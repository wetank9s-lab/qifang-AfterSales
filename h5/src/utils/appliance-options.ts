/**
 * 家电分类的**纯数据**选项表（Phase 11 / P11-1）
 * =============================================================================
 *
 * 与 `nocobase/plugins/service-ticket/src/shared/appliance-category.ts` 的
 * `APPLIANCE_CATEGORY_OPTIONS` **逐字一致**，由 `scripts/verify-phase3-h5.mjs`
 * 的两份比对断言盯住（见 `utils/appliance.ts` 文件头的说明）。
 *
 * 之所以与 `appliance.ts` 拆成两个文件：本文件**零依赖**，
 * 可以被门禁独立 require（经 esbuild 编译）后与后端那份做**逐字**比较；
 * 而 `appliance.ts` 会 import 它。门禁只需要前者。
 */
export const APPLIANCE_CATEGORY_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
  { label: '空调', value: 'air_conditioner' },
  { label: '冰箱', value: 'refrigerator' },
  { label: '洗衣机', value: 'washer' },
  { label: '电视', value: 'tv' },
  { label: '厨卫电器', value: 'kitchen_bath' },
  { label: '小家电', value: 'small_appliance' },
  { label: '其他', value: 'other' },
];
