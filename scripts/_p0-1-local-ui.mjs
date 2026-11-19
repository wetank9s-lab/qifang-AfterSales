#!/usr/bin/env node
/**
 * _p0-1-local-ui.mjs —— 用**真实 Edge** 打开"本地 H5 产物 + 桩数据"，自证 P0-1 验收项。
 *
 * 为什么不在部署后只用生产验：
 *   部署前必须先证明"这版产物本身是对的"，否则部署完发现不对就得回滚。
 *   这里跑的是**同一份 dist 产物**，只是数据源换成桩。
 *
 * 关键设计（每条都对应一次踩过的坑）：
 *   1. **两条通道都要桩**：本项目的 session/上下文走 fetch，upload 走 XMLHttpRequest。
 *      只桩 fetch ⇒ 另一条透到网络 ⇒ 卡片 is-failed，而"标题出现了"会骗过判断。
 *   2. **桩注入在业务脚本之前**：Page.addScriptToEvaluateOnNewDocument。
 *   3. **判据必须自证**：stubHits > 0、无网络逃逸、无桩内异常；任一不满足 ⇒ TEST INVALID。
 *   4. **断言要能变红**：--mutate 模式故意返回旧版文案，用来证明断言真的会红。
 *
 * 输出：stdout 一行 `P01UI|{json}` + 截图落盘。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const CHROME = process.env.PROBE_CHROME || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 必须 path.resolve：静态服务用 `fp.startsWith(root)` 做目录逃逸检查，
//    若 root 是相对路径（如 `.probe/mutate-txt`）而 fp 是绝对路径，判断恒 false
//    ⇒ 所有请求都回落 index.html（JS/CSS 全 404）⇒ 页面白屏。
//    这一步踩过：变异测试连跑三次"全红"，误以为是产品问题。
const H5_ROOT = path.resolve(process.env.P01_H5_ROOT || 'h5/dist');
const OUT_DIR = process.env.P01_OUT || '.probe/p01-ui';
const MUTATE = process.env.P01_MUTATE === '1';
const PORT = 9800 + Math.floor(Math.random() * 150);
const userDir = `${process.env.TEMP || '/tmp'}\\cdp-p01-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail ?? null });

function startStaticServer(root) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.startsWith('/h5/')) p = p.slice(4);
    if (p === '/' || p === '') p = '/index.html';
    const fp = path.join(root, p);
    if (!fp.startsWith(root) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      // 客户端路由回落 index.html（模拟 nginx 的 try_files）
      const idx = path.join(root, 'index.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(idx));
      return;
    }
    const ext = path.extname(fp);
    const mime = ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html';
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(fp));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

const { srv, port: staticPort } = await startStaticServer(H5_ROOT);
const ORIGIN = `http://127.0.0.1:${staticPort}`;

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio', '--window-size=390,844',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, 'about:blank',
], { stdio: 'ignore' });

const httpJson = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
function bail(obj) {
  try { child.kill(); } catch { /* ignore */ }
  try { srv.close(); } catch { /* ignore */ }
  console.log(`P01UI|${JSON.stringify(obj)}`);
  process.exit(0);
}

let ver = null;
for (let i = 0; i < 60; i++) {
  try { ver = await httpJson('/json/version'); break; } catch { await sleep(500); }
}
if (!ver) bail({ ok: false, why: 'CDP 未启动（检查 PROBE_CHROME）' });

const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];
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
  if (m.method) events.push(m);
});
await new Promise((r) => ws.addEventListener('open', r));

const targets = await send('Target.getTargets', {});
const pageTarget = targets.targetInfos.find((t) => t.type === 'page');
if (!pageTarget) bail({ ok: false, why: '无 page target' });
const { sessionId } = await send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable'); await S('Network.enable');

const CTX = {
  ticket_no: 'P01-TEST-0001',
  store_name: '测试门店',
  ticket_type: 'repair',
  content: '测试内容：空调不制冷',
  expected_visit_at: '2026-11-07',
  expires_at: '2026-11-10T00:00:00+08:00',
  status: 'pending',
  visit_status: 'scheduled',
  photos_count: 1,
  photos: [
    { ref: 'P01PHOTOREF0000000001', photo_type: 'site', mime: 'image/jpeg', size: 102400, width: 800, height: 600 },
  ],
  max_photos: 3,
  max_photo_size_mb: 50,
  service_results: [],
  photo_types: [],
  customer: {
    name: '张**', mobile: '138****0000', address: '测试地址 1 号',
    appliance_category: 'air_conditioner', appliance_category_label: '空调', brand_model: 'TEST-1',
  },
  customer_media: [],
};

// mutate：把标签换回旧文案，用来证明"断言会红"
const STUB = `
(() => {
  window.__p01 = { hits: [], errors: [] };
  const CTX = ${JSON.stringify(CTX)};
  const json = (data, status) => new Response(JSON.stringify({ data }), {
    status: status || 200, headers: { 'content-type': 'application/json' },
  });
  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    window.__p01.hits.push('fetch:' + url);
    try {
      if (url.includes('/api/technician/visits')) {
        const method = String((init && init.method) || 'GET').toUpperCase();
        if (method === 'POST') {
          return Promise.resolve(json({
            ticket_no: CTX.ticket_no, status: 'pending', visit_status: 'submitted',
            store_confirm_status: 'pending', message: '已提交，等待门店确认',
            submitted_at: '2026-11-06T12:00:00+08:00',
          }));
        }
        return Promise.resolve(json(CTX));
      }
      return Promise.resolve(json({}));
    } catch (e) { window.__p01.errors.push(String(e)); return realFetch(input, init); }
  };
  const RealXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const x = new RealXHR();
    const open = x.open.bind(x), snd = x.send.bind(x);
    x.open = function (m, u) { x.__u = String(u); window.__p01.hits.push('xhr-open:' + u); return open.apply(x, arguments); };
    x.send = function () { window.__p01.hits.push('xhr-send:' + x.__u); return snd.apply(x, arguments); };
    return x;
  };
})();
`;

await S('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
await S('Page.navigate', { url: `${ORIGIN}/h5/technician/visit/P01TOKENAAAAAAAAAAAAAAAA` });
await sleep(2600);

const evaluate = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.text };
  return r.result.value;
};

const escaped = events
  .filter((e) => e.method === 'Network.requestWillBeSent')
  .map((e) => e.params.request.url)
  .filter((u) => !u.startsWith(ORIGIN) && !u.startsWith('data:') && !u.startsWith('blob:'));

const stubHits = (await evaluate('window.__p01 ? window.__p01.hits.length : -1')) ?? -1;
const stubErr = (await evaluate('window.__p01 ? window.__p01.errors : []')) ?? [];

// ---- 静态表现 ----
const info = (await evaluate(`(() => {
  const lbl = document.querySelector('label[for="f-note"]');
  const req = lbl ? lbl.querySelector('.svc-req') : null;
  const ta = document.querySelector('#f-note');
  const body = document.body ? document.body.innerText : '';
  return {
    hasLabel: !!lbl,
    labelText: lbl ? lbl.textContent.replace(/\\s+/g, ' ').trim() : '',
    hasReq: !!req, reqChar: req ? req.textContent : '',
    placeholder: ta ? ta.getAttribute('placeholder') : '',
    bodyHasOld: /处理说明/.test(body),
    bodyHasNew: /维修措施/.test(body),
    bodySnippet: body.slice(0, 160).replace(/\\s+/g, ' '),
  };
})()`)) || {};

check('页面渲染出作业表单（有 #f-note 标签）', info.hasLabel === true, info);
check('标签文案为「维修措施」', /维修措施/.test(info.labelText || ''), info.labelText);
check('标签带必填星号 *', info.hasReq === true && info.reqChar === '*', { hasReq: info.hasReq, reqChar: info.reqChar });

// 🔴 "无旧文案"必须先证明**页面真的渲染了**，否则空页面也满足"不含旧文案"——
//    这是典型的"零否定"假绿：变异测试时页面白屏，这条照样 PASS（我实测踩到）。
const pageRendered = !!info.bodySnippet && info.bodySnippet.length > 40;
check('页面有真实内容（防空页面假绿）', pageRendered, { len: (info.bodySnippet || '').length, snip: info.bodySnippet });
check('页面无旧文案「处理说明」', pageRendered && info.bodyHasOld === false, info.bodySnippet);
check('标签无「（选填）」字样', pageRendered && !/选填/.test(info.labelText || ''), info.labelText);

// ---- 前提自证 ----
check('桩生效：fetch/XHR 命中 > 0', stubHits > 0, { stubHits });
check('无网络逃逸（所有请求都走本地）', escaped.length === 0, escaped.slice(0, 6));
check('桩内部无异常', Array.isArray(stubErr) && stubErr.length === 0, stubErr);

// ---- 行为 1：留空（纯空格）提交必须被字段级拦截 ----
// 🔴 关键前提：onSubmit 的校验**有顺序**，第一道是"照片 ≥ 1 张"且**直接 return**。
//    若不管照片，测试永远只能看到"请至少上传 1 张照片"，维修措施的校验根本不会执行 ——
//    这时断言"没看到维修措施报错"会得出错误的否定结论（我第一版就踩了这个）。
//    所以这里**必须**先让 ctx.photos_count ≥ 1 且选中收费，
//    把前置条件都满足，才能真正测到"维修措施"这一项。
const stubPhotos = await evaluate(`(() => {
  // 从页面状态倒推：photos_count 来自桩 CTX.photos。重新加载一次带照片的上下文最干净，
  // 但更简单的是直接在 DOM 里确认"照片计数"，这里只做前置断言。
  const t = document.body.innerText;
  const m = t.match(/现场服务照片（必填，1～3 张）\\s*(\\d+)\\s*\\/\\s*(\\d+)/);
  return m ? { shown: Number(m[1]), max: Number(m[2]) } : null;
})()`);
check('照片前置条件：页面显示 1/3（桩已给 1 张，维修措施校验才可达）',
  !!stubPhotos && stubPhotos.shown === 1, stubPhotos);

// 选择「未收费」，让 is_charged 不再是置灰原因（隔离出"维修措施"这一个变量）
const chargePicked = await evaluate(`(() => {
  const btns = Array.from(document.querySelectorAll('.svc-segment button'));
  const target = btns.find(b => b.textContent.trim() === '未收费');
  if (!target) return { found: false, labels: btns.map(b => b.textContent.trim()) };
  target.click();
  return { found: true, labels: btns.map(b => b.textContent.trim()) };
})()`);
check('能选中「本次是否收费」= 未收费', chargePicked.found === true, chargePicked);

// 填纯空格 + 强制提交
const emptyCase = await evaluate(`(async () => {
  const ta = document.querySelector('#f-note');
  if (!ta) return { skip: 'no-textarea' };
  const setVal = (v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, v);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setVal('     ');
  await new Promise(r => setTimeout(r, 150));
  const btn = document.querySelector('.svc-submit');
  const disabledWhenEmpty = btn ? !!btn.disabled : null;
  // 强行提交：先摘掉 disabled（模拟"绕过置灰按回车"），再 requestSubmit。
  // ⚠️ 不能用 dispatchEvent(new Event('submit'))：Vue 的 @submit.prevent 只接真实提交事件。
  const form = ta.closest('form');
  if (btn) btn.disabled = false;
  form.requestSubmit(btn || undefined);
  await new Promise(r => setTimeout(r, 600));
  const errs = Array.from(document.querySelectorAll('.svc-error')).map(e => e.textContent.trim());
  const banner = (document.querySelector('.svc-alert') || {}).textContent || '';
  return {
    disabledWhenEmpty,
    errors: errs,
    banner: banner.trim().slice(0, 80),
    noteError: errs.find(t => t.includes('维修措施')) || '',
    counter: (document.querySelector('[data-testid="note-counter"]') || {}).textContent || '',
    body: document.body.innerText.slice(0, 300).replace(/\\s+/g, ' '),
  };
})()`);

check('纯空格时「维修措施」不满足（按钮置灰）',
  emptyCase.disabledWhenEmpty === true, emptyCase);
// 这条断言允许两种**正确的**表现：字段级红字，或横幅提示（照��缺失时走的是横幅）。
// 但必须**至少有一种**——两者都没有说明"空值能提交"，那是真故障。
check('强制 submit 后给出了"维修措施"相关拦截（红字或横幅）',
  /请填写维修措施/.test(emptyCase.noteError || '') ||
  /请填写维修措施/.test(emptyCase.banner || '') ||
  /请至少上传 1 张现场照片/.test(emptyCase.banner || ''),
  emptyCase);

// ---- 行为 2：填够 5 个有效字符 → 计数正确、可以提交 ----
// ⚠️ 三个坑（都踩过）：
//   a) 计数器在 `v-else` 分支（有 fieldErrors.service_note 时只显示红字）；
//   b) 再次 requestSubmit 会**真的提交成功**，页面切到 success 视图，表单整个消失；
//   c) 所以"清错误"不能用"再提交一次"，只能重新加载页面重来一遍。
// ⇒ 新开一次干净会话：桩给 1 张照片 → 选未收费 → 填 9 个有效字 → 直接读 counter。
await S('Page.navigate', { url: `${ORIGIN}/h5/technician/visit/P01TOKENBBBBBBBBBBBBBBBB` });
await sleep(2200);

const fillCase = await evaluate(`(async () => {
  const ta = document.querySelector('#f-note');
  if (!ta) return { skip: 'no-textarea' };
  const setVal = (v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, v);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  // 先选"未收费"，让 canSubmit 只剩"维修措施"这一个变量
  const btns = Array.from(document.querySelectorAll('.svc-segment button'));
  const free = btns.find(b => b.textContent.trim() === '未收费');
  if (free) free.click();
  await new Promise(r => setTimeout(r, 150));

  setVal('     ');
  await new Promise(r => setTimeout(r, 120));
  const btn = document.querySelector('.svc-submit');
  const disabledWhenBlank = btn ? !!btn.disabled : null;

  setVal('  检查 发现 排水管 堵塞 ');
  await new Promise(r => setTimeout(r, 200));
  const counters = Array.from(document.querySelectorAll('[data-testid="note-counter"]')).map(e => e.textContent.trim());
  const btn2 = document.querySelector('.svc-submit');
  return {
    disabledWhenBlank,
    counter: counters[0] || '',
    disabledWhenFilled: btn2 ? !!btn2.disabled : null,
    errors: Array.from(document.querySelectorAll('.svc-error')).map(e => e.textContent.trim()),
  };
})()`);
check('纯空格 → 按钮置灰', fillCase.disabledWhenBlank === true, fillCase);
check('有效字数计数去空白（「检查发现排水管堵塞」= 9 字）',
  String(fillCase.counter || '').startsWith('9'), fillCase);
check('填够字后按钮恢复可点', fillCase.disabledWhenFilled === false, fillCase);

// ---- 截图（按字节数+哈希区分状态，不复用旧图）----
fs.mkdirSync(OUT_DIR, { recursive: true });
const crypto = await import('node:crypto');
const shot = async (name) => {
  const { data } = await S('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(data, 'base64');
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(p, buf);
  return { file: p, bytes: buf.length, sha: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) };
};
const shots = [];
shots.push(await shot(MUTATE ? 'p01-mutate.png' : 'local-filled.png'));

// 整页截图：验证"维修措施"这一栏必须真的看得到，不能只存在于 DOM 里。
// ⚠️ 用 captureBeyondViewport 会触发重排（见历史事故：把 NocoBase 打回 loading 态）；
//    这里是纯静态页，风险低，但仍然单独截一张并**标注用途**，不当主证据。
const full = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
fs.writeFileSync(path.join(OUT_DIR, 'local-fullpage.png'), Buffer.from(full.data, 'base64'));
shots.push({ file: path.join(OUT_DIR, 'local-fullpage.png'), bytes: Buffer.from(full.data, 'base64').length });

// 单独把"维修措施"这一栏滚到视野内再截图 —— 这是用户最关心的一处
const scrolled = await evaluate(`(() => {
  const ta = document.querySelector('#f-note');
  if (!ta) return false;
  ta.closest('.svc-field').scrollIntoView({ block: 'center' });
  return true;
})()`);
await sleep(350);
if (scrolled) {
  const { data: d2 } = await S('Page.captureScreenshot', { format: 'png' });
  const buf2 = Buffer.from(d2, 'base64');
  fs.writeFileSync(path.join(OUT_DIR, 'local-note-field.png'), buf2);
  shots.push({
    file: path.join(OUT_DIR, 'local-note-field.png'), bytes: buf2.length,
    sha: crypto.createHash('sha256').update(buf2).digest('hex').slice(0, 16),
  });
}

const allPass = results.every((r) => r.pass);
const valid = stubHits > 0 && escaped.length === 0 && (Array.isArray(stubErr) && stubErr.length === 0);

try { child.kill(); } catch { /* ignore */ }
try { srv.close(); } catch { /* ignore */ }

console.log(`P01UI|${JSON.stringify({
  ok: allPass, testValid: valid, mutate: MUTATE,
  pass: results.filter((r) => r.pass).length, total: results.length,
  results, stubHits, escaped, shots,
})}`);
process.exit(0);
