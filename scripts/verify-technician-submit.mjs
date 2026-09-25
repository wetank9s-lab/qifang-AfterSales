#!/usr/bin/env node
/**
 * verify-technician-submit.mjs —— **Submit 契约与事务边界**（P5-1）
 * =============================================================================
 *
 * `POST /api/technician/visits/:token/submit` 是整个匿名链路里**唯一**会同时改
 * 四样东西的入口：Visit、Token、Ticket、TicketEvent。所以本脚本不测"能不能提交成功"
 * 这一件事，而是把"成功时四样必须一起变 / 失败时四样必须一样都不变"钉死。
 *
 * -----------------------------------------------------------------------------
 * 矩阵 V：入参契约（全部拒绝，且**拒绝不消耗 Token**）
 * -----------------------------------------------------------------------------
 *   V1  service_result 缺失 / 非法 → 422 INVALID_SERVICE_RESULT
 *   V2  service_note 缺失 / 纯空白 / 超长 → 422
 *   V3  is_charged 缺失 / 非布尔字面量 → 422（**不能**用 Boolean() 兜底：
 *       字符串 'false' 会被判成 true，静默把"未收费"记成"已收费"）
 *   V4  is_charged=true 缺金额 / 金额 0 或负 / 超上界 / 三位小数 → 422
 *   V5  **关键**：以上每一次拒绝之后，同一 Token 仍然可用（GET 200）。
 *       否则"师傅填错一个字 → 链接作废" —— 这是最容易被忽略的灾难性耦合。
 *
 * -----------------------------------------------------------------------------
 * 矩阵 P：照片下限（用户 2026-09-25 拍板：**至少 1 张**，P5-1 范围内补校验）
 * -----------------------------------------------------------------------------
 *   P1  0 张照片 submit → 422 PHOTO_REQUIRED，且 Token 未被消耗。
 *       （此前 `PHASE-5.md` §6.2 只写上限，0 张也能提交 —— 已定为缺陷。）
 *   P2  **用户点名的路径**：上传 1 张 → 库里失效到 0 张（模拟删除/失效）→
 *       submit 仍必须被服务端拒绝。前端只是体验层（置灰 + 提示），
 *       权威校验必须在服务端 —— 尤其要挡"传了又失效到 0"这条绕过路径。
 *   P3  防御性上限兜底：把 `visit.photo_max_count` 临时降到 0（模拟后台调小）→
 *       已有 1 张的提交也要被拒（PHOTO_LIMIT_REACHED）。正常路径的上限
 *       由上传时 `PhotoService` 把守（上传矩阵 B8 验过），这格验的是 submit 侧兜底。
 *   P4  （正向）带 1 张照片提交成功后，事件 metadata 里的 photo_count=1。
 *       注：上传矩阵 B9b 已是"带 6 张提交成功 + photo_count=6"的正向门，
 *       两边合起来正好钉住 1 和 6 两个边界。
 *
 * -----------------------------------------------------------------------------
 * 矩阵 A：成功提交的原子性
 * -----------------------------------------------------------------------------
 *   A1 一次成功提交后，**四样**同时到位：
 *        Visit  ASSIGNED → SUBMITTED（含回执字段、submitted_at、store_confirm_status）
 *        Token  token_used_at 已置（一次性失效）
 *        Ticket PROCESSING → WAIT_STORE_CONFIRM
 *        Event  新增 1 条 TECHNICIAN_SUBMITTED，from/to 正确、带 visit_id 与 photo_count
 *   A2  提交前后 **数据库快照**逐字段对比（本脚本会打印出来，供人工核对）
 *   A3  终态文案不含"完成"（师傅提交 ≠ 工单完成）
 *   A4  `is_charged=false` 时，即使请求里带了残留金额，入库也必须是 NULL
 *
 * -----------------------------------------------------------------------------
 * 矩阵 R：两条反向测试（本阶段最重要的两条）
 * -----------------------------------------------------------------------------
 *   R1 **故意让 Ticket 状态更新失败** → 确认 Visit / Token / Event **都没有半落账**。
 *      手段：在库里临时装一个 BEFORE UPDATE 触发器，让
 *      `service_tickets.status: PROCESSING → WAIT_STORE_CONFIRM` 抛异常。
 *      于是事务在**第 ③ 步**炸掉，而第 ①② 步（Visit 回执、Token 消费）已经写过。
 *      判据（三条，缺一不可）：
 *        · Visit 仍是 ASSIGNED、回执字段仍为空、token_used_at 仍为 NULL
 *        · Ticket 仍是 PROCESSING
 *        · 事件数不变
 *      外加一条**最有说服力的**：撤掉触发器后**同一 Token 仍能提交成功** ——
 *      若 Token 被误消费，链接就废了，而"废掉的链接"在库里看起来只是一行
 *      `token_used_at` 非空，**不会报任何错**。
 *
 *   R2 **成功提交后用同一 Token 重放完全相同的请求** → 必须 401 TOKEN_INVALID，
 *      且不得再写 Visit / Event。
 *      ⚠️ 这里与内部 `/api/svc/*` 的 request-id 幂等**是两回事**：
 *      一次性 Token **本身就是提交边界**，重放应当被当作"入口已关闭"。
 *      为了"幂等"把已用 Token 再开放一次，等于给每条已提交的链接留了后门。
 *
 * -----------------------------------------------------------------------------
 * 停止线
 * -----------------------------------------------------------------------------
 * 本脚本只验到 `WAIT_STORE_CONFIRM`。门店确认/驳回、评价、CLOSED 属后续阶段，
 * **不在本脚本内**（也不该为了"顺手"而加）。
 *
 * -----------------------------------------------------------------------------
 * 用法 / 退出码
 * -----------------------------------------------------------------------------
 *   node scripts/verify-technician-submit.mjs     # 0 全绿 / 1 真红灯 / 2 环境未就绪
 */
import {
  EnvNotReady,
  PRIVATE_DIR,
  SMS_ENABLED_KEY,
  acceptAndDispatch,
  assert,
  cleanupTicket,
  createScratchTicket,
  ensureFixtureJpeg,
  eq,
  errorMessageOf,
  eventRows,
  inApp,
  makeChecker,
  psqlExec,
  psqlRows,
  psqlScalar,
  runMain,
  smsSwitch,
  technicianGet,
  technicianPhoto,
  technicianSubmit,
  technicianUpload,
  ticketSnapshot,
  tokenFromOutbox,
  twoSessions,
  visitSnapshots,
} from './technician-harness.mjs';

const { checkAsync, summary, state } = makeChecker({ heading: 'Submit 契约与事务边界' });

/**
 * 带限流退避的请求包装（**本脚本唯一允许吞掉 429 的地方**）。
 *
 * 为什么必须要有：nginx 的 `svc_upload` 区是 `30r/m burst=20 nodelay`
 * （见 `nginx/conf.d/service.conf`）。本脚本要打 ~25 次师傅接口，
 * **必然**超过一次突发额度 —— 那不是产品缺陷，是脚本自己的流量形态。
 *
 * 两个"不做"：
 *   · **不放宽产品限流**（虽然本脚本可以改 `service_settings`）。放宽会让
 *     "限流到底生不生效"这件事失去可信度，而限流本身在
 *     `verify-technician-routing.mjs` 与上传矩阵 B10 里是被正向验过的。
 *   · **不改走容器内直连**绕过 nginx。本脚本要验的正是"经 nginx 的对外路径"。
 *
 * ⚠️ 因此本脚本**没有任何一格期望 429**。将来若要在这里验限流，
 *    必须走一条不带退避的调用路径 —— 否则断言会被自己的退避逻辑吃掉，
 *    变成"永远绿"（本项目最忌讳的一类假绿）。
 */
const paced = (fn) => async (...args) => {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const r = await fn(...args);
    if (r.status !== 429) return r;
    const fromHeader = Number(r.headers?.get?.('retry-after'));
    const wait = Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : 2;
    console.log(`      · 429（nginx svc_upload 突发额度用尽）→ 等 ${wait}s 重试`);
    await new Promise((res) => setTimeout(res, Math.min(wait, 10) * 1000));
  }
  throw new EnvNotReady('退避重试 15 次仍持续 429 —— 环境异常或 nginx 限流被改动');
};

const pSubmit = paced(technicianSubmit);
const pGet = paced(technicianGet);
const pUpload = paced(technicianUpload);
const pPhoto = paced(technicianPhoto);

const fixtures = { t1: 0, t2: 0, t3: 0 };
const sms = smsSwitch();

/** 本轮如实标记的降级项（不假装验过） */
const degraded = [];

/** R1 用的临时触发器名（清理时按名删，绝不 DROP 整张表上的其它触发器） */
const FAIL_TRIGGER = 'p51_force_ticket_update_fail';
const FAIL_FUNCTION = 'p51_force_ticket_update_fail_fn';

// ---------------------------------------------------------------------------
// 取证助手（全部走 psql，读的是**真库**，不是接口回显）
// ---------------------------------------------------------------------------

/** 该工单的 Visit 行（按 visit_no 正序），输出成可比对的字符串数组 */
const visitRows = (ticketId) => visitSnapshots(ticketId);

/** 事件条数 */
const eventCount = (ticketId) =>
  Number(psqlScalar(`SELECT count(*) FROM ticket_events WHERE ticket_id = ${ticketId}`));

/** 工单状态 */
const ticketStatus = (ticketId) =>
  psqlScalar(`SELECT status FROM service_tickets WHERE id = ${ticketId}`);

/** 当前 ASSIGNED 的 Visit（提交前取，用于后续断言） */
const activeVisitId = (ticketId) =>
  Number(
    psqlScalar(
      `SELECT id FROM service_visits WHERE ticket_id = ${ticketId} AND visit_status='ASSIGNED'` +
        ` ORDER BY visit_no DESC LIMIT 1`,
    ),
  );

/** Visit 的关键字段（一次性读出，避免多次往返之间状态漂移） */
function visitFacts(visitId) {
  // ⚠️ 分隔符用 `chr(1)` 而不是 '|'：`service_note` 是师傅自由输入的文本，
  //    含一个竖线就会把这行切成 9 段，于是 `amount` 读到 note 的碎片 ——
  //    断言会以"金额不对"的形式报出来，而真实原因是**取证代码自己的分隔符**。
  const sep = 'chr(1)';
  const r = psqlScalar(
    `SELECT visit_status || ${sep} || store_confirm_status || ${sep} ||` +
      ` coalesce(service_result,'-') || ${sep} || coalesce(service_note,'-') || ${sep} ||` +
      ` is_charged::text || ${sep} || coalesce(reported_charge_amount::text,'-') || ${sep} ||` +
      ` (token_used_at IS NOT NULL)::text || ${sep} || coalesce(submitted_at::text,'-')` +
      ` FROM service_visits WHERE id = ${visitId}`,
  );
  const [visit_status, confirm, result, note, charged, amount, used, submittedAt] =
    r.split('');
  return { visit_status, confirm, result, note, charged, amount, used, submittedAt };
}

// ---------------------------------------------------------------------------
// R1 用的触发器
// ---------------------------------------------------------------------------

function installFailTrigger() {
  const r = psqlExec(
    `CREATE OR REPLACE FUNCTION ${FAIL_FUNCTION}() RETURNS trigger AS $fn$` +
      ` BEGIN` +
      `   IF NEW.status = 'WAIT_STORE_CONFIRM' AND OLD.status = 'PROCESSING' THEN` +
      `     RAISE EXCEPTION 'p51 reverse test: forced ticket update failure';` +
      `   END IF;` +
      `   RETURN NEW;` +
      ` END; $fn$ LANGUAGE plpgsql;` +
      ` CREATE TRIGGER ${FAIL_TRIGGER}` +
      `   BEFORE UPDATE ON service_tickets FOR EACH ROW` +
      `   EXECUTE FUNCTION ${FAIL_FUNCTION}();`,
  );
  assert(r.ok, `装触发器失败：${r.out}`);
}

function dropFailTrigger() {
  const r = psqlExec(
    `DROP TRIGGER IF EXISTS ${FAIL_TRIGGER} ON service_tickets;` +
      ` DROP FUNCTION IF EXISTS ${FAIL_FUNCTION}();`,
  );
  assert(r.ok, `卸触发器失败：${r.out}（**请手工检查 service_tickets 上是否还有残留触发器**）`);
  // 反向确认真的卸掉了：残留会让后续所有 submit 假红，且现象与产品缺陷难以区分
  const left = Number(
    psqlScalar(
      `SELECT count(*) FROM pg_trigger WHERE tgname = '${FAIL_TRIGGER}' AND NOT tgisinternal`,
    ),
  );
  eq(left, 0, `触发器 ${FAIL_TRIGGER} 残留数`);
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('\n── 夹具：三张一次性工单 ──');
  const { store, hq } = await twoSessions();

  // 取 Token 的前置条件：短信必须走 mock 通道（理由见 harness 的 smsSwitch 注释）
  console.log(`  · 打开 ${SMS_ENABLED_KEY}（原值 ${sms.original}），等待 11s 让配置缓存过期…`);
  await sms.enable();

  const makeFixture = async (tag, content) => {
    const t = await createScratchTicket({ tag, content });
    await acceptAndDispatch(t.ticketId, store);
    const token = (await tokenFromOutbox({ sessionToken: hq, ticketNo: t.ticketNo })).token;
    const visitId = activeVisitId(t.ticketId);
    assert(visitId > 0, `${tag}：派工后找不到 ASSIGNED 的 Visit`);
    console.log(`  · ${tag} ${t.ticketNo}（id=${t.ticketId}，visit=${visitId}）`);
    return { ...t, token, visitId };
  };

  const f1 = await makeFixture('P5-1-SUB-A', '提交契约主单（校验矩阵 + 成功 + 重放）');
  fixtures.t1 = f1.ticketId;
  const f2 = await makeFixture('P5-1-SUB-B', '事务边界反向单（强制 Ticket 更新失败）');
  fixtures.t2 = f2.ticketId;
  const f3 = await makeFixture('P5-1-SUB-C', '未收费残留金额单');
  fixtures.t3 = f3.ticketId;

  // =========================================================================
  // 矩阵 P —— 照片下限（至少 1 张，服务端权威校验）
  // =========================================================================
  console.log('\n── P 照片下限（至少 1 张）──');

  // 拒绝矩阵的基准（进入 P/V 之前取，见 V5）
  const baselineEvents = eventCount(f1.ticketId);

  const VALID_BODY = {
    service_result: 'resolved',
    service_note: '已更换排水泵并试机 30 分钟，无异常',
    is_charged: true,
    reported_charge_amount: 128.5,
  };

  /**
   * 打一次应当被拒的提交，并断言 Token 未被消耗。
   *
   * **前置守卫用库里的事实，而不是一次 HTTP GET。**
   * 为什么：每格 2 次 HTTP 会把脚本推过 nginx 的突发额度（见 `paced` 的注释），
   * 于是每一格都要退避等待，脚本被自己的取证动作拖慢。
   * 而"Token 还活着"的定义就是 `visit_status='ASSIGNED' AND token_used_at IS NULL` ——
   * 直接读库更快、更准，而且**不会因为限流而误判**。
   * HTTP 层的"链接确实还能打开"留到 V5 末尾统一验一次（那次是真实请求）。
   *
   * ⚠️ 这个守卫不能省：一旦前面某一格"本应被拒却成功了"，Token 会被消耗，
   *    于是**后面每一格都变成 401**，报出来的是"金额缺失却回 401"这种
   *    完全指向错方向的失败信息，而真凶在第一格。P5-1 首次运行就被这样误导过一轮。
   */
  const expectRejected = async (label, body, expectedCode) => {
    const guard = visitFacts(f1.visitId);
    eq(
      `${guard.visit_status}/${guard.used}`,
      'ASSIGNED/false',
      `${label} 的前置：Visit 已被前面某一格推进（那格本应被拒却成功了）`,
    );
    const r = await pSubmit(f1.token, body);
    eq(r.status, 422, `${label} 的 HTTP（${errorMessageOf(r)}）`);
    eq(r.json?.errors?.[0]?.code, expectedCode, `${label} 的错误码`);
    return `${expectedCode} 422`;
  };

  const photoCountOf = (visitId) =>
    Number(psqlScalar(`SELECT count(*) FROM service_visit_photos WHERE visit_id = ${visitId}`));

  const jpegBytes = ensureFixtureJpeg();

  await checkAsync('P1 0 张照片 submit → 422 PHOTO_REQUIRED，且 Token 未被消耗', async () => {
    eq(photoCountOf(f1.visitId), 0, '前置：夹具尚未上传任何照片');
    await expectRejected('0 张照片', VALID_BODY, 'PHOTO_REQUIRED');
    return '0 张 → 422 PHOTO_REQUIRED；Token 未消耗';
  });

  await checkAsync('P2 上传 1 张 → 失效到 0 张 → submit 仍被服务端拒绝（用户点名路径）', async () => {
    const up = await pUpload(f1.token, jpegBytes, { filename: 'onsite.jpg' });
    eq(up.status, 201, `上传 HTTP（${errorMessageOf(up)}）`);
    eq(photoCountOf(f1.visitId), 1, '上传后的照片行数');

    // "删除/失效至 0 张"：本阶段没有删除照片的对外接口，
    // 直接删库行模拟最坏情况（比模拟前端更狠：绕过一切页面状态看服务端认不认账）。
    // ⚠️ 先取 storage_key 再删行，随后把磁盘文件一起清掉 —— 不然 cleanupTicket
    //    按 storage_key 找不到行，会留下孤儿文件（UAT 洁净基线被污染）。
    const keys = psqlRows(
      `SELECT storage_key FROM service_visit_photos WHERE visit_id = ${f1.visitId}`,
    ).map((r) => String(r[0]));
    psqlExec(`DELETE FROM service_visit_photos WHERE visit_id = ${f1.visitId}`);
    eq(photoCountOf(f1.visitId), 0, '失效后的照片行数');

    await expectRejected('失效到 0 张', VALID_BODY, 'PHOTO_REQUIRED');

    // 补回 1 张：证明"被拒之后补照片"是可恢复路径；矩阵 A 继续用这条 Visit
    const reup = await pUpload(f1.token, jpegBytes, { filename: 'onsite2.jpg' });
    eq(reup.status, 201, `补传 HTTP（${errorMessageOf(reup)}）`);
    eq(photoCountOf(f1.visitId), 1, '补传后的照片行数');

    // 清理被"失效"掉的那批文件（此时已与库行无关，只能在这里删）
    for (const key of keys) {
      if (/^visits\/\d+\/\d{6}\/[0-9a-f]{48}\.(jpg|png|webp)$/.test(key)) {
        inApp(`rm -f ${PRIVATE_DIR}/${key}`);
      }
    }
    return '1 张 → 失效到 0 张 → 422 PHOTO_REQUIRED；补回 1 张后恢复';
  });

  await checkAsync('P3 防御性上限兜底：photo_max_count 临时降到 0 → 已有 1 张也被拒', async () => {
    // 正常路径的上限由上传时 PhotoService 把守（上传矩阵 B8 验过第 7 张 422）。
    // submit 侧的 `photoCount > maxPhotos` 是给"后台把上限调小"这类绕过场景兜底的
    // —— 兜底分支也必须有反向验证，不然它坏了也永远没人知道。
    const key = 'visit.photo_max_count';
    const original = psqlScalar(`SELECT value FROM service_settings WHERE key='${key}'`);
    assert(original !== '', `取不到 ${key} 的当前值`);
    try {
      psqlExec(`UPDATE service_settings SET value='0' WHERE key='${key}';`);
      // 等过 ConfigService 的 10s 缓存 TTL（理由同 smsSwitch / B10）
      await new Promise((r) => setTimeout(r, 11_000));
      await expectRejected('上限降为 0', VALID_BODY, 'PHOTO_LIMIT_REACHED');
    } finally {
      // ⚠️ 无条件恢复：改的是产品参数
      psqlExec(`UPDATE service_settings SET value='${original}' WHERE key='${key}';`);
      const now = psqlScalar(`SELECT value FROM service_settings WHERE key='${key}'`);
      assert(now === original, `${key} 未恢复，请手工设为 '${original}'（当前 '${now}'）`);
      // submit 自身也读 maxPhotos —— 恢复后必须等缓存过期，后续矩阵 A 才能正常提交
      await new Promise((r) => setTimeout(r, 11_000));
    }
    return `上限=0 → 422 PHOTO_LIMIT_REACHED；已恢复为 '${original}'`;
  });

  // =========================================================================
  // 矩阵 V —— 入参契约
  // =========================================================================
  console.log('\n── V 入参契约（每次拒绝后 Token 必须仍然可用）──');

  await checkAsync('V1 service_result 缺失 / 空 / 非法 → 422 INVALID_SERVICE_RESULT', async () => {
    const details = [];
    details.push(await expectRejected('缺失', { ...VALID_BODY, service_result: undefined }, 'INVALID_SERVICE_RESULT'));
    details.push(await expectRejected('空串', { ...VALID_BODY, service_result: '' }, 'INVALID_SERVICE_RESULT'));
    details.push(await expectRejected('非法值', { ...VALID_BODY, service_result: 'done' }, 'INVALID_SERVICE_RESULT'));
    // 大小写/空格不做"容错"：`RESOLVED` 与 `resolved` 是两个值，
    // 静默归一化会让枚举校验形同虚设
    details.push(await expectRejected('大小写不同', { ...VALID_BODY, service_result: 'RESOLVED' }, 'INVALID_SERVICE_RESULT'));
    return `4 种非法 service_result 全拒；Token 未消耗`;
  });

  await checkAsync('V2 service_note 缺失 / 纯空白 / 超 500 字 → 422', async () => {
    const details = [];
    details.push(await expectRejected('缺失', { ...VALID_BODY, service_note: undefined }, 'MISSING_SERVICE_NOTE'));
    details.push(await expectRejected('纯空白', { ...VALID_BODY, service_note: '   \t\n  ' }, 'MISSING_SERVICE_NOTE'));
    details.push(
      await expectRejected('超长', { ...VALID_BODY, service_note: '啊'.repeat(501) }, 'SERVICE_NOTE_TOO_LONG'),
    );
    // 边界：恰好 500 字应当**通过**（这一格不在这里做，留到 A1 用正常文案）
    return `3 种非法 service_note 全拒（含"纯空白"这种最容易漏的）`;
  });

  await checkAsync('V3 is_charged 缺失 / 数字 0 / 无法辨识的串 → 422', async () => {
    await expectRejected('缺失', { ...VALID_BODY, is_charged: undefined }, 'INVALID_IS_CHARGED');
    await expectRejected('null', { ...VALID_BODY, is_charged: null }, 'INVALID_IS_CHARGED');
    await expectRejected('数字 0', { ...VALID_BODY, is_charged: 0 }, 'INVALID_IS_CHARGED');
    await expectRejected("串 'yes'", { ...VALID_BODY, is_charged: 'yes' }, 'INVALID_IS_CHARGED');
    // ⚠️ 注意：字符串 `'true'` / `'false'` **是刻意容忍的**（表单编码会这么传），
    //    所以它们不在这条 422 矩阵里 —— 它们要验的是"语义没被翻转"，
    //    见 A4（`'false'` 必须落成 false，而 `Boolean('false') === true` 正是那个陷阱）。
    return `4 种非法 is_charged 全拒`;
  });

  await checkAsync('V4 收费金额：缺失 / 0 / 负 / 超上界 / 三位小数 → 422', async () => {
    await expectRejected('缺金额', { ...VALID_BODY, reported_charge_amount: undefined }, 'MISSING_CHARGE_AMOUNT');
    await expectRejected('空串', { ...VALID_BODY, reported_charge_amount: '' }, 'MISSING_CHARGE_AMOUNT');
    await expectRejected('非数字', { ...VALID_BODY, reported_charge_amount: 'abc' }, 'MISSING_CHARGE_AMOUNT');
    await expectRejected('零', { ...VALID_BODY, reported_charge_amount: 0 }, 'INVALID_CHARGE_AMOUNT');
    await expectRejected('负数', { ...VALID_BODY, reported_charge_amount: -1 }, 'INVALID_CHARGE_AMOUNT');
    await expectRejected(
      '超上界',
      { ...VALID_BODY, reported_charge_amount: 1000000 },
      'CHARGE_AMOUNT_TOO_LARGE',
    );
    // 三位小数：numeric(12,2) 会**静默四舍五入**，于是回执写 30.005、库里是 30.01
    await expectRejected('三位小数', { ...VALID_BODY, reported_charge_amount: 30.005 }, 'CHARGE_AMOUNT_PRECISION');
    return `7 种非法金额全拒（含 numeric(12,2) 静默舍入这一格）`;
  });

  await checkAsync('V5 全部拒绝之后：Visit 一字未改、Ticket 仍在 PROCESSING、事件数不变', async () => {
    const facts = visitFacts(f1.visitId);
    eq(facts.visit_status, 'ASSIGNED', 'Visit 状态');
    eq(facts.used, 'false', 'token_used_at');
    eq(facts.submittedAt, '-', 'submitted_at');
    eq(facts.result, '-', 'service_result（拒绝不得留下半截回执）');
    eq(facts.amount, '-', 'reported_charge_amount');
    eq(ticketStatus(f1.ticketId), 'PROCESSING', 'Ticket 状态');
    // 基准取"进入矩阵 V 之前"的快照，**不硬编码条数** —— 建单/受理/派工各记什么
    // 事件是 Phase 2~4 的契约，这里只关心"拒绝有没有新增"，别把两件事焊在一起
    eq(eventCount(f1.ticketId), baselineEvents, '事件数（拒绝不得产生事件）');

    // 最后用**一次真实 HTTP GET** 证明"链接确实还能打开"（前面每一格只查了库，见 expectRejected）
    const alive = await pGet(f1.token);
    eq(alive.status, 200, '全部拒绝之后，同一链接仍应能正常打开（拒绝不能作废链接）');
    eq(String(alive.json?.data?.visit_status), 'ASSIGNED', 'GET 回的 visit_status');
    return `${baselineEvents} 条事件未变；Visit/Ticket 原样；链接仍可打开`;
  });

  // =========================================================================
  // 矩阵 A —— 成功提交的原子性
  // =========================================================================
  console.log('\n── A 成功提交：四样必须一起变 ──');

  let beforeVisits = [];
  let beforeEvents = 0;
  let beforeTicket = '';
  let submitRes = null;

  await checkAsync('A1 提交成功 → Visit SUBMITTED / Token 消费 / Ticket WAIT_STORE_CONFIRM / 事件 +1', async () => {
    beforeVisits = visitRows(f1.ticketId);
    beforeEvents = eventCount(f1.ticketId);
    beforeTicket = ticketSnapshot(f1.ticketId);

    submitRes = await pSubmit(f1.token, VALID_BODY);
    eq(submitRes.status, 200, `提交 HTTP（${errorMessageOf(submitRes)}）`);

    const d = submitRes.json?.data ?? {};
    eq(String(d.ticket_no), f1.ticketNo, '响应里的工单号');
    eq(String(d.status), 'WAIT_STORE_CONFIRM', '响应里的 Ticket 状态');
    eq(String(d.visit_status), 'SUBMITTED', '响应里的 Visit 状态');
    eq(String(d.store_confirm_status), 'pending', '响应里的门店确认状态（待确认）');
    assert(Boolean(d.submitted_at), '响应缺 submitted_at');

    // ---- 库里回读（不信接口回显）----
    const facts = visitFacts(f1.visitId);
    eq(facts.visit_status, 'SUBMITTED', '库里 Visit 状态');
    eq(facts.result, 'resolved', '库里 service_result');
    eq(facts.note, VALID_BODY.service_note, '库里 service_note');
    eq(facts.charged, 'true', '库里 is_charged');
    eq(facts.amount, '128.50', '库里 reported_charge_amount（numeric(12,2) 两位）');
    eq(facts.used, 'true', '库里 token_used_at 已置');
    eq(facts.confirm, 'pending', '库里 store_confirm_status');
    eq(ticketStatus(f1.ticketId), 'WAIT_STORE_CONFIRM', '库里 Ticket 状态');
    eq(eventCount(f1.ticketId), beforeEvents + 1, '事件数 +1');

    const events = eventRows(f1.ticketId);
    const last = events[events.length - 1];
    eq(last[0], 'technician_submitted', '事件类型');
    eq(last[1], 'PROCESSING', '事件的 from_status');
    eq(last[2], 'WAIT_STORE_CONFIRM', '事件的 to_status');
    eq(Number(last[3]), f1.visitId, '事件关联的 visit_id');
    assert(/已解决/.test(last[4]), `事件摘要应含中文处理结果：${last[4]}`);
    // 照片下限的正向面：带 1 张提交成功，计数如实进事件 metadata
    // （与上传矩阵 B9b 的"6 张"合起来钉住 1 和 6 两个边界）
    const meta = psqlScalar(
      `SELECT metadata_json::text FROM ticket_events WHERE ticket_id = ${f1.ticketId}` +
        ` AND event_type = 'technician_submitted' ORDER BY id DESC LIMIT 1`,
    );
    assert(
      meta.includes('"photo_count": 1') || meta.includes('"photo_count":1'),
      `事件 metadata 缺 photo_count=1：${meta}`,
    );
    return `Visit=${facts.visit_status} · Token used=${facts.used} · Ticket=WAIT_STORE_CONFIRM · 事件 ${beforeEvents}→${beforeEvents + 1}`;
  });

  await checkAsync('A2 提交前后数据库快照（逐字段对比，供人工核对）', async () => {
    assert(beforeVisits.length > 0 && beforeTicket !== '', '前提：A1 必须已取到 before 快照');
    const afterVisits = visitRows(f1.ticketId);

    console.log('    ┌─ Visit 快照（id | visit_no | 状态 | 确认状态 | result | note | charged | 金额 | token_used | revoked | submitted_at）');
    console.log(`    │ before: ${beforeVisits.join('  //  ')}`);
    console.log(`    │ after : ${afterVisits.join('  //  ')}`);
    console.log(`    └─ Ticket: before=[${beforeTicket}] after=[${ticketSnapshot(f1.ticketId)}]`);

    eq(afterVisits.length, beforeVisits.length, 'Visit 行数（提交不得新增 Visit）');
    // 同一支 Visit 的 id/visit_no 不许变（变了就是"新建了一支 Visit"这种最坏的实现）
    eq(afterVisits[0].split(' | ')[0], beforeVisits[0].split(' | ')[0], 'Visit id 未变');
    assert(afterVisits[0] !== beforeVisits[0], '快照应当有变化（否则 A1 没真的写库）');
    assert(
      /ASSIGNED/.test(beforeVisits[0]) && /SUBMITTED/.test(afterVisits[0]),
      '快照里应能看到 ASSIGNED → SUBMITTED',
    );
    return `${beforeVisits.length} 支 Visit 原地推进，无新增`;
  });

  await checkAsync('A3 终态文案不含"完成"（师傅提交 ≠ 工单完成）', async () => {
    const msg = String(submitRes?.json?.data?.message ?? '');
    assert(msg.length > 0, '响应缺 message');
    assert(!/完成/.test(msg), `终态文案出现了"完成"：${msg} —— 会让师傅以为闭环了`);
    assert(/门店确认/.test(msg), `终态文案应指向"等待门店确认"：${msg}`);
    // 顺带钉住本阶段**不该**出现的后续状态：出现即说明越界实现了 Phase 6
    for (const forbidden of ['CLOSED', 'WAIT_FEEDBACK', 'confirmed', 'rejected']) {
      assert(
        !String(submitRes?.json?.data?.status ?? '').includes(forbidden),
        `提交后的 Ticket 状态不该是 ${forbidden}（那是 Phase 6 的停止线之后）`,
      );
    }
    return `"${msg}"`;
  });

  await checkAsync("A4 串 'false' 不得被翻转成 true；且不收费时入库金额必须为 NULL", async () => {
    // 这一格同时验两件事，因为它们共用一个成功提交（成功会消耗 Token）：
    //   ① **Boolean() 陷阱**：`Boolean('false') === true`。实现若用 Boolean() 兜底，
    //      师傅选"不收费"会被静默记成"已收费"并索要金额 —— 语义 180° 翻转。
    //      这里传字符串 `'false'`（表单编码的真实形态），必须落成 `false`。
    //   ② **残留金额**：师傅先勾了"收费"填了 300，又改回"不收费"，前端漏删了该字段。
    //      若原样入库，门店会看到"未收费但上报 300 元"这种自相矛盾的回执，
    //      而两个字段各自的校验都是通过的。
    // 照片下限生效后，f3 也要先有 1 张照片才进得了事务（否则 422 PHOTO_REQUIRED）。
    const upF3 = await pUpload(f3.token, ensureFixtureJpeg(), { filename: 'f3.jpg' });
    eq(upF3.status, 201, `f3 预上传 HTTP（${errorMessageOf(upF3)}）`);
    const r = await pSubmit(f3.token, {
      service_result: 'unresolved',
      service_note: '客户不接受报价，本次未收费',
      is_charged: 'false',
      reported_charge_amount: 300,
    });
    eq(r.status, 200, `提交 HTTP（${errorMessageOf(r)}）`);
    const facts = visitFacts(f3.visitId);
    eq(facts.charged, 'false', 'is_charged');
    eq(facts.amount, '-', 'reported_charge_amount 必须是 NULL（不得采纳残留金额）');
    // 事件 metadata 里也必须同步为 null，否则审核侧看到的还是 300
    const meta = psqlScalar(
      `SELECT coalesce(metadata_json->>'reported_charge_amount','NULL') FROM ticket_events` +
        ` WHERE ticket_id = ${f3.ticketId} AND event_type = 'technician_submitted' ORDER BY id DESC LIMIT 1`,
    );
    eq(meta, 'NULL', '事件 metadata 里的 reported_charge_amount');
    return `库与事件 metadata 均为 NULL（请求里带的是 300）`;
  });

  // =========================================================================
  // 矩阵 R2 —— 成功提交后重放（注意：与内部 request-id 幂等是两回事）
  // =========================================================================
  console.log('\n── R 反向测试 ──');

  await checkAsync('R2 成功提交后重放**完全相同**的请求 → 401 TOKEN_INVALID，且不重复落账', async () => {
    const visitsBefore = visitRows(f1.ticketId);
    const eventsBefore = eventCount(f1.ticketId);
    const ticketBefore = ticketSnapshot(f1.ticketId);
    const factsBefore = visitFacts(f1.visitId);

    // 逐字节相同的 body、同一个 Token —— 唯一的差别是"这是第二次"
    const replay = await pSubmit(f1.token, VALID_BODY);
    eq(replay.status, 401, `重放的 HTTP（${errorMessageOf(replay)}）`);
    eq(replay.json?.errors?.[0]?.code, 'TOKEN_INVALID', '重放的错误码');
    // 重放不得改写任何东西
    eq(visitRows(f1.ticketId), visitsBefore, 'Visit 快照（重放不得再写）');
    eq(eventCount(f1.ticketId), eventsBefore, '事件数（不得 +1）');
    eq(ticketSnapshot(f1.ticketId), ticketBefore, 'Ticket 快照');
    eq(visitFacts(f1.visitId).submittedAt, factsBefore.submittedAt, 'submitted_at（不得被刷新）');
    // 与 401 一致的还有：这条链接也不能再上传/读照片了
    const up = await pUpload(f1.token, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
      filename: 'x.jpg',
    });
    eq(up.status, 401, '提交后上传也应 401（入口已整体关闭，不只是 submit）');
    const ph = await pPhoto(f1.token, 'AAAAAAAAAAAAAAAAAAAAAA');
    eq(ph.status, 401, '提交后读照片也应 401');
    return `重放 401；Visit/Event/Ticket/submitted_at 四项全部未变；upload/photo 也一并关闭`;
  });

  // =========================================================================
  // 矩阵 R1 —— 故意让 Ticket 更新失败
  // =========================================================================
  await checkAsync('R1 故意让 Ticket 状态更新失败 → Visit/Token/Event 都不留半落账', async () => {
    const visitsBefore = visitRows(f2.ticketId);
    const eventsBefore = eventCount(f2.ticketId);
    const factsBefore = visitFacts(f2.visitId);

    // 照片下限生效后，f2 也要先有 1 张照片才能走到"强制失败"那一环
    // （否则 422 PHOTO_REQUIRED 会先于事务触发 —— 那测的就是别的了）
    const upF2 = await pUpload(f2.token, ensureFixtureJpeg(), { filename: 'f2.jpg' });
    eq(upF2.status, 201, `f2 预上传 HTTP（${errorMessageOf(upF2)}）`);

    installFailTrigger();
    let forcedStatus = 0;
    let forcedCode = '';
    try {
      const r = await pSubmit(f2.token, {
        service_result: 'need_followup',
        service_note: 'P5-1 事务边界反向测试：本次提交应被强制失败',
        is_charged: false,
      });
      forcedStatus = r.status;
      forcedCode = String(r.json?.errors?.[0]?.code ?? '');
      // 强制失败是**基础设施故障**，5xx 是对的口径（不是 4xx 业务拒绝）
      assert(
        forcedStatus >= 500,
        `强制失败应当表现为 5xx（基础设施故障），实际 ${forcedStatus} ${forcedCode}`,
      );
    } finally {
      dropFailTrigger();
    }

    // ---- 三条判据：任何一条不成立都说明事务没兜住 ----
    const factsAfter = visitFacts(f2.visitId);
    eq(factsAfter.visit_status, 'ASSIGNED', 'Visit 状态（必须回滚到 ASSIGNED）');
    eq(factsAfter.used, 'false', 'token_used_at（必须回滚为空 —— 否则链接被"半消费"）');
    eq(factsAfter.submittedAt, '-', 'submitted_at');
    eq(factsAfter.result, '-', 'service_result（回执字段必须一起回滚）');
    eq(factsAfter.amount, '-', 'reported_charge_amount');
    eq(visitRows(f2.ticketId), visitsBefore, 'Visit 快照整体未变');
    eq(ticketStatus(f2.ticketId), 'PROCESSING', 'Ticket 状态');
    eq(eventCount(f2.ticketId), eventsBefore, '事件数（不得留下半个事件）');

    // ---- 第 4 条判据（最有说服力）：撤掉故障后同一 Token 仍能提交成功 ----
    const retry = await pSubmit(f2.token, {
      service_result: 'need_followup',
      service_note: 'P5-1 事务边界反向测试：撤掉故障后重试（应当成功）',
      is_charged: false,
    });
    eq(retry.status, 200, `撤掉故障后重试的 HTTP（${errorMessageOf(retry)}）`);
    eq(visitFacts(f2.visitId).visit_status, 'SUBMITTED', '重试后 Visit 状态');
    eq(ticketStatus(f2.ticketId), 'WAIT_STORE_CONFIRM', '重试后 Ticket 状态');
    eq(eventCount(f2.ticketId), eventsBefore + 1, '重试后事件数');

    console.log(`    · 强制失败时返回 ${forcedStatus} ${forcedCode}（符合"基础设施故障"口径）`);
    console.log('    · 回滚判据：Visit 仍 ASSIGNED / token_used_at 仍空 / 事件数不变 —— 全部成立');
    console.log('    · 恢复判据：撤掉触发器后**同一 Token** 提交成功（证明链接没被半消费）');
    return `强制 ${forcedStatus} → 零半落账 → 撤障后同一 Token 重试成功`;
  });

  // =========================================================================
  // 收尾：如实标记降级项
  // =========================================================================
  summary();
  if (degraded.length) {
    console.log('  🟡 本轮**降级项**（如实标记，未当成通过）：');
    for (const d of degraded) console.log(`     · ${d}`);
    console.log('');
  }
  if (state.failures.length) process.exitCode = 1;
}

await runMain({
  name: 'Submit 契约与事务边界（P5-1）',
  main,
  cleanup: () => {
    // ⚠️ 先卸触发器再清库：留着会污染后续所有 submit（且现象像产品缺陷）
    try {
      dropFailTrigger();
    } catch (error) {
      console.log(`  · ⚠️ 卸触发器时出错：${error.message}`);
    }
    for (const id of [fixtures.t1, fixtures.t2, fixtures.t3]) cleanupTicket(id);
    const back = sms.restore();
    console.log(`  · 短信开关已复位：${back.note}`);
  },
});

if (state.failures.length) process.exit(1);
