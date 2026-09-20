/**
 * 门店种子数据。
 *
 * ⚠️ 当前是**占位清单**，等业务方给出正式的门店编码与名称后替换
 *    （开发文档附录 E-03「门店清单」仍待提供，已记录在 docs/PHASE-2.md 的
 *     「待确认输入」一节与 docs/DEVIATIONS.md DEV-21）。
 *
 * 为什么现在就落种子：
 *   Phase 2 的验收项 AT-03（门店隔离）必须有**两家以上**真实门店才能证伪 ——
 *   只有一家门店时，"门店用户看不到别家工单"这个断言恒真，测了等于没测。
 *   先落占位数据把隔离链路跑通，正式清单到位后只需改这一处常量：
 *   seedStores() 的语义是「按 code 只增不改」，改名/停用请走后台，
 *   不会因为重新部署而被覆盖回去。
 *
 * 命名约定：
 *   · code 形如 S01…S15（客户公开接口只回 code/name，不回 id —— docs/API.md §1.1）
 *   · code 一旦发出（印在门店二维码上）就**不可修改**，所以 seed 只按 code 判重
 *   · 15 家对应开发文档里的连锁规模
 *
 * ⚠️ 字段必须与 collections/stores.ts 严格对齐，多写一个不存在的列
 *    会在入库时报 `column "xxx" does not exist`（42703）而让 install 失败。
 *    这里只用 code / name / active / sort_order / contact_phone 五个真实列。
 */
export interface StoreSeed {
  code: string;
  name: string;
  /** H5 下拉排序（升序）；与清单顺序一致即可 */
  sortOrder: number;
  /** 门店对外售后电话；正式数据待提供，占位为 null */
  contactPhone?: string | null;
  active: boolean;
  /**
   * 门店所在区域 —— **仅注释用途，不落库**。
   * 现有 stores 表没有 region 列（避免为占位数据改表结构），
   * 保留它只为让运维一眼看出占位门店对应哪个片区。
   */
  region: string;
}

export const STORE_SEEDS: StoreSeed[] = [
  { code: 'S01', name: '圣大家电新都店', sortOrder: 10, active: true, region: '成都市新都区' },
  { code: 'S02', name: '圣大家电青白江店', sortOrder: 20, active: true, region: '成都市青白江区' },
  { code: 'S03', name: '圣大家电金堂店', sortOrder: 30, active: true, region: '成都市金堂县' },
  { code: 'S04', name: '金堂华林电器', sortOrder: 40, active: true, region: '成都市金堂县' },
  { code: 'S05', name: '圣大家电新津店', sortOrder: 50, active: true, region: '成都市新津区' },
  { code: 'S06', name: '圣大家电彭州店', sortOrder: 60, active: true, region: '成都市彭州市' },
  { code: 'S07', name: '圣大家电都江堰店', sortOrder: 70, active: true, region: '成都市都江堰市' },
  { code: 'S08', name: '圣大家电简阳店', sortOrder: 80, active: true, region: '成都市简阳市' },
  { code: 'S09', name: '圣大家电郫都店', sortOrder: 90, active: true, region: '成都市郫都区' },
  { code: 'S10', name: '圣大家电温江店', sortOrder: 100, active: true, region: '成都市温江区' },
  { code: 'S11', name: '圣大家电双流店', sortOrder: 110, active: true, region: '成都市双流区' },
  { code: 'S12', name: '圣大家电龙泉驿店', sortOrder: 120, active: true, region: '成都市龙泉驿区' },
  { code: 'S13', name: '圣大家电德阳店', sortOrder: 130, active: true, region: '德阳市旌阳区' },
  { code: 'S14', name: '圣大家电绵阳店', sortOrder: 140, active: true, region: '绵阳市涪城区' },
  { code: 'S15', name: '圣大家电眉山店', sortOrder: 150, active: true, region: '眉山市东坡区' },
];

/** 供离线校验断言：种子条数 */
export const STORE_SEED_COUNT = STORE_SEEDS.length;

/** 门店编码格式（客户端入参校验、二维码参数解析都用它） */
export const STORE_CODE_PATTERN = /^S\d{2,3}$/;

/** 把种子转成入库行（列名与 collections/stores.ts 严格对齐） */
export function toStoreRow(seed: StoreSeed): Record<string, unknown> {
  return {
    code: seed.code,
    name: seed.name,
    active: seed.active,
    sort_order: seed.sortOrder,
    contact_phone: seed.contactPhone ?? null,
  };
}
