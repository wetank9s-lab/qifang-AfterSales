/**
 * Phase 4-I 真人走查（UAT）账号开通 / 回收
 *
 * 为什么要有这个脚本（而不是"验收时手工在后台点几个用户"）：
 *   ① I 需要**两家门店**各一个账号才能证伪"看不到别家工单"——
 *      只有一个账号时"门店隔离"这条恒真（测了等于没测）；
 *   ② 账号的**角色**与 **storeUsers 门店映射**必须是同一份数据的两半。
 *      手工建号最容易漏掉 storeUsers，现象是"登录进去了，但一张工单都看不到"，
 *      很容易被误判成权限 bug 或页面 bug，白白烧掉真人走查的时间；
 *   ③ 走查结束要能**干净回收**。临时账号留在系统里，下一轮验收就分不清
 *      "这是临时账号还是真售后人员"。
 *
 * ⚠️ 口令安全（用户 2026-09-21 裁定）：
 *   · 口令**由本脚本随机生成**，不写死在代码里、不进 Git；
 *   · 只落到两个地方：本机 `.env`（已在 .gitignore 里）与 stdout（给走查人当面取用）；
 *   · 公开验收报告里只写"门店售后人员 UAT-A / 门店 S01"，**不写真实姓名**。
 *
 * 用法：
 *   node scripts/uat-accounts.mjs --create     # 建 3 个临时账号（幂等：已存在则只补映射）
 *   node scripts/uat-accounts.mjs --create --reset-password   # 强制重置口令（旧口令丢失时用）
 *   node scripts/uat-accounts.mjs --list       # 只看现状，不做任何写操作
 *   node scripts/uat-accounts.mjs --delete     # 回收：删账号 + 关联行
 *   node scripts/uat-accounts.mjs --bootstrap-uat-ticket   # 造一张 UAT 用的 NEW 工单（走真实匿名接口）
 *
 * 退出码：0 成功 / 1 失败 / 2 环境未就绪（容器或接口没起来）
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

// ------------------------------------------------------------------ 环境与工具

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

function envValue(key, fallback = '') {
  if (!fs.existsSync(ENV_PATH)) return fallback;
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(fs.readFileSync(ENV_PATH, 'utf8'));
  return m ? m[1].trim() : fallback;
}

const PORT = envValue('NGINX_HTTP_PORT', '8080');
const BASE_URL = `http://localhost:${PORT}`;
const ADMIN_EMAIL = envValue('SMOKE_ADMIN_EMAIL', 'admin@nocobase.com');
const ADMIN_PASSWORD = envValue('SMOKE_ADMIN_PASSWORD', 'admin123');

/** .env 里 UAT 账号的键名 —— 口令只存这里（.env 已被忽略） */
const ENV_KEYS = {
  'uat.store.a@svc.local': 'UAT_STORE_A_PASSWORD',
  'uat.store.b@svc.local': 'UAT_STORE_B_PASSWORD',
  'uat.hq@svc.local': 'UAT_HQ_PASSWORD',
};

let passed = 0;
const failures = [];
const notes = [];

function ok(message) {
  passed += 1;
  console.log(`  ✅ ${message}`);
}

function note(message) {
  notes.push(message);
  console.log(`  ·  ${message}`);
}

function die(message, code = 1) {
  console.error(`\n  ❌ ${message}\n`);
  process.exit(code);
}

function dockerAvailable() {
  try {
    execFileSync('docker', ['exec', 'svc-postgres', 'true'], {
      stdio: 'ignore',
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** 执行 SQL（不取回值） */
function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8' },
  );
}

/** 执行 SQL 并取单值（-tA：去表头、去对齐） */
function psqlScalar(sql) {
  return execFileSync(
    'docker',
    ['exec', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

async function http(url, init) {
  try {
    const res = await fetch(url, init);
    const body = await res.text();
    return { status: res.status, body };
  } catch (error) {
    return { status: 0, body: String(error?.message ?? error) };
  }
}

// ------------------------------------------------------------------ 账号规格

/**
 * 三个临时账号 —— 角色与门店映射是这份规格的两半，不允许分开手工写。
 *
 * `UAT-A` / `UAT-B` 是**对外可公开的代号**（写进验收报告用），
 * `nickname` 也刻意用代号而不是真人姓名：后台列表里显示的是 nickname，
 * 若写真人姓名，它会随截图/导出一起流出去。
 */
const UAT_ACCOUNTS = [
  {
    key: 'A',
    code: 'UAT-A',
    email: 'uat.store.a@svc.local',
    username: 'uat_store_a',
    nickname: 'UAT-A',
    role: 'store_after_sales',
    storeCode: 'S01',
    storeLabel: '门店 A（S01）',
    purpose: '主走查账号：登录只应看到「我的门店工单」，看不到「全量工单」',
  },
  {
    key: 'B',
    code: 'UAT-B',
    email: 'uat.store.b@svc.local',
    username: 'uat_store_b',
    nickname: 'UAT-B',
    role: 'store_after_sales',
    storeCode: 'S02',
    storeLabel: '门店 B（S02）',
    purpose: '反证账号：既不应看到门店 A 的工单，也不应能凭直链打开门店 A 的详情',
  },
  {
    key: 'HQ',
    code: 'UAT-HQ',
    email: 'uat.hq@svc.local',
    username: 'uat_hq',
    nickname: 'UAT-HQ',
    role: 'hq_after_sales',
    storeCode: null,
    storeLabel: '总部（不写 storeUsers —— 写错就等于给总部人员锁上了门店范围）',
    purpose: '范围账号：只应有「全量工单」入口，且能看到门店 A 与门店 B 两条数据',
  },
];

async function adminToken() {
  const r = await http(`${BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (r.status !== 200) {
    die(
      `管理员登录失败（HTTP ${r.status}）。容器可能还没起来，或 .env 里的 SMOKE_ADMIN_PASSWORD 已变更。\n` +
        `    原文：${r.body.slice(0, 200)}`,
      2,
    );
  }
  return JSON.parse(r.body).data.token;
}

async function signIn(email, password) {
  const r = await http(`${BASE_URL}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return r.status === 200 ? JSON.parse(r.body).data.token : null;
}

// ------------------------------------------------------------------ .env 读写

/** 写/更新一个键（保留其余内容与注释） */
function writeEnvKey(key, value) {
  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) text = text.replace(re, line);
  else {
    if (!text.endsWith('\n')) text += '\n';
    text += `\n# ── Phase 4-I UAT 临时账号（口令自动生成，**不要提交**；走查结束用 --delete 回收）──\n${line}\n`;
  }
  fs.writeFileSync(ENV_PATH, text, 'utf8');
}

function readEnvKey(key) {
  return envValue(key, '');
}

/**
 * 生成口令：**必须满足 NocoBase 的密码策略**（默认 ≥8 位且含大小写/数字/符号之一的组合）。
 * 用 base64url 自己拼：既避开易混淆字符，也保证一定含数字与非字母。
 */
function randomPassword() {
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digit = '23456789';
  const symbol = '!@#%^&*-_=+';
  const all = lower + upper + digit + symbol;
  const pick = (set) => set[crypto.randomInt(0, set.length)];
  let out = pick(lower) + pick(upper) + pick(digit) + pick(symbol);
  for (let i = 0; i < 12; i += 1) out += pick(all);
  return out;
}

// ------------------------------------------------------------------ 动作实现

function storeIdOf(code) {
  const id = psqlScalar(`SELECT id FROM stores WHERE code = '${code}'`);
  return id ? Number(id) : 0;
}

function userIdOf(email) {
  const id = psqlScalar(`SELECT id FROM users WHERE email = '${email}'`);
  return id ? Number(id) : 0;
}

async function createAccounts({ resetPassword }) {
  console.log('\n【1】环境检查');
  if (!dockerAvailable()) die('docker 或 svc-postgres 容器不可用 —— 环境未就绪', 2);

  // 门店必须先存在：账号好建，门店是种子数据，建错门店映射指向一个不存在的 store_id
  const storeIds = { S01: storeIdOf('S01'), S02: storeIdOf('S02') };
  if (!storeIds.S01 || !storeIds.S02) {
    die('S01 / S02 两家门店必须都存在（只有一家时"看不到别家工单"恒真）', 2);
  }
  ok(`门店就绪：S01=#${storeIds.S01} · S02=#${storeIds.S02}`);

  const token = await adminToken();
  ok(`管理员登录成功（${ADMIN_EMAIL}）`);

  console.log('\n【2】建立临时账号（口令随机生成，只落 .env）');
  const issued = [];

  for (const acct of UAT_ACCOUNTS) {
    const envKey = ENV_KEYS[acct.email];
    let password = resetPassword ? '' : readEnvKey(envKey);
    if (!password) password = randomPassword();

    let userId = userIdOf(acct.email);
    const existed = Boolean(userId);

    if (!existed) {
      const r = await http(`${BASE_URL}/api/users:create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          email: acct.email,
          username: acct.username,
          nickname: acct.nickname,
          password,
          roles: [{ name: acct.role }],
        }),
      });
      if (r.status !== 200) {
        die(`建账号 ${acct.email} 失败：HTTP ${r.status} ${r.body.slice(0, 300)}`);
      }
      userId = Number(JSON.parse(r.body).data.id);
      ok(`新建 ${acct.code}（#${userId}，角色 ${acct.role}）—— ${acct.purpose}`);
    } else {
      ok(`${acct.code} 已存在（#${userId}），跳过创建`);
      if (resetPassword) {
        const r = await http(`${BASE_URL}/api/users:update?filterByTk=${userId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ password }),
        });
        if (r.status !== 200) die(`重置 ${acct.email} 口令失败：HTTP ${r.status} ${r.body.slice(0, 200)}`);
        ok(`已重置 ${acct.code} 口令（--reset-password）`);
      }
    }

    // ⚠️ users:create 的 `roles` 只对**新建**可靠；已存在的账号要显式核一遍角色
    const hasRole = psqlScalar(
      `SELECT count(*) FROM "rolesUsers" WHERE "userId" = ${userId} AND "roleName" = '${acct.role}'`,
    );
    if (hasRole === '0') {
      psql(
        `INSERT INTO "rolesUsers" ("userId", "roleName", created_at, updated_at) ` +
          `VALUES (${userId}, '${acct.role}', now(), now()) ON CONFLICT DO NOTHING`,
      );
      ok(`补授角色 ${acct.role} → ${acct.code}（此前缺失）`);
    }

    // 门店映射：总部账号**必须不写** —— 写了就等于给总部人员锁上门店范围
    if (acct.storeCode) {
      const storeId = storeIds[acct.storeCode];
      const mapped = psqlScalar(
        `SELECT count(*) FROM store_users WHERE user_id = ${userId} AND store_id = ${storeId}`,
      );
      if (mapped === '0') {
        psql(
          `INSERT INTO store_users (user_id, store_id, created_at, updated_at) ` +
            `VALUES (${userId}, ${storeId}, now(), now())`,
        );
        ok(`建立门店映射 ${acct.storeCode} → ${acct.code}`);
      } else {
        ok(`门店映射已存在 ${acct.storeCode} → ${acct.code}`);
      }
    } else {
      const cnt = psqlScalar(`SELECT count(*) FROM store_users WHERE user_id = ${userId}`);
      if (cnt !== '0') {
        psql(`DELETE FROM store_users WHERE user_id = ${userId}`);
        note(`${acct.code} 是总部账号，却存在 ${cnt} 条 storeUsers 映射 —— 已清除（否则它的数据范围会被缩小到这些门店）`);
      }
    }

    writeEnvKey(envKey, password);
    issued.push({ ...acct, userId, password, existed });
  }

  console.log('\n【3】验证：每个账号都能用**新口令**真实登录，且角色生效');
  for (const acct of issued) {
    const t = await signIn(acct.email, acct.password);
    if (!t) die(`${acct.code}（${acct.email}）登录失败 —— 口令或账号状态有问题，真人走到浏览器前才发现就晚了`);
    ok(`${acct.code} 登录成功`);
  }

  console.log('\n' + '─'.repeat(66));
  console.log('  交付给走查人的账号（口令仅此处与 .env，切勿粘进 Git / 报告 / 聊天记录）');
  console.log('─'.repeat(66));
  for (const acct of issued) {
    console.log(`  ${acct.code.padEnd(8)} ${acct.email.padEnd(26)} ${acct.password}   ${acct.storeLabel}`);
  }
  console.log('─'.repeat(66));

  return issued;
}

function listAccounts() {
  console.log('\n临时 UAT 账号现状：');
  for (const acct of UAT_ACCOUNTS) {
    const userId = userIdOf(acct.email);
    if (!userId) {
      console.log(`  ⬜ ${acct.code.padEnd(8)} 未创建`);
      continue;
    }
    const roles = psqlScalar(
      `SELECT string_agg("roleName", ',') FROM "rolesUsers" WHERE "userId" = ${userId}`,
    );
    const stores = psqlScalar(
      `SELECT coalesce(string_agg(s.code, ','), '(无)') FROM store_users su JOIN stores s ON s.id = su.store_id WHERE su.user_id = ${userId}`,
    );
    console.log(`  ✅ ${acct.code.padEnd(8)} #${userId} 角色=${roles || '(无)'} 门店=${stores}`);
  }
  console.log('');
}

function deleteAccounts() {
  console.log('\n回收临时 UAT 账号（账号 + storeUsers 映射 + 角色绑定）');
  let removed = 0;
  for (const acct of UAT_ACCOUNTS) {
    const userId = userIdOf(acct.email);
    if (!userId) {
      console.log(`  ·  ${acct.code} 不存在，跳过`);
      continue;
    }
    const tickets = psqlScalar(
      `SELECT count(*) FROM service_tickets WHERE handler_user_id = ${userId}`,
    );
    if (tickets !== '0') {
      note(`${acct.code} 名下挂着 ${tickets} 张工单（handler_user_id）—— 这些工单的归属会变成空引用，请确认这是走查产物`);
    }
    psql(`DELETE FROM store_users WHERE user_id = ${userId}`);
    psql(`DELETE FROM "rolesUsers" WHERE "userId" = ${userId}`);
    psql(`DELETE FROM users WHERE id = ${userId}`);
    ok(`已删除 ${acct.code}（#${userId}）及其映射与角色绑定`);
    removed += 1;
  }
  console.log(`\n  共回收 ${removed} 个账号。\n  ⚠️ .env 里的 UAT_*_PASSWORD 已失效，可手工删除（不影响任何功能）。\n`);
}

/**
 * 造一张 UAT 工单 —— **必须走真实匿名接口**，不能直接 INSERT。
 *
 * 直接 INSERT 会漏掉取号、事件、幂等记录等真实链路产物，
 * 于是真人走查测的是一张"数据库里长得像工单的东西"，
 * 而受理/派工依赖的状态与事件可能对不上（表现是"点受理报错"，
 * 但根因在夹具而不在产品）。走接口就绕开了这个问题。
 */
async function bootstrapUatTicket(storeCode = 'S01') {
  const nonce = String(Date.now()).slice(-6);
  const mobile = `13${String(crypto.randomInt(100000000, 999999999)).slice(0, 9)}`;

  console.log(`\n【4】造一张 UAT 工单（门店 ${storeCode}，走真实匿名接口 /api/public/tickets）`);

  const body = {
    store_code: storeCode,
    source: 'qr',
    ticket_type: 'repair',
    content: `UAT 走查专用工单 ${nonce}：冰箱不制冷，压缩机有异响`,
    customer_name: 'UAT 客户',
    customer_mobile: mobile,
    privacy_agreed: true,
  };

  const r = await http(`${BASE_URL}/api/public/tickets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });

  if (r.status !== 201 && r.status !== 200) {
    die(`建 UAT 工单失败：HTTP ${r.status} ${r.body.slice(0, 300)}`);
  }

  const data = JSON.parse(r.body).data;
  const ticketId = psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no = '${data.ticket_no}'`);
  ok(`UAT 工单已创建：${data.ticket_no}（id=${ticketId}，门店 ${storeCode}，状态应为 NEW）`);

  const status = psqlScalar(`SELECT status FROM service_tickets WHERE id = ${ticketId}`);
  ok(`库内状态 = ${status}（走查第 2 步要求它从 NEW 开始）`);

  console.log('\n' + '─'.repeat(66));
  console.log('  交给走查人的工单信息（可写进验收报告，不含客户真实信息）');
  console.log('─'.repeat(66));
  console.log(`  工单号   ${data.ticket_no}`);
  console.log(`  门店     ${storeCode}`);
  console.log(`  说明     这是一张专门为 UAT 创建的报修单，客户信息为虚构`);
  console.log('─'.repeat(66) + '\n');
  return ticketId;
}

// ------------------------------------------------------------------ 主流程

console.log('\n══ Phase 4-I UAT 账号管理 ══');

if (has('--list')) {
  if (!dockerAvailable()) die('docker 不可用 —— 环境未就绪', 2);
  listAccounts();
  process.exit(0);
}

if (has('--delete')) {
  if (!dockerAvailable()) die('docker 不可用 —— 环境未就绪', 2);
  deleteAccounts();
  process.exit(0);
}

if (has('--create')) {
  await createAccounts({ resetPassword: has('--reset-password') });
  if (has('--bootstrap-uat-ticket')) {
    // 两店各造一张：走查第 7 步要证明"总部能同时看到门店 A、B 的数据"，
    // 而门店 B 一条工单都没有时这条**恒真**（测了等于没测）。
    await bootstrapUatTicket('S01');
    await bootstrapUatTicket('S02');
  }
  console.log(`\n  完成 ${passed} 步。\n`);
  process.exit(failures.length ? 1 : 0);
}

if (has('--bootstrap-uat-ticket')) {
  if (!dockerAvailable()) die('docker 不可用 —— 环境未就绪', 2);
  await bootstrapUatTicket('S01');
  await bootstrapUatTicket('S02');
  process.exit(0);
}

console.log(`
用法：
  node scripts/uat-accounts.mjs --create                    建 3 个临时账号
  node scripts/uat-accounts.mjs --create --bootstrap-uat-ticket
                                                            建账号 + 造一张 UAT 工单
  node scripts/uat-accounts.mjs --create --reset-password   强制重置口令
  node scripts/uat-accounts.mjs --list                      查看现状
  node scripts/uat-accounts.mjs --delete                    回收临时账号

⚠️ 口令只写入本机 .env（已忽略）与 stdout，**不要**提交进仓库或粘进验收报告。
`);
