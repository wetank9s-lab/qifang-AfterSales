/**
 * audit-be04-filter-flow.mjs —— 追踪一次**已经正常工作**的筛选流程
 *
 * 目标（用户 §三）：不要只看 dist 里有没有 filterManager，要跟踪真实调用链：
 *   改原生筛选字段 → 提交 → 查询状态更新 → 表格重新请求 → HTTP 携带 filter → 服务端返回
 *
 * 做法：
 *  ① 注入请求钩子；
 *  ② 在「客户手机号」输入一个唯一值，点「筛选」；
 *  ③ 记录新增请求的 URL（含 filter 参数）、状态码、返回条数；
 *  ④ 点「重置」，记录请求；
 *  ⑤ 只读探查表格组件实例（React fiber），看它的 props 里有哪些与请求/筛选相关的键。
 *
 * ⚠️ 只读：不修改页面、不注入假数据、不点任何写操作。
 */
import fs from 'node:fs';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';
import { envValue } from './technician-harness.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const PHONE = '13800004881';

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  BE-04-DATE：真实筛选数据流追踪');
console.log('══════════════════════════════════════════════════════════════');

const session = await launchCdp({ port: 9512, label: 'be04-flow' });
const { cdp } = session;
try {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__reqs = [];
      const oo = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; this.__m = m; return oo.apply(this, arguments); };
      const os = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        this.addEventListener('loadend', () => {
          window.__reqs.push({ u: String(this.__u), s: this.status, m: this.__m });
        });
        return os.apply(this, arguments);
      };
      const of = window.fetch;
      if (of) window.fetch = function (...a) {
        const u = (a[0] && a[0].url) || a[0];
        return of.apply(this, a).then((r) => { window.__reqs.push({ u: String(u), s: r.status, m: (a[1] && a[1].method) || 'GET' }); return r; });
      };
    })();`,
  });

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
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
  await cdp.waitFor(`document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length >= 5`, { what: '行', timeout: 60_000 });
  await sleep(1500);

  // ── 只读探查：表格 DOM 上的 React fiber 里有啥
  const probe = await cdp.evaluate(`(() => {
    const el = document.querySelector('.ant-table');
    if (!el) return { ok: false };
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!key) return { ok: false, reason: 'no fiber key' };
    let f = el[key];
    const seen = new Set();
    const hits = [];
    let depth = 0;
    while (f && depth < 40) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object') {
        for (const k of Object.keys(p)) {
          if (/filter|request|params|dataSource|refresh|service/i.test(k)) {
            const tag = k + ':' + Object.prototype.toString.call(p[k]).slice(8, -1);
            if (!seen.has(tag)) { seen.add(tag); hits.push(tag); }
          }
        }
      }
      // 记录所在组件名，便于定位是哪个模型
      const t = f.type;
      if (t && p && typeof p === 'object' && /Model|Table|Filter/i.test(String(t.displayName || t.name || ''))) {
        hits.push('component:' + (t.displayName || t.name));
      }
      f = f.return;
      depth += 1;
    }
    return { ok: true, hits: [...new Set(hits)].slice(0, 40) };
  })()`);
  console.log('  表格组件 props 相关键：', JSON.stringify(probe.hits ?? probe.reason));

  // ── 触发一次真实筛选（客户手机号）
  await cdp.evaluate(`window.__reqs = [];`);
  const filled = await cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('.ant-form-item')];
    const target = items.find((fi) => (fi.innerText || '').includes('客户手机号'));
    if (!target) return false;
    const input = target.querySelector('input');
    if (!input) return false;
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
    d.call(input, ${JSON.stringify(PHONE)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  console.log('  填写客户手机号：', filled ? '成功' : '失败');

  await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button, .ant-btn')].find((b) => (b.innerText || '').replace(/\\s+/g, '').trim() === '筛选');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(2500);

  const afterFilter = await cdp.evaluate(`(() => {
    const reqs = window.__reqs.filter((r) => String(r.u).includes('serviceTickets:list'));
    const last = reqs[reqs.length - 1];
    const rows = document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length;
    return { reqCount: reqs.length, last, rows };
  })()`);
  console.log('  筛选后请求：', JSON.stringify(afterFilter.last?.u ?? '(无)').slice(0, 240));
  console.log('  筛选后行数：', afterFilter.rows);

  // ── 重置
  await cdp.evaluate(`window.__reqs = [];`);
  await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button, .ant-btn')].find((b) => (b.innerText || '').replace(/\\s+/g, '').trim() === '重置');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(2000);
  const afterReset = await cdp.evaluate(`(() => {
    const reqs = window.__reqs.filter((r) => String(r.u).includes('serviceTickets:list'));
    const rows = document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length;
    return { last: reqs[reqs.length - 1]?.u ?? null, rows };
  })()`);
  console.log('  重置后请求：', JSON.stringify(afterReset.last ?? '(无)').slice(0, 240));
  console.log('  重置后行数：', afterReset.rows);

  fs.writeFileSync('.tmp-verify/be04-flow.json', JSON.stringify({ probe, afterFilter, afterReset }, null, 2));
} finally {
  session.close();
}
console.log('\n已写 .tmp-verify/be04-flow.json');
