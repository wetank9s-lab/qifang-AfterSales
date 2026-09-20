#!/usr/bin/env node
/**
 * =============================================================================
 *  smoke-test.mjs —— Phase 1 端到端验收自检（需要 Docker daemon 在跑）
 * -----------------------------------------------------------------------------
 *  与 verify-config.mjs / verify-plugin-load.mjs 的分工：
 *    verify-*.mjs        启动「前」的离线静态校验（不需要 Docker）
 *    smoke-test.mjs      启动「后」的真实环境验收（需要 Docker）
 *
 *  用法：
 *    node scripts/smoke-test.mjs
 *    node scripts/smoke-test.mjs --url http://localhost:8080
 *    node scripts/smoke-test.mjs --wait 240       # 等待应用就绪，最多 240 秒
 *
 *  退出码：0 = 全部通过；1 = 有失败项
 * =============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { EXPECTED_INDEXES, indexSignature, parseIndexDef } from './expected-indexes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ------------------------------------------------------------------ CLI 参数 --
const argv = process.argv.slice(2);
const getOpt = (name, def) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};

/** 从 .env 读一个键（避免手工传参） */
function envValue(key, fallback = '') {
  const p = path.resolve(ROOT, '.env');
  if (!fs.existsSync(p)) return fallback;
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(fs.readFileSync(p, 'utf8'));
  return m ? m[1].trim() : fallback;
}

const PORT = envValue('NGINX_HTTP_PORT', '8080');
const BASE_URL = getOpt('--url', `http://localhost:${PORT}`).replace(/\/$/, '');
const WAIT_SECONDS = Number(getOpt('--wait', '0'));

// ------------------------------------------------------------------ 断言框架 --
let passed = 0;
const failures = [];
const warnings = [];

/**
 * 断言包装。**必须 await**：支持同步与异步（async）断言函数。
 * 若不 await 一个 async 断言，异常会变成 unhandled rejection 而被静默吞掉 ——
 * 所以这里统一 async，并要求调用方 await，杜绝"看起来绿实际没跑"。
 */
async function check(label, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    failures.push({ label, message: e.message });
    console.log(`  ❌ ${label} — ${e.message}`);
  }
}

function section(title) {
  console.log('');
  console.log(`【${title}】`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 执行封装 --
/** 执行 docker 命令并返回 stdout（失败抛错，附 stderr） */
function docker(args, opts = {}) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      timeout: opts.timeout ?? 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
      /**
       * ⚠️ maxBuffer 必须显式给大值。
       *   Node 的默认值是 **1MB**，超了直接杀子进程并抛
       *   ERR_CHILD_PROCESS_STDIO_MAXBUFFER —— 而 docker() 的 catch 会把
       *   `e.stderr` 的首行当成失败原因，于是报出来的是应用日志里的
       *   "About to overwrite ArrayBuffer.prototype properties …" 这类无关告警，
       *   完全指不到"日志太大"这个真因（踩过：app 跑几小时后日志到 1.2MB，
       *   三条依赖 `docker logs` 的断言集体失败，看着像插件没加载）。
       *   64MB 足够容纳长时间运行的日志；`docker logs` 本身也是常用的排障手段，
       *   不该因为缓冲上限而不可用。
       */
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    });
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString().trim();
    throw new Error(`docker ${args.join(' ')} 失败：${msg.split('\n')[0] || '未知错误'}`);
  }
}

/** HTTP 请求（返回 {status, body, headers}） */
async function http(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(opts.timeout ?? 10000),
    headers: opts.headers,
    body: opts.body,
  });
  const text = await res.text();
  return { status: res.status, body: text, headers: res.headers };
}

/** 解析 JSON，失败给清晰的错误 */
function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${what} 返回的不是合法 JSON：${text.slice(0, 160)}`);
  }
}

/**
 * 解包 NocoBase 的响应信封。
 *
 * NocoBase 的 resourcer 会把 action 的返回值统一包成 `{ "data": ... }`
 * （实测 /api/svc:health 顶层只有一个 data 键）。
 * 早期版本的本脚本直接读顶层字段，导致 db/status/settingsSeeded 全部 undefined、
 * 一批断言集体误报失败 —— 属于脚本自身的缺陷，不是被验收对象的问题。
 * 这里做一次解包，并兼容"没有信封"的形态，避免 NocoBase 调整信封时整份脚本失效。
 */
function unwrapHealth(json) {
  if (json && typeof json === 'object' && json.data && typeof json.data === 'object') {
    return json.data;
  }
  return json;
}

// ============================================================================
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  Phase 1 端到端验收自检（smoke-test）');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  目标地址：${BASE_URL}`);
console.log('');

// ---------------------------------------------------------------------------
// 0. Docker 基础设施
// ---------------------------------------------------------------------------
section('0. Docker 基础设施');

await check('Docker daemon 可达', () => {
  const v = docker(['version', '--format', '{{.Server.Version}}']);
  return `Engine ${v.trim()}`;
});

const EXPECTED_CONTAINERS = ['svc-postgres', 'svc-app', 'svc-nginx'];

await check('三个容器存在', () => {
  const all = docker(['ps', '-a', '--format', '{{.Names}}'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const missing = EXPECTED_CONTAINERS.filter((n) => !all.includes(n));
  assert(missing.length === 0, `缺失容器：${missing.join(', ')}（先执行 docker compose up -d）`);
  return EXPECTED_CONTAINERS.join(', ');
});

// 可选等待应用就绪
if (WAIT_SECONDS > 0) {
  process.stdout.write(`  … 等待应用就绪（最多 ${WAIT_SECONDS}s）`);
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await http(`${BASE_URL}/api/svc/health`, { timeout: 5000 });
      if (r.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* 还没起来，继续等 */
    }
    process.stdout.write('.');
    await sleep(5000);
  }
  console.log(ready ? ' 就绪' : ' 超时');
  if (!ready) {
    warnings.push(`等待 ${WAIT_SECONDS}s 后 /api/svc/health 仍未返回 200，后续断言可能失败`);
  }
}

function containerStatus(name) {
  const s = docker(['inspect', '-f', '{{.State.Status}}|{{.State.Health.Status}}', name]).trim();
  const [state, health] = s.split('|');
  return { state, health };
}

for (const name of EXPECTED_CONTAINERS) {
  await check(`${name} 处于 running`, () => {
    const { state, health } = containerStatus(name);
    assertEq(state, 'running', `${name} 的 State.Status`);
    return health && health !== '<no value>' ? `health=${health}` : 'health=未配置';
  });
}

await check('postgres 与 app 均为 healthy（验收要求）', () => {
  const bad = [];
  for (const n of ['svc-postgres', 'svc-app']) {
    const { health } = containerStatus(n);
    if (health !== 'healthy') bad.push(`${n}=${health}`);
  }
  // nginx 依赖 app，通常也 healthy；不作为硬门槛
  const { health: nginxHealth } = containerStatus('svc-nginx');
  if (bad.length) throw new Error(`未达 healthy：${bad.join(', ')}`);
  return `postgres/app=healthy，nginx=${nginxHealth}`;
});

await check('app 端口仅绑定回环（不对局域网暴露）', () => {
  const raw = docker(['inspect', '-f', '{{json .NetworkSettings.Ports}}', 'svc-app']);
  const ports = JSON.parse(raw.trim());
  const bindings = Object.values(ports).flat().filter(Boolean);
  assert(bindings.length > 0, 'app 没有任何端口映射');
  for (const b of bindings) {
    assert(b.HostIp === '127.0.0.1', `存在非回环绑定：${b.HostIp}:${b.HostPort}`);
  }
  return bindings.map((b) => `${b.HostIp}:${b.HostPort}→13000`).join(', ');
});

await check('postgres 未向宿主机暴露端口', () => {
  const raw = docker(['inspect', '-f', '{{json .NetworkSettings.Ports}}', 'svc-postgres']);
  const ports = JSON.parse(raw.trim());
  const exposed = Object.entries(ports)
    .filter(([, v]) => v && v.length)
    .map(([k]) => k);
  assert(exposed.length === 0, `postgres 暴露了端口：${exposed.join(', ')}`);
  return '仅容器网络内可达';
});

// ---------------------------------------------------------------------------
// 1. 容器内插件加载
// ---------------------------------------------------------------------------
section('1. 容器内插件加载（容器内实测，非桩环境）');

await check("require.resolve('@local/service-ticket') 可在容器内解析", () => {
  const out = docker([
    'exec', 'svc-app', 'node', '-e',
    "process.stdout.write(require.resolve('@local/service-ticket'))",
  ]);
  const p = out.trim();
  assert(p.includes('@local/service-ticket'), `解析结果异常：${p}`);
  return p;
});

await check('插件已被 NocoBase 加载并出现在已启用列表', () => {
  // app 启动日志里插件会打印自定义的加载行
  const logs = docker(['logs', 'svc-app'], { timeout: 30000 });
  const combined = logs.toString();
  const hit = combined.includes('[ @local/service-ticket ]') || combined.includes('@local/service-ticket');
  assert(hit, 'app 日志中未发现 @local/service-ticket 的加载痕迹');
  const loadedLine = combined
    .split('\n')
    .find((l) => l.includes('已加载：') && l.includes('张表'));
  return loadedLine ? loadedLine.trim().slice(-90) : '日志中有插件痕迹';
});

await check('插件加载行报告 11 张表与 0 个定时任务', () => {
  const logs = docker(['logs', 'svc-app'], { timeout: 30000 }).toString();
  const line = logs.split('\n').find((l) => l.includes('已加载：') && l.includes('张表'));
  assert(line, '未找到插件的「已加载」日志行（Phase 1 关键证据）');
  assert(/已加载：11\s*张表/.test(line), `表数量不是 11：${line.trim().slice(-90)}`);
  return line.trim().replace(/^.*?\[@local\/service-ticket\]/, '').trim();
});

await check('参数种子：播种日志自洽（若走 install 路径），且落库恰为 16 项', () => {
  // ⚠️ 这条断言修正过一次，原因值得记下来（真机踩过）：
  //   旧版本直接要求日志里存在「新增 16 项」。
  //   但 `参数种子：…` 这行只在 install() / afterEnable() 里打 ——
  //   一旦容器被**重建**（docker compose up -d 改了 env、down/up、rm 后再起），
  //   NocoBase 认为应用"已安装"，install() 不再执行，这行就永远不会再出现；
  //   而 `docker restart` 保留旧日志，所以旧日志能一直"蒙"着断言通过。
  //   换句话说：旧断言测的不是播种，而是"这个容器自首次安装以来没被重建过"。
  //   任何人按 README 改了编排再 up -d，就会撞上一条红着的、与代码无关的断言。
  //
  // 现在分两种情况，各自断言真正的不变量：
  //   · 有日志 → 本次启动确实走了播种路径 → 断言数字自洽（created + skipped 恰为 16）
  //   · 无日志 → 已安装实例，播种不重跑 → 种子齐全性由数据库回答（本断言仍查一次总数，
  //              与后面第 4 节的 16 行断言互为交叉验证）
  const logs = docker(['logs', 'svc-app'], { timeout: 30000 }).toString();
  const line = logs.split('\n').find((l) => l.includes('参数种子：'));

  const dbCount = Number(psql('SELECT count(*) FROM service_settings'));
  assert(
    dbCount === 16,
    `service_settings 有 ${dbCount} 行，期望 16 —— 少于 16 说明播种没跑完，` +
      '多于 16 说明有人绕过 seeds/apply.ts 直接插入（阈值来源将不可追溯）',
  );

  if (!line) {
    return `已安装实例（容器重建后 install 不重跑，故无播种日志）；DB 16 项`;
  }

  const m = /新增\s*(\d+)\s*项，跳过（已存在）\s*(\d+)\s*项/.exec(line);
  assert(m, `参数种子日志格式不认识（seeds/apply.ts 改了文案？）：${line.trim().slice(-90)}`);
  const created = Number(m[1]);
  const skipped = Number(m[2]);
  assert(
    created + skipped === 16,
    `日志自相矛盾：新增 ${created} + 跳过 ${skipped} = ${created + skipped}，期望 16 ` +
      '（这两个数来自同一次 for 循环，和不为 16 说明 DEFAULT_SETTINGS 与断言漂移了）',
  );
  return `新增 ${created} 项 / 跳过 ${skipped} 项；DB 16 项`;
});

// ---------------------------------------------------------------------------
// 2. 健康检查接口（验收门槛）
// ---------------------------------------------------------------------------
section('2. 健康检查接口（DEV-PLAN Phase 1 验收门槛）');

let health = null;

await check('GET /api/svc:health（NocoBase 原生冒号形式）返回 200', async () => {
  const r = await http(`${BASE_URL}/api/svc:health`);
  assertEq(r.status, 200, 'HTTP 状态码');
  health = unwrapHealth(parseJson(r.body, '/api/svc:health'));
  return `db=${health.db} sms=${health.sms} tasks=${health.tasks}`;
});

await check('GET /api/svc/health（验收文档斜杠形式）行为一致', async () => {
  const r = await http(`${BASE_URL}/api/svc/health`);
  assertEq(r.status, 200, 'HTTP 状态码');
  const b = unwrapHealth(parseJson(r.body, '/api/svc/health'));
  return `db=${b.db} sms=${b.sms} tasks=${b.tasks}`;
});

await check('返回体核心三字段恰为 {"db":"ok","sms":"mock","tasks":"ok"}', () => {
  assert(health, '前置请求未成功，无法断言');
  assertEq(health.db, 'ok', 'db');
  assertEq(health.sms, 'mock', 'sms');
  assertEq(health.tasks, 'ok', 'tasks');
  return JSON.stringify({ db: health.db, sms: health.sms, tasks: health.tasks });
});

await check('status=ok 且 ready=true', () => {
  assertEq(health.status, 'ok', 'status');
  assertEq(health.ready, true, 'ready');
  return `status=${health.status} ready=${health.ready}`;
});

await check('11 张表全部存在（tablesPresent=11, missingTables 为空）', () => {
  assertEq(health.tablesExpected, 11, 'tablesExpected');
  assertEq(health.tablesPresent, 11, 'tablesPresent');
  assert(Array.isArray(health.missingTables) && health.missingTables.length === 0,
    `missingTables 非空：${JSON.stringify(health.missingTables)}`);
  return `11/11`;
});

await check('注册的 collection 数量为 11', () => {
  assertEq(health.registeredCollections, 11, 'registeredCollections');
  return '11';
});

await check('参数种子已成功落库（settingsSeeded=true）', () => {
  assertEq(health.settingsSeeded, true, 'settingsSeeded');
  return 'true';
});

await check('响应不含敏感信息（无连接串/密码/堆栈）', () => {
  const s = JSON.stringify(health);
  const leaks = [
    { re: /postgres:\/\//i, name: '数据库连接串' },
    { re: /password/i, name: 'password 字样' },
    { re: new RegExp(envValue('DB_PASSWORD', '\u0000').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), name: 'DB_PASSWORD 明文' },
    { re: /at\s+\w+\s+\(.*:\d+:\d+\)/, name: '堆栈' },
  ];
  const hit = leaks.filter((l) => l.re.test(s));
  // DB_PASSWORD 空值时该正则匹配空串，需排除
  const real = hit.filter((h) => h.name !== 'DB_PASSWORD 明文' || envValue('DB_PASSWORD'));
  assert(real.length === 0, `疑似泄露：${real.map((r) => r.name).join(', ')}`);
  return `${Object.keys(health).length} 个字段均无敏感内容`;
});

await check('响应头带 X-Trace-Id（便于与 nginx 日志串联）', async () => {
  const r = await http(`${BASE_URL}/api/svc:health`);
  const t = r.headers.get('x-trace-id');
  assert(t, '缺失 X-Trace-Id 响应头');
  return t;
});

// ---------------------------------------------------------------------------
// 3. Nginx 层
// ---------------------------------------------------------------------------
section('3. Nginx 层');

await check('GET /healthz 返回 ok（nginx 自身存活）', async () => {
  const r = await http(`${BASE_URL}/healthz`);
  assertEq(r.status, 200, 'HTTP 状态码');
  assertEq(r.body.trim(), 'ok', '响应体');
  return r.body.trim();
});

await check('安全响应头已下发（nosniff / X-Frame-Options / Referrer-Policy）', async () => {
  const r = await http(`${BASE_URL}/healthz`);
  const need = ['x-content-type-options', 'x-frame-options', 'referrer-policy'];
  const missing = need.filter((h) => !r.headers.get(h));
  assert(missing.length === 0, `缺失响应头：${missing.join(', ')}`);
  return need.map((h) => `${h}=${r.headers.get(h)}`).join(' ');
});

await check('HTTP 响应头未暴露 nginx 版本号（server_tokens off）', async () => {
  const r = await http(`${BASE_URL}/healthz`);
  const server = r.headers.get('server') || '';
  assert(!/\d+\.\d+\.\d+/.test(server), `Server 头含版本号：${server}`);
  return `Server: ${server}`;
});

await check('隐藏文件访问被拒绝（/.env 不可读）', async () => {
  const r = await http(`${BASE_URL}/.env`);
  assert(r.status === 403 || r.status === 404, `预期 403/404，实际 ${r.status}`);
  return `HTTP ${r.status}`;
});

await check('H5 占位页可访问（bind mount 生效）', async () => {
  const r = await http(`${BASE_URL}/h5/`);
  assertEq(r.status, 200, 'HTTP 状态码');
  assert(r.body.includes('H5'), '返回内容不是 H5 占位页');
  return `HTTP ${r.status}，${r.body.length} 字节`;
});

await check('H5 响应带 no-store 与 noindex（一次性页面不被缓存/收录）', async () => {
  const r = await http(`${BASE_URL}/h5/`);
  const cc = r.headers.get('cache-control') || '';
  const robots = r.headers.get('x-robots-tag') || '';
  assert(cc.includes('no-store'), `Cache-Control 未含 no-store：${cc}`);
  assert(robots.includes('noindex'), `X-Robots-Tag 未含 noindex：${robots}`);
  return `Cache-Control: ${cc} | X-Robots-Tag: ${robots}`;
});

await check('通用入口生效：后台首页可达（SPA 或重定向，非 5xx）', async () => {
  const r = await http(`${BASE_URL}/`);
  assert(r.status < 500, `返回 5xx：${r.status}`);
  return `HTTP ${r.status}`;
});

// ---------------------------------------------------------------------------
// 4. 数据库
// ---------------------------------------------------------------------------
section('4. PostgreSQL 实际表结构');

/** 11 张业务表（与插件 collections/index.ts 的 EXPECTED_TABLE_NAMES 一致） */
const EXPECTED_TABLES = [
  'api_guards',
  'daily_sequences',
  'idempotency_records',
  'service_tickets',
  'service_visit_photos',
  'service_visits',
  'sms_logs',
  'store_users',
  'stores',
  'service_settings',
  'ticket_events',
];

/** 在 postgres 容器里跑一条 SQL，返回原始文本（-t 去表头 -A 去对齐 -F 指定分隔符） */
function psql(sql) {
  const user = envValue('POSTGRES_USER', 'svc_app');
  const db = envValue('POSTGRES_DB', 'service_ticket');
  // 注意：这里**不能**用 `-T` —— `-T`(--no-TTY) 是 `docker compose exec` 的旗标，
  // 不是 `docker exec` 的，会直接报 "unknown shorthand flag: 'T' in -T"。
  // 本函数通过 psql -c 传 SQL，不需要 stdin，因此不带交互旗标即可。
  return docker([
    'exec', 'svc-postgres',
    'psql', '-U', user, '-d', db, '-t', '-A', '-F', '|', '-c', sql,
  ], { timeout: 30000 }).trim();
}

/**
 * psql 原始文本 → 行数组。
 * `-t` 去表头、`-A` 去对齐，所以每行就是一条记录（多列时用 `|` 分隔）。
 */
function psqlRows(sql) {
  return psql(sql)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 取"单个标量值"。
 *
 * ⚠️ 必须只取第一行：`INSERT ... RETURNING` 这类语句，psql 除了返回结果行，
 * 还会额外打印一行命令标签（`INSERT 0 1`）。直接把整个输出 Number() 会得到 NaN ——
 * 早期 daily_sequences 取号断言就是这么"稳定失败"的。
 */
function psqlScalar(sql) {
  return psqlRows(sql)[0] ?? '';
}

/**
 * 读取某张表在 Postgres 里的实际索引，返回 签名 → { columns, unique, names[] }。
 * 为什么按「列集合」而不是「索引名」比对：
 *   字段级 unique: true 由 PG 自动命名 `<table>_<col>_key`，
 *   collection 级的等价索引叫 `<table>_<col>`，名字不同但语义完全等价。
 *   按名字比会把"本来就满足"误判成"缺失"。
 */
function tableIndexes(table) {
  const rows = psqlRows(
    `SELECT indexname || '|' || indexdef FROM pg_indexes ` +
      `WHERE schemaname = 'public' AND tablename = '${table}'`,
  );

  const map = new Map();
  for (const row of rows) {
    const sep = row.indexOf('|');
    if (sep === -1) continue;
    const name = row.slice(0, sep);
    const { columns, unique } = parseIndexDef(row.slice(sep + 1));
    if (columns.length === 0) continue;

    const key = indexSignature(columns);
    const prev = map.get(key);
    if (prev) {
      prev.unique = prev.unique || unique;
      prev.names.push(name);
    } else {
      map.set(key, { columns, unique, names: [name] });
    }
  }
  return map;
}

/**
 * Docker/Go 的时间串 → Unix 秒。
 *
 * 输入形如 `2026-09-20 08:54:30.570636442 +0000 UTC`（docker inspect 的 Health.Log[].End）。
 * 为什么不用 `new Date(s)`：那串既不是 RFC3339（日期与时间之间是空格、带 " UTC" 后缀），
 * 小数位也可能超过 JS 支持的 3 位，直接解析在部分运行时得到 Invalid Date。
 * 这里手工切成 RFC3339 形态（小数截到毫秒），保证跨运行时稳定。
 *
 * 解析不出来时返回 null —— 调用方据此退化为"统计全量日志"，而不是抛错。
 */
function dockerTimeToUnixSeconds(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:\s*([+-]\d{4}))?/.exec(String(s).trim());
  if (!m) return null;

  const [, date, time, frac = '0', offset] = m;
  const ms = frac.slice(0, 3).padEnd(3, '0');
  const suffix = !offset || offset === '+0000' ? 'Z' : `${offset.slice(0, 3)}:${offset.slice(3)}`;

  const dt = new Date(`${date}T${time}.${ms}${suffix}`);
  return Number.isNaN(dt.getTime()) ? null : Math.floor(dt.getTime() / 1000);
}

await check('11 张业务表全部存在（按表名白名单查询，不数 pg_tables 总数）', () => {
  const inList = EXPECTED_TABLES.map((n) => `'${n}'`).join(',');
  const out = psql(
    `SELECT table_name FROM information_schema.tables ` +
      `WHERE table_schema = current_schema() AND table_name IN (${inList}) ` +
      `ORDER BY table_name`,
  );
  const found = out.split('\n').map((s) => s.trim()).filter(Boolean);
  const missing = EXPECTED_TABLES.filter((n) => !found.includes(n));
  assert(missing.length === 0, `缺失表：${missing.join(', ')}`);
  assertEq(found.length, 11, '表数量');
  return found.join(', ');
});

/**
 * 唯一的 `xxx` 索引是否建立。
 *
 * ⚠️ 这里查的是 **pg_indexes，不是 pg_constraint**。
 *   collection 定义里 `indexes: [{ fields: [...], unique: true }]` 落库是
 *   「UNIQUE INDEX」；只有当 unique 写在**字段**上时，Sequelize 才会在 CREATE TABLE 里
 *   生成「UNIQUE CONSTRAINT」。早期本脚本一律查 pg_constraint（contype='u'），
 *   于是把已经建好的 `service_visits_ticket_id_visit_no` 误报成"未找到复合唯一约束"。
 *   pg_indexes 对两种形态都覆盖（回环见 DEV-16 / DEV-17）。
 */
function hasUniqueIndex(table, columns) {
  const hit = tableIndexes(table).get(indexSignature(columns));
  return !!hit && hit.unique;
}

await check('unique(ticket_no) 已建立（防重复工单号）', () => {
  assert(hasUniqueIndex('service_tickets', ['ticket_no']), '未找到 ticket_no 唯一索引');
  return 'ok';
});

await check('unique(feedback_token_hash) 已建立（评价 Token 不可逆且唯一）', () => {
  assert(hasUniqueIndex('service_tickets', ['feedback_token_hash']), '未找到 feedback_token_hash 唯一索引');
  return 'ok';
});

await check('unique(ticket_id, visit_no) 已建立（一次上门一条记录，永不覆盖）', () => {
  assert(
    hasUniqueIndex('service_visits', ['ticket_id', 'visit_no']),
    '未找到 (ticket_id, visit_no) 唯一索引',
  );
  return 'ok';
});

await check('unique(access_token_hash) 已建立（师傅 Token 单次有效）', () => {
  assert(hasUniqueIndex('service_visits', ['access_token_hash']), '未找到 access_token_hash 唯一索引');
  return 'ok';
});

await check('unique(provider, biz_id) 已建立（短信回执幂等的唯一手段）', () => {
  assert(hasUniqueIndex('sms_logs', ['provider', 'biz_id']), '未找到 (provider, biz_id) 唯一索引');
  return 'ok';
});

await check('unique(file_id) 已建立（同一文件不得重复挂到两次上门）', () => {
  assert(hasUniqueIndex('service_visit_photos', ['file_id']), '未找到 file_id 唯一索引');
  return 'ok';
});

await check('service_settings 有 16 行参数种子', () => {
  const n = Number(psql('SELECT count(*) FROM service_settings'));
  assertEq(n, 16, '行数');
  return '16 项';
});

await check('参数种子关键项取值正确（抽样）', () => {
  // ⚠️ 键名是**点号分隔**的（`feedback.low_score_threshold`），不是下划线。
  //    仓库里的常量定义见 src/server/constants.ts 的 DEFAULT_SETTINGS。
  //    早期这里写成 `feedback_low_score_threshold`，一个都匹配不到，
  //    而断言只报"抽样键缺失"，看起来像种子没写进去，实则 SQL 条件本身就写错了。
  const keys = [
    'feedback.low_score_threshold',
    'feedback.wait_days',
    'technician.token_expire_hours',
    'privacy.retention_months',
  ];
  const inList = keys.map((k) => `'${k}'`).join(',');
  const rows = psqlRows(`SELECT key || '=' || value FROM service_settings WHERE key IN (${inList})`);
  const map = Object.fromEntries(rows.map((l) => [l.split('=')[0], l.split('=').slice(1).join('=')]));

  const missing = keys.filter((k) => !(k in map));
  assert(missing.length === 0, `抽样键缺失：${missing.join(', ')}（实际返回 ${rows.length} 行）`);
  return keys.map((k) => `${k}=${map[k]}`).join(' ');
});

await check('service_tickets 索引已建立（含复合索引）', () => {
  const idx = tableIndexes('service_tickets');
  assert(idx.size >= 10, `索引数量偏少（${idx.size} 个），可能未按定义建立`);
  const hasComposite = idx.has(indexSignature(['store_id', 'status']));
  assert(hasComposite, `未发现 (store_id, status) 复合索引，实际：${[...idx.values()].flatMap((v) => v.names).join(', ')}`);
  return `${idx.size} 个索引（按列集合去重）`;
});

// ---------------------------------------------------------------------------
// 4.2 索引完整性：清单里的每一条都必须真的落到 Postgres 上
//
// 为什么要有这一组：Phase 1 真机启动时，NocoBase 的 refreshIndexes() 把
// serviceVisitPhotos / ticketEvents / smsLogs 三张表共 8 条声明式索引**静默丢弃**，
// 而当时"表都存在 + 健康检查 200 + 离线校验全绿"，没有任何一项能发现。
// 清单来源：scripts/expected-indexes.mjs（与 docs/DATA-MODEL.md §13 对齐）。
// ---------------------------------------------------------------------------
for (const [table, expected] of Object.entries(EXPECTED_INDEXES)) {
  await check(`${table} 的声明式索引全部落库（${expected.length} 条）`, () => {
    const actual = tableIndexes(table);
    const missing = [];

    for (const item of expected) {
      const hit = actual.get(indexSignature(item.columns));
      if (!hit) {
        missing.push(`${item.columns.join('+')}（无索引）`);
      } else if (item.unique && !hit.unique) {
        missing.push(`${item.columns.join('+')}（存在但非唯一）`);
      }
    }

    assert(
      missing.length === 0,
      `缺失 ${missing.length}/${expected.length} 条：${missing.join('；')} ` +
        `[根因通常是 NocoBase refreshIndexes() 静默丢索引，见 docs/DEVIATIONS.md DEV-16]`,
    );
    return `${expected.length}/${expected.length} 条齐全`;
  });
}

await check('没有同一组列上的重复同义索引（浪费写入与存储）', () => {
  // 来源：DEV-17。字段级 unique: true 已经生成 PG UNIQUE CONSTRAINT，
  // 早期又在 collection.indexes 里声明了一遍，导致 ticket_no / access_token_hash /
  // seq_key / key 四列各有两个同义索引。
  const offenders = [];
  const tables = [...new Set([...EXPECTED_TABLES])];

  for (const table of tables) {
    for (const [sig, info] of tableIndexes(table)) {
      if (info.names.length > 1) offenders.push(`${table}(${sig || info.columns.join('+')}) → ${info.names.join(' = ')}`);
    }
  }

  assert(offenders.length === 0, `发现 ${offenders.length} 组重复索引：${offenders.join('；')}`);
  return `已扫 ${tables.length} 张表，无重复`;
});

await check('daily_sequences 可正常取号（Phase 2 的原子上限验证预演）', () => {
  // 列名用 created_at / updated_at（本插件 collection 全开了 underscored，与 DDL 一致）。
  // 返回值的解析必须走 psqlScalar()：`INSERT ... RETURNING` 会额外打印一行 `INSERT 0 1`，
  // 整段 Number() 会变 NaN。见 psqlScalar 的注释。
  const out = psqlScalar(
    "INSERT INTO daily_sequences (seq_key, current_value, created_at, updated_at) " +
      "VALUES ('smoke_' || to_char(now(),'YYYYMMDD'), 1, now(), now()) " +
      "ON CONFLICT (seq_key) DO UPDATE SET current_value = daily_sequences.current_value + 1 " +
      "RETURNING current_value",
  );
  const n = Number(out);
  assert(Number.isInteger(n) && n >= 1, `取号返回值异常：${JSON.stringify(out)}`);
  // 清理本次冒烟留下的记录，避免污染
  psql("DELETE FROM daily_sequences WHERE seq_key LIKE 'smoke_%'");
  return `current_value=${n}（已清理测试行）`;
});

// ---------------------------------------------------------------------------
// 4b. Phase 2 验收：资源级授权 / 字段白名单 / 门店隔离(AT-03) /
//     并发取号 / 事件必写
//
// 这一组是 Phase 2 的**真机行为**验收，与离线校验（verify-plugin-load.mjs）
// 互补：离线校验证明"代码会写正确的数据"，这里证明"写下去的数据真的让接口
// 按预期工作"。两者都在，才说明整条链路通。
//
// 为什么这些断言值得固化（都是踩过的静默缺陷）：
//   · 资源级授权缺失 → 角色能登录、后台看得见，但每个资源 403 No permissions；
//   · `fields: []` → 接口 200 但只回 id/createdAt/updatedAt（业务列全丢）；
//   · `fields: null` → **整行下发，把 feedback_token_hash 一起送出去**（安全漏洞）；
//   · 白名单误取 getFields()（真机返回数组）→ 白名单变成 ["0","1",…] 垃圾；
//   · 越权 get 返回 500 而不是 404 → 泄露"该工单存在"这一信息。
// ---------------------------------------------------------------------------
section('4b. Phase 2 验收（资源授权 / 字段白名单 / 门店隔离 / 并发取号 / 事件必写）');

const PHASE2_ROLES = ['store_after_sales', 'hq_after_sales', 'hq_admin', 'viewer'];
const PHASE2_RESOURCES = ['serviceTickets', 'serviceVisits', 'ticketEvents', 'smsLogs'];
/** 原生只读接口上绝不允许下发的列（与插件 NATIVE_READ_FIELD_DENY 对齐） */
const PHASE2_SENSITIVE = [
  'feedback_token_hash',
  'feedback_token_expires_at',
  'feedback_token_used_at',
  'access_token_hash',
  'token_expires_at',
  'token_used_at',
];

await check('四个业务角色都拿到了 4 张表的资源级授权（缺一即该角色全员 403）', () => {
  const rows = psqlRows(
    'SELECT r."roleName" || \'|\' || r.name || \'|\' || count(a.id) ' +
      'FROM "dataSourcesRolesResources" r ' +
      'LEFT JOIN "dataSourcesRolesResourcesActions" a ON a."rolesResourceId" = r.id ' +
      `WHERE r."roleName" IN (${PHASE2_ROLES.map((r) => `'${r}'`).join(',')}) ` +
      'GROUP BY r."roleName", r.name ORDER BY r."roleName", r.name',
  );

  const seen = new Map();
  const wrongActionCount = [];
  for (const line of rows) {
    const [role, resource, n] = line.split('|');
    if (!seen.has(role)) seen.set(role, new Set());
    seen.get(role).add(resource);
    if (Number(n) !== 2) wrongActionCount.push(`${role}/${resource}=${n}`);
  }

  const missing = [];
  for (const role of PHASE2_ROLES) {
    for (const resource of PHASE2_RESOURCES) {
      if (!seen.get(role)?.has(resource)) missing.push(`${role}/${resource}`);
    }
  }
  assert(
    missing.length === 0,
    `缺 ${missing.length} 条资源级授权：${missing.join(', ')} ` +
      '（现象：该角色能登录，但这些资源全部 403 No permissions）',
  );
  assert(
    wrongActionCount.length === 0,
    `这些资源授权的 action 行不是 2 条（list/get）：${wrongActionCount.join(', ')} ` +
      '（现象：该 action 恒 403，且日志里只有一句 No permissions）',
  );
  return `${PHASE2_ROLES.length} 角色 × ${PHASE2_RESOURCES.length} 资源 × 2 action 齐全`;
});

await check('资源授权表与代码期望逐行一致：0 条无主行、恰好 16 条授权、32 条 action、每张表白名单唯一', () => {
  // 这条是 Phase 2.1 整改项 4 的**真机收口**：光断言"白名单不含敏感列"是不够的。
  //
  // 为什么必须断言"恰好"而不是"至少"：
  //   真机上同时存在过"viewer 的正确白名单行"和一堆 `roleName` 为空的垃圾行。
  //   任何"至少有一条对的"式断言在这种库里都能过，于是"重新部署后配置是否一致"
  //   这个问题实际上没有答案 —— 库里有多少行、都是谁，没人说得清。
  //
  // 无主行的来源（真机取证，2026-09-20，见 docs/DEVIATIONS.md DEV-27）：
  //   `roles.resources` 是 hasMany(sourceKey:'name', foreignKey:'roleName')，
  //   替换关联时 Sequelize 执行的是 `UPDATE ... SET roleName = NULL`（把旧行脱钩），
  //   而库里没有 roleName 的外键约束 → 旧行永久留成无主行。
  //   实测：一次 `POST /api/roles:update?filterByTk=viewer` 就把无主行从 7 条变成 11 条。
  //   本插件的启动期自愈会清掉它们（seeds/apply.ts 的 removeOrphanResourceRows）。
  //
  // 另外断言"每张表的白名单只有一个版本"：
  //   这是对"字段白名单由代码单一事实来源决定"的最终检验 ——
  //   只要 4 个角色 × 2 个 action 在 serviceTickets 上出现两种白名单，
  //   就说明有人的改动没走代码（探针残留、后台误改），必须立刻红。
  const orphan = Number(
    psqlScalar(
      'SELECT count(*) FROM "dataSourcesRolesResources" WHERE "roleName" IS NULL OR "roleName" = \'\'',
    ),
  );
  assert(
    orphan === 0,
    `库里存在 ${orphan} 条无主资源授权行（roleName 为空）：它们永远不会被 ACL 加载，` +
      '但会让"授权配置是否一致"变成不可判定。正常部署后应为 0（启动期自愈会清理）',
  );

  const expectedResources = PHASE2_ROLES.length * PHASE2_RESOURCES.length;
  const total = Number(psqlScalar('SELECT count(*) FROM "dataSourcesRolesResources"'));
  assert(
    total === expectedResources,
    `资源授权共 ${total} 行，期望恰好 ` +
      `${PHASE2_ROLES.length} 角色 × ${PHASE2_RESOURCES.length} 资源 = ${expectedResources} 行`,
  );

  const totalActions = Number(
    psqlScalar(
      'SELECT count(*) FROM "dataSourcesRolesResourcesActions" a ' +
        'JOIN "dataSourcesRolesResources" r ON r.id = a."rolesResourceId"',
    ),
  );
  assert(totalActions === expectedResources * 2, `action 行 ${totalActions} 条，期望 ${expectedResources * 2} 条（list/get）`);

  const rows = psqlRows(
    'SELECT r.name || \'|\' || a.name || \'|\' || a.fields::text ' +
      'FROM "dataSourcesRolesResources" r ' +
      'JOIN "dataSourcesRolesResourcesActions" a ON a."rolesResourceId" = r.id ' +
      `WHERE r."roleName" IN (${PHASE2_ROLES.map((r) => `'${r}'`).join(',')}) ` +
      'ORDER BY r.name, a.name',
  );
  const distinct = new Map();
  for (const line of rows) {
    const [resource, action, fields] = line.split('|');
    // 集合比较：NocoBase 会重排 `list` 动作的 fields（get 保持原序），顺序不是语义
    const key = [...new Set(JSON.parse(fields))].sort().join(',');
    if (!distinct.has(resource)) distinct.set(resource, new Set());
    distinct.get(resource).add(key);
    void action;
  }
  const multiVersion = [...distinct.entries()].filter(([, set]) => set.size !== 1);
  assert(
    multiVersion.length === 0,
    `这些表在库里有不止一种字段白名单：${multiVersion.map(([r, s]) => `${r}=${s.size} 种`).join(', ')} ` +
      '（说明有绕过代码的改动，例如探针残留或后台误改）',
  );

  return (
    `0 条无主行 / ${total} 条授权 / ${totalActions} 条 action / ` +
    `${distinct.size} 张表各只有 1 种白名单`
  );
});

await check('字段白名单非空、不含敏感列、不含 getFields() 的数字索引', () => {
  // 三种"看着都像通了"的坏取值，必须一次钉死：
  //   · [] —— 空壳（接口只回 3 个系统字段）
  //   · null —— 整行下发，**直接泄露凭证哈希**
  //   · ["0","1",…] —— 把真机返回**数组**的 getFields() 当名字映射去取键
  const bad = [];
  const rows = psqlRows(
    'SELECT r."roleName" || \'|\' || r.name || \'|\' || a.name || \'|\' || ' +
      "coalesce(a.fields::text, '<NULL>') " +
      'FROM "dataSourcesRolesResources" r ' +
      'JOIN "dataSourcesRolesResourcesActions" a ON a."rolesResourceId" = r.id ' +
      `WHERE r."roleName" IN (${PHASE2_ROLES.map((r) => `'${r}'`).join(',')})`,
  );

  assert(rows.length > 0, '一条资源级授权都没查到，Phase 2 的权限链路根本没建立');

  let totalFields = 0;
  for (const line of rows) {
    const [role, resource, action, raw] = line.split('|');
    const where = `${role}/${resource}:${action}`;

    if (raw === '<NULL>') {
      bad.push(`${where}=null（整行下发，会泄露 token 哈希）`);
      continue;
    }
    let fields;
    try {
      fields = JSON.parse(raw);
    } catch {
      bad.push(`${where} 的 fields 不是合法 JSON：${raw.slice(0, 40)}`);
      continue;
    }
    if (!Array.isArray(fields) || fields.length === 0) {
      bad.push(`${where}=[]（空壳：接口只会回 id/createdAt/updatedAt）`);
      continue;
    }
    const leaked = fields.filter((f) => PHASE2_SENSITIVE.includes(f));
    if (leaked.length) bad.push(`${where} 含敏感列 ${leaked.join(',')}`);
    const numeric = fields.filter((f) => /^\d+$/.test(String(f)));
    if (numeric.length) bad.push(`${where} 含数字索引 ${numeric.slice(0, 3).join(',')}（取了 getFields() 的数组下标）`);
    totalFields += fields.length;
  }

  assert(bad.length === 0, `发现 ${bad.length} 处不安全的字段白名单：${bad.slice(0, 6).join('；')}`);
  return `${rows.length} 条 action 行全部安全（共 ${totalFields} 个字段授权，0 处敏感列）`;
});

await check('白名单用的是 ORM 属性名（含 store_id / createdAt，不含关联名与 snake 时间列）', () => {
  // NocoBase 的 ACL `fields` 比对的是 **Sequelize 属性名**，不是 PG 列名。
  // 取错来源的表现是静默丢列，而不是报错 —— 所以必须钉住名字的形状。
  const raw = psqlScalar(
    'SELECT a.fields::text FROM "dataSourcesRolesResources" r ' +
      'JOIN "dataSourcesRolesResourcesActions" a ON a."rolesResourceId" = r.id ' +
      "WHERE r.\"roleName\"='store_after_sales' AND r.name='serviceTickets' AND a.name='list'",
  );
  const fields = JSON.parse(raw);

  assert(fields.includes('store_id'), '白名单缺外键列 store_id —— 门店隔离(AT-03)靠它断言，缺了等于验收做瞎');
  assert(fields.includes('createdAt'), '白名单缺 createdAt（属性名）—— 时间列会静默消失');
  assert(!fields.includes('created_at'), '白名单出现 snake_case created_at —— 它匹配不上 ORM 属性，时间列会丢');
  for (const assoc of ['store', 'handler', 'feedback_visit']) {
    assert(!fields.includes(assoc), `白名单出现关联名 ${assoc} —— 应排除，只放属性名`);
  }
  assert(fields.includes('content') && fields.includes('status'), '白名单缺业务列 content/status，接口等于空壳');
  return `${fields.length} 个属性名（store_id ✓ / createdAt ✓ / 关联名 ✗）`;
});

// ---- 以下需要真实登录态：造夹具 → 验收 → 清理 ---------------------------------
// 管理员凭据从环境变量读，默认取 NocoBase 的初始账号。
// 允许覆盖是因为验收环境可能改过初始密码；不允许"猜不出来就跳过" ——
// 跳过的验收等于没有验收。
const SMOKE_ADMIN_EMAIL = envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com');
const SMOKE_ADMIN_PASSWORD = envValue('SMOKE_ADMIN_PASSWORD', 'admin123');
const SMOKE_USER_PASSWORD = 'Smoke@12345';
const SMOKE_EMAIL_LIKE = 'smoke.%@svc.local';
const smokeUuid = () => crypto.randomUUID();

async function smokeSignIn(email, password) {
  const r = await http(`${BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (r.status !== 200) throw new Error(`登录 ${email} 失败：HTTP ${r.status} ${r.body.slice(0, 160)}`);
  return JSON.parse(r.body).data.token;
}

function cleanupSmokeFixtures() {
  psql(`DELETE FROM store_users WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${SMOKE_EMAIL_LIKE}')`);
  psql(
    "DELETE FROM ticket_events WHERE ticket_id IN " +
      "(SELECT id FROM service_tickets WHERE content LIKE '[SMOKE]%')",
  );
  psql("DELETE FROM service_tickets WHERE content LIKE '[SMOKE]%'");
  psql(`DELETE FROM "rolesUsers" WHERE "userId" IN (SELECT id FROM users WHERE email LIKE '${SMOKE_EMAIL_LIKE}')`);
  psql(`DELETE FROM users WHERE email LIKE '${SMOKE_EMAIL_LIKE}'`);
}

const phase2 = {
  tickets: [],
  /** 门店用户的 token，供后续断言复用 */
  authA: null,
};

try {
  cleanupSmokeFixtures();

  const adminToken = await smokeSignIn(SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD);

  // 门店用户（S01）+ 只读角色，用于 AT-03 与字段白名单的**实际响应**验证
  const users = {
    a: { email: 'smoke.a@svc.local', username: 'smoke_store_a', role: 'store_after_sales' },
    v: { email: 'smoke.v@svc.local', username: 'smoke_viewer', role: 'viewer' },
  };
  for (const u of Object.values(users)) {
    const r = await http(`${BASE_URL}/api/users:create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        email: u.email,
        username: u.username,
        nickname: u.username,
        password: SMOKE_USER_PASSWORD,
        roles: [{ name: u.role }],
      }),
    });
    assert(r.status === 200, `建用户 ${u.email} 失败：HTTP ${r.status} ${r.body.slice(0, 200)}`);
    u.id = JSON.parse(r.body).data.id;
    u.token = await smokeSignIn(u.email, SMOKE_USER_PASSWORD);
  }

  const storeIds = {};
  for (const line of psqlRows("SELECT code || '|' || id FROM stores WHERE code IN ('S01','S02')")) {
    const [code, id] = line.split('|');
    storeIds[code] = Number(id);
  }
  assert(
    storeIds.S01 && storeIds.S02,
    'S01/S02 两家门店必须都存在 —— 只有一家时"看不到别家工单"恒真，AT-03 等于没测',
  );

  psql(
    'INSERT INTO store_users (user_id, store_id, created_at, updated_at) ' +
      `VALUES (${users.a.id}, ${storeIds.S01}, now(), now())`,
  );

  const stamp = Date.now();
  const mkTicket = (storeId, code, suffix) =>
    Number(
      psqlScalar(
        'INSERT INTO service_tickets ' +
          '(created_at, updated_at, ticket_no, store_id, source_store_code, source, ticket_type, ' +
          ' content, customer_mobile, status, escalated, reopen_count, review_status, feedback_token_hash) ' +
          `VALUES (now(), now(), 'FWSM${stamp}${suffix}', ${storeId}, '${code}', 'qr', 'repair', ` +
          ` '[SMOKE] Phase2 验收 ${suffix}', '13800001234', 'NEW', false, 0, 'pending', 'smokehash${suffix}') ` +
          'RETURNING id',
      ),
    );
  const tA = mkTicket(storeIds.S01, 'S01', 'A');
  const tB = mkTicket(storeIds.S02, 'S02', 'B');
  phase2.tickets = [tA, tB];
  phase2.authA = { Authorization: `Bearer ${users.a.token}` };
  phase2.authV = { Authorization: `Bearer ${users.v.token}` };

  // -------------------------------------------------------------------------
  await check('AT-03 门店隔离：门店用户 list 只返回本店工单', async () => {
    const r = await http(`${BASE_URL}/api/serviceTickets:list?pageSize=100`, {
      headers: phase2.authA,
      timeout: 15000,
    });
    assert(r.status === 200, `HTTP ${r.status} ${r.body.slice(0, 200)}`);
    const rows = JSON.parse(r.body).data;
    assert(Array.isArray(rows), '响应 data 不是数组');

    const foreign = rows.filter((row) => Number(row.store_id) !== storeIds.S01);
    assert(
      foreign.length === 0,
      `返回了 ${foreign.length} 行别家门店的数据（store_id=${foreign.map((x) => x.store_id).join(',')}）`,
    );
    assert(
      rows.some((row) => Number(row.id) === tA),
      '本店工单 T_A 不在列表里 —— 要么 list 被过度裁剪，要么 storeScope 过滤写反了',
    );
    return `返回 ${rows.length} 行，全部属于 S01(${storeIds.S01})，含本店 T_A`;
  });

  await check('AT-03 门店隔离：get 他店工单返回 404（不是 403/500）', async () => {
    const foreign = await http(`${BASE_URL}/api/serviceTickets:get?filterByTk=${tB}`, {
      headers: phase2.authA,
      timeout: 15000,
    });
    // 为什么必须是 404 而不是 403：403 等于承认"这条工单存在"，
    // 门店用户据此可以枚举出别家门店的工单规模。404 才是"看不见即不存在"。
    assert(
      foreign.status === 404,
      `他店工单返回 HTTP ${foreign.status}（期望 404）—— ` +
        (foreign.status === 403
          ? '403 泄露了"该工单存在"这一信息'
          : '500 说明异常没被收敛成可预期的状态码'),
    );

    const own = await http(`${BASE_URL}/api/serviceTickets:get?filterByTk=${tA}`, {
      headers: phase2.authA,
      timeout: 15000,
    });
    assert(own.status === 200, `本店工单 get 返回 HTTP ${own.status}，期望 200`);
    return '他店 404 / 本店 200';
  });

  await check('字段白名单生效：list 回业务列且不含 feedback_token_hash', async () => {
    // 这条是"安全漏洞"级别的验收：fields=null 时 NocoBase 会整行下发，
    // 实测能直接拿到 feedback_token_hash / _expires_at / _used_at。
    for (const [who, auth] of [
      ['门店售后', phase2.authA],
      ['只读管理层', phase2.authV],
    ]) {
      const r = await http(`${BASE_URL}/api/serviceTickets:list?pageSize=100`, { headers: auth, timeout: 15000 });
      assert(r.status === 200, `${who} list 返回 HTTP ${r.status} ${r.body.slice(0, 160)}`);
      const rows = JSON.parse(r.body).data;
      const sample = rows.find((row) => Number(row.id) === tA) || rows[0];
      assert(sample, `${who} 一行都没返回，字段白名单无法验证`);

      const keys = Object.keys(sample);
      const leaked = keys.filter((k) => PHASE2_SENSITIVE.includes(k));
      assert(
        leaked.length === 0,
        `${who} 的 list 响应含敏感列 ${leaked.join(',')} —— fields 被写成了 null（整行下发），这是安全漏洞`,
      );
      for (const need of ['id', 'ticket_no', 'store_id', 'status', 'content']) {
        assert(keys.includes(need), `${who} 的 list 响应缺业务列 ${need}（白名单过窄或成了空壳）`);
      }
      assert(
        keys.length > 10,
        `${who} 的 list 只返回 ${keys.length} 个字段（${keys.join(',')}）—— 疑似 fields:[] 空壳`,
      );
    }
    return '两类角色均回业务列，0 个敏感列';
  });

  await check('并发取号：同一条工单重复 accept 返回 409（不产生重复处理人）', async () => {
    const accept = () =>
      http(`${BASE_URL}/api/svc/tickets/${tA}/accept`, {
        method: 'POST',
        headers: { ...phase2.authA, 'Content-Type': 'application/json', 'X-Request-Id': smokeUuid() },
        body: '{}',
        timeout: 20000,
      });

    const first = await accept();
    assert(
      first.status === 200,
      `首次 accept 返回 HTTP ${first.status}：${first.body.slice(0, 200)}`,
    );

    const second = await accept();
    assert(
      second.status === 409,
      `重复 accept 返回 HTTP ${second.status}（期望 409）—— ` +
        '两次受理都成功意味着状态机没有做并发保护，会出现两个处理人',
    );
    const body = JSON.parse(second.body);
    const code = body?.errors?.[0]?.code || '';
    assert(
      String(code).includes('CONFLICT'),
      `409 的错误码是 ${code}（期望含 CONFLICT，便于前端区分"被别人抢先受理"与其他冲突）`,
    );
    return '首次 200 / 重复 409（CONFLICT）';
  });

  await check('事件必写：accept 落 accepted 事件；越权操作不留任何事件', async () => {
    // 事件时间线是本系统对客户承诺的"处置过程可追溯"的唯一载体，
    // 少写一条 = 事后无法复盘；多写一条（越权也写）= 时间线被污染。
    const events = psqlRows(
      `SELECT event_type FROM ticket_events WHERE ticket_id = ${tA} ORDER BY id`,
    );
    assert(
      events.includes('accepted'),
      `T_A(${tA}) 没有 accepted 事件，实际事件：${events.join(',') || '（空）'} —— ` +
        '状态与事件必须同事务写入，这里不同步说明事务边界错了',
    );

    const foreignEvents = Number(psqlScalar(`SELECT count(*) FROM ticket_events WHERE ticket_id = ${tB}`));
    assert(
      foreignEvents === 0,
      `越权访问的 T_B 产生了 ${foreignEvents} 条事件 —— 被拒绝的请求不该留下任何副作用`,
    );
    return `T_A 事件 ${events.length} 条（含 accepted）/ T_B 0 条`;
  });
} finally {
  // 无论断言是否失败都要清理：这些夹具是**验收数据**，不是业务数据。
  // 宁可清理失败也不要留下假工单（清理本身出错只告警，不改断言结论）。
  try {
    cleanupSmokeFixtures();
  } catch (e) {
    warnings.push(`Phase 2 验收夹具清理失败，请手工检查 smoke.%@svc.local 与 [SMOKE] 工单：${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 5. 幂等与降级（Phase 1 只做可观测性验证）
// ---------------------------------------------------------------------------
section('5. 运行时稳定性');

await check('app 容器无重启记录（启动过程未崩溃）', () => {
  const n = Number(docker(['inspect', '-f', '{{.RestartCount}}', 'svc-app']).trim());
  assertEq(n, 0, 'RestartCount');
  return '重启 0 次';
});

await check('app 日志中无 error 级别输出（仅统计应用就绪之后）', () => {
  // 为什么要卡"就绪之后"：
  //   应用启动/首次安装期间会有一批 503 —— 那时 NocoBase 还处于 installing/maintaining
  //   状态，容器探针打进来必然被网关以 `status:503` 拒绝并记为 error 日志。
  //   这是**预期行为**，不是缺陷。若把启动期也算进去，任何一次重启后本断言必然失败，
  //   断言就变成噪音了。
  // 就绪时刻 = 健康检查历史里**尾部连续成功段的起点**（即最后一次由失败转成功的时刻）。
  //
  // ⚠️ 为什么不是"第一条 exit=0 的记录"：`docker compose restart` 时旧进程还在，
  //    新容器起来 0.4 秒就可能被探针打到并返回 200（实测 09:05:13.403 收到请求、
  //    09:05:13.408 返回 200），紧接着新进程进入 maintaining/upgrading 才真正开始
  //    拒绝服务（09:05:21、09:05:26 两次 exit=1）。拿那条"假成功"当基准，
  //    启动期的 503 就会被算进来 —— 断言必然误报。
  //    取尾部连续成功段的起点，则中间那些失败会被正确地留在基准之前。
  //
  // Docker 只保留最近 5 条健康记录（FIFO）。本断言的目标场景是"刚 docker compose up
  // 完就跑冒烟"，此时窗口里必然包含启动期的失败→成功转折，基准准确。
  // 若应用已稳定运行很久（窗口里全是成功记录），基准会退化为窗口最早的一条，
  // 本断言随之退化成"最近约 2.5 分钟（5 × 30s 探针间隔）内无 error"。
  // 这是刻意接受的取舍：宁可窗口小，也不要因为一条读不准的旧时间戳而误报。
  let sinceFlag = null;
  try {
    const raw = docker([
      'inspect', '-f',
      '{{range .State.Health.Log}}{{.End}}|{{.ExitCode}}{{"\\n"}}{{end}}',
      'svc-app',
    ]);

    const probes = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const sep = l.lastIndexOf('|');
        return { end: l.slice(0, sep), ok: l.slice(sep + 1) === '0' };
      });

    let readyAt = null;
    for (let i = probes.length - 1; i >= 0; i -= 1) {
      if (!probes[i].ok) break;
      readyAt = probes[i].end;
    }

    if (readyAt) {
      // ⚠️ Health.Log 的 .End 是 Go 的 time.Time 字符串，形如
      //      `2026-09-20 08:54:30.570636442 +0000 UTC`
      //    docker logs --since **不接受**这种格式（会报
      //      invalid value for "since": parsing time ... as "2006-01-02T15:04:05.999999999Z07:00"）
      //    早期直接把原串透传进去，导致断言必然失败。
      //    这里换算成 Unix 秒再传 —— docker 对整数时间戳是稳定接受的。
      const unixSeconds = dockerTimeToUnixSeconds(readyAt);
      if (unixSeconds !== null) sinceFlag = String(unixSeconds);
    }
  } catch {
    /* 拿不到健康日志就退化为统计全量 */
  }

  const args = ['logs', 'svc-app'];
  if (sinceFlag) args.push('--since', sinceFlag);
  const logs = docker(args, { timeout: 30000 }).toString();

  // 只认 **level 字段** 是 error 的行，不做整行文本正则。
  //
  // ⚠️ 为什么不能用 `/\berror\b/` 扫整行（这是踩过的坑）：
  //   NocoBase 的全局错误处理器写日志时带 `extra.method = "error-handler"`，
  //   于是**任何**一条 4xx 都会让整行里出现 "error-handler" 这个词，
  //   `\berror\b` 在连字符前也成立 → 该行被误判成 error 日志。
  //   结果：越权 get 返回 404（这是 docs/API.md §0 明文要求的行为）、
  //   甚至健康检查期间的 401，都会让本断言红。
  //   按 level 字段判定才是"这条日志真的是 error 级吗"的准确问法。
  //
  // NocoBase 的日志格式是每行一个 JSON（LOGGER_FORMAT=json，生产默认）。
  // console 传输在容器里同样是 JSON 行，所以可以直接 parse。
  const errLines = [];
  const fallback = [];
  for (const line of logs.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    if (!text.startsWith('{')) {
      // 非 JSON 行（winston 的纯文本/堆栈残片）：保留文本兜底，
      // 但要排掉已知的良性命中，避免同一类噪声从另一条路又钻进来。
      if (/\berror\b/i.test(text) && !/error_log|0 error|ERROR_CODES|error-handler/i.test(text)) {
        fallback.push(text);
      }
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(text);
    } catch {
      // JSON 被截断（多字节字符在 docker logs 里被切开）时按文本兜底
      if (/\berror\b/i.test(text) && !/error-handler/i.test(text)) fallback.push(text);
      continue;
    }
    // winston 的 level 可能带 ANSI 颜色码（console 传输），剥掉再比
    const level = String(entry?.level ?? '').replace(/\u001b\[[0-9;]*m/g, '').trim();
    if (level === 'error') errLines.push(text);
  }

  const total = errLines.length + fallback.length;
  if (total) {
    throw new Error(
      `发现 ${total} 条 error 日志，首条：${(errLines[0] || fallback[0]).trim().slice(0, 160)}`,
    );
  }
  return sinceFlag
    ? `无 error 级日志（自 unix:${sinceFlag} 起，按 level 字段判定）`
    : '无 error 级日志（全量，按 level 字段判定）';
});

await check('连续 5 次健康检查均返回 200（稳定性）', async () => {
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const r = await http(`${BASE_URL}/api/svc:health`, { timeout: 8000 });
    codes.push(r.status);
    await sleep(300);
  }
  const bad = codes.filter((c) => c !== 200);
  assert(bad.length === 0, `出现非 200：${codes.join(', ')}`);
  return codes.join(', ');
});

await check('健康检查响应时间 < 1s（可安全用于容器探针）', async () => {
  const t0 = Date.now();
  await http(`${BASE_URL}/api/svc:health`, { timeout: 8000 });
  const ms = Date.now() - t0;
  assert(ms < 1000, `耗时 ${ms}ms 超过 1s`);
  return `${ms}ms`;
});

// ============================================================================
console.log('');
console.log('══════════════════════════════════════════════════════════════');
if (failures.length === 0) {
  console.log(`  ✅ Phase 1 端到端验收全部通过：${passed} 项`);
  console.log('══════════════════════════════════════════════════════════════');
  if (warnings.length) {
    console.log('');
    for (const w of warnings) console.log(`  ⚠️  ${w}`);
  }
  console.log('');
  console.log(`  验收门槛达成：curl ${BASE_URL}/api/svc/health`);

  const summary = health
    ? `{"db":"${health.db}","sms":"${health.sms}","tasks":"${health.tasks}"}`
    : '';
  console.log(`                 → ${summary}`);
  console.log('');
  process.exit(0);
} else {
  console.log(`  ❌ 通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`     • ${f.label}\n       ${f.message}`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(1);
}
