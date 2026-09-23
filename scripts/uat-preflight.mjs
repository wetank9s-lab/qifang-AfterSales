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
import { execFileSync } from 'node:child_process';
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
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    // ⚠️ CDP 错误必须抛出，不能静默 resolve(undefined)（DEV-66）
    if (m.error) p.rej(new Error(m.method + ': ' + m.error.message)); else p.res(m.result);
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
const drawer = { clicked: 'SKIPPED', open: false, sections: [], text: '' };
if (s.rows > 0) {
  const clicked = await ctx('Runtime.evaluate', {
    expression: \`(() => {
      const btns = [...document.querySelectorAll('.ant-table button, .ant-table a')];
      const b = btns.find((x) => ((x.innerText || '').trim()) === '详情');
      if (!b) return 'NOT_FOUND';
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

try { ws.close(); } catch {}
bail({ ok: s.tables > 0 && s.rows > 0, tables: s.tables, rows: s.rows, tickets: s.tickets, tableBtns: s.tableBtns, is404: s.is404, drawer: drawer });
`;

  // 保留生成脚本便于排错（DEBUG_RENDER=1 时落盘），否则用完即删
  const tmp = process.env.DEBUG_RENDER
    ? path.join(ROOT, '.probe-render-debug.mjs')
    : path.join(ROOT, `.probe-render-${Date.now()}-${Math.floor(Math.random() * 1000)}.mjs`);
  try {
    fs.writeFileSync(tmp, script);
    const out = execFileSync(process.execPath, [tmp], { encoding: 'utf8', timeout: 180000 });
    const line = out.split('\n').find((l) => l.startsWith('RENDER|'));
    if (!line) return { ok: false, tables: 0, rows: 0, tickets: [], tableBtns: [], is404: false, why: '探针无输出' };
    return JSON.parse(line.slice('RENDER|'.length));
  } catch (e) {
    return { ok: false, tables: 0, rows: 0, tickets: [], tableBtns: [], is404: false, why: `探针异常：${e.message}` };
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
      `（本轮走查结束应变为 Visit 2 条 · 事件 ≥6 条；改派必须留下 SUPERSEDED 的历史行）`,
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
      if (!r.ok) {
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

// 3.7) **详情抽屉（H3）真的渲染了吗** —— 呈现层哨兵
// ---------------------------------------------------------------------------
// 为什么单列一段（Phase 4-I 第二轮整改后新增）：
//   抽屉是**客户端自渲染**的（DEV-53 坑 1：服务工单页面不能挂 blueprint 弹窗）。
//   于是它落在了一个"三层断言都够不着"的位置：
//     · 接口断言只能证明 /api/svc:timeline 有数据；
//     · 结构断言只能证明 TicketDetailActionModel 实例挂对了；
//     · **没有任何断言能证明"点开之后里面有东西"** —— 直到真人点了一下。
//   本段补上这一层：无头浏览器真的点一次「详情」，把抽屉里的文字读回来，
//   核对整改后的四区块标题（客户与问题 / 当前服务 / 处理记录）是否都在。
//
// ⚠️ 判据分层（避免把"环境原因"误判成"产品缺陷"）：
//   · clicked=SKIPPED/NOT_FOUND（该页没有可点的行）→ 注意，不算阻塞
//   · clicked=CLICKED 但抽屉没开 / 缺区块      → **真红灯**（这就是产品缺陷）
console.log('\n【3.7 H3 详情抽屉真实渲染（点一次「详情」并回读文字）】');
{
  const WANT = ['客户与问题', '当前服务', '处理记录'];
  if (pageDrawers.size === 0) {
    warn('未取得任何抽屉快照（Chrome 不可用或账号口令缺失）—— **走查前必须手工点一次「详情」**');
  }
  for (const [code, d] of pageDrawers) {
    const title = pageButtons.get(code)?.title ?? code;
    if (d.clicked !== 'CLICKED') {
      warn(`${code} 「${title}」未点到「详情」（${d.clicked}）—— 该页可能没有数据行，无法预演抽屉`);
      continue;
    }
    const missing = WANT.filter((w) => !(d.sections ?? []).includes(w));
    if (!d.open) {
      bad(`${code} 「${title}」点了「详情」但**抽屉没有出现** —— 真人第一步就会卡住`);
    } else if (missing.length > 0) {
      bad(
        `${code} 「${title}」抽屉已打开但**缺少区块：${missing.join('、')}** —— ` +
          `整改后的四区块叙事没渲染出来（抽屉内容前 120 字：${String(d.text ?? '').slice(0, 120)}）`,
      );
    } else {
      ok(`${code} 「${title}」详情抽屉渲染正常，三个区块标题齐全（${WANT.join(' / ')}）`);
    }
  }
}

// 4) 明确划出"只能由真人回答"的部分
console.log('\n【以下内容脚本无法判定 —— 必须由真人走查给出】');
// ⚠️ 2026-09-23 第三轮：复核方明确"不重新完整走 8 步"。
//    首轮已由真人证明的结论（A 只见 S01 / B 只见 S02 / HQ 见两店 / 工单号搜索 /
//    对象级越权 404）**保留不重验**；本轮只验三项整改 + 一次收尾提问。
const manual = [
  '第 1 步：能否**自己找到**「受理」并完成；点完页面是否真的变成「处理中」（不需要额外的成功提示）',
  '第 2 步：派工弹窗里，上门字段是否显示为**「预计上门日期」**且是**日期选择**（不要求填时分、也不能出现时分）',
  '第 3 步（**本轮重点**）：改派给李师傅并**填写改派原因** ⇒ 是否**一次成功**（上一轮这里 FAIL：填了原因却被判 MISSING_REASON）',
  '第 4 步（**本轮重点**）：改约——同样是日期选择；改完业务含义是否清楚（"改到哪一天"而不是"改到几点"）',
  '第 5 步（**本轮重点**）：打开详情抽屉，能否**快速回答**：现在谁处理？哪天上门？之前发生了什么？',
  '第 6 步：详情抽屉里有没有**同一件事说两遍**（旧的"派工历史表 + 事件时间线"并列已被移除，应只剩一条「处理记录」）',
  '第 7 步：状态文案是否一眼看懂（例：Visit 的 SUBMITTED 现在显示「待门店确认」而不是「师傅已提交」）',
  '收尾提问（逐字记录）："如果明天再来一张工单，你知道应该从哪里开始处理吗？"',
  '观察项 ①（重点，仍不预提示）：自动生成的「编辑 / 删除」按钮是否让真人**误以为是正常售后操作**，点进去才看到 403',
  '观察项 ②：时间线里出现的英文枚举 / 内部编号（ticket_id、visit_id、token hash 之类）—— 一个都不该看到',
];
for (const m of manual) console.log(`  □  ${m}`);

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
