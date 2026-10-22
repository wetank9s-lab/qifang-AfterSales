/**
 * UX-MEDIA-01：**后台查看客户上传的媒体**（只读清单 + 受控单文件流）。
 *
 * ===========================================================================
 * 为什么需要这两个 action（而不是放开原生表读取）
 * ===========================================================================
 * `customerMedias` 里有 `storage_key` / `upload_ip_hash` —— 存储实现信息。
 * 把它加进原生读取白名单就要长期维护字段 denylist（与 `serviceVisitPhotos`
 * 完全同型的风险，见 `docs/SECURITY.md` §2.3 与 DEV-83 的教训）。
 * ⇒ 与 I14 照片同口径：**只经业务端点**，字段由代码白名单决定。
 *
 * ===========================================================================
 * 授权链（固定顺序，缺一不可）
 * ===========================================================================
 *   ① 登录身份（ACL 已要求，匿名不可达）
 *   ② `CAPABILITY.WRITE_TICKET`
 *      —— 门店 / 总部售后 / 总部管理员可看；**viewer 不具备**（用户明确"不得因本次修复
 *         自动开放媒体"）。401 与 403 的区别由外层中间件给出，这里只管 403。
 *   ③ 归属：`media.ticket_id === session.ticket_id === 入参 ticketId`
 *      （用户要求"验证工单、上传会话和媒体记录之间的真实归属关系"）
 *   ④ 数据范围：`assertCanAccessTicket` —— 门店按授权门店，总部按全量；跨店 → 404
 *
 * 失败形态：**不存在 / 越权 / 归属不一致 / 畸形 id 统一 404**，响应体同形。
 *   不区分它们，是因为"能不能看出这张单有媒体"本身就是一条信息泄露
 *   （与 I14 照片的 B3/B4/R1 同口径）。
 *
 * ===========================================================================
 * 为什么文件走 `streamPrivateMedia`
 * ===========================================================================
 * 它是 P11-5 已经过真机验证的唯一私有媒体流实现（Range / 206 / 416 / 安全头）。
 * 再写一份 `createReadStream` 就是"同一个坑有两条腿"—— 本项目已经为此付过代价。
 * 本文件**只负责授权**，字节怎么吐由那个共享实现决定。
 *
 * ⚠️ 本文件**不签发任何 URL / Token**：后台前端走 `authenticated fetch → Blob`，
 *    每次都携带当前登录态的 Authorization（与技师回执照片同一模式）。
 */
import { CAPABILITY } from '../../services/permission-service';
import type { MediaStoreService } from '../../services/media-store';
import { streamPrivateMedia } from '../../../shared/private-media-stream';
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
 * ⚠️ `Services` 接口里**没有** `media`（它由插件在 afterLoad 里单独构造，
 * 见 `plugin.ts` 的 `this.mediaStore`）。而 `this.services` 这个**运行时对象**
 * 也没有填它 —— 类型声明 ≠ 实际赋值。师傅端详情接口就因此 500 过一次
 * （plugin.ts 里那段注释是那次事故留下来的）。
 * ⇒ 本文件把"必须拿到 mediaStore"写成类型 + 启动期自检：
 *    漏注入时**启动即失败**，而不是等到用户点开某张工单才 500。
 */
export type TicketMediaDeps = SvcActionDeps & {
  services: SvcActionDeps['services'] & { media: MediaStoreService };
};

export function createTicketMediaHandlers(deps: TicketMediaDeps): Record<string, ActionHandler> {
  const { services, logger } = deps;
  const { permissions, media } = services;

  if (
    !media ||
    typeof media.listBoundForTicket !== 'function' ||
    typeof media.readBound !== 'function'
  ) {
    throw new Error(
      '[service-ticket] createTicketMediaHandlers 缺少 mediaStore 注入：' +
        '后台客户媒体接口会全部 500（见 plugin.ts 的 media 注入注释）',
    );
  }

  const wrap = createWrapper(deps);

  /** 解析正整数 id（`?id=` 或 `?filterByTk=`）。非法一律按"不存在"处理。 */
  function readId(ctx: any, field: string): number | null {
    const raw = param(ctx, field) ?? paramsOf(ctx)?.filterByTk;
    const id = Number(raw);
    if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) return null;
    return id;
  }

  /** 唯一失败出口 —— 所有失败分支同形，避免状态码成为存在性探针。 */
  function notFoundMedia(ctx: any): void {
    fail(ctx, 404, 'MEDIA_NOT_FOUND', '客户材料不存在或已失效');
  }

  /** 数据范围断言：越权与不存在都视为拒绝（内部仍会记 warn 审计）。 */
  async function canAccess(actor: any, ticketId: number): Promise<boolean> {
    try {
      await permissions.assertCanAccessTicket(actor, ticketId);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // ① 清单：只回元数据，**不回** storage_key / 文件名 / 上传 IP
  // -------------------------------------------------------------------------
  const ticketMedia = wrap(SVC_ACTION.TICKET_MEDIA, async (ctx, actor) => {
    // viewer 在这一步被拒（403）。用户：viewer 不得因本次修复自动获得媒体。
    permissions.assertCapability(actor, CAPABILITY.WRITE_TICKET);

    const ticketId = readId(ctx, 'ticket_id');
    if (ticketId === null) {
      notFoundMedia(ctx);
      return;
    }
    if (!(await canAccess(actor, ticketId))) {
      notFoundMedia(ctx);
      return;
    }

    // 服务层逐条校验 media.ticket_id === session.ticket_id === ticketId
    const rows = await media.listBoundForTicket(ticketId);
    // 只投影白名单字段（即便服务层将来多返回一列，也不会自动带出）
    const list = rows.map((row: any) => ({
      id: Number(row.id),
      kind: String(row.kind ?? ''),
      mime: String(row.mime ?? ''),
      size: Number(row.size) || 0,
      durationMs: row.durationMs == null ? null : Number(row.durationMs),
      width: row.width == null ? null : Number(row.width),
      height: row.height == null ? null : Number(row.height),
      uploadedAt:
        row.uploadedAt == null
          ? null
          : (() => {
              const d = new Date(String(row.uploadedAt));
              return Number.isNaN(d.getTime()) ? String(row.uploadedAt) : d.toISOString();
            })(),
    }));

    ok(ctx, {
      ticket_id: ticketId,
      media: list,
      count: list.length,
    });
  });

  // -------------------------------------------------------------------------
  // ② 单文件：授权通过后才进入共享的流式读取（Range 由它负责）
  // -------------------------------------------------------------------------
  const ticketMediaFile = wrap(SVC_ACTION.TICKET_MEDIA_FILE, async (ctx, actor) => {
    permissions.assertCapability(actor, CAPABILITY.WRITE_TICKET);

    const mediaId = readId(ctx, 'id');
    if (mediaId === null) {
      notFoundMedia(ctx);
      return;
    }

    // readBound 返回的是**行 + 文件是否真的在**；不含任何可下发的存储信息
    const meta = await media.readBound(mediaId);
    if (!meta || meta.ticketId === null) {
      notFoundMedia(ctx);
      return;
    }

    // 归属一致性：会话也必须指向同一张工单
    const sessionTicket = await media.ticketOfSession(meta.sessionId);
    if (sessionTicket !== meta.ticketId) {
      logger.warn?.(`[svc:ticketMediaFile] 媒体 ${mediaId} 的会话归属与工单不一致，拒绝`);
      notFoundMedia(ctx);
      return;
    }

    if (!(await canAccess(actor, meta.ticketId))) {
      notFoundMedia(ctx);
      return;
    }

    // 🔴 至此授权全部完成；下面只负责把已确认可读的文件按 Range 吐出去。
    //    入口、安全头、206/416 语义都在共享实现里（P11-5 已验证）。
    streamPrivateMedia(
      ctx,
      { absPath: meta.absPath, mime: meta.mime, size: meta.size },
      { log: logger, label: '客户媒体' },
    );
  });

  return {
    [SVC_ACTION.TICKET_MEDIA]: ticketMedia,
    [SVC_ACTION.TICKET_MEDIA_FILE]: ticketMediaFile,
  };
}
