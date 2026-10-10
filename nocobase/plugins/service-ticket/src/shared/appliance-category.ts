/**
 * 家电分类 —— **前后端共用的唯一事实来源**（Phase 11 / P11-1）
 * =============================================================================
 *
 * 来源：`docs/PHASE-11-REQUIREMENTS.md` §8.2「家电分类」明确给出了一组**固定枚举**，
 * 并加了一句约束：**"这是简单分类，不建立 ERP 商品档案。"**
 *
 * ⇒ 因此这里是**一个枚举**，不是一张表、不是一棵树、不是商品库的前身。
 *   任何人想往这里加"二级分类"""型号库""关系映射"之前，先回到那句话：
 *   本阶段要的是"这单是修空调还是修冰箱"，用来分流与统计，不是商品主数据。
 *
 * -----------------------------------------------------------------------------
 * 为什么放在 `src/shared/`（而不是像 `TICKET_TYPE_OPTIONS` 那样只放服务端）
 * -----------------------------------------------------------------------------
 * 这一组值**三处都要用**：
 *   · 服务端 collection 声明（`enumStr` 的选项 ⇒ 决定落库枚举与后台下拉）
 *   · 服务端 DTO 校验（客户匿名提交必须拒掉枚举外的值）
 *   · 客户 H5 表单（下拉选项）
 * 三处各写一份的代价本项目已经付过：`service-mode` 那次是"客户端写 self/third_party、
 * 服务端只认 inhouse/manufacturer/third_party"，表现是"选自营必然 422"。
 * ⇒ 收敛到这里（与 `service-mode.ts` 同一手法），三处不可能再各说一套。
 *
 * ⚠️ `value` 是**落库值**，改名等于一次数据迁移；`label` 只用于界面，可以改。
 *    `TICKET_TYPE_OPTIONS` 的注释里已经写过同一条纪律。
 */

export interface ApplianceCategoryOption {
  /** 落库值（英文枚举），一旦发出**不可随意改** */
  value: string;
  /** 界面文案（中文），可改 */
  label: string;
}

/** 与 `docs/PHASE-11-REQUIREMENTS.md` §8.2 的列表**逐字一致** */
export const APPLIANCE_CATEGORY_OPTIONS: readonly ApplianceCategoryOption[] = [
  { value: 'air_conditioner', label: '空调' },
  { value: 'refrigerator', label: '冰箱' },
  { value: 'washer', label: '洗衣机' },
  { value: 'tv', label: '电视' },
  { value: 'kitchen_bath', label: '厨卫电器' },
  { value: 'small_appliance', label: '小家电' },
  { value: 'other', label: '其他' },
] as const;

/** 允许的落库值集合（校验用；从上面那份列表派生，不重抄一遍） */
export const APPLIANCE_CATEGORY_VALUES: readonly string[] = APPLIANCE_CATEGORY_OPTIONS.map(
  (o) => o.value,
);

/** 是否在枚举内。`null` / `undefined` / 空串一律返回 false（调用方按"可选字段"自行放行） */
export function isApplianceCategory(value: unknown): boolean {
  return APPLIANCE_CATEGORY_VALUES.includes(String(value ?? '').trim());
}

/** 人类可读文案（用于错误消息；未知值原样回显，便于排障） */
export function applianceCategoryLabel(value: unknown): string {
  const v = String(value ?? '').trim();
  return APPLIANCE_CATEGORY_OPTIONS.find((o) => o.value === v)?.label ?? v;
}

/** 供界面渲染的下拉项（复制一份，避免调用方就地修改共享常量） */
export function applianceCategorySelectOptions(): Array<{ label: string; value: string }> {
  return APPLIANCE_CATEGORY_OPTIONS.map((o) => ({ label: o.label, value: o.value }));
}
