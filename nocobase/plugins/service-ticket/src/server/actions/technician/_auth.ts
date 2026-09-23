/**
 * 师傅作业接口的 **Token 认证层**（Phase 5 / P5-0）—— 三个匿名 action 的唯一入口守卫。
 *
 * ---------------------------------------------------------------------------
 * 为什么必须有这一层，而不是让每个 handler 各自校验
 * ---------------------------------------------------------------------------
 * 三个 action（get / upload / submit）都挂在**匿名**资源 `technicianVisit` 上
 * （ACL 只做到"这一步不用登录"）。也就是说 ACL **挡不住任何人** ——
 * 整个师傅接口的安全边界就落在这一层上。
 * 若每个 handler 各写一份校验：
 *   · 某天只在 `get` 里加了"Visit 必须是 ASSIGNED"，`upload` 就留下了缺口；
 *   · 而两个 handler 各自的测试都是绿的（它们测的是自己那一份）。
 * 这与 `svc/_request.ts` 把"解析操作者 → 执行 → 统一错误映射"收成唯一实现同源：
 * **安全语义只能有一份实现**。因此这里保留唯一入口，三个 action 都从它进。
 *
 * ---------------------------------------------------------------------------
 * 对外响应**只有一种失败**：`401 TOKEN_INVALID`
 * ---------------------------------------------------------------------------
 * `TokenService.verify()` 内部区分 `MALFORMED / NOT_FOUND / EXPIRED / ALREADY_USED /
 * REVOKED / VISIT_NOT_ACTIVE / TICKET_NOT_ACTIVE / LOOKUP_FAILED`，但**只有日志知道**。
 * 对外统一 `TOKEN_INVALID` —— 区分原因等于送攻击者一个**枚举探测接口**
 * （"这个链接是过期还是不存在"本身就说明 token 猜对了一半）。
 * 依据 docs/SECURITY.md 与 docs/STATE-MACHINE.md §5；
 * 形态与 Phase 4 的诊断探针 `svc:tokenCheck`（`200 + {valid:false}`）不同、语义一致
 * （见 DEV-45 与 docs/API.md §2 顶部说明）。
 *
 * ⚠️ **失败响应体逐字节相同**（这是本层最容易被无意破坏的性质）：
 *    失败体**不带 `detail`**，因此也**不带 traceId**。
 *    traceId 放响应头 `X-Trace-Id`（排障照旧），**不进 body** ——
 *    否则每次请求的 body 都不一样，"六种失效原因返回同一个响应"这条断言
 *    就只能退化成"只看 code 相同"，而那正是枚举侧信道会钻的缝。
 *
 * ---------------------------------------------------------------------------
 * 与 Phase 4 的坑的关系（DEV-72 的教训）
 * ---------------------------------------------------------------------------
 * 本层被调用时，请求**已经**穿过 nginx 与 resourcer 到达我们的 handler。
 * 也就是说"能走到这里"本身就是路由正确的证据：resourcer 解析失败会是 404，
 * 而不是 `401 TOKEN_INVALID`。`scripts/verify-technician-routing.mjs` 正是靠这一点，
 * **不需要造合法 Token** 就能断言 `/api/technician/*` 真的接到了我们的代码。
 */
import { TECHNICIAN_TOKEN } from '../../constants';
import type { Services } from '../../services';
import { param, type ActionHandler } from '../svc/_request';
import { clientIpOf, fail, traceId } from '../svc/_http';

export interface TechnicianActionDeps {
  services: Services;
  logger: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
    debug?: (m: string) => void;
  };
}

export type TechnicianAuthResult =
  | { ok: true; visit: Record<string, unknown>; token: string }
  | { ok: false };

/**
 * 统一的 401 失败响应。
 *
 * 文案刻意**不含**任何区分信息（不说"已过期"/"已使用"/"不存在"），
 * 且**不带 detail** —— 理由见文件头。
 *
 * 为什么用 `errors[0].code` 这个信封而不是顶层 `{code}`：
 *   错误信封的唯一事实来源是 docs/API.md §0（`{ errors: [{ code, message }] }`），
 *   由 `svc/_http.ts` 的 `fail()` 统一产出，svc 与 public 两组接口都走它。
 *   师傅接口若自创一种形状，前端就得按两套解析写。
 *   因此 `TOKEN_INVALID` 出现在 `errors[0].code`。
 */
const INVALID_MESSAGE = '链接无效或已失效，请联系门店重新获取';

function rejectInvalidToken(ctx: any): void {
  fail(ctx, 401, 'TOKEN_INVALID', INVALID_MESSAGE);
}

/**
 * 认证一次师傅请求。**成功返回 Visit 行，失败已写好 401 并返回 `{ok:false}`**
 * （调用方只需 `if (!auth.ok) return;`，不要自己再写响应，避免出现两种失败体）。
 *
 * @param actionName 仅用于日志，**不**进响应
 */
export async function authenticateTechnician(
  ctx: any,
  deps: TechnicianActionDeps,
  actionName: string,
): Promise<TechnicianAuthResult> {
  const { services, logger } = deps;
  const trace = traceId(ctx);
  if (ctx?.set) ctx.set('X-Trace-Id', trace);

  // 取 token：nginx 把它重写进 query（`?token=...`）——见 nginx/conf.d/service.conf
  // 的 /api/technician/ 段。`param()` 依次尝试 body.values → query → filterByTk，
  // 与 svc 组共用一份实现（避免"取参口径"两处分叉）。
  const raw = param(ctx, 'token');

  if (typeof raw !== 'string' || !TECHNICIAN_TOKEN.PATTERN.test(raw)) {
    // 格式非法：零成本判断，**不查库**（与 TokenService.verify 的第一道一致）。
    // 这里单独打日志是为了区分"扫描器乱打"与"真链接失效"——
    // 两者对外表现完全一样，运维只能靠日志分辨。
    logger.debug?.(
      `[technician:${actionName}] TOKEN_INVALID（格式非法，未查库，ip=${clientIpOf(
        ctx,
      )}，trace=${trace}）`,
    );
    rejectInvalidToken(ctx);
    return { ok: false };
  }

  const result = await services.tokens.verify(raw);
  if (!result.ok) {
    // ⚠️ 只把 reason 写进日志，**绝不**进响应（见文件头）。
    // debug 级别：陈旧书签、被改派后的旧链接、扫描器乱打都会走到这里，
    // 记 warn 会让"warn = 值得看一眼"这条纪律失效（与 NotFoundError.logLevel 同一理由）。
    logger.debug?.(
      `[technician:${actionName}] TOKEN_INVALID（真实原因 ${result.reason}，ip=${clientIpOf(
        ctx,
      )}，trace=${trace}）`,
    );
    rejectInvalidToken(ctx);
    return { ok: false };
  }

  return { ok: true, visit: result.visit, token: raw };
}

/**
 * 把 handler 包成"先认证、再执行"的固定形态。
 *
 * 用包装器而不是在每个 handler 里手写 `const auth = await ...; if (!auth.ok) return;`：
 * 手写版一旦在哪一个 handler 里漏了那两行，接口就变成**完全匿名可用**，
 * 而且是静默的（代码看起来只是"少了一行"）。包装器让"没有认证就不可能有业务代码"
 * 成为**结构上的必然**。
 */
export function withTechnicianAuth(
  deps: TechnicianActionDeps,
  actionName: string,
  run: (
    ctx: any,
    auth: { visit: Record<string, unknown>; token: string },
  ) => Promise<void>,
): ActionHandler {
  return async function technicianAction(ctx: any, next: () => Promise<void>): Promise<void> {
    const auth = await authenticateTechnician(ctx, deps, actionName);
    if (!auth.ok) return;
    await run(ctx, { visit: auth.visit, token: auth.token });
  };
}
