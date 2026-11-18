import {

  ARCHIVE_STAGE_LABEL,
  ARCHIVE_STAGE_ORDER,
  ARCHIVE_STAGE_PHOTO_MAX,
  ARCHIVE_STAGE_PHOTO_REQUIRED,
  ARCHIVE_STAGE_STATUS,
  ARCHIVE_STATUS,
  ARCHIVE_TYPE,
  ARCHIVE_VISIBILITY,
} from '../constants';
import { ArchiveError } from './archive-service';
import type { ArchiveActorLike, ArchiveService } from './archive-service';

/**
 * ArchiveStageService —— 暖通六阶段（ARC-V1 / A3）
 *
 * 规则全部来自**已冻结的业务契约**，本文件只做实现，不改规则：
 *   · 六个阶段固定、只能按顺序完成；
 *   · 勘察 / 管路 / 设备 / 验收四个阶段完成时至少一张照片；方案确认、调试运行可选；
 *   · 每阶段最多六张；
 *   · 第六阶段完成后工程自动「已验收」；
 *   · 销售可受控撤回，**留痕**，且不得让后续阶段仍显示已完成；
 *   · 并发用 version 乐观锁。
 *
 * 两个"看似细节、实则决定正确性"的点：
 *
 * 1. **阶段行是建档案时一次写好的六行**（见 ArchiveService.create），
 *    不是"完成时才插入"。只有六行都在，"跳过阶段"才能被检出 ——
 *    缺行与"还没做"在数据上无法区分。
 *
 * 2. **撤回必须连锁**。撤回第 3 阶段而让第 4 阶段保持"已完成"，
 *    等于承认"没做勘察就干了管路"。所以撤回时把 order 更大的已完成阶段一并撤回，
 *    并且**保留原 stage_date / completed_at** 作为历史（不物理删除、不清空日期）。
 */
export class ArchiveStageService {
  constructor(
    private readonly db: any,
    private readonly archives: ArchiveService,
    private readonly logger?: { warn?: (m: string) => void; info?: (m: string) => void },
  ) {}

  private repo(name: string) {
    return this.db.getRepository(name);
  }

  private async loadArchive(archiveId: number): Promise<any> {
    const row = await this.repo('serviceArchives').findOne({ filter: { id: archiveId } });
    if (!row) throw new ArchiveError('ARCHIVE_NOT_FOUND', '档案不存在或无权限', 404);
    return row;
  }

  /** 六阶段按 order 排好；缺行是数据异常，直接报（不猜） */
  private async loadStages(archiveId: number): Promise<any[]> {
    const rows = await this.repo('serviceArchiveStages').find({
      filter: { archive_id: archiveId },
      sort: ['stage_order'],
    });
    const list = rows ?? [];
    if (list.length !== ARCHIVE_STAGE_ORDER.length) {
      throw new ArchiveError(
        'ARCHIVE_STAGE_ROWS_BROKEN',
        `阶段数据异常：期望 ${ARCHIVE_STAGE_ORDER.length} 行，实际 ${list.length} 行`,
        500,
      );
    }
    return list;
  }

  /** 本阶段照片数（只数**归属到本阶段**的，不数整个档案） */
  private async countStagePhotos(archiveId: number, stageId: number): Promise<number> {
    const rows = await this.repo('serviceArchivePhotos').find({
      filter: { archive_id: archiveId, stage_id: stageId },
      fields: ['id'],
    });
    return (rows ?? []).length;
  }

  // -------------------------------------------------------------------------
  // 完成阶段
  // -------------------------------------------------------------------------

  async completeStage(
    actor: ArchiveActorLike,
    archiveId: number,
    stageCode: string,
    input: { stage_date: string; note?: string | null; expected_version: number },
  ): Promise<{ archive: any; stage: any }> {
    const archive = await this.loadArchive(archiveId);
    // 能力 + 门店归属（与建档案同一把闸）
    this.archives.assertCanWriteStore(actor, Number(archive.store_id));

    if (archive.archive_type !== ARCHIVE_TYPE.HVAC) {
      throw new ArchiveError('ARCHIVE_WRONG_TYPE', '只有暖通工程档案有阶段', 400);
    }
    if (archive.visibility === ARCHIVE_VISIBILITY.VOIDED) {
      throw new ArchiveError('ARCHIVE_VOIDED', '档案已作废，不能继续操作', 409);
    }

    const idx = ARCHIVE_STAGE_ORDER.indexOf(stageCode);
    if (idx < 0) {
      throw new ArchiveError('ARCHIVE_BAD_STAGE', `未知阶段 ${stageCode}`, 400);
    }

    const stages = await this.loadStages(archiveId);
    const stage = stages[idx];
    if (stage.stage_code !== stageCode) {
      // 顺序表与数据不一致时宁可报错，也不要按数组下标猜
      throw new ArchiveError('ARCHIVE_STAGE_ROWS_BROKEN', '阶段顺序与数据不一致', 500);
    }

    if (stage.status === ARCHIVE_STAGE_STATUS.DONE) {
      throw new ArchiveError('ARCHIVE_STAGE_ALREADY_DONE', '该阶段已完成，如需修改请先撤回', 409);
    }
    if (stage.status === ARCHIVE_STAGE_STATUS.WITHDRAWN) {
      // 撤回过的阶段允许重新完成 —— 这正是"受控纠错"的用法
      // 但前一阶段仍须 done（下面统一判）
    }
    if (Number(input.expected_version) !== Number(stage.version)) {
      throw new ArchiveError('ARCHIVE_STAGE_STALE', '该阶段刚被其他人修改，请刷新后重试', 409);
    }
    if (!input?.stage_date) {
      throw new ArchiveError('ARCHIVE_STAGE_MISSING_DATE', '完成阶段必须填写阶段日期', 400);
    }

    // ---- 顺序：前一阶段必须已完成 ----
    if (idx > 0) {
      const prev = stages[idx - 1];
      if (prev.status !== ARCHIVE_STAGE_STATUS.DONE) {
        throw new ArchiveError(
          'ARCHIVE_STAGE_OUT_OF_ORDER',
          `必须先完成「${ARCHIVE_STAGE_LABEL[prev.stage_code] ?? prev.stage_code}」，才能完成「${
            ARCHIVE_STAGE_LABEL[stageCode] ?? stageCode
          }」`,
          409,
        );
      }
    }

    // ---- 照片：关键阶段 ≥1，任何阶段 ≤6 ----
    const photoCount = await this.countStagePhotos(archiveId, Number(stage.id));
    if (photoCount > ARCHIVE_STAGE_PHOTO_MAX) {
      throw new ArchiveError(
        'ARCHIVE_STAGE_PHOTO_TOO_MANY',
        `每个阶段最多 ${ARCHIVE_STAGE_PHOTO_MAX} 张照片，当前 ${photoCount} 张`,
        409,
      );
    }
    if (ARCHIVE_STAGE_PHOTO_REQUIRED.includes(stageCode) && photoCount < 1) {
      throw new ArchiveError(
        'ARCHIVE_STAGE_PHOTO_REQUIRED',
        `「${ARCHIVE_STAGE_LABEL[stageCode] ?? stageCode}」完成前必须至少上传 1 张照片`,
        409,
      );
    }

    // ---- 写：条件更新，靠 version 防并发 ----
    const [rows] = (await this.db.sequelize.query(
      `UPDATE service_archive_stages
          SET status = :status, stage_date = :stageDate, note = :note,
              completed_at = now(), completed_by = :by,
              version = version + 1, updated_at = now()
        WHERE id = :id AND version = :oldVersion
        RETURNING id`,
      {
        replacements: {
          status: ARCHIVE_STAGE_STATUS.DONE,
          stageDate: input.stage_date,
          note: input.note ?? null,
          by: actor.userId ?? null,
          id: Number(stage.id),
          oldVersion: Number(stage.version),
        },
      },
    )) as unknown as [Array<{ id: number }>];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new ArchiveError('ARCHIVE_STAGE_STALE', '该阶段刚被其他人修改，请刷新后重试', 409);
    }

    await this.archives.writeEvent(actor, archiveId, Number(stage.id), 'stage_completed', {
      stage_code: stageCode,
      stage_order: stage.stage_order,
      photo_count: photoCount,
    });

    // ---- 第六阶段完成 ⇒ 工程「已验收」 ----
    let finalArchive = archive;
    if (idx === ARCHIVE_STAGE_ORDER.length - 1) {
      await this.db.sequelize.query(
        `UPDATE service_archives
            SET status = :status, completed_at = COALESCE(completed_at, now()),
                version = version + 1, updated_by = :by, updated_at = now()
          WHERE id = :id`,
        {
          replacements: {
            status: ARCHIVE_STATUS.ACCEPTED,
            by: actor.userId ?? null,
            id: archiveId,
          },
        },
      );
      finalArchive = await this.loadArchive(archiveId);
    } else if (archive.status === ARCHIVE_STATUS.PENDING) {
      // 一旦开始做阶段，进度至少是"服务中"（不越过已完成/已验收）
      await this.db.sequelize.query(
        `UPDATE service_archives
            SET status = :status, version = version + 1, updated_by = :by, updated_at = now()
          WHERE id = :id AND status = :pending`,
        {
          replacements: {
            status: ARCHIVE_STATUS.SERVING,
            by: actor.userId ?? null,
            id: archiveId,
            pending: ARCHIVE_STATUS.PENDING,
          },
        },
      );
      finalArchive = await this.loadArchive(archiveId);
    }

    const updatedStage = await this.repo('serviceArchiveStages').findOne({
      filter: { id: Number(stage.id) },
    });
    this.logger?.info?.(
      `[archive] 阶段完成 archive=${archiveId} stage=${stageCode} 操作者=${actor.userId}`,
    );
    return { archive: finalArchive, stage: updatedStage };
  }

  // -------------------------------------------------------------------------
  // 撤回阶段
  // -------------------------------------------------------------------------

  /**
   * 受控撤回。
   *
   * **连锁**：撤回第 N 阶段时，所有 order > N 且已完成的阶段一并撤回。
   * 否则会出现"没做勘察、却已完成管路"的状态，而那在客户眼里就是进度造假。
   *
   * **留痕**：不物理删除、不清空 stage_date / completed_at；
   * 只置 `status=withdrawn` 并写 `withdraw_reason` + 事件。
   */
  async withdrawStage(
    actor: ArchiveActorLike,
    archiveId: number,
    stageCode: string,
    input: { reason: string; expected_version: number },
  ): Promise<{ archive: any; withdrawn: string[] }> {
    const archive = await this.loadArchive(archiveId);
    this.archives.assertCanWriteStore(actor, Number(archive.store_id));

    if (archive.archive_type !== ARCHIVE_TYPE.HVAC) {
      throw new ArchiveError('ARCHIVE_WRONG_TYPE', '只有暖通工程档案有阶段', 400);
    }
    if (archive.visibility === ARCHIVE_VISIBILITY.VOIDED) {
      throw new ArchiveError('ARCHIVE_VOIDED', '档案已作废，不能继续操作', 409);
    }
    if (!input?.reason || String(input.reason).trim() === '') {
      throw new ArchiveError('ARCHIVE_STAGE_MISSING_REASON', '撤回必须填写原因', 400);
    }

    const idx = ARCHIVE_STAGE_ORDER.indexOf(stageCode);
    if (idx < 0) {
      throw new ArchiveError('ARCHIVE_BAD_STAGE', `未知阶段 ${stageCode}`, 400);
    }
    const stages = await this.loadStages(archiveId);
    const stage = stages[idx];
    if (stage.status !== ARCHIVE_STAGE_STATUS.DONE) {
      throw new ArchiveError('ARCHIVE_STAGE_NOT_DONE', '只能撤回已完成的阶段', 409);
    }
    if (Number(input.expected_version) !== Number(stage.version)) {
      throw new ArchiveError('ARCHIVE_STAGE_STALE', '该阶段刚被其他人修改，请刷新后重试', 409);
    }

    // 目标阶段 + 其后所有已完成阶段
    const targets = stages
      .filter((s, i) => i >= idx && s.status === ARCHIVE_STAGE_STATUS.DONE)
      .map((s) => s.stage_code);

    // ⚠️ 真正的"连锁"要连**照片的发布状态**一起收，而不只是阶段状态。
    //
    // 三条写入必须在**同一个事务**里（用户 2026-11-10 冻结规则）：
    //   ① 阶段 → withdrawn
    //   ② 这些阶段的照片 → published=false（不删记录、不删 storage_key）
    //   ③ 工程状态 accepted → completed
    // 少任何一条的原子性，就会出现"阶段撤回了但照片还对外可见"这种
    // **半提交**状态 —— 而客户接口恰好只读照片的 published，于是撤回等于没撤回。
    //
    // 为什么用 `stage_id IN (...)` 而不是按 photo_type='stage' 批量刷：
    //   普通上门服务的照片 stage_id 为 NULL，绝不能因为"撤回暖通阶段"被顺带下架。
    const withdrawStageIds = stages
      .filter((s, i) => i >= idx && s.status === ARCHIVE_STAGE_STATUS.DONE)
      .map((s) => Number(s.id));

    const withdrawnCodes: string[] = [];
    await this.db.sequelize.transaction(async (t: any) => {
      for (let i = idx; i < stages.length; i += 1) {
        const s = stages[i];
        if (s.status !== ARCHIVE_STAGE_STATUS.DONE) continue;
        await this.db.sequelize.query(
          `UPDATE service_archive_stages
              SET status = :status, withdraw_reason = :reason,
                  version = version + 1, updated_at = now()
            WHERE id = :id AND status = :done`,
          {
            replacements: {
              status: ARCHIVE_STAGE_STATUS.WITHDRAWN,
              reason: String(input.reason).trim(),
              id: Number(s.id),
              done: ARCHIVE_STAGE_STATUS.DONE,
            },
            transaction: t,
          },
        );
        withdrawnCodes.push(s.stage_code);
      }

      // ② 照片取消发布（保留行与 storage_key；内部仍可查历史）
      if (withdrawStageIds.length > 0) {
        await this.db.sequelize.query(
          `UPDATE service_archive_photos
              SET published = false, updated_at = now()
            WHERE archive_id = :archiveId
              AND stage_id IN (:stageIds)
              AND published = true`,
          {
            replacements: { archiveId, stageIds: withdrawStageIds },
            transaction: t,
          },
        );
      }

      // ③ 已验收被撤回 ⇒ 退回"已完成"
      if (archive.status === ARCHIVE_STATUS.ACCEPTED) {
        await this.db.sequelize.query(
          `UPDATE service_archives
              SET status = :status, version = version + 1, updated_by = :by, updated_at = now()
            WHERE id = :id AND status = :accepted`,
          {
            replacements: {
              status: ARCHIVE_STATUS.COMPLETED,
              by: actor.userId ?? null,
              id: archiveId,
              accepted: ARCHIVE_STATUS.ACCEPTED,
            },
            transaction: t,
          },
        );
      }

      // 事件也进同一事务：回滚了就不该留下"撤回过"的审计
      for (const s of stages) {
        if (!withdrawnCodes.includes(s.stage_code)) continue;
        await this.archives.writeEvent(
          actor,
          archiveId,
          Number(s.id),
          'stage_withdrawn',
          {
            stage_code: s.stage_code,
            reason: String(input.reason).trim(),
            photos_unpublished: true,
          },
          t,
        );
      }
    });

    this.logger?.warn?.(
      `[archive] 阶段撤回 archive=${archiveId} 起点=${stageCode} 连带=${targets.join(',')} ` +
        `照片已取消发布(阶段 ${withdrawStageIds.join(',')}) 操作者=${actor.userId}`,
    );
    // 返回**实际**被撤回的阶段（而不是计划里的 targets）：
    // 两者理论上相同，但接口对外的语义应该是"发生了什么"，不是"打算做什么"。
    return { archive: await this.loadArchive(archiveId), withdrawn: withdrawnCodes };
  }

  /** 读阶段（给页面与验收用；照片只给数量与是否有，不给 storage_key） */
  async listStages(actor: ArchiveActorLike, archiveId: number): Promise<any[]> {
    const archive = await this.loadArchive(archiveId);
    this.archives.assertCanAccessRow(actor, archive);
    // 🔴 DEV-272：「这不是暖通档案」是**调用方用错了**，不是库坏了。
    //
    // 原来这里直接 loadStages()，而 loadStages 发现行数 ≠ 6 就抛
    // ARCHIVE_STAGE_ROWS_BROKEN(500)。于是"对普通上门服务档案问阶段"这种
    // **合法的错误输入**被报成 500「服务端异常」—— 前端只能显示"请在稍后再试"，
    // 运维看到 500 会去查数据库，而数据其实一行都没坏。
    //
    // 同一文件里 `completeStage()`/`withdrawStage()` 早就做了这个类型校验并返回
    // 400 ARCHIVE_WRONG_TYPE —— 只有**只读**的 listStages 漏了。
    // 读接口漏校验的代价比写接口更大：界面一渲染就会调它，每个普通服务档案都踩一次。
    if (archive.archive_type !== ARCHIVE_TYPE.HVAC) {
      throw new ArchiveError('ARCHIVE_WRONG_TYPE', '只有暖通工程档案有阶段', 400);
    }
    const stages = await this.loadStages(archiveId);
    const photos = await this.repo('serviceArchivePhotos').find({
      filter: { archive_id: archiveId },
      fields: ['id', 'stage_id', 'photo_type', 'published'],
    });
    return stages.map((s) => {
      const mine = (photos ?? []).filter((p: any) => Number(p.stage_id) === Number(s.id));
      return {
        id: s.id,
        stage_code: s.stage_code,
        stage_order: s.stage_order,
        status: s.status,
        stage_date: s.stage_date,
        note: s.note,
        completed_at: s.completed_at,
        completed_by: s.completed_by,
        version: s.version,
        withdraw_reason: s.withdraw_reason,
        photo_count: mine.length,
        photo_required: ARCHIVE_STAGE_PHOTO_REQUIRED.includes(s.stage_code),
        photo_max: ARCHIVE_STAGE_PHOTO_MAX,
      };
    });
  }
}

