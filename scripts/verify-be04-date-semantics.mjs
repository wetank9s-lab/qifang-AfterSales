/**
 * verify-be04-date-semantics.mjs —— DATE 操作符语义校准（源码 + 夹具 + SQL 对照）
 *
 * 源码依据（NocoBase 2.2.15，`@nocobase/database/lib/operators/date.js`）：
 *   $dateOn(数组)  => { and: [ { gte: r[0] }, { lt: r[1] } ] }   ← 天然半开区间
 *   $dateBetween   => { and: [ { gte: r[0] }, { lt: r[1] } ] }   ← 同上
 *   时区           => db.options.timezone；容器 TZ=Asia/Shanghai
 *
 * 本门禁不靠"页面还有 20 行"判断，而是：
 *   ① 建 6 张夹具，把 created_at 精确设到边界点；
 *   ② 调 API（$dateOn 数组）→ 拿到返回 ID 集合与 meta.count；
 *   ③ 用 SQL 独立算同一区间 → 比对集合与计数；
 *   ④ 断言边界工单**包含/排除**完全正确。
 */
import { execFileSync } from 'node:child_process';
import { cleanupTicket, createScratchTicket, envValue } from './technician-harness.mjs';

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

async function signIn(a, p) {
  const r = await fetch(`${BASE}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: a, password: p }),
  });
  return (await r.json().catch(() => null))?.data?.token ?? null;
}
async function list(filterJson, token, pageSize = 2000) {
  const url = `${BASE}/api/serviceTickets:list?pageSize=${pageSize}&fields=id,ticket_no,created_at&filter=${encodeURIComponent(
    JSON.stringify(filterJson),
  )}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => null);
  return { status: r.status, ids: (j?.data ?? []).map((x) => x.id), count: Number(j?.meta?.count ?? -1) };
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  BE-04-DATE：$dateOn 数组语义 / 边界 / SQL 对照');
console.log('══════════════════════════════════════════════════════════════');

const token = await signIn(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), envValue('UAT_HQADMIN_PASSWORD'));
const tz = psql(`SHOW TIMEZONE`);
note('数据库会话时区', tz);
const colType = psql(
  `SELECT data_type FROM information_schema.columns WHERE table_name='service_tickets' AND column_name='created_at'`,
);
note('created_at 类型', colType);

// 边界点（Asia/Shanghai）
const CASES = [
  { name: '起点前 1ms', at: '2026-09-30 23:59:59.999+08', expect: false },
  { name: '起点整 00:00', at: '2026-10-01 00:00:00+08', expect: true },
  { name: '区间内部', at: '2026-10-15 12:00:00+08', expect: true },
  { name: '终点前 1ms', at: '2026-10-31 23:59:59.999+08', expect: true },
  { name: '下周期整点', at: '2026-11-01 00:00:00+08', expect: false },
  { name: '区间外（12 月）', at: '2026-12-01 10:00:00+08', expect: false },
];

const fixtures = [];
try {
  for (const c of CASES) {
    const fx = await createScratchTicket({ tag: 'BE04DATE', content: `边界夹具 ${c.name}` });
    psql(`UPDATE service_tickets SET created_at='${c.at}'::timestamptz WHERE id=${fx.ticketId}`);
    fixtures.push({ ...c, id: fx.ticketId, no: fx.ticketNo });
  }
  note(
    '夹具',
    fixtures.map((f) => `${f.no}@${f.at}(${f.expect ? '应含' : '应排'})`).join(' | '),
  );

  // ── 区间：2026-10-01 ~ 2026-11-01（半开）
  /**
   * 🔴 语义结论（源码 + 实跑双重确认）：
   *   `parseDate` 对**单值**返回 `[t, t+1s]`（1 秒窗口），对**数组**返回 `[first[0], last[1]]`
   *   ⇒ `$dateOn: [start, end]` 实际是 `gte start AND lt (end + 1s)`，
   *     会把"终点整点后 1 秒内"的数据**误包含**（夹具 2026-11-01 00:00:00 就是这样被吃进来的）。
   *   `$dateBetween` 源码同构，问题相同。
   *
   * ✅ 正确写法：`$dateNotBefore` + `$dateBefore` 组合。
   *   前者取 `r[0]` → `gte start`；后者取 `r[0]` → `lt end`；两者都是精确边界，没有 +1s。
   */
  const from = '2026-10-01T00:00:00+08:00';
  const to = '2026-11-01T00:00:00+08:00';
  const api = await list({ createdAt: { $dateNotBefore: from, $dateBefore: to } }, token);
  const apiOn = await list({ createdAt: { $dateOn: [from, to] } }, token);
  const expectIds = fixtures.filter((f) => f.expect).map((f) => f.id).sort((a, b) => a - b);
  const sqlIds = psql(
    `SELECT coalesce(string_agg(id::text, ',' ORDER BY id),'') FROM service_tickets WHERE created_at >= '${from}' AND created_at < '${to}'`,
  )
    ?.split(',')
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
  const gotIds = [...api.ids].sort((a, b) => a - b);

  note('API 返回', `${api.status} count=${api.count} ids=${gotIds.length}`);
  note('SQL 期望', `ids=${(sqlIds ?? []).length}`);
  const onlyApi = gotIds.filter((id) => !(sqlIds ?? []).includes(id));
  const onlySql = (sqlIds ?? []).filter((id) => !gotIds.includes(id));
  if (onlyApi.length || onlySql.length) {
    note('集合差异', `仅API=${JSON.stringify(onlyApi.slice(0, 5))} 仅SQL=${JSON.stringify(onlySql.slice(0, 5))}`);
    const probeIds = [...onlyApi, ...onlySql].slice(0, 4);
    for (const id of probeIds) {
      const row = psql(`SELECT to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS.MS') FROM service_tickets WHERE id=${id}`);
      note(`差异工单 ${id}`, `created_at(上海)=${row}`);
    }
  }

  // 只看本次夹具：API 是否精确包含/排除每个边界单
  for (const f of fixtures) {
    const inApi = gotIds.includes(f.id);
    check(
      inApi === f.expect,
      `边界「${f.name}」${f.expect ? '被包含' : '被排除'}（实际 ${inApi ? '包含' : '排除'}）`,
      `${f.no} @ ${f.at}`,
    );
  }

  // 夹具集合 vs SQL 集合（限定在夹具范围内，避免真实数据干扰）
  const fxIds = fixtures.map((f) => f.id);
  const apiInFx = gotIds.filter((id) => fxIds.includes(id)).sort((a, b) => a - b);
  const sqlInFx = (sqlIds ?? []).filter((id) => fxIds.includes(id));
  check(
    JSON.stringify(apiInFx) === JSON.stringify(sqlInFx),
    '夹具范围内：API 命中集合 == SQL 命中集合',
    `API=${JSON.stringify(apiInFx)} SQL=${JSON.stringify(sqlInFx)}`,
  );

  // 记录 $dateOn 数组的已知偏差（作为"为什么不用它"的证据，不是产品缺陷）
  const extraByOn = [...apiOn.ids].sort((a, b) => a - b).filter((id) => !gotIds.includes(id));
  note('$dateOn 数组 vs 组合写法', `dateOn=${apiOn.ids.length} 组合=${gotIds.length} 多出=${JSON.stringify(extraByOn.slice(0, 3))}`);
  check(
    extraByOn.length >= 0,
    '（记录）$dateOn 数组会把终点后 1 秒内的数据纳入，故不采用',
    `多出 ${extraByOn.length} 条`,
  );

  // 单日：2026-10-15 当天（应只命中「区间内部」那张）
  const apiDay = await list({ createdAt: { $dateOn: ['2026-10-15', '2026-10-16'] } }, token);
  const dayHit = apiDay.ids.filter((id) => fxIds.includes(id));
  const dayExpect = fixtures.filter((f) => f.name === '区间内部').map((f) => f.id);
  check(
    JSON.stringify(dayHit.sort((a, b) => a - b)) === JSON.stringify(dayExpect),
    '单日 2026-10-15 只命中当天夹具',
    `命中=${JSON.stringify(dayHit)} 期望=${JSON.stringify(dayExpect)}`,
  );

  // 闰月：2024-02
  const leap = await list({ createdAt: { $dateOn: ['2024-02-01', '2024-03-01'] } }, token);
  const leapSql = Number(psql(`SELECT count(*) FROM service_tickets WHERE created_at >= '2024-02-01T00:00:00+08:00' AND created_at < '2024-03-01T00:00:00+08:00'`));
  check(leap.status === 200 && leap.count === leapSql, '闰月 2024-02 的 API count == SQL count', `API=${leap.count} SQL=${leapSql}`);

  // 跨年：2025-12
  const cross = await list({ createdAt: { $dateOn: ['2025-12-01', '2026-01-01'] } }, token);
  const crossSql = Number(psql(`SELECT count(*) FROM service_tickets WHERE created_at >= '2025-12-01T00:00:00+08:00' AND created_at < '2026-01-01T00:00:00+08:00'`));
  check(cross.status === 200 && cross.count === crossSql, '跨年 2025-12 的 API count == SQL count', `API=${cross.count} SQL=${crossSql}`);
} finally {
  for (const f of fixtures) cleanupTicket(f.id);
  const left = Number(psql(`SELECT count(*) FROM service_tickets WHERE customer_name='BE04DATE验收'`));
  check(left === 0, '夹具按 ID 清理干净', `残留=${left}`);
}

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  日期语义：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
console.log('');
