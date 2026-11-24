/**
 * 产品清单录入（R2.2.4 §C）。
 *
 * ===========================================================================
 * 为什么是"一组数组"而不是"两个字段"
 * ===========================================================================
 *   旧实现第二步只有 `product_description`（产品/型号）+ `purchase_date`
 *   （购买日期）两个**单值**字段。用户的业务事实是一张档案可能装了三台设备：
 *   一台挂机、两台柜机，购买日期还不一样。
 *
 *   ⇒ 拼成一段文本（"挂机/2024-05-01；柜机/2024-05-03"）不是解法：
 *     它把**结构**降级成字符串，之后没有任何东西能可靠地按"第 2 台"取值：
 *     客户 H5 只能整段展示、导出 CSV 只能整段塞一格、改第二台的日期要重新解析
 *     （而解析必然失败于客户自己输入的分号/换行）。
 *
 *   ⇒ 真解是一对多子表 `service_archive_products`（服务端 `ArchiveProductService`），
 *     本组件只负责**编辑数组**，不负责怎么落库。
 *
 * ===========================================================================
 * 三条容易做错的细节
 * ===========================================================================
 *   ① **默认给一条空产品，但保存时丢弃完全空白的条目**
 *      用户要求"默认给出一条空产品"（不改就是"不填"），
 *      所以空条目必须在提交前被丢掉 —— 否则每条不填产品的档案
 *      都会落一行 `product_name = ''`，导出时多出一堆空行。
 *      丢弃规则放在服务端 `ArchiveProductService.normalize`（唯一口径），
 *      本组件不复制它，但**计数**用的是同一套判定（见 `isBlank` 注释）。
 *
 *   ② **数量只能是正整数**：输入框 type="number" 在 iOS 上允许输入 "1.5" 和 "-3"
 *      （`step=1` 只是步进约束，不是输入过滤）。所以这里做**输入即清洗**：
 *      非数字字符直接丢弃，前导 0 去掉，空 => 留在 `''` 由调用方落成 1。
 *      ⚠️ 不要"输入时截成合法值并把 0 改成 1"：用户想把 12 改成 2，
 *         删除中间态会经过 "1"，此时被改写成 1 会把光标搞乱。
 *
 *   ③ **删除按钮的可点区域 ≥44**：原型里是 `padding:5px 2px` 的小红字，
 *      真机上只有 26×20 —— `accessibility.md › Touch targets` 要求 44×44。
 *      ⇒ CSS 用 `min-width/min-height: 44px` + 负外边距，视觉上仍是小字。
 *
 * ===========================================================================
 * 字段名与服务端契约
 * ===========================================================================
 *   `product_name` / `purchase_date`（YYYY-MM-DD 或 null）/ `quantity`（≥1）
 *   与 `archive-product-service.ts` 的 `normalize()` 输入一致。
 */

import { useId } from 'react';
import { QFButton } from './primitives';

/** 一条产品（编辑态；`purchase_date` 用 `''` 表示未填，不写 null —— 受控 input 要字符串） */
export interface QFProductDraft {
  /** 仅用于 React key 与断言，**不提交**（服务端按数组顺序重排 sort_order） */
  key: string;
  product_name: string;
  purchase_date: string;
  /** 保持字符串：受控 number input 在清空时会是 `''`，转 number 会变 NaN 并让输入框失焦重置 */
  quantity: string;
}

let seq = 0;
function nextKey(): string {
  seq += 1;
  return `p${seq}`;
}

/** 新建一条空产品（数量默认 1） */
export function newProductDraft(): QFProductDraft {
  return { key: nextKey(), product_name: '', purchase_date: '', quantity: '1' };
}

/**
 * 空白条目判定 —— 与服务端 `ArchiveProductService.normalize` **同一口径**。
 *
 *   「名称空 且 日期空 且 数量===1」才算空白。
 *   ⚠️ 数量判定是 **===1** 而不是 `>0`：数量是默认值 1，用户没动过它就不代表
 *      任何意图；但他一旦改成 2 再改回 1，语义上仍是"没填"。
 *      这看起来像 bug，其实是刻意的 —— 否则"我只填了个数量 1"会变成一条
 *      没有产品名的垃圾行（而列表页会显示成一条空产品）。
 */
export function isBlankProduct(p: QFProductDraft): boolean {
  const name = p.product_name.trim();
  const date = p.purchase_date.trim();
  const qty = p.quantity.trim();
  const qtyNum = qty === '' ? 1 : Number(qty);
  return name === '' && date === '' && qtyNum === 1;
}

/** 已填写条数（给"n 项已填写"用） */
export function filledProductCount(list: QFProductDraft[]): number {
  return list.filter((p) => !isBlankProduct(p)).length;
}

/**
 * 数量输入清洗：只留数字、去前导 0、限 4 位。
 *
 * ⚠️ 不把 `0` 改成 `1`：见文件头 ②。
 *    0 由调用方在提交前归一成 1（服务端也会拒 0，见 `normalize` 的 quantity 校验）。
 */
function cleanQty(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '');
  return digits.slice(0, 4);
}

/** 提交给服务端的形态（剔除空白条目、数量归一） */
export function toProductPayload(
  list: QFProductDraft[],
): Array<{ product_name: string | null; purchase_date: string | null; quantity: number }> {
  return list.filter((p) => !isBlankProduct(p)).map((p) => {
    const q = Number(p.quantity.trim() || '1');
    return {
      product_name: p.product_name.trim() || null,
      purchase_date: p.purchase_date.trim() || null,
      quantity: Number.isFinite(q) && q >= 1 ? Math.floor(q) : 1,
    };
  });
}

/* ------------------------------------------------------------------ 组件 */

export function QFProductList({
  value,
  onChange,
  testId = 'archive-products',
  max = 20,
}: {
  value: QFProductDraft[];
  onChange: (next: QFProductDraft[]) => void;
  testId?: string;
  /** 上限：服务端没有硬限制，这里只防"手滑连点 50 次"把表单撑爆 */
  max?: number;
}) {
  const filled = filledProductCount(value);

  const update = (key: string, patch: Partial<QFProductDraft>) => {
    onChange(value.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  };

  const remove = (key: string) => {
    // ⚠️ 允许删到 0 条（用户 §E 明写"无产品"也是一种合法保存结果）。
    //    旧想法是"至少保留一条"，但那会逼用户保留一个他根本不需要的空行。
    onChange(value.filter((p) => p.key !== key));
  };

  return (
    <div data-testid={testId} data-product-count={filled}>
      <div className="svc-product-subhead">
        <strong>
          产品清单 <span className="svc-product-optional">（选填）</span>
        </strong>
        <span className="svc-product-count" data-testid={`${testId}-count`}>
          {filled} 项已填写
        </span>
      </div>

      <div className="svc-product-list">
        {value.map((p, i) => (
          <ProductItem
            key={p.key}
            index={i}
            draft={p}
            onChange={(patch) => update(p.key, patch)}
            onRemove={() => remove(p.key)}
            testId={`${testId}-${i}`}
          />
        ))}
      </div>

      {value.length < max ? (
        <button
          type="button"
          className="svc-product-add qf-pressable"
          onClick={() => onChange([...value, newProductDraft()])}
          data-testid={`${testId}-add`}
        >
          ＋ 添加产品
        </button>
      ) : (
        <div className="text-svc-ink-3 qf-foot mt-2 px-1">
          一条档案最多记录 {max} 项产品，需要更多请联系总部。
        </div>
      )}
    </div>
  );
}

function ProductItem({
  index,
  draft,
  onChange,
  onRemove,
  testId,
}: {
  index: number;
  draft: QFProductDraft;
  onChange: (patch: Partial<QFProductDraft>) => void;
  onRemove: () => void;
  testId: string;
}) {
  const base = useId();

  return (
    <div className="svc-product-item" data-product-item={index} data-testid={testId}>
      <div className="svc-product-item-top">
        {/*
          标题用**序号**（产品 1 / 产品 2），不用产品名：
          产品名为空时标题会是空白，用户看不出这是第几条 —— 而删除按钮
          就挂在标题这一行，需要说明"删的是哪一条"。
        */}
        <span className="svc-product-item-title" data-testid={`${testId}-title`}>
          产品 {index + 1}
        </span>
        <button
          type="button"
          className="svc-product-remove qf-pressable"
          onClick={onRemove}
          aria-label={`删除产品 ${index + 1}`}
          data-testid={`${testId}-remove`}
        >
          删除
        </button>
      </div>

      <div className="svc-product-field">
        <label htmlFor={`${base}-name`}>产品 / 型号</label>
        <input
          id={`${base}-name`}
          className="svc-product-input"
          value={draft.product_name}
          onChange={(e) => onChange({ product_name: e.target.value })}
          autoComplete="off"
          maxLength={120}
          data-testid={`${testId}-name`}
        />
      </div>

      <div className="svc-product-two-col">
        <div className="svc-product-field">
          <label htmlFor={`${base}-date`}>购买日期</label>
          <input
            id={`${base}-date`}
            className="svc-product-input"
            type="date"
            value={draft.purchase_date}
            onChange={(e) => onChange({ purchase_date: e.target.value })}
            style={{ minWidth: 0 }}
            data-testid={`${testId}-date`}
          />
        </div>
        <div className="svc-product-field">
          <label htmlFor={`${base}-qty`}>数量</label>
          <input
            id={`${base}-qty`}
            className="svc-product-input svc-product-qty"
            type="number"
            inputMode="numeric"
            min={1}
            max={9999}
            step={1}
            value={draft.quantity}
            onChange={(e) => onChange({ quantity: cleanQty(e.target.value) })}
            /*
             * 失焦时把空值落成 1：
             * 输入框空着不写值，用户会以为"数量是 0 台"。
             * ⚠️ 只在 blur 归一，不在 change 归一 —— 理由见文件头 ②。
             */
            onBlur={() => {
              if (draft.quantity.trim() === '' || Number(draft.quantity) < 1) {
                onChange({ quantity: '1' });
              }
            }}
            data-testid={`${testId}-qty`}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * 产品清单**只读展示**（详情页 / 客户 H5 共用）。
 *
 * ⚠️ 为什么不在两个页面各写一套：客户投影（`projectForCustomer`）与员工投影
 *    都是 `{product_name, purchase_date, quantity}`，字段名一致；
 *    写两套必然漂（一边显示数量、一边不显示），而用户 §E 第 7 条要的正是
 *    "客户公开页不出现内部备注"这类**判定边界清楚**的展示。
 */
export function QFProductSummary({
  products,
  testId = 'archive-product-summary',
}: {
  products: Array<{ product_name?: string | null; purchase_date?: string | null; quantity?: number | null }>;
  testId?: string;
}) {
  if (!products || products.length === 0) return null;

  // 区块标题由外层 QFListSection 的 title 提供；组件内**不再重复**一个小标题
  // （2026-11-24 截图发现：详情页出现「产品清单」两次叠在一起）。
  return (
    <div className="px-4 py-2.5" data-testid={testId} data-product-rows={products.length}>
      <div className="flex flex-col gap-1.5">
        {products.map((p, i) => (
          <div key={i} className="flex items-start justify-between gap-3" data-product-row={i}>
            <span className="text-svc-ink qf-body min-w-0 flex-1 break-words">
              {p.product_name || '（未填写产品）'}
            </span>
            <span className="text-svc-ink-2 qf-foot shrink-0 text-right">
              {p.purchase_date ? p.purchase_date : '未填日期'}
              {typeof p.quantity === 'number' && p.quantity > 1 ? ` · ${p.quantity} 台` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 「添加产品」的次级按钮（详情页编辑场景用；与表单内的虚线条目按钮区分开） */
export function QFAddProductButton({ onClick, testId }: { onClick: () => void; testId?: string }) {
  return (
    <QFButton variant="tonal" block onClick={onClick} testId={testId}>
      ＋ 添加产品
    </QFButton>
  );
}
