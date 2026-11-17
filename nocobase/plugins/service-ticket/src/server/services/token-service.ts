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
import { createHash, createHmac, randomBytes } from 'node:crypto';

import {
  REVIEW_TOKEN,
  TECHNICIAN_MANUAL_CODE,
  TECHNICIAN_SHORT_CODE,
  TECHNICIAN_TOKEN,
  TICKET_STATUS,
  VISIT_STATUS,
} from '../constants';
// 对外地址的**唯一来源**（与门店报修入口共用，避免"两份基址"漂移）
import { publicBaseUrlOf } from './public-url';
// 签名密钥的**唯一来源**（与门店入口签名 / 客户进度派生码共用同一把钥匙，
// 靠 domain 前缀做域隔离，不各读一份 env —— 见 signingSecretOf 的说明）
import { signingSecretOf } from './store-entry';

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

  /**
   * 生成一枚**评价** Token（P6-1；**纯计算，不碰数据库**）。
   *
   * ⚠️ 用的是 `REVIEW_TOKEN.*` 而**不是** `TECHNICIAN_TOKEN.*`：两侧是两套独立凭证
   * （作业 Token 改派即废；评价 Token 可重新签发且新旧切换必须原子，见契约 §7.4）。
   * 长度与字符集由 `REVIEW_TOKEN` 自己推导得出，不在这里手写 43（契约 §11.3 + C21）。
   *
   * ⚠️ **不返回链接**：P6-1 不发评价短信、I12 响应也不含链接（契约 §11.6）——
   *   多返回一个 `link` 就会有人把它写进日志或幂等响应，那正是明文泄漏的入口。
   *   等评价 H5 与 `/f/` 路由上线后，链接由那一层用 `REVIEW_TOKEN.LINK_PATH` 拼。
   *
   * ⚠️ 返回值的 `token`（明文）**只允许活在本次调用的内存里**：落库只落 `tokenHash`。
   *
   * @param expireDays 有效期（天），来自 `feedback.token_expire_days`（默认 15，不写死）
   */
  mintReview(expireDays: number): { token: string; tokenHash: string; expiresAt: Date } {
    const days = Number.isFinite(expireDays) && expireDays > 0 ? Math.trunc(expireDays) : 15;
    const token = this.randomBytesFn(REVIEW_TOKEN.BYTES).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + days * 86_400_000);
    return { token, tokenHash: hashToken(token), expiresAt };
  }

  /** 明文 → sha256 hex（`access_token_hash` 的长度 64 与之严格对应） */
  hashOf(token: string): string {
    return hashToken(token);
  }

  /**
   * 🔴 BE-03-SMS-TEMPLATE-02：生成一枚**师傅短码**（纯计算，不碰数据库）。
   *
   * 与 `mint()` 的关系：**同一套安全语义，不同长度的明文**。
   *   · 同样 `sha256` 后落库（列是 `short_code_hash`，与 `access_token_hash` 同宽 64）；
   *   · 同样由调用方在**同一事务**里写入 Visit（这里不写库，理由同 `mint()`）；
   *   · 同样 `ttlHours` —— **不得延长**既有授权期限。
   *
   * ⚠️ 明文只允许活在本次调用的内存里：落库只落 `codeHash`，
   *    发短信时用 `code` 拼链接，之后即丢弃。
   */
  mintCode(ttlHours: number): { code: string; codeHash: string; expiresAt: Date; link: string } {
    const hours = Number.isFinite(ttlHours) && ttlHours > 0 ? Math.trunc(ttlHours) : 72;
    const code = this.randomBytesFn(TECHNICIAN_SHORT_CODE.BYTES).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + hours * 3600 * 1000);
    return {
      code,
      codeHash: hashToken(code),
      expiresAt,
      link: `${this.baseUrl()}${TECHNICIAN_SHORT_CODE.LINK_PATH}${code}`,
    };
  }

  /** 拼作业链接。基址缺失时退化为**仅路径**并记 debug（配置问题由启动期警告暴露，不在这里阻断业务） */
  linkOf(token: string): string {
    const base = this.baseUrl();
    return `${base}${TECHNICIAN_TOKEN.LINK_PATH}${token}`;
  }

  // -------------------------------------------------------------------------
  // 门店手动转发码（BE-03-MANUAL-TECH-LINK）
  // -------------------------------------------------------------------------

  /**
   * 🔴 派生一枚**门店手动码**（纯函数，不碰数据库、不读库）。
   *
   * ```text
   *   base64url( HMAC-SHA256(SIGN_SECRET, "technician-manual|<visitId>|<salt>|<epoch>")[0..16] )
   * ```
   *
   * 为什么是派生而不是随机：
   *   需求要求**重复查看得到同一枚码**。随机数要满足这一点，就必须存明文或存可解容器 ——
   *   两者都违反"不保存凭证明文"。派生把"同一枚"变成 `(visitId, salt, epoch)` 的数学结果。
   *
   * ⚠️ 密钥缺失 ⇒ 返回 **null（fail-closed）**，绝不降级成空 key：
   *    那等于任何人都能算出别人的作业码。
   * ⚠️ `salt` 为空 ⇒ 同样返回 null。盐缺失时派生出来的码虽然仍不可猜，
   *    但"撤销"将失去手段（没有盐就没有族的概念），宁可不签发。
   */
  deriveManualCode(params: { visitId: number; salt: string; epoch: number }): string | null {
    const secret = signingSecretOf(process.env);
    if (!secret) return null;
    const visitId = Number(params.visitId);
    if (!Number.isFinite(visitId) || visitId <= 0) return null;
    const salt = String(params.salt ?? '').trim();
    if (!salt) return null;
    const epoch = Number.isFinite(Number(params.epoch))
      ? Math.max(0, Math.trunc(Number(params.epoch)))
      : 0;

    const message = `${TECHNICIAN_MANUAL_CODE.DOMAIN}|${visitId}|${salt}|${epoch}`;
    const digest = createHmac(TECHNICIAN_TOKEN.ALGORITHM, secret).update(message).digest();
    return digest.subarray(0, TECHNICIAN_MANUAL_CODE.BYTES).toString('base64url');
  }

  /** 手动码的明文 → sha256 hex（与 `manual_code_hash` 列严格对应，宽 64） */
  manualCodeHashOf(code: string): string {
    return hashToken(code);
  }

  /**
   * 生成一枚**新的随机盐**（用于首次签发手动码）。
   *
   * 盐的用途只有一个：让"同样的 visitId + 同样的 epoch"在两套环境下不产生相同的码，
   * 并让"重新签发一族"成为可能（改盐 = 换掉整族）。
   */
  newManualCodeSalt(): string {
    return this.randomBytesFn(TECHNICIAN_MANUAL_CODE.SALT_BYTES).toString('base64url');
  }

  /**
   * 只看**这条 Visit 的作业授权整体是否仍然有效**（不关心用哪把钥匙打开）。
   *
   * 为什么需要它（BE-03-MANUAL-TECH-LINK）：
   *   `svc:technicianLink` 要在"签发前"判断这条派工还能不能作业。
   *   最省事的写法是在 action 里手写 `if (expiresAt < now || revoked || used)` ——
   *   那就是**第二份状态判定**，而两份实现迟早漂移（且漂移的那份没有测试去红）。
   *   ⇒ 这里用 `verifyByHash(access_token_hash)` 走**同一段**判定：
   *     过期 / 已用 / 已吊销 / Visit 非 ASSIGNED / 工单非进行中，全部一次判完。
   *
   * ⚠️ 它**不返回明文**，也不签发任何东西 —— 只回答"这条派工现在还有效吗"，
   *    以及"原授权还剩多少小时"（供手动码 TTL 取 min，不延长授权）。
   *
   * @returns `ok:false` 时 `reason` 与 `verify()` 完全同义（EXPIRED / ALREADY_USED / …）
   */
  async verifyVisitAuthorization(visit: Record<string, any>): Promise<
    | { ok: true; ttlHours: number }
    | { ok: false; reason: string }
  > {
    const hash = String(visit?.access_token_hash ?? '').trim();
    if (!hash) {
      // 没有任何长 Token（provider-only / remote / 历史数据）⇒ 没有作业授权可继承。
      // 这不是"查询失败"，而是"这条 Visit 从来没被授权过作业"。
      return { ok: false, reason: 'NOT_FOUND' };
    }
    // ⚠️ `secret` 只用于日志指纹（`fingerprint('')` 是常量，不泄漏任何东西）。
    //    传真哈希会把"被查询的哈希前 8 位"写进日志 —— 日志里不该出现凭据材料。
    const result = await this.verifyByHash(hash, '', 'access_token_hash');
    if (result.ok !== true) {
      return { ok: false, reason: String((result as { reason?: unknown }).reason ?? 'NOT_FOUND') };
    }

    const expires = toDate(result.visit.token_expires_at);
    const ttlHours = expires
      ? Math.max(1, Math.ceil((expires.getTime() - this.now().getTime()) / 3_600_000))
      : TECHNICIAN_MANUAL_CODE.DEFAULT_TTL_HOURS;
    return { ok: true, ttlHours };
  }

  /** 拼手动码链接（与短信短码**同一个** H5 入口 `/p/t/`，不另开路由） */
  manualLinkOf(code: string): string {
    return `${this.baseUrl()}${TECHNICIAN_MANUAL_CODE.LINK_PATH}${code}`;
  }

  private baseUrl(): string {
    // ⚠️ Phase 11 / P11-1：对外地址改为**共用** `public-url.ts`。
    //    在它之前这里自己读 `PUBLIC_BASE_URL`，而门店二维码那条线会读
    //    `PUBLIC_H5_BASE_URL` —— 两份实现一旦漂移，就会出现"师傅链接是域名、
    //    二维码是 localhost"这类只在一部分功能上显形的错（而二维码印出去就收不回）。
    const raw = this.baseUrlOverride ?? publicBaseUrlOf();
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
    return this.verifyByHash(hashToken(token), token, 'access_token_hash');
  }

  /**
   * 🔴 BE-03-SMS-TEMPLATE-02：用**师傅短码**（22 位）换取它绑定的 Visit。
   *
   * 为什么不"把短码 302 到原 43 位 Token 接口"就完事：
   *   那要求短码表里存着 43 位明文（用来拼跳转地址），而明文落库是本项目明令禁止的；
   *   若不存，就只能每次解析时**重新签发**一枚 43 位 Token —— 那会让短码变成
   *   "可无限次兑换凭据"的万能钥匙，一次性语义直接消失。
   *   ⇒ 正确做法是让短码**自己成为一把钥匙**，开同一把锁（同一张 Visit、同一套状态判定）。
   *
   * 与 `verify()` 的差别只有两点：格式长度（22 vs 43）、查哪一列（`short_code_hash` vs
   * `access_token_hash`）。**判定顺序与结论完全共用 `verifyByHash()`** ——
   * 这不是"绕过 TokenService.verify()"，而是同一段授权逻辑的第二个入口。
   */
  async verifyByCode(rawCode: unknown): Promise<TokenVerifyResult> {
    const code = typeof rawCode === 'string' ? rawCode : '';
    if (!TECHNICIAN_SHORT_CODE.PATTERN.test(code)) {
      return this.invalid('MALFORMED', code);
    }
    return this.verifyByHash(hashToken(code), code, 'short_code_hash');
  }

  /**
   * 🔴 BE-03-MANUAL-TECH-LINK：用**门店手动码**（22 位）换取它绑定的 Visit。
   *
   * 这是 `/p/t/<code>` 的**第二个解析入口**，与 `verifyByCode()` 并列：
   *   · 形状完全相同（22 位 base64url）⇒ 无法从字符串判断"这是短信码还是手动码"，
   *     所以解析器必须**两种都试**（先短信码、再手动码，见 `technician/h5.ts`）；
   *   · 判定**完全共用** `verifyByHash()` —— 不另写一份"过期/已用/吊销/Visit/Ticket"。
   *
   * 为什么手动码能在 Visit 已提交后失效：因为 `ALREADY_USED` 判定读的是
   * `token_used_at`，那是**Visit 级**的（师傅提交一次，两把钥匙同时报废）。
   * 这正是需求第 7 条"已使用的作业任务不得再生成可操作的新链接"的落地方式 ——
   * 它不靠"再补一张表记手动码是否用过"，而是靠**本来就只有一个"用过"的事实**。
   */
  async verifyByManualCode(rawCode: unknown): Promise<TokenVerifyResult> {
    const code = typeof rawCode === 'string' ? rawCode : '';
    if (!TECHNICIAN_MANUAL_CODE.PATTERN.test(code)) {
      return this.invalid('MALFORMED', code);
    }
    return this.verifyByHash(hashToken(code), code, 'manual_code_hash');
  }

  /**
   * 三套凭据的**唯一**状态判定（长 Token / 短信短码 / 门店手动码只在"查哪一列"上不同）。
   *
   * ⚠️ 绝不要为某一套再写一份"过期→已用→吊销→Visit→Ticket"的判定：
   *    两份实现迟早漂移，而漂移的那一份不会有测试去红（它测的是自己那一份）——
   *    与 `_auth.ts` 文件头写的是同一条纪律。
   *
   * 🔴 BE-03-MANUAL-TECH-LINK 的硬约束在这里**自动成立**（不需要额外代码）：
   *    · 改派 / 取消 → 旧 Visit 变 SUPERSEDED ⇒ `VISIT_NOT_ACTIVE`；
   *      同时 `token_revoked_at` 被置位 ⇒ `REVOKED`。**两种链接一起失效**；
   *    · 师傅提交 → `token_used_at` 置位 ⇒ `ALREADY_USED`。两条都不再可用；
   *    · 工单闭环 → `TICKET_NOT_ACTIVE`。
   *    需求"改派、取消或原任务失效时，两种链接必须同时失效"因此是**结构性**的，
   *    而不是"记得在改派里也吊销一下手动码"那种需要人记性的约定。
   */
  private async verifyByHash(
    hash: string,
    secret: string,
    field: 'access_token_hash' | 'short_code_hash' | 'manual_code_hash',
  ): Promise<TokenVerifyResult> {
    const token = secret;
    const repository = this.db.getRepository('serviceVisits');
    let visit: any = null;
    try {
      visit = await repository.findOne({ filter: { [field]: hash } });
    } catch (error) {
      // 查库失败**不能**报成"Token 有效"，也不能报成业务原因 ——
      // 单独一个 reason 便于运维区分"链接坏了"与"库坏了"。
      this.logger?.warn?.(`[token] 校验时查库失败：${(error as Error)?.message}`);
      return this.invalid('LOOKUP_FAILED', token);
    }

    if (!visit) return this.invalid('NOT_FOUND', token);

    const now = this.now();
    /**
     * 🔴 **新凭据不得延长旧授权**（BE-03-SMS-TEMPLATE-02 / BE-03-MANUAL-TECH-LINK 共用）。
     *
     * 取"长 Token 到期时间"与"本凭据自己的到期时间"中**较早**的一个：
     *   · 正常签发时两者同一 `ttlHours` ⇒ 相等，无影响；
     *   · 若短码/手动码是后来补发的（或有人手工写了更晚的 exp），
     *     也绝不会比原授权活得更久 —— 这是"新凭据不得延长旧授权"的硬约束。
     * 长 Token 分支只看 `token_expires_at`（行为不变）。
     *
     * ⚠️ 手动码与短信短码**各自只看自己那一列**，不交叉比较：
     *    它们是并列的两把钥匙，谁先到期只收缩自己 ——
     *    若把手动码也纳入短信短码的比较，"门店复制一次链接"就会缩短短信链接，
     *    那正是用户明令禁止的"影响原短信链接有效性"。
     */
    const tokenExpires = toDate(visit.token_expires_at);
    const candidates: number[] = [];
    if (tokenExpires) candidates.push(tokenExpires.getTime());
    if (field === 'short_code_hash') {
      const codeExpires = toDate(visit.short_code_expires_at);
      if (codeExpires) candidates.push(codeExpires.getTime());
    } else if (field === 'manual_code_hash') {
      const manualExpires = toDate(visit.manual_code_expires_at);
      if (manualExpires) candidates.push(manualExpires.getTime());
    }
    const earliest = candidates.length ? Math.min(...candidates) : 0;
    if (!earliest || earliest <= now.getTime()) {
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

  /**
   * **一次性消费**：把 Visit 上的 Token 标记为已使用（M8 的"用后即焚"）。
   *
   * 与 `revoke()` 的区别（两列语义不同，别合并）：
   *   · `revoke()`  → `token_revoked_at/reason`：**被人为作废**（改派、取消、转店）。
   *     原因要留痕，因为客服要能回答"你是被改派了"。
   *   · `consume()` → `token_used_at`：**被正常用掉了**（师傅提交了回执）。
   *     没有"原因"这一维 —— 它只有一个原因：完成了作业。
   *
   * 返回值把"**这次**消费成功"（`consumed:true`）与"早就用过了"
   * （`consumed:false, alreadyUsed:true`）分开。为什么要分：
   *   ① 断言要用它 —— "重放得到 401 且**没有**再次写 Visit/Event"这句话里，
   *      "没有再次写"的取证点之一就是 `consumed` 为 false；
   *   ② 排障要用它 —— 客服问"师傅说提交了但门店没看到"时，
   *      要能区分"从没提交过"与"提交过、是后面某步失败了（已回滚）"。
   *   ⚠️ 但**不要**拿它当幂等键去"允许重放"：一次性 Token 本身就是提交边界，
   *      用过即废是设计（见 DEV 记录），不是需要绕过的限制。
   *
   * ⚠️ **必须在调用方的事务里执行**（与 Visit 的 `ASSIGNED → SUBMITTED`
   *    同一个事务）。分开做的后果很具体：
   *    ① 先 consume、后改 Visit —— Token 已废但 Visit 还是 ASSIGNED，
   *       师傅刷新页面会看到"链接无效"，而门店那边这张单还显示"待师傅作业"，
   *       两头对不上，且**没有任何自动恢复路径**；
   *    ② 先改 Visit、后 consume —— 若第二步失败，Visit 已 SUBMITTED
   *       而链接**依然可用**，任何人拿到这条链接都能再次进入作业页
   *       （虽然再提交会被条件 UPDATE 挡住，但读取与上传照片仍然放开）。
   *    所以它属于编排层的原子单元，见 `TicketService.technicianSubmit()`。
   */
  async consume(
    visitId: number | string,
    transaction?: unknown,
  ): Promise<{ consumed: boolean; alreadyUsed: boolean; usedAt: Date | null }> {
    const id = toPositiveInt(visitId, 'visitId');

    // 条件 UPDATE：`token_used_at IS NULL` 是"一次性"的**物理**判据。
    // 两个并发的提交请求里只有一个能拿到返回行 —— 另一个人影响 0 行。
    // 这比"先 SELECT 看有没有用过、再 UPDATE"可靠：后者是 check-then-act，
    // 两次读之间别人可能已经写完了。
    const [rows] = await this.rawQuery(
      `UPDATE service_visits
          SET token_used_at = now(), updated_at = now()
        WHERE id = $1 AND token_used_at IS NULL
        RETURNING id, token_used_at`,
      [id],
      transaction,
    );

    const row: any = Array.isArray(rows) ? rows[0] : undefined;
    if (row) return { consumed: true, alreadyUsed: false, usedAt: toDate(row.token_used_at) };

    // 影响 0 行 ⇒ 要么 Visit 不存在，要么此前已消费过。
    // 这里**只为了把返回值说清楚**（日志与排障要能区分"重放"与"没这条 Visit"），
    // 不参与任何决策 —— 决策已经由上面那条 UPDATE 做完了。
    const [existing] = await this.rawQuery(
      `SELECT id, token_used_at FROM service_visits WHERE id = $1`,
      [id],
      transaction,
    );
    const found: any = Array.isArray(existing) ? existing[0] : undefined;
    if (!found) return { consumed: false, alreadyUsed: false, usedAt: null };

    const usedAt = toDate(found.token_used_at);
    this.logger?.debug?.(`[token] visit=${id} 的 Token 此前已被消费（${usedAt?.toISOString()}）`);
    return { consumed: false, alreadyUsed: Boolean(usedAt), usedAt };
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
