/**
 * audit-be04-screenshot.mjs —— 「所有工单」有效截图 + 认证异常归因
 *
 * 目的：
 *  ① 给出一张**真正加载完成**的页面截图（门店名称表头 + 实际门店名 + 工单号 + 筛选表单）；
 *  ② 回答用户四个问题：
 *     A. 哪条请求触发 `No permissions`？
 *     B. 哪条请求触发 `未认证`？
 *     C. 后台业务列表请求是否 200？
 *     D. 这两条提示是否来自测试脚本自己发的无认证请求？
 *
 * 做法：在页面加载前注入 fetch/XHR 钩子，记录**每条**请求的 URL 与状态码，
 *      然后按状态码归因（403 = 权限；401 = 未认证）。
 */
import fs from 'node:fs';
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

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  BE-04：有效截图 + 认证异常归因');
console.log('══════════════════════════════════════════════════════════════');

const session = await launchCdp({ port: 9511, label: 'be04-shot' });
const { cdp } = session;
try {
  // 页面加载前注入请求记录器（不改变任何请求行为）
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__reqs = [];
      const of = window.fetch;
      if (of) {
        window.fetch = function (...a) {
          const u = (a[0] && a[0].url) || a[0];
          return of.apply(this, a).then((r) => {
            const rec = { u: String(u), s: r.status, kind: 'fetch' };
            window.__reqs.push(rec);
            try { r.clone().text().then((b) => { rec.b = b.slice(0, 160); }).catch(() => {}); } catch (e) {}
            return r;
          })
            .catch((e) => { window.__reqs.push({ u: String(u), s: 'ERR', kind: 'fetch' }); throw e; });
        };
      }
      const oo = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return oo.apply(this, arguments); };
      const os = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        this.addEventListener('loadend', () => {
          let b = '';
          try { b = String(this.responseText || '').slice(0, 160); } catch (e) {}
          window.__reqs.push({ u: String(this.__u), s: this.status, kind: 'xhr', b });
        });
        return os.apply(this, arguments);
      };
    })();`,
  });

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Network.clearBrowserCookies');
  await cdp.send('Page.navigate', { url: `${BASE}/signin` });
  await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页', timeout: 30_000 });
  await cdp.evaluate(`(() => { localStorage.clear(); window.__reqs = []; return true; })()`).catch(() => {});
  await cdp.send('Page.navigate', { url: `${BASE}/signin` });
  await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页2', timeout: 30_000 });
  await cdp.evaluate(`(() => { window.__reqs = []; return true; })()`).catch(() => {});

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
  await cdp.waitFor(`document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length >= 5`, { what: '数据行', timeout: 60_000 });
  await sleep(2500); // 让骨架屏与 toast 完全收尾

  const state = await cdp.evaluate(`(() => {
    const txt = (e) => (e?.innerText || '').replace(/\\s+/g, ' ').trim();
    const body = document.body.innerText || '';
    const ths = [...document.querySelectorAll('th')].map(txt).filter(Boolean);
    const rows = [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')];
    const cells = rows.slice(0, 3).map((r) => [...r.querySelectorAll('td')].map(txt));
    const skeleton = document.querySelectorAll('.ant-skeleton, .ant-spin-spinning').length;
    return {
      title: document.title, href: location.href,
      role: localStorage.getItem('NOCOBASE_ROLE'),
      ths, rowCount: rows.length, cells,
      formItems: [...document.querySelectorAll('.ant-form-item')].filter((e) => e.offsetParent !== null).length,
      hasNoPermissionText: body.includes('No permissions'),
      hasUnauthText: body.includes('未认证') || body.includes('请登录以继续'),
      skeleton,
      reqs: window.__reqs.slice(-80),
    };
  })()`);

  // ── 归因
  const blocked = state.reqs.filter((r) => r.s === 403 || r.s === 401);
  note('请求总数（近 80 条）', String(state.reqs.length));
  for (const r of blocked.slice(0, 10)) console.log(`     ${r.s}  ${String(r.u).slice(0, 110)}`);

  const ticketListReq = state.reqs.filter((r) => String(r.u).includes('serviceTickets:list'));
  const lastTicketList = ticketListReq[ticketListReq.length - 1];
  check(
    Boolean(lastTicketList) && lastTicketList.s === 200,
    'C. 后台业务列表请求 `serviceTickets:list` 返回 200',
    lastTicketList ? `${lastTicketList.s} ${String(lastTicketList.u).slice(0, 90)}` : '未捕获到',
  );
  const envReq = state.reqs.find((r) => String(r.u).includes('environmentVariables'));
  check(Boolean(envReq) && envReq.s === 403, 'A. `No permissions` 来自 `environmentVariables:list` 403（B-17 既有噪声）', envReq ? `${envReq.s} ${String(envReq.u).slice(0, 80)}` : '未捕获到');
  const auth401 = state.reqs.filter((r) => r.s === 401);
  check(auth401.length === 0, 'B/D. 本会话**没有任何 401**（未认证提示不是产品登录失效）', JSON.stringify(auth401.map((x) => String(x.u).slice(0, 60))));

  // ── 截图断言
  check(state.ths.includes('门店名称'), '表头含「门店名称」', JSON.stringify(state.ths));
  check(state.rowCount >= 5, '列表已加载数据行（非骨架屏）', `行=${state.rowCount} 骨架=${state.skeleton}`);
  check(state.formItems >= 7, '筛选表单已渲染', `items=${state.formItems}`);
  check(String(state.href).includes('/admin/'), '仍处于已登录后台页面', state.href);
  const storeIdx = state.ths.indexOf('门店名称') + 1;
  const firstStore = state.cells[0]?.[storeIdx];
  note('首行门店', String(firstStore ?? '(空)'));
  note('首行工单号', String(state.cells[0]?.[state.ths.indexOf('工单号') + 1] ?? '(空)'));

  // 截图前必须等"行真的画出来"：DOM 存在 ≠ 已绘制（SPA 重渲染时 DOM 就绪但画面是空的，
  // 第一版就是这样截到白屏的）。
  await cdp.waitFor(
    `(() => { const r = document.querySelector('.ant-table-tbody tr.ant-table-row'); if (!r) return false; const b = r.getBoundingClientRect(); return b.height > 12 && b.top < window.innerHeight; })()`,
    { what: '表格可见', timeout: 20_000 },
  );
  await sleep(1200);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync('.tmp-verify/be04-final-all-tickets.png', Buffer.from(shot.data, 'base64'));
  note('截图', '.tmp-verify/be04-final-all-tickets.png');

  fs.writeFileSync('.tmp-verify/be04-reqs.json', JSON.stringify(state.reqs, null, 2));
} finally {
  session.close();
}

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  截图与归因：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
