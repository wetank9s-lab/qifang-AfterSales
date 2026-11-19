/**
 * 迁移目录聚合哈希 —— 跨平台稳定算法
 *
 * 🔴 为什么需要这个文件（2026-11-12 实测）：
 *    `sha256sum` 的输出分隔符**随平台/模式变化**：
 *      · GNU coreutils（Linux / POSIX 模式）：`<hash>  <name>`（两个空格）
 *      · Git Bash（Windows，二进制模式，默认）：`<hash> *<name>`（星号）
 *    于是 `ls | sort | xargs sha256sum | sha256sum` 这条命令
 *    在 Windows 上得 `1c351abc…`、在 Linux 上得 `2c82c48d…` —— **同目录、同内容、不同值**。
 *
 *    S4 的核对是在**生产 Linux 服务器**上跑的，而登记值是在**本机 Windows** 算的
 *    ⇒ 直接用这条命令当判据，生产上必然"哈希不符"，然后人被假红训练成忽略它。
 *    这正是"判据不可复现 ⇒ 判据失效"的典型形态。
 *
 * 本算法只用「文件内容 + 相对路径」，**不依赖任何 sha256sum 的输出格式**：
 *   对每个文件（按相对路径字典序）取 `${sha256(content)}  ${relPath}\n` 拼接后整体 SHA256。
 *  Windows / Linux / Node 三处都得到同一个值。
 *
 * 用法：node scripts/lib/migrations-agg.mjs [目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 递归列普通文件，返回 POSIX 相对路径（升序） */
function listFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(a, r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

/**
 * MIGRATIONS_AGG_V1
 * @param {string} dir 迁移目录（绝对或相对 cwd）
 * @returns {{files:number, aggregate:string, jsOnly:string, jsFiles:number}}
 */
export function migrationsAgg(dir) {
  const files = listFiles(dir);
  const lines = files.map((rel) => `${sha(fs.readFileSync(path.join(dir, rel)))}  ${rel}\n`).join('');
  const js = files.filter((f) => f.endsWith('.js'));
  const jsLines = js.map((rel) => `${sha(fs.readFileSync(path.join(dir, rel)))}  ${rel}\n`).join('');
  return {
    files: files.length,
    aggregate: sha(lines),
    jsFiles: js.length,
    jsOnly: sha(jsLines),
  };
}

// CLI
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
    process.argv[1]?.endsWith('migrations-agg.mjs')) {
  const dir = process.argv[2] || 'storage/plugins/@local/service-ticket/dist/server/migrations';
  const r = migrationsAgg(dir);
  console.log(`目录        : ${dir}`);
  console.log(`文件数      : ${r.files}（其中 .js ${r.jsFiles} 个）`);
  console.log(`MIGRATIONS_AGG_V1（全部文件）: ${r.aggregate}`);
  console.log(`JS_ONLY_AGG_V1（仅 .js）     : ${r.jsOnly}`);
  console.log('');
  console.log('⚠️ 不要把 `ls|sort|xargs sha256sum|sha256sum` 当判据：那是平台相关的（见本文件头）。');
}
