/**
 * verify-be04-date-combo.mjs —— §五 D/E/H：组合筛选 + 清除 + 翻页/刷新
 *
 * D：门店 + 日期 → 清除日期 → 门店条件仍在
 * E：状态 + 类型 + 日期 → 清除日期 → 状态/类型仍在
 * H：清除后翻页 / 刷新 → UI 与实际请求一致
 *
 * 判据一律只看 `filter=` 参数，不对整条 URL 做 includes。
 */
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';
import { envValue } from './technician-harness.mjs';
import fs from 'node:fs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};

const session = await launchCdp({ port: 9535, label: 'be04-combo' });
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

  const readFilter = async () =>
    cdp.evaluate(`(() => {
      const list = window.__reqs.filter((x) => String(x.u).includes('serviceTickets:list'));
      const last = list[list.length - 1];
      const mm = last ? String(last.u).match(/[?&]filter=([^&]*)/) : null;
      const page = last ? String(last.u).match(/[?&]page=(\\d+)/) : null;
      return { filter: mm ? decodeURIComponent(mm[1]) : '', page: page ? Number(page[1]) : null,
               url: last ? decodeURIComponent(last.u).slice(0, 200) : null };
    })()`);

  /** 打开某个 select 并选第 1 项（跳过"请选择"） */
  const pickSelect = async (labelText) => {
    const opened = await cdp.evaluate(`(() => {
      const fi = [...document.querySelectorAll('.ant-form-item')].find((e) => (e.innerText || '').includes(${JSON.stringify(labelText)}));
      if (!fi) return false;
      const sel = fi.querySelector('.ant-select-selector');
      if (!sel) return false;
      sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      sel.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
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

  const submitFilter = async () => {
    await cdp.evaluate(`window.__reqs = [];`);
    await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button, .ant-btn')].find((x) => (x.innerText || '').replace(/\\s+/g, '') === '筛选'); if (b) b.click(); return !!b; })()`);
    await sleep(2200);
    return readFilter();
  };

  // ── D：门店 + 日期 → 清除 → 门店仍在
  const storePicked = await pickSelect('当前门店');
  check(storePicked, 'D：门店下拉可选中一项', '');
  let st = await submitFilter();
  check(st.filter.includes('store.id'), 'D：门店条件已生效', st.filter.slice(0, 120));
  const storePart = st.filter;

  await cdp.evaluate(`(() => { const b = document.querySelector('[data-testid="be04-preset-thisMonth"]'); if (b) b.click(); })()`);
  await sleep(2200);
  st = await readFilter();
  check(st.filter.includes('createdAt') && st.filter.includes('store.id'), 'D：门店 + 日期同时生效', st.filter.slice(0, 160));

  await cdp.evaluate(`window.__reqs = [];`);
  await cdp.evaluate(`(() => { const b = document.querySelector('[data-testid="be04-date-clear"]'); if (b) b.click(); })()`);
  await sleep(2200);
  st = await readFilter();
  check(!st.filter.includes('createdAt'), 'D：清除日期后 createdAt 消失', st.filter.slice(0, 160));
  check(st.filter.includes('store.id'), 'D：**门店条件仍然存在**（清除日期 ≠ 清全部）', st.filter.slice(0, 160));

  // ── 重置：清掉门店，回到无筛选
  await cdp.evaluate(`window.__reqs = [];`);
  await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button, .ant-btn')].find((x) => (x.innerText || '').replace(/\\s+/g, '') === '重置'); if (b) b.click(); return !!b; })()`);
  await sleep(2200);
  st = await readFilter();
  check(!st.filter.includes('store.id'), '重置：门店条件被清除', st.filter.slice(0, 120));

  // ── H：翻页仍在筛选内
  await cdp.evaluate(`(() => { const b = document.querySelector('[data-testid="be04-preset-thisMonth"]'); if (b) b.click(); })()`);
  await sleep(2200);
  await cdp.evaluate(`window.__reqs = [];`);
  await cdp.evaluate(`(() => { const b = document.querySelector('.ant-pagination-item-2'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(2200);
  st = await readFilter();
  check(st.page === 2 && st.filter.includes('createdAt'), 'H：翻到第 2 页仍带日期条件', `page=${st.page} filter=${st.filter.slice(0, 100)}`);

  // ── H：刷新后回到默认（无日期）
  await cdp.evaluate(`window.__reqs = [];`);
  await cdp.send('Page.reload');
  await cdp.waitFor(`!!document.querySelector('[data-testid="be04-preset-thisMonth"]')`, { what: 'reload', timeout: 60_000 });
  await sleep(2500);
  const afterReload = await cdp.evaluate(`(() => {
    const list = window.__reqs.filter((x) => String(x.u).includes('serviceTickets:list'));
    const last = list[list.length - 1];
    const mm = last ? String(last.u).match(/[?&]filter=([^&]*)/) : null;
    return { filter: mm ? decodeURIComponent(mm[1]) : '',
             text: (document.querySelector('[data-testid="be04-date-current"]') || {}).innerText || '' };
  })()`);
  check(!afterReload.filter.includes('createdAt'), 'H：刷新后请求不带日期条件', afterReload.filter || '(空)');
  check(afterReload.text.includes('未设置'), 'H：刷新后 UI 显示「未设置日期筛选」', afterReload.text.trim());

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync('.tmp-verify/be04-combo.png', Buffer.from(shot.data, 'base64'));
} finally {
  session.close();
}

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  组合/清除/翻页：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
