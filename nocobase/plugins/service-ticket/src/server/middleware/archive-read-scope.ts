/**
 * archive-read-scope.ts —— `serviceArchives` 原生只读通道的**字段级**裁剪
 * ===================================================================================================
 * 它解决什么问题
 * ===================================================================================================
 *   R2.2.1 §四 要求：员工端档案卡片显示**完整 11 位客户手机号，仅授权销售**，
 *   并且「**必须在服务端完成角色与门店范围控制**」。
 *
 *   但员工端的列表/详情走的是 **原生** `/serviceArchives:list` / `:get`
 *   （见 src-mobile/src/api/archives.ts 文件头的通道说明）。原生通道由
 *   NocoBase ACL 裁决 —— 而 ACL 的粒度是「资源 × action × 字段」，
 *   **没有行级、也没有"按行的角色"维度**。
 *
 *   ⇒ 给 `store_sales` 放开 `customer_mobile` 字段，等于**同时**放给了：
 *       · 门店负责人（store_manager，只读，不该看号码）；
 *       · 绑了多家店的销售（能看全店范围，包括非本店的档案）；
 *       · 总部只读角色。
 *     这三类人都能拿 token 直接 `GET /api/serviceArchives:list?fields=customer_mobile`
 *     把整表号码拉走。这不是"界面上看不见"，是**已经下载到浏览器**了。
 *
 * ===================================================================================================
 * 做法：在响应写出之前，按行重写 `customer_mobile`
 * ===================================================================================================
 *   本中间件挂在 `serviceArchives` 的只读动作上（list / get / view），
 *   在 `await next()` **之后**（此时 `ctx.body` 已经是 NocoBase 组装好的行）：
 *     · 逐行调 `canReadArchiveCustomerMobile(actor, row.store_id)`；
 *     · 不可见 ⇒ 把 `customer_mobile` 置为 `null`；
 *     · 同时补一个 `customer_mobile_visible: boolean`。
 *
 *   🔴 为什么是 **null** 而不是 `138****8888`：
 *     掩码仍泄露号段与首尾位。配合"这个名字我知道是谁"，足以缩到个位数候选。
 *     完整理由见 services/archive-mobile-visibility.ts 文件头。
 *
 *   🔴 为什么补 `customer_mobile_visible`：
 *     前端不该用"手机号是不是 null"反推权限 —— 那样"客户没填号码"会被
 *     误判成"你无权查看"，界面会对着一个本来就没填的字段说"已隐藏"。
 *     把判定结果显式说出来，两种语义才分得开。
 *
 * ===================================================================================================
 * 四条边界（都被反向验证钉过）
 * ===================================================================================================
 *   ① **只裁这一个字段**，不碰其它列，也不改行数 / 排序 / 分页 ——
 *      本层是"字段投影"，不是"数据范围过滤"。行级范围由 ACL 的 storeScope 负责，
 *      两件事混在一个中间件里会让"少了一行"与"少了一个字段"无法区分归因。
 *   ② **写动作不经过本层**（原生 update/create 本来就没有业务授权），
 *      但为了 fail-closed 仍然拦截并 403，避免将来 ACL 放宽时出现后门。
 *   ③ **匿名**：客户公开查询走的是 `progress` 投影（根本不含 customer_mobile），
 *      不经过本层；若哪天有人把原生 list 开给匿名，本层会按"无 actor"处理
 *      ⇒ `canReadArchiveCustomerMobile` 的第一个分支就返回 false ⇒ 一律 null。
 *   ④ **平台超管**（root / admin）不经过本层：维护视图需要看到真实数据，
 *      而它们本来就能读整库（拦着只是让人去 psql 里查，反而绕开审计）。
 */

import { canReadArchiveCustomerMobile } from '../services/archive-mobile-visibility';

/** 本中间件只管这一张表。 */
const SCOPED_RESOURCE = 'serviceArchives';

/** 需要裁剪的只读动作。`view` 是表格区块的 ACL 探针（与 settings-read-scope 同口径）。 */
const READ_ACTIONS = new Set(['list', 'get']);

/** 唯一需要处理的字段。枚举成常量，避免字符串散落。 */
const MOBILE_FIELD = 'customer_mobile';

const PLATFORM_ROLE_NAMES = ['root', 'admin'];

export interface ArchiveReadScopeOptions {
  logger?: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    debug?: (m: string) => void;
  };
}

/** 平台角色判定：`platformRoles` 与 `roles` 都看（不同路径下这两块填的东西不同）。 */
function isPlatform(ctx: any): boolean {
  const user: any = (ctx as any)?.state?.currentUser;
  if (!user) return false;
  const names: string[] = [];
  for (const r of Array.isArray(user.roles) ? user.roles : []) {
    names.push(String(typeof r === 'string' ? r : r?.name ?? ''));
  }
  for (const r of Array.isArray(user.platformRoles) ? user.platformRoles : []) {
    names.push(String(typeof r === 'string' ? r : r?.name ?? ''));
  }
  const stateRoles = (ctx as any)?.state?.currentRoles;
  if (Array.isArray(stateRoles)) names.push(...stateRoles.map(String));
  return names.some((n) => PLATFORM_ROLE_NAMES.includes(n));
}

/**
 * 从 `ctx.state.currentUser` 推出 `canReadArchiveCustomerMobile` 需要的 actor 形状。
 *
 * ⚠️ 这里**不复用** `permissions.resolveActor()`：
 *    那是业务 svc action 的入口，会跑一遍角色归一化 + 门店绑定查询；
 *    在裸读中间件里再跑一次等于每条列表请求多两次 SQL，
 *    而且两组 actor 的字段名不同（`roles` vs `storeIds`），混用会静默判错。
 *    本层只需要三样东西，直接取。
 */
interface RowActor {
  roles: string[];
  platformRoles: string[];
  storeIds: number[];
}

let cachedStoreIds = new WeakMap<object, number[]>();

async function actorOf(ctx: any): Promise<RowActor | null> {
  const user: any = (ctx as any)?.state?.currentUser;
  if (!user) return null;

  const roles: string[] = [];
  for (const r of Array.isArray(user.roles) ? user.roles : []) {
    roles.push(String(typeof r === 'string' ? r : r?.name ?? ''));
  }
  const platformRoles: string[] = [];
  for (const r of Array.isArray(user.platformRoles) ? user.platformRoles : []) {
    platformRoles.push(String(typeof r === 'string' ? r : r?.name ?? ''));
  }

  // 门店绑定：优先用缓存（同一请求内 list + count 会各来一次）
  const hit = cachedStoreIds.get(user);
  if (hit) return { roles, platformRoles, storeIds: hit };

  const repo = (ctx as any)?.db?.getRepository?.('storeUsers');
  let storeIds: number[] = [];
  if (repo) {
    try {
      const rows = await repo.find({ filter: { user_id: Number(user.id) }, fields: ['store_id'] });
      storeIds = (rows ?? [])
        .map((r: any) => Number(typeof r.toJSON === 'function' ? r.toJSON().store_id : r.store_id))
        .filter((n: number) => Number.isFinite(n) && n > 0);
    } catch {
      // 查不到门店 ⇒ 空数组 ⇒ canReadArchiveCustomerMobile 必然 false（fail-closed）
      storeIds = [];
    }
  }
  cachedStoreIds.set(user, storeIds);
  return { roles, platformRoles, storeIds };
}

/**
 * 对一行做裁剪。导出以便门禁做纯函数断言。
 *
 * ===================================================================================================
 * 🔴 必须**就地改写**，不能返回新对象（2026-11-19 实测踩到的最深一个坑）
 * ===================================================================================================
 *   NocoBase 在 `after: 'acl'` 这个位置上，`ctx.body` 里的列表行**不是**普通对象，
 *   而是 Sequelize 的 **Model 实例**。它的 `toJSON()` 读的是内部的
 *   `dataValues` / `_previousDataValues`。
 *
 *   第一版写的是 `return { ...row, customer_mobile: ..., customer_mobile_visible: ... }`：
 *     · 展开运算符只复制**自有可枚举属性**（`dataValues` 等内部对象），
 *     · 于是新对象**不再是 Model 实例**，`toJSON` 退化成普通对象序列化，
 *     · 结果响应里每行只剩 `dataValues / _previousDataValues / uniqtno / ...`
 *       这一堆 Sequelize 内部字段，**真实字段全部消失**。
 *
 *   而这一版之前的表现更糟：现象是"列表看起来正常、但被裁剪的行少了一半字段"，
 *   排查方向会一路歪到"ACL 字段授权"上去 —— 实际上授权一点问题都没有。
 *
 *   ⇒ 判定逻辑抽成纯函数 `mobileVisibleForRow()`（可单测、可变异），
 *     改写动作一律走 `applyMobileProjection()`：Model 实例直接 `set()`，
 *     普通对象直接赋值。两条路都不换对象身份。
 */
export function mobileVisibleForRow(row: any, actor: RowActor | null): boolean {
  if (!actor) return false; // 无 actor ⇒ fail-closed
  const storeId = row?.store_id ?? row?.storeId ?? (row?.get ? row.get('store_id') : null);
  return canReadArchiveCustomerMobile(actor as any, storeId);
}

/**
 * 就地应用裁剪。**不返回值**，避免调用方误用新对象。
 *
 * @returns 实际写入的可见性（供调试日志用）
 */
export function applyMobileProjection(row: any, actor: RowActor | null): boolean {
  if (!row || typeof row !== 'object') return false;
  const visible = mobileVisibleForRow(row, actor);
  const maskedMobile = visible ? (row.customer_mobile ?? null) : null;

  // ① Sequelize Model 实例：`set()` 会同时更新 dataValues 与 _previousDataValues，
  //    保证 toJSON() 与后续可能存在的 update 逻辑看到同一个值。
  if (typeof row.set === 'function' && row.dataValues) {
    row.set('customer_mobile', maskedMobile, { raw: true });
    row.set('customer_mobile_visible', visible, { raw: true });
    // `set` 会把字段标成 changed ⇒ 撤销掉：本站只是投影，没有改任何东西
    if (row._changed && typeof row._changed === 'object') {
      if (typeof row._changed.delete === 'function') {
        row._changed.delete('customer_mobile');
        row._changed.delete('customer_mobile_visible');
      } else {
        delete row._changed.customer_mobile;
        delete row._changed.customer_mobile_visible;
      }
    }
    return visible;
  }

  // ② 普通对象（`get({ plain: true })` 或 JSON 反序列化后的形态）
  row.customer_mobile = maskedMobile;
  row.customer_mobile_visible = visible;
  return visible;
}

export function createArchiveReadScopeMiddleware(options: ArchiveReadScopeOptions = {}) {
  const log = options.logger;

  return async function archiveReadScope(ctx: any, next: () => Promise<void>): Promise<void> {
    const resource = String((ctx as any)?.action?.resourceName ?? '');
    if (resource !== SCOPED_RESOURCE) return next();

    const action = String((ctx as any)?.action?.actionName ?? '');

    // 写动作：原生通道本来没有业务授权；这里再兜一道，防止将来 ACL 放宽成后门
    if (!READ_ACTIONS.has(action)) {
      if (action === 'view') {
        // ACL 探针：放行，不读数据
        return next();
      }
      log?.warn?.(`[svc:archive-read-scope] 拒绝 serviceArchives:${action}（只允许只读）`);
      ctx.throw(403, 'No permissions');
    }

    // 平台角色：维护视图完整（它们本来就能读整库）
    if (isPlatform(ctx)) return next();

    const actor = await actorOf(ctx);
    if (!actor) {
      // 匿名：ACL 通常已经拒了；万一放行，本层按"无权限"处理
      log?.warn?.(`[svc:archive-read-scope] ${action} 无 actor，按不可见处理`);
    }

    await next();

    // ⚠️ 必须在 next() 之后：此时 ctx.body 才是 NocoBase 组装好的结果
    const body: any = (ctx as any).body;
    if (!body) return;

    const effActor: RowActor = actor ?? { roles: [], platformRoles: [], storeIds: [] };

    try {
      /**
       * 🔴 响应体有**三种**形态，必须都覆盖（2026-11-19 实测踩到）：
       *
       *   ① 列表：`{ count, rows: [...], page, pageSize, totalPage }`
       *      —— NocoBase 的 `ctx.withoutDataWrapping` 分支下就是它。
       *      第一版只判了 `body.data` / `body` 是数组，于是列表**原样穿过去**，
       *      手机号一个都没裁 —— 而中间件本身明明挂上了（那是"判据写错"，
       *      不是"没生效"，两者的排查方向完全相反）。
       *   ② 单条：`{ data: {...} }`（默认 dataWrapping）
       *   ③ 裸数组 / 裸对象（个别 action 关掉包装直接回数组）
       */
      const projectList = (list: any[]) => {
        for (const row of list) applyMobileProjection(row, effActor);
      };

      if (Array.isArray(body)) {
        projectList(body);
      } else if (Array.isArray(body?.rows)) {
        // ① NocoBase 列表形态 `{ count, rows, page, pageSize, totalPage }`
        projectList(body.rows as any[]);
      } else if (Array.isArray(body?.data)) {
        // ② 列表（dataWrapping 未关）
        projectList(body.data);
      } else if (body?.data && typeof body.data === 'object') {
        // ③ 单条 `{ data: {...} }`
        applyMobileProjection(body.data, effActor);
      } else if (typeof body === 'object') {
        // ④ 裸对象（`:get` 关掉包装时）——同样就地改，不换对象身份
        applyMobileProjection(body, effActor);
      }

    } catch (error) {
      // 裁剪失败 ⇒ **不要**把原样数据放出去。直接把响应打掉，
      // 让前端拿到明确错误（而不是静默拿到完整手机号）。
      log?.warn?.(`[svc:archive-read-scope] 裁剪失败，拒绝响应：${String((error as Error)?.message ?? error)}`);
      ctx.status = 500;
      ctx.body = { errors: [{ code: 'ARCHIVE_SCOPE_FAILED', message: '无法安全下发档案数据，请稍后重试' }] };
    }
  };
}
