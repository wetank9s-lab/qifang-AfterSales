#!/usr/bin/env node
/**
 * _probe-historical-wizard-runner.mjs —— **历史 Excel 导入向导**的真实浏览器 worker
 * （被 `verify-historical-wizard-ui.mjs` 调用；拆成独立文件是既有纪律，见
 *   `_probe-detail-request-runner.mjs` 的头部说明：探针要生成浏览器侧表达式，
 *   塞进父脚本的模板字符串会双层转义 —— 本项目已被这件事咬过两次。）
 *
 * ===========================================================================
 * 它走的是**真人那条路**，而且是用户第 7 条点名的七步
 * ===========================================================================
 *   ① 选文件（真的把磁盘上的 .xlsx 交给浏览器的 file input）
 *   ② 看识别到的工作表与行数（读界面文字，不看接口）
 *   ③ 选工作表 + 表头行
 *   ④ 把 Excel 的列对上业务字段（**真的在 antd Select 里改选**）
 *   ⑤ 预览「清洗前 / 清洗后」对照
 *   ⑥ 看异常清单与原因
 *   ⑦ 安全暂存
 *
 * ⚠️ 每一步都截图落盘（`storage/tmp/historical-ui/`），因为**文字断言会骗人**：
 *    "页面上有这句话"与"人真的看得见这一屏"是两件事（DEV-65/68 同型）。
 *
 * 输入：PROBE_CHROME / PROBE_BASE / PROBE_TARGET / PROBE_EMAIL / PROBE_PASSWORD /
 *       PROBE_FILE（要上传的 Excel 绝对路径）/ PROBE_SHOT_DIR
 * 输出：stdout 一行 `WIZPROBE|{json}`
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { SVC_BASE_URL_PORT } from './lib/base-url.mjs';

const CHROME = process.env.PROBE_CHROME;
const BASE = process.env.PROBE_BASE;
const TARGET = process.env.PROBE_TARGET;
const EMAIL = process.env.PROBE_EMAIL;
const PASSWORD = process.env.PROBE_PASSWORD;
const FILE = process.env.PROBE_FILE;
const SHOT_DIR = process.env.PROBE_SHOT_DIR;

const PORT = 9900 + Math.floor(Math.random() * 90);
const userDir = `${process.env.TEMP || '/tmp'}\\cdp-wiz-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const child = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    // 演练证书是自签的：不加这一条，页面根本打不开（表现为"登录页未就绪"）
    '--ignore-certificate-errors',
    '--window-size=1600,1100',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reqs = new Map();
const resps = [];
const consoleMsgs = [];
const pageExceptions = [];
const shots = [];

function bail(obj) {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  console.log(`WIZPROBE|${JSON.stringify(obj)}`);
  process.exit(0);
}

/**
 * 🔴 CDP 的 `/json/version` 是 **HTTP**，与业务站点的协议无关。
 *
 * ⚠️ 这里**不能**复用 `SVC_SCHEME`：P10-C 起 `SVC_SCHEME=https`，
 *    而 Chrome 的调试端口**从不提供 TLS**。用 https 拼出来只会连接失败，
 *    再被 `catch` 吞掉 60 次，最后笼统地报一句「CDP 未启动」——
 *    排查时会一路怀疑 Chrome 装坏了，而真正的原因是一个协议前缀。
 *    （这就是"探针自己造出来的故障"，本项目的 DEV-66/67 同型。）
 */
const CDP_HTTP = `http://127.0.0.1:${PORT}`;
let ver = null;
let lastErr = '';
for (let i = 0; i < 60; i += 1) {
  try {
    ver = await (await fetch(`${CDP_HTTP}/json/version`)).json();
    break;
  } catch (e) {
    lastErr = String(e?.message ?? e);
    await sleep(500);
  }
}
if (!ver) bail({ ok: false, why: `CDP 未启动（最后一次错误：${lastErr}）` });

const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const mid = ++id;
  const msg = { id: mid, method, params: params ?? {} };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => pending.set(mid, { res, rej }));
}
const eventHandlers = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.rej(new Error(`${m.method}: ${m.error.message}`));
    else p.res(m.result);
    return;
  }
  if (m.method) {
    for (const h of eventHandlers) {
      try {
        h(m);
      } catch {
        /* 事件处理不得影响主流程 */
      }
    }
  }
});
await new Promise((r) => ws.addEventListener('open', r));

const targets = await send('Target.getTargets', {});
const pageTarget = targets.targetInfos.find((t) => t.type === 'page');
if (!pageTarget) bail({ ok: false, why: '无 page target' });
const { sessionId } = await send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
const ctx = (method, params) => send(method, params, sessionId);

await ctx('Runtime.enable');
await ctx('Page.enable');
await ctx('DOM.enable');
await ctx('Network.enable', { maxTotalBufferSize: 200 * 1024 * 1024, maxResourceBufferSize: 10 * 1024 * 1024 });
await ctx('Log.enable').catch(() => {});

eventHandlers.push((m) => {
  if (m.method === 'Network.requestWillBeSent') {
    const p = m.params;
    reqs.set(p.requestId, { url: p.request.url, method: p.request.method });
  } else if (m.method === 'Network.responseReceived') {
    const p = m.params;
    const r = reqs.get(p.requestId) || { url: p.response.url, method: '?' };
    resps.push({ requestId: p.requestId, url: p.response.url, method: r.method, status: p.response.status });
  } else if (m.method === 'Runtime.consoleAPICalled') {
    const p = m.params;
    consoleMsgs.push({
      kind: `console:${p.type}`,
      text: (p.args || []).map((a) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 400),
    });
  } else if (m.method === 'Runtime.exceptionThrown') {
    pageExceptions.push(String(m.params?.exceptionDetails?.exception?.description ?? '').slice(0, 400));
  }
});

async function ev(expression) {
  const r = await ctx('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.result?.subtype === 'error') throw new Error(`evaluate 抛错：${String(r.result.description).split('\n')[0]}`);
  return r?.result?.value;
}

async function shot(name) {
  try {
    const r = await ctx('Page.captureScreenshot', { format: 'png' });
    const p = path.join(SHOT_DIR, `${name}.png`);
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    shots.push(p);
  } catch (e) {
    shots.push(`(截图失败 ${name}: ${e.message})`);
  }
}

/** 等某个选择器出现 */
async function waitFor(selector, ms = 40000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    const n = await ev(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    if (Number(n) > 0) return true;
    await sleep(1000);
  }
  return false;
}

/** 按可见文字点按钮 */
async function clickByText(text, scope = 'document') {
  return ev(
    `(() => {
       const root = ${scope};
       const el = [...root.querySelectorAll('button, a')].find((x) => (x.innerText || '').trim().includes(${JSON.stringify(text)}));
       if (!el) return 'NOT_FOUND';
       el.click();
       return 'CLICKED';
     })()`,
  );
}

/**
 * 在 antd Select 里选一项。
 *
 * 🔴 必须用 **mousedown/click 事件序列**打在 `.ant-select-selector` 上。
 *
 *    第一版直接对 `[data-testid=…]`（也就是 `.ant-select` 根 div）调 `el.click()`，
 *    结果下拉**根本没打开** —— 表现为 `NO_OPTION:`（选项列表为空），
 *    而脚本只会说"没找到选项"，看不出是"没打开"。antd 的 Select 是在
 *    **mousedown** 上开下拉的，而 `HTMLElement.click()` 只派发一个 `click` 事件。
 *
 *    ⇒ 这也是"探针自己造出来的故障"：界面是好的，是探针不会用。
 *      判据要能区分"界面坏了"与"探针没点对"，所以这里返回的是
 *      `OPENED_BUT_NO_OPTION` 与 `NO_SELECT` 两种不同的结果。
 */
async function selectOption(testid, optionTextIncludes, { expectOptions = true } = {}) {
  const opened = await ev(
    `(() => {
       const root = document.querySelector('[data-testid="${testid}"]');
       if (!root) return 'NO_SELECT';
       const target = root.querySelector('.ant-select-selector') || root;
       for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
         target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
       }
       return 'OPENED';
     })()`,
  );
  if (opened !== 'OPENED') return opened;
  await sleep(1200);
  return ev(
    `(() => {
       const opts = [...document.querySelectorAll('.ant-select-item-option')];
       if (!opts.length) return 'OPENED_BUT_NO_OPTION';
       const hit = opts.find((o) => (o.innerText || '').includes(${JSON.stringify(optionTextIncludes)}));
       if (!hit) {
         return 'NO_MATCH:' + opts.map((o) => (o.innerText || '').trim()).slice(0, 8).join(' / ');
       }
       const target = hit.querySelector('.ant-select-item-option-content') || hit;
       for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
         target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
       }
       return 'PICKED';
     })()`,
  );
  void expectOptions;
}

try {
  // ---------------------------------------------------------------- 登录
  await ctx('Page.navigate', { url: `${BASE}/signin` });
  await sleep(15000);
  const inputCount = await ev("document.querySelectorAll('input').length");
  if (Number(inputCount) < 2) bail({ ok: false, why: `登录页未就绪（inputs=${inputCount}）` });
  await ev(
    `(() => {
       const ins = [...document.querySelectorAll('input')];
       const set = (el, v) => {
         const s = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
         s.call(el, v);
         el.dispatchEvent(new Event('input', { bubbles: true }));
         el.dispatchEvent(new Event('change', { bubbles: true }));
       };
       set(ins[0], ${JSON.stringify(EMAIL)});
       set(ins[1], ${JSON.stringify(PASSWORD)});
       return true;
     })()`,
  );
  await sleep(1000);
  await clickByText('登录');
  {
    const dl = Date.now() + 60000;
    while (Date.now() < dl) {
      await sleep(2000);
      const u = await ev('location.href');
      if (String(u).indexOf('/signin') === -1) break;
    }
  }
  const afterLoginUrl = await ev('location.href');
  if (String(afterLoginUrl).indexOf('/signin') !== -1) bail({ ok: false, why: '登录失败（仍停在 /signin）' });

  // ---------------------------------------------------------------- 打开「历史数据导入」页
  await ctx('Page.navigate', { url: BASE + TARGET });
  await sleep(12000);
  const sawEntryButton = await waitFor('[data-testid="historical-import-modal"]', 1000);
  void sawEntryButton;
  // 入口是区块工具栏上的按钮 —— 等它渲染出来
  {
    const dl = Date.now() + 60000;
    while (Date.now() < dl) {
      const t = await ev(
        `[...document.querySelectorAll('button')].some((b) => (b.innerText || '').includes('上传历史 Excel'))`,
      );
      if (t === true) break;
      await sleep(2000);
    }
  }
  await shot('01-page');

  // ---------------------------------------------------------------- ① 打开向导
  const open = await clickByText('上传历史 Excel');
  if (open !== 'CLICKED') bail({ ok: false, why: `找不到「上传历史 Excel」按钮（${open}）` });
  const modalOk = await waitFor('[data-testid="historical-import-wizard"]', 30000);
  if (!modalOk) bail({ ok: false, why: '向导弹窗没有出现' });
  await sleep(800);
  await shot('02-wizard-open');

  // ---------------------------------------------------------------- ② 真的把文件交给浏览器
  const fileInputOk = await ev(`document.querySelectorAll('input[type=file]').length > 0`);
  if (!fileInputOk) bail({ ok: false, why: '向导里没有 file input' });
  {
    const obj = await ctx('Runtime.evaluate', {
      expression: `document.querySelector('input[type=file]')`,
      returnByValue: false,
    });
    const objectId = obj?.result?.objectId;
    if (!objectId) bail({ ok: false, why: '取不到 file input 的 objectId' });
    await ctx('DOM.setFileInputFiles', { files: [FILE], objectId });
  }
  await sleep(800);
  await shot('03-file-picked');

  const upClicked = await ev(
    `(() => { const b = document.querySelector('[data-testid="hi-upload"]'); if (!b) return 'NO_BTN'; b.click(); return 'CLICKED'; })()`,
  );
  if (upClicked !== 'CLICKED') bail({ ok: false, why: '找不到「上传并识别」按钮' });

  // ---------------------------------------------------------------- ③ 识别结果
  if (!(await waitFor('[data-testid="hi-sheet"]', 60000))) {
    const err = await ev(
      `(() => { const e = document.querySelector('[data-testid="hi-error"]'); return e ? (e.innerText || '') : ''; })()`,
    );
    bail({ ok: false, why: `上传后没有出现工作表选择器。界面报错：${String(err).slice(0, 200)}` });
  }
  await sleep(1500);
  await shot('04-recognized');

  const ledgerText = String(
    (await ev(
      `(() => { const e = document.querySelector('[data-testid="hi-ledger"]'); return e ? (e.innerText || '') : ''; })()`,
    )) ?? '',
  ).replace(/\s+/g, ' ');

  // 打开工作表下拉，**先把它真的列出来**（这条本身就是"识别工作表"的证据）
  await ev(
    `(() => {
       const root = document.querySelector('[data-testid="hi-sheet"]');
       const target = root.querySelector('.ant-select-selector') || root;
       for (const t of ['mousedown', 'mouseup', 'click']) {
         target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, button: 0 }));
       }
       return true;
     })()`,
  );
  await sleep(1200);
  const sheetOptionTexts = JSON.parse(
    (await ev(
      `JSON.stringify([...document.querySelectorAll('.ant-select-item-option')].map((o) => (o.innerText || '').trim()))`,
    )) ?? '[]',
  );

  // ---------------------------------------------------------------- ④ 选 Sheet2（两列电话的那张）
  const switchSheet = await selectOption('hi-sheet', 'Sheet2');
  await sleep(2500);
  await shot('05-sheet2-selected');

  // 选完再关掉可能残留的下拉，避免遮住后续操作
  await ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await sleep(400);

  const ambiguousText = String(
    (await ev(
      `(() => { const e = document.querySelector('[data-testid="hi-ambiguous"]'); return e ? (e.innerText || '') : ''; })()`,
    )) ?? '',
  ).replace(/\s+/g, ' ');

  // 映射：把「联系电话」改到有数据的那一列（界面上真的改选）
  const mappingBefore = await ev(
    `(() => { const e = document.querySelector('[data-testid="hi-map-customerPhone"]'); return e ? (e.innerText || '').trim() : ''; })()`,
  );
  const pickPhone = await selectOption('hi-map-customerPhone', '手机号');
  await sleep(1200);
  const mappingAfter = await ev(
    `(() => { const e = document.querySelector('[data-testid="hi-map-customerPhone"]'); return e ? (e.innerText || '').trim() : ''; })()`,
  );
  await shot('06-mapping-changed');

  // ---------------------------------------------------------------- ⑤ 预览（改映射前）
  const previewBefore = await ev(
    `(() => { const b = document.querySelector('[data-testid="hi-preview"]'); if (!b) return 'NO_BTN'; b.click(); return 'CLICKED'; })()`,
  );
  void previewBefore;
  await waitFor('[data-testid="hi-preview-table"]', 60000);
  await sleep(1500);
  const qualityAfterFix = String(
    (await ev(
      `(() => { const e = document.querySelector('[data-testid="hi-quality"]'); return e ? (e.innerText || '') : ''; })()`,
    )) ?? '',
  ).replace(/\s+/g, ' ');
  await shot('07-preview-after-fix');

  const previewRowCount = Number(
    await ev(`document.querySelectorAll('[data-testid="hi-preview-table"] tbody tr').length`),
  );
  const dispositionTags = JSON.parse(
    (await ev(
      `JSON.stringify([...document.querySelectorAll('[data-testid="hi-disposition"]')].map((t) => (t.innerText || '').trim()))`,
    )) ?? '[]',
  );
  const rawSample = String(
    (await ev(
      `(() => { const e = document.querySelector('[data-testid="hi-raw"]'); return e ? (e.innerText || '') : ''; })()`,
    )) ?? '',
  ).replace(/\s+/g, ' ');
  const stdSample = String(
    (await ev(
      `(() => { const e = document.querySelector('[data-testid="hi-standardized"]'); return e ? (e.innerText || '') : ''; })()`,
    )) ?? '',
  ).replace(/\s+/g, ' ');
  const issuesSample = String(
    (await ev(
      `(() => { const e = document.querySelector('[data-testid="hi-issues"]'); return e ? (e.innerText || '') : ''; })()`,
    )) ?? '',
  ).replace(/\s+/g, ' ');

  // ---------------------------------------------------------------- ⑥ 改回自动映射，再预览一次（"改映射 → 重新校验"）
  await ev(
    `(() => { const b = document.querySelector('[data-testid="hi-back"]'); if (b) b.click(); return true; })()`,
  );
  await sleep(1500);
  const pickPhoneBack = await selectOption('hi-map-customerPhone', '用户电话');
  await sleep(1000);
  await ev(
    `(() => { const b = document.querySelector('[data-testid="hi-preview"]'); if (b) b.click(); return true; })()`,
  );
  await waitFor('[data-testid="hi-preview-table"]', 60000);
  await sleep(1500);
  const qualityBeforeFix = String(
    (await ev(
      `(() => { const e = document.querySelector('[data-testid="hi-quality"]'); return e ? (e.innerText || '') : ''; })()`,
    )) ?? '',
  ).replace(/\s+/g, ' ');
  await shot('08-preview-before-fix');

  // ---------------------------------------------------------------- ⑦ 安全暂存
  const staged = await ev(
    `(() => { const b = document.querySelector('[data-testid="hi-stage"]'); if (!b) return 'NO_BTN'; b.click(); return 'CLICKED'; })()`,
  );
  if (staged !== 'CLICKED') bail({ ok: false, why: '找不到「安全暂存」按钮' });
  const stagedOk = await waitFor('[data-testid="hi-staged"]', 60000);
  await sleep(1200);
  const stagedText = String(
    (await ev(
      `(() => { const e = document.querySelector('[data-testid="hi-staged"]'); return e ? (e.innerText || '') : ''; })()`,
    )) ?? '',
  ).replace(/\s+/g, ' ');
  await shot('09-staged');

  const btnTexts = JSON.parse(
    (await ev(
      `JSON.stringify([...document.querySelectorAll('[data-testid="historical-import-wizard"] button')].map((b) => (b.innerText || '').trim()))`,
    )) ?? '[]',
  );

  child.kill();
  console.log(
    `WIZPROBE|${JSON.stringify({
      ok: true,
      afterLoginUrl,
      ledgerText,
      sheetOptionTexts,
      switchSheet,
      ambiguousText,
      mappingBefore,
      mappingAfter,
      pickPhone,
      pickPhoneBack,
      qualityBeforeFix,
      qualityAfterFix,
      previewRowCount,
      dispositionTags,
      rawSample,
      stdSample,
      issuesSample,
      stagedOk,
      stagedText,
      btnTexts,
      shots,
      consoleMsgs,
      pageExceptions,
      svcRequests: resps.filter((r) => /svc:historical/.test(String(r.url))),
    })}`,
  );
} catch (e) {
  child.kill();
  console.log(
    `WIZPROBE|${JSON.stringify({ ok: false, why: String(e && e.message).slice(0, 500), shots, consoleMsgs, pageExceptions })}`,
  );
  process.exit(0);
}
void PORT;
void SVC_BASE_URL_PORT;
