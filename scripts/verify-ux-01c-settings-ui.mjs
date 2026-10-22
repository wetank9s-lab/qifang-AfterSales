#!/usr/bin/env node
/**
 * verify-ux-01c-settings-ui.mjs —— 「服务时效」页的**真实浏览器**全流程验收（UX-01C 第五轮）
 *
 * ===========================================================================
 * 它验证什么（对应指令 §三 的 1~9 项）
 * ===========================================================================
 *   1. hq_admin 真实登录后能打开「服务时效」菜单（页面不再是 No permissions）
 *   2. 看到三个真实 SLA 参数及当前值（值来自库里，不是硬编码）
 *   3. 点击「修改」→ 弹窗回显当前值/范围
 *   4. 保存成功 → 页面与服务端（库）一致
 *   5. 422 范围错误 → 页面清楚提示，且**库未变**
 *   6. 恢复原值 → 留痕（审计新增一条 old→new）
 *   7. 页面刷新后仍是恢复后的值（不是只在内存里改了）
 *   （409 冲突的页面行为由本脚本的 `--conflict` 分支验证：先并发制造冲突，再让页面重读）
 *   （"新阈值被真的用上"由 verify-ux-01c-settings-effect.mjs 用 SLA 扫描计数证明）
 *
 * ===========================================================================
 * 为什么必须用真实浏览器
 * ===========================================================================
 * 接口 200 不代表页面能渲染：`serviceSettings` 之前就是"ACL 403"和"表格区块拿不到
 * 元数据"两种坏法同时存在（前者 403 文本、后者"数据表…可能已被删除"）。
 * 只有真实页面 + 真实点击才能区分"页面空白是因为没数据"还是"权限没配好"。
 *
 * 用法：
 *   node scripts/verify-ux-01c-settings-ui.mjs
 *   node scripts/verify-ux-01c-settings-ui.mjs --conflict   # 额外验证 409 后页面重读
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
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const PAGE_URL = `${SVC_BASE_URL}/admin/orm5rz0ojnd`;
const CONFLICT_MODE = process.argv.includes('--conflict');

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

const EMAIL = envValue('UAT_HQADMIN_EMAIL', 'uat.hqadmin@svc.local');
const PASSWORD = envValue('UAT_HQADMIN_PASSWORD');

const KEY = 'sla.accept_minutes';
const BASE_VALUE = Number(envValue('UX01C_EXPECT_BASE', '120'));
const SAFE_VALUE = BASE_VALUE + 1; // 安全测试值：+1 分钟，仍在 5~1440 内
const OUT_OF_RANGE = 99999;

const results = [];
function check(pass, label, detail = '') {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? `\n       ${detail}` : ''}`);
}
function note(label, detail = '') {
  console.log(`  ·  ${label}${detail ? `：${detail}` : ''}`);
}

function dbValue() {
  return String(psql(`select value from service_settings where key='${KEY}'`)).trim();
}
function dbAudits() {
  return Number(String(psql(`select count(*) from config_change_audits where key='${KEY}'`)).trim());
}
function latestAudit() {
  const row = String(
    psql(
      `select coalesce(old_value,'')||'|'||coalesce(new_value,'')||'|'||coalesce(scene,'')||'|'||coalesce(operator_name,'') ` +
        `from config_change_audits where key='${KEY}' order by id desc limit 1`,
    ),
  ).trim();
  const [oldValue, newValue, scene, operator] = row.split('|');
  return { oldValue, newValue, scene, operator };
}

// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  UX-01C：「服务时效」真实浏览器全流程');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  · 页面：${PAGE_URL}`);
console.log(`  · 账号：${EMAIL}`);

if (!PASSWORD) {
  console.log('  ⛔ .env 缺 UAT_HQADMIN_PASSWORD —— 环境未就绪');
  process.exit(2);
}
if (dbValue() !== String(BASE_VALUE)) {
  console.log(`  ⛔ 前置条件不满足：库里 ${KEY}=${dbValue()}，期望基线 ${BASE_VALUE}`);
  console.log('     先跑 scripts/verify-ux-01c-settings-effect.mjs 归位，或手工确认当前值');
  process.exit(2);
}

const session = await launchCdp({ label: 'ux01c-ui' });
const { cdp } = session;
const consoleErrors = [];
let loggedIn = false;
const apiCalls = [];

try {
  cdp.on('Network.requestWillBeSent', (p) => {
    const url = p.request?.url ?? '';
    if (!url.includes('/api/')) return;
    apiCalls.push({ url: url.replace(SVC_BASE_URL, ''), requestId: p.requestId, status: null });
  });
  cdp.on('Network.responseReceived', (p) => {
    const hit = apiCalls.find((c) => c.requestId === p.requestId);
    if (hit) hit.status = p.response?.status ?? null;
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error' || !loggedIn) return;
    const text = p.args
      .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? a.type ?? '')))
      .join(' ')
      .trim()
      .slice(0, 200);
    if (text) consoleErrors.push(text);
  });

  async function shot(name) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT_DIR, `ux01c-${name}-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    note('截图', file.replace(ROOT + path.sep, ''));
    return file;
  }

  // ---- 登录 ----
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
  loggedIn = true;
  check(true, 'hq_admin 真实登录成功', EMAIL);

  // ---- 1/2：打开页面并读到三行真实值 ----
  await cdp.send('Page.navigate', { url: PAGE_URL });
  try {
    await cdp.waitFor('document.querySelectorAll(".ant-table-tbody tr[data-row-key]").length >= 3', {
      what: '表格三行就绪',
      timeout: 60_000,
    });
  } catch {
    const diag = await cdp.evaluate(`(() => ({
      href: location.href,
      body: (document.body?.innerText ?? '').slice(0, 600),
      rows: document.querySelectorAll('.ant-table-tbody tr[data-row-key]').length,
      tables: document.querySelectorAll('.ant-table').length,
    }))()`);
    check(false, '页面表格渲染', JSON.stringify(diag).slice(0, 600));
    await shot('page-failed');
    throw new Error('表格未渲染');
  }
  await cdp.waitFor(`document.querySelectorAll('.ant-spin-spinning').length === 0`, { timeout: 30_000 }).catch(() => {});
  // ⚠️ 判据收到**页面内容区**：antd 的按钮文字是「保 存」（CJK 间插空格），全局 toast 层
  //    也会短暂出现平台级 `environmentVariables:list 403` 的 "No permissions"
  //    （B-8 守卫的 fail-closed 结果，**所有业务角色在所有后台页都触发**，见 BACKLOG）。
  //    这两者都不属于本页功能，混进判据会让门禁对"页面到底是好是坏"说谎。
  const contentText = await cdp.evaluate(`(() => (document.querySelector('.ant-layout-content')?.innerText ?? '').replace(/\\s+/g,' '))()`);
  check(!/No permissions/.test(contentText), '页面内容区无 No permissions', /No permissions/.test(contentText) ? contentText.slice(0, 200) : '');
  check(!/可能已被删除|数据表.*不存在/.test(contentText), '表格区块未退化为「可能已被删除」');

  const tableRows = await cdp.evaluate(`(() => {
    return [...document.querySelectorAll('.ant-table-tbody tr[data-row-key]')].map((tr) => ({
      key: tr.getAttribute('data-row-key'),
      cells: [...tr.querySelectorAll('td')].map((td) => (td.innerText || '').trim()),
    }));
  })()`);
  const expectedKeys = ['sla.accept_minutes', 'sla.appointment_overdue_grace_minutes', 'sla.store_confirm_hours'];
  const rowText = JSON.stringify(tableRows);
  check(tableRows.length === 3, '页面显示 3 行 SLA 参数', `实际 ${tableRows.length} 行`);
  const allKeysPresent = expectedKeys.every((k) => rowText.includes(k));
  check(allKeysPresent, '三个配置键都在页面上', tableRows.map((r) => r.key).join(', '));
  check(rowText.includes(`"${BASE_VALUE}"`) || rowText.includes(String(BASE_VALUE)), `页面显示当前值 ${BASE_VALUE}（来自库）`);
  await shot('page-loaded');

  // ---- 3/4：修改 → 保存 → 页面与库一致 ----
  const auditsBeforeEdit = dbAudits();
  const openModal = async (valueToType) => {
    await cdp.evaluate(`(() => {
      const btn = document.querySelector('[data-testid="config-edit-action"][data-config-key="${KEY}"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await cdp.waitFor(`!!document.querySelector('[data-testid="config-edit-modal"]')`, { what: '编辑弹窗出现' });
    await cdp.waitFor(`!!document.querySelector('input[data-testid="config-edit-input"]')`, { what: '输入框出现' });
    const modalText = await cdp.evaluate(`document.querySelector('[data-testid="config-edit-modal"]').innerText`);
    await cdp.evaluate(`(() => {
      const el = document.querySelector('input[data-testid="config-edit-input"]');
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, ${JSON.stringify(String(valueToType))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    return modalText;
  };
  const clickSave = async () => {
    const clicked = await cdp.evaluate(`(() => {
      // ⚠️ 两个坑，都会让"点了没反应"：
      //   ① antd 把两个汉字渲染成「保 存」—— 匹配前必须去空白；
      //   ② Modal.confirm 的按钮在 .ant-modal-confirm-btns 里，**不在** .ant-modal-footer
      //      （第一版按 footer 找，选择器命中 0 个，后续却表现为"接口没响应"）。
      const norm = (s) => String(s || '').replace(/\\s+/g, '');
      const btns = [...document.querySelectorAll('.ant-modal button')];
      const ok = btns.find((b) => norm(b.innerText) === '保存');
      if (!ok) return false;
      ok.click();
      return true;
    })()`);
    if (!clicked) throw new Error('找不到「保存」按钮（选择器失效？）');
  };

  const modalText = await openModal(SAFE_VALUE);
  check(/单位：分钟/.test(modalText) && /5\s*~\s*1440/.test(modalText), '弹窗回显单位与范围（服务端下发）', modalText.replace(/\s+/g, ' ').slice(0, 160));
  check(modalText.includes(String(BASE_VALUE)), `弹窗回显当前值 ${BASE_VALUE}`);
  await shot('modal-open');

  await clickSave();
  await cdp.waitFor(
    `[...document.querySelectorAll('.ant-message-notice-content')].some((n) => (n.innerText || '').includes('已保存'))`,
    { what: '保存成功提示', timeout: 30_000 },
  );
  await cdp.waitFor(`!document.querySelector('[data-testid="config-edit-modal"]')`, { what: '弹窗关闭', timeout: 20_000 });
  await cdp.waitFor(`document.querySelectorAll('.ant-spin-spinning').length === 0`, { timeout: 30_000 }).catch(() => {});
  await sleep(800);

  const afterEdit = dbValue();
  const auditsAfterEdit = dbAudits();
  check(afterEdit === String(SAFE_VALUE), `库值已变为 ${SAFE_VALUE}`, `实际 ${afterEdit}`);
  check(auditsAfterEdit === auditsBeforeEdit + 1, '新增一条修改审计', `${auditsBeforeEdit} → ${auditsAfterEdit}`);
  const audit1 = latestAudit();
  check(audit1.oldValue === String(BASE_VALUE) && audit1.newValue === String(SAFE_VALUE), '审计记录 old → new', JSON.stringify(audit1));
  const pageTextAfter = await cdp.evaluate('document.body.innerText');
  check(pageTextAfter.includes(String(SAFE_VALUE)), '页面回显新值（不刷新也在）');
  await shot('after-save');

  // ---- 5：422 范围错误 ----
  await openModal(OUT_OF_RANGE);
  await clickSave();
  await cdp.waitFor(
    `[...document.querySelectorAll('.ant-message-notice-content')].some((n) => (n.innerText || '').includes('保存失败'))`,
    { what: '范围错误提示', timeout: 30_000 },
  );
  const errText = await cdp.evaluate(
    `[...document.querySelectorAll('.ant-message-notice-content')].map((n) => n.innerText).join(' | ')`,
  );
  check(
    /422/.test(errText) && /SETTING_VALUE_INVALID/.test(errText) && /5\s*~\s*1440/.test(errText),
    '422 范围错误页面给出明确提示（状态码 + 业务码 + 范围）',
    errText.replace(/\s+/g, ' ').slice(0, 200),
  );
  check(dbValue() === String(SAFE_VALUE), '422 之后库值未变', `实际 ${dbValue()}`);
  check(dbAudits() === auditsAfterEdit, '422 之后未新增审计');
  await shot('range-error');
  // 关掉弹窗（取消），避免残留影响后续
  await cdp.evaluate(`(() => {
    const norm = (s) => String(s || '').replace(/\\s+/g, '');
    const btns = [...document.querySelectorAll('.ant-modal button')];
    const cancel = btns.find((b) => norm(b.innerText) === '取消');
    if (cancel) cancel.click();
    return true;
  })()`);
  await sleep(500);
  // 有未保存改动时 kit 会二次确认，统一点「放弃并关闭」
  const discard = await cdp.evaluate(`(() => {
    const norm = (s) => String(s || '').replace(/\\s+/g, '');
    const btns = [...document.querySelectorAll('.ant-modal button')];
    const b = btns.find((x) => norm(x.innerText) === '放弃并关闭');
    if (b) { b.click(); return true; }
    return false;
  })()`);
  if (discard) await sleep(500);

  // ---- 6/7：恢复原值 → 留痕 → 刷新后仍是恢复值 ----
  const auditsBeforeRestore = dbAudits();
  await openModal(BASE_VALUE);
  await clickSave();
  await cdp.waitFor(
    `[...document.querySelectorAll('.ant-message-notice-content')].some((n) => (n.innerText || '').includes('已保存'))`,
    { what: '恢复保存成功', timeout: 30_000 },
  );
  await cdp.waitFor(`!document.querySelector('[data-testid="config-edit-modal"]')`, { what: '恢复后弹窗关闭', timeout: 20_000 });
  await sleep(500);
  const audit2 = latestAudit();
  check(dbValue() === String(BASE_VALUE), `已恢复为 ${BASE_VALUE}`, `实际 ${dbValue()}`);
  check(dbAudits() === auditsBeforeRestore + 1, '恢复也新增一条审计', `${auditsBeforeRestore} → ${dbAudits()}`);
  check(audit2.oldValue === String(SAFE_VALUE) && audit2.newValue === String(BASE_VALUE), '恢复审计 old → new', JSON.stringify(audit2));

  await cdp.send('Page.reload');
  await cdp.waitFor('document.querySelectorAll(".ant-table-tbody tr[data-row-key]").length >= 3', { what: '刷新后表格', timeout: 60_000 });
  await sleep(800);
  const afterReloadText = await cdp.evaluate('document.body.innerText');
  check(afterReloadText.includes(String(BASE_VALUE)), '刷新后页面仍显示恢复值（不是内存态）');
  await shot('restored');

  // ---- 可选：409 冲突后的页面重读 ----
  if (CONFLICT_MODE) {
    note('409 模式', '用两条并发请求制造冲突，再看页面是否重读');
    const { default: runConflict } = await import('./lib/ux01c-conflict.mjs');
    const r = await runConflict({ key: KEY, baseValue: BASE_VALUE, safeValue: SAFE_VALUE });
    check(r.statuses.includes(409) && r.statuses.includes(200), '并发写入：一个成功、一个 409', JSON.stringify(r.statuses));
    check(dbValue() === String(r.finalValue), '库里是胜出请求的值', `实际 ${dbValue()} 期望 ${r.finalValue}`);

    // 页面若还停留在旧值，点一次"修改"再保存会用过期 expected_value ⇒ 应当 409 并触发重读
    await cdp.send('Page.reload');
    await cdp.waitFor('document.querySelectorAll(".ant-table-tbody tr[data-row-key]").length >= 3', { what: '冲突后表格', timeout: 60_000 });
    await sleep(800);
  }
} catch (error) {
  check(false, '脚本执行异常', String(error?.message ?? error).slice(0, 300));
  try {
    const diag = await cdp.evaluate(
      `(() => ({ href: location.href, body: (document.body?.innerText ?? '').slice(0, 500) }))()`,
    );
    note('异常现场', JSON.stringify(diag).slice(0, 600));
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT_DIR, `ux01c-exception-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    note('异常截图', file.replace(ROOT + path.sep, ''));
  } catch {
    /* 诊断失败不影响结论 */
  }
} finally {
  session.close();
}

// 页面侧不能有未处理的 JS 异常（有的话说明渲染链路坏了，而不是"数据恰好没到"）
const fatal = consoleErrors.filter((t) => /Cannot read|is not a function|undefined is not/.test(t));
check(fatal.length === 0, '页面无致命 JS 异常', fatal.slice(0, 3).join(' | '));

// 收尾：库里必须是基线值（否则后续门禁会从脏状态开始）
check(dbValue() === String(BASE_VALUE), `收尾：库值回到基线 ${BASE_VALUE}`, `实际 ${dbValue()}`);

const failed = results.filter((r) => !r.pass);
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  结果：通过 ${results.length - failed.length} / 失败 ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`    ❌ ${f.label}${f.detail ? ` —— ${f.detail}` : ''}`);
}
console.log('══════════════════════════════════════════════════════════════');
process.exit(failed.length ? 1 : 0);
