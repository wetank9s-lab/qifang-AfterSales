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
import { TECHNICIAN_SHORT_CODE, TECHNICIAN_TOKEN } from '../../constants';
import type { Services } from '../../services';
// BE-03-MANUAL-TECH-LINK：两次尝试都要拿到**同一个**结果类型，显式标注而不是靠推断
import type { TokenVerifyResult } from '../../services/token-service';
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
  // 🔴 BE-03-SMS-TEMPLATE-02：**两套凭据，一个入口**。
  //    · 43 位 = 旧长 Token（`/t/{token}`，历史链接必须继续可用）；
  //    · 22 位 = 新短码（`/p/t/{code}`，短信用）。
  //    两者长度不同、查的列不同，但**授权判定完全共用**
  //    （`TokenService.verify` / `verifyByCode` 都落到同一个 `verifyByHash`）。
  //    ⚠️ 这里不是"绕过 TokenService"：格式分派之后走的仍是它。
  const rawToken = param(ctx, 'token');
  const rawCode = param(ctx, 'code');

  let raw = '';
  let credentialKind: 'token' | 'code' = 'token';
  if (typeof rawToken === 'string' && TECHNICIAN_TOKEN.PATTERN.test(rawToken)) {
    raw = rawToken;
  } else if (typeof rawCode === 'string' && TECHNICIAN_SHORT_CODE.PATTERN.test(rawCode)) {
    // ⚠️ 形状判据用 `TECHNICIAN_SHORT_CODE.PATTERN` 就够：手动码与它**同宽同字符集**，
    //    `TECHNICIAN_MANUAL_CODE.PATTERN` 是同一形态的第二个声明。
    //    两者若某天被改成不同宽（比如有人把手动码加成 32 位），这里**不会**报错 ——
    //    表现是"手动码一律 MALFORMED ⇒ 401"，所以由常量层的注释 + 验收脚本
    //    （断言 `TECHNICIAN_MANUAL_CODE.PATTERN === TECHNICIAN_SHORT_CODE.PATTERN`）盯住。
    raw = rawCode;
    credentialKind = 'code';
  }

  if (!raw) {
    // 格式非法：零成本判断，**不查库**（与 TokenService.verify 的第一道一致）。
    // 这里单独打日志是为了区分"扫描器乱打"与"真链接失效"——
    // 两者对外表现完全一样，运维只能靠日志分辨。
    // ⚠️ 日志只打长度与来源，**绝不打明文**（短码与长 Token 同属凭据）。
    logger.debug?.(
      `[technician:${actionName}] TOKEN_INVALID（格式非法，未查库，ip=${clientIpOf(
        ctx,
      )}，trace=${trace}，hasToken=${typeof rawToken === 'string'}，hasCode=${typeof rawCode === 'string'}）`,
    );
    rejectInvalidToken(ctx);
    return { ok: false };
  }

  let result: TokenVerifyResult;
  if (credentialKind === 'code') {
    // 🔴 BE-03-MANUAL-TECH-LINK：22 位这里其实有**两种**码 —— 短信短码与门店手动码。
    //
    //    它们长度与字符集完全相同（都是 base64url 22 位），**无法从字符串判断**
    //    是哪一种（这是刻意的：前端 / nginx 正则都不用改，见 TECHNICIAN_MANUAL_CODE 注释）。
    //    ⇒ 只能"先试短信码、再试手动码"，两次都失败才算失效。
    //
    //    ⚠️ 为什么这个顺序不影响安全：两次尝试走的是**同一段** `verifyByHash()`，
    //       差别只在按哪一列查。任意一次成功都意味着"这个哈希确实绑在那条 Visit 上"，
    //       不存在"放宽判定"。
    //    ⚠️ 为什么先短信码：绝大多数请求来自短信链接，先命中的那条**少一次查库**。
    //    ⚠️ 性能：未签发手动码的行 `manual_code_hash` 为 NULL，
    //       唯一索引对 NULL 的等值查找是 O(1) 的空结果，不构成额外扫描。
    const bySmsCode = await services.tokens.verifyByCode(raw);
    result = bySmsCode.ok ? bySmsCode : await services.tokens.verifyByManualCode(raw);
  } else {
    result = await services.tokens.verify(raw);
  }
  if (result.ok !== true) {
    // ⚠️ 只把 reason 写进日志，**绝不**进响应（见文件头）。
    // debug 级别：陈旧书签、被改派后的旧链接、扫描器乱打都会走到这里，
    // 记 warn 会让"warn = 值得看一眼"这条纪律失效（与 NotFoundError.logLevel 同一理由）。
    const reason = String((result as { reason?: unknown }).reason ?? '');
    logger.debug?.(
      `[technician:${actionName}] TOKEN_INVALID（真实原因 ${reason}，凭据类型 ${credentialKind}，ip=${clientIpOf(
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
