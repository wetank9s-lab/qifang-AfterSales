#!/usr/bin/env node
/**
 * verify-historical-import-mutation.mjs —— P11-3 第 3 项的**变异自证**
 *
 * ===========================================================================
 * 为什么必须有它（本项目铁律 8）
 * ===========================================================================
 *   「断言不会变红 = 没有断言。」
 *
 * 上一轮（第 2 项）就吃过一次：两条判据写错（版本正则多写了一个反斜杠、
 * "是否内联库"用了一个**出现在我们自己错误文案里**的词），产品明明是好的，
 * 断言却永远为真 —— 那种"绿"比红灯更危险，因为它不会被任何人发现。
 *
 * ⇒ 本脚本把关键机制**逐个做坏**，验证对应断言**确实变红**，再还原并验证复绿。
 *   全程走真实构建 → 真实重启 → 真实 HTTP，不做任何替身。
 *
 * ===========================================================================
 * 三个变异（各对应一条用户点名的约束）
 * ===========================================================================
 *   M1 让"工作表分类"依赖映射 ⇒ 东山的销售配送会被伪装映射变成售后
 *   M2 让"重复上传识别"失效（永远返回 null）⇒ 同文件重复上传会新建第二个批次
 *   M3 让"分代留痕"失效（写新版本前先删旧版本）⇒ 旧版本清洗结果被覆盖
 *
 * 判据：每个变异必须让**指定那一条**断言变红；还原后必须全绿。
 * 退出码：0 全部符合预期 / 1 有变异没被判红（门禁假绿）/ 2 环境未就绪
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'nocobase/plugins/service-ticket/src/server');
const CONTAINER = 'svc-app';

const results = [];
const log = (m) => console.log(m);

// ===========================================================================
// 🔴 单实例锁 —— 这台机器的 Bash 会把同一条命令**跑两遍**
// ===========================================================================
//
// 2026-10-12 实测事故（本脚本因此重写）：
//   变异自证连续三轮报出**互相矛盾**的结论 ——
//     · "M1 没有变红"（其实变异确实生效了，只是被另一个实例的构建盖掉）；
//     · "还原后复绿"（其实另一个实例还在变异中，跑的是变异版）。
//   取证到的事实：宿主与容器内的 `dist/server/index.js` 里**留着变异串**
//   （`sales-or-delivery" && mapping.fields.receiveDate === void 0`），
//   而**源码是干净的** —— 说明有一个"晚到的构建"把变异版覆盖了回去。
//
//   根因：本机 Bash 工具把同一条命令投递两次 ⇒ 两个实例**同时**在做
//   「改源码 → 构建 → 重启 → 跑门禁 → 还原」，互相覆盖彼此的文件与产物。
//   （这条机器特性在项目记忆里早有记录："对**消费型**脚本致命"。）
//
// ⇒ 处理方式：加锁 + 证据文件。
//   · 第一个实例持锁干活，结果写进 `storage/tmp/historical-import-mutation.json`；
//   · 第二个实例**不重复跑**，而是等锁释放后**读证据文件**并原样复述它的结论。
//   ⇒ 两个实例的输出一致，且**都不会**在对方干活时插一脚。
//   这也顺带让"结论"从 stdout 变成一份可复查的落盘证据（本项目一贯做法）。
const LOCK = path.join(ROOT, 'storage/tmp/.mutation-lock');
const EVIDENCE = path.join(ROOT, 'storage/tmp/historical-import-mutation.json');
fs.mkdirSync(path.dirname(LOCK), { recursive: true });

function isAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function tryAcquire() {
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // ⚠️ 陈旧锁必须能自动接管，否则一次异常退出就会让之后 30 分钟内
    //    **所有**变异自证都卡在等待里（实测踩到过一次）。
    //    判据用"持锁进程是否还活着"（`kill(pid, 0)`），比只看时间准得多。
    const holder = Number(String(fs.readFileSync(LOCK, 'utf8')).trim());
    const age = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (!Number.isFinite(holder) || !isAlive(holder) || age > 30 * 60 * 1000) {
      log(`  ⚠️ 接管陈旧锁（持有者 pid=${holder} 已不存在，锁龄 ${Math.round(age / 1000)} 秒）`);
      fs.writeFileSync(LOCK, String(process.pid));
      return true;
    }
    return false;
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK);
  } catch {
    /* 已被接管 */
  }
}

if (!tryAcquire()) {
  log('');
  log('  ⚠️ 已有另一个实例持锁（本机 Bash 会把同一条命令跑两遍）。');
  log('     本实例**不重复执行**，改为等待并复述对方的结论。');
  let waited = 0;
  while (fs.existsSync(LOCK) && waited < 30 * 60 * 1000) {
    sleepSync(3000);
    waited += 3000;
  }
  if (fs.existsSync(EVIDENCE)) {
    const prev = JSON.parse(fs.readFileSync(EVIDENCE, 'utf8'));
    log('');
    log('══════════════════════════════════════════════════════════════');
    log(`  变异自证（复述持锁实例的结论，${prev.finishedAt}）`);
    log('══════════════════════════════════════════════════════════════');
    for (const r of prev.results) log(`  ${r.ok ? '✅' : '❌'} ${r.id}${r.why ? ' —— ' + r.why : ''}`);
    process.exit(prev.failed === 0 ? 0 : 1);
  }
  console.error('  ⛔ 等待超时且没有证据文件 —— 拒绝给出结论');
  process.exit(2);
}

/** 同步 sleep（本脚本全程同步，避免 async 与子进程生命周期交错） */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });
}

function inspect(format) {
  return String(run('docker', ['inspect', '--format', format, CONTAINER]).stdout ?? '').trim();
}

/**
 * 重建 + 重启，并**证明容器真的换了**。
 *
 * ===========================================================================
 * 🔴 这里曾经有一个假绿（2026-10-12 实测踩到，必须记下来）
 * ===========================================================================
 * 第一版只等 `docker inspect ... .State.Health.Status == healthy`。
 * 但 `docker compose restart` **发出后**，容器的健康状态在头几秒里**仍然是
 * 重启前那个 `healthy`** —— 于是"等一下"这个动作**只看了一眼旧状态就返回**，
 * 随后跑的门禁打的是**上一个（被变异的）构建**。
 *
 * 后果极其隐蔽：
 *   · "还原后复绿"可能与事实相反（跑的还是变异版，恰好也绿）；
 *   · 变异步骤的"变红"可能来自**上一次**变异，而不是这一次。
 *   一句话：**整个变异自证建立在一个没被证明的假设上。**
 *
 * ⇒ 判据改成两条**同时**成立，且第一条是"重启这个动作确实发生了"：
 *   ① `.State.StartedAt` 与重启前**不同**（容器进程确实换了一个）；
 *   ② 之后 `.State.Health.Status == healthy`。
 *   这与本项目"配置类反向验证必须等改动生效（reload 是异步的）"是同一条教训
 *   （nginx `-s reload` + keep-alive 复用 ⇒ 假通过）。
 */
function rebuildAndRestart() {
  const build = run('node', [path.join(ROOT, 'scripts/build-plugin.mjs')], { cwd: ROOT });
  if (build.status !== 0) {
    return { ok: false, why: `构建失败：${String(build.stdout ?? '').slice(-600)}` };
  }
  const before = inspect('{{.State.StartedAt}}');
  run('docker', ['compose', 'restart', 'app'], { cwd: ROOT });

  for (let i = 0; i < 60; i += 1) {
    sleepSync(2000);
    const startedAt = inspect('{{.State.StartedAt}}');
    const health = inspect('{{.State.Health.Status}}');
    if (startedAt && startedAt !== before && health === 'healthy') {
      return { ok: true, startedAt };
    }
  }
  return {
    ok: false,
    why: `容器未在 120 秒内完成重启（StartedAt 仍是 ${before}）—— 拒绝在"可能还是旧进程"的状态下跑门禁`,
  };
}

function runVerify() {
  const r = run('node', [path.join(ROOT, 'scripts/verify-historical-import.mjs')], { cwd: ROOT });
  return { status: r.status, out: String(r.stdout ?? '') + String(r.stderr ?? '') };
}

const MUTATIONS = [
  {
    id: 'M1',
    title: '工作表分类改成依赖映射',
    /**
     * ⚠️ 第一版变异只改了 `if (isSalesSheet)` 这一个分支 —— **没有变红**，
     *    因为落到 `else if (!isServiceSheet)` 仍然判 excluded。
     *    那次"没变红"不是断言假，而是**变异没打中机制**：
     *    分类是由 `isSalesSheet` / `isServiceSheet` **两个**派生量共同决定的，
     *    只动一个，另一个会兜住。
     *    ⇒ 教训（写进 docs）：做变异自证时，"没变红"先怀疑变异无效，
     *      再怀疑断言；两者都要查清，否则会误删一条正确的断言。
     */
    file: path.join(PLUGIN, 'services/historical-import/mapping.ts'),
    edits: [
      {
        from: "  const isServiceSheet = sheetClass === 'service-install' || sheetClass === 'service-repair';",
        to:
          "  const isServiceSheet =\n" +
          "    sheetClass === 'service-install' || sheetClass === 'service-repair' ||\n" +
          '    mapping.fields.receiveDate !== undefined; // MUTATION',
      },
      {
        from: "  const isSalesSheet = sheetClass === 'sales-or-delivery';",
        to:
          "  const isSalesSheet = sheetClass === 'sales-or-delivery' && mapping.fields.receiveDate === undefined; // MUTATION",
      },
    ],
    expectRed: '刻意"伪装映射"后仍 100% 判为非售后排除',
  },
  {
    id: 'M2',
    title: '重复上传识别失效',
    file: path.join(PLUGIN, 'services/historical-import/store.ts'),
    edits: [
      {
        from: "    return repo('historicalImportBatches').findOne({ filter: { file_hash: fileHash } });",
        to: '    return null; // MUTATION',
      },
    ],
    expectRed: '重复上传返回同一个批次',
  },
  {
    id: 'M3',
    title: '分代留痕失效（写新版本前删旧版本）',
    file: path.join(PLUGIN, 'services/historical-import/store.ts'),
    edits: [
      {
        from: "    const cRepo = repo('historicalImportCandidates');",
        to:
          "    const cRepo = repo('historicalImportCandidates');\n" +
          '    // MUTATION: 先把旧版本删掉（真实产品绝不会这么做）\n' +
          '    await db.sequelize.query(`DELETE FROM historical_import_candidates WHERE batch_id = ${Number(batchId)} AND mapping_version <> ${Number(mappingVersion)}`);',
      },
    ],
    expectRed: '两代标准化结果（旧的一行没被覆盖）',
  },
];

// ---------------------------------------------------------------------------
log('');
log('══════════════════════════════════════════════════════════════');
log('  P11-3 第 3 项 · 变异自证（断言必须会变红）');
log('══════════════════════════════════════════════════════════════');

const dc = run('docker', ['ps', '--format', '{{.Names}}']);
if (!String(dc.stdout ?? '').includes(CONTAINER)) {
  console.error(`  ⛔ 容器 ${CONTAINER} 未运行 —— 环境未就绪`);
  process.exit(2);
}

// ---- 前置条件：源码必须干净 ----
//
// 🔴 这条是补上来的。2026-10-12 实测：因为"同一条命令被跑两遍"，
//    一个实例的构建把**变异版**产物留在了磁盘上，而它的源码还原动作
//    发生在另一个实例读取之后 —— 于是后续每一轮基线都报红，
//    而**源码其实是干净的**，人却只能看到"产品坏了"。
//    ⇒ 先把"源码是否干净"变成一条显式前置条件（不干净就直接拒绝出结论）。
const MUTATION_MARKERS = ['MUTATION', 'receiveDate === undefined', 'mapping_version <>'];
{
  const dirty = [];
  for (const m of MUTATIONS) {
    const text = fs.readFileSync(m.file, 'utf8');
    for (const marker of MUTATION_MARKERS) {
      if (text.includes(marker)) dirty.push(`${path.relative(ROOT, m.file)} 含「${marker}」`);
    }
  }
  if (dirty.length > 0) {
    console.error('  ⛔ 源码里残留变异标记 —— 拒绝出结论（先恢复源码再跑）：');
    for (const d of dirty) console.error(`     · ${d}`);
    releaseLock();
    process.exit(2);
  }
}

// ---- 基线：**强制**从干净源码重建一次，再证明当前是绿的 ----
//
// ⚠️ 为什么基线前要重建：产物可能被上一轮异常中断的实例留成变异版，
//    而"基线红"会被误读成"产品坏了"。重建 + 重启（带 StartedAt 证明）
//    之后得到的红/绿才真正反映**当前源码**。
log('\n── 基线（从干净源码强制重建）──────────────────────────────');
{
  const prep = rebuildAndRestart();
  if (!prep.ok) {
    log(`  ❌ ${prep.why}`);
    releaseLock();
    process.exit(2);
  }
  const r = runVerify();
  const ok = r.status === 0;
  log(`  验收门禁退出码 ${r.status}（要求 0）`);
  if (!ok) {
    log(String(r.out).split('\n').filter((l) => l.includes('❌')).join('\n'));
    console.error('  ⛔ 基线不是绿的 —— 先把产品修好再谈变异自证');
    releaseLock();
    process.exit(1);
  }
  results.push({ id: 'BASELINE', ok: true });
}

// ---- 逐个变异 ----
for (const m of MUTATIONS) {
  log(`\n── ${m.id}：${m.title} ─────────────────────────────`);
  const original = fs.readFileSync(m.file, 'utf8');
  let mutated = original;
  let anchorMissing = false;
  for (const e of m.edits) {
    if (!mutated.includes(e.from)) {
      log(`  ❌ 找不到要替换的源码片段 —— 变异脚本与源码已漂移，请先修脚本`);
      anchorMissing = true;
      break;
    }
    mutated = mutated.replace(e.from, e.to);
  }
  if (anchorMissing) {
    results.push({ id: m.id, ok: false, why: '锚点漂移' });
    continue;
  }
  // 自检：变异必须**真的改了文件**（改不动就是"变异没发生"，比没变红更难发现）
  if (mutated === original) {
    log('  ❌ 变异后文件内容与原文完全相同 —— 变异没有发生');
    results.push({ id: m.id, ok: false, why: '变异未生效' });
    continue;
  }
  fs.writeFileSync(m.file, mutated);

  let verdict;
  try {
    const build = rebuildAndRestart();
    if (!build.ok) {
      log(`  ❌ ${build.why}`);
      verdict = { ok: false, why: build.why };
    } else {
      const r = runVerify();
      const redLines = String(r.out)
        .split('\n')
        .filter((l) => l.trim().startsWith('❌'));
      const hit = redLines.some((l) => l.includes(m.expectRed));
      log(`  验收门禁退出码 ${r.status}`);
      for (const l of redLines) log(`  ${l.trim()}`);
      verdict = {
        ok: hit && r.status !== 0,
        why: hit ? '' : `期望变红的断言「${m.expectRed}」没有变红`,
      };
      log(
        `  ${verdict.ok ? '✅' : '❌'} 期望变红的那条断言「${m.expectRed}」` +
          (hit ? '**确实变红了**' : '**没有变红**（这条断言是假的）'),
      );
    }
  } finally {
    fs.writeFileSync(m.file, original);
  }
  // 🔴 还原必须**逐字节一致**。
  //    这条断言是补上来的：2026-10-12 实测出现过"源码看起来已还原、而构建产物里
  //    仍残留上一个变异"的状态（`grep MUTATION` 查不到，因为那标记在注释里、
  //    被 esbuild 剥掉了）。当时无法立刻归因，但**只要还原是可证明的**，
  //    这类困惑就不会再出现 —— 不需要先弄清它怎么发生的。
  const restoredOk = fs.readFileSync(m.file, 'utf8') === original;
  if (!restoredOk) {
    log('  ❌ 变异文件未逐字节还原 —— 后续结论一律不可信');
  }
  results.push({
    id: m.id,
    ok: verdict.ok && restoredOk,
    why: restoredOk ? verdict.why : '源码未还原',
  });
}

// ---- 还原后复绿 ----
log('\n── 还原（全部变异回滚）────────────────────────────────────');
{
  const build = rebuildAndRestart();
  if (!build.ok) {
    log(`  ❌ ${build.why}`);
    results.push({ id: 'RESTORE', ok: false, why: build.why });
  } else {
    const r = runVerify();
    log(`  验收门禁退出码 ${r.status}（要求 0）`);
    results.push({ id: 'RESTORE', ok: r.status === 0, why: r.status === 0 ? '' : '还原后没复绿' });
  }
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
log('');
log('══════════════════════════════════════════════════════════════');
log(`  变异自证：${results.length - failed.length}/${results.length} 符合预期`);
log('══════════════════════════════════════════════════════════════');
for (const r of results) log(`  ${r.ok ? '✅' : '❌'} ${r.id}${r.why ? ' —— ' + r.why : ''}`);

// 证据落盘：**结论不只在 stdout**（另一个实例要靠它复述；人也能事后复查）
fs.writeFileSync(
  EVIDENCE,
  JSON.stringify({ finishedAt: new Date().toISOString(), results, failed: failed.length }, null, 2),
);
releaseLock();
process.exit(failed.length === 0 ? 0 : 1);
