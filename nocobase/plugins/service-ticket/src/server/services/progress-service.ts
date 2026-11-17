/**
 * progress-service —— 客户**服务进度查询**（P11-4 · C 条）
 *
 * ===========================================================================
 * 这套凭证与另外两套的关系（用户明令"必须分离"）
 * ===========================================================================
 * ```
 *   师傅作业 Token  /t/{token}   匿名 · 单条 Visit · 改派即废
 *   客户评价 Token  /f/{token}   匿名 · 一次性 · 不可撤销
 *   客户进度 Token  /p/{token}   匿名 · **可重复查** · **可撤销** · 关闭后保留 30 天
 * ```
 * 三者不共用列、不共用常量、不共用短链。共用的后果：
 * "查进度"顺手获得"评价资格"（越权），或"撤销进度"误伤已完成的评价。
 *
 * ===========================================================================
 * 输出裁剪是这份服务的主要工作
 * ===========================================================================
 * 客户**只**能看到：单号、门店名、状态与状态变迁时间、自己提交的内容、
 * 自己上传的媒体、门店留给他的完成说明、评价状态。
 * 客户**看不到**：内部操作人 ID、审计事件全文、师傅 Token、其他客户数据、
 * 内部备注 —— 所以时间线只取 `event_type/from_status/to_status/created_at`，
 * **不取** `summary`（含师傅姓名与改派细节）、`metadata_json`、`operator_*`。
 */
import crypto from 'node:crypto';
import { signStoreEntry, signingSecretOf } from './store-entry';
import { PROGRESS_DERIVE, PROGRESS_TOKEN, TICKET_STATUS_LABEL } from '../constants';
import { customerEventLabel, deriveProgress } from './progress-stage';

export interface ProgressServiceOptions {
  db: any;
  logger?: any;
  now?: () => Date;
}

export interface MintedProgress {
  token: string;
  /** 强制过期时间（可选；未关闭工单通常为 NULL） */
  expiresAt: Date | null;
}

export type ProgressResult =
  | { ok: true; view: Record<string, unknown> }
  | { ok: false; code: string; status: number; message: string };

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * 派生码的**索引哈希**（DEV-207）。
 *
 * 与 `sha256Hex()` 是同一个东西，单独命名是为了让调用点自解释：
 * `progress_code_hash` 列的内容必须永远由**这一个函数**产生 ——
 * 一旦写入侧和查询侧用了不同拼法（比如一侧带前缀一侧不带），
 * 表现是"码明明发出去了却查不到"，而且两边各自看起来都对。
 */
function deriveCodeHash(code: string): string {
  return sha256Hex(code);
}

/**
 * 派生码的形状判据 —— **与 `PROGRESS_DERIVE.PATTERN` 同源**。
 *
 * ⚠️ 为什么不直接用 `PROGRESS_DERIVE.PATTERN` 去问"这是不是派生码"：
 *    派生码与原始短码**同长度同字符集**（都是 22 位 base64url），形状上无法区分。
 *    这正是设计目的（nginx 正则、H5 路由、前端长度校验全都不用改），
 *    但也意味着"猜它是不是派生码"永远没有答案 —— 所以解析器必须**两种都试**。
 */
export class ProgressService {
  private readonly db: any;
  private readonly logger: any;
  private readonly now: () => Date;

  constructor(options: ProgressServiceOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------- 签发
  /**
   * **只生成**一对 (明文, 哈希)，不写库。
   *
   * 为什么需要这个拆分：匿名建单要把明文放进**响应体**（客户当场拿链接），
   * 而哈希必须与建单**同事务**落库 ⇒ action 层先拿这对值，建单时传哈希，
   * 响应时用明文。若让 mintForTicket 自己写库，action 层就再也拿不到明文。
   */
  mintStandalone(): { token: string; hash: string } {
    const token = crypto.randomBytes(PROGRESS_TOKEN.BYTES).toString('base64url');
    return { token, hash: sha256Hex(token) };
  }

  // ------------------------------------------------- A4：派生短码（客户进展通知）
  /**
   * 纯函数：按 (ticketId, salt, epoch) 重算派生短码。
   *
   * ```text
   *   HMAC-SHA256( SIGN_SECRET, "progress-code|" + ticketId + "|" + salt + "|" + epoch )
   *     → 取前 16 字节 → base64url → 22 位
   * ```
   *
   * ⚠️ **域分隔前缀不可省**：同一个 `SIGN_SECRET` 还用于门店入口签名（`k` 参数）
   *    与评价校验，没有 `progress-code|` 这一段就等于"同一把钥匙开三种锁"，
   *    一旦某处输入可被构造，跨域重放就有了可能。
   *
   * ⚠️ 密钥为空 ⇒ 返回 null（**fail-closed**）。绝不降级成"用空 key 派生"：
   *    那会让任何人都能算出别人的短码。
   */
  deriveCode(params: { ticketId: number; salt: string; epoch: number }): string | null {
    const secret = signingSecretOf(process.env);
    if (!secret) return null;
    const salt = String(params.salt ?? '').trim();
    if (!salt) return null;
    const epoch = Number.isFinite(Number(params.epoch)) ? Math.max(0, Math.trunc(Number(params.epoch))) : 0;
    const message = `${PROGRESS_DERIVE.DOMAIN}|${Number(params.ticketId)}|${salt}|${epoch}`;
    const digest = crypto.createHmac('sha256', secret).update(message).digest();
    return digest.subarray(0, PROGRESS_DERIVE.BYTES).toString('base64url');
  }

  /**
   * 取（必要时**先建**）某张工单的派生盐，并返回当前代数下的派生短码。
   *
   * 语义边界（A4 的七条子目标逐条对应）：
   *   · ① 原有进度码**不失效**：本方法只写 `progress_code_salt/epoch/hash`，
   *        **从不触碰** `progress_token_hash / revoked_at / expires_at`；
   *   · ② 后续进展通知能拿到有效 22 位 code：同 (id, salt, epoch) 永远得同一枚 ⇒
   *        幂等；不需要"再发一次就换一枚"；
   *   · ③ 库不存访问凭据明文：只存盐、代数与 `sha256(码)`，凭据本身随时重算；
   *   · ④ 派生码只有进度读取权：它只出现在 `resolveTicketId()` 的比对里，
   *         **不进** `service_visits.short_code_hash`，因此师傅接口永远认不出它；
   *   · ⑤ 不允许进入师傅作业接口：同上（结构上不可能，而不是靠判断）；
   *   · ⑥ 有效期沿用原口径：派生码**不带自己的 TTL**，只在解析时复用同一套
   *        撤销/过期/关闭后 30 天判定；
   *   · ⑦ 同一业务事件不重复生成或发送：幂等由 `SmsService.enqueue` 的
   *        `biz_id` 唯一键 + 本方法的稳定输出共同保证（见 ticket-service 的调用点）。
   *
   * DEV-207 起**额外**维护 `progress_code_hash`（索引键），保证解析是等值查找而非扫描。
   *
   * @param transaction **调用方所在的事务**（见下方"为什么必须有它"）
   */
  async ensureDerivedCode(ticketId: number, source: string, transaction?: unknown): Promise<string | null> {
    const id = Number(ticketId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const repo = this.db.getRepository('serviceTickets');

    let ticket = await repo.findOne({ filter: { id }, transaction });
    if (!ticket) return null;
    let plain: any = typeof ticket.toJSON === 'function' ? ticket.toJSON() : { ...ticket };

    if (!plain.progress_code_salt) {
      // 抢写：只有"这一行还没有盐"时才算成功（原子条件更新，不读-改-写）
      const salt = crypto.randomBytes(16).toString('base64url'); // 22 位，丢进 varchar(32)
      //
      // 🔴 **必须传 transaction，否则派工必然自死锁**（2026-11-06 实机踩到，约 12 分钟）。
      //
      //    现象：`POST /api/svc:dispatch` 挂满 60s 后 500，
      //          `SequelizeConnectionAcquireTimeoutError: Operation timeout`；
      //          pg_stat_activity 里有两条 `idle in transaction` + 一条
      //          `active / wait_event_type=Lock / transactionid` 的
      //          `UPDATE "service_tickets" SET "progress_code_salt"...`。
      //
      //    根因：`enqueueDispatchPair` 在 **TicketService 的事务里**被调用，
      //          而那条事务已经用 `SELECT ... FOR UPDATE` 拿住了这张工单的行锁；
      //          本方法若不传 transaction，就会**从连接池另借一条连接**去 UPDATE
      //          同一行 ⇒ 新连接等旧事务的行锁、旧事务等本方法返回 ⇒ **自死锁**，
      //          并且两条连接一起被占死，池子耗尽后所有请求 500。
      //
      //    这也说明为什么"只在本机试一下"不够：mock 通道下短信入队是同步走完的，
      //    平时看不到，直到工单恰好还没有盐（**首次派生**）才触发。
      const updated = await repo.update({
        filter: { id, progress_code_salt: null },
        values: { progress_code_salt: salt, progress_code_epoch: 0 },
        transaction,
      });
      const wrote = Array.isArray(updated) ? Number(updated[0] ?? 0) : Number(updated ?? 0);
      if (wrote > 0) {
        plain = { ...plain, progress_code_salt: salt, progress_code_epoch: 0 };
        this.logger?.info?.(
          `[progress] 工单 ${id} 首次派生客户进度短码（来源：${source}；salt ${salt.slice(0, 6)}…）`,
        );
      } else {
        // 被别人抢先写了 ⇒ 重读，用库里的那一枚（保证"同单同码"）
        ticket = await repo.findOne({ filter: { id }, transaction });
        if (!ticket) return null;
        plain = typeof ticket.toJSON === 'function' ? ticket.toJSON() : { ...ticket };
      }
    }

    const code = this.deriveCode({
      ticketId: id,
      salt: String(plain.progress_code_salt ?? ''),
      epoch: Number(plain.progress_code_epoch ?? 0),
    });
    if (!code) {
      this.logger?.error?.(
        `[progress] 工单 ${id} 无法派生客户进度短码：SIGN_SECRET 缺失（fail-closed，不发送）`,
      );
      return null;
    }

    // ---- DEV-207：把派生码的 sha256 落到索引列 ----
    //
    // 为什么在这里补写而不是只靠迁移回填：
    //   ① 迁移只处理"迁移那一刻已派生过的行"；之后新派生的单必须自己写；
    //   ② 迁移期可能因 SIGN_SECRET 与生产不一致而漏回填 —— 这里重算一次就能自愈，
    //      不需要人工介入（"下次用到时补齐"比"一次跑批卡住"更抗故障）；
    //   ③ 撤销后 epoch 变化 ⇒ code 变化 ⇒ hash 也必须跟着变，否则旧码仍能命中索引。
    //
    // 🔴 必须传 transaction：理由与上面抢写 salt 完全相同。
    //    这里若另借连接，派工事务持锁时会**第二次**自死锁 —— 而且比第一次更隐蔽，
    //    因为它只在"hash 与 code 不一致"时才执行（正常情况下是 no-op）。
    const hash = deriveCodeHash(code);
    if (String(plain.progress_code_hash ?? '') !== hash) {
      await repo.update({
        filter: { id },
        values: { progress_code_hash: hash },
        transaction,
      });
      plain = { ...plain, progress_code_hash: hash };
    }

    return code;
  }

  /**
   * 撤销这一族派生码（`epoch + 1`）。**不影响**原始进度 Token。
   *
   * 为什么需要它：派生码是"可重算"的 ⇒ 没有 epoch 就没有撤销能力，
   * 而 A4 明确要求"不得绕过原来的进度权限校验"。撤销语义必须与原始 Token
   * 分开（撤销进展通知链接不该让客户收藏的原始进度链接一起失效）。
   *
   * @param transaction **调用方事务**。撤销动作本身若在事务里，必须复用连接
   *   （两次 UPDATE 同表；另借连接同样会与调用方的行锁互等）。
   */
  async revokeDerivedCodes(ticketId: number, reason: string, transaction?: unknown): Promise<boolean> {
    const id = Number(ticketId);
    const repo = this.db.getRepository('serviceTickets');
    const ticket = await repo.findOne({ filter: { id }, transaction });
    if (!ticket) return false;
    const plain: any = typeof ticket.toJSON === 'function' ? ticket.toJSON() : { ...ticket };
    const current = Number(plain.progress_code_epoch ?? 0);
    if (current >= PROGRESS_DERIVE.MAX_EPOCH) {
      this.logger?.error?.(
        `[progress] 工单 ${id} 的派生码代数已达上限 ${PROGRESS_DERIVE.MAX_EPOCH}，无法再撤销` +
          '（需人工处置：重置 salt）',
      );
      return false;
    }

    const nextEpoch = current + 1;
    const salt = String(plain.progress_code_salt ?? '');

    // 🔴 撤销必须**同时**改 epoch 与 hash（DEV-207 / 用户验收第 8 条）。
    //
    //   如果只改 epoch 不改 hash，会发生什么？
    //     撤销时 epoch 0→1；旧码 C0 的 hash H0 仍留在索引里。
    //     此时把 epoch **重置回 0**（运维误操作、或"恢复"脚本），
    //     当前派生码又变回 C0 —— 而索引里 H0 一直都在，
    //     ⇒ **旧链接原地复活**，撤销等于没做。
    //   把 hash 一并换成 H1 之后，索引里不再有 H0：
    //     · 撤销态下用 C0 查 → 按 H0 查不到（索引里是 H1）→ 401；
    //     · epoch 被重置回 0 → 当前码又是 C0，但库里 hash 还是 H1
    //       ⇒ 仍然查不到 ⇒ 需要一次**显式重派生**才会重新写入 H0。
    //   这就是"不允许因 epoch 重置而意外复活"的落地方式：
    //   撤销是一个**不可逆的写**，不是一个可由外部状态推断的开关。
    const nextCode = this.deriveCode({ ticketId: id, salt, epoch: nextEpoch });
    const values: Record<string, unknown> = { progress_code_epoch: nextEpoch };
    if (nextCode) {
      values.progress_code_hash = deriveCodeHash(nextCode);
    } else {
      // 没有密钥就没法算新一代的 hash。此时**清空**索引键而不是留着旧值 ——
      // 留着旧值等于"撤销后旧码仍可命中"，那是比"暂时不可用"严重得多的错误。
      values.progress_code_hash = null;
      this.logger?.error?.(
        `[progress] 工单 ${id} 撤销时无法派生新一代短码（SIGN_SECRET 缺失）；` +
          '已清空索引键，派生码在密钥恢复前一律不可用',
      );
    }

    await repo.update({ filter: { id }, values, transaction });
    this.logger?.info?.(
      `[progress] 工单 ${id} 的派生进度短码已撤销（epoch ${current} → ${nextEpoch}；原因：${reason}）` +
        '（原始进度 Token 不受影响）',
    );
    return true;
  }

  /**
   * 给一张工单签发进度 Token（提交成功时调用）。
   *
   * 明文**只在这里返回一次**，库里只存 sha256。
   * 已签发过的工单再次调用 ⇒ 返回 null（不轮换：轮换会让已发出去的短信失效，
   * 而"重新签发"应由显式的撤销 + 重发流程做）。
   */
  async mintForTicket(ticketId: number): Promise<MintedProgress | null> {
    const repo = this.db.getRepository('serviceTickets');
    const ticket = await repo.findOne({ filter: { id: Number(ticketId) } });
    if (!ticket) return null;
    const plain: any = typeof ticket.toJSON === 'function' ? ticket.toJSON() : { ...ticket };
    if (plain.progress_token_hash) return null;

    const minted = this.mintStandalone();
    await repo.update({
      filter: { id: Number(ticketId) },
      values: { progress_token_hash: minted.hash, progress_token_revoked_at: null },
    });
    this.logger?.info?.(`[progress] 工单 ${ticketId} 已签发进度 Token（hash ${minted.hash.slice(0, 8)}…）`);
    return { token: minted.token, expiresAt: null };
  }

  // ---------------------------------------------------------------- 撤销
  async revoke(ticketId: number, reason: string): Promise<boolean> {
    const repo = this.db.getRepository('serviceTickets');
    const ticket = await repo.findOne({ filter: { id: Number(ticketId) } });
    if (!ticket) return false;
    const plain: any = typeof ticket.toJSON === 'function' ? ticket.toJSON() : { ...ticket };
    if (!plain.progress_token_hash || plain.progress_token_revoked_at) return false;
    await repo.update({
      filter: { id: Number(ticketId) },
      values: { progress_token_revoked_at: this.now() },
    });
    this.logger?.info?.(`[progress] 工单 ${ticketId} 的进度 Token 已撤销（原因：${reason}）`);
    return true;
  }

  // ---------------------------------------------------------------- 解析
  /**
   * 明文凭据 → 工单 id。**两种凭据共用同一个解析入口**（A4 的核心接缝）。
   *
   * ```text
   *   ① 原始进度 Token（22 位新 / 43 位历史）→ sha256 → progress_token_hash 精确命中
   *   ② A4 派生短码（22 位）                 → sha256 → progress_code_hash 精确命中（DEV-207）
   * ```
   *
   * 🔴 **失效判定只有一份**：两种凭据进来后走的是**同一段**撤销 / 过期 / 关闭后 30 天判断。
   *    派生码**没有**自己的 TTL（用户裁决⑥：沿用原进度查询期限）。
   *    这正是"与原有进度凭据保持隔离和兼容"的落地方式：
   *      · 隔离 —— 凭据种类不同、存储不同、撤销开关不同（epoch vs revoked_at）；
   *      · 兼容 —— 出这个函数的形状完全一样（`number | null`），
   *        所有调用方（进度读取、进度页评价、媒体读取）**一行都不用改**。
   *
   * 四种失效**都返回 null**（调用方统一回同一个响应，不区分原因）：
   *   ① 不存在 / 格式不对   ② 已撤销   ③ 已过强制过期   ④ 关闭超过保留期
   *
   * ⚠️ "关闭后保留 30 天"按**真实服务端时间**算：
   *    effective = min(progress_token_expires_at, closed_at + 30d)，
   *    未关闭的工单没有第二项 ⇒ 关闭前一直可查。
   */
  async resolveTicketId(token: string): Promise<number | null> {
    const text = String(token ?? '');
    if (!PROGRESS_TOKEN.PATTERN_ANY.test(text)) return null;  // 同时接受 22 位新 Token 与 43 位旧 Token
    const repo = this.db.getRepository('serviceTickets');
    const hash = sha256Hex(text);

    // ---- 两次**等值**查找，都由唯一索引支撑 ----
    //
    // DEV-207 之前这里的第二段是全表扫描（逐行 HMAC 比对，上界 5000）。
    // 现在两把钥匙都是"sha256 → 唯一索引等值命中"，复杂度与表规模**无关**。
    //
    // 两列不可能同时命中同一行（同一枚码既是原始 Token 又是派生码需要 sha256 碰撞），
    // 所以顺序无关紧要；这里用 Promise.all 并发取，省一次往返。
    const [byToken, byDerived] = await Promise.all([
      repo.findOne({ filter: { progress_token_hash: hash } }),
      repo.findOne({ filter: { progress_code_hash: hash } }),
    ]);

    const credentialKind: 'progress_token' | 'derived_code' = byToken ? 'progress_token' : 'derived_code';
    const ticket: any = byToken ?? byDerived;
    if (!ticket) {
      // 两种都不是 ⇒ 同样回 null（**不区分**"没这条工单"与"码不对"，防枚举）
      return null;
    }
    const plain: any = typeof ticket.toJSON === 'function' ? ticket.toJSON() : { ...ticket };

    // 🔴 撤销开关**按凭据种类分开**：
    //    撤销原始 Token（客户点"结束查询"）不得连带作废"进展通知里的链接"，
    //    撤销派生码（epoch+1）也不得让客户收藏的原始链接失效。
    //
    // ⚠️ 派生码这一支**不需要**在这里再判 epoch：`revokeDerivedCodes()` 已经
    //    把 `progress_code_hash` 换成了新代数的哈希 ⇒ 旧码在当前表里**根本查不到**。
    //    在这里再写一次 `epoch === current` 就是同一判据的第二份实现（铁律 ④），
    //    而且会在"hash 尚未回填"的行上产生误判。
    if (credentialKind === 'progress_token' && plain.progress_token_revoked_at) return null;

    const now = this.now().getTime();
    if (plain.progress_token_expires_at && new Date(plain.progress_token_expires_at).getTime() <= now) {
      return null;
    }
    if (plain.closed_at) {
      const retainUntil =
        new Date(plain.closed_at).getTime() + PROGRESS_TOKEN.RETAIN_DAYS_AFTER_CLOSE * 86_400_000;
      if (retainUntil <= now) return null;
    }
    return Number(plain.id);
  }

  /**
   * ⚠️ **已删除**：`matchDerivedCode()` 的全表扫描实现（A4 第一版，DEV-207）。
   *
   * 原来的做法是"取所有 `progress_code_salt IS NOT NULL` 的行，逐行重算 HMAC 再定长比对"，
   * 上界 `DERIVE_SCAN_CAP = 5000`。实测 5000 行 ≈ 14.5ms 且**线性增长**，触顶后
   * 派生码会整体失效（表现为 401，与"码错"无法区分）。
   *
   * 现在改为 `sha256(码) → progress_code_hash 唯一索引等值命中`，
   * 复杂度与表规模无关，**不存在**扫描上界。
   *
   * 为什么不保留它作"降级路径"：
   *   · 保留就等于"有两条解析实现"，一条对一条错（hash 未回填时扫描能命中、索引不能），
   *     这种不一致会永久存在且只在生产数据上显形 —— 正是铁律④说的"同一个坑有两条腿"；
   *   · 回填由迁移 + `ensureDerivedCode()` 的就地补齐双保险覆盖，
   *     不需要一条"慢但看起来能兜底"的路径。
   */

  /** 供媒体读取侧复用：Token 是否仍指向一个可读工单 */
  async isUsable(token: string): Promise<boolean> {
    return (await this.resolveTicketId(token)) != null;
  }

  // ---------------------------------------------------------------- 查询
  async getProgress(token: string): Promise<ProgressResult> {
    const ticketId = await this.resolveTicketId(token);
    if (ticketId == null) {
      return {
        ok: false,
        code: 'PROGRESS_TOKEN_INVALID',
        status: 401,
        message: '这个查询链接无效、已过期或已被撤销',
      };
    }

    const repo = this.db.getRepository('serviceTickets');
    const ticket = await repo.findOne({
      filter: { id: ticketId },
      appends: ['store'],
    });
    if (!ticket) {
      return { ok: false, code: 'TICKET_NOT_FOUND', status: 404, message: '服务单不存在' };
    }
    const t: any = typeof ticket.toJSON === 'function' ? ticket.toJSON() : { ...ticket };

    // 时间线：**只取**状态变迁与时间。刻意不取 summary / metadata_json / operator_*。
    const events =
      (await this.db.getRepository('ticketEvents').find({
        filter: { ticket_id: ticketId },
        sort: ['created_at', 'id'],
        limit: 200,
      })) ?? [];
    // 时间线：**按事件渲染，不按状态渲染**（UX-PROGRESS-01 真机整改）。
    //
    // 旧实现拿 `to_status` 当标题 ⇒ 派工 / 改派 / 跟进都推 PROCESSING，
    // 于是客户看到多条一模一样的"处理中"；而 to_status 为空的事件
    // 直接渲染成"只有时间没有文字"的空行。
    //
    // 现在：事件类型 → 客户可读事件名（progress-stage 的 CUSTOMER_EVENT_LABEL）；
    //      表里没有的（sms_sent / sms_failed / internal_note / follow_up /
    //      metadata_corrected 等内部事件）**整条不展示**，绝不留空标题。
    //      仍然不取 summary / metadata_json / operator_*。
    const timeline = events
      .map((e: any) => {
        const p: any = typeof e.toJSON === 'function' ? e.toJSON() : { ...e };
        const label = customerEventLabel(p.event_type);
        if (!label) return null;
        const toStatus = String(p.to_status ?? '');
        return {
          event: String(p.event_type ?? ''),
          event_label: label,
          // 兼容旧字段：既有门禁与旧前端只依赖 at / status
          status: toStatus,
          status_label: TICKET_STATUS_LABEL[toStatus as keyof typeof TICKET_STATUS_LABEL] ?? '',
          // DEV-209：NocoBase 的系统时间字段属性名是驼峰（createdAt / updatedAt），
          // 数据库列名才是 created_at。两种写法都兼容（自定义字段不受影响）。
          at: p.createdAt ?? p.created_at,
        };
      })
      .filter(Boolean);

    // ---------------------------------------------------------------- 阶段与师傅
    // UX-PROGRESS-01：客户不能只看到"处理中"，要看到**到哪一步了、现在谁在办**。
    //
    // ⚠️ 这里刻意**不**读 `serviceTickets.technician_name/mobile`：
    //    那是工单级冗余快照，改派后可能落后于最新一次 Visit。
    //    "当前是谁"只认 Visit（且跳过 SUPERSEDED / CANCELLED）。
    // ⚠️ 也刻意**不**从事件里推断当前师傅：事件只有历史，没有"现在"。
    const visits =
      (await this.db.getRepository('serviceVisits').find({
        filter: { ticket_id: ticketId },
        sort: ['visit_no', 'id'],
      })) ?? [];
    const visitRows = visits.map((v: any) => {
      const p: any = typeof v.toJSON === 'function' ? v.toJSON() : { ...v };
      return {
        visit_no: Number(p.visit_no ?? 0),
        visit_status: String(p.visit_status ?? ''),
        technician_name: p.technician_name ?? null,
        // ⚠️ 读进来只用于**判断有没有号码**；是否对客展示由 progress-stage 决定（当前恒不展示）
        technician_mobile: p.technician_mobile ?? null,
        assigned_at: p.assigned_at ?? null,
        submitted_at: p.submitted_at ?? null,
        store_confirmed_at: p.store_confirmed_at ?? null,
        superseded_at: p.superseded_at ?? null,
        expected_visit_at: p.expected_visit_at ?? null,
      };
    });
    const { progress, technician } = deriveProgress({
      ticket: {
        status: String(t.status ?? ''),
        created_at: t.createdAt ?? t.created_at,
        closed_at: t.closed_at ?? null,
        updated_at: t.updatedAt ?? t.updated_at,
      },
      visits: visitRows,
      events: events.map((e: any) => {
        const p: any = typeof e.toJSON === 'function' ? e.toJSON() : { ...e };
        return {
          event_type: p.event_type,
          to_status: p.to_status,
          at: p.createdAt ?? p.created_at,
        };
      }),
    });

    // 媒体：只回客户应见的元信息（id 用于受控读取，kind/mime/size/duration 用于展示）
    const medias =
      (await this.db.getRepository('customerMedias').find({
        filter: { ticket_id: ticketId },
        sort: ['sort_order', 'id'],
      })) ?? [];
    const media = medias.map((m: any) => {
      const p: any = typeof m.toJSON === 'function' ? m.toJSON() : { ...m };
      return {
        id: Number(p.id),
        kind: String(p.media_kind),
        mime: String(p.mime),
        size: Number(p.size),
        duration_ms: p.duration_ms == null ? null : Number(p.duration_ms),
      };
    });

    // 有效期（如实告诉客户"这个链接还能用到什么时候"）
    const closedAt = t.closed_at ? new Date(t.closed_at) : null;
    const retainUntil = closedAt
      ? new Date(closedAt.getTime() + PROGRESS_TOKEN.RETAIN_DAYS_AFTER_CLOSE * 86_400_000)
      : null;

    return {
      ok: true,
      view: {
        ticket_no: String(t.ticket_no ?? ''),
        /** 只回门店**名**，不回 code（内部编码） */
        store_name: String(t.store?.name ?? ''),
        /**
         * P6-HOTFIX-02 问题③：门店**售后服务电话**（`stores.contact_phone`）。
         * ⚠️ 必须来自工单的真实归属门店（`t.store`），**不接受**客户端传的 storeCode/storeId ——
         *    否则改一个 URL 参数就能看别家门店的电话。
         * 空值一律回 null，前端据此不渲染拨号按钮。
         */
        store_phone: ((): string | null => {
          const v = (t as any).store?.contact_phone;
          const s = v == null ? '' : String(v).trim();
          return s ? s : null;
        })(),
        /**
         * 门店**有效地址**（2026-11-14 R1：客户要能直接照着找上门）。
         * 同样只读工单真实归属门店；空值回 null，前端据此整行不渲染，
         * 不写地址未填写这种空占位。
         */
        store_address: ((): string | null => {
          const v = (t as any).store?.address;
          const s2 = v == null ? '' : String(v).trim();
          return s2 ? s2 : null;
        })(),
        /**
         * P6-HOTFIX-02 问题④：该门店的**合法报修入口凭据**（`k`），供「提交新工单」按钮使用。
         * 语义边界：能拿到这张工单进度的人，本来就有权再提交一单 ⇒ 下发该门店入口不扩大权限。
         * ⚠️ 只下发**门店级公开入口签名**，绝不下发签名主密钥或管理凭据。
         */
        entry_k: ((): string | null => {
          const code = String((t as any).store?.code ?? '').trim();
          if (!code) return null;
          try {
            return signStoreEntry(code, signingSecretOf(process.env));
          } catch {
            return null;
          }
        })(),
        status: String(t.status ?? ''),
        status_label: TICKET_STATUS_LABEL[String(t.status ?? '') as keyof typeof TICKET_STATUS_LABEL] ?? String(t.status ?? ''),
        // DEV-209：同上 —— 系统时间字段是 `createdAt/updatedAt`；`closed_at` 是**自定义字段**，
        // 属性名保持 snake，所以它一直是对的（这正是根因的反证）。
        created_at: t.createdAt ?? t.created_at,
        updated_at: t.updatedAt ?? t.updated_at,
        closed_at: t.closed_at ?? null,
        // 客户自己提交的内容（回显，便于确认"我交的是这个"）
        submitted: {
          ticket_type: String(t.ticket_type ?? ''),
          content: String(t.content ?? ''),
          customer_name: t.customer_name ?? null,
          service_address: t.service_address ?? null,
          appliance_category: t.appliance_category ?? null,
          brand_model: t.brand_model ?? null,
        },
        media,
        timeline,
        /**
         * UX-PROGRESS-01：**客户可理解的阶段**（5 个里程碑 + 取消分支）。
         * 只给"到哪一步了、现在等谁"，**不给百分比** —— 百分比没有真实分母，
         * 编一个只会让客户按错误预期等待。
         */
        progress,
        /**
         * 当前服务师傅（最小投影）。
         * 没有有效派工 ⇔ null；有派工但无对客电话 ⇔ phone=null + contact_hint。
         */
        technician,
        /** 门店留给客户的完成说明（内部备注不走这里） */
        completion_note: t.completion_note ?? null,
        /** 评价：只回状态。**不给评价 Token**（那套凭证走短信，与本链接分离） */
        review: {
          status: String(t.review_status ?? 'pending'),
          invited_via_sms: true,
          /**
           * 已评价时的**实际持久化评分**（E 组）：
           *   · 只在 `review_status='submitted'` 且库里有有效 1–5 时才给；
           *   · 否则为 null —— 前端据此**不显示**只读星级，避免"零分星"冒充评分。
           * 仍不返回 review token / 客户手机号 / 内部 ID。
           */
          rating:
            String(t.review_status ?? '') === 'submitted' &&
            Number.isFinite(Number(t.rating)) &&
            Number(t.rating) >= 1 &&
            Number(t.rating) <= 5
              ? Number(t.rating)
              : null,
          /**
           * 收费核对所需的最小事实（P6-E-NO-OTP-01）：
           *   · 只在"待评价且未评价"时给，其余一律 null（已关闭页面不再暴露账单信息）；
           *   · `required=true` ⇒ 客户必须在 H5 选"一致/不一致"；
           *   · `unknown=true` ⇒ 夹具/数据缺 Visit，服务端会 422 fail-closed，页面据此提示联系门店；
           *   · 金额只给 `confirmed_charge_amount`（客户自己的应付额），不含内部字段。
           */
          charge: (() => {
            const pending =
              String(t.status ?? '') === 'WAIT_FEEDBACK' && String(t.review_status ?? '') === 'pending';
            if (!pending) return null;
            const fid = Number(t.feedback_visit_id ?? 0);
            const row: any = fid
              ? (visits as any[])
                  .map((v: any) => (typeof v.toJSON === 'function' ? v.toJSON() : { ...v }))
                  .find((p: any) => Number(p.id) === fid) ?? null
              : null;
            if (!row) return { required: false, unknown: true, amount: null };
            return row.is_charged === true
              ? { required: true, unknown: false, amount: row.confirmed_charge_amount ?? null }
              : { required: false, unknown: false, amount: null };
          })(),
        },
        /** 链接有效期：未关闭 ⇒ null（关闭前一直有效）；已关闭 ⇒ 关闭 + 30 天 */
        queryable_until: retainUntil ? retainUntil.toISOString() : null,
        closed: closedAt != null,
      },
    };
  }
}
