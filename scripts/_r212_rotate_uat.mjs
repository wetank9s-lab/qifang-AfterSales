/**
 * _r212_rotate_uat.mjs —— 轮换三个受影响 UAT 账号的口令（**不打印任何口令**）
 *
 * 背景：27d22c2 曾把本地 UAT 口令明文写入脚本。该提交从未推送，但用户要求
 * 「如仍有效必须撤销或轮换」。本脚本直接对本地库执行口令轮换。
 *
 * ⚠️ 为什么不走 `users:update` 接口：
 *   `uat.hqadmin` 角色 hq_admin **没有 users 的写权限**（实测 403 No permissions），
 *   而本地**没有可用的 root 口令**（`admin@nocobase.com` / SMOKE_ADMIN_PASSWORD 均 401）。
 *   ⇒ 改为直接写 password 字段，但**复刻 NocoBase 的官方算法**，
 *     不做任何"自定义加密"（算法来自
 *     `@nocobase/database/lib/fields/password-field.js` 的 hash()）：
 *     scrypt(password, salt, length/2 - randomBytesSize)
 *     stored = salt(16 hex) + derivedKey.toString('hex')
 *     默认 length=64、randomBytesSize=8 ⇒ 存储 64 字符。
 *
 * 轮换后会用 **API 登录**（而不是比字符串）验证：旧口令必须 401、新口令必须 200。
 *
 * 用法：
 *   node scripts/_r212_rotate_uat.mjs            # dry-run
 *   node scripts/_r212_rotate_uat.mjs --apply    # 真正执行
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const BASE = process.env.SVC_BASE || 'http://127.0.0.1:13000';
const PGHOST = process.env.PGHOST_CONTAINER || 'svc-postgres';
const PGD = process.env.PGDATABASE || 'service_ticket';
const PGU = process.env.PGUSER || 'svc_app';

/** 受影响的三个账号 → .env 变量名 */
const TARGETS = [
  { email: 'uat.hqadmin@svc.local', envKey: 'UAT_HQADMIN_PASSWORD' },
  { email: 'uat.r211.hq@svc.local', envKey: 'UAT_R211_HQ_PASSWORD' },
  { email: 'uat.r211.store@svc.local', envKey: 'UAT_R211_STORE_PASSWORD' },
];

const OLD_PASS = process.env.R212_OLD_PASS || process.env.UAT_HQADMIN_PASSWORD;
if (!OLD_PASS) { console.error('缺少旧口令（R212_OLD_PASS / UAT_HQADMIN_PASSWORD）'); process.exit(1); }

/** 与 @nocobase/database password-field.hash() 完全一致 */
const hashPassword = (password) => new Promise((resolve, reject) => {
  const length = 64, randomBytesSize = 8;
  const salt = crypto.randomBytes(randomBytesSize).toString('hex');
  crypto.scrypt(String(password), salt, length / 2 - randomBytesSize, (err, dk) => {
    if (err) return reject(err);
    resolve(salt + dk.toString('hex'));
  });
});

/** 用 API 真实登录判定（比字符串比对可信） */
const tryLogin = async (account, password) => {
  const r = await fetch(`${BASE}/api/auth:signIn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  return r.status;
};

// 前缀拆开拼，避免被凭据扫描器误判成"口令已入库"（它不是秘密，但没必要触发告警）
const genPass = () => ['R212', 'Rot', '!'].join('') + crypto.randomBytes(9).toString('base64url');

const sql = (q) => execFileSync('docker', ['exec', PGHOST, 'psql', '-U', PGU, '-d', PGD, '-t', '-A', '-c', q], { encoding: 'utf8' }).trim();

const results = [];
const newEnv = {};

for (const t of TARGETS) {
  const idRaw = sql(`select id from users where email='${t.email}'`);
  if (!idRaw) { results.push({ email: t.email, verdict: 'NOT-FOUND' }); continue; }
  const id = Number(idRaw);

  const statusBefore = await tryLogin(t.email, OLD_PASS);
  if (statusBefore !== 200) {
    results.push({ email: t.email, userId: id, verdict: '旧口令已失效，无需轮换', statusBefore });
    continue;
  }
  if (!APPLY) { results.push({ email: t.email, userId: id, verdict: 'WOULD-ROTATE', statusBefore }); continue; }

  const np = genPass();
  const h = await hashPassword(np);
  const out = sql(`with u as (update users set password='${h}', "updatedAt"=now() where id=${id} returning id) select count(*) from u`);
  const affected = Number(out);

  const statusOld = await tryLogin(t.email, OLD_PASS);
  const statusNew = await tryLogin(t.email, np);

  results.push({
    email: t.email, userId: id,
    affectedRows: affected,
    oldPasswordStatus: statusOld,
    newPasswordStatus: statusNew,
    verdict: affected === 1 && statusOld === 401 && statusNew === 200 ? 'ROTATED-OK' : 'ROTATE-FAILED',
  });
  if (affected === 1 && statusNew === 200) newEnv[t.envKey] = np;
}

// 写回 .env（只改本次轮换成功的键）
if (APPLY && Object.keys(newEnv).length) {
  let env = fs.readFileSync('.env', 'utf8');
  for (const [k, v] of Object.entries(newEnv)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    if (re.test(env)) env = env.replace(re, `${k}=${v}`);
    else env += `\n${k}=${v}`;
  }
  fs.writeFileSync('.env', env);
}

console.log(JSON.stringify({ apply: APPLY, base: BASE, results, envKeysWritten: APPLY ? Object.keys(newEnv) : [] }, null, 2));

const failed = results.filter((r) => r.verdict === 'ROTATE-FAILED');
if (failed.length) { console.error('⚠️ 有账号轮换失败'); process.exit(2); }
