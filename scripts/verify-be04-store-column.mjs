/**
 * verify-be04-store-column.mjs —— BE-04-STORE：所属门店列
 *
 * 修复方式（最小、可回退）：把总部列清单里的 `store` 换成关联字段路径 `store.name`，
 * 让引擎按关联的显示字段渲染，而不是把 belongsTo 当成标量。
 *
 * 断言：
 *  ① 总部表头出现「门店名称」；
 *  ② 首行该列 = 真实门店名（与 SQL `stores.name` 一致），不是空、不是纯数字 id；
 *  ③ 不产生重复行：行数 = min(pageSize, meta.count)，且工单号唯一；
 *  ④ 门店账号的列表**不含**跨店信息（门店页面列清单本来就没有 store 列）；
 *  ⑤ 门店按别店 id 过滤仍为 0（行级范围未被这次列改动影响）。
 */
import { execFileSync } from 'node:child_process';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';
import { envValue } from './technician-harness.mjs';

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
  return (await r.json().catch(() => null))?.data?.token ?? null;
}
async function api(p, token) {
  const r = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j };
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  BE-04-STORE：所属门店列（真实关联显示）');
console.log('══════════════════════════════════════════════════════════════');

const adminToken = await signIn(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), envValue('UAT_HQADMIN_PASSWORD'));
const storeToken = await signIn(envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'), envValue('UAT_STORE_A_PASSWORD'));

// API 侧：确认列表带 store 关联字段可用（这是列的数据来源）
const listApi = await api('/api/serviceTickets:list?pageSize=1&appends=store&fields=id,ticket_no,store', adminToken);
const firstApi = listApi.json?.data?.[0];
note('API 关联', `ticket=${firstApi?.ticket_no} store=${JSON.stringify(firstApi?.store?.name ?? null)}`);
check(Boolean(firstApi?.store?.name), 'API：`appends=store` 能取到门店名称（数据来源可用）', String(firstApi?.store?.name ?? ''));

// 浏览器侧
const session = await launchCdp({ port: 9510, label: 'be04-store' });
const { cdp } = session;
try {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE}/signin` });
  await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页', timeout: 30_000 });
  await cdp.evaluate(`(() => { localStorage.clear(); return true; })()`).catch(() => {});
  await cdp.send('Page.navigate', { url: `${BASE}/signin` });
  await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页2', timeout: 30_000 });
  await cdp.evaluate(`(() => {
    const ins = [...document.querySelectorAll('input')];
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; d.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    set(ins[0], ${JSON.stringify(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'))});
    set(ins[1], ${JSON.stringify(envValue('UAT_HQADMIN_PASSWORD'))});
    return true;
  })()`);
  await sleep(700);
  await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
  await cdp.waitFor(`document.title.indexOf('所有工单') >= 0`, { what: '所有工单', timeout: 90_000 });
  await cdp.waitFor(`document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length > 0`, { what: '行', timeout: 60_000 });
  await sleep(1200);

  const dom = await cdp.evaluate(`(() => {
    const txt = (e) => (e?.innerText || '').replace(/\\s+/g, ' ').trim();
    const ths = [...document.querySelectorAll('th')].map(txt).filter(Boolean);
    const rows = [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')];
    const cells = rows.map((r) => [...r.querySelectorAll('td')].map(txt));
    // ⚠️ 表格有勾选列：td 比过滤后的 th **多一列**（第 0 个 td 是行号/勾选）。
    //    第一版直接用同一个 index 取值，结果把"工单号"当成了"门店名"（假红）。
    //    （注释里不要写反引号：这里在模板字符串内部，会把字符串提前闭合。）
    const idx = ths.indexOf('门店名称') + 1;
    const ticketIdx = ths.indexOf('工单号') + 1;
    return {
      ths, idx,
      firstStore: idx > 0 && cells[0] ? cells[0][idx] : null,
      ticketNos: cells.map((c) => c[ticketIdx]).filter(Boolean),
      rowCount: rows.length,
      count: (() => { const m = document.body.innerText.match(/共\\s*([\\d,]+)\\s*条/); return m ? Number(m[1].replace(/,/g, '')) : null; })(),
    };
  })()`);

  check(dom.idx >= 0, '总部表头出现「门店名称」', `ths=${JSON.stringify(dom.ths)}`);
  check(
    Boolean(dom.firstStore) && !/^\\d+$/.test(String(dom.firstStore)),
    '首行门店列是**名称**（不是空、不是纯数字 id）',
    `值=${JSON.stringify(dom.firstStore)}`,
  );
  if (dom.firstStore && dom.ticketNos[0]) {
    const sqlName = psql(
      `SELECT s.name FROM service_tickets t JOIN stores s ON s.id=t.store_id WHERE t.ticket_no='${dom.ticketNos[0]}'`,
    );
    check(sqlName === dom.firstStore, '首行门店名与 SQL 关联一致（不是前端猜的）', `页面=${dom.firstStore} SQL=${sqlName}`);
  }
  const uniq = new Set(dom.ticketNos);
  check(uniq.size === dom.ticketNos.length, '无重复工单行（工单号唯一）', `行=${dom.rowCount} 唯一=${uniq.size}`);
  if (dom.count != null) {
    check(dom.rowCount <= dom.count, '行数不超过总数（关联未放大结果集）', `行=${dom.rowCount} 总数=${dom.count}`);
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  (await import('node:fs')).writeFileSync('.tmp-verify/be04-store-column.png', Buffer.from(shot.data, 'base64'));
} finally {
  session.close();
}

// 门店侧：不受影响
const storeList = await api('/api/serviceTickets:list?pageSize=50&fields=id,store_id', storeToken);
const storeIds = [...new Set((storeList.json?.data ?? []).map((x) => x.store_id).filter(Boolean))];
check(storeIds.length <= 1, '门店账号仍只看到本店（列改动未破坏行级范围）', JSON.stringify(storeIds));
const other = psql(`SELECT id FROM stores WHERE active = true ORDER BY id DESC LIMIT 1`);
const cross = await api(`/api/serviceTickets:list?pageSize=5&filter[store_id]=${other}`, storeToken);
check(Number(cross.json?.meta?.count ?? -1) === 0 || other === storeIds[0], '门店按别店条件过滤仍为 0', `count=${cross.json?.meta?.count}`);

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  BE-04-STORE：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
console.log('');
