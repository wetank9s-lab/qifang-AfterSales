#!/usr/bin/env node
/**
 * verify-ux-01c-settings-auth.mjs —— 「服务时效」原生只读的**授权与行级边界**门禁（UX-01C 第五轮）
 *
 * ===========================================================================
 * 它验证什么（不是"页面能打开"，而是"边界是否真的存在"）
 * ===========================================================================
 * 方案 A 给 `hq_admin` 放开了 `serviceSettings` 的原生只读授权。**只读不等于能读整表**：
 * 该表还有 `sms.*` / `security.*` / `privacy.*` / `historical.*` 等运行参数。
 * 因此本门禁必须同时证明三件事，缺任何一件都算没验：
 *   ① **能读**：hq_admin 读到本页 3 个 SLA 键（否则页面是空白，"权限已配好"是假象）；
 *   ② **只读到这些**：用**对抗性 filter**（`$eq`/`$ne`/`$in`）尝试把范围条件挤掉 ——
 *      若实现用的是"覆盖 filter"，第一条就会把 sms.provider 捞出来；
 *   ③ **写不进去**：原生 `create/update/destroy` 一律 403，且**值/行数/审计条数都不变**
 *      ——只看 HTTP 码不看库，会漏掉"403 但已经改了一半"的实现。
 * 另外验证其余三个业务角色仍被拒（不能因为"多放开一张表"把门店账号一起放开）。
 *
 * ===========================================================================
 * 为什么判据写在**接口 + 库**上，而不是浏览器
 * ===========================================================================
 * 前端的 `defaultFilter` 是展示口径，绕过它只需要一条 curl。真正的边界只能在服务端证明。
 * 浏览器只负责"页面确实渲染出来"（由 verify-ux-01c-settings-ui.mjs 负责）。
 *
 * 用法：node scripts/verify-ux-01c-settings-auth.mjs
 * 退出码：0 通过 / 1 判据不满足 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

const SCHEME = envValue('SVC_BASE_SCHEME', 'https');
const PORT = Number(envValue(SCHEME === 'https' ? 'NGINX_HTTPS_PORT' : 'NGINX_HTTP_PORT', SCHEME === 'https' ? '443' : '8080'));
const BASE = `${SCHEME}://localhost:${PORT}`;
// ⚠️ 必须规范化：`new URL().origin` 会去掉默认端口 443，直传带 :443 的串会 403 Invalid sign-in origin
const ORIGIN = new URL(BASE).origin;

const EXPECTED_KEYS = [
  'sla.accept_minutes',
  'sla.appointment_overdue_grace_minutes',
  'sla.store_confirm_hours',
];
/** 不在本页、且**必须读不到**的代表性键（拿真实主键去打 get） */
const FORBIDDEN_KEYS = ['sms.provider', 'security.ip_minute_limit'];

const ACCOUNTS = [
  { role: 'hq_admin', email: envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), env: 'UAT_HQADMIN_PASSWORD' },
  { role: 'hq_after_sales', email: envValue('UAT_HQ_EMAIL', 'uat.hq@svc.local'), env: 'UAT_HQ_PASSWORD' },
  { role: 'store_after_sales', email: envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'), env: 'UAT_STORE_A_PASSWORD' },
  { role: 'viewer', email: envValue('UAT_VIEWER_EMAIL', 'uat.viewer@svc.local'), env: 'UAT_VIEWER_PASSWORD' },
];

const results = [];
function check(pass, label, detail = '') {
  results.push({ pass, label, detail });
  const mark = pass ? '✅' : '❌';
  console.log(`  ${mark} ${label}${detail ? `\n       ${detail}` : ''}`);
}
function note(label, detail = '') {
  console.log(`  ·  ${label}${detail ? `：${detail}` : ''}`);
}

async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  const text = await r.text();
  if (r.status !== 200) return { ok: false, status: r.status, body: text.slice(0, 200) };
  return { ok: true, token: JSON.parse(text)?.data?.token };
}

async function get(token, p) {
  const r = await fetch(`${BASE}/api/${p}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, json, text };
}

async function write(token, p, body) {
  const r = await fetch(`${BASE}/api/${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  return { status: r.status, text: text.slice(0, 240) };
}

/** 直接读库（值 / 行数 / 审计条数）——判"403 之后库里到底变没变"只能看库 */
function sql(query) {
  const user = envValue('DB_USER');
  const db = envValue('DB_NAME', envValue('POSTGRES_DB', 'service_ticket'));
  const out = execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', user, '-d', db, '-t', '-A', '-F', '|', '-c', query],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return String(out).trim();
}

// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  UX-01C：「服务时效」原生只读的授权与行级边界');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  · 入口：${BASE}`);

// ---- 环境自检 -------------------------------------------------------------
const creds = [];
for (const a of ACCOUNTS) {
  const pwd = envValue(a.env);
  if (!pwd) {
    console.log(`  ⛔ .env 缺 ${a.env} —— 环境未就绪（先跑 scripts/uat-accounts.mjs）`);
    process.exit(2);
  }
  creds.push({ ...a, password: pwd });
}

const keyIds = {};
try {
  const rows = sql(`select id,key from service_settings where key in (${[...EXPECTED_KEYS, ...FORBIDDEN_KEYS].map((k) => `'${k}'`).join(',')})`);
  for (const line of rows.split('\n').filter(Boolean)) {
    const [id, key] = line.split('|');
    keyIds[key] = Number(id);
  }
} catch (error) {
  console.log(`  ⛔ 读库失败：${String(error?.message ?? error).slice(0, 200)}`);
  process.exit(2);
}
if (EXPECTED_KEYS.some((k) => !keyIds[k]) || FORBIDDEN_KEYS.some((k) => !keyIds[k])) {
  console.log(`  ⛔ 库里缺少目标配置键（${JSON.stringify(keyIds)}）—— 环境未就绪`);
  process.exit(2);
}
note('目标键主键', Object.entries(keyIds).map(([k, v]) => `${k}=${v}`).join(' / '));

// ---- 登录 -----------------------------------------------------------------
const tokens = {};
for (const c of creds) {
  const li = await login(c.email, c.password);
  if (!li.ok) {
    console.log(`  ⛔ ${c.role} 登录失败 HTTP ${li.status} ${li.body} —— 环境未就绪`);
    process.exit(2);
  }
  tokens[c.role] = li.token;
}
note('四个业务角色均已登录');

const hq = tokens.hq_admin;

// ---- ① 能读：只能读到 3 个 SLA 键 ----------------------------------------
console.log('');
console.log('  ① hq_admin 原生只读：能读，且**只**读本页键');
{
  const r = await get(hq, 'serviceSettings:list?pageSize=50&sort=key');
  const rows = r.json?.data ?? [];
  const keys = rows.map((x) => x.key).sort();
  check(r.status === 200, 'hq_admin list 返回 200', `HTTP ${r.status}`);
  check(
    keys.length === EXPECTED_KEYS.length && EXPECTED_KEYS.every((k) => keys.includes(k)),
    `只返回 ${EXPECTED_KEYS.length} 个 SLA 键`,
    `实际 ${keys.length} 行：${keys.join(', ') || '(空)'}`,
  );
  const leaked = keys.filter((k) => !EXPECTED_KEYS.includes(k));
  check(leaked.length === 0, '未下发任何非本页配置键', leaked.length ? `泄露：${leaked.join(', ')}` : '');
  check(Number(r.json?.meta?.count) === EXPECTED_KEYS.length, 'meta.count 与被收窄后的行数一致', `count=${r.json?.meta?.count}`);
}

// ---- ② 对抗性 filter：不能把范围条件挤掉 ---------------------------------
console.log('');
console.log('  ② 对抗性 filter：$eq / $ne / $in 都不能突破行级收窄');
{
  const cases = [
    { name: '$eq 直指 sms.provider', q: `filter=${encodeURIComponent(JSON.stringify({ key: { $eq: 'sms.provider' } }))}`, expect: 0 },
    { name: '$in 直指 security.*', q: `filter=${encodeURIComponent(JSON.stringify({ key: { $in: ['security.ip_minute_limit'] } }))}`, expect: 0 },
    { name: '$ne 取反（想拿"其余全部"）', q: `filter=${encodeURIComponent(JSON.stringify({ key: { $ne: 'sla.accept_minutes' } }))}`, expect: 2 },
    { name: '$and 嵌套绕过尝试', q: `filter=${encodeURIComponent(JSON.stringify({ $and: [{ key: { $ne: 'nope' } }] }))}`, expect: 3 },
  ];
  for (const c of cases) {
    const r = await get(hq, `serviceSettings:list?pageSize=50&${c.q}`);
    const rows = r.json?.data ?? [];
    const keys = rows.map((x) => x.key);
    const outOfScope = keys.filter((k) => !EXPECTED_KEYS.includes(k));
    check(
      r.status === 200 && outOfScope.length === 0 && rows.length === c.expect,
      `${c.name} ⇒ ${c.expect} 行且无越界键`,
      `HTTP ${r.status} · ${rows.length} 行 ${keys.join(',') || '(空)'}`,
    );
  }
}

// ---- ③ 字段白名单 --------------------------------------------------------
console.log('');
console.log('  ③ 字段白名单：请求越界字段不会让响应多出列');
{
  const r = await get(hq, 'serviceSettings:list?pageSize=5&fields=key,value,password_hash,feedback_token_hash');
  const rows = r.json?.data ?? [];
  const cols = new Set(rows.flatMap((x) => Object.keys(x)));
  const bad = [...cols].filter((c) => c === 'password_hash' || c === 'feedback_token_hash');
  check(r.status === 200, '指定越界 fields 仍返回 200', `HTTP ${r.status}`);
  check(bad.length === 0, '响应未包含请求的越界字段', bad.length ? `出现：${bad.join(', ')}` : `列：${[...cols].join(',')}`);
  check(cols.has('key') && cols.has('value'), '仍然下发 key / value（表格可用，不是空壳）', `列：${[...cols].join(',')}`);
}

// ---- ④ get：逐行校验 -----------------------------------------------------
console.log('');
console.log('  ④ get：本页键可读，非本页键 403');
{
  const allowedId = keyIds[EXPECTED_KEYS[0]];
  const okRow = await get(hq, `serviceSettings:get?filterByTk=${allowedId}`);
  check(okRow.status === 200 && okRow.json?.data?.key === EXPECTED_KEYS[0], `get 本页键（id=${allowedId}）返回 200`, `HTTP ${okRow.status}`);

  for (const k of FORBIDDEN_KEYS) {
    const id = keyIds[k];
    const bad = await get(hq, `serviceSettings:get?filterByTk=${id}`);
    check(bad.status === 403, `get 非本页键 ${k}（id=${id}）被拒`, `HTTP ${bad.status}`);
  }
  const missing = await get(hq, 'serviceSettings:get?filterByTk=999999');
  check(missing.status === 403, 'get 不存在的行同样 403（不给存在性信号）', `HTTP ${missing.status}`);
}

// ---- ⑤ 写入口：全部 403，且库不变 ----------------------------------------
console.log('');
console.log('  ⑤ 原生写入口：403 且**库里什么都没变**');
{
  const targetId = keyIds[EXPECTED_KEYS[0]];
  const before = sql(`select value from service_settings where id=${targetId}`);
  const auditsBefore = Number(sql('select count(*) from config_change_audits'));
  const rowsBefore = Number(sql('select count(*) from service_settings'));

  const upd = await write(hq, `serviceSettings:update?filterByTk=${targetId}`, { value: '999' });
  // ⚠️ 批量形态的 filter **必须放 query**：放 body 会被 NocoBase 的入参预检拦下并回
  //    `500 to do update action, filter or filterByTk is required`（不是 403，也不是守卫）。
  //    第一版用例就是这么写错的 —— 它看起来"没被 403 放行"，实际压根没走到 ACL。
  const bulkFilter = encodeURIComponent(JSON.stringify({ key: { $in: EXPECTED_KEYS } }));
  const updByFilter = await write(hq, `serviceSettings:update?filter=${bulkFilter}`, { values: { value: '999' } });
  const del = await write(hq, `serviceSettings:destroy?filterByTk=${targetId}`, {});
  const delByFilter = await write(hq, `serviceSettings:destroy?filter=${bulkFilter}`, {});
  const cre = await write(hq, 'serviceSettings:create', { key: '__probe__', value: '1', value_type: 'int' });
  // 两类"可能被当成写后门"的 action：本版 NocoBase 里**根本没有**这两个端点。
  // 判据要的是"不存在（404）"而不是"403" —— 403 意味着端点存在、只是被拒，
  // 而 404 才是"这条路上压根没有门"。两者对"绕过面"的含义不同，不能混着报。
  const upsert = await write(hq, 'serviceSettings:upsert', { values: { key: '__probe__', value: '1' } });
  const bulk = await write(hq, `serviceSettings:bulkUpdate?filter=${bulkFilter}`, { values: { value: '1' } });

  const after = sql(`select value from service_settings where id=${targetId}`);
  const auditsAfter = Number(sql('select count(*) from config_change_audits'));
  const rowsAfter = Number(sql('select count(*) from service_settings'));

  check(upd.status === 403, 'update（按主键）403', `HTTP ${upd.status} ${upd.text.slice(0, 80)}`);
  check(updByFilter.status === 403, 'update（按 filter 批量）403', `HTTP ${updByFilter.status}`);
  check(del.status === 403, 'destroy（按主键）403', `HTTP ${del.status}`);
  check(delByFilter.status === 403, 'destroy（按 filter 批量）403', `HTTP ${delByFilter.status}`);
  check(cre.status === 403, 'create 403', `HTTP ${cre.status}`);
  check(upsert.status === 404, 'upsert 端点不存在（404，不是"存在但被拒"）', `HTTP ${upsert.status}`);
  check(bulk.status === 404, 'bulkUpdate 端点不存在（404）', `HTTP ${bulk.status}`);
  check(after === before, '值未被改动', `${before} → ${after}`);
  check(rowsAfter === rowsBefore, '行数未变（没有偷偷插入）', `${rowsBefore} → ${rowsAfter}`);
  check(auditsAfter === auditsBefore, '审计条数未变（没有绕过 svc:updateSetting 的写入）', `${auditsBefore} → ${auditsAfter}`);
}

// ---- ⑥ 其余三个业务角色仍被拒 --------------------------------------------
console.log('');
console.log('  ⑥ 其余业务角色：仍不可读（隔离没有被一起放开）');
for (const role of ['hq_after_sales', 'store_after_sales', 'viewer']) {
  const r = await get(tokens[role], 'serviceSettings:list?pageSize=5');
  check(r.status === 403, `${role} list 403`, `HTTP ${r.status}`);
}

// ---- ⑦ 平台 admin 维护能力完整 -------------------------------------------
console.log('');
console.log('  ⑦ 平台 admin：维护能力不受影响（不能为了让 hq_admin 能读而误伤超管）');
{
  const email = envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com');
  const pwd = envValue('SMOKE_ADMIN_PASSWORD');
  if (!pwd) {
    note('SKIP', '未配置 SMOKE_ADMIN_PASSWORD，无法验证平台 admin');
  } else {
    const li = await login(email, pwd);
    if (!li.ok) {
      check(false, '平台 admin 登录失败', `HTTP ${li.status}`);
    } else {
      const r = await get(li.token, 'serviceSettings:list?pageSize=100');
      const count = Number(r.json?.meta?.count ?? 0);
      check(r.status === 200 && count > EXPECTED_KEYS.length, 'admin 仍可读全表（不收窄）', `HTTP ${r.status} · count=${count}`);
    }
  }
}

// ---- 汇总 ----------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  结果：通过 ${results.length - failed.length} / 失败 ${failed.length}`);
if (failed.length) {
  console.log('  失败项：');
  for (const f of failed) console.log(`    ❌ ${f.label}${f.detail ? ` —— ${f.detail}` : ''}`);
}
console.log('══════════════════════════════════════════════════════════════');
process.exit(failed.length ? 1 : 0);
