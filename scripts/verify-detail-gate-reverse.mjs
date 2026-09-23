#!/usr/bin/env node
/**
 * verify-detail-gate-reverse.mjs —— 详情闸门（preflight §3.7）的**反向验证**
 * =============================================================================
 *
 * 铁律 8：**断言不会变红 = 没有断言。**
 * 本轮把 §3.7 从"只回读抽屉文字"升级成"抓真实网络请求 + 断言 2xx"，
 * 那么必须证明它**真的会红** —— 否则它只是一段好看的日志。
 *
 * 做法：把抽屉请求**临时改回历史缺陷形态**（带 `/api` 前缀，正是 Phase 4-I
 * 第三轮真人 404 的那一版），重建产物后跑真闸门，要求：
 *
 *   ① §3.7 报红，且红灯内容里能看见 `404` 与 `svc:timeline`；
 *   ② 顺手抓下这次 404 的**四要素**（Request URL / Method / Status / Response body），
 *      这就是当初让真人开 DevTools 去抄、而一直没拿到的证据。
 *
 * 跑完**必定还原**（`finally`）并重建产物；还原后再静态校验产物里没有 `/api/svc:`。
 *
 * ⚠️ 只改一个字符级别的替换，且只动一个文件；其余全部只读。
 * ⚠️ 运行期间服务端会短暂提供"坏产物"（约 2~4 分钟）。不要在真人走查时段跑。
 *
 * 退出码：0 = 反向验证成立（如实变红且已还原）；1 = 闸门没红（**假闸门**）；2 = 环境未就绪
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DRAWER = path.join(
  ROOT,
  'nocobase/plugins/service-ticket/src/client/ticket-drawer.tsx',
);
const BUNDLE = path.join(
  ROOT,
  'storage/plugins/@local/service-ticket/dist/client/index.js',
);

/** 历史缺陷形态：抽屉请求带 `/api` 前缀 → 注入的 request 再补一次 → /api/api/… → 404 */
const FIXED = 'const timelineUrl = `svc:timeline?filterByTk=';
const BROKEN = 'const timelineUrl = `/api/svc:timeline?filterByTk=';

const log = (s) => console.log(s);

if (!fs.existsSync(DRAWER)) {
  console.error(`✗ 找不到抽屉源码：${DRAWER}`);
  process.exit(2);
}

const original = fs.readFileSync(DRAWER, 'utf8');

/** 在当前产物里找 `/api/svc:`（0 = 干净） */
const bundleHasApiPrefix = () => {
  if (!fs.existsSync(BUNDLE)) return -1;
  const s = fs.readFileSync(BUNDLE, 'utf8');
  return (s.match(/\/api\/svc:/g) || []).length;
};

function build() {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-plugin.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 跑真闸门，返回完整输出（不论退出码） */
function runPreflight() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/uat-preflight.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 900000,
  });
  return `${r.stdout || ''}\n${r.stderr || ''}`;
}

/** 抓"点一次详情"的真实 404 四要素（复用本轮建好的抓包探针） */
function captureReal404() {
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts/probe-detail-request.mjs'), '--account', 'A'],
    { cwd: ROOT, encoding: 'utf8', timeout: 300000 },
  );
  return `${r.stdout || ''}\n${r.stderr || ''}`;
}

let failed = false;
let restored = false;

try {
  // 前置：起点必须是"干净"的，否则反向验证的结论没有意义
  if (!original.includes(FIXED)) {
    console.error('✗ 源码里找不到预期的（无前缀）抽屉请求 —— 前置条件不成立，中止');
    process.exit(2);
  }

  log('══ 反向验证：把抽屉请求改回历史缺陷形态（带 /api 前缀）══');
  fs.writeFileSync(DRAWER, original.replace(FIXED, BROKEN), 'utf8');
  log('  · 已改源码（1 处）');

  build();
  const badCount = bundleHasApiPrefix();
  log(`  · 产物里 /api/svc: 出现次数：${badCount}（应 > 0，否则"坏产物"没真的构建出来）`);
  if (badCount <= 0) {
    console.error('✗ 坏产物没构建出来 —— 反向验证的前置条件不成立，中止');
    process.exit(2);
  }

  log('\n── 跑真闸门（uat-preflight）──');
  const out = runPreflight();
  fs.writeFileSync(path.join(ROOT, '.probe-reverse-preflight.log'), out, 'utf8');

  // 断言：§3.7 段必须报红，且红灯里能看见 404 与 svc:timeline
  const s37 = out.slice(out.indexOf('【3.7 '));
  const s37only = s37.slice(0, Math.max(0, s37.indexOf('【3.8')));
  const redLine = s37only
    .split('\n')
    .find((l) => l.includes('❌') && l.includes('详情抽屉不达标'));

  log('\n── 闸门输出（§3.7）──');
  for (const l of s37only.split('\n')) if (l.trim()) log('   ' + l.trim());

  if (!redLine) {
    failed = true;
    log('\n🚨 **闸门没有变红** —— 说明 §3.7 的判据是假的（假闸门）');
  } else if (!/404/.test(redLine) || !/svc:timeline/.test(redLine)) {
    failed = true;
    log('\n🚨 闸门红了，但红灯内容里看不到 404 / svc:timeline —— 判据不够精确');
    log(`   ${redLine}`);
  } else {
    log('\n✅ 闸门如实变红，且红灯里带出了真实的 404 与端点名');
  }

  // 顺带把"真人当初开 DevTools 要抄的那四项"抓下来
  log('\n── 抓取这次 404 的四要素（真人当时缺的正是这个）──');
  const cap = captureReal404();
  fs.writeFileSync(path.join(ROOT, '.probe-reverse-404.log'), cap, 'utf8');
  for (const l of cap.split('\n')) {
    if (/🚨|Request|GET |404|body:|timeline|visits/.test(l) && l.trim()) log('   ' + l.trim());
  }
} finally {
  // ⚠️ 无论成败都必须还原并重建 —— 反向验证绝不能把坏代码留在树上（铁律 9）
  if (fs.readFileSync(DRAWER, 'utf8') !== original) {
    fs.writeFileSync(DRAWER, original, 'utf8');
    log('\n── 已还原源码 ──');
  } else {
    log('\n── 源码本来就是原样 ──');
  }
  try {
    build();
    const after = bundleHasApiPrefix();
    log(`  · 还原后产物里 /api/svc: 出现次数：${after}（应为 0）`);
    restored = after === 0;
  } catch (e) {
    console.error(`✗ 还原后重建失败：${e.message} —— **请手工重跑 node scripts/build-plugin.mjs**`);
  }
}

if (!restored) {
  console.error('\n❌ 没有干净地还原到"修复版产物" —— 不要继续走查');
  process.exit(1);
}
if (failed) {
  console.error('\n❌ 反向验证不成立：闸门没能在缺陷态下变红');
  process.exit(1);
}
console.log('\n✅ 反向验证成立：缺陷态下闸门变红，且已还原为修复版产物');
console.log('   （还原后请再跑一次标准入口确认全绿：node scripts/uat-reset-baseline.mjs）');
process.exit(0);
