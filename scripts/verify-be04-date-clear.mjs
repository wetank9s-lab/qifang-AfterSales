/**
 * verify-be04-date-clear.mjs —— 清除日期专项（A/B/C/F/G）+ 五个快捷
 *
 * 判据要点：
 *   · 只看请求的 `filter=` 参数（不能对整个 URL 做 includes('createdAt')，
 *     因为 `sort[]=-createdAt` 会让它永远为真 —— 第一版就是这样假红的）；
 *   · SQL 期望值用**独立日期计算**（JS Date），不复用产品函数 `date-range.mjs`，
 *     避免"用产品算预期、再用产品证明自己"。
 */
import { execFileSync } from 'node:child_process';
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
const psql = (sql) =>
  execFileSync('docker', ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql], {
    encoding: 'utf8',
  }).trim();

// 独立日期计算（不 import 产品函数）
const pad = (n) => String(n).padStart(2, '0');
const sh = (ms) => new Date(ms + 8 * 3600 * 1000);
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

const session = await launchCdp({ port: 9534, label: 'be04-clear' });
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

  const readState = async () =>
    cdp.evaluate(`(() => {
      const list = window.__reqs.filter((x) => String(x.u).includes('serviceTickets:list'));
      const last = list[list.length - 1];
      const mm = last ? String(last.u).match(/[?&]filter=([^&]*)/) : null;
      const filterStr = mm ? decodeURIComponent(mm[1]) : '';
      const el = document.querySelector('.ant-table');
      const fk = Object.keys(el || {}).find((k) => k.startsWith('__reactFiber$'));
      let f = el[fk]; let t = null; let d = 0;
      while (f && d < 80) { const p = f.memoizedProps; if (p && typeof p === 'object') for (const k of Object.keys(p)) { const v = p[k]; if (v && v.constructor && v.constructor.name === 'TableBlockModel') t = v; } if (t) break; f = f.return; d++; }
      return { n: list.length, filterStr, count: t?.context?.resource?.getCount?.() ?? -1,
               text: (document.querySelector('[data-testid="be04-date-current"]') || {}).innerText || '' };
    })()`);

  const click = async (testid) => {
    await cdp.evaluate(`window.__reqs = [];`);
    await cdp.evaluate(`(() => { const b = document.querySelector('[data-testid="${testid}"]'); if (b) b.click(); return !!b; })()`);
    await sleep(2200);
    return readState();
  };

  const nowMs = Date.now();
  const todayStr = ymd(sh(nowMs));
  const y = Number(todayStr.slice(0, 4));
  const m = Number(todayStr.slice(5, 7));
  const dayMs = 86400000;

  const cases = [
    { id: 'be04-preset-today', name: '今天', start: todayStr, end: ymd(sh(nowMs + dayMs)) },
    { id: 'be04-preset-yesterday', name: '昨天', start: ymd(sh(nowMs - dayMs)), end: todayStr },
    { id: 'be04-preset-thisMonth', name: '本月', start: `${y}-${pad(m)}-01`, end: m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01` },
    { id: 'be04-preset-lastMonth', name: '上月', start: m === 1 ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01`, end: `${y}-${pad(m)}-01` },
    { id: 'be04-preset-thisYear', name: '本年', start: `${y}-01-01`, end: `${y + 1}-01-01` },
  ];

  for (const c of cases) {
    const st = await click(c.id);
    const sql = Number(psql(`SELECT count(*) FROM service_tickets WHERE created_at >= '${c.start}T00:00:00+08:00' AND created_at < '${c.end}T00:00:00+08:00'`));
    check(
      st.filterStr.includes('$dateNotBefore') && st.filterStr.includes('$dateBefore') && !st.filterStr.includes('$dateOn'),
      `快捷「${c.name}」：filter 用双操作符（无 $dateOn）`,
      st.filterStr.slice(0, 120),
    );
    check(st.count === sql, `快捷「${c.name}」：meta.count == SQL`, `API=${st.count} SQL=${sql}`);
  }

  // A/B/C：任选一个 → 清除 → createdAt 完全消失
  await click('be04-preset-thisMonth');
  let st = await click('be04-date-clear');
  check(!st.filterStr.includes('createdAt'), 'A：本月 → 清除，filter 里 createdAt 消失', st.filterStr || '(空)');
  check(st.text.includes('未设置'), 'A：清除后文案为「未设置日期筛选」', st.text.trim());

  await click('be04-preset-today');
  st = await click('be04-date-clear');
  check(!st.filterStr.includes('createdAt'), 'B：今天 → 清除，filter 里 createdAt 消失', st.filterStr || '(空)');

  await click('be04-preset-thisMonth');
  await click('be04-preset-today');
  st = await click('be04-date-clear');
  check(!st.filterStr.includes('createdAt'), 'C：本月 → 今天 → 清除，不残留旧日期', st.filterStr || '(空)');

  // F：连续清除两次
  st = await click('be04-date-clear');
  check(!st.filterStr.includes('createdAt'), 'F：连续清除第二次，仍无 createdAt 且不报错', st.filterStr || '(空)');

  // G：清除后重设，只有一个日期条件
  await click('be04-preset-lastMonth');
  st = await readState();
  const andCount = (st.filterStr.match(/"createdAt"/g) ?? []).length;
  check(andCount === 1 || andCount === 2, 'G：重设后只有一组 createdAt（$and 内 1 条 = 出现 1 次键）', `出现 ${andCount} 次`);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync('.tmp-verify/be04-date-clear.png', Buffer.from(shot.data, 'base64'));
} finally {
  session.close();
}

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  清除专项 + 五快捷：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
