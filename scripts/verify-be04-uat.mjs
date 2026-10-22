/**
 * verify-be04-uat.mjs —— BE-04-FINAL-UAT：补测 1~5
 *
 * 补测 1 四模式（按日/按年/自定义）
 * 补测 2 组合（日期+门店+状态+类型）→ 只清除日期 → 其余条件仍在本
 * 补测 3 重置全部筛选
 * 补测 4 分页回第一页
 * 补测 5 刷新后 UI 与请求一致
 *
 * 🔴 判据统一走 `scripts/lib/request-filter.mjs`：
 *    浏览器只负责把请求 URL 带出来，解析全部在 Node 侧做。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';
import { envValue } from './technician-harness.mjs';
import { parseRequestFilter, queryParam, findFieldConditions, inspectDateCondition } from './lib/request-filter.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};
const psql = (sql) =>
  execFileSync('docker', ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql], {
    encoding: 'utf8',
  }).trim();
const pad = (n) => String(n).padStart(2, '0');

const session = await launchCdp({ port: 9536, label: 'be04-uat' });
const { cdp } = session;
try {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => { window.__reqs = []; const oo = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return oo.apply(this, arguments); };
      const os = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        this.addEventListener('loadend', () => { window.__reqs.push({ u: String(this.__u) }); });
        return os.apply(this, arguments);
      }; })();`,
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE}/signin` });
  await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: 'login', timeout: 30_000 });
  await cdp.evaluate(`(() => { localStorage.clear(); return true; })()`).catch(() => {});
  await cdp.send('Page.navigate', { url: `${BASE}/signin` });
  await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: 'login2', timeout: 30_000 });
  await cdp.evaluate(`(() => {
    const ins = [...document.querySelectorAll('input')];
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; d.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    set(ins[0], ${JSON.stringify(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'))});
    set(ins[1], ${JSON.stringify(envValue('UAT_HQADMIN_PASSWORD'))});
    return true;
  })()`);
  await sleep(700);
  await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
  await cdp.waitFor(`document.title.indexOf('所有工单') >= 0`, { what: 'page', timeout: 90_000 });
  await cdp.waitFor(`!!document.querySelector('[data-testid="be04-preset-thisMonth"]')`, { what: 'bar', timeout: 30_000 });
  await sleep(1200);

  /** 取最近一次 list 请求的 URL（解析交给 lib） */
  const lastListUrl = () =>
    cdp.evaluate(`(() => {
      const list = window.__reqs.filter((x) => String(x.u).includes('serviceTickets:list'));
      return list.length ? list[list.length - 1].u : null;
    })()`);

  const readCount = () =>
    cdp.evaluate(`(() => {
      const el = document.querySelector('.ant-table');
      const fk = Object.keys(el || {}).find((k) => k.startsWith('__reactFiber$'));
      let f = el[fk]; let t = null; let d = 0;
      while (f && d < 80) { const p = f.memoizedProps; if (p && typeof p === 'object') for (const k of Object.keys(p)) { const v = p[k]; if (v && v.constructor && v.constructor.name === 'TableBlockModel') t = v; } if (t) break; f = f.return; d++; }
      return t?.context?.resource?.getCount?.() ?? -1;
    })()`);

  const resetReqs = () => cdp.evaluate(`window.__reqs = [];`);

  const clickTestId = async (id) => {
    await resetReqs();
    const ok = await cdp.evaluate(`(() => { const b = document.querySelector('[data-testid="${id}"]'); if (b) { b.click(); return true; } return false; })()`);
    await sleep(2200);
    return ok;
  };

  /**
   * 真实点选日期：打开 picker → 点日历格子（`title="YYYY-MM-DD"` / 年份 `title="YYYY"`）。
   * ⚠️ 直接往 input 里 setValue 不会触发 antd 的 onChange（受控组件会覆盖），必须点格子。
   */
  const pickDate = async (testid, title) => {
    const opened = await cdp.evaluate(`(() => {
      const host = document.querySelector('[data-testid="${testid}"]');
      if (!host) return false;
      const input = host.querySelector('input') || host;
      input.click();
      return true;
    })()`);
    if (!opened) return false;
    await sleep(700);
    const picked = await cdp.evaluate(`(() => {
      const cell = document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) .ant-picker-cell[title="${title}"]')
        || document.querySelector('.ant-picker-cell[title="${title}"]');
      if (!cell) return false;
      cell.click();
      return true;
    })()`);
    await sleep(1800);
    return picked;
  };

  const pickSelect = async (labelText) => {
    const opened = await cdp.evaluate(`(() => {
      const fi = [...document.querySelectorAll('.ant-form-item')].find((e) => (e.innerText || '').includes(${JSON.stringify(labelText)}));
      if (!fi) return false;
      const sel = fi.querySelector('.ant-select-selector');
      if (!sel) return false;
      sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      sel.click();
      return true;
    })()`);
    if (!opened) return false;
    await sleep(700);
    const picked = await cdp.evaluate(`(() => {
      const opts = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')];
      if (!opts.length) return false;
      opts[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      opts[0].click();
      return true;
    })()`);
    await sleep(500);
    return picked;
  };

  const submit = async () => {
    await resetReqs();
    await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button, .ant-btn')].find((x) => (x.innerText || '').replace(/\\s+/g, '') === '筛选'); if (b) b.click(); return !!b; })()`);
    await sleep(2200);
    return lastListUrl();
  };

  // ───────── 补测 1：四模式
  // 按日
  await clickTestId('be04-mode-day');
  const dayPicked = await pickDate('be04-day-picker', '2026-10-15');
  check(dayPicked, '1a 按日：日历里点中 2026-10-15', '');
  let url = await lastListUrl();
  let f = parseRequestFilter(url);
  let dc = inspectDateCondition(f);
  let sql = Number(psql(`SELECT count(*) FROM service_tickets WHERE created_at >= '2026-10-15T00:00:00+08:00' AND created_at < '2026-10-16T00:00:00+08:00'`));
  check(dc.ok, '1a 按日：filter 是 $dateNotBefore + $dateBefore（无 $dateOn）', JSON.stringify(dc.keys));
  check(await readCount() === sql, '1a 按日：meta.count == SQL(2026-10-15)', `API=${await readCount()} SQL=${sql}`);

  // 按年
  await clickTestId('be04-mode-year');
  const yearPicked = await pickDate('be04-year-picker', '2026');
  check(yearPicked, '1b 按年：年份面板里点中 2026', '');
  url = await lastListUrl();
  f = parseRequestFilter(url);
  dc = inspectDateCondition(f);
  sql = Number(psql(`SELECT count(*) FROM service_tickets WHERE created_at >= '2026-01-01T00:00:00+08:00' AND created_at < '2027-01-01T00:00:00+08:00'`));
  check(dc.ok, '1b 按年：filter 双操作符', JSON.stringify(dc.keys));
  check(await readCount() === sql, '1b 按年：meta.count == SQL(2026 全年)', `API=${await readCount()} SQL=${sql}`);

  // 自定义（起 10-05，止 10-07 → 结束应是 10-08 零点）
  await clickTestId('be04-mode-custom');
  const s1 = await pickDate('be04-range-start', '2026-10-05');
  const s2 = await pickDate('be04-range-end', '2026-10-07');
  check(s1 && s2, '1c 自定义：起止日期都点中（10-05 / 10-07）', `start=${s1} end=${s2}`);
  url = await lastListUrl();
  f = parseRequestFilter(url);
  dc = inspectDateCondition(f);
  const endVal = dc.conds?.[0]?.$dateBefore;
  sql = Number(psql(`SELECT count(*) FROM service_tickets WHERE created_at >= '2026-10-05T00:00:00+08:00' AND created_at < '2026-10-08T00:00:00+08:00'`));
  check(dc.ok, '1c 自定义：filter 双操作符', JSON.stringify(dc.keys));
  check(String(endVal).includes('2026-10-08'), '1c 自定义：结束 = 次日零点（10-08 00:00）', String(endVal));
  check(await readCount() === sql, '1c 自定义：meta.count == SQL(10-05~10-07 含末日)', `API=${await readCount()} SQL=${sql}`);

  // 非法区间：起 > 止（应不提交错误条件）
  const beforeBad = await lastListUrl();
  await pickDate('be04-range-start', '2026-10-20');
  url = await lastListUrl();
  f = parseRequestFilter(url);
  const bad = inspectDateCondition(f);
  check(!bad.present || String(url) === String(beforeBad), '1d 非法区间（起 > 止）不提交错误条件', `present=${bad.present}`);

  // ───────── 补测 2：组合
  await clickTestId('be04-date-clear');
  await clickTestId('be04-preset-thisMonth');
  await pickSelect('当前门店');
  await pickSelect('状态');
  await pickSelect('工单类型');
  url = await submit();
  f = parseRequestFilter(url);
  const hasStore = findFieldConditions(f, 'store').length > 0 || findFieldConditions(f, 'store.id').length > 0;
  const hasStatus = findFieldConditions(f, 'status').length > 0;
  const hasType = findFieldConditions(f, 'ticket_type').length > 0;
  const comboDate = inspectDateCondition(f);
  check(comboDate.ok && hasStore && hasStatus && hasType, '2 组合：日期+门店+状态+类型四条件同时存在', `date=${comboDate.present} store=${hasStore} status=${hasStatus} type=${hasType}`);

  // 只清除日期 → 其余仍在
  await resetReqs();
  await cdp.evaluate(`(() => { const b = document.querySelector('[data-testid="be04-date-clear"]'); if (b) b.click(); })()`);
  await sleep(2200);
  url = await lastListUrl();
  f = parseRequestFilter(url);
  check(!inspectDateCondition(f).present, '2b 只清除日期：createdAt 条件消失', '');
  check(
    findFieldConditions(f, 'store').length > 0 || findFieldConditions(f, 'store.id').length > 0,
    '2b 只清除日期：**门店条件仍在**',
    JSON.stringify(f)?.slice(0, 120),
  );
  check(findFieldConditions(f, 'status').length > 0, '2b 只清除日期：状态仍在', '');
  check(findFieldConditions(f, 'ticket_type').length > 0, '2b 只清除日期：类型仍在', '');

  // ───────── 补测 3：重置全部
  await resetReqs();
  await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button, .ant-btn')].find((x) => (x.innerText || '').replace(/\\s+/g, '') === '重置'); if (b) b.click(); return !!b; })()`);
  await sleep(2200);
  url = await lastListUrl();
  f = parseRequestFilter(url);
  check(!f || Object.keys(f).length === 0, '3 重置：filter 清空', JSON.stringify(f)?.slice(0, 120));
  const uiText = await cdp.evaluate(`(document.querySelector('[data-testid="be04-date-current"]') || {}).innerText || ''`);
  check(uiText.includes('未设置'), '3 重置：日期组件回到未设置', uiText.trim());

  // ───────── 补测 4：分页回第一页
  await clickTestId('be04-preset-thisMonth');
  await cdp.evaluate(`(() => { const b = document.querySelector('.ant-pagination-item-2'); if (b) b.click(); })()`);
  await sleep(2000);
  const p2url = await lastListUrl();
  check(queryParam(p2url, 'page') === '2', '4a 已进入第 2 页', String(queryParam(p2url, 'page')));

  await clickTestId('be04-preset-lastMonth');
  const p1url = await lastListUrl();
  check(queryParam(p1url, 'page') === '1', '4b 改日期后请求 page=1', String(queryParam(p1url, 'page')));
  const activePage = await cdp.evaluate(`(document.querySelector('.ant-pagination-item-active') || {}).innerText || ''`);
  check(String(activePage).trim() === '1', '4c UI 分页器显示第 1 页', activePage.trim());

  // ───────── 补测 5：刷新
  await clickTestId('be04-preset-thisMonth');
  await cdp.send('Page.reload');
  await cdp.waitFor(`!!document.querySelector('[data-testid="be04-preset-thisMonth"]')`, { what: 'reload', timeout: 60_000 });
  await sleep(2500);
  const afterReloadUrl = await lastListUrl();
  const afterReloadFilter = parseRequestFilter(afterReloadUrl);
  const afterText = await cdp.evaluate(`(document.querySelector('[data-testid="be04-date-current"]') || {}).innerText || ''`);
  const reloadHasDate = inspectDateCondition(afterReloadFilter).present;
  check(!reloadHasDate && afterText.includes('未设置'), '5 刷新：请求无日期条件 且 UI 显示未设置（一致）', `date=${reloadHasDate} ui=${afterText.trim()}`);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync('.tmp-verify/be04-uat.png', Buffer.from(shot.data, 'base64'));
} finally {
  session.close();
}

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  FINAL-UAT 补测 1-5：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const x of failed) console.log(`   ❌ ${x.label} — ${x.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
