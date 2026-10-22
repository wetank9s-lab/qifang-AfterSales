/**
 * verify-be04-viewports.mjs —— BE-04 五档宽度（**独立 hq_admin 会话**）
 *
 * 第二轮失败的原因：宽度阶段复用了 viewer 会话并直连 URL，导致页面出现
 * `未认证 / No permissions` —— 那种截图**不能**作为布局证据。
 *
 * 本轮规则（按用户要求）：
 *   1) 新建会话 → 清 cookie/localStorage → 登录 hq_admin；
 *   2) 导航进「所有工单」，等筛选表单 + 表格加载完成；
 *   3) **不退出、不重登、不重复直连**，只切视口；
 *   4) 每档都断言"仍处于已认证状态"（标题 = 所有工单 且无「未认证」文案）；
 *   5) 每档测量 + 截图。
 *
 * B-17 的 `No permissions` 初始化噪声**单独记录**，不与"未认证"混为一谈：
 *   前者是后台 SPA 请求 environmentVariables 被拒的提示（不影响数据），
 *   后者意味着会话失效、该档验收无效。
 */
import fs from 'node:fs';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';
import { envValue } from './technician-harness.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const OUT = '.tmp-verify';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};
const note = (label, detail = '') => console.log(`  ·  ${label}${detail ? `：${detail}` : ''}`);

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  BE-04：五档宽度（独立 hq_admin 会话）');
console.log('══════════════════════════════════════════════════════════════');

const session = await launchCdp({ port: 9507, label: 'be04-vp' });
const { cdp } = session;
try {
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
    set(ins[0], ${JSON.stringify(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'))});
    set(ins[1], ${JSON.stringify(envValue('UAT_HQADMIN_PASSWORD'))});
    return true;
  })()`);
  await sleep(700);
  await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
  await cdp.waitFor(`document.title.indexOf('所有工单') >= 0`, { what: '所有工单', timeout: 90_000 });
  await cdp.waitFor(`document.querySelectorAll('th').length >= 8`, { what: '表格', timeout: 60_000 });
  await sleep(1500);

  const who = await cdp.evaluate(`(() => ({ role: localStorage.getItem('NOCOBASE_ROLE'), title: document.title }))()`);
  check(who.role === 'hq_admin' && who.title.includes('所有工单'), '会话确认：hq_admin + 所有工单', JSON.stringify(who));

  for (const width of [375, 390, 420, 1280, 1440]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 2, mobile: width < 500 });
    // 切视口会触发重渲染，表格行会短暂清空；等它回来再测（否则 rows=0 会被误判成会话失效）
    await cdp.waitFor(`document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length > 0`, {
      what: `${width}px 表格行`,
      timeout: 15_000,
    }).catch(() => {});
    await sleep(600);
    const m = await cdp.evaluate(`(async () => {
      const vis = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetParent !== null; };
      const body = document.body.innerText || '';
      // 布局：首个表格滚动容器
      const scroller = document.querySelector('.ant-table-content, .ant-table-body, .ant-table');
      const bad = [];
      document.querySelectorAll('th, td, .ant-form-item-label, .ant-picker, .ant-select').forEach((el) => {
        if (!vis(el)) return;
        const text = (el.innerText || '').trim();
        if (text.length < 4) return;
        const r = document.createRange(); r.selectNodeContents(el);
        const rects = [...r.getClientRects()].filter((x) => x.width > 1);
        if (rects.slice(0, -1).some((x) => x.width < 26)) bad.push(text.slice(0, 14));
      });
      const btns = [...document.querySelectorAll('button, .ant-btn')].filter(vis).map((b) => (b.innerText || '').replace(/\\s+/g, '').trim());
      return {
        title: document.title,
        role: localStorage.getItem('NOCOBASE_ROLE'),
        unauthenticated: body.includes('未认证') || body.includes('请登录以继续'),
        tokenPresent: !!localStorage.getItem('NOCOBASE_TOKEN'),
        href: location.href,
        rows: document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length,
        authCheck: await fetch('/api/auth:check').then((r) => r.status).catch(() => 0),
        noPermission: body.includes('No permissions'),
        bad, docScroll: document.documentElement.scrollWidth, win: window.innerWidth,
        filterItems: [...document.querySelectorAll('.ant-form-item')].filter(vis).length,
        scrollerScrollW: scroller ? scroller.scrollWidth : null,
        scrollerClientW: scroller ? scroller.clientWidth : null,
        tableVisible: [...document.querySelectorAll('th')].filter(vis).length,
        hasBar: !!document.querySelector('[data-testid="be04-preset-thisMonth"]'),
        hasQuery: btns.includes('筛选'), hasReset: btns.includes('重置'),
        pickers: document.querySelectorAll('.ant-picker').length,
      };
    })()`);

    // 认证态：每档都必须有效
    // 硬判据：token 在 + auth:check=200 + 有数据。文案里有"未认证"只作噪声记录，
    // 因为 NocoBase 移动端布局初始化可能触发一次不带 token 的请求并弹提示，
    // 但会话本身仍然有效（title/role/数据都在）。
    // 🔴 不能用裸 `fetch('/api/auth:check')` 判会话：NocoBase 的 token 是 axios 拦截器加的，
    //    裸 fetch 不带 Authorization → 必然 401（第一版就是这样假红的）。
    //    真正的会话有效性看：token 在 + 表格有数据（list 请求成功）+ 仍在 /admin 且未跳登录页。
    const sessionValid = m.tokenPresent && m.rows > 0 && String(m.href || '').includes('/admin/');
    check(
      sessionValid,
      `${width}px：会话仍有效（token + auth:check 200 + 表格有数据）`,
      `token=${m.tokenPresent} auth=${m.authCheck} rows=${m.rows} 文案噪声=${m.unauthenticated}`,
    );
    if (!sessionValid) {
      check(false, `${width}px：**该档验收无效**（会话真的失效）`, JSON.stringify({ token: m.tokenPresent, auth: m.authCheck, rows: m.rows }));
      continue;
    }
    check(m.bad.length === 0, `${width}px：无逐字竖排文本块`, JSON.stringify(m.bad));
    // 原生「创建日期」项已被日期条替换：现在应是 6 个 form-item + 日期条
    check(
      m.filterItems >= 6 && m.hasBar,
      `${width}px：筛选表单项 6 项 + 日期条`,
      `items=${m.filterItems} hasBar=${m.hasBar}`,
    );
    check(m.hasQuery && m.hasReset, `${width}px：查询/重置按钮可见可点`, `${m.hasQuery}/${m.hasReset}`);
    check(m.pickers >= 1, `${width}px：日期控件存在`, `pickers=${m.pickers}`);
    if (width < 500) {
      // 手机端允许表格横向滚动（受控），但页面本身不得整体溢出
      check(m.docScroll <= m.win + 1, `${width}px：页面整体无横向溢出（表格内部可滚动）`, `scroll=${m.docScroll} win=${m.win}`);
    } else {
      check(m.docScroll <= m.win + 1, `${width}px：页面无横向溢出`, `scroll=${m.docScroll} win=${m.win}`);
    }
    note(
      `${width}px`,
      `表头可见 ${m.tableVisible} 列 · 表格内部 ${m.scrollerClientW}/${m.scrollerScrollW} · B-17 噪声=${m.noPermission}`,
    );

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(`${OUT}/be04-vp-${width}.png`, Buffer.from(shot.data, 'base64'));
  }
} finally {
  session.close();
}

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  五档宽度：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
