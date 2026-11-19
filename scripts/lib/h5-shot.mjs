/**
 * h5-shot.mjs —— 用 **CDP 严格布局视口** 截一张整页图
 * =============================================================================
 * 为什么需要这个文件（2026-11-13 实测结论）
 * -----------------------------------------------------------------------------
 *   旧做法：`chrome --headless=new --window-size=390,H --screenshot=x.png <url>`
 *
 *   问题：`--window-size` 设的是**窗口外框宽**，布局视口实际更宽（实测约 406px），
 *   Chrome 再把结果裁到 390 ⇒ **右侧内容被削掉约 16px**。
 *
 *   症状（用户真实反馈）：
 *     · 客户报修页「我要投诉」显示成「我要投讠」
 *     · 门店电话 028-83992299 被切一半
 *     · 评价页第五颗星看不全
 *
 *   但同一页面的几何体检（CDP 严格 390 视口）却判"无横向溢出"——
 *   因为**产品本身没问题，是截图口径错了**。
 *
 *   决定性判据（一次定向检查实测）：
 *     CDP 设 390 视口后，`我要投诉` rect = left 199 / right **374**（完整在屏内）、
 *     全页越界元素 = **0**、截图宽 = 780 = 390 × DPR(2)。
 *
 * 用法
 * -----------------------------------------------------------------------------
 *   node scripts/lib/h5-shot.mjs <url> <out.png> <width> <height> <budgetMs> [profileDir]
 *
 * 约定
 * -----------------------------------------------------------------------------
 *   · 成功：进程退出码 0，文件已写出
 *   · 失败：退出码非 0，stderr 带原因（调用方自行决定是否继续）
 *   · **必须尽量清理 profile**：C 盘是硬约束（历史上 91 个残留 profile 打满过盘）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const [url, outPng, wArg, hArg, budgetArg, profileArg] = process.argv.slice(2);
if (!url || !outPng) {
  console.error('用法: node scripts/lib/h5-shot.mjs <url> <out.png> [width] [height] [budgetMs] [profileDir]');
  process.exit(64);
}

const VW = Number(wArg) || 390;
const VH = Number(hArg) || 844;
const BUDGET = Number(budgetArg) || 15000;
const PROFILE = profileArg || path.join(process.env.TEMP || '/tmp', `h5shot-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
const PORT = 9600 + Math.floor(Math.random() * 300);
const DPR = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* noop */ } }
  throw new Error('未找到 chrome.exe（可用 CHROME_PATH 指定）');
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(e));
    });
    this.ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 40000);
    });
  }
  close() { try { this.ws.close(); } catch { /* noop */ } }
}

async function main() {
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  const child = spawn(findChrome(), [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    '--hide-scrollbars',
    '--ignore-certificate-errors',
    `--window-size=${VW},${VH}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const pg = list.find((t) => t.type === 'page');
      if (pg?.webSocketDebuggerUrl) { wsUrl = pg.webSocketDebuggerUrl; break; }
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!wsUrl) throw new Error('浏览器未就绪（CDP 端口无页面目标）');

  const cdp = new Cdp(wsUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  /**
   * 🔴 关键一步：**严格设定布局视口**。
   *   这一步是 `--window-size` 做不到的，也是"截图被切"的根治点。
   */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VW, height: VH, deviceScaleFactor: DPR, mobile: true,
  });

  const nav = cdp.send('Page.navigate', { url });
  await nav;
  // 等网络安静 + 渲染稳定（不用固定死等：轮询 readyState）
  const tNav = Date.now();
  while (Date.now() - tNav < BUDGET) {
    const st = await cdp.send('Runtime.evaluate', {
      expression: 'document.readyState', returnByValue: true,
    }).then((r) => r.result?.value).catch(() => null);
    if (st === 'complete') break;
    await sleep(200);
  }
  // 给 Vue 首屏渲染与字体加载留一点时间（不改变视口）
  await sleep(1200);

  /**
   * 整页截图：先量出文档高度，再用 captureBeyondViewport 一次拍完。
   * ⚠️ 高度上限设 8000：避免异常页面（如无限滚动）把内存吃光。
   */
  const metrics = await cdp.send('Runtime.evaluate', {
    expression: `(() => ({
      h: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      w: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    }))()`,
    returnByValue: true,
  }).then((r) => r.result?.value || {});
  const fullH = Math.min(Math.max(metrics.h || VH, VH), 8000);

  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: VW, height: fullH, scale: 1 },
  });
  const buf = Buffer.from(shot.data, 'base64');
  fs.writeFileSync(outPng, buf);

  /**
   * 自证：截图宽度必须等于 视口宽 × DPR。
   * 不等就说明口径又歪了 —— 这时**必须报错**，不能让调用方拿到一张"看着有图但被切"的图。
   */
  const pngW = buf.readUInt32BE(16);
  const pngH = buf.readUInt32BE(20);
  const wantW = VW * DPR;
  if (pngW !== wantW) {
    console.error(`截图宽度不符：得到 ${pngW}，期望 ${wantW}（${VW}×${DPR}）。视口=${JSON.stringify(metrics)}`);
    process.exitCode = 3;
  }

  console.error(`[h5-shot] ${path.basename(outPng)} ${pngW}x${pngH} ${buf.length}B `
    + `(视口 ${VW}x${VH} DPR=${DPR} 文档高 ${metrics.h} innerW ${metrics.innerW})`);

  cdp.close();
  try { child.kill('SIGKILL'); } catch { /* noop */ }
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 2 }); } catch { /* 晚释放 */ }
}

main().catch(async (e) => {
  console.error('[h5-shot] 失败:', e?.message || e);
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 2 }); } catch { /* noop */ }
  process.exit(2);
});
