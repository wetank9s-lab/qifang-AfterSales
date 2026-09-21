/**
 * TokenService —— 师傅作业 Token 的**签发 / 校验 / 吊销**
 *
 * 三条设计约束（每一条失守都会变成安全事故，不是体验问题）：
 *
 * 1) **明文只活一次**。
 *    生成时 `randomBytes(32).toString('base64url')`，随后只做两件事：
 *    拼进短信、以及把 sha256 写进 `serviceVisits.access_token_hash`。
 *    明文不入库、不进事件 metadata、不进 SmsLog（SmsLog 只存脱敏收件人）。
 *    这样"拿到库权限"与"拿到可用的作业链接"是两件事 ——
 *    哈希泄露只能被离线爆破，而 256 位随机数没有爆破余地。
 *
 *    为什么**不加盐**：加盐是为了对抗"口令熵低 + 彩虹表"。
 *    这里的明文是 256 位密码学随机数，字典攻击不成立；
 *    加盐反而会让"按哈希查行"这条唯一的校验路径失效（必须全表扫+逐行比）。
 *    这是刻意的取舍，不是遗漏。
 *
 * 2) **校验失败一律 `TOKEN_INVALID`**，不区分"不存在 / 已过期 / 已用过 / 被改派吊销"。
 *    依据 docs/STATE-MACHINE.md §5 与 docs/SECURITY.md：
 *    区分原因等于送给攻击者一个**枚举探测接口** ——
 *    "这个链接是过期还是不存在"能直接告诉他 token 猜对了一半。
 *    因此对外只有一种失败；为什么失败记在**日志**里（`reason`），
 *    排查排障时看日志，不看响应。
 *
 * 3) **吊销不等于删除**。
 *    Token 被改派/取消作废时，我们保留哈希、只置 `token_revoked_at` + 原因。
 *    理由：客服接到"我这个链接打不开"时，需要能回答
 *    "是你被改派了"还是"链接放太久了"；若把哈希清空，
 *    这条 Token 在库里就彻底消失，两个问题都答不了。
 *    对外表现完全一样（都是 TOKEN_INVALID），所以保留它**不增加任何暴露面**。
 *
 * 生命周期与各场景的失效触发见 docs/STATE-MACHINE.md §5 与 §7.4。
 */
import { createHash, randomBytes } from 'node:crypto';

import { TECHNICIAN_TOKEN, TICKET_STATUS, VISIT_STATUS } from '../constants';

/**
 * 校验失败的**内部**原因。
 *
 * ⚠️ 仅供日志与本机排障使用，**不得**出现在任何对外响应里
 *    （见本文件顶部第 2 条）。`verify()` 把它单独放在 `reason` 字段，
 *    就是为了让调用方在"想返回它"时能意识到自己在做一件不该做的事。
 */
export type TokenInvalidReason =
  | 'MALFORMED' // 格式非法，没查库
  | 'NOT_FOUND' // 哈希查不到行
  | 'EXPIRED'
  | 'ALREADY_USED'
  | 'REVOKED'
  /** Visit 已被改派取代 / 已取消 —— 与 REVOKED 分开记，因为"改派"与"被吊销"可能不同时发生 */
  | 'VISIT_NOT_ACTIVE'
  /** 所属工单已闭环或取消 */
  | 'TICKET_NOT_ACTIVE'
  | 'LOOKUP_FAILED'; // 查库本身失败（表缺失/连接断）——**不是** TOKEN_INVALID 的业务原因，但对外同样不明说

export type TokenVerifyResult =
  | { ok: true; visit: Record<string, unknown> }
  | { ok: false; code: 'TOKEN_INVALID'; reason: TokenInvalidReason };

/** 一次签发的结果。明文 `token` 与 `link` 都只在内存里流转。 */
export interface MintedToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
  /** 师傅作业链接（`{PUBLIC_BASE_URL}/t/{token}`） */
  link: string;
}

export interface TokenServiceOptions {
  logger?: { warn?: (msg: string) => void; debug?: (msg: string) => void; info?: (msg: string) => void };
  /** 对外基址；缺省读 `process.env.PUBLIC_BASE_URL`。显式传入只为可测。 */
  publicBaseUrl?: string;
  /** 注入随机源（测试用），返回 BYTES 长度的 Buffer */
  randomBytesFn?: (size: number) => Buffer;
  /** 注入时钟（测试用） */
  now?: () => Date;
}

export class TokenService {
  private readonly db: any;
  private readonly logger?: TokenServiceOptions['logger'];
  private readonly baseUrlOverride?: string;
  private readonly randomBytesFn: (size: number) => Buffer;
  private readonly now: () => Date;

  constructor(db: any, options: TokenServiceOptions = {}) {
    this.db = db;
    this.logger = options.logger;
    this.baseUrlOverride = options.publicBaseUrl;
    this.randomBytesFn = options.randomBytesFn ?? ((size: number) => randomBytes(size));
    this.now = options.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // 签发
  // -------------------------------------------------------------------------

  /**
   * 生成一枚新 Token（**纯计算，不碰数据库**）。
   *
   * 为什么不在这里顺手写库：Token 必须与"它所属的那条 Visit"同一个事务落库，
   * 而 Visit 的 id 在插入之前不存在。因此顺序只能是
   *   mint()（先拿到 hash）→ 建 Visit（把 hash 一起插进去）→ 提交 → 拿明文去发短信。
   * 若把写库塞进来，就只能"先建 Visit、再 UPDATE 补 hash"，
   * 中间那一步失败会留下一条**有 Visit 却没有 Token** 的派工 —— 师傅永远打不开链接。
   *
   * @param ttlHours 有效期（小时），来自 `technician.token_expire_hours`
   */
  mint(ttlHours: number): MintedToken {
    const hours = Number.isFinite(ttlHours) && ttlHours > 0 ? Math.trunc(ttlHours) : 72;
    const token = this.randomBytesFn(TECHNICIAN_TOKEN.BYTES).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + hours * 3600 * 1000);

    return {
      token,
      tokenHash: hashToken(token),
      expiresAt,
      link: this.linkOf(token),
    };
  }

  /** 明文 → sha256 hex（`access_token_hash` 的长度 64 与之严格对应） */
  hashOf(token: string): string {
    return hashToken(token);
  }

  /** 拼作业链接。基址缺失时退化为**仅路径**并记 debug（配置问题由启动期警告暴露，不在这里阻断业务） */
  linkOf(token: string): string {
    const base = this.baseUrl();
    return `${base}${TECHNICIAN_TOKEN.LINK_PATH}${token}`;
  }

  private baseUrl(): string {
    const raw = this.baseUrlOverride ?? process.env.PUBLIC_BASE_URL ?? '';
    const trimmed = String(raw).trim().replace(/\/+$/, '');
    if (!trimmed) {
      this.logger?.debug?.(
        '[token] PUBLIC_BASE_URL 未配置，作业链接将只有路径（师傅无法直接打开）',
      );
    }
    return trimmed;
  }

  // -------------------------------------------------------------------------
  // 校验
  // -------------------------------------------------------------------------

  /**
   * 用**明文** Token 换取它绑定的 Visit。
   *
   * 判定顺序是刻意的：先做零成本的格式检查（避免为垃圾输入查库），
   * 再按唯一索引查一次（**一次**查询覆盖"不存在"与"存在但无效"两种情况，
   * 不存在时不做第二次查询，因此响应时间几乎不泄漏"是否存在"）。
   *
   * 之后依次拒绝：过期 → 已用 → 被吊销 → Visit 非 ASSIGNED → 工单非进行中。
   * 每一层各自能独立挡住一类问题，不要因为"上面已经拦了"就删掉下面那层：
   *   · `EXPIRED`      —— 链接放久了；
   *   · `ALREADY_USED` —— 同一链接二次提交（M8 的用后即焚）；
   *   · `REVOKED`      —— 改派/取消时主动作废（**Phase 4 的硬门槛**）；
   *   · `VISIT_NOT_ACTIVE` —— 兜底：即便有人手工改库没置吊销时间，
   *                            Visit 不是 ASSIGNED 就一律不认；
   *   · `TICKET_NOT_ACTIVE` —— 兜底：工单已闭环/取消，作业链接自然失效。
   */
  async verify(rawToken: unknown): Promise<TokenVerifyResult> {
    const token = typeof rawToken === 'string' ? rawToken : '';
    if (!TECHNICIAN_TOKEN.PATTERN.test(token)) {
      return this.invalid('MALFORMED', token);
    }

    const repository = this.db.getRepository('serviceVisits');
    let visit: any = null;
    try {
      visit = await repository.findOne({ filter: { access_token_hash: hashToken(token) } });
    } catch (error) {
      // 查库失败**不能**报成"Token 有效"，也不能报成业务原因 ——
      // 单独一个 reason 便于运维区分"链接坏了"与"库坏了"。
      this.logger?.warn?.(`[token] 校验时查库失败：${(error as Error)?.message}`);
      return this.invalid('LOOKUP_FAILED', token);
    }

    if (!visit) return this.invalid('NOT_FOUND', token);

    const now = this.now();
    const expiresAt = toDate(visit.token_expires_at);
    if (!expiresAt || expiresAt.getTime() <= now.getTime()) {
      return this.invalid('EXPIRED', token, visit);
    }
    if (toDate(visit.token_used_at)) {
      return this.invalid('ALREADY_USED', token, visit);
    }
    if (toDate(visit.token_revoked_at)) {
      return this.invalid('REVOKED', token, visit);
    }
    if (String(visit.visit_status) !== VISIT_STATUS.ASSIGNED) {
      return this.invalid('VISIT_NOT_ACTIVE', token, visit);
    }

    const ticket = await this.loadTicket(visit.ticket_id);
    if (!ticket) return this.invalid('NOT_FOUND', token, visit);
    if (![TICKET_STATUS.NEW, TICKET_STATUS.PROCESSING].includes(String(ticket.status) as any)) {
      return this.invalid('TICKET_NOT_ACTIVE', token, visit);
    }

    return { ok: true, visit: plain(visit) };
  }

  /**
   * 失败收口：统一返回 `TOKEN_INVALID`，把真实原因写进日志。
   *
   * 日志级别：`REVOKED` / `NOT_FOUND` / `MALFORMED` 用 debug ——
   * 前两者是**安全设计的正常产物**（陈旧书签、被改派后的旧链接、
   * 扫描器乱打），每次刷新都记 warn 会让"warn = 值得看一眼"这条纪律失效
   * （与 PermissionService.NotFoundError.logLevel 同一理由）。
   * 而 `LOOKUP_FAILED` 用 warn：那是真的出问题了。
   */
  private invalid(reason: TokenInvalidReason, token: string, visit?: any): TokenVerifyResult {
    const suffix = visit ? `（visit=${visit.id} ticket=${visit.ticket_id}）` : '';
    const message = `[token] 校验失败 TOKEN_INVALID（真实原因 ${reason}，token 指纹 ${fingerprint(token)}${suffix}）`;
    if (reason === 'LOOKUP_FAILED') this.logger?.warn?.(message);
    else this.logger?.debug?.(message);

    return { ok: false, code: 'TOKEN_INVALID', reason };
  }

  private async loadTicket(ticketId: unknown): Promise<any | null> {
    try {
      const repository = this.db.getRepository('serviceTickets');
      return (await repository.findOne({ filter: { id: Number(ticketId) } })) ?? null;
    } catch (error) {
      this.logger?.warn?.(`[token] 读取工单 ${ticketId} 失败：${(error as Error)?.message}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 吊销 / 换发（写库，须在调用方事务内）
  // -------------------------------------------------------------------------

  /**
   * 作废某条 Visit 的**当枚** Token（改派、取消、转店都走它）。
   *
   * 幂等：`COALESCE` 保留第一次的吊销时间与原因 ——
   * 一条 Visit 只应有一个"作废原因"，后来的调用不该把它覆盖成别的
   * （否则"到底是改派还是取消"会随着调用顺序漂移）。
   *
   * @param reason 写进 `token_revoked_reason`，取值是稳定的短标识
   *               （`reassigned` / `cancelled` / `transferred`），**不要写中文句子**：
   *               这一列会在后台被过滤与统计，也会被 Phase 5 的客服话术映射。
   */
  async revoke(
    visitId: number | string,
    reason: string,
    transaction?: unknown,
  ): Promise<{ revoked: boolean; alreadyRevoked: boolean }> {
    const id = toPositiveInt(visitId, 'visitId');
    const [rows] = await this.rawQuery(
      `UPDATE service_visits
          SET token_revoked_at = COALESCE(token_revoked_at, now()),
              token_revoked_reason = COALESCE(token_revoked_reason, $2),
              updated_at = now()
        WHERE id = $1
        RETURNING id, token_revoked_at, token_revoked_reason`,
      [id, String(reason)],
      transaction,
    );

    const row: any = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return { revoked: false, alreadyRevoked: false };

    const already = Boolean(toDate(row.token_revoked_at));
    // 只有在"本次真的写入了"时才记 debug，避免把幂等重放刷成噪声
    if (!already) this.logger?.debug?.(`[token] visit=${id} 的 Token 已作废（${reason}）`);
    return { revoked: true, alreadyRevoked: already };
  }

  /**
   * 换发：把 Visit 上的 Token 换成新的一枚（**改约专用**，M5）。
   *
   * 为什么不复用 `revoke()` + 再写新 hash：
   *   两列语义不同。`token_revoked_at/reason` 描述的是"**当前这枚** Token
   *   是否已被人为作废"。改约后旧明文作废靠的是"哈希被覆盖、查不到了"，
   *   而 Visit 仍然**有效并继续作业**，所以这一对必须回到 NULL ——
   *   否则新 Token 一签发就带着"已吊销"标记，师傅永远打不开链接
   *   （这是最容易写错、且只在真机才会暴露的一处：单测里如果只用返回对象断言，
   *    不读回库里的行，就会漏掉）。
   *
   * 旧哈希被覆盖即意味着旧明文**永久不可再用**（无论是否有吊销标记），
   * 这正是 docs/STATE-MACHINE.md M5「旧 Token 吊销并签发新 Token」的效果。
   */
  async reissue(params: {
    visitId: number | string;
    minted: MintedToken;
    transaction?: unknown;
  }): Promise<any | null> {
    const id = toPositiveInt(params.visitId, 'visitId');
    const [rows] = await this.rawQuery(
      `UPDATE service_visits
          SET access_token_hash = $2,
              token_expires_at = $3,
              token_used_at = NULL,
              token_revoked_at = NULL,
              token_revoked_reason = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, params.minted.tokenHash, params.minted.expiresAt],
      params.transaction,
    );

    const row: any = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return null;
    this.logger?.debug?.(`[token] visit=${id} 已换发新 Token（旧明文即刻失效）`);
    return plain(row);
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async rawQuery(
    sqlText: string,
    bind: unknown[],
    transaction?: unknown,
  ): Promise<[unknown, unknown]> {
    const sequelize = this.db?.sequelize;
    if (!sequelize || typeof sequelize.query !== 'function') {
      throw new Error('[token] db.sequelize.query 不可用');
    }
    const options: Record<string, unknown> = { bind };
    if (transaction) options.transaction = transaction;
    return (await sequelize.query(sqlText, options)) as [unknown, unknown];
  }
}

// ---------------------------------------------------------------------------
// 纯函数工具（auth 层与测试直接复用）
// ---------------------------------------------------------------------------

/** sha256 hex。明文永不出现在返回值之外的任何持久化路径上。 */
export function hashToken(token: string): string {
  return createHash(TECHNICIAN_TOKEN.ALGORITHM).update(String(token)).digest('hex');
}

/**
 * Token 指纹：取哈希前 8 位。
 *
 * 用于日志里把"同一次失败"串联起来，**同时保证日志里没有可用于重放的凭证**。
 * 为什么不用明文前几位：那会泄漏真凭证明文的一部分，且明文随机，
 * 前几位对排障毫无帮助（它不指向任何业务对象）。
 */
export function fingerprint(token: string): string {
  return hashToken(token).slice(0, 8);
}

/** 统一把 DB 返回的时间列归一化成 Date（PG 可能给 Date，桩环境可能给字符串） */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function plain(row: any): Record<string, unknown> {
  if (row && typeof row.toJSON === 'function') {
    try {
      return row.toJSON();
    } catch {
      /* 落到下面 */
    }
  }
  if (row && typeof row === 'object' && row.dataValues && typeof row.dataValues === 'object') {
    return { ...row.dataValues };
  }
  return { ...(row as Record<string, unknown>) };
}

function toPositiveInt(value: unknown, field: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    throw new Error(`[token] ${field} 必须是正整数`);
  }
  return num;
}
