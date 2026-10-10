/**
 * H5 侧的家电分类选项与字段长度上限（Phase 11 / P11-1）
 * =============================================================================
 *
 * ⚠️ **这是一份刻意的副本**，真源在
 *    `nocobase/plugins/service-ticket/src/shared/appliance-category.ts`。
 *
 * 为什么不能直接 import：`h5/` 与插件是两个独立工程（各自的 tsconfig / vite root / 依赖树），
 * 跨工程相对导入会把插件目录拖进 H5 的构建图里 —— 那会连带把 React、antd 这些
 * 宿主依赖的解析问题引进来，代价远大于收益。
 *
 * ⇒ 采用本项目对"必须重复的常量"的既有做法（见 `utils/validate.ts` 里
 *   `STORE_CODE_PATTERN` / `MOBILE_PATTERN` 的注释）：
 *   **重复一份，并用门禁把两份逐字比一遍**
 *   （`scripts/verify-phase3-h5.mjs` 的「H5 常量与后端同源」断言）。
 *   也就是说：这个文件**不允许**单独被改 —— 改它就必须同时改后端那份，
 *   否则门禁当场变红。
 *
 * ⚠️ 一旦哪天两个工程合并成一个（或共享包抽出来），**这个文件应当删除**，
 *    而不是继续维护两份。
 */
import { APPLIANCE_CATEGORY_OPTIONS } from './appliance-options';

// 直接复用上面那份纯数据模块，避免"选项"与"文案"再分两处
export { APPLIANCE_CATEGORY_OPTIONS };

/** 服务地址上限（与 `actions/public/ticket.ts` 的 `SERVICE_ADDRESS_MAX` 一致） */
export const SERVICE_ADDRESS_MAX = 200;
/** 品牌/型号上限（与 `actions/public/ticket.ts` 的 `BRAND_MODEL_MAX` 一致） */
export const BRAND_MODEL_MAX = 64;

export type ApplianceCategoryValue = string;

/** 是否在枚举内（H5 侧的下拉本来就只给合法值，这里用于"手改 DOM/粘贴"的兜底） */
export function isApplianceCategory(value: unknown): boolean {
  const v = String(value ?? '').trim();
  return APPLIANCE_CATEGORY_OPTIONS.some((o) => o.value === v);
}
