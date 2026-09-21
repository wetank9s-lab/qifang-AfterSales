/**
 * 匿名客户接口 —— 提交报修/投诉（docs/API.md §1.2，Phase 3 的 B~G 五步）
 *
 * 路径（对外）：`POST /api/public/tickets`
 * 应用实现路径：`POST /api/publicTicket:create`
 *   （nginx 把对外路径重写过来，同 DEV-18：NocoBase 的 URL 形态是
 *    `/api/<resource>:<action>`，`/api/public/tickets` 会被解析成
 *    resource=`public` / index=`tickets`，随后 getResource('public') 抛错 → 404）
 *
 * ---------------------------------------------------------------------------
 * 守卫的**执行顺序**（这份顺序是安全属性，不是风格问题）
 * ---------------------------------------------------------------------------
 *   ① X-Request-Id 校验（缺失/非法 → 422）
 *   ② 隐私勾选（未勾选 → **400**）
 *   ③ 字段白名单 + 结构校验（→ 422）
 *   ④ **IP 频控**（消费式，超限 → 429）
 *   ⑤ **request_id 幂等**（命中 → 回放首次响应，200）
 *   ⑥ 手机号日频控（消费式，超限 → 429）
 *   ⑦ 重复单识别（同手机号+同门店+同类型+**同事项文本**；命中 → 409 DUPLICATE_TICKET，带原单号）
 *   ⑧ 建单（取号 + 建单 + 写事件 + 写幂等记录，**同一事务**）→ 201
 *
 * 三处顺序不能动，各有明确理由：
 *
 *  · **④ 必须在 ⑤ 之前**（见 guard-service.ts 文件头第 1 条）。
 *    幂等命中会直接返回、不再往下走；如果把"读幂等"提到频控之前，
 *    同一个 request_id 就能被无限重放而不消耗任何配额 ——
 *    等于给刷单者开了一条免限流的旁路。先把配额扣掉，再看要不要回放。
 *
 *  · **② 在 ③ 之前**。隐私勾选是**准入门槛**：DEV-PLAN Phase 3-G 明文
 *    "未勾选一律 400"。若把它排在字段校验之后，"body 里少了一个字段"
 *    会先返回 422，于是"未勾选"这件事在某些请求形态下永远拿不到 400 ——
 *    验收口径就成了一句需要附加说明的话。门槛就该在门口。
 *
 *  · **⑦ 在 ⑧ 之前**，且**不消耗序号**。重复单是"已经有一张在办了"，
 *    不该再取一个号（否则工单号出现空洞，验收里"序号连续"的口径被污染）。
 *
 * ---------------------------------------------------------------------------
 * 响应体**只回三个字段**：`{ ticket_no, store_name, created_at }`
 * ---------------------------------------------------------------------------
 * 不回 `id`（内部主键，匿名接口暴露等于给出可枚举实体）、不回处理人、
 * 不回门店 id/电话。这三个字段全部在服务层建单后**直接取**，
 * 不经过"取整行再删字段"——那样敏感值会先进内存，迟早被某条日志打出来。
 *
 * 幂等回放时优先用首次写入的 `response_json`，**不重新构造**：
 * 重放必须与首次逐字节一致（前端据此认为"还是那一单"），
 * 若两边各拼一次，`created_at` 的格式差异足以让前端判成两次不同的提交。
 *
 * ---------------------------------------------------------------------------
 * 同 request_id 并发：⑤~⑧ 必须**进程内串行**（一次真机验收抓出来的缺陷）
 * ---------------------------------------------------------------------------
 * 现象（Phase 3-H 的验收脚本第一次跑就红了）：
 *   固定同一个 `X-Request-Id` 并发 10 路 → 期望 201×1 + 200×9、序号 +1；
 *   实际 201×1 + 200×4 + **429×5**，且序号从 1 跳到 6（**增量 5**）。
 *
 * 根因：⑤ 只是"读一眼幂等表"，它**不产生任何行**。10 路同时到达时，
 * 每一路读幂等表都读到"没有"（谁都没写进去），于是**10 路全部往下走**：
 *   · ⑥ 手机号日频控各自消费一次 → 额度 5 被瞬间打满，第 6 路起 429；
 *   · 活下来的 5 路各自 `nextTicketNo()` 取号（取号在事务**外**）→ 序号被推进 5；
 *   · 5 路同时 `INSERT` 幂等记录，1 路成功、4 路撞唯一索引回滚 → 4 个号白耗。
 *
 * 为什么这不是"验收脚本太苛刻"：这是**用户自己能触发的真实缺陷**。
 *   前端虽然做了 single-flight（10 次点击 → 1 个请求），但弱网重试、
 *   多标签页、用户手动狂点刷新都会绕过它，产生"同 request_id 的多路并发"。
 *   后果是客户正常提交一次就把自己手机号的日额度烧掉、并让工单号出现空洞。
 *
 * 修法：把 ⑤~⑧ 放进一把**按 `scene:request_id` 的进程内锁**里。
 *   先到者走完整条链；后来者在锁上等到先到者**提交完**，再进 ⑤ 时
 *   幂等表已有该行 → 直接回放 200。于是恰好 1 次手机号消费、1 个号、1 张单。
 *
 * 为什么锁**不含 ④**（IP 频控）：④ 留在锁外是刻意的 ——
 *   重放仍然要消耗 IP 配额。若把 ④ 也放进锁里（或干脆按命中跳过），
 *   同一个 request_id 就能被无限重放且**完全不计数**，
 *   等于给刷单者开一条免限流旁路（guard-service.ts 文件头第 1 条禁止的正是这个）。
 *
 * 边界（必须诚实记录）：这把锁是**单进程**的。当前部署是单容器，
 *   锁覆盖全部真实流量；一旦横向扩容成多实例，跨进程的并发仍由
 *   `idempotency_records(scene, idempotency_key)` 唯一索引兜底 ——
 *   正确性不受影响（不会出现两张单），只是那一路会按 296 行注释的取舍白耗一个号。
 *   真要多实例也零浪费，得把锁换成 PG 会话级咨询锁，那是扩容时的事，不是现在。
 */
import {
  GUARD_SCENE,
  GUARD_SCOPE,
  GUARD_WINDOW,
  IDEMPOTENCY_SCENE,
  PRIVACY_NOTICE_VERSION,
  RATE_LIMIT_SETTING_KEY,
  TICKET_SOURCE_VALUES,
  TICKET_TYPE_VALUES,
} from '../../constants';
import { STORE_CODE_PATTERN } from '../../seeds/stores';
import { RateLimitedError, type Services } from '../../services';
import {
  StateConflictError,
  ValidationError,
  isUniqueViolationOn,
} from '../../services/ticket-service';
import {
  REQUEST_ID_HEADER,
  clientIpOf,
  fail,
  handleError,
  ok,
  readRequestId,
  traceId,
} from '../svc/_http';

export interface PublicTicketDeps {
  services: Services;
  logger: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
    debug?: (m: string) => void;
  };
}

export type ActionHandler = (ctx: any, next: () => Promise<void>) => Promise<void>;

/** 幂等场景：与 `idempotency_records.scene` 的取值一致 */
const SCENE = IDEMPOTENCY_SCENE.PUBLIC_TICKET;
/** 频控场景：与 `api_guards.scene` 的取值一致（与门店下拉**分开计桶**） */
const GUARD_SCENE_TICKET = GUARD_SCENE.PUBLIC_TICKET;

const CONTENT_MIN = 5;
const CONTENT_MAX = 500;
const NAME_MIN = 1;
const NAME_MAX = 32;
const MOBILE_PATTERN = /^1[3-9]\d{9}$/;

/**
 * 枚举白名单的**运行期**查询集合。
 *
 * `TICKET_SOURCE_VALUES` / `TICKET_TYPE_VALUES` 是 `Object.values(...)` 的产物，
 * 类型上收窄成了字面量联合数组（`("qr" | "link" | "staff")[]`）。
 * 在这里校验的是"请求体里来的、完全不可信的字符串"，用字面量联合的数组
 * 去 `.includes(某个 string)` 会被 TS 正确地拒掉（TS2345）。
 * 转成 `Set<string>`：既让类型如实描述"输入是任意字符串"，
 * 又把查找从 O(n) 降成 O(1)。**不要**退化成 `as any[]` 了事 ——
 * 那等于把"这里需要放宽类型"这个事实藏起来。
 */
const SOURCE_SET: ReadonlySet<string> = new Set<string>(TICKET_SOURCE_VALUES);
const TYPE_SET: ReadonlySet<string> = new Set<string>(TICKET_TYPE_VALUES);

/**
 * 入参白名单。**不在这个列表里的键一律丢弃**（docs/API.md §1.2
 * "入参（白名单，其余字段一律忽略）"）。
 *
 * 为什么是"逐字段取值"而不是"整包取来再删"：后者等价于 mass assignment，
 * 现在没风险是因为下游 `TicketService.create` 也只挑字段用；
 * 但一旦有人给 create 加个 `...input` 的透传，白名单就悄悄失效了，
 * 而那种改动在 review 里看起来完全无害。这里显式收敛，缺陷无处可藏。
 */
const ALLOWED_FIELDS = [
  'store_code',
  'source',
  'ticket_type',
  'content',
  'customer_name',
  'customer_mobile',
  'privacy_agreed',
] as const;

interface PublicTicketDto {
  storeCode: string;
  source: string;
  ticketType: string;
  content: string;
  customerName: string;
  customerMobile: string;
}

/** 对外响应体（docs/API.md §1.2）——三个字段，一个都不多 */
interface PublicTicketResponse {
  ticket_no: string;
  store_name: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// 同 request_id 串行锁（进程内）
// ---------------------------------------------------------------------------

/**
 * 每个 `scene:request_id` 上"最后一个入队任务"的尾指针。
 *
 * 存**尾指针**而不是队列数组：队列要在任务结束时精确地把自己摘掉、
 * 还要处理"摘错了把后来者一起清空"的竞态；尾指针天然形成一条链，
 * 谁最后谁负责删 key，不需要额外的引用计数。
 */
const inFlightByRequestId = new Map<string, Promise<void>>();

/**
 * 按 key 串行执行 `task`（**进程内**互斥；跨进程由幂等唯一索引兜底，见文件头）。
 *
 * 三个细节都是必要的：
 *
 *  1) `previous.catch(() => undefined)` —— 等的是"前一个任务**结束**"，
 *     不是"前一个任务成功"。先到者如果是 409/429/500，锁也必须传给后来者，
 *     否则一次失败会把 key 永久锁死（比并发更糟：后面所有重试全部挂住）。
 *
 *  2) 返回值用 `run`（保留原始结果与异常），`tail` 只用于排队。
 *     排队链上挂的是 `run.catch(…)` 的**派生** promise —— 它的拒绝已被吞掉，
 *     因此绝不会产生 unhandledRejection。而调用方 await 的是 `run`，
 *     异常照样原样抛出，交给外层 `handleError` 映射成 409/429/422。
 *
 *  3) 只有"自己仍是最后一个"时才删 key。如果等待期间又来了新任务，
 *     `map.get(key)` 已经不指向自己的 tail，此时删就等于把新任务的链头抹掉 ——
 *     新任务之后的请求会以为自己排在最前，串行失效。
 */
async function withRequestLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = inFlightByRequestId.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  inFlightByRequestId.set(key, tail);
  try {
    return await run;
  } finally {
    if (inFlightByRequestId.get(key) === tail) inFlightByRequestId.delete(key);
  }
}

export function createPublicTicketHandler(deps: PublicTicketDeps): ActionHandler {
  const { services, logger } = deps;

  return async function publicTicketCreate(ctx: any, next: () => Promise<void>): Promise<void> {
    const trace = traceId(ctx);
    ctx.set?.('X-Trace-Id', trace);

    try {
      // ---------------------------------------------------------------- ① 请求 ID
      const requestId = readRequestId(ctx);
      if (!requestId) {
        const raw = ctx?.get?.(REQUEST_ID_HEADER);
        // 422 而不是 400：缺请求头属于**字段校验失败**（与内部写接口同一口径，
        // 见 actions/svc/ticket.ts 的 requireRequestId），保持两套接口的错误码语义一致。
        fail(
          ctx,
          422,
          'VALIDATION_FAILED',
          raw
            ? `${REQUEST_ID_HEADER} 不是合法的 UUID v4`
            : `写接口必须携带 ${REQUEST_ID_HEADER} 请求头（UUID v4），用于幂等与链路追踪`,
          { header: REQUEST_ID_HEADER, received: raw ?? null },
        );
        return;
      }

      const rawValues = bodyOf(ctx);

      // ------------------------------------------------------ ② 隐私勾选（门槛）
      if (rawValues.privacy_agreed !== true) {
        logger.warn?.(
          `[public:ticket] 隐私说明未勾选，拒绝提交（trace=${trace}，received=${JSON.stringify(
            rawValues.privacy_agreed ?? null,
          )}）`,
        );
        fail(ctx, 400, 'PRIVACY_NOT_AGREED', '请先阅读并勾选个人信息处理说明后再提交', {
          field: 'privacy_agreed',
          notice_version: PRIVACY_NOTICE_VERSION,
        });
        return;
      }

      // -------------------------------------------------- ③ 字段白名单 + 结构校验
      const dto = parseDto(rawValues, logger, trace);

      const ip = clientIpOf(ctx);

      // ------------------------------------------------------------ ④ IP 频控
      const ipLimit = await services.config.getInt(RATE_LIMIT_SETTING_KEY.IP_MINUTE_LIMIT);
      const ipDecision = await services.guards.consume({
        scene: GUARD_SCENE_TICKET,
        scope: GUARD_SCOPE.IP,
        value: ip,
        limit: ipLimit,
        window: GUARD_WINDOW.MINUTE,
      });
      if (!ipDecision.allowed) {
        ctx.set?.('Retry-After', String(ipDecision.windowResetsInSeconds));
        throw new RateLimitedError('提交过于频繁，请稍后再试', {
          scene: ipDecision.scene,
          scope: ipDecision.scope,
          limit: ipDecision.limit,
          used: ipDecision.used,
          window_resets_in_seconds: ipDecision.windowResetsInSeconds,
        });
      }

      // ================================================= ⑤~⑧ 同 request_id 串行段
      //
      // 锁的 key 带 scene 前缀：request_id 是客户端自己造的 UUID，
      // 不加前缀会让互不相关的场景（理论上）互相阻塞。
      //
      // 这一段整体交给 `guardChain`，本函数只负责"锁住 + 按结果回响应"。
      // 把守卫链抽出去还有一个副作用是好的：**顺序**（⑤→⑥→⑦→⑧）
      // 从此只出现在一个地方，读文件头那张顺序表就能对上代码。
      const outcome = await withRequestLock(`${SCENE}:${requestId}`, () =>
        guardChain({ ctx, services, logger, trace, requestId, dto }),
      );

      if (outcome.status === 201) {
        logger.info?.(
          `[public:ticket] 已建单 ${outcome.payload.ticket_no}` +
            `（门店 ${dto.storeCode}，类型 ${dto.ticketType}，trace=${trace}）`,
        );
      }

      ok(ctx, outcome.payload, outcome.status);
    } catch (error) {
      handleError(ctx, error, logger, trace, 'publicTicket:create');
    }

    await next();
  };
}

// ---------------------------------------------------------------------------
// ⑤~⑧ 守卫链（**必须在 request_id 锁内**调用，见文件头）
// ---------------------------------------------------------------------------

/** 守卫链的结果：`status` 就是最终要回的 HTTP 码（200 回放 / 201 新建） */
interface GuardChainOutcome {
  status: 200 | 201;
  payload: PublicTicketResponse;
}

/**
 * 幂等 → 手机号频控 → 重复单 → 建单。
 *
 * ⚠️ 调用方**必须**已持有 `scene:request_id` 的锁。裸调会在并发下退化成
 *    文件头描述的那个缺陷（额度被打满 + 序号出现空洞）。
 *    这里不加运行时断言 —— 加锁是 action 层与守卫链之间的契约，
 *    用注释讲清楚，比在热路径塞一个 `if` 更合适。
 *
 * 参数用**显式字段**而不是整个 `ctx`：这个函数不该能碰 ctx 上的任意东西。
 * `ctx` 只在两处需要（回放时重建响应要读库、限流要写 `Retry-After`）。
 */
async function guardChain(args: {
  ctx: any;
  services: Services;
  logger: PublicTicketDeps['logger'];
  trace: string;
  requestId: string;
  dto: PublicTicketDto;
}): Promise<GuardChainOutcome> {
  const { ctx, services, logger, trace, requestId, dto } = args;

  // ---------------------------------------------- ⑤ request_id 幂等（命中即回放）
  const existing = await services.guards.findIdempotency(SCENE, requestId);
  if (existing) {
    logger.debug?.(
      `[public:ticket] 幂等命中，回放首次响应（request_id=${requestId}，trace=${trace}）`,
    );
    return { status: 200, payload: await rebuildResponse(ctx, services, existing) };
  }

  // ----------------------------------------------------------- ⑥ 手机号日频控
  const phoneLimit = await services.config.getInt(RATE_LIMIT_SETTING_KEY.PHONE_DAILY_LIMIT);
  const phoneDecision = await services.guards.consume({
    scene: GUARD_SCENE_TICKET,
    scope: GUARD_SCOPE.MOBILE,
    value: dto.customerMobile,
    limit: phoneLimit,
    window: GUARD_WINDOW.DAY,
  });
  if (!phoneDecision.allowed) {
    ctx.set?.('Retry-After', String(phoneDecision.windowResetsInSeconds));
    throw new RateLimitedError('该手机号今日提交次数已达上限，请明日再试或直接联系门店', {
      scene: phoneDecision.scene,
      scope: phoneDecision.scope,
      limit: phoneDecision.limit,
      used: phoneDecision.used,
      window_resets_in_seconds: phoneDecision.windowResetsInSeconds,
    });
  }

  // --------------------------------------------------------------- ⑦ 重复单识别
  const duplicateWindow = await services.config.getInt(
    RATE_LIMIT_SETTING_KEY.DUPLICATE_WINDOW_MINUTES,
  );
  const store = await findActiveStore(ctx, dto.storeCode);
  const duplicate = await services.guards.findDuplicateTicket({
    mobile: dto.customerMobile,
    storeId: store.id,
    ticketType: dto.ticketType,
    // Phase 3.1：判重必须带上"事项文本"。缺了这一维，同店同 ticket_type 的
    // 不同家电报修（"空调不制冷" / "冰箱漏水"）会被互相判成重复单，
    // 客户第二件事根本提交不上 —— 这是合法场景被错误拦截，不是防刷生效。
    content: dto.content,
    windowMinutes: duplicateWindow,
  });
  if (duplicate) {
    logger.warn?.(
      `[public:ticket] 命中重复单 ${duplicate.ticket_no}（同手机号+同门店+同类型+同事项文本，` +
        `窗口 ${duplicateWindow} 分钟，trace=${trace}）`,
    );
    throw new StateConflictError(
      `您在 ${duplicateWindow} 分钟内已提交过相同内容的服务请求（单号 ${duplicate.ticket_no}），请勿重复提交`,
      'DUPLICATE_TICKET',
      { ticket_no: duplicate.ticket_no, created_at: toIso(duplicate.created_at) },
    );
  }

  // -------------------------------------------------------------------- ⑧ 建单
  const responseOf = buildResponse;
  try {
    const created = await services.tickets.create({
      storeId: store.id,
      storeCode: store.code,
      ticketType: dto.ticketType,
      content: dto.content,
      customerName: dto.customerName,
      customerMobile: dto.customerMobile,
      source: dto.source,
      // 匿名提交：没有登录用户。事件的操作者身份是 customer（见 EventService）。
      operatorUserId: null,
      // 隐私同意的**证据**（版本 + 时间点）。口径：只记同意过的版本，
      // 不记 IP / UA —— 记 IP 会打破"最小必要"，且它对售后履约没有用途。
      privacy: {
        agreed: true,
        version: PRIVACY_NOTICE_VERSION,
        agreed_at: new Date().toISOString(),
      },
      metadata: { request_id: requestId },
      idempotency: {
        scene: SCENE,
        key: requestId,
        responseOf,
      },
    });

    return { status: 201, payload: responseOf({ ticket: created.ticket, store: created.store }) };
  } catch (error) {
    // 走到这里说明"同 request_id 的并发"**越过了进程内锁** ——
    // 只可能是多实例部署（锁是单进程的，见文件头"边界"）。
    //
    // 兜底逻辑仍然必须留着：两个实例同时到达、彼此都还没写幂等记录，
    // 后到的那个会在 `idempotency_records(scene, idempotency_key)` 唯一索引上撞 23505，
    // 整个建单事务回滚（**不留半张单**，这正是"幂等记录与建单同事务"的价值）。
    //
    // 此时先到者**一定已经提交**：PostgreSQL 里 INSERT 遇到未提交的同键行会**阻塞**，
    // 直到对方 COMMIT/ROLLBACK 之后才报冲突 —— 所以看到 23505 就等价于"对方已落库"，
    // 可以安全地重读幂等记录并按其响应回放。
    //
    // 代价：这一次重试会白耗一个工单号（序号被推进但不产出工单）。
    // 这是"宁可号有洞，也不给客户两张单"的取舍 —— 号码空洞只影响观感，
    // 重复单会让门店真的跑两趟。
    if (isUniqueViolationOn(error, ['scene', 'idempotency_key'])) {
      const raced = await services.guards.findIdempotency(SCENE, requestId);
      if (raced) {
        logger.warn?.(
          `[public:ticket] 同 request_id 并发提交越过了进程内锁（多实例部署？），` +
            `已按先到者回放（request_id=${requestId}，trace=${trace}）`,
        );
        return { status: 200, payload: await rebuildResponse(ctx, services, raced) };
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/**
 * 取请求体。
 *
 * NocoBase 的 resourcer 中间件把 body 放在 `ctx.action.params.values`
 * （见 @nocobase/resourcer/lib/resourcer.js 的 `mergeParams({ ..., values: ctx.request.body })`），
 * 与内部 svc action 同一口径。
 * 非对象形态（表单编码、被中间件包装过）一律当空对象处理 —— 交给下面的字段校验报 422，
 * 而不是在这里抛 `Cannot read property of undefined` 变成 500。
 */
function bodyOf(ctx: any): Record<string, unknown> {
  const values = ctx?.action?.params?.values;
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    return values as Record<string, unknown>;
  }
  return {};
}

/**
 * 白名单取值 + 校验。
 *
 * 校验顺序与 docs/API.md §1.2 的列举顺序一致（store → source → type → content → name → mobile），
 * 目的是让"同一个错误请求永远得到同一条提示"——顺序随意变动会让冒烟断言变得不稳定。
 */
function parseDto(
  raw: Record<string, unknown>,
  logger: PublicTicketDeps['logger'],
  trace: string,
): PublicTicketDto {
  const ignored = Object.keys(raw).filter((key) => !ALLOWED_FIELDS.includes(key as any));
  if (ignored.length > 0) {
    // 不报错（文档要求"其余字段一律忽略"），但必须留痕：
    // 前端多传字段往往意味着 H5 与接口文档已经不同步，值得在日志里看见。
    logger.debug?.(`[public:ticket] 忽略白名单外字段：${ignored.join(', ')}（trace=${trace}）`);
  }

  const storeCode = String(raw.store_code ?? '').trim();
  if (!storeCode) {
    throw new ValidationError('MISSING_STORE_CODE', '必须提供 store_code', 422);
  }
  if (!STORE_CODE_PATTERN.test(storeCode)) {
    // 格式不对就**不要**去查库：门店编码是可枚举的，允许任意字符串查询
    // 等于把"哪些编码存在"变成一个可暴力探测的接口。
    throw new ValidationError(
      'INVALID_STORE_CODE',
      `store_code 格式不正确（应形如 S01），实际 "${storeCode}"`,
      422,
    );
  }

  const source = String(raw.source ?? 'qr').trim() || 'qr';
  if (!SOURCE_SET.has(source)) {
    throw new ValidationError(
      'INVALID_SOURCE',
      `source 必须是 ${TICKET_SOURCE_VALUES.join(' / ')} 之一，实际 "${source}"`,
      422,
    );
  }

  const ticketType = String(raw.ticket_type ?? '').trim();
  if (!TYPE_SET.has(ticketType)) {
    throw new ValidationError(
      'INVALID_TICKET_TYPE',
      `ticket_type 必须是 ${TICKET_TYPE_VALUES.join(' / ')} 之一，实际 "${ticketType}"`,
      422,
    );
  }

  const content = String(raw.content ?? '').trim();
  if (content.length < CONTENT_MIN || content.length > CONTENT_MAX) {
    throw new ValidationError(
      'INVALID_CONTENT',
      `报修内容需 ${CONTENT_MIN}–${CONTENT_MAX} 字（去首尾空白后），当前 ${content.length} 字`,
      422,
    );
  }

  // 姓名：公开接口**必填**。
  // 与 serviceTickets.customer_name（allowNull: true）不一致是有意的 ——
  // 表允许空是为了"门店代提时只知道电话"这类内部来源；
  // 客户自己在 H5 上提交时，姓名是上门沟通的必要信息，不该允许空缺。
  const customerName = String(raw.customer_name ?? '').trim();
  if (customerName.length < NAME_MIN || customerName.length > NAME_MAX) {
    throw new ValidationError(
      'INVALID_CUSTOMER_NAME',
      `姓名需 ${NAME_MIN}–${NAME_MAX} 字，当前 ${customerName.length} 字`,
      422,
    );
  }

  const customerMobile = String(raw.customer_mobile ?? '').trim();
  if (!MOBILE_PATTERN.test(customerMobile)) {
    // ⚠️ 错误信息里**不回显**手机号：它是敏感个人信息，而错误响应会进浏览器控制台与
    //    各种前端日志采集。只回长度，足够排查"少打了一位/带了空格"。
    throw new ValidationError(
      'INVALID_MOBILE',
      `手机号格式不正确（应为 11 位中国大陆号码，当前长度 ${customerMobile.length}）`,
      422,
    );
  }

  return { storeCode, source, ticketType, content, customerName, customerMobile };
}

// ---------------------------------------------------------------------------
// 响应构造
// ---------------------------------------------------------------------------

/**
 * 由建单结果产出对外响应（同时作为幂等记录的 `response_json`）。
 *
 * 抽成**同一个函数**是关键：幂等回放要求"两次响应逐字节一致"，
 * 只要有一处各拼一次，字段名或时间格式的分叉就足以让前端把重放当成新提交。
 */
function buildResponse(input: { ticket: any; store: { name: string } }): PublicTicketResponse {
  return {
    ticket_no: String(input.ticket.ticket_no),
    store_name: String(input.store.name),
    created_at: toIso(input.ticket.createdAt ?? input.ticket.created_at),
  };
}

/**
 * 幂等回放：优先返回首次写入的 `response_json`；
 * 拿不到（中间态/历史数据）时据 `resource_id` **重建**。
 *
 * 为什么不让"响应体缺失"变成 500：工单已经建出来了，客户需要的是它的单号。
 * 回一个 500 会让他以为没提交成功，于是再提交一次 —— 反而制造重复单。
 */
async function rebuildResponse(
  ctx: any,
  services: Services,
  record: { resourceId: number; response: unknown },
): Promise<PublicTicketResponse> {
  const cached = record.response;
  if (cached && typeof cached === 'object' && (cached as PublicTicketResponse).ticket_no) {
    return cached as PublicTicketResponse;
  }

  const ticket = await (ctx.app as any).db
    .getRepository('serviceTickets')
    .findOne({ filter: { id: record.resourceId } });

  if (!ticket) {
    // 幂等记录指向一张不存在的工单：数据不一致（人工删过库？）。
    // 这是**服务端问题**，回 500 并留下 error 日志，不要伪装成"查无此单"。
    throw new Error(
      `[public:ticket] 幂等记录指向的工单不存在（resource_id=${record.resourceId}），无法重建响应`,
    );
  }

  const store = await (ctx.app as any).db
    .getRepository('stores')
    .findOne({ filter: { id: ticket.store_id } });

  return {
    ticket_no: String(ticket.ticket_no),
    store_name: store ? String(store.name) : '',
    created_at: toIso(ticket.createdAt ?? ticket.created_at),
  };
}

// ---------------------------------------------------------------------------
// 门店解析
// ---------------------------------------------------------------------------

/**
 * 按 code 取启用中的门店。
 *
 * ⚠️ 与 `TicketService.resolveStore` 的分工：
 *    这里查一次是**为了拿 store_id 做重复单判定**（需要 id，而客户只给了 code）；
 *    服务层建单时会再查一次并做 active 校验。两次查询之间门店可能被停用 ——
 *    那时服务层会抛 STORE_INACTIVE（422），是正确结果，不需要在这里加锁。
 */
async function findActiveStore(ctx: any, storeCode: string): Promise<any> {
  const store = await (ctx.app as any).db
    .getRepository('stores')
    .findOne({ filter: { code: storeCode } });

  if (!store) {
    // 门店编码不存在 ≠ 秘密：编码本身印在门店二维码上。
    // 返回 422（请求参数错误）而不是 404，避免与"接口不存在"混为一谈。
    throw new ValidationError('STORE_NOT_FOUND', `门店编码 ${storeCode} 不存在`, 422);
  }
  if (store.active !== true) {
    throw new ValidationError('STORE_INACTIVE', `门店「${store.name}」已停用，暂不能报修`, 422);
  }
  return store;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 任意时间值 → ISO 字符串（回放与首次响应用的是同一个函数，保证格式一致） */
function toIso(value: unknown): string {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}
