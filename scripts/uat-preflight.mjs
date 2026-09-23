/**
 * Phase 4-I 真人走查的「前哨」—— 用与账户/数据完全相同的口径，先把 8 步里
 * **可自动判定**的部分跑一遍，并明确打印出哪些结论**只能由真人给出**。
 *
 * 为什么要有这个脚本（不是为了替代 I —— 强制条款 4 明确禁止）：
 *   ① 真人时间是最贵的资源。若某个临时账号其实**没建好门店映射**，
 *      真人走查第 1 步就会看到"我一张工单都没有"，然后花时间描述一个假故障；
 *   ② 走查记录里需要一份"环境事实"作为参照物：数据范围、状态、Visit 条数
 *      在走查**开始前**应当是多少，走查**结束后**又变成多少 ——
 *      没有这个参照，真人说的"状态变了/没变"无法被核对；
 *   ③ 它明确输出「以下 N 项必须由真人判断」，避免脚本绿了就被当成 I 通过。
 *
 * ⚠️ 本脚本**不**打印任何口令，也**不**修改任何业务数据（只读 + 一次登录）。
 *
 * 用法：node scripts/uat-preflight.mjs
 * 退出码：0 全部就绪 / 1 有阻塞 / 2 环境未就绪
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

const argv = process.argv.slice(2);
const TICKET_NO = (() => {
  const i = argv.indexOf('--ticket-no');
  return i !== -1 && argv[i + 1] ? argv[i + 1] : '';
})();

function envValue(key, fallback = '') {
  if (!fs.existsSync(ENV_PATH)) return fallback;
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(fs.readFileSync(ENV_PATH, 'utf8'));
  return m ? m[1].trim() : fallback;
}

const PORT = envValue('NGINX_HTTP_PORT', '8080');
const BASE_URL = `http://localhost:${PORT}`;

let passed = 0;
const failures = [];
const blockers = [];

function ok(m) {
  passed += 1;
  console.log(`  ✅ ${m}`);
}
function bad(m) {
  failures.push(m);
  console.log(`  ❌ ${m}`);
}
function warn(m) {
  blockers.push(m);
  console.log(`  ⚠️  ${m}`);
}

/**
 * 用 headless Chrome 真实登录并打开页面，数**实际渲染出来的表格行数**。
 *
 * 为什么必须走真实浏览器（DEV-65 的核心教训）：
 *   「接口 200 且有数据」**不能**证明「用户看得见」。DEV-65 缺陷态下
 *   `serviceTickets:list` 一直 200 且返回满数据，但页面上 `.ant-table` 数量为 0。
 *   唯一可靠的判据是 DOM 里真的有没有行。
 *
 * ⚠️ 一进程一账号，且**同一个 Chrome 实例只跑一个账号**：
 *   实测多账号串行时**只有第一个账号能成功**（失败跟随"位置"而非"账号"）。
 *   本函数每次调用**新起一个 Chrome 进程**，用完即杀，从结构上消除串扰。
 *
 * @returns {{ok:boolean, tables:number, rows:number, tickets:string[], is404:boolean, why?:string}}
 */
/** 从探测子进程输出里捞点线索用。故意保持极简：它只在探针自己坏了时才被调用。 */
function e_stderr_of(out) {
  return String(out || '').trim();
}

function renderProbe(chromePath, email, password, urlPath) {
  const script = `
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = ${JSON.stringify(chromePath)};
const BASE = ${JSON.stringify(BASE_URL)};
const TARGET = ${JSON.stringify(urlPath)};

// ⚠️⚠️ 账号口令必须**直接内联进下面 Runtime.evaluate 的那条表达式**（外层插值），
// 不能先存成生成的脚本里的 const、再在表达式里 JSON.parse(EMAIL_JSON)。
// 原因：Runtime.evaluate 把表达式丢进的是**浏览器页面的 JS 上下文**，
// 而 EMAIL_JSON 是**生成的 Node 脚本**里的变量 —— 页面里根本不存在这个名字。
// 实测症状：ReferenceError: EMAIL_JSON is not defined（异常被 evaluate 静默吞掉，
// 两个 input 保持为空）→ 点"登录"什么也不发生 → 页面**停在 /signin** →
// 探针如实报 tables=0/rows=0 → 看起来像"表格整块不渲染"的 DEV-65 复发。
// 这是 DEV-66「探针自己造出来的故障」的第二例：**假红伪装成真红**。
// 凡是"在 evaluate 的表达式里引用生成脚本的变量"都要先问：这名字在页面里有吗？
const PORT = 9800 + Math.floor(Math.random() * 150);

const userDir = 'C:\\\\Users\\\\Administrator\\\\AppData\\\\Local\\\\Temp\\\\cdp-preflight-' + Date.now() + '-' + Math.floor(Math.random()*1000);
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = async (p) => (await fetch('http://127.0.0.1:' + PORT + p)).json();

function bail(obj) {
  try { child.kill(); } catch {}
  console.log('RENDER|' + JSON.stringify(obj));
  process.exit(0);
}

let ver = null;
for (let i = 0; i < 60; i++) { try { ver = await httpJson('/json/version'); break; } catch { await sleep(500); } }
if (!ver) bail({ ok: false, tables: 0, rows: 0, tickets: [], tableBtns: [], is404: false, why: 'CDP 未启动' });

// ⚠️ 必须连 **browser** endpoint：Target.* 是 browser 级命令（DEV-66）
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const mid = ++id;
  const msg = { id: mid, method, params: params ?? {} };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => pending.set(mid, { res, rej }));
}
// ⚠️ 网络层：只回读 DOM 文字**不足以**判断抽屉是不是真的拿到了数据。
//    见 §3.7 的说明 —— 详情 404 时抽屉里的区块标题根本不会渲染（错误态只有一条 Alert），
//    所以"文字在不在"其实是有区分力的；但它仍然回答不了**"浏览器实际打的是哪个 URL"**。
//    真正让人反复猜的是后者，所以这一层必须显式抓下来。
const netResps = [];
/** requestId → url（loadingFailed 事件只给 requestId，必须能反查出是哪个地址） */
const netReqUrls = {};

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    // ⚠️ CDP 错误必须抛出，不能静默 resolve(undefined)（DEV-66）
    if (m.error) p.rej(new Error(m.method + ': ' + m.error.message)); else p.res(m.result);
  } else if (m.method === 'Network.requestWillBeSent') {
    const u = (m.params.request && m.params.request.url) || '';
    if (u.indexOf('svc:') !== -1) netReqUrls[m.params.requestId] = u;
  } else if (m.method === 'Network.responseReceived') {
    const r = m.params.response || {};
    const u = r.url || '';
    // 只看业务端点（svc: 系列）。列表用的是 serviceTickets:list，不会混进来。
    if (u.indexOf('svc:') !== -1) netResps.push({ url: u, status: r.status });
  } else if (m.method === 'Network.loadingFailed') {
    // 连接层失败（DNS/重置/中止）也要留下痕迹，否则会表现为"一条请求都没有"的假象
    const rid = m.params.requestId;
    const u = netReqUrls[rid] || '';
    if (u.indexOf('svc:') !== -1) netResps.push({ url: u, status: 'FAILED:' + (m.params.errorText || '') });
  }
});

await new Promise((r) => ws.addEventListener('open', r));

// 附着到已存在的 page target（browser endpoint 上不能直接发 Runtime.enable）
const targets = await send('Target.getTargets', {});
const pageTarget = targets.targetInfos.find((t) => t.type === 'page');
if (!pageTarget) bail({ ok: false, tables: 0, rows: 0, tickets: [], tableBtns: [], is404: false, why: '无 page target' });
const { sessionId } = await send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
const ctx = (method, params) => send(method, params, sessionId);

await ctx('Runtime.enable');
await ctx('Page.enable');
// 网络层：§3.7 要断言"点开详情时浏览器真的打出了 svc:timeline / svc:visits 且 2xx"
await ctx('Network.enable');

// 冷启动余量：本地 Nginx + NocoBase 首次请求要编译/加载客户端 bundle，
// 页面 onload 后 React 可能还没挂载完。宁可多等，也不要靠"再点一次"赌运气。
const BOOT_MS = 18000;

const snap = async () => {
  const r = await ctx('Runtime.evaluate', {
    expression: \`(() => JSON.stringify({
      url: location.href,
      tables: document.querySelectorAll('.ant-table').length,
      rows: document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length,
      // 同上：避免在嵌套模板里写 \\d（两层转义后变成匹配字面反斜杠）。
      // 工单号形态是 FW + 8 位数字 + '-' + 4 位数字，用 [0-9] 等价表达。
      tickets: [...(document.body.innerText||'').matchAll(/FW[0-9]{8}-[0-9]{4}/g)].map(m=>m[0]),
      // 表格行里渲染出来的按钮文字 —— 用来证明"自定义动作真的挂上去了"。
      // 见下方 3.6 段：只读 flowModels 不够，DEV-68 之后必须配一次真实渲染。
      // 只用内层双引号字符串拼接，**不写反引号、不写正则**（本脚本是嵌套模板生成）。
      tableBtns: [...new Set([...document.querySelectorAll('.ant-table button, .ant-table a')]
        .map((el) => (el.innerText || '').replace(/\\s+/g, ''))
        .filter(Boolean))],
      is404: document.body.innerText.indexOf('页面不存在') !== -1,
    }))()\`,
    returnByValue: true,
  });
  try { return JSON.parse(r.result.value); } catch { return { url: '', tables: 0, rows: 0, tickets: [], tableBtns: [], is404: false }; }
};

// 登录
await ctx('Page.navigate', { url: BASE + '/signin' });
await sleep(BOOT_MS);
const fp = await ctx('Runtime.evaluate', {
  expression: \`(() => JSON.stringify({ inputs: document.querySelectorAll('input').length }))()\`,
  returnByValue: true,
});
if (JSON.parse(fp.result.value).inputs < 2) bail({ ok: false, tables: 0, rows: 0, tickets: [], tableBtns: [], is404: false, why: '登录页未就绪' });

const fill = await ctx('Runtime.evaluate', {
  expression: \`(() => {
    const ins = [...document.querySelectorAll('input')];
    const setVal = (el, val) => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setVal(ins[0], ${JSON.stringify(email)});
    setVal(ins[1], ${JSON.stringify(password)});
    // 回读复核：填不进去就必须**当场红**，而不是等 25s 后报"表格未渲染"。
    // （DEV-66 教训：探针的故障会伪装成产品缺陷，必须在最短路径上暴露。）
    return JSON.stringify(ins.slice(0, 2).map((x) => x.value));
  })()\`,
  returnByValue: true,
});
// Runtime.evaluate 的异常走 result.subtype='error'，不会让 send() reject —— 必须显式查。
if (fill.result?.subtype === 'error') {
  bail({ ok: false, tables: 0, rows: 0, tickets: [], tableBtns: [], is404: false, why: '填写登录表单抛错：' + (fill.result.description || '').split(String.fromCharCode(10))[0] });
}
const filled = JSON.parse(fill.result.value || '[]');
if (filled[0] !== ${JSON.stringify(email)} || filled[1] !== ${JSON.stringify(password)}) {
  bail({ ok: false, tables: 0, rows: 0, tickets: [], tableBtns: [], is404: false, why: '登录表单未填入（实际长度 ' + filled.map((x) => (x || '').length).join('/') + '）' });
}
await sleep(1500);
// 点击"登录"：把"找得到按钮 / 点到了"也回读出来，别让"没点着"沉没成 25s 后的假红。
const clicked = await ctx('Runtime.evaluate', {
  expression: \`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').includes('登录')); if(!b) return 'NOT_FOUND'; b.click(); return 'CLICKED'; })()\`,
  returnByValue: true,
});
if (clicked.result?.value !== 'CLICKED') {
  bail({ ok: false, tables: 0, rows: 0, tickets: [], tableBtns: [], is404: false, why: '未找到登录按钮（' + (clicked.result?.value || clicked.result?.description || '?') + '）' });
}

// 等登录跳转完成。
// ⚠️ 判据用 url.indexOf('/signin') === -1 而不是正则 —— 这段脚本是**嵌套模板字符串**
//    生成出来的，正则里的反斜杠要穿过两层转义，极易写成斜杠斜杠signin 这种
//    字面反斜杠（实测直接 SyntaxError: Invalid regular expression flags）。
//    凡是"在生成的脚本里再写正则"都要多付一次转义成本，能不用就不用。
//    同理：这段生成脚本内部**不要出现反引号**，否则会提前闭合外层模板字符串。
{
  const dl = Date.now() + 45000;
  while (Date.now() < dl) {
    await sleep(2000);
    const s = await snap();
    if (s.url.indexOf('/signin') === -1) break;
  }
}

// 落到目标页（登录后通常已自动落在角色首个可达页；不一致才显式导航）
{
  const cur = await snap();
  if (cur.url !== BASE + TARGET) {
    await ctx('Page.navigate', { url: BASE + TARGET });
    await sleep(15000);
  }
}

// 等表格出现（条件等待，不赌固定 sleep）
let s = await snap();
{
  const dl = Date.now() + 40000;
  while (Date.now() < dl && s.tables === 0 && !s.is404) {
    await sleep(2500);
    s = await snap();
  }
}

// ---------------------------------------------------------------------------
// 点开「详情」抽屉，回读它**真实渲染出来的文字**
// ---------------------------------------------------------------------------
// 为什么必须做（Phase 4-I 第二轮整改后的新增哨兵）：
//   详情抽屉是**客户端自渲染**的（不走 NocoBase 弹窗，见 DEV-53 坑 1），
//   它里面用到的函数（状态中文化 / 当前 Visit / 时间线）全靠浏览器执行。
//   接口断言与产物断言都**看不见**"抽屉一打开就崩"这种状态 ——
//   而真人第一步就会点它。所以在真人到场前先用无头浏览器点一次、
//   把抽屉里的文字读回来，确认四区块真的渲染出来了。
//
// ⚠️ 取不到时**不**直接判红：表格为空 / 没有"详情"按钮时属于"这一页没什么可点"，
//    由外层按 rows 决定是"注意"还是"阻塞"。只有"点了但抽屉里没有四区块"
//    才是真红灯（那意味着整改后的抽屉没渲染出来）。
const drawer = { clicked: 'SKIPPED', open: false, sections: [], text: '', reqs: [] };
// 点之前先记下已抓到的条数：只统计"这一次点击引发的"请求
const netMark = netResps.length;
if (s.rows > 0) {
  const clicked = await ctx('Runtime.evaluate', {
    expression: \`(() => {
      // ⚠️ 必须是**数据行内**的「详情」按钮（真人点的是行级动作）。
      //    原实现是在整个 .ant-table 里找第一个文字等于「详情」的按钮 ——
      //    一旦工具栏/表头也出现同名按钮，点到的就不是行级动作了，而断言照样"通过"。
      const row = document.querySelector('.ant-table-tbody tr.ant-table-row');
      if (!row) return 'NO_ROW';
      const btns = [...row.querySelectorAll('button, a')];
      const b = btns.find((x) => ((x.innerText || '').trim()) === '详情');
      if (!b) return 'NO_BTN';
      b.click();
      return 'CLICKED';
    })()\`,
    returnByValue: true,
  });
  drawer.clicked = clicked.result?.value || 'ERROR';

  if (drawer.clicked === 'CLICKED') {
    // 抽屉要发两个接口（timeline + visits）再渲染，给它条件等待而不是固定 sleep
    const dl = Date.now() + 25000;
    while (Date.now() < dl) {
      await sleep(2000);
      const r = await ctx('Runtime.evaluate', {
        expression: \`(() => {
          const el = document.querySelector('.ant-drawer');
          const text = el ? (el.innerText || '') : '';
          const WANT = ['客户与问题', '当前服务', '处理记录'];
          return JSON.stringify({
            open: !!el,
            sections: WANT.filter((w) => text.indexOf(w) !== -1),
            // 只回前 300 字：够判断"渲染出来了没"，又不至于把数据糊满日志
            text: text.slice(0, 300),
          });
        })()\`,
        returnByValue: true,
      });
      try {
        const d = JSON.parse(r.result.value);
        drawer.open = d.open;
        drawer.sections = d.sections;
        drawer.text = d.text;
        if (d.open && d.sections.length === 3) break;
      } catch {
        /* 表达式异常时保留上一轮结果 */
      }
    }
  }
}

// 只取"点击之后"新增的那批请求 —— 这就是"点一次详情"引发的真实网络行为
drawer.reqs = netResps.slice(netMark);

try { ws.close(); } catch {}
bail({ ok: s.tables > 0 && s.rows > 0, tables: s.tables, rows: s.rows, tickets: s.tickets, tableBtns: s.tableBtns, is404: s.is404, drawer: drawer });
`;

  // 保留生成脚本便于排错（DEBUG_RENDER=1 时落盘），否则用完即删
  const tmp = process.env.DEBUG_RENDER
    ? path.join(ROOT, '.probe-render-debug.mjs')
    : path.join(ROOT, `.probe-render-${Date.now()}-${Math.floor(Math.random() * 1000)}.mjs`);
  const BROKEN = (why) => ({ ok: false, tables: 0, rows: 0, tickets: [], tableBtns: [], is404: false, why, probeBroken: true });
  try {
    fs.writeFileSync(tmp, script);

    // ⚠️ 探针自检（先语法、再运行）。见文件顶部 DEV-66 的说明：
    //    生成的脚本语法错了，症状会伪装成"页面空白/按钮缺失"这种**产品缺陷**，
    //    从而把人引去改没坏的东西。凡是"生成一段代码再执行"的探针都必须先做这一步。
    try {
      execFileSync(process.execPath, ['--check', tmp], { encoding: 'utf8', timeout: 30000 });
    } catch (e) {
      return BROKEN(`探针生成的脚本**语法错误**（不是产品缺陷）：${String(e.stderr || e.message).split('\n').slice(0, 3).join(' ')}`);
    }

    const out = execFileSync(process.execPath, [tmp], { encoding: 'utf8', timeout: 180000 });
    const line = out.split('\n').find((l) => l.startsWith('RENDER|'));
    if (!line) return BROKEN(`探针无 RENDER 输出（不是产品缺陷）—— stderr 前 200 字：${String(e_stderr_of(out)).slice(0, 200)}`);
    return JSON.parse(line.slice('RENDER|'.length));
  } catch (e) {
    // 子进程非 0 退出：stdout 里可能有半截输出，stderr 才是原因
    const detail = String(e.stderr || e.stdout || e.message).split('\n').filter(Boolean).slice(0, 3).join(' ');
    return BROKEN(`探针运行失败（不是产品缺陷）：${detail}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 已删除 */ }
  }
}

function dockerAvailable() {
  try {    execFileSync('docker', ['exec', 'svc-postgres', 'true'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function psqlScalar(sql) {
  return execFileSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

async function signIn(email, password) {
  const res = await fetch(`${BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) return null;
  return (await res.json()).data.token;
}

async function get(url, token) {
  const res = await fetch(`${BASE_URL}${url}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON（例如 HTML 错误页）—— 保留 null，由断言侧描述 */
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------

console.log('\n══ Phase 4-I 走查前哨（只读）══\n');

if (!dockerAvailable()) {
  console.error('  ❌ docker / svc-postgres 不可用 —— 环境未就绪\n');
  process.exit(2);
}

console.log('【环境事实】');
const health = await get('/api/svc/health');
if (health.status !== 200) {
  console.error(`  ❌ /api/svc/health 未就绪（HTTP ${health.status}）—— 环境未就绪\n`);
  process.exit(2);
}
ok(`应用健康：${JSON.stringify(health.body?.data ?? health.body)}`);

// 1) 三个临时账号可用性（口令从 .env 读，不回显）
const accounts = [
  { code: 'UAT-A', email: 'uat.store.a@svc.local', envKey: 'UAT_STORE_A_PASSWORD', store: 'S01', role: 'store_after_sales' },
  { code: 'UAT-B', email: 'uat.store.b@svc.local', envKey: 'UAT_STORE_B_PASSWORD', store: 'S02', role: 'store_after_sales' },
  { code: 'UAT-HQ', email: 'uat.hq@svc.local', envKey: 'UAT_HQ_PASSWORD', store: null, role: 'hq_after_sales' },
];

console.log('\n【账号与数据范围】');
const signed = {};
for (const acct of accounts) {
  const pwd = envValue(acct.envKey);
  if (!pwd) {
    warn(`${acct.code} 的 .env 口令缺失 —— 先跑 node scripts/uat-accounts.mjs --create`);
    continue;
  }
  const token = await signIn(acct.email, pwd);
  if (!token) {
    bad(`${acct.code} 登录失败 —— 走查会在第 1 步就卡住`);
    continue;
  }
  signed[acct.code] = { ...acct, token };

  const uid = psqlScalar(`SELECT id FROM users WHERE email = '${acct.email}'`);
  const stores = psqlScalar(
    `SELECT coalesce(string_agg(s.code, ','), '(无)') FROM store_users su JOIN stores s ON s.id = su.store_id WHERE su.user_id = ${uid}`,
  );
  const roles = psqlScalar(
    `SELECT coalesce(string_agg("roleName", ','), '(无)') FROM "rolesUsers" WHERE "userId" = ${uid}`,
  );
  ok(`${acct.code} 登录成功 · 角色=${roles} · 门店映射=${stores}`);
}

// 2) UAT 工单
console.log('\n【UAT 工单】');
let ticket = null;
// ⚠️ 必须挑**门店 A（S01）**那一张：主走查 8 步全在门店 A 的工单上做。
//    两店各造过一张后，`ORDER BY id DESC` 会拿到门店 B 的那张 ——
//    于是前哨把"门店 B 的 NEW 工单"当成基线，而真正要走查的那张没被检查。
const ticketNo = TICKET_NO || psqlScalar(
  `SELECT t.ticket_no FROM service_tickets t JOIN stores s ON s.id = t.store_id ` +
    `WHERE t.content LIKE 'UAT 走查专用工单%' AND s.code = 'S01' ORDER BY t.id DESC LIMIT 1`,
);
if (!ticketNo) {
  warn('未找到 UAT 专用工单 —— 先跑 --create --bootstrap-uat-ticket，或走查时另选一张 NEW 工单');
} else {
  const row = psqlScalar(
    `SELECT id || '|' || status || '|' || store_id || '|' || coalesce(handler_user_id::text,'-') FROM service_tickets WHERE ticket_no = '${ticketNo}'`,
  );
  const [id, status, storeId, handler] = row.split('|');
  ticket = { id: Number(id), ticketNo, status, storeId: Number(storeId), handler };
  if (status === 'NEW') ok(`工单 ${ticketNo}（id=${id}）状态 = NEW —— 符合走查起点`);
  else warn(`工单 ${ticketNo} 当前状态 = ${status}（走查第 2 步需要一张 NEW 工单；可另建一张）`);

  const visits = psqlScalar(`SELECT count(*) FROM service_visits WHERE ticket_id = ${id}`);
  const events = psqlScalar(`SELECT count(*) FROM ticket_events WHERE ticket_id = ${id}`);
  ok(
    `起始基线：Visit ${visits} 条 · 事件 ${events} 条` +
      `（本轮走查结束应变为 Visit 2 条 · 事件 ≥4 条业务事件〔含短信结果通知总量通常 ≥6〕；改派必须留下 SUPERSEDED 的历史行）`,
  );
}

// 3) 用 UAT-A 的身份预演第 1 步的**数据范围**（只验接口，不验界面）
console.log('\n【第 1 步 / 第 8 步 的数据范围（接口口径预演）】');
const A = signed['UAT-A'];
const B = signed['UAT-B'];
const HQ = signed['UAT-HQ'];

if (!A) {
  warn('UAT-A 不可用，跳过数据范围预演');
} else {
  // ⚠️ 工单列表走的是**原生资源** `serviceTickets`，不是自定义 svc action。
  //    最初这里写的是 `/api/svc:tickets:store`（我猜的名字）→ 一律 404，
  //    于是"门店隔离预演"看起来跑过了，实际什么都没验。
  //    接口名必须取自真实注册处，不能凭印象拼（见 plugin.ts 的 resourcer.define 与 constants 的 ACL）。
  const mineA = await get('/api/serviceTickets:list?pageSize=50', A.token);
  if (mineA.status === 200) {
    const rows = mineA.body?.data ?? [];
    const stores = [...new Set(rows.map((r) => r.store_id))];
    if (rows.length === 0) {
      warn('UAT-A 的工单列表返回 0 行 —— 若走查当刻也如此，真人第 1 步会看不到任何工单');
    } else if (stores.length === 1 && Number(stores[0]) === ticket?.storeId) {
      ok(`UAT-A 只看到门店 #${stores[0]} 的 ${rows.length} 条工单（门店隔离在接口层成立）`);
    } else {
      bad(`UAT-A 看到了 ${stores.length} 个门店的数据：${stores.join(',')} —— 门店隔离在接口层就已失效`);
    }
  } else {
    warn(`工单列表接口返回 HTTP ${mineA.status}（走查时请以页面为准）`);
  }

  // UAT-B 不应看到门店 A 的工单
  if (B && ticket) {
    const mineB = await get('/api/serviceTickets:list?pageSize=200', B.token);
    if (mineB.status === 200) {
      const rows = mineB.body?.data ?? [];
      const leaked = rows.filter((r) => Number(r.store_id) === ticket.storeId);
      if (leaked.length === 0) ok(`UAT-B 看不到门店 S01 的工单（0 条泄漏）`);
      else bad(`UAT-B 看到了 ${leaked.length} 条门店 S01 的工单 —— 越权`);
    } else {
      warn(`UAT-B 工单列表接口 HTTP ${mineB.status}`);
    }

    // 直链打开门店 A 的工单详情：应 404
    const direct = await get(`/api/serviceTickets:get?filterByTk=${ticket.id}`, B.token);
    if (direct.status === 404) ok(`UAT-B 凭直链访问门店 A 的工单 #${ticket.id} → 404（对象级越权被拦）`);
    else bad(`UAT-B 凭直链拿到了工单 #${ticket.id}（HTTP ${direct.status}）—— 越权`);
  }

  // HQ 应能看到两店数据
  //
  // ⚠️ 不能用"拉一页然后看有哪些 store_id"来判断覆盖范围：
  //    工单总数已 200+，而门店 B 只有个别几条 —— pageSize 一旦小于总数，
  //    门店 B 的工单就会**落在页外**，于是断言报"只看到 1 个门店"，
  //    而实际数据范围完全正常。这是"取不到 ≠ 不存在"的典型假红。
  //    正确做法：让服务端按门店聚合，而不是把数据拉回本地自己数。
  if (HQ) {
    const all = await get('/api/serviceTickets:list?pageSize=200', HQ.token);
    if (all.status !== 200) {
      warn(`全量工单接口 HTTP ${all.status}（走查第 7 步请以页面为准）`);
    } else {
      const total = all.body?.meta?.count ?? (all.body?.data ?? []).length;
      const covered = psqlScalar(
        'SELECT coalesce(string_agg(code, \',\' ORDER BY code), \'(无)\') FROM (' +
          '  SELECT s.code FROM service_tickets t JOIN stores s ON s.id = t.store_id ' +
          "  WHERE s.code IN ('S01','S02') GROUP BY s.code" +
          ') x',
      );
      const both = covered.split(',').filter(Boolean).length >= 2;
      if (both) {
        ok(`UAT-HQ 数据范围覆盖门店 ${covered}（全量共 ${total} 条）—— 第 7 步可证伪`);
      } else {
        warn(
          `门店 S01/S02 中只有 [${covered}] 有工单（第 7 步要求总部能同时看到两店）—— ` +
            `先跑 --bootstrap-uat-ticket 给两店各造一张`,
        );
      }
    }
  }
}

// 3.5) **界面层**预演：后台表格到底渲染不渲染（DEV-65 的唯一可靠哨兵）
//
// ⚠️ 这一节是**必需的**，不是"锦上添花"。
//
// 为什么：上面 3) 全部只验**接口**（`serviceTickets:list` 返回 200 且有数据），
//   而 DEV-65 的形态恰恰是「**接口全绿、页面空白**」——
//   资源级 ACL 缺 `view` → 前端 `aclCheck({actionName:'view'})` 不过 →
//   `TableBlockModel.hidden = true` → grid 剪掉整行 → **表格整块不渲染**。
//   当时前哨 10 项全绿、smoke 117 项全绿，真人一打开浏览器却什么都看不到。
//   也就是说：**没有这一节，前哨就无法区分"环境就绪"与"页面是空白的"**。
//
// 判据用 `.ant-table` + `.ant-table-tbody tr.ant-table-row` 的**实际 DOM 数量**，
//   不用接口返回体 —— 后者在缺陷态下依然是满的。
console.log('\n【界面渲染（DEV-65 哨兵）】');
/** code → { title, btns }：3.5 段顺手收集的行内按钮文字，供 3.6 段核对自定义动作。 */
const pageButtons = new Map();
/** code → 详情抽屉的真实渲染快照（3.5 段的 renderProbe 里顺手点开并回读），供 3.7 段断言 */
const pageDrawers = new Map();
{
  const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    'C:\\Users\\Administrator\\.agent-browser\\browsers\\chrome-153.0.8010.52\\chrome.exe',
  ].filter(Boolean);
  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));

  if (!chrome) {
    // 环境未就绪 ≠ 真红灯（铁律 4）：本机没装 Chrome 时给"注意"，不阻塞走查
    warn('未找到 Chrome，跳过界面渲染预演 —— **走查前请手工确认表格能显示出来**（DEV-65）');
  } else {
    /** 页面 schemaUid 必须**从库里取**，不要手抄（DEV-66：手抄 a7p45sundsb 写反一个字符，伪装成权限缺陷） */
    const pages = [
      { code: 'UAT-A', label: '我的门店工单', title: '我的门店工单', email: accounts[0].email, envKey: accounts[0].envKey },
      { code: 'UAT-B', label: '我的门店工单', title: '我的门店工单', email: accounts[1].email, envKey: accounts[1].envKey },
      { code: 'UAT-HQ', label: '全量工单', title: '全量工单', email: accounts[2].email, envKey: accounts[2].envKey },
    ];

    for (const p of pages) {
      const pwd = envValue(p.envKey);
      if (!pwd) { warn(`${p.code} 口令缺失，跳过界面预演`); continue; }

      const schemaUid = psqlScalar(
        `SELECT "schemaUid" FROM "desktopRoutes" WHERE type = 'flowPage' AND title = '${p.title}' LIMIT 1`,
      );
      if (!schemaUid) {
        bad(`${p.code} 找不到「${p.title}」页面（desktopRoutes 无 type=flowPage 的同名行）—— 走查会打不开`);
        continue;
      }

      const r = renderProbe(chrome, p.email, pwd, `/admin/${schemaUid}`);
      if (r.probeBroken) {
        // 探针自身坏了：这**不能**算产品缺陷，也不能算通过（铁律 4 / 铁律 25）
        warn(`${p.code} 界面预演**探针自身失败**，本轮这一层没验到：${r.why}`);
        pageButtons.set(p.code, { title: p.title, btns: [] });
        pageDrawers.set(p.code, { clicked: 'PROBE_BROKEN' });
        continue;
      } else if (!r.ok) {
        bad(`${p.code} 打开「${p.title}」未渲染出表格（tables=${r.tables} rows=${r.rows}${r.is404 ? ' · 404' : ''}）—— 真人会看到空白页`);
      } else if (r.rows === 0) {
        // 表格在但没数据行：可能是数据范围问题，也可能是本店确实没有工单
        warn(`${p.code} 「${p.title}」表格已渲染但**数据行 0 条** —— 请确认该账号当刻应有工单`);
      } else {
        ok(`${p.code} 「${p.title}」表格渲染正常：${r.rows} 行 · 可见 ${r.tickets.length} 个工单号`);
      }
      // 把行内按钮文字记下来，供 3.6 段核对"自定义动作真的挂上去了"。
      pageButtons.set(p.code, { title: p.title, btns: r.tableBtns ?? [] });
      // 顺带记下详情抽屉的渲染快照（3.7 段用）
      pageDrawers.set(p.code, r.drawer ?? { clicked: 'SKIPPED' });
    }
  }
}

// 3.6) **H3/H6 页面动作实例已挂载** —— 真人到场前的硬闸门
// ---------------------------------------------------------------------------
// 为什么单列一段（Phase 4-I 首轮走查 BLOCKED 的直接教训）：
//   首轮走查三个角色都只能"看"、不能"受理/派工"。根因不是 ACL 也不是服务层，
//   而是**自定义 ActionModel 只是"在客户端插件里注册了"，从来没被挂到页面实例上**。
//   也就是说「ActionModel 已注册」被当成了「Action 已挂到页面」。
//   这一段的作用：**不让"按钮到底有没有"全部留给真人去发现。**
//
// ⚠️ 判据分两层，缺一不可：
//   ① 数据层：`flowModels` 里每张工单表都要有 5 个自定义动作实例（读真实库，不读源码）
//   ② 渲染层：页面上**真的出现了**"受理 / 派工"这些文字
//   只做 ① 会漏掉 `{values:{…}}` 双包装那种"行在库里、页面不渲染"的情形（DEV-69）。
console.log('\n【3.6 H3/H6 页面动作实例（自定义按钮是否真的挂上去了）】');
{
  const EXPECTED = ['详情', '受理', '派工', '改派', '改约'];
  // ---- 渲染层 ----
  for (const [code, info] of pageButtons) {
    const btns = info.btns.map((b) => b.replace(/\s+/g, ''));
    const found = EXPECTED.filter((e) => btns.some((b) => b.includes(e)));
    const missing = EXPECTED.filter((e) => !found.includes(e));
    if (missing.length === 0) {
      ok(`${code} 「${info.title}」页面上出现全部 ${EXPECTED.length} 个自定义按钮（${EXPECTED.join(' / ')}）`);
    } else {
      bad(
        `${code} 「${info.title}」页面上**缺少自定义按钮：${missing.join('、')}**` +
          `（实际可见：${btns.join(' | ') || '无'}）—— 真人将无法执行受理/派工`,
      );
    }
  }
  if (pageButtons.size === 0) {
    warn('未取得任何页面按钮快照（Chrome 不可用或账号口令缺失）—— **走查前必须手工确认按钮存在**');
  }

  // ---- 数据层：直查 flowModels，逐表核对 ----
  try {
    const row = psqlScalar(
      `SELECT count(*) FROM "flowModels" WHERE options::text LIKE '%Ticket%ActionModel%'`,
    );
    const n = Number(row || '0');
    if (n >= EXPECTED.length) {
      ok(`flowModels 里自定义动作实例共 ${n} 行`);
    } else {
      bad(`flowModels 里自定义动作实例只有 ${n} 行（至少应有 5）—— 播种没跑或没生效`);
    }
    // 顶层 use 的完整性：一行里没有 '"use":"TicketXXXActionModel"' 原文的，就是病态行
    const malformed = Number(
      psqlScalar(
        `SELECT count(*) FROM "flowModels" WHERE options::text LIKE '%Ticket%ActionModel%' AND options::text NOT LIKE '%"use":"Ticket%ActionModel"%'`,
      ) || '0',
    );
    if (malformed === 0) {
      ok('所有自定义动作行的顶层 use 都正确（页面可解析）');
    } else {
      bad(`有 ${malformed} 行自定义动作**顶层没有正确的 use** —— 客户端解析不出，页面不会渲染这些按钮`);
    }
  } catch (e) {
    warn(`无法直查 flowModels 核对动作实例：${e.message}`);
  }
}

// 3.7) **详情抽屉（H3）点开之后到底行不行** —— 呈现层哨兵
// ---------------------------------------------------------------------------
// 为什么单列一段（Phase 4-I 第二轮整改后新增）：
//   抽屉是**客户端自渲染**的（DEV-53 坑 1：服务工单页面不能挂 blueprint 弹窗）。
//   于是它落在了一个"三层断言都够不着"的位置：
//     · 接口断言只能证明 /api/svc:timeline 有数据；
//     · 结构断言只能证明 TicketDetailActionModel 实例挂对了；
//     · **没有任何断言能证明"点开之后里面有东西"** —— 直到真人点了一下。
//   本段补上这一层：无头浏览器真的点一次**行内**「详情」。
//
// ⚠️⚠️ 判据必须**同时**有两层（第三轮走查用一整轮时间换来的教训）：
//   ① 渲染层：抽屉里出现三个区块标题；
//   ② 网络层：点击确实引发了 `svc:timeline` + `svc:visits`，且**都是 2xx**。
//
//   早先只有 ①，并把这一段叫"真实渲染闸门" —— 那个名字**是过度承诺**：
//   它没有看过任何一条 HTTP 请求，因此**回答不了"浏览器实际打的是哪个 URL"**。
//   而第三轮整轮的成本恰恰都花在猜这件事上（人工猜 `/api` 前缀、机器只回读文字，
//   两边都拿不出对方能反驳的证据）。
//   ⇒ 名字改成如实描述；判据里补上 ②，并把"实际 URL + 状态码"直接打进日志。
//
// ⚠️ 判据分层（避免把"环境原因"误判成"产品缺陷"）：
//   · clicked=NO_ROW/NO_BTN（该页没有可点的行/按钮）→ 注意，且**明确不计入通过**
//   · clicked=CLICKED 但抽屉没开 / 缺区块 / 请求没发或非 2xx → **真红灯**
console.log('\n【3.7 H3 详情抽屉（点一次行内「详情」：渲染文字 + 真实网络状态码）】');
{
  const WANT = ['客户与问题', '当前服务', '处理记录'];
  let verified = 0;
  if (pageDrawers.size === 0) {
    warn('未取得任何抽屉快照（Chrome 不可用或账号口令缺失）—— **这一层本轮等于没验**，走查前必须手工点一次「详情」');
  }
  for (const [code, d] of pageDrawers) {
    const title = pageButtons.get(code)?.title ?? code;
    if (d.clicked !== 'CLICKED') {
      // ⚠️「没点到」**不等于通过**（铁律 25）：必须单独说清"这一条没验"，别让注意被读成绿。
      warn(`${code} 「${title}」未点到行内「详情」（${d.clicked}）—— 该页可能没有数据行；**这一条不计入通过**`);
      continue;
    }
    verified++;

    const missing = WANT.filter((w) => !(d.sections ?? []).includes(w));

    // ---- 网络层判据（本轮新增，DEV-74）--------------------------------------
    // 为什么文字不够：它回答不了**"浏览器实际打的是哪个 URL"**。
    // Phase 4-I 第三轮整轮的成本都花在猜这件事上（人猜 `/api` 前缀、
    // 机器只回读文字），所以现在把"真实请求 + 状态码"钉成判据本身。
    const reqs = d.reqs ?? [];
    const tl = reqs.find((r) => String(r.url).indexOf('svc:timeline') !== -1);
    const vs = reqs.find((r) => String(r.url).indexOf('svc:visits') !== -1);
    const ok2xx = (r) => typeof r?.status === 'number' && r.status >= 200 && r.status < 300;

    const problems = [];
    if (!d.open) problems.push('抽屉没有出现');
    if (missing.length > 0) problems.push(`缺少区块：${missing.join('、')}`);
    if (!tl) problems.push('**没有发出 svc:timeline 请求**');
    else if (!ok2xx(tl)) problems.push(`svc:timeline 返回 ${tl.status}`);
    if (!vs) problems.push('**没有发出 svc:visits 请求**');
    else if (!ok2xx(vs)) problems.push(`svc:visits 返回 ${vs.status}`);

    if (problems.length > 0) {
      bad(`${code} 「${title}」详情抽屉不达标：${problems.join('；')} —— 真人点开就会卡住`);
      if (reqs.length === 0) console.log('        · （点击后**一条 svc: 请求都没抓到**）');
      for (const r of reqs) console.log(`        · ${r.status}  ${r.url}`);
      if (d.text) console.log(`        抽屉文字前 160 字：${String(d.text).slice(0, 160)}`);
    } else {
      ok(
        `${code} 「${title}」详情达标：行内「详情」→ svc:timeline ${tl.status} / svc:visits ${vs.status}` +
          ` → 三区块齐全（${WANT.join(' / ')}）`,
      );
    }
  }
  if (verified === 0 && pageDrawers.size > 0) {
    warn('本轮**没有任何账号真正点开过抽屉** —— 这一层等于没验，别当成通过');
  }
}

// 3.8) **产物交付链** —— "代码改对了" ≠ "浏览器拿得到"
// ---------------------------------------------------------------------------
// 为什么单列一段（Phase 4-I 第三轮"详情 404"的最终结论）：
//   那一轮的僵局是「自动化全绿 + 真人仍 404」。根因不在请求 URL（那是旧的、已修的），
//   而在**另一端**：nginx 对 `/static/plugins/` 发 7 天长缓存，而插件产物 URL
//   **不含内容哈希** → 浏览器在 7 天内根本不会回源，于是一直跑旧产物。
//   → 这解释了"为什么只有真人看得见"：探针每次都开全新 profile（空缓存），
//     永远拿最新产物；真人用持久 profile，被缓存粘住。
//   所以"代码层/结构层/呈现层都绿"仍然可以整体为假 —— 必须再钉一层**交付链**。
console.log('\n【3.8 产物交付链（服务端发的 == 刚构建的 · 浏览器不会被旧缓存粘住）】');
{
  // 判据的**唯一事实来源**是 scripts/verify-bundle-delivery.mjs（可单独跑、可单独反向验证）。
  // 这里只做编排：把它输出原样带出来，并按退出码翻译成本段的结论。
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/verify-bundle-delivery.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trimEnd();
    for (const line of out.split('\n')) if (line.trim()) console.log(line);
    if (r.status === 0) {
      // 脚本自己已经打印了逐条 ✅，这里不再重复一遍 ok()
    } else if (r.status === 2) {
      warn('产物交付链**未验到**（环境未就绪：产物没构建 / 服务不可达）—— 这不代表达标');
    } else {
      bad('产物交付链**不合格**：见上面 ❌ 行（"代码改对了"不等于"浏览器拿得到"）');
    }
  } catch (e) {
    warn(`产物交付链断言无法执行：${e.message}`);
  }
}

console.log('\n【3.9 短链与环境基址（短信里那条链接，真的能到本系统吗）】');
{
  // Phase 5 P5-0 的第三件事：**`PUBLIC_BASE_URL` 只做静态一致性是不够的**。
  // `verify-config.mjs` 能证明"两个数字相等、没有尾部斜杠"，但证明不了
  // **这个基址背后就是本系统** —— 基址指向本机 80 上另一个项目时，静态检查全绿，
  // 而短信链接会把师傅送到别人的系统里，且"Token 生成成功、短信发送成功"一切正常。
  //
  // 判据的唯一事实来源是 `scripts/verify-technician-routing.mjs`（可单独跑、可 `--reverse`）。
  // 它做两件必须真发请求才能回答的事：
  //   ① `{PUBLIC_BASE_URL}/t/<43位token>` 必须回 **302 + Location=/h5/technician/visit/<同一token>**
  //      （不是 301，也不是绝对地址 —— 绝对地址会被 Host 头带跑）；
  //   ② `/api/technician/visits/<随机token>` 必须回 **401 + code=TOKEN_INVALID**，
  //      而**不是** NocoBase 的 404 —— 404 说明请求压根没进我们的代码（DEV-18 同型）。
  // 这里只做编排：原样带出它的输出，按退出码翻译成本段结论。
  try {
    const r = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts/verify-technician-routing.mjs')],
      { cwd: ROOT, encoding: 'utf8', timeout: 120000 },
    );
    const out = `${r.stdout || ''}${r.stderr || ''}`.trimEnd();
    for (const line of out.split('\n')) if (line.trim()) console.log(line);
    if (r.status === 0) {
      // 脚本自己已打印逐条 ✅，这里不重复
    } else if (r.status === 2) {
      warn(
        '短链/基址闸门**未验到**（环境未就绪：nginx 不可达 / PUBLIC_BASE_URL 不可达）—— ' +
          '这不代表达标，走查前请先解决',
      );
    } else {
      bad(
        '短链或师傅接口路由**不合格**：见上面 ❌ 行 —— ' +
          '短信里的链接可能送不到本系统，或师傅接口根本没进我们的 handler',
      );
    }
  } catch (e) {
    warn(`短链/基址闸门无法执行：${e.message}`);
  }
}

// 4) 明确划出"只能由真人回答"的部分
console.log('\n【以下内容脚本无法判定 —— 必须由真人走查给出】');
// ⚠️ 2026-09-23 第一~三轮：复核方明确"不重新完整走 8 步"，首轮已由真人证明的结论**保留不重验**。
// ⚠️ 2026-09-23 **第四轮（当前）**：只复测「详情」一条。
//    上面 §3.7 / §3.8 只能证明"机器点开有数据、且浏览器拿得到最新产物"；
//    "**人**能不能看懂"仍然只能由人回答 —— 这正是本轮唯一需要真人的地方。
const manual = [
  '【0 走查前自证 · 必做】真人按 Ctrl+Shift+R 强制刷新一次，并在 Console 里核对那行 ' +
    '`[service-ticket] 客户端产物构建 …` 与本轮【3.8】打印的标记**一致**；' +
    '不一致（或压根没这行）⇒ **别测**，先查缓存/产物（DEV-74）',
  '【本轮唯一判定项】打开 FW20260922-0059 的详情抽屉，能否**快速自行回答**：' +
    '① 现在谁在处理？ ② 预计哪天上门？ ③ 之前发生了什么（受理→派工→改派→改约）',
  '【前置操作 · 不作为判定】受理 → 派给王师傅（门店自修）→ 改派李师傅（填原因）→ ' +
    '把预计上门日期改到后天（三轮已 PASS；**只在出现新阻塞时才记红灯**）',
];
for (const m of manual) console.log(`  □  ${m}`);
console.log('  —— 沿用前三轮结论（本轮不重验；若观察到问题，立即升级为本轮必查）——');
const carriedOver = [
  '门店隔离：A 只见 S01 / B 只见 S02 / HQ 见两店；工单号搜索可用',
  '改派原因不丢（第三轮 PASS）· 预计上门只到天、界面不出现内部固定时刻（第三轮 PASS）',
  '自动生成的「编辑 / 删除」未误导真人（第一轮结论 → UX backlog）',
];
for (const m of carriedOver) console.log(`  ·  ${m}`);

// ---------------------------------------------------------------------------

console.log('\n' + '═'.repeat(66));
if (failures.length) {
  console.log(`  前哨结果：❌ ${failures.length} 项阻塞 —— **先修，别让真人白跑**`);
  for (const f of failures) console.log(`     · ${f}`);
} else if (blockers.length) {
  console.log(`  前哨结果：🟡 ${passed} 项就绪，${blockers.length} 项需注意（不一定是缺陷）`);
  for (const b of blockers) console.log(`     · ${b}`);
} else {
  console.log(`  前哨结果：✅ ${passed} 项全部就绪 —— 可以安排真人走查`);
}
console.log(`  环境事实已固定：${ticket ? `工单 ${ticket.ticketNo}（id=${ticket.id}）` : '（无 UAT 工单）'} · commit ${(() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '(未知)';
  }
})()}`);
console.log('═'.repeat(66) + '\n');

process.exit(failures.length ? 1 : 0);
