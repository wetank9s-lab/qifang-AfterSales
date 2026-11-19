/**
 * arc-dev-admin-restore.mjs —— 恢复**本地开发环境** admin 登录
 *
 * 前置（必须按顺序）：
 *   ① 已跑 `arc-dev-isolation-proof.mjs` 并留档（证明目标是开发库）
 *   ② 本脚本先**备份** users 认证字段到本地文件，再写入新口令
 *
 * 约束（用户 2026-11-10 指令）：
 *   · 仅开发环境；不重装应用、不重建数据库、不跑全量 seed；
 *   · 备份认证数据后再改；
 *   · 口令**不打印到 stdout**、不写入 git 跟踪的文件。
 *
 * 做法：只改 `users.password` 一个字段（scrypt，与 NocoBase 同算法），
 *      其余字段（email/username/role 关联）一概不动 —— 这是最小改动，
 *      也让回滚只需要把备份的哈希写回去。
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BACKUP_DIR = '.tmp-verify';
const CRED_FILE = path.join(BACKUP_DIR, 'admin-credential-dev.txt');

function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

/** NocoBase 口令格式：salt(16 hex) + scrypt(password, salt, 24) 的 hex */
function hashPassword(plain) {
  const salt = crypto.randomBytes(8).toString('hex');
  return salt + crypto.scryptSync(plain, salt, 24).toString('hex');
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ---- ① 备份 ----
const row = psql(`SELECT id || '|' || email || '|' || username || '|' || password FROM users WHERE id = 1;`);
const [id, email, username, passwordHash] = row.split('|');
if (!id) {
  console.error('找不到 id=1 的用户，终止');
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(BACKUP_DIR, `admin-auth-backup-${stamp}.txt`);
fs.writeFileSync(
  backupFile,
  [
    '# ARC-V1 本地开发环境 admin 认证字段备份（重置口令之前）',
    `# 时间：${new Date().toISOString()}`,
    `id=${id}`,
    `email=${email}`,
    `username=${username}`,
    `password_hash=${passwordHash}`,
    '',
    '# 回滚方式（把哈希写回即可，无需改其它字段）：',
    `# UPDATE users SET password='${passwordHash}' WHERE id=${id};`,
  ].join('\n') + '\n',
  'utf8',
);
console.log(`已备份原哈希 → ${backupFile}`);
console.log(`（哈希长度 ${passwordHash.length}，前 6 位 ${passwordHash.slice(0, 6)}…）`);

// ---- ② 生成临时口令 ----
// 只用于本地开发环境；不含歧义字符（l/I/1/o/O/0），便于手输
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const pick = () => {
  const buf = crypto.randomBytes(14);
  let s = '';
  for (const b of buf) s += ALPHABET[b % ALPHABET.length];
  return s;
};
const placeholder = '# 占位';  // 防止忘了改
const password = pick().slice(0, 10) + '-' + pick().slice(0, 6);

// ---- ③ 写入 ----
psql(`UPDATE users SET password = '${hashPassword(password)}', "updatedAt" = now() WHERE id = 1;`);

// ---- ④ 自证：新哈希能被校验通过（不依赖应用，纯算法核对） ----
const stored = psql('SELECT password FROM users WHERE id = 1;');
const salt = stored.slice(0, 16);
const ok = stored.length === 64 && crypto.scryptSync(password, salt, 24).toString('hex') === stored.slice(16);
console.log(`哈希自证：${ok ? 'PASS（新口令可校验通过）' : 'FAIL'}`);

fs.writeFileSync(
  CRED_FILE,
  [
    '# ARC-V1 本地开发环境 admin 临时口令',
    `# 生成时间：${new Date().toISOString()}`,
    '# ⚠️ 仅本地开发库（svc-postgres / service_ticket / APP_ENV=development）',
    '# ⚠️ 不入 git、不进日志、不进交付报告；不需要时删掉本文件',
    `email: ${email}`,
    `username: ${username}`,
    `password: ${password}`,
    '',
    `# 回滚原口令：见 ${path.basename(backupFile)}`,
  ].join('\n') + '\n',
  'utf8',
);
console.log(`临时口令已写入 ${CRED_FILE}（未打印到 stdout）`);
console.log(`账号：${email}`);

if (!ok) process.exit(1);
