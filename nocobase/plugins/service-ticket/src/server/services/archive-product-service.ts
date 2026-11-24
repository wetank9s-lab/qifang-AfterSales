import { parseDateOnly } from '../../shared/date-only';
import { ArchiveError } from './archive-service';

/**
 * ArchiveProductService —— 档案「产品清单」的唯一读写入口（R2.2.4 §C）
 *
 * ===========================================================================
 * 三条铁律（每条都对应一种"保存成功但数据已经坏了"的失败）
 * ===========================================================================
 *
 * ① **完全不空的条目才入库**。
 *    用户 §C：不保存完全空白条目。
 *    "完全空白" = 产品名为空 **且** 购买日期为空 **且** 数量是默认值 1。
 *    ⚠️ 为什么数量要算进去：前端默认给一条空产品（数量预填 1），
 *       如果只看"名字和日期都空"，那么用户点了「添加产品」但没填，
 *       会入库一条 `{name:null, date:null, qty:1}` 的空行，
 *       于是详情页永远显示"产品 1 台"—— 凭空多出一台不存在的设备。
 *    但**只要用户动过数量**（改成 2、3…），这条就不是"完全空白"：
 *    他知道自己在登记什么，只是没写型号。
 *
 * ② **数组"没传"与"传了空数组"语义相反**。
 *    没传  ⇒ 不动产品清单（老客户端、只想改备注的场景）
 *    传 [] ⇒ **明确清空**（用户删掉了最后一条）
 *    把两者混为一谈是本节最大的坑：混了之后"只想改手机号"会把客户的产品清单删光。
 *
 * ③ **旧列绝不被清单反向清空**。
 *    `service_archives.product_description` / `purchase_date` 是历史事实。
 *    清单为空时（例如用户把产品全删了）**保持原值**，不写 NULL。
 *    理由：客户 H5、导出报表、幂等比对都还在读这两列；
 *    一次"清空产品"不该让客户查到的"产品/型号"变成空白。
 *
 * ===========================================================================
 * 为什么整表替换（delete-all + insert）而不是逐条 diff
 * ===========================================================================
 *   产品清单是**整块表单**：用户在第二步看到的是完整的一块，
 *   保存时提交的也是完整的一块。逐条 diff 需要客户端为每条带稳定的临时 id，
 *   而那个 id 一旦在两次保存之间丢失（刷新、换个手机），diff 会把同一条
 *   当成"删一条 + 加一条"，`created_at` 全部重置。
 *
 *   整表替换的代价是 id 会变。这里评估过：**没有任何地方引用 product.id**
 *   （照片挂的是 stage_id，事件挂的是 archive_id），
 *   所以 id 不稳定不影响任何关联。判据一律用 `(archive_id, sort_order)`。
 */

/** 单条产品输入（来自请求体，全部可能缺失） */
export interface ProductInput {
  product_name?: unknown;
  purchase_date?: unknown;
  quantity?: unknown;
}

/** 规整后的产品行（服务层与前端共用的形状） */
export interface NormalizedProduct {
  product_name: string | null;
  purchase_date: string | null;
  quantity: number;
  sort_order: number;
}

/** 数量上限：不是业务上限，是防"一次填 999999 台"把统计打爆 */
const MAX_QUANTITY = 9999;

export class ArchiveProductService {
  constructor(
    private readonly db: any,
    private readonly logger?: { warn?: (m: string) => void },
  ) {}

  private repo(name: string) {
    return this.db.getRepository(name);
  }

  /**
   * 把请求里的 `products` 规整成可入库的行。
   *
   * ⚠️ 这条函数是**纯逻辑**（出参只依赖入参），所以它同时是验收断言的靶子：
   *    `scripts/r224-product-normalize.mjs` 直接调用它跑用例，
   *    不需要起数据库 —— "空白条目被丢弃"这类规则必须能离线复现。
   *
   * @returns `null` 表示"没传这个字段"（不动），数组表示"按这个数组整表替换"
   */
  normalize(raw: unknown): NormalizedProduct[] | null {
    if (raw === undefined) return null;
    if (raw === null) return null;
    if (!Array.isArray(raw)) {
      throw new ArchiveError('ARCHIVE_BAD_PRODUCTS', '产品清单格式不正确', 400);
    }

    const out: NormalizedProduct[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const src = item as ProductInput;

      const name = String(src.product_name ?? '').trim();
      // 空串归 null：前端清空输入框时给的是 ''，直接入库会得到"有值但为空"的行
      const nameOrNull = name === '' ? null : name.slice(0, 255);

      /**
       * 日期走 `parseDateOnly` 统一口径（与 `archiveCreate` 同一个函数）。
       *
       * ⚠️ 移动端 `<input type="date">` 在未选择时可能给出字符串 `'Invalid date'`
       *    （DEV-217 真机 500 的根因）。这里不能只 trim 就透传 ——
       *    那会让一条产品记录整条 500，而用户看到的是"档案保存失败"。
       *    区分"没填"与"填了个坏值"正是 parseDateOnly 的职责。
       */
      const dateParsed = parseDateOnly(src.purchase_date);
      if (!dateParsed.ok) {
        throw new ArchiveError(
          'ARCHIVE_BAD_DATE',
          `购买日期${dateParsed.reason}。请重新选择日期后再提交`,
          400,
        );
      }
      const dateOrNull = dateParsed.value;

      // 数量：缺省 1；非整数或 <1 直接 400（不静默改成 1 —— 那会让用户以为填进去了）
      const rawQty = src.quantity;
      let quantity = 1;
      if (rawQty !== undefined && rawQty !== null && String(rawQty).trim() !== '') {
        const n = Number(rawQty);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
          throw new ArchiveError('ARCHIVE_BAD_QUANTITY', '产品数量必须是 1 以上的整数', 400);
        }
        if (n > MAX_QUANTITY) {
          throw new ArchiveError('ARCHIVE_BAD_QUANTITY', `产品数量不能超过 ${MAX_QUANTITY}`, 400);
        }
        quantity = n;
      }

      // 铁律 ①：完全空白 ⇒ 丢弃（不报错、不入库）
      const isBlank = nameOrNull === null && dateOrNull === null && quantity === 1;
      if (isBlank) continue;

      out.push({
        product_name: nameOrNull,
        purchase_date: dateOrNull,
        quantity,
        sort_order: out.length + 1,
      });
    }
    return out;
  }

  /**
   * 读取某档案的产品清单（按填写顺序）。
   *
   * ⚠️ `ORDER BY sort_order, id` —— **必须带 id 兜底**。
   *    整表替换时所有行同一个事务写入，`sort_order` 若因并发被写成相同值，
   *    只按 `sort_order` 排会让 PostgreSQL 返回**不确定顺序**（同一查询两次结果不同），
   *    表现是"刷新一下产品顺序变了"。这不是理论问题，PG 明确不保证稳定排序。
   */
  async list(archiveId: number): Promise<NormalizedProduct[]> {
    const rows = await this.repo('serviceArchiveProducts').find({
      filter: { archive_id: Number(archiveId) },
      sort: ['sort_order', 'id'],
    });
    return (rows ?? []).map((r: any) => ({
      product_name: r.product_name ?? null,
      purchase_date: r.purchase_date ? String(r.purchase_date).slice(0, 10) : null,
      quantity: Number(r.quantity ?? 1),
      sort_order: Number(r.sort_order ?? 1),
    }));
  }

  /**
   * 整表替换（铁律 ②③ 的落点）。
   *
   * @param products 已规整的数组（调用 `normalize` 得到）
   * @returns 是否真的动了清单（`false` = 没传产品字段）
   */
  async replace(
    archiveId: number,
    products: NormalizedProduct[] | null,
    transaction?: any,
  ): Promise<boolean> {
    if (products === null) return false;

    const id = Number(archiveId);
    const repo = this.repo('serviceArchiveProducts');
    const txOpt = transaction ? { transaction } : {};

    await repo.destroy({ filter: { archive_id: id }, ...txOpt });
    for (const p of products) {
      await repo.create({
        values: {
          archive_id: id,
          product_name: p.product_name,
          purchase_date: p.purchase_date,
          quantity: p.quantity,
          sort_order: p.sort_order,
        },
        ...txOpt,
      });
    }
    return true;
  }

  /**
   * 把第一条产品镜像回旧列（写入方向：清单 → 旧列）。
   *
   * 🔴 铁律 ③：**清单为空时什么都不写**，返回 `{}`。
   *    返回空对象而不是 `{product_description: null}` 是刻意的 ——
   *    调用方通常把它展开进 patch，空对象不会覆盖任何列；
   *    若返回 null 则一次"删光产品"会顺手把历史的"产品/型号"抹掉。
   */
  mirrorToLegacy(products: NormalizedProduct[]): Record<string, string | null> {
    const first = products[0];
    if (!first) return {};
    return {
      product_description: first.product_name,
      purchase_date: first.purchase_date,
    };
  }

  /**
   * 把产品清单投影成**客户可见**的形状。
   *
   * ===========================================================================
   * 为什么客户页只给名称/日期/数量
   * ===========================================================================
   *   这三样是"我买了什么、什么时候买的、买了几台"——客户自己就知道的事实。
   *   不给 `sort_order`（内部排序号，对外无意义）、不给 `id`（内部主键，
   *   一旦下发就成了可枚举的越权探测入口）。
   *
   * ⚠️ 空数组要原样返回 `[]`，**不要**用 `null` 表示"没有产品"：
   *    前端 `products === null` 与 `products.length === 0` 是两种状态，
   *    混用会让"旧档案（没有清单表数据）"和"新档案（清单为空）"
   *    在界面上表现不一致。
   */
  projectForCustomer(products: NormalizedProduct[]): Array<{
    product_name: string | null;
    purchase_date: string | null;
    quantity: number;
  }> {
    return products.map((p) => ({
      product_name: p.product_name,
      purchase_date: p.purchase_date,
      quantity: p.quantity,
    }));
  }
}
