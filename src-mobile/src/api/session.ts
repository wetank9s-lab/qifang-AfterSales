/**
 * 会话适配层（AuthContextAdapter）
 *
 * ===========================================================================
 * 关键设计：**不引入第二套账号体系**
 * ===========================================================================
 *   登录走 NocoBase 原生的 `POST /api/auth:signIn`，
 *   用一个真实的 `users` 行 + 真实 `rolesUsers` 绑定换一枚 JWT。
 *   因此：
 *     · 角色、门店绑定、ACL 全部是**既有**的那一套；
 *     · 本应用不知道也不判断"这个用户能不能看某条工单"——
 *       每次请求都会由服务端重新裁一遍；
 *     · 停用账号、撤销角色、解除门店绑定，在**下一次请求**立刻生效，
 *       不需要本应用配合。
 *
 *   ⇒ 换句话说：本应用只是"换了个壳"，权限体系一个字没动。
 *
 * ===========================================================================
 * 为什么用 Bearer 而不是 Cookie（取证结论，不是偏好）
 * ===========================================================================
 *   NocoBase 的 Cookie token 只在**文件访问路径 + GET/HEAD** 时被接受：
 *     const canUseAuthCookie = (ctx.state.fileAccess || ctx.state.legacyFileAccess)
 *                           && ['GET','HEAD'].includes(ctx.method);
 *   业务 API 的 POST（受理/派工/建档）一律 EMPTY_TOKEN。
 *   所以本应用必须自己持有 Bearer Token。
 *
 *   好消息：Bearer 请求**不需要 CSRF 头**（已实测 POST 200），
 *   因此不存在"cookie + csrf"那一套复杂度。
 */

import { ApiError, request, setToken, getToken, setUnauthorizedHandler, setActiveRole } from './http';

export interface Role {
  name: string;
  title: string;
}

export interface CurrentUser {
  id: number;
  nickname: string;
  username: string;
  email: string | null;
  roles: Role[];
}

/** 业务角色枚举（与库内 `roles.name` 一致） */
export const ROLE = {
  ADMIN: 'admin',
  STORE_SALES: 'store_sales',
  STORE_AFTER_SALES: 'store_after_sales',
  STORE_MANAGER: 'store_manager',
  HQ_ADMIN: 'hq_admin',
  HQ_AFTER_SALES: 'hq_after_sales',
} as const;

export type RoleName = (typeof ROLE)[keyof typeof ROLE];

/**
 * 从账号实际拥有的角色里选一个作为**当前工作角色**（发给服务端做 `X-Role`）。
 *
 * 🔴 DEV-273：这一步不能省。一个账号可以同时绑定多个角色（生产实测：
 * 门店销售账号同时有 `store_after_sales` + `store_sales`），而 NocoBase
 * 一次只按**一个**角色裁决。不指定时它会挑其中一个，实测挑的是
 * `store_after_sales` —— 于是销售看不到自己建的档案（403 No permissions），
 * 而 `store_after_sales` 本来就没有 serviceArchives 授权，**403 完全正确**。
 *
 * 选序依据是"这个人来 `/m/` 最可能干什么"：
 *   销售建档 → store_sales 优先（这是唯一能建档的角色）
 *   售后处理 → store_after_sales
 *   门店负责人 → store_manager（只读工单 + 档案）
 *   总部 → hq_admin / hq_after_sales
 *
 * ⚠️ 这**不是**权限判断 —— 服务端仍会独立裁决。选错了的后果只是
 *    "按另一个角色的权限看"，不会越权：服务端只认它自己那份 ACL。
 */
const ROLE_PRIORITY: string[] = [
  ROLE.STORE_SALES,      // 销售：唯一能建档，且 /m/new 的主用户
  ROLE.STORE_MANAGER,    // 门店负责人：只读工单 + 档案
  ROLE.STORE_AFTER_SALES,// 门店售后：工单处理
  ROLE.HQ_ADMIN,
  ROLE.HQ_AFTER_SALES,
  ROLE.ADMIN,
];

export function pickActiveRole(user: CurrentUser | null): string | null {
  const names = (user?.roles ?? []).map((r) => r.name);
  if (names.length === 0) return null;
  for (const want of ROLE_PRIORITY) {
    if (names.includes(want)) return want;
  }
  // 没有登记过的角色：交给服务端默认裁决（不瞎猜）
  return null;
}

/**
 * 角色 → 能力。**这只是"界面该显示什么"的映射**，
 * 不是权限判断。服务端仍然会对每个请求独立裁决。
 *
 * ⚠️ 因此即使本函数判错（比如新角色没登记），后果也只是"某个 Tab 没显示"，
 *    而不是"越权访问"。这是刻意把前端的作用压到"展示"这一层。
 */
export interface Capabilities {
  /** 能看工单（售后/负责人/总部） */
  tickets: boolean;
  /** 能看服务档案（销售/负责人/总部） */
  archives: boolean;
  /** 能**新建**档案（只有门店销售） */
  archiveCreate: boolean;
  /** 能受理/派工/改派等写操作（售后 + 总部） */
  ticketWrite: boolean;
  /** 能跨门店看（总部） */
  crossStore: boolean;
  /** 客户摘要查询入口（所有人都有，它是匿名功能） */
  archiveQuery: boolean;
  /** 总部看板 */
  hqOverview: boolean;
}

export function capabilitiesOf(user: CurrentUser | null): Capabilities {
  const names = new Set((user?.roles ?? []).map((r) => r.name));
  const isHq = names.has(ROLE.HQ_ADMIN) || names.has(ROLE.HQ_AFTER_SALES);
  const isAdmin = names.has(ROLE.ADMIN);
  const isAs = names.has(ROLE.STORE_AFTER_SALES);
  const isSales = names.has(ROLE.STORE_SALES);
  const isMgr = names.has(ROLE.STORE_MANAGER);

  return {
    // 负责人能"看"工单但不能写 —— 这条与服务端矩阵一致（store_manager 是只读）
    tickets: isAs || isMgr || isHq || isAdmin,
    archives: isSales || isMgr || isHq || isAdmin,
    // ⚠️ 只有 store_sales 能建档。服务端 `archiveCreate` 对其它角色返回
    //    ARCHIVE_FORBIDDEN，所以这里不给入口，避免用户点了才被拒。
    archiveCreate: isSales,
    ticketWrite: isAs || isHq || isAdmin,
    crossStore: isHq || isAdmin,
    // 匿名功能，任何登录用户都能用（它本来就是给客户用的）
    archiveQuery: true,
    hqOverview: isHq || isAdmin,
  };
}

/** 401 时的跳转由 AppRouter 注册，避免本模块依赖路由 */
let redirectToLogin: (() => void) | null = null;
export function onSessionExpired(fn: () => void): void {
  redirectToLogin = fn;
}

let bootstrapped = false;
function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;
  setUnauthorizedHandler(() => {
    redirectToLogin?.();
  });
}

/**
 * 登录。
 *
 * ⚠️ 刻意**不做**"记住账号"、**不做**"自动重试"。
 *    登录失败只有两种原因：账号密码错、网络断。
 *    前者的重试毫无意义（还可能触发对方的风控），后者用户自己会重试。
 */
export async function signIn(account: string, password: string): Promise<CurrentUser> {
  bootstrap();
  // 登录时还没有角色信息 ⇒ 明确不让 http 层注入 X-Role
  setActiveRole(null);
  const out = await request<{ token?: string; user?: any }>('/auth:signIn', {
    method: 'POST',
    body: { account: account.trim(), password },
    skipAuthRedirect: true,
    timeoutMs: 15_000,
    skipRole: true,
  });

  const token = out?.token;
  if (!token) {
    // 200 但没有 token —— 服务端行为变了。这里必须显式失败，
    // 否则会得到一个"登录成功但什么都打不开"的诡异状态。
    throw new ApiError(200, 'NO_TOKEN', '登录响应异常：未取得登录凭证');
  }
  setToken(token);

  const user = await fetchCurrentUser();
  if (!user) {
    setToken(null);
    throw new ApiError(200, 'NO_USER', '登录成功但无法读取账号信息，请重试');
  }
  // 角色拿到之后再定"以什么身份工作"（DEV-273）
  setActiveRole(pickActiveRole(user));
  return user;
}

/** 登出。本地清 token 即可 —— JWT 是自包含的，服务端无需吊销 */
export async function signOut(): Promise<void> {
  setActiveRole(null);
  setToken(null);
}

/**
 * 读当前用户。
 *
 * ⚠️ 用 `auth:check` 而不是 `users:me`：前者是**认证**接口，
 *    只回"你是谁"；后者是**数据**接口，受 users 表 ACL 约束 ——
 *    门店销售角色对 `users` 表本来就没有读权限，用后者会得到 403，
 *    然后我会误以为"登录态失效了"。
 */
export async function fetchCurrentUser(): Promise<CurrentUser | null> {
  if (!getToken()) return null;
  // auth:check 是"你是谁"，不是"你以什么角色工作" ⇒ 不带 X-Role
  const raw = await request<any>('/auth:check', { skipAuthRedirect: true, skipRole: true });
  if (!raw?.id) return null;
  return {
    id: Number(raw.id),
    nickname: String(raw.nickname ?? raw.username ?? ''),
    username: String(raw.username ?? ''),
    email: raw.email ?? null,
    roles: Array.isArray(raw.roles)
      ? raw.roles.map((r: any) => ({ name: String(r.name ?? ''), title: String(r.title ?? r.name ?? '') }))
      : [],
  };
}

/** 有 token 就尝试恢复会话；失败返回 null（不抛，让上层决定显示登录页还是错误页） */
export async function restoreSession(): Promise<CurrentUser | null> {
  bootstrap();
  if (!getToken()) return null;
  try {
    const user = await fetchCurrentUser();
    // 刷新页面后必须重算角色，否则 X-Role 丢失 ⇒ 退回服务端默认角色 ⇒ 403（DEV-273）
    setActiveRole(pickActiveRole(user));
    return user;
  } catch {
    setActiveRole(null);
    setToken(null);
    return null;
  }
}
