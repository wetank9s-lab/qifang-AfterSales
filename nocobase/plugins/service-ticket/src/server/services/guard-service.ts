/**
 * GuardService —— 匿名入口的**四类守卫**唯一实现（docs/API.md §1.2 / docs/SECURITY.md）
 *
 * 四类守卫，缺一不可：
 *   ① IP 频控        同 IP 每分钟请求上限（`security.ip_minute_limit`）
 *   ② 手机号频控     同手机号每日提交上限（`security.ticket_phone_daily_limit`）
 *   ③ 重复单识别     同手机号 + 同门店 + 同类型 + **同事项文本** + 时间窗
 *                    （`security.duplicate_window_minutes`；见下方 `normalizeContent`）
 *   ④ request_id 幂等 客户端连点/弱网重放只落一张单
 *
 * 为什么单独一个服务、而不是散在 action 里：
 *   这四类守卫都要读写 `api_guards` / `idempotency_records`，且**顺序有关**：
 *   频控必须在"读幂等"之前消费（否则同一个 request_id 可以无限重放而不计数，
 *   等于把频控绕过去），重复单必须在"建单"之前完成。顺序只有在同一处才看得见。
 *
 * ⚠️ 三条硬约束
 * --------------
 * 1) **绝不存明文**。`api_guards.guard_key` 存的是 `sha256(值 + SIGN_SECRET)`。
 *    明文 IP / 手机号一旦入库，库被拖走就等于客户名单泄露（docs/SECURITY.md）。
 *    反过来说：SIGN_SECRET 缺失时**不能降级成无盐哈希** —— 11 位手机号空间
 *    只有 10^11，无盐 sha256 可以秒级穷举。因此密钥为空时本服务记 error 日志，
 *    并由 guard-quota 的 handler 对一切请求返回 404（fail-closed）。
 *
 * 2) **计数必须用单条 upsert 原子完成**。`SELECT 再 UPDATE` 在并发下必然漏计：
 *    100 路同时到达时，它们会读到同一个 counter 再各自写回，最终计数远小于 100，
 *    于是"100 路并发"这件事本身就把频控绕过去了 —— 而这正是并发验收要压的场景。
 *    正确写法是 `INSERT … ON CONFLICT (…) DO UPDATE SET counter = counter + 1 RETURNING counter`。
 *
 * 3) **窗口起点由数据库算**（`date_trunc('minute'/'day', now())`），不在 Node 里算。
 *    应用容器与 DB 容器的时钟、时区（`TZ=Asia/Shanghai`）可能不同；
 *    两边各算一次就会出现"写入落在 12:00 桶、读取去查 12:01 桶"的错位，
 *    表现为"限流偶尔不生效"，且只在高并发/跨分钟边界时偶发 —— 极难复现。
 *    `window_resets_in_seconds` 同理，用 DB 的 `now()` 算，不掺应用时钟。
 */
import { createHash } from 'node:crypto';

import { GUARD_SCOPE, GUARD_WINDOW, type GuardWindow } from '../constants';

/** 防止 `guard_key` 列（varchar 128）放不下：sha256 hex 固定 64 字符 */
const GUARD_KEY_LENGTH = 64;

/**
 * 窗口表达式（**内部常量**，绝不含外部输入，因此可以安全地拼进 SQL）。
 *
 * expires_at 比窗口结束晚一段（分钟窗口 +2min / 日窗口 +1d）：
 * 早于窗口结束就清理会让计数行在窗口内消失 → 限流被重置 → 可以无限刷。
 * 晚一点只是多留几行垃圾，由 guardCleanup 定时任务按 expires_at 回收。
 */
const WINDOW_SQL: Record<GuardWindow, { start: string; end: string; expires: string; seconds: number }> = {
  [GUARD_WINDOW.MINUTE]: {
    start: `date_trunc('minute', now())`,
    end: `date_trunc('minute', now()) + interval '1 minute'`,
    expires: `date_trunc('minute', now()) + interval '3 minutes'`,
    seconds: 60,
  },
  [GUARD_WINDOW.DAY]: {
    start: `date_trunc('day', now())`,
    end: `date_trunc('day', now()) + interval '1 day'`,
    expires: `date_trunc('day', now()) + interval '2 days'`,
    seconds: 86_400,
  },
};

// ---------------------------------------------------------------------------
// 报修内容归一化（Phase 3.1）
// ---------------------------------------------------------------------------
//
// 起因（Phase 3 独立复核结论 · 一）：重复单判定原先只有"同手机号 + 同门店 +
// 同类型 + 时间窗"四个维度，**漏掉了 PHASE-0 §9.4 明文要求的"事项文本相似"**。
// 后果是把合法场景当重复挡掉，而且挡得毫无道理：
//
//     同一客户在同一家店，10 分钟内分别报修两件不同家电 ——
//       工单 A：空调不制冷      工单 B：冰箱漏水
//     两者 ticket_type 都是 repair，于是 B 被判成 A 的重复单，客户拿不到 B 的单号。
//
// 修法：把"事项文本"作为**第五个**判重维度，用确定性的 normalizeContent() 比较。
// 第一版**不引入** AI / 向量 / 复杂 NLP —— 这类能力一旦进入判重链路，
// 就变成"同一个输入在不同时间可能得到不同结论"，而判重结果是直接拒绝客户请求的，
// 必须是可复现、可解释、可测的。相似度阈值调参也会变成一个新的运维负担。
// 宁可漏判（放行，客户最多看到两张单），也不要误判（拦截，客户以为系统坏了）。

/**
 * 归一化时抹掉的字符：Unicode 标点（`\p{P}`）+ 符号（`\p{S}`）。
 *
 * 为什么用 Unicode 属性转义而不是手写字符枚举：
 *   中文标点散落在多个码点区（U+3000–303F CJK 标点、U+FF00–FF65 全角形态、
 *   U+2018–201D 引号……），手写枚举必然漏。`\p{P}` 覆盖全部 Unicode 标点类别
 *   （Pc/Pd/Ps/Pe/Pi/Pf/Po），`\p{S}` 补上符号（`+ = < > $ ￥ ° ©` 等）。
 *   它不是"猜语义"，只是字符类替换 —— 纯函数、无状态。
 *
 * ⚠️ 一个必须说清楚的后果：标点被**删除**（不保留、也不换成空格），
 *   而空白在下一步同样被删光。所以 `"不制冷,漏水"` 与 `"不制冷漏水"`
 *   归一化后相同。这是刻意的宽松化 —— 见文件末"重复单是软约束"的说明。
 */
const CONTENT_NOISE = /[\p{P}\p{S}]/gu;

/**
 * 把报修内容压成用于重复判定的**内容指纹**。
 *
 * 四步（与 Phase 3.1 指令一一对应）：
 *   ① NFKC 归一化 —— 全角 → 半角（Ａ→A、１→1、（）→()），兼容字符统一（ﬁ→fi）。
 *      必须放最前：后面的规则都按"半角形态"设计，先统一才不会漏。
 *   ② 删除标点与符号（`CONTENT_NOISE`）。
 *   ③ 删除全部空白 —— 这一步同时覆盖了指令里的「trim」和「连续空白合并」：
 *      因为空白最终归零，先 trim 再合并只是中间态。
 *      为什么是"删光"而不是"合并成单个空格"：中文不靠空格分词，
 *      `"空调 不制冷"` 与 `"空调不制冷"` 对客户来说就是同一句话；
 *      保留一个空格反而会让这对明显相同的文本判成**不重复**。
 *   ④ 仅把 ASCII `A–Z` 转小写。
 *      有意**不用** `toLowerCase()`：后者按 Unicode 大小写映射，会带进与业务无关的
 *      意外（如 `İ` → `i̇` 变成两个码点，长度都变了）。全角大写字母已被 ① 转成 ASCII，
 *      所以 `[A-Z]` 已覆盖完整。
 *
 * 返回空串是**合法且有意义**的：说明原文是由标点/空白构成（如 `"。。。"`）。
 * 调用方必须把空串当作"无法判定"处理，**绝不能**让两个空串互判为重复 ——
 * 那会把所有"内容无意义"的提交互相拦死。见 `findDuplicateTicket`。
 */
export function normalizeContent(input: unknown): string {
  return String(input ?? '')
    .normalize('NFKC')
    .replace(CONTENT_NOISE, '')
    .replace(/\s+/g, '')
    .replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

/**
 * 单次判重最多取回多少条候选（应用层比较的输入上限）。
 *
 * 窗口内"同手机号 + 同门店 + 同类型"的在办单量被**手机号日频控**（默认 5 次/日）
 * 天然压住，50 已是很大的余量。设上限的意义是防住一种运营配置组合：
 * 把 `duplicate_window_minutes` 调得很大（如 30 天），而该手机号历史上提交过很多单 ——
 * 那时不设限就会把整段历史拉进内存逐条归一化。
 *
 * 超限只会**漏判**（放行），不会误判 —— 与本文件"宁可漏判、不要误判"的取向一致。
 */
const DUPLICATE_CANDIDATE_LIMIT = 50;

/** 429：调用方应把它映射成 HTTP 429 + `Retry-After` */
export class RateLimitedError extends Error {
  readonly code = 'RATE_LIMITED';
  /**
   * 自带 HTTP 状态码。原因与 StateConflictError 相同：
   * 中间件层抛出的错误不经过 action 层的映射表，会直接落到 NocoBase 全局错误处理器，
   * 那里只看 `error.status`；不带就会把 429 报成 500。
   */
  readonly status = 429;
  readonly statusCode = 429;
  /**
   * 框架认识的日志级别（见 verify-plugin-load 的断言）。
   * 限流是**预期内**的拒绝，记 warn；记成 error 会污染"app 日志无 error"这条运维断言。
   */
  readonly logLevel = 'warn';
  readonly detail: Record<string, unknown>;

  constructor(message: string, detail: Record<string, unknown>) {
    super(message);
    this.name = 'RateLimitedError';
    this.detail = detail;
  }
}

/** 一次限流判定的完整结果（既用于"消费"，也用于"只读预检"） */
export interface GuardDecision {
  scene: string;
  scope: string;
  /** 已哈希的维度值（sha256 hex），**不是**明文 */
  guardKey: string;
  window: GuardWindow;
  windowSeconds: number;
  /** 窗口起点（ISO 字符串，由 DB 给出） */
  windowStart: string;
  /** 距窗口重置还有多少秒（DB 时钟口径） */
  windowResetsInSeconds: number;
  /** 本窗口已发生的次数（含本次消费） */
  used: number;
  limit: number;
  /** 剩余可用次数（下限 0；超限时为 0） */
  remaining: number;
  /** 本次是否放行（`used <= limit`） */
  allowed: boolean;
}

export interface ConsumeInput {
  scene: string;
  scope: string;
  /** **明文**维度值（IP / 手机号 / Token）。本服务负责哈希，调用方不得自行哈希。 */
  value: string;
  limit: number;
  window: GuardWindow;
}

export interface PeekInput {
  scene: string;
  scope: string;
  value: string;
  limit: number;
  window: GuardWindow;
}

export interface GuardServiceOptions {
  /**
   * 哈希盐（`SIGN_SECRET`）。为空时记 error 并仍然哈希 ——
   * 这样"别的功能还能用"，但 guard-quota 会 fail-closed（见文件头第 1 条）。
   */
  secret?: string;
  logger?: {
    warn?: (msg: string) => void;
    debug?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}

/** 重复单命中的结果 */
export interface DuplicateTicketHit {
  id: number;
  ticket_no: string;
  created_at: Date | string;
}

export class GuardService {
  private readonly db: any;
  private readonly secret: string;
  private readonly logger?: GuardServiceOptions['logger'];

  constructor(db: any, options: GuardServiceOptions = {}) {
    this.db = db;
    this.secret = String(options.secret ?? '');
    this.logger = options.logger;

    if (!this.secret) {
      // 不抛错（会连带让整个应用起不来），但必须留下明确痕迹：
      // 无盐哈希对 11 位手机号是可穷举的，等于把"禁止存明文"这条设计悄悄作废。
      this.logger?.error?.(
        '[guard] 环境变量 SIGN_SECRET 为空 —— api_guards 的维度哈希将**无盐**，' +
          '11 位手机号空间可被穷举反查。请用 node scripts/gen-secret.mjs 生成并写入 .env。' +
          '（在补齐之前，/api/svc:guardQuota 一律返回 404，不会对外泄露额度）',
      );
    }
  }

  // -------------------------------------------------------------------------
  // 维度哈希
  // -------------------------------------------------------------------------

  /**
   * 维度值 → guard_key。
   *
   * 唯一实现点：调用方**不得**自行拼接 `sha256(value + secret)`。
   * 一旦脚本/测试自己复算一遍，就会多一份会漂移的实现 ——
   * 典型后果是"脚本按自己的算法回查占用，永远查不到，于是每轮都撞频控"。
   */
  guardKey(value: string): string {
    const key = createHash('sha256')
      .update(`${String(value)}${this.secret}`)
      .digest('hex');
    if (key.length !== GUARD_KEY_LENGTH) {
      throw new Error(`[guard] guard_key 长度异常：${key.length}`);
    }
    return key;
  }

  /** 诊断用：密钥是否齐备（空密钥时 guardQuota 必须 fail-closed） */
  get secretReady(): boolean {
    return this.secret !== '';
  }

  // -------------------------------------------------------------------------
  // ① / ② 频控
  // -------------------------------------------------------------------------

  /**
   * 消费一次计数并给出判定（**写**）。
   *
   * 返回值里的 `used` 是**包含本次**的计数，因此判定口径是 `used <= limit`：
   * 阈值 30 表示"本窗口最多放行 30 次"，第 31 次开始 429。
   */
  async consume(input: ConsumeInput): Promise<GuardDecision> {
    const window = this.windowOf(input.window);
    const guardKey = this.guardKey(input.value);

    const [rows] = await this.query(
      `WITH w AS (SELECT ${window.start} AS ws, ${window.expires} AS exp)
       INSERT INTO api_guards
         (scene, scope, guard_key, window_start, counter, expires_at, created_at, updated_at)
       SELECT $1, $2, $3, w.ws, 1, w.exp, now(), now() FROM w
       ON CONFLICT (scene, scope, guard_key, window_start)
       DO UPDATE SET counter = api_guards.counter + 1, updated_at = now()
       RETURNING counter,
                 window_start,
                 ${this.resetsInSql(window)} AS resets_in`,
      [input.scene, input.scope, guardKey],
    );

    const row = Array.isArray(rows) ? (rows[0] as any) : undefined;
    const used = Number(row?.counter);
    if (!Number.isFinite(used) || used <= 0) {
      // 取不到计数就**不能**当作放行：fail-closed 才是限流该有的缺省。
      throw new Error(
        `[guard] 计数失败：scene=${input.scene} scope=${input.scope} 未返回有效 counter` +
          `（实际 ${JSON.stringify(rows)}）`,
      );
    }

    return this.decisionOf(input, guardKey, used, row);
  }

  /**
   * 只读查询当前窗口用量（**不消费**）。
   *
   * 供 `/api/svc:guardQuota` 使用。**严禁**在业务路径上用 peek 替代 consume：
   * peek 不自增，拿它做放行判定等于没有频控。
   */
  async peek(input: PeekInput): Promise<GuardDecision> {
    const window = this.windowOf(input.window);
    const guardKey = this.guardKey(input.value);

    const [rows] = await this.query(
      `SELECT counter,
              window_start,
              ${this.resetsInSql(window)} AS resets_in
       FROM api_guards
       WHERE scene = $1 AND scope = $2 AND guard_key = $3
         AND window_start = ${window.start}`,
      [input.scene, input.scope, guardKey],
    );

    const row = Array.isArray(rows) ? (rows[0] as any) : undefined;
    // 窗口内还没有任何计数行 → used = 0（这是"额度充足"的正常形态，不是错误）
    const used = Number(row?.counter ?? 0);
    return this.decisionOf(
      input,
      guardKey,
      Number.isFinite(used) ? used : 0,
      row ?? { window_start: null, resets_in: null },
    );
  }

  // -------------------------------------------------------------------------
  // ③ 重复单识别
  // -------------------------------------------------------------------------

  /**
   * 查"时间窗内是否已有**同一件事**的在办工单"。
   *
   * 口径（PHASE-0 §9.4 + Phase 3.1 修正）：
   *   · 五个维度**全部**相同才算重复：
   *     同手机号 + 同门店 + 同 `ticket_type` + **同事项文本**（归一化后相等）
   *     + `created_at` 落在窗口内。
   *     **任一不同都是另一件事，必须允许提交** —— 这一条是 Phase 3.1 的核心修正，
   *     原先漏了"事项文本"，导致"空调不制冷"与"冰箱漏水"被互相拦死。
   *   · 窗口长度取 `security.duplicate_window_minutes`；为 0 表示关闭判重。
   *   · **排除 CANCELLED**：客户自己取消后重新提交是正常行为，
   *     拿一张已取消的单把它挡掉，客户会以为系统坏了。
   *
   * 为什么"事项文本"这一维在**应用层**比较、而不是写进 SQL：
   *   归一化要用 `String.normalize('NFKC')` + Unicode 标点类，PG 侧没有对等能力，
   *   而本阶段的明确约束是不引入 PostgreSQL 扩展。所以分工是：
   *   SQL 仍用最省索引的四个维度把候选压到极小，应用层再逐条比归一化结果。
   *   候选上限见 `DUPLICATE_CANDIDATE_LIMIT`（超限只会漏判，不会误判）。
   *
   * 为什么用**查询**而不是"先查后插 + 唯一索引"：
   *   "五维相同 + 移动窗口 + 内容归一化"无法用唯一索引表达，
   *   因此这里是"尽力识别"，允许并发下的极小概率漏判 —— 这一点必须诚实记录，
   *   而不是假装它是硬约束。真正的硬防线是手机号日频控与 IP 频控。
   *
   * ⚠️ 判重始终是**软约束**：判错两个方向代价不对称 ——
   *   漏判 = 客户看到两张单（可人工合并）；误判 = 客户拿不到单号、以为系统坏了。
   *   所以一切边界情形（归一化后为空、候选超限）一律选择**放行**。
   */
  async findDuplicateTicket(input: {
    mobile: string;
    storeId: number;
    ticketType: string;
    /** 本次要提交的报修内容 —— 第五个判重维度 */
    content: string;
    windowMinutes: number;
  }): Promise<DuplicateTicketHit | null> {
    const minutes = Math.max(0, Math.trunc(Number(input.windowMinutes) || 0));
    // 窗口为 0 表示"关闭重复单识别"（运营在后台把参数调成 0 时的预期语义）
    if (minutes <= 0) return null;

    const wanted = normalizeContent(input.content);
    // 归一化后为空（原文全由标点/空白构成）→ **不判重**，直接放行。
    // 若在这里拿空串当键去比，所有"内容无意义"的提交会互相拦截 ——
    // 那是比漏判更糟的误判，且会让"内容校验"形同虚设（见 normalizeContent 的说明）。
    if (!wanted) return null;

    const [rows] = await this.query(
      `SELECT id, ticket_no, created_at, content
       FROM service_tickets
       WHERE customer_mobile = $1
         AND store_id = $2
         AND ticket_type = $3
         AND status <> 'CANCELLED'
         AND created_at > now() - make_interval(mins => $4::int)
       ORDER BY created_at DESC
       LIMIT $5`,
      [input.mobile, input.storeId, input.ticketType, minutes, DUPLICATE_CANDIDATE_LIMIT],
    );

    // 已按 created_at DESC 排序，所以命中的是窗口内**最近**的那张同事项工单。
    for (const row of Array.isArray(rows) ? rows : []) {
      if (normalizeContent((row as any).content) === wanted) {
        return {
          id: Number((row as any).id),
          ticket_no: String((row as any).ticket_no),
          created_at: (row as any).created_at,
        };
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // ④ request_id 幂等
  // -------------------------------------------------------------------------

  /**
   * 读幂等记录。
   *
   * ⚠️ 返回 `response_json` 可能为 null —— 那是"首次执行已建单、但响应体还没写进去"
   *    的中间态（或历史数据）。调用方必须能**据 resource_id 重建响应**，
   *    不能假设它一定存在；报 500 会让客户拿着一张已经建好的单无从得知单号。
   */
  async findIdempotency(
    scene: string,
    key: string,
  ): Promise<{ id: number; resourceId: number; response: unknown | null } | null> {
    const [rows] = await this.query(
      `SELECT id, resource_id, response_json
       FROM idempotency_records
       WHERE scene = $1 AND idempotency_key = $2
       LIMIT 1`,
      [scene, key],
    );

    const row = Array.isArray(rows) ? (rows[0] as any) : undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      resourceId: Number(row.resource_id),
      response: row.response_json ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private windowOf(window: GuardWindow) {
    const conf = WINDOW_SQL[window];
    if (!conf) {
      throw new Error(`[guard] 未知窗口粒度 "${window}"，允许：${Object.keys(WINDOW_SQL).join(' / ')}`);
    }
    return conf;
  }

  /** `window_end - now()` 的秒数，全部在 DB 侧算（见文件头第 3 条） */
  private resetsInSql(window: { end: string }): string {
    return `ceil(extract(epoch from (${window.end} - now())))::int`;
  }

  private decisionOf(
    input: { scene: string; scope: string; limit: number; window: GuardWindow },
    guardKey: string,
    used: number,
    row: { window_start?: unknown; resets_in?: unknown },
  ): GuardDecision {
    const conf = this.windowOf(input.window);
    const limit = Number(input.limit);
    const windowStart = row?.window_start ? new Date(row.window_start as any).toISOString() : null;
    const resetsIn = Number(row?.resets_in);

    return {
      scene: input.scene,
      scope: input.scope,
      guardKey,
      window: input.window,
      windowSeconds: conf.seconds,
      // 窗口内无行时（peek 的常态）回落到应用时钟，仅为让字段可读；
      // 判定用的 used/limit 不受影响。
      windowStart: windowStart ?? new Date().toISOString(),
      windowResetsInSeconds: Number.isFinite(resetsIn) ? Math.max(0, resetsIn) : conf.seconds,
      used,
      limit: Number.isFinite(limit) ? limit : 0,
      remaining: Number.isFinite(limit) ? Math.max(0, limit - used) : 0,
      allowed: Number.isFinite(limit) ? used <= limit : false,
    };
  }

  /**
   * 统一的原生查询入口（与 SequenceService 同风格）。
   *
   * 用位置参数（$1/$2 + bind 数组）而不是 replacements：
   * bind 由驱动直接交给 PG 的预处理协议，不存在字符串拼接。
   */
  private async query(sql: string, bind: unknown[]): Promise<[unknown, unknown]> {
    const sequelize = this.db?.sequelize;
    if (!sequelize || typeof sequelize.query !== 'function') {
      throw new Error('[guard] db.sequelize.query 不可用');
    }
    return (await sequelize.query(sql, { bind })) as [unknown, unknown];
  }
}

/** 供 action 层复用的 scope 常量（避免各处手写 'ip' / 'mobile' 字符串） */
export const GUARD_SCOPE_IP = GUARD_SCOPE.IP;
export const GUARD_SCOPE_MOBILE = GUARD_SCOPE.MOBILE;
