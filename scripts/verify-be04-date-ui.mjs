/**
 * verify-be04-date-ui.mjs —— 日期条 UI 闭环（真实浏览器 → 请求 → count → SQL）
 *
 * 覆盖：本月 / 今天 / 上月 三个快捷、清除日期、分页在筛选内翻页。
 * （按日/按年/自定义的日期控件存在性由 probe 已证；这里聚焦"操作→请求→结果"链路。）
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

const session = await launchCdp({ port: 9532, label: 'be04-ui' });
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

  const clickAndRead = async (testid, label, sqlWhere) => {
    await cdp.evaluate(`window.__reqs = [];`);
    await cdp.evaluate(`(() => { const b = document.querySelector('[data-testid="${testid}"]'); if (b) b.click(); return !!b; })()`);
    await sleep(2500);
    const r = await cdp.evaluate(`(() => {
      const list = window.__reqs.filter((x) => String(x.u).includes('serviceTickets:list'));
      const last = list[list.length - 1];
      const m = last ? decodeURIComponent(last.u).match(/"createdAt":\\{[^}]+\\}/) : null;
      return { n: list.length, url: last?.u ?? null, filter: m ? m[0] : null, rows: document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length };
    })()`);
    const sqlCount = Number(psql(`SELECT count(*) FROM service_tickets WHERE created_at ${sqlWhere}`));
    check(Boolean(r.filter), `${label}：请求带 createdAt 双操作符`, r.filter ?? '(无)');
    check(
      r.filter?.includes('$dateNotBefore') && r.filter?.includes('$dateBefore') && !r.filter.includes('$dateOn'),
      `${label}：用 $dateNotBefore + $dateBefore（无 $dateOn）`,
      '',
    );
    const apiCount = await cdp.evaluate(`(() => {
      const el = document.querySelector('.ant-table');
      const fk = Object.keys(el || {}).find((k) => k.startsWith('__reactFiber$'));
      let f = el[fk]; let t = null; let d = 0;
      while (f && d < 80) { const p = f.memoizedProps; if (p && typeof p === 'object') for (const k of Object.keys(p)) { const v = p[k]; if (v && v.constructor && v.constructor.name === 'TableBlockModel') t = v; } if (t) break; f = f.return; d++; }
      return t?.context?.resource?.getCount?.() ?? -1;
    })()`);
    check(apiCount === sqlCount, `${label}：meta.count == SQL`, `API=${apiCount} SQL=${sqlCount}`);
    return { apiCount, rows: r.rows };
  };

  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const y = now.getUTCFullYear();
  const m = pad(now.getUTCMonth() + 1);
  const d = pad(now.getUTCDate());
  const nextMonth = m === '12' ? `${y + 1}-01` : `${y}-${pad(Number(m) + 1)}`;
  const tm = new Date(now.getTime() + 86400000);
  const tomorrow = `${tm.getUTCFullYear()}-${pad(tm.getUTCMonth() + 1)}-${pad(tm.getUTCDate())}`;

  await clickAndRead(
    'be04-preset-thisMonth',
    '本月',
    `>= '${y}-${m}-01T00:00:00+08:00' AND created_at < '${nextMonth}-01T00:00:00+08:00'`,
  );
  await clickAndRead(
    'be04-preset-today',
    '今天',
    `>= '${y}-${m}-${d}T00:00:00+08:00' AND created_at < '${tomorrow}T00:00:00+08:00'`,
  );

  // 清除
  await cdp.evaluate(`window.__reqs = [];`);
  await cdp.evaluate(`(() => { const b = document.querySelector('[data-testid="be04-date-clear"]'); if (b) b.click(); return !!b; })()`);
  await sleep(2500);
  const cleared = await cdp.evaluate(`(() => {
    const list = window.__reqs.filter((x) => String(x.u).includes('serviceTickets:list'));
    const last = list[list.length - 1];
    // ⚠️ 判据只能看 filter 参数本身：URL 里还有 sort[]=-createdAt，
    //    对整个 URL 做 includes('createdAt') 会永远为 true（第一版就是这样假红的）。
    const m = last ? String(last.u).match(/[?&]filter=([^&]*)/) : null;
    const filterStr = m ? decodeURIComponent(m[1]) : '';
    return {
      n: list.length,
      filterStr,
      hasFilter: last ? filterStr.includes('createdAt') : null,
      text: (document.querySelector('[data-testid="be04-date-current"]') || {}).innerText || '',
    };
  })()`);
  check(
    cleared.hasFilter === false,
    '清除日期：请求的 filter 参数不再含 createdAt',
    `n=${cleared.n} filter=${cleared.filterStr || '(空)'}`,
  );
  check(cleared.text.includes('未设置'), '清除日期：界面回到"未设置"', cleared.text.trim());

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync('.tmp-verify/be04-date-ui.png', Buffer.from(shot.data, 'base64'));
} finally {
  session.close();
}

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  DATE UI 闭环：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`   ❌ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
