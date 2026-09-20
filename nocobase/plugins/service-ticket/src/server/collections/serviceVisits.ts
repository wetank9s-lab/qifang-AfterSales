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
} from './_options';

/**
 * serviceVisits —— 服务回执（一次上门 / 一次处理 = 一条）
 *
 * 设计要点：
 *  1) 一张工单可以有多个 Visit：改派、二次上门、低评分返工、驳回后重做。
 *     **历史永不覆盖**，这是"返工过程可追溯"的基础。
 *  2) 师傅姓名/手机号/预约时间/服务方式在这里是**快照**，
 *     即使后续改派，也能还原"当时是谁上的门"。
 *  3) 师傅 Token 只存 sha256；提交后 token_used_at 置位，立即失效（用后即焚）。
 *  4) 照片挂在 Visit 上（serviceVisitPhotos.visit_id），不挂 Ticket，避免被覆盖。
 *  5) 门店确认状态是 Visit 维度的，不是 Ticket 维度的 —— 所以"驳回"只回退当前 Visit。
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

    // ---------------- 派工快照 ----------------
    enumStr('service_mode', '服务方式', SERVICE_MODE_OPTIONS, { allowNull: false }),
    str('provider_name', '厂家/第三方名称', { length: 64, allowNull: true }),
    str('technician_name', '师傅姓名', {
      length: 32,
      allowNull: false,
      comment: '快照：改派后仍保留当时的师傅',
    }),
    str('technician_mobile', '师傅手机号', { length: 20, allowNull: false }),
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
    enumStr('store_confirm_status', '门店确认状态', STORE_CONFIRM_STATUS_OPTIONS, {
      allowNull: false,
      defaultValue: 'pending',
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
    // 注意：access_token_hash 的唯一性**只由字段级 `unique: true` 声明**（见上方字段定义）。
    // 不要再在这里加 `{ fields: ['access_token_hash'], unique: true }` —— 同列双索引无意义，
    // 字段级生成的是 PG UNIQUE CONSTRAINT（更强）。已清理，见 DEV-17。
  ],
});
