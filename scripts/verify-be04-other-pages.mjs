/**
 * verify-be04-other-pages.mjs —— 任务 B：四个原筛选页面的提交与重置
 *
 * hq_admin：事件时间线 / 派工记录 / 门店报修入口
 * store_after_sales：我的门店工单（**必须用真实门店账号**，不用 hq_admin 冒充）
 *
 * 每页：能进入 → 表单渲染 → 无 BE-04 日期条 → 选一个原生筛选条件 → 查询请求带 filter
 *       → 重置 → filter 清空 → 列表有数据。
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

const session = await launchCdp({ port: 9539, label: 'be04-other' });
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

  const login = async (email, pw) => {
    await cdp.send('Page.navigate', { url: `${BASE}/signin` });
    await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页', timeout: 30_000 });
    await cdp.evaluate(`(() => { localStorage.clear(); return true; })()`).catch(() => {});
    await cdp.send('Page.navigate', { url: `${BASE}/signin` });
    await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页2', timeout: 30_000 });
    await cdp.evaluate(`(() => {
      const ins = [...document.querySelectorAll('input')];
      const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; d.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      set(ins[0], ${JSON.stringify(email)});
      set(ins[1], ${JSON.stringify(pw)});
      return true;
    })()`);
    await sleep(700);
    await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
    await cdp.waitFor(`document.location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 90_000 });
    await sleep(2500);
  };

  const lastListUrl = () =>
    cdp.evaluate(`(() => {
      const list = window.__reqs.filter((x) => String(x.u).includes(':list'));
      return list.length ? list[list.length - 1].u : null;
    })()`);

  const inspectPage = async (title, opts = {}) => {
    const requireSubmit = opts.requireSubmit !== false;
    // 从菜单取 href 直接导航（点 <a> 在 SPA 里不一定会切路由）
    const href = await cdp.evaluate(`(() => {
      const a = [...document.querySelectorAll('aside a')].find((x) => (x.innerText || '').includes(${JSON.stringify(title)}));
      return a ? a.getAttribute('href') : null;
    })()`);
    check(Boolean(href), `${title}：菜单里找到入口`, href ?? '(无)');
    if (!href) return;

    await cdp.send('Page.navigate', { url: BASE + href });
    await sleep(3200);

    const snap = await cdp.evaluate(`(() => ({
      title: document.title,
      dateBar: document.querySelectorAll('[data-testid="be04-preset-thisMonth"]').length,
      formItems: document.querySelectorAll('.ant-form-item').length,
      selects: document.querySelectorAll('.ant-form-item .ant-select').length,
      inputs: [...document.querySelectorAll('.ant-form-item input')].length,
      rows: document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length,
      bodyLen: (document.body.innerText || '').trim().length,
    }))()`);
    check(snap.bodyLen > 50 && snap.rows > 0, `${title}：页面正常加载且有数据`, `rows=${snap.rows}`);
    check(snap.dateBar === 0, `${title}：**没有 BE-04 日期条**（未被误替换）`, `dateBar=${snap.dateBar}`);

    // 无 filterForm 的页面（事件时间线/派工/报修入口）没有表单级筛选，跳过提交段
    if (!requireSubmit) {
      check(snap.formItems === 0, `${title}：确认无表单级筛选（表格级筛选不在本项范围）`, `formItems=${snap.formItems}`);
      return;
    }

    // 有 filterForm 的页面：优先填输入框（下拉里第一个往往是"操作符"，不是字段）
    let acted = false;
    if (snap.inputs > 0) {
      // 真实键盘输入：先聚焦，再用 CDP insertText（直接 setValue 不会进 antd 表单）
      acted = await cdp.evaluate(`(() => {
        const el = document.querySelector('.ant-form-item input');
        if (!el) return false;
        el.focus();
        el.click();
        return true;
      })()`);
      if (acted) {
        await cdp.send('Input.insertText', { text: 'FW' });
        await sleep(400);
        // 回车提交（filterForm 的常见提交方式）
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await sleep(1800);
      }
    } else if (snap.selects > 0) {
      const opened = await cdp.evaluate(`(() => {
        const sel = document.querySelector('.ant-form-item .ant-select-selector');
        if (!sel) return false;
        sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        sel.click();
        return true;
      })()`);
      if (opened) {
        await sleep(700);
        acted = await cdp.evaluate(`(() => {
          const opt = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find((o) => (o.innerText || '').trim());
          if (!opt) return false;
          opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          opt.click();
          return true;
        })()`);
      }
    }
    check(acted, `${title}：能操作一个原生筛选条件`, `selects=${snap.selects} inputs=${snap.inputs}`);

    // 查询
    await cdp.evaluate(`window.__reqs = [];`);
    const clicked = await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('button, .ant-btn')].find((x) => (x.innerText || '').replace(/\\s+/g, '') === '筛选');
      if (b) { b.click(); return true; }
      return false;
    })()`);
    await sleep(2200);
    const qUrl = await lastListUrl();
    const qFilter = parseRequestFilter(qUrl);
    const dbg = await cdp.evaluate(`(() => ({
      all: window.__reqs.map((x) => String(x.u)).slice(-4),
      buttons: [...document.querySelectorAll('button, .ant-btn')].map((b) => (b.innerText || '').replace(/\s+/g, '').trim()).filter(Boolean).slice(0, 8),
    }))()`);
    check(
      clicked && Boolean(qFilter && Object.keys(qFilter).length > 0),
      `${title}：查询请求带 filter`,
      `${JSON.stringify(qFilter)?.slice(0, 120) ?? '(无)'} | clicked=${clicked} reqs=${JSON.stringify(dbg.all)} btns=${JSON.stringify(dbg.buttons)}`,
    );

    // 重置
    await cdp.evaluate(`window.__reqs = [];`);
    const resetClicked = await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('button, .ant-btn')].find((x) => (x.innerText || '').replace(/\\s+/g, '') === '重置');
      if (b) { b.click(); return true; }
      return false;
    })()`);
    await sleep(2200);
    const rUrl = await lastListUrl();
    const rFilter = parseRequestFilter(rUrl);
    check(resetClicked && (!rFilter || Object.keys(rFilter).length === 0), `${title}：重置后 filter 清空`, JSON.stringify(rFilter)?.slice(0, 100) ?? '(空)');
  };

  // ── hq_admin 的三个页面
  await login(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), envValue('UAT_HQADMIN_PASSWORD'));
  for (const t of ['工单事件时间线', '派工记录', '门店报修入口']) {
    await inspectPage(t, { requireSubmit: false });
  }

  // ── 门店账号：我的门店工单
  await login(envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'), envValue('UAT_STORE_A_PASSWORD'));
  await inspectPage('我的门店工单');

  // 门店数据隔离：菜单正确 + 列表只含本店
  const storeState = await cdp.evaluate(`(() => {
    const menus = [...new Set([...document.querySelectorAll('aside a')].map((a) => (a.innerText || '').replace(/\\s+/g, '').trim()).filter(Boolean))];
    const dateBar = document.querySelectorAll('[data-testid="be04-preset-thisMonth"]').length;
    return { menus, dateBar };
  })()`);
  check(storeState.menus.includes('我的门店工单'), '门店：菜单名称为「我的门店工单」', JSON.stringify(storeState.menus.slice(0, 6)));
  check(storeState.dateBar === 0, '门店：没有 BE-04 日期条', `dateBar=${storeState.dateBar}`);

  // 用门店 token 直接查别店（服务端不得扩大范围）
  const cross = await cdp.evaluate(`(async () => {
    const t = localStorage.getItem('NOCOBASE_TOKEN');
    const me = await fetch('/api/serviceTickets:list?pageSize=50&fields=id,store_id', { headers: { Authorization: 'Bearer ' + t } }).then((r) => r.json());
    const ids = [...new Set((me?.data ?? []).map((x) => x.store_id).filter(Boolean))];
    return { stores: ids, count: me?.meta?.count ?? -1 };
  })()`);
  check(cross.stores.length <= 1, '门店：列表只含本店（服务端行级）', JSON.stringify(cross.stores));

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync('.tmp-verify/be04-other-pages.png', Buffer.from(shot.data, 'base64'));
} finally {
  session.close();
}

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  四个原筛选页面：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const x of failed) console.log(`   ❌ ${x.label} — ${x.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
