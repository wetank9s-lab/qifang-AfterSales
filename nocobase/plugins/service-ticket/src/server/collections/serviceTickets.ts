import {
  belongsTo,
  bool,
  CREATED_AT_COLUMN,
  defineAppCollection,
  enumStr,
  int,
  json,
  str,
  text,
  ts,
} from './_helpers';
import {
  CHARGE_MATCH_OPTIONS,
  COMPLETION_RESULT_OPTIONS,
  REVIEW_STATUS_OPTIONS,
  SERVICE_MODE_OPTIONS,
  TICKET_SOURCE_OPTIONS,
  TICKET_STATUS_OPTIONS,
  TICKET_TYPE_OPTIONS,
} from './_options';

/**
 * serviceTickets —— 售后工单（核心表）
 *
 * 三条铁律：
 *  1) `id` 是内部主键，**绝不作为任何匿名访问凭证**（对外只用 ticket_no 与 Token）。
 *  2) `status` 只能由 TicketService 写入，且必须与 TicketEvent 同事务。
 *  3) `source_store_code` 一经写入不再改变；转店只改 `store_id`，
 *     这样"客户是扫哪家店进来的"永远可追溯（M6）。
 *
 * 枚举一律存字符串；下拉与校验共用 constants.ts 的同一份定义。
 */
export default defineAppCollection({
  name: 'serviceTickets',
  title: '售后工单',
  fields: [
    // ---------------- 标识 ----------------
    str('ticket_no', '工单号', {
      length: 24,
      allowNull: false,
      unique: true,
      comment: 'FW + YYYYMMDD + - + 4 位流水，由 dailySequences 原子取号',
    }),

    // ---------------- 门店归属 ----------------
    belongsTo('store', '当前门店', 'stores', 'store_id', {
      allowNull: false,
      comment: '当前负责门店；转店时变更（M6）',
    }),
    str('source_store_code', '来源门店编码', {
      length: 16,
      allowNull: true,
      comment: '入口带入的原始门店编码，转店时保持不变',
    }),

    // ---------------- 客户提交内容 ----------------
    enumStr('source', '来源', TICKET_SOURCE_OPTIONS, {
      allowNull: false,
      defaultValue: 'qr',
    }),
    enumStr('ticket_type', '工单类型', TICKET_TYPE_OPTIONS, { allowNull: false }),
    text('content', '报修/投诉内容', {
      allowNull: false,
      comment: '5–500 字，长度校验在 DTO 层',
    }),
    str('customer_name', '客户姓名', { length: 32, allowNull: true }),
    str('customer_mobile', '客户手机号', {
      length: 20,
      allowNull: false,
      comment: '后台列表默认脱敏展示',
    }),

    // ---------------- 状态 ----------------
    enumStr('status', '状态', TICKET_STATUS_OPTIONS, {
      allowNull: false,
      defaultValue: 'NEW',
      comment: '6 个主状态之一，仅 TicketService 可写',
    }),
    belongsTo('handler', '当前处理人', 'users', 'handler_user_id', {
      allowNull: true,
    }),

    // ---------------- 派工信息（当前最新值） ----------------
    enumStr('service_mode', '服务方式', SERVICE_MODE_OPTIONS, {
      allowNull: true,
      comment: '派工时必填；remote 表示远程指导，不生成师傅 Token',
    }),
    str('provider_name', '厂家/第三方名称', { length: 64, allowNull: true }),
    str('technician_name', '师傅姓名', {
      length: 32,
      allowNull: true,
      comment: '当前最新安排（快照同时写进 serviceVisits）',
    }),
    str('technician_mobile', '师傅手机号', { length: 20, allowNull: true }),
    ts('expected_visit_at', '预计上门时间', { allowNull: true }),
    ts('dispatch_at', '首次派工时间', {
      allowNull: true,
      comment: '仅首次派工写入，不随改派/改约变化（报表口径固定）',
    }),

    // ---------------- 完成信息 ----------------
    enumStr('completion_result', '完成结果', COMPLETION_RESULT_OPTIONS, { allowNull: true }),
    text('completion_note', '完成说明', { allowNull: true }),
    ts('completed_at', '完成时间', { allowNull: true }),

    // ---------------- 客户评价 ----------------
    int('rating', '评分', {
      allowNull: true,
      comment: '1–5，校验在 DTO 层',
    }),
    text('review_comment', '评价内容', { allowNull: true }),
    ts('reviewed_at', '评价时间', { allowNull: true }),
    enumStr('review_status', '评价状态', REVIEW_STATUS_OPTIONS, {
      allowNull: true,
      defaultValue: 'pending',
    }),

    // ---------------- 评价 Token（只存哈希） ----------------
    str('feedback_token_hash', '评价Token哈希', {
      length: 64,
      allowNull: true,
      unique: true,
      comment: 'sha256(base64url token)，明文永不入库',
    }),
    ts('feedback_token_expires_at', '评价Token到期', { allowNull: true }),
    ts('feedback_token_used_at', '评价Token使用时间', {
      allowNull: true,
      comment: '非空即已使用，不可覆盖原评价',
    }),
    belongsTo('feedback_visit', '评价对应上门', 'serviceVisits', 'feedback_visit_id', {
      allowNull: true,
      comment: '多次返工时区分是哪一次上门获得的评价',
    }),

    // ---------------- 异常与重开（用字段表达，不新增状态） ----------------
    bool('escalated', '异常升级', {
      allowNull: false,
      defaultValue: false,
      comment: '低评分或收费不一致时置位，进总部异常看板',
    }),
    int('reopen_count', '重开次数', { allowNull: false, defaultValue: 0 }),
    str('close_reason', '关闭原因', {
      length: 32,
      allowNull: true,
      comment: 'reviewed / review_expired / cancelled / manual',
    }),

    // ---------------- 计时口径 ----------------
    ts('first_response_at', '首次响应时间', {
      allowNull: true,
      comment: '首次 NEW→PROCESSING，用于响应时长统计',
    }),
    ts('closed_at', '关闭时间', { allowNull: true, comment: '闭环口径' }),

    // ---------------- 其他 ----------------
    json('extra_json', '扩展信息', {
      allowNull: true,
      comment: '预留：不进入报表口径的补充字段',
    }),
  ],
  indexes: [
    // 注意：ticket_no 的唯一性**只由字段级 `unique: true` 声明**（见上方字段定义），
    // 不要再在这里加 `{ fields: ['ticket_no'], unique: true }` ——
    // 那会在同一列上再建一个同义索引。字段级 unique 生成的是 PG **UNIQUE CONSTRAINT**
    // （索引名 `<table>_<col>_key`），比 collection 级的裸唯一索引更强，
    // 保留字段级、去掉 collection 级即可。Phase 1 初期两者并存过，已清理（DEV-17）。
    // 门店工单列表默认按状态 Tab 过滤 + 时间倒序
    { fields: ['store_id', 'status'] },
    { fields: ['store_id'] },
    { fields: ['status'] },
    // SLA 扫描：找出应上门但已超期的单
    { fields: ['status', 'expected_visit_at'] },
    // 重复单检测：同手机号 + 同门店 + 同类型 + 时间窗
    { fields: ['customer_mobile'] },
    { fields: ['customer_mobile', 'store_id', 'ticket_type'] },
    // 总部看板时间维度
    // 时间戳列必须用 CREATED_AT_COLUMN（NocoBase 注入 camelCase createdAt）
    { fields: [CREATED_AT_COLUMN] },
    // 总部异常看板
    { fields: ['escalated'] },
    { fields: ['review_status'] },
  ],
});
