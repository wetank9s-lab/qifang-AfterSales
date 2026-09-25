#!/usr/bin/env node
/**
 * =============================================================================
 *  smoke-test.mjs —— Phase 1~4 端到端验收自检（需要 Docker daemon 在跑）
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
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { EXPECTED_INDEXES, indexSignature, parseIndexDef } from './expected-indexes.mjs';
import {
  readDefaultSettingKeys as readDefaultSettingKeysImpl,
  CONSTANTS_TS_PATH,
} from './expected-settings.mjs';
import {
  SENSITIVE_COLUMN_SET,
  REQUIRED_ADMIN_PAGES,
  TICKET_STATUS_TABS,
  DEFAULT_FILTER_MIN_FIELDS,
  ADMIN_NAV_GROUP,
  MANAGED_MENU_ROLES,
  visiblePagesOf,
} from './expected-sensitive-columns.mjs';
import {
  DISPATCH_SERVICE_MODE_LABELS,
  IDEMPOTENCY_REPLAY_HEADER,
  INTERNAL_WRITE_SCENES,
  REQUEST_ID_HEADER,
  uiDispatchPayload,
  uiReschedulePayload,
  uiWriteHeaders,
} from './expected-h6-contract.mjs';

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

/**
 * 从插件源码里读出 DEFAULT_SETTINGS 的全部 key（**参数种子的单一事实来源**）。
 *
 * 为什么不把 16 / 17 写死在断言里（Phase 4 的真实教训）：
 *   Phase 3 时本脚本在两处写死了「恰为 16 项」，Phase 4 新增 `sms.enabled` 后
 *   两条断言同时变红 —— 而**代码是对的，红灯全在脚本自己身上**。
 *   这类"过期期望"会训练人忽略红灯（工程铁律 2），比没有断言更糟。
 *
 *   现在改成从 constants.ts 现读：断言永远跟着常量走，
 *   而"库里到底几行、是哪几行"仍由真机数据回答。
 *   断言强度不降反升 —— 见下面"集合相等"那一条，它同时能抓漏插与多插。
 *
 * ⚠️ 实现已抽到 `scripts/expected-settings.mjs`（与 `verify-plugin-load.mjs` 共用）。
 *    2026-09-23 实测：这段逻辑原先在这里与那边**各抄了一份**，
 *    常量一改成 `TECHNICIAN_SETTING_KEY.*`，两份解析器**同时变瞎**
 *    （真实 17 项被读成 14 项）→ 本脚本报"service_settings 有 17 行，期望 14
 *    —— 多于 14 说明有人绕过 seeds/apply.ts 直接插入"，**指控完全错误**。
 *    共用一份之后，这类"两份一起漂"的问题从根上消失。
 */
const readDefaultSettingKeys = () => readDefaultSettingKeysImpl(CONSTANTS_TS_PATH);

// ------------------------------------------------------------------ 断言框架 --
let passed = 0;
const failures = [];
const warnings = [];
/**
 * 「显式跳过」哨兵。
 *
 * ⚠️ 为什么必须与"通过"分开计数：
 *   旧实现里"跳过"就是 `return '⚠️ 已跳过…'`，而 `check()` 把**任何不抛异常的返回**
 *   都算 `passed++` → 汇总写成「全部通过：N 项」，**跳过项被伪装成通过**。
 *   那正是用户明令禁止的"用总闸全绿掩盖缺失"。走查洁净基线（Visit=0）会稳定触发
 *   这一分支，于是这个假绿每轮都会复现。
 *   ⇒ 跳过必须：① 走独立的 `SkipCheck` 分支；② 计入 `skipped`；
 *   ③ 在汇总里**单独打印**，不并入 `passed`。
 */
class SkipCheck extends Error {}
let skipped = 0;
const skipReasons = [];

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
    if (e instanceof SkipCheck) {
      skipped++;
      skipReasons.push({ label, message: e.message });
      console.log(`  ⏭️  ${label} — ${e.message}`);
      return;
    }
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
console.log('  Phase 1~4 端到端验收自检（smoke-test）');
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

function containerStatus(name) {
  const s = docker(['inspect', '-f', '{{.State.Status}}|{{.State.Health.Status}}', name]).trim();
  const [state, health] = s.split('|');
  return { state, health };
}

/** 验收硬门槛要求的容器（见下面"postgres 与 app 均为 healthy"那条断言） */
const HEALTHY_REQUIRED = ['svc-postgres', 'svc-app'];

/**
 * 可选等待应用就绪 —— 必须等到 **HTTP 可服务 AND health 已收敛**，两个条件都满足。
 *
 * 为什么不能只等 HTTP 200（Phase 4-H 开工首日踩到，见 DEV-50）：
 *   app 的 healthcheck 是 `interval: 30s / start_period: 240s`。重启后应用往往
 *   10~15s 就能对外服务（health 接口 200），但 Docker 要等到**下一个探测周期**
 *   （最长 30s 后）才会把状态从 `starting` 翻成 `healthy`。
 *   旧实现的循环体是 `if (r.status === 200) { ready = true; break; }` ——
 *   一拿到 200 就跳出，于是**每次"重启 app 后跑总闸"这条断言都必然误报**
 *   为 `svc-app=starting`：它前面 96 项全绿、后面 34 项也全绿，单看结论
 *   像"部署有毛病"，实际是脚本自己在测一个刚刚开始的竞态。
 *   这正是工程铁律 2 —— 会误报的检查比没有检查更糟，常亮的假红灯会把真红灯淹掉。
 *
 * 修法**不是**放宽断言（`starting` 本来就该算"未就绪"），而是给它收敛的时间：
 * 真实验收要回答的是"这次部署最终会不会收敛到 healthy"，那就得等它收敛。
 * 等待上限仍由 `--wait` 统一控制，超时只记 warning 不静默吞掉（下面第二条 warning）。
 */
if (WAIT_SECONDS > 0) {
  process.stdout.write(`  … 等待应用就绪（最多 ${WAIT_SECONDS}s）`);
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let httpReady = false;
  let unhealthy = [];
  while (Date.now() < deadline) {
    if (!httpReady) {
      try {
        const r = await http(`${BASE_URL}/api/svc/health`, { timeout: 5000 });
        if (r.status === 200) httpReady = true;
      } catch {
        /* 还没起来，继续等 */
      }
    }
    if (httpReady) {
      // 只有在应用已经能服务以后才看 health：否则会在启动期白刷 docker 调用
      unhealthy = HEALTHY_REQUIRED.filter((n) => containerStatus(n).health !== 'healthy');
      if (unhealthy.length === 0) break;
    }
    process.stdout.write('.');
    await sleep(3000);
  }
  const settled = httpReady && unhealthy.length === 0;
  console.log(settled ? ' 就绪（HTTP 200 且 health=healthy）' : ' 超时');
  if (!httpReady) {
    warnings.push(
      `等待 ${WAIT_SECONDS}s 后 /api/svc/health 仍未返回 200 —— ` +
        `若下面出现大面积红灯，先怀疑"应用根本没起来"，而不是业务逻辑坏了`,
    );
  } else if (unhealthy.length) {
    warnings.push(
      `等待 ${WAIT_SECONDS}s 后应用已可服务（HTTP 200），但 ${unhealthy.join(', ')} 仍未 healthy；` +
        `healthcheck 的 interval=30s，重启后收敛需要时间 —— 加大 --wait 后复跑`,
    );
  }
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
  if (bad.length) {
    throw new Error(
      `未达 healthy：${bad.join(', ')}` +
        (bad.some((b) => b.endsWith('=starting'))
          ? '（starting = healthcheck 周期还没走到；用 --wait 等收敛后复跑，见 DEV-50）'
          : ''),
    );
  }
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

await check('参数种子：播种日志自洽（若走 install 路径），且落库数量与 DEFAULT_SETTINGS 一致', () => {
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
  //   · 有日志 → 本次启动确实走了播种路径 → 断言数字自洽（created + skipped == 常量数）
  //   · 无日志 → 已安装实例，播种不重跑 → 种子齐全性由数据库回答（本断言仍查一次总数，
  //              与后面第 4 节的"集合相等"断言互为交叉验证）
  //
  // ⚠️ 数量期望来自 constants.ts 的 DEFAULT_SETTINGS，**不在这里复写**
  //    （Phase 4 加 `sms.enabled` 时，写死的 16 曾让这里假红，见函数注释）。
  const expectedKeys = readDefaultSettingKeys();
  const logs = docker(['logs', 'svc-app'], { timeout: 30000 }).toString();
  const line = logs.split('\n').find((l) => l.includes('参数种子：'));

  const dbCount = Number(psql('SELECT count(*) FROM service_settings'));
  assert(
    dbCount === expectedKeys.length,
    `service_settings 有 ${dbCount} 行，期望 ${expectedKeys.length}（= DEFAULT_SETTINGS 项数）—— ` +
      `少于 ${expectedKeys.length} 说明播种没跑完，多于 ${expectedKeys.length} 说明有人绕过 seeds/apply.ts 直接插入` +
      '（阈值来源将不可追溯）',
  );

  if (!line) {
    return `已安装实例（容器重建后 install 不重跑，故无播种日志）；DB ${dbCount} 项`;
  }

  const m = /新增\s*(\d+)\s*项，跳过（已存在）\s*(\d+)\s*项/.exec(line);
  assert(m, `参数种子日志格式不认识（seeds/apply.ts 改了文案？）：${line.trim().slice(-90)}`);
  const created = Number(m[1]);
  const skipped = Number(m[2]);
  assert(
    created + skipped === expectedKeys.length,
    `日志自相矛盾：新增 ${created} + 跳过 ${skipped} = ${created + skipped}，期望 ${expectedKeys.length} ` +
      '（这两个数来自同一次 for 循环，和值不符说明 DEFAULT_SETTINGS 与断言漂移了）',
  );
  return `新增 ${created} 项 / 跳过 ${skipped} 项；DB ${dbCount} 项`;
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

await check('H5 客户报修站点可访问（bind mount + 真实构建产物生效）', async () => {
  const r = await http(`${BASE_URL}/h5/`);
  assertEq(r.status, 200, 'HTTP 状态码');
  // Phase 3 起 /h5/ 不再是占位页，而是 Vite 构建出的真实 SPA 入口。
  // 页面本身不含任何可见文案（文案都在 JS 里），所以判据只能是挂载点 + 资源引用。
  assert(
    r.body.includes('<div id="app">'),
    '缺少 SPA 挂载点 <div id="app"> —— 挂上去的不是 Vite 构建产物',
  );
  const asset = r.body.match(/src="(\/h5\/assets\/[^"]+)"/);
  assert(
    asset,
    'index.html 未引用 /h5/assets/*.js —— 构建产物不完整（clone 后忘了 `cd h5 && npm run build`？）',
  );

  // 单独把 JS 真拉一次：DEV-29 记录过 `alias` 写法会让 /h5/assets/ 走 301 并丢端口，
  // 只验 index.html 返回 200 抓不到那个坑，必须让资源真落到流里。
  const js = await http(`${BASE_URL}${asset[1]}`);
  assertEq(js.status, 200, `${asset[1]} HTTP 状态码`);
  assert(js.body.length > 1000, `${asset[1]} 仅 ${js.body.length} 字节，疑似空文件`);
  return `HTTP 200，挂载点 ✓，资源 ${asset[1]} ${js.body.length} 字节`;
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

/**
 * 本插件的 11 个 **collection 名**（camelCase），与 EXPECTED_TABLES（snake_case 表名）一一对应。
 *
 * 为什么不在这里手抄一份：手抄的清单一定会与 collections/*.ts 漂移，
 * 而漂移的表现是"§4e 说后台少了某张表"却查不出到底谁对。
 * 直接从集合定义里读 —— 与 readDefaultSettingKeys() 同一思路：
 * 脚本的期望值必须来自**唯一事实来源**，而不是再抄一遍。
 *
 * `| sort -u` 语义：同一目录下每个文件恰好声明一个 collection。
 */
function readBusinessCollectionNames() {
  const dir = path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/collections');
  const names = new Set();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.startsWith('_') || file === 'index.ts') continue;
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    // 只认顶格的 `name: 'xxx',`（字段名是缩进两格的写法，不会误命中）
    const m = /^\s{2}name:\s*'([A-Za-z][A-Za-z0-9]*)',/m.exec(src);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

const BUSINESS_COLLECTION_NAMES = readBusinessCollectionNames();

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

await check('service_settings 的行集合与 DEFAULT_SETTINGS 逐键一致（无漏插、无绕过播种的插入）', () => {
  // 从"数量相等"升级为"**集合相等**"，两个理由：
  //   ① 只比数量发现不了"插错键"——漏了一个又多了另一个时数量照样相等，
  //      而缺的那项会让 ConfigService 回落到代码默认值、运营在后台看到的阈值与实际不符；
  //   ② 数量是手抄的，Phase 4 新增 `sms.enabled` 时它直接变成假红灯（见 readDefaultSettingKeys 注释）。
  // 期望侧现读 constants.ts，所以这条断言会跟着常量演进，且强度只增不减。
  const expected = readDefaultSettingKeys().slice().sort();
  const rows = psqlRows('SELECT key FROM service_settings ORDER BY key').slice().sort();
  const missing = expected.filter((k) => !rows.includes(k));
  const extra = rows.filter((k) => !expected.includes(k));
  assert(
    missing.length === 0 && extra.length === 0,
    `缺少 ${JSON.stringify(missing)}；多出 ${JSON.stringify(extra)}`,
  );
  return `${rows.length} 项，与常量逐键一致`;
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
/**
 * 资源级授权上应有的**只读动作**集合 —— 必须与插件常量
 * `ROLE_NATIVE_READ_ACTIONS`（nocobase/.../server/constants.ts）同集合。
 *
 * ⚠️ `view` 不是可有可无的美化项（DEV-65）：NocoBase 的 ACL 是**两级判定**，
 * 资源级缺 `view` 会让后台表格区块的前端 ACL 探针（`aclCheck({actionName:'view'})`）
 * 失败 → `TableBlockModel.hidden = true` → grid 剪掉整行 → **表格整块不渲染**。
 * 现象是"能登录、菜单能点、搜索框也在，就是没有表格"，极具迷惑性。
 */
const PHASE2_READ_ACTIONS = ['view', 'list', 'get'];
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
    if (Number(n) !== PHASE2_READ_ACTIONS.length) wrongActionCount.push(`${role}/${resource}=${n}`);
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
    `这些资源授权的 action 行不是 ${PHASE2_READ_ACTIONS.length} 条` +
      `（${PHASE2_READ_ACTIONS.join('/')}）：${wrongActionCount.join(', ')} ` +
      '（现象：该 action 恒 403，且日志里只有一句 No permissions）',
  );
  return (
    `${PHASE2_ROLES.length} 角色 × ${PHASE2_RESOURCES.length} 资源 × ` +
    `${PHASE2_READ_ACTIONS.length} action 齐全`
  );
});

await check('资源授权表与代码期望逐行一致：0 条无主行、恰好 16 条授权、48 条 action、每张表白名单唯一', () => {
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
  assert(
    totalActions === expectedResources * PHASE2_READ_ACTIONS.length,
    `action 行 ${totalActions} 条，期望 ${expectedResources * PHASE2_READ_ACTIONS.length} 条` +
      `（${PHASE2_READ_ACTIONS.join('/')}）`,
  );

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
const SMOKE_ADMIN_PASSWORD = envValue('SMOKE_ADMIN_PASSWORD', '');
// ---- 安全债清理（用户 2026-09-25 判 A 类，本次清除）----
// 最早公开提交（d9c617e）里这里是 envValue('SMOKE_ADMIN_PASSWORD', 'admin123') ——
// 明文默认值直接进了 public 仓库（该口令已轮换，历史里的残留值已失效）。
// 现在的口径：**未设置就明确失败**，不存在任何默认口令 fallback；
// 绝不发"空密码登录"这种注定失败、还把真实失败原因（口令缺失）掩盖掉的请求。
if (!SMOKE_ADMIN_PASSWORD) {
  console.error(
    '\n  ❌ SMOKE_ADMIN_PASSWORD 未设置 —— 烟测拒绝在无管理员口令的状态下运行。\n' +
      '     请在 .env 里设置 SMOKE_ADMIN_PASSWORD=<管理员口令> 后重试（模板见 .env.example）。\n',
  );
  process.exit(1);
}
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
  // ⚠️ Phase 4 起夹具会产生 Visit 与 SmsLog，而它们**没有外键约束** ——
  //    NocoBase 只为 belongsTo 建「列 + 索引」，不建 FK（真机 information_schema 取证过），
  //    所以删工单**不会**连带删除它们。必须在删工单之前显式清掉，否则每跑一轮
  //    就留下指向已不存在工单的孤儿行：越积越多，还会污染任何"Visit 总数 / 第 N 条"类断言。
  psql(
    "DELETE FROM sms_logs WHERE ticket_id IN " +
      "(SELECT id FROM service_tickets WHERE content LIKE '[SMOKE]%')",
  );
  psql(
    "DELETE FROM service_visits WHERE ticket_id IN " +
      "(SELECT id FROM service_tickets WHERE content LIKE '[SMOKE]%')",
  );
  psql(
    "DELETE FROM ticket_events WHERE ticket_id IN " +
      "(SELECT id FROM service_tickets WHERE content LIKE '[SMOKE]%')",
  );
  // 2026-09-21：内部写动作的幂等记录（scene = svc_*）也要清。
  //   它们没有指向工单的外键，只靠 `scene + idempotency_key` 唯一约束存在；
  //   不清就会一行行累积，而任何"幂等记录总数"类的断言都会随库龄漂移成假红。
  //   按 scene 白名单删（而不是 LIKE 'svc_%' 之外都不动），避免误删 public_ticket 的记录。
  psql(
    "DELETE FROM idempotency_records WHERE scene IN (" +
      INTERNAL_WRITE_SCENES.map((s) => `'${s}'`).join(',') +
      ')',
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
    assert(rows.length > 0, '门店用户一行都没返回 —— 隔离被做成了"谁都看不见"');

    const foreign = rows.filter((row) => Number(row.store_id) !== storeIds.S01);
    assert(
      foreign.length === 0,
      `返回了 ${foreign.length} 行别家门店的数据（store_id=${foreign.map((x) => x.store_id).join(',')}）`,
    );

    // 上面只证明"没越界"，还得证明"没被过度裁剪"。但不能直接断言 T_A 就出现在这一页里：
    // 默认排序 + pageSize=100，而 S01 是验收主战场（并发压测一次就落 100 张），
    // 库里早已 200+ 张，新造的 T_A（id 最大）必然被挤出第 1 页 ——
    // 那样会得到一条**随库龄漂移的假红灯**（Phase 2 时库是空的，所以当时是绿的）。
    // 正确做法：用 filter 把范围收窄到本次夹具这两张单，再断言"只剩本店的 T_A"。
    // 顺带验到 scope 是 `$and` 叠加而非覆盖 —— 请求里的 filter 挤不掉范围条件。
    const filter = encodeURIComponent(JSON.stringify({ id: { $in: [tA, tB] } }));
    const scoped = await http(
      `${BASE_URL}/api/serviceTickets:list?pageSize=100&filter=${filter}`,
      { headers: phase2.authA, timeout: 15000 },
    );
    assert(scoped.status === 200, `带 filter 的 list 返回 HTTP ${scoped.status}`);
    const scopedIds = JSON.parse(scoped.body).data.map((row) => Number(row.id));
    assert(scopedIds.includes(tA), `本店工单 T_A(${tA}) 不在结果里 —— list 被过度裁剪了`);
    assert(
      !scopedIds.includes(tB),
      `他店工单 T_B(${tB}) 混进来了 —— storeScope 过滤没生效或写反了`,
    );
    return (
      `第 1 页 ${rows.length} 行全部属于 S01(${storeIds.S01})；` +
      `定向 filter {T_A,T_B} → 仅 ${scopedIds.join(',')}`
    );
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
// 4c. Phase 3 验收（客户 H5 报修：/api/public/* + 服务端守卫链 ①~⑧）
// ---------------------------------------------------------------------------
//
// 为什么这一段必须并进 smoke-test，而不是只在 verify-phase3-h5.mjs 里跑：
//   本脚本是**唯一**"干净机器部署后必须过"的总闸（DEV-PLAN Phase 10 把它写成了
//   发布形态可复现的前提）。Phase 3 是客户唯一能直接触达的入口，它的主链路
//   （建单 / 幂等 / 隐私门槛 / 重复单 / 频控）若不进总闸，就会出现
//   "总闸全绿，但客户报修其实是坏的"这种最难看的失败。
//
// 与 verify-phase3-h5.mjs 的分工（刻意不重复覆盖）：
//   那个脚本管 **H5 自身**：前后端常量逐字对齐、提交器 single-flight、构建产物、
//   同一 request_id 并发 10 路。这里管 **服务端对外契约**：HTTP 语义 + 落库 + 守卫链顺序。
//   本段只走 nginx，不碰前端构建，因此不依赖 h5/node_modules 与 esbuild。
//
// ⚠️ "应用层 429" 为什么用**临时降阈值**的办法，而不是连发 30+ 次打满真实阈值：
//   实测（本机 2026-09-20，45 次连发同一 request_id）：
//     nginx `svc_public burst=10` 只放行 **11 次**突发（1×201 + 10×200），
//     第 12 次起就是 nginx 自己的 429（响应体 `{"code":"TOO_MANY_REQUESTS"}`），
//     而这时应用层 `guardQuota.used` 才 11 —— 离 30 的阈值还差得远。
//   也就是说：走 nginx 打满**应用层**阈值，必须先被网关拦下、再按 0.5 次/秒的回填速率
//   慢慢喂够 30 次，需要约 60 秒；而且会把 nginx 的桶打空，让**紧接着的下一轮**本段
//   全部失败（一条与产品无关的假红灯）。
//   改用"库里阈值临时降到 2 + 3 个请求"：全程 3 个请求，远不到 nginx 的 11 次突发上限，
//   无冷却、可重复跑，而且走的是**完全相同的** HTTP 路径（nginx → 插件 → GuardService）。
//   顺带还验到一条真实性质：阈值来自**库**、10s TTL 内生效、**不需要重启**（DEV-31）。
//   nginx 自己那层 429 的语义（`limit_req_status 429` + JSON 错误体）已由
//   `scripts/verify-config.mjs` 静态覆盖，无需在这里把桶打空来重复证明。
section('4c. Phase 3 验收（客户 H5 报修：公开接口 + 守卫链）');

const PHASE3_STORE = 'S01';
const PHASE3_IP_KEY = 'security.ip_minute_limit';
/** 生产阈值（恢复用）。真正的判定阈值一律以库/诊断接口为准，不从这里读。 */
const PHASE3_IP_PROD = 30;
const PHASE3_IP_TEST = 2;
/** 诊断接口的共享密钥 = 进程内 SIGN_SECRET（见 guard-quota.ts 的两道闸门） */
const PHASE3_DIAG_KEY = envValue('SIGN_SECRET', '');
/**
 * 每轮用独立手机号：手机号日额度（默认 5）是**按号**计的，
 * 复用固定号会被上一轮吃掉额度，于是本轮第一条就被 429 —— 又是一条假红灯。
 */
const PHASE3_MOBILE = `138${String(Date.now()).slice(-8)}`;
const PHASE3_REQUEST_ID = crypto.randomUUID();

// ---------------------------------------------------------------------------
// Phase 3.1 —— 重复单识别必须包含"事项文本"维度
//
// Phase 3 独立复核指出：原实现只比 手机号+门店+类型+时间窗，漏了 PHASE-0 §9.4
// 明文要求的"事项文本相似"，于是"同客户在同店 10 分钟内分别报修空调和冰箱"这种
// **完全合法的场景**会被判成重复单。修法见 guard-service.ts 的 normalizeContent()。
// 下面五组断言逐条钉住修正后的规则，并且**必须在总闸里**（单独脚本没人跑）。
// ---------------------------------------------------------------------------

/** 每组独立手机号：手机号日额度默认 5/日，且 409 的请求同样消耗额度 */
const PHASE31_SEQ = String(Date.now()).slice(-7);
const phase31Mobile = (n) => `137${String(Number(PHASE31_SEQ) + n).padStart(8, '0')}`;

/**
 * 动手前等待 nginx 令牌桶回填。
 *
 * `/api/public/` 走 `limit_req zone=svc_public rate=30r/m burst=10`（DEV-34）：
 * 真实吞吐是「11 次突发 + 0.5 次/秒回填」，且 **nginx 不看应用层是否拒绝** ——
 * 上面那些 400/422 的请求同样消耗令牌。本节要连发约 10 次，
 * 不等就会撞上网关 429，把"不同事项被误判成重复"伪装成"频控生效"，归因完全跑偏。
 * 22s 足以把桶补满（11 ÷ 0.5 = 22），代价是每轮多 22 秒，换来结论可信。
 */
const PHASE31_REFILL_MS = 22_000;

const phase31Body = (mobile, content, overrides = {}) =>
  phase3TicketBody({ customer_mobile: mobile, content, ...overrides });

/** 今天的取号器当前值 —— "重复单不消耗序号"这条断言的**唯一**证据来源 */
function phase31TodaySeq() {
  return Number(
    psqlScalar(
      'SELECT COALESCE((SELECT current_value FROM daily_sequences ' +
        "WHERE seq_key = 'FW-' || to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYYMMDD')), 0)",
    ),
  );
}

/** 该手机号名下的工单数（手机号由脚本生成，不含外部输入，可安全内插） */
function phase31Count(mobile) {
  return Number(
    psqlScalar(`SELECT count(*) FROM service_tickets WHERE customer_mobile = '${mobile}'`),
  );
}

/** 只清本段要用到的桶（两个匿名场景的 ip 行），不动 mobile 行 */
function phase3ResetIpBuckets() {
  psql(`DELETE FROM api_guards WHERE scope = 'ip' AND scene IN ('public_ticket','public_store')`);
}

function phase3SetIpLimit(value) {
  psql(
    `UPDATE service_settings SET value = '${value}', updated_at = now() ` +
      `WHERE key = '${PHASE3_IP_KEY}'`,
  );
}

async function phase3GuardQuota(scene = 'public_ticket') {
  const r = await http(`${BASE_URL}/api/svc:guardQuota?scene=${scene}&scope=ip`, {
    headers: { 'X-Svc-Diag-Key': PHASE3_DIAG_KEY },
    timeout: 15000,
  });
  assert(
    r.status === 200,
    `限流诊断接口返回 HTTP ${r.status} —— 通常是 X-Svc-Diag-Key 与 .env 的 SIGN_SECRET 不一致` +
      `（该接口对密钥不符一律 404，fail-closed，且刻意不回 401/403）`,
  );
  return parseJson(r.body, 'guardQuota').data;
}

/** 轮询到新阈值真正生效（ConfigService 有 10s TTL：改库即可，不需要重启但必须等一拍） */
async function phase3WaitIpLimit(expected, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let seen = null;
  while (Date.now() < deadline) {
    seen = (await phase3GuardQuota()).limit;
    if (seen === expected) return seen;
    await sleep(1000);
  }
  throw new Error(
    `等待 ${PHASE3_IP_KEY}=${expected} 生效超时（仍读到 ${seen}）—— ` +
      `ConfigService TTL 是 10s，超过 30s 说明改库没落地，或被别处覆盖`,
  );
}

/**
 * 区分"到底是谁在限流"。
 *
 * nginx 的 429 体是 `{"code":"TOO_MANY_REQUESTS"}`（verify-config 有静态断言），
 * 应用层的是 `{"errors":[{"code":"RATE_LIMITED",...}]}`。
 * 不区分的话，"网关把请求拦了"会被读成"应用层频控生效了" —— 结论看着对、归因全错，
 * 排查时会在错误的层里找半天。
 */
function phase3LimitSource(r) {
  if (r.body.includes('RATE_LIMITED')) return '应用层';
  if (r.body.includes('TOO_MANY_REQUESTS')) return 'nginx 网关层';
  return '未知';
}

function phase3TicketBody(overrides = {}) {
  return {
    store_code: PHASE3_STORE,
    ticket_type: 'repair',
    content: '[SMOKE] Phase3 验收：客户报修主链路',
    customer_name: '冒烟验收',
    customer_mobile: PHASE3_MOBILE,
    privacy_agreed: true,
    ...overrides,
  };
}

/** 发一次建单请求。`sendRequestId=false` 用于验"缺请求号"的门槛。 */
async function phase3Post(body, { requestId = PHASE3_REQUEST_ID, sendRequestId = true } = {}) {
  return http(`${BASE_URL}/api/public/tickets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sendRequestId ? { 'X-Request-Id': requestId } : {}),
    },
    body: JSON.stringify(body),
    timeout: 15000,
  });
}

const phase3 = { ticketNo: null };

try {
  // 先清干净本段要用的桶：否则"第几次被拒"会随上一轮的残留计数漂移，断言不再确定。
  phase3ResetIpBuckets();

  await check('Phase3: 门店列表只回 code/name 两列（匿名接口最小披露）', async () => {
    const r = await http(`${BASE_URL}/api/public/stores`, { timeout: 15000 });
    assertEq(r.status, 200, 'HTTP 状态码');
    const rows = parseJson(r.body, '门店列表').data;
    assert(
      Array.isArray(rows) && rows.length > 0,
      '门店列表为空 —— 客户在报修页无处可选，等于这个功能不可用',
    );
    const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
    assert(
      JSON.stringify(keys) === JSON.stringify(['code', 'name']),
      `门店列表回了 ${keys.join(', ')} —— 匿名接口只该给 code/name（连 id 都不该出）`,
    );
    assert(
      rows.some((row) => row.code === PHASE3_STORE),
      `列表里没有 ${PHASE3_STORE} —— 后续建单要用的门店在页面上不可选`,
    );
    return `${rows.length} 家启用门店，字段 ${keys.join('/')}`;
  });

  await check('Phase3: 建单成功返回 201，响应体恰好三字段（不泄露 id/手机号）', async () => {
    const r = await phase3Post(phase3TicketBody());
    assert(
      r.status === 201,
      `HTTP ${r.status}（期望 201）` +
        (r.status === 429 ? ` —— ${phase3LimitSource(r)}在限流` : '') +
        ` ${r.body.slice(0, 160)}`,
    );
    const data = parseJson(r.body, '建单').data;
    const keys = Object.keys(data).sort();
    assert(
      JSON.stringify(keys) === JSON.stringify(['created_at', 'store_name', 'ticket_no']),
      `响应字段是 ${keys.join(', ')}，期望 created_at/store_name/ticket_no —— ` +
        '多回一个 id 就等于把内部主键交给匿名调用方',
    );
    assert(
      /^FW\d{8}-\d{4}$/.test(String(data.ticket_no)),
      `单号格式异常：${data.ticket_no}（期望 FW + 8 位日期 + 4 位序号）`,
    );
    phase3.ticketNo = data.ticket_no;
    return `${data.ticket_no} @ ${data.store_name}`;
  });

  await check('Phase3: 同 X-Request-Id 重放返回 200 + 同单号（幂等，不新建单）', async () => {
    const before = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    const r = await phase3Post(phase3TicketBody());
    assertEq(r.status, 200, 'HTTP 状态码（重放应为 200，不是 201）');
    assertEq(parseJson(r.body, '重放').data.ticket_no, phase3.ticketNo, '重放拿到的单号');
    const after = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    assertEq(after, before, '工单总数（重放不得新建）');

    const idem = Number(
      psqlScalar(
        `SELECT count(*) FROM idempotency_records WHERE scene = 'public_ticket' ` +
          `AND idempotency_key = '${PHASE3_REQUEST_ID}'`,
      ),
    );
    assertEq(idem, 1, '该 request_id 的幂等记录数（并发/重试都必须只留一条）');
    return `${phase3.ticketNo} 回放，工单总数不变（${before}）`;
  });

  await check('Phase3: 未勾选隐私说明一律 400（字段缺省 / 显式 false 两种形态）', async () => {
    const before = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    // "字段缺省"要真的把键删掉：`JSON.stringify` 会把 undefined 丢掉没错，
    // 但那依赖读者知道这一点，不如显式 delete，让意图写在代码上。
    const missingPrivacy = phase3TicketBody();
    delete missingPrivacy.privacy_agreed;
    const cases = [
      ['字段缺省', missingPrivacy],
      ['显式 false', phase3TicketBody({ privacy_agreed: false })],
    ];
    const seen = [];
    for (const [label, body] of cases) {
      // 注意：隐私门槛在守卫链 ① 之后、④ 频控之前 ——
      // 所以这两种形态**不消耗** IP/手机号额度，可以放心多打几次。
      const r = await phase3Post(body, { requestId: crypto.randomUUID() });
      assertEq(r.status, 400, `${label} 的 HTTP 状态码`);
      assertEq(parseJson(r.body, label).errors?.[0]?.code, 'PRIVACY_NOT_AGREED', `${label} 的错误码`);
      seen.push(`${label}:400`);
    }
    const after = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    assertEq(after, before, '未勾选隐私说明时落库的工单数（必须 0 增量）');
    return `${seen.join(' / ')}，且未落库`;
  });

  await check('Phase3: 缺 X-Request-Id 返回 422（不是 400/500）', async () => {
    const r = await phase3Post(phase3TicketBody(), { sendRequestId: false });
    assertEq(r.status, 422, 'HTTP 状态码');
    const err = parseJson(r.body, '缺请求号').errors?.[0];
    assertEq(err?.code, 'VALIDATION_FAILED', '错误码');
    assertEq(err?.detail?.header, REQUEST_ID_HEADER, 'detail.header（要指出缺的是哪个头）');
    return '422 VALIDATION_FAILED';
  });

  await check('Phase3: 窗口内同手机号+同门店+同类型+同内容 → 409 且回原单号', async () => {
    const r = await phase3Post(phase3TicketBody(), { requestId: crypto.randomUUID() });
    assertEq(r.status, 409, 'HTTP 状态码');
    const err = parseJson(r.body, '重复单').errors?.[0];
    assertEq(err?.code, 'DUPLICATE_TICKET', '错误码');
    assertEq(
      err?.detail?.ticket_no,
      phase3.ticketNo,
      'detail.ticket_no（必须指向原单，客户才知道自己刚才已经提交过）',
    );
    return `409 DUPLICATE_TICKET → 原单 ${phase3.ticketNo}`;
  });

  // =========================================================================
  // Phase 3.1 —— 重复单识别必须包含"事项文本"维度（A~E 五组）
  // =========================================================================
  await sleep(PHASE31_REFILL_MS);

  await check('Phase3.1-A: 完全相同内容 → 409 回原单号，且**不消耗序号**', async () => {
    const mobile = phase31Mobile(1);
    const content = '[SMOKE] Phase3.1 A 组空调不制冷';

    const seqBefore = phase31TodaySeq();
    const first = await phase3Post(phase31Body(mobile, content), {
      requestId: crypto.randomUUID(),
    });
    assertEq(first.status, 201, '首次提交的状态码');
    const no1 = parseJson(first.body, 'A 首次').data.ticket_no;

    const seqAfterCreate = phase31TodaySeq();
    assertEq(seqAfterCreate - seqBefore, 1, `建单应恰好推进 1 个序号（${seqBefore}→${seqAfterCreate}）`);

    const again = await phase3Post(phase31Body(mobile, content), {
      requestId: crypto.randomUUID(),
    });
    assertEq(again.status, 409, '内容完全相同的第二次提交');
    const err = parseJson(again.body, 'A 重复').errors?.[0];
    assertEq(err?.code, 'DUPLICATE_TICKET', '错误码');
    assertEq(err?.detail?.ticket_no, no1, 'detail.ticket_no（必须回原单号）');

    // 这两条是"重复单不消耗序号"的**直接证据**：取号发生在建单事务之前，
    // 若 ⑦ 被跳过（或误判为需要取号），序号就会凭空 +1，工单号出现空洞。
    const seqAfterDup = phase31TodaySeq();
    assertEq(seqAfterDup, seqAfterCreate, '重复单**不得**推进序号（否则工单号出现空洞）');
    assertEq(phase31Count(mobile), 1, '该手机号名下的工单数（重复单不得落新单）');

    return `409 + 原单 ${no1}；序号 ${seqBefore}→${seqAfterCreate}，重复后仍为 ${seqAfterDup}`;
  });

  await check('Phase3.1-B: 同客户不同事项 → 各建一张独立工单（Phase 3 曾误判为重复）', async () => {
    const mobile = phase31Mobile(2);
    const r1 = await phase3Post(phase31Body(mobile, '[SMOKE] Phase3.1 B 组空调不制冷'), {
      requestId: crypto.randomUUID(),
    });
    const r2 = await phase3Post(phase31Body(mobile, '[SMOKE] Phase3.1 B 组冰箱漏水严重'), {
      requestId: crypto.randomUUID(),
    });
    assertEq(r1.status, 201, '第一件事（空调不制冷）');
    assertEq(
      r2.status,
      201,
      '第二件事（冰箱漏水）—— 这正是 Phase 3 会挡掉的合法场景：同客户同店同类型，但不是同一件事',
    );
    const no1 = parseJson(r1.body, 'B1').data.ticket_no;
    const no2 = parseJson(r2.body, 'B2').data.ticket_no;
    assert(no1 !== no2, `两张单号必须不同（都拿到了 ${no1}）`);
    assertEq(phase31Count(mobile), 2, '该手机号名下应有 2 张独立工单');
    return `${no1} + ${no2}（两件事并行在办）`;
  });

  await check('Phase3.1-C: 仅空白/标点差异 → 仍判为重复（归一化生效）', async () => {
    const mobile = phase31Mobile(3);
    const noisy = '  [SMOKE] Phase3.1 C 组洗衣机不脱水。 ';
    const r1 = await phase3Post(phase31Body(mobile, '[SMOKE] Phase3.1 C 组洗衣机不脱水'), {
      requestId: crypto.randomUUID(),
    });
    assertEq(r1.status, 201, '首次提交');
    const no1 = parseJson(r1.body, 'C1').data.ticket_no;

    const r2 = await phase3Post(phase31Body(mobile, noisy), { requestId: crypto.randomUUID() });
    assertEq(r2.status, 409, `首尾空格 + 句号的第二次提交（原文 ${JSON.stringify(noisy)}）`);
    assertEq(parseJson(r2.body, 'C2').errors?.[0]?.detail?.ticket_no, no1, 'detail.ticket_no');
    return `「${noisy.trim()}」与首次归一化后相同 → 409 回原单 ${no1}`;
  });

  await check('Phase3.1-D: 同内容但不同 ticket_type → 允许（类型仍是独立维度）', async () => {
    const mobile = phase31Mobile(4);
    const content = '[SMOKE] Phase3.1 D 组热水器不出热水';
    const r1 = await phase3Post(phase31Body(mobile, content, { ticket_type: 'repair' }), {
      requestId: crypto.randomUUID(),
    });
    const r2 = await phase3Post(phase31Body(mobile, content, { ticket_type: 'complaint' }), {
      requestId: crypto.randomUUID(),
    });
    assertEq(r1.status, 201, 'repair');
    assertEq(r2.status, 201, 'complaint（同一件事走了不同类型，是两条独立流程）');
    const no1 = parseJson(r1.body, 'D1').data.ticket_no;
    const no2 = parseJson(r2.body, 'D2').data.ticket_no;
    assert(no1 !== no2, `两张单号必须不同（都拿到了 ${no1}）`);
    return `repair ${no1} + complaint ${no2}`;
  });

  await check('Phase3.1-E: 原单已 CANCELLED → 允许重新提交', async () => {
    const mobile = phase31Mobile(5);
    const content = '[SMOKE] Phase3.1 E 组微波炉不加热';
    const r1 = await phase3Post(phase31Body(mobile, content), { requestId: crypto.randomUUID() });
    assertEq(r1.status, 201, '首次提交');
    const no1 = parseJson(r1.body, 'E1').data.ticket_no;

    // 夹具：把这张单置为 CANCELLED。
    // 这里**刻意**用 SQL 而不是 /api/svc/ticket:cancel —— 本断言要验的只是
    // "判重是否排除 CANCELLED"这一条规则，不是取消流程本身（那由 svc 侧覆盖）。
    // 用 SQL 能避免把"登录 + 能力矩阵 + 状态前置"三件事的失败混进来，
    // 红灯的归因保持唯一。只改这一条（WHERE ticket_no = ...），不碰其它数据。
    psql(`UPDATE service_tickets SET status = 'CANCELLED', updated_at = now() WHERE ticket_no = '${no1}'`);
    assertEq(
      psqlScalar(`SELECT status FROM service_tickets WHERE ticket_no = '${no1}'`),
      'CANCELLED',
      '夹具状态写入',
    );

    const r2 = await phase3Post(phase31Body(mobile, content), { requestId: crypto.randomUUID() });
    assertEq(r2.status, 201, '原单已取消后重新提交相同内容（客户取消后重报是正常行为）');
    const no2 = parseJson(r2.body, 'E2').data.ticket_no;
    assert(no2 !== no1, `新单号必须不同于已取消的原单（都拿到了 ${no1}）`);
    return `${no1} 置为 CANCELLED → 重新提交得到 ${no2}`;
  });

  await check('Phase3: IP 分钟频控超限返回 429，来源是应用层（RATE_LIMITED + Retry-After）', async () => {
    phase3SetIpLimit(PHASE3_IP_TEST);
    await phase3WaitIpLimit(PHASE3_IP_TEST);
    phase3ResetIpBuckets();

    const statuses = [];
    let limited = null;
    for (let i = 1; i <= PHASE3_IP_TEST + 1; i += 1) {
      const r = await phase3Post(phase3TicketBody());
      statuses.push(r.status);
      if (r.status === 429) limited = r;
    }
    assertEq(statuses.join(','), '200,200,429', `阈值=${PHASE3_IP_TEST} 时前 3 次的状态码序列`);
    assert(limited, '一次 429 都没出现 —— 频控没生效');
    assertEq(phase3LimitSource(limited), '应用层', '429 的来源');
    const err = parseJson(limited.body, '429').errors?.[0];
    assertEq(err?.code, 'RATE_LIMITED', '429 错误码');
    assertEq(err?.detail?.scope, 'ip', '429 的限流维度（必须是 ip，不能被手机号额度先截胡）');
    assertEq(Number(err?.detail?.limit), PHASE3_IP_TEST, '429 detail.limit');
    const retryAfter = limited.headers.get('retry-after');
    assert(
      retryAfter && Number(retryAfter) > 0,
      `缺 Retry-After 响应头（实际 ${retryAfter}）—— 客户端无从知道何时可以重试`,
    );
    return `阈值降到 ${PHASE3_IP_TEST} → 第 ${PHASE3_IP_TEST + 1} 次 429（scope=ip，Retry-After=${retryAfter}s）`;
  });
} finally {
  // 无论断言成败，阈值必须回到生产值、桶必须清空。
  // 否则这个总闸会把自己变成故障源：后续每一轮运行、以及真机上的真实客户，
  // 都会被上一轮留下的降阈值/满桶堵在 429 上。
  try {
    phase3SetIpLimit(PHASE3_IP_PROD);
    await phase3WaitIpLimit(PHASE3_IP_PROD);
    phase3ResetIpBuckets();
  } catch (e) {
    warnings.push(
      `Phase3 频控阈值未恢复成功，请手工确认 ${PHASE3_IP_KEY}=${PHASE3_IP_PROD} ` +
        `并清空 api_guards 里 scope='ip' 的行：${e.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4d. Phase 4 验收（派工 / 改派 / 改约：Visit 生命周期 + Token 硬门槛 + 三 scene 短信）
// ---------------------------------------------------------------------------
//
// 为什么这一段必须进总闸：
//   Phase 4 是**责任落地的第一步** —— 从这一刻起系统对外承诺"谁上的门"。
//   它带来的三条硬语义（Visit 历史不可覆盖 / 旧 Token 立即失效 / 客户与师傅不共用模板）
//   都属于"做错了不会报错、只在三个月后被人发现"的类型：
//     · 改派写成"覆盖旧行" → 页面一切正常，只是返工过程不可追溯；
//     · 旧 Token 不失效 → 原师傅仍能提交回执，数据看起来完全合法；
//     · 两处共用 scene → 供应商照发，只是师傅收到一句客户话术。
//   所以它们必须在**真机 + HTTP 层**被证明，而不是只在单测里调一下 service。
//
// 本段覆盖的 8 条高风险闸门（与 docs/PHASE-4.md 的编号一一对应）：
//   ① 首次派工必须创建 Visit；② 改派必须保留旧 Visit（新建而非覆盖）；
//   ③ **改派后旧 Token 必须立即失效**（本段的核心断言）；
//   ④ 改约若重签 Token，旧 Token 同样失效；
//   ⑤ 客户短信与师傅短信必须是两个独立 scene（改派还要第三条给原师傅）；
//   ⑥ SmsProvider 保持抽象（本段只经由 mock 通道断言，不碰任何供应商 SDK）；
//   ⑦ 短信返回 accepted 只能记"已受理"，绝不记 delivered；
//   ⑧ 门店数据范围由**服务端**决定（本段用门店用户越权派别家工单来证伪）。
//
// 两个探针（`svc:tokenCheck` / `svc:smsOutbox`）为什么是**仅 mock 通道**的：
//   师傅端页面是 Phase 5 的交付物；在此之前，"旧 Token 失效"这条硬门槛如果只在
//   单测里证明，就等于没在真实链路上证明过。而 Token 明文只出现在短信里
//   （库里只有 sha256），没有取回通道就无从发起这次校验。
//   所以这两个 action **自带生产环境自毁闸**：`sms.provider` 一旦不是 mock，
//   它们立刻返回 404（见 docs/DEVIATIONS.md DEV-41）。它们不是"忘了删的调试接口"，
//   而是"在真实通道下不存在"的验收设施。
//
// ⚠️ 本段会把 `sms.enabled` 临时改成 true 并在 finally 里恢复：
//   该参数默认 false（"供应商账号还没批下来时不要照发"），而本段要断言的是
//   **短信内容与 scene 正确性**，必须让它真的走一遍发件箱。
//   它与"临时降限流阈值"是同一类做法（见 4c 段注释）：改一个小参数、
//   在 finally 里**无条件**恢复，绝不把改动留在库里。
section('4d. Phase 4 验收（派工 / 改派 / 改约：Visit 生命周期 + Token 硬门槛 + 三 scene 短信）');

const PHASE4_STORE = 'S01';
const PHASE4_STORE_OTHER = 'S02';
/**
 * 客户端产物在 HTTP 上的路径（§4e 与 §4f 共用）。
 *
 * ⚠️ 只此一处：两份定义迟早漂移，而漂移的表现是"§4f 验的是产物 A、
 *    §4e 验的是产物 B"，两个断言各自都绿，合起来什么也没证明。
 */
const PLUGIN_CLIENT_PATH = '/static/plugins/@local/service-ticket/dist/client/index.js';
const PHASE4_SMS_KEY = 'sms.enabled';
/** 恢复用原值：读一次记下来，finally 里原样写回（不假设它一定是 false） */
const PHASE4_SMS_RESTORE = psqlScalar(`SELECT value FROM service_settings WHERE key='${PHASE4_SMS_KEY}'`);
/** 每轮独立的手机号：手机号维度的守卫是**按号**计的，复用固定号会被上一轮吃掉额度 */
const PHASE4_CUSTOMER_MOBILE = `138${String(Date.now()).slice(-8)}`;
const PHASE4_TECH_A = '13900010001';
const PHASE4_TECH_B = '13900010002';

/** 夹具工单号前缀：与 [SMOKE] 内容前缀一起，保证 cleanupSmokeFixtures 能收干净 */
const phase4Stamp = Date.now();
const phase4TicketNo = (suffix) => `FWP4${phase4Stamp}${suffix}`;

/** POST 一个 svc 动作（统一带 X-Request-Id —— 写接口没有它一律 422） */
async function phase4Post(action, ticketId, auth, body) {
  const url = ticketId
    ? `${BASE_URL}/api/svc:${action}?filterByTk=${ticketId}`
    : `${BASE_URL}/api/svc:${action}`;
  const r = await http(url, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
    body: JSON.stringify(body ?? {}),
    timeout: 15000,
  });
  let json = null;
  try {
    json = JSON.parse(r.body);
  } catch {
    /* 非 JSON 交给调用方断言 */
  }
  return { status: r.status, json, body: r.body };
}

/** 取错误信封里的第一个 code（docs/API.md §0：`{ errors: [ { code } ] }`） */
const phase4ErrorCode = (res) => res.json?.errors?.[0]?.code;
const phase4ErrorMessage = (res) => res.json?.errors?.[0]?.message ?? res.body.slice(0, 160);

try {
  const phase4AdminToken = await smokeSignIn(SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD);
  const phase4Auth = { Authorization: `Bearer ${phase4AdminToken}` };

  const phase4StoreId = Number(psqlScalar(`SELECT id FROM stores WHERE code='${PHASE4_STORE}'`));
  const phase4OtherStoreId = Number(psqlScalar(`SELECT id FROM stores WHERE code='${PHASE4_STORE_OTHER}'`));
  assert(phase4StoreId && phase4OtherStoreId, `${PHASE4_STORE}/${PHASE4_STORE_OTHER} 必须都存在（门店隔离要两家才可证伪）`);

  /** 直接造一张已受理的工单（跳过 H5 建单：那一段已由 4c 段覆盖） */
  const phase4MkTicket = (storeId, storeCode, suffix, status = 'NEW') =>
    Number(
      psqlScalar(
        'INSERT INTO service_tickets ' +
          '(created_at, updated_at, ticket_no, store_id, source_store_code, source, ticket_type, ' +
          ' content, customer_mobile, status, escalated, reopen_count, review_status, feedback_token_hash) ' +
          `VALUES (now(), now(), '${phase4TicketNo(suffix)}', ${storeId}, '${storeCode}', 'qr', 'repair', ` +
          ` '[SMOKE] Phase4 ${suffix}', '${PHASE4_CUSTOMER_MOBILE}', '${status}', false, 0, 'pending', ` +
          ` 'p4hash${phase4Stamp}${suffix}') RETURNING id`,
      ),
    );

  /**
   * 造一个**非 root** 的业务账号并登录。
   *
   * ⚠️ 为什么不能直接用 `SMOKE_ADMIN_EMAIL` 那个账号来验证字段白名单：
   *   `admin@nocobase.com` 是 NocoBase 的内置 **root**，而 root **绕过 ACL** ——
   *   它的 list 响应是整行（实测 34 个字段，含 `access_token_hash`）。
   *   用它去断言"白名单挡住了 Token 哈希"必然失败，而且失败得**极具误导性**：
   *   报告上会写成"原生接口泄露 Token 哈希"，实际是测试挑错了主体。
   *   （这不是缺陷：root 能读整行是 NocoBase 的设计；真正要守的是**业务角色**。）
   */
  async function phase4MakeUser(email, username, roleName, storeId = null) {
    const created = await http(`${BASE_URL}/api/users:create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...phase4Auth },
      body: JSON.stringify({
        email,
        username,
        nickname: username,
        password: SMOKE_USER_PASSWORD,
        roles: [{ name: roleName }],
      }),
    });
    assertEq(created.status, 200, `建用户 ${email} HTTP：${created.body.slice(0, 200)}`);
    const userId = Number(JSON.parse(created.body).data.id);
    if (storeId) {
      psql(
        'INSERT INTO store_users (user_id, store_id, created_at, updated_at) ' +
          `VALUES (${userId}, ${storeId}, now(), now())`,
      );
    }
    const token = await smokeSignIn(email, SMOKE_USER_PASSWORD);
    return { userId, auth: { Authorization: `Bearer ${token}` } };
  }

  const t4 = phase4MkTicket(phase4StoreId, PHASE4_STORE, 'A');
  const t4Other = phase4MkTicket(phase4OtherStoreId, PHASE4_STORE_OTHER, 'B');
  const t4Reject = phase4MkTicket(phase4StoreId, PHASE4_STORE, 'C');
  const PHASE4_TICKET_NO = phase4TicketNo('A');
  assert(t4 && t4Other && t4Reject, 'Phase4 夹具工单创建失败');

  // 总部售后（非 root 的业务角色）：验证"字段白名单真的挡得住 Token 哈希"必须用它
  const phase4Hq = await phase4MakeUser('smoke.p4.hq@svc.local', 'smoke_p4_hq', 'hq_after_sales');

  // 受理（dispatch 的前置状态是 PROCESSING）
  for (const id of [t4, t4Reject]) {
    const acc = await phase4Post('accept', id, phase4Auth, {});
    assertEq(acc.status, 200, `accept(${id}) HTTP`);
  }
  const visitRows = (ticketId) =>
    psqlRows(
      `SELECT visit_no||'|'||visit_status||'|'||technician_mobile||'|'||` +
        `coalesce(reassigned_from_visit_id::text,'-')||'|'||coalesce(superseded_reason,'-')||'|'||` +
        `coalesce(token_revoked_reason,'-') FROM service_visits WHERE ticket_id=${ticketId} ORDER BY visit_no`,
    );
  const visitIds = (ticketId) =>
    psqlRows(`SELECT id FROM service_visits WHERE ticket_id=${ticketId} ORDER BY visit_no`).map(Number);
  const smsRows = (ticketId) =>
    psqlRows(
      `SELECT scene||'|'||recipient_masked||'|'||send_status||'|'||coalesce(delivery_status,'-')||'|'||` +
        `coalesce(visit_id::text,'-') FROM sms_logs WHERE ticket_id=${ticketId} ORDER BY id`,
    );
  const smsScenes = (ticketId) => smsRows(ticketId).map((r) => r.split('|')[0]);
  const visitCount = (ticketId) =>
    Number(psqlScalar(`SELECT count(*) FROM service_visits WHERE ticket_id=${ticketId}`));

  /**
   * 从 mock 发件箱里按 **ticket_no + scene** 精确取回短信。
   *
   * ⚠️ 必须双重过滤，不能"取最新一条"：
   *   发件箱是**进程内**内存队列，跨轮次、跨工单都不清空。早期探针按
   *   `items.pop()` 取最新，结果拿到了上一张工单的 Token，于是
   *   "改派后旧 Token 失效"这条断言看起来通过了、实际证的是别的工单。
   *   这与工程铁律 6（断言必须与库龄无关）是同一件事。
   */
  async function phase4OutboxFor(scene, ticketNo) {
    const r = await http(`${BASE_URL}/api/svc:smsOutbox?since_seq=0&limit=100`, {
      headers: phase4Auth,
      timeout: 15000,
    });
    assertEq(
      r.status,
      200,
      'smsOutbox HTTP —— 非 mock 通道下这个接口不存在（返回 404），' +
        `实际 ${r.status}：${r.body.slice(0, 160)}`,
    );
    const data = parseJson(r.body, 'smsOutbox').data;
    return (data.items ?? [])
      .filter((i) => i.params?.ticket_no === ticketNo && i.scene === scene)
      .sort((a, b) => a.seq - b.seq);
  }
  const phase4TokenOf = (entry) => /\/([A-Za-z0-9_-]{43})$/.exec(entry?.params?.link ?? '')?.[1];

  const futureIso = new Date(Date.now() + 86400000).toISOString();
  const dispatchBody = (name, mobile) => ({
    service_mode: 'inhouse',
    technician_name: name,
    technician_mobile: mobile,
    expected_visit_at: futureIso,
  });

  let visit1Id = 0;
  let visit2Id = 0;
  let token1 = '';
  let token2 = '';

  // ---- ⓿ 通道未就绪这条闸（用它顺带把默认值也验了） ----
  //
  // 顺序是刻意的：**先**在 `sms.enabled=false` 下派一次工，**再**打开开关。
  // 因为 ConfigService 有 10s 进程内缓存，本段只能"改一次 + 等一次"；
  // 把要验的两种状态安排在这一次等待的两侧，就等于零额外耗时地覆盖了两条路径。
  //
  // 这条闸要证明的是一句很容易写反的话：**短信发不出去，业务照常推进**。
  // 派工是既成事实（师傅已经派出去了），通知失败只能被如实记录，
  // 绝不能让派工回滚 —— 否则"短信通道没批下来"会变成"门店派不了工"。
  await check('Phase4: 通道未就绪（sms.enabled=false）时业务照常、短信如实记 rejected 且不阻断派工', async () => {
    psql(`UPDATE service_settings SET value='false' WHERE key='${PHASE4_SMS_KEY}'`);
    const tDisabled = phase4MkTicket(phase4StoreId, PHASE4_STORE, 'D');
    const acc = await phase4Post('accept', tDisabled, phase4Auth, {});
    assertEq(acc.status, 200, `accept HTTP（${phase4ErrorMessage(acc)}）`);

    const r = await phase4Post('dispatch', tDisabled, phase4Auth, dispatchBody('通道测试', '13900010009'));
    assertEq(
      r.status,
      200,
      '短信通道未就绪时派工被挡住了 —— 通知失败不该让业务失败' +
        `（${phase4ErrorMessage(r)}）`,
    );
    assertEq(visitCount(tDisabled), 1, '派工必须照常落 Visit');

    const rows = psqlRows(
      `SELECT scene||'|'||send_status||'|'||coalesce(error_code,'-') FROM sms_logs ` +
        `WHERE ticket_id=${tDisabled} ORDER BY id`,
    );
    assertEq(rows.length, 2, '短信行数（**仍要落两条日志**：没记录就无从发现"通知根本没发出去"）');
    for (const row of rows) {
      const [, sendStatus, errorCode] = row.split('|');
      assertEq(sendStatus, 'rejected', `send_status（${row.split('|')[0]}）`);
      assertEq(errorCode, 'SMS_DISABLED', `error_code（${row.split('|')[0]}）—— 失败原因必须可查，不能是一句"没发"`);
    }
    return `派工 200 / Visit 已建 / 短信 rejected×2（SMS_DISABLED）`;
  });

  // ---- ⓪ 打开短信开关，并把 ConfigService 的 10s 进程内缓存等过去 ----
  //
  // 为什么必须等：`sms.enabled` 由 ConfigService 以 **10s TTL** 缓存在进程内
  // （设计如此，为了"后台改参数不必重启"，见 services/config-service.ts）。
  // 刚写完库就断言，读到的可能是**上一个**值 —— 那会造成一条与功能无关的假红灯。
  // 全脚本只有这一处等待，而且它等的是一个**确定的**事实（缓存过期），不是"希望能好"。
  psql(`UPDATE service_settings SET value='true' WHERE key='${PHASE4_SMS_KEY}'`);
  await new Promise((resolve) => setTimeout(resolve, 11_000));

  // ---- ① 首次派工建立 Visit #1 ----
  await check('Phase4: 首次派工建立 Visit #1，并把派工快照写进工单（不覆盖任何历史）', async () => {
    const r = await phase4Post('dispatch', t4, phase4Auth, dispatchBody('张师傅', PHASE4_TECH_A));
    assertEq(r.status, 200, `dispatch HTTP（${phase4ErrorMessage(r)}）`);
    const visit = r.json.data.visit;
    visit1Id = Number(visit.id);

    assertEq(Number(visit.visit_no), 1, 'visit_no');
    assertEq(String(visit.visit_status), 'ASSIGNED', 'visit_status');

    const rows = visitRows(t4);
    assertEq(rows.length, 1, 'Visit 行数（首次派工只该有一条）');
    assertEq(rows[0], `1|ASSIGNED|${PHASE4_TECH_A}|-|-|-`, 'Visit #1 的内容');

    // 工单上的派工快照（后台列表直接读这几列，不能只在 Visit 上）
    const snap = psqlScalar(
      `SELECT status||'|'||coalesce(service_mode,'-')||'|'||coalesce(technician_mobile,'-')||'|'||` +
        `(dispatch_at IS NOT NULL)||'|'||(expected_visit_at IS NOT NULL) FROM service_tickets WHERE id=${t4}`,
    );
    assertEq(snap, `PROCESSING|inhouse|${PHASE4_TECH_A}|true|true`, '工单派工快照');

    // Visit 响应体不得带 Token 相关列（它们走 HTTP 出去过一次就多一处泄露面）
    for (const col of ['access_token_hash', 'token_expires_at', 'token_used_at']) {
      assert(!(col in visit), `dispatch 响应体里出现了 ${col}`);
    }
    return `visit=${visit1Id} #1 ASSIGNED`;
  });

  // ---- ② 客户与师傅必须是两个独立 scene ----
  await check('Phase4: 首次派工恰发两条短信，且客户与师傅是**两个不同 scene**、两个不同收件人', () => {
    const rows = smsRows(t4);
    assertEq(rows.length, 2, '短信条数');

    const scenes = rows.map((r) => r.split('|')[0]).sort();
    assertEq(
      JSON.stringify(scenes),
      JSON.stringify(['dispatch_customer', 'technician_task']),
      'scene 集合 —— 客户与师傅绝不能共用一条场景（共用时供应商照发，只是有人收到读不通的短信）',
    );

    const recipients = rows.map((r) => r.split('|')[1]);
    assertEq(new Set(recipients).size, 2, '收件人数量（客户与师傅必须各收一条）');
    // 落库必须是脱敏号：完整号码只该存在于 Visit 快照与供应商请求里
    for (const masked of recipients) {
      assert(/^\d{3}\*{4}\d{4}$/.test(masked), `收件人未脱敏落库：${masked}`);
    }
    return scenes.join(' + ');
  });

  // ---- ③ accepted ≠ delivered ----
  await check('Phase4: 短信返回 accepted 只记「已受理」，delivery_status 必须仍是 pending', () => {
    const accepted = smsRows(t4);
    assert(accepted.length > 0, '没有任何短信行，上一条断言应当已经失败');
    for (const row of accepted) {
      assertEq(row.split('|')[2], 'accepted', `send_status（scene=${row.split('|')[0]}）`);
      assertEq(
        row.split('|')[3],
        'pending',
        `delivery_status（scene=${row.split('|')[0]}）—— 供应商"已受理"不等于"已送达"，` +
          '把 accepted 记成 delivered 会让"客户没收到短信"这类投诉永远查不出来',
      );
    }
    const delivered = psqlScalar(
      `SELECT count(*) FROM sms_logs WHERE ticket_id=${t4} AND delivery_status='delivered'`,
    );
    assertEq(delivered, '0', 'delivered 行数');
    return `accepted ×${accepted.length} / delivered 0`;
  });

  // ---- ④ Token 明文只活一次 ----
  await check('Phase4: 师傅 Token 明文只存在于短信里，库里只存 sha256', async () => {
    const entries = await phase4OutboxFor('technician_task', PHASE4_TICKET_NO);
    assertEq(entries.length, 1, `首次派工的师傅短信条数（应恰好 1 条）`);
    token1 = phase4TokenOf(entries[0]);
    assert(token1, `师傅短信里没有 43 位 base64url 的作业链接：${entries[0]?.params?.link}`);
    assertEq(token1.length, 43, 'Token 长度');

    const stored = psqlScalar(`SELECT access_token_hash FROM service_visits WHERE id=${visit1Id}`);
    assert(stored && stored.length === 64, `access_token_hash 应为 sha256 十六进制（${stored?.length} 位）`);
    assert(stored !== token1, '库里存的是**明文 Token** —— 一旦库被读走就等于凭证泄露');
    assertEq(stored, createHash('sha256').update(token1).digest('hex'), 'access_token_hash 与 sha256(明文) 不符');
    // 明文与哈希都不该出现在任何 HTTP 响应里。
    // ⚠️ 必须用**业务角色**（hq_after_sales）而不是 root：root 绕过 ACL，整行下发。
    const listed = await http(
      `${BASE_URL}/api/serviceVisits:list?pageSize=200&filter=${encodeURIComponent(
        JSON.stringify({ ticket_id: t4 }),
      )}`,
      { headers: phase4Hq.auth, timeout: 15000 },
    );
    assertEq(listed.status, 200, `serviceVisits:list HTTP：${listed.body.slice(0, 160)}`);
    assert(!listed.body.includes(token1), '原生接口把明文 Token 下发了');
    assert(!listed.body.includes(stored), '原生接口把 Token 哈希下发了（字段白名单没生效）');
    // 同时确认这条断言不是空转：业务列必须在（否则"不含哈希"可能只是因为整行都没返回）
    assert(listed.body.includes('technician_mobile'), '原生接口连业务列都没返回 —— 这条断言会变成空转');
    return `明文 ${token1.length} 位 → 哈希 ${stored.slice(0, 12)}…（业务角色接口 0 泄露）`;
  });

  // ---- ⑤ 探针：有效 Token ----
  await check('Phase4: 探针 tokenCheck 认可有效 Token，且只回最小字段集', async () => {
    const r = await phase4Post('tokenCheck', null, phase4Auth, { token: token1 });
    assertEq(r.status, 200, `tokenCheck HTTP（${phase4ErrorMessage(r)}）`);
    assertEq(r.json.data.valid, true, 'valid');
    assertEq(Number(r.json.data.visit.id), visit1Id, '校验命中的 visit');
    assertEq(String(r.json.data.visit.visit_status), 'ASSIGNED', 'visit_status');
    // 探针的用途只有一个："这个 Token 有效吗"。多回一个字段就多一份被当业务接口用的可能。
    for (const leak of ['technician_mobile', 'technician_name', 'customer_mobile', 'access_token_hash']) {
      assert(!(leak in r.json.data.visit), `tokenCheck 回传了 ${leak}`);
    }
    return `visit=${visit1Id} valid`;
  });

  // ---- ⑥ 重复派工必须 409 且不改数据 ----
  await check('Phase4: 工单已有进行中派工时再派工返回 409，且一个字段都不改', async () => {
    const before = visitRows(t4);
    const r = await phase4Post('dispatch', t4, phase4Auth, dispatchBody('李四', PHASE4_TECH_B));
    assertEq(r.status, 409, `HTTP（${phase4ErrorMessage(r)}）`);
    assertEq(phase4ErrorCode(r), 'VISIT_ALREADY_ASSIGNED', '错误码');
    assertEq(visitRows(t4).length, before.length, 'Visit 行数（被拒绝的请求不该留下新 Visit）');
    assertEq(psqlScalar(`SELECT technician_mobile FROM service_tickets WHERE id=${t4}`), PHASE4_TECH_A, '工单师傅快照');
    return `409 ${phase4ErrorCode(r)}`;
  });

  // ---- ⑦ 改派：旧 Visit 原样保留 + 新建 Visit ----
  await check('Phase4: 改派是「旧 Visit 置 SUPERSEDED + 新建 Visit」，不是就地换人', async () => {
    const r = await phase4Post('reassign', t4, phase4Auth, {
      ...dispatchBody('李师傅', PHASE4_TECH_B),
      reason: '原师傅临时请假',
    });
    assertEq(r.status, 200, `reassign HTTP（${phase4ErrorMessage(r)}）`);
    const visit = r.json.data.visit;
    visit2Id = Number(visit.id);
    assertEq(Number(visit.visit_no), 2, 'visit_no（改派是"新的一次上门"，必须递增）');
    assertEq(String(visit.visit_status), 'ASSIGNED', 'visit_status');
    assertEq(Number(visit.reassigned_from_visit_id), visit1Id, '新 Visit 必须指回被取代的那条');

    const rows = visitRows(t4);
    assertEq(rows.length, 2, 'Visit 行数（历史不可覆盖 ⇒ 一定是两行不是一行）');
    assertEq(
      rows[0],
      `1|SUPERSEDED|${PHASE4_TECH_A}|-|原师傅临时请假|reassigned`,
      'Visit #1 —— 师傅快照必须还是原师傅，状态与被取代原因都要落下来',
    );
    assertEq(rows[1], `2|ASSIGNED|${PHASE4_TECH_B}|${visit1Id}|-|-`, 'Visit #2 及其前序指针');
    assertEq(visitIds(t4)[0], visit1Id, 'Visit #1 的 id 必须与派工响应一致');
    return `visit#1 SUPERSEDED → visit#2 (#${visit2Id})`;
  });

  // ---- ⑧ 硬门槛：改派后旧 Token 立即失效 ----
  await check('Phase4: 【硬门槛】改派后旧 Token 立即失效（同一实例上的同一 Token 由 valid 变 invalid）', async () => {
    const r = await phase4Post('tokenCheck', null, phase4Auth, { token: token1 });
    assertEq(r.status, 200, `tokenCheck HTTP（${phase4ErrorMessage(r)}）`);
    assertEq(
      r.json.data.valid,
      false,
      '旧 Token 仍然有效 —— 原师傅能继续提交回执，而系统认为这条派工已经作废了',
    );
    assertEq(phase4ErrorCode(r), undefined, '失败响应不该走 errors 信封（探针回 200 + valid:false）');
    assertEq(r.json.data.code, 'TOKEN_INVALID', '失败码');
    // 失效原因**不外露**：区分"过期/已用/被改派"等于给了一个可枚举的探测接口
    assert(
      !('reason' in r.json.data) && !JSON.stringify(r.json.data).includes('reassigned'),
      `失败原因被回传了：${JSON.stringify(r.json.data)}`,
    );

    // 同时：库里的吊销位必须落下来（排障时客服要能回答"是你被改派了还是链接放太久了"）
    const rev = psqlScalar(
      `SELECT coalesce(token_revoked_reason,'-')||'|'||(token_revoked_at IS NOT NULL) FROM service_visits WHERE id=${visit1Id}`,
    );
    assertEq(rev, 'reassigned|true', 'Visit #1 的 token_revoked_*（PG 把 boolean 转文本时是 true/false，不是 t/f）');

    // 新 Token 有效（否则"失效"可能只是因为整条链路坏了）
    const entries = await phase4OutboxFor('technician_task', PHASE4_TICKET_NO);
    assertEq(entries.length, 2, '改派后师傅短信累计条数');
    token2 = phase4TokenOf(entries[1]);
    assert(token2 && token2 !== token1, '改派必须换发新 Token（沿用旧的等于没改派）');
    const chk = await phase4Post('tokenCheck', null, phase4Auth, { token: token2 });
    assertEq(chk.json.data.valid, true, '新 Token 应当有效');
    assertEq(Number(chk.json.data.visit.id), visit2Id, '新 Token 命中的 visit');
    return `旧 ${token1.slice(0, 6)}… TOKEN_INVALID / 新 ${token2.slice(0, 6)}… valid`;
  });

  // ---- ⑨ 改派三条短信：客户 + 新师傅 + 原师傅（三个不同 scene） ----
  await check('Phase4: 改派发出三条短信，三个 scene 互不相同，且原师傅收到的是「取消通知」', () => {
    const rows = smsRows(t4);
    assertEq(rows.length, 5, '累计短信条数（首次 2 条 + 改派 3 条）');

    const reassignRows = rows.slice(2);
    const scenes = reassignRows.map((r) => r.split('|')[0]).sort();
    assertEq(
      JSON.stringify(scenes),
      JSON.stringify(['dispatch_update', 'technician_assignment_cancelled', 'technician_task']),
      '改派的 scene 集合 —— 少一条就是"系统里已改派、原师傅照常上门"',
    );

    // 客户拿到的不是首次派工那句"已受理"，而是"信息已更新"
    const customerRow = reassignRows.find((r) => r.split('|')[0] === 'dispatch_update');
    assert(customerRow, '缺少发给客户的 dispatch_update');
    const cancelledRow = reassignRows.find((r) => r.split('|')[0] === 'technician_assignment_cancelled');
    assert(cancelledRow, '缺少发给原师傅的 technician_assignment_cancelled');
    // 取消通知必须发给**原**师傅，而不是新师傅 —— 这是最容易写反的一处
    assertEq(
      cancelledRow.split('|')[1],
      `${PHASE4_TECH_A.slice(0, 3)}****${PHASE4_TECH_A.slice(-4)}`,
      '取消通知的收件人（必须是原师傅）',
    );
    // 且必须挂在**旧** Visit 上，否则时间线读起来自相矛盾
    assertEq(cancelledRow.split('|')[4], String(visit1Id), '取消通知关联的 visit_id');
    return scenes.join(' + ');
  });

  // ---- ⑩ 改约：不新建 Visit，只换发 Token ----
  await check('Phase4: 改约不新建 Visit（只改预约时间），并换发 Token 让旧链接失效', async () => {
    const before = visitRows(t4);
    const newExpected = new Date(Date.now() + 3 * 86400000).toISOString();
    const r = await phase4Post('reschedule', t4, phase4Auth, {
      expected_visit_at: newExpected,
      reason: '客户要求推迟',
    });
    assertEq(r.status, 200, `reschedule HTTP（${phase4ErrorMessage(r)}）`);
    assertEq(Number(r.json.data.visit.id), visit2Id, '改约必须落在同一条 Visit 上');
    assertEq(Number(r.json.data.visit.visit_no), 2, 'visit_no（改约不是新的一次上门）');

    const after = visitRows(t4);
    assertEq(after.length, before.length, 'Visit 行数（改约不新建 Visit）');
    assertEq(after[1].split('|')[1], 'ASSIGNED', '改约后 Visit #2 仍应是 ASSIGNED');
    assert(
      psqlScalar(`SELECT expected_visit_at > now() + interval '2 days' FROM service_visits WHERE id=${visit2Id}`) === 't',
      'Visit #2 的 expected_visit_at 未被改约更新',
    );

    // 旧（改派后签发的）Token 必须失效，新 Token 有效
    const stale = await phase4Post('tokenCheck', null, phase4Auth, { token: token2 });
    assertEq(stale.json.data.valid, false, '改约后旧的作业链接仍然有效 —— 师傅会看到过期的预约时间');
    assertEq(stale.json.data.code, 'TOKEN_INVALID', '失败码');

    const entries = await phase4OutboxFor('technician_task', PHASE4_TICKET_NO);
    assertEq(entries.length, 3, '改约后师傅短信累计条数');
    const token3 = phase4TokenOf(entries[2]);
    assert(token3 && token3 !== token2, '改约必须换发新 Token');
    const fresh = await phase4Post('tokenCheck', null, phase4Auth, { token: token3 });
    assertEq(fresh.json.data.valid, true, '改约后的新 Token 应当有效');

    // 客户收到的是"时间已更新"，不是"已受理"
    const customerRows = smsRows(t4).filter((row) => row.split('|')[0] === 'dispatch_update');
    assertEq(customerRows.length, 2, '客户收到的更新通知条数（改派 1 条 + 改约 1 条）');
    return `visit 数不变 / Token 换发（${token2.slice(0, 6)}… → ${token3.slice(0, 6)}…）`;
  });

  // ---- ⑪ 失败一律同一错误码（防枚举） ----
  await check('Phase4: Token 校验的三种失败（伪造 / 格式错 / 已失效）都是同一个 TOKEN_INVALID', async () => {
    const probes = {
      伪造: 'A'.repeat(43),
      格式错: 'short',
      已失效: token1,
      空值: '',
    };
    const codes = [];
    for (const [label, value] of Object.entries(probes)) {
      const r = await phase4Post('tokenCheck', null, phase4Auth, { token: value });
      if (value === '') {
        // 空值走的是参数校验（422），不是"校验失败"——两者必须能被区分
        assertEq(r.status, 422, '空 Token 的 HTTP（应当是参数错误而不是"无效 Token"）');
        codes.push(`${label}=422`);
        continue;
      }
      assertEq(r.status, 200, `${label} 的 HTTP`);
      assertEq(r.json.data.valid, false, `${label}.valid`);
      assertEq(r.json.data.code, 'TOKEN_INVALID', `${label}.code —— 区分原因等于给攻击者一个可枚举的探测接口`);
      codes.push(`${label}=TOKEN_INVALID`);
    }
    return codes.join(' / ');
  });

  // ---- ⑫ 被拒绝的操作不留任何痕迹 ----
  await check('Phase4: 被拒绝的改派（缺原因）不产生 Visit / 事件 / 短信（事务边界）', async () => {
    const beforeVisits = visitRows(t4).length;
    const beforeEvents = Number(psqlScalar(`SELECT count(*) FROM ticket_events WHERE ticket_id=${t4}`));
    const beforeSms = smsRows(t4).length;

    const r = await phase4Post('reassign', t4, phase4Auth, dispatchBody('王师傅', '13900010003'));
    assertEq(r.status, 422, `HTTP（${phase4ErrorMessage(r)}）`);
    assertEq(phase4ErrorCode(r), 'MISSING_REASON', '错误码');

    assertEq(visitRows(t4).length, beforeVisits, 'Visit 行数');
    assertEq(Number(psqlScalar(`SELECT count(*) FROM ticket_events WHERE ticket_id=${t4}`)), beforeEvents, '事件数');
    assertEq(smsRows(t4).length, beforeSms, '短信数');
    return '422 MISSING_REASON / 零副作用';
  });

  // ---- ⑬ 责任主体不变时不许用改派 ----
  await check('Phase4: 责任人未变化时改派返回 422 SAME_RESPONSIBLE_PARTY（防止 visit_no 无意义增长）', async () => {
    const r = await phase4Post('reassign', t4, phase4Auth, {
      ...dispatchBody('李师傅改名', PHASE4_TECH_B),
      reason: '想改个名字',
    });
    assertEq(r.status, 422, `HTTP（${phase4ErrorMessage(r)}）`);
    assertEq(phase4ErrorCode(r), 'SAME_RESPONSIBLE_PARTY', '错误码');
    // 姓名不在责任主体判据里，所以"只改姓名"必须被这条闸拦住（应走 metadata_corrected）
    assertEq(psqlScalar(`SELECT count(*) FROM service_visits WHERE ticket_id=${t4}`), '2', 'Visit 行数');
    return `422 ${phase4ErrorCode(r)}`;
  });

  // ---- ⑭ 门店数据范围由服务端决定 ----
  await check('Phase4: 门店用户派别家门店的工单返回 404（数据范围在服务端，不接受前端传 store_id）', async () => {
    const phase4StoreUser = await phase4MakeUser(
      'smoke.p4.store@svc.local',
      'smoke_p4_store',
      'store_after_sales',
      phase4StoreId,
    );

    // 他店工单：越权与不存在**统一 404**（区分两者等于给了一个"这单存在吗"的探测器）
    const own = await phase4Post('dispatch', t4Other, phase4StoreUser.auth, dispatchBody('跨店', '13900010004'));
    assertEq(own.status, 404, `门店用户派他店工单应得到 404，实际 ${own.status}：${phase4ErrorMessage(own)}`);
    assertEq(
      visitCount(t4Other),
      0,
      '越权请求在别家工单上产生了 Visit —— 对象级校验必须发生在写库之前',
    );

    // 反向对照：同一个人对本店工单是能通过的（否则上一条可能是被别的原因挡下的）
    const r2 = await phase4Post('reschedule', t4Reject, phase4StoreUser.auth, {
      expected_visit_at: futureIso,
      reason: '门店自己改约',
    });
    // 该工单还没派工 → 409（说明确实通过了能力+对象级校验，走到了业务幂等语义）
    assertEq(r2.status, 409, `本店工单应通过权限校验后因"无进行中派工"而 409，实际 ${r2.status}`);
    return `他店 404 / 本店 409（权限已通过）`;
  });

  // ---- ⑮ 派工历史是可串成链的 ----
  await check('Phase4: 派工历史能串成一条链（Visit#1 → 改派 → Visit#2，无断点无环）', () => {
    const rows = visitRows(t4);
    assertEq(rows.length, 2, 'Visit 行数');
    const ids = visitIds(t4);
    const [v1, v2] = rows.map((r, i) => {
      const [visit_no, visit_status, , from, reason, revoked] = r.split('|');
      return { id: String(ids[i]), visit_no, visit_status, from, reason, revoked };
    });
    assertEq(v1.from, '-', 'Visit#1 不应指向前序（首次派工）');
    assertEq(v2.from, v1.id, 'Visit#2 必须指回 Visit#1');
    assertEq(v1.visit_status, 'SUPERSEDED', 'Visit#1 状态');
    assertEq(v2.visit_status, 'ASSIGNED', 'Visit#2 状态');
    assertEq(v1.reason, '原师傅临时请假', 'Visit#1 被取代原因；Visit#2 不得有');
    assertEq(v2.reason, '-', 'Visit#2 不该有被取代原因');
    assert(Number(v2.visit_no) === Number(v1.visit_no) + 1, 'visit_no 必须逐次递增且无跳号');
    // 时间线也要有对应的四类事件（Visit 之外，后台"工单详情"读的是事件流）
    const events = psqlRows(`SELECT event_type FROM ticket_events WHERE ticket_id=${t4} ORDER BY id`);
    for (const expected of ['accepted', 'dispatched', 'reassigned', 'rescheduled']) {
      assert(events.includes(expected), `时间线缺少 ${expected} 事件（实际：${events.join(',')}）`);
    }
    return `#1 SUPERSEDED → #2 ASSIGNED；事件 ${events.length} 条`;
  });
} finally {
  // 无条件恢复：参数与夹具都必须在离开本段前回到原样。
  // 与 4c 的限流阈值同理 —— 一个会污染后续运行的总闸比没有总闸更糟。
  try {
    psql(`UPDATE service_settings SET value='${PHASE4_SMS_RESTORE}' WHERE key='${PHASE4_SMS_KEY}'`);
  } catch (e) {
    warnings.push(
      `Phase4 的 ${PHASE4_SMS_KEY} 未恢复成功，请手工设为 '${PHASE4_SMS_RESTORE}'：${e.message}`,
    );
  }
  try {
    cleanupSmokeFixtures();
  } catch (e) {
    warnings.push(`Phase4 验收夹具清理失败，请手工检查 [SMOKE] 工单与 smoke.%@svc.local：${e.message}`);
  }
}

// ===========================================================================
// 4f. Phase 4-H6 契约收口（2026-09-21 复核方在两个阻塞缺陷上要求的断言）
// ---------------------------------------------------------------------------
//   为什么要单列一节：§4d 验的是"派工这条业务链跑得通"，
//   本节验的是"H6 的**按钮真的调得动服务端**" —— 两件不同的事。
//   复核方原话：「I 很可能只是帮我们发现一个本来静态审查就该发现的 422」。
//
//   因此本节把真人按下按钮时发出的**每一个字段、每一个头**都复刻一遍再打一次：
//     · payload 取自 UI 的构造器（scripts/expected-h6-contract.mjs）；
//     · 请求头与 UI 同名同值（合法的 UUID v4）；
//     · 那份"UI 契约镜像"又由 verify-client-logic.mjs 与真实 TS 实现逐条比对，
//       于是"脚本发的"和"按钮发的"不可能漂移。
//
//   覆盖三件事：① service_mode 对齐 + provider_name 条件必填；
//              ② X-Request-Id 缺失/非法一律 422；
//              ③ 同一 request id 重放不重复副作用（方案 A 的真实幂等）。
// ===========================================================================
section('4f. Phase 4-H6 契约收口（service_mode / X-Request-Id / request-id 幂等）');

/**
 * 可控的 H6 写请求：`sendRequestId: false` 用于复现"没带 X-Request-Id"的历史形态。
 *
 * ⚠️ 不能复用 §4d 的 phase4Post —— 那个函数总是自动带上合法的请求号，
 *    而本节恰恰要验"没有它的时候服务端会不会放过去"。
 */
async function h6Post(action, ticketId, body, opts = {}) {
  const { requestId = crypto.randomUUID(), auth = h6AdminAuth, sendRequestId = true } = opts;
  const url = ticketId
    ? `${BASE_URL}/api/svc:${action}?filterByTk=${ticketId}`
    : `${BASE_URL}/api/svc:${action}`;
  const r = await http(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...auth,
      ...(sendRequestId ? uiWriteHeaders(requestId) : {}),
    },
    body: JSON.stringify(body ?? {}),
    timeout: 15000,
  });
  let json = null;
  try {
    json = JSON.parse(r.body);
  } catch {
    /* 非 JSON 交给调用方断言 */
  }
  return { status: r.status, json, headers: r.headers ?? {} };
}

/** 取**服务端实际部署**的那份客户端 JS（浏览器加载的就是它） */
async function h6ClientBundle() {
  const r = await http(`${BASE_URL}${PLUGIN_CLIENT_PATH}`, { timeout: 15000 });
  assertEq(r.status, 200, `客户端产物 HTTP：${r.body.slice(0, 120)}`);
  return r.body;
}

/**
 * 读响应头。
 *
 * ⚠️ `http()` 返回的是 fetch 的 **Headers 实例**（不是普通对象），
 *    直接 `res.headers['x-idempotent-replay']` 恒为 undefined ——
 *    而"恒为 undefined"的断言是**假绿**：真没带回放头时它也不红。
 *    所以这里必须走 `.get()`，并兼容普通对象两种形态。
 */
const headerOf = (res, name) => {
  const h = res?.headers;
  if (!h) return undefined;
  const key = String(name).toLowerCase();
  if (typeof h.get === 'function') return h.get(key) ?? undefined;
  return h[key];
};

// ⚠️ 必须声明在 h6Post 之外：h6Post 的默认参数要读它，
//    放在 try 块里就只有块作用域 —— 函数声明在外面 ⇒ 取不到（TDZ/ReferenceError）。
let h6AdminAuth = {};

try {
  h6AdminAuth = {
    Authorization: `Bearer ${await smokeSignIn(SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD)}`,
  };
  const h6StoreId = Number(psqlScalar(`SELECT id FROM stores WHERE code='${PHASE4_STORE}'`));
  const h6Stamp = String(Date.now());
  let h6Seq = 0;

  /** 造一张 NEW 工单（ticket_no 每张不同，故先把计数器自增） */
  const h6Ticket = () => {
    h6Seq += 1;
    return Number(
      psqlScalar(
        'INSERT INTO service_tickets ' +
          '(created_at, updated_at, ticket_no, store_id, source_store_code, source, ticket_type, ' +
          ' content, customer_mobile, status, escalated, reopen_count, review_status, feedback_token_hash) ' +
          `VALUES (now(), now(), 'FWH6${h6Stamp}${h6Seq}', ${h6StoreId}, '${PHASE4_STORE}', 'qr', 'repair', ` +
          ` '[SMOKE] Phase4-H6 ${h6Seq}', '${PHASE4_CUSTOMER_MOBILE}', 'NEW', false, 0, 'pending', ` +
          ` 'h6hash${h6Stamp}${h6Seq}') RETURNING id`,
      ),
    );
  };

  /** 一次幂等验收要盯的四样东西：Visit 数 / 事件数 / 短信数 / Token 哈希 */
  const h6Counts = (ticketId) => ({
    visits: Number(psqlScalar(`SELECT count(*) FROM service_visits WHERE ticket_id=${ticketId}`)),
    events: Number(psqlScalar(`SELECT count(*) FROM ticket_events WHERE ticket_id=${ticketId}`)),
    sms: Number(psqlScalar(`SELECT count(*) FROM sms_logs WHERE ticket_id=${ticketId}`)),
    token: String(
      psqlScalar(
        `SELECT coalesce(max(access_token_hash), '-') FROM service_visits WHERE ticket_id=${ticketId}`,
      ),
    ),
  });

  const h6Future = new Date(Date.now() + 2 * 86400000).toISOString();
  const h6ErrorCode = (r) => r.json?.errors?.[0]?.code;
  const h6ErrorMessage = (r) => r.json?.errors?.[0]?.message ?? '';

  /** 造一个非 root 的业务账号并用它登录（验证幂等键里的"操作者"维度） */
  async function h6MakeHqUser(email, username) {
    const created = await http(`${BASE_URL}/api/users:create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...h6AdminAuth },
      body: JSON.stringify({
        email,
        username,
        nickname: username,
        password: SMOKE_USER_PASSWORD,
        roles: [{ name: 'hq_after_sales' }],
      }),
    });
    assertEq(created.status, 200, `建用户 ${email} HTTP：${created.body.slice(0, 160)}`);
    return { Authorization: `Bearer ${await smokeSignIn(email, SMOKE_USER_PASSWORD)}` };
  }

  // ---- ⓿ 已部署的客户端产物必须与 UI 契约一致（防"源码改了、产物没重编"） ----
  await check('H6: 已部署客户端产物的 service_mode 恰为 inhouse/厂家/第三方（remote 不在派工选项里）', async () => {
    const js = await h6ClientBundle();

    // 直接读浏览器拿到的那份 JS 里的"可派工集合"
    const block = /var DISPATCHABLE_SERVICE_MODES = \[([\s\S]*?)\];/.exec(js);
    assert(block, '产物里找不到 DISPATCHABLE_SERVICE_MODES —— 本节断言失去意义，必须查证');
    const offered = [...block[1].matchAll(/SERVICE_MODE\.(\w+)/g)].map((m) => m[1]);
    assertEq(
      JSON.stringify(offered),
      JSON.stringify(['INHOUSE', 'MANUFACTURER', 'THIRD_PARTY']),
      '已部署产物的派工选项（少一个 = 某种服务方式点不出来；多一个 = remote 进了 UI）',
    );
    assert(!/SERVICE_MODE\.REMOTE/.test(block[1]), 'remote 混进了派工选项（Phase 6 之前不允许）');

    // 每个选项必须有中文文案：下拉里出现裸枚举值是 UI 缺陷
    // esbuild 把非 ASCII 转成 \uXXXX，用 JSON.parse 还原成可读文本
    const labels = Object.fromEntries(
      [...js.matchAll(/\[SERVICE_MODE\.(\w+)\]: "((?:[^"\\]|\\.)*)"/g)].map((m) => [
        m[1],
        JSON.parse(`"${m[2]}"`),
      ]),
    );
    assertEq(labels.INHOUSE, DISPATCH_SERVICE_MODE_LABELS.inhouse, 'inhouse 文案');
    assertEq(labels.MANUFACTURER, DISPATCH_SERVICE_MODE_LABELS.manufacturer, 'manufacturer 文案');
    assertEq(labels.THIRD_PARTY, DISPATCH_SERVICE_MODE_LABELS.third_party, 'third_party 文案');
    assert(/远程指导/.test(labels.REMOTE ?? ''), 'remote 缺"不派工"提示文案');
    return `选项 ${offered.join('/')} · 文案 ${labels.INHOUSE}/${labels.MANUFACTURER}/${labels.THIRD_PARTY}`;
  });

  await check('H6: 已部署客户端产物显式发送 X-Request-Id（不依赖框架隐式注入）', async () => {
    const js = await h6ClientBundle();
    assert(
      js.includes(`var REQUEST_ID_HEADER = "${REQUEST_ID_HEADER}"`),
      `产物里找不到 ${REQUEST_ID_HEADER} 常量 —— 客户端可能压根没发这个头`,
    );
    // 常量存在还不够：必须在真正发请求的地方把它装进 headers
    assert(
      /headers:\s*\{\s*\[REQUEST_ID_HEADER\]:\s*requestId\s*\}/.test(js),
      '产物里看不到"把 request id 写进 headers"的装配过程',
    );
    return `${REQUEST_ID_HEADER}：常量 + 装配两处均在产物里`;
  });

  // ---- ① 用"与 UI 完全相同的 payload + header"真打一次 dispatch ----
  //
  // 这是整个收口里最关键的一条：它证明 **UI 能选到的每一项**都真的能落到库里。
  // 复核方发现的原缺陷正是"厂家被 UI 合并进了第三方" —— 于是 manufacturer
  // 这种数据**永远产生不出来**，按 service_mode 做的统计从第一天起就是错的。
  await check('H6: 【UI payload】厂家派工真实可用：service_mode=manufacturer + provider_name 落库', async () => {
    const id = h6Ticket();
    await h6Post('accept', id, {});
    const payload = uiDispatchPayload({
      technician_name: '厂家李工',
      technician_mobile: PHASE4_TECH_A,
      expected_visit_at: h6Future,
      service_mode: 'manufacturer',
      provider_name: '海尔售后',
    });
    assertEq(Object.keys(payload).length, 5, 'payload 字段数（应与 UI 表单一致）');

    const r = await h6Post('dispatch', id, payload);
    assertEq(r.status, 200, `HTTP（${h6ErrorMessage(r)}）`);
    assertEq(String(r.json.data.visit.service_mode), 'manufacturer', 'Visit 的 service_mode');
    assertEq(String(r.json.data.visit.provider_name), '海尔售后', 'Visit 的 provider_name');
    assertEq(
      psqlScalar(`SELECT service_mode FROM service_visits WHERE ticket_id=${id}`),
      'manufacturer',
      '库里的 service_mode（**统计口径的源头**）',
    );
    assertEq(
      psqlScalar(`SELECT provider_name FROM service_visits WHERE ticket_id=${id}`),
      '海尔售后',
      '库里的 provider_name',
    );
    return `manufacturer / 海尔售后 已落库（visit=${r.json.data.visit.id}）`;
  });

  await check('H6: 【UI payload】第三方与门店自修同样成立（自修时不下发空 provider_name）', async () => {
    const thirdId = h6Ticket();
    await h6Post('accept', thirdId, {});
    const third = await h6Post(
      'dispatch',
      thirdId,
      uiDispatchPayload({
        technician_name: '三方王工',
        technician_mobile: PHASE4_TECH_B,
        expected_visit_at: h6Future,
        service_mode: 'third_party',
        provider_name: '快益修',
      }),
    );
    assertEq(third.status, 200, `第三方派工 HTTP（${h6ErrorMessage(third)}）`);
    assertEq(String(third.json.data.visit.service_mode), 'third_party', '第三方 service_mode');

    const selfId = h6Ticket();
    await h6Post('accept', selfId, {});
    const selfPayload = uiDispatchPayload({
      technician_name: '本店张师傅',
      technician_mobile: PHASE4_TECH_A,
      expected_visit_at: h6Future,
      service_mode: 'inhouse',
      // UI 允许留空 ⇒ 构造器必须把它剔掉，而不是发一个空串
      provider_name: '   ',
    });
    assert(
      !('provider_name' in selfPayload),
      `UI payload 里不该出现空 provider_name：${JSON.stringify(selfPayload)}`,
    );
    const self = await h6Post('dispatch', selfId, selfPayload);
    assertEq(self.status, 200, `门店自修派工 HTTP（${h6ErrorMessage(self)}）`);
    assertEq(String(self.json.data.visit.service_mode), 'inhouse', '门店自修 service_mode');
    assertEq(
      psqlScalar(`SELECT provider_name IS NULL FROM service_visits WHERE ticket_id=${selfId}`),
      't',
      '门店自修不该留下 provider_name（空串会让"谁修的"变得无法解释）',
    );
    return 'third_party / inhouse 均通过；空 provider_name 已在出口剔除';
  });

  // ---- ② 服务端兜底：绕过 UI 仍然拦得住（UI 校验不是安全边界） ----
  await check('H6: 绕过 UI 缺 provider_name 时服务端兜底 422 MISSING_PROVIDER', async () => {
    const id = h6Ticket();
    await h6Post('accept', id, {});
    const r = await h6Post('dispatch', id, {
      technician_name: '厂家李工',
      technician_mobile: PHASE4_TECH_A,
      expected_visit_at: h6Future,
      service_mode: 'manufacturer',
      // 刻意不传 provider_name：模拟 curl / 老版本前端产物
    });
    assertEq(r.status, 422, 'HTTP');
    assertEq(h6ErrorCode(r), 'MISSING_PROVIDER', '错误码');
    assertEq(
      Number(psqlScalar(`SELECT count(*) FROM service_visits WHERE ticket_id=${id}`)),
      0,
      'Visit 行数（被拒绝的请求不该留下任何东西）',
    );
    return '422 MISSING_PROVIDER（前端拦了，服务端也没松）';
  });

  await check('H6: 历史取值 self 与 remote 仍被服务端拒绝（UI 不显示 ≠ 接口开放）', async () => {
    const seen = [];
    for (const [mode, expectedCode] of [
      ['self', 'INVALID_ENUM'],
      ['remote', 'REMOTE_MODE_DEFERRED'],
    ]) {
      const id = h6Ticket();
      await h6Post('accept', id, {});
      const r = await h6Post('dispatch', id, {
        technician_name: '李师傅',
        technician_mobile: PHASE4_TECH_A,
        expected_visit_at: h6Future,
        service_mode: mode,
      });
      assertEq(r.status, 422, `${mode} 的 HTTP`);
      assertEq(h6ErrorCode(r), expectedCode, `${mode} 的错误码`);
      seen.push(`${mode}=${expectedCode}`);
    }
    return seen.join(' / ');
  });

  // ---- ③ 写动作缺/非法的 X-Request-Id 一律 422 ----
  await check('H6: 四个写动作缺少或非法的 X-Request-Id 一律 422（幂等键不可跳过）', async () => {
    const id = h6Ticket();
    await h6Post('accept', id, {});
    const cases = [
      { label: '缺头', options: { sendRequestId: false } },
      { label: '非法 UUID', options: { requestId: 'not-a-uuid' } },
      { label: '空值', options: { requestId: '' } },
    ];
    const actions = ['accept', 'dispatch', 'reassign', 'reschedule'];
    for (const action of actions) {
      for (const c of cases) {
        const r = await h6Post(action, id, {}, c.options);
        assertEq(r.status, 422, `${action} / ${c.label} 的 HTTP`);
        assertEq(h6ErrorCode(r), 'VALIDATION_FAILED', `${action} / ${c.label} 的错误码`);
      }
    }
    return `${actions.length} 个动作 × ${cases.length} 种坏头部 = 全部 422`;
  });

  // ---- ④【硬门槛】同一 request id 重放改约：零副作用 + 首次响应原样返回 ----
  //
  // 复核方点名的危险点：改约不新建 Visit、状态仍是 PROCESSING，
  // 状态机**没有任何东西拦第二次**，于是弱网重试 = 再换 Token + 再写一封短信。
  // 这正是"真人走查几乎不会遇到"（谁会故意模拟点了没反应？）而必须靠自动化的场景。
  await check('H6: 【硬门槛】同一 request id 重放改约：Visit / 事件 / 短信 / Token 均不再变化', async () => {
    const id = h6Ticket();
    await h6Post('accept', id, {});
    const dispatched = await h6Post(
      'dispatch',
      id,
      uiDispatchPayload({
        technician_name: '重放张师傅',
        technician_mobile: PHASE4_TECH_A,
        expected_visit_at: h6Future,
        service_mode: 'inhouse',
      }),
    );
    assertEq(dispatched.status, 200, `前置派工 HTTP（${h6ErrorMessage(dispatched)}）`);

    const before = h6Counts(id);
    const requestId = crypto.randomUUID();
    const body = uiReschedulePayload({
      expected_visit_at: new Date(Date.now() + 4 * 86400000).toISOString(),
      reason: '客户要求推迟（幂等验收）',
    });

    const first = await h6Post('reschedule', id, body, { requestId });
    assertEq(first.status, 200, `首次改约 HTTP（${h6ErrorMessage(first)}）`);
    const afterFirst = h6Counts(id);
    assert(afterFirst.events > before.events, '首次改约必须写事件（否则本节断言会变成空转）');
    assert(afterFirst.token !== before.token, '首次改约必须换发 Token');
    assert(afterFirst.sms > before.sms, '首次改约必须发出通知短信');

    // 重放：**完全相同的 body + 完全相同的 request id**
    const replayed = await h6Post('reschedule', id, body, { requestId });
    assertEq(replayed.status, 200, `重放 HTTP（${h6ErrorMessage(replayed)}）`);
    const afterReplay = h6Counts(id);

    assertEq(afterReplay.visits, afterFirst.visits, 'Visit 行数');
    assertEq(afterReplay.events, afterFirst.events, '事件数（重复事件会让时间线说谎）');
    assertEq(afterReplay.sms, afterFirst.sms, '短信数（多发一封"时间已改"＝客户以为又改了一次）');
    assertEq(afterReplay.token, afterFirst.token, 'Token 哈希（再签发一次 = 旧链接当场作废）');
    assertEq(
      JSON.stringify(replayed.json),
      JSON.stringify(first.json),
      '响应体必须与首次逐字一致（幂等的定义）',
    );
    return `事件 ${afterFirst.events} / 短信 ${afterFirst.sms} / Token ${afterFirst.token.slice(0, 8)}… 全部保持不变`;
  });

  await check('H6: 幂等命中只在响应头标注 X-Idempotent-Replay，正文仍与首次一致', async () => {
    const id = h6Ticket();
    const requestId = crypto.randomUUID();

    const once = await h6Post('accept', id, {}, { requestId });
    assertEq(once.status, 200, `首次受理 HTTP（${h6ErrorMessage(once)}）`);
    assertEq(headerOf(once, IDEMPOTENCY_REPLAY_HEADER) ?? null, null, '首次响应不该带回放头');

    const twice = await h6Post('accept', id, {}, { requestId });
    assertEq(twice.status, 200, `重放受理 HTTP（${h6ErrorMessage(twice)}）`);
    assertEq(
      String(headerOf(twice, IDEMPOTENCY_REPLAY_HEADER) ?? ''),
      '1',
      `${IDEMPOTENCY_REPLAY_HEADER} 响应头`,
    );
    assertEq(JSON.stringify(twice.json), JSON.stringify(once.json), '响应体必须与首次逐字一致');

    // 反向对照：换个 request id 就是"又一次操作"，此时状态机应当拒绝（已不是 NEW）
    const another = await h6Post('accept', id, {});
    assertEq(another.status, 409, '换号后重复受理应被状态机拒绝（不是幂等重放）');
    return `重放命中：${IDEMPOTENCY_REPLAY_HEADER}: 1（换号则 409）`;
  });

  await check('H6: 换一个操作者用同一个 request id 不算重放（幂等键含操作者维度）', async () => {
    const id = h6Ticket();
    const requestId = crypto.randomUUID();
    const hqAuth = await h6MakeHqUser('smoke.p4f.hq@svc.local', 'smoke_p4f_hq');

    const mine = await h6Post('accept', id, {}, { requestId });
    assertEq(mine.status, 200, `甲受理 HTTP（${h6ErrorMessage(mine)}）`);

    const others = await h6Post('accept', id, {}, { requestId, auth: hqAuth });
    // 乙的幂等键不同 ⇒ 不该命中甲的缓存（缓存的响应体是按甲的视角脱敏的）
    assertEq(
      String(headerOf(others, IDEMPOTENCY_REPLAY_HEADER) ?? ''),
      '',
      '乙拿到了甲的幂等回放（等于把甲的响应体给了另一个人）',
    );
    assertEq(others.status, 409, '乙的动作应走到状态机并被拒绝（工单已是 PROCESSING）');
    return '甲 200 / 乙 409，且乙没有拿到甲的回放';
  });
} finally {
  try {
    cleanupSmokeFixtures();
  } catch (e) {
    warnings.push(`Phase 4-H6 验收夹具清理失败：${e.message}`);
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

/**
 * 由**本脚本自己**故意触发、因此不算缺陷的 error 日志。
 *
 * ⚠️ 为什么必须有这个豁免（2026-09-21 真机踩到，与工程铁律 5 同型）：
 *   §4e 第 4 组有一条**反向对照**断言：用 `Origin: https://evil.example.com` 登录，
 *   期望 403 —— 用来证明"来源校验确实生效，而不是被整体关掉"。
 *   而 403 在服务端是 `ForbiddenError`，会被 NocoBase 全局错误处理器按 **error 级**记一条。
 *   `docker logs` 不会随断言结束而清空：**下一轮**跑冒烟时这条 error 仍在窗口里，
 *   于是"app 日志中无 error 级别输出"必然红 —— 而红的原因是**上一轮脚本自己的探针**，
 *   与被测系统无关（测试工具污染环境，又一次）。
 *
 * 豁免口径**必须窄**：只认 `Invalid sign-in origin` 这一条消息（正是那条断言制造的），
 * 不能写成"排除所有 4xx" —— 那会把真正的故障一起豁免掉。
 * 副作用：若 nginx 来源校验真的坏了，这里不再变红；
 * 但 §4e 的"携带正确 Origin 的登录成功"会红，所以不会漏。
 */
function isExpectedError(entry) {
  return /Invalid sign-in origin/.test(String(entry?.message ?? ''));
}

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
  const allowed = [];
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
    if (level !== 'error') continue;
    if (isExpectedError(entry)) {
      allowed.push(String(entry?.message ?? '').slice(0, 60));
      continue;
    }
    errLines.push(text);
  }

  const total = errLines.length + fallback.length;
  if (total) {
    throw new Error(
      `发现 ${total} 条 error 日志，首条：${(errLines[0] || fallback[0]).trim().slice(0, 160)}`,
    );
  }
  const base = sinceFlag
    ? `无 error 级日志（自 unix:${sinceFlag} 起，按 level 字段判定）`
    : '无 error 级日志（全量，按 level 字段判定）';
  return allowed.length ? `${base}；豁免 ${allowed.length} 条脚本自造（Invalid sign-in origin）` : base;
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

// ---------------------------------------------------------------------------
// 4e. 后台可用性（Phase 4-H）
// ---------------------------------------------------------------------------
section('4e. 后台可用性（管理界面能否真正打开与登录）');

/**
 * 这一段的由来（2026-09-21 真机，两条**生产级**故障，且此前**一条断言都覆盖不到**）：
 *
 *   ① 插件从未产出客户端 bundle
 *      → 后台 SPA 加载 /static/plugins/@local/service-ticket/dist/client/index.js 得到 404
 *      → requirejs 抛 `Script error for "@local/service-ticket"`
 *      → 整个后台渲染成 "App error"，**连登录页都出不来**。
 *
 *   ② nginx 用 `proxy_set_header Host $host` 转发（$host **不含端口**）
 *      → NocoBase 的 isTrustedOrigin() 算出对外来源 http://localhost，
 *        而浏览器 Origin 是 http://localhost:8080 → 判定非同源
 *      → 后台登录 **403 {"message":"Invalid sign-in origin"}**。
 *
 *   为什么此前的近百项断言全绿却什么都没发现：
 *     · 断言只打了 /api/* 这一侧，没有请求过任何**前端静态资源**；
 *     · 登录用 `fetch()` 且**不带 Origin 头** → NocoBase 走 referer 分支、
 *       referer 也为空 → 直接放行。而浏览器发 POST 时**必定**带 Origin，
 *       这一点在"用 curl 打接口"的验收范式里被彻底漏掉了。
 *
 *   所以第 1~3 组断言盯静态资源与后台元数据，第 4 组**显式带上 Origin 头**再登录
 *   —— 让"接口全绿、后台全瞎"这类缺口以后能被自动发现。
 */


await check('插件客户端产物可访问（否则后台整页 App error）', async () => {
  const r = await http(`${BASE_URL}${PLUGIN_CLIENT_PATH}`);
  assert(r.status === 200, `HTTP ${r.status}（期望 200；404 即后台打不开）`);
  assert(r.body.length > 200, `响应体只有 ${r.body.length} 字节，不像真正的 bundle`);
  for (const [name, needle] of [
    ['define.amd 分支', 'define.amd'],
    ['外部依赖白名单报错', '未在 AMD 依赖里声明的外部模块'],
    ['__esModule 标记', '__esModule'],
  ]) {
    assert(r.body.includes(needle), `产物缺少${name}`);
  }
  return `HTTP 200 · ${r.body.length} 字节`;
});

await check('客户端产物的 AMD 依赖**全部运行时可解析**（否则 requirejs 报 Script error → 整页 App error）', async () => {
  // 这条盯的是一类极其昂贵的事故：产物本身 HTTP 200、字节数正常、语法也没问题，
  // 但只要 import 了一个 requirejs **不认得**的模块名，浏览器就抛
  // `Script error for "@local/service-ticket"`，整个后台渲染成 "App error"。
  // 而 /api/* 侧的所有断言**照样全绿** —— 与 §4e 开头那两条同型。
  //
  // 判据：产物的 define([...]) 依赖数组，逐个对照"内置插件实际用过"的模块名。
  // 白名单不是凭空写的，是 2026-09-21 逐个取证的结果（见 DEVIATIONS DEV-56）。
  const r = await http(`${BASE_URL}${PLUGIN_CLIENT_PATH}`);
  assert(r.status === 200, `HTTP ${r.status}`);
  const m = /define\(\[([^\]]*)\]/.exec(r.body);
  assert(m, '产物里找不到 define([...]) 依赖数组 —— 构建形态变了，本断言失效');
  const deps = m[1]
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  assert(deps.length > 0, '依赖数组是空的 —— 断言会假绿，必须修');

  // 运行时可解析的模块名（取证来源：内置插件 dist/client/index.js 的 UMD 依赖数组）
  const RESOLVABLE = new Set([    '@nocobase/client',
    '@nocobase/client-v2',
    '@nocobase/flow-engine',
    '@nocobase/sdk',
    '@nocobase/utils',
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react-i18next',
    'i18next',
    'antd',
    '@ant-design/icons',
    '@emotion/css',
    'dayjs',
    'lodash',
    'ahooks',
    '@formily/core',
    '@formily/react',
    '@formily/reactive',
    '@formily/reactive-react',
    '@formily/shared',
    '@formily/antd-v5',
    '@formily/json-schema',
    '@formily/path',
    'react-router',
    'react-router-dom',
    'axios',
  ]);
  const unknown = deps.filter((d) => !RESOLVABLE.has(d));
  assert(
    unknown.length === 0,
    `以下依赖 requirejs 大概率解析不了：${unknown.join(', ')}（新增依赖前先确认它在内置插件里被用过）`,
  );

  // ⚠️ 上面只查了「**声明了的**依赖是否可解析」这一个方向。
  //    反向同样致命：bundle 正文 `require(id)` 了某个模块，但 define([...]) 里**没声明**它
  //    → 白名单 __require 抛 "未在 AMD 依赖里声明的外部模块: xxx" → **整页 App error**。
  //    2026-09-22 实测踩过：probe 构建漏了 jsx:'automatic'，于是 metafile 里没有
  //    react/jsx-runtime，而真正发布的产物 require 了它。声明方向全绿、调用方向炸了。
  //    两个方向都要断言，缺一个就是"半个检查"（项目铁律 8：断言不会变红 = 没有断言）。
  const declared = new Set(deps);
  // 只认会被 UMD 包装器拦下的调用形态：`require("x")`，且 x 是裸模块名（非相对路径、非绝对路径）
  const required = new Set(
    [...r.body.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)]
      .map((mm) => mm[1])
      .filter((id) => !id.startsWith('.') && !id.startsWith('/')),
  );
  assert(
    required.size > 0,
    '产物里扫不到任何 require("...") 裸模块调用 —— 产物形态变了，本断言会假绿，必须修',
  );
  const undeclared = [...required].filter((id) => !declared.has(id));
  assert(
    undeclared.length === 0,
    `产物 require 了但 define([...]) 未声明的模块：${undeclared.join(', ')} —— ` +
      `运行时会抛 "未在 AMD 依赖里声明的外部模块" 并导致整页 App error`,
  );

  // ⚠️ 第三个方向：上面两张表都可能是**手抄的**，手抄的清单迟早与运行时漂移。
  //    这里直接问运行时：「本插件产物用到的每个外部模块，NocoBase 的加载器到底注册了没有？」
  //    取证方式：admin 主 bundle 里逐个 `iR(e,"<模块名>",<变量>)` 就是加载器的注册调用；
  //    凡是注册过的模块名都会以 `,"<名字>",` 的形态出现。取不到就变红（铁律 3：不拿"取不到"放宽）。
  //
  //    ⚠️ 主 bundle 的文件名带内容哈希（`/assets/index-<hash>.js`），**不能硬编码**。
  //       每次发布哈希都会变，硬编码的表现是"断言永远取 404 → 假红"，人就会把它注释掉。
  //       所以从首页 HTML 里现取 `<script type="module" src="/assets/index-*.js">`。
  const home = await http(`${BASE_URL}/`);
  assert(home.status === 200, `取不到首页（HTTP ${home.status}）—— 无法定位后台主 bundle`);
  const indexM = /<script[^>]+src="(\/assets\/index-[^"]+\.js)"/.exec(home.body);
  assert(indexM, '首页 HTML 里找不到 /assets/index-*.js —— 后台打包形态变了，本断言失效，必须修');
  const adminIndex = await http(`${BASE_URL}${indexM[1]}`);
  assert(
    adminIndex.status === 200,
    `取不到后台主 bundle ${indexM[1]}（HTTP ${adminIndex.status}）—— 不能静默跳过`,
  );
  assert(
    adminIndex.body.length > 100_000,
    `后台主 bundle 只有 ${adminIndex.body.length} 字节，不像真产物 —— 本断言会假绿，必须修`,
  );
  const notRegistered = deps.filter((d) => !adminIndex.body.includes(`,${JSON.stringify(d)},`));
  assert(
    notRegistered.length === 0,
    `以下模块在产物里声明了，但 NocoBase 加载器**没有注册**：${notRegistered.join(', ')} —— ` +
      `requirejs 会报 Script error，后台整页 App error`,
  );

  return (
    `${deps.length} 个外部依赖均在可解析白名单内：${deps.join(', ')}` +
    ` · 正文 require 的 ${required.size} 个裸模块全部已声明` +
    ` · 且全部已被加载器注册`
  );
});

await check('svc:visits 按 ticket_id 服务端查询，且不返回任何凭据列', async () => {
  // H3 详情抽屉的数据源。复核方要求：事件与 Visit 必须**按 ticket_id 在服务端查**，
  // 不许前端下载全量再过滤 —— 这里证明服务端真的提供了这条路，且没漏凭据。
  const token = await smokeSignIn(SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD);
  const headers = { Authorization: `Bearer ${token}` };

  // 先找一张确实有 Visit 的工单（用派工记录列表取，避免依赖固定 id）
  const list = await http(
    `${BASE_URL}/api/serviceVisits:list?pageSize=5&sort=-id&fields[0]=ticket_id`,
    { headers },
  );
  assert(list.status === 200, `serviceVisits:list HTTP ${list.status}`);
  const rows = parseJson(list.body, 'serviceVisits:list').data ?? [];

  /**
   * 前置条件闸（**不是豁免**）：本断言需要**至少一条 Visit** 才成立。
   *
   * 为什么带闸而不是无条件失败：Phase 4-I 走查前把库清成了"每店一张 NEW 工单、
   * 0 条 Visit"的洁净基线，好让走查人一眼看到目标单 —— 此时"没有 Visit"
   * 是**预期状态**，不是缺陷。
   *
   * ⚠️ 但它绝不能变成"悄悄跳过"：
   *   · 默认**仍然报失败并打印下一步**，提醒跑一次 `--bootstrap-uat-ticket`
   *     并完成一次派工，把环境恢复成可验状态；
   *   · 只有显式设 `SMOKE_ALLOW_NO_VISITS=1`（例如走查当天做前置自检）才允许 SKIP，
   *     且必须走 `SkipCheck` —— 汇总里**单独列出**，绝不并入"通过"。
   * 这样"环境未就绪"与"接口坏了"始终可以区分（工程铁律 4），
   * 也不会出现"断言永远不会变红"（铁律 8）。
   *
   * ⚠️ 2026-09-23 补充（覆盖搬家）：标准入口 `uat-reset-baseline.mjs` 会带
   *   `SMOKE_ALLOW_NO_VISITS=1`，于是**这一条在标准入口里永远是跳过**。
   *   因此同主题的断言已搬到 `scripts/verify-reassign-contract.mjs` 的 **A7**
   *   —— 那个脚本**自带 Visit 夹具**，判据不再依赖"库里碰巧有数据"。
   *   不要因为这里被跳过就以为没人管 `svc:visits`。
   */
  if (rows.length === 0) {
    if (process.env.SMOKE_ALLOW_NO_VISITS === '1') {
      throw new SkipCheck(
        '库中 Visit=0（走查洁净基线，SMOKE_ALLOW_NO_VISITS=1）—— 未验证 svc:visits；' +
          '同主题断言见 verify-reassign-contract A7（自带 Visit 夹具）',
      );
    }
    assert(
      false,
      '库里没有 Visit，无法验证。这不是接口缺陷，是**环境未就绪**：' +
        '先跑 `node scripts/uat-accounts.mjs --create --bootstrap-uat-ticket` 并完成一次派工；' +
        '若走查期间确需跳过，设 SMOKE_ALLOW_NO_VISITS=1（会在汇总里单独标记为跳过）',
    );
  }
  const ticketId = rows[0].ticket_id;
  assert(ticketId != null, '取不到 ticket_id');

  const r = await http(`${BASE_URL}/api/svc:visits?filterByTk=${ticketId}`, { headers });
  assert(r.status === 200, `svc:visits HTTP ${r.status} ${r.body.slice(0, 200)}`);
  const data = parseJson(r.body, 'svc:visits').data ?? {};
  const visits = data.visits ?? [];
  assert(
    visits.length > 0,
    `工单 ${ticketId} 明明有 Visit，svc:visits 却返回 0 条 —— 接口没按 ticket_id 查`,
  );
  for (const v of visits) {
    assert(
      v.ticket_id === ticketId,
      `返回的 Visit 属于别的工单（${v.ticket_id} ≠ ${ticketId}）—— 过滤失效`,
    );
  }
  const forbidden = ['access_token_hash', 'token_expires_at', 'token_used_at', 'token_revoked_at'];
  const leaked = new Set();
  for (const v of visits) {
    for (const col of forbidden) if (col in v) leaked.add(col);
  }
  assert(leaked.size === 0, `svc:visits 泄露了凭据列：${[...leaked].join(', ')}`);
  // 失效原因是**业务必须可见**的（派工记录页与抽屉都要显示），不能被一起删掉
  assert(
    visits.some((v) => 'token_revoked_reason' in v),
    'visits 里没有 token_revoked_reason —— 抽屉无法显示"链接为什么失效"',
  );
  return `工单 ${ticketId}：${visits.length} 条 Visit，0 个凭据列，保留失效原因`;
});

await check('pm:listEnabled 给出的客户端入口与实际可访问文件一致', async () => {
  const token = await smokeSignIn(SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD);
  const r = await http(`${BASE_URL}/api/pm:listEnabled`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(r.status === 200, `HTTP ${r.status}`);
  const list = parseJson(r.body, 'pm:listEnabled').data || [];
  const entry = list.find((p) => p.packageName === '@local/service-ticket');
  assert(entry, '已启用插件清单里没有 @local/service-ticket');
  assert(
    entry.url && entry.url.startsWith(PLUGIN_CLIENT_PATH),
    `前端入口 URL 不是预期路径：${entry.url}`,
  );
  // URL 里必须带 ?hash=：服务端 `PackageUrls.fetch()` 只在文件**确实存在**时才追加它。
  // 这条是"文件真的在磁盘上"的远端佐证，比只看 HTTP 200 更早暴露问题。
  assert(/\?hash=/.test(entry.url), `URL 缺少 ?hash=，说明服务端认为文件不存在：${entry.url}`);
  return entry.url.replace(BASE_URL, '');
});

await check('业务数据表已进入后台元数据仓库（否则后台选不到表）', async () => {
  const token = await smokeSignIn(SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD);
  // ⚠️ 必须用客户端**真正**调用的那个接口（见 plugin-data-source-manager 的 client-v2：
  //    url: "dataSources/main/collections:list"）。换成 /api/collections:list
  //    虽然数据相同，但那不是界面实际依赖的路径 —— 换了接口照样全绿，等于没测。
  const r = await http(`${BASE_URL}/api/dataSources/main/collections:list?paginate=false`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(r.status === 200, `HTTP ${r.status}`);
  const names = (parseJson(r.body, 'collections:list').data || []).map((c) => c.name);
  const missing = BUSINESS_COLLECTION_NAMES.filter((n) => !names.includes(n));
  assert(missing.length === 0, `后台看不到这些表：${missing.join(', ')}`);
  return `${names.length} 张可见 · 本插件 ${BUSINESS_COLLECTION_NAMES.length} 张全在`;
});

await check('健康检查暴露后台元数据齐备度且无缺表', async () => {
  const r = await http(`${BASE_URL}/api/svc:health`);
  const h = unwrapHealth(parseJson(r.body, 'svc:health'));
  assert(
    typeof h.uiCollectionsExpected === 'number' && typeof h.uiCollectionsRegistered === 'number',
    '健康检查未暴露 uiCollectionsExpected / uiCollectionsRegistered',
  );
  assert(
    h.uiCollectionsRegistered === h.uiCollectionsExpected,
    `期望 ${h.uiCollectionsExpected} 张，实际注册 ${h.uiCollectionsRegistered} 张`,
  );
  assert(
    Array.isArray(h.missingUiCollections) && h.missingUiCollections.length === 0,
    `missingUiCollections 非空：${JSON.stringify(h.missingUiCollections)}`,
  );
  return `${h.uiCollectionsRegistered}/${h.uiCollectionsExpected}`;
});

/**
 * 时间戳字段元数据（DEV-51）。
 *
 * 为什么这条断言必须存在：
 *   API 侧的 `createdAt` 一直是好的（ACL 白名单里就有它），但后台界面**选不到** ——
 *   NocoBase 会把 Sequelize 托管的时间戳从集合字段注册表里主动删除，
 *   而 db2cm 只 dump 字段注册表。后果是"工单列表排不出报修时间、事件时间线没有时间"，
 *   而**上面所有接口断言仍然全绿** —— 与 DEV-48 完全同型。
 *   所以必须显式断言"元数据里真的有这两行"，否则修好了也没人知道。
 */
await check('后台时间戳字段元数据齐备（否则列表排不出"报修时间"、时间线没有时间）', async () => {
  const r = await http(`${BASE_URL}/api/svc:health`);
  const h = unwrapHealth(parseJson(r.body, 'svc:health'));
  assert(
    typeof h.uiTimestampFieldsExpected === 'number' &&
      typeof h.uiTimestampFieldsRegistered === 'number',
    '健康检查未暴露 uiTimestampFieldsExpected / uiTimestampFieldsRegistered',
  );
  assert(
    h.uiTimestampFieldsRegistered === h.uiTimestampFieldsExpected,
    `期望 ${h.uiTimestampFieldsExpected} 行，实际 ${h.uiTimestampFieldsRegistered} 行；` +
      `缺：${JSON.stringify(h.missingUiTimestampFields ?? [])}`,
  );
  assert(
    Array.isArray(h.missingUiTimestampFields) && h.missingUiTimestampFields.length === 0,
    `missingUiTimestampFields 非空：${JSON.stringify(h.missingUiTimestampFields)}`,
  );
  return `${h.uiTimestampFieldsRegistered}/${h.uiTimestampFieldsExpected}（表数 × 2）`;
});

// —— 第 4 组：带 Origin 的登录（这正是此前完全缺失的那一侧）——
const PUBLIC_ORIGIN = envValue('SMOKE_PUBLIC_ORIGIN', BASE_URL);

await check('携带正确 Origin 的登录成功（浏览器必带 Origin，curl 不会）', async () => {
  const r = await http(`${BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: PUBLIC_ORIGIN },
    body: JSON.stringify({ email: SMOKE_ADMIN_EMAIL, password: SMOKE_ADMIN_PASSWORD }),
  });
  assert(
    r.status === 200,
    `HTTP ${r.status} ${r.body.slice(0, 200)}` +
      (r.body.includes('Invalid sign-in origin')
        ? '  ← 代理头问题：检查 nginx/conf.d/proxy-headers.inc 是否使用 $http_host'
        : ''),
  );
  const data = parseJson(r.body, 'auth:signIn').data;
  assert(data && data.token, '登录响应里没有 token');
  return `HTTP 200 · Origin=${PUBLIC_ORIGIN}`;
});

await check('来源校验确实生效：未知 Origin 一律 403（反向对照，防"校验被关掉"）', async () => {
  const r = await http(`${BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ email: SMOKE_ADMIN_EMAIL, password: SMOKE_ADMIN_PASSWORD }),
  });
  assert(
    r.status === 403,
    `HTTP ${r.status}（期望 403）—— 若为 200 说明来源校验被整体关掉了，那是更大的问题`,
  );
  return 'HTTP 403';
});

// —— 第 5 组：Phase 4-H 后台业务页面（清单 → 真机）——
//
// 为什么这一组必须存在（这是本项目第三次踩到"接口全绿、界面全瞎"）：
//   后台页面存在 desktopRoutes / flowModels 两张**数据表**里，不是配置文件。
//   于是有两种静默事故：
//     ① 页面被删、或播种脚本（scripts/seed-admin-pages.mjs）被误删
//        → 后台导航里没有这些页面，而**所有 /api 断言照样全绿**；
//     ② 为了让 applyBlueprint 通过 `default-field-groups-incomplete` 校验，
//        敏感列（token 哈希）**必须**写进 defaults.collections.*.fieldGroups。
//        当前唯一让"必须写进分组"与"绝不展示"并存的条件是：这些页面
//        **一个蓝图弹窗都不挂**。一旦有人给页面挂上 popup，分组就会被渲染成
//        表单项 → 敏感列直接出现在界面上，而**没有任何 HTTP 断言会变红**。
//
//   所以这一组盯两件事：**页面在不在** + **区块到底引用了哪些列**。
//   权威视图是 `flowSurfaces:exportBlueprint`（校验器认的那份页面内容），
//   而不是"我们发送了什么" —— 发送成功 ≠ 落库成功 ≠ 界面上就是这个样子。
//   敏感列清单来自 scripts/expected-sensitive-columns.mjs，与播种脚本同一份。

const adminToken = await smokeSignIn(SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD);

/** 后台页面路由（拿权威的 schemaUid 用） */
async function fetchAdminRoutes() {
  const r = await http(`${BASE_URL}/api/desktopRoutes:list?pageSize=200&sort=sort`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert(r.status === 200, `desktopRoutes:list HTTP ${r.status}`);
  return parseJson(r.body, 'desktopRoutes:list').data ?? [];
}

/**
 * flowModels 整表（本环境约 1.4k 个节点 / 0.5MB），一次取回后在内存里建树。
 *
 * ⚠️ 为什么不用 `flowSurfaces:exportBlueprint` 回读页面内容：
 *    它对**含关联列的页面**直接 400 ——
 *    `cannot export field 'TableColumnModel' … unsupported-node`。
 *    全量工单（`store`）、事件时间线与派工记录（`ticket`）都会中招，
 *    也就是说这个"官方回读通道"在本项目的四张页面里有三张不可用。
 *    flowModels 树是后台**渲染时真正读的东西**，比导出通道更权威。
 */
async function fetchAllFlowModels() {
  const r = await http(`${BASE_URL}/api/flowModels:list?paginate=false`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    timeout: 20000,
  });
  assert(r.status === 200, `flowModels:list HTTP ${r.status}`);
  const models = parseJson(r.body, 'flowModels:list').data ?? [];
  assert(models.length > 0, 'flowModels 里一个节点都没有 —— 断言会假绿，必须修');
  return models;
}

/**
 * 「角色 → 菜单」授权行（`rolesDesktopRoutes`）。
 *
 * 页面建出来 ≠ 该看的人能看见。实测 applyBlueprint 只把新路由授给内置的
 * member / admin，四个业务角色一条都没有；反过来若全都授，门店员工会同时看到
 * 「我的门店工单」和「全量工单」两个入口、进去却都是自己门店的数据。
 * 由 `scripts/seed-admin-pages.mjs` 按 `ROLE_MENU_MATRIX` 显式维护，这里核对。
 */
async function fetchAdminRoleGrants() {
  const r = await http(`${BASE_URL}/api/rolesDesktopRoutes:list?pageSize=500`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert(r.status === 200, `rolesDesktopRoutes:list HTTP ${r.status}`);
  return parseJson(r.body, 'rolesDesktopRoutes:list').data ?? [];
}

const adminRoutes = await fetchAdminRoutes();
const allFlowModels = await fetchAllFlowModels();
const adminRoleGrants = await fetchAdminRoleGrants();

const childrenOf = new Map();
for (const m of allFlowModels) {
  if (!m.parentId) continue;
  if (!childrenOf.has(m.parentId)) childrenOf.set(m.parentId, []);
  childrenOf.get(m.parentId).push(m);
}

/**
 * 取某页面（含其全部 Tab）的模型节点子树。
 *
 * ⚠️ 根**不只有页面 uid**：区块挂在 **Tab 自己的 schemaUid** 下
 *    （desktopRoutes 里 `type='tabs'` 的路由各有 schemaUid）。只从页面 uid 出发
 *    会拿到 0 个区块 —— 于是"敏感列检查"会因为**读到空**而通过，那是最坏的假绿。
 */
function pageSubtree(pageRoute, tabRoutes) {
  const roots = new Set([pageRoute.schemaUid, ...tabRoutes.map((r) => r.schemaUid)].filter(Boolean));
  const out = [];
  const stack = [...roots];
  const seen = new Set();
  while (stack.length) {
    const uid = stack.pop();
    if (seen.has(uid)) continue;
    seen.add(uid);
    if (!roots.has(uid)) {
      const node = allFlowModels.find((m) => m.uid === uid);
      if (node) out.push(node);
    }
    for (const kid of childrenOf.get(uid) ?? []) stack.push(kid.uid);
  }
  return out;
}

/** 页面 → { tabRoutes, nodes, blocks, columns, filters } */
function inspectAdminPage(title) {
  // ⚠️ 必须限定 type === 'flowPage'：单 Tab 页面的 Tab 标题与页面标题**同名**，
  //    只按标题找的话，页面路由被删后仍会被同名的 tabs 路由"命中" ——
  //    于是"页面没了"这件事不会变红。
  const route = adminRoutes.find((r) => r.type === 'flowPage' && r.title === title);
  assert(route, `desktopRoutes 里没有 type=flowPage 的「${title}」`);
  const tabRoutes = adminRoutes.filter((r) => r.type === 'tabs' && r.parentId === route.id);
  const nodes = pageSubtree(route, tabRoutes);
  const blocks = nodes.filter((n) => n.use === 'TableBlockModel');
  const columns = nodes.filter((n) => n.use === 'TableColumnModel');
  const filters = nodes.filter((n) => n.use === 'FilterActionModel');
  return { route, tabRoutes, nodes, blocks, columns, filters };
}

/** 节点引用的列名（列 / 排序 / 筛选三个来源都要看） */
function referencedColumnsOf(nodes) {
  const out = new Set();
  for (const n of nodes) {
    const p = n.stepParams ?? {};
    if (n.use === 'TableColumnModel') {
      const f = p.fieldSettings?.init?.fieldPath;
      if (f) out.add(f);
    }
    for (const s of p.tableSettings?.defaultSorting?.sort ?? []) if (s?.field) out.add(s.field);
  }
  // 筛选条件在 props.defaultFilterValue（不是 stepParams）
  for (const n of nodes) {
    for (const it of n.props?.defaultFilterValue?.items ?? []) if (it?.path) out.add(it.path);
  }
  return out;
}

await check('Phase 4-H 四张后台页面均已落库（否则后台导航里空空如也）', () => {
  const problems = [];
  for (const page of REQUIRED_ADMIN_PAGES) {
    const route = adminRoutes.find((r) => r.type === 'flowPage' && r.title === page.title);
    if (!route) {
      problems.push(`缺页面「${page.title}」`);
      continue;
    }
    if (page.tabs != null && route.enableTabs !== page.tabs > 1) {
      problems.push(
        `「${page.title}」enableTabs=${route.enableTabs}，与清单的 ${page.tabs} 个 Tab 不符`,
      );
    }
  }
  assert(problems.length === 0, problems.join('；'));
  return REQUIRED_ADMIN_PAGES.map((p) => p.title).join(' / ');
});

await check('后台页面区块**不引用任何敏感列**（DEV-53 处置②的守护断言）', () => {
  const violations = [];
  const stats = [];
  for (const page of REQUIRED_ADMIN_PAGES) {
    const { nodes, blocks, columns } = inspectAdminPage(page.title);
    // 正对照：断言必须不可能"因为页面是空的"而通过（工程铁律 1）。
    assert(blocks.length > 0, `「${page.title}」模型树里没有 TableBlockModel`);
    assert(columns.length >= 3, `「${page.title}」只有 ${columns.length} 个表格列（校验器下限是 3）`);
    for (const b of blocks) {
      const coll = b.stepParams?.resourceSettings?.init?.collectionName;
      assert(
        coll === page.collection,
        `「${page.title}」区块指向 ${coll}，清单里是 ${page.collection}`,
      );
    }
    const cols = referencedColumnsOf(nodes);
    const hit = [...cols].filter((c) => SENSITIVE_COLUMN_SET.has(c));
    if (hit.length) violations.push(`「${page.title}」引用了敏感列：${hit.join(', ')}`);
    stats.push(`${page.title}=${columns.length}列/${blocks.length}区块`);
  }
  assert(violations.length === 0, violations.join('；'));
  return stats.join(' · ');
});

await check('每个状态 Tab 都带完整默认筛选（约束 4：≥3 个可筛选字段且都有值）', () => {
  const problems = [];
  let checked = 0;
  for (const tab of TICKET_STATUS_TABS) {
    const { tabRoutes } = inspectAdminPage('我的门店工单');
    const tabRoute = tabRoutes.find((r) => r.title === tab.title);
    if (!tabRoute) {
      problems.push(`缺状态 Tab「${tab.title}」`);
      continue;
    }
    // Tab 路由自己就是模型树的根（区块挂在它下面），所以 tabRoutes 传空数组
    const nodes = pageSubtree(tabRoute, []);
    const filters = nodes.filter((n) => n.use === 'FilterActionModel');
    assert(filters.length > 0, `状态 Tab「${tab.title}」没有筛选动作`);
    const items = filters[0].props?.defaultFilterValue?.items ?? [];
    checked += 1;
    // 无 value 的条目是平台自动生成的空筛选器，不算"我们设的默认筛选"
    const real = items.filter((i) => 'value' in i);
    if (real.length < DEFAULT_FILTER_MIN_FIELDS) {
      problems.push(`「${tab.title}」默认筛选只有 ${real.length} 条带值条件`);
    }
    const statusHit = real.find((i) => i.path === 'status' && i.value === tab.status);
    if (!statusHit) {
      problems.push(`「${tab.title}」默认筛选里没有 status=$eq:${tab.status}`);
    }
  }
  assert(
    checked === TICKET_STATUS_TABS.length,
    `只检查了 ${checked}/${TICKET_STATUS_TABS.length} 个状态 Tab —— 断言会假绿，必须修`,
  );
  assert(problems.length === 0, problems.join('；'));
  return `${checked} 个状态 Tab 全部命中 status 且 ≥${DEFAULT_FILTER_MIN_FIELDS} 条带值条件`;
});

/**
 * 取 `FilterFormItemModel` 的**搜索项**，按"它连到哪张表"索引。
 *
 * ⚠️ 为什么不能像其他节点一样走 `pageSubtree` 树遍历：
 *   `filterForm` 的字段节点挂在 `FilterFormGridModel` 下面，而这个中间节点
 *   在 `/api/flowModels:list?paginate=false` 的返回里**没有 parentId**
 *   （实测：`"parentId" in grid === false`）—— 树的链在那儿断了，
 *   从页面根节点走下来**一个搜索项也到不了**。
 *   走树会得到 `searched=[]`，正是本次实测踩到的假红。
 *
 * 好在 `FilterFormItemModel` 自己带了两条可靠信息：
 *   · `filterField.name`      —— 搜的是哪个字段
 *   · `defaultTargetUid`      —— 这张搜索框连到哪张表（= 目标表格的 uid）
 * 直接按 targetUid 索引即可，不依赖任何中间节点。
 */
function searchItemsByTarget() {
  const map = new Map();
  for (const m of allFlowModels) {
    if (m.use !== 'FilterFormItemModel') continue;
    const init = m.stepParams?.filterFormItemSettings?.init ?? {};
    const target = init.defaultTargetUid;
    if (!target) continue;
    if (!map.has(target)) map.set(target, []);
    map.get(target).push(init.filterField?.name);
  }
  return map;
}

/**
 * Phase 4-I 走查补丁：显眼的工单号搜索框。
 *
 * 背景：原设计只有 `actions:['filter']`，在界面上是一个**图标按钮**。
 * 真人走查（门店售后 UAT-A）在 234 张工单里找不到目标单，反馈"没有搜索功能"。
 * 所以补了 `filterForm` 区块做常驻输入框，这里守住它不被人删掉或断链。
 *
 * 三个方向都要断（少一个就会漏掉一种坏法）：
 *  ① 区块在     —— 每个工单列表 Tab 都有 FilterFormBlockModel；
 *  ② 连得上     —— grid 的 filterManager 指向**本 tab 的**表格（防"框是装饰"）；
 *  ③ 搜得对     —— 连过去的那张表，其搜索项字段确实是 ticket_no
 *                  （防"框连上了但搜的是别的字段"）。
 */
await check('工单页面都有显眼的工单号搜索框，且已连到表格上（否则"有框搜不动"）', () => {
  const problems = [];
  const itemsByTarget = searchItemsByTarget();
  let checked = 0;

  // H2 单 Tab，H1 多 Tab：两类都要覆盖，避免只验了其中一个
  const pages = [
    { title: '我的门店工单', expectTabs: TICKET_STATUS_TABS.length + 1 },
    { title: '全量工单', expectTabs: 1 },
  ];

  for (const page of pages) {
    const { tabRoutes } = inspectAdminPage(page.title);
    assert(
      tabRoutes.length === page.expectTabs,
      `「${page.title}」有 ${tabRoutes.length} 个 Tab，期望 ${page.expectTabs} 个 —— 断言基数变了，必须修`,
    );
    for (const tabRoute of tabRoutes) {
      const nodes = pageSubtree(tabRoute, []);
      const forms = nodes.filter((n) => n.use === 'FilterFormBlockModel');
      const tables = nodes.filter((n) => n.use === 'TableBlockModel');
      if (forms.length === 0) {
        problems.push(`「${page.title} / ${tabRoute.title}」没有搜索框（FilterFormBlockModel）`);
        continue;
      }
      if (tables.length === 0) {
        problems.push(`「${page.title} / ${tabRoute.title}」搜索框下面没有表格，连不上`);
        continue;
      }
      checked += 1;

      // ② 连接性：找到承载该 tab 的 grid，看它的 filterManager 是否指向本 tab 的表格
      const grid = nodes.find((n) => n.use === 'BlockGridModel');
      const fm = grid?.filterManager ?? [];
      const tableUids = new Set(tables.map((t) => t.uid));
      const wired = fm.filter((e) => tableUids.has(e.targetId));
      if (wired.length === 0) {
        problems.push(
          `「${page.title} / ${tabRoute.title}」搜索框没连到本 tab 的表格` +
            `（filterManager=${JSON.stringify(fm)}，表格 uid=${[...tableUids].join(',')}）`,
        );
        continue;
      }
      if (!wired.some((e) => (e.filterPaths ?? []).includes('ticket_no'))) {
        problems.push(
          `「${page.title} / ${tabRoute.title}」连接存在但没带 ticket_no` +
            `（filterPaths=${JSON.stringify(wired.flatMap((e) => e.filterPaths ?? []))}）`,
        );
      }

      // ③ 字段正确性：连过去的那张表，搜索项必须真的是 ticket_no
      for (const e of wired) {
        const names = itemsByTarget.get(e.targetId);
        if (!names || names.length === 0) {
          problems.push(
            `「${page.title} / ${tabRoute.title}」表格 ${e.targetId} 有连接但找不到对应搜索项节点`,
          );
          continue;
        }
        if (!names.includes('ticket_no')) {
          problems.push(
            `「${page.title} / ${tabRoute.title}」表格 ${e.targetId} 的搜索项是 ` +
              `${JSON.stringify(names)}，不是 ticket_no`,
          );
        }
      }
    }
  }

  // 铁律 10：读到空是最坏的假绿
  assert(checked > 0, '一个搜索框都没检查到 —— 断言会假绿，必须修');
  assert(
    itemsByTarget.size > 0,
    '一条搜索项都没索引到（FilterFormItemModel 的 defaultTargetUid 全空？）—— 断言会假绿，必须修',
  );
  assert(problems.length === 0, problems.join('；'));
  return `${checked} 个 Tab 的搜索框均已连到表格，且搜索字段为 ticket_no`;
});

await check('业务角色的后台菜单可见性符合角色矩阵（否则门店员工会看到两个长得一样的菜单）', () => {
  const problems = [];
  const lines = [];
  // 铁律 10：读到空是最坏的假绿。这里必须证明"确实读到了授权行"，
  // 否则 rolesDesktopRoutes 一旦改名/清空，本断言会因为两边都是空集而永久绿灯。
  let grantRows = 0;

  const pageIdOf = new Map(
    adminRoutes.filter((r) => r.type === 'flowPage').map((r) => [r.id, r.title]),
  );
  const groupRoute = adminRoutes.find((r) => r.type === 'group' && r.title === ADMIN_NAV_GROUP);

  for (const role of MANAGED_MENU_ROLES) {
    const want = new Set(visiblePagesOf(role) ?? []);
    const rows = adminRoleGrants.filter((g) => g.roleName === role);
    grantRows += rows.length;
    const ids = new Set(rows.map((g) => g.desktopRouteId));
    const got = new Set([...ids].map((id) => pageIdOf.get(id)).filter(Boolean));

    for (const title of got) {
      if (!want.has(title)) problems.push(`${role} **不该**看到「${title}」`);
    }
    for (const title of want) {
      if (!got.has(title)) problems.push(`${role} 看不到「${title}」`);
    }
    // 导航组没授权的话，子菜单根本不会出现在侧边栏（页面授权全对也白搭）
    if (groupRoute && !ids.has(groupRoute.id)) {
      problems.push(`${role} 没有导航组「${ADMIN_NAV_GROUP}」的授权，子菜单不会显示`);
    }
    lines.push(`${role}=${[...got].sort().join('+') || '无'}`);
  }

  assert(
    grantRows > 0,
    '一个业务角色的菜单授权行都没读到 —— 断言会因为两边都是空集而假绿，必须修',
  );
  assert(problems.length === 0, problems.join('；'));
  return `${MANAGED_MENU_ROLES.length} 个业务角色（共 ${grantRows} 行授权）：${lines.join(' · ')}`;
});

await check('任一业务角色都只有 1 个工单列表入口（两个菜单不能长得一样）', () => {
  // 单独拎出来：上面那条是"逐格核对矩阵"，这条盯的是**那条要求的意图** ——
  // 同一角色不该同时拥有两个工单列表入口（进去看到的是同一份数据，纯误导）。
  // 矩阵将来可能因业务调整而变，但这条 UX 底线不该被悄悄改掉。
  //
  // ⚠️ 必须从**实际授权**出发，不能用 `visiblePagesOf(role)` 过滤：
  //    那样等于"只看我期望的页面里有哪些可见"，而多出来的违规授权
  //    压根不在期望列表里，会被静默滤掉 —— 反向验证实测：注入
  //    「全量工单」给门店售后后，这条**没有变红**。正是铁律 10 的
  //    "别用期望过滤实际"这一型，留着注释以免以后又被改回去。
  const problems = [];
  // ⚠️ 只映射 **flowPage** 类型的路由：单 Tab 页面的 Tab 标题与页面标题**同名**
  //    （DEV-53 坑 3），若不过滤类型，「全量工单」会被 page 与它的 tab 各命中一次，
  //    于是同一角色"同时看到 全量工单 与 全量工单"—— 一条自己造出来的假红。
  //    反向验证时正是靠这条才发现：红得对不对，和红不红一样重要。
  const titleOf = new Map(
    adminRoutes.filter((r) => r.type === 'flowPage').map((r) => [r.id, r.title]),
  );
  // 工单列表入口 = REQUIRED_ADMIN_PAGES 里 collection 是 serviceTickets 的页面。
  // 用判据而非硬编码标题：将来若新增第三个工单列表页，它自动纳入本断言。
  const listPages = new Set(
    REQUIRED_ADMIN_PAGES.filter((p) => p.collection === 'serviceTickets').map((p) => p.title),
  );
  assert(listPages.size >= 2, '工单列表页面不足 2 个 —— 本断言的判据失效，必须修');

  for (const role of MANAGED_MENU_ROLES) {
    const ids = new Set(
      adminRoleGrants.filter((g) => g.roleName === role).map((g) => g.desktopRouteId),
    );
    const got = new Set([...ids].map((id) => titleOf.get(id)).filter(Boolean));
    const ticketLists = [...got].filter((t) => listPages.has(t));

    if (ticketLists.length > 1) {
      problems.push(`${role} 同时看到 ${ticketLists.join(' 与 ')} —— 两个入口的数据范围相同`);
    }
    if (ticketLists.length === 0) {
      problems.push(`${role} 一个工单列表入口都没有`);
    }
  }
  assert(problems.length === 0, problems.join('；'));
  return `${MANAGED_MENU_ROLES.length} 个业务角色各自只有 1 个工单列表入口`;
});

// ============================================================================
console.log('');
console.log('══════════════════════════════════════════════════════════════');
if (failures.length === 0) {
  // ⚠️ 跳过项必须**当场列出**：`全部通过：N 项 · 跳过 M 项` 里的 N **不含** M。
  //    编排器（uat-reset-baseline.mjs）会把这个后缀一起抄进汇总行。
  console.log(
    `  ✅ Phase 1~4 端到端验收全部通过：${passed} 项` +
      (skipped ? ` · 跳过 ${skipped} 项` : ''),
  );
  console.log('══════════════════════════════════════════════════════════════');
  for (const s of skipReasons) {
    console.log(`  ⏭️  跳过：${s.label}`);
    console.log(`      ${s.message}`);
  }
  if (skipped) console.log('  （跳过项不计入"通过"，也不代表已验证）');
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
  console.log(
    `  ❌ 通过 ${passed} 项，失败 ${failures.length} 项` +
      (skipped ? `，跳过 ${skipped} 项` : '') +
      '：',
  );
  for (const f of failures) console.log(`     • ${f.label}\n       ${f.message}`);
  for (const s of skipReasons) console.log(`     ⏭️  （跳过）${s.label}`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(1);
}
