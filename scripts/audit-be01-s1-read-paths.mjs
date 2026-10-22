/**
 * audit-be01-s1-read-paths.mjs —— BE-01-S1 读取路径与敏感字段完整性审计
 *
 * 用**合成夹具**（13800001111 / 13900002222）贯穿，确保"漏了能看见"：
 *   ① viewer 的 5 个 ACL 资源 × list/get/view；
 *   ② appends 关联展开（visits / events / store / ticket）；
 *   ③ fields / except 字段投影；
 *   ④ 聚合、导出、附件元数据；
 *   ⑤ 非规范号码格式（+86 / 空格 / 短横线 / 座机 / 空 / 垃圾）；
 *   ⑥ 前端角色时序（首登 / 切页 / 刷新 / 重登 / 重渲染）。
 *
 * ⚠️ 只改**自建夹具**的字段；真实工单一律不碰。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';
import { acceptAndDispatch, cleanupTicket, createScratchTicket, envValue } from './technician-harness.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const OUT = path.join(process.cwd(), '.tmp-verify');
fs.mkdirSync(OUT, { recursive: true });

const CUSTOMER = '13800001111';
const TECH = '13900002222';
const results = [];
const record = (row) => {
  results.push(row);
  const flag = row.verdict === 'LEAK' ? '🔴' : row.verdict === 'MASKED' ? '🟢' : row.verdict === 'DENIED' ? '⚪' : '🟡';
  console.log(`  ${flag} ${row.resource.padEnd(16)} ${String(row.action).padEnd(6)} ${String(row.status).padEnd(4)} ${row.verdict}${row.detail ? `  ${row.detail}` : ''}`);
};

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
async function call(p, { token, method = 'GET' } = {}) {
  const r = await fetch(`${BASE}${p}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const text = await r.text();
  return { status: r.status, text };
}

const hitsOf = (text, needle) => (String(text).match(new RegExp(needle, 'g')) ?? []).length;

/** 响应里的号码被掩码成什么样（取第一个 * 号模式） */
const maskedOf = (text) => (String(text).match(/\d{3}\*{4}\d{4}/) ?? [''])[0];

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  BE-01-S1：viewer 读取路径完整性审计');
console.log('══════════════════════════════════════════════════════════════');

const admin = await signIn(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), envValue('UAT_HQADMIN_PASSWORD'));
const viewer = await signIn('uat.viewer@svc.local', envValue('UAT_VIEWER_PASSWORD'));
if (!admin || !viewer) {
  console.log('⛔ 登录失败');
  process.exit(2);
}

const fx = await createScratchTicket({ tag: 'BE01S1', content: '读取路径审计夹具' });
psql(`UPDATE service_tickets SET customer_mobile='${CUSTOMER}' WHERE id=${fx.ticketId}`);
await acceptAndDispatch(fx.ticketId, admin, { technician_name: '审计师傅', technician_mobile: TECH });
await sleep(1500);

const visitId = psql(`SELECT id FROM service_visits WHERE ticket_id=${fx.ticketId} ORDER BY visit_no DESC LIMIT 1`);
const eventCount = psql(`SELECT count(*) FROM ticket_events WHERE ticket_id=${fx.ticketId}`);
const smsCount = psql(`SELECT count(*) FROM sms_logs WHERE ticket_id=${fx.ticketId}`);
console.log(`  夹具 ${fx.ticketNo}（ticket=${fx.ticketId}, visit=${visitId}, events=${eventCount}, sms=${smsCount}）`);

try {
  // ─────────────────────────────────────────── ① 5 资源 × list/get/view
  console.log('\n── ① viewer ACL 资源 × 只读动作 ─────────────────────');
  const resources = [
    ['serviceTickets', fx.ticketId],
    ['serviceVisits', visitId],
    ['smsLogs', null],
    ['stores', null],
    ['ticketEvents', null],
  ];
  for (const [resource, id] of resources) {
    const q = id ? `filterByTk=${id}` : 'pageSize=2';
    const list = await call(`/api/${resource}:list?pageSize=2`, { token: viewer });
    const get = await call(`/api/${resource}:get?${q}&pageSize=1`, { token: viewer });
    const view = await call(`/api/${resource}:view?${q}&pageSize=1`, { token: viewer });
    for (const [action, res] of [['list', list], ['get', get], ['view', view]]) {
      if (res.status >= 400) {
        record({ resource, action, status: res.status, verdict: 'DENIED', detail: res.text.slice(0, 60) });
        continue;
      }
      const full = hitsOf(res.text, `(?<!\\d)(${CUSTOMER}|${TECH})(?!\\d)`);
      record({
        resource,
        action,
        status: res.status,
        verdict: full > 0 ? 'LEAK' : 'MASKED',
        detail: full > 0 ? `完整号码×${full}` : maskedOf(res.text) || '无号码字段',
      });
    }
  }

  // ─────────────────────────────────────────── ② appends 关联展开
  console.log('\n── ② 关联展开（appends）────────────────────────────');
  const appendsCases = [
    ['serviceTickets', 'appends=visits', '/api/serviceTickets:list?pageSize=1&filter[id]=' + fx.ticketId + '&appends=visits', 'visits'],
    ['serviceTickets', 'appends=events', '/api/serviceTickets:list?pageSize=1&filter[id]=' + fx.ticketId + '&appends=events', 'events'],
    ['serviceTickets', 'appends=store', '/api/serviceTickets:list?pageSize=1&filter[id]=' + fx.ticketId + '&appends=store', 'store'],
    ['serviceVisits', 'appends=ticket', '/api/serviceVisits:list?pageSize=1&filter[id]=' + visitId + '&appends=ticket', 'ticket'],
  ];
  for (const [resource, action, url, key] of appendsCases) {
    const res = await call(url, { token: viewer });
    const expanded = res.status === 200 && new RegExp(`"${key}"\\s*:`).test(res.text);
    const full = hitsOf(res.text, `(?<!\\d)(${CUSTOMER}|${TECH})(?!\\d)`);
    record({
      resource,
      action,
      status: res.status,
      verdict: full > 0 ? 'LEAK' : expanded ? 'MASKED' : 'NOT_EXPANDED',
      detail: full > 0 ? `关联内完整号码×${full}` : expanded ? '已展开且无明文' : '未展开（该关联不可用）',
    });
  }

  // ─────────────────────────────────────────── ③ fields / except
  console.log('\n── ③ 字段投影（fields / except）────────────────────');
  const projCases = [
    ['fields=双号', `/api/serviceTickets:list?pageSize=1&filter[id]=${fx.ticketId}&fields=customer_mobile,technician_mobile`],
    ['fields=*', `/api/serviceTickets:list?pageSize=1&filter[id]=${fx.ticketId}&fields=*`],
    ['except=tech', `/api/serviceTickets:list?pageSize=1&filter[id]=${fx.ticketId}&except=technician_mobile`],
    ['fields=主键+号', `/api/serviceTickets:get?filterByTk=${fx.ticketId}&fields=id,customer_mobile`],
  ];
  for (const [label, url] of projCases) {
    const res = await call(url, { token: viewer });
    const full = hitsOf(res.text, `(?<!\\d)(${CUSTOMER}|${TECH})(?!\\d)`);
    record({
      resource: 'serviceTickets',
      action: label,
      status: res.status,
      verdict: res.status >= 400 ? 'DENIED' : full > 0 ? 'LEAK' : 'MASKED',
      detail: full > 0 ? `完整×${full}` : maskedOf(res.text) || '无号码',
    });
  }

  // ─────────────────────────────────────────── ④ 聚合 / 导出 / 附件元数据
  console.log('\n── ④ 聚合 / 导出 / 附件 ────────────────────────────');
  const otherCases = [
    ['svc', 'dashboardSummary', '/api/svc:dashboardSummary'],
    ['svc', 'reportKpi', '/api/svc:reportKpi'],
    ['svc', 'exportTickets', `/api/svc:exportTickets?filterByTk=${fx.ticketId}`],
    ['serviceTickets', 'export(原生)', '/api/serviceTickets:export?pageSize=1'],
    ['customerMedias', 'list', '/api/customerMedias:list?pageSize=1'],
    ['serviceVisitPhotos', 'list', '/api/serviceVisitPhotos:list?pageSize=1'],
    ['attachments', 'list', '/api/attachments:list?pageSize=1'],
  ];
  for (const [resource, action, url] of otherCases) {
    const res = await call(url, { token: viewer });
    const full = hitsOf(res.text, `(?<!\\d)(${CUSTOMER}|${TECH})(?!\\d)`);
    record({
      resource,
      action,
      status: res.status,
      verdict: res.status >= 400 ? 'DENIED' : full > 0 ? 'LEAK' : 'OK_NO_PII',
      detail: res.status >= 400 ? res.text.slice(0, 50) : '无 PII',
    });
  }

  // ─────────────────────────────────────────── ⑤ 号码格式
  console.log('\n── ⑤ 非规范号码格式（改自建夹具）──────────────────');
  const variants = [
    ['标准 11 位', '13800001111'],
    ['+86 前缀', '+8613800001111'],
    ['带空格', '138 0000 1111'],
    ['带短横线', '138-0000-1111'],
    ['座机', '0731-88886666'],
    ['空值', ''],
    ['垃圾值', 'abc'],
  ];
  for (const [label, value] of variants) {
    psql(`UPDATE service_tickets SET customer_mobile='${value}' WHERE id=${fx.ticketId}`);
    const res = await call(`/api/serviceTickets:list?pageSize=1&filter[id]=${fx.ticketId}&fields=customer_mobile`, { token: viewer });
    const returned = (res.text.match(/"customer_mobile":("[^"]*"|null)/) ?? [])[1] ?? '(无)';
    const leaks = value && hitsOf(res.text, value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    record({
      resource: 'serviceTickets',
      action: `号码:${label}`,
      status: res.status,
      verdict: leaks > 0 ? 'LEAK' : 'MASKED',
      detail: `入参=${JSON.stringify(value)} 返回=${returned}`,
    });
  }
  psql(`UPDATE service_tickets SET customer_mobile='${CUSTOMER}' WHERE id=${fx.ticketId}`);

  // ─────────────────────────────────────────── ⑥ 前端时序
  console.log('\n── ⑥ 前端角色时序（viewer）────────────────────────');
  const session = await launchCdp({ port: 9501, label: 'be01s1-timing' });
  const { cdp } = session;
  try {
    const countWrite = async () =>
      cdp.evaluate(`(() => {
        const vis = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetParent !== null; };
        const nodes = [...document.querySelectorAll('button, .ant-btn, [role="button"]')].filter(vis);
        return nodes.map((b) => (b.innerText || '').replace(/\\s+/g, '').trim()).filter((t) => ['处理','跟进','新建服务单','编辑','删除'].includes(t)).length;
      })()`);

    const login = async () => {
      await cdp.send('Network.clearBrowserCookies');
      await cdp.evaluate(`(() => { localStorage.clear(); return true; })()`).catch(() => {});
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
    };

    await login();
    const first = await countWrite();
    record({ resource: 'UI', action: '首次登录', status: 200, verdict: first === 0 ? 'MASKED' : 'LEAK', detail: `可见写按钮=${first}` });

    await cdp.send('Page.reload');
    await sleep(3500);
    const afterReload = await countWrite();
    record({ resource: 'UI', action: '刷新', status: 200, verdict: afterReload === 0 ? 'MASKED' : 'LEAK', detail: `可见写按钮=${afterReload}` });

    const menu = await cdp.evaluate(`(() => { const a = [...document.querySelectorAll('aside a, .ant-menu-item')].find(x => (x.innerText||'').includes('工单事件时间线')); if (a) a.click(); return !!a; })()`);
    await sleep(2500);
    const afterNav = await countWrite();
    record({ resource: 'UI', action: '页面切换', status: 200, verdict: afterNav === 0 ? 'MASKED' : 'LEAK', detail: `切换=${menu} 可见写按钮=${afterNav}` });

    // 退出再登录
    await cdp.evaluate(`(() => { localStorage.removeItem('NOCOBASE_TOKEN'); localStorage.removeItem('NOCOBASE_ROLE'); return true; })()`);
    await cdp.send('Page.navigate', { url: `${BASE}/signin` });
    await sleep(1500);
    await login();
    const again = await countWrite();
    record({ resource: 'UI', action: '退出再登录', status: 200, verdict: again === 0 ? 'MASKED' : 'LEAK', detail: `可见写按钮=${again}` });

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, 'be01s1-viewer-timing.png'), Buffer.from(shot.data, 'base64'));
  } finally {
    session.close();
  }
} finally {
  cleanupTicket(fx.ticketId);
  const left = Number(psql(`SELECT count(*) FROM service_tickets WHERE id=${fx.ticketId}`));
  record({ resource: 'fixture', action: '清理', status: 200, verdict: left === 0 ? 'MASKED' : 'LEAK', detail: `残留=${left}` });
}

fs.writeFileSync(path.join(OUT, 'be01s1-matrix.json'), JSON.stringify(results, null, 2));
const leaks = results.filter((r) => r.verdict === 'LEAK');
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  合计 ${results.length} 项 · LEAK ${leaks.length} · DENIED ${results.filter((r) => r.verdict === 'DENIED').length}`);
if (leaks.length) {
  for (const l of leaks) console.log(`   🔴 ${l.resource}.${l.action} — ${l.detail}`);
  process.exit(1);
}
console.log('  ✅ 无完整联系方式泄露');
console.log('');
