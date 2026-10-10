/**
 * 工单"新建类"输入字段的**共享校验**（Phase 11 / P11-2）
 * =============================================================================
 *
 * ===========================================================================
 * 为什么要有这个文件（否则会出现"同一个坑有两条腿"）
 * ===========================================================================
 * 现在有**两个**建单入口：
 *   · 匿名客户 H5 —— `actions/public/ticket.ts`（只有 repair / complaint 两类，
 *     `urgent` 在匿名面上**不存在**）；
 *   · 门店人工新建 —— `actions/svc/ticket-create.ts`（**六类**，`urgent` 由授权员工设置）。
 *
 * 两者的**字段校验规则必须逐字相同**（长度上限与 collection 的 `length` 一致、
 * 空值归一成 `undefined`、家电类型走同一个枚举）。各写一份的后果不是"重复代码"，
 * 而是：客户 H5 拒绝 201 字的服务地址、门店后台却写进去了 —— 表现为改完后台的表单，
 * H5 那边开始报 500（PG 拒绝超长 varchar）。**同一段解析逻辑出现两次 = 同一个坑有两条腿。**
 *
 * ⇒ 收敛到本文件：两个入口都从这里取规则；`docs`/门禁只需盯这一处的常量。
 *
 * ===========================================================================
 * 两条共同纪律（从原 `parseNewModelFields` 原样搬来，语义未变）
 * ===========================================================================
 * ① **空值一律归一成 `undefined`**（不落库、不下发），而不是空串 ——
 *    空串会与"用户真的输入了空"混为一谈，也会让 `varchar` 里出现两种"没有值"；
 * ② 长度上限与 collection 的 `length` **逐字一致**（超了会被 PG 拒绝，
 *    表现为 500 —— 必须在 DTO 层变成 422 并说清是哪一项）。
 */
import {
  APPLIANCE_CATEGORY_VALUES,
  isApplianceCategory,
} from '../../shared/appliance-category';
import { ValidationError } from '../services/ticket-service';

/** 服务地址上限（= `serviceTickets.service_address` 的 varchar(200)） */
export const SERVICE_ADDRESS_MAX = 200;
/** 品牌/型号上限（= `serviceTickets.brand_model` 的 varchar(64)） */
export const BRAND_MODEL_MAX = 64;
/** 客户姓名上限（与匿名面 §1.2 的"姓名 1–32 字"一致） */
export const CUSTOMER_NAME_MAX = 32;

/** 取一个可选文本字段：trim 后为空 ⇒ `undefined`；超长 ⇒ 422 `INVALID_FIELD_LENGTH` */
export function parseOptionalText(
  raw: Record<string, unknown>,
  key: string,
  label: string,
  max: number,
): string | undefined {
  const value = String(raw[key] ?? '').trim();
  if (!value) return undefined;
  if (value.length > max) {
    throw new ValidationError(
      'INVALID_FIELD_LENGTH',
      `${label}最多 ${max} 字，当前 ${value.length} 字`,
      422,
    );
  }
  return value;
}

/** 家电类型：**枚举校验**（非法值必须拒绝，不能静默丢弃） */
export function parseApplianceCategory(raw: Record<string, unknown>): string | undefined {
  const value = String(raw.appliance_category ?? '').trim();
  if (!value) return undefined;
  if (!isApplianceCategory(value)) {
    throw new ValidationError(
      'INVALID_APPLIANCE_CATEGORY',
      `appliance_category 必须是 ${APPLIANCE_CATEGORY_VALUES.join(' / ')} 之一，实际 "${value}"`,
      422,
    );
  }
  return value;
}

/**
 * 紧急标记。
 *
 * ⚠️ **两个入口的语义刻意不同**，由 `allowUrgent` 显式声明：
 *    · `allowUrgent: false`（匿名客户面）—— 该字段在这个面上**不存在**。
 *      这里**不做**"收到 true 就报错"：那会让旧产物/第三方调用方因为一个**已被忽略**的
 *      字段而整单失败。正确语义是静默忽略，并把"伪造也无效"写成一条断言。
 *    · `allowUrgent: true`（门店人工新建）—— 授权员工可以设置。
 *      必须是**真布尔**：`"true"` 这种字符串一律 422，防 `Boolean('false') === true`
 *      那类"悄悄变真"（与 `urgent` 列改成 boolean 时的口径一致）。
 */
export function parseUrgent(raw: Record<string, unknown>, allowUrgent: boolean): boolean {
  if (!allowUrgent) return false;
  const value = raw.urgent;
  if (value === undefined || value === null || value === '') return false;
  if (typeof value !== 'boolean') {
    throw new ValidationError(
      'INVALID_URGENT',
      `urgent 必须是布尔（true / false），实际 ${JSON.stringify(value)}`,
      422,
    );
  }
  return value;
}

/** `service_address` / `appliance_category` / `brand_model` / `urgent` 四个字段的解析结果 */
export interface NewModelFields {
  serviceAddress?: string;
  applianceCategory?: string;
  brandModel?: string;
  urgent: boolean;
}

/**
 * 解析 Phase 11 / P11-1 的四个新字段（§8.1）。
 *
 * ⚠️ 调用方**必须**把它排在既有六项校验**之后**：`parseDto` 的校验顺序被
 *    `docs/API.md` §1.2 与冒烟断言绑定（"同一个错误请求永远得到同一条提示"），
 *    新增字段若插在中间会改掉既有请求的**首个**报错。
 */
export function parseNewModelFields(
  raw: Record<string, unknown>,
  options: { allowUrgent: boolean },
): NewModelFields {
  return {
    serviceAddress: parseOptionalText(raw, 'service_address', '服务地址', SERVICE_ADDRESS_MAX),
    applianceCategory: parseApplianceCategory(raw),
    brandModel: parseOptionalText(raw, 'brand_model', '品牌/型号', BRAND_MODEL_MAX),
    urgent: parseUrgent(raw, options.allowUrgent),
  };
}
