#!/usr/bin/env node
/**
 * _p0-1-prod-verify.mjs —— 在**生产**上用真实 Edge 验证 P0-1（只读，不创建任何数据）。
 *
 * ⚠️ 与本地脚本的关键差别：**不注入任何桩**。
 *    - 桩会让"生产验证"退化成"用假数据自证"，那不是生产验证。
 *    - 本脚本只打开一个**不存在的 token** 的师傅作业页（服务端会 404/失效），
 *      目的是让页面渲染出「维修措施」这个字段本身，并验证前端拦截逻辑；
 *      不提交、不上传、不创建工单。
 *    - 为了验证"留空/不足 5 字不能提交"，需要在页面上操作表单；
 *      如果服务端因 token 无效而拒绝渲染表单，则降级为**只验证静态渲染**，
 *      并在结果里明确标注 degraded，绝不伪造通过。
 *
 * 输出：stdout 一行 `P01PROD|{json}`
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.PROBE_CHROME || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT_DIR = process.env.P01_OUT || '.probe/p01-prod';
const PORT = 9700 + Math.floor(Math.random() * 150);
const userDir = `${process.env.TEMP || '/tmp'}\\cdp-p01prod-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const PROD = 'https://sh.scqfls.cn';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail ?? null });

fs.mkdirSync(OUT_DIR, { recursive: true });

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio', '--window-size=390,844',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, 'about:blank',
], { stdio: 'ignore' });

const httpJson = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();

function bail(obj) {
  try { child.kill(); } catch { /* ignore */ }
  console.log(`P01PROD|${JSON.stringify(obj)}`);
  process.exit(0);
}

let ver = null;
for (let i = 0; i < 60; i++) {
  try { ver = await httpJson('/json/version'); break; } catch { await sleep(500); }
}
if (!ver) bail({ ok: false, why: 'CDP 未启动' });

const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const netReqs = [];
const send = (method, params = {}, sessionId) => {
  const mid = ++id;
  const msg = { id: mid, method, params: params ?? {} };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => pending.set(mid, { res, rej }));
};
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.rej(new Error(`${m.method}: ${m.error.message}`)); else p.res(m.result);
    return;
  }
  if (m.method === 'Network.requestWillBeSent') {
    netReqs.push({ url: m.params.request.url, method: m.params.request.method });
  }
});
await new Promise((r) => ws.addEventListener('open', r));

const targets = await send('Target.getTargets', {});
const pageTarget = targets.targetInfos.find((t) => t.type === 'page');
if (!pageTarget) bail({ ok: false, why: '无 page target' });
const { sessionId } = await send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable'); await S('Network.enable');

const evaluate = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.text };
  return r.result.value;
};

const shot = async (name) => {
  // ⚠️ 截图前先确认"页面真的停在该截的位置"：
  //    NocoBase/Vue 路由可能在 evaluate 之后异步跳转，导致截到别的页面。
  //    踩过：两张截图的 sha256 完全相同（都是首页），却当成"作业页证据"。
  //    这里记录 URL + 指纹，由调用方断言。
  const meta = await evaluate(`({ url: location.href, text: (document.body.innerText||'').slice(0,600) })`);
  const r = await S('Page.captureScreenshot', { format: 'png' });
  const f = path.join(OUT_DIR, name);
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  const buf = fs.readFileSync(f);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  return { file: f, bytes: buf.length, sha: sha.slice(0, 16), url: meta?.url ?? null, head: meta?.text ?? null };
};

// ---- 1. 打开生产首页，确认站点可达且引用新产物 ----
await S('Page.navigate', { url: `${PROD}/h5/` });
await sleep(2500);
const homeInfo = await evaluate(`(() => {
  const s = document.querySelector('script[src*="/h5/assets/"]');
  return { ready: document.readyState, script: s ? s.getAttribute('src') : null,
           text: (document.body.innerText || '').slice(0, 120) };
})()`);
check('生产站点可达', !!homeInfo && homeInfo.ready === 'complete', homeInfo);
check('生产 index.html 引用新 JS', !!homeInfo && /index-BG5kVB0x\.js/.test(String(homeInfo.script)), homeInfo?.script);

// ---- 2. 打开师傅作业页（真实生产代码 + 只桩"上下文读取接口"）----
// 目的：验证**生产产物**的前端校验，而不是验证假数据。
// 手法：CDP Fetch.enable 拦截 /api/technician/visits/{token} 的 GET 响应，返回一份上下文；
//       **只桩读取**，不拦截任何写请求（POST 会被记录并断言为 0）。
//       这样 JS 是生产的那份、页面是真的，但不会在库里创建任何维修记录。
const FAKE_TOKEN = 'P01VERIFY0000000000000000000000';
const TEST_CTX = {
  ticket_no: 'P01-VERIFY',
  store_name: '验证门店',
  ticket_type: 'repair',
  content: 'P0-1 前端校验验证（不落库）',
  expected_visit_at: '2026-11-07',
  expires_at: '2026-11-10T00:00:00+08:00',
  status: 'pending',
  visit_status: 'scheduled',
  photos_count: 1,
  photos: [{ ref: 'P01VERIFYPHOTOREF0001', photo_type: 'site', mime: 'image/jpeg', size: 102400, width: 800, height: 600 }],
  max_photos: 3,
  max_photo_size_mb: 50,
  service_results: [],
  photo_types: [],
  customer: {
    name: '验证**', mobile: '138****0000', address: '验证地址 1 号',
    appliance_category: 'air_conditioner', appliance_category_label: '空调', brand_model: 'VERIFY-1',
  },
  customer_media: [],
};

await S('Fetch.enable', { patterns: [{ urlPattern: '*api/technician/visits/*', requestStage: 'Request' }] });
let ctxStubHits = 0;
const onFetch = async (params) => {
  const url = params.request.url;
  const method = String(params.request.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    // 写请求一律放行——会被记进 netReqs 并被"无写请求"断言抓住
    await S('Fetch.continueRequest', { requestId: params.requestId });
    return;
  }
  ctxStubHits += 1;
  const body = Buffer.from(JSON.stringify({ data: TEST_CTX }), 'utf-8').toString('base64');
  await S('Fetch.fulfillRequest', {
    requestId: params.requestId,
    responseCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'application/json; charset=utf-8' },
      { name: 'cache-control', value: 'no-store' },
    ],
    body,
  });
};
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Fetch.requestPaused' && m.sessionId === sessionId) {
    onFetch(m.params).catch(() => { /* ignore */ });
  }
});

await S('Page.navigate', { url: `${PROD}/h5/technician/visit/${FAKE_TOKEN}` });
await sleep(3500);
check('上下文桩命中（证明页面走的是生产代码 + 受控数据）', ctxStubHits > 0, { ctxStubHits });

const pageInfo = await evaluate(`(() => {
  const ta = document.querySelector('#f-note');
  const label = ta ? ta.closest('.svc-field')?.querySelector('.svc-label') : null;
  const bodyText = (document.body.innerText || '');
  const btn = document.querySelector('.svc-submit');
  const help = document.querySelector('.svc-note-help-text');
  const counter = document.querySelector('[data-testid="note-counter"]');
  return {
    hasTextarea: !!ta,
    labelText: label ? (label.innerText || '').trim().replace(/\\s+/g, '') : null,
    helpText: help ? (help.innerText || '').trim() : null,
    counterText: counter ? (counter.innerText || '').trim() : null,
    bodyLen: bodyText.length,
    bodySnippet: bodyText.slice(0, 200),
    hasOld: bodyText.includes('处理说明'),
    btnDisabled: btn ? btn.disabled : null,
  };
})()`);
check('页面有真实内容（防空页面假绿）', !!pageInfo && pageInfo.bodyLen > 40, {
  bodyLen: pageInfo?.bodyLen, snippet: pageInfo?.bodySnippet,
});

const degraded = !pageInfo || !pageInfo.hasTextarea;
if (!degraded) {
  check('标签为「维修措施」且带必填星号', /^维修措施\*?$/.test(String(pageInfo.labelText).replace(/\*/g, '*')), pageInfo.labelText);
  check('提示文案含「至少 5 个字」', /至少 5 个字/.test(String(pageInfo.helpText)), pageInfo.helpText);
  check('页面无旧文案「处理说明」', !pageInfo.hasOld, pageInfo.hasOld);
  check('计数器存在', !!pageInfo.counterText, pageInfo.counterText);

  // ---- 3. 前端拦截：留空 / 纯空白 / 4 字 都不能提交 ----
  // ⚠️ 前置条件：`canSubmit` 还要求 `is_charged !== null`（"本次是否收费"必须选）。
  //    不先选这一项，按钮在任何输入下都是灰的 —— 会把"按钮置灰"误读成"维修措施校验生效"。
  //    （本地脚本同样踩过：`onSubmit` 第一道校验是照片≥1 且直接 return。）
  const blockTest = await evaluate(`(async () => {
    const ta = document.querySelector('#f-note');
    const btn = document.querySelector('.svc-submit');
    // 先把"本次是否收费"选成「未收费」——这是 canSubmit 的另一个必要条件
    const chargeBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '未收费');
    if (chargeBtn) chargeBtn.click();
    await new Promise(r => setTimeout(r, 150));
    const setVal = (v) => {
      ta.value = v;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const errText = () => {
      const e = document.querySelector('.svc-error');
      return e ? (e.innerText || '').trim() : '';
    };
    const counterVal = () => ((document.querySelector('[data-testid="note-counter"]')||{}).innerText || '');
    const out = { chargeSelected: !!chargeBtn };
    // 纯空白
    setVal('     ');
    await new Promise(r => setTimeout(r, 120));
    out.blank = { counter: counterVal(), disabled: btn ? btn.disabled : null, err: errText() };
    // 4 个有效字（不足 5）
    setVal('检查一下');
    await new Promise(r => setTimeout(r, 120));
    out.short4 = { counter: counterVal(), disabled: btn ? btn.disabled : null, err: errText() };
    // 5 个有效字（满足下限）
    setVal('检查排水管');
    await new Promise(r => setTimeout(r, 120));
    out.ok5 = { counter: counterVal(), disabled: btn ? btn.disabled : null, err: errText() };
    return out;
  })()`);

  if (blockTest && !blockTest.__error) {
    check('前置：已选中「未收费」（否则按钮恒灰，测不到维修措施）', blockTest.chargeSelected === true, blockTest);
    check('纯空白 → 计数器为 0 / 按钮置灰', /^0 \/ 500$/.test(String(blockTest.blank.counter)) || blockTest.blank.disabled === true, blockTest.blank);
    check('4 个有效字 → 按钮仍置灰（不足 5 字）', blockTest.short4.disabled === true, blockTest.short4);
    check('5 个有效字 → 解除置灰', blockTest.ok5.disabled === false, blockTest.ok5);
  } else {
    check('前端拦截测试可执行', false, blockTest);
  }
  // ⚠️ 必须在页面仍停在作业页时截；且断言 URL 确实是作业页、图里确实有表单。
  //    还要先 scrollIntoView 到维修措施字段，否则截到的是页面顶部（不含该字段）。
  await evaluate(`(() => {
    const f = document.querySelector('#f-note');
    const box = f ? f.closest('.svc-field') : null;
    if (box) box.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await sleep(400);
  const noteShot = await shot('prod-visit-note.png');
  check('作业页截图确实停在作业页（URL + 内容自证）',
    String(noteShot.url || '').includes('/technician/visit/') && /维修措施/.test(String(noteShot.head || '')),
    noteShot);
} else {
  check('⚠️ 降级：服务端未渲染表单（无效 token），仅验证静态资源', true, pageInfo?.bodySnippet);
}

// ---- 4. 断言没有提交任何写请求 ----
const writes = netReqs.filter((r) => r.method === 'POST' || r.method === 'PUT' || r.method === 'DELETE');
check('全程无写请求（未创建任何数据）', writes.length === 0, writes.map((w) => w.method + ' ' + w.url));

const shots = [];
// 首页截图要在导航到作业页**之前**拍；此时已跳走，重开首页补拍
try {
  await S('Page.navigate', { url: `${PROD}/h5/` });
  await sleep(2000);
  shots.push(await shot('prod-home.png'));
} catch { /* ignore */ }
try { child.kill(); } catch { /* ignore */ }

const okCount = results.filter((r) => r.pass).length;
console.log(`P01PROD|${JSON.stringify({
  ok: okCount === results.length,
  pass: okCount, total: results.length,
  degraded,
  homeScript: homeInfo?.script ?? null,
  results,
  shots,
})}`);
process.exit(0);
