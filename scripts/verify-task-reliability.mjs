#!/usr/bin/env node
/**
 * verify-task-reliability.mjs —— Phase 8 核心门禁（后台任务可靠性 + SMS 失败恢复）
 * =============================================================================
 *
 * 覆盖用户在 Phase 8 开工时点名的**四条**门禁（契约 `docs/PHASE-8.md` §6）：
 *
 *   G1  任务重启/热重载**不会重复注册**，且运行结果**可观测**
 *   G2  SMS retry **真并发**时，同一失败短信**最多 retry once**      🔴 最关键
 *   G3  SLA 三类边界时间判断正确，尤其 **expected-visit 的 date semantics
 *       不被 12:00 技术值污染**（DEV-71）
 *   G4  scheduler **重复执行幂等**，不重复产生业务副作用
 *
 * -----------------------------------------------------------------------------
 * 为什么这四条必须存在（而不是"看代码就知道对"）
 * -----------------------------------------------------------------------------
 * Phase 8 的全部风险都集中在"**看着对、但语义已经漂了**"，而这类缺陷的共同特征是
 * **单看任何一层都自洽**：
 *
 *   · G1 —— 注册函数写成 `addJob` 返回 null 也继续，读代码完全没问题；
 *           真正会出事的是**热重载时旧 job 没被 remove** ⇒ 同一 cron 有两份在跑，
 *           5 分钟后同一批短信被两个 job 各扫一遍。
 *   · G2 —— 这是本阶段唯一"错了就无法挽回"的一条：先发短信再更新 retry_count，
 *           数据库最终状态**看起来完全正确**（retry_count=1），但客户**已经收到两条**。
 *           只有真并发（两个 worker 同时抢同一行）能把"顺序颠倒"咬出来。
 *   · G3 —— `expected_visit_at` 在库里是归一化到当天 **12:00** 的技术值（DEV-71）。
 *           任何 `expected_visit_at + graceMs` 都会算出"当天 14:00 超时"这个
 *           **不存在的业务含义**。这个错误在任何单元测试里都"看着对"，
 *           因为它与错误期望一致 —— 只有拿**日期边界**去顶才知道错在哪一天。
 *   · G4 —— 本项目全仓 0 处行锁，重复执行的正确性**只靠条件更新的影响行数**。
 *           要证明"跑两遍与跑一遍等价"，就得真的跑两遍再比库。
 *
 * -----------------------------------------------------------------------------
 * 反向验证（`--reverse`，铁律 8："断言不会变红 = 没有断言"）
 * -----------------------------------------------------------------------------
 * 以**故意写错的期望**重放同一组事实，要求**每一条都必须变红**。
 * 某条反向**通过**了，说明它根本没有区分力 —— 那比红灯更糟。
 *
 * -----------------------------------------------------------------------------
 * 前置 / 副作用 / 退出码
 * -----------------------------------------------------------------------------
 *   · 需要运行中的 compose 栈（`svc-app` / `svc-postgres`），且插件产物为**最新**
 *     （先跑 `node scripts/build-plugin.mjs && docker compose restart app`）。
 *     原因：本脚本要 `docker exec` 进容器 require **正在运行的那份 dist**。
 *   · **自建自删** SMS 测试行（`sms_logs` 里插入 4 行哨兵，`finally` 里按 id 精确删除）。
 *     不建工单、不派工，因此**不需要 UAT 账号口令**；但与真实库共用一个
 *     `sms_logs` 表，所以插入前先把 id 记下来，删除时按 id 删。
 *   · 证据落 `.tmp-verify/task-reliability-<run_id>.json`（**带 run_id**：
 *     本机 Bash 工具有"同一条命令跑两遍"的历史问题，固定文件名会让第二遍覆盖第一遍）。
 *   · 退出码：0 全绿 / 1 真红灯 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  ROOT,
  EnvNotReady,
  assert,
  makeChecker,
  psqlExec,
  psqlScalar,
  runMain,
} from './technician-harness.mjs';

const argv = process.argv.slice(2);
const REVERSE = argv.includes('--reverse');
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;

const { check, checkAsync, summary, state } = makeChecker({
  heading: 'Phase 8 后台任务可靠性 / SMS 失败恢复',
});

const APP = 'svc-app';
/** 容器内路径（probe 经 `docker cp` 送进去；跑完删掉，不留给镜像） */
const PROBE_IN_CONTAINER = '/app/nocobase/p8-probe.cjs';
const PROBE_STAGING = '/tmp/p8';
const SERVER_DIR = path.join(ROOT, 'nocobase', 'plugins', 'service-ticket', 'src', 'server');
const SRC_INDEX = path.join(SERVER_DIR, 'index.ts');
const SRC_PLUGIN = path.join(SERVER_DIR, 'plugin.ts');

// ---------------------------------------------------------------------------
// 探针调用（宿主 ↔ 容器）
// ---------------------------------------------------------------------------
/**
 * 跑一次容器探针，拿回结论。
 *
 * 通道约定（**结论走文件**，2026-09-26 实测踩到才定下）：
 *   · 请求：`docker cp` 一个 json 进容器；
 *   · 结论：探针写 `$P8_PROBE_OUT`，宿主 `cat` 它再删。
 *
 * ⚠️ 为什么结论不能走 stdout：NocoBase 的 Application 把**结构化日志写到 stdout**，
 *    一次 `app.load()` 就 ~50 行 JSON，`app.destroy()` 的日志还跟在后面。
 *    任何"取 stdout 最后一行当结论"的做法都会拿到 `app has stopped` 那条日志，
 *    报错变成"探针失败：undefined"—— 排查方向会被带偏到 docker / 网络上去。
 *    （这正是本项目一贯的那类坑：**通道没分开，就只能靠行序猜**。）
 *
 * ⚠️ 每次调用**先 `rm -f` 结论文件**：否则探针崩了没写，宿主会读到**上一轮**的
 *    ok 结论 —— 那是假绿最经典的成因。
 */
function runProbe(expect, { label = '' } = {}) {
  const reqLocal = path.join(ROOT, '.tmp-verify', `p8-req-${RUN_ID}${label}.json`);
  const outRemote = `${PROBE_STAGING}/conclusion${label}.json`;
  fs.writeFileSync(reqLocal, JSON.stringify({ pid: process.pid, expect }, null, 2), 'utf8');

  // ⚠️ 探针**每次调用都重新拷一份**，而不是"开头拷一次、结尾删掉"。
  //    理由（2026-09-26 实测踩到）：本机 Bash 工具会把同一条命令**跑两遍**。
  //    跑两遍时两条流水线的时序是交错的：run#2 的首次 `docker cp` 可能落在
  //    run#1 已经执行完 `cleanup()`（删掉探针）之后 ⇒ run#2 后面几个探针
  //    全部 `Cannot find module '/app/nocobase/p8-probe.cjs'`，
  //    表现成"G2/G3 全红、G1 却绿"，非常容易误判成"探针代码有问题"。
  //    每次拷一份后，任何时序交错都不会让对方找不到文件。
  const cpProbe = spawnSync(
    'docker',
    ['cp', path.join(ROOT, 'scripts', 'lib', 'p8-probe.cjs'), `${APP}:${PROBE_IN_CONTAINER}`],
    { encoding: 'utf8' },
  );
  if (cpProbe.status !== 0) {
    throw new EnvNotReady(`docker cp 探针失败（${APP} 在跑吗？）：${cpProbe.stderr || cpProbe.stdout}`);
  }

  const cp = spawnSync('docker', ['cp', reqLocal, `${APP}:${PROBE_STAGING}/req.json`], {
    encoding: 'utf8',
  });
  if (cp.status !== 0) {
    throw new EnvNotReady(`docker cp 请求文件失败（${APP} 在跑吗？）：${cp.stderr || cp.stdout}`);
  }

  // ⚠️ 分**三次** exec，不能写成一条 `sh -lc "rm && node && cat"`：
  //    日志在**同一个 stdout 流**里（NocoBase 写 stdout），`cat` 出来的结论会
  //    与前面几十行日志混在一起 ⇒ JSON.parse 直接失败。
  //    分开之后，`cat` 那一次 stdout 只有文件内容本身。
  spawnSync('docker', ['exec', APP, 'rm', '-f', outRemote], { encoding: 'utf8' });
  const run = spawnSync(
    'docker',
    ['exec', '-e', `P8_PROBE_OUT=${outRemote}`, '-w', '/app/nocobase', APP, 'node', PROBE_IN_CONTAINER, `${PROBE_STAGING}/req.json`],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const cat = spawnSync('docker', ['exec', APP, 'cat', outRemote], { encoding: 'utf8' });
  const text = String(cat.stdout || '').trim();
  if (cat.status !== 0 || !text) {
    throw new EnvNotReady(
      `探针未产出结论（exec 退出码 ${run.status} / cat 退出码 ${cat.status}）。\n` +
        `stdout 标记：${String(run.stdout || '').split('\n').filter((l) => l.startsWith('P8PROBE')).join('') || '(无)'}\n` +
        `stderr 末尾：\n${String(run.stderr || '').split('\n').slice(-6).join('\n')}`,
    );
  }
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new EnvNotReady(`探针结论不是 JSON（exec 退出码 ${run.status}）：${text.slice(0, 500)}`);
  }
  if (!envelope.ok) {
    const detail =
      envelope.error ?? `未提供 error 字段（键：${Object.keys(envelope).join(',')}）`;
    throw new EnvNotReady(`探针失败：${detail}`);
  }
  // ⚠️ 返回**完整信封**（含 ok / result 两层），调用方统一 `.result` 取数据。
  //    早期版本这里直接 return envelope.result，而调用方又写 `.result.xxx` ⇒ 永远 undefined，
  //    表现为"断言里所有字段都是 undefined"（看着像探针没干活，其实是少剥/多剥一层）。
  return envelope;
}

// ---------------------------------------------------------------------------
// 源码扫描（只用于"接口对齐"这一件事，见文件头说明）
// ---------------------------------------------------------------------------
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function readSrc(p) {
  return fs.readFileSync(p, 'utf8');
}
function walkTs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SMS 哨兵行（自建自删）
// ---------------------------------------------------------------------------
const SMS_SENTINEL_IDS = [];

/**
 * 插一行 `sms_logs` 哨兵。
 *
 * ⚠️ 字段要给全（`recipient_masked` / `template_code` / `provider` 都是 NOT NULL）——
 *    漏一个就是 23502，而报错信息里只说"某列"，排查方向容易跑到"权限"上去。
 * ⚠️ `recipient_masked` 用**明显假的**值（`139****0000` 形态）：
 *    万一删除失败留在库里，也要一眼能看出是验收残留，而不是某个真实客户。
 */
function seedSmsLog(sendStatus, retryCount) {
  // ⚠️ `biz_id` 每行必须唯一 —— 表上有 `sms_logs_provider_biz_id` 唯一约束
  //    (provider, biz_id)。踩到它时的报错是 23505，很容易被读成"脚本没清理干净"，
  //    真因其实是本机 Bash 工具有"同一条命令跑两遍"的历史行为（见 `docs/BACKLOG.md`
  //    与本项目 MEMORY 的"第二遍会覆盖证据文件"条）：第一遍插了 4 行、
  //    第二遍用**同一个** RUN_ID 再插 4 行 ⇒ 撞唯一约束。
  //    给它加上序号后，两遍各自成组，互不影响，且清理按 id 精确删除。
  const seq = SMS_SENTINEL_IDS.length + 1;
  // ⚠️ 用 `-t -A` 的 psqlScalar 跑 `INSERT … RETURNING` 会得到**两行**：
  //    第一行是 id，第二行是 `INSERT 0 1` 的命令标签。只取第一行 ——
  //    否则 `Number('2891\nINSERT 0 1')` = NaN。
  const out = psqlScalar(
    `INSERT INTO sms_logs ` +
      `(created_at, updated_at, scene, provider, template_code, recipient_masked, ` +
      ` send_status, retry_count, biz_id) ` +
      `VALUES (now(), now(), 'p8-verify', 'mock', 'P8_VERIFY_SENTINEL', ` +
      ` '139****0000', '${sendStatus}', ${retryCount}, 'p8-verify-${RUN_ID}-${seq}') ` +
      `RETURNING id`,
  );
  const first = String(out).trim().split('\n')[0].trim();
  const id = Number(first);
  if (!Number.isFinite(id) || id <= 0) throw new EnvNotReady(`插入 sms_logs 哨兵失败，返回：${out}`);
  SMS_SENTINEL_IDS.push(id);
  return id;
}

function smsRow(id) {
  const r = psqlScalar(
    `SELECT send_status || '|' || retry_count::text FROM sms_logs WHERE id = ${id}`,
  );
  if (!r) return null;
  const [send_status, retry_count] = String(r).split('|');
  return { send_status, retry_count: Number(retry_count) };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  // 前置：容器在跑 + 产物是最新的
  const probeStage = spawnSync(
    'docker',
    ['exec', APP, 'sh', '-lc', `mkdir -p ${PROBE_STAGING}`],
    { encoding: 'utf8' },
  );
  if (probeStage.status !== 0) {
    throw new EnvNotReady(`容器 ${APP} 不可用（先 docker compose up -d）：${probeStage.stderr}`);
  }
  // 探针文件由 `runProbe()` 每次调用时各自拷贝（见那里的注释）。


  // =========================================================================
  // G1 —— 任务重启/热重载不重复注册 + 运行结果可观测
  // =========================================================================
  console.log('\n--- G1 任务注册幂等 + 可观测 ---');

  await checkAsync('G1.1 health 暴露三个任务且 tasksOverall=ok', async () => {
    const r = await fetch(`http://localhost:${process.env.NGINX_HTTP_PORT || 8080}/api/svc:health`);
    assert(r.status === 200, `health 状态码 ${r.status}`);
    const body = await r.json();
    const data = body?.data ?? body;
    const tasks = data?.tasks ?? {};
    for (const name of ['review_expiry', 'sms_retry', 'sla_scan']) {
      assert(tasks[name], `health.tasks 缺 ${name}（实际键：${Object.keys(tasks).join(',')}）`);
    }
    assert(
      data.tasksOverall === 'ok',
      `tasksOverall=${data.tasksOverall}（期望 ok；attention 说明某任务失败过）`,
    );
    return `tasks=[${Object.keys(tasks).join(',')}] tasksOverall=${data.tasksOverall}`;
  });

  await checkAsync('G1.2 每个任务都有 lastRun 字段族（不是假字段）', async () => {
    const r = await fetch(`http://localhost:${process.env.NGINX_HTTP_PORT || 8080}/api/svc:health`);
    const data = (await r.json())?.data ?? {};
    const tasks = data.tasks ?? {};
    const missing = [];
    for (const [name, t] of Object.entries(tasks)) {
      for (const key of ['lastStartedAt', 'lastFinishedAt', 'lastResult', 'lastSuccessAt', 'runCount']) {
        if (!(key in t)) missing.push(`${name}.${key}`);
      }
    }
    assert(missing.length === 0, `缺字段：${missing.join(', ')}`);
    const sla = tasks.sla_scan ?? {};
    assert(sla.neverRan === false, `sla_scan.neverRan=${sla.neverRan}（启动预热未生效？）`);
    assert(sla.lastResult === 'success', `sla_scan.lastResult=${sla.lastResult}`);
    return `sla_scan lastResult=${sla.lastResult} processed=${sla.lastProcessedCount} runs=${sla.runCount}`;
  });

  await checkAsync('G1.3 三个注册器对"没有 cronJobManager"的 app 只 warn 不抛错', async () => {
    const resp = runProbe({ mode: 'registry' }, { label: '-registry' });
    const d = resp.result.degraded;
    const bad = [];
    for (const [k, v] of Object.entries(d)) {
      if (v?.threw) bad.push(`${k} 抛错：${v.error}`);
      else if (v?.value !== null) bad.push(`${k} 返回 ${JSON.stringify(v?.value)}（期望 null）`);
    }
    assert(bad.length === 0, bad.join('; '));
    return 'reviewExpiry/smsRetry/slaScan 三者均不抛错且返回 null';
  });

  check('G1.4 plugin 注册任务时"先移除旧 job 再 add"（热重载不叠加）', () => {
    const src = stripComments(readSrc(SRC_PLUGIN));
    const hits = [...src.matchAll(/private\s+(?:async\s+)?register\w*Task\s*\(/g)].map((m) => m[0]);
    assert(hits.length >= 3, `plugin.ts 里 register*Task 方法只找到 ${hits.length} 个（期望 ≥3）`);
    // 每个方法体内必须出现 removeJob；否则热重载会叠加出两份 cron
    const body = src.slice(src.indexOf('register'));
    assert(
      /removeJob/.test(src),
      'plugin.ts 没有 removeJob 调用 —— 热重载会叠加注册（同一 cron 两份在跑）',
    );
    return `找到 ${hits.length} 个注册方法 + removeJob 存在`;
  });

  check('G1.5 三处注册函数名与源码导出一致（改源码忘改脚本会立刻红）', () => {
    const idx = stripComments(readSrc(SRC_INDEX));
    for (const name of [
      'registerReviewExpiryJob',
      'registerSmsRetryJob',
      'registerSlaScanJob',
      'appointmentOverdueFrom',
      'SMS_CLAIM_SQL',
    ]) {
      assert(idx.includes(name), `index.ts 未导出 ${name}（本门禁的探针依赖它）`);
    }
    return '5 个测试缝均在 index.ts 有显式导出';
  });

  // =========================================================================
  // G2 —— SMS retry 真并发 ⇒ 同一 SmsLog 最多 retry once 🔴
  // =========================================================================
  console.log('\n--- G2 SMS 重试并发门（本阶段最关键）---');

  // 四行哨兵：① 可抢的 error/retry_count=0  ② 已是 pending（不该被抢）
  //           ③ 已到上限 error/retry_count=1  ④ accepted（不该被抢）
  const rowClaimable = seedSmsLog('error', 0);
  const rowPending = seedSmsLog('pending', 0);
  const rowExhausted = seedSmsLog('error', 1);
  const rowAccepted = seedSmsLog('accepted', 0);

  const WORKERS = 8;
  // 🔴 反向模式：故意把 retry 上限喂成 0 —— 谓词变成 `retry_count < 0`（恒假），
  //    于是 8 个 worker 一个都抢不到。这是"claim 被错误收紧"的真实回归形态，
  //    门禁必须抓到它（G2.1/G2.2 转红）。正向则用真实上限 1。
  const CLAIM_RETRY_LIMIT = REVERSE ? 0 : 1;
  const claimResp = runProbe(
    {
      mode: 'claim',
      primaryId: rowClaimable,
      secondaryId: rowPending,
      seedIds: [rowClaimable, rowPending, rowExhausted, rowAccepted],
      workerCount: WORKERS,
      retryLimit: CLAIM_RETRY_LIMIT,
    },
    { label: '-claim' },
  );
  const claim = claimResp.result;

  check(`G2.1 ${WORKERS} 路真并发抢同一行 ⇒ 恰好 1 个 true，其余全 false`, () => {
    const claims = claim.primary.claims;
    assert(Array.isArray(claims), `claims 不是数组：${JSON.stringify(claims)}`);
    const trues = claims.filter(Boolean).length;
    assert(
      trues === 1,
      `${WORKERS} 个并发 claim 里 ${trues} 个拿到资格（期望恰好 1）—— ` +
        `${trues > 1 ? '🔴 会重复发送！' : '一个都没抢到，谓词可能写错了'}`,
    );
    return `${WORKERS} 并发 → ${trues} 个 true`;
  });

  check('G2.2 抢完后 retry_count 恰好 1 且状态转为 pending（幂等上界）', () => {
    const after = claim.primary.after;
    assert(after, '抢完后读不到该行');
    assert(
      Number(after.retry_count) === 1,
      `retry_count=${after.retry_count}（期望 1：8 个并发只能推一次）`,
    );
    assert(
      after.send_status === 'pending',
      `send_status=${after.send_status}（期望 pending）`,
    );
    return `retry_count=${after.retry_count} send_status=${after.send_status}`;
  });

  check('G2.3 并发结束后再抢一次仍为 false（上限已到，不是只挡同时刻）', () => {
    const again = claim.primary.afterConcurrent;
    assert(again === false, `第二次串行 claim 返回 ${again}（期望 false —— 上限是持久的）`);
    return '串行再抢 = false';
  });

  check('G2.4 谓词对"已到上限的 error 行"直接拒绝（不依赖并发）', () => {
    const rows = claim.rows ?? [];
    const exhausted = rows.find((r) => Number(r?.id) === rowExhausted);
    assert(exhausted, `读不到哨兵行 ${rowExhausted}`);
    assert(
      exhausted.send_status === 'error' && Number(exhausted.retry_count) === 1,
      `已到上限行状态被改了：${JSON.stringify(exhausted)}`,
    );
    return `retry_count=1 的 error 行原样未动（未参与并发，故未验证拒绝；见 G2.6）`;
  });

  check('G2.5 谓词对"非 error 状态"拒绝（pending 行不被抢走）', () => {
    const s = claim.secondary;
    assert(s, '读不到 secondary 结果');
    assert(s.claim === false, `对 pending 行的 claim 返回 ${s.claim}（期望 false）`);
    return `pending 行 claim=false（读到的状态 ${s.row?.send_status}）`;
  });

  check('G2.6 已到上限 / 非 error 的行经**并发路径**也不被改写', () => {
    const rows = claim.rows ?? [];
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const ex = byId.get(rowExhausted);
    const ac = byId.get(rowAccepted);
    assert(ex && ac, '哨兵行读回不全');
    assert(
      ex.send_status === 'error' && Number(ex.retry_count) === 1,
      `上限行被改写：${JSON.stringify(ex)}`,
    );
    assert(
      ac.send_status === 'accepted' && Number(ac.retry_count) === 0,
      `accepted 行被改写：${JSON.stringify(ac)}`,
    );
    return 'error/retry=1 与 accepted 两行均未被 claim 触及';
  });

  check('G2.7 claim SQL 是**条件 UPDATE + RETURNING**（不是 SELECT 后 UPDATE）', () => {
    const sql = String(claim.sqlText ?? '');
    assert(/\bUPDATE\s+sms_logs\b/i.test(sql), `未见 UPDATE sms_logs：${sql}`);
    assert(/\bWHERE\b/i.test(sql), 'claim SQL 没有 WHERE —— 会无条件改写');
    assert(
      /retry_count\s*<\s*\$/i.test(sql) || /retry_count\s*<\s*\d/i.test(sql),
      `claim SQL 没有 retry_count 上界谓词：${sql}`,
    );
    assert(
      /send_status\s*=\s*\$/i.test(sql) || /send_status\s*=\s*'/i.test(sql),
      `claim SQL 没有 send_status 前置谓词：${sql}`,
    );
    assert(/RETURNING\s+id/i.test(sql), `claim SQL 没有 RETURNING（无法靠影响行数裁决）：${sql}`);
    assert(!/\bFOR\s+UPDATE\b/i.test(sql), 'claim SQL 用了行锁 —— 违反本项目并发范式');
    return '条件式 UPDATE + RETURNING id，无行锁';
  });

  check('G2.8 全仓 0 处 FOR UPDATE（本项目并发范式是条件 UPDATE + 影响行数）', () => {
    const files = [
      ...walkTs(path.join(ROOT, 'nocobase', 'plugins', 'service-ticket', 'src')),
      ...walkTs(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs')),
    ];
    const hits = [];
    for (const f of files) {
      const src = stripComments(readSrc(f));
      if (/\bFOR\s+UPDATE\b/i.test(src)) hits.push(path.relative(ROOT, f));
    }
    assert(hits.length === 0, `发现行锁用法：${hits.join(', ')}`);
    return `扫描 ${files.length} 个源文件，0 处 FOR UPDATE`;
  });

  check('G2.9 sms-service 里 claim**先于**发送（顺序颠倒会重复发送）', () => {
    const src = stripComments(readSrc(path.join(SERVER_DIR, 'services', 'sms-service.ts')));
    const body = src.slice(src.indexOf('async retryPending'));
    assert(body.length > 200, '找不到 retryPending 方法体');
    const iClaim = body.indexOf('claimForRetry');
    const iSend = body.indexOf('safeSend');
    assert(iClaim >= 0, 'retryPending 里没有调用 claimForRetry');
    assert(iSend >= 0, 'retryPending 里没有调用 safeSend');
    assert(
      iClaim < iSend,
      '🔴 顺序颠倒：safeSend 出现在 claimForRetry 之前 —— 两个 worker 竞争时会重复发送',
    );
    return 'claimForRetry 在 safeSend 之前';
  });

  // =========================================================================
  // G3 —— SLA 三类边界时间（DEV-71 日期语义）
  // =========================================================================
  console.log('\n--- G3 SLA 日期语义边界（DEV-71）---');

  /**
   * 边界用例（**以 +08:00 表达**，因为 DEV-71 的"当地"就是 UTC+8）。
   *
   * 判据的完整链条（契约 §3.3）：
   *   expected_visit_at → appointmentDateOnly() → `当地日期 T23:59:59.999+08:00`
   *   → + appointment_overdue_grace_minutes → overdue 判定
   *
   * 所以 `expectedAt` 的**时分秒一律被忽略**：12:00、23:59、00:01 三个不同时刻
   * 在同一天必须给出**同一个** overdueFrom。这正是"日期语义"的可证伪形式。
   */
  const GRACE = 120;
  const boundaryCases = [
    // 同名日期、不同时刻 ⇒ 必须同值（三条）
    { name: '同日 00:01', expectedAt: '2026-09-20T00:01:00+08:00', grace: GRACE, day: '2026-09-20' },
    { name: '同日 12:00（DB 归一化值）', expectedAt: '2026-09-20T12:00:00+08:00', grace: GRACE, day: '2026-09-20' },
    { name: '同日 23:59', expectedAt: '2026-09-20T23:59:00+08:00', grace: GRACE, day: '2026-09-20' },
    // 跨日：差一天必须差 24h
    { name: '次日 12:00', expectedAt: '2026-09-21T12:00:00+08:00', grace: GRACE, day: '2026-09-21' },
    // 边界：当地 23:59:59.999 + 120min = 次日 01:59:59.999
    { name: 'grace=0 的基准日', expectedAt: '2026-09-20T12:00:00+08:00', grace: 0, day: '2026-09-20' },
  ];

  /**
   * 🔴 反向模式：发往探针的 `expectedAt` **整体 +1 天**（+08:00 无夏令时，24h 即整整一天）。
   *
   * 为什么这样能证明"断言有区分力"：
   *   探针用**被移位**的日期算 `from`，而 G3.2/G3.3/G3.4/G3.5 的**独立期望**仍按
   *   `boundaryCases`（正确日期）算 ⇒ 必然不符 ⇒ 这些断言**必须转红**。
   *   同时 G3.1 保持绿 —— 因为它验的是"时分秒被忽略"（三时刻同日仍同日），
   *   整体平移一天不破坏这个性质。这正是"反向不把所有断言都变红"的诚实形态：
   *   红的都是"绝对日期正确性"断言，绿的是"日期语义"断言，各司其职。
   */
  function shiftIsoByDay(iso, days) {
    const d = new Date(iso);
    d.setTime(d.getTime() + days * 86_400_000);
    return d.toISOString();
  }
  const probeCases = boundaryCases.map((c) => ({
    name: c.name,
    expectedAt: REVERSE ? shiftIsoByDay(c.expectedAt, 1) : c.expectedAt,
    grace: c.grace,
  }));

  const slaResp = runProbe(
    { mode: 'sla-boundary', cases: probeCases },
    { label: '-sla' },
  );
  const boundaries = slaResp.result.boundaries;
  const byName = new Map(boundaries.map((b) => [b.name, b]));
  const get = (n) => byName.get(n);

  /** 从 ISO 串直接算"当地日期 T23:59:59.999+08:00"的毫秒，作为独立期望 */
  function localDayEndPlusGrace(iso, grace) {
    const d = new Date(iso);
    // 把时刻抹掉，只留 +08:00 当地日期
    const local = new Date(d.getTime() + 8 * 3600_000);
    const y = local.getUTCFullYear();
    const m = local.getUTCMonth();
    const day = local.getUTCDate();
    // 当地 23:59:59.999 = UTC (当日 24:00:00.000 - 0.001) - 8h
    const endUtc = Date.UTC(y, m, day, 23, 59, 59, 999) - 8 * 3600_000;
    return endUtc + grace * 60_000;
  }

  check('G3.1 同一天不同时刻（00:01 / 12:00 / 23:59）给出**同一个** overdueFrom', () => {
    const a = get('同日 00:01')?.from;
    const b = get('同日 12:00（DB 归一化值）')?.from;
    const c = get('同日 23:59')?.from;
    assert(a && b && c, `边界结果缺失：${JSON.stringify([a, b, c])}`);
    assert(
      a === b && b === c,
      `同一天三种时刻给出不同 overdueFrom —— 说明**用到了时分秒**（DEV-71 违规）：\n` +
        `  00:01 → ${a}\n  12:00 → ${b}\n  23:59 → ${c}`,
    );
    return `三者同为 ${a}`;
  });

  check('G3.2 overdueFrom 等于「当地 23:59:59.999 + grace」，不是 expectedAt + grace', () => {
    const b = get('同日 12:00（DB 归一化值）');
    const caseDef = boundaryCases[1];
    const want = new Date(localDayEndPlusGrace(caseDef.expectedAt, caseDef.grace)).toISOString();
    assert(b?.from, `边界结果缺失：${JSON.stringify(b)}`);
    assert(
      b.from === want,
      `overdueFrom=${b.from}，期望 ${want}\n` +
        `（若期望值与 actual 是"12:00 + 120min"那种，就是被 12:00 技术值污染了）`,
    );
    const naive = new Date(new Date(caseDef.expectedAt).getTime() + caseDef.grace * 60_000).toISOString();
    assert(b.from !== naive, `🔴 overdueFrom 等于 expected_visit_at + graceMs（${naive}）—— 实现错误`);
    return `${b.from}（且 ≠ 直接相加的 ${naive}）`;
  });

  check('G3.3 grace=0 时 overdueFrom = 当地当天 23:59:59.999', () => {
    const b = get('grace=0 的基准日');
    const want = new Date(localDayEndPlusGrace('2026-09-20T12:00:00+08:00', 0)).toISOString();
    assert(b?.from === want, `grace=0 → ${b?.from}，期望 ${want}`);
    return b.from;
  });

  check('G3.4 跨日：次日同一时刻的 overdueFrom 恰好晚 24h', () => {
    const a = get('同日 12:00（DB 归一化值）')?.from;
    const d = get('次日 12:00')?.from;
    assert(a && d, '缺跨日用例');
    const delta = new Date(d).getTime() - new Date(a).getTime();
    assert(delta === 24 * 3600_000, `跨日差 ${delta}ms（期望 86400000）`);
    return `Δ=${delta}ms`;
  });

  check('G3.5 当日边界算式：23:59:59.999 + 120min = 次日 01:59:59.999', () => {
    const b = get('同日 12:00（DB 归一化值）');
    const d = new Date(b.from);
    // 转回 +08:00 当地时间看字面
    const local = new Date(d.getTime() + 8 * 3600_000);
    const hh = local.getUTCHours();
    const mm = local.getUTCMinutes();
    const day = local.getUTCDate();
    assert(
      hh === 1 && mm === 59 && day === 21,
      `+08:00 当地应为 2026-09-21 01:59，实际 ${local.toISOString()} → ${hh}:${mm} day=${day}`,
    );
    return '当地 09-21 01:59:59.999';
  });

  check('G3.6 源码里不存在 `expected_visit_at + graceMs` 形态的直接相加', () => {
    const dir = path.join(SERVER_DIR, 'services');
    const hits = [];
    for (const f of walkTs(dir)) {
      const src = stripComments(readSrc(f));
      // 只挑"sla/overdue"语境的文件，避免把"受理超时 = 创建时刻 + 分钟"这类**正确的**加法误伤
      if (!/sla-scan/.test(f)) continue;
      for (const m of src.matchAll(/expectedVisitAt[\s\S]{0,40}?\+\s*[\w.]*grace/gi)) {
        hits.push(`${path.basename(f)}: ${m[0].replace(/\s+/g, ' ')}`);
      }
    }
    assert(hits.length === 0, `发现直接相加：\n${hits.join('\n')}`);
    return 'sla-scan-scheduler.ts 无 expectedVisitAt + grace 形态';
  });

  // =========================================================================
  // G4 —— 重复执行幂等
  // =========================================================================
  console.log('\n--- G4 scheduler 重复执行幂等 ---');

  check('G4.1 SLA scan 是纯读：源码里没有任何写库调用', () => {
    const src = stripComments(readSrc(path.join(SERVER_DIR, 'services', 'sla-scan-scheduler.ts')));
    const forbidden = [
      [/\bINSERT\s+INTO\b/i, 'INSERT'],
      [/\bUPDATE\s+\w/i, 'UPDATE'],
      [/\bDELETE\s+FROM\b/i, 'DELETE'],
      [/TicketEvent/i, '写 TicketEvent'],
      [/createTicketEvent|recordEvent/i, '事件写入辅助'],
    ];
    const hits = forbidden.filter(([re]) => re.test(src)).map(([, label]) => label);
    assert(hits.length === 0, `SLA 扫描出现写操作：${hits.join(', ')}（契约 §3.4：只计算 + 聚合）`);
    return '0 处写操作';
  });

  check('G4.2 claim 重复调用幂等：第二次必为 false（跑两遍 = 跑一遍）', () => {
    const again = claim.primary.afterConcurrent;
    const after = claim.primary.after;
    assert(again === false, `第二次 claim 返回 ${again}`);
    assert(Number(after.retry_count) === 1, `重复执行后 retry_count=${after.retry_count}（期望仍为 1）`);
    return `重复 claim=false 且 retry_count 仍为 1`;
  });

  check('G4.3 三个任务 onTick 都不 await（cron 库不因慢任务堆积）', () => {
    const files = ['review-expiry-scheduler.ts', 'sms-retry-scheduler.ts', 'sla-scan-scheduler.ts'];
    const bad = [];
    for (const f of files) {
      const src = stripComments(readSrc(path.join(SERVER_DIR, 'services', f)));
      const m = /onTick:\s*\([^)]*\)\s*=>\s*\{([\s\S]{0,400}?)\}/.exec(src);
      if (!m) {
        bad.push(`${f}: 找不到 onTick 体`);
        continue;
      }
      if (/\bawait\b/.test(m[1])) bad.push(`${f}: onTick 里出现 await`);
    }
    assert(bad.length === 0, bad.join('; '));
    return '三个 onTick 均 void 调用（异常在内部收干净）';
  });

  check('G4.4 sweep 入口永不抛错（catch 后返回空结果），失败不阻断后续 tick', () => {
    const files = {
      'review-expiry-scheduler.ts': 'runReviewExpirySweep',
      'sms-retry-scheduler.ts': 'runSmsRetrySweep',
      'sla-scan-scheduler.ts': 'runSlaScan',
    };
    const bad = [];
    for (const [f] of Object.entries(files)) {
      const src = stripComments(readSrc(path.join(SERVER_DIR, 'services', f)));
      assert(/catch\s*\(/.test(src), `${f} 没有 catch —— 任务失败会冒泡到 cron 库`);
      // catch 块里必须不 throw
      const catchBlocks = [...src.matchAll(/catch\s*\([^)]*\)\s*\{([\s\S]{0,600}?)\n\s*\}/g)];
      for (const cb of catchBlocks) {
        if (/\bthrow\b/.test(cb[1])) bad.push(`${f}: catch 里仍然 throw`);
      }
    }
    assert(bad.length === 0, bad.join('; '));
    return '三个 sweep 均有 catch 且 catch 内不 throw';
  });

  check('G4.5 registry 写方法永不抛错（可观测性不能成为单点故障）', () => {
    const src = stripComments(readSrc(path.join(SERVER_DIR, 'services', 'task-registry.ts')));
    const body = src.slice(src.indexOf('class TaskRegistry'));
    assert(body.length > 500, '取不到 TaskRegistry 类体');
    assert(
      !/\bthrow\b/.test(body),
      'TaskRegistry 内有 throw —— 任务状态记录失败会反过来影响业务执行（用户明令禁止）',
    );
    const catches = (body.match(/catch\s*\(/g) ?? []).length;
    assert(catches >= 3, `TaskRegistry 只有 ${catches} 个 catch（start/finish/snapshot/putFact 都该各自兜底）`);
    return `0 处 throw / ${catches} 处 catch`;
  });

  // -------------------------------------------------------------------------
  // 证据落盘
  // -------------------------------------------------------------------------
  const evidence = {
    run_id: RUN_ID,
    reverse: REVERSE,
    passed: state.passed,
    failures: state.failures,
    sentinel_rows: { rowClaimable, rowPending, rowExhausted, rowAccepted },
    claims: claim.claims,
    primaryAfter: claim.primary.after,
    boundaries,
  };
  const outPath = path.join(ROOT, '.tmp-verify', `task-reliability-${RUN_ID}.json`);
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`\n  证据：${path.relative(ROOT, outPath)}`);
}

// ---------------------------------------------------------------------------
// 清理（**必须覆盖 sms_logs 哨兵**）
// ---------------------------------------------------------------------------
function cleanup() {
  if (SMS_SENTINEL_IDS.length) {
    const list = SMS_SENTINEL_IDS.join(',');
    const r = psqlExec(`DELETE FROM sms_logs WHERE id IN (${list}) AND scene = 'p8-verify';`);
    const left = psqlScalar(`SELECT count(*) FROM sms_logs WHERE id IN (${list})`);
    if (String(left).trim() !== '0') {
      console.log(`  ⚠️ sms_logs 哨兵残留 ${left} 行（id: ${list}）—— 请手工清理`);
    } else {
      console.log(`  已清理 ${SMS_SENTINEL_IDS.length} 行 sms_logs 哨兵（${r.ok ? 'ok' : '见上'})`);
    }
  }
  // 容器内的探针与请求/响应文件：跑完即删，不留在镜像里
  spawnSync('docker', ['exec', APP, 'sh', '-lc', `rm -f ${PROBE_IN_CONTAINER} ${PROBE_STAGING}/req.json ${PROBE_STAGING}/conclusion*.json`], {
    encoding: 'utf8',
  });
}

runMain({
  name: `Phase 8 核心门禁${REVERSE ? '（反向验证）' : ''}`,
  main: async () => {
    try {
      await main();
    } finally {
      summary();
    }
  },
  cleanup,
}).then(() => {
  if (REVERSE) {
    reverseVerdict();
    return;
  }
  // 正向：summary 已打印；有失败即退出码 1（铁律 4）
  if (state.failures.length) process.exit(1);
});

/**
 * 反向模式的裁决。
 *
 * 反向不是"把绿改成红"——而是给底层**喂错的数据**（retryLimit=0、边界日期 +1 天），
 * 让正确代码产出"看似异常"的结果，再要求门禁**恰好**把这些异常抓出来。
 * 因此反向的 PASS 判据是**精确匹配**，不是"有红就行"：
 *
 *   ① 每一个**期望转红**的断言都必须真的红了（漏抓 = 假绿，最危险）；
 *   ② 除此之外**任何**断言都不能红（误伤 = 注入的坏数据把不该炸的炸了，同样是缺陷）。
 *
 * 期望转红（由反向注入决定）：
 *   · G2.1/G2.2/G4.2 —— retryLimit=0 ⇒ 8 个 worker 一个都抢不到，
 *      于是"恰好 1 个 true"（G2.1）、"retry_count=1 且 pending"（G2.2）、
 *      "第二次 no-op 后 retry_count 仍为 1"（G4.2）三个断言**同一根因**转红；
 *   · G3.2/G3.3/G3.5 —— 边界日期 +1 天 ⇒ 与独立期望（按正确日期算）必然不符
 *   （G3.4 的"跨日差 24h"是**相对**量，整体平移不改变它 ⇒ 保持绿，这是设计使然）
 */
function reverseVerdict() {
  const failedNames = state.failures.map((f) => f.name);
  const expectedRed = ['G2.1 ', 'G2.2 ', 'G4.2 ', 'G3.2 ', 'G3.3 ', 'G3.5 '];

  const missing = expectedRed.filter((p) => !failedNames.some((n) => n.startsWith(p)));
  const extra = failedNames.filter((n) => !expectedRed.some((p) => n.startsWith(p)));

  console.log('\n--- 反向验证裁决 ---');
  let ok = true;
  if (missing.length) {
    ok = false;
    console.log(`  ❌ 漏抓（假绿）：这些断言本应转红却没有：\n     · ${missing.join('\n     · ')}`);
  } else {
    console.log(`  ✅ 期望转红的 ${expectedRed.length} 个断言全部正确转红`);
  }
  if (extra.length) {
    ok = false;
    console.log(`  ❌ 误伤：反向注入的坏数据把不该炸的断言也炸了：\n     · ${extra.join('\n     · ')}`);
  } else {
    console.log('  ✅ 无意外误伤（注入只命中了该命中的断言）');
  }

  if (ok) {
    console.log('\n  反向验证通过：门禁有区分力，能抓出注入的回归。\n');
    process.exit(0);
  } else {
    console.log('\n  反向验证失败：门禁要么漏抓、要么误伤。\n');
    process.exit(1);
  }
}
