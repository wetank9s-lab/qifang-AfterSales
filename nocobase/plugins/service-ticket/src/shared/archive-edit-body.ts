/**
 * 编辑页「提交体」的唯一构造口径 —— 纯函数，不依赖 React / antd。
 *
 * ===========================================================================
 * 为什么把它从组件里抽出来（2026-11-11，DEV-218）
 * ===========================================================================
 *   原先这段逻辑写在 `archive-edit-block.tsx` 的 `onSave()` 里，是一段循环：
 *
 *     for (const key of EDIT_FIELDS) {
 *       const v = values[key];
 *       …日期走 parseDateOnly…
 *       body[key] = v === undefined || v === '' ? null : v;   // ← 这里有问题
 *     }
 *
 *   问题在于 `undefined` 与 `''` 被**合并处理**成 `null`，但它们在 antd 里
 *   语义完全不同：
 *     · `''`        = 用户把这个框清空了 ⇒ 清空列，合理；
 *     · `undefined` = 这个字段**根本没注册进表单**（没渲染 `Form.Item`）
 *                     ⇒ `validateFields()` 不会返回它 ⇒ 不该出现在提交体里。
 *
 *   而 `EDIT_FIELDS` 里有三列**从来没有渲染**：
 *     `purchase_date` / `package_description` / `assigned_worker`
 *   ⇒ 每保存一次，这三列就被显式写成 `null`。
 *
 *   实测影响面（2026-11-11，不是推断，是变异测试跑出来的）：
 *     · `purchase_date` **真的被清空** —— 日期分支走 `paramPresence`，
 *       `null` 算"传了"，于是 patch 里写 `purchase_date = NULL`（E2E 的 C2 在旧实现下变红）；
 *     · `package_description` / `assigned_worker` **侥幸没被清** —— 服务端文本列走
 *       `str()`，而 `str()` 把 `null` 与 `''` 都当成"没传"直接跳过（`str()` 见
 *       `archive.ts`）。也就是说这两列是**靠服务端的宽容**才没丢，不是设计如此。
 *   ⇒ 结论：**真实被清空的是 `purchase_date`**；另外两列属于"没坏但结构上是错的"。
 *     这三列现在都不会再出现在提交体里。
 *
 *   把它抽成纯函数有两个好处（不是"为了好看"）：
 *     ① 这条"未注册字段绝不提交"的规则**只有一处实现**，不会在别处又长出第二条腿；
 *     ② 它能在 Node 里直接单测（`.tmp-verify/a5d/verify-archive-edit-body.mjs`），
 *        不需要浏览器 —— 数据清空类的缺陷必须有一条**会变红**的断言守着。
 */

import { parseDateOnly } from './date-only';

/**
 * 编辑页允许提交的字段白名单。
 * `status` / `visibility` / `store_id` / `archive_no` **不在此列** ——
 * 它们各有专用 action，防止一条 update 改掉状态或把档案挪到别家。
 */
export const ARCHIVE_EDIT_FIELDS = [
  'customer_name',
  'customer_mobile',
  'service_address',
  'service_type',
  'product_description',
  'package_description',
  'purchase_date',
  'planned_date',
  'assigned_worker',
  'notes',
  'public_note',
] as const;

/** `dateOnly` 列：必须只接受 `YYYY-MM-DD`，与建档、服务端**同一个**解析器 */
const DATE_ONLY_FIELDS = ['purchase_date', 'planned_date'];

const DATE_LABEL: Record<string, string> = {
  purchase_date: '购买日期',
  planned_date: '计划上门日期',
};

/**
 * 结果用「单对象 + `ok` 判别字段」而不是联合类型 ——
 * 与 `date-only.ts` 同一理由：本仓库 `strictNullChecks: false`，
 * 在布尔判别式上做否定收窄不生效，联合类型会让构建门禁 BUILD-TS-GATE-01 报 TS2339。
 */
export type BuildUpdateBodyResult = {
  ok: boolean;
  body?: Record<string, unknown>;
  field?: string;
  message?: string;
};

/**
 * 由表单值构造 `svc:archiveUpdate` 的请求体（不含 `id` 与 `expected_version`）。
 *
 * 三条规则，逐条都有对应断言（见 verify-archive-edit-body.mjs）：
 *   ① 键的值为 `undefined` ⇒ **不放进提交体**（未注册字段，服务端保持原值）；
 *   ② `dateOnly` 两列 ⇒ 过 `parseDateOnly`，坏值返回 `ok:false` 并指明字段，**不静默落 NULL**；
 *   ③ 文本列 `''` ⇒ `null`（用户主动清空），其余原样。
 */
export function buildUpdateBody(values: Record<string, unknown>): BuildUpdateBodyResult {
  const body: Record<string, unknown> = {};

  for (const key of ARCHIVE_EDIT_FIELDS) {
    const v = values[key];

    // ① 未注册字段：绝不提交。
    //    ⚠️ 这里**不能**写成 `v === undefined ? null : v` —— 那正是本函数要修掉的缺陷：
    //    `validateFields()` 只返回已注册字段，把"没渲染"当成"用户清空"会把已有值打掉。
    if (v === undefined) continue;

    // ② 日期列：`''` 是清空（→ null），`'Invalid date'` / `'2026-02-31'` 是错误。
    //    两者必须分开 —— 静默把坏值当没填 = "保存成功但内容没保存"。
    if (DATE_ONLY_FIELDS.indexOf(key) >= 0) {
      const parsed = parseDateOnly(v);
      if (!parsed.ok) {
        return {
          ok: false,
          field: key,
          message: `${DATE_LABEL[key] ?? key}${parsed.reason}。请重新选择（或清空）后再保存`,
        };
      }
      body[key] = parsed.value;
      continue;
    }

    // ③ 文本列
    body[key] = v === '' ? null : v;
  }

  return { ok: true, body };
}
