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
 *   node scripts/uat-accounts.mjs --create     # 建 4 个临时账号（幂等：已存在则只补映射）
 *   node scripts/uat-accounts.mjs --create --reset-password   # 强制重置口令（旧口令丢失时用）
 *   node scripts/uat-accounts.mjs --list       # 只看现状，不做任何写操作
 *   node scripts/uat-accounts.mjs --disable    # 停用（走查后默认）：撤角色/撤映射/重置口令，保留行
 *   node scripts/uat-accounts.mjs --delete     # 物理删除（有历史引用时拒绝，需 --force）
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
const ADMIN_PASSWORD = envValue('SMOKE_ADMIN_PASSWORD', '');

/** .env 里 UAT 账号的键名 —— 口令只存这里（.env 已被忽略） */
const ENV_KEYS = {
  'uat.store.a@svc.local': 'UAT_STORE_A_PASSWORD',
  'uat.store.b@svc.local': 'UAT_STORE_B_PASSWORD',
  'uat.hq@svc.local': 'UAT_HQ_PASSWORD',
  'uat.viewer@svc.local': 'UAT_VIEWER_PASSWORD',
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
  {
    key: 'V',
    code: 'UAT-V',
    email: 'uat.viewer@svc.local',
    username: 'uat_viewer',
    nickname: 'UAT-V',
    role: 'viewer',
    storeCode: null,
    storeLabel: '只读管理层（不写 storeUsers —— 与总部同口径，范围由角色决定）',
    purpose:
      '只读账号（P6-1 门禁 C3 需要它）：能登录、能看到全量工单，但**任何写动作都必须 403**。' +
      '没有它时"只读角色写不进去"只能靠读代码推断 —— 那正是本项目反复吃亏的形状。',
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

/**
 * 找账号 id —— 三种形态都要能命中：
 *   ① 未停用：按原邮箱；
 *   ② 已停用：邮箱被改成 `revoked+<id>@invalid.local`，改按**规格里的 username**（或加 `.revoked` 后缀）查。
 *
 * ⚠️ 两个坑都踩过：
 *   · **不能用 `??`**：`userIdOf()` 查不到返回**数字 0**，而 `??` 只在 null/undefined 才走右边，
 *     `0 ?? x` 求值为 0 → 兜底永不生效（表现为"停用后的账号被误判成不存在，跳过"）。
 *   · **不能用 `email.split('@')[0]` 当 username**：邮箱前缀是 `uat.store.a`（点），
 *     而 username 是 `uat_store_a`（下划线）——两者不同，用邮箱前缀去查永远查不到。
 *     必须用规格里显式声明的 `acct.username`。
 */
function resolveUserId(acct) {
  const byEmail = psqlScalar(`SELECT id FROM users WHERE email = '${acct.email}'`);
  if (byEmail) return Number(byEmail);
  const byName = psqlScalar(
    `SELECT id FROM users WHERE username = '${acct.username}' OR username = '${acct.username}.revoked' LIMIT 1`,
  );
  return byName ? Number(byName) : 0;
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

    let userId = resolveUserId(acct);
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
    // 兜底查找：账号被停用后邮箱已改，仍应显示为"已停用"而不是"未创建"。
    const userId = resolveUserId(acct);
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
    const restricted = psqlScalar(
      `SELECT coalesce(uat_restricted_at::text, '') FROM users WHERE id = ${userId}`,
    );
    const flag = restricted ? ' 🚫已停用' : '';
    console.log(`  ✅ ${acct.code.padEnd(8)} #${userId} 角色=${roles || '(无)'} 门店=${stores}${flag}`);
  }
  console.log('');
}

/**
 * UAT 正式清理方式 —— **停用**，而不是物理删除。
 *
 * 为什么默认不是 `--delete`（复核方 2026-09-22 裁定）：
 *   走查结束后 UAT-A 往往已经是主工单的 `handler_user_id`，`ticket_events.operator_user_id`
 *   也指向它（受理 / 派工 / 改派 / 改约每条事件都记了操作者）。
 *   而 UAT 工单是**要保留的验收证据**。此时物理删除用户行，会把工单与事件的
 *   操作者引用清成空引用 —— 证据"还在"，但**失去了可解释性**（谁受理的？谁派的工？
 *   查不出来）。所以默认清理只做"让人无法继续用"，不破坏历史引用的可追溯性。
 *
 * 本项 NocoBase 的 `users` 表**没有**可用的禁用字段（实测 \d users 无 disabled/enabled），
 * 因此按复核方给的降级口径执行：
 *   ① 删除 storeUsers 临时门店映射
 *   ② 撤销业务角色（rolesUsers）
 *   ③ 重置成不可知随机口令
 *   ④ 追加三道具名化阻断（用户名 / 邮箱 / nickname 改成 revoked 形态 + 追加 `restrict` 列标记）
 *   ⑤ **保留 users 行本身**（工单与事件的历史引用继续指向它）
 *
 * 幂等：重复执行不会报错，也不会把已改名的账号再改一次。
 */
function disableAccounts() {
  console.log('\n【停用】临时 UAT 账号（撤角色 + 撤门店映射 + 重置口令；**保留 users 行**）');

  // restrict 标记列：本项目 users 表无禁用字段，用它记录"此账号已作停用处理"，
  // 供后续判别（也存在的情况下幂等跳过改名）。
  psql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS uat_restricted_at timestamptz`);

  let disabled = 0;
  for (const acct of UAT_ACCOUNTS) {
    // 先按原邮箱，再按用户名前缀兜底（停用后邮箱被改）。
    // ⚠️ 用 `||` 不用 `??`：userIdOf 查不到返回数字 0，`0 ?? x` 求值为 0，兜底会失效。
    const userId = resolveUserId(acct);
    if (!userId) {
      console.log(`  ·  ${acct.code} 不存在，跳过`);
      continue;
    }

    // ── 引用计数：停用**不该**破坏这些引用，但要让操作者知道它们的存在
    const handlerTickets = psqlScalar(
      `SELECT count(*) FROM service_tickets WHERE handler_user_id = ${userId}`,
    );
    const events = psqlScalar(
      `SELECT count(*) FROM ticket_events WHERE operator_user_id = ${userId}`,
    );

    // ① 撤门店映射
    psql(`DELETE FROM store_users WHERE user_id = ${userId}`);
    // ② 撤业务角色
    psql(`DELETE FROM "rolesUsers" WHERE "userId" = ${userId}`);
    // ③ 重置成不可知随机口令
    const scrambled = crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex');
    psql(`UPDATE users SET password = '${scrambled}' WHERE id = ${userId}`);
    // ④ 阻断登录入口：改名 / 改邮箱（唯一约束保证不冲突），并打标记
    const already = psqlScalar(
      `SELECT coalesce(uat_restricted_at::text, '') FROM users WHERE id = ${userId}`,
    );
    if (already === '') {
      psql(
        `UPDATE users SET username = username || '.revoked', email = 'revoked+' || id || '@invalid.local', ` +
          `nickname = nickname || '(已停用)', uat_restricted_at = now() WHERE id = ${userId}`,
      );
    }

    const left = psqlScalar(`SELECT count(*) FROM "rolesUsers" WHERE "userId" = ${userId}`);
    const mapping = psqlScalar(`SELECT count(*) FROM store_users WHERE user_id = ${userId}`);

    if (left === '0' && mapping === '0') {
      ok(
        `${acct.code}（#${userId}）已停用 —— 角色=0 · 门店映射=0 · 口令已重置 · 行保留` +
          `（历史引用：工单 ${handlerTickets} 张 / 事件 ${events} 条仍指向它）`,
      );
      disabled += 1;
    } else {
      note(`${acct.code}（#${userId}）停用不彻底：角色剩 ${left} 条 / 门店映射剩 ${mapping} 条`);
    }
  }

  console.log(
    `\n  共停用 ${disabled} 个账号。` +
      `\n  ⚠️ 账号**仍在库里**（历史工单/事件引用可解释），但已无法登录、无角色、无门店范围。` +
      `\n  真正需要清库时，先确认工单与事件引用后再执行 --delete。\n`,
  );
}

/**
 * 物理删除 —— **默认不要用**。走查后的正式清理请用 `--disable`。
 *
 * 只有确认用户名下**没有任何历史引用**（工单 handler / 事件 operator）时才允许物理删除。
 * 带引用强行删除会把验收证据的操作者引用清成空引用（见 disableAccounts 的说明）。
 * 脚手架本身也据此设了闸：有引用时默认**拒绝**，除非显式 `--force`。
 */
function deleteAccounts({ force = false } = {}) {
  console.log('\n回收临时 UAT 账号（账号 + storeUsers 映射 + 角色绑定）');
  let removed = 0;
  let blocked = 0;
  for (const acct of UAT_ACCOUNTS) {
    // 同上：`||` 而非 `??`，否则停用后的账号会被误判成"不存在"。
    const userId = resolveUserId(acct);
    if (!userId) {
      console.log(`  ·  ${acct.code} 不存在，跳过`);
      continue;
    }
    const handlerTickets = psqlScalar(
      `SELECT count(*) FROM service_tickets WHERE handler_user_id = ${userId}`,
    );
    const events = psqlScalar(
      `SELECT count(*) FROM ticket_events WHERE operator_user_id = ${userId}`,
    );

    // 有历史引用 → 默认拒绝物理删除（会破坏验收证据的可解释性）
    if ((handlerTickets !== '0' || events !== '0') && !force) {
      note(
        `${acct.code}（#${userId}）仍有历史引用（工单 ${handlerTickets} 张 / 事件 ${events} 条）—— ` +
          `**拒绝物理删除**。走查后请改用 --disable（保留 users 行）。`,
      );
      blocked += 1;
      continue;
    }

    psql(`DELETE FROM store_users WHERE user_id = ${userId}`);
    psql(`DELETE FROM "rolesUsers" WHERE "userId" = ${userId}`);
    psql(`DELETE FROM users WHERE id = ${userId}`);
    ok(`已删除 ${acct.code}（#${userId}）及其映射与角色绑定`);
    removed += 1;
  }
  console.log(`\n  共回收 ${removed} 个账号${blocked ? `，${blocked} 个因仍有历史引用被拒绝` : ''}。`);
  if (blocked) {
    console.log('  ⚠️ 被拒绝的账号请用 --disable 处理；若确需物理删除，先归档工单证据再 --delete --force。');
  }
  console.log('  ⚠️ .env 里的 UAT_*_PASSWORD 已失效，可手工删除（不影响任何功能）。\n');
  return blocked;
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

if (has('--disable')) {
  if (!dockerAvailable()) die('docker 不可用 —— 环境未就绪', 2);
  const blocked = disableAccounts();
  process.exit(blocked ? 1 : 0);
}

if (has('--delete')) {
  if (!dockerAvailable()) die('docker 不可用 —— 环境未就绪', 2);
  const blocked = deleteAccounts({ force: has('--force') });
  process.exit(blocked ? 1 : 0);
}

if (has('--create')) {
  await createAccounts({ resetPassword: has('--reset-password') });
  if (has('--bootstrap-uat-ticket')) {
    // 两店各造一张：走查第 7 步要证明"总部能同时看到门店 A、B 的数据"，
    // 而门店 B 一条工单都没有时这条**恒真**（测了等于没测）。
    await bootstrapUatTicket('S01');
    await bootstrapUatTicket('S02');
    // 第三张：专用「门店自修 inhouse」专项。
    // 复核方 2026-09-22 指出：主工单**一张只做一次首次派工**，因为第一次派工成功后
    // 工单已 PROCESSING 且 Visit #1 ASSIGNED，再 dispatch 应当被状态机拒绝 ——
    // 想真人看 inhouse 界面必须换一张草稿工单，不能在主工单上连派两次。
    if (has('--bootstrap-inhouse-ticket')) await bootstrapUatTicket('S01');
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
                                                            建账号 + 造 UAT 工单（S01 + S02 各一张）
  node scripts/uat-accounts.mjs --create --bootstrap-uat-ticket --bootstrap-inhouse-ticket
                                                            再补一张 S01 工单（专供「门店自修」专项）
  node scripts/uat-accounts.mjs --create --reset-password   强制重置口令
  node scripts/uat-accounts.mjs --list                      查看现状
  node scripts/uat-accounts.mjs --disable                   停用临时账号（走查后**默认用这个**）
  node scripts/uat-accounts.mjs --delete                    物理删除（有历史引用时会被拒绝）
  node scripts/uat-accounts.mjs --delete --force            无视历史引用强行物理删除

⚠️ 走查后优先用 --disable 而不是 --delete：
   UAT 工单是要保留的验收证据，而 UAT-A 常已是工单 handler / 事件 operator。
   物理删除用户行会让这些引用变成空引用 —— 证据"还在"但说不清是谁做的。
   停用 = 撤角色 + 撤门店映射 + 重置口令 + 阻断登录，但**保留 users 行**。
   （NocoBase 的 users 表无禁用字段，故按复核方降级口径处理。）

⚠️ 口令只写入本机 .env（已忽略）与 stdout，**不要**提交进仓库或粘进验收报告。
`);
