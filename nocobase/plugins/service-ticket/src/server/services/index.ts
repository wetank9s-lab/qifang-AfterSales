/**
 * 服务层汇总入口。
 *
 * 为什么要一个 factory 而不是各处 new：
 *  这些服务之间有依赖（TicketService 需要 EventService + SequenceService），
 *  且都要拿同一个 db / logger / 告警回调。散落构造会出现"某个调用点
 *  忘了传 events，于是事件没写"这类静默缺陷 —— 集中一处构造，
 *  依赖关系写在类型里，编译期就能发现漏传。
 *
 * 用法：
 *   const services = createServices(app.db, { logger: app.log, onWarn });
 *   await services.tickets.accept(ticketId, actor);
 */
import { ConfigService, type ConfigServiceOptions } from './config-service';
import { EventService, type EventServiceOptions } from './event-service';
import { GuardService, type GuardServiceOptions } from './guard-service';
import { PermissionService, type PermissionServiceOptions } from './permission-service';
import { SequenceService, type SequenceServiceOptions } from './sequence-service';
import { TicketService, type TicketServiceOptions } from './ticket-service';

export { ConfigService } from './config-service';
export { EventService, STATUS_CHANGE_EVENTS, type WriteEventInput } from './event-service';
export {
  GUARD_SCOPE_IP,
  GUARD_SCOPE_MOBILE,
  GuardService,
  RateLimitedError,
  type ConsumeInput,
  type DuplicateTicketHit,
  type GuardDecision,
} from './guard-service';
export {
  CAPABILITY,
  ForbiddenError,
  NotFoundError,
  PermissionService,
  collectRoleNames,
  extractRoles,
  filterPlatformRoles,
  maskMobileText,
  normalizeRoles,
  type Actor,
  type Capability,
  type DataScope,
} from './permission-service';
export { SequenceService, formatDatePart } from './sequence-service';
export {
  StateConflictError,
  TicketService,
  ValidationError,
  describeTransition,
  isUniqueViolationOn,
  type CreateTicketInput,
} from './ticket-service';

export interface Services {
  config: ConfigService;
  sequences: SequenceService;
  events: EventService;
  permissions: PermissionService;
  tickets: TicketService;
  /** 匿名入口的四类守卫：IP 频控 / 手机号频控 / 重复单 / request_id 幂等（Phase 3） */
  guards: GuardService;
}

export interface CreateServicesOptions {
  logger?: {
    warn?: (msg: string) => void;
    debug?: (msg: string) => void;
    info?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  /** 配置读取异常（缺键/类型不对/查库失败）时的额外回调，用于 health 暴露 */
  onConfigWarn?: (message: string) => void;
  /** 参数缓存 TTL（毫秒），测试里可调小 */
  configTtlMs?: ConfigServiceOptions['ttlMs'];
}

export function createServices(db: any, options: CreateServicesOptions = {}): Services {
  const { logger } = options;

  const config = new ConfigService(db, {
    ttlMs: options.configTtlMs,
    logger,
    onWarn: options.onConfigWarn,
  } satisfies ConfigServiceOptions);

  const sequences = new SequenceService(db, { logger } satisfies SequenceServiceOptions);
  const events = new EventService(db, { logger } satisfies EventServiceOptions);
  const permissions = new PermissionService(db, { logger } satisfies PermissionServiceOptions);

  const guards = new GuardService(db, {
    // 哈希盐取自进程环境（docker compose 通过 env_file 注入 .env）。
    // 刻意**不**接受调用方显式传值：一旦能被传参，就会有人为了"测试方便"
    // 传一个固定字符串，于是生产与测试的哈希口径分叉，回查占用全部落空。
    secret: process.env.SIGN_SECRET,
    logger,
  } satisfies GuardServiceOptions);

  const tickets = new TicketService(db, {
    events,
    sequences,
    logger,
  } satisfies TicketServiceOptions);

  return { config, sequences, events, permissions, tickets, guards };
}
