/**
 * 适配层契约验证（直连本地 NocoBase，用真实数据）
 *
 * 目的：**在写界面之前**先证明适配器对接口的理解是对的。
 *   如果等到界面写完再发现"字段名猜错了"，
 *   排查时会误以为是渲染问题（因为界面确实显示了、只是显示错了）。
 */
import fs from 'node:fs';
import path from 'node:path';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = 'https://127.0.0.1';

const results = [];
function ck(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  <- ' + detail : ''}`);
}

async function signIn(account, password) {
  const r = await fetch(`${BASE}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  if (!r.ok) throw new Error(`signIn ${r.status}`);
  return (await r.json()).data.token;
}

function api(token, p, opt = {}) {
  return fetch(BASE + p, {
    method: opt.method || 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(opt.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opt.headers || {}),
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
}

const q = (o) => encodeURIComponent(JSON.stringify(o));

console.log('\n== 适配层契约验证（真实数据） ==\n');

// 用店长账号：它既能看工单（只读），又能验证"只读角色"的错误路径
const tok = await signIn('arc1_mgr_a', 'Arc1#2026-Dev');
console.log('已登录：arc1_mgr_a (store_manager)\n');

// ---------- 1. 工单列表 + meta.count ----------
const listRes = await api(tok, `/api/serviceTickets:list?page=1&pageSize=5&fields=id,ticket_no,status&sort=-created_at`);
ck('serviceTickets:list 返回 200', listRes.status === 200, `status=${listRes.status}`);
const rows = listRes.json?.data ?? [];
ck('列表有数据行', Array.isArray(rows) && rows.length > 0, `rows=${rows.length}`);
ck('meta.count 存在（状态计数的唯一来源）', typeof listRes.json?.meta?.count === 'number',
   `count=${listRes.json?.meta?.count}`);
ck('fields 白名单生效（不含手机号）', rows.every((r) => !('customer_mobile' in r)),
   `keys=${Object.keys(rows[0] ?? {}).join(',')}`);

// ---------- 2. 状态大小写双写 ----------
// 只查大写 NEW
const onlyUpper = await api(tok, `/api/serviceTickets:list?pageSize=1&filter=${q({ status: 'NEW' })}`);
// 双写
const both = await api(tok, `/api/serviceTickets:list?pageSize=1&filter=${q({ $or: [{ status: 'NEW' }, { status: 'new' }] })}`);
const cUpper = onlyUpper.json?.meta?.count ?? -1;
const cBoth = both.json?.meta?.count ?? -1;
ck('状态双写能多查出小写 new 的记录（证明脏数据真实存在）', cBoth > cUpper,
   `NEW=${cUpper}  NEW+new=${cBoth}  差=${cBoth - cUpper}`);
ck('差值正好是实测的 4 条', cBoth - cUpper === 4, `差=${cBoth - cUpper}`);

// ---------- 3. 关键词搜索 ----------
const kw = await api(tok, `/api/serviceTickets:list?pageSize=3&filter=${q({ $or: [{ ticket_no: { $includes: 'FW2026' } }] })}`);
ck('关键词 $includes 搜索可用', kw.status === 200 && (kw.json?.meta?.count ?? 0) > 0,
   `count=${kw.json?.meta?.count}`);

// ---------- 4. 工单详情（svc:timeline） ----------
const anyId = rows[0]?.id;
const tl = await api(tok, `/api/svc:timeline?filterByTk=${anyId}&pageSize=50`);
ck('svc:timeline 返回 200', tl.status === 200, `status=${tl.status}`);
const tlData = tl.json?.data ?? {};
ck('timeline 含 ticket 字段', !!tlData.ticket?.id, `ticket.id=${tlData.ticket?.id}`);
ck('timeline 含 events 数组', Array.isArray(tlData.events), `events=${tlData.events?.length ?? 'null'}`);
ck('timeline 含 sms 数组', Array.isArray(tlData.sms), `sms=${tlData.sms?.length ?? 'null'}`);
console.log(`     ticket 字段数：${Object.keys(tlData.ticket ?? {}).length}`);
const sensitive = ['feedback_token_hash', 'progress_token_hash', 'progress_code_hash', 'progress_code_salt'];
const leaked = sensitive.filter((k) => k in (tlData.ticket ?? {}));
ck('DTO 不含任何 token 凭据列', leaked.length === 0, leaked.join(',') || 'none');

// ---------- 5. 只读角色尝试写（应被拒） ----------
const reqId = crypto.randomUUID();
const writeTry = await api(tok, `/api/svc:accept?filterByTk=${anyId}`, {
  method: 'POST', body: {}, headers: { 'X-Request-Id': reqId },
});
ck('store_manager 受理工单被服务端拒绝（只读角色）',
   writeTry.status === 403 || writeTry.status === 404,
   `status=${writeTry.status} code=${writeTry.json?.errors?.[0]?.code ?? '-'}`);

// ---------- 6. 缺 X-Request-Id 的行为 ----------
const noReqId = await api(tok, `/api/svc:accept?filterByTk=${anyId}`, { method: 'POST', body: {} });
ck('缺 X-Request-Id 会被拒（证明该头是硬要求，不是可选）',
   noReqId.status === 422 || noReqId.status === 400,
   `status=${noReqId.status} code=${noReqId.json?.errors?.[0]?.code ?? '-'}`);

// ---------- 7. 越权/不存在统一 404 ----------
const notExist = await api(tok, `/api/svc:timeline?filterByTk=999999999`);
ck('不存在的工单统一 404（不泄露存在性）', notExist.status === 404, `status=${notExist.status}`);

// ---------- 8. 服务档案列表 ----------
const arch = await api(tok, `/api/serviceArchives:list?pageSize=3&sort=-id`);
ck('serviceArchives:list 返回 200', arch.status === 200, `status=${arch.status}`);
ck('档案列表不含 storage_key', (arch.json?.data ?? []).every((r) => !('storage_key' in r)),
   `keys=${Object.keys((arch.json?.data ?? [])[0] ?? {}).slice(0, 8).join(',')}`);

// ---------- 9. 阶段（via 两跳） ----------
const firstArch = (arch.json?.data ?? [])[0];
if (firstArch) {
  const stages = await api(tok, `/api/serviceArchiveStages:list?pageSize=10&filter=${q({ archive_id: firstArch.id })}`);
  ck('serviceArchiveStages:list 可用', stages.status === 200, `status=${stages.status} rows=${stages.json?.data?.length}`);
}

// ---------- 10. 匿名摘要查询（真实号码） ----------
const pub = await fetch(`${BASE}/api/publicArchive:queryByMobile`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mobile: '13585258888' }),
});
const pubJson = await pub.json().catch(() => null);
ck('匿名摘要查询可用（200）', pub.status === 200, `status=${pub.status}`);
ck('摘要只含 groups/mobile_masked/total 三个键',
   JSON.stringify(Object.keys(pubJson?.data ?? {}).sort()) === JSON.stringify(['groups', 'mobile_masked', 'total']),
   Object.keys(pubJson?.data ?? {}).join(','));
ck('摘要无任何客户姓名/地址/工单号',
   !JSON.stringify(pubJson).match(/customer_name|service_address|archive_no|工单/),
   'clean');

// 写证据
const outDir = path.resolve('.tmp-verify/mobile-api');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'contract.json'), JSON.stringify({
  at: new Date().toISOString(),
  listCount: listRes.json?.meta?.count,
  statusNewUpper: cUpper,
  statusNewBoth: cBoth,
  timelineFieldCount: Object.keys(tlData.ticket ?? {}).length,
  results,
}, null, 2));

const fails = results.filter((r) => !r.ok);
console.log(`\n结论：${fails.length === 0 ? '全部 PASS' : 'FAIL ' + fails.map((f) => f.name).join(' | ')}`);
console.log(`共 ${results.length} 项，通过 ${results.length - fails.length} 项`);
process.exit(fails.length === 0 ? 0 : 1);
