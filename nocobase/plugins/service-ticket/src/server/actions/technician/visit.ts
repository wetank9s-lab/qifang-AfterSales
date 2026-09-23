/**
 * 师傅作业接口（Phase 5 / P5-0）—— `technicianVisit` 资源的三个匿名 action。
 *
 * 对外路径（由 nginx 重写，见 DEV-18 与 `nginx/conf.d/service.conf`）：
 *
 *   GET  /api/technician/visits/:token          → `/api/technicianVisit:get?token=…`
 *   POST /api/technician/visits/:token/files    → `/api/technicianVisit:upload?token=…`
 *   POST /api/technician/visits/:token/submit   → `/api/technicianVisit:submit?token=…`
 *
 * ⚠️ **对外路径与 NocoBase 内部路径是同一个接口**，不是两套实现
 *    （理由与写法同 `/api/public/`，见该段注释与 DEV-18）。
 *
 * ---------------------------------------------------------------------------
 * P5-0 的范围：**只证明"路由打得通 + 认证自守"**，不实现业务
 * ---------------------------------------------------------------------------
 * 本轮（P5-0 · Routing & Environment Gate）刻意只交付：
 *   · `get`    —— Token 认证 + 返回**最小工单上下文**（API.md §2.1）。
 *                 它同时是路由闸门的取证对象：随机 token 必须在**这一步**返回
 *                 `401 TOKEN_INVALID`，而不是让 resourcer 先回 404。
 *   · `upload` —— 认证通过后返回 **501 NOT_IMPLEMENTED**（业务留 P5-1）。
 *   · `submit` —— 同上。
 *
 * 为什么 `upload` / `submit` 先"注册但返回 501"而不是干脆不注册：
 *   ① 路由闸门要对**三条真实路径**取证（否则"三条都配对了"这句话只说了一条）；
 *   ② 501 是**诚实**的中间态 —— 它明确区分"接口不存在（404）"与
 *      "接口在、但这一步还没做（501）"，不会让人把未实现误读成已实现；
 *   ③ 三条 action 一起进 ACL 白名单与资源形状自检，
 *      避免 Phase 5 收尾时才发现某一条的 `only` 白名单配漏。
 *
 * ⚠️ **`upload` / `submit` 的 501 必须在认证之后**：不能"未实现所以先不管鉴权"——
 *    那样两个接口会短暂地变成匿名可探测的开放端点。
 */
import { TECHNICIAN_ACTION, TECHNICIAN_SETTING_KEY, VISIT_STATUS } from '../../constants';
import type { Services } from '../../services';
import { fail, ok } from '../svc/_http';
import type { ActionHandler } from '../svc/_request';
import { withTechnicianAuth, type TechnicianActionDeps } from './_auth';

/**
 * 师傅侧看到的作业状态（API.md §2.1 的 `status`）。
 *
 * 为什么是一个新字面量而不是直接回 `visit_status`：
 *   `verify()` 只放行 `visit_status === 'ASSIGNED'` 的 Visit，也就是说**能走到 handler
 *   的请求，作业状态必然是"待师傅作业"**。API.md §2.1 把它写成 `"pending"`，
 *   这里照契约实现。
 *   ⚠️ 它是**投影值**（师傅视角），不是 `VISIT_STATUS` 枚举的成员 ——
 *      别拿它去比对库里的 `visit_status`（那边是 `ASSIGNED`）。
 *      `VISIT_STATUS.ASSIGNED` 是它的来源，两者在 `get` 里同时回显，
 *      便于前端与排障一眼对上。
 */
const TECHNICIAN_JOB_STATUS = {
  PENDING: 'pending',
} as const;

export interface TechnicianHandlerDeps extends TechnicianActionDeps {
  /** 计照片数需要直接读 `serviceVisitPhotos`（VisitService 没有这个只读聚合） */
  db: any;
}

export function createTechnicianActionHandlers(
  deps: TechnicianHandlerDeps,
): Record<string, ActionHandler> {
  const { services, logger } = deps;

  /**
   * `GET /api/technician/visits/:token` —— 打开作业页所需的**最小必要信息**。
   *
   * 刻意**不回**的东西（每一条都是"能少给就少给"）：
   *   · `customer_mobile` / `customer_name` —— 师傅联系客户走门店，不由本接口派号
   *     （API.md §2.1：「客户姓名仅在使用需要时返回（默认不返回）」）；
   *   · `visit.id` / `ticket.id` —— 内部主键，匿名接口不回（同 `publicTicket` 的理由）；
   *   · `access_token_hash` / `storage_key` —— 凭据类，任何情况下都不出站。
   *
   * 回显 `max_photos` / `max_photo_size_mb` 是为了让页面**自己**能在上传前先拦一道
   * （体验用）。真正的上限校验在**服务端**（P5-1 的 upload）——
   * **前端校验不是校验**。
   */
  const get = withTechnicianAuth(deps, TECHNICIAN_ACTION.GET, async (ctx, auth) => {
    const ticketId = Number(auth.visit.ticket_id);

    const ticket = await deps.db
      .getRepository('serviceTickets')
      .findOne({ filter: { id: ticketId } });
    if (!ticket) {
      // 理论上不可达（verify 已确认工单处于进行中）。真出现说明工单在
      // verify 与本行之间被删了 —— 按"链接失效"处理，与其它失效同一种对外表现。
      logger.warn?.(
        `[technician:get] Token 有效但工单 ${ticketId} 不存在（visit=${String(
          auth.visit.id,
        )}），按 TOKEN_INVALID 返回`,
      );
      fail(ctx, 401, 'TOKEN_INVALID', '链接无效或已失效，请联系门店重新获取');
      return;
    }

    const store = ticket.store_id
      ? await deps.db.getRepository('stores').findOne({ filter: { id: Number(ticket.store_id) } })
      : null;

    // 只数，不取行：`count` 不会把 storage_key / mime 等字段带进内存。
    const photosCount = await deps.db
      .getRepository('serviceVisitPhotos')
      .count({ filter: { visit_id: Number(auth.visit.id) } });

    const maxPhotos = await services.config.getInt(TECHNICIAN_SETTING_KEY.PHOTO_MAX_COUNT, 6);
    const maxPhotoSizeMb = await services.config.getInt(
      TECHNICIAN_SETTING_KEY.PHOTO_MAX_SIZE_MB,
      5,
    );

    ok(ctx, {
      ticket_no: String(ticket.ticket_no ?? ''),
      store_name: String(store?.name ?? ''),
      ticket_type: String(ticket.ticket_type ?? ''),
      // 报修内容：师傅靠它判断带什么工具，属"作业必需"
      content: String(ticket.content ?? ''),
      expected_visit_at: toIsoOrNull(auth.visit.expected_visit_at),
      expires_at: toIsoOrNull(auth.visit.token_expires_at),
      // 师傅视角状态 + 其来源枚举值（见 TECHNICIAN_JOB_STATUS 注释）
      status: TECHNICIAN_JOB_STATUS.PENDING,
      visit_status: String(auth.visit.visit_status ?? ''),
      photos_count: Number(photosCount) || 0,
      max_photos: maxPhotos,
      max_photo_size_mb: maxPhotoSizeMb,
    });

    logger.debug?.(
      `[technician:get] 已返回作业上下文（visit=${String(auth.visit.id)} ticket=${String(
        ticket.ticket_no,
      )} photos=${photosCount}）`,
    );
  });

  /**
   * 三条"还没实现"的 action 共用一个出口。
   *
   * 用同一份实现而不是各写一句：501 的文案与 code 是**对外契约的一部分**
   * （P5-1 接手时要把它们删掉），两份手写迟早漂移。
   */
  const notImplemented = (actionName: string, what: string): ActionHandler =>
    withTechnicianAuth(deps, actionName, async (ctx) => {
      // 走到这里说明 **Token 已经有效** —— 501 而不是 401 是准确的：
      // 不是"你没资格"，而是"服务端这一步还没做"。
      fail(
        ctx,
        501,
        'NOT_IMPLEMENTED',
        `${what}尚未实现（Phase 5 P5-1 交付），当前仅完成路由与认证`,
        { action: actionName },
      );
    });

  return {
    [TECHNICIAN_ACTION.GET]: get,
    [TECHNICIAN_ACTION.UPLOAD]: notImplemented(TECHNICIAN_ACTION.UPLOAD, '照片上传'),
    [TECHNICIAN_ACTION.SUBMIT]: notImplemented(TECHNICIAN_ACTION.SUBMIT, '回执提交'),
  };
}

/**
 * PG 的 `timestamptz` 经 Sequelize 取回来可能是 Date，桩环境可能是字符串。
 * 一律归一成 ISO 字符串输出 —— 直接把 Date 塞进 JSON 也能序列化，
 * 但两种形态混在同一个响应里会让前端与断言各写一套解析。
 */
function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 供断言脚本与文档引用：师傅侧作业状态的合法取值集合 */
export const TECHNICIAN_JOB_STATUS_VALUES = Object.values(TECHNICIAN_JOB_STATUS);

/** 保持与枚举的显式关联，防止有人误以为 `pending` 是 VISIT_STATUS 的成员 */
export const TECHNICIAN_JOB_STATUS_SOURCE = VISIT_STATUS.ASSIGNED;
