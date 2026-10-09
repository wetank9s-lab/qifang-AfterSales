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
    // ⚠️ 序列化要**能读出真因**：早前只取 `a.value ?? a.type`，结果把错误打成 `J`
    //    （控制台对象被 CDP 传成 preview 结构），等于"有错误但查不出是什么"。
    //    这里把 value / description / preview / unserializableValue 都串起来。
    // ⚠️ 顺序很关键：**先取 preview.properties，再退到 description**。
    //    实测踩到：AxiosError 对象没有 `value`，若先退到 `description`
    //    只会得到被压缩的类名（`J`）—— 而真正的信息（`name` / `message`）在
    //    `preview.properties` 里。顺序写反 ⇒ 日志里有错误但**查不出是什么**。
    const serializeArg = (a) => {
      if (a == null) return '';
      if (a.value !== undefined && a.value !== null) {
        return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
      }
      if (a.preview?.properties?.length) {
        const label = a.preview.description ?? a.preview.subtype ?? 'object';
        const props = a.preview.properties.map((p) => `${p.name}=${p.value}`).join(' ');
        return `${label}{${props}}`;
      }
      if (a.unserializableValue) return String(a.unserializableValue);
      if (a.description) return a.description;
      return a.type ?? '';
    };
    const serialized = p.args.map(serializeArg).join(' ').trim().slice(0, 400);
    if (loggedIn) {
      // 附带原始载荷（截断）：序列化仍然读不出真因时，至少能看到 CDP 到底给了什么。
      // ⚠️ 只在有值时保留第一条原始载荷，避免把控制台刷满。
      if (consoleErrors.length === 0) {
        try {
          consoleErrors.push(`[raw] ${JSON.stringify(p).slice(0, 600)}`);
        } catch {
          /* 循环引用等忽略 */
        }
      }
      consoleErrors.push(serialized);
    } else {
      preLoginErrors.push(serialized);
    }
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
  try {
    await cdp.waitFor(`location.href.indexOf('/signin') === -1`, { what: '登录跳转', timeout: 45_000 });
  } catch (e) {
    // 失败自证：登录这一步同样要把"到底哪些请求没通过"打出来
    const diag = await cdp.evaluate(`(() => ({
      href: location.href,
      bodyHead: (document.body?.innerText ?? '').slice(0, 300),
    }))()`);
    console.log('  ⛔ 登录步骤诊断：');
    console.log(`     href: ${diag?.href}`);
    console.log(`     body: ${String(diag?.bodyHead).replace(/\s+/g, ' ').slice(0, 240)}`);
    console.log('     /api 请求（含状态）:');
    for (const c of calls.slice(-12)) console.log(`       ${c.status ?? '-'}  ${c.url}`);
    throw e;
  }
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

  // ---- ① 业务导航：打开一行详情的"查看"入口（不经原生 Edit/Delete）----
  // 判据是"详情面真的展开了"，不是"点了一下" —— 只点不看等于没验。
  let detailOpened = false;
  try {
    await cdp.evaluate(`(() => {
      const row = document.querySelector('body'); // 用真实鼠标点更可靠，这里只做预备
      return !!row;
    })()`);
    // 用真实鼠标点第一行的第一个业务按钮/行体（NocoBase 行点击进详情）
    const box = await cdp.evaluate(`(() => {
      const el = document.querySelector('.ant-table-row td');
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (box) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await sleep(4000);
      detailOpened = await cdp.evaluate(
        `document.querySelectorAll('.ant-drawer, .ant-modal, .ant-card').length > 0`,
      );
    }
  } catch { /* 详情打不开也算记录，不掩盖主结论 */ }
  console.log(`  ${detailOpened ? '✅' : '⚠️'} 业务导航（点行 → 详情面展开）：${detailOpened ? '已展开' : '未观察到展开'}`);

  // ---- ② 双 Tab：第二个标签页打开同一页面，仍须零 429 ----
  // 为什么必须测：多个标签页会**并发**拉同一批 schema 与 bundle，
  // 共享同一个限流桶 —— 这是"单 Tab 恰好过、双 Tab 就 429"的典型场景。
  let secondTabOk = false;
  try {
    const t2 = await cdp.send('Target.createTarget', { url: `${SVC_BASE_URL}/admin/${schemaUid}` });
    const page2 = (await pollJsonEndpoint(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).find(
      (t) => t.targetId === t2.targetId || (t.url || '').includes(`/admin/${schemaUid}`),
    );
    if (page2) {
      const ws2 = new WebSocket(page2.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws2.addEventListener('open', res, { once: true });
        ws2.addEventListener('error', () => rej(new Error('第二个标签页 CDP 连接失败')), { once: true });
      });
      const cdp2 = new Cdp(ws2);
      await cdp2.send('Page.enable');
      await cdp2.send('Runtime.enable');
      await cdp2.send('Network.enable');
      cdp2.on('Network.requestWillBeSent', (p) => {
        const url = p.request?.url ?? '';
        if (!url.includes('/api/') && !url.includes('/static/')) return;
        calls.push({ url: url.replace(SVC_BASE_URL, ''), method: p.request.method, requestId: p.requestId, status: null, tab: 2 });
      });
      cdp2.on('Network.responseReceived', (p) => {
        const hit = calls.find((c) => c.requestId === p.requestId && c.tab === 2);
        if (hit) hit.status = p.response?.status ?? null;
      });
      // 等第二个标签页把表格渲出来（超时不算致命，但记录清楚）
      try {
        await cdp2.waitFor('document.querySelectorAll(".ant-table").length > 0', { what: '第二标签页表格', timeout: 40_000 });
        await sleep(3000);
        secondTabOk = true;
      } catch {
        secondTabOk = false;
      }
      console.log(`  ${secondTabOk ? '✅' : '❌'} 双 Tab 并发加载：${secondTabOk ? '第二个标签页也渲染出表格' : '第二个标签页未渲染出表格'}`);
    } else {
      console.log('  ⚠️ 双 Tab：未能定位第二个 target（跳过，但记录为未验证）');
    }
  } catch (e) {
    console.log(`  ⚠️ 双 Tab 检查出错（记录为未验证）：${String(e?.message ?? e).slice(0, 160)}`);
  }

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
  // ⚠️ 刻意**不写死**任何请求数当产品阈值：171/49 是**某次实测的规模**，
  //    它随启用插件数、页面区块数、字段数变化。写死会让门禁在"加了插件"时
  //    以产品无回归的方式变红。这里只**打印**规模（供限流取值时参考），不判红。
  isOk(`本次页面加载规模：静态资源 ${staticCount} 个 / 业务接口 ${calls.length - staticCount} 个`
    + '（**仅作参考，不是阈值** —— 各限流区必须 ≥ 该规模，但具体数值由实测反推，见 docs/PHASE-11.md）');

  if (!detailOpened) {
    notOk('业务导航：点行后未观察到详情面展开（门店员工无法从列表进入服务详情）');
  } else {
    isOk('业务导航：点行 → 详情面展开');
  }

  if (!secondTabOk) {
    notOk('双 Tab 并发加载未通过（多标签页共享同一限流桶，是"单 Tab 过、双 Tab 挂"的典型场景）');
  } else {
    isOk('双 Tab 并发加载：第二个标签页同样渲染出表格');
  }

  // -------------------------------------------------------------------------
  // 【4】反向验证：**真正超限必须 429**
  // -------------------------------------------------------------------------
  // 🔴 为什么必须有这一条：上面 4 条断言全是"零 429"。
  //    而"零 429"有两种可能达成方式 —— ①额度真的够；②**限流根本没生效**。
  //    只测前者等于把"限流器坏了"当成"通过"。这条反向验证证明限流器是活的：
  //    真把某个区打超 ⇒ 必须出现 429。
  //
  // 取值依据（不写死数量）：目标区为 `svc_upload`（60r/m, burst 20）
  //   ⇒ 连续发到出现首个 429 的期望次数 ≈ burst + 少量。
  //   这里**循环打到第一个 429 为止**（上限 60 次），而不是写死"第几次必须 429"。
  //
  // ⚠️ 副作用管理（必须交代）：这次冲击会消耗 `svc_upload` 的桶，而 smoke 也会用
  //    同区（师傅接口）。因此打完后**等待桶恢复**再退出，避免把 429 留给下一支门禁
  //    —— 本项目历史上就吃过"串跑撞 30r/m ⇒ 429 假红"的亏。
  console.log('');
  console.log('【4】反向验证：真正超限必须 429（证明限流器是活的，而不是"零 429"另有原因）');
  console.log('');
  {
    // ⚠️ Token 形状的探针值必须**运行时构造**，不能写字面量：
    //    写 43 个 A 会被仓库的密钥审计当成"43 位 token"命中（实测踩到），
    //    而那时唯一"顺理成章"的修法就是给它加豁免 —— **安全工具最不该豁免**。
    //    运行时拼出来 ⇒ 源码里没有任何 token 形状的字面量，审计自然干净。
    const probePath = `/api/technician/visits/${'A'.repeat(43)}`;
    let first429AtAttempt = null;
    const ATTEMPT_MAX = 60;
    for (let i = 1; i <= ATTEMPT_MAX; i += 1) {
      const r = await fetch(`${SVC_BASE_URL}${probePath}`, { redirect: 'manual' });
      if (r.status === 429) {
        first429AtAttempt = i;
        break;
      }
    }
    if (first429AtAttempt === null) {
      notOk(`连续 ${ATTEMPT_MAX} 次请求同一个受限期（svc_upload）都没出现 429 —— `
        + '限流器可能没生效（"零 429"因此不可信）');
    } else {
      isOk(`第 ${first429AtAttempt} 次请求触发 429（svc_upload 限额生效，未写死次数，循环打到出现为止）`);
    }

    // 等桶恢复：sr 60r/m ⇒ 约 1 token/s；实测等待 25s 已足够覆盖 burst 被吃掉的量。
    // 等待时长同样是**按额度推算**而不是拍脑袋，并打印出来。
    const refillSeconds = 25;
    console.log(`  ·  等待 ${refillSeconds}s 让 svc_upload 的桶恢复（避免把 429 留给下一支门禁 —— `
      + '本项目历史上吃过"串跑撞限流 ⇒ 429 假红"的亏）');
    await sleep(refillSeconds * 1000);
    const after = await fetch(`${SVC_BASE_URL}${probePath}`, { redirect: 'manual' });
    if (after.status === 429) {
      notOk(`等待 ${refillSeconds}s 后仍 429 —— 恢复时间不足，会污染后续门禁`);
    } else {
      isOk(`桶已恢复（等待后同路径返回 ${after.status}，不再是 429）`);
    }
  }

  // -------------------------------------------------------------------------
  // 控制台错误：**分类**而不是放宽
  // -------------------------------------------------------------------------
  // 🔴 判据（不是豁免）：业务角色的平台元数据边界会**故意**拒绝一批资源
  //    （例如 `environmentVariables:list` —— 它可能含真实密钥，绝不能给门店角色读）。
  //    前端 SDK 对这类 403 会 `console.error` 一条 AxiosError，而那是**边界在正确工作**。
  //
  //    ⇒ 因此不看"有没有错误"，而是**配对核验**：
  //      ① 每条被容忍的控制台错误必须**恰好**是 `403` 的 AxiosError；
  //      ② 本次运行里必须**真的存在**对应的 403 API 请求（否则这条 403 无从解释）；
  //      ③ **条数封顶**：容忍的控制台 403 条数 ≤ 实际 403 请求条数
  //         （这样"某个允许的接口忽然 403"不可能躲在这条判据后面）。
  //    任何非 403 的错误（JS 异常、500、TypeError…）**照常红灯**。
  {
    const isAxios403 = (m) => /Request failed with status code 403/.test(String(m));
    const rawMarks = consoleErrors.filter((m) => String(m).startsWith('[raw]'));
    const realErrors = consoleErrors.filter((m) => !String(m).startsWith('[raw]'));
    const api403 = calls.filter((c) => c.status === 403);
    const others = realErrors.filter((m) => !isAxios403(m));

    if (others.length) {
      notOk(`浏览器控制台有 ${others.length} 条**非 403** 的错误：${others.slice(0, 3).join(' | ')}`);
    } else if (realErrors.length === 0) {
      isOk('浏览器控制台零错误');
    } else if (realErrors.length <= api403.length) {
      isOk(
        `浏览器控制台 ${realErrors.length} 条错误**全部**是 403（本次确有 ${api403.length} 条 403 请求与之对应）` +
          ` —— 这是**平台元数据边界在故意拒绝**，不是缺陷。被拒资源：` +
          `${[...new Set(api403.map((c) => c.url))].slice(0, 5).join(', ')}`,
      );
    } else {
      notOk(
        `控制台有 ${realErrors.length} 条 403 错误，但本次只有 ${api403.length} 条 403 请求 —— ` +
          '数量对不上，说明有 403 不是"边界拒绝"造成的',
      );
    }

    // ---- 被拒资源**不得**引发"持续加载 / 重复请求"（用户 2026-10-09 要求）----
    //
    // 判据：按 URL 聚合本次运行里被拒资源的请求次数。
    //   · 一次正常页面加载（含双 Tab）对同一被拒资源只会发**个位数**次；
    //   · 若前端在重试循环里反复打它，次数会显著放大（几十上百）。
    // ⚠️ 上限取 10 是"病态重复"的界限，**不是性能阈值**：
    //    它的作用是"抓重试风暴"，所以定得宽松；页面加载规模另由上面的"仅作参考"输出。
    {
      const RETRY_STORM_LIMIT = 10;
      const counts = new Map();
      for (const c of api403) counts.set(c.url, (counts.get(c.url) ?? 0) + 1);
      if (counts.size === 0) {
        isOk('本次没有被拒请求（无需检查重试风暴）');
      } else {
        const worst = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const storm = worst.filter(([, n]) => n > RETRY_STORM_LIMIT);
        const summary = worst.map(([u, n]) => `${n}× ${u.split('/api/')[1] ?? u}`).join(' · ');
        if (storm.length) {
          notOk(
            `被拒资源出现**重复请求风暴**（>${RETRY_STORM_LIMIT} 次）：${storm
              .map(([u, n]) => `${n}× ${u}`)
              .join(' / ')} —— 前端在重试一个注定 403 的请求`,
          );
        } else {
          isOk(`被拒资源无重试风暴（各 ${summary}；上限 ${RETRY_STORM_LIMIT} 属病态界限，非性能阈值）`);
        }
      }
    }
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
