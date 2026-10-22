#!/usr/bin/env node
/**
 * verify-ux-01c-settings-conflict-ui.mjs —— 409 冲突后**页面是否真的重读**（UX-01C 第五轮 §三.9）
 *
 * ===========================================================================
 * 为什么单独一支脚本
 * ===========================================================================
 * 单用户点一次保存**永远不会**产生 409（`expected_value` 就是他刚看到的值）。
 * 要制造冲突必须**两个主体**：页面里停在旧值的人 + 另一个已改过值的人。
 * 这与"接口并发 409"是**两件事**：
 *   前者验的是**服务端裁决**（`lib/ux01c-conflict.mjs` 用两条并发请求证明）；
 *   后者验的是**客户端的失败处理**——409 之后如果只弹一个错、表格还停在过期值，
 *   用户会在一个已知过期的界面上反复重试。用户 §三.9 明确要求"页面正确重新读取"。
 *
 * 判据（缺一不可）：
 *   ① 保存失败提示里同时出现 `409` 与 `CONFIG_CONFLICT`；
 *   ② 弹窗**关闭**（不让人继续对着过期值改）；
 *   ③ 表格**重读**后显示"别人改成的新值"；
 *   ④ 库里仍是新值（本次保存没有覆盖别人）。
 *
 * 用法：node scripts/verify-ux-01c-settings-conflict-ui.mjs
 * 退出码：0 通过 / 1 判据不满足 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SVC_BASE_URL } from './lib/base-url.mjs';
import { launchCdp, psql, sleep } from './verify-store-ui-primary-action.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.tmp-verify');

const KEY = 'sla.accept_minutes';
const BASE = 120;
const THEIRS = 121; // 另一个主体改成的值
const MINE = 122; // 页面里那位的打算值（基于过期的 120）

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

const dbValue = () => String(psql(`select value from service_settings where key='${KEY}'`)).trim();

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
};

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  UX-01C：409 冲突后的页面重读（真实浏览器）');
console.log('══════════════════════════════════════════════════════════════');

if (dbValue() !== String(BASE)) {
  console.log(`  ⛔ 前置条件不满足：${KEY}=${dbValue()}，期望 ${BASE}`);
  process.exit(2);
}

// ---- 另一个主体：先用 API 把值改掉 ----------------------------------------
const ORIGIN = new URL(SVC_BASE_URL).origin;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const li = await fetch(`${SVC_BASE_URL}/api/auth:signIn`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify({
    email: envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'),
    password: envValue('UAT_HQADMIN_PASSWORD'),
  }),
});
if (li.status !== 200) {
  console.log(`  ⛔ 登录失败 HTTP ${li.status}`);
  process.exit(2);
}
const token = (await li.json()).data.token;
const apiUpdate = async (value, expected, scene = 'update') => {
  const r = await fetch(`${SVC_BASE_URL}/api/svc:updateSetting`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      Authorization: `Bearer ${token}`,
      'X-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({ key: KEY, value: String(value), expected_value: String(expected), scene }),
  });
  return { status: r.status, text: (await r.text()).slice(0, 160) };
};

const session = await launchCdp({ label: 'ux01c-conflict-ui' });
const { cdp } = session;
try {
  // ---- 打开页面（此时库里还是 120）----
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
    setVal(ins[0], ${JSON.stringify(envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local'))});
    setVal(ins[1], ${JSON.stringify(envValue('UAT_HQADMIN_PASSWORD'))});
    return true;
  })()`);
  await sleep(700);
  await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
  await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 45_000 });

  await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/admin/orm5rz0ojnd` });
  await cdp.waitFor('document.querySelectorAll(".ant-table-tbody tr[data-row-key]").length >= 3', {
    what: '表格就绪',
    timeout: 60_000,
  });
  await sleep(1000);
  const pageValue0 = await cdp.evaluate(`(() => {
    const tr = [...document.querySelectorAll('.ant-table-tbody tr[data-row-key]')]
      .find((r) => r.innerText.includes('${KEY}'));
    return tr ? tr.innerText.replace(/\\s+/g, ' ').trim() : '';
  })()`);
  check(pageValue0.includes(String(BASE)), `页面初始显示 ${BASE}（与库一致）`, pageValue0.slice(0, 120));

  // ---- 页面打开编辑弹窗（停在对 120 的认知上）----
  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="config-edit-action"][data-config-key="${KEY}"]');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await cdp.waitFor(`!!document.querySelector('input[data-testid="config-edit-input"]')`, { what: '编辑弹窗' });
  await cdp.evaluate(`(() => {
    const el = document.querySelector('input[data-testid="config-edit-input"]');
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    setter.call(el, '${MINE}');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);

  // ---- 另一个主体此刻把值改成 121（页面完全不知道）----
  const theirs = await apiUpdate(THEIRS, BASE);
  check(theirs.status === 200, `另一个主体把值改为 ${THEIRS}`, `HTTP ${theirs.status}`);
  check(dbValue() === String(THEIRS), '库里已是 121（页面仍显示 120）', dbValue());

  // ---- 页面点保存：必然用过期 expected_value=120 ⇒ 409 ----
  await cdp.evaluate(`(() => {
    const norm = (s) => String(s || '').replace(/\\s+/g, '');
    const ok = [...document.querySelectorAll('.ant-modal button')].find((b) => norm(b.innerText) === '保存');
    if (ok) ok.click();
    return !!ok;
  })()`);

  await cdp.waitFor(
    `[...document.querySelectorAll('.ant-message-notice-content')].some((n) => (n.innerText || '').includes('409'))`,
    { what: '409 提示', timeout: 30_000 },
  );
  const toast = await cdp.evaluate(
    `[...document.querySelectorAll('.ant-message-notice-content')].map((n) => n.innerText).join(' | ')`,
  );
  check(/409/.test(toast) && /CONFIG_CONFLICT/.test(toast), '① 提示同时含 409 与业务码', toast.replace(/\s+/g, ' ').slice(0, 180));

  await cdp.waitFor(`!document.querySelector('[data-testid="config-edit-modal"]')`, { what: '弹窗关闭', timeout: 20_000 });
  check(true, '② 弹窗已关闭（不让人对着过期值继续改）');

  await cdp.waitFor(`document.querySelectorAll('.ant-spin-spinning').length === 0`, { timeout: 30_000 }).catch(() => {});
  await sleep(1200);
  const pageValue1 = await cdp.evaluate(`(() => {
    const tr = [...document.querySelectorAll('.ant-table-tbody tr[data-row-key]')]
      .find((r) => r.innerText.includes('${KEY}'));
    return tr ? tr.innerText.replace(/\\s+/g, ' ').trim() : '';
  })()`);
  check(pageValue1.includes(String(THEIRS)), `③ 表格已重读为 ${THEIRS}`, pageValue1.slice(0, 140));
  check(dbValue() === String(THEIRS), '④ 库里仍是别人的值（本次保存未覆盖）', dbValue());
  check(!dbValue().includes(String(MINE)), `④ 本次的 ${MINE} 没有落库`);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT_DIR, `ux01c-conflict-refresh-${Date.now()}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`  ·  截图：${file.replace(ROOT + path.sep, '')}`);

  // ---- 归位 ----
  const back = await apiUpdate(BASE, THEIRS, 'restore');
  check(back.status === 200 && dbValue() === String(BASE), `归位：恢复 ${BASE}`, `HTTP ${back.status} / 现值 ${dbValue()}`);
} catch (error) {
  check(false, '脚本执行异常', String(error?.message ?? error).slice(0, 300));
  try {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT_DIR, `ux01c-conflict-exception-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`  ·  异常截图：${file.replace(ROOT + path.sep, '')}`);
  } catch {
    /* noop */
  }
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
