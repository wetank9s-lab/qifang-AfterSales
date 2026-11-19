#!/usr/bin/env node
/**
 * _p0-1-widths.mjs —— 四个常见宽度下检查「维修措施」一栏是否溢出/错位。
 *
 * 为什么单独做：手机宽度不是只有 iPhone 的 390。
 * 本项目的门店客户/师傅多有安卓机（360/320 很常见），
 * 而"计数被挤到行尾"这类排版问题恰恰在小宽度下最明显。
 *
 * 判据（每条都要能在坏实现上变红）：
 *   ① 横向溢出：documentElement.scrollWidth > clientWidth
 *   ② 提示文字不与计数重叠（两者 boundingRect 不交叠）
 *   ③ 计数完整可见（right ≤ 视口宽，且文本以 " / 500" 结尾）
 *   ④ 标签文字仍是「维修措施」且带星号
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const CHROME = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.resolve(process.env.P01_H5_ROOT || 'h5/dist');
const OUT = process.env.P01_OUT || '.probe/p01-ui';
const WIDTHS = [390, 375, 360, 320];
const PORT = 9800 + Math.floor(Math.random() * 150);

const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.startsWith('/h5/')) p = p.slice(4);
  if (p === '/' || p === '') p = '/index.html';
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
    return;
  }
  const ext = path.extname(fp);
  res.writeHead(200, {
    'content-type': ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html; charset=utf-8',
  });
  res.end(fs.readFileSync(fp));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${srv.address().port}`;

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.TEMP}\\w-${Date.now()}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver = null;
for (let i = 0; i < 60; i++) {
  try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(400); }
}
if (!ver) { console.log('CDP 起不来'); process.exit(1); }

const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const send = (m, p = {}, s) => {
  const mid = ++id;
  const o = { id: mid, method: m, params: p };
  if (s) o.sessionId = s;
  ws.send(JSON.stringify(o));
  return new Promise((r, j) => pend.set(mid, { r, j }));
};
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id);
    m.error ? p.j(new Error(m.error.message)) : p.r(m.result);
    return;
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const t = await send('Target.getTargets');
const pt = t.targetInfos.find((x) => x.type === 'page');
const { sessionId } = await send('Target.attachToTarget', { targetId: pt.targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable');

const CTX = {
  ticket_no: 'P01-W-TEST', store_name: '测试门店', ticket_type: 'repair',
  content: '测试内容：空调不制冷', expected_visit_at: '2026-11-07',
  expires_at: '2026-11-10T00:00:00+08:00', status: 'pending', visit_status: 'scheduled',
  photos_count: 1,
  photos: [{ ref: 'P01PHOTOREF0000000001', photo_type: 'site', mime: 'image/jpeg', size: 102400, width: 800, height: 600 }],
  max_photos: 3, max_photo_size_mb: 50, service_results: [], photo_types: [],
  customer: { name: '张**', mobile: '138****0000', address: '测试地址 1 号', appliance_category: 'air_conditioner', appliance_category_label: '空调', brand_model: 'TEST-1' },
  customer_media: [],
};
const STUB = `
(() => {
  const CTX = ${JSON.stringify(CTX)};
  const json = (d) => new Response(JSON.stringify({ data: d }), { status: 200, headers: { 'content-type': 'application/json' } });
  const rf = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/api/technician/visits')) {
      return Promise.resolve(json(String((init && init.method) || 'GET').toUpperCase() === 'POST'
        ? { ticket_no: CTX.ticket_no, status: 'pending', visit_status: 'submitted', store_confirm_status: 'pending', message: 'ok', submitted_at: null }
        : CTX));
    }
    return Promise.resolve(json({}));
  };
})();
`;
await S('Page.addScriptToEvaluateOnNewDocument', { source: STUB });

fs.mkdirSync(OUT, { recursive: true });
const rows = [];
for (const w of WIDTHS) {
  await S('Emulation.setDeviceMetricsOverride', { width: w, height: 844, deviceScaleFactor: 2, mobile: true });
  await S('Page.navigate', { url: `${ORIGIN}/h5/technician/visit/P01WIDTHTOKENAAAAAAAAAAA` });
  await sleep(2000);
  // 填 9 个有效字，让计数显示 9 / 500
  const r = await S('Runtime.evaluate', {
    returnByValue: true, awaitPromise: true,
    expression: `(async () => {
      const ta = document.querySelector('#f-note');
      if (!ta) return { err: 'no-textarea' };
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '  检查 发现 排水管 堵塞 ');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      const de = document.documentElement;
      const lbl = document.querySelector('label[for="f-note"]');
      const req = lbl && lbl.querySelector('.svc-req');
      const cnt = document.querySelector('[data-testid="note-counter"]');
      const helper = document.querySelector('.svc-note-help-text');
      const cr = cnt ? cnt.getBoundingClientRect() : null;
      const hr = helper ? helper.getBoundingClientRect() : null;
      const overlap = cr && hr ? !(cr.bottom <= hr.top + 1 || cr.top >= hr.bottom - 1) : false;
      return {
        scrollWidth: de.scrollWidth, clientWidth: de.clientWidth,
        overflow: de.scrollWidth > de.clientWidth + 1,
        label: lbl ? lbl.textContent.replace(/\\s+/g,' ').trim() : '',
        star: req ? req.textContent : '',
        counterText: cnt ? cnt.textContent.trim() : '',
        counterRight: cr ? Math.round(cr.right) : null,
        counterVisible: cr ? cr.right <= de.clientWidth + 1 : false,
        overlap,
        // 🔴 关键判据（反向验证后才补上的）：计数值必须**贴右**。
        //    旧实现把它塞进 flex 容器当 flex item，被 space-between 挤到容器中间/左侧，
        //    counterRight 只有 ~81（正常应接近卡片右边 ~340）。
        //    只查"不溢出/不重叠"是查不出这个的 —— 它既没溢出也没重叠，就是位置错了。
        cardRight: (() => {
          const f = ta.closest('.svc-field');
          return f ? Math.round(f.getBoundingClientRect().right) : null;
        })(),
        counterRightAligned: cr && ta.closest('.svc-field')
          ? cr.right >= ta.closest('.svc-field').getBoundingClientRect().right - 24
          : false,
      };
    })()`,
  });
  const v = r.result.value || {};
  rows.push({ width: w, ...v });
  // 截图前把这一栏滚进视野 —— 否则小宽度下截到的是页面顶部（客户信息卡），
  // 断言查的是"维修措施"，截图却是别处，证据与结论对不上（我踩过）。
  await S('Runtime.evaluate', {
    expression: `(() => { const ta = document.querySelector('#f-note');
      if (ta) ta.closest('.svc-field').scrollIntoView({ block: 'center' }); })()`,
  });
  await sleep(250);
  const { data } = await S('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `w${w}-note.png`), Buffer.from(data, 'base64'));
}

const allOk = rows.every((r) => !r.overflow && r.counterVisible && !r.overlap && r.counterRightAligned &&
  /维修措施/.test(r.label || '') && r.star === '*' && /^9 \/ 500$/.test(r.counterText || ''));

console.log(`P01W|${JSON.stringify({ allOk, rows })}`);
child.kill();
srv.close();
process.exit(0);
