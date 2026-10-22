/**
 * verify-be01-phone-policy.mjs —— 后台手机号展示策略（2026-10-20 新规则）
 *
 * 🔴 规则变更说明（不是"测试被删"）：
 *   2026-10-19 的要求是「viewer 看到 `138****8888`」，对应旧门禁 `verify-be01-s0-permissions.mjs`
 *   里"无完整手机号 / 有掩码值"这两组断言。
 *   2026-10-20 用户裁决：**内部售后平台，授权人员查看完整手机号是正常业务**，后台不再默认脱敏。
 *   ⇒ 旧断言与现行产品规则冲突，已改为"**必须是完整号码**"（旧文件保留 + 文件头注明）。
 *
 * 本门禁覆盖用户列出的 12 条：
 *  ① 门店看本店完整客户号 ② 门店看本店师傅完整号 ③ 门店看不到别店
 *  ④ 总部售后完整号 ⑤ 总部管理员完整号 ⑥ viewer 完整号
 *  ⑦ viewer 写仍 403 ⑧ viewer 界面无写按钮
 *  ⑨ 客户 H5 凭证不变 ⑩ 未登录不得读集合
 *  ⑪ list 与 get 一致 ⑫ 电话筛选不被破坏
 *  另：敏感资源仍拒绝（users/roles/envVars）。
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';
import { acceptAndDispatch, cleanupTicket, createScratchTicket, envValue } from './technician-harness.mjs';
import { storeEntryQuery } from './lib/store-entry-token.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const CUSTOMER = '13800005555';
const TECH = '13900003333';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};
const note = (label, detail = '') => console.log(`  ·  ${label}${detail ? `：${detail}` : ''}`);

const psql = (sql) =>
  execFileSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  ).trim();

async function signIn(account, password) {
  const r = await fetch(`${BASE}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  const j = await r.json().catch(() => null);
  return j?.data?.token ?? null;
}
async function call(p, { token, method = 'GET', body } = {}) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-Request-Id': crypto.randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, text };
}
const has = (text, v) => String(text).includes(v);
const masked = (text) => /1[3-9]\d\*{4}\d{4}/.test(String(text));

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  BE-01 号码展示策略：四角色完整号码 + 隔离 + 只读');
console.log('══════════════════════════════════════════════════════════════');

const admin = await signIn(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), envValue('UAT_HQADMIN_PASSWORD'));
const hq = await signIn('uat.hq@svc.local', envValue('UAT_HQ_PASSWORD'));
const viewer = await signIn('uat.viewer@svc.local', envValue('UAT_VIEWER_PASSWORD'));
const store = await signIn(envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'), envValue('UAT_STORE_A_PASSWORD'));

const fx = await createScratchTicket({ tag: 'BE01PHONE', content: '号码策略夹具' });
psql(`UPDATE service_tickets SET customer_mobile='${CUSTOMER}' WHERE id=${fx.ticketId}`);
await acceptAndDispatch(fx.ticketId, admin, { technician_name: '号码验证师', technician_mobile: TECH });
await sleep(500);
const visitId = psql(`SELECT id FROM service_visits WHERE ticket_id=${fx.ticketId} ORDER BY visit_no DESC LIMIT 1`);
const storeId = psql(`SELECT store_id FROM service_tickets WHERE id=${fx.ticketId}`);
note('夹具', `${fx.ticketNo} · ticket=${fx.ticketId} · visit=${visitId} · store=${storeId}`);

try {
  const ticketUrl = `/api/serviceTickets:list?pageSize=1&filter[id]=${fx.ticketId}&fields=id,customer_mobile,technician_mobile,store_id`;
  const getUrl = `/api/serviceTickets:get?filterByTk=${fx.ticketId}&fields=id,customer_mobile,technician_mobile,store_id`;

  // ① 门店：本店完整客户号 + 师傅号
  const sList = await call(ticketUrl, { token: store });
  check(sList.status === 200 && has(sList.text, CUSTOMER), '① 门店可看本店**完整客户手机号**', `HTTP ${sList.status} 含号=${has(sList.text, CUSTOMER)}`);
  check(has(sList.text, TECH), '② 门店可看本店**完整师傅手机号**', `含号=${has(sList.text, TECH)}`);
  const sVisits = await call(`/api/serviceVisits:list?pageSize=3&filter[ticket_id]=${fx.ticketId}`, { token: store });
  check(has(sVisits.text, TECH), '② 门店在**派工记录**里也看到完整师傅号', `HTTP ${sVisits.status}`);

  // ③ 门店隔离：列表全部行属于单店
  const sAll = await call('/api/serviceTickets:list?pageSize=50&fields=id,store_id', { token: store });
  const storeIds = [...new Set((JSON.parse(sAll.text)?.data ?? []).map((x) => x.store_id).filter(Boolean))];
  check(sAll.status === 200 && storeIds.length <= 1, '③ 门店列表只含本店（数据范围未变）', JSON.stringify(storeIds));

  // ④⑤⑥ 总部 / 管理员 / viewer
  for (const [label, token] of [['总部售后', hq], ['总部管理员', admin], ['viewer', viewer]]) {
    const r = await call(ticketUrl, { token });
    check(
      r.status === 200 && has(r.text, CUSTOMER) && has(r.text, TECH),
      `④⑤⑥ ${label} 看到**完整**客户+师傅手机号`,
      `HTTP ${r.status} 客户=${has(r.text, CUSTOMER)} 师傅=${has(r.text, TECH)}`,
    );
  }

  // ⑦ viewer 写仍拒绝
  for (const [name, path, body] of [
    ['followUp', `/api/svc:followUp?filterByTk=${fx.ticketId}`, { note: '越权探针' }],
    ['internalNote', `/api/svc:internalNote?filterByTk=${fx.ticketId}`, { note: '越权探针' }],
    ['update', `/api/serviceTickets:update?filterByTk=${fx.ticketId}`, { content: '越权探针' }],
  ]) {
    const r = await call(path, { token: viewer, method: 'POST', body });
    check(r.status === 403 || r.status === 404, `⑦ viewer 写动作 ${name} 仍被服务端拒绝`, `HTTP ${r.status}`);
  }

  // ⑨ 客户 H5 凭证不变：无签名入口被拒
  const badEntry = await call('/api/public/store-entry?k=S01.' + 'A'.repeat(22));
  check(badEntry.status >= 400 && badEntry.status < 500, '⑨ 客户 H5 入口签名校验仍然生效（未被号码策略影响）', `HTTP ${badEntry.status}`);

  // ⑩ 未登录不得读集合
  const anon = await call(ticketUrl);
  check([401, 403].includes(anon.status), '⑩ 未登录不能通过后台集合接口读工单', `HTTP ${anon.status}`);

  // ⑪ list 与 get 一致
  const g = await call(getUrl, { token: viewer });
  check(
    g.status === 200 && has(g.text, CUSTOMER) && has(g.text, TECH) && !masked(g.text),
    '⑪ 列表与详情的号码展示一致（都是完整号，无掩码）',
    `HTTP ${g.status} 掩码=${masked(g.text)}`,
  );

  // ⑫ 电话筛选仍可用
  const byPhone = await call(
    `/api/serviceTickets:list?pageSize=5&filter[customer_mobile]=${CUSTOMER}&fields=id,customer_mobile`,
    { token: hq },
  );
  const cnt = JSON.parse(byPhone.text)?.meta?.count ?? -1;
  check(byPhone.status === 200 && cnt >= 1, '⑫ 按手机号筛选仍然可用（未被脱敏破坏）', `count=${cnt}`);

  // 敏感资源仍拒绝
  for (const [name, url] of [
    ['users', '/api/users:list?pageSize=1'],
    ['roles', '/api/roles:list?pageSize=1'],
    ['environmentVariables', '/api/environmentVariables:list?pageSize=1'],
  ]) {
    const r = await call(url, { token: viewer });
    check([401, 403, 404].includes(r.status), `敏感资源 ${name} 仍被拒绝（未因放开号码而扩大权限）`, `HTTP ${r.status}`);
  }

  // ⑧ viewer 界面无写按钮
  const session = await launchCdp({ port: 9502, label: 'be01-phone' });
  const { cdp } = session;
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Network.clearBrowserCookies');
    await cdp.send('Page.navigate', { url: `${BASE}/signin` });
    await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页', timeout: 30_000 });
    await cdp.evaluate(`(() => {
      const ins = [...document.querySelectorAll('input')];
      const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; d.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      set(ins[0], 'uat.viewer@svc.local'); set(ins[1], ${JSON.stringify(envValue('UAT_VIEWER_PASSWORD'))});
      return true;
    })()`);
    await sleep(600);
    await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
    await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 60_000 });
    await sleep(3000);
    const dom = await cdp.evaluate(`(() => {
      const vis = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetParent !== null; };
      const nodes = [...document.querySelectorAll('button, .ant-btn, [role="button"]')].filter(vis);
      const labels = nodes.map((b) => (b.innerText || '').replace(/\\s+/g, '').trim()).filter(Boolean);
      const write = labels.filter((t) => ['处理', '跟进', '新建服务单', '编辑', '删除'].includes(t));
      return { write, sample: labels.slice(0, 8), fullMobile: (document.body.innerText.match(/1[3-9]\\d{9}/g) || []).length };
    })()`);
    check(dom.write.length === 0, '⑧ viewer 界面无写按钮', JSON.stringify(dom.write));
    check(dom.fullMobile > 0, '⑥ viewer 页面上确实显示完整手机号（不是掩码）', `页面完整号码×${dom.fullMobile}`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    (await import('node:fs')).writeFileSync('.tmp-verify/be01-phone-viewer.png', Buffer.from(shot.data, 'base64'));
  } finally {
    session.close();
  }
} finally {
  cleanupTicket(fx.ticketId);
  const left = Number(psql(`SELECT count(*) FROM service_tickets WHERE id=${fx.ticketId}`));
  check(left === 0, '夹具按 ID 清理干净', `残留 ${left}`);
}

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  BE-01 号码策略：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
console.log('');
