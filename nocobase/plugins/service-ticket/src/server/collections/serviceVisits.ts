import {
  belongsTo,
  bool,
  defineAppCollection,
  enumStr,
  int,
  money,
  str,
  text,
  ts,
} from './_helpers';
import {
  CHARGE_MATCH_OPTIONS,
  SERVICE_MODE_OPTIONS,
  SERVICE_RESULT_OPTIONS,
  STORE_CONFIRM_STATUS_OPTIONS,
  VISIT_STATUS_OPTIONS,
} from './_options';
import { VISIT_STATUS } from '../constants';

/**
 * serviceVisits —— 服务回执（**一次「执行责任的派工尝试」**）
 *
 * 模型口径（Phase 4 用户裁定，这是本表最重要的一条规则）：
 *   ServiceTicket = 一次客户售后事项
 *   ServiceVisit  = 一次"具体执行责任的派工尝试"
 *
 *   **只要执行责任人发生变化，就产生新的 Visit，绝不修改旧 Visit 的师傅身份。**
 *   于是"历史不可覆盖"是**数据模型**保证的（旧行原样留存），而不是靠程序员自觉。
 *
 *   判据：责任主体 = `technician_mobile` + `provider_name` + `service_mode`。
 *   **姓名不在此列** —— 只纠正姓名错别字（王师付 → 王师傅）而手机号与服务方未变，
 *   属同一责任主体，可就地修改但必须写 `metadata_corrected` 事件留痕。
 *
 * 由此推出三条后果（Phase 4 实现必须遵守）：
 *   · `dispatch`（首次派工）→ 新建 Visit #1
 *   · `reassign`（改派）    → 旧 Visit → SUPERSEDED（**原样保留**）+ 新建 Visit #2
 *   · `reschedule`（改约）  → **不新建** Visit，只改 `expected_visit_at`（责任人没变）
 *
 * 设计要点（延续 Phase 2 并新增 Phase 4 部分）：
 *  1) 一张工单可以有多个 Visit：改派、二次上门、低评分返工、驳回后重做。
 *     **历史永不覆盖**，这是"返工过程可追溯"的基础。
 *  2) 师傅姓名/手机号/预约时间/服务方式在这里是**快照**，
 *     即使后续改派，也能还原"当时是谁上的门"。
 *  3) 师傅 Token 只存 sha256；提交后 token_used_at 置位，立即失效（用后即焚）。
 *  4) 照片挂在 Visit 上（serviceVisitPhotos.visit_id），不挂 Ticket，避免被覆盖。
 *  5) `visit_status` 是 Visit 生命周期的**唯一事实来源**（Phase 4-A 起）。
 *     原 `store_confirm_status` **降级为派生字段**，仅为兼容历史数据与既有断言保留，
 *     两者不得各自推进（映射表见 constants.ts 的 VISIT_STATUS_TO_CONFIRM_STATUS）。
 */
export default defineAppCollection({
  name: 'serviceVisits',
  title: '服务回执',
  fields: [
    belongsTo('ticket', '所属工单', 'serviceTickets', 'ticket_id', {
      allowNull: false,
    }),
    int('visit_no', '第几次上门', {
      allowNull: false,
      comment: '从 1 递增，事务内 max+1 取号，unique(ticket_id, visit_no) 兜底',
    }),

    // ---------------- 生命周期（Phase 4-A 新增） ----------------
    enumStr('visit_status', '派工状态', VISIT_STATUS_OPTIONS, {
      allowNull: false,
      defaultValue: VISIT_STATUS.ASSIGNED,
      comment:
        'Visit 生命周期的唯一事实来源：ASSIGNED/SUBMITTED/CONFIRMED/REJECTED/SUPERSEDED/CANCELLED',
    }),
    ts('assigned_at', '派工时间', {
      allowNull: true,
      comment: '本次派工产生的时刻；改派时新 Visit 重新计时，旧 Visit 保留原值',
    }),
    /**
     * 被改派取代 —— 这条 Visit 的历史到此为止。
     *
     * 为什么需要 self-FK 而不是只靠事件：后台要把 Visit 串成
     * 「Visit #1 → 改派 → Visit #2 → 改派 → Visit #3」的链，
     * 有这列就能一次查询画出链条；只靠事件则需要按时间正序做文本匹配。
     */
    belongsTo('reassigned_from', '前序派工', 'serviceVisits', 'reassigned_from_visit_id', {
      allowNull: true,
      comment: '改派时指向被取代的那条 Visit；首次派工为空。自引用外键',
    }),
    ts('superseded_at', '被取代时间', {
      allowNull: true,
      comment: '仅 visit_status=SUPERSEDED 时有值',
    }),
    text('superseded_reason', '被取代原因', {
      allowNull: true,
      comment: '改派必填原因；此处冗余一份，便于只读 Visit 表时也能看到原因',
    }),

    // ---------------- 派工快照 ----------------
    enumStr('service_mode', '服务方式', SERVICE_MODE_OPTIONS, { allowNull: false }),
    str('provider_name', '厂家/第三方名称', { length: 64, allowNull: true }),
    str('technician_name', '师傅姓名', {
      length: 32,
      allowNull: false,
      comment:
        '快照：改派后仍保留当时的师傅（改派新建 Visit，不覆盖本行）。' +
        '姓名是唯一允许在原 Visit 上就地纠正的责任字段，且必须写 metadata_corrected 事件',
    }),
    str('technician_mobile', '师傅手机号', {
      length: 20,
      allowNull: false,
      comment: '责任主体判据之一：本字段变化 = 必须走 reassign（新建 Visit），不得就地改',
    }),
    ts('expected_visit_at', '预计上门时间', { allowNull: false }),

    // ---------------- 师傅 Token（只存哈希） ----------------
    str('access_token_hash', '师傅Token哈希', {
      length: 64,
      allowNull: true,
      unique: true,
      comment: 'sha256(base64url token)；remote 模式为空',
    }),
    ts('token_expires_at', 'Token到期时间', { allowNull: true }),
    ts('token_used_at', 'Token使用时间', {
      allowNull: true,
      comment: '提交回执后置位 → 同一 Token 无法二次提交或上传',
    }),
    /**
     * Token 被**主动吊销**的时刻与原因（改派 / 改约重新签发）。
     *
     * 为什么不直接复用 `token_expires_at = now()`：
     *   "过期"与"被吊销"在排障时是完全不同的两件事 ——
     *   师傅打不开链接，客服需要能回答"是你自己被改派了"还是"链接放太久了"。
     *   把原因写下来，这条工单的支持成本从"猜"变成"看一眼"。
     */
    ts('token_revoked_at', 'Token吊销时间', { allowNull: true }),
    str('token_revoked_reason', 'Token吊销原因', {
      length: 64,
      allowNull: true,
      comment: '如 reassigned / rescheduled；与 token_revoked_at 同生同灭',
    }),
    bool('is_remote', '远程处理', {
      allowNull: false,
      defaultValue: false,
      comment: 'service_mode=remote 时为 true，不生成 Token',
    }),

    // ---------------- 师傅填报 ----------------
    enumStr('service_result', '服务结果', SERVICE_RESULT_OPTIONS, { allowNull: true }),
    text('service_note', '处理说明', {
      allowNull: true,
      comment: '提交回执时必填（校验在 DTO/Service 层）',
    }),
    bool('is_charged', '是否收费', {
      allowNull: true,
      defaultValue: false,
      comment: 'true 时 reported_charge_amount 必须 > 0，false 时必须 = 0',
    }),
    money('reported_charge_amount', '师傅填报金额', {
      allowNull: true,
      comment: '师傅上报的收费金额',
    }),
    money('confirmed_charge_amount', '门店确认金额', {
      allowNull: true,
      comment: '门店确认后的最终金额；与填报不一致时必须填原因',
    }),
    ts('submitted_at', '师傅提交时间', { allowNull: true }),

    // ---------------- 门店确认 ----------------
    enumStr('store_confirm_status', '门店确认状态（派生）', STORE_CONFIRM_STATUS_OPTIONS, {
      allowNull: false,
      defaultValue: 'pending',
      comment:
        '⚠️ Phase 4-A 起降级为 visit_status 的派生字段，仅为兼容历史数据与既有断言保留。' +
        '写入必须经 VISIT_STATUS_TO_CONFIRM_STATUS 映射，禁止两套状态各自推进',
    }),
    text('store_confirm_note', '驳回/改额原因', {
      allowNull: true,
      comment: '驳回必填；金额调整必填',
    }),
    belongsTo('store_confirmer', '确认人', 'users', 'store_confirmed_by', {
      allowNull: true,
    }),
    ts('store_confirmed_at', '确认时间', { allowNull: true }),

    // ---------------- 客户反馈的收费一致性 ----------------
    enumStr('customer_charge_match', '收费一致性', CHARGE_MATCH_OPTIONS, {
      allowNull: true,
      comment: 'mismatch 会触发工单自动重开（即使评分很高）',
    }),
    money('customer_reported_amount', '客户实付金额', { allowNull: true }),
    text('charge_diff_reason', '收费差异说明', { allowNull: true }),
  ],
  indexes: [
    { fields: ['ticket_id'] },
    // 同一工单内 visit_no 唯一：并发取号的最后一道防线
    { fields: ['ticket_id', 'visit_no'], unique: true },
    { fields: ['technician_mobile'] },
    { fields: ['store_confirm_status'] },
    // Phase 4-A 新增：后台"当前派工"与"历史派工"的查询都按它过滤
    { fields: ['visit_status'] },
    // 注意：access_token_hash 的唯一性**只由字段级 `unique: true` 声明**（见上方字段定义）。
    // 不要再在这里加 `{ fields: ['access_token_hash'], unique: true }` —— 同列双索引无意义，
    // 字段级生成的是 PG UNIQUE CONSTRAINT（更强）。已清理，见 DEV-17。
  ],
});
