/**
 * settings-read-scope.ts —— `serviceSettings` 的**行级**读取收窄（UX-01C）
 *
 * ===========================================================================
 * 它解决什么问题
 * ===========================================================================
 * 「服务时效」页是一张 `serviceSettings` 原生表格，而 NocoBase 的资源级授权
 * 粒度是「资源 × action × 字段」，**没有行级维度**。给 `hq_admin` 放行
 * `serviceSettings:list` 的实际效果是：整表（`sms.*` / `security.*` / `privacy.*`
 * / `historical.*` …）全部可读。
 *
 * ⇒ 本中间件把"能不能读这张表"与"能读到哪些行"分开：
 *    ACL / `native-metadata-guard` 决定前者；本层决定后者，且**只放本页真正要的键**。
 *
 * ===========================================================================
 * 🔴 为什么不能靠页面上的 `defaultFilter`
 * ===========================================================================
 * 页面配置是**客户端**的：任何人拿 token 直接 `GET /api/serviceSettings:list`
 * 都绕过它。`defaultFilter` 只决定"界面默认看到什么"，**不是权限边界**。
 * 这条与 docs/SECURITY.md 的"前端过滤不算隔离"同口径。
 *
 * ===========================================================================
 * 四个动作分别处理
 * ===========================================================================
 *   list / view → **注入** `key ∈ 允许清单`；与客户端 filter 用 `$and` 合并
 *                 （不覆盖 —— 覆盖意味着攻击者可以用 filter 把范围条件挤掉）
 *   get         → 按主键取到行后校验 `key`；越界 / 查不到 ⇒ 403（fail-closed）
 *   create/update/destroy/... → **一律 403**（写只有 `svc:updateSetting` 一条路）
 *
 * 角色：`root` / 平台 `admin` 不经过本层（维护能力完整）；
 *      业务角色中**只放行 `hq_admin`**，其余角色即使 ACL 某天漏放开，这里仍然 403。
 *
 * ⚠️ 允许清单**取自** `SETTING_EDIT_SPECS`（受控写白名单），不另立一份：
 *    读的范围与写的范围必须同源，否则会出现"能看到但改不了"或"能改但看不到"的
 *    第二种真相 —— 那正是本项目反复踩的"两份清单漂移"。
 */
import type { Context, Next } from 'koa';

import { SETTING_EDIT_SPECS } from '../actions/svc/config-settings';

/** 本中间件只管这一张表。 */
const SCOPED_RESOURCE = 'serviceSettings';

/** 需要收窄的只读 action（`view` 是表格区块的 ACL 探针，见 DEV-65）。 */
const READ_ACTIONS = new Set(['list', 'get', 'view']);

/** 唯一被允许读该表的业务角色。 */
const ALLOWED_BUSINESS_ROLE = 'hq_admin';

/** 平台角色：完整维护能力，不经过本层。 */
const PLATFORM_ROLE_NAMES = ['root', 'admin'];

/**
 * 「服务时效」页可见的配置键。
 *
 * ⚠️ 从 R8 起 `SETTING_EDIT_SPECS` 还包含短信三项（`sms.*`），但**原生行级读取
 * 继续只放 SLA 三键**：
 *   · R5 的门禁（`verify-ux-01c-settings-auth`）把"list 恰好 3 行"写成了冻结断言；
 *   · 短信配置属于总部运维面，只经 `svc:smsStatus` / `svc:updateSetting` 受控读写，
 *     没必要放宽原生表读取（扩大读取面 = 扩大泄露面）。
 * ⇒ 用 `sla.` 前缀显式收窄，而不是"把白名单跟着扩"。
 */
export const SETTINGS_READ_KEYS: readonly string[] = SETTING_EDIT_SPECS.filter((s) =>
  s.key.startsWith('sla.'),
).map((s) => s.key);

/** 允许下发的列。该表没有秘密列，但显式列出，防止将来加列时被自动带出。 */
const SAFE_FIELDS: readonly string[] = [
  'id',
  'key',
  'value',
  'value_type',
  'description',
  'updated_by',
  'createdAt',
  'updatedAt',
];

export interface SettingsReadScopeOptions {
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; debug?: (m: string) => void };
  /** 便于门禁注入不同清单做反向验证；缺省用 `SETTINGS_READ_KEYS`。 */
  allowedKeys?: readonly string[];
}

function roleNamesOf(ctx: Context): string[] {
  const single = (ctx as any)?.state?.currentRole ? [String((ctx as any).state.currentRole)] : [];
  const multi = Array.isArray((ctx as any)?.state?.currentRoles)
    ? (ctx as any).state.currentRoles.map(String)
    : [];
  return [...new Set([...single, ...multi])];
}

function isPlatform(ctx: Context): boolean {
  const roles = roleNamesOf(ctx);
  return PLATFORM_ROLE_NAMES.some((r) => roles.includes(r));
}

/** 当前请求是否是业务角色中的 `hq_admin`。 */
export function isSettingsReader(ctx: Context): boolean {
  return roleNamesOf(ctx).includes(ALLOWED_BUSINESS_ROLE);
}

/**
 * 把"可见键范围"叠加到既有 filter 上。
 *
 * 抽成纯函数便于门禁直接断言：`filter` 的合并方式（$and 而不是覆盖）
 * 是本层最容易被改坏的一行，必须能被单测钉住。
 */
export function mergeKeyFilter(
  original: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const keyFilter = { key: { $in: [...allowedKeys] } };
  if (!original || typeof original !== 'object') return keyFilter;
  if (Array.isArray(original) && original.length === 0) return keyFilter;
  return { $and: [original as Record<string, unknown>, keyFilter] };
}

/** 把请求的 fields 收窄到 `SAFE_FIELDS`（请求未指定 ⇒ 直接用安全清单）。 */
export function narrowFields(requested: unknown): string[] {
  if (!Array.isArray(requested) || requested.length === 0) return [...SAFE_FIELDS];
  const kept = requested.map(String).filter((f) => SAFE_FIELDS.includes(f));
  // 交集为空 ⇒ 宁可回安全清单，也不回空数组（空数组语义是"只给 id/时间戳"，会让表格空白）
  return kept.length > 0 ? kept : [...SAFE_FIELDS];
}

export function createSettingsReadScopeMiddleware(options: SettingsReadScopeOptions = {}) {
  const log = options.logger;
  const allowedKeys = options.allowedKeys ?? SETTINGS_READ_KEYS;

  return async function settingsReadScope(ctx: Context, next: Next): Promise<void> {
    const resource = String((ctx as any)?.action?.resourceName ?? '');
    if (resource !== SCOPED_RESOURCE) return next();

    // 平台角色：维护能力完整（与其它中间件同口径）
    if (isPlatform(ctx)) return next();

    // 匿名请求不归本层管（ACL 已拒；匿名白名单里没有该资源）
    if (!(ctx as any)?.state?.currentUser) return next();

    const action = String((ctx as any)?.action?.actionName ?? '');

    // ① 非只读动作：一律拒绝（写只有 svc:updateSetting 一条受控路径）
    if (!READ_ACTIONS.has(action)) {
      log?.warn?.(`[svc:settings-read-scope] 拒绝 serviceSettings:${action}（只允许只读）`);
      ctx.throw(403, 'No permissions');
    }

    // ② 非 hq_admin 的业务角色：即使 ACL 放开也拒绝（第二道，fail-closed）
    if (!isSettingsReader(ctx)) {
      log?.warn?.(`[svc:settings-read-scope] 拒绝非 hq_admin 读取 serviceSettings:${action}`);
      ctx.throw(403, 'No permissions');
    }

    const actionObj = (ctx as any).action;
    const params = actionObj?.params ?? {};

    // ③ get / view：先按主键取行，校验 key 是否在清单内
    if (action === 'get' || action === 'view') {
      const tk = params.filterByTk ?? params.filter?.id;
      const id = Number(tk);
      if (!Number.isFinite(id) || id <= 0) {
        log?.warn?.(`[svc:settings-read-scope] ${action} 缺少合法主键，拒绝`);
        ctx.throw(403, 'No permissions');
      }
      const repo = (ctx as any).db?.getRepository?.(SCOPED_RESOURCE);
      if (!repo) {
        log?.warn?.('[svc:settings-read-scope] 取不到 repository，拒绝（fail-closed）');
        ctx.throw(403, 'No permissions');
      }
      const row = await repo.findOne({ filter: { id }, fields: ['id', 'key'] });
      if (!row || !allowedKeys.includes(String(row.key))) {
        log?.warn?.(`[svc:settings-read-scope] ${action} 目标行不在可见清单内，拒绝`);
        ctx.throw(403, 'No permissions');
      }
      return next();
    }

    // ④ list：注入键范围 + 字段白名单（不覆盖客户端 filter，用 $and 叠加）
    const merged = { filter: mergeKeyFilter(params.filter, allowedKeys), fields: narrowFields(params.fields) };
    if (typeof actionObj?.mergeParams === 'function') {
      actionObj.mergeParams(merged);
    } else {
      (ctx as any).action.params = { ...params, ...merged };
    }

    log?.debug?.(`[svc:settings-read-scope] list 收窄为 ${allowedKeys.length} 个键`);
    return next();
  };
}
