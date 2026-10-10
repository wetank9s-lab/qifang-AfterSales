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
 *    这里只用 code / name / active / sort_order / contact_phone / address 六个真实列。
 */
import { CONFIRMED_STORE_PROFILE } from './store-official-list';
/**
 * ⚠️⚠️ 2026-10-10 更新（P11-2 A 段）：**本文件的 name 不再是唯一事实来源。**
 *
 *   用户给了 10 条真实「门店名称 + 门店地址」，其中**证据充分的 2 条**
 *   已落在 `seeds/store-official-list.ts`（含逐条匹配证据与"待核对"清单）。
 *   下面这个数组仍是**占位清单**（本文件头部原本就写着"等业务方给出正式的门店编码与名称后替换"），
 *   但 `STORE_SEEDS` 会把**已确认**条目的 name/address 覆盖进去 ⇒ 全新安装也拿到正式名。
 *
 *   ⚠️ 为什么不是直接把这里的字面量改掉：那样"哪几条确认过、凭什么确认、还有哪几条待核对"
 *      就只剩下 git diff 了。现在这些信息在 `store-official-list.ts` 里**逐条可读、可复核**，
 *      并且 `verify-store-official-list.mjs` 会盯住"两个文件不许漂移"。
 *
 *   ⚠️ `address` 是 2026-10-10 新增的列（迁移 202610103）。种子**只增不改**
 *      （见下面 seedStores 的说明）⇒ 重新跑 seed **不会**把已录入的地址或名称改回去。
 */
export interface StoreSeed {
  code: string;
  name: string;
  /** H5 下拉排序（升序）；与清单顺序一致即可 */
  sortOrder: number;
  /** 门店对外售后电话；正式数据待提供，**一律保持 null**（不得生成虚假号码） */
  contactPhone?: string | null;
  /** 门店经营地址（用户 2026-10-10 提供，逐字保留）；未提供则为 null，页面不渲染该行 */
  address?: string | null;
  active: boolean;
  /**
   * 门店所在区域 —— **仅注释用途，不落库**。
   * 现有 stores 表没有 region 列（避免为占位数据改表结构），
   * 保留它只为让运维一眼看出占位门店对应哪个片区。
   */
  region: string;
}

/** 占位清单（15 家）。正式名称/地址由 `store-official-list.ts` 覆盖 —— 见上面说明。 */
const PLACEHOLDER_STORE_SEEDS: StoreSeed[] = [
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

/**
 * 落库用的门店清单 = 占位清单 **⊕** 已确认的正式资料。
 *
 * ⚠️ 覆盖率刻意做成"只有 confirmed 才覆盖"：`CONFIRMED_STORE_PROFILE` 里
 *    只含 `status==='confirmed'` 的条目 ⇒ **待核对的条目结构上无法被写入**
 *    （这就是"不得猜测绑定"在代码里的落点，而不是靠人记得）。
 */
export const STORE_SEEDS: StoreSeed[] = PLACEHOLDER_STORE_SEEDS.map((seed) => {
  const official = CONFIRMED_STORE_PROFILE[seed.code];
  return official ? { ...seed, name: official.name, address: official.address } : seed;
});

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
    // ⚠️ 2026-10-10 起包含 `address`（迁移 202610103 建的列）。
    //    未提供资料的门店写 NULL —— **绝不用别的门店的地址顶上**（用户明令）。
    address: seed.address ?? null,
  };
}
