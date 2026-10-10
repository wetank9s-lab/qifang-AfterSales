/**
 * sms-orphan-resolver —— `pending` 孤儿"要不要补发、补发什么"的**领域裁决**（Phase 11 / P11-1 · B-16）
 * =============================================================================
 *
 * 为什么单独一个文件（而不是塞进 `SmsService`）
 * -----------------------------------------------------------------------------
 * `SmsService` 的职责边界是"一条短信怎么发出去"（模板、Provider、SmsLog、事件），
 * 它**刻意不认识**工单/上门记录。而"这条孤儿通知**现在**还成不成立"必须读业务表
 * （工单状态、visit 是否还是有效那一条、凭据还有效吗）——
 * 那是域逻辑。把两者混在一起，`SmsService` 会变成第二个 TicketService。
 * ⇒ 这里只做裁决 + 重建，**发送仍由 `SmsService.recoverOrphanedPending` 统一负责**。
 *
 * -----------------------------------------------------------------------------
 * 判据形状：**白名单 + 当前状态守卫**，两者都 fail-closed
 * -----------------------------------------------------------------------------
 *   ① scene 是否在 `SMS_SCENE_ORPHAN_REBUILDABLE` 白名单里？
 *      不在 ⇒ 不补发（含未知 scene）。
 *   ② 业务状态是否仍与"当初那条通知"相符？
 *      不相符 ⇒ 不补发（发出去是**过期信息**，比不发更糟）。
 *   ③ 收件人号码是否仍合法（`isMobile`，与 `enqueue` 同一校验函数）？
 *      不合法 ⇒ 不补发。
 *
 * -----------------------------------------------------------------------------
 * 🔴 关于"失效 Token 不重发"
 * -----------------------------------------------------------------------------
 * 含一次性凭据的两个 scene（`technician_task` / `review_invite`）**从不走到这里**的
 * 补发分支 —— `SmsService` 在调本模块之前就把它们截住了（这是硬闸，不看本模块返回什么）。
 * 但本模块仍然**会读一次凭据状态**，目的是给出**准确的原因码**：
 *
 *   · 凭据已用 / 已吊销 / 已过期 ⇒ `SMS_PENDING_ORPHAN_TOKEN_INVALID`
 *     （运维一眼看出"这条链接本来就废了，不发是对的"）
 *   · 凭据仍在有效窗口内、只是**明文丢了** ⇒ `SMS_PENDING_ORPHAN_TOKEN_LOST`
 *     （运维该去走"重新签发"的人工路径 —— 见 `docs/PHASE-7.md` §8.3）
 *
 * 两者都不发，但**它们对未来的人意味着完全不同的动作**。
 * 把这两件事合成一句"没发出去"，等于把唯一的线索扔掉。
 */
import {
  SMS_ORPHAN_TERMINAL_CODE,
  SMS_SCENE,
  SMS_SCENE_ONE_TIME_CREDENTIAL,
  SMS_SCENE_RECIPIENT,
  TICKET_STATUS,
  TICKET_TYPE_LABEL,
  VISIT_STATUS,
  isMobile,
} from '../constants';
import type { OrphanResolution, OrphanSmsRow } from './sms-service';

export interface OrphanResolverDeps {
  db: any;
  logger?: {
    warn?: (m: string) => void;
    debug?: (m: string) => void;
    info?: (m: string) => void;
  };
}

/** 只读业务行的最小取值（避免 `SELECT *` 把敏感列读进内存） */
const TICKET_FIELDS = [
  'id',
  'ticket_no',
  'ticket_type',
  'status',
  'store_id',
  'customer_mobile',
  'feedback_token_expires_at',
  'feedback_token_used_at',
  'review_status',
];
const VISIT_FIELDS = [
  'id',
  'ticket_id',
  'visit_no',
  'visit_status',
  'technician_name',
  'technician_mobile',
  'provider_name',
  'expected_visit_at',
];

/**
 * ⚠️ 下面两个函数**从 `ticket-service` 导入而不是重写**：
 *    重建出来的载荷必须与首发**逐字一致**（日期格式、门店名差一个字符，
 *    客户收到的短信就不同，而 mock 通道下**不会报错**）。
 *    同口径的唯一保障是**同一个函数**，不是两份长得一样的代码。
 */
import { formatVisitDate, storeLabelOf } from './ticket-service';

export function createOrphanResolver(deps: OrphanResolverDeps) {
  const { db } = deps;

  /**
   * ⚠️ 用 `storeLabelOf`（`门店名(编码)`）而**不是** `storeDisplayNameOf`（只要门店名）：
   *    这三个可重建 scene 的通知短信（派工/改派/取消派工）走的都是前者，
   *    重建必须与首发逐字一致 —— 少了 `(S01)` 后缀在 mock 通道下**不报错**，
   *    只有客户真的收到才会发现两条短信长得不一样。
   */
  const storeNameOf = (storeId: unknown) => storeLabelOf(db, Number(storeId));

  return async function resolveOrphan(row: OrphanSmsRow): Promise<OrphanResolution> {
    const scene = String(row.scene ?? '');
    const ticketId = Number(row.ticket_id);
    if (!Number.isFinite(ticketId) || ticketId <= 0) {
      return {
        kind: 'terminal',
        code: SMS_ORPHAN_TERMINAL_CODE.STALE,
        reason: 'SmsLog 没有关联工单 ⇒ 无法判断通知是否仍成立，保守不发',
      };
    }

    const ticket: any = await db
      .getRepository('serviceTickets')
      .findOne({ filter: { id: ticketId }, fields: TICKET_FIELDS });
    if (!ticket) {
      return {
        kind: 'terminal',
        code: SMS_ORPHAN_TERMINAL_CODE.STALE,
        reason: `工单 ${ticketId} 已不存在 ⇒ 不补发`,
      };
    }

    const visitId = Number(row.visit_id);
    const visit: any =
      Number.isFinite(visitId) && visitId > 0
        ? await db
            .getRepository('serviceVisits')
            .findOne({ filter: { id: visitId }, fields: VISIT_FIELDS })
        : null;

    const store = await storeNameOf(ticket.store_id);
    const ticketNo = String(ticket.ticket_no ?? '');
    const label = TICKET_TYPE_LABEL[String(ticket.ticket_type)] ?? '报修';

    // =====================================================================
    // 含一次性凭据 ⇒ 只给出**准确的原因码**，不发（SmsService 已先截过一道）
    // =====================================================================
    if (SMS_SCENE_ONE_TIME_CREDENTIAL[scene] === true) {
      return {
        kind: 'terminal',
        code: credentialCodeOf(scene, ticket, visit),
        reason: credentialReasonOf(scene, ticket, visit),
      };
    }

    // =====================================================================
    // 可重建的三个 scene
    // =====================================================================
    if (scene === SMS_SCENE.TECHNICIAN_ASSIGNMENT_CANCELLED) {
      // 这条是发给**原师傅**的"任务已取消"。它成立的前提是**那次派工确实作废了**。
      if (!visit) {
        return {
          kind: 'terminal',
          code: SMS_ORPHAN_TERMINAL_CODE.STALE,
          reason: `作废派工短信的 visit=${row.visit_id ?? '-'} 已不存在 ⇒ 不补发`,
        };
      }
      const voided = [VISIT_STATUS.SUPERSEDED, VISIT_STATUS.CANCELLED].includes(
        String(visit.visit_status),
      );
      if (!voided) {
        return {
          kind: 'terminal',
          code: SMS_ORPHAN_TERMINAL_CODE.STALE,
          reason:
            `该派工（visit=${visit.id}）现在是 ${visit.visit_status}，**并未作废** ⇒ ` +
            '「任务已取消」这条通知已不成立，不补发',
        };
      }
      const to = String(visit.technician_mobile ?? '');
      if (!isMobile(to)) {
        return {
          kind: 'terminal',
          code: SMS_ORPHAN_TERMINAL_CODE.STALE,
          reason: '原师傅手机号已不可用（provider-only 或已清空）⇒ 不补发',
        };
      }
      return {
        kind: 'send',
        to,
        recipientKind: String(SMS_SCENE_RECIPIENT[scene] ?? ''),
        params: {
          store,
          ticket_no: ticketNo,
          expected: formatVisitDate(visit.expected_visit_at),
        },
      };
    }

    if (
      scene === SMS_SCENE.DISPATCH_CUSTOMER ||
      scene === SMS_SCENE.DISPATCH_UPDATE
    ) {
      // 给客户的派工/更新通知。它成立的前提是：
      //   ① 工单仍在处理中（闭环/取消之后再发"师傅将上门"是错的）；
      //   ② 这条通知指向的 visit **仍是有效那一条**（被改派取代之后再发旧时间也是错的）。
      if (String(ticket.status) !== TICKET_STATUS.PROCESSING) {
        return {
          kind: 'terminal',
          code: SMS_ORPHAN_TERMINAL_CODE.STALE,
          reason: `工单现在是 ${ticket.status}，不再是"处理中" ⇒ 派工通知已过期，不补发`,
        };
      }
      if (!visit) {
        return {
          kind: 'terminal',
          code: SMS_ORPHAN_TERMINAL_CODE.STALE,
          reason: `派工通知的 visit=${row.visit_id ?? '-'} 已不存在 ⇒ 不补发`,
        };
      }
      if (Number(visit.ticket_id) !== ticketId) {
        return {
          kind: 'terminal',
          code: SMS_ORPHAN_TERMINAL_CODE.STALE,
          reason: `visit=${visit.id} 不属于工单 ${ticketId} ⇒ 数据不一致，不补发`,
        };
      }
      // 🔴 关键守卫：`SUPERSEDED` 意味着这次派工**已被改派/改约取代**，
      //    旧通知里的时间/师傅都是过去的信息。
      if (String(visit.visit_status) === VISIT_STATUS.SUPERSEDED) {
        return {
          kind: 'terminal',
          code: SMS_ORPHAN_TERMINAL_CODE.STALE,
          reason: `visit=${visit.id} 已被取代（SUPERSEDED）⇒ 这条通知的时间/师傅已过期，不补发`,
        };
      }
      const to = String(ticket.customer_mobile ?? '');
      if (!isMobile(to)) {
        return {
          kind: 'terminal',
          code: SMS_ORPHAN_TERMINAL_CODE.STALE,
          reason: '客户手机号已不可用 ⇒ 不补发',
        };
      }
      return {
        kind: 'send',
        to,
        recipientKind: String(SMS_SCENE_RECIPIENT[scene] ?? ''),
        params: {
          store,
          label,
          ticket_no: ticketNo,
          // 与 `enqueueDispatchPair` 逐字一致：provider-only 时退回服务商名称
          technician: String(visit.technician_name ?? visit.provider_name ?? ''),
          expected: formatVisitDate(visit.expected_visit_at),
        },
      };
    }

    // 白名单里出现了这里没覆盖的 scene ⇒ 代码缺陷（白名单加了一个却没实现重建）
    // ⚠️ 报 warn 并**不发**：宁可少发一条，也不能凭猜测拼一条通知给真人。
    deps.logger?.warn?.(
      `[sms-orphan] scene "${scene}" 在白名单里但解析器没有对应分支 —— ` +
        '这是代码缺陷（白名单与解析器漂移），本次不补发',
    );
    return {
      kind: 'terminal',
      code: SMS_ORPHAN_TERMINAL_CODE.UNREBUILDABLE,
      reason: `解析器没有 scene "${scene}" 的重建分支（白名单与解析器漂移）⇒ 不补发`,
    };
  };
}

/**
 * 含凭据的 scene：给出**具体原因**（已失效 / 明文丢失）。
 *
 * ⚠️ 这里读的是"业务侧现在还需不需要这次评价/这次作业"，
 *    而不是"凭据字符串还有效吗" —— 后者库内只有 sha256，无法比对。
 *    能判定的是**等价且更有用**的事实：这张单还处在该凭据应被使用的状态吗？
 */
function credentialCodeOf(scene: string, ticket: any, visit: any): string {
  if (scene === SMS_SCENE.REVIEW_INVITE) {
    const used = ticket.feedback_token_used_at != null;
    const expired = isExpired(ticket.feedback_token_expires_at);
    const awaiting = String(ticket.status) === TICKET_STATUS.WAIT_FEEDBACK;
    if (used || expired || !awaiting) {
      return SMS_ORPHAN_TERMINAL_CODE.TOKEN_INVALID;
    }
    return SMS_ORPHAN_TERMINAL_CODE.TOKEN_LOST;
  }
  if (scene === SMS_SCENE.TECHNICIAN_TASK) {
    // 作业链接的凭据在 visit 上：visit 一旦离开 ASSIGNED（提交/确认/被取代/作废），
    // 原链接就不再是该用它的东西了。
    const stillAssigned = visit && String(visit.visit_status) === VISIT_STATUS.ASSIGNED;
    if (!stillAssigned) return SMS_ORPHAN_TERMINAL_CODE.TOKEN_INVALID;
    return SMS_ORPHAN_TERMINAL_CODE.TOKEN_LOST;
  }
  return SMS_ORPHAN_TERMINAL_CODE.TOKEN_LOST;
}

function credentialReasonOf(scene: string, ticket: any, visit: any): string {
  const code = credentialCodeOf(scene, ticket, visit);
  if (code === SMS_ORPHAN_TERMINAL_CODE.TOKEN_INVALID) {
    return (
      `scene "${scene}" 的一次性凭据**已失效**（工单状态=${ticket.status}` +
      `${ticket.feedback_token_used_at ? ' / Token 已使用' : ''}` +
      `${visit ? ` / visit=${visit.visit_status}` : ''}）⇒ ` +
      '补发出去也是个打不开的死链接，**按口径不重发**'
    );
  }
  return (
    `scene "${scene}" 的一次性凭据仍在有效窗口内，但**明文只在内存、已随进程退出丢失**` +
    '（库内只有 sha256，无法反推）⇒ 后台任务不替人做"重新签发"这个决定，' +
    '须由人工按 docs/PHASE-7.md §8.3 处理'
  );
}

function isExpired(value: unknown): boolean {
  if (value == null || value === '') return false;
  const t = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(t) ? t <= Date.now() : false;
}
