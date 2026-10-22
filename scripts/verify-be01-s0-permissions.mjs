/**
 * verify-be01-s0-permissions.mjs —— BE-01-S0 只读角色权限与敏感数据收口
 *
 * 判据（对应用户 2026-10-20 指令）：
 *   ① viewer 列表 / 详情 / 关联资源（serviceVisits）都拿不到完整手机号，且返回**掩码值**；
 *   ② viewer 的写动作由**服务端**拒绝（403），不是靠前端隐藏；
 *   ③ viewer 对 users/roles/collections/environmentVariables/导出 一律拒绝；
 *   ④ viewer 仍可看聚合（dashboardSummary 200），不被"一刀切封死"；
 *   ⑤ hq_after_sales / hq_admin 的手机号语义**不变**（不误伤）；
 *   ⑥ store_after_sales 仍按门店隔离（列表只含本店）；
 *   ⑦ viewer 界面无「处理 / 跟进」写按钮（浏览器）。
 *
 * 反向验证：移除 `native-sensitive-field-guard` 注册后，①② 必须变红。
 *
 * 🔴 2026-10-20 规则变更（**不是删测试**）：
 *   2026-10-19 的要求是「viewer 只能看到掩码手机号」，本文件当时断言"无完整号 / 有掩码"。
 *   2026-10-20 用户裁决：内部售后平台，授权人员查看完整手机号是正常业务 ⇒ 后台不再脱敏。
 *   因此 ① 组的两条断言改为「**必须是完整手机号 / 不再出现掩码**」；
 *   写 403、敏感资源拒绝、门店隔离、按钮隐藏等**安全断言全部保留不变**。
 *   新规则下的完整验收见 `verify-be01-phone-policy.mjs`。
 */
import crypto from 'node:crypto';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';
import {
  acceptAndDispatch,
  cleanupTicket,
  createScratchTicket,
  envValue,
} from './technician-harness.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};
const note = (label, detail = '') => console.log(`  ·  ${label}${detail ? `：${detail}` : ''}`);

async function signIn(account, password) {
  const r = await fetch(`${BASE}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  const j = await r.json().catch(() => null);
  return j?.data?.token ?? null;
}

async function call(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-Request-Id': crypto.randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: r.status, json, text };
}

const FULL_MOBILE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const MASKED = /1[3-9]\d\*{4}\d{4}/;

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  BE-01-S0：viewer 只读与敏感数据收口');
console.log('══════════════════════════════════════════════════════════════');

const hqAdmin = await signIn(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), envValue('UAT_HQADMIN_PASSWORD'));
const hq = await signIn('uat.hq@svc.local', envValue('UAT_HQ_PASSWORD'));
const viewer = await signIn('uat.viewer@svc.local', envValue('UAT_VIEWER_PASSWORD'));
const store = await signIn(envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'), envValue('UAT_STORE_A_PASSWORD'));
check(Boolean(viewer), 'viewer 账号可登录（前置）', String(Boolean(viewer)));

const fx = await createScratchTicket({ tag: 'BE01S0', content: '权限收口夹具' });
note('夹具工单', `${fx.ticketNo}（id=${fx.ticketId}）`);
// 派工，确保 Visit 上有真实 technician_mobile
await acceptAndDispatch(fx.ticketId, hqAdmin, {
  technician_name: '收口验证师',
  technician_mobile: '13900018888',
});
const visitId = Number(
  (await call(`/api/serviceVisits:list?pageSize=1&filter[ticket_id]=${fx.ticketId}`, { token: hqAdmin })).json?.data?.[0]?.id ?? 0,
);
note('夹具派工', `visit=${visitId}`);

try {
  // ---------------------------------------------------------------- ① 读路径
  const listRes = await call(
    `/api/serviceTickets:list?pageSize=1&filter[id]=${fx.ticketId}&fields=id,ticket_no,customer_mobile,technician_mobile`,
    { token: viewer },
  );
  const getRes = await call(
    `/api/serviceTickets:get?filterByTk=${fx.ticketId}&fields=id,ticket_no,customer_mobile,technician_mobile`,
    { token: viewer },
  );
  const visitsRes = await call(`/api/serviceVisits:list?pageSize=5&filter[ticket_id]=${fx.ticketId}`, { token: viewer });

  for (const [name, res] of [['列表 list', listRes], ['详情 get', getRes], ['关联 serviceVisits', visitsRes]]) {
    check(res.status === 200, `① viewer ${name} 仍可访问（不封死只读）`, `HTTP ${res.status}`);
    // 2026-10-20 新规则：后台授权角色看完整号码（旧断言"无完整号/有掩码"已废止）
    check(FULL_MOBILE.test(res.text), `①（新规则）viewer ${name} 返回**完整手机号**`, res.text.slice(0, 140));
    check(!MASKED.test(res.text), `①（新规则）viewer ${name} **不再出现掩码**`, (res.text.match(MASKED) ?? [''])[0]);
  }

  // ---------------------------------------------------------------- ② 写动作
  const writes = [
    ['followUp', `/api/svc:followUp?filterByTk=${fx.ticketId}`, { note: '越权探针' }],
    ['internalNote', `/api/svc:internalNote?filterByTk=${fx.ticketId}`, { note: '越权探针' }],
    ['update', `/api/serviceTickets:update?filterByTk=${fx.ticketId}`, { content: '越权探针' }],
  ];
  for (const [name, path, body] of writes) {
    const r = await call(path, { method: 'POST', token: viewer, body });
    check(r.status === 403 || r.status === 404, `② viewer 写动作 ${name} 由**服务端**拒绝`, `HTTP ${r.status}`);
  }

  // ---------------------------------------------------------------- ③ 敏感资源
  const denied = [
    ['users', '/api/users:list?pageSize=1'],
    ['roles', '/api/roles:list?pageSize=1'],
    ['collections', '/api/collections:list?pageSize=1'],
    ['environmentVariables', '/api/environmentVariables:list?pageSize=1'],
    ['exportTickets', `/api/svc:exportTickets?filterByTk=${fx.ticketId}`],
  ];
  for (const [name, path] of denied) {
    const r = await call(path, { token: viewer });
    check(r.status === 403 || r.status === 404, `③ viewer 访问 ${name} 被拒绝`, `HTTP ${r.status}`);
  }

  // ---------------------------------------------------------------- ④ 聚合可用
  const dash = await call('/api/svc:dashboardSummary', { token: viewer });
  check(dash.status === 200, '④ viewer 仍可使用聚合看板（未被一刀切）', `HTTP ${dash.status}`);
  check(!FULL_MOBILE.test(dash.text), '④ 聚合响应不含手机号', '');

  // ---------------------------------------------------------------- ⑤ 不误伤总部
  for (const [name, token] of [['hq_after_sales', hq], ['hq_admin', hqAdmin]]) {
    const r = await call(
      `/api/serviceTickets:list?pageSize=1&filter[id]=${fx.ticketId}&fields=id,technician_mobile,customer_mobile`,
      { token },
    );
    check(r.status === 200 && FULL_MOBILE.test(r.text), `⑤ ${name} 仍能读到完整号码（业务需要，未被误伤）`, `HTTP ${r.status}`);
  }

  // ---------------------------------------------------------------- ⑥ 门店隔离
  const storeList = await call('/api/serviceTickets:list?pageSize=20&fields=id,store_id,ticket_no', { token: store });
  const storeIds = [...new Set((storeList.json?.data ?? []).map((x) => x?.store_id).filter(Boolean))];
  check(storeList.status === 200, '⑥ 门店账号可读本店列表', `HTTP ${storeList.status}`);
  check(storeIds.length <= 1, '⑥ 门店列表只含**一个**门店（本店）', JSON.stringify(storeIds));

  // ---------------------------------------------------------------- ⑦ 浏览器按钮
  const session = await launchCdp({ port: 9497, label: 'be01s0-viewer' });
  const { cdp } = session;
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Network.clearBrowserCookies');
    await cdp.send('Page.navigate', { url: `${BASE}/signin` });
    await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页', timeout: 30_000 });
    await cdp.evaluate(`(() => {
      const ins = [...document.querySelectorAll('input')];
      const setVal = (el, val) => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setVal(ins[0], 'uat.viewer@svc.local');
      setVal(ins[1], ${JSON.stringify(envValue('UAT_VIEWER_PASSWORD'))});
      return true;
    })()`);
    await sleep(600);
    await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
    await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 60_000 });
    await sleep(2500);

    // ⚠️ 判据必须是**可见性**，不能只看 innerText：
    //    `display:none` 的元素按规范会退回 textContent，innerText 仍然有字 ——
    //    第一版就是这么误判成"按钮还在"的（假红）。
    const dom = await cdp.evaluate(`(() => {
      const isVisible = (el) => {
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetParent !== null;
      };
      const nodes = [...document.querySelectorAll('button, .ant-btn, [role="button"]')];
      const visible = nodes.filter(isVisible).map((b) => (b.innerText || '').replace(/\s+/g, '').trim()).filter(Boolean);
      const writeBtns = visible.filter((t) => ['处理', '跟进', '新建服务单', '编辑', '删除'].includes(t));
      return { title: document.title, writeBtns, all: visible.slice(0, 24), hiddenCount: nodes.length - visible.length };
    })()`);
    check(dom.writeBtns.length === 0, '⑦ viewer 界面**无写按钮**（处理/跟进/新建/编辑/删除）', JSON.stringify(dom.writeBtns));
    note('viewer 页面', `${dom.title} · 按钮 ${JSON.stringify(dom.all.slice(0, 10))}`);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const fs = await import('node:fs');
    fs.writeFileSync('.tmp-verify/be01s0-viewer.png', Buffer.from(shot.data, 'base64'));
  } finally {
    session.close();
  }
} finally {
  cleanupTicket(fx.ticketId);
  const left = Number(
    (await call(`/api/serviceTickets:list?pageSize=1&filter[id]=${fx.ticketId}`, { token: hqAdmin })).json?.data?.length ?? 0,
  );
  check(left === 0, '夹具按 ID 清理干净', `残留 ${left}`);
}

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  BE-01-S0：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
console.log('');
