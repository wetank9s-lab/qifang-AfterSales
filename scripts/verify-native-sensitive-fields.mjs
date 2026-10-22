#!/usr/bin/env node
/**
 * verify-native-sensitive-fields.mjs —— 原生只读接口**不得下发凭据列**（字段级安全门禁）
 *
 * ===========================================================================
 * 为什么单独一支
 * ===========================================================================
 * 资源级 ACL 只管"能不能读这张表"，**字段级**由 `dataSourcesRolesResourcesActions.fields`
 * 决定（`seeds/apply.ts: nativeReadFieldsOf` → `NATIVE_READ_FIELD_DENY`）。
 * 这层没有天然的红灯：接口 200、业务字段齐全，**多出来的那几列**没人会注意到。
 *
 * 2026-10-17（UX-MEDIA-01 取证）就实测到一次：P11-4 新增的 `progress_token_*`
 * 没有登记进 deny 列表，于是 `serviceTickets:get` 把 `progress_token_hash` 整列下发。
 * ⇒ 本门禁按"**真实账号 + 真实 HTTP + 逐列断言**"覆盖它。
 *
 * 判据（两类都查）：
 *   ① 敏感列**一个都不出现**（否命题 —— 新增敏感列必须先登记，漏登记就红）；
 *   ② 业务列**仍在**（防"把 fields 收紧成空壳"这种反向假修：接口 200 但全是系统列）。
 *
 * 用法：node scripts/verify-native-sensitive-fields.mjs
 * 退出码：0 通过 / 1 判据不满足 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SVC_BASE_URL } from './lib/base-url.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const ORIGIN = new URL(SVC_BASE_URL).origin;

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

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};

/**
 * 各资源上**绝不能出现在原生响应里**的列。
 *
 * ⚠️ 与 `constants.NATIVE_READ_FIELD_DENY` 是**两份**清单，且这是有意的：
 *    这里写的是"安全上不允许外流"（验收判据），那里是"实现上排除"（工程手段）。
 *    两份一致才通过；只留一份就等于"用实现证明实现是对的"。
 */
const FORBIDDEN = {
  serviceTickets: [
    'feedback_token_hash',
    'feedback_token_expires_at',
    'feedback_token_used_at',
    'progress_token_hash',
    'progress_token_expires_at',
    'progress_token_revoked_at',
  ],
  serviceVisits: ['access_token_hash', 'token_expires_at', 'token_used_at'],
  customerMedias: ['storage_key', 'upload_ip_hash'],
  serviceVisitPhotos: ['storage_key', 'upload_ip_hash'],
};

/** 每个资源必须仍能读到的业务列（防"空壳"假修） */
const MUST_HAVE = {
  serviceTickets: ['ticket_no', 'status', 'content'],
  serviceVisits: ['visit_no', 'visit_status'],
};

const ACCOUNTS = [
  ['store_after_sales', 'UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'],
  ['hq_after_sales', 'UAT_HQ_EMAIL', 'uat.hq@svc.local'],
  ['hq_admin', 'UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'],
  ['viewer', 'UAT_VIEWER_EMAIL', 'uat.viewer@svc.local'],
];

async function login(emailKey, fallback) {
  const r = await fetch(`${SVC_BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({
      email: envValue(emailKey, fallback),
      password: envValue(emailKey.replace('_EMAIL', '_PASSWORD')),
    }),
  });
  const text = await r.text();
  if (r.status !== 200) return { ok: false, status: r.status, body: text.slice(0, 120) };
  return { ok: true, token: JSON.parse(text).data.token };
}

async function get(token, pathname) {
  const r = await fetch(`${SVC_BASE_URL}/api/${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* noop */
  }
  return { status: r.status, json, text };
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  原生只读：凭据列不得下发 + 业务列必须仍在');
console.log('══════════════════════════════════════════════════════════════');

const creds = [];
for (const [role, key, fallback] of ACCOUNTS) {
  if (!envValue(key.replace('_EMAIL', '_PASSWORD'))) {
    console.log(`  ⛔ .env 缺 ${key.replace('_EMAIL', '_PASSWORD')} —— 环境未就绪`);
    process.exit(2);
  }
  const li = await login(key, fallback);
  if (!li.ok) {
    console.log(`  ⛔ ${role} 登录失败 HTTP ${li.status} ${li.body}`);
    process.exit(2);
  }
  creds.push({ role, token: li.token });
}

for (const { role, token } of creds) {
  console.log('');
  console.log(`  · ${role}`);
  for (const [resource, forbidden] of Object.entries(FORBIDDEN)) {
    // 先 list 取一条真实主键，再 get —— 两条路径的字段投影都要查
    const list = await get(token, `${resource}:list?pageSize=1`);
    if (list.status !== 200) {
      // 该角色对这个资源本就不可读（例如照片表整资源封禁）⇒ 记一条"不可读"而不是失败
      check(list.status === 403 || list.status === 404, `${resource}:list 不可读（预期）`, `HTTP ${list.status}`);
      continue;
    }
    const row = list.json?.data?.[0];
    if (!row) {
      check(true, `${resource}:list 无可读行（跳过列断言）`);
      continue;
    }
    const leaked = forbidden.filter((c) => Object.prototype.hasOwnProperty.call(row, c));
    check(leaked.length === 0, `${resource}:list 未下发凭据列`, leaked.length ? `泄露：${leaked.join(', ')}` : '');
    const keep = MUST_HAVE[resource] ?? [];
    const missing = keep.filter((c) => !Object.prototype.hasOwnProperty.call(row, c));
    check(missing.length === 0, `${resource}:list 业务列仍在（非空壳）`, missing.length ? `缺少：${missing.join(', ')}` : '');

    const id = row.id;
    if (id != null) {
      const one = await get(token, `${resource}:get?filterByTk=${id}`);
      check(one.status === 200, `${resource}:get 可用`, `HTTP ${one.status}`);
      if (one.status === 200) {
        const data = one.json?.data ?? {};
        const leakedGet = forbidden.filter((c) => Object.prototype.hasOwnProperty.call(data, c));
        check(leakedGet.length === 0, `${resource}:get 未下发凭据列`, leakedGet.length ? `泄露：${leakedGet.join(', ')}` : '');
      }
    }
  }
}

// 未登录：一个都不许读
console.log('');
console.log('  · anon');
for (const resource of Object.keys(FORBIDDEN)) {
  const r = await get('', `${resource}:list?pageSize=1`);
  check(r.status === 401 || r.status === 403, `anon ${resource}:list 被拒`, `HTTP ${r.status}`);
}

const failed = results.filter((r) => !r.pass);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  结果：通过 ${results.length - failed.length} / 失败 ${failed.length}`);
if (failed.length) for (const f of failed) console.log(`    ❌ ${f.label}${f.detail ? ` —— ${f.detail}` : ''}`);
console.log('══════════════════════════════════════════════════════════════');
process.exit(failed.length ? 1 : 0);
