/**
 * 服务层汇总入口。
 *
 * 为什么要一个 factory 而不是各处 new：
 *  这些服务之间有依赖（TicketService 需要 EventService + SequenceService +
 *  VisitService + TokenService + SmsService），且都要拿同一个 db / logger / 告警回调。
 *  散落构造会出现"某个调用点忘了传 events，于是事件没写"这类静默缺陷 ——
 *  集中一处构造，依赖关系写在类型里，编译期就能发现漏传。
 *
 * Phase 4 起依赖图（箭头 = "需要"）：
 *
 *   config ─────────────┬──────────────────────┐
 *   events ─────────────┼──────────┐           │
 *   sequences ─┬────────┤          ↓           ↓
 *              ↓        │      sms-service  tickets
 *          visit-service│          ↑           ↑
 *                       └─── token-service ───┘
 *
 * 构造顺序必须与实际依赖一致（tokens/visits/sms 先于 tickets），
 * 否则会出现"某个服务拿到 undefined 依赖、运行时才炸"。
 *
 * 用法：
 *   const services = createServices(app.db, { logger: app.log, onWarn });
 *   await services.tickets.dispatch(ticketId, input, actor);
 */
import { ConfigService, type ConfigServiceOptions } from './config-service';
import { EventService, type EventServiceOptions } from './event-service';
import { GuardService, type GuardServiceOptions } from './guard-service';
import { PermissionService, type PermissionServiceOptions } from './permission-service';
import { SequenceService, type SequenceServiceOptions } from './sequence-service';
import { SmsService, type SmsServiceOptions } from './sms-service';
import { TicketService, type TicketServiceOptions } from './ticket-service';
import { TokenService, type TokenServiceOptions } from './token-service';
import { VisitService, type VisitServiceOptions } from './visit-service';

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
  toPlainRow,
  toPlainRows,
  type Actor,
  type Capability,
  type DataScope,
} from './permission-service';
export { SequenceService, formatDatePart } from './sequence-service';
export {
  SMS_DISABLED,
  SmsService,
  makeBizId,
  sceneSummary,
  type EnqueueSmsInput,
  type PendingSms,
  type SmsFlushResult,
} from './sms-service';
export {
  AliyunSmsProvider,
  MockSmsProvider,
  NotImplementedSmsProvider,
  SMS_MISCONFIGURED,
  SMS_TEMPLATE_MISSING,
  aliyunEncode,
  aliyunTimestamp,
  buildSignedBody,
  createSmsProvider,
  type SmsOutboxEntry,
  type SmsProvider,
  type SmsSendRequest,
  type SmsSendResult,
} from './sms-provider';
export {
  StateConflictError,
  TicketService,
  ValidationError,
  VISIT_VOID_REASON,
  describeTransition,
  formatVisitDate,
  // 「预计上门日期」的服务端规范化入口（联机断言见 scripts/verify-reassign-contract.mjs 的 A6b/A6d）
  parseAppointmentDate,
  canonicalizeAppointmentDate,
  isUniqueViolationOn,
  type CreateTicketInput,
  type DispatchInput,
  type DispatchResult,
  type ReassignInput,
  type RescheduleInput,
} from './ticket-service';
export { TokenService, fingerprint, hashToken, type MintedToken, type TokenVerifyResult } from './token-service';
export {
  VisitService,
  VisitValidationError,
  assertVisitStatus,
  derivedConfirmStatus,
  type CreateVisitInput,
} from './visit-service';

export interface Services {
  config: ConfigService;
  sequences: SequenceService;
  events: EventService;
  permissions: PermissionService;
  tickets: TicketService;
  /** 匿名入口的四类守卫：IP 频控 / 手机号频控 / 重复单 / request_id 幂等（Phase 3） */
  guards: GuardService;
  /** Visit（一次执行责任的派工尝试）的唯一写入口（Phase 4） */
  visits: VisitService;
  /** 师傅作业 Token 的签发 / 校验 / 吊销（Phase 4） */
  tokens: TokenService;
  /** 短信的唯一出口：scene → 模板 → Provider → SmsLog → 事件（Phase 4） */
  sms: SmsService;
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
  /** 环境变量（测试注入用）。缺省读进程环境。 */
  env?: Record<string, string | undefined>;
  /** 注入短信 Provider（测试用）。生产路径由 `sms.provider` 参数决定。 */
  smsProvider?: SmsServiceOptions['provider'];
  /** 注入 fetch（测试用） */
  fetchFn?: typeof fetch;
}

export function createServices(db: any, options: CreateServicesOptions = {}): Services {
  const { logger } = options;
  const env = options.env ?? process.env;

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

  // ---- Phase 4：Token / Visit / 短信（构造顺序即依赖顺序，勿重排）----
  const tokens = new TokenService(db, {
    logger,
    publicBaseUrl: env.PUBLIC_BASE_URL,
  } satisfies TokenServiceOptions);

  const visits = new VisitService(db, {
    sequences,
    logger,
  } satisfies VisitServiceOptions);

  const sms = new SmsService(db, {
    config,
    events,
    logger,
    env,
    provider: options.smsProvider,
    fetchFn: options.fetchFn,
  } satisfies SmsServiceOptions);

  const tickets = new TicketService(db, {
    events,
    sequences,
    visits,
    tokens,
    sms,
    config,
    logger,
  } satisfies TicketServiceOptions);

  return { config, sequences, events, permissions, tickets, guards, visits, tokens, sms };
}
