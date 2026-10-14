/**
 * media-store —— 客户媒体的**会话、私有存储、绑定与受控读取**（P11-4 · B/C 条）
 *
 * ===========================================================================
 * 这份服务要同时满足的六条硬约束（用户 2026-10-13 冻结契约）
 * ===========================================================================
 * ① **独立会话**：媒体先挂会话，提交时才绑工单 —— 于是"未完成上传"
 *    能被精确定位（session 有值而 ticket 为 NULL）并清理；
 * ② **私有存储**：文件落 `UPLOAD_PRIVATE_DIR`，`storage_key` 永不对外；
 * ③ **有效工单关联**：绑定是原子的（同一事务里改 session 与 media）；
 * ④ **失败重试不重复**：同会话同内容重复上传 ⇒ 复用既有行（幂等）；
 * ⑤ **未完成上传清理**：过期会话的文件被物理删除（P11-7 的到期清理
 *    在这里提供 `purgeExpired()` 入口，本轮只做"可发现 + 可执行"）；
 * ⑥ **读取受控**：只按会话 token 或进度 token 放行，不生成公开 URL。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CUSTOMER_MEDIA, MEDIA_SESSION_STATUS } from '../constants';
import {
  MediaFormatError,
  sniffCustomerMedia,
  summariseContainerStructure,
} from './media-format';

export interface MediaStoreOptions {
  db: any;
  logger?: any;
  /** 私有存储根目录（.env 的 UPLOAD_PRIVATE_DIR） */
  privateDir?: string;
  /** 单文件字节上限 */
  maxFileBytes?: number;
  /** 会话 TTL（分钟） */
  sessionTtlMinutes?: number;
  /** 会话内媒体总数上限 */
  sessionMaxItems?: number;
  /** 图片归一化管线（PhotoService 实例）—— 图片与师傅照片共用同一段 */
  photos?: {
    normalizeImage(input: {
      buffer: Buffer;
      declaredMime?: string | null;
      context?: string;
      maxSizeBytes: number;
    }): Promise<{
      data: Buffer;
      mime: string;
      ext: string;
      width: number;
      height: number;
      stripped: string[];
      exifOrientation: number | null;
      rotatedFrom: number | null;
    }>;
  };
  /**
   * **进度 Token → 工单 id** 的解析（P11-4 · C 条）。
   *
   * ⚠️ 判据**只有一份**，放在 `progress-service.ts`（它同时服务进度查询与媒体读取）。
   *    这里用注入而不是自己再查一遍 `service_tickets.progress_token_hash` ——
   *    自己查一份就等于"两处判据"，将来一边加了撤销校验、另一边忘了，
   *    就会出现"进度查不了、媒体还能看"的窗口。
   *    返回 null = Token 无效/过期/已撤销/工单不存在。
   */
  resolveProgressTicket?: (token: string) => Promise<number | null>;
  now?: () => Date;
}

export interface CreatedSession {
  sessionId: number;
  /** 明文会话 token —— **只在创建响应里出现一次**，库里只有哈希 */
  token: string;
  expiresAt: Date;
}

export interface StoredMedia {
  id: number;
  kind: 'image' | 'audio' | 'video';
  mime: string;
  size: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  sortOrder: number;
  /** 是否复用了此前已上传的同一内容（幂等表现） */
  reused: boolean;
}

const DEFAULT_PRIVATE_DIR = '/app/nocobase/storage/uploads-private';

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export class MediaStoreService {
  private readonly db: any;
  private readonly logger: any;
  private readonly root: string;
  private readonly maxFileBytes: number;
  private readonly ttlMinutes: number;
  private readonly maxItems: number;
  private readonly photos?: MediaStoreOptions['photos'];
  private readonly resolveProgressTicket?: (token: string) => Promise<number | null>;
  private readonly now: () => Date;

  constructor(options: MediaStoreOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.root = options.privateDir ?? process.env.UPLOAD_PRIVATE_DIR ?? DEFAULT_PRIVATE_DIR;
    this.maxFileBytes = options.maxFileBytes ?? CUSTOMER_MEDIA.MAX_FILE_BYTES;
    this.ttlMinutes = options.sessionTtlMinutes ?? CUSTOMER_MEDIA.SESSION_TTL_MINUTES;
    this.maxItems = options.sessionMaxItems ?? CUSTOMER_MEDIA.SESSION_MAX_ITEMS;
    this.photos = options.photos;
    this.resolveProgressTicket = options.resolveProgressTicket;
    this.now = options.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------- 路径安全
  /**
   * 解析私有目录内的绝对路径，**拒绝任何逃逸尝试**。
   * 与 PhotoService.resolveInsideRoot 同一套判据（同一条腿）。
   */
  private resolveInsideRoot(storageKey: string): string {
    const root = path.resolve(this.root);
    const abs = path.resolve(root, storageKey);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new MediaFormatError('PATH_ESCAPE', '存储路径不合法', 500);
    }
    return abs;
  }

  // ---------------------------------------------------------------- 会话
  async createSession(input: { ipHash?: string | null } = {}): Promise<CreatedSession> {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + this.ttlMinutes * 60_000);
    const row = await this.db.getRepository('customerMediaSessions').create({
      values: {
        session_token_hash: sha256Hex(token),
        status: MEDIA_SESSION_STATUS.OPEN,
        media_kind: 'mixed',
        expires_at: expiresAt,
        upload_ip_hash: input.ipHash ?? null,
      },
    });
    this.logger?.info?.(
      `[media] 新建上传会话 #${row.id}（TTL ${this.ttlMinutes} 分钟，到期 ${expiresAt.toISOString()}）`,
    );
    return { sessionId: Number(row.id), token, expiresAt };
  }

  /** 按明文 token 找会话；不存在/过期/非 open 一律返回 null（调用方统一答"会话不可用"） */
  async resolveOpenSession(token: string): Promise<any | null> {
    const hash = sha256Hex(String(token ?? ''));
    if (!hash) return null;
    const row = await this.db.getRepository('customerMediaSessions').findOne({
      filter: { session_token_hash: hash },
    });
    if (!row) return null;
    const plain: any = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
    if (String(plain.status) !== MEDIA_SESSION_STATUS.OPEN) return null;
    if (new Date(plain.expires_at).getTime() <= this.now().getTime()) {
      // 惰过期：查到过期的顺手标一下（不删文件，删文件走 purgeExpired）
      await this.db
        .getRepository('customerMediaSessions')
        .update({ filter: { id: Number(plain.id) }, values: { status: MEDIA_SESSION_STATUS.EXPIRED } })
        .catch(() => {});
      return null;
    }
    return plain;
  }

  // ---------------------------------------------------------------- 上传
  /**
   * 往会话里写一个媒体文件。
   *
   * 幂等：同会话内**内容完全相同**的重复上传 ⇒ 返回既有行（`reused: true`），
   * 不插入第二条。这覆盖双击、弱网重试、页面重开后重新选择同一文件。
   */
  async uploadToSession(input: {
    token: string;
    buffer: Buffer;
    declaredMime?: string | null;
    originalName?: string | null;
    /** 客户端声称的时长 —— **只作日志对照**，判定一律以容器解析为准 */
    declaredDurationMs?: number | null;
    /**
     * 浏览器给出的采集类型（`audio` / `video`）。
     * ⚠️ 仅用于 webm **判不出**音视频时（真实 MediaRecorder 产物没有 Tracks）。
     *    容器能判定时以容器为准 —— 伪造它不能改变容器判定。
     */
    declaredKind?: 'audio' | 'video' | null;
    ipHash?: string | null;
  }): Promise<StoredMedia> {
    const session = await this.resolveOpenSession(input.token);
    if (!session) {
      throw new MediaFormatError('SESSION_UNAVAILABLE', '上传会话不存在、已过期或已提交，请重新开始', 409);
    }
    const sessionId = Number(session.id);
    const buf = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer ?? []);

    // ⓪ 大小（在任何解析之前）
    if (buf.length === 0) throw new MediaFormatError('EMPTY_FILE', '上传内容为空', 422);
    if (buf.length > this.maxFileBytes) {
      throw new MediaFormatError(
        'FILE_TOO_LARGE',
        `单个文件不能超过 ${Math.floor(this.maxFileBytes / 1024 / 1024)}MB`,
        413,
      );
    }

    // ⓵ 数量上限（按"已有行数"判，不按请求次数判 ⇒ 重试不占额度）
    const existingCount = Number(
      (
        await this.db.getRepository('customerMedias').find({
          filter: { session_id: sessionId },
          fields: ['id'],
        })
      )?.length ?? 0,
    );
    if (existingCount >= this.maxItems) {
      throw new MediaFormatError(
        'SESSION_ITEM_LIMIT',
        `一次最多上传 ${this.maxItems} 个文件，请先去掉不需要的`,
        409,
      );
    }

    // ⓶ 类型 + 时长（magic bytes + 容器解析）
    let sniffed: ReturnType<typeof sniffCustomerMedia>;
    try {
      sniffed = sniffCustomerMedia(buf, 'mixed', input.declaredKind ?? null);
    } catch (error) {
      // 🔴 解析失败**必须留下可诊断的痕迹**（用户要求"不猜根因"）。
      //    只记**容器结构**（box 类型 / timescale / duration / track 类型 + 前 12 字节 magic），
      //    **不含**媒体采样数据与任何客户文本。
      const e = error as { code?: string };
      this.logger?.warn?.(
        `[media] 解析失败 code=${e?.code ?? '?'} 声明mime=${input.declaredMime ?? '?'} ` +
          `size=${buf.length} 结构=${summariseContainerStructure(buf)}`,
      );
      throw error;
    }

    // ⓷ 契约时长上限
    if (sniffed.kind === 'audio' && (sniffed.durationMs ?? 0) > CUSTOMER_MEDIA.AUDIO_MAX_MS) {
      throw new MediaFormatError('AUDIO_TOO_LONG', '语音最长 60 秒，请重新录制', 413);
    }
    if (sniffed.kind === 'video' && (sniffed.durationMs ?? 0) > CUSTOMER_MEDIA.VIDEO_MAX_MS) {
      throw new MediaFormatError('VIDEO_TOO_LONG', '视频最长 30 秒，请重新录制', 413);
    }

    // ⓸ 图片数量上限（1~3 张）
    if (sniffed.kind === 'image') {
      const imageCount = Number(
        (
          await this.db.getRepository('customerMedias').find({
            filter: { session_id: sessionId, media_kind: 'image' },
            fields: ['id'],
          })
        )?.length ?? 0,
      );
      if (imageCount >= CUSTOMER_MEDIA.IMAGE_MAX_COUNT) {
        throw new MediaFormatError(
          'IMAGE_COUNT_LIMIT',
          `图片最多 ${CUSTOMER_MEDIA.IMAGE_MAX_COUNT} 张，请先去掉不需要的`,
          409,
        );
      }
    }

    // ⓹ 落盘。图片走**共用归一化管线**（剥 EXIF/转正），音视频原样落盘
    //    （它们的容器里没有需要剥离的个人元数据；WAV/EBML 均无 GPS 段）。
    let data = buf;
    let mime = sniffed.mime;
    let ext = sniffed.ext;
    let width: number | null = null;
    let height: number | null = null;

    if (sniffed.kind === 'image') {
      if (!this.photos) {
        throw new MediaFormatError('PHOTO_PIPELINE_UNAVAILABLE', '图片处理服务不可用', 500);
      }
      const norm = await this.photos.normalizeImage({
        buffer: buf,
        declaredMime: input.declaredMime,
        context: `session=${sessionId}`,
        maxSizeBytes: this.maxFileBytes,
      });
      data = norm.data;
      mime = norm.mime;
      ext = norm.ext;
      width = norm.width;
      height = norm.height;
    }

    const contentHash = sha256Hex(data);
    const storageKey = `customer/${sessionId}/${contentHash.slice(0, 16)}.${ext}`;
    const absPath = this.resolveInsideRoot(storageKey);

    // ⓺ 幂等：同会话同内容 ⇒ 复用既有行（先查后写；DB 上的
    //    unique(session_id, storage_key) 是并发兜底）
    const dup = await this.db.getRepository('customerMedias').findOne({
      filter: { session_id: sessionId, storage_key: storageKey },
    });
    if (dup) {
      const dupPlain: any = typeof dup.toJSON === 'function' ? dup.toJSON() : { ...dup };
      this.logger?.info?.(
        `[media] 会话 ${sessionId} 重复上传同一内容 ⇒ 复用既有媒体 #${dupPlain.id}（不新增行）`,
      );
      return {
        id: Number(dupPlain.id),
        kind: dupPlain.media_kind,
        mime: String(dupPlain.mime),
        size: Number(dupPlain.size),
        durationMs: dupPlain.duration_ms == null ? null : Number(dupPlain.duration_ms),
        width: dupPlain.width == null ? null : Number(dupPlain.width),
        height: dupPlain.height == null ? null : Number(dupPlain.height),
        sortOrder: Number(dupPlain.sort_order ?? 0),
        reused: true,
      };
    }

    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    // 'wx'：已存在则失败而不是覆盖（与 PhotoService 同一约束）
    await fs.promises.writeFile(absPath, data, { flag: 'wx' }).catch(async (err: any) => {
      if (err && err.code === 'EEXIST') return; // 同内容已落盘：内容寻址，安全
      throw err;
    });

    const sortOrder = existingCount;
    const row = await this.db.getRepository('customerMedias').create({
      values: {
        session_id: sessionId,
        ticket_id: null,
        media_kind: sniffed.kind,
        storage_key: storageKey,
        mime,
        size: data.length,
        duration_ms: sniffed.durationMs,
        width,
        height,
        original_name: input.originalName ? String(input.originalName).slice(0, 255) : null,
        sort_order: sortOrder,
        uploaded_at: this.now(),
        upload_ip_hash: input.ipHash ?? null,
      },
    });

    // 会话计数（只作展示与风控，不作为判重依据）
    await this.db
      .getRepository('customerMediaSessions')
      .update({
        filter: { id: sessionId },
        values: {
          upload_count: existingCount + 1,
          upload_bytes: Number(session.upload_bytes ?? 0) + data.length,
        },
      })
      .catch(() => {});

    this.logger?.info?.(
      `[media] 会话 ${sessionId} 存入 #${row.id}：${mime} ${data.length}B` +
        (sniffed.durationMs != null ? ` ${sniffed.durationMs}ms` : '') +
        (width ? ` ${width}x${height}` : ''),
    );

    return {
      id: Number(row.id),
      kind: sniffed.kind,
      mime,
      size: data.length,
      durationMs: sniffed.durationMs,
      width,
      height,
      sortOrder,
      reused: false,
    };
  }

  /** 会话里当前有多少个媒体（提交前校验"文字或媒体至少一种"用） */
  async countForSession(sessionId: number): Promise<number> {
    const rows =
      (await this.db.getRepository('customerMedias').find({
        filter: { session_id: Number(sessionId) },
        fields: ['id'],
      })) ?? [];
    return rows.length;
  }

  /**
   * 会话 token 是否**当前可用**（open 且未过期）。
   *
   * 与 `resolveOpenSession` 的差别：这个**不惰过期**（不写库），
   * 因为它在匿名建单的热路径上，写库会让一次提交尝试产生副作用。
   */
  async sessionUsable(token: string): Promise<boolean> {
    const hash = sha256Hex(String(token ?? ''));
    if (!hash) return false;
    const row = await this.db.getRepository('customerMediaSessions').findOne({
      filter: { session_token_hash: hash },
    });
    if (!row) return false;
    const plain: any = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
    if (String(plain.status) !== MEDIA_SESSION_STATUS.OPEN) return false;
    return new Date(plain.expires_at).getTime() > this.now().getTime();
  }

  // ---------------------------------------------------------------- 凭证解析
  /** 按明文 token 找会话（**不限状态**——读取侧要能读"已绑定"的会话） */
  private async findSessionByToken(token: string): Promise<any | null> {
    const hash = sha256Hex(String(token ?? ''));
    if (!hash) return null;
    const row = await this.db.getRepository('customerMediaSessions').findOne({
      filter: { session_token_hash: hash },
    });
    if (!row) return null;
    const plain: any = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
    return plain;
  }

  /**
   * 这个媒体**能不能被当前凭证持有者读取**。
   *
   * 两条独立路径，任一通过即放行：
   *   ① 会话 token：媒体必须属于该会话，且会话仍是 open/bound
   *      （expired/voided 的文件已被或即将被清理，不放行）；
   *   ② 进度 token：媒体必须属于该 Token 对应的工单（Token 的有效性
   *      由注入的 resolveProgressTicket 判据决定，那份判据同时服务进度查询）。
   *
   * ⚠️ 两种"不给看"（不存在 / 无权限）都返回 false，由调用方回**同一个** 404 ——
   *    不构成"这个 media id 存在吗"的探测器。
   */
  async assertReadable(input: {
    mediaId: number;
    sessionToken: string | null;
    progressToken: string | null;
  }): Promise<boolean> {
    const media = await this.db.getRepository('customerMedias').findOne({ filter: { id: Number(input.mediaId) } });
    if (!media) return false;
    const m: any = typeof media.toJSON === 'function' ? media.toJSON() : { ...media };

    if (input.sessionToken) {
      const session = await this.findSessionByToken(input.sessionToken);
      if (session && Number(m.session_id) === Number(session.id)) {
        const status = String(session.status);
        if (status === MEDIA_SESSION_STATUS.OPEN || status === MEDIA_SESSION_STATUS.BOUND) return true;
      }
    }

    if (input.progressToken && this.resolveProgressTicket) {
      const ticketId = await this.resolveProgressTicket(input.progressToken);
      if (ticketId != null && Number(m.ticket_id) === ticketId) return true;
    }

    return false;
  }

  // ---------------------------------------------------------------- 绑定
  /**
   * 把会话里的全部媒体**原子绑定**到工单，并把会话标记为 bound。
   *
   * 为什么要一个事务：客户提交时"建工单 + 绑媒体"必须同时成立。
   * 若媒体绑了而工单没建成 ⇒ 出现无主媒体（正是要避免的）；
   * 工单建成而媒体没绑 ⇒ 客户以为材料交了，门店看不到。
   */
  async bindToTicket(sessionId: number, ticketId: number): Promise<number> {
    const sequelize = this.db.sequelize;
    const transaction = await sequelize.transaction();
    try {
      const sessions = this.db.getRepository('customerMediaSessions');
      const medias = this.db.getRepository('customerMedias');
      const session = await sessions.findOne(
        { filter: { id: sessionId } },
        { transaction },
      );
      if (!session) {
        await transaction.rollback();
        throw new MediaFormatError('SESSION_NOT_FOUND', '上传会话不存在', 404);
      }
      const plain: any = typeof session.toJSON === 'function' ? session.toJSON() : { ...session };
      if (String(plain.status) === MEDIA_SESSION_STATUS.BOUND) {
        await transaction.rollback();
        throw new MediaFormatError('SESSION_ALREADY_BOUND', '这个上传会话已经提交过了', 409);
      }
      const rows = await medias.find({ filter: { session_id: sessionId } }, { transaction });
      const ids = (rows ?? []).map((r: any) => Number(r.id));
      if (ids.length > 0) {
        await medias.update(
          { filter: { id: { $in: ids } }, values: { ticket_id: ticketId } },
          { transaction },
        );
      }
      await sessions.update(
        {
          filter: { id: sessionId },
          values: { status: MEDIA_SESSION_STATUS.BOUND, ticket_id: ticketId, bound_at: this.now() },
        },
        { transaction },
      );
      await transaction.commit();
      this.logger?.info?.(
        `[media] 会话 ${sessionId} 绑定到工单 ${ticketId}：${ids.length} 个媒体`,
      );
      return ids.length;
    } catch (error) {
      if (!(error instanceof MediaFormatError)) {
        await transaction.rollback().catch(() => {});
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------- 读取
  /**
   * 受控读取：返回绝对路径与**库里记录的** MIME。
   *
   * 🔴 **不校验权限** —— 权限由调用方（action 层）按会话 token / 进度 token 判。
   *    这里只负责"行在不在、文件在不在、路径是否越界"。
   */
  async read(mediaId: number | string): Promise<{ absPath: string; mime: string; size: number } | null> {
    const row = await this.db.getRepository('customerMedias').findOne({ filter: { id: Number(mediaId) } });
    if (!row) return null;
    const plain: any = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
    const absPath = this.resolveInsideRoot(String(plain.storage_key));
    try {
      const stat = await fs.promises.stat(absPath);
      if (!stat.isFile()) return null;
    } catch {
      return null;
    }
    return { absPath, mime: String(plain.mime), size: Number(plain.size) || stat_size(plain) };
  }

  /** 按工单取媒体（进度查询页展示用；只回客户应见的元信息，不回 storage_key） */
  async listForTicket(ticketId: number): Promise<Array<Record<string, unknown>>> {
    const rows =
      (await this.db.getRepository('customerMedias').find({
        filter: { ticket_id: Number(ticketId) },
        sort: ['sort_order', 'id'],
      })) ?? [];
    return rows.map((r: any) => {
      const p: any = typeof r.toJSON === 'function' ? r.toJSON() : { ...r };
      return {
        id: Number(p.id),
        kind: String(p.media_kind),
        mime: String(p.mime),
        size: Number(p.size),
        durationMs: p.duration_ms == null ? null : Number(p.duration_ms),
        width: p.width == null ? null : Number(p.width),
        height: p.height == null ? null : Number(p.height),
        uploadedAt: p.uploaded_at,
      };
    });
  }

  // ---------------------------------------------------------------- 清理
  /**
   * 清理**过期且未绑定**的会话及其文件（P11-4 B 条"未完成上传清理"）。
   *
   * 只删：`status=expired`（或已到 expires_at 且仍是 open）且 `ticket_id IS NULL`。
   * 已绑定工单的媒体**永不被这里碰** —— 那是业务数据。
   *
   * 返回删除了几个会话、几个文件、多少字节（供清理任务记日志与门禁断言）。
   */
  async purgeExpired(): Promise<{ sessions: number; files: number; bytes: number }> {
    const now = this.now();
    const sessions = this.db.getRepository('customerMediaSessions');
    const medias = this.db.getRepository('customerMedias');

    // ① 先把到期的 open 会话标 expired
    const stale = (await sessions.find({ filter: { status: MEDIA_SESSION_STATUS.OPEN } })) ?? [];
    let marked = 0;
    for (const s of stale) {
      const p: any = typeof s.toJSON === 'function' ? s.toJSON() : { ...s };
      if (new Date(p.expires_at).getTime() <= now.getTime()) {
        await sessions.update({ filter: { id: Number(p.id) }, values: { status: MEDIA_SESSION_STATUS.EXPIRED } });
        marked += 1;
      }
    }

    // ② 收集可删媒体：会话已过期/作废 且 未绑定工单
    const dead =
      (await sessions.find({
        filter: { status: { $in: [MEDIA_SESSION_STATUS.EXPIRED, MEDIA_SESSION_STATUS.VOIDED] } },
      })) ?? [];
    const deadIds = dead
      .map((s: any) => Number((typeof s.toJSON === 'function' ? s.toJSON() : { ...s }).id))
      .filter((id: number) => Number.isFinite(id) && id > 0);

    let files = 0;
    let bytes = 0;
    if (deadIds.length > 0) {
      const rows = (await medias.find({ filter: { session_id: { $in: deadIds }, ticket_id: null } })) ?? [];
      for (const r of rows) {
        const p: any = typeof r.toJSON === 'function' ? r.toJSON() : { ...r };
        const abs = this.resolveInsideRoot(String(p.storage_key));
        try {
          const stat = await fs.promises.stat(abs);
          await fs.promises.unlink(abs);
          files += 1;
          bytes += stat.size;
        } catch {
          /* 文件本来就不在：按已删处理（行仍要删） */
          files += 1;
        }
        await medias.destroy({ filter: { id: Number(p.id) } });
      }
      // 空目录顺手收掉（失败无所谓）
      for (const id of deadIds) {
        await fs.promises.rm(path.resolve(this.root, 'customer', String(id)), { recursive: true, force: true }).catch(() => {});
      }
    }
    this.logger?.info?.(
      `[media] 清理过期上传：标记 ${marked} 个会话，删除 ${files} 个文件（${bytes} 字节）`,
    );
    return { sessions: marked, files, bytes };
  }
}

/** 兜底：size 缺失时用文件大小（理论上不会发生，列是 NOT NULL） */
function stat_size(row: any): number {
  return Number(row?.size ?? 0) || 0;
}
