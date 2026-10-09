#!/usr/bin/env node
/**
 * probe-native-read-deps.mjs —— 原生读取依赖清单 / 一级 ACL 边界探针（Phase 11 / P11-0）
 *
 * ===========================================================================
 * 它解决什么问题
 * ===========================================================================
 * B-8：业务角色能原生读取 NocoBase 核心集合（`users` 含 email/phone、`roles`、`collections`）。
 * 根因是 ACL 的两级判定 —— ② 资源级无条目时**不是 deny**，而是回退 ① 策略，
 * 而 ① 的资源门 `strategyResources` 为 `null` 时**对任何资源都成立**。
 *
 * ⇒ 收紧手段是 `acl.setStrategyResources(<最小白名单>)`：把 ① 变成
 *   "**未知资源默认拒绝**"的一级边界。
 *
 * ⚠️ 但收紧**之前**必须知道"后台到底依赖哪些原生读取" —— 因为当前"任何资源都放行"，
 *    这些依赖是**不可见的**：它只在收紧后以 403 的形式暴露，而那时已经打断了后台。
 *    ⇒ 本脚本就是那份清单的取证装置（改前基线 + 改后拒绝证明，同一支脚本、同一套判据）。
 *
 * ===========================================================================
 * 两个模式（同一判据，两种用途）
 * ===========================================================================
 *   --baseline   改前：记录每个资源当前的 200/403（预期核心集合全 200 = B-8 现场）
 *   --assert     改后：断言**必须拒绝**的集合确实拒绝、**必须允许**的集合仍正常
 *
 * ===========================================================================
 * 用真实账号、走真实 HTTP
 * ===========================================================================
 * 以 UAT 门店账号（仅授权 S01）登录，拿真 token 再打原生 collection API ——
 * 与"门店员工在浏览器里"是同一条判定链路，不构造特权旁路。
 *
 * 用法：
 *   node scripts/probe-native-read-deps.mjs --baseline
 *   node scripts/probe-native-read-deps.mjs --assert
 * 退出码：0 通过 / 1 判据不满足 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SVC_BASE_URL } from './lib/base-url.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MODE = process.argv.includes('--assert') ? 'assert' : 'baseline';

function envValue(key, fallback = '') {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* 落到 process.env */
  }
  return process.env[key] ?? fallback;
}

const STORE_EMAIL = envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local');
const STORE_PASSWORD = envValue('UAT_STORE_A_PASSWORD');
const ADMIN_EMAIL = envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com');
const ADMIN_PASSWORD = envValue('SMOKE_ADMIN_PASSWORD');

/**
 * 候选资源清单。
 *
 * 🔴 分三组，**判据方向不同** —— 这是本脚本的核心，不是"列一堆资源打一打"：
 *   MUST_DENY   ：平台/主数据，业务角色**必须**拒绝（B-8 的关闭对象）
 *   MUST_ALLOW  ：业务自有数据，业务角色**必须**能读（否则后台列表/详情直接废掉）
 *   NEVER_EXIST ：不存在的资源，用来验证"拒绝"不是因为拼错了名字（**防假绿**）
 */
const MUST_DENY = [
  { resource: 'users', why: '含 email/phone/nickname —— B-8 的首要对象' },
  { resource: 'roles', why: '含全部角色与 strategy —— B-8 对象' },
  { resource: 'collections', why: '全部集合定义（含未暴露的业务结构）—— B-8 对象' },
  { resource: 'storages', why: '存储配置（对照：改前本就 403，用于证明探针有效）' },
  { resource: 'attachments', why: '全局附件表（可能含他人文件元数据）' },
];

const MUST_ALLOW = [
  { resource: 'serviceTickets', why: '服务单列表/详情（后台主界面）' },
  { resource: 'serviceVisits', why: '上门记录（服务详情内）' },
  { resource: 'ticketEvents', why: '处理记录时间线' },
  { resource: 'smsLogs', why: '通知记录' },
];

const NEVER_EXIST = [
  { resource: 'definitelyNotARealCollectionXyz', why: '名字不存在 ⇒ 必须拒绝，用于防"探针恒绿"' },
];

const ALL = [...MUST_DENY, ...MUST_ALLOW, ...NEVER_EXIST];

let failures = [];
let passed = 0;
const ok = (m) => { passed += 1; console.log(`  ✅ ${m}`); };
const no = (m) => { failures.push(m); console.log(`  ❌ ${m}`); };
const info = (m) => console.log(`  ·  ${m}`);

async function login(email, password) {
  const r = await fetch(`${SVC_BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(SVC_BASE_URL).origin },
    body: JSON.stringify({ email, password }),
  });
  const text = await r.text();
  if (r.status !== 200) {
    return { ok: false, status: r.status, body: text.slice(0, 200) };
  }
  const j = JSON.parse(text);
  return { ok: true, token: j?.data?.token };
}

/** 原生 collection 读取：GET /api/<resource>:list?pageSize=1 */
async function probe(token, resource) {
  const url = `${SVC_BASE_URL}/api/${resource}:list?pageSize=1`;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const text = await r.text();
    let columns = null;
    if (r.status === 200) {
      try {
        const j = JSON.parse(text);
        const row = j?.data?.[0];
        columns = row ? Object.keys(row) : [];
      } catch { /* 非 JSON */ }
    }
    return { status: r.status, columns, size: text.length };
  } catch (err) {
    return { status: 0, error: String(err?.message ?? err) };
  }
}

// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  原生读取依赖探针（Phase 11 / P11-0）· 模式 = ${MODE}`);
console.log('══════════════════════════════════════════════════════════════');
console.log(`  · 入口：${SVC_BASE_URL}`);
console.log(`  · 门店账号：${STORE_EMAIL}`);

if (!STORE_PASSWORD) {
  console.log('');
  console.log('  ⛔ .env 缺 UAT_STORE_A_PASSWORD —— 环境未就绪（先跑 scripts/uat-accounts.mjs 建号）');
  console.log('');
  process.exit(2);
}

const storeLogin = await login(STORE_EMAIL, STORE_PASSWORD);
if (!storeLogin.ok) {
  console.log('');
  console.log(`  ⛔ 门店账号登录失败（HTTP ${storeLogin.status}）—— 环境未就绪。`);
  console.log(`     ${storeLogin.body}`);
  console.log('     若账号已过期，先跑 scripts/uat-accounts.mjs 重建。');
  console.log('');
  process.exit(2);
}
ok(`门店账号登录成功（${STORE_EMAIL}）· 这个账号只授权 S01`);

console.log('');
console.log(`【1】逐资源探测（${MODE === 'baseline' ? '记录改前基线' : '断言一级边界'}）`);
console.log('');

const rows = [];
for (const item of ALL) {
  const r = await probe(storeLogin.token, item.resource);
  rows.push({ ...item, ...r });

  // 同样按名字判定分组（不要用 includes(item)）
  const group = MUST_DENY.some((x) => x.resource === item.resource)
    ? '必须拒绝'
    : MUST_ALLOW.some((x) => x.resource === item.resource)
      ? '必须允许'
      : '必须拒绝(不存在)';
  const label = `${item.resource.padEnd(32)} ${String(r.status).padEnd(4)} ${group}`;

  if (MODE === 'baseline') {
    info(`${label}  ${item.why}`);
  } else {
    const wantDeny = group !== '必须允许';
    const denied = r.status === 403 || r.status === 401 || r.status === 404;
    if (wantDeny && denied) ok(`${label}  ← ${item.why}`);
    else if (!wantDeny && r.status === 200) ok(`${label}  ← ${item.why}`);
    else no(`${label}  ← ${item.why}（期望 ${wantDeny ? '403/401/404' : '200'}，实际 ${r.status}）`);
  }
}

// ---------------------------------------------------------------------------
if (MODE === 'baseline') {
  console.log('');
  console.log('【2】基线结论');
  console.log('');
  // ⚠️ 必须按 **资源名**比较，不能拿行对象去 includes(item)：
  //    行是 {...item, ...r} 新建的对象，includes 永远为 false ⇒
  //    汇总会输出"核心集合仍可读 0 个"，与上面逐行的 200 **自相矛盾**。
  //    第一版就是这么写的：逐行正确、汇总假绿 —— 而只看汇总的人会得出"B-8 不存在"。
  //    ⇒ 聚合与逐行必须用同一套判据（这里统一按 resource 名）。
  const deniedNames = new Set(MUST_DENY.map((x) => x.resource));
  const allowNames = new Set(MUST_ALLOW.map((x) => x.resource));
  const leaked = rows.filter((r) => deniedNames.has(r.resource) && r.status === 200);
  info(`核心集合仍可读（= B-8 现场）：${leaked.length} 个 —— ${leaked.map((r) => r.resource).join(', ') || '（无）'}`);
  const usersRow = rows.find((r) => r.resource === 'users');
  if (usersRow && usersRow.status === 200 && usersRow.columns) {
    const sensitive = usersRow.columns.filter((c) => /email|phone|password|nickname/i.test(c));
    info(`users:list 返回列（前若干）：${usersRow.columns.slice(0, 12).join(', ')}`);
    if (sensitive.length) {
      info(`⚠️ 其中敏感列：${sensitive.join(', ')} —— 这正是 B-8 要关闭的暴露面`);
    }
  }
  const allowOk = rows.filter((r) => allowNames.has(r.resource) && r.status === 200).length;
  info(`业务自有集合可读（改后必须保持）：${allowOk}/${MUST_ALLOW.length}`);

  // 基线模式不判红：它只负责记录事实。但"探针自身有效性"必须成立。
  console.log('');
  const storages = rows.find((r) => r.resource === 'storages');
  const bogus = rows.find((r) => r.resource === 'definitelyNotARealCollectionXyz');
  if (storages && storages.status === 200) {
    no('对照资源 storages 竟然 200 —— 说明策略层确实"任何资源都放行"，B-8 比预期更宽');
  } else {
    ok(`对照资源 storages 被拒（${storages?.status}）—— 说明 ACL 确实在判定，探针有效（防"探针恒绿"）`);
  }
  if (bogus && bogus.status === 200) {
    no('不存在的资源竟然 200 —— 探针或 ACL 有问题，基线不可信');
  } else {
    ok(`不存在的资源被拒（${bogus?.status}）—— 排除"随便什么名字都能读"`);
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  基线已记录（通过 ${passed} / 失败 ${failures.length}）`);
  console.log('  ⚠️ 这只是**改前事实**；改后用 --assert 跑同一套判据，方向相反。');
  console.log('');
  // 🔴 污染声明（实测，不是顾虑）：本探针**故意**对 storages / 不存在的资源发请求，
  //    拿到的 403/404 会被 NocoBase 的 error-handler 记成 **error 级**日志。
  //    实测增量：跑一次本探针 = app 日志 +2 条 error。
  //    ⇒ 而 `smoke-test.mjs` 的「无 error 级别输出」断言窗口是
  //      「最近一次健康检查由失败转成功之后」（约 2.5 分钟）—— 会被这两条打红。
  //
  //    ⚠️ 处理方式是**消除噪声源（重启）**，不是给 smoke 加豁免：
  //      契约 §0.2 明令"不允许为了全绿扩大豁免名单"。而这两条 error 本身
  //      是"我们故意触发拒绝"的产物，不该进任何判据。
  //    ⇒ 顺序：跑本探针 → `docker compose restart app` → 再跑 smoke。
  console.log('  ⚠️ 本探针会在 app 日志留下 error 级记录（故意触发的 403/404）。');
  console.log('     再跑 smoke 之前请先：docker compose restart app');
  console.log('     （smoke 的错误窗口是"最近一次就绪之后"，重启即可把它移出窗口；');
  console.log('      不给 smoke 加豁免 —— 契约 §0.2 禁止扩大豁免名单）');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(failures.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
console.log('');
console.log('【2】附加：root/admin 平台维护能力不受影响（契约 §16.1 明令）');
console.log('');
if (!ADMIN_PASSWORD) {
  no('.env 缺 SMOKE_ADMIN_PASSWORD —— 无法证明 root/admin 未被误伤');
} else {
  const adminLogin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!adminLogin.ok) {
    no(`管理员登录失败（HTTP ${adminLogin.status}）—— 无法证明平台维护能力未被 ACL 误伤`);
  } else {
    ok('管理员登录成功');
    for (const res of ['users', 'roles', 'collections']) {
      const r = await probe(adminLogin.token, res);
      if (r.status === 200) ok(`admin 仍可读 ${res}:list（平台维护不受影响）`);
      else no(`admin 读 ${res}:list 被拒（${r.status}）—— 误伤了平台维护能力`);
    }
  }
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
if (failures.length === 0) {
  console.log(`  ✅ 一级 ACL 边界断言全部通过：${passed} 项`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(0);
}
console.log(`  ❌ 失败 ${failures.length} 项 / 通过 ${passed} 项`);
for (const f of failures) console.log(`     - ${f}`);
console.log('══════════════════════════════════════════════════════════════');
console.log('');
process.exit(1);
