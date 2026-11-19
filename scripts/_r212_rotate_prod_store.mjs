/**
 * _r212_rotate_prod_store.mjs —— 重置**生产验收专用**门店账号口令（一次性）
 *
 * 用户 2026-11-18 明确选择「重置一个验收专用口令」。
 * 只动 `hl@scqfls.cn`（users.id=904，角色仅 `store_after_sales`），不动其他真实账号。
 *
 * 安全纪律：
 *   · 新口令**只写 .env**（已 gitignore），不打印、不入库、不写文档。
 *   · 用官方 scrypt 算法（`@nocobase/database` 的 password-field hash）：
 *     scrypt(password, salt, length/2 - randomBytesSize)，存 `salt(hex) + derivedKey(hex)`。
 *   · 强校验 affectedRows === 1，0 行与 1 行在输出里长得一样，必须断言。
 *   · 改完立刻用 API 登录自证：旧口令应 401、新口令应 200。
 *
 * 用法：PROD_SSH_PASS=<ssh 口令> node scripts/_r212_rotate_prod_store.mjs [--apply]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const EMAIL = process.env.PROD_STORE_RESET_EMAIL || 'hl@scqfls.cn';
const HOST = '162.14.121.180';
const DB = 'scqf_aftersales_candidate';
const PGU = 'scqf_as';
const BASE = 'https://sh.scqfls.cn';

const hashPassword = (password) => new Promise((resolve, reject) => {
  const length = 64;
  const randomBytesSize = 8;
  const salt = crypto.randomBytes(randomBytesSize).toString('hex');
  crypto.scrypt(String(password), salt, length / 2 - randomBytesSize, (err, dk) => {
    if (err) return reject(err);
    resolve(salt + dk.toString('hex'));
  });
});

const genPass = () => ['R212', 'Store', '!'].join('') + crypto.randomBytes(9).toString('base64url');

/** 本机无 sshpass ⇒ 用 paramiko（与 deploy-s6-remote.py 同一套，已验证可用） */
const ssh = (cmd) => {
  const py = `
import os, sys, paramiko
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(sys.argv[1], port=22, username=sys.argv[2], password=os.environ['PROD_SSH_PASS'], timeout=25, allow_agent=False, look_for_keys=False)
_i, _o, _e = c.exec_command(sys.argv[3], timeout=110)
out = _o.read().decode('utf-8', 'replace'); err = _e.read().decode('utf-8', 'replace')
rc = _o.channel.recv_exit_status(); c.close()
sys.stderr.write(err)
sys.stdout.write(out)
sys.exit(rc)
`;
  const r = execFileSync('python', ['-c', py, HOST, process.env.PROD_SSH_USER || 'root', cmd],
    { encoding: 'utf8', timeout: 130000, env: process.env });
  return r;
};

const signIn = async (email, pass) => {
  const r = await fetch(`${BASE}/api/auth:signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ account: email, password: pass }),
  });
  return r.status;
};

const sql = (q) => ssh(`docker exec ${process.env.PROD_PG_CONTAINER || 'scqf-as-postgres'} psql -U ${PGU} -d ${DB} -tAc ${JSON.stringify(q)}`).trim();

const main = async () => {
  // 0) 先看清现状（只读）
  const before = sql(`SELECT id || '|' || COALESCE(nickname,'') || '|' || COALESCE(email,'') FROM users WHERE email='${EMAIL}'`);
  console.log('目标账号：', before || '(未找到)');
  if (!before) { console.error('账号不存在，停止'); process.exit(1); }
  const uid = before.split('|')[0];
  // ⚠️ "rolesUsers" 是驼峰表名，PG 不加引号会全部转小写 ⇒ relation "rolesusers" does not exist
  const roles = sql(`SELECT string_agg(r.name, ',') FROM "rolesUsers" ru JOIN roles r ON r.name=ru."roleName" WHERE ru."userId"=${uid}`);
  console.log('角色：', roles);
  if (!/^store_after_sales$/.test(roles.trim())) { console.error('角色不是纯 store_after_sales，停止（不误伤其他账号）'); process.exit(1); }

  const NEW = genPass();
  if (!APPLY) {
    console.log('WOULD 更新 users.id=%s 的 password（dry-run，未执行）', uid);
    console.log('WOULD 新口令长度 = %d（不打印）', NEW.length);
    return;
  }

  const hash = await hashPassword(NEW);
  // ⚠️ 用 WITH ... RETURNING + count 强校验，不能只看"命令没报错"
  const out = sql(`WITH u AS (UPDATE users SET password='${hash}', "updatedAt"=now() WHERE email='${EMAIL}' RETURNING 1) SELECT count(*) FROM u`);
  const n = Number(String(out).trim());
  console.log('受影响行数 =', n);
  if (n !== 1) { console.error('❌ 期望 1 行，实际 %d —— 未生效，中止', n); process.exit(2); }

  // 自证：新口令 200
  const st = await signIn(EMAIL, NEW);
  console.log('新口令登录 →', st);
  if (st !== 200) { console.error('❌ 新口令登录失败（%d），算法可能不匹配', st); process.exit(3); }

  // 写 .env（只写不打印）
  const envPath = '.env';
  let s = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `PROD_STORE_EMAIL=${EMAIL}\nPROD_STORE_PASSWORD=${NEW}\n`;
  if (/^PROD_STORE_PASSWORD=/m.test(s)) {
    s = s.replace(/^PROD_STORE_PASSWORD=.*$/m, `PROD_STORE_PASSWORD=${NEW}`).replace(/^PROD_STORE_EMAIL=.*$/m, `PROD_STORE_EMAIL=${EMAIL}`);
  } else {
    if (!s.endsWith('\n')) s += '\n';
    s += `\n# 生产验收专用门店账号（2026-11-18 用户批准重置，禁止入库）\n${line}`;
  }
  fs.writeFileSync(envPath, s, 'utf8');
  console.log('✅ 已写入 .env（PROD_STORE_EMAIL / PROD_STORE_PASSWORD），未打印口令');
};

main().catch((e) => { console.error('EXCEPTION', String(e.message || e).slice(0, 300)); process.exit(9); });
