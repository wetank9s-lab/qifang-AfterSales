/**
 * TicketService —— 工单状态的**唯一**写入入口（docs/STATE-MACHINE.md）
 *
 * Phase 2 实现 4 个动作（M1 / M2 / M6 / M7）：
 *   create   M1  — → NEW
 *   accept   M2  NEW → PROCESSING
 *   transfer M6  NEW/PROCESSING → **状态不变**（只改 store_id）
 *   cancel   M7  NEW/PROCESSING → CANCELLED
 * Phase 4 补齐派工三动作（M3 / M4 / M5）：
 *   dispatch   M3  NEW/PROCESSING → PROCESSING（新建 Visit #1 + 签发 Token + 双短信）
 *   reassign   M4  PROCESSING → PROCESSING（旧 Visit → SUPERSEDED + 新建 Visit + 三短信）
 *   reschedule M5  PROCESSING → PROCESSING（**不新建 Visit**，仅改时间 + 换发 Token）
 * 其余动作（technicianSubmit/confirm/reject/remoteComplete/review/autoClose/hqReopen）
 * 分别属于 Phase 5–7，接口位置已预留。
 *
 * 三条不能妥协的设计：
 *
 * 1) **乐观并发用"条件 UPDATE + 影响行数为 0 即冲突"**（文档 §4）。
 *    不先 SELECT 再判断状态再 UPDATE —— 那是 check-then-act 竞态：
 *    两个门店同事同时点"受理"，都会读到 NEW，都会通过校验，然后都写。
 *    正确做法是把状态条件写进 WHERE，让数据库替我们做互斥：
 *      UPDATE ... SET status='PROCESSING' WHERE id=$1 AND status='NEW'
 *    返回 0 行就说明别人先动了手，抛 CONFLICT_STATE_CHANGED，**不产生第二条短信/事件**。
 *
 * 2) **状态与事件必须在同一个事务里**。
 *    否则会出现"状态变了但没有事件"（审计断链）或"有事件但状态没变"（时间线说谎）。
 *    两者任一都比"操作失败"更糟 —— 失败可以重试，脏数据无法自动修复。
 *
 * 3) **不在本服务里做权限判断**（改由 PermissionService 在调用前完成）。
 *    原因：本服务会被系统侧调用（定时任务、短信回调），那里没有"用户"。
 *    把鉴权混进来会让这两种调用的边界变得含糊。
 *
 * Phase 4 追加的两条（**事务边界**，见 docs/STATE-MACHINE.md §8）：
 *
 * 4) **短信在事务内"入队"、提交后才"发送"**。
 *    事务内写 `sms_logs(send_status=pending)`，提交后调供应商并回写状态。
 *    理由：外部 HTTP 可能耗时数秒，不能占着事务；更重要的是
 *    **外部失败不该回滚派工** —— 师傅已经派出去了，那是既成事实。
 *    而"提交成功但一条记录都没留"的缺口，由 pending 行 + Phase 8 的重发任务补上。
 *
 * 5) **凡使当前派工失效的动作，必须同时作废 Token 并通知原师傅**。
 *    这条覆盖三个动作：`reassign`（改派）、`cancel`（工单取消）、
 *    `transfer`（转店）。只作废不通知会出现最糟的错配 ——
 *    系统里"这条派工已经没了"，而师傅仍按原预约时间跑到客户家。
 *    见 docs/DEVIATIONS.md DEV-43。
 */
import {
  APPOINTMENT_CANONICAL_TIME,
  APPOINTMENT_TIMEZONE_OFFSET,
  CLOSE_REASON,
  DISPATCHABLE_SERVICE_MODES,
  EVENT_TYPE,
  INTERNAL_WRITE_SCENE,
  OPERATOR_KIND,
  SERVICE_MODE,
  SERVICE_MODE_LABEL,
  SERVICE_RESULT_LABEL,
  SMS_RECIPIENT_KIND,
  SMS_SCENE,
  TICKET_SOURCE,
  TICKET_SOURCE_VALUES,
  TICKET_STATUS,
  TICKET_TYPE_LABEL,
  TICKET_TYPE_VALUES,
  VISIT_STATUS,
  canTransition,
  isMobile,
} from '../constants';
import { maskMobileText, toPlainRow } from './permission-service';
import type { ConfigService } from './config-service';
import type { EventService } from './event-service';
import type { SmsFlushResult, SmsService, PendingSms } from './sms-service';
import type { SequenceService } from './sequence-service';
import type { MintedToken, TokenService } from './token-service';
import type { VisitService } from './visit-service';

/** 允许出现在条件 UPDATE 的 SET 子句里的列（白名单，防列名注入） */
const UPDATABLE_COLUMNS = new Set([
  'status',
  'handler_user_id',
  'first_response_at',
  'store_id',
  'source_store_code',
  'service_mode',
  'provider_name',
  'technician_name',
  'technician_mobile',
  'customer_mobile',
  'expected_visit_at',
  'dispatch_at',
  'completion_result',
  'completion_note',
  'completed_at',
  'close_reason',
  'closed_at',
  'escalated',
  'reopen_count',
  'review_status',
]);

/** 允许转移工单的来源状态（M6：只有 NEW / PROCESSING 可以转店） */
const TRANSFERABLE_STATUSES = [TICKET_STATUS.NEW, TICKET_STATUS.PROCESSING];
/** 允许取消的来源状态（M7） */
const CANCELLABLE_STATUSES = [TICKET_STATUS.NEW, TICKET_STATUS.PROCESSING];

/**
 * 允许派工的来源状态（M3：NEW / PROCESSING）。
 *
 * 注意它**同时**用作条件 UPDATE 的 WHERE —— 两个门店同事同时点"派工"时，
 * 后到者的 UPDATE 影响 0 行，被映射成 409 且不产生第二条短信/Visit。
 *
 * 显式标注 `string[]`：它既要做 `includes(ticket.status)`（status 是 string），
 * 又要传进 `conditionalUpdate` 的 `fromStatuses: string[]`。
 * 让 TS 推断成 `("NEW"|"PROCESSING")[]` 会在第一个用法上直接报错 ——
 * 那不是类型安全，那是把状态机的字面量泄漏到了读路径。
 */
const DISPATCHABLE_STATUSES: string[] = [TICKET_STATUS.NEW, TICKET_STATUS.PROCESSING];

/** 内容长度（M1 前置校验） */
const CONTENT_MIN = 5;
const CONTENT_MAX = 500;

/**
 * 责任主体判据（Phase 4 用户裁定，见 docs/DEV-PLAN.md §Phase 4）：
 * `technician_mobile` + `provider_name` + `service_mode` 三者同时不变
 * **才**算"同一执行责任人"。姓名不在其中 —— 只纠正错别字不构成改派。
 *
 * 用它拦掉"用改派接口干改约/改名的事"：那会凭空多出一条 Visit，
 * 让"第几次上门"这个数字失真（后台看到的派工历史会变得没有意义）。
 */
function sameResponsibleParty(
  visit: any,
  next: { serviceMode: string; providerName: string | null; technicianMobile: string },
): boolean {
  return (
    String(visit?.technician_mobile ?? '') === next.technicianMobile &&
    String(visit?.service_mode ?? '') === next.serviceMode &&
    String(visit?.provider_name ?? '') === String(next.providerName ?? '')
  );
}

/** 状态竞争：调用方应把它映射为 HTTP 409 */
export class StateConflictError extends Error {
  /**
   * 冲突子类型。缺省是并发状态冲突 `CONFLICT_STATE_CHANGED`，
   * 允许子类场景覆盖（如 Phase 3 的重复单 `DUPLICATE_TICKET`，同样 409）。
   *
   * 声明为 `string`（不是字面量）是刻意的：否则子类/调用方无法给出别的冲突码，
   * 只能再发明一个近似类型，而 `statusOf()` 是按类型分支的 —— 新类型会被静默映射成 500。
   */
  readonly code: string;
  /**
   * 附带信息（如重复单的原单号）。`handleError()` 会把它并进响应 detail，
   * 客户端据此可以直接跳转到原单，而不是干等一句"重复提交"。
   */
  readonly detail?: Record<string, unknown>;
  /**
   * 自带 HTTP 状态码，口径与 actions/svc/_http.ts 的 statusOf 一致。
   * 原因：中间件层（storeScope）抛出的错误不经过 action 层的映射表，
   * 会直接落到 NocoBase 的全局错误处理器，那里只看 `error.status`。
   * 不带这个字段时越权/冲突会被报成 500（真机实测过），
   * 既违反 docs/API.md §0，也让"app 日志无 error"的运维断言产生噪声。
   */
  readonly status = 409;
  readonly statusCode = 409;
  constructor(message: string, code = 'CONFLICT_STATE_CHANGED', detail?: Record<string, unknown>) {
    super(message);
    this.name = 'StateConflictError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 业务校验失败：**状态码由实例自己带**（`statusOf()` 直接读它，不再按 code 二次判定）。
 *
 * `status` 默认 422；显式传入时以传入值为准 —— 现有的两处特例：
 *   · `NOT_FOUND`  → 404（transfer 内部按 ID 找不到工单，属"资源不存在"）
 *   · `PRIVACY_NOT_AGREED` → 400（DEV-PLAN Phase 3-G 明文要求"未勾选一律 400"）
 */
export class ValidationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly statusCode: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    // NOT_FOUND 是 ValidationError 里唯一的 404（transfer 内部按 ID 找不到工单），
    // 与 actions/svc/_http.ts 的 statusOf 保持同一口径。
    this.status = status ?? (code === 'NOT_FOUND' ? 404 : 422);
    this.statusCode = this.status;
  }
}

export interface CreateTicketInput {
  /** 门店 ID（与 storeCode 二选一） */
  storeId?: number | string;
  /** 门店业务编码（如 S01），H5 扫码入口带的就是它 */
  storeCode?: string;
  ticketType: string;
  content: string;
  customerName?: string | null;
  customerMobile: string;
  source?: string;
  /** 操作者：客户匿名提交时为 null */
  operatorUserId?: number | string | null;
  operatorKind?: string;
  /** 结构化补充（request_id、入口来源等） */
  metadata?: Record<string, unknown> | null;
  /**
   * 隐私说明同意记录，写入 `extra_json`（Phase 3-G）。
   *
   * ⚠️ 关于"为什么不新加一列" —— 这里原先写的理由**是错的**，已于 2026-09-21 更正：
   *
   *   原注释声称"`sync()` 对已存在的表只做 `CREATE TABLE IF NOT EXISTS`，不会补列"。
   *   实际相反：NocoBase 的 `Database` 构造函数写死了默认同步选项
   *   `sync: { alter: { drop: false }, force: false }`（容器内源码取证），
   *   即 `db.sync()` 是**增量同步 —— 会补列，只是不删列**。
   *   真机实测：Phase 4-A 新增的 7 列 + 2 索引在迁移执行之前就已由 sync 建好。
   *   完整记录见 docs/DEVIATIONS.md **DEV-39**。
   *
   *   所以"加不了列"从来不是障碍。**仍然沿用 `extra_json`** 的理由只剩两条，
   *   都是工程取舍而非能力限制：
   *     ① 它已经上线并且有 Phase 3 的断言覆盖，改列要连带改 DTO / 断言 / 已落库数据；
   *     ② 它**不参与任何查询条件与统计口径**，放在 JSON 里不损失可索引性。
   *     反例是 `serviceVisits.visit_status` —— 它是生命周期主状态、要建索引、
   *     要被后台过滤，那种字段就**必须**是真实列（见 Phase 4-A 的迁移）。
   *
   *   一句话口径：**能查询/要断言的字段用列，纯留痕的字段可以用 extra_json。**
   */
  privacy?: Record<string, unknown> | null;
  /**
   * request_id 幂等记录（Phase 3-D）。
   *
   * ⚠️ 为什么要由本服务写、而不是 action 层在建单之后再写：
   *    两次写不在同一个事务里，中间任何一次崩溃（进程被杀、连接断）都会留下
   *    "工单已建、幂等记录没有"的状态 —— 客户重试会拿到**第二张单**，
   *    而这正是幂等要防的事。放进同一个事务，则两者要么都在、要么都不在。
   *
   * `responseOf` 由调用方提供：对外响应体里该有哪些字段是 DTO 层的事
   * （`ticket_no` / `store_name` / `created_at`），服务层不该知道 HTTP 形状。
   * 它也允许为空（中间态），此时记录里只有 `resource_id`，
   * 重放时调用方据它**重建**响应（见 guard-service.findIdempotency 的注释）。
   */
  idempotency?: {
    scene: string;
    key: string;
    responseOf?: (result: { ticket: any; store: TicketStoreRef }) => unknown;
  } | null;
}

/** 建单时解析出的门店三元组（id 内部用，code/name 对外用） */
export interface TicketStoreRef {
  id: number;
  code: string;
  name: string;
}

/** 建单结果。`store` 一并返回，避免调用方为了拼响应再查一次库（少一次竞态） */
export interface CreatedTicket {
  ticket: any;
  event: any;
  store: TicketStoreRef;
}

/**
 * `token_revoked_reason` 与 `superseded_reason` 的**稳定短标识**。
 *
 * 为什么不写中文句子：这两列会被后台过滤、被统计"因改派而作废的链接数"，
 * 也会被 Phase 5 的客服话术映射成一句解释。自由文本会让统计口径永远对不齐。
 */
export const VISIT_VOID_REASON = {
  /** 改派：旧 Visit 被新 Visit 取代 */
  REASSIGNED: 'reassigned',
  /** 工单取消 */
  CANCELLED: 'cancelled',
  /** 转店：原门店的派工作废，由新门店重新派 */
  TRANSFERRED: 'transferred',
  /** 改约：Visit 仍有效，只是旧 Token 被新 Token 取代（不进 token_revoked_*，见 TokenService.reissue） */
  RESCHEDULED: 'rescheduled',
} as const;

export interface TicketServiceOptions {
  events: EventService;
  sequences: SequenceService;
  /**
   * Phase 4 起新增的三项依赖。
   *
   * 为什么放在 `required` 而不是可选：派工是这个服务的核心动作，
   * 少了任何一个都不是"降级可用"，而是"派工要么建不出 Visit、
   * 要么发不出作业链接、要么留不下通知记录"。让它在编译期就拦住，
   * 比在真机上表现为 500 好得多（见 services/index.ts 顶部的同一理由）。
   */
  visits: VisitService;
  tokens: TokenService;
  sms: SmsService;
  /** 读 `technician.token_expire_hours` 等可调参数 */
  config: ConfigService;
  logger?: { warn?: (msg: string) => void; debug?: (msg: string) => void; info?: (msg: string) => void };
  /** ticket_no 撞唯一约束时的重试次数（取号原子，理论不会撞；留作兜底） */
  maxTicketNoRetries?: number;
}

/**
 * **内部写动作**的 request-id 幂等参数。
 *
 * `responseOf` 由 action 层提供 —— 响应体的形状（哪些字段、怎么脱敏）是 DTO 的事，
 * 服务层不该知道 HTTP 长什么样；这与 create() 的 `idempotency` 参数是同一处约定。
 */
export interface InternalWriteIdempotency {
  /** 幂等场景（六个内部写动作各一个，见 constants.INTERNAL_WRITE_SCENE） */
  scene: string;
  /** 幂等键：`${ticketId}:${actorUserId}:${X-Request-Id}` */
  key: string;
  /** 用首次结果构造可缓存的响应体 */
  responseOf: (value: any) => unknown;
}

/**
 * 写动作的执行结果。
 *
 * `replay=true` 表示"这条请求之前已经执行过"，由 action 层直接回放首次响应 ——
 * 它**不携带** value，因为重放时业务代码一行都没有跑，不存在"本次结果"这个概念。
 * 用联合类型而不是给结果塞一个 `null` 值，是为了让"重放"这件事在类型上就不可忽略。
 */
export type IdempotentWriteOutcome<T> =
  | { replay: false; value: T }
  | { replay: true; response: unknown | null };

export interface DispatchInput {
  /** 服务方式：inhouse / manufacturer / third_party（**不含 remote**，见 DEV-42） */
  serviceMode: string;
  /** 厂家/第三方名称（manufacturer / third_party 时必填） */
  providerName?: string | null;
  technicianName: string;
  technicianMobile: string;
  /** 预计上门时间 */
  expectedVisitAt: Date | string;
  /** 派工备注（进事件 metadata，便于事后复盘） */
  note?: string | null;
}

export interface ReassignInput extends DispatchInput {
  /** 改派原因（必填）—— 会同时进事件与 Visit 的 superseded_reason */
  reason: string;
}

export interface RescheduleInput {
  expectedVisitAt: Date | string;
  /** 改约原因（必填） */
  reason: string;
}

/** 派工类动作的统一返回。`sms` 是发送结果（已受理 ≠ 已送达，见 SmsService） */
export interface DispatchResult {
  ticket: any;
  visit: any;
  event: any;
  sms: SmsFlushResult[];
}

export class TicketService {
  private readonly db: any;
  private readonly events: EventService;
  private readonly sequences: SequenceService;
  private readonly visits: VisitService;
  private readonly tokens: TokenService;
  private readonly sms: SmsService;
  private readonly config: ConfigService;
  private readonly logger?: TicketServiceOptions['logger'];
  private readonly maxTicketNoRetries: number;

  constructor(db: any, options: TicketServiceOptions) {
    this.db = db;
    this.events = options.events;
    this.sequences = options.sequences;
    this.visits = options.visits;
    this.tokens = options.tokens;
    this.sms = options.sms;
    this.config = options.config;
    this.logger = options.logger;
    this.maxTicketNoRetries = options.maxTicketNoRetries ?? 3;
  }

  // -------------------------------------------------------------------------
  // M1 —— 创建工单
  // -------------------------------------------------------------------------

  /**
   * M1 createTicket：— → NEW
   *
   * 同事务副作用：取 ticket_no → 建单 → 写 `created` 事件 →（可选）写幂等记录。
   *
   * ⚠️ 限流（IP/手机号）、request_id 幂等**判定**、重复工单检测**不在本方法内**，
   *    它们属于匿名入口的前置守卫（Phase 3 的 GuardService）。
   *    本方法只做两件事：① 保证"给我的输入，我建出一张一致的工单"；
   *    ② 把**幂等记录**一起写进同一个事务（判定在外面，落库在里面，理由见下面的注释）。
   */
  async create(input: CreateTicketInput): Promise<CreatedTicket> {
    const store = await this.resolveStore(input);
    const ticketType = this.assertEnum(input.ticketType, TICKET_TYPE_VALUES, 'ticket_type');
    const source = this.assertEnum(
      input.source ?? TICKET_SOURCE.QR,
      TICKET_SOURCE_VALUES,
      'source',
    );
    const content = String(input.content ?? '').trim();
    if (content.length < CONTENT_MIN || content.length > CONTENT_MAX) {
      throw new ValidationError(
        'INVALID_CONTENT',
        `报修内容需 ${CONTENT_MIN}–${CONTENT_MAX} 字，当前 ${content.length} 字`,
      );
    }

    const mobile = String(input.customerMobile ?? '').trim();
    if (!isMobile(mobile)) {
      throw new ValidationError('INVALID_MOBILE', '手机号格式不正确');
    }

    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxTicketNoRetries; attempt += 1) {
      const ticketNo = await this.sequences.nextTicketNo();

      try {
        return await this.withTransaction(async (transaction) => {
          const repository = this.db.getRepository('serviceTickets');

          const ticket = await repository.create({
            values: {
              ticket_no: ticketNo,
              // belongsTo 的外键列直接赋值（列名 = _helpers.belongsTo 的 foreignKey）
              store_id: Number(store.id),
              source_store_code: store.code,
              source,
              ticket_type: ticketType,
              content,
              customer_name: input.customerName ? String(input.customerName).trim() : null,
              customer_mobile: mobile,
              // 显式设 NEW，不依赖 defaultValue —— 状态机的起点必须写在代码里
              status: TICKET_STATUS.NEW,
              // 客户同意隐私说明的**证据**（版本号 + 时间点）。
              // 为什么不加列：加列要走 ALTER，而 `extra_json` 的语义正是
              // "不进入报表口径的补充字段"（见 serviceTickets 的 extra_json 注释），
              // 隐私同意恰好符合。口径：只记**同意过**的版本，不记 IP/UA。
              ...(input.privacy ? { extra_json: input.privacy } : {}),
            },
            transaction,
          });

          const event = await this.events.write({
            ticketId: ticket.id,
            eventType: EVENT_TYPE.CREATED,
            operatorKind: input.operatorKind ?? OPERATOR_KIND.CUSTOMER,
            operatorUserId: input.operatorUserId ?? null,
            toStatus: TICKET_STATUS.NEW,
            summary: `客户提交${ticketType === 'complaint' ? '投诉' : '报修'}（${store.name}）`,
            metadata: {
              store_code: store.code,
              store_name: store.name,
              ticket_type: ticketType,
              source,
              ...(input.metadata ?? {}),
            },
            transaction,
          });

          // 幂等记录与"建单 + 写事件"同事务（关键，理由见 CreateTicketInput.idempotency）
          if (input.idempotency?.scene && input.idempotency?.key) {
            await this.writeIdempotency({
              scene: input.idempotency.scene,
              key: input.idempotency.key,
              ticket,
              store,
              responseOf: input.idempotency.responseOf,
              transaction,
            });
          }

          return { ticket, event, store };
        });
      } catch (error) {
        lastError = error;
        if (isTicketNoConflict(error) && attempt < this.maxTicketNoRetries - 1) {
          this.logger?.warn?.(
            `[ticket] ticket_no ${ticketNo} 撞唯一约束，重新取号（第 ${attempt + 1} 次）`,
          );
          continue;
        }
        throw error;
      }
    }

    throw lastError;
  }

  /**
   * 写一条幂等记录。
   *
   * `response_json` 由调用方给出（DTO 形状归 action 层）；拿不到就存 null，
   * 重放时据 `resource_id` 重建 —— 这比"让建单失败"好得多：
   * 工单已经建出来了，客户需要的是它的单号，而不是一个 500。
   */
  private async writeIdempotency(params: {
    scene: string;
    key: string;
    ticket: any;
    store: TicketStoreRef;
    responseOf?: (result: { ticket: any; store: TicketStoreRef }) => unknown;
    transaction?: unknown;
  }): Promise<void> {
    const repository = this.db.getRepository('idempotencyRecords');

    let response: unknown = null;
    if (typeof params.responseOf === 'function') {
      try {
        response = params.responseOf({ ticket: params.ticket, store: params.store }) ?? null;
      } catch (error) {
        // 响应体构造失败不该阻断建单（它是"给下一次重放看的缓存"，不是业务数据）
        this.logger?.warn?.(
          `[ticket] 幂等响应体构造失败，改存 null（重放时据 resource_id 重建）：${(error as Error)?.message}`,
        );
        response = null;
      }
    }

    const options: Record<string, unknown> = {
      values: {
        scene: params.scene,
        idempotency_key: String(params.key),
        resource_type: 'serviceTicket',
        resource_id: Number(params.ticket.id),
        response_json: response,
      },
    };
    if (params.transaction) options.transaction = params.transaction;

    await repository.create(options);
  }

  // -------------------------------------------------------------------------
  // 内部写动作的 request-id 幂等（2026-09-21，方案 A，见 DEV-58）
  // -------------------------------------------------------------------------

  /**
   * 幂等包装：**占位行**写在业务事务里，**响应体**在提交后回填。
   *
   * 为什么分两步，而不是一次写完（这是整个机制里唯一需要解释的地方）：
   *
   *   响应体里含短信的发送结果（`SmsFlushResult[]`），而短信**必须**在事务提交后
   *   才能调供应商（见文件头第 4 条）—— 于是"知道完整响应"这件事天然晚于"提交"。
   *   如果为了让响应体一次写完而把幂等记录挪到事务外，
   *   就会失去"业务写 + 幂等标记同事务"这个原子保证：
   *   进程在两者之间被杀时，重放会**真的再执行一次**（reschedule 尤其危险 ——
   *   再执行一次 = 再换一个 Token + 再写一封短信，见复核方指出的问题）。
   *
   *   所以采用的顺序是：
   *     ① 事务内：业务写完之后写一行占位（scene + key + resource_id，response 为 NULL）；
   *     ② 提交后：调供应商发短信，然后把响应体 UPDATE 回这一行。
   *   ① 与业务写同事务 ⇒ **副作用与幂等标记不可能只落一个**；
   *   ② 落在一句 UPDATE 上 ⇒ 失败只影响"下次能否回放响应体"，不影响本次业务。
   *
   * 并发重放怎么被拦住：
   *   两个相同 key 的请求同时进来时，后到者的 INSERT 会在唯一索引
   *   `idempotency_records(scene, idempotency_key)` 上撞 23505 ——
   *   PostgreSQL 里它会**阻塞**到对方 COMMIT 才报错，所以看到 23505 就等价
   *   于"先到者已经落库"，此刻重读那一行是安全的（与 public/ticket.ts 同一套推理）。
   *   而 INSERT 报错会让后到者的**整个事务回滚**：它建的那条 Visit、写的那个事件
   *   全部消失 —— 这正是"幂等标记与业务写同事务"换来的结果。
   *
   * ⚠️ 什么时候不该用：`responseOf` 需要外部副作用结果时不要放进这里，
   *    这一类副作用的重放语义必须逐条评审（本项目目前只有短信）。
   */
  private async runIdempotentWrite<T>(params: {
    scene: string;
    idempotency?: InternalWriteIdempotency | null;
    /** 幂等记录指向的产物类型（serviceTicket / serviceVisit） */
    resourceType: string;
    /**
     * 业务写。`claim(resourceId, transaction)` 必须在**事务内**、
     * 且在主产物已经写入之后再调用。
     */
    execute: (claim: (resourceId: number, transaction?: unknown) => Promise<void>) => Promise<T>;
  }): Promise<IdempotentWriteOutcome<T>> {
    const idempotency = params.idempotency;
    // 没有幂等参数 ⇒ 完全跳过（系统侧调用：定时任务、批处理、单测桩）
    if (!idempotency?.key) {
      return { replay: false, value: await params.execute(async () => {}) };
    }

    const scene = idempotency.scene || params.scene;

    /**
     * ⚠️ ① 前置查表 —— 这一句不是"优化"，而是**机制的一部分**，缺了它幂等就漏一大半。
     *
     *   占位行写在业务写之后（原因见上），于是"业务先拒绝"的路径根本走不到占位行：
     *   受理重放时状态机在第一行就抛 409（工单已不是 NEW），
     *   唯一索引**永远撞不上** —— 幂等只能靠"先查一次"来兑现。
     *   这正是本项目第一次实现时踩到的坑（2026-09-21 真机取证：
     *   同一 request id 的第二次 accept 返回 409 而不是回放）。
     *
     *   并发下的先到者还没提交怎么办：查不到（不可见），于是继续走业务，
     *   由 ② 的唯一索引冲突兜住 —— 两条路径覆盖"串行重放"与"并发重放"两种情形。
     */
    const existing = await this.loadIdempotencyReplay(scene, idempotency.key);
    if (existing?.exists) {
      this.logger?.warn?.(
        `[ticket] scene=${scene} 命中幂等重放（前置查表），按首次结果返回`,
      );
      return { replay: true, response: existing.response };
    }

    let claimId = 0;

    const claim = async (resourceId: number, transaction?: unknown): Promise<void> => {
      const repository = this.db.getRepository('idempotencyRecords');
      const options: Record<string, unknown> = {
        values: {
          scene,
          idempotency_key: String(idempotency.key),
          resource_type: params.resourceType,
          resource_id: Number(resourceId),
          response_json: null,
        },
      };
      if (transaction) options.transaction = transaction;
      const created = await repository.create(options);
      claimId = Number((created as any)?.id ?? 0);
    };

    try {
      const value = await params.execute(claim);
      if (claimId > 0) await this.completeIdempotencyClaim(claimId, idempotency, value);
      return { replay: false, value };
    } catch (error) {
      // ② 并发兜底：与先到者同时进来时，占位行的唯一索引会撞 23505
      //    （PG 里 INSERT 遇到未提交的同键行会阻塞到对方 COMMIT 才报错，
      //     所以看到冲突就等价于"先到者已落库"）。claimId===0 说明连占位都没写成功，
      //     才可能是撞了别人的幂等键；占位写成功之后的失败都是普通业务失败。
      if (claimId === 0 && isUniqueViolationOn(error, ['scene', 'idempotency_key'])) {
        const cached = await this.loadIdempotencyReplay(scene, idempotency.key);
        if (cached?.exists) {
          this.logger?.warn?.(
            `[ticket] scene=${scene} 命中幂等重放，按首次结果返回（未重复执行副作用）`,
          );
          return { replay: true, response: cached.response };
        }
      }
      throw error;
    }
  }

  /** 提交后回填响应体。回填失败只告警：业务已经完成，不该因为缓存失败而失败 */
  private async completeIdempotencyClaim<T>(
    claimId: number,
    idempotency: InternalWriteIdempotency,
    value: T,
  ): Promise<void> {
    let response: unknown = null;
    try {
      response = idempotency.responseOf ? idempotency.responseOf(value) ?? null : null;
    } catch (error) {
      this.logger?.warn?.(
        `[ticket] 幂等响应体构造失败，改存 null（${(error as Error)?.message}）`,
      );
    }
    try {
      const repository = this.db.getRepository('idempotencyRecords');
      await repository.update({ filterByTk: claimId, values: { response_json: response } });
    } catch (error) {
      this.logger?.warn?.(
        `[ticket] 幂等响应体回填失败（本次业务已完成，仅影响下次重放的保真度）：` +
          `${(error as Error)?.message}`,
      );
    }
  }

  /**
   * 读幂等记录。
   *
   * 返回 `exists=true, response=null` 是一种**真实且必须区分**的状态：
   * 首次请求已经提交，但还没来得及回填响应体（进程在那几毫秒里被杀）。
   * 调用方（action 层）据此回 409 `IDEMPOTENT_REPLAY_UNAVAILABLE` ——
   * 宁可让人再点一次并得到明确结果，也不要伪造一个"成功"。
   */
  private async loadIdempotencyReplay(
    scene: string,
    key: string,
  ): Promise<{ exists: boolean; response: unknown | null }> {
    try {
      const repository = this.db.getRepository('idempotencyRecords');
      const row = await repository.findOne({
        filter: { scene, idempotency_key: String(key) },
      });
      if (!row) return { exists: false, response: null };
      return { exists: true, response: ((row as any).response_json ?? null) as unknown };
    } catch (error) {
      this.logger?.warn?.(
        `[ticket] 读取幂等记录失败（${(error as Error)?.message}），按"无记录"处理`,
      );
      return { exists: false, response: null };
    }
  }

  // -------------------------------------------------------------------------
  // M2 —— 受理
  // -------------------------------------------------------------------------

  /**
   * M2 accept：NEW → PROCESSING
   *
   * 同事务副作用：`handler_user_id`（仅首次）、`first_response_at`（仅首次）、写 `accepted`。
   *
   * 「仅首次」用 COALESCE 在 SQL 里完成，而不是先在 JS 里判断 ——
   * 后者在并发下会丢失先到者的时间戳。
   */
  async accept(
    ticketId: number | string,
    actor: { userId: number; username?: string },
    idempotency?: InternalWriteIdempotency | null,
  ): Promise<IdempotentWriteOutcome<{ ticket: any; event: any }>> {
    const id = toPositiveInt(ticketId, 'ticketId');
    const operatorUserId = toPositiveInt(actor.userId, 'operatorUserId');

    return this.runIdempotentWrite({
      scene: INTERNAL_WRITE_SCENE.ACCEPT,
      resourceType: 'serviceTicket',
      idempotency,
      execute: (claim) =>
        this.withTransaction(async (transaction) => {
          const updated = await this.conditionalUpdate({
            ticketId: id,
            fromStatuses: [TICKET_STATUS.NEW],
            set: {
              status: TICKET_STATUS.PROCESSING,
              // 已经是别人的工单时不抢归属，只补 first_response_at
              handler_user_id: sql`COALESCE(handler_user_id, ${operatorUserId})`,
              first_response_at: sql`COALESCE(first_response_at, now())`,
            },
            transaction,
          });

          if (!updated) {
            await this.throwStateConflict(id, [TICKET_STATUS.NEW], '受理');
          }

          const event = await this.events.recordTransition({
            ticketId: id,
            fromStatus: TICKET_STATUS.NEW,
            toStatus: TICKET_STATUS.PROCESSING,
            eventType: EVENT_TYPE.ACCEPTED,
            operatorKind: OPERATOR_KIND.STORE,
            operatorUserId,
            summary: `门店受理，开始处理`,
            metadata: { operator_username: actor.username ?? null },
            transaction,
          });

          await claim(Number(updated.id), transaction);

          return { ticket: stripInternal(updated), event };
        }),
    });
  }

  // -------------------------------------------------------------------------
  // M6 —— 转店（状态不变）
  // -------------------------------------------------------------------------

  /**
   * M6 transfer：NEW / PROCESSING → **状态不变**，只改 store_id。
   *
   * 两个容易写错的点：
   *   · `source_store_code` **保持不变** —— 它记录"客户当初是扫哪家店进来的"，
   *     转店后这仍是审计线索（M6 明确要求）。
   *   · 事件类型是 `transferred` 而非状态变更事件 —— 所以**不带 from/to status**，
   *     否则 EventService 会因为 from == to 而报错（这是刻意的互相卡位）。
   *
   * Phase 4 追加（DEV-43）：转店时**作废原门店的进行中派工**。
   *   理由与 cancel 完全一致，另加一层：那条 Visit 的师傅是**原门店**安排的，
   *   新门店既联系不上他也不认这笔账；而客户收到的短信里写的还是原门店。
   *   不作废就会留下"两家门店都以为对方在处理"的空档。
   *
   * ⚠️ 权限（能否转到目标门店、是否需要总部特权）由调用方经 PermissionService 完成。
   */
  async transfer(
    ticketId: number | string,
    targetStoreId: number | string,
    reason: string,
    actor: { userId: number; username?: string },
    idempotency?: InternalWriteIdempotency | null,
  ): Promise<
    IdempotentWriteOutcome<{
      ticket: any;
      event: any;
      previousStoreId: number;
      sms: SmsFlushResult[];
    }>
  > {
    const id = toPositiveInt(ticketId, 'ticketId');
    const targetId = toPositiveInt(targetStoreId, 'targetStoreId');
    const operatorUserId = toPositiveInt(actor.userId, 'operatorUserId');
    const reasonText = this.assertReason(reason, '转店');

    return this.runIdempotentWrite({
      scene: INTERNAL_WRITE_SCENE.TRANSFER,
      resourceType: 'serviceTicket',
      idempotency,
      execute: async (claim) => {
        const result = await this.withTransaction(async (transaction) => {
      const repository = this.db.getRepository('serviceTickets');
      const before = await repository.findOne({ filter: { id }, transaction });
      if (!before) {
        throw new ValidationError('NOT_FOUND', `工单 ${id} 不存在`);
      }

      const previousStoreId = Number(before.store_id);
      if (previousStoreId === targetId) {
        throw new ValidationError('SAME_STORE', '目标门店与当前门店相同');
      }

      const updated = await this.conditionalUpdate({
        ticketId: id,
        fromStatuses: TRANSFERABLE_STATUSES,
        set: { store_id: targetId },
        transaction,
      });

      if (!updated) {
        await this.throwStateConflict(id, TRANSFERABLE_STATUSES, '转店');
      }

      const storeName = await this.loadStoreName(targetId, transaction);

      const { visit, pending } = await this.voidActiveVisit({
        ticket: updated,
        revokedReason: VISIT_VOID_REASON.TRANSFERRED,
        operatorUserId,
        transaction,
      });

      const event = await this.events.write({
        ticketId: id,
        eventType: EVENT_TYPE.TRANSFERRED,
        operatorKind: OPERATOR_KIND.STORE,
        operatorUserId,
        summary: `转店：${before.source_store_code ?? previousStoreId} → ${storeName}`,
        metadata: {
          reason: reasonText,
          from_store_id: previousStoreId,
          to_store_id: targetId,
          // 刻意保留原始来源门店：它不随转店变化
          source_store_code: before.source_store_code ?? null,
          operator_username: actor.username ?? null,
          superseded_visit_id: visit ? Number(visit.id) : null,
          token_revoked: Boolean(visit),
        },
        transaction,
      });

          // 幂等占位行：事件写完之后、事务提交之前（与业务写同事务）
          await claim(Number(updated.id), transaction);

      return { ticket: stripInternal(updated), event, previousStoreId, pending };
        });

        const sms = await this.sms.flush(result.pending);
        return {
          ticket: result.ticket,
          event: result.event,
          previousStoreId: result.previousStoreId,
          sms,
        };
      },
    });
  }

  // -------------------------------------------------------------------------
  // M7 —— 取消
  // -------------------------------------------------------------------------

  /**
   * M7 cancel：NEW / PROCESSING → CANCELLED（终态）
   *
   * Phase 4 追加（docs/DEVIATIONS.md DEV-43）：**进行中的派工一并作废**。
   *
   * 为什么这是必须的、而不是"顺手加的功能"：
   *   工单取消后，已签发的师傅作业链接若仍然可用，就会出现
   *   "工单已经取消、师傅明天照常上门"——系统里这条业务已经不存在了，
   *   现场却来个人。这类错配的修复成本远高于一次短信。
   *   因此顺序是死的：**先作废 Visit（同时吊销 Token），再发取消短信**，
   *   两者在同一个事务里，短信在提交后才发。
   *
   * 对 Phase 2/3 的既有行为**无影响**：那时没有任何代码会创建 Visit，
   * `findActiveByTicket` 恒为 null，本段整体跳过。
   */
  async cancel(
    ticketId: number | string,
    reason: string,
    actor: { userId: number; username?: string },
    idempotency?: InternalWriteIdempotency | null,
  ): Promise<IdempotentWriteOutcome<{ ticket: any; event: any; sms: SmsFlushResult[] }>> {
    const id = toPositiveInt(ticketId, 'ticketId');
    const operatorUserId = toPositiveInt(actor.userId, 'operatorUserId');
    const reasonText = this.assertReason(reason, '取消');

    return this.runIdempotentWrite({
      scene: INTERNAL_WRITE_SCENE.CANCEL,
      resourceType: 'serviceTicket',
      idempotency,
      execute: async (claim) => {
        const result = await this.withTransaction(async (transaction) => {
      const updated = await this.conditionalUpdate({
        ticketId: id,
        fromStatuses: CANCELLABLE_STATUSES,
        set: {
          status: TICKET_STATUS.CANCELLED,
          close_reason: CLOSE_REASON.CANCELLED,
          closed_at: sql`now()`,
        },
        transaction,
      });

      if (!updated) {
        await this.throwStateConflict(id, CANCELLABLE_STATUSES, '取消');
      }

      const { visit, pending } = await this.voidActiveVisit({
        ticket: updated,
        revokedReason: VISIT_VOID_REASON.CANCELLED,
        operatorUserId,
        transaction,
      });

      const event = await this.events.recordTransition({
        ticketId: id,
        fromStatus: String(updated.__from_status),
        toStatus: TICKET_STATUS.CANCELLED,
        eventType: EVENT_TYPE.CANCELLED,
        operatorKind: OPERATOR_KIND.STORE,
        operatorUserId,
        summary: `工单取消：${reasonText}`,
        metadata: {
          reason: reasonText,
          operator_username: actor.username ?? null,
          // 有进行中的派工时，把"顺带作废了哪条 Visit"记下来 ——
          // 否则时间线上会看到"师傅的链接突然不能用了"而找不到原因
          superseded_visit_id: visit ? Number(visit.id) : null,
          token_revoked: Boolean(visit),
        },
        transaction,
      });

          // 幂等占位行：事件写完之后、事务提交之前（与业务写同事务）
          await claim(Number(updated.id), transaction);

      return { ticket: stripInternal(updated), event, pending };
        });

        const sms = await this.sms.flush(result.pending);
        return { ticket: result.ticket, event: result.event, sms };
      },
    });
  }

  // -------------------------------------------------------------------------
  // M3 —— 派工（Phase 4）
  // -------------------------------------------------------------------------

  /**
   * M3 dispatch：NEW / PROCESSING → PROCESSING
   *
   * 同事务副作用：新建 Visit **#1** + 签发师傅 Token（只写 sha256）
   * + 同步 `technician_*` / `expected_visit_at` 到 Ticket + `dispatch_at`（仅首次）
   * + 写 `dispatched` 事件 + **入队**两条短信（客户 + 师傅）。
   *
   * 执行顺序是刻意的，不要重排：
   *   ① 读工单并校验状态（只读，最便宜的拒绝）
   *   ② 查"是否已有进行中的派工"（有 → 409 提示走改派，而不是悄悄建第二条）
   *   ③ 条件 UPDATE 工单状态（乐观并发；0 行即冲突）
   *   ④ **此时才**建 Visit 取 visit_no
   *   ⑤ 写事件
   *   ⑥ 短信入队（事务内，pending）
   *   ⑦ 事务提交后 flush 发送
   *
   * 为什么 ④ 必须排在 ③ 之后：`visit_no` 来自 dailySequences 的原子自增，
   * 而**取号不受事务回滚影响**（刻意设计：号码一旦发出即作废，绝不回收）。
   * 把注定失败的请求挡在取号之前，能显著减少"号码空洞"。
   */
  async dispatch(
    ticketId: number | string,
    input: DispatchInput,
    actor: { userId: number; username?: string },
    idempotency?: InternalWriteIdempotency | null,
  ): Promise<IdempotentWriteOutcome<DispatchResult>> {
    const id = toPositiveInt(ticketId, 'ticketId');
    const operatorUserId = toPositiveInt(actor.userId, 'operatorUserId');
    const payload = this.assertDispatchInput(input);

    const ttlHours = await this.tokenTtlHours();
    const minted = this.tokens.mint(ttlHours);

    return this.runIdempotentWrite({
      scene: INTERNAL_WRITE_SCENE.DISPATCH,
      resourceType: 'serviceVisit',
      idempotency,
      execute: async (claim) => {
        const result = await this.withTransaction(async (transaction) => {
      const ticket = await this.findById(id, transaction);
      if (!ticket) {
        throw new ValidationError('NOT_FOUND', `工单 ${id} 不存在`);
      }

      const status = String(ticket.status);
      if (!DISPATCHABLE_STATUSES.includes(status)) {
        throw new StateConflictError(
          `工单 ${id} 当前状态为 ${status}，不能派工（仅 ${DISPATCHABLE_STATUSES.join(' / ')}）；` +
            '已闭环的工单需先由总部重开',
        );
      }

      const active = await this.visits.findActiveByTicket(id, transaction);
      if (active) {
        // 409 而不是"再建一条"：重复派工会让 visit_no 与责任主体都失真。
        // detail 里带上现有 Visit 的 id/no，前端可以直接跳到那条并提示"改派"。
        throw new StateConflictError(
          `工单 ${id} 已有进行中的派工（第 ${active.visit_no} 次上门，师傅 ${active.technician_name}），请改用「改派」`,
          'VISIT_ALREADY_ASSIGNED',
          { visit_id: Number(active.id), visit_no: Number(active.visit_no) },
        );
      }

      const updated = await this.conditionalUpdate({
        ticketId: id,
        fromStatuses: DISPATCHABLE_STATUSES,
        set: {
          status: TICKET_STATUS.PROCESSING,
          service_mode: payload.serviceMode,
          provider_name: payload.providerName,
          technician_name: payload.technicianName,
          technician_mobile: payload.technicianMobile,
          expected_visit_at: payload.expectedVisitAt,
          // 「仅首次」：COALESCE 在 SQL 里完成，避免先读后写的竞态（与 accept 同一手法）
          dispatch_at: sql`COALESCE(dispatch_at, now())`,
        },
        transaction,
      });
      if (!updated) {
        await this.throwStateConflict(id, DISPATCHABLE_STATUSES, '派工');
      }

      const created = await this.visits.create(
        {
          ticketId: id,
          serviceMode: payload.serviceMode,
          providerName: payload.providerName,
          technicianName: payload.technicianName,
          technicianMobile: payload.technicianMobile,
          expectedVisitAt: payload.expectedVisitAt,
          accessTokenHash: minted.tokenHash,
          tokenExpiresAt: minted.expiresAt,
        },
        transaction,
      );
      const visit = toPlainRow<any>(created);

      const store = await this.loadStoreName(Number(updated.store_id), transaction);

      const event = await this.events.recordTransition({
        ticketId: id,
        fromStatus: String(updated.__from_status),
        toStatus: TICKET_STATUS.PROCESSING,
        eventType: EVENT_TYPE.DISPATCHED,
        operatorKind: OPERATOR_KIND.STORE,
        operatorUserId,
        visitId: Number(visit.id),
        // ⚠️ 事件文案是**给一线同事看的**（详情抽屉的时间线直接用它），
        //    因此写「谁 · 什么方式 · 预计哪天到」，不再写「第 N 次上门」——
        //    "第几次"是 Visit 行的审计口径，售后同事关心的是人和日期。
        //    日期用 formatVisitDate（**只到天**）：不能把规范化出来的 12:00 说成真实到达时刻。
        summary:
          `派工：${payload.technicianName}` +
          ` · ${SERVICE_MODE_LABEL[payload.serviceMode] ?? payload.serviceMode}` +
          (payload.providerName ? `（${payload.providerName}）` : '') +
          ` · 预计 ${formatVisitDate(payload.expectedVisitAt)}`,
        metadata: {
          visit_id: Number(visit.id),
          visit_no: Number(visit.visit_no),
          service_mode: payload.serviceMode,
          provider_name: payload.providerName,
          // ⚠️ 事件里也**只记脱敏手机号**：ticketEvents 会被后台与导出接口读取，
          //    完整号码只在工单主表（有字段级白名单保护）里存一份。
          technician_mobile_masked: maskMobileText(payload.technicianMobile),
          expected_visit_at: payload.expectedVisitAt.toISOString(),
          token_expires_at: minted.expiresAt.toISOString(),
          note: payload.note,
          operator_username: actor.username ?? null,
        },
        transaction,
      });

      const pending = await this.enqueueDispatchPair({
        ticket: updated,
        visit,
        minted,
        store,
        hours: ttlHours,
        transaction,
      });

          // 幂等占位行：Visit 已产出（resource_id 指向它），且仍在事务内
          await claim(Number(visit.id), transaction);

      return { ticket: stripInternal(updated), visit, event, pending };
        });

    // ⚠️ 必须在这里（事务提交之后）才真正发送（见文件头第 4 条）
    const sms = await this.sms.flush(result.pending);

    this.logger?.info?.(
      `[ticket] 工单 ${id} 派工完成：visit=${result.visit.id}（第 ${result.visit.visit_no} 次），` +
        `短信 ${sms.filter((s) => s.accepted).length}/${sms.length} 已受理`,
    );

        return { ticket: result.ticket, visit: result.visit, event: result.event, sms };
      },
    });
  }

  // -------------------------------------------------------------------------
  // M4 —— 改派（Phase 4：**旧 Visit 原样保留 + 新建一条**）
  // -------------------------------------------------------------------------

  /**
   * M4 reassign：PROCESSING → PROCESSING
   *
   * 这是 Phase 4 语义最重要的一条：
   *   **改派不是"把这条 Visit 的师傅换掉"，而是"终止旧 Visit + 新建 Visit"。**
   *   旧行连一个字段都不改（师傅快照、预约时间、已上传照片全部留存），
   *   只把 `visit_status` 置为 `SUPERSEDED` 并记下被取代的时间与原因。
   *   于是"返工过程可追溯"是数据模型的必然结果，而不是靠人记得别覆盖。
   *
   * 三道前置闸门（任一不过都**不改任何数据**）：
   *   ① 工单必须是 PROCESSING；
   *   ② 必须存在 `visit_status = ASSIGNED` 的当前 Visit（**只有这一态可改派**）；
   *   ③ **责任人必须真的变了**。手机号/服务方/服务方式三者全同 → 422
   *      `SAME_RESPONSIBLE_PARTY`，并明确告诉他该用「改约」还是「更正姓名」。
   *      没有这道闸，改派接口会被当成"改点东西"的通用入口，
   *      后果是 visit_no 无意义地增长、派工历史变得不可读。
   *
   * 三条短信：客户（信息更新）+ **新**师傅（作业链接）+ **原**师傅（取消通知）。
   * 第三条最容易被漏，而漏了它就会出现"系统里已改派、原师傅照常上门"。
   */
  async reassign(
    ticketId: number | string,
    input: ReassignInput,
    actor: { userId: number; username?: string },
    idempotency?: InternalWriteIdempotency | null,
  ): Promise<IdempotentWriteOutcome<DispatchResult>> {
    const id = toPositiveInt(ticketId, 'ticketId');
    const operatorUserId = toPositiveInt(actor.userId, 'operatorUserId');
    const payload = this.assertDispatchInput(input);
    const reasonText = this.assertReason(input.reason, '改派');

    const ttlHours = await this.tokenTtlHours();
    const minted = this.tokens.mint(ttlHours);

    return this.runIdempotentWrite({
      scene: INTERNAL_WRITE_SCENE.REASSIGN,
      resourceType: 'serviceVisit',
      idempotency,
      execute: async (claim) => {
    const result = await this.withTransaction(async (transaction) => {
      const ticket = await this.findById(id, transaction);
      if (!ticket) {
        throw new ValidationError('NOT_FOUND', `工单 ${id} 不存在`);
      }
      if (String(ticket.status) !== TICKET_STATUS.PROCESSING) {
        throw new StateConflictError(
          `工单 ${id} 当前状态为 ${ticket.status}，只有 PROCESSING 才能改派`,
        );
      }

      const active = await this.visits.findActiveByTicket(id, transaction);
      if (!active) {
        throw new StateConflictError(
          `工单 ${id} 没有进行中的派工，无法改派（请先派工）`,
          'NO_ACTIVE_VISIT',
        );
      }
      if (String(active.visit_status) !== VISIT_STATUS.ASSIGNED) {
        // findActiveByTicket 已按 ASSIGNED 过滤，这里是防御性兜底：
        // 真命中说明过滤条件被人改过，宁可拒绝也不要覆盖一条已提交的 Visit。
        throw new StateConflictError(
          `工单 ${id} 的当前派工状态为 ${active.visit_status}，只有 ASSIGNED 可以改派`,
          'VISIT_NOT_REASSIGNABLE',
          { visit_id: Number(active.id), visit_status: String(active.visit_status) },
        );
      }
      if (sameResponsibleParty(active, payload)) {
        throw new ValidationError(
          'SAME_RESPONSIBLE_PARTY',
          '执行责任人未变化（师傅手机号 / 服务方 / 服务方式均相同）：' +
            '改上门时间请用「改约」，纠正师傅姓名请用「更正姓名」——' +
            '否则会凭空多出一条上门记录，让"第几次上门"失真',
        );
      }

      const previousVisit = await this.visits.supersede(
        active.id,
        { code: VISIT_VOID_REASON.REASSIGNED, note: reasonText },
        transaction,
      );
      if (!previousVisit) {
        throw new StateConflictError(
          `工单 ${id} 的当前派工状态刚刚发生变化（可能师傅已提交回执），改派未执行`,
          'VISIT_STATE_CHANGED',
          { visit_id: Number(active.id) },
        );
      }

      const updated = await this.conditionalUpdate({
        ticketId: id,
        fromStatuses: [TICKET_STATUS.PROCESSING],
        set: {
          service_mode: payload.serviceMode,
          provider_name: payload.providerName,
          technician_name: payload.technicianName,
          technician_mobile: payload.technicianMobile,
          expected_visit_at: payload.expectedVisitAt,
        },
        transaction,
      });
      if (!updated) {
        await this.throwStateConflict(id, [TICKET_STATUS.PROCESSING], '改派');
      }

      const created = await this.visits.create(
        {
          ticketId: id,
          serviceMode: payload.serviceMode,
          providerName: payload.providerName,
          technicianName: payload.technicianName,
          technicianMobile: payload.technicianMobile,
          expectedVisitAt: payload.expectedVisitAt,
          accessTokenHash: minted.tokenHash,
          tokenExpiresAt: minted.expiresAt,
          // 链条：新 Visit 指回被它取代的那条，后台可据此画出"改派链"
          reassignedFromVisitId: Number(previousVisit.id),
        },
        transaction,
      );
      const visit = toPlainRow<any>(created);
      const store = await this.loadStoreName(Number(updated.store_id), transaction);

      const event = await this.events.write({
        ticketId: id,
        eventType: EVENT_TYPE.REASSIGNED,
        operatorKind: OPERATOR_KIND.STORE,
        operatorUserId,
        visitId: Number(visit.id),
        // 文案对齐详情抽屉时间线的诉求：**谁 → 谁 / 原因**（而不是"第 N 次"）。
        // 原因放在这里是有意的：一句话讲完"发生了什么 + 为什么"，
        // 售后同事不用再点开别的记录拼答案。
        summary:
          `改派：${previousVisit.technician_name} → ${payload.technicianName}` +
          `；原因：${reasonText}`,
        metadata: {
          reason: reasonText,
          from_visit_id: Number(previousVisit.id),
          from_visit_no: Number(previousVisit.visit_no),
          from_technician_masked: maskMobileText(String(previousVisit.technician_mobile ?? '')),
          to_visit_id: Number(visit.id),
          to_visit_no: Number(visit.visit_no),
          to_technician_masked: maskMobileText(payload.technicianMobile),
          service_mode: payload.serviceMode,
          provider_name: payload.providerName,
          expected_visit_at: payload.expectedVisitAt.toISOString(),
          // 时间线上明确"旧链接已经不能用了"，客服解释这类问题时不用再翻代码
          previous_token_revoked: true,
          operator_username: actor.username ?? null,
        },
        transaction,
      });

      const pending = await this.enqueueDispatchPair({
        ticket: updated,
        visit,
        minted,
        store,
        hours: ttlHours,
        transaction,
        /** 改派时额外通知**原**师傅（scene 与收件人都不同，见 SMS_SCENE 注释） */
        cancelledTechnician: {
          visitId: Number(previousVisit.id),
          mobile: String(previousVisit.technician_mobile ?? ''),
          expectedVisitAt: previousVisit.expected_visit_at,
        },
        // 给客户的不是"已受理"（首次派工语义），而是"师傅有变更"的更新通知
        customerScene: SMS_SCENE.DISPATCH_UPDATE,
      });

      // 幂等占位行：指向**新建**的那条 Visit（旧 Visit 保持 SUPERSEDED 原样）
      await claim(Number(visit.id), transaction);

      return { ticket: stripInternal(updated), visit, event, pending };
    });

        const sms = await this.sms.flush(result.pending);

    this.logger?.info?.(
      `[ticket] 工单 ${id} 改派完成：visit=${result.visit.id}（第 ${result.visit.visit_no} 次），` +
        `旧 Token 已作废；短信 ${sms.filter((s) => s.accepted).length}/${sms.length} 已受理`,
    );

        return { ticket: result.ticket, visit: result.visit, event: result.event, sms };
      },
    });
  }

  // -------------------------------------------------------------------------
  // M5 —— 改约（Phase 4：**不新建 Visit**）
  // -------------------------------------------------------------------------

  /**
   * M5 reschedule：PROCESSING → PROCESSING
   *
   * 与 reassign 的区别只有一句话：**执行责任人没变**，所以
   *   · **不新建 Visit**（`visit_no` 不动 —— 上门次数没有增加）；
   *   · 不碰任何师傅快照字段（改的是时间，不是人）；
   *   · 旧 Token 用"换发"作废：覆盖哈希 → 旧明文**永久不可校验**，
   *     且 Visit 上的吊销标记回到 NULL（新链接必须能用）。
   *
   * ⚠️ 这里是本项目最容易写错的一处：如果换发时忘了把 `token_revoked_at` 清空，
   *    新 Token 一签发就带着"已吊销"标记 —— **师傅永远打不开链接**，
   *    而库里看起来一切正常（哈希是新的、过期时间是新的）。
   *    因此 `TokenService.reissue()` 是唯一的换发入口，并在真机验收里
   *    专门断言"改约后新 Token 可校验、旧 Token 不可校验"这一对。
   *
   * ⚠️ 六个内部写动作里，**这一个最依赖幂等**（复核方 2026-09-21 点出）：
   *   它既不满足"状态机天然拦重"（状态始终是 PROCESSING、也不新建 Visit），
   *   一次成功的改约不会留下任何"再来一次就该被拒"的状态痕迹，
   *   却带着三个副作用（换 Token + 写事件 + 发短信）。弱网重试两次，
   *   旧版代码会老老实实再跑一遍 —— 客户收到两封"时间变更"短信，
   *   客服手里的链接也会指向一个已经被顶掉的 Token。
   *   现在它由 `runIdempotentWrite` 兜住：同 key 的重放根本不进业务代码。
   */
  async reschedule(
    ticketId: number | string,
    input: RescheduleInput,
    actor: { userId: number; username?: string },
    idempotency?: InternalWriteIdempotency | null,
  ): Promise<
    IdempotentWriteOutcome<{ ticket: any; visit: any; event: any; sms: SmsFlushResult[] }>
  > {
    const id = toPositiveInt(ticketId, 'ticketId');
    const operatorUserId = toPositiveInt(actor.userId, 'operatorUserId');
    const reasonText = this.assertReason(input.reason, '改约');
    const expectedVisitAt = parseAppointmentDate(input.expectedVisitAt, 'expected_visit_at');

    const ttlHours = await this.tokenTtlHours();
    const minted = this.tokens.mint(ttlHours);

    return this.runIdempotentWrite({
      scene: INTERNAL_WRITE_SCENE.RESCHEDULE,
      // 改约不产新 Visit：幂等记录指向被改的那一条
      resourceType: 'serviceVisit',
      idempotency,
      execute: async (claim) => {
        const result = await this.withTransaction(async (transaction) => {
      const ticket = await this.findById(id, transaction);
      if (!ticket) {
        throw new ValidationError('NOT_FOUND', `工单 ${id} 不存在`);
      }
      if (String(ticket.status) !== TICKET_STATUS.PROCESSING) {
        throw new StateConflictError(
          `工单 ${id} 当前状态为 ${ticket.status}，只有 PROCESSING 才能改约`,
        );
      }

      const active = await this.visits.findActiveByTicket(id, transaction);
      if (!active) {
        throw new StateConflictError(
          `工单 ${id} 没有进行中的派工，无法改约（请先派工）`,
          'NO_ACTIVE_VISIT',
        );
      }

      const previousExpected = active.expected_visit_at;

      const updated = await this.conditionalUpdate({
        ticketId: id,
        fromStatuses: [TICKET_STATUS.PROCESSING],
        set: { expected_visit_at: expectedVisitAt },
        transaction,
      });
      if (!updated) {
        await this.throwStateConflict(id, [TICKET_STATUS.PROCESSING], '改约');
      }

      // 条件 UPDATE（仅 ASSIGNED 可改）：师傅已提交回执后再改时间毫无意义
      const visit = await this.visits.reschedule(active.id, expectedVisitAt, transaction);
      if (!visit) {
        throw new StateConflictError(
          `工单 ${id} 的当前派工状态刚刚发生变化（可能师傅已提交回执），改约未执行`,
          'VISIT_STATE_CHANGED',
          { visit_id: Number(active.id) },
        );
      }

      const reissued = await this.tokens.reissue({
        visitId: active.id,
        minted,
        transaction,
      });
      if (!reissued) {
        throw new StateConflictError(
          `工单 ${id} 的派工记录在换发作业链接时消失，改约未执行`,
          'VISIT_STATE_CHANGED',
          { visit_id: Number(active.id) },
        );
      }

      const store = await this.loadStoreName(Number(updated.store_id), transaction);

      const event = await this.events.write({
        ticketId: id,
        eventType: EVENT_TYPE.RESCHEDULED,
        operatorKind: OPERATOR_KIND.STORE,
        operatorUserId,
        visitId: Number(active.id),
        summary:
          // ⚠️ 说「上门**日期**」而不是「上门时间」：格式化的值只到天，
          //    用"时间"称呼它会让人以为背后有一个精确到分钟的真实承诺。
          `改约：${formatVisitDate(previousExpected)} → ${formatVisitDate(expectedVisitAt)}` +
          `；原因：${reasonText}`,
        metadata: {
          reason: reasonText,
          visit_id: Number(active.id),
          visit_no: Number(active.visit_no),
          from_expected_visit_at: toIsoOrNull(previousExpected),
          to_expected_visit_at: expectedVisitAt.toISOString(),
          // 明确记录"链接换了"：旧链接打不开时客服能一眼看到原因，
          // 而 Visit 行上的 token_revoked_* 保持 NULL（当前这枚是有效的）
          token_reissued: true,
          previous_token_invalid: true,
          operator_username: actor.username ?? null,
        },
        transaction,
      });

      const pending = await this.enqueueDispatchPair({
        ticket: updated,
        visit: reissued,
        minted,
        store,
        hours: ttlHours,
        transaction,
        // 改约通知客户的是"上门时间已更新为X"，同样不是首次派工的"已受理"
        customerScene: SMS_SCENE.DISPATCH_UPDATE,
      });

          await claim(Number(reissued.id), transaction);

      return { ticket: stripInternal(updated), visit: reissued, event, pending };
        });

        const sms = await this.sms.flush(result.pending);

    this.logger?.info?.(
      `[ticket] 工单 ${id} 改约完成：visit=${result.visit.id}（第 ${result.visit.visit_no} 次，未新建），` +
        `旧 Token 已作废并换发新 Token；短信 ${sms.filter((s) => s.accepted).length}/${sms.length} 已受理`,
    );

        return { ticket: result.ticket, visit: result.visit, event: result.event, sms };
      },
    });
  }

  // -------------------------------------------------------------------------
  // 师傅提交回执（P5-1）—— 一个事务里完成四件事
  // -------------------------------------------------------------------------

  /**
   * 师傅提交回执：`Visit ASSIGNED → SUBMITTED` + Token 一次性失效 +
   * `Ticket PROCESSING → WAIT_STORE_CONFIRM` + 写 `technician_submitted` 事件。
   *
   * ---------------------------------------------------------------------------
   * 为什么这四件事必须**在同一个事务里**（而不是各写各的）
   * ---------------------------------------------------------------------------
   * 它们描述的是同一件事实：「第 N 次上门作业已完成」。任何一步落单，
   * 系统里就出现一个**自相矛盾的工单**，而且都不是崩溃、只是"数据不对"：
   *
   *   · 只有 Visit 变了 → 门店看板（按 ticket.status 过滤）找不到这张待审核单，
   *     师傅以为提交成功、门店什么也没收到 —— 这是最坏的一种，没有人会报错；
   *   · 只有 Token 失效 → 师傅刷新看到"链接已失效"，但门店侧还显示"待师傅作业"，
   *     客服即使想重发链接也解释不清（Visit 还是 ASSIGNED，重发也不会通过校验）；
   *   · 只有 Ticket 变了 → Visit 仍 ASSIGNED，`findActiveByTicket()` 认为还有
   *     "进行中的派工"，于是门店**无法改派**（会被"已有进行中的派工"拦下），
   *     这张单就此卡死，只能人工改库；
   *   · 缺事件 → 时间线上凭空少一段，Phase 6 的审核与 Phase 9 的时效统计
   *     都会把它算漏，而且**事后无法补**（补出来的时间戳是假的）。
   *
   * 因此顺序是刻意的，且每一步失败都**抛错让整体回滚**：
   *   ① Visit（最可能因"已提交过/已被改派"而失败，放最前，失败代价最小）
   *   ② Token 消费（紧随其后，保证①成功后入口立刻关闭）
   *   ③ Ticket 状态（唯一可能因并发被他人抢占的一步）
   *   ④ 事件（写在最后：前面的状态都已成立，事件是"已发生"的记录而不是"将要发生"的指令）
   *
   * ---------------------------------------------------------------------------
   * ⚠️ 这里**刻意不做** request-id 幂等（与 `/api/svc/*` 的写动作不同）
   * ---------------------------------------------------------------------------
   * 内部写动作靠 `runIdempotentWrite()` + `X-Request-Id` 去重，因为它们的
   * 副作用（换 Token、发短信）在状态上可能不留痕迹。**师傅提交不需要它**：
   * 一次性 Token 本身就**是**提交边界 —— 提交成功后 Token 立即失效，
   * 同一链接的第二次请求连认证层都过不去（401 TOKEN_INVALID，见
   * `verify-technician-submit.mjs` 的重放用例）。
   * 用一个"允许重放返回首次响应"的幂等机制去覆盖它，等于**把已经关掉的匿名入口
   * 重新打开一次**，而打开的正是那个"可以被任何人拿旧链接再跑一遍"的口子。
   * 因此 `IDEMPOTENCY_SCENE.TECHNICIAN_SUBMIT` 这个常量**保持未被使用**，
   * 它的存在只是"曾计划过"的痕迹 —— 不要因为它在常量表里就把它接上。
   *
   * @returns `alreadyUsedToken` 为 true 表示"Visit 还是 ASSIGNED 但 Token 已被消费"
   *          —— 那是**不可能由正常流程产生的**状态（两者同事务），
   *          出现即说明有人绕过服务层改过库，此时抛冲突而不是继续。
   */
  async technicianSubmit(input: {
    visitId: number | string;
    ticketId: number | string;
    service_result: string;
    service_note: string;
    is_charged: boolean;
    reported_charge_amount: number | null;
    /** 本次上门已上传的照片张数，只进事件 metadata（用于审核侧判断"有没有带证据"） */
    photoCount?: number;
  }): Promise<{ visit: any; ticket: any; event: any }> {
    const ticketId = toPositiveInt(input.ticketId, 'ticketId');
    const visitId = toPositiveInt(input.visitId, 'visitId');

    return this.withTransaction(async (transaction) => {
      // ① Visit：条件 UPDATE，只有 ASSIGNED 能走到 SUBMITTED。
      //    回执字段（service_result / service_note / is_charged / 金额 / submitted_at）
      //    在这一步一起写入 —— 它们与状态是同一件事的两面，不能分两次写。
      const visit = await this.visits.submit(
        {
          visitId,
          service_result: input.service_result,
          service_note: input.service_note,
          is_charged: input.is_charged,
          reported_charge_amount: input.reported_charge_amount,
        },
        transaction,
      );
      if (!visit) {
        throw new StateConflictError(
          `上门作业记录 ${visitId} 不处于可提交状态（可能已提交过、已被改派或已取消）`,
          'VISIT_NOT_SUBMITTABLE',
          { visit_id: visitId },
        );
      }

      // ② Token 一次性失效。**必须在同一事务**：见 TokenService.consume 的注释。
      const consumed = await this.tokens.consume(visitId, transaction);
      if (!consumed.consumed) {
        throw new StateConflictError(
          `上门作业记录 ${visitId} 的作业链接此前已被使用，但作业状态仍是"待作业" ——` +
            '数据不一致，请人工核查',
          'TOKEN_ALREADY_CONSUMED',
          { visit_id: visitId, token_used_at: toIsoOrNull(consumed.usedAt) },
        );
      }

      // ③ Ticket：严格只接受 PROCESSING。
      //    为什么不像 verify() 那样也接受 NEW：有 Visit 就必然已经被派过工，
      //    `dispatch()` 会把 NEW 推到 PROCESSING。停在 NEW 而存在 ASSIGNED 的 Visit
      //    说明有人绕过服务层改过库 —— 那种情况宁可 409 让人来看，
      //    也不要"顺手把它推到 WAIT_STORE_CONFIRM"，把坏数据洗成正常数据。
      const updated = await this.conditionalUpdate({
        ticketId,
        fromStatuses: [TICKET_STATUS.PROCESSING],
        set: { status: TICKET_STATUS.WAIT_STORE_CONFIRM },
        transaction,
      });
      if (!updated) {
        await this.throwStateConflict(ticketId, [TICKET_STATUS.PROCESSING], '师傅提交回执');
      }

      // ④ 事件：from/to 由上面那次 UPDATE 的回填给出（`__from_status`），
      //    不在这里手写字面量 —— 写反 from/to 是这类记录最常见的错。
      const event = await this.events.recordTransition({
        ticketId,
        fromStatus: (updated as any).__from_status,
        toStatus: TICKET_STATUS.WAIT_STORE_CONFIRM,
        operatorKind: OPERATOR_KIND.TECHNICIAN,
        eventType: EVENT_TYPE.TECHNICIAN_SUBMITTED,
        visitId,
        summary: `师傅已提交处理结果：${
          // 标签从 constants 取（与后台下拉同源）。取不到就回退成原值 ——
          // 事件摘要宁可显示 `need_followup` 这种机器值，也不能变成空字符串
          // （空摘要会让时间线出现一条看不出发生了什么的事件）。
          SERVICE_RESULT_LABEL[input.service_result] ?? input.service_result
        }`,
        metadata: {
          visit_id: visitId,
          visit_no: Number(visit.visit_no),
          service_result: input.service_result,
          is_charged: input.is_charged === true,
          reported_charge_amount: input.is_charged === true ? input.reported_charge_amount : null,
          photo_count: Number(input.photoCount ?? 0) || 0,
          // 明确记录匿名入口已关闭 —— 客服遇到"链接打不开"时，
          // 一眼能看出是"师傅提交完了"而不是"系统出问题了"
          token_consumed: true,
        },
        transaction,
      });

      this.logger?.info?.(
        `[ticket] 工单 ${ticketId} 师傅回执已提交：visit=${visitId}（第 ${visit.visit_no} 次）→ ` +
          `WAIT_STORE_CONFIRM，作业链接已作废（等门店确认，本阶段到此为止）`,
      );

      return { visit, ticket: stripInternal(updated), event };
    });
  }

  // -------------------------------------------------------------------------
  // 查询辅助（只读，不做鉴权 —— 调用方须先过 PermissionService）
  // -------------------------------------------------------------------------

  /** 按 ID 取工单 */
  async findById(ticketId: number | string, transaction?: unknown): Promise<any | null> {
    const repository = this.db.getRepository('serviceTickets');
    const options: Record<string, unknown> = { filter: { id: toPositiveInt(ticketId, 'ticketId') } };
    if (transaction) options.transaction = transaction;
    return repository.findOne(options);
  }

  // -------------------------------------------------------------------------
  // 内部：派工辅助（Phase 4）
  // -------------------------------------------------------------------------

  /** 师傅作业链接有效期（小时）。参数缺失时回退代码默认值 72（ConfigService 负责告警） */
  private async tokenTtlHours(): Promise<number> {
    const hours = await this.config.getInt('technician.token_expire_hours', 72);
    return Number.isFinite(hours) && hours > 0 ? Math.trunc(hours) : 72;
  }

  /**
   * 派工输入的**唯一**校验点（dispatch / reassign 共用）。
   *
   * 校验全部放在服务层而不是 action 层：系统侧调用（定时任务、批处理）
   * 同样要受这些约束，放在 action 层等于给它们开了后门。
   */
  private assertDispatchInput(input: DispatchInput): {
    serviceMode: string;
    providerName: string | null;
    technicianName: string;
    technicianMobile: string;
    expectedVisitAt: Date;
    note: string | null;
  } {
    const serviceMode = String(input?.serviceMode ?? '').trim();

    if (serviceMode === SERVICE_MODE.REMOTE) {
      // 见 constants.DISPATCHABLE_SERVICE_MODES 的完整理由（DEV-42）：
      // 远程处理不走派工，它由 M11 自己建一条 is_remote 的 Visit（Phase 6）。
      throw new ValidationError(
        'REMOTE_MODE_DEFERRED',
        '远程处理不走派工流程（M11，Phase 6 交付）：请先按上门派工，或等远程流程上线',
      );
    }
    if (!DISPATCHABLE_SERVICE_MODES.includes(serviceMode)) {
      throw new ValidationError(
        'INVALID_ENUM',
        `service_mode 必须是 ${DISPATCHABLE_SERVICE_MODES.join(' / ')} 之一，实际 "${serviceMode}"`,
      );
    }

    const providerName = input.providerName ? String(input.providerName).trim() : null;
    if (providerName && providerName.length > 64) {
      throw new ValidationError('FIELD_TOO_LONG', '服务方名称不能超过 64 字');
    }
    if (
      (serviceMode === SERVICE_MODE.MANUFACTURER || serviceMode === SERVICE_MODE.THIRD_PARTY) &&
      !providerName
    ) {
      // 厂家/三方送修必须有主体名称：否则工单上只写"师傅李四"，
      // 后续对账、追责、回访都找不到"是谁修的"。
      throw new ValidationError(
        'MISSING_PROVIDER',
        '服务方式为厂家/第三方时必须填写服务方名称（provider_name）',
      );
    }

    const technicianName = String(input.technicianName ?? '').trim();
    if (technicianName.length === 0) {
      throw new ValidationError('MISSING_TECHNICIAN_NAME', '必须填写师傅姓名');
    }
    if (technicianName.length > 32) {
      throw new ValidationError('FIELD_TOO_LONG', '师傅姓名不能超过 32 字');
    }

    const technicianMobile = String(input.technicianMobile ?? '').trim();
    if (!isMobile(technicianMobile)) {
      throw new ValidationError('INVALID_TECHNICIAN_MOBILE', '师傅手机号格式不正确');
    }

    const expectedVisitAt = parseAppointmentDate(input.expectedVisitAt, 'expected_visit_at');

    const note = input.note ? String(input.note).trim().slice(0, 200) : null;

    return { serviceMode, providerName, technicianName, technicianMobile, expectedVisitAt, note };
  }

  /**
   * 入队**派工对**短信：客户一条 + 师傅一条。
   *
   * 两条的 scene **必须不同**（`dispatch_customer` / `technician_task`），
   * 这与"模板 CODE 不同"是两回事：模板不同只影响文案，scene 不同才保证
   * SmsService 会拒绝"客户收件人 + 师傅 scene"这类错配（见 SMS_SCENE_RECIPIENT）。
   *
   * `cancelledTechnician` 只在改派时传入，用于通知**原**师傅 ——
   * 它用的是第三个 scene，收件人虽然同为 technician，但**用途不同**
   * （"你有新任务" vs "你的任务没了"），合规文案也不一样，因此不能复用。
   */
  private async enqueueDispatchPair(params: {
    ticket: any;
    visit: any;
    minted: MintedToken;
    store: string;
    hours: number;
    transaction?: unknown;
    /**
     * 给**客户**发哪条 scene。
     *
     * 为什么必须区分（Phase 4-B 收口时修）：
     *   `dispatch_customer` 的文案是"您的报修已由某店受理，师傅X将于…" ——
     *   那是**首次派工**的语义。改派/改约时客户早已收到过这条，
     *   再发一遍"已受理"是在告诉他一件已经发生的事，而真正变化的信息
     *   （新时间 / 新师傅）反而没有强调。供应商侧则是**模板 CODE 用错**：
     *   用 `ALIYUN_SMS_TPL_DISPATCH_CUSTOMER` 发更新通知，
     *   模板变量能对上，所以不报任何错，只是内容不对 —— 正是本项目最怕的那类静默缺陷。
     *
     *   `SMS_SCENE.DISPATCH_UPDATE` 早就为此定义好了（含独立的模板 CODE、
     *   独立的环境变量后缀），却一直没有任何调用方 —— 一个"定义了但永不使用"
     *   的场景，等价于把这条规则只写进了注释。此处接上。
     *
     * 师傅侧**不区分**：无论首次还是改派，他需要的都是同一个东西 ——
     *   作业链接 + 预约时间，所以统一用 `TECHNICIAN_TASK`（供应商只需审一套模板）。
     */
    customerScene?: string;
    cancelledTechnician?: { visitId: number; mobile: string; expectedVisitAt: unknown };
  }): Promise<PendingSms[]> {
    const { ticket, visit, minted, store, hours } = params;
    const customerScene = params.customerScene ?? SMS_SCENE.DISPATCH_CUSTOMER;
    const ticketId = Number(ticket.id);
    const visitId = Number(visit.id);
    const ticketNo = String(ticket.ticket_no ?? '');
    const label = TICKET_TYPE_LABEL[String(ticket.ticket_type)] ?? '报修';
    const expected = formatVisitDate(visit.expected_visit_at);

    const pending: PendingSms[] = [];

    pending.push(
      await this.sms.enqueue(
        {
          scene: customerScene,
          recipientKind: SMS_RECIPIENT_KIND.CUSTOMER,
          to: String(ticket.customer_mobile ?? ''),
          ticketId,
          visitId,
          params: {
            store,
            label,
            ticket_no: ticketNo,
            technician: String(visit.technician_name ?? ''),
            expected,
          },
        },
        params.transaction,
      ),
    );

    pending.push(
      await this.sms.enqueue(
        {
          scene: SMS_SCENE.TECHNICIAN_TASK,
          recipientKind: SMS_RECIPIENT_KIND.TECHNICIAN,
          to: String(visit.technician_mobile ?? ''),
          ticketId,
          visitId,
          params: {
            store,
            ticket_no: ticketNo,
            // 只给师傅脱敏后的客户号码 + 姓名：完整号码需要他打开作业页（Token 校验过）才可见。
            // 这是一处**刻意的隐私取舍**，已在 docs/PHASE-4.md 登记待业务确认。
            contact: contactOf(ticket),
            expected,
            // ⚠️ 明文 Token 只是这个链接的一部分，它**只在内存里**流转到这里，
            //    不落 SmsLog、不进事件 metadata。
            link: minted.link,
            hours,
          },
        },
        params.transaction,
      ),
    );

    if (params.cancelledTechnician) {
      pending.push(
        await this.sms.enqueue(
          {
            scene: SMS_SCENE.TECHNICIAN_ASSIGNMENT_CANCELLED,
            recipientKind: SMS_RECIPIENT_KIND.TECHNICIAN,
            to: params.cancelledTechnician.mobile,
            ticketId,
            // 挂在**旧** Visit 上：这条通知说的就是"那条派工没了"，
            // 挂到新 Visit 上会让时间线读起来自相矛盾。
            //
            // ⚠️ 这里曾经传 `null`（biz_id 里落成 `x`），与注释正好相反 ——
            //    根因是当时 `cancelledTechnician` 只带了手机号与预约时间、
            //    **拿不到旧 Visit 的 id**，于是"先写注释、代码凑合"。
            //    后果不致命（biz_id 还有随机后缀，不撞唯一键），但排障时
            //    "这条取消短信对应哪次派工"就答不出来了 —— 而这正是要留日志的原因。
            //    所以把 visitId 一并传进来，让代码与注释一致。
            visitId: params.cancelledTechnician.visitId,
            params: {
              store,
              ticket_no: ticketNo,
              expected: formatVisitDate(params.cancelledTechnician.expectedVisitAt),
            },
          },
          params.transaction,
        ),
      );
    }

    return pending;
  }

  /**
   * 作废当前进行中的派工（并通知原师傅）。
   *
   * 供 `cancel`（工单取消）与 `transfer`（转店）复用 —— 两处都要做同一件事，
   * 各写一遍迟早有一处漏掉"通知原师傅"。
   *
   * 条件 UPDATE 未命中时**不阻断主流程**（工单取消/转店已是既定事实），
   * 但要留 warn：那意味着师傅刚好在同一瞬间提交了回执，
   * 此时"链接失效"这件事已经不重要了（Visit 已进入审核流程）。
   */
  private async voidActiveVisit(params: {
    ticket: any;
    /** `token_revoked_reason` / `superseded_reason` 的稳定短标识 */
    revokedReason: string;
    operatorUserId: number;
    transaction?: unknown;
  }): Promise<{ visit: any | null; pending: PendingSms[] }> {
    const ticketId = Number(params.ticket.id);
    const active = await this.visits.findActiveByTicket(ticketId, params.transaction);
    if (!active) return { visit: null, pending: [] };

    let voided: any | null;
    switch (params.revokedReason) {
      case VISIT_VOID_REASON.CANCELLED:
        voided = await this.visits.cancelActive(
          active.id,
          { code: params.revokedReason },
          params.transaction,
        );
        break;
      case VISIT_VOID_REASON.TRANSFERRED:
        voided = await this.visits.supersede(
          active.id,
          { code: params.revokedReason },
          params.transaction,
        );
        break;
      default:
        // 未知原因码一律抛错：这条链路上"静默作废"比"操作失败"危险得多
        throw new Error(
          `[ticket] voidActiveVisit 不支持的原因码 "${params.revokedReason}"；` +
            `允许：${VISIT_VOID_REASON.CANCELLED} / ${VISIT_VOID_REASON.TRANSFERRED}`,
        );
    }

    if (!voided) {
      this.logger?.warn?.(
        `[ticket] 工单 ${ticketId} 的进行中派工（visit=${active.id}）状态已变化，` +
          '本次未作废 —— 师傅可能刚提交回执',
      );
      return { visit: null, pending: [] };
    }

    this.logger?.info?.(
      `[ticket] 工单 ${ticketId} 的派工 visit=${voided.id} 已作废（${params.revokedReason}），` +
        '作业链接同时失效，正在通知原师傅',
    );

    const store = await this.loadStoreName(Number(params.ticket.store_id), params.transaction);
    const pending = await this.sms.enqueue(
      {
        scene: SMS_SCENE.TECHNICIAN_ASSIGNMENT_CANCELLED,
        recipientKind: SMS_RECIPIENT_KIND.TECHNICIAN,
        to: String(voided.technician_mobile ?? ''),
        ticketId,
        visitId: Number(voided.id),
        params: {
          store,
          ticket_no: String(params.ticket.ticket_no ?? ''),
          expected: formatVisitDate(voided.expected_visit_at),
        },
      },
      params.transaction,
    );

    return { visit: voided, pending: [pending] };
  }

  // -------------------------------------------------------------------------
  // 内部：条件更新
  // -------------------------------------------------------------------------

  /**
   * 条件 UPDATE（乐观并发）。
   *
   * 返回更新后的行（含内部字段 `__from_status` = 更新前的状态，供写事件用）；
   * 影响 0 行返回 null，由调用方抛 StateConflictError。
   *
   * 为什么用 `RETURNING *` 而不是看 rowCount：
   *   sequelize 对 UPDATE 的 metadata 在各方言下形态不一致（PG 给 rowCount，
   *   MySQL 给 affectedRows），而 RETURNING 是 PG 的强项且语义最直白：
   *   **返回了行就是更新成功了**。本系统只支持 PostgreSQL，用满它的能力。
   */
  private async conditionalUpdate(params: {
    ticketId: number;
    fromStatuses: string[];
    set: Record<string, unknown>;
    transaction?: unknown;
  }): Promise<any | null> {
    const { ticketId, fromStatuses, set, transaction } = params;

    const columns = Object.keys(set);
    for (const column of columns) {
      if (!UPDATABLE_COLUMNS.has(column)) {
        throw new Error(`[ticket] 列 "${column}" 不在允许更新白名单内（防列名注入）`);
      }
    }

    const bind: unknown[] = [ticketId, fromStatuses];
    const assignments: string[] = [];

    // 参数序号从 $3 开始（$1=id，$2=状态数组）
    columns.forEach((column, index) => {
      const value = set[column];
      if (value instanceof RawSql) {
        // 原生片段：内部构造，绝不接受外部输入
        assignments.push(`${column} = ${value.inline(bind)}`);
      } else {
        bind.push(value);
        assignments.push(`${column} = $${bind.length}`);
      }
    });

    // updated_at 是 NOT NULL 且无 DB 默认值，必须显式赋值
    assignments.push(`updated_at = now()`);

    const sqlText =
      `UPDATE service_tickets SET ${assignments.join(', ')} ` +
      `WHERE id = $1 AND status = ANY($2::text[]) ` +
      `RETURNING *`;

    const [rows] = await this.rawQuery(sqlText, bind, transaction);
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return null;

    // 记下更新前的状态：并发下我们无法再 SELECT 一次（状态已经变了）
    const changed = { ...(row as Record<string, unknown>) };
    changed.__from_status = resolveChangedFrom(fromStatuses, String(changed.status));
    return changed;
  }

  /**
   * 影响 0 行时，查一次真实状态好把冲突信息说清楚（日志/前端提示用）。
   * 注意：这里读了库但**不用于决策**，决策已经由 UPDATE 完成。
   */
  private async throwStateConflict(
    ticketId: number,
    expected: string[],
    action: string,
  ): Promise<never> {
    const current = await this.findById(ticketId);
    const currentStatus = current ? String(current.status) : '(不存在)';
    const message =
      `工单 ${ticketId} 当前状态为 ${currentStatus}，` +
      `不满足「${action}」要求的 ${expected.join('/')} —— 可能已被他人操作`;
    this.logger?.warn?.(`[ticket] ${message}`);
    throw new StateConflictError(message);
  }

  // -------------------------------------------------------------------------
  // 内部：事务与查询
  // -------------------------------------------------------------------------

  /**
   * 开事务执行。
   *
   * 若宿主没有 sequelize.transaction（离线桩环境），退化为"直接执行、不传事务"，
   * 这样服务层在桩环境下仍可被单测覆盖 —— 桩环境本来就验不了事务语义，
   * 硬报错只会让整批用例变红而掩盖真正的问题。
   */
  private async withTransaction<T>(fn: (transaction: unknown) => Promise<T>): Promise<T> {
    const sequelize = this.db?.sequelize;
    if (!sequelize || typeof sequelize.transaction !== 'function') {
      this.logger?.debug?.('[ticket] sequelize.transaction 不可用，本次操作未使用事务');
      return fn(undefined);
    }
    return sequelize.transaction(fn);
  }

  private async rawQuery(
    sqlText: string,
    bind: unknown[],
    transaction?: unknown,
  ): Promise<[unknown, unknown]> {
    const sequelize = this.db?.sequelize;
    if (!sequelize || typeof sequelize.query !== 'function') {
      throw new Error('[ticket] db.sequelize.query 不可用');
    }
    const options: Record<string, unknown> = { bind };
    if (transaction) options.transaction = transaction;
    return (await sequelize.query(sqlText, options)) as [unknown, unknown];
  }

  // -------------------------------------------------------------------------
  // 内部：校验
  // -------------------------------------------------------------------------

  private async resolveStore(input: CreateTicketInput): Promise<{ id: number; code: string; name: string }> {
    const repository = this.db.getRepository('stores');
    const filter: Record<string, unknown> = {};

    if (input.storeId !== undefined && input.storeId !== null) {
      filter.id = toPositiveInt(input.storeId, 'storeId');
    } else if (input.storeCode) {
      filter.code = String(input.storeCode).trim();
    } else {
      throw new ValidationError('MISSING_STORE', '必须提供 storeId 或 storeCode');
    }

    const store = await repository.findOne({ filter });
    if (!store) {
      throw new ValidationError('STORE_NOT_FOUND', '门店不存在');
    }
    if (store.active !== true) {
      // M1 前置校验：门店必须 active
      throw new ValidationError('STORE_INACTIVE', `门店「${store.name}」已停用，暂不能报修`);
    }

    return { id: Number(store.id), code: String(store.code), name: String(store.name) };
  }

  private async loadStoreName(storeId: number, transaction?: unknown): Promise<string> {
    const repository = this.db.getRepository('stores');
    const options: Record<string, unknown> = { filter: { id: storeId } };
    if (transaction) options.transaction = transaction;
    const store = await repository.findOne(options);
    return store ? `${store.name}(${store.code})` : String(storeId);
  }

  private assertEnum(value: unknown, allowed: readonly string[], field: string): string {
    const text = String(value ?? '').trim();
    if (!allowed.includes(text)) {
      throw new ValidationError(
        'INVALID_ENUM',
        `${field} 必须是 ${allowed.join(' / ')} 之一，实际 "${text}"`,
      );
    }
    return text;
  }

  private assertReason(reason: unknown, action: string): string {
    const text = String(reason ?? '').trim();
    if (text.length === 0) {
      throw new ValidationError('MISSING_REASON', `${action}必须填写原因`);
    }
    if (text.length > 200) {
      throw new ValidationError('REASON_TOO_LONG', `${action}原因不能超过 200 字`);
    }
    return text;
  }
}

// ---------------------------------------------------------------------------
// 原生 SQL 片段（内部专用）
// ---------------------------------------------------------------------------

/**
 * 包一层原生 SQL 片段，让 `COALESCE(handler_user_id, $3)` 这类表达式
 * 能安全地混进参数化语句。
 *
 * ⚠️ 这个类**只允许在 TicketService 内部构造**，绝不接受来自请求的值 ——
 *    一旦把外部字符串塞进来，参数化就形同虚设。
 */
class RawSql {
  constructor(private readonly build: (bind: unknown[]) => string) {}
  inline(bind: unknown[]): string {
    return this.build(bind);
  }
}

const sql = (strings: TemplateStringsArray, ...values: unknown[]): RawSql =>
  new RawSql((bind: unknown[]) => {
    let out = '';
    strings.forEach((chunk, index) => {
      out += chunk;
      if (index < values.length) {
        bind.push(values[index]);
        out += `$${bind.length}`;
      }
    });
    return out;
  });

function resolveChangedFrom(fromStatuses: string[], currentStatus: string): string {
  // 条件更新命中的原状态：优先取"唯一候选"，否则取条件里那个不等于当前值的
  if (fromStatuses.length === 1) return fromStatuses[0];
  return fromStatuses.find((status) => status !== currentStatus) ?? fromStatuses[0];
}

function stripInternal<T extends Record<string, unknown>>(row: T): Omit<T, '__from_status'> {
  const { __from_status: _drop, ...rest } = row;
  return rest;
}

function toPositiveInt(value: unknown, field: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    throw new ValidationError('INVALID_ID', `${field} 必须是正整数`);
  }
  return num;
}

/**
 * 把时间格式化成短信里给人看的样子（`09-23 14:30`）。
 *
 * 为什么不用 `toISOString()`：短信是给客户和师傅看的，
 * `2026-09-23T06:30:00.000Z` 既长又会被误读成当地时间（它其实是 UTC）。
 * 这里统一按**容器的本地时区**（`TZ=Asia/Shanghai`）渲染。
 *
 * 时区取错的表现很隐蔽：短信里写着"14:30 上门"，师傅按 06:30 的 UTC 理解
 * （或反过来），只有真机上跨时区才会暴露。
 */
/**
 * 「预计上门日期」的展示文案 —— **只到天**（`09-24`）。
 *
 * ⚠️ 原实现叫 `formatVisitTime`，输出 `MM-DD HH:mm`。2026-09-23 改掉，原因：
 *   存储层的时分是**规范化产物**（共享契约把日期统一写成当日正午
 *   `APPOINTMENT_CANONICAL_TIME`），**不是真实承诺到达时刻**。
 *   把它渲染进**事件文案**与**客户短信**，等于用系统自己的口吻
 *   向门店与客户宣布一个项目根本没有能力支撑的精度
 *   （"原定 09-24 12:00 上门" → 客户 11:50 就开始等）。
 *
 * 复核方 2026-09-23 明确：UI / TicketEvent 都不得把固定时分描述成真实预约时间；
 * SLA 也不得把它当真实承诺到达时刻（Phase 9 再裁定 overdue 的日期语义）。
 * 短信虽然没被点名，但它是**送达客户**的展示面，同属"不得虚构精度"，
 * 因此一并改为只到天。
 *
 * 真正需要精确时刻时（未来若接入排班），应当**新增**一个字段承载真实时段，
 * 而不是让这个规范化值顺带承担该语义。
 */
export function formatVisitDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) return '待定';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 事件的 metadata 里记原始时间戳（ISO），查不到就给 null —— 不要回退成空串 */
function toIsoOrNull(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 解析日期入参。非法一律 422（而不是悄悄用当前时间，那会派出一个错误的上门时间） */
/**
 * 「预计上门日期」解析 —— **只保留天**，时分统一规范化成固定时刻。
 *
 * ⚠️ 为什么服务端也要做一次（客户端出口已经规范化了）：
 *   服务端不是只能被自家 UI 调用 —— curl / 自动化脚本 / 旧的前端产物
 *   都会直接打 `/api/svc:dispatch`。如果只在客户端规范化，那么
 *   "同一天"会因入口不同而落成两个时刻（12:00 与 09:37），
 *   于是 ① 数据里出现一个看起来精确、实际毫无意义的时分；
 *        ② 任何按毫秒比较的逻辑（Phase 9 的 SLA）都会开始区分
 *           "两个其实同日期的值"。**入口处兜底才是"存储层统一规范化"**。
 *
 * 归一目标见 shared/service-mode.ts 的 APPOINTMENT_CANONICAL_TIME（当日正午，
 * 选正午是为了抗时区误读）。这里按 **+08:00** 计算日历天，不依赖进程 TZ ——
 * 容器 TZ 一旦被改，日期不会悄悄漂一天。
 */
export function parseAppointmentDate(value: unknown, field: string): Date {
  return canonicalizeAppointmentDate(parseDateInput(value, field), field);
}

/** 把任意时刻折算成"它所属的那一天"的统一固定时刻 */
export function canonicalizeAppointmentDate(date: Date, field = 'expected_visit_at'): Date {
  const offsetMs = timezoneOffsetMs(APPOINTMENT_TIMEZONE_OFFSET);
  // 加偏移后读 UTC 字段 = 直接读业务时区的日历字段（与时区数据库无关）
  const shifted = new Date(date.getTime() + offsetMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(
    shifted.getUTCDate(),
  )}`;
  const canonical = new Date(`${day}T${APPOINTMENT_CANONICAL_TIME}${APPOINTMENT_TIMEZONE_OFFSET}`);
  if (Number.isNaN(canonical.getTime())) {
    throw new ValidationError('INVALID_DATETIME', `${field} 无法规范化到日期`);
  }
  return canonical;
}

/** `+08:00` → 毫秒（只支持这一种形态；写错会当场抛，不会静默按 0 处理） */
function timezoneOffsetMs(offset: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) throw new Error(`[appointment] 非法时区偏移：${offset}`);
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3])) * 60000;
}

function parseDateInput(value: unknown, field: string): Date {
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return value;
    throw new ValidationError('INVALID_DATETIME', `${field} 不是合法时间`);
  }
  const text = String(value ?? '').trim();
  if (!text) {
    throw new ValidationError('MISSING_FIELD', `${field} 不能为空`);
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError('INVALID_DATETIME', `${field} 不是合法时间："${text}"`);
  }
  return parsed;
}

/** 师傅短信里的"客户怎么称呼"：姓名 + **脱敏**号码（完整号码要打开作业页才可见） */
function contactOf(ticket: any): string {
  const name = String(ticket?.customer_name ?? '').trim();
  const masked = maskMobileText(String(ticket?.customer_mobile ?? ''));
  return name ? `${name} ${masked}` : `客户 ${masked}`;
}

/**
 * 唯一约束冲突的**统一识别器**（PG 23505）。
 *
 * 为什么要按"列名出现在 detail 里"判定，而不是按约束名：
 *   `ticket_no` 的唯一性是**字段级** `unique: true` 声明的，落库是 PG UNIQUE CONSTRAINT，
 *   名字由 PG 生成（`service_tickets_ticket_no_key`）；而 `idempotency_records` 那条
 *   是 collection 级索引，且因为 NocoBase 会静默丢弃声明式索引（DEV-16），
 *   实际由 `ensureIndexes()` 兜底创建，名字与前者的命名规则**并不一致**。
 *   按名字判会在两种环境下各错一次 —— 按列名判则只依赖 PG 的错误 detail，稳定。
 *
 * ⚠️ `detail` 同时包含**键名**与**键值**，所以匹配必须用带括号的键名形态
 *    （`(ticket_no)` / `(scene, idempotency_key)`）：只用 `includes('ticket_no')`
 *    会被"值里恰好含该串"误命中。本项目的值里目前不会出现，但这属于运气而非设计。
 */
export function isUniqueViolationOn(error: unknown, columns: string[]): boolean {
  const anyError = error as any;
  const original = anyError?.original ?? anyError;
  const code = original?.code ?? anyError?.code;
  if (code !== '23505') return false;

  const detail = String(original?.detail ?? '');
  const keyed = /Key\s*\(([^)]*)\)/.exec(detail);
  if (keyed) {
    const keys = keyed[1].split(',').map((s) => s.trim());
    return columns.every((column) => keys.includes(column));
  }

  // 兜底：拿不到 detail 的驱动/版本差异下退回约束名匹配。
  // 要求名字里**同时**含全部列名，避免 `..._store_id_fkey` 这类前缀误命中。
  const constraint = String(original?.constraint ?? anyError?.constraint ?? '');
  if (!constraint) return false;
  return columns.every((column) => constraint.includes(column));
}

function isTicketNoConflict(error: unknown): boolean {
  return isUniqueViolationOn(error, ['ticket_no']);
}

/** 供 action 层把状态机判定前移到 DTO 校验用（不改数据，纯查询） */
export function describeTransition(from: string, to: string): { allowed: boolean; reason?: string } {
  if (from === to) return { allowed: true, reason: '同状态内的字段变更' };
  if (canTransition(from as any, to as any)) return { allowed: true };
  return { allowed: false, reason: `状态机不允许 ${from} → ${to}（见 docs/STATE-MACHINE.md §3）` };
}
