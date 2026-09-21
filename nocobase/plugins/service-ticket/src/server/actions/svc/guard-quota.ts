/**
 * 限流额度只读诊断：`GET /api/svc:guardQuota`（Phase 3-E）
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这个接口（不是为了好看，是为了让验收说实话）
 * ---------------------------------------------------------------------------
 * `scripts/verify-concurrency-phase2.mjs` 要在**发压之前**知道：
 * "本 IP 在当前分钟窗口已用了几次、阈值多少、还剩几次，够不够跑 100 路"。
 *
 * 这件事只能由应用自己回答，脚本算不出来：
 *   · 桶的维度值是**客户端 IP**，而脚本看到的 IP 与 nginx 传给应用的
 *     `X-Real-IP` 未必一致（脚本走 localhost，应用在容器里，还可能经过 Docker NAT）；
 *   · 桶的键是 `sha256(IP + SIGN_SECRET)`，`SIGN_SECRET` 只在服务端，
 *     脚本若自己复算就等于把"哈希口径"复制成第二份实现 ——
 *     口径一漂移，脚本就永远查不到占用，于是每一轮都误判成"额度不足"或者更糟：
 *     误判成"额度充足"然后被 429 打脸。
 *
 * 所以：**数值由应用给，脚本只做减法。**
 *
 * ---------------------------------------------------------------------------
 * 为什么它敢挂在匿名白名单上
 * ---------------------------------------------------------------------------
 * 它确实走 `acl.allow('svc','guardQuota')`（public）—— 因为调用它的运维脚本
 * 没有登录态，而"为了给脚本发 token"要引入一套机器账号，成本远大于收益。
 *
 * 代价用两道闸门补回来：
 *   ① **共享密钥**：必须带 `X-Svc-Diag-Key` 且等于进程内的 `SIGN_SECRET`，
 *      比较用 `crypto.timingSafeEqual`（定长，避免逐字节短路泄露）。
 *   ② **fail-closed**：`SIGN_SECRET` 为空时，**一切请求都返回 404** ——
 *      此时连 guard 的维度哈希都是无盐的（见 guard-service 文件头），
 *      再对外暴露"某个哈希用了多少次"等于帮忙确认碰撞。
 *
 * 不匹配时一律 404 **而不是 401/403**：对外它就应该"不存在"。
 * 回 401 等于承认"这里有个受保护的接口"，可以被用来确认部署形态。
 *
 * ---------------------------------------------------------------------------
 * 它为什么是**只读**的
 * ---------------------------------------------------------------------------
 * 走 `GuardService.peek()`（不自增）。绝不能在业务路径上用 peek 替代 consume：
 * peek 不计数，拿它做放行判定等于没有频控。本接口只被"发压前的预检"与
 * "运维排障"调用，两条路径都不该消耗客户的配额。
 */
import { timingSafeEqual } from 'node:crypto';

import { GUARD_SCENE, GUARD_SCOPE, GUARD_WINDOW, RATE_LIMIT_SETTING_KEY, type GuardWindow } from '../../constants';
import type { Services } from '../../services';
import { ValidationError } from '../../services/ticket-service';
import { clientIpOf, fail, handleError, ok, traceId } from './_http';

export interface GuardQuotaDeps {
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
 * 允许查询的场景白名单。
 *
 * 用**白名单**而不是"把 scene 当参数直接塞进 SQL 条件"：
 * scene 是 `api_guards` 唯一索引的第一列，任何拼进来的字符串都能构造出
 * 一个"永远查不到行"的假桶（返回 used=0 / remaining=limit），
 * 于是运维看到的是"额度充足"，而压测照样被 429 打回 —— 又是一次狼来了。
 */
const ALLOWED_SCENES: string[] = [GUARD_SCENE.PUBLIC_TICKET, GUARD_SCENE.PUBLIC_STORE];

/**
 * scope → 窗口粒度 + 阈值参数键。
 *
 * 这个映射是**唯一**的：`mobile` 只按自然日计数、`ip` 只按分钟计数，
 * 不存在"手机号按分钟"这种桶 —— 让调用方自由组合 window 只会造出查不到行的查询。
 * windows 的取值来自 `WINDOW_SQL`（guard-service），这里不重复声明表达式。
 */
const SCOPE_CONFIG: Record<string, { window: GuardWindow; limitKey: string }> = {
  [GUARD_SCOPE.IP]: {
    window: GUARD_WINDOW.MINUTE,
    limitKey: RATE_LIMIT_SETTING_KEY.IP_MINUTE_LIMIT,
  },
  [GUARD_SCOPE.MOBILE]: {
    window: GUARD_WINDOW.DAY,
    limitKey: RATE_LIMIT_SETTING_KEY.PHONE_DAILY_LIMIT,
  },
};

export function createGuardQuotaHandler(deps: GuardQuotaDeps): ActionHandler {
  const { services, logger } = deps;

  return async function guardQuota(ctx: any, next: () => Promise<void>): Promise<void> {
    const trace = traceId(ctx);
    ctx.set?.('X-Trace-Id', trace);

    try {
      // ---------------------------------------------- ① 两道闸门（不通过一律 404）
      const secret = String(process.env.SIGN_SECRET ?? '');
      const provided = String(ctx?.get?.('x-svc-diag-key') ?? '');

      if (!secret || !services.guards.secretReady || !safeEqual(provided, secret)) {
        // 刻意不区分"密钥为空"与"密钥不对"，也不写 warn（会被扫描器刷成噪声）。
        // 记 debug：运维排障时能看到"确实有人敲过这个路径"，而正常流量不会污染日志。
        logger.debug?.(`[svc:guardQuota] 诊断密钥校验未通过，按不存在处理（trace=${trace}）`);
        fail(ctx, 404, 'NOT_FOUND', 'Not Found');
        return;
      }

      // ------------------------------------------------------------ ② 参数解析
      const params = ctx?.action?.params ?? {};
      const scene = String(params.scene ?? GUARD_SCENE.PUBLIC_TICKET).trim();
      const scope = String(params.scope ?? GUARD_SCOPE.IP).trim();

      if (!ALLOWED_SCENES.includes(scene)) {
        fail(ctx, 422, 'VALIDATION_FAILED', `scene 必须是 ${ALLOWED_SCENES.join(' / ')} 之一`, {
          field: 'scene',
          received: scene,
        });
        return;
      }

      const scopeConfig = SCOPE_CONFIG[scope];
      if (!scopeConfig) {
        fail(ctx, 422, 'VALIDATION_FAILED', `scope 必须是 ${Object.keys(SCOPE_CONFIG).join(' / ')} 之一`, {
          field: 'scope',
          received: scope,
        });
        return;
      }

      const ip = clientIpOf(ctx);
      const value = resolveValue(ctx, scope, params);

      // ------------------------------------------------------------ ③ 只读查询
      const limit = await services.config.getInt(scopeConfig.limitKey);
      const decision = await services.guards.peek({
        scene,
        scope,
        value,
        limit,
        window: scopeConfig.window,
      });

      ok(ctx, {
        scene: decision.scene,
        scope: decision.scope,
        window: decision.window,
        window_seconds: decision.windowSeconds,
        window_start: decision.windowStart,
        window_resets_in_seconds: decision.windowResetsInSeconds,
        used: decision.used,
        limit: decision.limit,
        remaining: decision.remaining,
        allowed: decision.allowed,
        /**
         * 调用方自己的 IP 哈希。
         *
         * 脚本契约里读的就是这个字段名（`verify-concurrency-phase2.mjs` §1），
         * 且**必须在 scope=mobile 时也回** —— 否则"本 IP 还有多少额度"要多发一次请求。
         */
        ip_key_hash: services.guards.guardKey(ip),
        /** 实际被查询的那个桶的维度哈希（scope=ip 时与 ip_key_hash 相同） */
        value_key_hash: decision.guardKey,
        /** 本次是只读预检，未消耗任何额度 —— 调用方可据此安心重试 */
        consumed: false,
      });
    } catch (error) {
      handleError(ctx, error, logger, trace, 'guardQuota');
    }

    await next();
  };
}

/**
 * 定长比较，避免"前缀相同即返回"造成的时间侧信道。
 *
 * 长度不同直接判否（`timingSafeEqual` 对不等长入参是**抛错**而不是返回 false，
 * 不先判长度会让一个畸形请求变成 500 —— 那等于把"这里有接口"告诉了对方）。
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * 桶的维度值。
 *
 *   scope=ip     → **强制**用应用自己解析的客户端 IP，
 *                  不接受 `?value=` 覆盖：允许覆盖就等于让调用方随便选一个桶去看，
 *                  而"我本机到底算哪个桶"恰恰是这个接口唯一无法被替代的价值。
 *   scope=mobile → 必须显式给 `?value=13xxxxxxxxx`（运维排查"客户说提交不了"）。
 *                  手机号在这里是**明文入参**，但只用于哈希、不回显、不落库。
 */
function resolveValue(ctx: any, scope: string, params: Record<string, unknown>): string {
  if (scope === GUARD_SCOPE.IP) return clientIpOf(ctx);

  const raw = String(params.value ?? '').trim();
  if (!raw) {
    // 复用 ValidationError（→ 422）：不新造错误类型。
    // `statusOf()` 是按 instanceof 分支的，新类型会被静默映射成 500 ——
    // 参数写错却回 500，运维会去翻服务端日志找一个不存在的异常。
    throw new ValidationError('VALIDATION_FAILED', 'scope=mobile 时必须提供 value（11 位手机号）');
  }
  return raw;
}
