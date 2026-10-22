/**
 * verify-be04-all-tickets.mjs —— BE-04「所有工单」服务端筛选 / 分页 / 边界
 *
 * 判据全部以 **SQL 为基准**（同一口径算 count，再与 API 的 meta.count 对比），
 * 这样"服务端过滤"与"前端只过滤当前页"能被明确区分开。
 *
 * 覆盖：
 *  ① 时间半开区间（当日 00:00 含 / 次日 00:00 不含）；
 *  ② 月末→次月、12 月→次年、闰日 2/29；
 *  ③ 门店 / 类型 / 状态 / 单号 / 客户姓名 / 手机号 组合；
 *  ④ 分页：第 1 页 / 第 2 页不重叠、末页、总数一致、排序稳定；
 *  ⑤ 无匹配时 count=0 且列表空；
 *  ⑥ 门店角色跨店不可见（服务端行级）。
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { acceptAndDispatch, cleanupTicket, createScratchTicket, envValue } from './technician-harness.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};
const note = (label, detail = '') => console.log(`  ·  ${label}${detail ? `：${detail}` : ''}`);

const psql = (sql) =>
  execFileSync('docker', ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql], {
    encoding: 'utf8',
  }).trim();

async function signIn(account, password) {
  const r = await fetch(`${BASE}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  const j = await r.json().catch(() => null);
  return j?.data?.token ?? null;
}
async function api(p, token) {
  const r = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* */
  }
  return { status: r.status, json, text };
}
const count = (r) => Number(r.json?.meta?.count ?? -1);

/** Asia/Shanghai 自然日 → [startIso, endIso)（半开） */
function shanghaiDayRange(dayIso) {
  const start = new Date(`${dayIso}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return [start.toISOString(), end.toISOString()];
}

const q = (iso) => encodeURIComponent(iso);

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  BE-04：所有工单 · 服务端筛选 / 分页 / 时间边界');
console.log('══════════════════════════════════════════════════════════════');

const admin = await signIn(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), envValue('UAT_HQADMIN_PASSWORD'));
const hq = await signIn('uat.hq@svc.local', envValue('UAT_HQ_PASSWORD'));
const store = await signIn(envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'), envValue('UAT_STORE_A_PASSWORD'));
const viewer = await signIn('uat.viewer@svc.local', envValue('UAT_VIEWER_PASSWORD'));
if (!admin || !hq || !store || !viewer) {
  console.log('⛔ 登录失败');
  process.exit(2);
}

const fx = await createScratchTicket({ tag: 'BE04', content: '筛选夹具' });
psql(`UPDATE service_tickets SET customer_mobile='13800007777', customer_name='筛选夹具甲' WHERE id=${fx.ticketId}`);
await acceptAndDispatch(fx.ticketId, admin, { technician_name: '筛选师', technician_mobile: '13900009999' });
const fxStore = psql(`SELECT store_id FROM service_tickets WHERE id=${fx.ticketId}`);
const fxType = psql(`SELECT ticket_type FROM service_tickets WHERE id=${fx.ticketId}`);
const fxStatus = psql(`SELECT status FROM service_tickets WHERE id=${fx.ticketId}`);
note('夹具', `${fx.ticketNo} · store=${fxStore} · type=${fxType} · status=${fxStatus}`);

try {
  // ─────────────────────────── ① 当日半开区间
  const today = psql(`SELECT to_char((created_at AT TIME ZONE 'Asia/Shanghai')::date,'YYYY-MM-DD') FROM service_tickets WHERE id=${fx.ticketId}`);
  const [d0, d1] = shanghaiDayRange(today);
  const apiDay = await api(
    `/api/serviceTickets:list?pageSize=1&filter[createdAt][$gte]=${q(d0)}&filter[createdAt][$lt]=${q(d1)}`,
    admin,
  );
  const sqlDay = Number(
    psql(`SELECT count(*) FROM service_tickets WHERE created_at >= '${d0}' AND created_at < '${d1}'`),
  );
  check(apiDay.status === 200 && count(apiDay) === sqlDay, '① 当日 [00:00, 次日00:00) 与 SQL 计数一致', `API=${count(apiDay)} SQL=${sqlDay}`);

  // 边界探针：次日 00:00 那一刻**不得**包含当日记录
  const apiNextStart = await api(
    `/api/serviceTickets:list?pageSize=1&filter[createdAt][$gte]=${q(d1)}&filter[createdAt][$lt]=${q(new Date(new Date(d1).getTime() + 86400000).toISOString())}`,
    admin,
  );
  const todayIds = new Set((apiDay.json?.data ?? []).map((x) => x.id));
  const nextIds = new Set((apiNextStart.json?.data ?? []).map((x) => x.id));
  const overlap = [...todayIds].filter((id) => nextIds.has(id)).length;
  check(overlap === 0, '① 次日区间与当日区间**无重叠**（半开区间正确）', `重叠 ${overlap}`);

  // ─────────────────────────── ② 月末 / 12 月 / 闰日
  const monthCases = [
    ['2026-02（闰年？2026 非闰年）', '2026-02-01', '2026-03-01'],
    ['2024-02（**闰月**）', '2024-02-01', '2024-03-01'],
    ['2025-12 → 2026-01', '2025-12-01', '2026-01-01'],
    ['2026-10（当前月）', '2026-10-01', '2026-11-01'],
  ];
  for (const [label, from, to] of monthCases) {
    const s = new Date(`${from}T00:00:00+08:00`).toISOString();
    const e = new Date(`${to}T00:00:00+08:00`).toISOString();
    const apiM = await api(`/api/serviceTickets:list?pageSize=1&filter[createdAt][$gte]=${q(s)}&filter[createdAt][$lt]=${q(e)}`, admin);
    const sqlM = Number(psql(`SELECT count(*) FROM service_tickets WHERE created_at >= '${s}' AND created_at < '${e}'`));
    check(apiM.status === 200 && count(apiM) === sqlM, `② ${label}：月边界与 SQL 一致`, `API=${count(apiM)} SQL=${sqlM}`);
  }

  // 闰日单日：2024-02-29
  {
    const [s, e] = shanghaiDayRange('2024-02-29');
    const apiLeap = await api(`/api/serviceTickets:list?pageSize=1&filter[createdAt][$gte]=${q(s)}&filter[createdAt][$lt]=${q(e)}`, admin);
    const sqlLeap = Number(psql(`SELECT count(*) FROM service_tickets WHERE created_at >= '${s}' AND created_at < '${e}'`));
    check(apiLeap.status === 200 && count(apiLeap) === sqlLeap, '② **闰日 2024-02-29** 单日查询与 SQL 一致', `API=${count(apiLeap)} SQL=${sqlLeap}`);
  }

  // ─────────────────────────── ③ 组合筛选
  const combos = [
    ['门店', `filter[store_id]=${fxStore}`],
    ['类型', `filter[ticket_type]=${fxType}`],
    ['状态', `filter[status]=${fxStatus}`],
    ['单号', `filter[ticket_no]=${fx.ticketNo}`],
    ['客户姓名', `filter[customer_name]=${encodeURIComponent('筛选夹具甲')}`],
    ['客户手机号', `filter[customer_mobile]=13800007777`],
  ];
  for (const [label, cond] of combos) {
    const r = await api(`/api/serviceTickets:list?pageSize=5&${cond}&filter[createdAt][$gte]=${q(d0)}&filter[createdAt][$lt]=${q(d1)}`, admin);
    check(r.status === 200 && count(r) >= 1, `③ 单条件「${label}」命中夹具`, `count=${count(r)}`);
  }
  // 六条件组合 + 时间
  const comboAll = await api(
    `/api/serviceTickets:list?pageSize=5` +
      `&filter[store_id]=${fxStore}&filter[ticket_type]=${fxType}&filter[status]=${fxStatus}` +
      `&filter[ticket_no]=${fx.ticketNo}&filter[customer_name]=${encodeURIComponent('筛选夹具甲')}&filter[customer_mobile]=13800007777` +
      `&filter[createdAt][$gte]=${q(d0)}&filter[createdAt][$lt]=${q(d1)}`,
    admin,
  );
  check(comboAll.status === 200 && count(comboAll) === 1, '③ 六条件 + 时间**组合**只命中该夹具', `count=${count(comboAll)}`);

  // 组合里有一个不匹配 ⇒ 0
  const comboMiss = await api(
    `/api/serviceTickets:list?pageSize=5&filter[ticket_no]=${fx.ticketNo}&filter[customer_mobile]=13900001111`,
    admin,
  );
  check(count(comboMiss) === 0, '③ 组合条件互相矛盾时 count=0（不是 OR）', `count=${count(comboMiss)}`);

  // ─────────────────────────── ④ 分页
  const total = count(await api('/api/serviceTickets:list?pageSize=1', admin));
  const p1 = await api('/api/serviceTickets:list?pageSize=5&page=1&sort=-createdAt', admin);
  const p2 = await api('/api/serviceTickets:list?pageSize=5&page=2&sort=-createdAt', admin);
  const ids1 = (p1.json?.data ?? []).map((x) => x.id);
  const ids2 = (p2.json?.data ?? []).map((x) => x.id);
  const dup = ids1.filter((id) => ids2.includes(id));
  check(ids1.length === 5 && ids2.length === 5, '④ 第 1 页与第 2 页各返回 5 条', `${ids1.length}/${ids2.length}`);
  check(dup.length === 0, '④ 第 1、2 页**无重复**', JSON.stringify(dup));
  check(count(p1) === total && count(p2) === total, '④ 两页 meta.count 相同且等于总数', `${count(p1)}/${count(p2)}/${total}`);

  const lastPage = Math.ceil(total / 5);
  const pl = await api(`/api/serviceTickets:list?pageSize=5&page=${lastPage}&sort=-createdAt`, admin);
  check(pl.status === 200 && (pl.json?.data ?? []).length > 0, '④ 末页非空', `page=${lastPage} 条数=${(pl.json?.data ?? []).length}`);

  const noHit = await api('/api/serviceTickets:list?pageSize=5&filter[ticket_no]=FW00000000-0000', admin);
  check(noHit.status === 200 && count(noHit) === 0 && (noHit.json?.data ?? []).length === 0, '④ 无匹配：count=0 且列表为空', `count=${count(noHit)}`);

  // 排序稳定：同一请求两次，首条 id 相同
  const s1 = await api('/api/serviceTickets:list?pageSize=3&sort=-createdAt', admin);
  const s2 = await api('/api/serviceTickets:list?pageSize=3&sort=-createdAt', admin);
  check(
    JSON.stringify((s1.json?.data ?? []).map((x) => x.id)) === JSON.stringify((s2.json?.data ?? []).map((x) => x.id)),
    '④ 排序稳定（两次请求顺序一致）',
    '',
  );

  // ─────────────────────────── ⑤ 门店隔离（服务端）
  const storeList = await api('/api/serviceTickets:list?pageSize=50&fields=id,store_id', store);
  const storeIds = [...new Set((storeList.json?.data ?? []).map((x) => x.store_id).filter(Boolean))];
  check(storeIds.length <= 1, '⑤ 门店角色列表只含本店（服务端行级）', JSON.stringify(storeIds));
  // 直接按别店 id 过滤，也不能拿到
  const otherStore = psql(`SELECT id FROM stores WHERE id <> '${fxStore}' AND active = true LIMIT 1`);
  const storeCross = await api(`/api/serviceTickets:list?pageSize=5&filter[store_id]=${otherStore}`, store);
  check(count(storeCross) === 0, '⑤ 门店按别店 id 过滤仍为 0（不能跨店）', `count=${count(storeCross)} other=${otherStore}`);

  // ─────────────────────────── ⑥ viewer 只读
  const vUpd = await fetch(`${BASE}/api/serviceTickets:update?filterByTk=${fx.ticketId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${viewer}`, 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
    body: JSON.stringify({ content: '越权探针' }),
  });
  check([403, 404].includes(vUpd.status), '⑥ viewer 修改工单仍 403', `HTTP ${vUpd.status}`);
} finally {
  cleanupTicket(fx.ticketId);
  check(Number(psql(`SELECT count(*) FROM service_tickets WHERE id=${fx.ticketId}`)) === 0, '夹具清理干净', '');
}

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  BE-04 服务端筛选：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
console.log('');
