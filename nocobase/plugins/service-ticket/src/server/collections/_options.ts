/**
 * 枚举下拉选项（label/value 形式），集中从 constants.ts 派生。
 *
 * 这样做的意义：枚举只在一处定义（constants.ts），
 * collection 的 UI 下拉、DTO 校验、状态机判断全部引用同一份数据源，
 * 不会出现"后台下拉多了一个值但状态机不认"的情况。
 */
import {
  CHARGE_MATCH_VALUES,
  COMPLETION_RESULT_VALUES,
  EVENT_TYPE_LABEL,
  EVENT_TYPE_VALUES,
  GUARD_SCOPE_VALUES,
  OPERATOR_KIND_LABEL,
  OPERATOR_KIND_VALUES,
  PHOTO_TYPE_LABEL,
  PHOTO_TYPE_VALUES,
  REVIEW_STATUS_VALUES,
  SERVICE_MODE_VALUES,
  SERVICE_RESULT_LABEL,
  SERVICE_RESULT_VALUES,
  SMS_DELIVERY_STATUS_VALUES,
  SMS_SCENE_VALUES,
  SMS_SEND_STATUS_VALUES,
  STORE_CONFIRM_STATUS_VALUES,
  TICKET_SOURCE_VALUES,
  TICKET_STATUS_LABEL,
  TICKET_STATUS_VALUES,
  TICKET_TYPE_VALUES,
  VISIT_STATUS_LABEL,
  VISIT_STATUS_VALUES,
  type TicketStatus,
  type VisitStatus,
} from '../constants';

const plain = (values: readonly string[]) => values.map((value) => ({ label: value, value }));

export const TICKET_STATUS_OPTIONS = TICKET_STATUS_VALUES.map((value) => ({
  label: TICKET_STATUS_LABEL[value as TicketStatus],
  value,
}));

export const TICKET_TYPE_OPTIONS = [
  { label: '报修', value: 'repair' },
  { label: '投诉', value: 'complaint' },
];

export const TICKET_SOURCE_OPTIONS = [
  { label: '扫码', value: 'qr' },
  { label: '链接', value: 'link' },
  { label: '店员代提', value: 'staff' },
];

export const SERVICE_MODE_OPTIONS = [
  { label: '门店自有', value: 'inhouse' },
  { label: '厂家服务', value: 'manufacturer' },
  { label: '第三方', value: 'third_party' },
  { label: '远程指导', value: 'remote' },
];

export const COMPLETION_RESULT_OPTIONS = [
  { label: '已解决', value: 'resolved' },
  { label: '未解决', value: 'unresolved' },
  { label: '转其他方处理', value: 'referred' },
  { label: '客户取消', value: 'customer_cancelled' },
  { label: '其他', value: 'other' },
];

/**
 * ⚠️ P5-1：`service_result` 与 `photo_type` 的选项**改为从 constants 的标签表派生**。
 *
 * 理由与上面 operator_kind / event_type 那段完全一样（同一类问题的第二次）：
 * 一旦标签在两处各写一份，`technician_submit` 事件摘要里会出现与用户
 * 在下拉里看到的**不一样**的中文，而两边各自的测试都不会发现 ——
 * 因为它们测的是"自己那一份对不对"。
 * 派生之后，值的集合与顺序仍由 `*_VALUES` / 标签表的键顺序决定，
 * 与原来的手写数组逐项一致（`verify-technician-upload.mjs` 有一条断言盯着）。
 */
export const SERVICE_RESULT_OPTIONS = Object.entries(SERVICE_RESULT_LABEL).map(([value, label]) => ({
  label,
  value,
}));

export const STORE_CONFIRM_STATUS_OPTIONS = [
  { label: '待确认', value: 'pending' },
  { label: '已确认', value: 'confirmed' },
  { label: '已驳回', value: 'rejected' },
];

/**
 * Visit 生命周期下拉（Phase 4-A）。
 *
 * label 取自 constants.ts 的 VISIT_STATUS_LABEL —— 单一事实来源，
 * 避免出现"后台下拉写 已派工、状态机写 ASSIGNED"这类口径分叉。
 */
export const VISIT_STATUS_OPTIONS = VISIT_STATUS_VALUES.map((value) => ({
  label: VISIT_STATUS_LABEL[value as VisitStatus],
  value,
}));

export const REVIEW_STATUS_OPTIONS = [
  { label: '待评价', value: 'pending' },
  { label: '已评价', value: 'submitted' },
  { label: '已超时', value: 'expired' },
];

export const CHARGE_MATCH_OPTIONS = [
  { label: '一致', value: 'match' },
  { label: '不一致', value: 'mismatch' },
  { label: '不涉及收费', value: 'not_applicable' },
];

export const PHOTO_TYPE_OPTIONS = Object.entries(PHOTO_TYPE_LABEL).map(([value, label]) => ({
  label,
  value,
}));

/**
 * ⚠️ Phase 4-I 第二轮：`operator_kind` 与 `event_type` 的选项**改为从
 *    `constants.ts` 的中文标签表派生**，不再各写一份。
 *
 * 此前 `event_type` 走的是 `plain(EVENT_TYPE_VALUES)` —— label 就是英文枚举值，
 * 于是后台事件列表显示 `reassigned` 这种**只有开发看得懂**的字符串。
 * 现在后台与详情抽屉时间线共用同一张 `EVENT_TYPE_LABEL`，
 * 「界面中文」这件事不会再出现两份实现（一份改了另一份没改）。
 */
export const OPERATOR_KIND_OPTIONS = OPERATOR_KIND_VALUES.map((value) => ({
  label: OPERATOR_KIND_LABEL[value] ?? value,
  value,
}));

export const EVENT_TYPE_OPTIONS = EVENT_TYPE_VALUES.map((value) => ({
  label: EVENT_TYPE_LABEL[value] ?? value,
  value,
}));

// ⚠️ 以下仍是 `plain()`（label = 枚举值本身），即后台里显示英文。
//    它们是**支撑表的内部状态**（短信场景/发送状态/防刷作用域），
//    与一线售后人员的日常操作无关，本轮**刻意不动**（不扩需求）。
//    已登记进 UX backlog：若总部以后要直接用短信日志表排查，再补中文标签。
export const SMS_SCENE_OPTIONS = plain(SMS_SCENE_VALUES);
export const SMS_SEND_STATUS_OPTIONS = plain(SMS_SEND_STATUS_VALUES);
export const SMS_DELIVERY_STATUS_OPTIONS = plain(SMS_DELIVERY_STATUS_VALUES);
export const GUARD_SCOPE_OPTIONS = plain(GUARD_SCOPE_VALUES);

// 以下仅用于"编译期确保常量被引用"，避免 tree-shaking 误删后类型检查失效
export const __OPTION_SOURCE_LENGTHS = {
  charge: CHARGE_MATCH_VALUES.length,
  operator: OPERATOR_KIND_VALUES.length,
  photo: PHOTO_TYPE_VALUES.length,
  review: REVIEW_STATUS_VALUES.length,
  mode: SERVICE_MODE_VALUES.length,
  result: SERVICE_RESULT_VALUES.length,
  source: TICKET_SOURCE_VALUES.length,
  guard: GUARD_SCOPE_VALUES.length,
};
