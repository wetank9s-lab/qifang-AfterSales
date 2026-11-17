/**
 * public-archive-gate.ts —— `publicArchive` 匿名资源的**总开关**（PROD-HOTFIX-01）
 *
 * ===========================================================================
 * 为什么需要这一层（不是"再加一道防御"，而是补一个**缺失的闸门**）
 * ===========================================================================
 * 此前"客户档案查询入口是关闭的"这件事，**完全依赖部署侧**：
 *   · H5 页面文件不出现在站点目录（`archive.html` / `archive-render.js` 不存在）；
 *   · nginx 没有指向它的 location。
 *
 * 这两条都是**外网入口**的封堵，与代码是否具备能力无关。证据是 2026-11-12 的
 * PROD-DEPLOY：dist 一部署，`POST /api/publicArchive:queryByMobile` 立刻匿名可达
 * （返回我方 `400 ARCHIVE_QUERY_BAD_MOBILE`，说明请求**已经进到业务 handler**）。
 * 也就是说 —— **只要把代码放上去，能力就打开了**，没有任何一处代码可以拦住它。
 *
 * ⇒ 本模块就是那一处代码：**默认关闭**，只有显式配置才开。
 *
 * ===========================================================================
 * 三道要求，逐条对应实现
 * ===========================================================================
 * ① **默认关闭、仅显式 true 开启**
 *    判据只有一个：`PUBLIC_ARCHIVE_ENABLED` 的**规范化结果严格等于 `'true'`**。
 *    ⚠️ 不用 `ConfigService.getBool()`：它把 `'1'/'yes'/'on'` 也算真，而本开关
 *       控制的是"公网上匿名可查客户档案摘要"，任何宽松解释都是放行风险。
 *    ⚠️ 也不能用 `process.env.X` 的隐式真值：`'false'` 是 truthy 字符串，
 *       `Boolean('false') === true` —— 这是最经典的开关写反。
 *
 * ② **关闭时所有 publicArchive 匿名 Action 返回 403**
 *    在 **app 级中间件**里判 `(resource, action)`，不看 URL 形态：
 *    nginx 可能重写路径、客户端可能用 `?action=` 或 `/{action}` 后缀、
 *    也可能直接打应用端口 `:13000`。判**解析后的能力名**才覆盖全部入口。
 *    （与 `native-metadata-guard.ts` / `native-export-guard.ts` 同纪律。）
 *
 * ③ **不得在参数校验、数据查询、短信发送之后才检查**
 *    本中间件注册位置在 `{ after: 'auth' }` —— 早于 resourcer 的 **action 中间件**
 *    与 **preActionHandlers**，也早于任何业务 handler。因此被关闭时：
 *      · 不会解析 body 参数（不产生 `ARCHIVE_QUERY_BAD_MOBILE` 之类业务错误）；
 *      · 不会查库；
 *      · 不会进短信 outbox（`sendCode` 一次都不会发）。
 *
 * ===========================================================================
 * 为什么"关掉 handler 注册"不是更好的做法
 * ===========================================================================
 * `registerPublicResources()` 里已有 `PRODUCTION_FORBIDDEN_PUBLIC_ACTIONS` 那种
 * "生产环境不注册"的先例，但它不适合本开关：
 *   · 不注册 ⇒ 该 action 变成 **404**，而用户明令要求 **403**（404 会让人以为
 *     "接口不存在"，运维与验证都无法区分"没部署"与"关掉了"）；
 *   · 注册期删键会牵动"形状表 ↔ 实现表"双向自检，等于为了一个运行期开关
 *     去改启动期的一致性模型；
 *   · 最关键的：注册与否是**进程启动时**的决定，改开关必须重启；
 *     本开关是纯运行期判定，改配置 + 重启进程即生效，语义更直接。
 *
 * ===========================================================================
 * 边界：只管 `publicArchive`，不碰别的任何东西
 * ===========================================================================
 *   · 不影响原有匿名接口：`publicStore` / `publicTicket` / `publicMedia` /
 *     `publicProgress` / `publicReview` / `publicUiTheme` / 师傅端 `publicVisit`
 *     —— 它们不在 `GATED_RESOURCE` 里，本中间件对它们**直接 next()**；
 *   · 不影响员工端业务 Action（`svc:*`，要登录 + 角色）；
 *   · 不影响短信：`sms.enabled` 与各 `sms.scene.*.enabled` 一个字都没动；
 *   · 不影响权限/角色/ACL：本中间件在 ACL 之后运行，**不改动**任何 ACL 条目。
 *
 * 为什么资源名写死 `publicArchive` 而不是从 `PUBLIC_RESOURCE.ARCHIVE` 引入：
 *   本模块是**安全边界**，它必须能在"常量被人误改"的情况下依然守住。
 *   常量改动会让这里在编译期就失配（自检断言会红），而不是静默跟随。
 *
 * ===========================================================================
 * 🔴 ARC-V1 / FINAL-LAUNCH · D2：从「资源级」收紧为「**资源级 + Action 级**」
 * ===========================================================================
 * 上面那版实现只有一个判据：`resourceName === 'publicArchive'` **且** 总开关关闭。
 * 它的缺陷是**全有或全无** —— `PUBLIC_ARCHIVE_ENABLED=true` 会同时放开 6 条动作：
 *  `sendCode` / `verify` / `list` / `detail` / `photo` / `queryByMobile`。
 *
 * 但产品上只批准开放**一条**：`queryByMobile`（客户手机号直查摘要）。
 * 其余五条属于「验证码换会话 + 按 archive_no 看明细/看照片」的老链路，
 * 本次**不开放**（客户查询已改为手机号直查，它们没有业务必要）。
 *
 * ⇒ 于是必须有两层**互相独立**的放行条件，缺一即拒：
 *   ① 资源级：`PUBLIC_ARCHIVE_ENABLED=true`（整个 publicArchive 资源的总闸）；
 *   ② Action 级：`PUBLIC_ARCHIVE_QUERY_ENABLED=true`（**且仅且只**对下表的
 *      `queryByMobile` 生效）。
 * 两层都是「显式 `'true'`」，都是默认 OFF。这样：
 *   · 只开总闸 ⇒ 一条都不放行（比旧行为更严，不是更松）；
 *   · 两层全开 ⇒ 只放行 `queryByMobile`；
 *   · 想让别的 action 也开放 ⇒ 必须改 `QUERY_ACTION_ALLOWLIST` 的源码并重新评审，
 *     不存在"配一个环境变量就放开全部"的路子（用户明令）。
 *
 * ⚠️ 白名单是**严格枚举**：`queryByMobile` 之外的任何 actionName（含拼错的名字、
 *    将来新增但忘了评审的动作）一律按「Action 级未放行」拒绝，绝不默认跟随。
 * ⚠️ 资源级总开关仍然要求：即使 Action 级已放行，资源级关闭时**依然拒绝**
 *    （两层是与关系）。这条是为了让"整体回滚"仍然是一次环境变量操作。
 */

/** 受本开关约束的匿名资源名（**唯一**）。 */
export const GATED_RESOURCE = 'publicArchive';

/** 资源级开关的环境变量名（唯一事实来源；文档、脚本、验证都引用它）。 */
export const PUBLIC_ARCHIVE_ENABLED_ENV = 'PUBLIC_ARCHIVE_ENABLED';

/**
 * Action 级开关的环境变量名（ARC-V1 / D2 新增）。
 *
 * ⚠️ 名字刻意**不**叫 `PUBLIC_ARCHIVE_ENABLED_ACTION` 之类 —— 它只放行一条
 *    「手机号摘要查询」，名字里带 `QUERY` 才能让运维在 `.env` 里一眼看懂
 *    它开的是哪件事。写成 `PUBLIC_ARCHIVE_ALLOW_MOBILE_QUERY` 会更直白，
 *    但本项目对"是否开放某能力"的既有命名都收在 `PUBLIC_*` 前缀下，
 *    这里跟随既有风格。
 */
export const PUBLIC_ARCHIVE_QUERY_ENABLED_ENV = 'PUBLIC_ARCHIVE_QUERY_ENABLED';

/** 关闭时的错误码 —— **资源级关闭**（对外契约；验证脚本按它断言）。 */
export const PUBLIC_ARCHIVE_DISABLED_CODE = 'PUBLIC_ARCHIVE_DISABLED';

/**
 * 关闭时的错误码 —— **Action 级未放行**（D2 新增的独立码）。
 *
 * 为什么必须与上面那个分开：两者的排障含义完全不同 ——
 *   · `PUBLIC_ARCHIVE_DISABLED`      ⇒ 整个资源没开，去看资源级开关；
 *   · `PUBLIC_ARCHIVE_ACTION_CLOSED` ⇒ 资源开着，但这个动作没被批准，
 *                                      去看是不是该只调 `queryByMobile`。
 * 合成一个码会让"接口不存在/资源没开/动作未批准"三种情况在日志里无法区分。
 */
export const PUBLIC_ARCHIVE_ACTION_CLOSED_CODE = 'PUBLIC_ARCHIVE_ACTION_CLOSED';

/**
 * **唯一**被 Action 级开关放行的动作名。
 *
 * 严格白名单，不做前缀/模式匹配：`queryByMobileV2`、`queryByMobile2`、
 * `queryByMobile `（尾空格）都必须**不匹配**。用 `includes` 而不是
 * `startsWith` 正是为了这个 —— 将来有人加一个"看起来同族"的动作，
 * 它必须自己来这一行报到，而不是被前缀顺手放行。
 */
export const PUBLIC_ARCHIVE_QUERY_ACTION = 'queryByMobile';

/** Action 级放行清单（当前**只有一条**；加一条必须走 D2 之外的单独评审）。 */
export const QUERY_ACTION_ALLOWLIST: readonly string[] = [PUBLIC_ARCHIVE_QUERY_ACTION];

/**
 * 开关是否开启。
 *
 * **唯一判据**：规范化后严格等于 `'true'`。
 *   · 未设置 / 空串 / `'0'` / `'1'` / `'yes'` / `'on'` / `'TRUE'` 之外的一切 ⇒ **关闭**
 *   · 只有 `'true'`（忽略首尾空白与大小写）⇒ 开启
 *
 * 为什么连 `'TRUE'` 都要接受：环境变量由人工在 `.env` / compose 里写，
 * 大小写不一致是常见笔误；把 `'TRUE'` 当关闭会造成"明明配了却不生效"，
 * 而它的**安全性**与 `'true'` 完全相同（都表示"开启"）——
 * 放松大小写不降低安全性，只降低误配概率。
 */
export function isPublicArchiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env?.[PUBLIC_ARCHIVE_ENABLED_ENV];
  if (raw === undefined || raw === null) return false;
  return String(raw).trim().toLowerCase() === 'true';
}

/**
 * **Action 级**开关是否开启（D2 新增）。
 *
 * 判据与资源级**逐字相同**：规范化后严格等于 `'true'`，其余一律关闭。
 * 为什么不抽成 `readBooleanEnv(name)` 共用一份再调用两次：
 *   两者是**两层独立的授权**，其中任一层将来若被单独收紧（例如 Action 级
 *   要求额外的签名/时间窗），共用同一个读函数会逼着改那份函数 —— 那时
 *   改动会**同时**影响资源级。安全边界的两个判据各自成形、各自可被单独变异，
 *   变红时才分得清是哪一层失效。
 */
export function isPublicArchiveQueryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env?.[PUBLIC_ARCHIVE_QUERY_ENABLED_ENV];
  if (raw === undefined || raw === null) return false;
  return String(raw).trim().toLowerCase() === 'true';
}

/**
 * 这个 actionName 是否被 Action 级开关**明确放行**？
 *
 * fail-closed 三处：
 *   · `actionName` 缺失（undefined / 空串）⇒ **不放行**（不能因为"没拿到名字"就放行）；
 *   · 大小写不同 ⇒ 不放行（`QueryByMobile` ≠ `queryByMobile`；NocoBase 的动作名
 *     是大小写敏感的精确字符串，放宽大小写等于允许一个"看起来对但走不到 handler"
 *     的名字被放行 —— 那样它会在下一层变成 404，排查方向被带偏）；
 *   · 白名单之外的一切 ⇒ 不放行。
 *
 * 用 `includes`（数组精确相等）而不是 `startsWith`：见 `QUERY_ACTION_ALLOWLIST`
 * 的注释 —— 前缀匹配会让"同族的新动作"被静默放行。
 */
export function isActionExplicitlyAllowed(actionName: string | undefined): boolean {
  const name = String(actionName ?? '');
  if (!name) return false;
  return QUERY_ACTION_ALLOWLIST.includes(name);
}

/**
 * 纯判定：这笔 (resource, action) 是否被本闸门拦下？（D2 起为**双层**判定）
 *
 * 保留函数名与"返回是否拦截"的语义，是为了让既有门禁脚本与单测不必改签名；
 * 但参数从 `(resource, enabled)` 扩成了 `(resource, action, enabled, queryEnabled)`。
 *
 * 判定顺序（**先判资源、再判动作**，顺序影响返回的错误码，故固定）：
 *   ① 不是 `publicArchive` ⇒ 不拦（本中间件面向全站，默认放行不是默认拒绝）；
 *   ② 资源级关闭 ⇒ 拦（`PUBLIC_ARCHIVE_DISABLED`）；
 *   ③ 资源级开着但 Action 级关闭 ⇒ 拦（`PUBLIC_ARCHIVE_ACTION_CLOSED`）；
 *   ④ 两层的开关都开，但 actionName 不在白名单 ⇒ 拦（`PUBLIC_ARCHIVE_ACTION_CLOSED`）。
 *      ⚠️ ④ 是本轮最关键的一条：它使"开了总开关 + 开了查询开关"**仍然**不会
 *         放开 `sendCode`/`verify`/`list`/`detail`/`photo`。
 *
 * 为什么不在开启时"顺手"校验 `PUBLIC_ARCHIVE_ENABLED` 之外的东西（如 profile）：
 *   生产/开发的差异已由 `assertProductionStartup` 与匿名白名单管；闸门只回答
 *   "这笔请求该不该被这层拦"，多判一件事就会在下一次排障时说不清是谁拦的。
 */
export function shouldBlockPublicArchive(
  resourceName: string | undefined,
  actionName: string | undefined,
  enabled: boolean,
  queryEnabled: boolean,
): boolean {
  if (String(resourceName ?? '') !== GATED_RESOURCE) return false;
  if (!enabled) return true;
  if (!queryEnabled) return true;
  return !isActionExplicitlyAllowed(actionName);
}

/**
 * 拦截时给出的错误码（与 `shouldBlockPublicArchive` 的判定顺序**同源**）。
 *
 * 抽成函数而不是在中间件里写一串 `if`：错误码是**对外契约**，
 * 门禁按它断言；两处各写一遍就是"同一个坑两条腿"。
 * 返回 `null` 表示"不该拦"（调用方据此 `next()`）。
 */
export function publicArchiveBlockCode(
  resourceName: string | undefined,
  actionName: string | undefined,
  enabled: boolean,
  queryEnabled: boolean,
): string | null {
  if (!shouldBlockPublicArchive(resourceName, actionName, enabled, queryEnabled)) return null;
  return enabled ? PUBLIC_ARCHIVE_ACTION_CLOSED_CODE : PUBLIC_ARCHIVE_DISABLED_CODE;
}

export interface PublicArchiveGateOptions {
  /** 资源级开关求值函数（默认读 `process.env`；测试可注入固定值） */
  isEnabled?: () => boolean;
  /** Action 级开关求值函数（默认读 `process.env`；测试可注入固定值） */
  isQueryEnabled?: () => boolean;
  /** 启动日志用：`app.log` 子集 */
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

/**
 * app 级中间件工厂。
 *
 * 中间件签名是 NocoBase/koa 的标准 `(ctx, next)`；**不改 ctx.state / 不写 ctx.body
 * 的其它字段**，只设 `ctx.status=403` + `ctx.body` 的文档信封，与
 * `actions/svc/_http.ts#fail()` **逐字段一致**（`{errors:[{code,message,detail}]}`
 * + `withoutDataWrapping = true`），这样客户端只需一套错误解析。
 */
export function createPublicArchiveGateMiddleware(
  options: PublicArchiveGateOptions = {},
) {
  const isEnabled = options.isEnabled ?? (() => isPublicArchiveEnabled());
  const isQueryEnabled = options.isQueryEnabled ?? (() => isPublicArchiveQueryEnabled());
  const logger = options.logger;

  return async function publicArchiveGate(ctx: any, next: () => Promise<void>): Promise<void> {
    const resourceName = ctx?.action?.resourceName;
    const actionName = ctx?.action?.actionName;
    if (!resourceName) {
      // 还没解析出资源（非资源型路由：静态文件、健康检查的外部形态等）——
      // 本中间件对它没有意见，交给后续链路。
      await next();
      return;
    }

    // 不是被管资源 ⇒ 一个字节都不碰，直接放行。
    // ⚠️ 这里**必须**先短路：下面的 `isEnabled()` / `isQueryEnabled()` 会被求值，
    //    而它们读的是 process.env —— 对全站每个请求都求值一次属于无意义的开销，
    //    更重要的是：若将来有人把开关求值写成"求值即记日志"，全站日志会被它淹没。
    if (String(resourceName ?? '') !== GATED_RESOURCE) {
      await next();
      return;
    }

    const enabled = isEnabled();
    // Action 级开关**只在资源级开启时才求值**：资源级关闭时结论已定，
    // 再读一次环境变量只会让"到底是哪层关的"更难判断。
    const queryEnabled = enabled ? isQueryEnabled() : false;

    const blockCode = publicArchiveBlockCode(resourceName, actionName, enabled, queryEnabled);
    if (!blockCode) {
      await next();
      return;
    }

    // ---- 关闭：**在这里就结束**，不解析 body、不查库、不发短信 ----
    //
    // 只记资源:动作与请求 ID，不记任何请求体内容 ——
    // 关闭态下"有人仍在尝试访问"本身就是信号，但请求体可能含手机号（PII），
    // 关闭态日志同样受"日志不得记录完整手机号"约束。
    const reason =
      blockCode === PUBLIC_ARCHIVE_DISABLED_CODE
        ? `${PUBLIC_ARCHIVE_ENABLED_ENV} 未显式设为 true`
        : `${PUBLIC_ARCHIVE_QUERY_ENABLED_ENV} 未显式设为 true 或该动作未被批准` +
          `（仅 ${QUERY_ACTION_ALLOWLIST.join('/')} 可在本资源内开启）`;
    logger?.warn?.(`[publicArchive-gate] 已关闭 ⇒ 403 ${resourceName}:${actionName ?? '?'}（${reason}）`);

    ctx.status = 403;
    ctx.withoutDataWrapping = true;
    ctx.body = {
      errors: [
        {
          code: blockCode,
          message: '客户档案查询服务未开放',
          detail: { resource: resourceName, action: actionName ?? null },
        },
      ],
    };
  };
}
