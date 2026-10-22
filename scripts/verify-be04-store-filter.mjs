/**
 * verify-be04-store-filter.mjs —— 门店「我的门店工单」筛选 UI 闭环
 *
 * 定位原则（上一轮失败的教训）：
 *   页面上有**两组**按钮：filterForm 的「筛 选/重 置」和表格工具栏的「筛选/刷新」。
 *   按文字全局找会点错组。这里**限定在 `.ant-form` 容器内**定位提交/重置，
 *   并在点击前断言"容器内恰好一个"，避免歧义。
 */
import fs from 'node:fs';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';
import { envValue } from './technician-harness.mjs';
import { parseRequestFilter, findFieldConditions } from './lib/request-filter.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};

const session = await launchCdp({ port: 9540, label: 'be04-store-filter' });
const { cdp } = session;
try {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => { window.__reqs = []; const oo = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return oo.apply(this, arguments); };
      const os = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        this.addEventListener('loadend', () => { window.__reqs.push({ u: String(this.__u), s: this.status }); });
        return os.apply(this, arguments);
      }; })();`,
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE}/signin` });
  await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页', timeout: 30_000 });
  await cdp.evaluate(`(() => { localStorage.clear(); return true; })()`).catch(() => {});
  await cdp.send('Page.navigate', { url: `${BASE}/signin` });
  await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页2', timeout: 30_000 });
  await cdp.evaluate(`(() => {
    const ins = [...document.querySelectorAll('input')];
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; d.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    set(ins[0], ${JSON.stringify(envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'))});
    set(ins[1], ${JSON.stringify(envValue('UAT_STORE_A_PASSWORD'))});
    return true;
  })()`);
  await sleep(700);
  await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
  await cdp.waitFor(`document.location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 90_000 });
  await sleep(2500);

  // 进「我的门店工单」
  const href = await cdp.evaluate(`(() => {
    const a = [...document.querySelectorAll('aside a')].find((x) => (x.innerText || '').includes('我的门店工单'));
    return a ? a.getAttribute('href') : null;
  })()`);
  check(Boolean(href), '门店菜单里有「我的门店工单」', href ?? '(无)');
  await cdp.send('Page.navigate', { url: BASE + href });
  await sleep(3200);

  // 表单容器与按钮定位（限定 .ant-form）
  const layout = await cdp.evaluate(`(() => {
    const forms = [...document.querySelectorAll('form.ant-form, .ant-form')];
    const norm = (b) => (b.innerText || '').replace(/\\s+/g, '').trim();
    return {
      forms: forms.length,
      inForm: forms.map((f) => [...f.querySelectorAll('button, .ant-btn')].map(norm).filter(Boolean)),
      global: [...document.querySelectorAll('button, .ant-btn')].map(norm).filter(Boolean).slice(0, 12),
      formInputs: forms.map((f) => f.querySelectorAll('input').length),
    };
  })()`);
  console.log('  · 布局：', JSON.stringify(layout));

  const submitIdx = layout.inForm.findIndex((arr) => arr.filter((t) => t === '筛选').length === 1);
  check(layout.forms > 0 && submitIdx >= 0, '表单容器内**恰好一个**「筛选」提交按钮', JSON.stringify(layout.inForm));

  // 取本店一个真实工单号
  const ticketNo = await cdp.evaluate(`(async () => {
    const t = localStorage.getItem('NOCOBASE_TOKEN');
    const j = await fetch('/api/serviceTickets:list?pageSize=1&fields=ticket_no', { headers: { Authorization: 'Bearer ' + t } }).then((r) => r.json());
    return j?.data?.[0]?.ticket_no ?? null;
  })()`);
  check(Boolean(ticketNo), '取到本店一个真实工单号', String(ticketNo));

  // 真实键盘输入到表单内第一个 input
  // ⚠️ 表单里第一个 input 是 `createdAt_*`（日期字段的操作符选择器），填它等于没填。
  //    必须按字段 id 前缀定位：工单号框的 id 形如 `ticket_no_<uid>`。
  const typed = await cdp.evaluate(`(() => {
    const f = [...document.querySelectorAll('form.ant-form, .ant-form')][${submitIdx}];
    const el = f.querySelector('input[id^="ticket_no"]');
    if (!el) return { ok: false };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(String(ticketNo))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, id: el.id, value: el.value };
  })()`);
  check(typed.ok === true && typed.value === String(ticketNo), '输入进到工单号框（按 id 前缀定位）', JSON.stringify(typed));

  // 点表单内的提交
  await cdp.evaluate(`window.__reqs = [];`);
  const clicked = await cdp.evaluate(`(() => {
    const f = [...document.querySelectorAll('form.ant-form, .ant-form')][${submitIdx}];
    const b = [...f.querySelectorAll('button, .ant-btn')].find((x) => (x.innerText || '').replace(/\\s+/g, '').trim() === '筛选');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(2500);

  const listUrl = await cdp.evaluate(`(() => {
    const list = window.__reqs.filter((x) => String(x.u).includes('serviceTickets:list'));
    return list.length ? list[list.length - 1].u : null;
  })()`);
  const filter = parseRequestFilter(listUrl);
  const ticketConds = findFieldConditions(filter, 'ticket_no');

  check(clicked, '点击的是表单内的提交按钮', '');
  check(Boolean(filter && Object.keys(filter).length > 0), '请求带上 filter', JSON.stringify(filter)?.slice(0, 160) ?? '(无)');
  check(ticketConds.length > 0, 'filter 含 ticket_no 条件', JSON.stringify(ticketConds));

  const st = await cdp.evaluate(`(async () => {
    const el = document.querySelector('.ant-table');
    const fk = Object.keys(el || {}).find((k) => k.startsWith('__reactFiber$'));
    let f = el[fk]; let t = null; let d = 0;
    while (f && d < 80) { const p = f.memoizedProps; if (p && typeof p === 'object') for (const k of Object.keys(p)) { const v = p[k]; if (v && v.constructor && v.constructor.name === 'TableBlockModel') t = v; } if (t) break; f = f.return; d++; }
    const rows = [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')].map((r) => (r.innerText || '').replace(/\\s+/g, ' ').trim());
    return { count: t?.context?.resource?.getCount?.() ?? -1, rows: rows.length, first: rows[0] ?? '' };
  })()`);
  check(st.count === 1, 'meta.count = 1（工单号唯一）', `count=${st.count} rows=${st.rows}`);
  check(st.rows === 1 && String(st.first).includes(String(ticketNo)), '表格只剩该工单', st.first.slice(0, 80));

  // 门店范围未扩大
  const scope = await cdp.evaluate(`(async () => {
    const t = localStorage.getItem('NOCOBASE_TOKEN');
    const j = await fetch('/api/serviceTickets:list?pageSize=50&fields=store_id', { headers: { Authorization: 'Bearer ' + t } }).then((r) => r.json());
    return [...new Set((j?.data ?? []).map((x) => x.store_id).filter(Boolean))];
  })()`);
  check(scope.length <= 1, '门店范围未扩大（仍只本店）', JSON.stringify(scope));

  // 表单内重置
  await cdp.evaluate(`window.__reqs = [];`);
  const resetClicked = await cdp.evaluate(`(() => {
    const f = [...document.querySelectorAll('form.ant-form, .ant-form')][${submitIdx}];
    const b = [...f.querySelectorAll('button, .ant-btn')].find((x) => (x.innerText || '').replace(/\\s+/g, '').trim() === '重置');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(2500);
  const afterResetUrl = await cdp.evaluate(`(() => {
    const list = window.__reqs.filter((x) => String(x.u).includes('serviceTickets:list'));
    return list.length ? list[list.length - 1].u : null;
  })()`);
  const afterReset = parseRequestFilter(afterResetUrl);
  check(resetClicked, '点击的是表单内的重置按钮', '');
  check(!afterReset || Object.keys(afterReset).length === 0, '重置后 filter 清空', JSON.stringify(afterReset)?.slice(0, 120) ?? '(空)');

  const afterCount = await cdp.evaluate(`(() => {
    const el = document.querySelector('.ant-table');
    const fk = Object.keys(el || {}).find((k) => k.startsWith('__reactFiber$'));
    let f = el[fk]; let t = null; let d = 0;
    while (f && d < 80) { const p = f.memoizedProps; if (p && typeof p === 'object') for (const k of Object.keys(p)) { const v = p[k]; if (v && v.constructor && v.constructor.name === 'TableBlockModel') t = v; } if (t) break; f = f.return; d++; }
    return t?.context?.resource?.getCount?.() ?? -1;
  })()`);
  check(afterCount > 1, '重置后恢复本店默认列表', `count=${afterCount}`);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync('.tmp-verify/be04-store-filter.png', Buffer.from(shot.data, 'base64'));
} finally {
  session.close();
}

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  门店筛选 UI 闭环：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const x of failed) console.log(`   ❌ ${x.label} — ${x.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
