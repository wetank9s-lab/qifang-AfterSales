/**
 * PhotoService —— 上门照片的**唯一**落盘与读取入口（Phase 5 / P5-1）。
 *
 * ---------------------------------------------------------------------------
 * 五条安全口径（`docs/SECURITY.md` §3 的落地实现，逐条对应代码）
 * ---------------------------------------------------------------------------
 *  ① **私有存储**：文件写到 `UPLOAD_PRIVATE_DIR`（默认
 *     `/app/nocobase/storage/uploads-private`），它在 nginx 可服务的文档根
 *     （`storage/uploads`）**之外**。nginx 里没有它的 alias，NocoBase 的
 *     static 中间件也不会去那里找文件 —— 也就是说**没有任何一条 URL 能直接读到它**，
 *     唯一通路是本文件末尾的 `read()`，由 action 层带 Token 鉴权后调用。
 *     ⚠️ 它有两点容易被改坏：把目录指到 `storage/uploads` 下（瞬间变公网可读），
 *        或给 nginx 加一条 alias（注释里明确禁止）。两个反向用例都在
 *        `scripts/verify-technician-upload.mjs` 里。
 *
 *  ② **magic bytes 判定，不信任何声明**：类型由 `sniffImage()` 从**字节**判定，
 *     与请求里的 `Content-Type`、文件名后缀**完全无关**。落盘扩展名也取自判定结果。
 *     一个叫 `photo.jpg` 的 PHP 脚本会被判为"不是图片"直接拒绝，
 *     而且**根本不会落盘**（校验在写文件之前）。
 *
 *  ③ **去 EXIF/GPS**：落盘的是 `stripImageMetadata()` 的产物（段级剥离，
 *     像素不变）。见 `shared/media-guard.ts` 顶部关于"为什么不是重编码"的完整说明。
 *
 *  ④ **受控读取**：读取走 action 层的 `photo` handler，先过 Token 认证、
 *     再断言"这张照片属于这个 Visit"。本服务的 `read()` **不做鉴权**
 *     （它只认 id），因此它是**仅供已鉴权调用方使用**的内部方法 ——
 *     这一点写在签名上方，不靠调用点自觉。
 *
 *  ⑤ **IP 只存哈希**：`upload_ip_hash = sha256(ip + SIGN_SECRET)`，由
 *     `GuardService.guardKey()` 计算（唯一实现点，与频控同盐同算法）。
 *     存明文 IP 会让照片表变成一张定位表，而它的用途只是风控回溯。
 *
 * ---------------------------------------------------------------------------
 * 为什么"张数上限"必须写在 SQL 里而不是先 count 再 insert
 * ---------------------------------------------------------------------------
 * 先 `SELECT count(*)` 再 `INSERT` 是典型的 check-then-act：
 * 师傅在弱网下连点两次"上传"，或前端并发上传 6 张，两次 count 都会读到
 * "还没到上限"，于是插进去 8 张 —— 而且**恰好在上限附近才复现**，
 * 本地测试几乎撞不到。所以上限判定与插入放在**同一条语句**里
 * （`INSERT ... SELECT ... WHERE (SELECT count(*)) < $limit`），
 * 由数据库保证原子。同一语句里还顺带断言 `visit_status = 'ASSIGNED'`，
 * 让"已提交/已改派后拒绝新增照片"也免于 TOCTOU。
 *
 * ⚠️ `sort_order` 用的是"插入时的现有张数"，并发上传时两条可能拿到同一个值。
 *    这不是缺陷：展示排序是 `(sort_order, id)`（见 `VisitService.listPhotos`），
 *    id 是稳定兜底。要严格递增就得加锁，代价大于收益 —— 照片顺序没有业务含义。
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PHOTO_TYPE, PHOTO_TYPE_VALUES, VISIT_STATUS } from '../constants';
import { VisitValidationError } from './visit-service';
import {
  IMAGE_EXTENSION,
  SUPPORTED_IMAGE_MIMES,
  findMetadataTraces,
  probeIssues,
  sniffImage,
  stripImageMetadata,
} from '../../shared/media-guard';
import type { ConfigService } from './config-service';

/** 私有根目录的缺省值。与 `.env.example` 的 `UPLOAD_PRIVATE_DIR` 必须一致 */
export const DEFAULT_PRIVATE_DIR = '/app/nocobase/storage/uploads-private';

export interface PhotoServiceOptions {
  config: ConfigService;
  logger?: {
    warn?: (msg: string) => void;
    debug?: (msg: string) => void;
    info?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  /** 私有根目录；缺省读 `UPLOAD_PRIVATE_DIR`。显式传入只为测试 */
  privateDir?: string;
  /** 注入文件系统（测试用） */
  fsImpl?: typeof fs.promises;
  /** 注入随机源（测试用），返回 BYTES 长度的 Buffer */
  randomBytesFn?: (size: number) => Buffer;
  /** 注入时钟（测试用） */
  now?: () => Date;
}

export interface SavePhotoInput {
  visitId: number | string;
  /** 上传的原始字节（已由 multer 限制过单文件大小） */
  buffer: Buffer;
  /** 请求里声明的 Content-Type —— **只用于日志对照**，不参与判定 */
  declaredMime?: string | null;
  /** 原始文件名 —— **只进 attachments.title 用于人工辨认**，不参与任何路径拼接 */
  originalName?: string | null;
  /** 照片分类（`PHOTO_TYPE`），缺省 `onsite` */
  photoType?: string | null;
  /** 上传者 IP 的哈希（`GuardService.guardKey(ip)`），仅风控用 */
  uploadIpHash?: string | null;
  /** 上限（由 action 层从参数读取后传入，缺省值见 constants 种子） */
  maxCount: number;
  /** 单张字节上限 */
  maxSizeBytes: number;
}

export interface SavedPhoto {
  id: number;
  /** 私有存储内的相对路径 —— **禁止对外输出** */
  storageKey: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  sortOrder: number;
  photoType: string;
  /** 被剥离的元数据段名（日志与断言用） */
  stripped: string[];
}

export interface ReadPhotoResult {
  /** 绝对路径（已断言过在私有根之内） */
  absPath: string;
  /** **数据库里记录的** MIME（不是从磁盘重新嗅探，也不是请求里声明的） */
  mime: string;
  size: number;
}

export class PhotoService {
  private readonly db: any;
  private readonly config: ConfigService;
  private readonly logger?: PhotoServiceOptions['logger'];
  private readonly fsx: typeof fs.promises;
  private readonly randomBytesFn: (size: number) => Buffer;
  private readonly now: () => Date;
  private readonly rootOverride?: string;

  constructor(db: any, options: PhotoServiceOptions) {
    this.db = db;
    this.config = options.config;
    this.logger = options.logger;
    this.fsx = options.fsImpl ?? fs.promises;
    this.randomBytesFn = options.randomBytesFn ?? ((size: number) => randomBytes(size));
    this.now = options.now ?? (() => new Date());
    this.rootOverride = options.privateDir;
  }

  /** 私有根目录（绝对路径）。**每次读**而不是构造时缓存 —— 环境变量在测试里会被改 */
  get privateDir(): string {
    const raw = this.rootOverride ?? process.env.UPLOAD_PRIVATE_DIR ?? '';
    return path.resolve(String(raw).trim() || DEFAULT_PRIVATE_DIR);
  }

  // -------------------------------------------------------------------------
  // 写入
  // -------------------------------------------------------------------------

  /**
   * 校验并落盘一张照片。
   *
   * 执行顺序**不可调换**，每一步都在为后面挡住一类输入：
   *   ⓐ 大小 → ⓑ magic bytes（决定 mime/ext） → ⓒ 头部尺寸可解析
   *   → ⓓ 剥元数据 → ⓔ 剥完回查 → ⓕ 写文件 → ⓖ 写两张表（带原子上限）
   * 其中 ⓐ~ⓔ 全部发生在**磁盘写入之前** —— 一个非法文件连一个 inode 都不会产生。
   * 这是有意的：`uploads-private` 若能被匿名请求写满，本身就是一种拒绝服务。
   */
  async save(input: SavePhotoInput): Promise<SavedPhoto> {
    const visitId = toPositiveInt(input.visitId, 'visitId');
    const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer ?? []);

    // ⓐ 大小
    if (buffer.length === 0) {
      throw new VisitValidationError('EMPTY_FILE', '上传内容为空');
    }
    if (buffer.length > input.maxSizeBytes) {
      throw new VisitValidationError(
        'PHOTO_TOO_LARGE',
        `单张照片不能超过 ${Math.floor(input.maxSizeBytes / 1024 / 1024)}MB`,
        413,
      );
    }

    // ⓑ magic bytes
    const probe = sniffImage(buffer);

    // ⓒ 头部尺寸。为什么不能省：截断/损坏的真图片在字节层面**确实是图片**，
    //    存进来就是一张打不开的照片，而师傅看到的是"上传成功"。
    const issues = probeIssues(probe);
    if (issues.includes('UNSUPPORTED_FORMAT')) {
      this.logger?.warn?.(
        `[photo] 拒绝非图片上传（visit=${visitId}，声明 ${String(
          input.declaredMime ?? '(无)',
        )}，文件名 ${String(input.originalName ?? '(无)')}，字节 ${buffer.length}）`,
      );
      // 对外**不说**"只支持 jpg/png/webp"以外的细节：判定依据是字节而不是扩展名，
      // 把内部判定过程讲清楚等于教人构造绕过。允许的类型本身是公开信息，可以说。
      throw new VisitValidationError(
        'UNSUPPORTED_IMAGE',
        `只支持 ${SUPPORTED_IMAGE_MIMES.map((m) => m.replace('image/', '').toUpperCase()).join(
          ' / ',
        )} 格式的图片`,
        415,
      );
    }
    if (issues.includes('NO_DIMENSIONS')) {
      throw new VisitValidationError('IMAGE_MALFORMED', '图片已损坏或不完整，请重新拍照上传', 422);
    }

    // ⓓ 剥元数据
    const { data, removed } = stripImageMetadata(buffer, probe!.mime);

    // ⓔ 回查。为什么要在落盘前做：段级解析是手写的，
    //    "移除"与"看起来移除了"必须能被区分。这里查不到才允许写盘。
    //    （`findMetadataTraces` 的能力边界见 media-guard 顶部说明。）
    const traces = findMetadataTraces(data, probe!.mime);
    if (traces.length > 0) {
      throw new Error(
        `[photo] 元数据剥离后仍检出 ${traces.join(', ')} —— 解析器存在缺陷，拒绝落盘（visit=${visitId}）`,
      );
    }

    const photoType = this.assertPhotoType(input.photoType);

    // ⓕ 写文件。路径**完全由服务端生成**：不含任何用户可控字符串
    //    （原始文件名只进 attachments.title，见下），因此路径穿越在本模块里
    //    不是"靠过滤挡住"，而是"结构上不可能"。下面的 contains() 断言是第二道。
    const storageKey = this.buildStorageKey(visitId, probe!.ext);
    const absPath = this.resolveInsideRoot(storageKey);
    await this.fsx.mkdir(path.dirname(absPath), { recursive: true });
    // flag 'wx'：若目标已存在则失败而不是覆盖。随机名重复的概率可忽略，
    // 但"绝不覆盖既有文件"这条约束不该依赖概率。
    await this.fsx.writeFile(absPath, data, { flag: 'wx' });

    try {
      // ⓖ 写两张表。attachments 是 serviceVisitPhotos.file_id 的外键目标。
      const photo = await this.persist({
        visitId,
        storageKey,
        mime: probe!.mime,
        size: data.length,
        width: probe!.width,
        height: probe!.height,
        photoType,
        uploadIpHash: input.uploadIpHash ?? null,
        maxCount: input.maxCount,
        originalName: input.originalName ?? null,
        declaredMime: input.declaredMime ?? null,
        stripped: removed,
        rawSize: buffer.length,
      });

      this.logger?.info?.(
        `[photo] visit=${visitId} 已存照片 #${photo.id}：${probe!.mime} ` +
          `${probe!.width}x${probe!.height} ${buffer.length}→${data.length}B ` +
          `（剥离 ${removed.length ? removed.join('+') : '无元数据'}，第 ${photo.sortOrder + 1} 张）`,
      );

      return {
        id: Number(photo.id),
        storageKey,
        mime: probe!.mime,
        size: data.length,
        width: probe!.width,
        height: probe!.height,
        sortOrder: Number(photo.sort_order),
        photoType,
        stripped: removed,
      };
    } catch (error) {
      // ⚠️ 落盘成功但入库失败（张数已满 / Visit 已不可写 / 库抖了一下）：
      //    必须把文件删掉。否则私有目录会积累一批**没有任何行指向的孤儿文件**，
      //    它们永远不会被展示、也永远不会被清理 —— 而"张数上限"是按行算的，
      //    于是这成了一个可以无限塞满磁盘的口子：每次上传都失败，但文件都留下了。
      await this.unlinkQuietly(absPath);
      throw error;
    }
  }

  /**
   * 两张表的写入。
   *
   * `attachments` 行是必须的（`serviceVisitPhotos.file_id` 是 NOT NULL 外键）。
   * ⚠️ 它**只承载元数据**，不携带任何可下载路径：
   *    · `storageId = null` —— 故意不挂到 NocoBase 的 local storage 上，
   *      否则后台附件列表会给出一个指向 `storage/uploads/...` 的下载链接，
   *      而文件**不在那里**（在 `uploads-private`），点开就是 404 ——
   *      那种"链接存在但打不开"的状态比"明确没有链接"更难排查；
   *    · `path = storageKey`（私有相对路径），业务侧要读取时走 `read()`。
   */
  private async persist(params: {
    visitId: number;
    storageKey: string;
    mime: string;
    size: number;
    width: number | null;
    height: number | null;
    photoType: string;
    uploadIpHash: string | null;
    maxCount: number;
    originalName: string | null;
    declaredMime: string | null;
    stripped: string[];
    rawSize: number;
  }): Promise<any> {
    const attachment = await this.insertAttachment(params);

    // ⚠️ 这条语句同时承担三件事，任意一件不满足就返回 0 行：
    //    ① Visit 存在且仍是 ASSIGNED（已提交/已改派/已取消 ⇒ 拒绝新增照片）；
    //    ② 现有张数 < 上限（原子，无 check-then-act 窗口）；
    //    ③ 插入照片行。
    //    `sort_order` 取"插入时的现有张数"（从 0 开始），见文件头的说明。
    const [rows] = await this.query(
      `INSERT INTO service_visit_photos
         (visit_id, photo_type, file_id, storage_key, mime, size, width, height,
          sort_order, uploaded_at, upload_ip_hash, created_at, updated_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, c.n, now(), $9, now(), now()
         FROM (SELECT count(*)::int AS n FROM service_visit_photos WHERE visit_id = $1) c
        WHERE EXISTS (
                SELECT 1 FROM service_visits
                 WHERE id = $1 AND visit_status = '${VISIT_STATUS.ASSIGNED}'
              )
          AND c.n < $10
       RETURNING *`,
      [
        params.visitId,
        params.photoType,
        attachment.id,
        params.storageKey,
        params.mime,
        params.size,
        params.width,
        params.height,
        params.uploadIpHash,
        params.maxCount,
      ],
    );

    const row: any = Array.isArray(rows) ? rows[0] : undefined;
    if (row) return row;

    // 0 行 ⇒ 必须分辨"Visit 不可写"与"张数已满"：
    // 两者的对外表现完全不同（前者是"链接已失效"，后者是"最多 N 张"），
    // 混成一个错误码会让师傅在"已经提交过"时看到"照片太多"，白折腾一遍。
    // ⚠️ 这次查询只用于**把错误说清楚**，不参与判定 —— 判定已经由上面那条语句完成。
    const visit = await this.loadVisit(params.visitId);
    if (!visit) {
      throw new VisitValidationError('NOT_FOUND', '上门作业记录不存在', 404);
    }
    if (String(visit.visit_status) !== VISIT_STATUS.ASSIGNED) {
      throw new VisitValidationError(
        'VISIT_NOT_WRITABLE',
        '本次上门作业已提交或已失效，不能再上传照片',
        409,
      );
    }
    throw new VisitValidationError(
      'PHOTO_LIMIT_REACHED',
      `本次上门最多上传 ${params.maxCount} 张照片`,
      422,
    );
  }

  private async insertAttachment(params: {
    storageKey: string;
    mime: string;
    size: number;
    width: number | null;
    height: number | null;
    originalName: string | null;
    declaredMime: string | null;
    stripped: string[];
    rawSize: number;
  }): Promise<any> {
    const repository = this.db.getRepository('attachments');
    const filename = path.basename(params.storageKey);
    return repository.create({
      values: {
        // 原始文件名只在这里出现，且**截断到 255**（列宽度就是 255，
        // 超长会直接报数据库错误而不是"友好拒绝"）。它纯粹是给人看的。
        title: truncate(params.originalName || filename, 255),
        filename: truncate(filename, 255),
        extname: path.extname(filename).replace(/^\./, ''),
        size: params.size,
        // ⚠️ 落库的 MIME 是**嗅探结果**，不是请求声明的那个。
        //    请求声明的值只作为对照记在 meta 里，用于事后发现"有人专门伪造后缀"。
        mimetype: params.mime,
        path: params.storageKey,
        url: null,
        storageId: null,
        meta: {
          private: true,
          source: 'technician_upload',
          width: params.width,
          height: params.height,
          declared_mime: params.declaredMime,
          // 记录剥离了什么：将来"某张照片为什么没有拍摄时间"这类问题，
          // 答案应该在库里而不是靠人回想
          stripped_metadata: params.stripped,
          raw_size: params.rawSize,
        },
      },
    });
  }

  // -------------------------------------------------------------------------
  // 读取（**不做鉴权** —— 仅供已通过 Token 认证与属主校验的 action 调用）
  // -------------------------------------------------------------------------

  /**
   * 取一张照片的磁盘位置。
   *
   * ⚠️ 本方法**没有任何鉴权**。把它暴露成接口就是"任何人凭 id 读任意照片"，
   *    因此它只允许被 `actions/technician/visit.ts` 的 `photo` handler 调用 ——
   *    那里先过 `withTechnicianAuth()`，再断言照片属于该 Token 的 Visit。
   *    （这就是为什么它不叫 `getById` 之类看起来"通用"的名字。）
   */
  async read(photoId: number | string): Promise<ReadPhotoResult | null> {
    const repository = this.db.getRepository('serviceVisitPhotos');
    const row = await repository.findOne({ filter: { id: toPositiveInt(photoId, 'photoId') } });
    if (!row) return null;

    const plainRow: any = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
    const absPath = this.resolveInsideRoot(String(plainRow.storage_key));
    return {
      absPath,
      mime: String(plainRow.mime),
      size: Number(plainRow.size) || 0,
    };
  }

  /** 文件是否真的在私有目录里（读取前判一次，把"行在、文件没了"报成 404 而不是 500） */
  async exists(storageKey: string): Promise<boolean> {
    try {
      await this.fsx.access(this.resolveInsideRoot(storageKey));
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 生成本次上传的相对路径：`visits/{visitId}/{YYYYMM}/{32位随机}.{ext}`。
   *
   * 三个刻意的选择：
   *   · **不含原始文件名** —— 用户可控字符串一旦进路径，就同时引入路径穿越、
   *     特殊字符、超长路径、同名覆盖四类问题；不引入就不可能踩。
   *   · **按月分目录** —— 单目录文件数过多会让目录操作变慢，
   *     而照片是持续增长的（Phase 9 的保留策略会按时间清理）。
   *   · **随机名不用时间戳** —— 时间戳可猜；随机名让"猜邻居文件"不成立
   *     （虽然读取本身还要过属主校验，这是纵深防御）。
   */
  private buildStorageKey(visitId: number, ext: string): string {
    const stamp = this.now();
    const yyyymm = `${stamp.getUTCFullYear()}${String(stamp.getUTCMonth() + 1).padStart(2, '0')}`;
    const name = this.randomBytesFn(24).toString('hex');
    return `visits/${visitId}/${yyyymm}/${name}.${ext}`;
  }

  /**
   * 把相对路径解析成绝对路径，并断言它**落在私有根之内**。
   *
   * 第二道防线（第一道是"路径里没有用户输入"）。两次 path.resolve 的比较
   * 是这类校验的标准写法：`startsWith(root)` 会被 `/root-evil` 骗过，
   * 所以必须比 `root + path.sep`。
   */
  private resolveInsideRoot(storageKey: string): string {
    const root = this.privateDir;
    const abs = path.resolve(root, storageKey);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`[photo] 存储路径越出私有目录：${storageKey}`);
    }
    return abs;
  }

  private async unlinkQuietly(absPath: string): Promise<void> {
    try {
      await this.fsx.unlink(absPath);
    } catch (error) {
      this.logger?.warn?.(
        `[photo] 回滚删除文件失败（${absPath}）：${(error as Error)?.message} —— ` +
          '该文件已成为孤儿，需要人工清理',
      );
    }
  }

  private assertPhotoType(value: unknown): string {
    const text = String(value ?? '').trim() || PHOTO_TYPE.ONSITE;
    if (!PHOTO_TYPE_VALUES.includes(text as any)) {
      throw new VisitValidationError(
        'INVALID_ENUM',
        `photo_type 必须是 ${PHOTO_TYPE_VALUES.join(' / ')} 之一`,
      );
    }
    return text;
  }

  private async loadVisit(visitId: number): Promise<any | null> {
    const repository = this.db.getRepository('serviceVisits');
    return (await repository.findOne({ filter: { id: visitId } })) ?? null;
  }

  private async query(sqlText: string, bind: unknown[]): Promise<[unknown, unknown]> {
    const sequelize = this.db?.sequelize;
    if (!sequelize || typeof sequelize.query !== 'function') {
      throw new Error('[photo] db.sequelize.query 不可用');
    }
    return (await sequelize.query(sqlText, { bind })) as [unknown, unknown];
  }
}

/** 剥离后回查（见 `save()` 的 ⓔ 步） */

function truncate(value: string, max: number): string {
  const text = String(value ?? '');
  return text.length <= max ? text : text.slice(0, max);
}

function toPositiveInt(value: unknown, field: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    throw new VisitValidationError('INVALID_ID', `${field} 必须是正整数`);
  }
  return num;
}

/** 供断言脚本引用：私有目录之外绝不允许出现照片文件 */
export const PHOTO_STORAGE_ROOT_ENV = 'UPLOAD_PRIVATE_DIR';

/** 落盘扩展名白名单（与嗅探结果一一对应）；断言脚本用它枚举"合法后缀" */
export const PHOTO_EXTENSIONS = Object.values(IMAGE_EXTENSION);
