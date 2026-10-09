#!/usr/bin/env node
/**
 * verify-acl-boundary-reverse.mjs —— **断开 guard 的有效反向验证**（Phase 11 / P11-0 · B-8）
 *
 * ===========================================================================
 * 它证明什么（以及为什么不能只看"断言绿了"）
 * ===========================================================================
 * `probe-native-read-deps.mjs --assert` 会断言 `users:list` / `roles:list` /
 * `collections:list` 对业务角色返回 403。但"断言绿"有两种可能：
 *   ① 边界**真的**在拦；
 *   ② 断言写错了 / 什么都没测到（本项目最忌讳的假绿）。
 *
 * ⇒ 本脚本用**断开 guard** 的方式做判别：
 *    把中间件里那句拒绝改成放行 → 重编译 → 重启 → **同一套判据必须变红**。
 *    若断开后仍然全绿，说明那条断言是**假闸门**，B-8 从未真正被验证。
 *
 * ===========================================================================
 * 为什么改**源码**而不是改产物 / 不走开关
 * ===========================================================================
 * · 不走"环境变量开关"：那等于在**生产代码里留一个关掉安全边界的后门**，
 *   而"最不该留后门的地方就是安全工具本身"（本项目既有纪律）。
 * · 改产物（dist）需要按压缩后的字符串定位，脆弱且难校验；
 *   改**源码**是精确字符串替换，可 sha256 逐字节校验还原。
 *
 * ⚠️ 代价：两次重编译 + 两次重启（约 4 分钟）。这是"证明边界真实"的必要成本，
 *    且只在**收口完成时**跑一次（不是每次回归都跑）。
 *
 * 用法：node scripts/verify-acl-boundary-reverse.mjs
 * 退出码：0 反向验证成立 / 1 反向验证不成立（存在假闸门） / 2 环境未就绪
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const GUARD = path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/middleware/native-metadata-guard.ts');
const DENY_LINE = "    ctx.throw(403, 'No permissions');";
const ALLOW_LINE = '    return next(); // ⏳ 反向验证：临时断开 guard';

const problems = [];
const log = (m) => console.log(m);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function build() {
  const r = spawnSync(NODE, ['scripts/build-plugin.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`build-plugin 失败：${String(r.stdout).slice(-400)}`);
}
function restartApp() {
  spawnSync('docker', ['compose', 'restart', 'app'], { cwd: ROOT, stdio: 'ignore' });
  // 等就绪（与 smoke 的 --wait 同一判据：容器 healthy）
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const r = spawnSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', 'svc-app'], { encoding: 'utf8' });
    if (String(r.stdout).trim() === 'healthy') {
      // 再等一会儿，让插件 load 完成（healthy 是容器探针，插件注册紧随其后）
      spawnSync(NODE, ['-e', 'setTimeout(()=>{},0)']);
      return new Promise((res) => setTimeout(res, 3000));
    }
    spawnSync(NODE, ['-e', 'setTimeout(()=>{},0)']);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  throw new Error('等待 svc-app healthy 超时');
}
/** 跑边界断言，返回 {passed, failed, raw} */
function runAssert() {
  const r = spawnSync(NODE, ['scripts/probe-native-read-deps.mjs', '--assert'], { cwd: ROOT, encoding: 'utf8' });
  const raw = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // ⚠️ 成功时探针打的是「✅ 一级 ACL 边界断言全部通过：**19 项**」（冒号在"通过"之后），
  //    失败时打的是「❌ 失败 N 项 / 通过 M 项」。
  //    第一版只匹配 `通过 (\d+) 项` ⇒ **成功那次解析出 0/0**，
  //    汇总行于是显示"通过 0 / 失败 0" —— 一个在说谎的汇总（本轮实测踩到）。
  //    ⇒ 两种形态都要认。
  const passed = Number(/通过：\s*(\d+)\s*项/.exec(raw)?.[1] ?? /通过 (\d+) 项/.exec(raw)?.[1] ?? 0);
  const failed = Number(/失败\s*(\d+)\s*项/.exec(raw)?.[1] ?? 0);
  return { rc: r.status, passed, failed, raw };
}

// ---------------------------------------------------------------------------
log('');
log('══════════════════════════════════════════════════════════════');
log('  B-8 边界反向验证：断开 guard ⇒ 判据必须变红');
log('══════════════════════════════════════════════════════════════');

if (!fs.existsSync(GUARD)) {
  log(`  ⛔ 找不到 guard 源码：${GUARD}（环境未就绪）`);
  process.exit(2);
}

const originalText = fs.readFileSync(GUARD, 'utf8');
const originalSha = sha(GUARD);
if (!originalText.includes(DENY_LINE)) {
  log(`  ⛔ guard 源码里找不到拒绝语句，反向验证无法注入：`);
  log(`     ${DENY_LINE}`);
  log('     （源码若改了措辞，请同步本脚本的锚点 —— 不要改成模糊匹配）');
  process.exit(2);
}

let restoredCleanly = false;
try {
  // ---- ① 断开 guard ----
  log('');
  log('  ① 断开 guard（把"拒绝"改成"放行"）');
  fs.writeFileSync(GUARD, originalText.replace(DENY_LINE, ALLOW_LINE), 'utf8');
  build();
  await restartApp();
  log('     已重编译并重启');

  const red = runAssert();
  log(`     断开后判据：通过 ${red.passed} / 失败 ${red.failed}（rc=${red.rc}）`);
  const wentRed = red.rc !== 0 && red.failed > 0;
  if (wentRed) {
    const hit = (red.raw.match(/❌[^\n]*/g) ?? []).slice(0, 3);
    log(`     ✅ 如实变红，命中：${hit.map((s) => s.trim().slice(0, 60)).join(' | ') || '(见完整输出)'}`);
  } else {
    problems.push(
      '断开 guard 后判据**仍然全绿** —— 说明那些"平台元数据被拒绝"的断言是**假闸门**，B-8 从未被真正验证',
    );
    log('     🚨 仍然全绿：这是假闸门');
  }

  // ---- ② 还原 ----
  log('');
  log('  ② 还原 guard 并复验');
  fs.writeFileSync(GUARD, originalText, 'utf8');
  const nowSha = sha(GUARD);
  if (nowSha !== originalSha) {
    problems.push(`还原后 sha256 不一致（${originalSha.slice(0, 12)} → ${nowSha.slice(0, 12)}）`);
    log('     🚨 sha256 不一致');
  } else {
    log(`     ✅ 源码已逐字节还原（sha256 ${originalSha.slice(0, 12)}…）`);
  }
  build();
  await restartApp();

  const green = runAssert();
  log(`     还原后判据：通过 ${green.passed} / 失败 ${green.failed}（rc=${green.rc}）`);
  if (green.rc === 0 && green.failed === 0) {
    log('     ✅ 边界恢复，判据回到全绿');
  } else {
    problems.push('还原后判据没有回到全绿 —— 环境不干净，后续结论不可信');
    log('     🚨 没有回到全绿');
  }
  restoredCleanly = true;
} finally {
  if (!restoredCleanly) {
    // 兜底还原：进程异常也要把源码写回，避免留下"被断开的 guard"
    fs.writeFileSync(GUARD, originalText, 'utf8');
    log('');
    log('  ⚠️ 异常路径：已兜底还原源码（请自行重编译/重启后再判结论）');
  }
}

log('');
log('══════════════════════════════════════════════════════════════');
if (problems.length === 0) {
  log('  ✅ 反向验证成立：断开 guard ⇒ 判据变红；还原 ⇒ 回到全绿');
  log('     ⇒ 那几条"平台元数据被拒绝"的断言**真的在观测边界**，不是假闸门。');
  log('══════════════════════════════════════════════════════════════');
  log('');
  process.exit(0);
}
log(`  ❌ 反向验证不成立（${problems.length} 项）：`);
for (const p of problems) log(`     · ${p}`);
log('══════════════════════════════════════════════════════════════');
log('');
process.exit(1);
