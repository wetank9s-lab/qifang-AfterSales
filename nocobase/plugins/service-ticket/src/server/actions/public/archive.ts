/**
 * 客户档案查询（ARC-V1 / A4）—— **匿名可达**的独立资源 `publicArchive`
 *
 * 与内部 `svc:archive*` **完全分离**（执行令：客户端照片接口与内部接口严格分离）：
 *   · 资源名不同（`publicArchive` vs `svc`），ACL 也分开；
 *   · 客户接口不读任何登录身份，只认**查询会话 token**；
 *   · 内部接口不接受 token，客户接口不接受 Authorization。
 *
 * 三个"不接受"决定了它的攻击面：
 *   ① 不接受手机号单独查询（必须先核销验证码换 token）；
 *   ② 不接受 archive_id（只接受 archive_no，且必须命中会话的 store+mobile）；
 *   ③ 不接受任意照片路径（只接受 photo id，且重新走可见性判定）。
 */
import crypto from 'node:crypto';

import {
  GUARD_SCENE,
  GUARD_SCOPE,
  PUBLIC_ACTION,
  PUBLIC_RESOURCE,
  RATE_LIMIT_SETTING_KEY,
} from '../../constants';
import { ArchiveError, isArchiveError } from '../../services/archive-service';
import { ArchiveQueryService, normalizeArchiveMobile } from '../../services/archive-query-service';
import { RateLimitedError } from '../../services/guard-service';
import { fail, ok } from '../svc/_http';
import type { ActionHandler } from '../svc/_request';

export interface PublicArchiveDeps {
  db: any;
  logger?: { warn?: (m: string) => void; info?: (m: string) => void };
  /** 当前 profile：'development' 才回显验证码（生产永不回显） */
  profile?: string;
  enqueueSms?: (input: {
    scene: string;
    storeId: number;
    mobile: string;
    params: Record<string, string>;
  }) => Promise<{ sent: boolean; smsLogId?: string | number; reason?: string }>;
  /**
   * 频控与配置读取（ARC-V1 / R0-CHG-01 新增依赖）。
   *
   * ⚠️ 为什么是**注入**而不是在 handler 里 `new GuardService(db)`：
   *    限流桶必须与全站共用同一个 `SIGN_SECRET` 与同一张 `api_guards` 表。
   *    自己 new 一份就等于多一个实例、多一份密钥读取路径 ——
   *    而桶键一旦算错（少了一个 secret），限流会**静默失效**：
   *    每个请求都落进不同的桶，永远数不到 3。
   * 两者都可选（保持向后兼容：既有 5 个 action 不依赖它们）；
   * `queryByMobile` 在缺依赖时按 **fail-closed** 处理（拒绝，不放行）。
   */
  guards?: {
    consumeSliding: (input: {
      scene: string;
      scope: string;
      value: string;
      limit: number;
      windowSeconds: number;
    }) => Promise<{
      allowed: boolean;
      used: number;
      limit: number;
      remaining: number;
      retryAfterSeconds: number;
      guardKey: string;
    }>;
  };
  config?: {
    getInt: (key: string, fallback?: number) => Promise<number>;
  };
}

/** 客户接口的错误映射：**不泄露内部错误详情** */
function failFrom(ctx: any, error: unknown): boolean {
  if (!isArchiveError(error)) return false;
  const e = error as ArchiveError;
  fail(ctx, e.status, e.code, e.message);
  return true;
}

function clientIpHash(ctx: any): string {
  const raw = String(
    ctx?.get?.('x-real-ip') ?? ctx?.request?.ip ?? ctx?.ip ?? '',
  ).trim();
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * 取客户端真实 IP（ARC-V1 / R0-CHG-01）。
 *
 * 验收第 7 项明确要求"**伪造来源 IP 不能轻易绕过规定的服务端限流**"，
 * 因此 IP 口径只能有一个答案，且必须是**不可被客户端伪造**的那个：
 *
 *   ① `X-Real-IP` —— nginx 用 `proxy_set_header X-Real-IP $remote_addr` 写入。
 *      客户端自带的同名头会被 nginx **覆盖**（见 nginx/conf.d/proxy-headers.inc），
 *      所以这是唯一可信的来源。
 *   ② `X-Forwarded-For` **首段** —— 仅兜底（直连调试、单元测试桩）。
 *      ⚠️ 它**可被伪造**。这里刻意只取第一段，且**只在没有 X-Real-IP 时**才用：
 *      拿它当首选就等于把限流交给客户端决定。
 *   ③ socket 远端地址 —— 容器内直连（health、本地脚本）。
 *   ④ `'unknown'` 固定串 —— 全取不到时让所有请求**聚进同一个桶**（fail-closed），
 *      比"每个请求各自一个新桶"（等价于不限流）安全得多。
 *
 * ⚠️ 口径与 `_http.ts` 的 `clientIpOf()` **逐字一致**，只是那里是给 svc 用的。
 *    这里不 import 它，是因为 public 组此前刻意保持"只依赖 _http 的 ok/fail"；
 *    但两处的**取值优先级必须相同** —— 否则"同一个客户端在两组接口上算两个桶"，
 *    表现是限流可以在接口之间互相绕过，且只在真机存在反代时复现。
 */
function clientIpOfPublic(ctx: any): string {
  const real = ctx?.get?.('x-real-ip') ?? ctx?.request?.headers?.['x-real-ip'];
  if (real && String(real).trim()) return String(real).trim();

  const forwarded = ctx?.get?.('x-forwarded-for') ?? ctx?.request?.headers?.['x-forwarded-for'];
  if (forwarded) {
    const first = String(forwarded).split(',')[0].trim();
    if (first) return first;
  }

  const socket = ctx?.req?.socket?.remoteAddress ?? ctx?.socket?.remoteAddress;
  return socket ? String(socket) : 'unknown';
}

/** token 只从请求头读，避免进 URL / 日志 / Referer */
function tokenOf(ctx: any): string {
  const h = ctx?.get?.('x-archive-session') ?? ctx?.request?.headers?.['x-archive-session'] ?? '';
  return String(h ?? '').trim();
}

function bodyParam(ctx: any, key: string): unknown {
  return ctx?.request?.body?.[key] ?? ctx?.action?.params?.values?.[key] ?? ctx?.action?.params?.[key];
}

export function createPublicArchiveHandlers(deps: PublicArchiveDeps): Record<string, ActionHandler> {
  const service = new ArchiveQueryService({
    db: deps.db,
    logger: deps.logger,
    enqueueSms: deps.enqueueSms,
  });
  const isDev = (deps.profile ?? '').toLowerCase() === 'development';

  const sendCode: ActionHandler = async (ctx: any) => {
    try {
      const result = await service.sendCode({
        storeCode: String(bodyParam(ctx, 'store_code') ?? ''),
        mobile: String(bodyParam(ctx, 'mobile') ?? ''),
        ipHash: clientIpHash(ctx),
      });
      // 开发环境把"模拟发送"的码回出来，方便验收；生产**永不回显**
      // （生产连发都不发 —— 模板未审核，闸门在 SmsService 里）
      ok(ctx, {
        sent: result.sent,
        expires_in_seconds: result.expiresInSeconds,
        resend_after_seconds: result.resendAfterSeconds,
        ...(isDev ? { dev_hint: '验证码已按 mock 通道"发送"，请向管理员索取本轮验证码' } : {}),
      });
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  };

  const verifyCode: ActionHandler = async (ctx: any) => {
    try {
      const result = await service.verifyCode({
        storeCode: String(bodyParam(ctx, 'store_code') ?? ''),
        mobile: String(bodyParam(ctx, 'mobile') ?? ''),
        code: String(bodyParam(ctx, 'code') ?? ''),
        ipHash: clientIpHash(ctx),
      });
      // token 只在这里出现一次；客户端必须存内存/会话存储，不要进 URL
      ok(ctx, { token: result.token, expires_in_seconds: result.expiresInSeconds });
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  };

  const listArchives: ActionHandler = async (ctx: any) => {
    try {
      const rows = await service.listVisibleArchives(tokenOf(ctx));
      ok(ctx, { archives: rows });
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  };

  const archiveDetail: ActionHandler = async (ctx: any) => {
    try {
      const data = await service.detail(tokenOf(ctx), String(bodyParam(ctx, 'archive_no') ?? ''));
      ok(ctx, data);
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  };

  const archivePhoto: ActionHandler = async (ctx: any) => {
    try {
      const file = await service.readPhoto(tokenOf(ctx), Number(bodyParam(ctx, 'photo_id')));
      ctx.set('Content-Type', file.mime);
      ctx.set('Cache-Control', 'private, no-store');
      ctx.body = file.buffer;
    } catch (error) {
      if (!failFrom(ctx, error)) throw error;
    }
  };

  /**
   * ARC-V1 / R0-CHG-01：**手机号直接查询**（匿名，无需验证码）。
   *
   * 与上面五个 action 的关系：**并列，不替代**。原有 `sendCode`/`verify`/
   * `list`/`detail`/`photo` 的权限检查与语义**一个字都没动**（用户明令）。
   *
   * 为什么"不校验手机号持有权"在这里是可接受的：
   *   产品决策是"客户查询改用手机号直查"。我们无法在技术上替代身份核验，
   *   能做的是把**单次查询的信息量**压到最低（门店名/类型/粗略进度），
   *   再用**限流**把"批量枚举"的收益压到极低。两者缺一，这个入口就不该开。
   *
   * ⚠️ **fail-closed 三处**（任何一处不成立都拒绝，绝不"降级成不限制"）：
   *   ① 缺 guards/config 依赖 ⇒ 拒绝（限流无法执行 ⇒ 不能放行）；
   *   ② 任一维度限流判定抛错 ⇒ 拒绝（需求："限流异常时拒绝查询"）；
   *   ③ 限流判定 `allowed=false` ⇒ 429 + Retry-After。
   */
  const queryByMobile: ActionHandler = async (ctx: any) => {
    // 响应绝不能被缓存：同一个 IP/客户端代理缓存了"某手机号的档案摘要"，
    // 下一个人打开就是一次**跨用户的数据泄露**。no-store 是这里唯一正确的值
    // （`no-cache` 还允许存副本，只是要求回源校验 —— 那是给"可能有敏感内容"
    //   用的，这里必须是"根本不存"）。
    ctx.set?.('Cache-Control', 'no-store');
    ctx.set?.('X-Content-Type-Options', 'nosniff');

    const rawMobile = bodyParam(ctx, 'mobile');
    const mobile = normalizeArchiveMobile(rawMobile);
    if (!mobile) {
      fail(ctx, 400, 'ARCHIVE_QUERY_BAD_MOBILE', '手机号格式不正确', { field: 'mobile' });
      return;
    }

    // ---- 限流：依赖缺失 ⇒ fail-closed ----
    const guards = deps.guards;
    const config = deps.config;
    if (!guards || !config) {
      deps.logger?.warn?.(
        '[publicArchive:queryByMobile] 频控/配置依赖未注入，按 fail-closed 拒绝（不允许降级为无限制）',
      );
      fail(ctx, 503, 'ARCHIVE_QUERY_UNAVAILABLE', '服务暂时不可用，请稍后再试');
      return;
    }

    try {
      const windowSeconds = await config.getInt(
        RATE_LIMIT_SETTING_KEY.ARCHIVE_QUERY_WINDOW_SECONDS,
        60,
      );
      const ipLimit = await config.getInt(RATE_LIMIT_SETTING_KEY.ARCHIVE_QUERY_IP_MINUTE_LIMIT, 3);
      const mobileLimit = await config.getInt(
        RATE_LIMIT_SETTING_KEY.ARCHIVE_QUERY_MOBILE_MINUTE_LIMIT,
        3,
      );

      const ip = clientIpOfPublic(ctx);

      // ---- 双维度限流：**两阶段**，IP 先行 ----
      //
      // ⚠️ 顺序不是随意定的，两种写法有实质差别（实测过）：
      //
      //   【写法 A · 先算两侧再判】两次 `consumeSliding` 都执行，再一起判。
      //     后果：一次**被 IP 拒绝**的请求，仍会在"新手机号"那一侧落一行 ——
      //       · 无意义：这次请求根本没发生查询，却给该号留了痕迹；
      //       · 可放大：攻击者用同一 IP + 每次换新号刷，虽然次次被拒，
      //         却能持续往 `api_guards` 写新行。而回收逻辑是按
      //         `(scene, scope, guard_key)` 精确删除**自己那一行**的，
      //         不同手机号是不同的 key ⇒ **这些行没有任何人回收**。
      //
      //   【写法 B · 两阶段（本实现）】IP 判定并消费；IP 通过后才判手机号。
      //     任一拒绝即 429。两个维度**仍然都独立累积**（这是"任意一项超限"
      //     的前提），但被拒的请求不会污染另一维度。
      //
      // 为什么写法 B **不会**削弱"换号不能绕过手机号限流"：
      //   针对同一个受害者号码的持续骚扰，攻击者必须反复提交**同一个号**
      //   ⇒ 该号必然被反复消费，第 4 次必拒，与写法 A 完全一致。
      //   而"同 IP 换新号"的场景里，那些号本来就没有历史（攻击者在枚举），
      //   "不给他们留痕"没有损失。
      const ipDecision = await guards.consumeSliding({
        scene: GUARD_SCENE.ARCHIVE_QUERY,
        scope: GUARD_SCOPE.IP,
        value: ip,
        limit: ipLimit,
        windowSeconds,
      });

      let mobileDecision = null as null | Awaited<ReturnType<typeof guards.consumeSliding>>;
      if (ipDecision.allowed) {
        mobileDecision = await guards.consumeSliding({
          scene: GUARD_SCENE.ARCHIVE_QUERY,
          // ⚠️ scope 用 `mobile`：哈希与「同手机号」语义一致；
          //    guard_key = sha256(手机号 + SIGN_SECRET) ⇒ **不存明文**。
          scope: GUARD_SCOPE.MOBILE,
          value: mobile,
          limit: mobileLimit,
          windowSeconds,
        });
      }

      if (!ipDecision.allowed || !mobileDecision || !mobileDecision.allowed) {
        // Retry-After 取两个维度里"更晚恢复"的那个 —— 取小的会让客户端
        // 在更早的时间点重试并再次被拒，看起来像"限流忽冷忽热"。
        const retryAfter = Math.max(
          ipDecision.allowed ? 0 : ipDecision.retryAfterSeconds,
          mobileDecision && !mobileDecision.allowed ? mobileDecision.retryAfterSeconds : 0,
        );
        ctx.set?.('Retry-After', String(retryAfter > 0 ? retryAfter : windowSeconds));

        deps.logger?.warn?.(
          // ⚠️ **不记完整手机号**（需求明令）。这里只记掩码 + 维度哈希前缀：
          //    哈希前缀足以让运维回答"是不是同一个号在被反复刷"，
          //    而**无法**从日志反查号码（SIGN_SECRET 在进程环境里，不在日志里）。
          `[publicArchive:queryByMobile] 429 超限 scene=${GUARD_SCENE.ARCHIVE_QUERY}` +
            ` ip_used=${ipDecision.used}/${ipDecision.limit}` +
            ` mobile_used=${mobileDecision ? `${mobileDecision.used}/${mobileDecision.limit}` : 'n/a(ip 先行拒绝)'}` +
            ` mobile=${maskMobileForLog(mobile)}` +
            ` mobile_key=${mobileDecision ? mobileDecision.guardKey.slice(0, 12) : '-'}`,
        );

        throw new RateLimitedError('查询过于频繁，请稍后再试', {
          scene: GUARD_SCENE.ARCHIVE_QUERY,
          reason: !ipDecision.allowed
            ? 'ip'
            : (!mobileDecision!.allowed ? 'mobile' : 'unknown'),
          // ⚠️ `limit` 是**次数上限**，不是窗口长度。
          //   此前这里误传 `windowSeconds`（60），于是响应里
          //   `{"limit":60,"retry_after_seconds":59}` 自相矛盾 ——
          //   客户端若按 limit 文案展示"每 60 秒 60 次"，与真实 3 次差 20 倍。
          //   修复：按**被触发的那个维度**给各自的次数上限；
          //   同时补 `window_seconds` 明确窗口长度（两个含义分开，不再混用）。
          limit: !ipDecision.allowed ? ipDecision.limit : mobileDecision!.limit,
          window_seconds: windowSeconds,
          retry_after_seconds: retryAfter > 0 ? retryAfter : windowSeconds,
        });
      }

      const result = await service.queryByMobileSummary(mobile);
      ok(ctx, result);
    } catch (error) {
      if (error instanceof RateLimitedError) {
        // 限流错误必须走 429（RateLimitedError.status 自带），不能被下面的
        // ArchiveError 分支吞掉。failFrom 只认 ArchiveError，所以这里显式分流。
        fail(ctx, 429, error.code, error.message, error.detail);
        return;
      }
      if (!failFrom(ctx, error)) throw error;
    }
  };

  return {
    [`${PUBLIC_RESOURCE.ARCHIVE}:${PUBLIC_ACTION.ARCHIVE_SEND_CODE}`]: sendCode,
    [`${PUBLIC_RESOURCE.ARCHIVE}:${PUBLIC_ACTION.ARCHIVE_VERIFY}`]: verifyCode,
    [`${PUBLIC_RESOURCE.ARCHIVE}:${PUBLIC_ACTION.ARCHIVE_LIST}`]: listArchives,
    [`${PUBLIC_RESOURCE.ARCHIVE}:${PUBLIC_ACTION.ARCHIVE_DETAIL}`]: archiveDetail,
    [`${PUBLIC_RESOURCE.ARCHIVE}:${PUBLIC_ACTION.ARCHIVE_PHOTO}`]: archivePhoto,
    [`${PUBLIC_RESOURCE.ARCHIVE}:${PUBLIC_ACTION.ARCHIVE_QUERY_BY_MOBILE}`]: queryByMobile,
  };
}

/**
 * 日志用的手机号掩码。
 *
 * ⚠️ 需求原文："日志不得记录完整手机号。"
 *    这里**不复用** `maskMobileText`（那是给"响应/界面展示"用的，语义一样但
 *    调用点性质不同）—— 但为避免两份实现漂移，用的仍是同一种形态。
 *    之所以在本文件内联一份 3 行实现而不 import：import 会让"日志脱敏"这件事
 *    与"响应脱敏"耦合在一起，将来有人为了改界面展示去动那个函数时，
 *    会**顺手改掉日志口径**。日志脱敏的口径必须独立且难以被误改。
 */
function maskMobileForLog(mobile: string): string {
  const m = String(mobile ?? '');
  if (m.length < 7) return '***';
  return `${m.slice(0, 3)}****${m.slice(-4)}`;
}
