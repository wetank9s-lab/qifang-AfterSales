/**
 * 匿名客户接口 —— 客户评价（Phase 7 / 契约 §4 + §10）
 *
 * 路径（对外）：`GET  /api/public/reviews/:token`
 *              `POST /api/public/reviews/:token`
 * 应用实现路径：`GET  /api/publicReview:get`
 *              `POST /api/publicReview:submit`
 *   （nginx 把对外路径重写过来，同 DEV-18：NocoBase 的 URL 形态是
 *    `/api/<resource>:<action>`，`/api/public/reviews/xxx` 会被解析成
 *    resource=`public` / index=`reviews`，随后 getResource('public') 抛错 → 404）
 *
 * ---------------------------------------------------------------------------
 * 为什么 GET 与 POST 的**响应码刻意不对称**（这是本文件最重要的设计决定）
 * ---------------------------------------------------------------------------
 *   状态            GET                              POST
 *   ─────────────── ──────────────────────────────── ───────────────────────────
 *   形状非法        404 REVIEW_NOT_FOUND             404 REVIEW_NOT_FOUND
 *   hash 查不到     404 REVIEW_NOT_FOUND             404 REVIEW_NOT_FOUND
 *   已提交          200 + can_review=false           409 REVIEW_ALREADY_SUBMITTED
 *   已过期          200 + can_review=false           410 REVIEW_EXPIRED
 *   正常            200 最小上下文                   见 §1.2
 *
 *   GET 的职责是**让页面把话说清楚**（"您已评价过 / 评价已关闭"）——
 *   把它做成 4xx 会让 H5 把"正常业务终态"走成异常分支，于是客户看到
 *   "加载失败，请重试"，重试一百次也还是同一个结果。
 *   POST 的职责是**拒绝一次真实写入**，必须是稳定、可断言的业务错误码。
 *   ⇒ 这是**刻意的不对称**，不是不一致。门禁 A 会同时钉住这两列。
 *
 * ---------------------------------------------------------------------------
 * Token 从**路径**取，不从 query 取
 * ---------------------------------------------------------------------------
 *   与师傅接口（token 在 query）**不同**，理由不是风格：
 *   `/f/{token}` 的 nginx 段做了 `access_log off`，token 只出现在 path 上
 *   才受这条保护。若允许 query 形态 `?token=...`，它就绕过了那条规则、
 *   直接落进 access log 与各种中间层的日志。
 *   因此这里**只读 path 参数**，读不到就 404 —— 不接受 query 兜底。
 *
 * ---------------------------------------------------------------------------
 * 明文 Token 的生命周期
 * ---------------------------------------------------------------------------
 *   进本函数 → `tokens.hashOf(明文)` → 查库 → **明文出作用域即消亡**。
 *   它**不**进：TicketEvent、幂等记录、SmsLog、应用日志（任何级别）。
 *   日志里只出现 `fingerprint()`（sha256 前 8 位），够串排障、不足以还原凭证。
 */
import {
  GUARD_SCENE,
  GUARD_SCOPE,
  GUARD_WINDOW,
  PUBLIC_ACTION,
  PUBLIC_RESOURCE,
  RATE_LIMIT_SETTING_KEY,
  REVIEW_ERROR,
  REVIEW_STATUS,
} from '../../constants';
import { RateLimitedError, type Services } from '../../services';
import { runReviewExpirySweep } from '../../services/review-expiry-scheduler';
import { clientIpOf, fail, handleError, ok, traceId } from '../svc/_http';

export interface PublicReviewDeps {
  services: Services;
  logger: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
    debug?: (m: string) => void;
  };
}

export type ActionHandler = (ctx: any, next: () => Promise<void>) => Promise<void>;

/**
 * POST body 的**白名单**（§10）。
 *
 * ⚠️ 与 `public/ticket.ts`（"其余字段一律忽略"）**口径相反**：这里是**拒绝**多余字段。
 *    理由：评价是一个**一次性、不可撤回**的动作（Token 用掉就没了）。
 *    "忽略"意味着 H5 以为提交了 `rating=5`，而实际因字段名写错（`score`）
 *    导致 `rating` 缺失 → 422；更糟的是**多传一个 `ticket_id` 想改别人的单**时，
 *    忽略它会让客户端以为"我指定成功了"。拒绝能把"客户端与契约不同步"立刻暴露出来。
 */
const ALLOWED_POST_FIELDS = ['rating', 'comment', 'charge_match', 'customer_reported_amount'] as const;

/** 取请求体（与 `public/ticket.ts` 同口径：NocoBase resourcer 把 body 放在 values） */
function bodyOf(ctx: any): Record<string, unknown> {
  const values = ctx?.action?.params?.values;
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    return values as Record<string, unknown>;
  }
  return {};
}

/**
 * 取路径里的 token（**唯一**来源）。
 *
 * 依次尝试 NocoBase resourcer 可能放置 path 参数的位置：
 *   · `ctx.action.params.filterByTk` —— `define({ type: 'single' })` + 自定义 action 的常见落点
 *   · `ctx.action.params.token` / `ctx.params.token` —— 显式命名参数
 *   · URL path 的最后一段 —— 兜底（nignx 重写后是 `/api/publicReview:get/<token>`）
 *
 * ⚠️ **刻意不读 query**（理由见文件头）。上面的兜底解析 path 时也会
 *    先剥掉 query string，确保 `?token=x` 不会被当成 path 里的一段。
 */
function tokenOf(ctx: any): string {
  const params = ctx?.action?.params;
  const candidates = [params?.filterByTk, params?.token, ctx?.params?.token];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  const raw = String(ctx?.request?.path ?? ctx?.path ?? ctx?.originalUrl ?? '')
    .split('?')[0]
    .replace(/\/+$/, '');
  const last = raw.split('/').pop() ?? '';
  return last.includes(':') ? '' : last;
}

/** 形状非法与查不到一律给**同一个** 404（不暴露"资源是否存在"的额外信息） */
function rejectNotFound(ctx: any): void {
  fail(ctx, 404, REVIEW_ERROR.NOT_FOUND, '评价链接无效或已失效');
}

// ---------------------------------------------------------------------------
// GET —— 打开评价页
// ---------------------------------------------------------------------------

export function createPublicReviewGetHandler(deps: PublicReviewDeps): ActionHandler {
  const { services, logger } = deps;

  return async function publicReviewGet(ctx: any, next: () => Promise<void>): Promise<void> {
    const trace = traceId(ctx);
    ctx.set?.('X-Trace-Id', trace);

    try {
      // ---------------- ① IP 频控（read 桶；与提交/报修分开计桶） ----------------
      await consumeIp(ctx, services, GUARD_SCENE.REVIEW_VIEW, '打开评价页过于频繁，请稍后再试');

      // ---------------- ② Token 形状 + 查库 ----------------
      const token = tokenOf(ctx);
      const lookup = await services.tickets.reviewContextOf(token);

      if (lookup.kind === 'not_found') {
        // ⚠️ 只记 fingerprint，**绝不记明文**（见文件头）
        logger.debug?.(
          `[public:review:get] REVIEW_NOT_FOUND（ip=${clientIpOf(ctx)}，trace=${trace}）`,
        );
        rejectNotFound(ctx);
        return;
      }

      // ---------------- ③ 最小上下文（DTO 由服务层构造，见 reviewContextOf） ----------------
      // ⚠️ 已提交 / 已过期**仍然是 200**，只是 `can_review=false`
      //    —— 让页面能把"您已评价过 / 评价已关闭"渲染成人话（见文件头）。
      logger.debug?.(
        `[public:review:get] 返回评价上下文 state=${lookup.state}（trace=${trace}）`,
      );
      ok(ctx, lookup.context);
    } catch (error) {
      handleError(ctx, error, logger, trace, 'publicReview:get');
    }

    await next();
  };
}

// ---------------------------------------------------------------------------
// POST —— 提交评价
// ---------------------------------------------------------------------------

export function createPublicReviewSubmitHandler(deps: PublicReviewDeps): ActionHandler {
  const { services, logger } = deps;

  return async function publicReviewSubmit(ctx: any, next: () => Promise<void>): Promise<void> {
    const trace = traceId(ctx);
    ctx.set?.('X-Trace-Id', trace);

    try {
      // ---------------- ① IP 频控（write 桶） ----------------
      await consumeIp(ctx, services, GUARD_SCENE.REVIEW_SUBMIT, '提交过于频繁，请稍后再试');

      // ---------------- ② Token 形状 + 查库（**先判 not_found 再判状态**） ----------------
      const token = tokenOf(ctx);
      const lookup = await services.tickets.reviewContextOf(token);
      if (lookup.kind === 'not_found') {
        rejectNotFound(ctx);
        return;
      }

      // ---------------- ③ 终态前置检查（把 409/410 说清楚；真正的判定仍在领域层） ----------------
      // ⚠️ 这里的检查是**为了给出稳定的业务错误码**，不是为了决定谁赢 ——
      //    谁赢由 `submitReview()` 里那条条件 UPDATE 决定（§1.1）。
      //    因此这里读到"pending"也**不保证**下面一定成功（可能刚好被人抢先），
      //    那条路径由领域层抛 409/410（§1.4），两处话术一致。
      if (lookup.state === REVIEW_STATUS.EXPIRED) {
        fail(ctx, 410, REVIEW_ERROR.EXPIRED, '评价窗口已关闭，无法再提交评价', {
          review_state: lookup.state,
        });
        return;
      }
      if (lookup.state === REVIEW_STATUS.SUBMITTED) {
        fail(ctx, 409, REVIEW_ERROR.ALREADY_SUBMITTED, '该评价已提交，请勿重复提交', {
          review_state: lookup.state,
        });
        return;
      }

      // ---------------- ④ body 白名单（**拒绝**多余字段，不做忽略） ----------------
      const raw = bodyOf(ctx);
      const unexpected = Object.keys(raw).filter(
        (key) => !ALLOWED_POST_FIELDS.includes(key as any),
      );
      if (unexpected.length > 0) {
        fail(
          ctx,
          422,
          REVIEW_ERROR.UNEXPECTED_FIELD,
          `请求包含未知字段：${unexpected.join(', ')}`,
          { unexpected },
        );
        return;
      }

      // ---------------- ⑤ 领域层提交（唯一状态推进点） ----------------
      const outcome = await services.tickets.submitReview({
        // ticketId 由 Token 解出（**不由客户端提供**）—— 匿名端无法指定别人的单
        ticketId: lookup.ticketId,
        rating: Number(raw.rating),
        comment: raw.comment === undefined ? null : (raw.comment as any),
        charge_match: String(raw.charge_match ?? ''),
        // ⚠️⚠️ **金额必须保持"未提供"与"显式 null"等价**，不能一律 `Number()`。
        //   首跑真实缺陷（Phase 7 DEV-89）：这里原先写
        //     `raw.customer_reported_amount === undefined ? null : Number(raw.customer_reported_amount)`
        //   而 H5 在"未收费 / 金额一致"时**显式发 `customer_reported_amount: null`**。
        //   JSON `null` ≠ `undefined`，于是走进 `Number(null)` → **0**，
        //   归一化层再看到 `0 !== null`，判定"你带了金额" → 422 AMOUNT_NOT_ALLOWED。
        //   即：合法提交被自己的 DTO 层拒掉，且 `match` / `not_applicable` 两条正常路径全挂
        //   （只有 `mismatch` 因为本来就要带数字才活着）。
        //   修法：`null` 与 `undefined` 同义（都表示"没填金额"）；
        //   其余交 `Number()`，非数字由领域层报 INVALID_CUSTOMER_AMOUNT。
        //   **不要**改成"前端别发 null" —— 服务端必须自己对 `null` 稳健（匿名直连 API 同样成立）。
        customer_reported_amount:
          raw.customer_reported_amount === undefined || raw.customer_reported_amount === null
            ? null
            : Number(raw.customer_reported_amount),
      });

      logger.info?.(
        `[public:review:submit] 工单 ${outcome.ticket?.ticket_no ?? lookup.ticketId} 评价完成` +
          `（${outcome.reopened ? '重开' : '闭环'}，trace=${trace}）`,
      );

      // 只回"客户需要看到的结果"，不回工单内部字段
      ok(ctx, {
        ticket_no: String(outcome.ticket?.ticket_no ?? ''),
        rating: Number(outcome.ticket?.rating ?? 0),
        closed: !outcome.reopened,
        reopened: outcome.reopened,
      });
    } catch (error) {
      handleError(ctx, error, logger, trace, 'publicReview:submit');
    }

    await next();
  };
}

// ---------------------------------------------------------------------------
// 探针：手动触发一轮评价超时扫描（仅 mock 短信通道可达）
// ---------------------------------------------------------------------------

/**
 * `POST /api/public/reviews/_probe/sweep`
 *
 * ---------------------------------------------------------------------------
 * 为什么需要一个**探针**而不是让门禁脚本自己写 SQL 关工单
 * ---------------------------------------------------------------------------
 * 门禁要证明的是"提交与超时竞争时恰好一个 winner"。如果门禁自己写
 * `UPDATE ... SET status='CLOSED'`，那它验证的是**门禁自己那份谓词**，
 * 而不是应用里真正跑的那份 —— 两份谓词只要有一处不同（少写 `feedback_token_used_at IS NULL`），
 * 门禁照样全绿，而线上的 cron 任务照样能覆盖客户的评价。
 *
 * 因此这里**复用 `runReviewExpirySweep`**（cron 任务 onTick 调的就是它），
 * 门禁触发的是**与生产完全同一条代码路径**。
 *
 * ---------------------------------------------------------------------------
 * 自毁闸：与 `svc:tokenCheck` / `svc:smsOutbox` 同一口径
 * ---------------------------------------------------------------------------
 * 非 mock 短信通道 ⇒ **404**（不是 403）：对外表现是"这个接口不存在"，
 * 不给"生产环境里有个能批量关工单的入口"任何信号。
 * ⚠️ 它**不**校验登录角色 —— 因为它是匿名资源组下的路径。安全性因此完全依赖
 *    上面那条自毁闸 + 生产环境 `SMS_CHANNEL` 必为真实通道这一事实。
 *     这个权衡是刻意的（本接口的能力上限是"把已到期的工单关掉"，即幂等 no-op），
 *     并且它**不返回任何客户数据**，只回计数。
 */
export function createPublicReviewSweepProbeHandler(deps: PublicReviewDeps): ActionHandler {
  const { services, logger } = deps;

  return async function publicReviewSweepProbe(
    ctx: any,
    next: () => Promise<void>,
  ): Promise<void> {
    const trace = traceId(ctx);
    ctx.set?.('X-Trace-Id', trace);

    try {
      // ---------------- 自毁闸（非 mock ⇒ 404，与运维探针同口径） ----------------
      if (!(await services.sms.isMockChannel())) {
        fail(ctx, 404, REVIEW_ERROR.NOT_FOUND, '接口不存在');
        return;
      }

      // ---------------- 与 cron 任务**同一条**代码路径 ----------------
      const result = await runReviewExpirySweep({ services, logger });
      logger.info?.(
        `[public:review:sweep] 手动触发一轮：扫 ${result.scanned} / 关 ${result.expired} / ` +
          `跳 ${result.skipped} / 失败 ${result.errors}（trace=${trace}）`,
      );
      ok(ctx, result);
    } catch (error) {
      handleError(ctx, error, logger, trace, 'publicReview:sweep');
    }

    await next();
  };
}

// ---------------------------------------------------------------------------
// 共用：IP 频控
// ---------------------------------------------------------------------------

/**
 * IP 维度限流（**消费式**）。
 *
 * 阈值复用 `security.ip_minute_limit`（不新增配置项，见契约 §12），
 * 但 **scene 独立** ⇒ 与报修/门店下拉/师傅上传**各自计桶**。
 * 共桶的后果是"某人刷评价页把别人的报修额度吃掉"。
 */
async function consumeIp(
  ctx: any,
  services: Services,
  scene: string,
  message: string,
): Promise<void> {
  const limit = await services.config.getInt(RATE_LIMIT_SETTING_KEY.IP_MINUTE_LIMIT);
  const decision = await services.guards.consume({
    scene,
    scope: GUARD_SCOPE.IP,
    value: clientIpOf(ctx),
    limit,
    window: GUARD_WINDOW.MINUTE,
  });

  if (!decision.allowed) {
    ctx.set?.('Retry-After', String(decision.windowResetsInSeconds));
    throw new RateLimitedError(message, {
      scene: decision.scene,
      scope: decision.scope,
      limit: decision.limit,
      used: decision.used,
      window_resets_in_seconds: decision.windowResetsInSeconds,
    });
  }
}
