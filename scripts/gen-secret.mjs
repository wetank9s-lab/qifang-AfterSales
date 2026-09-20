#!/usr/bin/env node
/**
 * =============================================================================
 *  gen-secret.mjs —— 从 .env.example 生成带真实随机密钥的 .env
 * -----------------------------------------------------------------------------
 *  用法：
 *    node scripts/gen-secret.mjs              # 生成 .env（已存在则拒绝覆盖）
 *    node scripts/gen-secret.mjs --force      # 覆盖已存在的 .env
 *    node scripts/gen-secret.mjs --out .env.local
 *    node scripts/gen-secret.mjs --stdout     # 只打印，不写文件
 *
 *  做了什么：
 *    1. 读取 .env.example（模板）
 *    2. 替换所有 CHANGE_ME__* 占位符为密码学安全随机值
 *    3. 保证 DB_PASSWORD 与 POSTGRES_PASSWORD 取值一致（否则容器首次初始化
 *       的密码与应用连接串不匹配，启动即失败）
 *    4. 保留模板中的中文注释与空行（便于后续人工查阅）
 *
 *  安全说明：
 *    - 使用 node:crypto 的 randomBytes，非 Math.random
 *    - .env 已在 .gitignore 中，脚本会做一次自检并警告
 *    - 生成的密钥只写入本机文件，不通过网络传输
 * =============================================================================
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ------------------------------------------------------------------ CLI 参数 --
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const getOpt = (name, def) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};

const FORCE = hasFlag('--force');
const STDOUT_ONLY = hasFlag('--stdout');
const TEMPLATE = path.resolve(ROOT, getOpt('--template', '.env.example'));
const OUT_FILE = path.resolve(ROOT, getOpt('--out', '.env'));

// -------------------------------------------------------------- 随机值生成器 --
/** 字母数字串（避免出现 + / = 等在 shell / URL 中需转义或易混淆的字符） */
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * 生成 n 位随机串。
 * 用拒绝采样消除取模偏置（alphabet 长度 57 与 256 不成整除关系）。
 */
function randStr(n) {
  const max = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = '';
  while (out.length < n) {
    const buf = randomBytes(n * 2);
    for (const b of buf) {
      if (b >= max) continue; // 丢弃偏置区
      out += ALPHABET[b % ALPHABET.length];
      if (out.length === n) break;
    }
  }
  return out;
}

const randHex = (bytes) => randomBytes(bytes).toString('hex');

// --------------------------------------------------------------- 占位符映射 --
// key: 环境变量名；value: 生成函数
// 注意：DB_PASSWORD 与 POSTGRES_PASSWORD 共用同一实例（下方 special-case 处理）
const GENERATORS = {
  APP_KEY: () => randStr(64),
  SIGN_SECRET: () => randStr(64),
  MOCK_SMS_CALLBACK_SECRET: () => randStr(32),
  BACKUP_PASSPHRASE: () => randStr(32),
};

// 一次性生成，保证同一变量在文件中出现多次时取值一致
const generated = {};
for (const [k, fn] of Object.entries(GENERATORS)) generated[k] = fn();

// DB 口令：只生成一次，两处复用
const dbPassword = randStr(40);
generated.DB_PASSWORD = dbPassword;
generated.POSTGRES_PASSWORD = dbPassword;

// 是否所有占位符都被覆盖（用于自检告警）
const COVERED = new Set(Object.keys(generated));

// ------------------------------------------------------------------- 主流程 --
function main() {
  if (!fs.existsSync(TEMPLATE)) {
    fail(`模板文件不存在：${TEMPLATE}`);
  }

  if (!STDOUT_ONLY && !FORCE && fs.existsSync(OUT_FILE)) {
    fail(
      `${path.relative(ROOT, OUT_FILE)} 已存在，拒绝覆盖（防止把线上密钥冲掉）。\n` +
        `     如确认要重新生成，请加 --force`,
    );
  }

  const src = fs.readFileSync(TEMPLATE, 'utf8');
  const lines = src.split(/\r?\n/);

  const replaced = new Set();
  const unknownPlaceholders = [];
  const outLines = lines.map((line) => {
    // 只处理「KEY=VALUE」形式的赋值行（忽略纯注释行）
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) return line;

    const [, key, rawValue] = m;
    if (!rawValue.includes('CHANGE_ME')) return line;

    if (Object.prototype.hasOwnProperty.call(generated, key)) {
      replaced.add(key);
      return `${key}=${generated[key]}`;
    }

    // 模板里出现了新的 CHANGE_ME 变量但生成器没覆盖它 —— 登记，稍后告警
    unknownPlaceholders.push(key);
    return `${key}=${randStr(32)}`; // 兜底：也给一个随机值，避免留合法占位符
  });

  if (!replaced.size) {
    fail(
      '模板中没有找到任何 CHANGE_ME 占位符，可能模板已被改动。请检查 ' +
        path.relative(ROOT, TEMPLATE),
    );
    return;
  }

  const content = outLines.join('\n');

  if (STDOUT_ONLY) {
    process.stdout.write(content);
    return;
  }

  fs.writeFileSync(OUT_FILE, content, { encoding: 'utf8', mode: 0o600 });

  // ------------------------------------------------------------ 输出摘要 --
  const rel = path.relative(ROOT, OUT_FILE);
  console.log('');
  console.log('  ✅ 已生成 ' + rel);
  console.log('');
  console.log('     已填充的密钥变量：');
  for (const k of [...replaced].sort()) {
    const v = generated[k] ?? '';
    console.log(`       • ${k.padEnd(26)} ${mask(v)}`);
  }
  if (unknownPlaceholders.length) {
    console.log('');
    console.log('     ⚠️  模板中存在生成器未登记的占位符（已用随机值兜底，请核对用途）：');
    for (const k of unknownPlaceholders) console.log(`       • ${k}`);
  }

  // DB 口令一致性提示（最容易踩的坑）
  console.log('');
  console.log('     DB_PASSWORD 与 POSTGRES_PASSWORD 已设为同一值（保持一致）。');

  // .gitignore 自检
  console.log('');
  const gi = path.resolve(ROOT, '.gitignore');
  let ignored = false;
  if (fs.existsSync(gi)) {
    const g = fs.readFileSync(gi, 'utf8');
    ignored = g.split(/\r?\n/).some((l) => {
      const t = l.trim();
      return t === '.env' || t === '.env*' || t === '/.env' || t === '*.env';
    });
  }
  if (ignored) {
    console.log('     🔒 .gitignore 已包含 .env，不会被提交');
  } else {
    console.log('     ⚠️  .gitignore 未明确忽略 .env —— 提交前请确认！');
  }

  console.log('');
  console.log('  下一步：');
  console.log('     docker compose up -d');
  console.log('');
  console.log('  提示：如需接入真实短信，请在 .env 中设置 SMS_PROVIDER / SMS_ENABLED');
  console.log('        并补齐对应服务商的 AccessKey 与模板 CODE。');
  console.log('');
}

function mask(v) {
  if (v == null || v === '') return '(空)';
  if (v.length <= 8) return v[0] + '***';
  return `${v.slice(0, 4)}…${v.slice(-4)}  (${v.length} 位)`;
}

function fail(msg) {
  console.error('');
  console.error('  ❌ ' + msg);
  console.error('');
  process.exit(1);
}

main();
