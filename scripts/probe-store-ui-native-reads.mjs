#!/usr/bin/env node
/**
 * probe-store-ui-native-reads.mjs —— 门店后台「UI 实际发了哪些原生请求」清单（Phase 11 / P11-0）
 *
 * ===========================================================================
 * 为什么必须抓真实浏览器，而不是 grep 源码 / 读页面定义
 * ===========================================================================
 * 收紧 ACL（`setStrategyResources` 建立"未知资源默认拒绝"的一级边界）之前，
 * 必须知道**后台真的依赖哪些原生读取**。而当前 `strategyResources === null`
 * ⇒ 任何资源都放行 ⇒ 这些依赖**完全不可见**：源码里看不到、页面定义里也推不准
 * （NocoBase 的关系字段/区块/权限探针会在运行时自行发起请求）。
 *
 * ⇒ 唯一可信的口径：**以门店账号真登录 → 打开真实页面 → 抓 Network 里发出的
 *    `/api/<resource>:<action>`**。这份清单就是"收紧后必须仍然工作"的对象集合。
 *
 * ===========================================================================
 * 判据（不是"打印一堆 URL"）
 * ===========================================================================
 *   ① 记录 UI 实际请求过的每一个 `resource:action`（含次数与状态码）
 *   ② 与 `probe-native-read-deps.mjs --baseline` 的"当前可读资源"对照，
 *      标出**必须拒绝组**（users/roles/collections）是否被 UI 依赖 —— 若被依赖，
 *      则"收紧 ACL"必须**先**提供受控最小业务接口，否则后台会断（这正是要防的事）
 *   ③ 落盘证据，便于改后复跑对照
 *
 * 用法：node scripts/probe-store-ui-native-reads.mjs
 * 退出码：0 记录完成 / 2 环境未就绪
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.tmp-verify');

function envValue(key, fallback = '') {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* 落到 process.env */ }
  return process.env[key] ?? fallback;
}

const STORE_EMAIL = envValue('UAT_STORE_A_EMAIL', 'uat.store.a@svc.local');
const STORE_PASSWORD = envValue('UAT_STORE_A_PASSWORD');

class EnvNotReady extends Error {}

function psqlScalar(sql) {
  return execFileSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

function findChrome() {
  if (process.env.WALKTHROUGH_CHROME) return process.env.WALKTHROUGH_CHROME;
  const base = path.join(process.env.USERPROFILE || process.env.HOME || '', '.agent-browser', 'browsers');
  if (!fs.existsSync(base)) throw new EnvNotReady(`找不到 ${base} —— 先跑一次 agent-browser install`);
  const candidates = fs
    .readdirSync(base)
    .filter((d) => d.startsWith('chrome-'))
    .sort()
    .reverse()
    .map((d) => path.join(base, d, 'chrome.exe'))
    .filter((p) => fs.existsSync(p));
  if (!candidates.length) throw new EnvNotReady(`${base} 下没有 chrome-*/chrome.exe`);
  return candidates[0];
}

const DEBUG_PORT = 24000 + Math.floor(Math.random() * 12000);
const PROFILE_DIR = path.join(OUT_DIR, `chrome-profile-nativeread-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        return;
      }
      if (msg.method) {
        const hs = this.handlers.get(msg.method);
        if (hs) for (const h of hs) h(msg.params);
      }
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}, timeout = 30_000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  }
  async waitFor(expression, { timeout = 30_000, what = expression } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const v = await this.evaluate(`(() => { try { return ${expression}; } catch (e) { return false; } })()`);
      if (v) return v;
      await sleep(250);
    }
    throw new Error(`等待超时：${what}`);
  }
}

async function pollJsonEndpoint(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new EnvNotReady(`Chrome 调试端口没起来（${url}）`);
}

// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  门店后台「UI 实际发出的原生请求」清单（Phase 11 / P11-0）');
console.log('══════════════════════════════════════════════════════════════');

if (!STORE_PASSWORD) {
  console.log('  ⛔ .env 缺 UAT_STORE_A_PASSWORD —— 环境未就绪');
  process.exit(2);
}

const schemaUid = psqlScalar(
  `SELECT "schemaUid" FROM "desktopRoutes" WHERE type='flowPage' AND title='我的门店工单' LIMIT 1`,
);
if (!schemaUid) {
  console.log('  ⛔ 找不到「我的门店工单」页面（desktopRoutes）—— 环境未就绪');
  process.exit(2);
}
console.log(`  · 入口：${SVC_BASE_URL}`);
console.log(`  · 门店账号：${STORE_EMAIL}`);
console.log(`  · 列表页：/admin/${schemaUid}`);

const chromePath = findChrome();
fs.mkdirSync(PROFILE_DIR, { recursive: true });

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // 🔴 自签演练证书：Chrome 默认停在证书错误页 ⇒ 登录页的 input 永远不出现。
    //    实测踩到（P11-0）：TLS 迁移把**所有**浏览器走查脚本一起打断了 ——
    //    它们此前都打 http，改成 https 后必须显式忽略证书错误。
    //    ⚠️ 只在演练模式（SVC_TLS_INSECURE）下加；正式域名 + 受信 CA 到位后不能带这个标志，
    //       否则等于把'证书链是否可信'这件事在走查里也一起关掉了。
    ...(SVC_TLS_INSECURE ? ['--ignore-certificate-errors', '--allow-insecure-localhost'] : []),
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

/** 抓到的所有 /api/ 请求（含原生 collection 调用） */
const calls = [];
const consoleErrors = [];
const preLoginErrors = [];
/** 登录完成标记：console 错误按它切窗口，避免把'还没登录'的 401 当成缺陷 */
let loggedIn = false;

try {
  const page = (await pollJsonEndpoint(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).find(
    (t) => t.type === 'page',
  );
  if (!page) throw new EnvNotReady('Chrome 没有 page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new EnvNotReady('CDP 连接失败')), { once: true });
  });
  const cdp = new Cdp(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  cdp.on('Network.requestWillBeSent', (p) => {
    const url = p.request?.url ?? '';
    // 采集 /api/ 与 /static/ 两类：前者验业务限流，后者验静态资源限流
    // （两者都曾被 svc_general 打满 ⇒ SPA 起不来，见 docs/PHASE-11.md §P11-0）
    if (!url.includes('/api/') && !url.includes('/static/')) return;
    calls.push({ url: url.replace(SVC_BASE_URL, ''), method: p.request.method, requestId: p.requestId, status: null });
  });
  cdp.on('Network.responseReceived', (p) => {
    const hit = calls.find((c) => c.requestId === p.requestId);
    if (hit) hit.status = p.response?.status ?? null;
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error') return;
    // ⚠️ 必须区分**登录前 / 登录后**：
    //    登录前 SPA 会主动探测 `auth:check` 等接口并拿到 401（这是正常形态，
    //    NocoBase 就是靠 401 判断"还没登录"），会在控制台留下错误。
    //    把它算进来 ⇒ 断言恒红，then 人会去"修"一个正常现象。
    //    ⇒ 只对**登录之后**的错误做断言（与 smoke 的"就绪之后"窗口同一条纪律）。
    const serialized = p.args
      .map((a) => a.value ?? a.description ?? (a.preview ? JSON.stringify(a.preview) : a.type))
      .join(' ')
      .slice(0, 300);
    if (loggedIn) consoleErrors.push(serialized);
    else preLoginErrors.push(serialized);
  });

  // ---- 真实登录 ----
  await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/signin` });
  try {
    await cdp.waitFor('document.querySelectorAll("input").length >= 2', { what: '登录页就绪', timeout: 30_000 });
  } catch (e) {
    // 失败时**自证现场**：排障最缺的从来不是"它挂了"，而是"挂之前页面到底是什么"。
    const diag = await cdp.evaluate(`(() => ({
      href: location.href, title: document.title,
      inputs: document.querySelectorAll('input').length,
      bodyLen: (document.body?.innerText ?? '').length,
      bodyHead: (document.body?.innerText ?? '').slice(0, 400),
      htmlHead: (document.documentElement?.outerHTML ?? '').slice(0, 400),
    }))()`);
    console.log('  ⛔ 登录页诊断：');
    for (const [k, v] of Object.entries(diag ?? {})) {
      console.log(`     ${k}: ${String(v).replace(/\s+/g, ' ').slice(0, 260)}`);
    }
    console.log('     consoleErrors: ' + JSON.stringify(consoleErrors.slice(0, 5)));
    console.log('     /api 请求：' + JSON.stringify(calls.slice(0, 8).map((c) => c.url + ' → ' + c.status)));
    throw e;
  }
  await cdp.evaluate(`(() => {
    const ins = [...document.querySelectorAll('input')];
    const setVal = (el, val) => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setVal(ins[0], ${JSON.stringify(STORE_EMAIL)});
    setVal(ins[1], ${JSON.stringify(STORE_PASSWORD)});
    return true;
  })()`);
  await sleep(800);
  await cdp.evaluate(`document.querySelector('button[type="submit"], .ant-btn-primary').click()`);
  await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 45_000 });
  loggedIn = true;
  const loginMark = calls.length;
  console.log(`  ✅ 门店账号登录成功（登录阶段 ${loginMark} 个 /api 请求）`);

  // ---- 打开列表页，等表格与数据都到位 ----
  await cdp.send('Page.navigate', { url: `${SVC_BASE_URL}/admin/${schemaUid}` });
  try {
    await cdp.waitFor('document.querySelectorAll(".ant-table").length > 0', { what: '表格容器出现', timeout: 40_000 });
  } catch (e) {
    // 与登录页同一纪律：失败时自证现场（挂之前页面到底是什么、API 返回了什么）
    const diag = await cdp.evaluate(`(() => ({
      href: location.href,
      title: document.title,
      tables: document.querySelectorAll('.ant-table').length,
      bodyLen: (document.body?.innerText ?? '').length,
      bodyHead: (document.body?.innerText ?? '').slice(0, 400),
    }))()`);
    console.log('  ⛔ 列表页诊断：');
    for (const [k, v] of Object.entries(diag ?? {})) {
      console.log(`     ${k}: ${String(v).replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    console.log('     consoleErrors: ' + JSON.stringify(consoleErrors.slice(0, 5)));
    console.log('     非 2xx 的 /api 请求：' +
      JSON.stringify(calls.filter((c) => c.status && c.status >= 400).slice(0, 10).map((c) => `${c.url} → ${c.status}`)));
    throw e;
  }
  await sleep(4000); // 给关系字段/下拉/权限探针把请求发完
  const tables = await cdp.evaluate('document.querySelectorAll(".ant-table").length');
  const rows = await cdp.evaluate('document.querySelectorAll(".ant-table-row").length');
  console.log(`  ✅ 列表页已渲染：表格 ${tables} 个 · 行 ${rows} 行`);

  // ---- 打开一行详情（详情页会额外拉时间线/上门记录等）----
  let detailOpened = false;
  try {
    detailOpened = await cdp.evaluate(`(() => {
      const row = document.querySelector('.ant-table-row');
      if (!row) return false;
      row.click();
      return true;
    })()`);
    await sleep(4000);
  } catch { /* 详情打不开也算记录，不掩盖主结论 */ }
  console.log(`  ${detailOpened ? '✅' : '⚠️'} 详情行点击：${detailOpened ? '已执行' : '无行可点'}`);

  // ---- 聚合 ----
  const agg = new Map();
  for (const c of calls) {
    // 形如 /api/serviceTickets:list?pageSize=20  →  serviceTickets:list
    const m = /\/api\/([A-Za-z][\w]*):([A-Za-z]\w*)/.exec(c.url);
    const key = m ? `${m[1]}:${m[2]}` : `(非资源型) ${c.url.split('?')[0]}`;
    const cur = agg.get(key) ?? { key, count: 0, statuses: new Set(), resource: m ? m[1] : null };
    cur.count += 1;
    if (c.status) cur.statuses.add(c.status);
    agg.set(key, cur);
  }
  const list = [...agg.values()].sort((a, b) => b.count - a.count);

  console.log('');
  console.log('【1】UI 实际请求的原生资源（按次数）');
  console.log('');
  for (const it of list) {
    const st = [...it.statuses].join('/') || '-';
    console.log(`  ·  ${it.key.padEnd(42)} ×${String(it.count).padEnd(4)} 状态 ${st}`);
  }

  // ---- 关键判定：UI 是否依赖"必须拒绝"组的资源 ----
  const MUST_DENY = ['users', 'roles', 'collections', 'storages', 'attachments'];
  const deniedDeps = list.filter((it) => it.resource && MUST_DENY.includes(it.resource));
  const bizDeps = list.filter((it) => it.resource && !MUST_DENY.includes(it.resource));

  console.log('');
  console.log('【2】与 ACL 收紧的关系（这份清单的用途）');
  console.log('');
  console.log(`  ·  业务资源依赖（收紧后**必须继续工作**）：${bizDeps.length} 种`);
  for (const it of bizDeps) console.log(`        ${it.key}`);
  if (deniedDeps.length === 0) {
    console.log('  ✅ UI **没有**依赖 users / roles / collections —— 收紧后后台不会因此断掉');
  } else {
    console.log(`  🔴 UI **依赖了**必须拒绝的资源：${deniedDeps.map((d) => d.key).join(', ')}`);
    console.log('      ⇒ 收紧 ACL **之前**必须先提供受控最小业务接口（契约 §16.1），否则后台会断。');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const evidence = {
    at: new Date().toISOString(),
    base: SVC_BASE_URL,
    schemaUid,
    tables,
    rows,
    detailOpened,
    aggregated: list.map((it) => ({ key: it.key, count: it.count, statuses: [...it.statuses] })),
    bizDeps: bizDeps.map((d) => d.key),
    deniedDeps: deniedDeps.map((d) => d.key),
    consoleErrors,
    preLoginErrors,
  };
  const evidencePath = path.join(OUT_DIR, 'native-read-deps-ui.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  console.log('');
  console.log(`  证据已落盘：${path.relative(ROOT, evidencePath).replace(/\\/g, '/')}`);

  // -------------------------------------------------------------------------
  // 回归断言（这才是本脚本真正的价值）
  // -------------------------------------------------------------------------
  // 🔴 2026-10-09 实测事故：P10-B 给 `/static/plugins/` 与 `location /` 加的
  //    `limit_req zone=svc_general burst=60` **把后台 SPA 打挂了** ——
  //    一次页面加载的插件 bundle 与 `flowModels:findOne` 数量远超 60，
  //    表现为 `limiting requests … by zone "svc_general"` + 前端
  //    `应用错误 Request failed with status code 429`、登录页永远 Loading。
  //    **当时所有门禁全绿**，因为没有任何一支门禁用真浏览器加载过后台。
  //    ⇒ 这条断言就是补那个缺口：**真浏览器 + 真登录 + 真渲染**。
  console.log('');
  console.log('【3】回归断言（真浏览器加载后台）');
  console.log('');
  let failed = 0;
  const notOk = (m) => { failed += 1; console.log(`  ❌ ${m}`); };
  const isOk = (m) => console.log(`  ✅ ${m}`);

  if (tables === 0 || rows === 0) {
    notOk(`后台列表页没有渲染出表格/数据（表格 ${tables} 个 · 行 ${rows} 行）—— 后台对真实浏览器不可用`);
  } else {
    isOk(`后台列表页真实渲染：表格 ${tables} 个 · 行 ${rows} 行`);
  }

  const throttled = calls.filter((c) => c.status === 429);
  if (throttled.length) {
    const byZone = new Map();
    for (const c of throttled) {
      const k = c.url.includes('/static/') ? '静态资源(/static/)' : '业务接口(/api/)';
      byZone.set(k, (byZone.get(k) ?? 0) + 1);
    }
    notOk(`出现 ${throttled.length} 个 429（限流打满）：${[...byZone].map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    for (const c of throttled.slice(0, 5)) console.log(`       429 → ${c.url}`);
    console.log('       ⇒ 额度低于真实页面加载的请求数：调 nginx 限流，别去调客户端。');
  } else {
    isOk('全程零 429（一次真实后台页面加载未触发任何限流区）');
  }

  const staticCount = calls.filter((c) => c.url.includes('/static/')).length;
  isOk(`静态资源请求 ${staticCount} 个 / 业务接口 ${calls.length - staticCount} 个 —— 这就是各限流区必须承载的真实规模`);

  if (consoleErrors.length) {
    notOk(`浏览器控制台有 ${consoleErrors.length} 条错误：${consoleErrors.slice(0, 3).join(' | ')}`);
  } else {
    isOk('浏览器控制台零错误');
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ✅ 后台对真实浏览器可用（清单 + 回归断言均通过）`);
    console.log('     业务资源依赖 ' + bizDeps.length + ' 种；必须拒绝组依赖 ' + deniedDeps.length + ' 种');
    console.log('══════════════════════════════════════════════════════════════');
    console.log('');
    try { chrome.kill(); } catch { /* 忽略 */ }
    process.exit(0);
  }
  console.log(`  ❌ 回归断言失败 ${failed} 项`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  try { chrome.kill(); } catch { /* 忽略 */ }
  process.exit(1);
} catch (err) {
  try { chrome.kill(); } catch { /* 忽略 */ }
  if (err instanceof EnvNotReady) {
    console.log('');
    console.log(`  ⛔ ${err.message}（环境未就绪，不是产品红灯）`);
    console.log('');
    process.exit(2);
  }
  console.log('');
  console.log(`  ❌ ${err?.stack ?? err}`);
  console.log('');
  process.exit(1);
}
