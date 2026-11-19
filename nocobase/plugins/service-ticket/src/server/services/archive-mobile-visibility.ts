/**
 * 服务档案 · 客户手机号 DTO 裁剪（R2.2.1 §四）
 *
 * ===========================================================================
 * 这一条为什么必须在**服务端**做
 * ===========================================================================
 * 需求原文：「卡片展示客户姓名/服务类型/服务内容/**完整 11 位手机号（仅授权销售）**」，
 * 紧跟着一句：「**必须在服务端完成角色与门店范围控制**」。
 *
 * 前端的 `maskMobile()` 只是**呈现**，不是控制 —— 谁打开 DevTools 都能拿到
 * 网络响应里的原文。所以规则落在服务端，前端拿到的就是它该看到的那个值：
 *   · 有权限的角色 → 完整 11 位；
 *   · 没权限的角色 → `null`（**不是** `138****8888`）。
 *
 * ===========================================================================
 * 🔴 为什么没权限时给 null 而不是掩码
 * ===========================================================================
 * 掩码看起来"更友好"，但它**仍然泄露了号段与前三位后四位**：
 * 针对一个已知道姓名的客户，`139****9999` 已经把范围缩到 1 万人以内，
 * 结合门店/地址足以确认具体是谁。既然这个角色按业务规则**不需要**这个号，
 * 就应该拿不到任何位数。
 *
 * 前端据此渲染成「已隐藏」而不是一排星号 —— 星号会让人以为"号码在，只是没显示"，
 * 进而去骚扰管理员要权限；而"已隐藏"直接说明这是一个权限事实。
 *
 * ===========================================================================
 * 判定顺序（先说结论：三个条件**同时**成立才给完整号）
 * ===========================================================================
 *   ① **角色**：持有门店销售角色 `store_sales`。
 *      —— 不用 `VIEW_RAW_MOBILE` 能力：那个能力对整个后台生效且当前 `MASK_MOBILE_ROLES`
 *         为空 ⇒ 它对所有登录用户都为 true，拿它判会把手机号发给不该看的人。
 *   ② **范围**：该档案的 `store_id` 在该用户授权的门店内。
 *      —— 销售可能被绑定多家店；只要不是这家店的，就不给。
 *   ③ **平台超管**（root/admin）视为有权限：它们是系统主人，且后台其它入口
 *      本来就能看到。这一点与 `PLATFORM_ADMIN_ROLES` 的既有裁决一致。
 *
 * 三条都用**正向列举**而不是"排除某些角色"：
 * 将来新增一个角色时，它**默认拿不到**手机号（fail-closed），
 * 需要时再显式加进来。反过来写（排除名单）会让新角色默认拿到。
 */
/** 允许看到本店客户完整手机号的角色 */
export const ARCHIVE_MOBILE_READABLE_ROLES: string[] = ['store_sales'];

/**
 * 判断某个操作者能否看到**指定门店**档案的客户完整手机号。
 *
 * ⚠️ 纯函数，不读库、不碰 ctx —— 便于用表驱动的方式做双向断言
 *    （反向用例：换角色不变、换门店不变、平台超管恒真）。
 *
 * 参数刻意写成**结构化的宽类型**而不是 `Pick<Actor, ...>`：
 * 调用方拿到的 actor 可能来自中间件（字段齐全）、也可能来自单测桩（只有角色），
 * 收窄成 `Actor` 会逼着每个调用点去补 `userId`/`raw` 这些与判定无关的字段。
 */
export function canReadArchiveCustomerMobile(
  actor: { roles?: readonly string[] | null; platformRoles?: readonly string[] | null; storeIds?: readonly (number | string)[] | null },
  rowStoreId: number | null | undefined,
): boolean {
  const roles: string[] = Array.isArray(actor?.roles) ? actor.roles : [];
  const platform: string[] = Array.isArray(actor?.platformRoles) ? actor.platformRoles : [];

  // ③ 平台超管（root / admin）恒真。
  //    ⚠️ 必须读 `platformRoles`：`normalizeRolesDetailed()` 已经把 root/admin
  //    从 `roles` 里剥掉了，在 `roles` 里找它们**永远找不到**
  //    （这是本仓库第 3 次踩同一个坑，见 archiveAdminList 的注释）。
  if (platform.includes('root') || platform.includes('admin')) return true;

  // ① 角色
  if (!roles.some((r) => ARCHIVE_MOBILE_READABLE_ROLES.includes(r))) return false;

  // ② 门店范围
  const storeId = Number(rowStoreId);
  if (!Number.isFinite(storeId) || storeId <= 0) return false;
  const storeIds: number[] = Array.isArray(actor.storeIds)
    ? actor.storeIds.map((n) => Number(n))
    : [];
  return storeIds.includes(storeId);
}

/**
 * 按权限裁剪一行档案的客户手机号。
 *
 * 返回**新对象**而不是原地改：调用方可能还要用原值做别的事，
 * 原地改会让"这一行到底是被裁过还是没裁过"变得不可判定。
 */
export function projectArchiveMobile<T extends { customer_mobile?: unknown }>(
  row: T,
  visible: boolean,
): T {
  return { ...row, customer_mobile: visible ? (row.customer_mobile ?? null) : null };
}
