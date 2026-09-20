/**
 * PermissionService —— 对象级鉴权与门店数据隔离
 *
 * 这是本系统安全模型的地基（docs/SECURITY.md「双层数据隔离」）：
 *   第一层：ACL 决定"这个角色能不能调这个 action"（粗粒度）
 *   第二层：**本服务**决定"这条具体数据你能看/能改吗"（对象级）
 *
 * 铁律（违反任何一条都会造成越权）：
 *   1) **服务端强制**。前端藏菜单、藏按钮只是体验优化，**不构成权限**。
 *      每一个读写工单/Visit 的入口都必须过这里，包括后台原生接口。
 *   2) **fail-closed**。身份解析不出来、角色未知、门店授权为空 —— 一律按
 *      "看不到任何数据"处理，绝不是"那就放开看全部"。
 *      这是最容易写反的地方：`if (isHq) return {}` 之后忘记写 else，
 *      或者把空数组当成"无限制"，都会让门店用户看到全部门店的工单。
 *   3) **越权与不存在返回同一个结果**。门店 A 的用户查门店 B 的工单，
 *      要返回"工单不存在"（404）而不是"无权限"（403）——
 *      否则响应码本身就成了一个探测器：403 说明"这个 ID 存在"，
 *      攻击者可以逐个 ID 枚举出全部工单的存在性与分布。
 */
import {
  HQ_ROLES,
  MASK_MOBILE_ROLES,
  PLATFORM_ADMIN_ROLES,
  PRIVILEGED_ROLES,
  ROLE,
  ROLE_VALUES,
  WRITE_ROLES,
  type RoleName,
} from '../constants';

export interface Actor {
  userId: number;
  /** 用户在 NocoBase 中的角色名（可能多个） */
  roles: RoleName[];
  /**
   * 被授权的门店 ID 列表。
   * 只有门店角色需要它；总部角色为空数组但不受限（由 scope 判定区分）。
   * **注意**：空数组对门店角色意味着"什么也看不到"，而不是"不受限"。
   */
  storeIds: number[];
  /** 原始用户对象（后台展示用，如 username） */
  raw?: any;
  /**
   * NocoBase 内置的**平台超管**角色名（root / admin），见 constants.PLATFORM_ADMIN_ROLES。
   *
   * 为什么要单独记一份，而不是塞进 `roles`：
   *   `roles` 的语义是"业务角色"（normalizeRoles 只保留本系统认识的四个），
   *   拿它去做 hasRole('hq_admin') 之类的判断必须干净。
   *   平台超管是"系统主人"，它的授权是一份**独立的、集中评审的**来源，
   *   混进业务角色列表会让"谁的业务能力从哪来"变得说不清。
   */
  platformRoles?: string[];
  /**
   * 系统身份（定时任务/短信回调）标记。
   *
   * 语义要拆开看，不能被一个布尔值糊在一起：
   *   · 数据范围 —— all（定时任务要扫全量工单，否则 SLA 巡检只能覆盖一部分）；
   *   · 业务能力 —— **没有任何能力**（不冒充任何"人"，见 can() 的默认分支）。
   * 换句话说它只能"看"，且只能经服务层被系统代码调用，不能调 /api/svc 业务 action。
   */
  system?: boolean;
}

/** 数据范围：决定查询要加什么过滤条件 */
export type DataScope =
  | { kind: 'all' }
  | { kind: 'stores'; storeIds: number[] }
  | { kind: 'none' };

/** 业务动作 → 所需能力。集中在常量里，避免各处硬编码角色名。 */
export const CAPABILITY = {
  /** 查看工单/回执（含后台列表、详情、时间线） */
  VIEW_TICKET: 'view_ticket',
  /** 受理 / 派工 / 改派 / 改约 / 取消 / 确认 / 驳回 / 重发短信 */
  WRITE_TICKET: 'write_ticket',
  /** 强制转店、重开已关闭工单 */
  PRIVILEGED: 'privileged',
  /** 查看完整手机号（未脱敏） */
  VIEW_RAW_MOBILE: 'view_raw_mobile',
  /** 修改参数 / 用户 / 门店，导出 Excel */
  ADMIN: 'admin',
} as const;

export type Capability = (typeof CAPABILITY)[keyof typeof CAPABILITY];

/** 越权一律以"不存在"对外表达（见顶部铁律 3） */
export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  /**
   * HTTP 状态码。
   *
   * 为什么错误对象上要自带 status：本插件的 action 层有自己的映射表
   * （actions/svc/_http.ts 的 statusOf），走那条路的错误不需要它。
   * 但**中间件层**抛出的错误（storeScope 的对象级校验）会直接穿透到
   * NocoBase 的全局错误处理器，而后者按 `error.status` 决定响应码 ——
   * 不设这个字段时，越权读原生接口 `GET /api/serviceTickets:get?filterByTk=<别家id>`
   * 会返回 **500**（真机实测），既违反 docs/API.md §0 的「越权 = 404」，
   * 又会让"app 日志无 error"这类运维断言被噪声污染。
   *
   * 因此：凡是可能逃逸到框架层的错误，都自带状态码。
   */
  readonly status = 404;
  readonly statusCode = 404;
  /**
   * 逃逸到框架层时的日志级别。
   *
   * NocoBase 的全局错误处理器（`@nocobase/plugin-error-handler`）在兜住异常后
   * 一定会写一条日志，级别由这段代码决定：
   *
   * ```js
   * const logMethods = ['trace', 'debug', 'info', 'warn', 'error'];
   * function getLogMethod(err) {
   *   if (logMethods.includes(err?.logLevel)) return err.logLevel;
   *   return 'error';   // ← 不设 logLevel 就一律记成 error
   * }
   * ```
   *
   * 也就是说：**「越权/不存在 → 404」这条安全设计本身会让应用日志里堆满 error**。
   * 那是自欺欺人——error 日志一旦混入大量预期噪声，"error 日志 = 真出事了"
   * 这条最有用的运维断言就废了（真机实测：一条越权 get 就打出一行
   * `{"level":"error","message":"工单 10 不存在",...}`）。
   *
   * 取 `debug` 而不是 `warn`：404 在本系统里是**刻意不可区分**的对外语义
   * （见顶部铁律 3），它连"发生过一次越权"都不能被当成信号——因为正常的
   * 陈旧书签、刷新已删工单、ID 猜错都会产生 404，根本没法据此告警。
   * 这与 action 层的口径一致：`actions/svc/_http.ts` 的 handleError 对 404
   * **一条日志都不写**。框架层强制要写，那就写到默认级别（info）之下，
   * 平时不出现，需要排查时把 `LOGGER_LEVEL=debug` 打开就能全量还原。
   *
   * ⚠️ 别改成 'error'：那等于把安全设计的正常产物当成故障。
   *
   * 会不会因此丢掉安全线索？不会 —— 越权被拒的证据有**另外两条**更准确的路：
   *   · PermissionService 自己打的 `[permission] 越权访问被拒：用户 X（授权门店 […]）
   *     尝试访问门店 Y 的工单 Z`（warn，真机实测），这条能直接告警；
   *   · NocoBase 请求日志按状态码记录（4xx → warn），`response /api/serviceTickets:get
   *     ?filterByTk=N` 同样留痕。
   * 两条都保留着"谁在什么时候被拒了"，而 error-handler 那条只是重复的堆栈。
   */
  readonly logLevel = 'debug' as const;
  constructor(message = '工单不存在') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  readonly code: string;
  /** 见 NotFoundError.status 的说明：中间件层抛出的错误需要自带 HTTP 状态码 */
  readonly status: number;
  readonly statusCode: number;
  /**
   * 逃逸到框架层时的日志级别。
   *
   * 取 `warn`（不是 error）：401 会话过期、403 能力不足/跨店都是安全模型
   * 正常工作时的产物，**不是系统故障**，但比 404 更值得看一眼（它指向
   * 权限配置错配或有人在试探），所以不能被 debug 吞掉。
   * 与 actions/svc/_http.ts 的 handleError 对 403 记 warn 的口径完全一致：
   * 同一个错误类，无论是从 action 层被捕获还是从中间件层逃逸到框架，
   * 日志级别都不该漂移。见 NotFoundError.logLevel 里引用的框架实现。
   */
  readonly logLevel = 'warn' as const;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ForbiddenError';
    this.code = code;
    // 未登录 → 401；其余（能力不足、跨店、目标门店停用…）→ 403
    // 与 actions/svc/_http.ts 的 statusOf 保持同一口径，避免两处漂移。
    this.status = code === 'UNAUTHENTICATED' ? 401 : 403;
    this.statusCode = this.status;
  }
}

export interface PermissionServiceOptions {
  logger?: { warn?: (msg: string) => void; debug?: (msg: string) => void };
}

export class PermissionService {
  private readonly db: any;
  private readonly logger?: PermissionServiceOptions['logger'];

  constructor(db: any, options: PermissionServiceOptions = {}) {
    this.db = db;
    this.logger = options.logger;
  }

  // -------------------------------------------------------------------------
  // 身份解析
  // -------------------------------------------------------------------------

  /**
   * 从 NocoBase 的 ctx 解析当前操作者。
   *
   * 兼容几种真实存在的数据形态（不同版本的 ctx 结构有差异）：
   *   ctx.state.currentUser  / ctx.auth.user  / ctx.state.currentUser.roles
   * roles 元素可能是字符串，也可能是 { name } 对象。
   *
   * 解析不出用户 → 抛错（内部接口必须登录；匿名接口不走本服务）。
   */
  async resolveActor(ctx: any): Promise<Actor> {
    const user =
      ctx?.state?.currentUser ?? ctx?.auth?.user ?? ctx?.currentUser ?? ctx?.state?.auth?.user;

    if (!user) {
      throw new ForbiddenError('UNAUTHENTICATED', '未登录');
    }

    const userId = Number(user.id ?? user.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      throw new ForbiddenError('UNAUTHENTICATED', '无法识别当前用户');
    }

    const rawNames = collectRoleNames(user, ctx);
    const roles = normalizeRoles(rawNames);
    const platformRoles = filterPlatformRoles(rawNames);
    const storeIds = await this.loadStoreIds(userId, roles);

    return { userId, roles, platformRoles, storeIds, raw: user };
  }

  /**
   * 直接按 userId 构造 Actor（种子脚本、定时任务、定向测试用）。
   * 传 roleNames 可跳过角色读取（后台任务没有 ctx）。
   */
  async loadActor(userId: number | string, roleNames?: string[]): Promise<Actor> {
    const id = Number(userId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new ForbiddenError('UNAUTHENTICATED', 'userId 非法');
    }

    const rawNames =
      roleNames && roleNames.length > 0 ? roleNames : await this.loadRawRolesFromDb(id);

    const roles = normalizeRoles(rawNames);
    const platformRoles = filterPlatformRoles(rawNames);
    const storeIds = await this.loadStoreIds(id, roles);

    return { userId: id, roles, platformRoles, storeIds };
  }

  /** 系统身份（定时任务/回调）：数据范围全量，但不被授予任何"人"的业务能力 */
  systemActor(): Actor {
    return {
      userId: 0,
      roles: [],
      storeIds: [],
      platformRoles: [],
      system: true,
      raw: { username: 'system' },
    };
  }

  // -------------------------------------------------------------------------
  // 能力判定
  // -------------------------------------------------------------------------

  hasRole(actor: Actor, ...roles: RoleName[]): boolean {
    return roles.some((role) => actor.roles.includes(role));
  }

  /**
   * 是否持有 NocoBase 平台超管角色（root / admin）。
   * 语义见 constants.PLATFORM_ADMIN_ROLES：按总部管理员对待。
   */
  isPlatformAdmin(actor: Actor): boolean {
    return (actor.platformRoles || []).some((name) => PLATFORM_ADMIN_ROLES.includes(name));
  }

  isHq(actor: Actor): boolean {
    if (this.isPlatformAdmin(actor)) return true;
    return actor.roles.some((role) => HQ_ROLES.includes(role));
  }

  isReadOnly(actor: Actor): boolean {
    // 平台超管不是只读角色（它按总部管理员对待）
    if (this.isPlatformAdmin(actor)) return false;
    // 只读角色：有 viewer 且没有任何可写角色
    return actor.roles.includes(ROLE.VIEWER) && !actor.roles.some((r) => WRITE_ROLES.includes(r));
  }

  can(actor: Actor, capability: Capability): boolean {
    // 系统身份：数据范围全量，但不冒充任何"人"，因此不持有任何业务能力
    if (actor.system) return false;

    // 平台超管（root/admin）：按总部管理员对待（constants.PLATFORM_ADMIN_ROLES 注释有完整理由）
    if (this.isPlatformAdmin(actor)) return true;

    switch (capability) {
      case CAPABILITY.VIEW_TICKET:
        // 能写的人一定能看；viewer 也能看（范围由 scope 裁剪）
        return (
          actor.roles.some((r) => WRITE_ROLES.includes(r)) || actor.roles.includes(ROLE.VIEWER)
        );

      case CAPABILITY.WRITE_TICKET:
        return actor.roles.some((r) => WRITE_ROLES.includes(r));

      case CAPABILITY.PRIVILEGED:
        return actor.roles.some((r) => PRIVILEGED_ROLES.includes(r));

      case CAPABILITY.VIEW_RAW_MOBILE:
        return !actor.roles.some((r) => MASK_MOBILE_ROLES.includes(r));

      case CAPABILITY.ADMIN:
        return actor.roles.includes(ROLE.HQ_ADMIN);

      default:
        return false;
    }
  }

  /** 能力不足直接抛错（HTTP 层映射为 403） */
  assertCapability(actor: Actor, capability: Capability, message?: string): void {
    if (!this.can(actor, capability)) {
      this.logger?.warn?.(
        `[permission] 用户 ${actor.userId}（角色 ${actor.roles.join(',') || '无'}）` +
          `缺少能力 ${capability}`,
      );
      throw new ForbiddenError('FORBIDDEN', message ?? `缺少权限：${capability}`);
    }
  }

  // -------------------------------------------------------------------------
  // 数据范围
  // -------------------------------------------------------------------------

  /**
   * 当前操作者的数据范围。
   *
   * **这是全系统最需要小心的一段**：
   *   - 系统身份 / 平台超管 / 有总部角色 → all（不受授权表限制）
   *   - 门店角色且有授权门店 → stores(ids)
   *   - 其余（无角色 / 只读但无总部角色且无授权门店 / 角色未知）→ **none**
   *
   * 注意最后一条：角色解析失败时返回 none 而不是 all。
   * 把空数组当"无限制"是这类实现最常见的写反方式，后果是门店用户看到全部门店的工单。
   */
  scopeOf(actor: Actor): DataScope {
    // 系统身份与平台超管：数据范围全量（能力另算，见 can()）
    if (actor.system || this.isPlatformAdmin(actor)) return { kind: 'all' };

    if (this.isHq(actor)) return { kind: 'all' };

    const isStoreScoped = actor.roles.some((r) => r === ROLE.STORE_AFTER_SALES);
    if (isStoreScoped && actor.storeIds.length > 0) {
      return { kind: 'stores', storeIds: [...new Set(actor.storeIds)] };
    }

    // fail-closed：宁可什么都看不到，也不要因为角色配置缺失而放开全量
    this.logger?.warn?.(
      `[permission] 用户 ${actor.userId} 的角色解析结果为 [${actor.roles.join(',') || '空'}]、` +
        `授权门店 ${actor.storeIds.length} 个 → 数据范围 none（fail-closed）`,
    );
    return { kind: 'none' };
  }

  /**
   * 把数据范围合进 NocoBase 的 filter。
   *
   * @param scopeField 隔离字段名，默认 store_id（serviceTickets 与 serviceVisits 都经
   *                   ticket.store_id 隔离；Visit 自身没有 store_id，调用方需改用
   *                   ticket_id 预过滤，见 assertCanAccessTicket）
   */
  applyScope(
    actor: Actor,
    filter: Record<string, unknown> = {},
    scopeField = 'store_id',
  ): Record<string, unknown> {
    const scope = this.scopeOf(actor);

    if (scope.kind === 'all') return { ...filter };

    if (scope.kind === 'stores') {
      const existing = filter[scopeField];
      // 已显式指定的门店：必须落在授权集合内，否则直接判空
      if (existing !== undefined) {
        const requested = toIdList(existing);
        const allowed = requested.filter((id) => scope.storeIds.includes(id));
        if (allowed.length === 0) {
          this.logger?.warn?.(
            `[permission] 用户 ${actor.userId} 请求门店 [${requested.join(',')}] 不在授权范围` +
              ` [${scope.storeIds.join(',')}] → 返回空集`,
          );
          return { ...filter, id: -1 };
        }
        return { ...filter, [scopeField]: { $in: allowed } };
      }

      return { ...filter, [scopeField]: { $in: scope.storeIds } };
    }

    // none：用恒假条件让查询返回空集（比抛错更贴近"这片数据对你不可见"）
    return { ...filter, id: -1 };
  }

  /**
   * 断言当前操作者能访问某条工单，返回该工单行。
   *
   * 越权 / 不存在都抛 NotFoundError —— 调用方在 action 层映射为 **404**。
   */
  async assertCanAccessTicket(actor: Actor, ticketId: number | string): Promise<any> {
    const id = toPositiveInt(ticketId, 'ticketId');
    const repository = this.db.getRepository('serviceTickets');
    const ticket = await repository.findOne({ filter: { id } });

    if (!ticket) {
      throw new NotFoundError(`工单 ${id} 不存在`);
    }

    const scope = this.scopeOf(actor);

    if (scope.kind === 'all') return ticket;

    if (scope.kind === 'stores') {
      const storeId = Number(ticket.store_id);
      if (!scope.storeIds.includes(storeId)) {
        // 刻意记日志：越权尝试是安全事件，需要留痕；
        // 但对外只回"不存在"，不给攻击者任何确认信号。
        this.logger?.warn?.(
          `[permission] 越权访问被拒：用户 ${actor.userId}（授权门店 [${scope.storeIds.join(',')}]）` +
            `尝试访问门店 ${storeId} 的工单 ${id}`,
        );
        throw new NotFoundError(`工单 ${id} 不存在`);
      }
      return ticket;
    }

    this.logger?.warn?.(`[permission] 用户 ${actor.userId} 数据范围为 none，拒绝访问工单 ${id}`);
    throw new NotFoundError(`工单 ${id} 不存在`);
  }

  /**
   * 断言可**写**某条工单：先过能力（角色），再过归属（范围）。
   */
  async assertCanWriteTicket(actor: Actor, ticketId: number | string): Promise<any> {
    this.assertCapability(actor, CAPABILITY.WRITE_TICKET);
    return this.assertCanAccessTicket(actor, ticketId);
  }

  /** 断言具备跨店特权（强制转店 / 重开已关闭） */
  assertPrivileged(actor: Actor, action: string): void {
    this.assertCapability(
      actor,
      CAPABILITY.PRIVILEGED,
      `${action} 属于总部专属操作，门店角色无权执行`,
    );
  }

  /**
   * 断言"可以把工单转到某门店"。
   *
   * 规则（docs/STATE-MACHINE.md M6 + docs/API.md 角色矩阵）：
   *   · 门店角色只能转**到**自己被授权的门店（不能借转店把工单推给无关门店）
   *   · 总部角色不受目标门店限制
   * 两者都必须先能访问源工单。
   */
  async assertCanTransferTo(actor: Actor, ticketId: number | string, targetStoreId: number | string): Promise<{ ticket: any; targetStore: any }> {
    const ticket = await this.assertCanWriteTicket(actor, ticketId);
    const targetId = toPositiveInt(targetStoreId, 'targetStoreId');

    const storeRepository = this.db.getRepository('stores');
    const targetStore = await storeRepository.findOne({ filter: { id: targetId } });

    if (!targetStore) {
      throw new NotFoundError(`目标门店 ${targetId} 不存在`);
    }
    if (targetStore.active !== true) {
      throw new ForbiddenError('TARGET_STORE_INACTIVE', `目标门店「${targetStore.name}」已停用，不能转入`);
    }
    if (Number(targetStore.id) === Number(ticket.store_id)) {
      throw new ForbiddenError('SAME_STORE', '目标门店与当前门店相同，无需转店');
    }

    const scope = this.scopeOf(actor);
    if (scope.kind === 'stores' && !scope.storeIds.includes(targetId)) {
      throw new ForbiddenError(
        'TARGET_STORE_NOT_AUTHORIZED',
        '只能将工单转到自己负责的门店（跨店转移需总部角色）',
      );
    }
    if (scope.kind === 'none') {
      throw new ForbiddenError('FORBIDDEN', '无数据权限，不能转店');
    }

    return { ticket, targetStore };
  }

  // -------------------------------------------------------------------------
  // 字段级脱敏
  // -------------------------------------------------------------------------

  /**
   * 手机号脱敏：138****8000。
   *
   * 只读角色一律脱敏（docs/API.md 角色矩阵「看完整手机号」列）。
   * 非手机号形态的原样返回（不猜、不截断）—— 猜错会把邮箱之类的字段也改坏。
   */
  maskMobile(value: unknown, actor: Actor): string | null {
    if (value === null || value === undefined || String(value).trim() === '') return null;

    const text = String(value);
    if (!this.can(actor, CAPABILITY.VIEW_RAW_MOBILE)) {
      return maskMobileText(text);
    }
    return text;
  }

  /** 对工单行按角色脱敏后返回（不改原对象） */
  maskTicketForActor(ticket: any, actor: Actor): any {
    const plain = toPlainRow(ticket);
    if (!plain || typeof plain !== 'object') return plain;

    const masked: Record<string, unknown> = { ...plain };
    masked.customer_mobile = this.maskMobile(masked.customer_mobile, actor);
    masked.technician_mobile = this.maskMobile(masked.technician_mobile, actor);
    return masked;
  }

  // -------------------------------------------------------------------------
  // 内部：查库
  // -------------------------------------------------------------------------

  /**
   * 读用户被授权的门店 ID。
   *
   * 只有门店角色需要查 —— 总部角色跳过这次查询（它在 scopeOf 里不受限）。
   * 这既省一次查询，也避免总部用户被"忘记加授权"坑到。
   */
  private async loadStoreIds(userId: number, roles: RoleName[]): Promise<number[]> {
    const isStoreScoped = roles.some((r) => r === ROLE.STORE_AFTER_SALES);
    if (!isStoreScoped) return [];

    try {
      const repository = this.db.getRepository('storeUsers');
      const rows = await repository.find({ filter: { user_id: userId } });
      return (rows || [])
        .map((row: any) => Number(row.store_id))
        .filter((id: number) => Number.isFinite(id) && id > 0);
    } catch (error) {
      // 查不到授权表：**绝不能**当成"不受限"。返回空 → scopeOf 判为 none。
      this.logger?.warn?.(
        `[permission] 读取用户 ${userId} 的门店授权失败，按无授权处理：${(error as Error)?.message}`,
      );
      return [];
    }
  }

  /**
   * 读用户的**原始**角色名（不做业务角色过滤）。
   * 返回原始名而不是 RoleName[]，因为平台超管（root/admin）也要能从同一份数据里认出来。
   */
  private async loadRawRolesFromDb(userId: number): Promise<string[]> {
    try {
      const repository = this.db.getRepository('users');
      const user = await repository.findOne({
        filter: { id: userId },
        appends: ['roles'],
      });
      return collectRoleNames(user, null);
    } catch (error) {
      this.logger?.warn?.(
        `[permission] 读取用户 ${userId} 的角色失败：${(error as Error)?.message}`,
      );
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// 纯函数工具（也被 action 层与测试直接使用）
// ---------------------------------------------------------------------------

/** 13312345678 → 133****5678；非法/过短的原样返回 */
export function maskMobileText(value: string): string {
  const text = String(value).trim();
  if (text.length < 7) return text;
  return `${text.slice(0, 3)}****${text.slice(-4)}`;
}

/**
 * Sequelize Model 实例上的内部属性名。
 * 它们不是业务列，绝不能出现在 API 响应里。
 */
const ORM_INTERNAL_KEYS = new Set([
  'dataValues',
  '_previousDataValues',
  '_previousDataValuesWithAssociations',
  '_changed',
  '_changedWithAssociations',
  '_options',
  'isNewRecord',
  'uniqno',
  '_modelOptions',
  '_customGetters',
  '_customSetters',
  'sequelize',
]);

/** 去掉 ORM 内部键，只留业务列 */
function stripInternalKeys(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    if (ORM_INTERNAL_KEYS.has(key)) continue;
    out[key] = row[key];
  }
  return out;
}

/**
 * 把"可能是 Sequelize Model 实例、也可能是纯对象"的行**归一化**成纯对象。
 *
 * ⚠️ 这个函数是一次真机事故的产物，不要删：
 *   timeline 的工单来自 `repository.findOne()`，拿到的是 **Model 实例**，
 *   字段挂在 `row.dataValues` 上。而脱敏是对"顶层键"做的：
 *       const masked = { ...ticket };
 *       masked.customer_mobile = maskMobile(ticket.customer_mobile, actor);
 *   对 Model 实例执行 `{ ...ticket }` 展开的是 `dataValues / _previousDataValues /
 *   _changed / _options / isNewRecord / uniqno …` 这些**内部属性**，
 *   于是：
 *     · 顶层 `customer_mobile` 是脱敏后的值（看着像成功了）；
 *     · 但 `dataValues.customer_mobile` 是**原始完整手机号**，一并被序列化出去。
 *   结果就是「只读角色（viewer）能在响应里拿到完整手机号」这个安全缺陷，
 *   同时把 ORM 内部结构泄露给了客户端。
 *   而 accept/cancel/transfer 的工单来自 `UPDATE ... RETURNING *`（纯对象），
 *   天然正常 —— 所以这个缺陷只在 timeline 上出现，很容易漏测。
 *
 * 归一化优先走 `toJSON()`（Sequelize 的标准出口，就是 dataValues 的浅拷贝），
 * 再退到 `dataValues`，最后按纯对象处理；三步都过一遍内部键过滤兜底。
 */
export function toPlainRow<T = Record<string, unknown>>(row: any): T {
  if (row === null || row === undefined) return row;
  if (typeof row !== 'object') return row;

  if (typeof row.toJSON === 'function') {
    try {
      const json = row.toJSON();
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        return stripInternalKeys(json) as T;
      }
    } catch {
      // toJSON 被覆写或依赖了不可用的状态：落到下面的分支
    }
  }

  if (row.dataValues && typeof row.dataValues === 'object' && !Array.isArray(row.dataValues)) {
    return stripInternalKeys(row.dataValues) as T;
  }

  return stripInternalKeys(row) as T;
}

/** 批量归一化（列表场景） */
export function toPlainRows<T = Record<string, unknown>>(rows: any): T[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => toPlainRow<T>(row));
}

/**
 * 从各种真实形态里抽出**原始**角色名（不去重、不区分业务/平台角色）。
 * 兼容：['hq_admin'] / [{name:'hq_admin'}] / {roles:[...]} / ctx.state.currentRole
 *
 * 之所以先全部收集、再由调用方各取所需（业务角色 / 平台角色）：
 * 两边的过滤规则完全不同，用一个函数顺手过滤会把 root/admin 一起丢掉。
 */
export function collectRoleNames(user: any, ctx: any): string[] {
  const collected: string[] = [];

  const pushFrom = (source: unknown) => {
    if (!source) return;
    if (typeof source === 'string') {
      collected.push(source);
      return;
    }
    if (Array.isArray(source)) {
      for (const item of source) {
        if (typeof item === 'string') collected.push(item);
        else if (item && typeof item === 'object' && typeof (item as any).name === 'string') {
          collected.push((item as any).name);
        }
      }
      return;
    }
    if (typeof source === 'object' && typeof (source as any).name === 'string') {
      collected.push((source as any).name);
    }
  };

  pushFrom(user?.roles);
  pushFrom(ctx?.state?.currentRole);
  pushFrom(ctx?.state?.currentRoles);
  pushFrom(user?.role);

  return collected;
}

/**
 * 从各种真实形态里抽出角色名（**只保留本系统认识的业务角色**）。
 * 兼容：['hq_admin'] / [{name:'hq_admin'}] / {roles:[...]} / ctx.state.currentRole
 */
export function extractRoles(user: any, ctx: any): RoleName[] {
  return normalizeRoles(collectRoleNames(user, ctx));
}

/** 只保留 NocoBase 内置的平台超管角色名（root / admin），用于 Actor.platformRoles */
export function filterPlatformRoles(names: string[]): string[] {
  const result: string[] = [];
  for (const name of names) {
    const normalized = String(name).trim().toLowerCase();
    if (PLATFORM_ADMIN_ROLES.includes(normalized) && !result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
}

/**
 * 只保留本系统认识的角色名，去掉 NocoBase 内置的 root/admin/member 等。
 *
 * ⚠️ 平台超管（root/admin）**故意**在这里被过滤掉：业务能力只应来自业务角色。
 *    它们另行经 filterPlatformRoles → Actor.platformRoles 处理，
 *    映射规则是"按总部管理员对待"（constants.PLATFORM_ADMIN_ROLES 有完整理由）。
 */
export function normalizeRoles(names: string[]): RoleName[] {
  const result: RoleName[] = [];
  for (const name of names) {
    const normalized = String(name).trim().toLowerCase();
    if ((ROLE_VALUES as string[]).includes(normalized) && !result.includes(normalized as RoleName)) {
      result.push(normalized as RoleName);
    }
  }
  return result;
}

function toPositiveInt(value: unknown, field: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    throw new ForbiddenError('BAD_REQUEST', `${field} 必须是正整数`);
  }
  return num;
}

function toIdList(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number).filter((n) => Number.isFinite(n));
  if (value && typeof value === 'object' && Array.isArray((value as any).$in)) {
    return (value as any).$in.map(Number).filter((n: number) => Number.isFinite(n));
  }
  const single = Number(value);
  return Number.isFinite(single) ? [single] : [];
}
