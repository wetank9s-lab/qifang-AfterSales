/**
 * _r212_local_3btn.mjs —— 「处理 / 跟进 / 审核」三类按钮真实点击验收（本地，同一份产物）
 *
 * 为什么在本地跑：
 *   生产库 NEW / PROCESSING / WAIT_STORE_CONFIRM **三种状态工单为 0**（已 SQL 核实），
 *   这三类按钮在生产数据上**无对象可点**。而本地 `dist` 与生产 `dist` 的
 *   client / server SHA256 **逐字节相同**，因此对这三类按钮的实测在本地等价成立。
 *   报告里必须写明"本地实测 + 产物哈希相同"，不能写成"生产实测"。
 *
 * 纪律：
 *   · 真实鼠标点击（Input.dispatchMouseEvent），不是 el.click()。
 *   · 只**打开**面板，随后 Escape 关闭；全程不提交、不填必填项。
 *   · 判据取「可见 pane 内第一个含 [data-primary-action] 的真实数据行」。
 *   · 每类按钮都要证明：尺寸 64×30、label 两字、hint 正确、点击后打开的面板类型正确、
 *     URL 不跳走、关闭后回到列表。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.LOCAL_BASE || 'http://127.0.0.1:13000';
const EMAIL = process.env.LOCAL_EMAIL || 'uat.hqadmin@svc.local';
const PASS = process.env.LOCAL_PASS || process.env.UAT_HQADMIN_PASSWORD;
const OUT = 'storage/tmp/r212/local-3btn';
fs.mkdirSync(OUT, { recursive: true });
if (!PASS) { console.error('缺少 LOCAL_PASS / UAT_HQADMIN_PASSWORD'); process.exit(1); }

const port = 9988;
const profile = path.join(os.tmpdir(), `r212l3-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const child = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 200; i++) {
  try { const l = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch { /* */ }
  await sleep(300);
}
if (!wsUrl) { console.error('CHROME 启动失败'); process.exit(1); }
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
  return r.result?.result?.value; };
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, n), Buffer.from(r.result.data, 'base64')); return n; };
const results = [];
const ok = (m, d = null) => { results.push({ pass: true, m, d }); console.log(`✅ ${m}`, d === null ? '' : JSON.stringify(d)); };
const no = (m, d = null) => { results.push({ pass: false, m, d }); console.log(`❌ ${m}`, d === null ? '' : JSON.stringify(d)); };
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
const pressEsc = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
};

const login = async () => {
  await ev('localStorage.clear(); sessionStorage.clear();');
  await send('Network.clearBrowserCookies');
  await send('Page.navigate', { url: `${BASE}/signin` });
  for (let i = 0; i < 80; i++) { const n = await ev(`[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null).length`).catch(() => 0); if (n >= 2) break; await sleep(400); }
  await sleep(900);
  await ev(`(() => { const all=[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null);
    const a=all.find(i=>i.type!=='password'), p=all.find(i=>i.type==='password');
    if(!a||!p) return false;
    const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    s.call(a,${JSON.stringify(EMAIL)}); a.dispatchEvent(new Event('input',{bubbles:true}));
    s.call(p,${JSON.stringify(PASS)}); p.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await sleep(400);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/登录|Sign/i.test(x.innerText)); if(b) b.click(); return !!b; })()`);
  for (let i = 0; i < 60; i++) { await sleep(500); if (!/\/signin/.test(await ev('location.href'))) break; }
  await sleep(8000);
  return await ev('location.href');
};

const switchTabByName = async (name) => {
  const box = await ev(`(() => { const t=[...document.querySelectorAll('.ant-tabs-nav .ant-tabs-tab')].find(x => (x.innerText||'').trim() === ${JSON.stringify(name)});
    if(!t) return null; const r=t.getBoundingClientRect(); if(r.width===0) return null;
    return { x:r.left+r.width/2, y:r.top+r.height/2 }; })()`);
  if (!box || box.__err) return false;
  await clickAt(box.x, box.y);
  await sleep(2600);
  return true;
};

/** 取该页签第一个含主按钮的行里指定 label 的按钮几何 */
const findBtn = (label) => ev(`(() => {
  const pane = [...document.querySelectorAll('.ant-tabs-tabpane')].reverse().find(p => p.getAttribute('aria-hidden') !== 'true');
  if (!pane) return { ok: false, why: 'no-pane' };
  const tbl = [...pane.querySelectorAll('table')].find(t => t.getBoundingClientRect().width > 0);
  if (!tbl) return { ok: false, why: 'no-table' };
  const rows = [...tbl.querySelectorAll('tbody tr.ant-table-row')].filter(r => r.getBoundingClientRect().height > 0);
  for (const row of rows) {
    const bs = [...row.querySelectorAll('[data-primary-action]')];
    const b = bs.find(x => (x.getAttribute('data-action-label') || '').trim() === ${JSON.stringify(label)});
    if (b) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      return { ok: true, kind: b.getAttribute('data-primary-action'), label: b.getAttribute('data-action-label'),
               hint: b.getAttribute('title') || b.getAttribute('aria-label') || b.getAttribute('data-action-hint'),
               w: Math.round(r.width), h: Math.round(r.height),
               bg: getComputedStyle(b).backgroundColor, color: getComputedStyle(b).color,
               radius: getComputedStyle(b).borderRadius,
               x: r.left + r.width/2, y: r.top + r.height/2, ticketRow: (row.innerText||'').split('\\n')[0].slice(0,20) };
    }
  }
  return { ok: false, why: 'label-not-found', labels: [...new Set(rows.flatMap(r => [...r.querySelectorAll('[data-primary-action]')].map(x => x.getAttribute('data-action-label'))))] };
})()`);

try {
  await send('Page.enable'); await send('Runtime.enable');
  const u = await login();
  if (/\/signin/.test(u)) { no('本地登录', { url: u }); throw new Error('login failed'); }
  ok('本地登录成功（同一份产物校验用）', { url: u });

  await send('Page.navigate', { url: `${BASE}/admin/tujyw08ec1d` });
  await sleep(11000);
  const tabs = (await ev(`[...document.querySelectorAll('.ant-tabs-nav .ant-tabs-tab')].map(t => (t.innerText||'').trim())`)) || [];
  ok('本地页签清单', tabs);

  const CASES = [
    { tab: '待处理', label: '处理', expectKind: 'handle', expectHint: '处理工单', expectPanel: ['modal'] },
    { tab: '处理中', label: '跟进', expectKind: 'follow', expectHint: '记录工单跟进情况', expectPanel: ['modal'] },
    { tab: '待门店确认', label: '审核', expectKind: 'review', expectHint: '审核师傅回执', expectPanel: ['drawer', 'modal'] },
  ];

  const got = [];
  for (const c of CASES) {
    const sw = await switchTabByName(c.tab);
    if (!sw) { no(`切到「${c.tab}」页签`, { tab: c.tab, tabs }); continue; }
    const b = await findBtn(c.label);
    if (!b?.ok) { no(`页签「${c.tab}」内找到「${c.label}」按钮`, b); continue; }
    ok(`「${c.label}」按钮存在（页签 ${c.tab}）`, { kind: b.kind, label: b.label, hint: b.hint, w: b.w, h: b.h, bg: b.bg, color: b.color, radius: b.radius, row: b.ticketRow });

    (b.w === 64 && b.h === 30 ? ok : no)(`「${c.label}」尺寸 64×30`, { w: b.w, h: b.h });
    (b.label === c.label ? ok : no)(`「${c.label}」文案为两个汉字`, { label: b.label, len: b.label?.length });
    (b.kind === c.expectKind ? ok : no)(`「${c.label}」kind=${c.expectKind}`, { kind: b.kind });
    ((b.hint || '').includes(c.expectHint) ? ok : no)(`「${c.label}」hint 含「${c.expectHint}」`, { hint: b.hint });

    const urlBefore = await ev('location.href');
    await shot(`btn-${c.expectKind}-before.png`);
    await clickAt(b.x, b.y);
    await sleep(3400);
    const opened = await ev(`(() => {
      const m = [...document.querySelectorAll('.ant-modal-wrap')].filter(e => e.getBoundingClientRect().height > 0).length;
      const d = [...document.querySelectorAll('.ant-drawer-open, .ant-drawer-content-wrapper')].filter(e => e.getBoundingClientRect().width > 0).length;
      const title = (document.querySelector('.ant-modal-title, .ant-drawer-title')?.innerText || '').trim().slice(0, 40);
      // 「审核」必须滚到师傅回执区：检查抽屉里是否出现回执相关文案
      const body = (document.querySelector('.ant-modal-body, .ant-drawer-body')?.innerText || '').slice(0, 400);
      return { modal: m, drawer: d, title, hasReceipt: /回执|师傅/.test(body) };
    })()`);
    const urlAfter = await ev('location.href');
    const kind = opened?.modal > 0 ? 'modal' : (opened?.drawer > 0 ? 'drawer' : 'none');
    await shot(`btn-${c.expectKind}-open.png`);
    (c.expectPanel.includes(kind) ? ok : no)(`「${c.label}」点击后打开 ${c.expectPanel.join('/')}`, { kind, title: opened?.title });
    (urlBefore === urlAfter ? ok : no)(`「${c.label}」点击未跳走页面`, { urlBefore, urlAfter });
    if (c.expectKind === 'review') (opened?.hasReceipt ? ok : no)('「审核」打开后含师傅回执内容', { hasReceipt: opened?.hasReceipt });

    await pressEsc(); await sleep(1400);
    const closed = await ev(`[...document.querySelectorAll('.ant-modal-wrap')].filter(e=>e.getBoundingClientRect().height>0).length + [...document.querySelectorAll('.ant-drawer-open')].length`);
    (closed === 0 ? ok : no)(`「${c.label}」Escape 可关闭（未提交任何数据）`, { remaining: closed });
    got.push({ ...c, measured: b, opened: { kind, title: opened?.title, hasReceipt: opened?.hasReceipt } });

    await send('Page.navigate', { url: `${BASE}/admin/tujyw08ec1d` });
    await sleep(9000);
  }
  fs.writeFileSync(path.join(OUT, 'report-buttons.json'), JSON.stringify(got, null, 2));
} catch (e) {
  console.log('EXCEPTION', String(e.message || e).slice(0, 300));
} finally {
  const pass = results.filter((r) => r.pass).length; const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n共 ${results.length} 项，失败 ${fail} 项`);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ results, pass, fail }, null, 2));
  try { ws.close(); } catch { /* */ } try { child.kill(); } catch { /* */ }
  process.exit(fail === 0 ? 0 : 2);
}
