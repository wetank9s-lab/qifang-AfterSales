/**
 * probe-acl-minimality.mjs —— 敏感动作的响应体最小性取证（Phase 11 / P11-0）
 *
 * 用户要求：「对 roles:check、collections:listMeta 先实取响应体确认最小性，
 *            并验证相邻非必需 read actions 仍拒绝」。
 *
 * 本脚本只做取证（打印 + 断言最小性），不做授权变更。
 * 用法：node scripts/probe-acl-minimality.mjs
 * 退出码：0 取证完成 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SVC_BASE_URL } from './lib/base-url.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function envValue(key, fallback = '') {
  const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
  return m ? m[1].trim() : (process.env[key] ?? fallback);
}

const EMAIL = envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local');
const PASSWORD = envValue('UAT_STORE_A_PASSWORD');

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  敏感动作响应体最小性取证（Phase 11 / P11-0）');
console.log('══════════════════════════════════════════════════════════════');

if (!PASSWORD) {
  console.log('  ⛔ .env 缺 UAT_STORE_A_PASSWORD —— 环境未就绪');
  process.exit(2);
}

const signIn = await fetch(`${SVC_BASE_URL}/api/auth:signIn`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: new URL(SVC_BASE_URL).origin },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const signInBody = await signIn.text();
if (signIn.status !== 200) {
  console.log(`  ⛔ 登录失败（HTTP ${signIn.status}）：${signInBody.slice(0, 200)}`);
  process.exit(2);
}
const token = JSON.parse(signInBody)?.data?.token;
if (!token) {
  console.log(`  ⛔ 登录成功但没拿到 token：${signInBody.slice(0, 200)}`);
  process.exit(2);
}
console.log(`  ✅ 门店账号登录成功：${EMAIL}`);

async function get(p, useAuth = true) {
  const r = await fetch(`${SVC_BASE_URL}/api/${p}`, {
    headers: useAuth ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: r.status, text: await r.text() };
}

// ---------------------------------------------------------------------------
console.log('');
console.log('【1】roles:check —— 它到底回了什么？');
const rc = await get('roles:check');
console.log(`  状态 ${rc.status} · ${rc.text.length} 字节`);
{
  let j = null;
  try { j = JSON.parse(rc.text); } catch { /* 非 JSON */ }
  const data = j?.data;
  if (data && typeof data === 'object') {
    const keys = Object.keys(data);
    console.log(`  顶层键（${keys.length}）：${keys.join(', ')}`);
    // 判"最小性"：它**只应**回当前用户自己的权限，不应含他人账号/邮箱/手机号
    const dump = JSON.stringify(data);
    const leaksOthers =
      /"email"\s*:/.test(dump) || /"phone"\s*:/.test(dump) || /@[a-z0-9.-]+\.[a-z]{2,}/i.test(dump);
    console.log(`  ⚠️ 是否含他人账号/邮箱/手机号：${leaksOthers ? '**是**（需重新评估）' : '否 ✅'}`);
    console.log(`  样本：${dump.slice(0, 320)}`);
  } else {
    console.log(`  样本：${rc.text.slice(0, 320)}`);
  }
}

console.log('');
console.log('【2】collections:listMeta —— 它到底回了什么？');
const cm = await get('collections:listMeta');
console.log(`  状态 ${cm.status} · ${cm.text.length} 字节`);
{
  let j = null;
  try { j = JSON.parse(cm.text); } catch { /* 非 JSON */ }
  const rows = Array.isArray(j?.data) ? j.data : [];
  console.log(`  集合数：${rows.length}`);
  const withFields = rows.filter((r) => Array.isArray(r?.fields) && r.fields.length > 0);
  console.log(`  含 fields 明细的集合数：${withFields.length} / ${rows.length}`);
  const sample = rows[0];
  if (sample) {
    console.log(`  单条形状（第一个集合）：keys = ${Object.keys(sample).join(', ')}`);
    console.log(`  样本：${JSON.stringify(sample).slice(0, 420)}`);
  }
  // 判"最小性"：listMeta 只应给"结构元数据"，不应含数据行 / 不含具体记录
  const dump = JSON.stringify(j?.data ?? null);
  const hasRows = /"rows"\s*:/.test(dump) || /"data"\s*:\s*\[/.test(dump);
  console.log(`  是否含具体数据行：${hasRows ? '**是**（越界）' : '否 ✅（只有结构元数据）'}`);
  // 是否泄露"未向业务暴露"的集合（如 users / roles 的字段结构）
  const names = rows.map((r) => r?.name).filter(Boolean);
  const sensitive = names.filter((n) => ['users', 'roles', 'collections', 'storages', 'authenticators'].includes(n));
  console.log(`  含敏感集合名：${sensitive.length ? sensitive.join(', ') : '否 ✅'}`);
  console.log(`  集合名（前 30）：${names.slice(0, 30).join(', ')}`);
}

// ---------------------------------------------------------------------------
console.log('');
console.log('【3】相邻"非必需" read actions 的现状（改后必须拒绝）');
for (const p of ['roles:list', 'collections:list', 'users:list']) {
  const r = await get(p);
  console.log(`  ${p.padEnd(22)} 当前 ${r.status}   ← 改前应为 200（B-8 现场），改后必须 403/404`);
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  取证完成（本脚本不做授权变更）');
console.log('══════════════════════════════════════════════════════════════');
console.log('');
