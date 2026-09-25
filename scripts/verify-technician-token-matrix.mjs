#!/usr/bin/env node
/**
 * verify-technician-token-matrix.mjs —— **Token HTTP Matrix**（P5-1）
 * =============================================================================
 *
 * 把"师傅作业链接"在各种生命周期位置上的**对外表现**钉成一张表，逐格用真实
 * HTTP 请求取证。为什么叫"矩阵"而不叫"N 条"：条数会随实现演进（本轮 8 格，
 * 以后加"转店"可能变 9 格），而**矩阵**表达的是"两个维度交叉出来的格子必须全覆盖"
 * —— 维度是「Token 的失效原因」× 「四个匿名端点」。
 *
 * -----------------------------------------------------------------------------
 * 矩阵（本轮 8 格，全部经 nginx 打**对外路径**，不是内部 NocoBase 路径）
 * -----------------------------------------------------------------------------
 *   #  场景                                期望      它证明了什么
 *   ────────────────────────────────────────────────────────────────────────────
 *   1  A 有效（首次派工后）                 200       正常入口通
 *   2  随机 43 位（格式合法但不存在）        401       不存在 ⇒ 不区分
 *   3  A 人为置为已过期（夹具改库）          401       过期 ⇒ 不区分
 *   4  另一枚被置为"已使用"（夹具改库）      401       已用 ⇒ 不区分（**与 Visit 状态解耦**：
 *                                                     此时 Visit 仍是 ASSIGNED，若实现只看
 *                                                     visit_status 就会漏放）
 *   5  A 在改派**之前**                     200       改派不影响当前链接
 *   6  同一枚 A 在改派**之后**               401       旧链接立刻失效（Phase 4 硬门槛）
 *   7  改派产生的新 Visit 的 Token B         200       新链接可用
 *   8  B 在**成功提交**之后                  401       真实提交确实消费了匿名入口
 *
 * 第 8 格是本矩阵的**核心**：它证明的不只是"TokenService 能标记已用"，
 * 而是"一次真实的 submit 走完之后，那个匿名入口真的关上了"。
 * 前面 7 格都可能在一个"从未真正提交过"的实现里全绿。
 *
 * -----------------------------------------------------------------------------
 * 两条附加的"防水"断言（不是矩阵的一格，但同等重要）
 * -----------------------------------------------------------------------------
 *   P1 **四个端点共用同一层认证**：随机 Token 打 get / files / submit / photos
 *      四个路径，必须**都是** 401。只测 get 的话，某个 handler 未来若被
 *      从 `withTechnicianAuth` 里摘出来，本矩阵会全绿而接口已经裸奔。
 *   P2 **失败响应逐字节相同**：2/3/4/6 四格的响应体必须**完全一致**
 *      （不是"code 相同"）。这正是防枚举的判据 —— 如果实现开始回
 *      "已过期" / "已被改派" 这类区分性文案，本断言立刻变红。
 *      同时断言响应体里**不出现** reason 关键词（EXPIRED/REVOKED/...）。
 *
 * -----------------------------------------------------------------------------
 * 副作用与可重复性
 * -----------------------------------------------------------------------------
 *   · 自建 **2 张**一次性工单（T1 走完 1/2/3/5/6/7/8，T2 专供第 4 格），
 *     跑完在 finally 里按各自的 id 精确删除（含照片与私有文件）
 *   · 第 3、4 格需要"把链接置成过期/已用"，做法是**直接改库**——
 *     这是唯一能在秒级构造这两个状态的手段（否则要等 72 小时）。
 *     第 3 格改完**立刻还原**，因为后面的格子还要用同一枚 A。
 *   · **不碰**走查工单 35 / 886 / 1039 / 1040
 *
 * 用法：node scripts/verify-technician-token-matrix.mjs
 * 退出码：0 全绿 / 1 真红灯 / 2 环境未就绪
 */
import { createHash, randomBytes } from 'node:crypto';

import {
  BASE_URL,
  acceptAndDispatch,
  assert,
  cleanupTicket,
  createScratchTicket,
  ensureFixtureJpeg,
  eq,
  errorMessageOf,
  localDateOnly,
  makeChecker,
  psqlExec,
  psqlScalar,
  runMain,
  SMS_ENABLED_KEY,
  smsSwitch,
  svcPost,
  twoSessions,
  technicianGet,
  technicianPhoto,
  technicianSubmit,
  technicianUpload,
  tokenFromOutbox,
} from './technician-harness.mjs';

const { check, checkAsync: checkA, summary, state } = makeChecker({
  heading: 'Token HTTP Matrix',
});

/**
 * 一个"格式合法但必然不存在"的 Token。
 *
 * ⚠️ **必须运行时生成，不能手写常量**。第一版手写了一个 42 位的字符串，
 *    结果 nginx 的 `{43}` 正则不匹配 → 请求**根本没被重写** → 原样到达应用 →
 *    resourcer 解析失败 → **404**。于是"随机 token → 401"这条断言变红，
 *    而红灯的措辞会把人引向"认证层有问题"，实际上认证层连碰都没被碰到。
 *    （这正好也是 nginx 那段注释描述的语义："不符时不重写"，语义唯一但**不好查**。）
 *    用 `randomBytes(32).toString('base64url')` 生成，长度由算法保证；
 *    下面的自断言让"形态正确"这件事本身也被检查 —— 它一红，
 *    说明 Token 长度约定（`TECHNICIAN_TOKEN.BYTES`）变了，而不是认证坏了。
 */
const RANDOM_TOKEN = randomBytes(32).toString('base64url');

const fixtures = { t1: 0, t2: 0 };
/**
 * 短信开关：**取 Token 的前置条件**（原因见 harness 的 `smsSwitch` 注释：
 * 本机 `sms.enabled=false` 时短信不入 mock 通道，发件箱空 ⇒ 拿不到 Token）。
 * 在 main 里打开，在 cleanup 里无条件恢复。
 */
const sms = smsSwitch();

const bodyOf = (r) => String(r?.body ?? '');
const sha256Hex = (value) => createHash('sha256').update(String(value)).digest('hex');
const bodiesEqual = (list) => new Set(list).size === 1;

/** 响应体里绝不允许出现的"原因"关键词（内部 reason 只能进日志） */
const REASON_LEAK_WORDS = [
  'EXPIRED',
  'REVOKED',
  'ALREADY_USED',
  'NOT_FOUND',
  'MALFORMED',
  'VISIT_NOT_ACTIVE',
  'TICKET_NOT_ACTIVE',
  'LOOKUP_FAILED',
  'reassigned',
  'expired',
  'revoked',
  '已过期',
  '已使用',
  '已失效原因',
];

async function main() {
  // 两个会话：门店做业务、总部读发件箱取 Token（后者对门店账号 403，见 harness 注释）
  const { store: session, hq } = await twoSessions();

  // 打开短信开关并等过 ConfigService 的 10s 缓存 TTL —— 只有走 mock 通道，
  // 短信入参（含师傅链接）才会进发件箱；Token 明文**只在**那里可取。
  console.log(`  · 打开 ${SMS_ENABLED_KEY}（原值 ${sms.original}），等待 11s 让配置缓存过期…`);
  await sms.enable();

  // =========================================================================
  // 夹具：T1（主链路）+ T2（专供"已使用"一格）
  // =========================================================================
  const t1 = await createScratchTicket({
    tag: 'P5-1-TOKEN',
    content: '师傅 Token 矩阵专用',
  });
  fixtures.t1 = t1.ticketId;
  await acceptAndDispatch(t1.ticketId, session);
  const first = await tokenFromOutbox({ sessionToken: hq, ticketNo: t1.ticketNo });
  const tokenA = first.token;
  console.log(`  · T1 ${t1.ticketNo}（id=${t1.ticketId}）· 首次派工 Token A = ${tokenA.slice(0, 6)}…`);

  const t2 = await createScratchTicket({
    tag: 'P5-1-USED',
    content: '已使用 Token 分支专用',
  });
  fixtures.t2 = t2.ticketId;
  await acceptAndDispatch(t2.ticketId, session);
  const second = await tokenFromOutbox({ sessionToken: hq, ticketNo: t2.ticketNo });
  const tokenUsed = second.token;
  console.log(
    `  · T2 ${t2.ticketNo}（id=${t2.ticketId}）· 已使用分支 Token = ${tokenUsed.slice(0, 6)}…`,
  );

  // 记下失败响应用于 P2（逐字节同一性）
  const failureBodies = {};

  // =========================================================================
  // 第 1 格 —— A 有效
  // =========================================================================
  await checkA('#1 有效 Token A → 200，且只回最小上下文', async () => {
    const r = await technicianGet(tokenA);
    eq(r.status, 200, 'HTTP');
    const data = r.json?.data;
    assert(data && typeof data === 'object', `响应不是对象：${bodyOf(r).slice(0, 160)}`);
    eq(data.status, 'pending', 'status（师傅视角投影值）');
    eq(data.visit_status, 'ASSIGNED', 'visit_status（来源枚举值）');
    assert(data.ticket_no === t1.ticketNo, `ticket_no 应为 ${t1.ticketNo}，实际 ${data.ticket_no}`);
    assert(typeof data.max_photos === 'number' && data.max_photos > 0, `max_photos 异常：${data.max_photos}`);
    assert(typeof data.max_photo_size_mb === 'number', 'max_photo_size_mb 必须是数字');
    assert(Array.isArray(data.photos), 'photos 必须是数组（刷新后回显已传照片）');
    eq(data.photos.length, 0, '初始照片数');
    // 最小披露：这些键**不允许**出现
    const forbidden = [
      'customer_mobile',
      'customer_name',
      'access_token_hash',
      'storage_key',
      'token_revoked_reason',
    ];
    const leaked = forbidden.filter((k) => k in data);
    eq(leaked, [], '泄漏键');
    assert(!('id' in data), '响应里不得出现内部主键 id');
    return `ticket_no=${data.ticket_no} photos=${data.photos.length} max=${data.max_photos}`;
  });

  // =========================================================================
  // 第 2 格 —— 随机 Token
  // =========================================================================
  await checkA('#2 随机 43 位 Token → 401', async () => {
    const r = await technicianGet(RANDOM_TOKEN);
    eq(r.status, 401, 'HTTP');
    eq(r.json?.errors?.[0]?.code, 'TOKEN_INVALID', '错误码');
    failureBodies.random = bodyOf(r);
    return `${r.status} ${r.json?.errors?.[0]?.code}`;
  });

  // =========================================================================
  // 第 3 格 —— 人为置为已过期（夹具改库，改完立刻还原）
  // =========================================================================
  await checkA('#3 已过期 Token → 401（夹具置位后立即还原）', async () => {
    const visitId = Number(
      psqlScalar(
        `SELECT id FROM service_visits WHERE ticket_id = ${t1.ticketId} AND visit_status = 'ASSIGNED' ORDER BY visit_no DESC LIMIT 1`,
      ),
    );
    assert(visitId > 0, '取不到 ASSIGNED 的 Visit');

    const original = psqlScalar(`SELECT token_expires_at::text FROM service_visits WHERE id = ${visitId}`);
    assert(original, '取不到原始 token_expires_at');

    const set = psqlExec(
      `UPDATE service_visits SET token_expires_at = now() - interval '1 minute' WHERE id = ${visitId};`,
    );
    assert(set.ok, `置位失败：${set.out}`);

    let r;
    try {
      r = await technicianGet(tokenA);
    } finally {
      // ⚠️ 无条件还原：后面的格子还要用同一枚 A。
      //    放在 finally 里是因为"断言失败"不该让夹具留在脏状态 ——
      //    那会让**后续**格子连锁变红，掩盖真正的首个失败点。
      const restore = psqlExec(
        `UPDATE service_visits SET token_expires_at = '${original}'::timestamptz WHERE id = ${visitId};`,
      );
      assert(restore.ok, `还原 token_expires_at 失败：${restore.out}`);
    }

    eq(r.status, 401, 'HTTP');
    eq(r.json?.errors?.[0]?.code, 'TOKEN_INVALID', '错误码');
    failureBodies.expired = bodyOf(r);

    // 还原是否真的生效 —— 不验证的话，"还原失败 + 后续格子也 401"会被误读成
    // "改派没生效"，排查方向完全错。
    const restored = psqlScalar(`SELECT token_expires_at::text FROM service_visits WHERE id = ${visitId}`);
    eq(restored, original, '还原后的 token_expires_at');
    return `visit=${visitId} 已过期→401，且已还原`;
  });

  // =========================================================================
  // 第 4 格 —— 已使用（**与 Visit 状态解耦**：Visit 仍是 ASSIGNED）
  // =========================================================================
  await checkA('#4 已使用 Token（Visit 仍 ASSIGNED）→ 401', async () => {
    const visitId = Number(
      psqlScalar(
        `SELECT id FROM service_visits WHERE ticket_id = ${t2.ticketId} AND visit_status = 'ASSIGNED' ORDER BY visit_no DESC LIMIT 1`,
      ),
    );
    assert(visitId > 0, '取不到 T2 的 ASSIGNED Visit');

    // 只置 token_used_at，**不动** visit_status —— 这正是本格与第 8 格的区别：
    // 它证明"已用"这条分支是独立生效的，而不是靠 Visit 已 SUBMITTED 顺带挡住的。
    // （若实现把 ALREADY_USED 的判定删掉、只靠 VISIT_NOT_ACTIVE 兜底，
    //   第 8 格照样绿，而本格会红。）
    const set = psqlExec(`UPDATE service_visits SET token_used_at = now() WHERE id = ${visitId};`);
    assert(set.ok, `置位失败：${set.out}`);

    const r = await technicianGet(tokenUsed);
    eq(r.status, 401, 'HTTP');
    eq(r.json?.errors?.[0]?.code, 'TOKEN_INVALID', '错误码');
    failureBodies.used = bodyOf(r);

    const stillAssigned = psqlScalar(`SELECT visit_status FROM service_visits WHERE id = ${visitId}`);
    eq(stillAssigned, 'ASSIGNED', 'Visit 状态（本格的前提：它没变）');
    return `visit=${visitId} 已用→401（Visit 仍 ${stillAssigned}）`;
  });

  // =========================================================================
  // 第 5 格 —— 改派前 A 仍然有效
  // =========================================================================
  await checkA('#5 改派前 A 仍有效 → 200', async () => {
    const r = await technicianGet(tokenA);
    eq(r.status, 200, 'HTTP');
    return `${r.status}`;
  });

  // =========================================================================
  // 第 6 格 —— 改派后同一枚 A
  // =========================================================================
  let tokenB = '';
  await checkA('#6 改派后同一枚 A → 401（旧行一字段不改，仅置吊销位）', async () => {
    const reassign = await svcPost(
      'reassign',
      t1.ticketId,
      session,
      {
        technician_name: '李师傅',
        technician_mobile: '13900010002',
        expected_visit_at: localDateOnly(2),
        service_mode: 'third_party',
        provider_name: 'P5-1改派厂家',
        reason: 'P5-1 Token 矩阵：改派以验证旧链接失效',
      },
      crypto.randomUUID(),
    );
    assert(
      reassign.status === 200,
      `改派失败 HTTP ${reassign.status} ${errorMessageOf(reassign)}`,
    );

    const r = await technicianGet(tokenA);
    eq(r.status, 401, 'HTTP');
    eq(r.json?.errors?.[0]?.code, 'TOKEN_INVALID', '错误码');
    failureBodies.revoked = bodyOf(r);

    // 内部取证：旧行**状态与快照都没被改**，只是吊销位被置上（Phase 4 的硬约束）
    const oldVisit = psqlScalar(
      `SELECT visit_status || '|' || coalesce(token_revoked_reason,'-') || '|' || technician_name` +
        ` FROM service_visits WHERE ticket_id = ${t1.ticketId} ORDER BY visit_no LIMIT 1`,
    );
    eq(oldVisit, 'SUPERSEDED|reassigned|王师傅', '旧 Visit 行（状态/吊销原因/师傅姓名）');
    return `A→401，旧行=${oldVisit}`;
  });

  // =========================================================================
  // 第 7 格 —— 改派后的新 Token B
  // =========================================================================
  await checkA('#7 改派产生的新 Visit 的 Token B → 200', async () => {
    const b = await tokenFromOutbox({ sessionToken: hq, ticketNo: t1.ticketNo });
    tokenB = b.token;
    assert(tokenB && tokenB !== tokenA, `Token B 应与 A 不同（A=${tokenA.slice(0, 6)}…）`);

    const r = await technicianGet(tokenB);
    eq(r.status, 200, 'HTTP');
    const visitNo = psqlScalar(`SELECT visit_no FROM service_visits WHERE ticket_id = ${t1.ticketId} ORDER BY visit_no DESC LIMIT 1`);
    eq(String(r.json?.data?.visit_status), 'ASSIGNED', 'visit_status');
    return `B=${tokenB.slice(0, 6)}… visit_no=${visitNo}`;
  });

  // =========================================================================
  // 第 8 格 —— B 在**真实提交**之后（本矩阵的核心）
  // =========================================================================
  await checkA('#8 B 在成功提交之后 → 401（真实 submit 消费了匿名入口）', async () => {
    // 照片下限（用户 2026-09-25 拍板：至少 1 张）生效后，真实提交必须带 1 张照片
    // —— 这格测的是"提交消费 Token"，不是照片规则，所以先补齐前置。
    const upB = await technicianUpload(tokenB, ensureFixtureJpeg(), { filename: 'b.jpg' });
    eq(upB.status, 201, `提交前上传照片 HTTP（${errorMessageOf(upB)}）`);
    const submitRes = await technicianSubmit(tokenB, {
      service_result: 'resolved',
      service_note: 'Token 矩阵：一次真实提交',
      is_charged: false,
    });
    eq(submitRes.status, 200, `提交 HTTP（${errorMessageOf(submitRes)}）`);

    const after = await technicianGet(tokenB);
    eq(after.status, 401, '提交后 GET 的 HTTP');
    eq(after.json?.errors?.[0]?.code, 'TOKEN_INVALID', '错误码');

    // 内部取证：Visit 已 SUBMITTED 且 token_used_at 已置、Ticket 已到 WAIT_STORE_CONFIRM
    const visit = psqlScalar(
      `SELECT visit_status || '|' || (token_used_at IS NOT NULL)::text` +
        ` FROM service_visits WHERE ticket_id = ${t1.ticketId} ORDER BY visit_no DESC LIMIT 1`,
    );
    eq(visit, 'SUBMITTED|true', 'Visit（状态|Token 已消费）');
    const status = psqlScalar(`SELECT status FROM service_tickets WHERE id = ${t1.ticketId}`);
    eq(status, 'WAIT_STORE_CONFIRM', 'Ticket 状态');
    return `提交 200 → 再 GET 401；Visit=SUBMITTED（used=true）Ticket=${status}`;
  });

  // =========================================================================
  // P0 —— 夹具自身的形态（它一红说明"Token 长度约定变了"，不是认证坏了）
  // =========================================================================
  check('P0 用作"不存在"的那枚 Token 形态合法（43 位 base64url）', () => {
    eq(RANDOM_TOKEN.length, 43, '长度（= TECHNICIAN_TOKEN.LENGTH）');
    assert(/^[A-Za-z0-9_-]{43}$/.test(RANDOM_TOKEN), `字符集不合法：${RANDOM_TOKEN}`);
    const inDb = Number(
      psqlScalar(`SELECT count(*) FROM service_visits WHERE access_token_hash = '${sha256Hex(RANDOM_TOKEN)}'`),
    );
    eq(inDb, 0, '它不该恰好等于库中某枚 Token 的哈希（256 位随机，概率可忽略）');
    return `${RANDOM_TOKEN.slice(0, 6)}… 长度 43`;
  });

  // =========================================================================
  // P1 —— 四个端点共用同一层认证
  // =========================================================================
  await checkA('P1 随机 Token 打四个端点：全部 401（认证层不是"只装在 get 上"）', async () => {
    const results = {
      get: await technicianGet(RANDOM_TOKEN),
      files: await technicianUpload(RANDOM_TOKEN, Buffer.from('not-an-image'), { filename: 'x.jpg' }),
      submit: await technicianSubmit(RANDOM_TOKEN, {
        service_result: 'resolved',
        service_note: 'x',
        is_charged: false,
      }),
      photos: await technicianPhoto(RANDOM_TOKEN, 'AAAAAAAAAAAAAAAAAAAAAA'),
    };
    const codes = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.status]));
    eq(codes, { get: 401, files: 401, submit: 401, photos: 401 }, '四个端点的 HTTP 码');

    const bodies = Object.values(results).map(bodyOf);
    assert(bodiesEqual(bodies), `四个 401 的响应体必须逐字节相同：\n${bodies.join('\n')}`);
    return `4/4 端点 401，响应体一致`;
  });

  // =========================================================================
  // P2 —— 失败响应逐字节相同 + 不泄漏原因
  // =========================================================================
  check('P2 四种失效（随机/过期/已用/已吊销）的响应体**逐字节相同**', () => {
    const keys = ['random', 'expired', 'used', 'revoked'];
    const missing = keys.filter((k) => !failureBodies[k]);
    eq(missing, [], '缺少取证样本（前面的格子必须有失败）');
    const bodies = keys.map((k) => failureBodies[k]);
    for (const k of keys) {
      assert(
        bodiesEqual(bodies),
        `第 ${k} 格的响应体与其它失效不一致：\n  ${failureBodies[k]}\n  ${bodies[0]}`,
      );
    }
    return `${bodies.length} 种失效 → 同一个响应体（${bodies[0].length} 字节）`;
  });

  check('P2b 失败响应体里不含任何"失效原因"关键词，也不含 detail', () => {
    for (const [key, body] of Object.entries(failureBodies)) {
      for (const word of REASON_LEAK_WORDS) {
        assert(
          !body.includes(word),
          `第 ${key} 格的响应体泄漏了原因关键词 "${word}"：${body}`,
        );
      }
      assert(
        !/"detail"/.test(body),
        `第 ${key} 格的响应体带上了 detail —— 那会让每次请求的 body 都不一样，` +
          `"逐字节相同"这条判据随之失效：${body}`,
      );
    }
    return `${Object.keys(failureBodies).length} 份响应体均干净`;
  });

  summary();
  if (state.failures.length) process.exitCode = 1;
}

await runMain({
  name: 'Token HTTP Matrix（P5-1）',
  main,
  cleanup: () => {
    const r = cleanupTicket(fixtures.t1);
    cleanupTicket(fixtures.t2);
    if (r) console.log(`  · 清理：删除 ${r.filesDeleted} 个私有照片文件 / ${r.attachmentsDeleted} 条附件行`);
    // ⚠️ 恢复短信开关**必须在清理之后也要跑到** —— 所以它在 cleanup 里，
    //    而不是 main 的末尾（main 抛 EnvNotReady 时就跳过了）。
    const back = sms.restore();
    console.log(`  · 短信开关已复位：${back.note}`);
  },
});

if (state.failures.length) process.exit(1);
