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

function dockerAvailable() {
  try {
    execFileSync('docker', ['exec', 'svc-postgres', 'true'], { stdio: 'ignore', timeout: 10_000 });
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
  ok(`起始基线：Visit ${visits} 条 · 事件 ${events} 条（走查结束应变为 Visit 2 条 · 事件 ≥4 条）`);
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

// 4) 明确划出"只能由真人回答"的部分
console.log('\n【以下内容脚本无法判定 —— 必须由真人走查给出】');
const manual = [
  '第 1 步：登录后**页面上**是否只出现「我的门店工单」菜单，而看不到「全量工单」',
  '第 2 步：点「受理」后**页面是否真的刷新为 PROCESSING**（而不是弹"成功"但列表没动）',
  '第 3 步：能否**自己找到**「派工」按钮并填出王师傅；「门店自修」与「厂家（填厂家名称）」各试一次；页面是否出现 Visit #1',
  '第 4 步：改派李师傅后，Visit #1 是否**仍然在**且显示 SUPERSEDED，Visit #2 为 ASSIGNED',
  '第 5 步：改约后页面是否仍只有两条 Visit，且预约时间已变',
  '第 6 步：详情抽屉的四块内容（基本信息 / 时效 / Visit 历史 / 事件时间线）**看得懂吗**；事件顺序是否为 受理→派工→改派→改约',
  '第 7 步：切总部账号后，**菜单上**是否只有「全量工单」主入口，且能看到门店 A、B 两店数据',
  '第 8 步：切门店 B 账号后，既看不到门店 A 的工单，也不能通过详情入口打开门店 A 的工单',
  '观察项 ①（重点）：自动生成的「新建 / 编辑 / 删除」按钮是否让真人**误以为是正常售后操作**，点进去才看到 403',
  '观察项 ②：派工成功但短信记 rejected 时，真人**能否察觉**客户其实没收到短信',
  '观察项 ③：6 个状态 Tab 的切法，真人习不习惯；是否有"今日待办"这类诉求（记 Phase 9，本期不做）',
  '观察项 ④：`service_mode` / `provider_name` / `superseded_at` 这些列名，哪几个**必须解释才能看懂**',
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
