/**
 * arc-r0chg01-browser.mjs —— ARC-V1 / R0-CHG-01 真实浏览器验收（§五 ①②③⑥ 的页面侧）
 *
 * 为什么必须有这一条（不能让接口验收代替它）：
 *   §五 ①②③ 说的都是"**页面**已无门店选择和验证码""输入手机号能查到"
 *   "同一手机号跨两家门店时正确显示对应门店名称与记录" —— 这些是**渲染**结论。
 *   接口返回对了、页面渲染错了，是完全可能的（字段名拼错、分组循环写错）。
 *
 * ## 判据纪律（沿用本项目已沉淀的教训）
 *
 *  1. **不能只看"卡片出现了"**：卡片出现可能来自缓存/上一次的 DOM。
 *     必须同时有**两条独立通道**：
 *       · 页面内 JS 桩计数（stubHits）—— 证明页面调了接口；
 *       · CDP `Network.requestWillBeSent` —— 证明网络上真有这条请求。
 *     因为桩是**透传**（计数后调原生 fetch），两者数量必须**相等**：
 *       · netCount > hits ⇒ 有请求绕过桩（观测点有洞）⇒ TEST INVALID；
 *       · hits > 0 而 netCount = 0 ⇒ 请求被桩吞掉 ⇒ TEST INVALID。
 *     另有 ⓪ 步"桩自证"：让桩返回一个**只有它才能给出**的探针店名，
 *     页面若显示它，说明桩确实挂在业务调用链上（否则 hits>0 可能是巧合）。
 *  2. fetch 与 XHR **都要桩**：本项目踩过"只桩 fetch，XHR 透到网络"的坑。
 *     本页只用 fetch，但桩必须两条都覆盖，否则将来改用 XHR 就静默失效。
 *  3. 截图按 **字节数 + 哈希** 区分状态，**不复用旧图**当另一种状态的证据。
 *  4. 每个断言都要有**会红的对手场景**：跨店用例若只断言"有 2 张卡"，
 *     一个"把两家店合并成一张卡"的实现也能通过 ⇒ 必须断言**门店名分别出现**
 *     且**各自的记录数正确**。
 *
 * 用法：
 *   node scripts/arc-r0chg01-browser.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const CDP_PORT = Number(process.env.SVC_CDP_PORT || 9444);
const OUT = path.resolve('storage/arc-r0chg01-evidence');
const PROFILE = path.resolve('.tmp-r0chg01-profile');

const M_CROSS = '13600000001';   // store 1：已发布 2 条
const M_SPAN = '13900007777';    // 由本脚本造：跨 store 1 / store 4
const M_EMPTY = '13600009876';   // 无任何档案 ⇒ 空态

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};
const section = (t) => console.log(`\n=== ${t} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function psql(sql) {
  const env = {};
  try {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  } catch { /* 用默认值 */ }
  return execFileSync(
    'docker',
    ['exec', '-i', 'svc-postgres', 'psql', '-U', env.POSTGRES_USER || 'svc_app',
      '-d', env.POSTGRES_DB || 'service_ticket',
      '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8' },
  ).trim();
}

function findChrome() {
  for (const c of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ]) if (fs.existsSync(c)) return c;
  // agent-browser 缓存的 Chrome
  const bases = [
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
    path.join(process.env.LOCALAPPDATA || '', 'agent-browser'),
  ];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    for (const dir of fs.readdirSync(base)) {
      const p = path.join(base, dir);
      if (!fs.statSync(p).isDirectory()) continue;
      for (const c of fs.readdirSync(p).map((x) => path.join(p, x))) {
        if (/chrome\.exe$/i.test(c) && fs.existsSync(c)) return c;
      }
    }
  }
  throw new Error('找不到 Chrome/Edge');
}

/* ---------------- 极简 CDP 客户端 ---------------- */
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
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 30000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('JS error: ' + (r.exceptionDetails.text || '') + ' ' + (r.exceptionDetails.exception?.description || ''));
    }
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function waitFor(cdp, expr, timeout = 15000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let v; try { v = await cdp.evaluate(expr); } catch { v = undefined; }
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`等待超时${label ? '（' + label + '）' : ''}: ${expr}`);
}

/** 截图并返回 { bytes, sha256, file } —— 供"不同状态必须是不同图"用 */
async function shoot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.data, 'base64');
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, buf);
  const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  console.log(`        · 截图 ${name}  ${buf.length}B  sha256=${sha}`);
  return { bytes: buf.length, sha, file };
}

/* ---------------- 测试数据准备 ---------------- */
function seedSpan() {
  const tag = 'R0CHG01-BW-' + Date.now();
  const rows = [
    { sid: 1, type: 'service', name: '浏览器跨店A' },
    { sid: 4, type: 'hvac', name: '浏览器跨店B' },
  ];
  for (let i = 0; i < rows.length; i += 1) {
    const r0 = rows[i];
    psql(`INSERT INTO service_archives
      (created_at, updated_at, archive_no, store_id, archive_type, customer_name, customer_mobile,
       service_address, status, visibility, version)
      VALUES (now(), now(), '${tag}-${i}', ${r0.sid}, '${r0.type}', '${r0.name}', '${M_SPAN}',
              '浏览器验收地址', 'pending', 'published', 1);`);
  }
  return tag;
}

/* ========================================================================= */
const chromePath = findChrome();
console.log(`ARC-V1 / R0-CHG-01 · 真实浏览器验收`);
console.log(`  BASE=${BASE}  浏览器=${chromePath}`);

if (fs.existsSync(PROFILE)) fs.rmSync(PROFILE, { recursive: true, force: true });
const seedTag = seedSpan();
const chrome = spawn(chromePath, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--ignore-certificate-errors',
  '--window-size=390,844',
  'about:blank',
], { stdio: 'ignore' });

let cdp = null;
try {
  /* 等调试端口 */
  let target = null;
  for (let i = 0; i < 60 && !target; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* 未就绪 */ }
    if (!target) await sleep(300);
  }
  if (!target) throw new Error('Chrome 调试端口未就绪');

  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  /* ----------------------------------------------------------------------
   * 网络观测：两条**互相独立**的通道，缺一不可
   *
   *   通道 A：页面内 JS 桩计数（window.__stubHits）—— 证明"页面调了接口"
   *   通道 B：CDP 的 Network.requestWillBeSent —— 证明"网络上真有这条请求"
   *
   * 为什么必须两条都有（而不是只看一条）：
   *   · 只看 A：桩可能被绕过（比如代码改用 XHR、或用了别的 URL），
   *     而 A 是 0，会被读成"页面没请求" —— 实际是观测点失效。
   *   · 只看 B：无法知道页面**调的是哪个接口**（比如它其实调了 sendCode）。
   *
   * 因为本脚本的桩是**透传**（计数后调原生 fetch），所以两条通道的
   * 数量应当**相等**：
   *   · `netCount > hits` ⇒ 有请求绕过了桩（观测点有洞）⇒ 判 TEST INVALID；
   *   · `hits > 0 而 netCount === 0` ⇒ 请求没真的发出去（桩把它吞了）⇒ 同样无效。
   * -------------------------------------------------------------------- */
  const netSeen = [];
  const rawOnMessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method === 'Network.requestWillBeSent') {
      const url = m.params?.request?.url || '';
      if (url.includes('/api/publicArchive')) netSeen.push(url);
    }
  };
  cdp.ws.addEventListener('message', rawOnMessage);

  // 在**业务脚本之前**注入桩（addScriptToEvaluateOnNewDocument）
  //
  // ⚠️ 桩的形态：**透传计数**，不是"返回假数据"。
  //    最初写成返回假 payload，那样 ②③④ 验的就是我编的数据，而不是真实响应
  //    —— 页面渲染对了也说明不了产品对。所以：
  //      · 正常路径：计数 → 调**原生** fetch → 真实响应（计数与真实性兼得）；
  //      · 另配一个 `__probeStoreName` 开关，临时让桩返回探针数据，
  //        用来证明"桩确实在链路上"（否则 hits>0 可能来自别的地方）。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (() => {
        window.__stubHits = 0;
        window.__stubLog = [];
        window.__probeStoreName = null;   // 非空时：桩返回探针数据（自证用）

        const pick = (url) => String(url).includes('publicArchive:queryByMobile');
        const origFetch = window.fetch;
        // 保留原生引用：验收 429 那段必须**关掉桩**回到真实网络
        // （用桩验"有没有被限流"等于自己骗自己 —— 桩不发真请求）
        window.__nativeFetch = origFetch;

        window.fetch = function (input, init) {
          const url = typeof input === 'string' ? input : (input && input.url);
          if (!pick(url)) return origFetch.apply(this, arguments);

          let body = {};
          try { body = JSON.parse((init && init.body) || '{}'); } catch { /* ignore */ }
          window.__stubHits += 1;
          window.__stubLog.push({ via: 'fetch', mobile: body.mobile, probe: !!window.__probeStoreName });

          if (window.__probeStoreName) {
            // 仅自证用：返回一份**可识别**的假数据
            return Promise.resolve(new Response(JSON.stringify({
              data: {
                mobile_masked: '000****0000',
                groups: [{ store_id: 999, store_name: window.__probeStoreName, archives: [
                  { archive_type: 'service', archive_type_label: '探针类型', progress: 'ongoing', progress_label: '探针进度' }] }],
                total: 1,
              },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
          }
          return origFetch.apply(this, arguments);
        };

        // XHR 同样要计数（本项目踩过"只桩 fetch，XHR 透网"）。
        // 这里只**计数并透传**，不伪造响应。
        const OrigXhr = window.XMLHttpRequest;
        function StubXhr() {
          const real = new OrigXhr();
          const self = this;
          this._url = null;
          this.open = function (m, u, ...rest) { self._url = u; return real.open(m, u, ...rest); };
          this.setRequestHeader = function (...a) { return real.setRequestHeader(...a); };
          this.send = function (bodyStr) {
            if (pick(self._url)) {
              window.__stubHits += 1;
              window.__stubLog.push({ via: 'xhr', probe: !!window.__probeStoreName });
            }
            return real.send(bodyStr);
          };
          this.addEventListener = function (...a) { return real.addEventListener(...a); };
          this.removeEventListener = function (...a) { return real.removeEventListener(...a); };
          this.abort = function () { return real.abort(); };
          for (const k of ['status','statusText','responseText','response','readyState']) {
            Object.defineProperty(self, k, { get: () => real[k] });
          }
          Object.defineProperty(self, 'onload', {
            get: () => real.onload, set: (f) => { real.onload = f; },
          });
        }
        window.XMLHttpRequest = StubXhr;
      })();
    `,
  });

  const pageUrl = `${BASE}/h5/archive.html`;
  await cdp.send('Page.navigate', { url: pageUrl });
  await sleep(1500);

  /* =======================================================================
   * ① 页面已无门店选择和验证码（真实 DOM，不是源码 grep）
   * ======================================================================= */
  section('① 页面已无门店选择和验证码（真实 DOM）');
  const dom = await cdp.evaluate(`(() => ({
    ids: ['storeSel','codeInput','sendBtn','verifyBtn','mobileInput','queryBtn']
      .reduce((a,id)=> (a[id] = !!document.getElementById(id), a), {}),
    selects: document.querySelectorAll('select').length,
    inputs: [...document.querySelectorAll('input')].map(i=>i.id||i.type),
    buttons: [...document.querySelectorAll('button')].map(b=>b.id||b.textContent.trim()),
    renderLoaded: typeof window.ArcRender === 'object' && typeof window.ArcRender.summaryStoreBlock === 'function',
    queryFn: typeof window.ArcRender,
  }))()`);
  check(dom.ids.mobileInput === true, '页面有手机号输入框 #mobileInput');
  check(dom.ids.queryBtn === true, '页面有查询按钮 #queryBtn');
  for (const id of ['storeSel', 'codeInput', 'sendBtn', 'verifyBtn']) {
    check(dom.ids[id] === false, `DOM 中不存在 #${id}`);
  }
  check(dom.selects === 0, '页面上**没有任何 select**（门店下拉已彻底移除）', `select 数=${dom.selects}`);
  check(dom.inputs.length === 1, '页面上只有 1 个 input（手机号）', `inputs=${JSON.stringify(dom.inputs)}`);
  check(dom.renderLoaded === true, 'archive-render.js 含 summaryStoreBlock（新渲染函数已部署）');
  const s0 = await shoot(cdp, '01-query-view.png');

  /* ---------------------------------------------------------------------
   * ⓪ 桩自证：先证明"计数"这件事本身在链路上
   * ------------------------------------------------------------------- */
  section('⓪ 观测点自证（桩确实在链路里，不是摆设）');
  await cdp.evaluate('window.__probeStoreName = "探针门店XYZ"');
  await cdp.evaluate(`(() => {
    const m = document.getElementById('mobileInput');
    m.value = '${M_CROSS}';
    m.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('queryBtn').click();
    return true;
  })()`);
  await waitFor(cdp, "document.getElementById('viewResult').hidden === false", 15000, '探针结果视图');
  await sleep(300);
  const probeShown = await cdp.evaluate(
    "[...document.querySelectorAll('#resultBody .sum-store')].map(e=>e.textContent).join('|')");
  check(String(probeShown).includes('探针门店XYZ'),
    '桩生效自证：页面显示了**只有桩才能给出**的探针门店名',
    `页面上的门店名=${probeShown}`);
  const probeHits = await cdp.evaluate('window.__stubHits');
  check(Number(probeHits) > 0, '探针请求被计入 stubHits', `hits=${probeHits}`);
  // 还原：关掉探针，回到真实响应
  await cdp.evaluate('window.__probeStoreName = null');
  await cdp.evaluate("document.getElementById('requeryBtn').click(); true");
  await waitFor(cdp, "document.getElementById('viewQuery').hidden === false", 10000, '回查询视图');
  psql(`DELETE FROM api_guards WHERE scene='archive_query';`);
  await cdp.evaluate('window.__stubHits = 0');

  /* =======================================================================
   * ② 输入手机号能查到已发布档案摘要（真实请求 + 真渲染）
   * ======================================================================= */
  section('② 输入手机号查到已发布档案摘要');
  // 先清桶，避免上一轮验收的限流残留
  psql(`DELETE FROM api_guards WHERE scene='archive_query';`);

  const beforeHits = await cdp.evaluate('window.__stubHits');
  const beforeNet = netSeen.length;

  await cdp.evaluate(`(() => {
    const m = document.getElementById('mobileInput');
    m.value = '${M_CROSS}';
    m.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('queryBtn').click();
    return true;
  })()`);

  await waitFor(cdp, "document.getElementById('viewResult').hidden === false", 15000, '结果视图');
  await sleep(500);

  const hits = (await cdp.evaluate('window.__stubHits')) - beforeHits;
  const netCount = netSeen.length - beforeNet;
  check(hits > 0, '页面确实调用了摘要接口（stubHits > 0）', `hits=${hits}`);
  check(netCount > 0, '网络上确实出现了该请求（CDP 观测到，非仅桩自报）', `netCount=${netCount}`);
  check(netCount === hits,
    '两条观测通道的计数一致（桩无洞、请求未被吞）⇒ 本测试有效',
    `hits=${hits} netCount=${netCount}`);

  const detail = await cdp.evaluate(`(() => {
    const body = document.getElementById('resultBody');
    return {
      cards: body.querySelectorAll('.card').length,
      stores: [...body.querySelectorAll('.sum-store')].map(e=>e.textContent),
      counts: [...body.querySelectorAll('.sum-count')].map(e=>e.textContent),
      rows: [...body.querySelectorAll('.sum-row')].map(e=>e.textContent.trim()),
      text: body.textContent,
      pageSub: document.getElementById('pageSub').textContent,
    };
  })()`);
  check(detail.stores.length === 1 && detail.stores[0] === '新都圣大家电',
    '结果按门店分组，门店名为「新都圣大家电」', `stores=${JSON.stringify(detail.stores)}`);
  check(detail.rows.length === 2, '该门店下渲染 2 条摘要行', `rows=${detail.rows.length}`);
  check(detail.pageSub.includes('136****0001'), '页头显示**服务端给的**脱敏手机号', detail.pageSub);
  // 界面上绝不能出现明文号码
  check(!detail.text.includes(M_CROSS), '结果区不含明文手机号');
  // 摘要行只含"类型 + 进度"，不得出现档案编号/姓名/地址
  check(!/DA-\d{8}-\d{4}/.test(detail.text), '摘要区不含档案编号（无枚举入口）');
  check(!detail.text.includes('照片验证'), '摘要区不含客户姓名');
  const s2 = await shoot(cdp, '02-result-one-store.png');

  /* =======================================================================
   * ③ 同一手机号跨两家门店分别展示
   * ======================================================================= */
  section('③ 同一手机号跨两家门店分别展示');
  await cdp.evaluate("document.getElementById('requeryBtn').click(); true");
  await waitFor(cdp, "document.getElementById('viewQuery').hidden === false", 10000, '回查询视图');
  psql(`DELETE FROM api_guards WHERE scene='archive_query';`);

  await cdp.evaluate(`(() => {
    const m = document.getElementById('mobileInput');
    m.value = '${M_SPAN}';
    m.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('queryBtn').click();
    return true;
  })()`);
  await waitFor(cdp, "document.getElementById('viewResult').hidden === false", 15000, '跨店结果视图');
  await sleep(500);

  const span = await cdp.evaluate(`(() => {
    const body = document.getElementById('resultBody');
    const cards = [...body.querySelectorAll('.card')].filter(c=>c.querySelector('.sum-store'));
    return cards.map(c => ({
      store: c.querySelector('.sum-store').textContent,
      count: c.querySelector('.sum-count').textContent,
      rows: [...c.querySelectorAll('.sum-row')].map(r=>r.textContent.trim()),
    }));
  })()`);
  check(span.length === 2, '渲染 2 张门店卡（未被合并成 1 张）', `cards=${span.length}`);
  const storeNames = span.map((c) => c.store);
  check(storeNames.includes('新都圣大家电') && storeNames.includes('金堂华林电器'),
    '两张卡的店名分别是「新都圣大家电」与「金堂华林电器」', storeNames.join(' / '));
  // 逐卡核对记录**属于本店**（A 店 service / B 店 hvac）—— 防"把两家记录堆在一张卡里"
  const svc = span.find((c) => c.store === '新都圣大家电');
  const hvac = span.find((c) => c.store === '金堂华林电器');
  check(svc && svc.rows.length === 1 && svc.rows[0].includes('上门服务'),
    'A 店卡内只有本店的「上门服务」1 条', JSON.stringify(svc));
  check(hvac && hvac.rows.length === 1 && hvac.rows[0].includes('暖通工程'),
    'B 店卡内只有本店的「暖通工程」1 条', JSON.stringify(hvac));
  const s3 = await shoot(cdp, '03-result-two-stores.png');

  /* =======================================================================
   * ④ 无可展示记录 → 指定文案
   * ======================================================================= */
  section('④ 无可展示记录时的空态文案');
  await cdp.evaluate("document.getElementById('requeryBtn').click(); true");
  await waitFor(cdp, "document.getElementById('viewQuery').hidden === false", 10000, '回查询视图');
  psql(`DELETE FROM api_guards WHERE scene='archive_query';`);

  await cdp.evaluate(`(() => {
    const m = document.getElementById('mobileInput');
    m.value = '${M_EMPTY}';
    m.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('queryBtn').click();
    return true;
  })()`);
  await waitFor(cdp, "document.getElementById('viewResult').hidden === false", 15000, '空态视图');
  await sleep(400);
  const emptyText = await cdp.evaluate("document.getElementById('resultBody').textContent");
  check(String(emptyText).includes('未查询到可展示的服务档案'),
    '空态文案为「未查询到可展示的服务档案」', String(emptyText).trim().slice(0, 60));
  const s4 = await shoot(cdp, '04-empty.png');

  /* =======================================================================
   * ⑤ 超限 → 指定文案（真实第 4 次 429）
   * ======================================================================= */
  section('⑤ 超限时的提示文案（真实第 4 次 429）');
  await cdp.evaluate("document.getElementById('requeryBtn').click(); true");
  await waitFor(cdp, "document.getElementById('viewQuery').hidden === false", 10000, '回查询视图');

  // ⚠️ 这里**必须关掉桩**：限流是服务端行为，桩住的响应永远 200，
  //    用桩来验收 429 等于自己骗自己（"假闸门"的另一种形态）。
  const restored = await cdp.evaluate(`(() => {
    if (!window.__nativeFetch) return false;
    window.fetch = window.__nativeFetch;    // 还原为原生 fetch
    return true;
  })()`);
  check(restored === true, '已关闭请求桩，回到真实网络（否则限流验收无意义）');

  psql(`DELETE FROM api_guards WHERE scene='archive_query';`);
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    const st = await cdp.evaluate(`(async () => {
      const r = await fetch('/api/publicArchive:queryByMobile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: '${M_EMPTY}' }),
      });
      return r.status;
    })()`);
    statuses.push(st);
    await sleep(150);
  }
  check(JSON.stringify(statuses) === JSON.stringify([200, 200, 200, 429]),
    '页面上下文里连续 4 次请求为 200,200,200,429（服务端限流在浏览器侧同样生效）',
    `statuses=${statuses.join(',')}`);

  // 文案：走真实点击（第 5 次必然 429），应显示服务端话术
  await cdp.evaluate(`(() => {
    const m = document.getElementById('mobileInput');
    m.value = '${M_EMPTY}';
    m.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('queryBtn').click();
    return true;
  })()`);
  await waitFor(cdp, "document.querySelector('#queryMsg.show') ? true : false", 12000, '超限提示');
  await sleep(300);
  const msg = await cdp.evaluate("document.getElementById('queryMsg').textContent");
  check(String(msg).includes('查询过于频繁'),
    '超限提示为「查询过于频繁，请稍后再试」', String(msg).trim());
  const s5 = await shoot(cdp, '05-rate-limited.png');

  /* 按钮必须恢复可用（不能因为 429 卡死） */
  const btnState = await cdp.evaluate(`(() => {
    const b = document.getElementById('queryBtn');
    return { disabled: b.disabled, text: b.textContent.trim() };
  })()`);
  check(btnState.disabled === false, '超限后按钮恢复可用（不会永久卡死）', JSON.stringify(btnState));

  /* =======================================================================
   * ⑥ 截图互不相同（防"复用旧图当另一种状态的证据"）
   * ======================================================================= */
  section('⑥ 各状态截图互不相同（哈希各不相同）');
  const shots = [s0, s2, s3, s4, s5];
  const shas = shots.map((s) => s.sha);
  check(new Set(shas).size === shas.length, '5 张截图的 sha256 互不相同',
    shas.join(' / '));
  check(s2.sha !== s3.sha, '「单店结果」与「跨店结果」是**不同**的图（跨店渲染确实变了）',
    `${s2.sha} vs ${s3.sha}`);
  check(s4.sha !== s2.sha, '「空态」与「有结果」是**不同**的图', `${s4.sha} vs ${s2.sha}`);
  check(s5.sha !== s0.sha && s5.sha !== s2.sha,
    '「超限提示」是**新**图（未复用查询态/结果态旧图）', `${s5.sha}`);

  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({
    base: BASE, shots: shots.map((s) => ({ file: path.basename(s.file), bytes: s.bytes, sha256: s.sha })),
    statuses, netSeen,
  }, null, 2), 'utf8');

  cdp.ws.removeEventListener('message', rawOnMessage);
} catch (e) {
  console.error('\n[脚本异常]', e && (e.stack || e.message || e));
  results.push({ pass: false, label: '浏览器验收未抛异常', detail: String(e && (e.message || e)) });
} finally {
  try { if (cdp) cdp.close(); } catch { /* ignore */ }
  try { chrome.kill(); } catch { /* ignore */ }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
  try { psql(`DELETE FROM service_archives WHERE archive_no LIKE '${seedTag}-%';`); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n========== 汇总 ==========`);
console.log(`共 ${results.length} 条断言，通过 ${results.length - failed.length}，失败 ${failed.length}`);
for (const f of failed) console.log(`  FAIL  ${f.label}${f.detail ? '  — ' + f.detail : ''}`);
process.exit(failed.length ? 1 : 0);
