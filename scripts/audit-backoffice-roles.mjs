/**
 * audit-backoffice-roles.mjs —— 后台四角色真实页面审计（只读，不改库）
 *
 * 输出每个角色的：默认落地页、侧边栏菜单（层级文本）、页面标题、可见表格/按钮、截图。
 * 用于 BE-01 角色与页面 UX 审计；**不以 seed 脚本证明 UI 可用**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';
import { envValue } from './technician-harness.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const OUT = path.join(process.cwd(), '.tmp-verify');
fs.mkdirSync(OUT, { recursive: true });

const ROLES = [
  { key: 'store_after_sales', label: '门店售后', email: envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local'), pass: envValue('UAT_STORE_A_PASSWORD') },
  { key: 'hq_after_sales', label: '总部售后', email: envValue('UAT_HQ_EMAIL', 'uat.hq@svc.local'), pass: envValue('UAT_HQ_PASSWORD') },
  { key: 'hq_admin', label: '总部管理员', email: envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'), pass: envValue('UAT_HQADMIN_PASSWORD') },
  { key: 'viewer', label: '只读管理层', email: envValue('UAT_VIEWER_EMAIL', 'uat.viewer@svc.local'), pass: envValue('UAT_VIEWER_PASSWORD') },
];

const session = await launchCdp({ port: 9496, label: 'audit-roles' });
const { cdp } = session;
const report = [];

try {
  for (const role of ROLES) {
    if (process.env.ONLY && role.key !== process.env.ONLY) continue;
    if (!role.pass) {
      report.push({ ...role, ok: false, reason: '缺少口令环境变量' });
      console.log(`  ⛔ ${role.key}：缺少口令，跳过`);
      continue;
    }
    await cdp.send('Network.clearBrowserCookies');
    await cdp.send('Page.navigate', { url: `${BASE}/signin` });
    try {
      await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页', timeout: 30_000 });
    } catch {
      console.log(`  ⛔ ${role.key}：登录页未就绪`);
      continue;
    }
    if (role.key === 'store_after_sales') {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    }
    await cdp.evaluate(`(() => {
      const ins = [...document.querySelectorAll('input')];
      const setVal = (el, val) => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setVal(ins[0], ${JSON.stringify(role.email)});
      setVal(ins[1], ${JSON.stringify(role.pass)});
      return true;
    })()`);
    await sleep(600);
    await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);

    let loggedIn = true;
    try {
      await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 60_000 });
    } catch {
      loggedIn = false;
    }

    await sleep(2500);
    const info = await cdp.evaluate(`(() => {
      const txt = (el) => (el?.innerText || '').replace(/\\s+/g, ' ').trim();
      const menuNodes = [...document.querySelectorAll('aside .ant-menu-item, aside .ant-menu-submenu-title, .ant-menu-item, .ant-menu-submenu-title')];
      const menus = [...new Set(menuNodes.map(txt).filter(Boolean))].slice(0, 40);
      const links = [...new Set([...document.querySelectorAll('aside a')].map((a) => txt(a)).filter(Boolean))].slice(0, 30);
      const buttons = [...new Set([...document.querySelectorAll('button')].map((b) => txt(b)).filter((t) => t && t.length <= 20))].slice(0, 25);
      const tables = document.querySelectorAll('table').length;
      const cols = [...new Set([...document.querySelectorAll('th')].map(txt).filter(Boolean))].slice(0, 20);
      return {
        href: location.href,
        title: document.title,
        h1: txt(document.querySelector('h1, h2, .ant-page-header-heading-title')),
        menus, links, buttons, tables, cols,
        bodyHead: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 600),
        scrollW: document.documentElement.scrollWidth,
        win: window.innerWidth,
      };
    })()`);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, `audit-${role.key}.png`), Buffer.from(shot.data, 'base64'));

    report.push({ ...role, ok: loggedIn, ...info });
    console.log(`\n── ${role.label}（${role.key}）${loggedIn ? '' : ' ⛔ 登录未跳转'}`);
    console.log(`   落地: ${info.href}`);
    console.log(`   标题: ${info.h1 || info.title}`);
    console.log(`   菜单(${info.menus.length}): ${JSON.stringify(info.menus)}`);
    console.log(`   链接: ${JSON.stringify(info.links)}`);
    console.log(`   表格: ${info.tables} · 列: ${JSON.stringify(info.cols)}`);
    console.log(`   按钮: ${JSON.stringify(info.buttons)}`);
    console.log(`   正文头: ${info.bodyHead.slice(0, 220)}`);
  }
} finally {
  session.close();
}

fs.writeFileSync(path.join(OUT, 'audit-roles.json'), JSON.stringify(report, null, 2));
console.log('\n已写 .tmp-verify/audit-roles.json');
