/**
 * verify-be04-relogin.mjs —— 任务 A：退出重新登录后的状态一致性
 *
 * 1. 登录 hq_admin → 所有工单 → 点「本月」→ 确认 filter
 * 2. 走正式 `auth:signOut` 退出
 * 3. 用旧 token 访问受保护业务接口 → 必须被拒
 * 4. 重新登录 → 回「所有工单」
 * 5. 断言：UI 显示「未设置」、请求无 createdAt、无重复日期条、只有一个日期来源
 *
 * ⚠️ 不用裸 fetch 判会话（不带 NocoBase 认证头）；这里只判"受保护接口是否 200"。
 */
import fs from 'node:fs';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';
import { envValue } from './technician-harness.mjs';
import { parseRequestFilter, inspectDateCondition } from './lib/request-filter.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};

const session = await launchCdp({ port: 9538, label: 'be04-relogin' });
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

  const doLogin = async () => {
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
    await cdp.waitFor(`document.location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 90_000 });
    await sleep(2500);
  };

  const lastListUrl = () =>
    cdp.evaluate(`(() => {
      const list = window.__reqs.filter((x) => String(x.u).includes('serviceTickets:list'));
      return list.length ? list[list.length - 1].u : null;
    })()`);

  // 1) 登录 + 设本月
  await doLogin();
  await cdp.waitFor(`!!document.querySelector('[data-testid="be04-preset-thisMonth"]')`, { what: '所有工单', timeout: 60_000 }).catch(() => {});
  await sleep(1200);
  check(!!(await cdp.evaluate(`!!document.querySelector('[data-testid="be04-preset-thisMonth"]')`)), '登录后进入「所有工单」（日期条存在）', '');

  await cdp.evaluate(`window.__reqs = [];`);
  await cdp.evaluate(`(() => { const b = document.querySelector('[data-testid="be04-preset-thisMonth"]'); if (b) b.click(); })()`);
  await sleep(2500);
  const beforeLogoutUrl = await lastListUrl();
  const beforeFilter = parseRequestFilter(beforeLogoutUrl);
  check(inspectDateCondition(beforeFilter).ok, '退出前：本月条件已生效（双操作符）', JSON.stringify(beforeFilter)?.slice(0, 140));

  // 2) 正式退出
  const token = await cdp.evaluate(`(() => localStorage.getItem('NOCOBASE_TOKEN'))()`);
  const signOut = await cdp.evaluate(`(async () => {
    const t = localStorage.getItem('NOCOBASE_TOKEN');
    const r = await fetch('/api/auth:signOut', { method: 'POST', headers: { Authorization: 'Bearer ' + (t || ''), 'Content-Type': 'application/json' } });
    return r.status;
  })()`);
  await cdp.evaluate(`(() => { localStorage.clear(); return true; })()`).catch(() => {});
  check(signOut < 400, '退出登录：auth:signOut 返回成功', `HTTP ${signOut}`);

  // 3) 旧 token 访问受保护接口
  const stale = await cdp.evaluate(`(async () => {
    const r = await fetch('/api/serviceTickets:list?pageSize=1', { headers: { Authorization: 'Bearer ' + ${JSON.stringify(token)} } });
    return r.status;
  })()`);
  check([401, 403].includes(stale), '退出后：旧 token 无法访问受保护业务接口', `HTTP ${stale}`);

  // 4) 重新登录
  await doLogin();
  await cdp.waitFor(`!!document.querySelector('[data-testid="be04-preset-thisMonth"]')`, { what: '所有工单2', timeout: 60_000 }).catch(() => {});
  await sleep(2500);

  const after = await cdp.evaluate(`(() => {
    const bars = document.querySelectorAll('[data-testid="be04-preset-thisMonth"]').length;
    const text = (document.querySelector('[data-testid="be04-date-current"]') || {}).innerText || '';
    const rows = document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length;
    return { bars, text, rows };
  })()`);
  const afterUrl = await lastListUrl();
  const afterFilter = parseRequestFilter(afterUrl);
  const afterDate = inspectDateCondition(afterFilter);

  check(after.bars === 1, '重登：只有一个日期组件（无重复）', `bars=${after.bars}`);
  check(!afterDate.present, '重登：请求不带 createdAt（恢复未设置）', JSON.stringify(afterFilter)?.slice(0, 120));
  check(after.text.includes('未设置'), '重登：UI 显示「未设置日期筛选」', after.text.trim());
  check(after.rows > 0, '重登：表格正常加载', `rows=${after.rows}`);

  // 5) 受保护业务接口 200（用当前会话走页面内 axios 等价：带 token 的 fetch）
  const okApi = await cdp.evaluate(`(async () => {
    const t = localStorage.getItem('NOCOBASE_TOKEN');
    const r = await fetch('/api/serviceTickets:list?pageSize=1', { headers: { Authorization: 'Bearer ' + t } });
    return r.status;
  })()`);
  check(okApi === 200, '重登：受保护业务接口返回 200', `HTTP ${okApi}`);
} finally {
  session.close();
}

const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  退出重登：${results.length - failed.length} / ${results.length} 通过`);
if (failed.length) {
  for (const x of failed) console.log(`   ❌ ${x.label} — ${x.detail}`);
  process.exit(1);
}
console.log('  ✅ 全部通过');
