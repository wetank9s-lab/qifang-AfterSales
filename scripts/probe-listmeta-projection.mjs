/**
 * probe-listmeta-projection.mjs —— 对照取证：投影到底砍掉了什么（Phase 11 / P11-0）
 *
 * 现象：收口后页面上报「字段 ticket_no 可能已被删除」「数据表 serviceTickets 可能已被删除」。
 * 说明 `collection-metadata-scope` 的正向投影**砍过了头**。
 *
 * 口径：同一个 `collections:listMeta`，
 *   · 平台管理员（root/admin）→ **原始完整**（不经过投影）
 *   · 门店业务角色 → 投影后的结果
 * 逐集合对比：集合数、每集合的字段名集合、差集。
 *
 * 用法：node scripts/probe-listmeta-projection.mjs
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

async function login(email, password) {
  const r = await fetch(`${SVC_BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(SVC_BASE_URL).origin },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  return j?.data?.token ?? null;
}

async function listMeta(token) {
  const r = await fetch(`${SVC_BASE_URL}/api/collections:listMeta`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await r.text();
  if (r.status !== 200) return { status: r.status, data: [], text };
  return { status: 200, data: JSON.parse(text)?.data ?? [], text };
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  collections:listMeta 投影对照取证（Phase 11 / P11-0）');
console.log('══════════════════════════════════════════════════════════════');

const storeToken = await login(
  envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'),
  envValue('UAT_STORE_A_PASSWORD'),
);
const adminToken = await login(envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com'), envValue('SMOKE_ADMIN_PASSWORD'));
if (!storeToken || !adminToken) {
  console.log('  ⛔ 登录失败 —— 环境未就绪');
  process.exit(2);
}

const asStore = await listMeta(storeToken);
const asAdmin = await listMeta(adminToken);

// 形状自证：形状不对时先把原始响应打出来，再谈对比
if (!Array.isArray(asStore.data)) {
  console.log('');
  console.log(`  ⛔ 业务角色的响应形状不是 {data: [...]}：status=${asStore.status}`);
  console.log(`     原始响应（前 400 字）：${String(asStore.text).slice(0, 400)}`);
  console.log('     ⇒ 投影中间件改了响应形状 —— 这是**我的 bug**，不是 ACL 的。');
  console.log('');
  process.exit(1);
}

console.log(`  · 平台管理员看到的集合数：${asAdmin.data.length}（原始）`);
console.log(`  · 业务角色看到的集合数：  ${asStore.data.length}（投影后）`);

const storeNames = asStore.data.map((c) => c.name);
console.log(`  · 业务角色可见：${storeNames.join(', ') || '（空）'}`);

// 逐集合对比字段
const adminByName = new Map(asAdmin.data.map((c) => [c.name, c]));
let totalDropped = 0;
for (const c of asStore.data) {
  const full = adminByName.get(c.name);
  const fFull = new Set((full?.fields ?? []).map((f) => f.name));
  const fProj = new Set((c.fields ?? []).map((f) => f.name));
  const dropped = [...fFull].filter((n) => !fProj.has(n));
  totalDropped += dropped.length;
  console.log('');
  console.log(`  ── ${c.name}：字段 ${fFull.size} → ${fProj.size}（丢弃 ${dropped.length} 条）`);
  if (dropped.length) console.log(`     丢弃的字段：${dropped.join(', ')}`);
}

// 关键：顶层集合是否被整体丢掉
const adminNames = asAdmin.data.map((c) => c.name);
const removedCollections = adminNames.filter((n) => !storeNames.includes(n));
console.log('');
console.log(`  · 被整体移除的集合（${removedCollections.length}）：${removedCollections.join(', ') || '（无）'}`);

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  合计丢弃字段 ${totalDropped} 条 —— 若把渲染必需字段也丢了，页面就会报"字段/数据表可能已被删除"`);
console.log('══════════════════════════════════════════════════════════════');
console.log('');
