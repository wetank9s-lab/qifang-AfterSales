/**
 * 前端字段校验规则 —— 与后端 `actions/public/ticket.ts` 的 parseDto **逐条对齐**。
 *
 * 为什么要在前端重写一遍（而不是"交给后端校验、前端只显示错误"）：
 * 1. 弱网下 422 的往返要好几秒，用户已经填完的表单被退回体验很差；
 * 2. 前端的职责是"尽量不发出必然被拒的请求"，
 *    后端的职责是"任何进来的请求都要自证清白"——两者都要有，不是二选一。
 *
 * ⚠️ 这些常量必须与后端保持一致。后端改了范围而前端没改，
 * 表现是"本地校验通过、提交后被 422 拒绝"，用户完全无法自救。
 * `scripts/verify-phase3-h5.mjs` 会读后端源码里的这些常量做比对断言。
 */
export const CONTENT_MIN = 5;
export const CONTENT_MAX = 500;
export const NAME_MIN = 1;
export const NAME_MAX = 32;

/** 与后端 `seeds/stores.ts` 的 STORE_CODE_PATTERN 一致 */
export const STORE_CODE_PATTERN = /^S\d{2,3}$/;
/** 与后端 `actions/public/ticket.ts` 的 MOBILE_PATTERN 一致 */
export const MOBILE_PATTERN = /^1[3-9]\d{9}$/;

export type FieldName = 'store_code' | 'ticket_type' | 'content' | 'customer_name' | 'customer_mobile';

export interface FieldIssue {
  field: FieldName | 'privacy_agreed';
  message: string;
}

/** 单字段校验；通过返回 null */
export function validateField(field: FieldName, rawValue: string): FieldIssue | null {
  const value = rawValue.trim();
  switch (field) {
    case 'store_code':
      if (!value) return { field, message: '请选择服务门店' };
      if (!STORE_CODE_PATTERN.test(value)) return { field, message: '门店编码格式不正确' };
      return null;
    case 'ticket_type':
      if (value !== 'repair' && value !== 'complaint') return { field, message: '请选择服务类型' };
      return null;
    case 'content':
      if (value.length < CONTENT_MIN) return { field, message: `请至少填写 ${CONTENT_MIN} 个字描述问题` };
      if (value.length > CONTENT_MAX) return { field, message: `描述最多 ${CONTENT_MAX} 个字，当前 ${value.length} 字` };
      return null;
    case 'customer_name':
      if (value.length < NAME_MIN) return { field, message: '请填写联系人姓名' };
      if (value.length > NAME_MAX) return { field, message: `姓名最多 ${NAME_MAX} 个字` };
      return null;
    case 'customer_mobile':
      if (!MOBILE_PATTERN.test(value)) return { field, message: '请填写 11 位手机号' };
      return null;
    default:
      return null;
  }
}

/**
 * 后端字段 code → 表单字段名。
 *
 * 后端 422 的 code 是 `INVALID_CONTENT` 这种"语义码"，前端要落到具体输入框上。
 * 命中不了的（例如 SERVICE 层抛的）不硬猜，交给页面显示为顶部通用错误。
 */
const CODE_TO_FIELD: Record<string, FieldName> = {
  MISSING_STORE_CODE: 'store_code',
  INVALID_STORE_CODE: 'store_code',
  STORE_NOT_FOUND: 'store_code',
  STORE_INACTIVE: 'store_code',
  INVALID_SOURCE: 'store_code',
  INVALID_TICKET_TYPE: 'ticket_type',
  INVALID_CONTENT: 'content',
  INVALID_CUSTOMER_NAME: 'customer_name',
  INVALID_MOBILE: 'customer_mobile',
};

export function fieldOfCode(code: string): FieldName | null {
  return CODE_TO_FIELD[code] ?? null;
}
