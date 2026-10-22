/**
 * native-sensitive-field-guard.ts —— 业务角色的**原生读接口字段脱敏**（BE-01-S0）
 *
 * ===========================================================================
 * 为什么需要这一层（第一手实测，2026-10-20）
 * ===========================================================================
 * `svc:*` 动作在服务层调 `permissionService.maskMobile()`，按 `MASK_MOBILE_ROLES`
 * 把手机号打码。但**后台列表/详情根本不走 `svc:*`**——它们走 NocoBase 原生集合接口：
 *
 *   GET /api/serviceTickets:list    → 200，返回完整 customer_mobile / technician_mobile
 *   GET /api/serviceTickets:get     → 200，同上
 *   GET /api/serviceVisits:list     → 200，返回完整 technician_mobile
 *
 * viewer（只读管理层）同样能拿到。也就是说：**掩码策略只覆盖了一条路，另一条路完全敞开**。
 *
 * ===========================================================================
 * 为什么在中间件层做，而不是 ACL 字段白名单
 * ===========================================================================
 * ACL 的字段级配置只能"给/不给字段"，不能"给打码后的值"。直接去掉字段会让
 * 后台列表整列变空——用户明确要求"允许合法的脱敏展示，不能因为关闭敏感字段
 * 把管理查看功能全部封死"。
 *
 * 所以：**保留字段、改写值**。挂在 `after: 'acl'`，在 action 返回后处理 `ctx.body`。
 *
 * ⚠️ 只对 `MASK_MOBILE_ROLES`（当前 = viewer）生效；hq_after_sales / hq_admin /
 *    store_after_sales 的手机号语义**一点不变**（它们本来就需要联系客户/师傅）。
 * ⚠️ 只改**响应体**，不碰数据库；不改变任何字段的可读性判断（那是 ACL 的事）。
 * 🔴 本层不是"唯一防线"：ACL 仍然最小授权（viewer 无写动作、users/roles 403），
 *    本层只补"读到了但不该看全"的那一段。
 */
import type { Context, Next } from 'koa';
import { MASK_MOBILE_ROLES } from '../constants';

/** 需要脱敏的资源（原生集合名，不是 URL）。 */
const TARGET_RESOURCES: readonly string[] = ['serviceTickets', 'serviceVisits'];

/** 需要脱敏的字段名（精确匹配，避免误伤 `*_mobile_hash` 之类）。 */
const SENSITIVE_FIELDS: readonly string[] = ['customer_mobile', 'technician_mobile'];

/**
 * 联系方式脱敏（**不依赖"必须是标准手机号"**）。
 *
 * 🔴 2026-10-20 审计实测的漏点：第一版只认 `^1[3-9]\d{9}$`，不匹配就 `return 原值` ——
 *    于是下面这些**原样返回给 viewer**：
 *      `+8613800001111` / `138 0000 1111` / `138-0000-1111` / `0731-88886666`
 *    "格式不规范"不等于"可以公开"。库里出现什么格式，客户端就可能原样拿到。
 *
 * 现在的规则（fail-closed）：
 *   · 先归一化：去空格/括号/短横线，去掉 `+86` 前缀；
 *   · 11 位手机 → `138****1111`；
 *   · 其它含 ≥7 位数字的（座机等）→ 保留前 3 后 4 其余打码；
 *   · 太短/非数字 → `***`（**绝不原样放行**）；
 *   · 空值 → 原样空（不泄露任何信息）。
 *
 * ⚠️ 只用于 `customer_mobile` / `technician_mobile` 这类**个人联系方式**；
 *    门店业务电话（`stores.phone`）属允许公开，不经过本函数。
 */
export function maskMobileValue(value: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) return raw;
  const normalized = raw.replace(/[\s()\-]/g, '').replace(/^\+?86(?=1[3-9]\d{9}$)/, '');
  if (/^1[3-9]\d{9}$/.test(normalized)) {
    return `${normalized.slice(0, 3)}****${normalized.slice(-4)}`;
  }
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  return '***';
}

/** 深度遍历响应体；只替换命中字段名的字符串值。 */
function maskDeep(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) maskDeep(item);
    return;
  }
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (SENSITIVE_FIELDS.includes(key) && typeof value === 'string') {
      record[key] = maskMobileValue(value);
      continue;
    }
    maskDeep(value);
  }
}

/** `ctx.state.currentUser.roles` 在不同版本可能是字符串数组或 `{name}` 数组 */
function roleNamesOf(ctx: Context): string[] {
  const roles = (ctx.state as any)?.currentUser?.roles;
  if (!Array.isArray(roles)) return [];
  return roles
    .map((r: any) => (typeof r === 'string' ? r : r?.name))
    .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0);
}

export function createNativeSensitiveFieldGuard(options: {
  roles?: readonly string[];
  logger?: { info?: (msg: string) => void };
} = {}) {
  const maskedRoles = options.roles ?? MASK_MOBILE_ROLES;

  return async function nativeSensitiveFieldGuard(ctx: Context, next: Next): Promise<void> {
    await next();

    // 只在成功响应上处理；错误响应没有业务数据
    if (typeof ctx.status === 'number' && ctx.status >= 400) return;

    const resource = String((ctx as any).action?.resourceName ?? '');
    if (!TARGET_RESOURCES.includes(resource)) return;

    const roles = roleNamesOf(ctx);
    if (!roles.some((r) => maskedRoles.includes(r as any))) return;

    maskDeep(ctx.body);
  };
}
