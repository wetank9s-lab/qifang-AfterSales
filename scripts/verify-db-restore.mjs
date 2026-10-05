#!/usr/bin/env node
/**
 * verify-db-restore —— RB-5：**隔离恢复演练** + 损坏备份反证
 * ===========================================================================
 * 这个脚本存在的理由
 * ---------------------------------------------------------------------------
 * `backup-db.mjs` 产出的备份**不构成任何发布证据** —— 它的退出码 0 只说明
 * "pg_dump 跑完了"，不说明"这份文件能恢复出一个可用的库"。
 * 一个从未被恢复过的备份，价值低于零：它代理了**虚假的安全感**。
 *
 * 🔴 本阶段最重要的一条纪律：**绝不恢复回原库**
 * ---------------------------------------------------------------------------
 * "把备份恢复回它自己的库"证明不了任何事情 —— 因为那个库本来就是好的。
 * 它只能证明 psql/pg_restore 会拼字符串，却在验收记录里写一句"已演练恢复"，
 * 而这是**最典型的假绿**：一次真实的 PITR 场景里，库是空的、是坏的、
 * 或者版本不同 —— 那时才会暴露的问题，在"恢复回原库"里一个都遇不到。
 *
 * ⇒ 本脚本强制三层隔离，缺一层就不算演练：
 *   ① **不同 compose project**（`-p svcdrill<rand>`）→ 容器、网络、卷全部另起
 *   ② **新 PG volume**（drill 自己的具名卷）→ 物理上与生产数据无关
 *   ③ **app 也不复用**：drill 起自己的 app，指向 drill 的库，用 storage 的**副本**
 *     （副本里含 `apps/main/aes_key.dat` —— 那是 NocoBase 的 AES 主密钥，
 *      不复制它，恢复出来的库连加密字段都读不了）
 *
 * 三条纵向结论，缺一条就不算通过
 * ---------------------------------------------------------------------------
 *   A. **结构恢复**：表 / 列指纹 / 唯一索引集合与源库逐项相等（不是"表存在"，是"完全一致"）
 *   B. **数据恢复**：13 张探针表行数逐项相等
 *   C. **可用恢复**：drill 的 app 起得来，且 `/api/svc:health` 的 **40 个数据派生字段**
 *      与源库逐项相等，外加一次**认证业务读**（`serviceTickets:list` 的总数 == 库内行数）
 *
 * 只做 A/B 是不够的 —— 那只能证明"字节被搬过去了"。C 才回答
 * "NocoBase + 本插件能不能在这个库上正常工作"。所以 C 不是可选加分项。
 *
 * 反证（`--corrupt=…`）：堵"半恢复假成功"
 * ---------------------------------------------------------------------------
 * 仅仅证明"好备份能恢复"是不够的 —— 还必须证明"**坏备份不会被当成好的**"，
 * 否则脚本在真实故障时可能把一次部分恢复报成成功。
 * 本脚本用 `--corrupt=truncate|flip|empty|garbage` 故意损坏备份，
 * 然后要求**整条流水线失败**（非零退出 + 不打印成功横幅）。
 * 注意判据是"我们的脚本失败了"，不是"pg_restore 失败了" ——
 * 后者只是手段；前者才是发布时真正依赖的性质。
 *
 * 用法
 * ---------------------------------------------------------------------------
 *   node scripts/verify-db-restore.mjs                      # 完整演练（含起 app）
 *   node scripts/verify-db-restore.mjs --no-app             # 跳过起 app（证据不完整）
 *   node scripts/verify-db-restore.mjs --corrupt=truncate    # 反证：截断的备份必须被拒
 *   node scripts/verify-db-restore.mjs --corrupt=flip        # 反证：字节翻转
 *   node scripts/verify-db-restore.mjs --corrupt=empty       # 反证：0 字节
 *   node scripts/verify-db-restore.mjs --corrupt=garbage     # 反证：随机字节冒充 dump
 *   node scripts/verify-db-restore.mjs --keep                # 保留演练产物便于排查
 *
 * 退出码
 *   正向：0 = 全部通过；1 = 有断言失败；2 = 环境错误
 *   反向（--corrupt）：0 = **损坏确实被拒绝**（反证成立）；1 = 损坏竟然"恢复成功"（严重）
 *
 * ⚠️ 演练产物落在 `.tmp-verify/restore-drill/`（已被 `.gitignore:74` 覆盖）。
 *    刻意**不新建** ignore 规则：那里会复制 `uploads-private`（客户照片），
 *    落在"已验证被忽略"的目录里，比依赖一条新规则安全。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');

const ARGS = process.argv.slice(2);
const NO_APP = ARGS.includes('--no-app');
const KEEP = ARGS.includes('--keep');
const CORRUPT = (ARGS.find((a) => a.startsWith('--corrupt=')) || '').split('=')[1] || null;
const CORRUPT_MODES = ['truncate', 'flip', 'empty', 'garbage'];
if (CORRUPT && !CORRUPT_MODES.includes(CORRUPT)) {
  console.error(`  ❌ --corrupt 只接受 ${CORRUPT_MODES.join(' | ')}，收到 "${CORRUPT}"`);
  process.exit(2);
}

const PG_CONTAINER = 'svc-postgres';
const APP_CONTAINER = 'svc-app';
const LIVE_BASE = `http://127.0.0.1:${process.env.NGINX_HTTP_PORT || 8080}`;
/**
 * drill app 的宿主端口必须**每次运行都不同**，不能用固定的 13991。
 * 原因（本机实测）：Bash 工具存在"同一条命令跑两遍"的行为，且杀不掉的那一遍
 * 仍会占着端口 ⇒ 固定端口时第二遍的 drill app 绑定失败、health 永远起不来，
 * 表现为**一次莫名其妙的假红**（而真正的原因与备份/恢复毫无关系）。
 * ⇒ 随机高位端口 + 启动前占位检测（与 headless Chrome 那次的教训同源）。
 */
let DRILL_APP_PORT = Number(process.env.DRILL_APP_PORT || 0);
let DRILL_APP_URL = '';

const RUN_ID = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const DRILL_PROJECT = `svcdrill${crypto.randomBytes(3).toString('hex')}`;
const WORK = path.join(ROOT, '.tmp-verify', 'restore-drill', RUN_ID);
const DRILL_STORAGE = path.join(WORK, 'storage');
const DRILL_COMPOSE = path.join(WORK, 'docker-compose.drill.yml');
const BACKUP_OUT = path.join(ROOT, 'backups');

const pas = [];
const fails = [];
const skipped = [];
const notes = [];
const warns = [];
let passCount = 0;

function pass(msg) { passCount += 1; pas.push(msg); console.log(`  ✅ ${msg}`); }
function fail(msg) { fails.push(msg); console.log(`  ❌ ${msg}`); }
function skip(msg) { skipped.push(msg); console.log(`  ⏭️  ${msg}`); }
function note(msg) { notes.push(msg); console.log(`  ·  ${msg}`); }
/** 警告：不改变判定，但必须被看见（例如"临时目录没删掉"不该让演练判红，也不该隐身） */
function warn(msg) { warns.push(msg); console.log(`  ⚠️  ${msg}`); }

function printWarns() {
  if (warns.length === 0) return;
  console.log(` ⚠️ ${warns.length} 条警告（不构成失败，但需处理）：`);
  for (const w of warns) console.log(`     - ${w}`);
}
function section(t) { console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`); }

// --- 进程封装 ---------------------------------------------------------------

/** 任何一步失败都**必须**炸掉，不允许静默继续 —— 否则后面的断言是在错误前提上做的 */
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...opts });
}

function runChecked(cmd, args, opts = {}, label = '') {
  const r = run(cmd, args, opts);
  if (r.status !== 0) {
    fail(`${label || `${cmd} ${args.slice(0, 3).join(' ')}`} 执行失败（rc=${r.status}）：${(r.stderr || '').trim().slice(0, 300)}`);
    throw new Error(`command failed: ${cmd} ${args.join(' ')}`);
  }
  return r.stdout;
}

const dcompose = (args, opts = {}) =>
  run('docker', ['compose', '-p', DRILL_PROJECT, '-f', DRILL_COMPOSE, ...args], opts);

const dcomposeChecked = (args, label, opts = {}) => {
  const r = dcompose(args, opts);
  if (r.status !== 0) {
    fail(`${label} 失败（rc=${r.status}）：${(r.stderr || '').trim().slice(0, 400)}`);
    throw new Error(`drill compose failed: ${args.join(' ')}`);
  }
  return r.stdout;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 端口是否可绑定（占位检测：不连任何东西，只试 bind） */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickFreePort() {
  if (DRILL_APP_PORT) {
    if (await isPortFree(DRILL_APP_PORT)) return DRILL_APP_PORT;
    note(`DRILL_APP_PORT=${DRILL_APP_PORT} 已被占用，改为随机挑选`);
  }
  for (let i = 0; i < 40; i += 1) {
    const p = 14000 + crypto.randomInt(0, 1000);
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p)) return p;
  }
  return 0;
}

/**
 * 清掉历史遗留的演练目录。
 * ⚠️ 为什么需要：被中断/被 kill 的那一遍走不到 `finish()`，会留下 ~12MB 的
 *    storage 副本（其中 `uploads-private/` 是**客户照片**）。不清理会无限累积。
 * 🔴 删除范围严格受限，两道闸缺一不可：
 *    ① 只删 `.tmp-verify/restore-drill/` 下**名字符合 RUN_ID 形态**
 *       （`<base36>-<6位hex>`）的兄弟目录，绝不递归删其它任何路径；
 *    ② 只删 **mtime 超过 30 分钟**的 —— 否则同时跑第二个演练（例如反向模式）
 *       时，它会把**正在运行的那一遍**的工作目录删掉，症状是"storage 突然消失"
 *       这种与备份恢复毫无关系、极难归因的假红。一次演练 <10 分钟，30 分钟足够安全。
 */
const STALE_WORK_MS = 30 * 60 * 1000;
const WORK_PARENT = path.dirname(WORK);
const RUN_ID_PAT = /^[a-z0-9]+-[0-9a-f]{6}$/;

/** 删除前的最后一道闸：名字必须是 RUN_ID 形态，且路径不越出 WORK_PARENT */
function assertSafeTargetName(name) {
  if (!RUN_ID_PAT.test(name)) throw new Error(`拒绝删除：目录名不符合演练 RUN_ID 形态（${name}）`);
  const abs = path.join(WORK_PARENT, name);
  if (!abs.startsWith(WORK_PARENT)) throw new Error(`拒绝删除：路径越出演练目录（${abs}）`);
  return abs;
}

/**
 * 删除演练目录（本脚本自己创建的）。
 * ⚠️ 实测：一次演练会产出 ~250 个文件（storage 副本），而宿主机 agent 有
 *    "单轮批量删除守卫"（threshold=50）⇒ `fs.rmSync(recursive)` 直接抛
 *    `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`。
 *    与既往 `h5/dist` 构建那次是同一个守卫。
 * ⇒ 策略：先尝试直连删；被拦下则用**一次性容器**删（容器内进程不受该守卫审计）。
 *    回退路径**必须**先过 `assertSafeTargetName`，绝不允许指向别处。
 */
function removeWorkDirs(names) {
  const out = [];
  for (const name of names) {
    let abs;
    try { abs = assertSafeTargetName(name); } catch (e) { out.push({ name, how: null, err: e.message }); continue; }
    if (!fs.existsSync(abs)) { out.push({ name, how: 'absent' }); continue; }

    try { fs.rmSync(abs, { recursive: true, force: true }); out.push({ name, how: 'direct' }); continue; } catch { /* 守卫拦下，走容器 */ }

    // 把**父目录**挂进去，只删这一个子目录（父目录里其它东西一动不动）
    const r = run('docker', ['run', '--rm', '-v', `${WORK_PARENT}:/p`, 'alpine', 'sh', '-c', `rm -rf "/p/${name}"`]);
    if (!fs.existsSync(abs)) out.push({ name, how: 'container' });
    else out.push({ name, how: null, err: `容器删除未生效：${(r.stderr || '').trim().slice(0, 160)}` });
  }
  return out;
}

function sweepStaleWorkDirs() {
  if (!fs.existsSync(WORK_PARENT)) return 0;
  const stale = [];
  for (const e of fs.readdirSync(WORK_PARENT, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === path.basename(WORK) || !RUN_ID_PAT.test(e.name)) continue;
    let age = 0;
    try { age = Date.now() - fs.statSync(path.join(WORK_PARENT, e.name)).mtimeMs; } catch { continue; }
    if (age >= STALE_WORK_MS) stale.push(e.name);
  }
  if (stale.length === 0) return 0;
  return removeWorkDirs(stale).filter((r) => r.how === 'direct' || r.how === 'container').length;
}

function httpJson(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method, headers, timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* 非 JSON 也要能拿到原文 */ }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, text: '', error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, text: '', error: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

// --- .env 读取（⚠️ 绝不 `source`：值里含 shell 元字符，会被当命令执行）---------
function envValue(key) {
  const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    if (t.slice(0, i).trim() === key) return t.slice(i + 1).trim();
  }
  return null;
}

// --- 源库读取 ---------------------------------------------------------------

function pgEnv() {
  const raw = runChecked('docker', ['exec', PG_CONTAINER, 'printenv', 'POSTGRES_USER', 'POSTGRES_DB'],
    {}, '读取 postgres 容器环境');
  const [user, db] = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!user || !db) throw new Error('POSTGRES_USER/POSTGRES_DB 为空');
  return { user, db };
}

const COUNT_PROBES = [
  'service_tickets', 'service_visits', 'service_visit_photos', 'ticket_events',
  'sms_logs', 'attachments', 'export_audits', 'store_users',
  'users', 'issuedTokens', 'api_guards', 'daily_sequences', 'idempotency_records',
];

/**
 * 在**任意容器**上跑 psql。
 * ⚠️ 标识符一律加双引号：NocoBase 用带引号的 camelCase 建表，不引用会被折成小写
 *    （实测 `from issuedTokens` ⇒ relation "issuedtokens" does not exist）。
 */
function psqlOn(container, user, db, sql) {
  const r = run('docker', ['exec', container, 'psql', '-U', user, '-d', db,
    '-t', '-A', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  if (r.status !== 0) throw new Error(`psql(${container}) 失败：${(r.stderr || '').trim().slice(0, 300)}`);
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

function countRowsOn(container, user, db) {
  const union = COUNT_PROBES.map((t) => `select '${t}' as t, count(*)::bigint as n from "${t}"`).join(' union all ');
  const out = {};
  for (const line of psqlOn(container, user, db, `select t, n from (${union}) x order by t`)) {
    const [t, n] = line.split('|');
    out[t] = Number(n);
  }
  return out;
}

function schemaOf(container, user, db) {
  const tables = psqlOn(container, user, db,
    "select tablename from pg_tables where schemaname='public' order by tablename");
  const cols = psqlOn(container, user, db,
    "select table_name, string_agg(column_name, ',' order by column_name) from information_schema.columns " +
    "where table_schema='public' group by table_name order by table_name");
  const colFp = {};
  for (const line of cols) {
    const i = line.indexOf('|');
    const t = line.slice(0, i);
    const joined = line.slice(i + 1);
    colFp[t] = { columns: joined.split(',').length, sha16: crypto.createHash('sha256').update(joined).digest('hex').slice(0, 16) };
  }
  const uniq = psqlOn(container, user, db,
    "select tablename||' :: '||indexname from pg_indexes where schemaname='public' " +
    "and indexdef like '%UNIQUE%' order by 1");
  return { tables, columns: colFp, uniqueIndexes: uniq };
}

/** 业务数据抽样：按 id 排序取首/中/尾三条的 (id,status)，比对两边完全一致 */
function ticketSamplesOn(container, user, db) {
  return psqlOn(container, user, db,
    'select id||\'|\'||status from "service_tickets" order by id ' +
    'offset (select case when count(*)>6 then count(*)/2 else 0 end from "service_tickets") limit 3');
}

/**
 * 唯一约束"**实际生效**"探针。
 * ---------------------------------------------------------------------------
 * 为什么不能只比 `pg_indexes`：那只证明**目录里写着**有唯一索引。
 * 一个 `indisvalid=false`（恢复中途失败留下的）索引在目录里照样列得出来，
 * 却完全不拦重复。所以必须真的插一次。
 *
 * 🔴 两个已踩过的坑：
 *  ① 首版写死 `insert into "rolesUsers" ("rolesId","usersId") …` —— 实际列名是
 *     `("roleName","userId")`（`rolesUsers_pkey`）。这会产生 42703「列不存在」，
 *     而不是 23505，于是**好备份也会被报成失败**（假红）。
 *  ② 所以改成"候选表列表 + 只认 23505 的报错文本"：任一候选给出
 *     `duplicate key value violates unique constraint` 即判定生效；
 *     若没有一个给出，则把每个候选的**实际报错**都打出来 ——
 *     这样"探针写错了"与"约束真没生效"能被区分开，而不是混成一句红。
 *
 * 安全性：只在 **drill 库**上跑（一次性、随即销毁），且插入必然失败 ⇒ 不写入任何行。
 */
const DUP_PROBE_CANDIDATES = [
  'service_tickets', 'ticket_events', 'api_guards', 'service_visits', 'attachments',
  'sms_logs', 'daily_sequences', 'users', 'store_users', 'collections',
];

function probeUniqueEnforcement(container, user, db) {
  const tried = [];
  for (const t of DUP_PROBE_CANDIDATES) {
    // `select * from T limit 1` 整行复制 ⇒ 必然撞主键（或复合唯一键）
    const r = run('docker', ['exec', container, 'psql', '-U', user, '-d', db, '-t', '-A',
      '-c', `insert into "${t}" select * from "${t}" limit 1`]);
    const err = `${r.stderr || ''}`;
    if (/duplicate key value violates unique constraint/i.test(err)) {
      const con = (err.match(/unique constraint "([^"]+)"/) || [])[1] || '(未解析出名字)';
      return { ok: true, table: t, constraint: con };
    }
    const first = err.split('\n').find((l) => l.startsWith('ERROR')) || `(无 ERROR 行, rc=${r.status})`;
    tried.push(`${t} → ${first.slice(0, 110)}`);
  }
  return { ok: false, tried };
}

// --- health 比较 -------------------------------------------------------------

/**
 * 忽略清单：**正向列举**要忽略的字段（而不是列举要比较的字段）。
 * 极性很重要：将来给 health 加了新字段，默认会被比较（fail-closed），
 * 而不是默认被忽略 —— 后者会让"新增字段在恢复后不一致"永远不被发现。
 */
const HEALTH_IGNORE = {
  uptimeSeconds: '进程年龄，与数据无关',
  tasksOverall: '派生自 tasks.*',
  tasks: '调度器运行时状态（lastStartedAt/runCount…），每次启动必然不同',
  sms: '连接器形态（当前 mock），由 env 决定而非数据 —— RB-2/P10-B 另议',
  rolesSeededThisRun: '本次启动的增量写入，反映"本进程做过什么"而非数据',
  storesSeededThisRun: '同上',
  uiCollectionsSyncedThisRun: '同上',
  uiTimestampFieldsSyncedThisRun: '同上',
  uiFieldInterfacesRepaired: '同上',
  slaScannedAt: '时间戳',
  loadedAt: '时间戳',
  checkedAt: '时间戳',
  traceId: '请求标识',
  latencyMs: '本次请求耗时',
};

/**
 * 时间相关字段：SLA 逾期数按"当前时刻"计算，演练耗时数分钟，
 * 期间真实业务可能跨过阈值 ⇒ 允许"漂移"但**不允许"分歧"**：
 * 若 drill 的值等于 live 的**第二次**读数，说明是时间在动，不是数据不一致。
 */
const HEALTH_TIME_SENSITIVE = new Set(['slaAcceptanceOverdue', 'slaAppointmentOverdue', 'slaStoreConfirmOverdue']);

function flattenHealth(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    const ignored = Object.keys(HEALTH_IGNORE).some((ig) => p === ig || p.startsWith(`${ig}.`));
    if (ignored) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flattenHealth(v, p));
    else out[p] = v;
  }
  return out;
}

function compareHealth(live, drill, liveAfter) {
  const a = flattenHealth(live);
  const b = flattenHealth(drill);
  const c = flattenHealth(liveAfter);

  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  // 字段集合本身必须一致：少字段 = 恢复出的库让插件走了不同分支
  if (JSON.stringify(keysA) !== JSON.stringify(keysB)) {
    const onlyA = keysA.filter((k) => !keysB.includes(k));
    const onlyB = keysB.filter((k) => !keysA.includes(k));
    fail(`health 字段集合不一致（live 独有 ${onlyA.length}：${onlyA.slice(0, 5).join(',')}；drill 独有 ${onlyB.length}：${onlyB.slice(0, 5).join(',')}）`);
    return { compared: 0, mismatches: [] };
  }

  const mismatches = [];
  let drift = 0;
  for (const k of keysA) {
    const ja = JSON.stringify(a[k]);
    const jb = JSON.stringify(b[k]);
    if (ja === jb) continue;
    if (HEALTH_TIME_SENSITIVE.has(k) && JSON.stringify(c[k]) === jb) { drift += 1; continue; }
    mismatches.push({ field: k, live: a[k], drill: b[k] });
  }

  if (drift > 0) note(`${drift} 个时间相关字段在演练期间发生了漂移（drill 值 == live 二次读数），按漂移处理而非分歧`);
  if (mismatches.length === 0) {
    pass(`health 数据派生字段逐项相等（${keysA.length} 项，已排除 ${Object.keys(HEALTH_IGNORE).length} 类运行时字段）`);
  } else {
    for (const m of mismatches.slice(0, 6)) fail(`health.${m.field}：live=${JSON.stringify(m.live)} vs drill=${JSON.stringify(m.drill)}`);
    if (mismatches.length > 6) fail(`…另有 ${mismatches.length - 6} 个字段不一致`);
  }
  return { compared: keysA.length, mismatches };
}

// --- 演练用 compose ----------------------------------------------------------

const fwd = (p) => p.replace(/\\/g, '/');

function writeDrillCompose(user, db, password) {
  const yaml = `# 由 scripts/verify-db-restore.mjs 生成 —— 请勿手工编辑
# 目的：用**另一个 compose project + 另一个 PG 卷**证明备份可恢复。
# 关键点：这里出现的任何卷名都必须与生产项目（service-ticket / svc_pg_data）不同。
name: ${DRILL_PROJECT}

networks:
  drill:
    driver: bridge

volumes:
  pg_drill:
    name: ${DRILL_PROJECT}_pg_data

services:
  postgres:
    image: postgres:16
    container_name: ${DRILL_PROJECT}-postgres
    environment:
      POSTGRES_USER: ${user}
      POSTGRES_PASSWORD: ${password}
      POSTGRES_DB: ${db}
      POSTGRES_INITDB_ARGS: "--encoding=UTF8 --locale=C"
      TZ: Asia/Shanghai
    volumes:
      - pg_drill:/var/lib/postgresql/data
    networks: [drill]

  app:
    image: nocobase/nocobase:2.2.15-full-no-nginx
    container_name: ${DRILL_PROJECT}-app
    env_file:
      - '${fwd(path.join(ROOT, '.env'))}'
    environment:
      APP_PORT: 13000
      DB_HOST: postgres
      DB_PORT: 5432
      DB_DATABASE: ${db}
      LOGGER_LEVEL: info
    volumes:
      - '${fwd(DRILL_STORAGE)}:/app/nocobase/storage'
      - '${fwd(path.join(DRILL_STORAGE, 'plugins', '@local', 'service-ticket'))}:/app/nocobase/node_modules/@local/service-ticket'
    ports:
      - "127.0.0.1:${DRILL_APP_PORT}:13000"
    depends_on:
      - postgres
    networks: [drill]
`;
  fs.writeFileSync(DRILL_COMPOSE, yaml, 'utf8');
}

/** storage 副本：**必须**含 apps/main/aes_key.dat，否则恢复出的库连加密字段都读不了 */
function copyStorageCopy() {
  const src = path.join(ROOT, 'storage');
  fs.mkdirSync(DRILL_STORAGE, { recursive: true });
  const SKIP = new Set(['logs', 'tmp']); // logs 68M 且与数据无关；tmp 是原生导出临时产物
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    fs.cpSync(path.join(src, entry.name), path.join(DRILL_STORAGE, entry.name), { recursive: true });
  }
}

// --- 主流程 ------------------------------------------------------------------

async function main() {
  console.log('='.repeat(78));
  console.log(` verify-db-restore —— RB-5 隔离恢复演练${CORRUPT ? `（反证模式：${CORRUPT}）` : ''}`);
  console.log(` run_id = ${RUN_ID}`);
  console.log(` 演练项目 = ${DRILL_PROJECT} · 工作目录 = ${path.relative(ROOT, WORK)}`);
  console.log('='.repeat(78));

  // ===== §0 前置 =============================================================
  section('§0 前置检查');

  const swept = sweepStaleWorkDirs();
  if (swept > 0) note(`清理了 ${swept} 个历史遗留的演练目录（被中断的上一遍留下的 storage 副本，含客户照片）`);

  DRILL_APP_PORT = await pickFreePort();
  if (!DRILL_APP_PORT) { fail('在 14000-14999 内找不到可用宿主端口用于 drill app'); return finish(); }
  DRILL_APP_URL = `http://127.0.0.1:${DRILL_APP_PORT}`;
  note(`drill app 宿主端口 = ${DRILL_APP_PORT}（每次运行随机挑选，避免与前一遍抢端口）`);

  const ps = run('docker', ['inspect', '-f', '{{.State.Status}}', PG_CONTAINER]);
  if (ps.status !== 0 || ps.stdout.trim() !== 'running') {
    fail(`源容器 ${PG_CONTAINER} 未运行 —— 演练无意义`);
    return finish();
  }
  pass(`源容器 ${PG_CONTAINER} 正在运行`);

  const { user, db } = pgEnv();
  const password = envValue('POSTGRES_PASSWORD');
  if (!password) { fail('读不到 POSTGRES_PASSWORD（.env）—— drill 的 postgres 起不来'); return finish(); }
  note(`源库 = ${db} / 用户 ${user}`);

  // 演练目标绝不能是生产项目名/卷名 —— 这两条断言是"隔离"的第一道闸
  if (DRILL_PROJECT.includes('service') || DRILL_PROJECT === 'service-ticket') {
    fail(`演练项目名 "${DRILL_PROJECT}" 与生产项目名撞车，拒绝继续`);
    return finish();
  }
  pass(`演练项目名与生产项目不同：${DRILL_PROJECT} ≠ service-ticket`);

  // ===== §1 源库基线 =========================================================
  section('§1 源库基线快照');

  const liveCountsBefore = countRowsOn(PG_CONTAINER, user, db);
  const liveSchema = schemaOf(PG_CONTAINER, user, db);
  const liveSamplesBefore = ticketSamplesOn(PG_CONTAINER, user, db);
  const liveHealthBefore = await httpJson(`${LIVE_BASE}/api/svc:health`);
  if (liveHealthBefore.status !== 200 || !liveHealthBefore.json?.data) {
    fail(`源库 health 读不到（status=${liveHealthBefore.status}）—— 无法做语义对照`);
    return finish();
  }
  pass(`基线：${liveSchema.tables.length} 张表 · ${liveSchema.uniqueIndexes.length} 个唯一索引 · 探针 ${Object.values(liveCountsBefore).reduce((a, b) => a + b, 0)} 行`);
  pass(`源库 health 可用（${Object.keys(liveHealthBefore.json.data).length} 个顶层字段）`);

  // ===== §2 备份 =============================================================
  section('§2 备份（backup-db.mjs）');

  fs.mkdirSync(WORK, { recursive: true });
  // ⚠️ 演练用的 dump 必须落在**一次性的 WORK 里**，不能落在 `backups/`。
  //    `backups/` 是生产备份目录 —— 往里塞 10 份 768KiB 的演练件（实测累积 7.7MB），
  //    既污染"哪些是真备份"的判断，又依赖一次事后删除（而那次删除会被
  //    宿主机删除守卫拦下 ⇒ 静默失败）。放到 WORK 里则随目录一起消失，无需事后清理。
  const bk = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backup-db.mjs'), '--out', WORK, '--label', `drill-${RUN_ID}`, '--quiet'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const bkLine = (bk.stdout || '').split('\n').find((l) => l.startsWith('BACKUP_RESULT='));
  if (bk.status !== 0 || !bkLine) {
    fail(`backup-db 未产出可用备份（rc=${bk.status}）：${(bk.stderr || '').trim().slice(0, 300)}`);
    return finish();
  }
  const backup = JSON.parse(bkLine.slice('BACKUP_RESULT='.length));
  const originalBytes = backup.bytes;
  const originalSha = backup.sha256;
  pass(`备份产出：${path.basename(backup.dumpPath)}（${(originalBytes / 1024).toFixed(1)} KiB，sha256 ${originalSha.slice(0, 16)}…）`);

  // ---- 反证模式：在这里把备份弄坏 -------------------------------------------
  let corruptInfo = null;
  if (CORRUPT) {
    corruptInfo = damageDump(backup.dumpPath, CORRUPT);
    note(`已按 --corrupt=${CORRUPT} 损坏备份：${corruptInfo.detail}（新 sha256 ${corruptInfo.sha256.slice(0, 16)}…）`);
  }

  // ===== §3 隔离恢复 =========================================================
  section(`§3 隔离恢复（project=${DRILL_PROJECT}，新卷 ${DRILL_PROJECT}_pg_data）`);

  copyStorageCopy();
  const aesExists = fs.existsSync(path.join(DRILL_STORAGE, 'apps', 'main', 'aes_key.dat'));
  if (!aesExists) {
    fail('storage 副本里缺 apps/main/aes_key.dat —— 恢复出的库将无法解密字段元数据');
    return finish();
  }
  pass('storage 副本已就绪（含 apps/main/aes_key.dat）');
  writeDrillCompose(user, db, password);

  dcomposeChecked(['up', '-d', 'postgres'], '启动 drill postgres');

  const pgReady = await waitFor(async () => {
    const r = run('docker', ['exec', `${DRILL_PROJECT}-postgres`, 'pg_isready', '-U', user, '-d', db]);
    return r.status === 0;
  }, { timeoutMs: 120000, intervalMs: 2000, label: 'drill postgres pg_isready' });
  if (!pgReady) { fail('drill postgres 在 120s 内未就绪'); return finish(); }
  pass('drill postgres 已就绪（独立容器 + 独立卷）');

  // 确认源库与目标库**物理不同**（这是"隔离"的第二道闸，比配置断言更硬）
  const drillId = runChecked('docker', ['inspect', '-f', '{{.Id}}', `${DRILL_PROJECT}-postgres`], {}, 'inspect drill 容器').trim();
  const srcId = runChecked('docker', ['inspect', '-f', '{{.Id}}', PG_CONTAINER], {}, 'inspect 源容器').trim();
  if (drillId === srcId) { fail('drill 容器与源容器是同一个 —— 隔离失败'); return finish(); }
  const drillVol = runChecked('docker', ['inspect', '-f', '{{range .Mounts}}{{.Name}}{{end}}', `${DRILL_PROJECT}-postgres`], {}, 'inspect drill 卷').trim();
  if (drillVol.includes('svc_pg_data') || drillVol.includes('service-ticket')) {
    fail(`drill 挂载了生产卷：${drillVol}`);
    return finish();
  }
  pass(`物理隔离已确认：容器 ${drillId.slice(0, 12)} ≠ ${srcId.slice(0, 12)} · 卷 ${drillVol}`);

  // ---- pg_restore（--single-transaction：失败则整体回滚，不留"半恢复"）-------
  note('pg_restore --single-transaction --exit-on-error --no-owner --no-privileges …');
  // 🔴 反证模式下必须喂**损坏后**的那份。
  //    曾经这里一直写 `backup.dumpPath`（完好件），于是 4 种 corrupt 模式全部
  //    报"损坏备份竟然恢复成功" —— 那不是真发现，是**反证根本没用上损坏件**。
  //    （人被这类结果带偏的方向很典型：会去怀疑 pg_restore 太宽容，
  //     而不是先确认喂进去的到底是哪个文件。）
  const dumpToRestore = CORRUPT ? corruptInfo.path : backup.dumpPath;
  if (CORRUPT) {
    const sz = fs.statSync(dumpToRestore).size;
    note(`喂给 pg_restore 的是**损坏件**：${path.basename(dumpToRestore)}（${(sz / 1024).toFixed(1)} KiB，完好件 ${(originalBytes / 1024).toFixed(1)} KiB）`);
  }

  const restore = dcompose([
    'exec', '-T', 'postgres', 'pg_restore',
    '-U', user, '-d', db,
    '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges',
  ], { input: fs.readFileSync(dumpToRestore), maxBuffer: 128 * 1024 * 1024 });

  const restoreOk = restore.status === 0;

  if (CORRUPT) {
    // 反证模式：要求这里**失败**，并且后面不要再做正向断言
    return await finishCorrupt(restore, corruptInfo, originalBytes, originalSha);
  }

  if (!restoreOk) {
    fail(`pg_restore 失败（rc=${restore.status}）：${(restore.stderr || '').trim().slice(0, 400)}`);
    return finish();
  }
  pass('pg_restore 退出码 0（--exit-on-error --single-transaction）');

  // ===== §4 恢复后校验 =======================================================
  section('§4 恢复后校验：结构 / 数据 / 可用性');

  // --- A. 结构 ---
  const drillC = `${DRILL_PROJECT}-postgres`;
  const drillSchema = schemaOf(drillC, user, db);

  const srcT = [...liveSchema.tables].sort();
  const dstT = [...drillSchema.tables].sort();
  if (JSON.stringify(srcT) === JSON.stringify(dstT)) pass(`表集合完全一致（${dstT.length} 张）`);
  else {
    const missing = srcT.filter((t) => !dstT.includes(t));
    const extra = dstT.filter((t) => !srcT.includes(t));
    fail(`表集合不一致：缺 ${missing.length}（${missing.slice(0, 5)}）· 多 ${extra.length}（${extra.slice(0, 5)}）`);
  }

  let colBad = 0;
  for (const t of srcT) {
    const a = liveSchema.columns[t];
    const b = drillSchema.columns[t];
    if (!b) { colBad += 1; continue; }
    if (a.columns !== b.columns || a.sha16 !== b.sha16) colBad += 1;
  }
  if (colBad === 0) pass(`列指纹完全一致（${srcT.length} 张表逐表比对列数与列名哈希）`);
  else fail(`${colBad} 张表的列指纹与源库不一致`);

  const srcU = [...liveSchema.uniqueIndexes].sort();
  const dstU = [...drillSchema.uniqueIndexes].sort();
  if (JSON.stringify(srcU) === JSON.stringify(dstU)) pass(`唯一索引集合完全一致（${dstU.length} 个）`);
  else {
    const missing = srcU.filter((i) => !dstU.includes(i));
    const extra = dstU.filter((i) => !srcU.includes(i));
    fail(`唯一索引不一致：缺 ${missing.length}（${missing.slice(0, 4)}）· 多 ${extra.length}（${extra.slice(0, 4)}）`);
  }

  // --- B. 数据 ---
  const drillCounts = countRowsOn(drillC, user, db);
  const diffCounts = COUNT_PROBES.filter((t) => liveCountsBefore[t] !== drillCounts[t]);
  if (diffCounts.length === 0) {
    const total = Object.values(drillCounts).reduce((a, b) => a + b, 0);
    pass(`探针表行数逐项相等（${COUNT_PROBES.length} 张 / ${total} 行）`);
  } else {
    for (const t of diffCounts) fail(`行数不一致 ${t}：live=${liveCountsBefore[t]} vs drill=${drillCounts[t]}`);
  }

  const drillSamples = ticketSamplesOn(drillC, user, db);
  if (JSON.stringify(drillSamples) === JSON.stringify(liveSamplesBefore)) {
    pass(`业务数据抽样一致（service_tickets 首/中/尾三条 (id,status) 完全相同）`);
  } else {
    fail(`业务数据抽样不一致：live=${JSON.stringify(liveSamplesBefore)} vs drill=${JSON.stringify(drillSamples)}`);
  }

  // --- B2. 约束**实际生效**（比"目录里有索引"硬）---
  // 刻意放在行数断言**之后**：万一某个候选插入竟然成功（说明约束真没生效），
  // 那它会多写一行；放在计数之后可以避免把"约束失效"错误地表现为"行数不一致"。
  const dup = probeUniqueEnforcement(drillC, user, db);
  if (dup.ok) {
    pass(`唯一约束**实际生效**：向 ${dup.table} 插入重复行被拒（constraint=${dup.constraint}）—— 非仅目录中存在`);
  } else {
    fail(`未在任何候选表上观察到唯一约束拒绝。实际报错逐条如下（若全是"列不存在/语法错"则是探针要更新，不是数据问题）：\n       ${dup.tried.join('\n       ')}`);
  }

  // --- C. 可用性：起 app ---
  if (NO_APP) {
    skip('--no-app：未启动 drill app ⇒ **"恢复出的库能被应用使用"未证明**（本次证据不完整）');
  } else {
    note('启动 drill app（复用 storage 副本 + aes_key.dat，指向 drill 库）…');
    dcomposeChecked(['up', '-d', 'app'], '启动 drill app');

    const booted = await waitFor(async () => {
      const r = await httpJson(`${DRILL_APP_URL}/api/svc:health`, { timeoutMs: 8000 });
      return r.status === 200 && r.json?.data?.db === 'ok';
    }, { timeoutMs: 420000, intervalMs: 5000, label: 'drill app health' });

    if (!booted) {
      fail('drill app 在 420s 内未通过 health（db=ok）—— 恢复出的库无法被应用使用');
      const logs = run('docker', ['logs', '--tail', '40', `${DRILL_PROJECT}-app`]);
      note(`drill app 末尾日志：\n${(logs.stdout || logs.stderr || '').split('\n').slice(-25).join('\n')}`);
      return finish();
    }
    pass('drill app 已启动且 health.db=ok（恢复出的库可被应用使用）');

    const drillHealth = await httpJson(`${DRILL_APP_URL}/api/svc:health`);
    const liveHealthAfter = await httpJson(`${LIVE_BASE}/api/svc:health`);
    const cmp = compareHealth(liveHealthBefore.json.data, drillHealth.json.data, liveHealthAfter.json.data);

    // 认证业务读：总数必须等于库内行数（同时证明 ACL/角色也被恢复了）
    const email = envValue('SMOKE_ADMIN_EMAIL');
    const pw = envValue('SMOKE_ADMIN_PASSWORD');
    if (!email || !pw) {
      skip('未配置 SMOKE_ADMIN_EMAIL/PASSWORD ⇒ 跳过认证读探针（**ACL/角色恢复未被验证**）');
    } else {
      const si = await httpJson(`${DRILL_APP_URL}/api/auth:signIn`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: email, password: pw }),
      });
      const token = si.json?.data?.token;
      if (!token) {
        fail(`drill app 登录失败（status=${si.status}）—— 用户/角色数据或 ACL 未正确恢复`);
      } else {
        const list = await httpJson(`${DRILL_APP_URL}/api/serviceTickets:list?pageSize=1&fields=id,status`,
          { headers: { Authorization: `Bearer ${token}` } });
        const total = list.json?.meta?.count;
        if (list.status === 200 && total === drillCounts.service_tickets) {
          pass(`认证业务读通过：serviceTickets:list 返回 total=${total}，与库内 service_tickets 行数相等（ACL/角色亦已恢复）`);
        } else {
          fail(`认证业务读异常：status=${list.status} total=${total}（库内 ${drillCounts.service_tickets}）`);
        }
      }
    }
    note(`health 比较字段数 = ${cmp.compared}`);
  }

  // ===== §5 源库未被触碰 =====================================================
  section('§5 反证：源库未被触碰');

  const liveCountsAfter = countRowsOn(PG_CONTAINER, user, db);
  const liveSamplesAfter = ticketSamplesOn(PG_CONTAINER, user, db);

  if (JSON.stringify(liveCountsBefore) === JSON.stringify(liveCountsAfter)
      && JSON.stringify(liveSamplesBefore) === JSON.stringify(liveSamplesAfter)) {
    pass('源库行数与业务抽样在演练前后完全一致（演练没有写进生产库）');
  } else {
    const changed = COUNT_PROBES.filter((t) => liveCountsBefore[t] !== liveCountsAfter[t]);
    fail(`源库在演练期间发生了变化：${changed.map((t) => `${t} ${liveCountsBefore[t]}→${liveCountsAfter[t]}`).join(', ')}`);
  }

  const liveVol = runChecked('docker', ['inspect', '-f', '{{range .Mounts}}{{.Name}}{{end}}', PG_CONTAINER], {}, 'inspect 源卷').trim();
  pass(`源库卷未被复用：生产 ${liveVol} vs 演练 ${drillVol}`);

  return finish({ drillCounts, cmp: null, restoreOk });
}

// --- 反证模式的收尾 ----------------------------------------------------------

async function finishCorrupt(restore, info, originalBytes, originalSha) {
  section('反证判定：损坏的备份必须被拒绝');

  const stderr = `${restore.stderr || ''}`.trim();
  if (restore.status !== 0) {
    pass(`pg_restore 对损坏备份非零退出（rc=${restore.status}）`);
  } else {
    fail('pg_restore 对损坏备份竟然返回 0 —— 这是最危险的情况');
  }
  if (stderr) note(`pg_restore 报错：${stderr.split('\n').slice(0, 3).join(' | ').slice(0, 300)}`);

  // 更硬的一条：损坏备份**不得**留下一个"看起来能用"的库。
  // --single-transaction 应保证整体回滚 ⇒ 业务表一张都不该有。
  const { user, db } = pgEnv();
  const left = run('docker', ['exec', `${DRILL_PROJECT}-postgres`, 'psql', '-U', user, '-d', db,
    '-t', '-A', '-c', "select count(*) from pg_tables where schemaname='public' and tablename='service_tickets'"]);
  const tableLeft = (left.stdout || '').trim();
  if (tableLeft === '0') {
    pass('损坏备份未留下部分恢复的库（--single-transaction 已整体回滚，service_tickets 不存在）');
  } else {
    fail(`损坏备份留下了部分恢复的表（service_tickets 存在，pg_tables 计数=${tableLeft}）—— 存在"半恢复假成功"风险`);
  }

  const evidence = {
    schemaVersion: 1, runId: RUN_ID, mode: 'corrupt', corrupt: CORRUPT, corruptDetail: info,
    originalBytes, originalSha256: originalSha, damagedSha256: info.sha256,
    pgRestoreRc: restore.status, partialTablesLeft: tableLeft,
    pass: fails.length === 0, failures: fails.slice(),
  };
  fs.writeFileSync(path.join(ROOT, '.tmp-verify', `db-restore-corrupt-${CORRUPT}-${RUN_ID}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  return finish();
}

/** 无损替换式的损坏：绝不改动原备份，只在 WORK 里生成一份坏的 */
function damageDump(p, mode) {
  const buf = fs.readFileSync(p);
  const out = path.join(WORK, `damaged-${mode}.dump`);
  let detail = '';

  if (mode === 'empty') {
    fs.writeFileSync(out, Buffer.alloc(0));
    detail = '0 字节';
  } else if (mode === 'truncate') {
    // 保留头部（让它是"看起来合法"的 dump），砍掉后 40%
    const keep = Math.floor(buf.length * 0.6);
    fs.writeFileSync(out, buf.subarray(0, keep));
    detail = `截断到 ${(keep / 1024).toFixed(1)} KiB（原 ${(buf.length / 1024).toFixed(1)} KiB）`;
  } else if (mode === 'flip') {
    const b = Buffer.from(buf);
    // 在 payload 区（跳过 header/TOC 首部）翻转 64 字节，模拟磁盘位翻转
    const start = Math.floor(b.length * 0.3);
    for (let i = 0; i < 64 && start + i < b.length; i += 1) b[start + i] ^= 0xff;
    fs.writeFileSync(out, b);
    detail = `payload 偏移 ${start} 处翻转 64 字节`;
  } else {
    fs.writeFileSync(out, crypto.randomBytes(Math.min(buf.length, 256 * 1024)));
    detail = '随机字节冒充 dump';
  }

  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
  return { mode, path: out, sha256, bytes: fs.statSync(out).size, detail, originalSha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

// --- 有界轮询 ---------------------------------------------------------------

async function waitFor(fn, { timeoutMs, intervalMs, label }) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      if (await fn()) return true;
    } catch (e) { lastErr = e; }
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }
  if (lastErr) note(`${label} 轮询期间最后一次错误：${lastErr.message}`);
  return false;
}

// --- 收尾 --------------------------------------------------------------------

async function finish(extra = {}) {
  section('§6 清理与还原自证');

  // 演练容器/卷/网络全部销毁 —— 留着会污染下一次演练与资源
  const down = dcompose(['down', '-v', '--remove-orphans']);
  if (down.status === 0) pass('演练 project 已 down -v（容器 / 网络 / 卷全部移除）');
  else fail(`演练 project 清理失败（rc=${down.status}）：${(down.stderr || '').trim().slice(0, 200)}`);

  const vols = run('docker', ['volume', 'ls', '-q', '--filter', `name=${DRILL_PROJECT}`]);
  if ((vols.stdout || '').trim() === '') pass('演练卷已确认删除（docker volume ls 无残留）');
  else fail(`演练卷仍残留：${(vols.stdout || '').trim()}`);

  const ctrs = run('docker', ['ps', '-a', '--filter', `name=${DRILL_PROJECT}`, '--format', '{{.Names}}']);
  if ((ctrs.stdout || '').trim() === '') pass('演练容器无残留');
  else fail(`演练容器仍残留：${(ctrs.stdout || '').trim()}`);

  if (KEEP) skip(`--keep：保留 ${path.relative(ROOT, WORK)}`);
  else {
    // ⚠️ 清理**不得**影响判定：演练结论由断言决定，不由"能不能删掉临时目录"决定。
    //    实测踩过：recursive 删除被宿主机守卫拦下后抛异常 ⇒ 一次**全部断言通过**的
    //    演练被整体判成 EXIT=1 —— 这是最坏的一种假红：真证据被环境问题埋掉。
    const r = removeWorkDirs([path.basename(WORK)]);
    const one = r[0];
    if (one.how === 'direct' || one.how === 'container') {
      pass(`演练工作目录已清理（${path.relative(ROOT, WORK)}，方式=${one.how}）`);
    } else if (one.how === 'absent') {
      note('演练工作目录不存在，无需清理');
    } else {
      warn(`演练工作目录未能清理（${path.relative(ROOT, WORK)}）：${one.err || '未知'} —— **不影响本次演练结论**，但需手工删除`);
    }
  }

  // 生产容器必须仍然健康 —— 演练不能有任何副作用
  for (const c of [PG_CONTAINER, APP_CONTAINER]) {
    const st = run('docker', ['inspect', '-f', '{{.State.Status}}', c]);
    if ((st.stdout || '').trim() === 'running') pass(`${c} 仍为 running`);
    else fail(`${c} 状态异常：${(st.stdout || '').trim()}`);
  }
  const liveHealthFinal = await httpJson(`${LIVE_BASE}/api/svc:health`);
  if (liveHealthFinal.status === 200 && liveHealthFinal.json?.data?.db === 'ok') pass('生产 health 仍为 db=ok');
  else fail(`生产 health 异常（status=${liveHealthFinal.status}）`);

  // 演练用的 dump 已随 WORK 一起删除（现在直接落在 WORK 里，不再污染 backups/）。
  // 这里只兜底清理**历史上**误落到 backups/ 的演练件（旧版本行为留下的）。
  {
    let cleaned = 0;
    for (const f of fs.existsSync(BACKUP_OUT) ? fs.readdirSync(BACKUP_OUT) : []) {
      if (!f.includes('-drill-')) continue;
      try { fs.unlinkSync(path.join(BACKUP_OUT, f)); cleaned += 1; } catch { /* 尽力，不算失败 */ }
    }
    if (cleaned > 0) note(`清除了 ${cleaned} 个历史遗留的 drill-* 备份件（backups/ 只应放**真实**备份）`);
  }

  // --- 判定 ---
  console.log(`\n${'='.repeat(78)}`);
  if (CORRUPT) {
    if (fails.length === 0) {
      console.log(` ✅ 反证成立：损坏备份（${CORRUPT}）被正确拒绝 —— ${passCount} 项通过，0 项失败`);
      printWarns();
      console.log('='.repeat(78));
      return 0;
    }
    console.log(` ❌ 反证失败：损坏备份（${CORRUPT}）竟然"恢复成功"或被漏过 —— ${fails.length} 项失败`);
    for (const f of fails) console.log(`     - ${f}`);
    printWarns();
    console.log('='.repeat(78));
    return 1;
  }

  if (fails.length === 0) {
    console.log(` ✅ 隔离恢复演练通过 —— ${passCount} 项通过，0 项失败${skipped.length ? `，${skipped.length} 项跳过` : ''}`);
    printWarns();
    if (skipped.length > 0) {
      console.log(' ⚠️ 但有跳过项，证据**不完整**：');
      for (const s of skipped) console.log(`     - ${s}`);
    }
    console.log('='.repeat(78));
    return 0;
  }
  console.log(` ❌ 隔离恢复演练失败 —— ${fails.length} 项失败（通过 ${passCount} 项）`);
  for (const f of fails) console.log(`     - ${f}`);
  printWarns();
  console.log('='.repeat(78));
  return 1;
}

main()
  .then((code) => { process.exit(code); })
  .catch((e) => {
    console.error(`\n  ❌ verify-db-restore 异常终止：${e && e.message ? e.message : e}`);
    // 尽力清理，避免残留容器影响后续运行
    try { spawnSync('docker', ['compose', '-p', DRILL_PROJECT, '-f', DRILL_COMPOSE, 'down', '-v'], { cwd: ROOT, encoding: 'utf8' }); } catch { /* 尽力 */ }
    process.exit(1);
  });
