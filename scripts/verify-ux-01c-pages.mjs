#!/usr/bin/env node
/**
 * verify-ux-01c-pages.mjs —— hq_admin 后台页面**回归**（UX-01C 第五轮）
 *
 * 本轮放开了 `serviceSettings` 的元数据（`collections:listMeta`）与原生只读授权，
 * 还新增了一个"按角色"的元数据守卫分支。这类改动最容易的副作用**不是本页坏**，
 * 而是**别的页悄悄坏**（守卫按角色判错、白名单把 `serviceSettings` 之外的集合挤掉）。
 *
 * ⇒ 逐页真实打开 hq_admin 能看到的每一个 `flowPage`，判据只有三条：
 *   ① 内容区不出现 `No permissions`（不是"表格空白"那种可解释的空）；
 *   ② 不出现「数据表…可能已被删除」（元数据没拿到的确定信号）；
 *   ③ 表格页至少有 1 行（"能打开"不等于"有数据"）。
 *
 * 用法：node scripts/verify-ux-01c-pages.mjs
 * 退出码：0 通过 / 1 判据不满足 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SVC_BASE_URL } from './lib/base-url.mjs';
import { launchCdp, sleep } from './verify-store-ui-primary-action.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function envValue(key, fallback = '') {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* 落到 process.env */
  }
  return process.env[key] ?? fallback;
}

/**
 * hq_admin 的 6 个 flowPage（取自 `rolesDesktopRoutes` × `desktopRoutes`，不是手抄界面）。
 *
 * ⚠️ `knownIssue` 机制保留，但 **2026-10-17（UX-01C-R6）起没有任何条目**：
 *    「门店报修入口」的 `stores:list 403` 已修（按角色授权 + 行级收窄），
 *    因此它现在是**正向断言**（必须渲染出表格）。
 *    以后若再出现"已知但暂不修"的页面缺陷，可以登记 knownIssue ——
 *    但**不得**用它把"预期失败"伪装成通过：登记时同时要写清"修好后门禁会变红"。
 */
const PAGES = [
  { title: '全量工单', uid: 'a7p45sundsb', expectTable: true },
  { title: '工单事件时间线', uid: 'dube4oncffx', expectTable: true },
  { title: '派工记录', uid: 'djf51kfh83a', expectTable: true },
  // UX-01C-R6 / B-18：**已修复**。原 knownIssue（stores:list 403）改为正向断言：
  // 页面必须真的渲染出表格，而不是"预期 403 也算通过"。
  // 精确行数 / 行级范围 / 二维码由 `verify-ux-01c-store-entry.mjs` 专项覆盖。
  { title: '门店报修入口', uid: 'qbr4apqripv', expectTable: true, expectRows: 1 },
  { title: '服务时效', uid: 'orm5rz0ojnd', expectTable: true, expectRows: 3, viaMenu: true },
  // UX-01C-R8：短信通知（自定义区块，无 antd 表格；内容断言由 verify-ux-01c-sms.mjs 覆盖）
  { title: '短信通知', uid: 'o4fx69lk2pb', expectTable: false },
];

const results = [];
function check(pass, label, detail = '') {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
}

const EMAIL = envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local');
const PASSWORD = envValue('UAT_HQADMIN_PASSWORD');
if (!PASSWORD) {
  console.log('  ⛔ .env 缺 UAT_HQADMIN_PASSWORD —— 环境未就绪');
  process.exit(2);
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  UX-01C：hq_admin 后台页面回归');
console.log('══════════════════════════════════════════════════════════════');

const session = await launchCdp({ label: 'ux01c-pages' });
const { cdp } = session;
const calls = [];
try {
  cdp.on('Network.requestWillBeSent', (p) => {
    const url = p.request?.url ?? '';
    if (url.includes('/api/')) calls.push({ url: url.replace(SVC_BASE_URL, ''), id: p.requestId, status: null });
  });
  cdp.on('Network.responseReceived', (p) => {
    const hit = calls.find((c) => c.id === p.requestId);
    if (hit) hit.status = p.response?.status ?? null;
  });
  await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/signin` });
  await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页就绪' });
  await cdp.evaluate(`(() => {
    const ins = [...document.querySelectorAll('input')];
    const setVal = (el, val) => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setVal(ins[0], ${JSON.stringify(EMAIL)});
    setVal(ins[1], ${JSON.stringify(PASSWORD)});
    return true;
  })()`);
  await sleep(700);
  await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
  await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 45_000 });

  for (const page of PAGES) {
    calls.length = 0;
    if (page.viaMenu) {
      // §三.1 说的是"打开「服务时效」**菜单**" —— 直接输 URL 不算。
      // 这里从侧边栏点进去，同时证明"菜单项在 hq_admin 的可见路由里"。
      // ⚠️ 必须点**真正的 `<a href>`**：侧边栏的 `li.ant-menu-item` 命中后 click
      //    不会触发路由（实测停在上一个页面），而"点了没跳转"最容易被误读成"菜单没权限"。
      const menuHit = await cdp.evaluate(`(() => {
        const a = document.querySelector('a[href*="${page.uid}"]');
        if (!a) return false;
        a.click();
        return true;
      })()`);
      check(menuHit, `侧边栏存在「${page.title}」菜单并可点击`);
      await sleep(2500);
      const href = await cdp.evaluate('location.pathname');
      check(href.includes(page.uid), `点击菜单后进入 /admin/${page.uid}`, href);
    } else {
      await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/admin/${page.uid}` });
    }
    // 等首屏稳定：要么出现表格行，要么出现自定义区块，或至少 6 秒
    await sleep(6000);
    await cdp.waitFor(`document.querySelectorAll('.ant-spin-spinning').length === 0`, { timeout: 20_000 }).catch(() => {});
    const state = await cdp.evaluate(`(() => {
      const content = document.querySelector('.ant-layout-content');
      const text = (content?.innerText ?? '').replace(/\\s+/g, ' ');
      return {
        text: text.slice(0, 400),
        rows: document.querySelectorAll('.ant-table-tbody tr[data-row-key]').length,
        tables: document.querySelectorAll('.ant-table').length,
        hasNoPerm: /No permissions/.test(text),
        hasMissing: /可能已被删除|数据表.*不存在|Data table.*deleted/.test(text),
        notFound: /页面不存在|404/.test(text),
      };
    })()`);

    const label = `${page.title}（/admin/${page.uid}）`;

    if (page.knownIssue) {
      // 已知遗留：断言失败形态**恰好**是那条资源 403，且失败原因没换
      const bad = calls.filter((c) => c.status >= 400 && !c.url.includes('environmentVariables'));
      const target = bad.find((c) => c.url.includes(`${page.knownIssue.resource}:`));
      const others = bad.filter((c) => !c.url.includes(`${page.knownIssue.resource}:`));
      check(
        Boolean(target) && target.status === 403,
        `${label} 已知遗留：${page.knownIssue.resource}:list 仍 403（${page.knownIssue.why}）`,
        target ? `${target.status} ${target.url.slice(0, 90)}` : `未观测到该 403（可能已修复 ⇒ 请更新本门禁）`,
      );
      check(
        others.length === 0,
        `${label} 没有**别的**失败请求（失败原因未被混淆）`,
        others.map((c) => `${c.status} ${c.url.slice(0, 80)}`).join(' | '),
      );
      continue;
    }

    check(!state.hasNoPerm, `${label} 无 No permissions`, state.hasNoPerm ? state.text.slice(0, 180) : '');
    check(!state.hasMissing, `${label} 表格区块未缺失`, state.hasMissing ? state.text.slice(0, 180) : '');
    check(!state.notFound, `${label} 路由存在`, state.notFound ? state.text.slice(0, 120) : '');
    if (page.expectTable) {
      const min = page.expectRows ?? 1;
      check(
        state.rows >= min,
        `${label} 表格有数据（≥${min} 行）`,
        `实际 ${state.rows} 行 / ${state.tables} 个表格`,
      );
    } else {
      // 自定义区块：至少要渲染出内容，不能是空白页
      check(state.text.length > 20, `${label} 区块有内容`, `文本长度 ${state.text.length}`);
    }
  }
} catch (error) {
  check(false, '脚本执行异常', String(error?.message ?? error).slice(0, 300));
} finally {
  session.close();
}

const failed = results.filter((r) => !r.pass);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  结果：通过 ${results.length - failed.length} / 失败 ${failed.length}`);
if (failed.length) for (const f of failed) console.log(`    ❌ ${f.label}${f.detail ? ` —— ${f.detail}` : ''}`);
console.log('══════════════════════════════════════════════════════════════');
process.exit(failed.length ? 1 : 0);
