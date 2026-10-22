/**
 * verify-be04-roles-viewports.mjs —— BE-04 四角色入口 + 五档宽度
 *
 * 每个角色**独立会话**：清 cookie + 清 localStorage + 重新登录，
 * 每次断言"当前身份/角色/URL/标题"，避免上一个账号的 SPA 状态污染。
 */
import fs from 'node:fs';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';
import { envValue } from './technician-harness.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const OUT = '.tmp-verify';

const ROLE_CASES = [
  { key: 'store_after_sales', email: envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'), pass: envValue('UAT_STORE_A_PASSWORD'), expectMenu: '我的门店工单', forbid: '所有工单' },
  { key: 'hq_after_sales', email: 'uat.hq@svc.local', pass: envValue('UAT_HQ_PASSWORD'), expectMenu: '所有工单', forbid: '全量工单' },
  { key: 'hq_admin', email: envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), pass: envValue('UAT_HQADMIN_PASSWORD'), expectMenu: '所有工单', forbid: '全量工单' },
  { key: 'viewer', email: 'uat.viewer@svc.local', pass: envValue('UAT_VIEWER_PASSWORD'), expectMenu: '所有工单', forbid: '全量工单' },
];

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  BE-04：四角色入口 + 五档宽度');
console.log('══════════════════════════════════════════════════════════════');

const session = await launchCdp({ port: 9506, label: 'be04-roles' });
const { cdp } = session;
try {
  for (const role of ROLE_CASES) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Network.clearBrowserCookies');
    await cdp.send('Page.navigate', { url: `${BASE}/signin` });
    await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页', timeout: 30_000 });
    await cdp.evaluate(`(() => { localStorage.clear(); return true; })()`).catch(() => {});
    await cdp.send('Page.navigate', { url: `${BASE}/signin` });
    await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页2', timeout: 30_000 });
    await cdp.evaluate(`(() => {
      const ins = [...document.querySelectorAll('input')];
      const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; d.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      set(ins[0], ${JSON.stringify(role.email)}); set(ins[1], ${JSON.stringify(role.pass)});
      return true;
    })()`);
    await sleep(700);
    await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
    await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: `${role.key} 跳转`, timeout: 60_000 });
    await sleep(3000);

    const info = await cdp.evaluate(`(() => {
      const txt = (e) => (e?.innerText || '').replace(/\\s+/g, ' ').trim();
      const menus = [...new Set([...document.querySelectorAll('aside .ant-menu-item, .ant-menu-submenu-title, .ant-menu-item, .ant-menu-submenu-title')].map(txt).filter(Boolean))];
      const vis = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetParent !== null; };
      const writeBtns = [...document.querySelectorAll('button, .ant-btn, [role="button"]')]
        .filter(vis).map((b) => (b.innerText || '').replace(/\\s+/g, '').trim())
        .filter((t) => ['处理', '跟进', '新建服务单', '编辑', '删除'].includes(t));
      return {
        href: location.href, title: document.title, role: localStorage.getItem('NOCOBASE_ROLE'),
        menus, writeBtns,
        cols: [...new Set([...document.querySelectorAll('th')].map(txt).filter(Boolean))],
      };
    })()`);

    check(info.role === role.key, `${role.key}：会话角色正确（无上一账号残留）`, `role=${info.role}`);
    check(info.menus.includes(role.expectMenu), `${role.key}：菜单含「${role.expectMenu}」`, JSON.stringify(info.menus.slice(0, 8)));
    check(!info.menus.includes(role.forbid), `${role.key}：菜单**无**「${role.forbid}」`, '');
    if (role.key === 'viewer') {
      check(info.writeBtns.length === 0, 'viewer：界面无写按钮', JSON.stringify(info.writeBtns));
    }
    console.log(`     落地=${info.href} 标题=${info.title} 列=${info.cols.slice(0, 12).join('/')}`);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(`${OUT}/be04-role-${role.key}.png`, Buffer.from(shot.data, 'base64'));
  }

  // 五档宽度已独立到 `verify-be04-viewports.mjs`（独立 hq_admin 会话，31 条）。
  // 这里只保留四角色入口断言，避免两处重复维护同一份布局判据。
} finally {
  session.close();
}

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  四角色 + 宽度：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
