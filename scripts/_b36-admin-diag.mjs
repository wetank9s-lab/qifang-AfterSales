/**
 * _b36-admin-diag.mjs —— 一次性诊断：后台 Banner 区块到底渲染出了什么
 *
 * 触发原因：`_b36-admin-shots.mjs` 里「已发布行出现下架按钮」= 0 个，
 *   但同一时刻「已有横幅（1 张）」读得到 ⇒ 列表数据是有的。
 *   两者矛盾，必须查清是**产品缺陷**还是**我的读法错**（本仓库的铁律：
 *   工具坏了 ≠ 产品坏了，不能混报）。
 *
 * 本脚本把区块内所有按钮文本、所有可见文案、以及区块的 DOM 结构 dump 出来，
 * 不作产品结论。
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readEnv, signIn, purgeBanners, uuid, FIX } from './_b36-lib.mjs';

const BASE = 'https://127.0.0.1';
const PAGE_UID = '222b0i1wl2i';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  for (const c of ['C:/Program Files/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null].filter(Boolean)) {
    try { if (fs.existsSync(c)) return c; } catch { /* noop */ }
  }
  throw new Error('未找到 chrome.exe');
}

const env = readEnv();
const clean = await purgeBanners([1, 4], 'diag 前置');
console.log('前置清理归零 =', clean);
const hq = await signIn(BASE, 'uat.hqadmin@svc.local', env.UAT_HQADMIN_PASSWORD);

const png = fs.readFileSync(path.join(FIX, 'banner-b.png'));
const fd = new FormData();
fd.append('banner', new Blob([png], { type: 'image/png' }), 'diag.png');
const up = await fetch(`${BASE}/api/svc:bannerUpload?store_id=1&alt_text=${encodeURIComponent('门店1横幅')}`, {
  method: 'POST', headers: { Authorization: `Bearer ${hq}`, 'X-Request-Id': uuid() }, body: fd,
});
const upJson = await up.json();
console.log('上传:', up.status, 'id=', upJson?.data?.id, 'status=', upJson?.data?.status);
const idA = upJson.data.id;
const pub = await fetch(`${BASE}/api/svc:bannerPublish`, {
  method: 'POST', headers: { Authorization: `Bearer ${hq}`, 'Content-Type': 'application/json', 'X-Request-Id': uuid() },
  body: JSON.stringify({ banner_id: idA }),
});
console.log('发布:', pub.status, await pub.text());

const port = 9955;
const profile = path.join(os.tmpdir(), `b36diag-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const child = spawn(findChrome(), ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--ignore-certificate-errors',
  '--window-size=1440,1400', 'about:blank'], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const l = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const pg = l.find((t) => t.type === 'page');
    if (pg?.webSocketDebuggerUrl) { wsUrl = pg.webSocketDebuggerUrl; break; }
  } catch { /* 未就绪 */ }
  await sleep(250);
}
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws')), { once: true }); });
let id = 0; const pending = new Map();
const netLog = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Network.responseReceived' && /svc:|\/api\//.test(m.params?.response?.url || '')) {
    netLog.push(`${m.params.response.status} ${String(m.params.response.url).replace(BASE, '')}`);
  }
  if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => pending.has(i) && (pending.delete(i), reject(new Error('超时 ' + method))), 30000); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/admin/` });
await sleep(2500);
await ev(`localStorage.setItem('NOCOBASE_TOKEN', ${JSON.stringify(hq)}); localStorage.setItem('nocobase-token', ${JSON.stringify(hq)}); 'ok'`);
await send('Page.navigate', { url: `${BASE}/admin/${PAGE_UID}` });
await sleep(9000);

const dump = await ev(`(() => {
  const txt = document.body.innerText || '';
  const all = [...document.querySelectorAll('button')].map((b) => JSON.stringify((b.textContent||'').trim()));
  // 找到 Banner 区块的锚点文本，取它之后的 DOM 片段
  const i = txt.indexOf('客户页顶部横幅');
  return {
    allButtons: all,
    bannerAnchorFound: i >= 0,
    bannerExcerpt: i >= 0 ? txt.slice(i, i + 500) : null,
    toasts: [...document.querySelectorAll('.ant-message-notice, .ant-notification-notice')].map((n) => (n.textContent||'').trim()),
    bannerImgs: [...document.querySelectorAll('img')].filter((im)=>(im.getAttribute('src')||'').includes('/api/public/banner/')).map((im)=>({src:im.getAttribute('src'),natW:im.naturalWidth})),
  };
})()`);

console.log('\n=== 网络（含 /api/） ===');
console.log(netLog.slice(-25).join('\n'));
console.log('\n=== 所有按钮文本 ===');
console.log(dump.allButtons.join('\n'));
console.log('\n=== Banner 锚点 ===', dump.bannerAnchorFound);
console.log(dump.bannerExcerpt);
console.log('\n=== Toast ===', JSON.stringify(dump.toasts));
console.log('\n=== 预览图 ===', JSON.stringify(dump.bannerImgs));

try { ws.close(); } catch { /* noop */ }
try { child.kill('SIGKILL'); } catch { /* noop */ }
await sleep(400);
try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2 }); } catch { /* noop */ }
await purgeBanners([1, 4], 'diag 收尾');
process.exit(0);
