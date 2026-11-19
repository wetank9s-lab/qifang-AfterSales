import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  ARCHIVE_PHOTO_TYPE,
  ARCHIVE_STAGE_PHOTO_MAX,
  ARCHIVE_STAGE_PHOTO_REQUIRED,
  ARCHIVE_STAGE_STATUS,
  ARCHIVE_TYPE,
  ARCHIVE_VISIBILITY,
} from '../constants';
import {
  IMAGE_EXTENSION,
  findMetadataTraces,
  sniffImage,
  stripImageMetadata,
} from '../../shared/media-guard';
import { ArchiveError } from './archive-service';
import type { ArchiveActorLike, ArchiveService } from './archive-service';

/**
 * ArchivePhotoService —— 档案照片的上传/绑定/发布/读取（ARC-PHOTO-01）
 *
 * ===========================================================================
 * 为什么不是"再写一套图片存储"
 * ===========================================================================
 * 图片校验与落盘**复用** `shared/media-guard`（与师傅现场照片同一套）：
 *   `sniffImage`（magic bytes 定类型）→ `stripImageMetadata`（剥 EXIF/GPS）
 *   → `findMetadataTraces`（剥完回查）→ 写私有目录。
 * 存储根目录也是同一个 `UPLOAD_PRIVATE_DIR`，`storage_key` 仍是私有相对路径。
 *
 * 只是**表不同**（`service_archive_photos` 而不是 `service_visit_photos`），
 * 因为档案照片要挂阶段、要有独立的发布状态。表不同不等于体系不同。
 *
 * ===========================================================================
 * 三条不可让步的规则
 * ===========================================================================
 * 1. **上传即未发布**。`published` 一律从 false 开始，发布是独立动作。
 *    如果上传就自动发布，"撤回时取消发布"会变成"下次上传又自动发布"的循环。
 * 2. **发布要求阶段已 done**。撤回后的阶段可以重新完成，但在那之前，
 *    它的照片不能重新发布 —— 否则客户会看到一张"属于已撤回阶段"的照片。
 * 3. **storage_key 永不出接口**。读取走 `readForActor`，返回 Buffer 与 mime，
 *    路径只在服务端存在。
 */

export interface ArchivePhotoDeps {
  db: any;
  /** 私有存储根目录（与 PhotoService 同一个 env） */
  privateDir: string;
  maxSizeBytes: number;
  logger?: { warn?: (m: string) => void; info?: (m: string) => void };
}

/**
 * 单张照片的最大像素数（宽×高）。
 *
 * 8000 万像素 ≈ 一张 8000×10000 的图，远大于任何手机拍照（当前主流 5000 万以内）。
 * 设这个上限只为挡住**解压炸弹**，不是画质策略 —— 所以给得很宽，
 * 正常用户的照片不可能被它挡住。
 */
export const MAX_PIXELS = 80_000_000;

export interface AttachInput {
  archiveId: number;
  stageId?: number | null;
  photoType?: string | null;
  buffer: Buffer;
  declaredMime?: string | null;
  originalName?: string | null;
  uploadIpHash?: string | null;
}

export class ArchivePhotoService {
  constructor(
    private readonly deps: ArchivePhotoDeps,
    private readonly archives: ArchiveService,
  ) {}

  private repo(name: string) {
    return this.deps.db.getRepository(name);
  }

  // -------------------------------------------------------------------------
  // 上传 + 绑定
  // -------------------------------------------------------------------------

  async attach(actor: ArchiveActorLike, input: AttachInput): Promise<any> {
    const archive = await this.repo('serviceArchives').findOne({
      filter: { id: input.archiveId },
    });
    if (!archive) throw new ArchiveError('ARCHIVE_NOT_FOUND', '档案不存在或无权限', 404);
    // 写权限 + 门店归属（销售只能操作本店）
    this.archives.assertCanWriteStore(actor, Number(archive.store_id));

    if (archive.visibility === ARCHIVE_VISIBILITY.VOIDED) {
      throw new ArchiveError('ARCHIVE_VOIDED', '档案已作废，不能上传照片', 409);
    }

    const photoType = String(input.photoType ?? '').trim();
    let stageId: number | null = null;

    if (archive.archive_type === ARCHIVE_TYPE.HVAC) {
      // 暖通：照片**必须**绑定具体阶段
      const sid = Number(input.stageId);
      if (!Number.isFinite(sid) || sid <= 0) {
        throw new ArchiveError('ARCHIVE_PHOTO_STAGE_REQUIRED', '暖通照片必须指定所属阶段', 400);
      }
      const stage = await this.repo('serviceArchiveStages').findOne({ filter: { id: sid } });
      if (!stage) {
        throw new ArchiveError('ARCHIVE_STAGE_NOT_FOUND', '阶段不存在', 404);
      }
      // 归属校验：阶段必须属于这个档案（防止跨档案挂照片）
      if (Number(stage.archive_id) !== Number(input.archiveId)) {
        throw new ArchiveError('ARCHIVE_PHOTO_STAGE_MISMATCH', '该阶段不属于此档案', 400);
      }
      if (photoType && photoType !== ARCHIVE_PHOTO_TYPE.STAGE) {
        throw new ArchiveError('ARCHIVE_PHOTO_BAD_TYPE', '暖通照片类型必须为 stage', 400);
      }
      stageId = sid;

      // 每阶段上限（含已撤回的，因为它们仍占着历史）
      const count = (await this.repo('serviceArchivePhotos').find({
        filter: { archive_id: input.archiveId, stage_id: sid },
        fields: ['id'],
      })).length;
      if (count >= ARCHIVE_STAGE_PHOTO_MAX) {
        throw new ArchiveError(
          'ARCHIVE_STAGE_PHOTO_TOO_MANY',
          `每个阶段最多 ${ARCHIVE_STAGE_PHOTO_MAX} 张照片，当前已 ${count} 张`,
          409,
        );
      }
    } else {
      // 普通上门服务：区分 before / after，且**不接受** stage_id
      if (input.stageId !== undefined && input.stageId !== null && Number(input.stageId) > 0) {
        throw new ArchiveError('ARCHIVE_PHOTO_STAGE_INVALID', '普通服务照片不能关联阶段', 400);
      }
      if (photoType !== ARCHIVE_PHOTO_TYPE.BEFORE && photoType !== ARCHIVE_PHOTO_TYPE.AFTER) {
        throw new ArchiveError('ARCHIVE_PHOTO_BAD_TYPE', '普通服务照片类型必须为 before 或 after', 400);
      }
    }

    // ---- 校验与落盘（顺序不可换：先判类型，再剥元数据，最后才写盘）----
    const probe = sniffImage(input.buffer);
    if (!probe) {
      throw new ArchiveError('ARCHIVE_PHOTO_BAD_IMAGE', '文件不是受支持的图片格式', 415);
    }
    if (input.buffer.length > this.deps.maxSizeBytes) {
      throw new ArchiveError(
        'ARCHIVE_PHOTO_TOO_LARGE',
        `单张照片不能超过 ${Math.floor(this.deps.maxSizeBytes / 1024 / 1024)}MB`,
        413,
      );
    }

    const stripped = stripImageMetadata(input.buffer, probe.mime);
    const traces = findMetadataTraces(stripped.data, probe.mime);
    if (traces.length > 0) {
      // 剥完还查得到残余 ⇒ 宁可不收，也不把带 GPS 的照片收进档案
      throw new ArchiveError(
        'ARCHIVE_PHOTO_METADATA_RESIDUAL',
        `照片元数据未能完全清除（${traces.join(',')}）`,
        422,
      );
    }

    // ---- 像素上限（ARC-PHOTO-01 复核补充）----
    //
    // 为什么字节数上限不够：一张 5MB 的 PNG 可以是 20000×20000（4 亿像素），
    // 解码时占用 GB 级内存 —— 这就是"解压炸弹"。字节闸拦不住它，
    // 因为它压缩后确实很小。
    //
    // 注意 `probe.width/height` 来自**文件头**，不触发像素解码，所以这个判断本身是安全的。
    // 解析不出尺寸（null）时放行：那意味着容器头里没有尺寸信息，后续也不会被解码成巨图
    // （真正解码发生在客户端；服务端只做存储）。宁可不因此误拒正常照片。
    const px = Number(probe.width ?? 0) * Number(probe.height ?? 0);
    if (px > MAX_PIXELS) {
      throw new ArchiveError(
        'ARCHIVE_PHOTO_TOO_MANY_PIXELS',
        `照片分辨率过大（${probe.width}×${probe.height}），请压缩后重试`,
        413,
      );
    }

    const ext = probe.ext || IMAGE_EXTENSION[probe.mime] || 'bin';
    const key = path.posix.join(
      'archive',
      String(input.archiveId),
      `${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`,
    );
    const abs = path.join(this.deps.privateDir, key);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, stripped.data);

    /**
     * 写库失败必须把刚落的文件删掉。
     *
     * 顺序是"先落盘、再写库"（不能反过来：写库成功而落盘失败，
     * 会留下一条指向不存在文件的记录，客户打开就是 404，
     * 而且这条记录会一直占着"每阶段 6 张"的名额）。
     * 但反过来的代价是**孤儿文件**：写库抛错时盘上多一个没人引用的文件。
     *
     * 2026-11-09 ARC-PHOTO-01 复核发现的真实缺口：原实现没有清理。
     * 后果不是安全漏洞，是**磁盘缓慢泄漏**（每次失败泄漏一张），
     * 且这些文件永远不会被任何清理任务扫到（它们不在任何表里）。
     * ⇒ 最小修复：失败即 unlink，且 `catch` 里吞掉 unlink 自身的错误
     *   （清理失败不应把原始错误盖成一个 IO 错）。
     */
    let row: any;
    try {
      row = await this.repo('serviceArchivePhotos').create({
        values: {
          archive_id: input.archiveId,
          stage_id: stageId,
          photo_type: stageId ? ARCHIVE_PHOTO_TYPE.STAGE : photoType,
          storage_key: key,
          mime: probe.mime,
          byte_size: stripped.data.length,
          width: probe.width ?? null,
          height: probe.height ?? null,
          exif_stripped: true,
          // 🔴 上传一律未发布；发布是独立动作
          published: false,
          uploaded_by: actor.userId ?? null,
          uploaded_at: new Date(),
          upload_ip_hash: input.uploadIpHash ?? null,
        },
      });
    } catch (error) {
      await fs.promises.unlink(abs).catch(() => {
        this.deps.logger?.warn?.(`[archive-photo] 孤儿文件清理失败：${key}`);
      });
      throw error;
    }

    await this.archives.writeEvent(actor, input.archiveId, stageId, 'photo_added', {
      photo_id: Number(row.id),
      photo_type: stageId ? ARCHIVE_PHOTO_TYPE.STAGE : photoType,
      // ⚠️ 事件里不写 storage_key，也不写原始文件名（可能含客户信息）
    });

    // 回给前端的投影**不含 storage_key**
    return this.project(row);
  }

  // -------------------------------------------------------------------------
  // 发布 / 取消发布
  // -------------------------------------------------------------------------

  /**
   * 设置照片发布状态。
   *
   * **发布时必须阶段已 done**（用户 2026-11-10 冻结）：
   * 撤回后的阶段可以重新完成，但在那之前它的照片不能重新发布。
   * 取消发布永远允许（撤回场景要走这条路）。
   */
  async setPublished(
    actor: ArchiveActorLike,
    photoId: number,
    published: boolean,
  ): Promise<any> {
    const photo = await this.repo('serviceArchivePhotos').findOne({ filter: { id: photoId } });
    if (!photo) throw new ArchiveError('ARCHIVE_PHOTO_NOT_FOUND', '照片不存在或无权限', 404);

    const archive = await this.repo('serviceArchives').findOne({
      filter: { id: Number(photo.archive_id) },
    });
    if (!archive) throw new ArchiveError('ARCHIVE_NOT_FOUND', '档案不存在或无权限', 404);
    this.archives.assertCanWriteStore(actor, Number(archive.store_id));

    if (archive.visibility === ARCHIVE_VISIBILITY.VOIDED) {
      throw new ArchiveError('ARCHIVE_VOIDED', '档案已作废，不能调整照片', 409);
    }

    if (published) {
      if (photo.stage_id !== null && photo.stage_id !== undefined) {
        const stage = await this.repo('serviceArchiveStages').findOne({
          filter: { id: Number(photo.stage_id) },
        });
        if (!stage || stage.status !== ARCHIVE_STAGE_STATUS.DONE) {
          throw new ArchiveError(
            'ARCHIVE_PHOTO_STAGE_NOT_DONE',
            '所属阶段尚未完成（或已撤回），请先重新完成该阶段再发布照片',
            409,
          );
        }
      }

      /**
       * 🔴 并发：上面的"读阶段 → 判 done"与下面的 UPDATE 之间存在窗口。
       *
       * 场景（ARC-PHOTO-01 复核发现）：
       *   T1 发布：读到 stage=done ✓
       *   T2 撤回：事务提交，stage→withdrawn 且 photo.published=false
       *   T1 继续：把 photo.published 改成 true
       *   ⇒ 结果是一条"阶段已撤回、照片却标记已发布"的记录。
       *
       * 客户侧不会看到它（`isPhotoCustomerVisible` 的第三个条件会拦），
       * 但**数据自相矛盾**：下一次任何人看这条记录都会以为是撤回逻辑漏了。
       *
       * 最小修复：把阶段条件**写进 UPDATE 的 WHERE**，让数据库自己保证原子性。
       * 返回 0 行 ⇒ 说明窗口期里有别的写，按"阶段未完成"拒绝。
       */
      const [rows] = (await this.deps.db.sequelize.query(
        `UPDATE service_archive_photos p
            SET published = true, updated_at = now()
          WHERE p.id = :photoId
            AND (p.stage_id IS NULL OR EXISTS (
                  SELECT 1 FROM service_archive_stages s
                   WHERE s.id = p.stage_id AND s.status = :done
                ))
          RETURNING p.id`,
        {
          replacements: { photoId, done: ARCHIVE_STAGE_STATUS.DONE },
        },
      )) as unknown as [Array<{ id: number }>];

      if (!Array.isArray(rows) || rows.length === 0) {
        throw new ArchiveError(
          'ARCHIVE_PHOTO_STAGE_NOT_DONE',
          '所属阶段尚未完成（或已撤回），请先重新完成该阶段再发布照片',
          409,
        );
      }
    } else {
      // 取消发布永远允许（撤回场景走这条路），不需要阶段条件
      await this.repo('serviceArchivePhotos').update({
        filter: { id: photoId },
        values: { published: false },
      });
    }

    await this.archives.writeEvent(
      actor,
      Number(photo.archive_id),
      photo.stage_id === null || photo.stage_id === undefined ? null : Number(photo.stage_id),
      published ? 'photo_added' : 'photo_removed',
      { photo_id: photoId, action: published ? 'publish' : 'unpublish' },
    );

    const fresh = await this.repo('serviceArchivePhotos').findOne({ filter: { id: photoId } });
    return this.project(fresh);
  }

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  /**
   * 内部受控读取（员工）。
   *
   * `archives.assertCanAccessRow` 判门店范围；总部角色放行（跨店只读）。
   * **不做 published 过滤**：内部要能看历史照片（含已撤回阶段的）。
   */
  async readForActor(
    actor: ArchiveActorLike,
    photoId: number,
  ): Promise<{ buffer: Buffer; mime: string; fileName: string }> {
    const photo = await this.repo('serviceArchivePhotos').findOne({ filter: { id: photoId } });
    if (!photo) throw new ArchiveError('ARCHIVE_PHOTO_NOT_FOUND', '照片不存在或无权限', 404);

    const archive = await this.repo('serviceArchives').findOne({
      filter: { id: Number(photo.archive_id) },
    });
    if (!archive) throw new ArchiveError('ARCHIVE_NOT_FOUND', '档案不存在或无权限', 404);
    this.archives.assertCanAccessRow(actor, archive);

    const key = String(photo.storage_key ?? '');
    if (!key || key.includes('..')) {
      throw new ArchiveError('ARCHIVE_PHOTO_BROKEN', '照片记录异常', 500);
    }
    const abs = path.join(this.deps.privateDir, key);
    if (!fs.existsSync(abs)) {
      throw new ArchiveError('ARCHIVE_PHOTO_MISSING', '照片文件不存在', 404);
    }
    return {
      buffer: await fs.promises.readFile(abs),
      mime: String(photo.mime ?? 'application/octet-stream'),
      fileName: path.basename(key),
    };
  }

  // -------------------------------------------------------------------------
  // 移除（R2.2.1 §七 / §九：阶段照片可合法替换与移除）
  // -------------------------------------------------------------------------

  /**
   * 移除一张阶段照片。
   *
   * ===========================================================================
   * 为什么必须有这条，以及它与 setPublished(false) 的区别
   * ===========================================================================
   *   `setPublished(false)` 只是"客户看不到"，行还在、文件还在 ——
   *   那是**撤回**的语义（保留历史、可再发布）。
   *   而员工点「移除」想要的是"这张传错了，删掉"。
   *   用取消发布顶替移除 ⇒ 照片区永远显示着那张错图（内部投影不过滤 published），
   *   员工会反复点移除、每次都没有反应。
   *
   * ===========================================================================
   * 三条硬约束
   * ===========================================================================
   *   ① **不能让必需照片数变零**（用户 §七 原文）。
   *      必须先在客户端"先传替换再删旧"（见 `QFStagePhotoManager`），
   *      服务端在这里**再判一次**：remaining < required ⇒ 409。
   *      只在客户端拦是不够的 —— 接口是公开的，脚本能直接调。
   *   ② **物理删除行 + 删文件**，但**先写事件再删文件**：
   *      文件删失败只记 warn（孤儿文件可由运维清理）；
   *      而事件丢了就无法解释"照片为什么少了一张"。
   *   ③ **必须校验照片属于这个档案**：`photo_id` 与 `filterByTk` 不匹配时
   *      报 404 而不是"删别人的照片"。
   */
  async remove(
    actor: ArchiveActorLike,
    archiveId: number,
    photoId: number,
  ): Promise<{ removed: number; stage_id: number | null; remaining: number }> {
    const repo = this.repo('serviceArchivePhotos');
    const photo = await repo.findOne({ filter: { id: photoId } });
    // 越权与不存在统一 404（不给存在性信号）
    if (!photo || Number(photo.archive_id) !== Number(archiveId)) {
      throw new ArchiveError('ARCHIVE_PHOTO_NOT_FOUND', '照片不存在或无权限', 404);
    }

    const archive = await this.repo('serviceArchives').findOne({ filter: { id: archiveId } });
    if (!archive) throw new ArchiveError('ARCHIVE_NOT_FOUND', '档案不存在或无权限', 404);
    this.archives.assertCanWriteStore(actor, Number(archive.store_id));
    if (archive.visibility === ARCHIVE_VISIBILITY.VOIDED) {
      throw new ArchiveError('ARCHIVE_VOIDED', '档案已作废，不能调整照片', 409);
    }

    const stageId =
      photo.stage_id === null || photo.stage_id === undefined ? null : Number(photo.stage_id);

    // ① 必需照片数不能变零
    if (stageId !== null) {
      const stage = await this.repo('serviceArchiveStages').findOne({ filter: { id: stageId } });
      const code = String(stage?.stage_code ?? '');
      const required = ARCHIVE_STAGE_PHOTO_REQUIRED.includes(code);
      // ⚠️ 不能写成 `const [{ count }] = (await ...) as unknown as [Array<{count:number}>]`：
      //    解构会把**整个数组**塞给 `count`（TS2339：Property 'count' does not exist on '{count:number}[]'）。
      //    这与本文件 305 行那处同型（那里是先取 `[rows]` 再取 `rows[0]`）。
      //    ⇒ 统一先解构第一层（rows），再从 rows[0] 取值。
      const [countRows] = (await this.deps.db.sequelize.query(
        `SELECT count(*)::int AS count FROM service_archive_photos WHERE stage_id = :stageId`,
        { replacements: { stageId } },
      )) as unknown as [Array<{ count: number }>];
      const count = Number((countRows ?? [])[0]?.count ?? 0);
      const remaining = count - 1;
      if (required && remaining < 1) {
        throw new ArchiveError(
          'ARCHIVE_STAGE_PHOTO_REQUIRED',
          '这个阶段的照片是必需项，请先上传替换照片，再移除这张',
          409,
        );
      }
      // ② 先写事件（事务外，删了就删了，但必须留痕）
      await this.archives.writeEvent(actor, archiveId, stageId, 'photo_removed', {
        photo_id: photoId,
        photo_type: photo.photo_type,
        reason: 'employee_removed',
        remaining,
      });

      const key = String(photo.storage_key ?? '');
      await repo.destroy({ filter: { id: photoId } });
      if (key && !key.includes('..')) {
        const abs = path.join(this.deps.privateDir, key);
        await fs.promises.unlink(abs).catch(() => {
          // 文件已不在（或不可删）不影响"行已删除"这个事实；
          // 但必须留 warn —— 否则磁盘上会累积看不见的孤儿文件。
          this.deps.logger?.warn?.(`[archive-photo] 删除文件失败（孤儿）：${key}`);
        });
      }
      return { removed: 1, stage_id: stageId, remaining };
    }

    // 非阶段照片（档案级）：同样留痕后删除
    await this.archives.writeEvent(actor, archiveId, null, 'photo_removed', {
      photo_id: photoId,
      photo_type: photo.photo_type,
      reason: 'employee_removed',
    });
    const key2 = String(photo.storage_key ?? '');
    await repo.destroy({ filter: { id: photoId } });
    if (key2 && !key2.includes('..')) {
      await fs.promises
        .unlink(path.join(this.deps.privateDir, key2))
        .catch(() => this.deps.logger?.warn?.(`[archive-photo] 删除文件失败（孤儿）：${key2}`));
    }
    return { removed: 1, stage_id: null, remaining: 0 };
  }

  /** 对外投影：**绝不含 storage_key** */
  project(row: any): Record<string, unknown> {    if (!row) return {};
    return {
      id: Number(row.id),
      archive_id: Number(row.archive_id),
      stage_id: row.stage_id === null || row.stage_id === undefined ? null : Number(row.stage_id),
      photo_type: row.photo_type,
      mime: row.mime,
      byte_size: row.byte_size,
      width: row.width ?? null,
      height: row.height ?? null,
      published: Boolean(row.published),
      uploaded_at: row.uploaded_at,
    };
  }

  /** 供验收脚本核对文件确实落盘 */
  static hashOf(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }
}
