/**
 * 对照实验：同一个菜单项，分别用 4 种触发方式，看哪种"不导航"。
 *
 * 目的：弄清我上一轮报告的"点菜单不导航"到底是**产品缺陷**还是**我的测试方法缺陷**。
 * 判据只有一条：点击前后 location.href 是否变化。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.SVC_BASE || 'http://127.0.0.1:13000';
const EMAIL = process.env.R212_ADMIN || 'uat.hqadmin@svc.local';
const PASS = process.env.R212_PASS || process.env.UAT_HQADMIN_PASSWORD;
if (!PASS) { console.error('缺少口令：export R212_PASS=<本地 UAT 口令>'); process.exit(1); }
const OUT = 'storage/tmp/r212/local-nav';
fs.mkdirSync(OUT, { recursive: true });
const port = 9996;
const profile = path.join(os.tmpdir(), `r212ab-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const child = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 200; i++) { try { const l = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()); const p = l.find(t => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {} await sleep(300); }
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description?.slice(0, 250) }; return r.result?.result?.value; };

await send('Page.navigate', { url: `${BASE}/signin` });
for (let i = 0; i < 80; i++) { const n = await ev(`[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null).length`).catch(() => 0); if (n >= 2) break; await sleep(400); }
await sleep(900);
await ev(`(() => { const all=[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null); const a=all.find(i=>i.type!=='password'), p=all.find(i=>i.type==='password'); const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(a,${JSON.stringify(EMAIL)}); a.dispatchEvent(new Event('input',{bubbles:true})); s.call(p,${JSON.stringify(PASS)}); p.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
await sleep(400);
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/登录/.test(x.innerText)); if(b)b.click(); return !!b; })()`);
for (let i = 0; i < 50; i++) { await sleep(500); if (!/\/signin/.test(await ev('location.href'))) break; }
await sleep(6000);
console.log('起始 URL:', await ev('location.href'));

const TARGET = '我的门店工单';

/** 回到工作台，确保每次实验起点相同 */
async function reset() {
  await send('Page.navigate', { url: `${BASE}/admin/ypcok9wxzys` });
  await sleep(4500);
}

/** 真实鼠标点击中心点 */
async function mouseClick() {
  const box = await ev(`(() => {
    const sider = document.querySelector('.ant-layout-sider');
    const li = [...sider.querySelectorAll('li')].find(x => (x.textContent||'').trim() === ${JSON.stringify(TARGET)});
    if (!li) return null;
    const t = li.querySelector('.ant-menu-title-content') || li;
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), w: Math.round(r.width) };
  })()`);
  if (!box?.w) return 'NOT-VISIBLE';
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(3500);
  return null;
}

const CASES = [
  {
    name: 'A. 真实鼠标点击 <a> 的中心点',
    run: async () => mouseClick(),
  },
  {
    name: 'B. JS: a.click()（DOM 原生 click）',
    run: async () => {
      await ev(`(() => {
        const sider = document.querySelector('.ant-layout-sider');
        const li = [...sider.querySelectorAll('li')].find(x => (x.textContent||'').trim() === ${JSON.stringify(TARGET)});
        const a = li && li.querySelector('a');
        if (a) a.click();
        return !!a;
      })()`);
      await sleep(3500);
    },
  },
  {
    name: 'C. JS: 内层 .ant-menu-title-content 上 click()',
    run: async () => {
      await ev(`(() => {
        const sider = document.querySelector('.ant-layout-sider');
        const li = [...sider.querySelectorAll('li')].find(x => (x.textContent||'').trim() === ${JSON.stringify(TARGET)});
        const t = li && li.querySelector('.ant-menu-title-content');
        if (t) t.click();
        return !!t;
      })()`);
      await sleep(3500);
    },
  },
  {
    name: 'D. JS: 在 <li> 上 click()',
    run: async () => {
      await ev(`(() => {
        const sider = document.querySelector('.ant-layout-sider');
        const li = [...sider.querySelectorAll('li')].find(x => (x.textContent||'').trim() === ${JSON.stringify(TARGET)});
        if (li) li.click();
        return !!li;
      })()`);
      await sleep(3500);
    },
  },
  {
    name: 'E. 真实鼠标点击 <a> 的右边缘（非文字处）',
    run: async () => {
      const box = await ev(`(() => {
        const sider = document.querySelector('.ant-layout-sider');
        const li = [...sider.querySelectorAll('li')].find(x => (x.textContent||'').trim() === ${JSON.stringify(TARGET)});
        const a = li && li.querySelector('a');
        if (!a) return null;
        const r = a.getBoundingClientRect();
        return { x: Math.round(r.right - 6), y: Math.round(r.top + r.height/2), w: Math.round(r.width) };
      })()`);
      if (!box?.w) return 'NOT-VISIBLE';
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await sleep(3500);
      return null;
    },
  },
];

const rows = [];
for (const c of CASES) {
  await reset();
  const before = await ev('location.href');
  const err = await c.run();
  const after = await ev('location.href');
  rows.push({ name: c.name, before, after, navigated: before !== after, note: err });
  console.log(`\n${c.name}\n  before=${before.replace(BASE,'')}\n  after =${after.replace(BASE,'')}\n  navigated=${before !== after}${err ? '  note=' + err : ''}`);
}

console.log('\n=== 对照结论 ===');
for (const r of rows) console.log(`${r.navigated ? '✅ 导航' : '❌ 未导航'}  ${r.name}`);
fs.writeFileSync(path.join(OUT, 'ab-result.json'), JSON.stringify(rows, null, 2));
ws.close(); try { child.kill(); } catch {}
process.exit(0);
