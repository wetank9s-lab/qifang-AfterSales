#!/usr/bin/env node
/**
 * =============================================================================
 *  verify-version-pins-reverse.mjs —— 镜像版本冻结的**反向门**（Phase 10 · §6 #1，P10-B）
 * -----------------------------------------------------------------------------
 *  目的：证明"版本漂移"真的会被拦住，而不是只有一条看起来在比的静态断言。
 *
 *  为什么单独一个脚本（不并入 verify-config-falsegreen-reverse.mjs）：
 *    那个脚本的语义是"#62 三处假绿"，混进来会把两个不同契约搅在一起；
 *    版本冻结是 §6 #1 的独立条目，反向证据也应当能被单独复核。
 *
 *  ⚠️ 覆盖不到的那一半（如实登记，不假装覆盖）：
 *    本脚本只反证**声明侧**（compose 里写的 tag）。"实际在跑的镜像"（smoke 里的
 *    `Config.Image` 断言）无法在本脚本里反证 —— 那需要真的把容器换成别的镜像再起来，
 *    代价远高于收益。它靠的是**静态断言 + 真机断言成对存在**这一结构本身，
 *    以及 smoke 那条断言自身的严格性（逐字比 tag，不比仓库名）。
 *
 *  用法：node scripts/verify-version-pins-reverse.mjs
 *  退出码：0 = 全部反例成立且已干净还原；1 = 有反例不成立/还原失败；2 = 前置条件不成立
 * =============================================================================
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VERIFY_CONFIG = path.join(ROOT, 'scripts', 'verify-config.mjs');
const COMPOSE = path.join(ROOT, 'docker-compose.yml');

const log = (s) => console.log(s);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const runVerifyConfig = () => {
  const r = spawnSync(process.execPath, [VERIFY_CONFIG], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

const baseline = runVerifyConfig();
if (baseline.code !== 0) {
  console.error('✗ 前置条件不成立：verify-config 当前不是全绿，先把它修好再来做反向验证。');
  for (const l of baseline.out.split('\n').slice(-14)) if (l.trim()) console.error('   ' + l);
  process.exit(2);
}
log(`✓ 前置：verify-config 全绿（${/全部通过：(\d+) 项/.exec(baseline.out)?.[1] ?? '?'} 项）`);

/**
 * 每个反例 = 把 compose 里的一个 tag 漂移到"看起来仍然合理"的另一个值。
 *
 * ⚠️ 漂移值的选择有讲究：不能写成明显非法的字符串（那样任何正则都会红，
 *    证明不了"逐字比对"在起作用），要写成**格式完全合法、只是版本不同**的值。
 */
const CASES = [
  {
    name: 'NocoBase 升级：2.2.15 → 2.3.0（-full-no-nginx 变体不变，格式完全合法）',
    from: 'image: nocobase/nocobase:2.2.15-full-no-nginx',
    to: 'image: nocobase/nocobase:2.3.0-full-no-nginx',
    expect: 'app 镜像',
  },
  {
    name: 'PostgreSQL 升级：16 → 17（大版本漂移，备份/恢复假设依赖它）',
    from: 'image: postgres:16',
    to: 'image: postgres:17',
    expect: 'postgres 镜像',
  },
  {
    name: 'nginx 升级：1.27-alpine → 1.29-alpine（公网入口组件，本条是 §6 #1 的重点）',
    from: 'image: nginx:1.27-alpine',
    to: 'image: nginx:1.29-alpine',
    expect: 'nginx 镜像',
  },
  {
    name: 'nginx 退化成浮动 tag：1.27-alpine → alpine（最典型的"顺手改成 latest 线"）',
    from: 'image: nginx:1.27-alpine',
    to: 'image: nginx:alpine',
    expect: 'nginx 镜像',
  },
];

const original = fs.readFileSync(COMPOSE, 'utf8');
const problems = [];
let restoredCleanly = false;

try {
  for (const [i, c] of CASES.entries()) {
    log(`\n══ 反例 ${i + 1}/${CASES.length}：${c.name} ══`);

    if (!original.includes(c.from)) {
      problems.push(`反例「${c.name}」的锚点在当前 compose 里找不到 —— 前置形态变了，请更新本脚本`);
      log('  ⚠️  找不到锚点（跳过）');
      continue;
    }
    const mutated = original.replace(c.from, c.to);
    if (mutated === original) {
      problems.push(`反例「${c.name}」替换后内容未变 —— 用例空跑`);
      log('  ⚠️  替换无效果（跳过）');
      continue;
    }

    fs.writeFileSync(COMPOSE, mutated, 'utf8');
    const r = runVerifyConfig();
    fs.writeFileSync(COMPOSE, original, 'utf8');

    if (r.code === 0) {
      problems.push(`反例「${c.name}」下 verify-config 仍然全绿 —— 版本冻结是**假闸门**`);
      log('  🚨 仍然全绿：版本漂移拦不住');
      continue;
    }
    if (!r.out.includes(c.expect)) {
      problems.push(`反例「${c.name}」确实变红了，但红灯里看不到「${c.expect}」—— 红的可能是别的断言`);
      log(`  🚨 变红了但不是预期的断言（找不到「${c.expect}」）`);
      continue;
    }
    log(`  ✅ 如实变红，且红灯命中预期断言：「${c.expect}」`);
  }
} finally {
  log('\n── 还原 ──');
  if (fs.readFileSync(COMPOSE, 'utf8') !== original) fs.writeFileSync(COMPOSE, original, 'utf8');
  if (sha(COMPOSE) !== crypto.createHash('sha256').update(original).digest('hex')) {
    console.error(`✗ 还原失败（内容与备份不一致）：${path.relative(ROOT, COMPOSE)}`);
  } else {
    log(`  ✅ ${path.relative(ROOT, COMPOSE)} 已按原始内容还原（sha256 逐字节比对一致）`);
    const after = runVerifyConfig();
    if (after.code === 0) {
      log('  ✅ 还原后 verify-config 回到全绿');
      restoredCleanly = true;
    } else {
      console.error('  ✗ 还原后 verify-config 仍不是全绿 —— **请手工检查 docker-compose.yml**');
      for (const l of after.out.split('\n').slice(-14)) if (l.trim()) console.error('     ' + l);
    }
  }
}

if (!restoredCleanly) process.exit(1);
if (problems.length > 0) {
  console.error(`\n❌ 反向验证不成立（${problems.length} 项）：`);
  for (const p of problems) console.error(`   • ${p}`);
  process.exit(1);
}

log(`\n✅ ${CASES.length} 个版本漂移形态全部被拦住，且改动已干净还原。`);
