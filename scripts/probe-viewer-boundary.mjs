/**
 * probe-viewer-boundary.mjs —— 实测 viewer 的读写边界（BE-01-S0 取证）
 *
 * 只用一个**脚本自建**的夹具单试探，跑完按 ID 删除。
 * 目的：区分「按钮错误（前端可见）」与「实际后端越权（服务端接受）」。
 */
import crypto from 'node:crypto';
import { cleanupTicket, createScratchTicket, envValue } from './technician-harness.mjs';
import { storeEntryQuery } from './lib/store-entry-token.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';

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

const mobileRe = /1[3-9]\d{9}/g;
const hits = (s) => (String(s ?? '').match(mobileRe) ?? []).length;

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  viewer 读写边界实测（BE-01-S0 取证）');
console.log('══════════════════════════════════════════════════════════════');

const viewer = await signIn('uat.viewer@svc.local', envValue('UAT_VIEWER_PASSWORD'));
const hq = await signIn('uat.hq@svc.local', envValue('UAT_HQ_PASSWORD'));
if (!viewer) {
  console.log('⛔ viewer 登录失败');
  process.exit(2);
}

const fx = await createScratchTicket({ tag: 'VIEWER-BOUNDARY', content: '权限边界探针' });
console.log(`  夹具工单 ${fx.ticketNo}（id=${fx.ticketId}）`);

const out = {};
try {
  const cases = [
    ['list_tickets', `/api/serviceTickets:list?pageSize=1&filter[id]=${fx.ticketId}&fields=id,ticket_no,technician_mobile,customer_mobile`],
    ['get_ticket', `/api/serviceTickets:get?filterByTk=${fx.ticketId}&fields=id,ticket_no,technician_mobile,customer_mobile`],
    ['list_visits', `/api/serviceVisits:list?pageSize=1&filter[ticket_id]=${fx.ticketId}`],
    ['list_medias', `/api/customerMedias:list?pageSize=1&filter[ticket_id]=${fx.ticketId}`],
    ['list_users', `/api/users:list?pageSize=1`],
    ['list_roles', `/api/roles:list?pageSize=1`],
    ['list_collections', `/api/collections:list?pageSize=1`],
    ['env_vars', `/api/environmentVariables:list?pageSize=1`],
    ['export_tickets', `/api/svc:exportTickets?filterByTk=${fx.ticketId}`],
    ['follow_up', `/api/svc:followUp?filterByTk=${fx.ticketId}`, 'POST', { note: '越权探针' }],
    ['internal_note', `/api/svc:internalNote?filterByTk=${fx.ticketId}`, 'POST', { note: '越权探针' }],
    ['update_ticket', `/api/serviceTickets:update?filterByTk=${fx.ticketId}`, 'POST', { content: '越权探针' }],
    ['dashboard', `/api/svc:dashboardSummary`],
    ['report_kpi', `/api/svc:reportKpi`],
  ];

  for (const [name, path, method, body] of cases) {
    const r = await call(path, { method: method ?? 'GET', token: viewer, body });
    out[name] = { status: r.status, mobiles: hits(r.text), bodyHead: r.text.slice(0, 160) };
    console.log(`  ${name.padEnd(16)} HTTP ${String(r.status).padEnd(3)} 完整手机号×${hits(r.text)}`);
  }

  // 总部售后基线（用于确认"不误伤"）
  const hqList = await call(`/api/serviceTickets:list?pageSize=1&filter[id]=${fx.ticketId}&fields=technician_mobile,customer_mobile`, { token: hq });
  console.log(`  hq list 基线      HTTP ${hqList.status} 完整手机号×${hits(hqList.text)}`);
  out.hq_list = { status: hqList.status, mobiles: hits(hqList.text) };
} finally {
  cleanupTicket(fx.ticketId);
  console.log(`  夹具 ${fx.ticketNo} 已清理`);
}

console.log('\n结果：');
console.log(JSON.stringify(out, null, 2));
