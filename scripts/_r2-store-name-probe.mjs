/**
 * _r2-store-name-probe.mjs —— R2 门店名投影验证（只读探针）
 *
 * 判据（**不是**看页面文案）：
 *   ① `svc:timeline` 响应顶层出现 `store_name`，且**等于** `stores.name`（不是 code）；
 *   ② 门店角色（store_after_sales）拿到的 `store_name` 与其授权门店一致；
 *   ③ 反向：`stores:get` 对门店角色仍是 403（证明"前端不该去查它"这个前提成立）。
 *
 * 纪律：只 GET，不写任何数据。
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * ⚠️ 必须用 **https://127.0.0.1**（不是 `:8080`）：
 *    8080 上 nginx 会 301 到 https 并**丢掉 POST body** ⇒ 登录一律 400/401，
 *    看起来像"口令全失效"，实则是打错了端口（2026-11-16 实测踩到）。
 */
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';

const env = {};
for (const l of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
  if (m) env[m[1]] = m[2];
}

const results = [];
const ck = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`);
};

async function signIn(account, password) {
  const res = await fetch(`${BASE}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  const j = await res.json().catch(() => null);
  if (!j?.data?.token) throw new Error(`登录失败 ${account}: HTTP ${res.status}`);
  return j.data.token;
}

async function api(token, p, opt = {}) {
  const res = await fetch(BASE + p, {
    method: opt.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opt.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text };
}

function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-A', '-t', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8' },
  ).trim();
}

async function main() {
  // ---- 取一张门店 1（新都圣大家电）的工单 + 该店真实名称 ----
  const row = psql(`select t.id, t.store_id, s.name from service_tickets t join stores s on s.id=t.store_id where t.store_id=1 order by t.id desc limit 1;`);
  const [ticketId, storeId, storeName] = row.split('|');
  console.log(`\n样本：工单 #${ticketId} / 门店 id=${storeId} / 库中名称="${storeName}"`);

  // ---- ① hq_after_sales（有全量范围）----
  console.log('\n--- ① hq_after_sales ---');
  const hqToken = await signIn('uat.hq@svc.local', env.UAT_HQ_PASSWORD);
  const hqTl = await api(hqToken, `/api/svc:timeline?filterByTk=${ticketId}&pageSize=50`);
  ck(hqTl.status === 200, 'timeline 200', `status=${hqTl.status}`);
  ck('store_name' in (hqTl.json?.data ?? {}), '响应顶层含 store_name 键',
    `keys=${Object.keys(hqTl.json?.data ?? {}).join(',')}`);
  ck(hqTl.json?.data?.store_name === storeName,
    'store_name 与库中 stores.name 逐字一致',
    `got="${hqTl.json?.data?.store_name}" expect="${storeName}"`);
  ck(hqTl.json?.data?.store_name !== `S0${storeId}` && !/^S\d+$/.test(String(hqTl.json?.data?.store_name ?? '')),
    'store_name 不是编码（S01 之类）', `got="${hqTl.json?.data?.store_name}"`);

  // ---- ② store_after_sales（门店角色）----
  console.log('\n--- ② store_after_sales（门店角色）---');
  const stToken = await signIn('uat.store.a@svc.local', env.UAT_STORE_A_PASSWORD);
  const stTl = await api(stToken, `/api/svc:timeline?filterByTk=${ticketId}&pageSize=50`);
  ck(stTl.status === 200, 'timeline 200（门店角色）', `status=${stTl.status}`);
  ck(stTl.json?.data?.store_name === storeName,
    '门店角色也能拿到同一门店名（不依赖 stores 读权限）',
    `got="${stTl.json?.data?.store_name}"`);

  // ---- ③ 复核"旧方案为什么失败"（推翻我第一轮的误诊）----
  /*
   * 🔴 我第一轮断言"门店角色读 stores 会被 403、所以前端查不到"——**这是错的**。
   *    实测：门店角色读**自己授权**的门店 200、读**未授权**门店 404（有 scoped ACL）。
   *    ⇒ 真正的失败原因是旧代码第一行 `if (!code) return` 提前返回，压根没发请求。
   *    这条断言把事实钉住，避免下一个人再把"没显示"误读成"没权限"。
   */
  console.log('\n--- ③ 复核 stores 的真实可达性（纠正误诊）---');
  const stOwn = await api(stToken, `/api/stores:get?filterByTk=${storeId}`);
  ck(stOwn.status === 200,
    '门店角色读**自己授权**门店 → 200（所以我第一轮的"403 无权限"是误诊）',
    `status=${stOwn.status}`);

  const otherStoreId = psql(`select id from stores where id <> ${storeId} order by id limit 1;`);
  const stOther = await api(stToken, `/api/stores:get?filterByTk=${otherStoreId}`);
  ck(stOther.status === 404 || stOther.status === 403,
    ' 门店角色读**未授权**门店 → 404/403（ACL 是按门店 scope 裁的）',
    `其他门店 id=${otherStoreId} status=${stOther.status}`);

  console.log('\n===== 汇总 =====');
  const failed = results.filter((r) => !r.pass);
  console.log(failed.length === 0 ? '✅ 全部通过' : `❌ ${failed.length} 项失败`);
  for (const f of failed) console.log(`   FAIL ${f.label} ${f.detail}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('探针异常：', e?.message ?? e); process.exit(2); });
