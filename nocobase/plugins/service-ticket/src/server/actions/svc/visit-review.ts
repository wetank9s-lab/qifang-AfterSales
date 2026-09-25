/**
 * Phase 6 · P6-0：门店审核**读**接口（只读，不含确认/驳回）。
 *
 * 两个 action（`docs/API.md` §4 的 I11 / I14；`docs/PHASE-6.md` §6）：
 *   · `visitDetail` —— 门店回执读模型。对外 `GET /api/svc/visits/:id`
 *     （nginx 重写成 `/api/svc:visitDetail?filterByTk=<visitId>`）。
 *   · `photo`       —— 私有照片**受控读取**。对外 `GET /api/svc/photos/:photoId`
 *     （nginx 重写成 `/api/svc:photo?filterByTk=<photoId>`）。
 *
 * 为什么不复用 action 名 `visits`：它已经表示"按 ticketId 列某工单的派工历史"，
 * 与本文件"按 visitId 取单条审核读模型"**同名不同义**（见 `constants.ts` 的 SVC_ACTION 注释）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 安全口径（三条，缺一不可）
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ① **照片不是"知道 id 就能看"**：`photo` 每一次都走完整授权链
 *    登录身份 → resolveActor → Photo→Visit→Ticket 归属 → 数据范围断言 → 流式返回。
 *
 * ② **失败一律同形**：不存在 / 越权 / 畸形 id **统一 `404 PHOTO_NOT_FOUND`**，
 *    响应体**逐字节相同** —— 不让状态码或文案成为"这张照片存不存在"的探测器
 *    （`docs/PHASE-6.md` §5 的 B3/B4/R1）。
 *
 * ③ **不发任何签名 URL / 短期凭证**：后台前端走 `authenticated fetch → Blob`，
 *    每次取图都经过当前登录身份（`docs/PHASE-6.md` §4.3a）。因此这里**不 import**
 *    任何签名工具，也不读 `SIGN_SECRET`。
 *
 * 为什么 `serviceVisitPhotos` 不进原生读取白名单：该表含 `storage_key` /
 * `upload_ip_hash` 等存储实现信息，只能经本文件的两个受控端点访问
 * （`docs/SECURITY.md` §2.3；反向门见 `scripts/verify-store-photo-access.mjs` 的 N1）。
 */
import { createReadStream } from 'node:fs';

import { SVC_ACTION } from '../../constants';
import { fail, ok } from './_http';
import {
  createWrapper,
  param,
  paramsOf,
  type ActionHandler,
  type SvcActionDeps,
} from './_request';

/**
 * I11 读模型**只暴露**这些 Visit 列（显式白名单，逐字段列举）。
 *
 * ⚠️ 刻意**不**用 `maskVisitForActor()` 那种"整行 + 删列"的写法：
 *    读模型是**给人看的一小块**，白名单能让"将来新增一列会不会顺带泄出去"
 *    这个问题自动变成"否"，而删列黑名单需要每次新增列都记得同步。
 *    凭据列（`access_token_hash` / `token_*`）不在白名单里，天然不外流。
 */
const VISIT_REVIEW_FIELDS = [
  // 标识与状态
  'id',
  'visit_no',
  'visit_status',
  'store_confirm_status',
  // 技师回执（Phase 5 写入）
  'service_result',
  'service_note',
  'is_charged',
  'reported_charge_amount',
  'submitted_at',
  // 展示用的上下文（不含凭据）
  'technician_name',
  'service_mode',
  'provider_name',
  'expected_visit_at',
  'assigned_at',
] as const;

/**
 * 照片的**安全展示元数据**白名单。
 * **不得**含 `storage_key` / `upload_ip_hash` / `file_id` / `visit_id`。
 */
const PHOTO_DISPLAY_FIELDS = [
  'id',
  'photo_type',
  'mime',
  'size',
  'width',
  'height',
  'sort_order',
  'uploaded_at',
] as const;

/** 从 Sequelize Model 实例或普通对象里取字段（两种形态都可能出现） */
function readField(source: any, field: string): unknown {
  if (source == null) return undefined;
  if (typeof source.get === 'function') return source.get(field);
  return source[field];
}

/** 白名单投影 */
function pick(source: any, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = readField(source, field);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

export function createVisitReviewHandlers(deps: SvcActionDeps): Record<string, ActionHandler> {
  const { services, logger } = deps;
  const { permissions, visits, photos } = services;

  const wrap = createWrapper(deps);

  /**
   * 解析正整数 id（来自 `?filterByTk=` 或显式传参）。
   * 非法返回 null —— 调用方**一律按"不存在"处理**，而不是抛 422：
   * 422 会把"格式不对"与"不存在"区分开，正好是 §5 R1 要避免的信息泄露。
   */
  function readId(ctx: any, field: string): number | null {
    const raw = param(ctx, field) ?? paramsOf(ctx)?.filterByTk;
    const id = Number(raw);
    if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) return null;
    return id;
  }

  /** 照片侧的**唯一失败出口** —— 所有失败分支都走它，保证响应体逐字节一致 */
  function notFoundPhoto(ctx: any): void {
    fail(ctx, 404, 'PHOTO_NOT_FOUND', '照片不存在或已失效');
  }

  /** 读模型侧的失败出口（与照片侧同理：不区分"越权"与"不存在"） */
  function notFoundVisit(ctx: any): void {
    fail(ctx, 404, 'VISIT_NOT_FOUND', '服务回执不存在');
  }

  /**
   * 数据范围断言：越权与不存在**都视为拒绝**。
   * 刻意吞掉 `assertCanAccessTicket` 抛出的 `NotFoundError` ——
   * 它自己会在内部记 warn（越权审计不丢），但对外我们只回统一的 404 文案，
   * 不让"工单存在但你没权限"与"工单不存在"在响应上可区分。
   */
  async function canAccess(actor: any, ticketId: number): Promise<boolean> {
    try {
      await permissions.assertCanAccessTicket(actor, ticketId);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // I11 —— 门店审核读模型（只读）
  // -------------------------------------------------------------------------
  const visitDetail = wrap(SVC_ACTION.VISIT_DETAIL, async (ctx, actor) => {
    const visitId = readId(ctx, 'visit_id');
    if (visitId === null) {
      notFoundVisit(ctx);
      return;
    }

    const visit = await visits.findById(visitId);
    if (!visit) {
      notFoundVisit(ctx);
      return;
    }

    const ticketId = Number(readField(visit, 'ticket_id'));
    if (!(await canAccess(actor, ticketId))) {
      notFoundVisit(ctx);
      return;
    }

    // listPhotos 已在服务层剔除 storage_key / upload_ip_hash；这里再做一次白名单投影。
    const photoRows = (await visits.listPhotos(visitId)) || [];

    ok(ctx, {
      visit: pick(visit, VISIT_REVIEW_FIELDS),
      photos: photoRows.map((row: any) => pick(row, PHOTO_DISPLAY_FIELDS)),
      count: photoRows.length,
    });
  });

  // -------------------------------------------------------------------------
  // I14 —— 私有照片受控读取（只读；无签名 URL）
  // -------------------------------------------------------------------------
  const photo = wrap(SVC_ACTION.PHOTO, async (ctx, actor) => {
    const photoId = readId(ctx, 'photo_id');
    if (photoId === null) {
      notFoundPhoto(ctx);
      return;
    }

    // findPhotoById 返回**完整行（含 storage_key）** —— 只在服务端用，绝不进响应
    const row = await visits.findPhotoById(photoId);
    if (!row) {
      notFoundPhoto(ctx);
      return;
    }

    const visitId = Number(readField(row, 'visit_id'));
    const storageKey = String(readField(row, 'storage_key') ?? '');

    const visit = await visits.findById(visitId);
    if (!visit) {
      notFoundPhoto(ctx);
      return;
    }

    const ticketId = Number(readField(visit, 'ticket_id'));
    if (!(await canAccess(actor, ticketId))) {
      notFoundPhoto(ctx);
      return;
    }

    const stored = await photos.read(photoId);
    if (!stored) {
      notFoundPhoto(ctx);
      return;
    }

    // 行在、但文件没了：回 404 而不是 500（与 Phase 5 师傅端 photo handler 同口径）
    if (!storageKey || !(await photos.exists(storageKey))) {
      logger.warn?.(
        `[svc:photo] photo=${photoId} 在库但文件缺失（${stored.absPath}）`,
      );
      notFoundPhoto(ctx);
      return;
    }

    ctx.withoutDataWrapping = true;
    // Content-Type 取**库中记录的** mime，而不是从磁盘重嗅 / 采信请求声明
    ctx.set?.('Content-Type', stored.mime);
    ctx.set?.('X-Content-Type-Options', 'nosniff');
    // 私有内容：禁止任何中间层缓存，也禁止浏览器写进磁盘缓存
    ctx.set?.('Cache-Control', 'private, no-store');
    ctx.set?.('Content-Disposition', 'inline');
    ctx.status = 200;
    ctx.body = createReadStream(stored.absPath, (error: any) => {
      // 流式读取中途出错时响应头已发出，只能记日志 + 断开
      logger.error?.(`[svc:photo] 读取照片流失败（${stored.absPath}）：${error?.message}`);
    });
  });

  return {
    [SVC_ACTION.VISIT_DETAIL]: visitDetail,
    [SVC_ACTION.PHOTO]: photo,
  };
}
