/**
 * SLA overdue 检测（Phase 8 / P8-C，契约 §3）。
 *
 * ---------------------------------------------------------------------------
 * 本模块**只检测，不改任何状态**
 * ---------------------------------------------------------------------------
 * 用户 2026-09-26 明令 + 契约 §3.4 冻结：
 *   · **不发** SLA 提醒短信（明确切断，防止膨胀成"通知谁/多久提醒一次/quiet hours…"）；
 *   · **不无条件写** `TicketEvent`（一张工单连续超时三天、每 5 分钟扫一次，
 *     审计轨迹会被瞬间废掉）；
 *   · **不新建 Ticket 状态** —— SLA 是**派生运营事实**，不得污染核心状态机。
 *
 * ⇒ 本模块是**纯读**的：产出"当前有哪些工单/派工处于 SLA overdue"这个**事实**，
 *    并聚合出计数供 `health` 与后续 Phase 9 的 HQ 看板消费。
 *
 * ---------------------------------------------------------------------------
 * 🔴 本模块唯一真正容易写错的地方：`appointmentOverdue` 的时间基准（DEV-71）
 * ---------------------------------------------------------------------------
 * `expected_visit_at` 是**日期语义**：DB 里的 `12:00+08:00` 只是**防跨日的技术归一值**，
 * **不是**客户约定过的上门时刻。
 *
 * ⛔ **禁止**：`expected_visit_at + graceMs`
 *    （会得到"预计当天 14:00 超时"这种**客户从未约定过的**假业务含义）
 *
 * ✅ **正确**（契约 §3.3 冻结）：
 * ```
 *   ① expected_visit_at  →  appointmentDateOnly()  取裸日期 YYYY-MM-DD
 *   ② 裸日期             →  当地 23:59:59.999 (+08:00)
 *   ③ + sla.appointment_overdue_grace_minutes
 *   ④ 与 now 比较 ⇒ overdue
 * ```
 *
 * ---------------------------------------------------------------------------
 * clock_mode = calendar elapsed time（契约 §3.2）
 * ---------------------------------------------------------------------------
 * 用**日历自然时间**，**不实现**营业时间日历。未来业务确需 business-hours SLA
 * 时再作为明确功能加入 —— 不让 Phase 8 卡在"门店营业日历系统"上。
 */
import { TASK_NAME, TICKET_STATUS, VISIT_STATUS } from '../constants';
import { appointmentDateOnly, APPOINTMENT_TIMEZONE_OFFSET } from '../../shared/service-mode';
import type { ConfigService } from './config-service';
import { TASK_RESULT, isShutdownSignal } from './task-registry';
import type { Services } from './services';

/** 三类 overdue 事实的聚合（health / HQ 消费；**不含**工单明细） */
export interface SlaOverdueSummary {
  /** 待门店受理超时：`status='NEW'` 且 `created_at + sla.accept_minutes < now` */
  acceptanceOverdue: number;
  /** 预计上门日期已过（DEV-71 日期语义 + grace）且尚未上门完成 */
  appointmentOverdue: number;
  /** 门店确认超时：Ticket 仍 `WAIT_STORE_CONFIRM` 且 `submitted_at + sla.store_confirm_hours < now` */
  storeConfirmOverdue: number;
}

/** 单个 overdue 事实（含定位信息，供排障与 Phase 9 消费） */
export interface SlaOverdueFact {
  kind: 'acceptance' | 'appointment' | 'store_confirm';
  ticketId: number;
  ticketNo: string | null;
  visitId: number | null;
  /** 该事实的判定基准时刻（ISO）；= 合同里那个"从何时起算超时" */
  dueFrom: string;
}

export interface SlaScanResult extends SlaOverdueSummary {
  /** 本轮扫描时刻（ISO） */
  scannedAt: string;
  /** 命中的 overdue 明细（受 `detailLimit` 限制；计数是全量的） */
  facts: SlaOverdueFact[];
  /** 本轮读到的一致性快照所用的三个参数值（便于排障与门禁断言） */
  thresholds: {
    acceptMinutes: number;
    graceMinutes: number;
    storeConfirmHours: number;
  };
}

/**
 * SLA 扫描**只需要**这四个只读能力。
 *
 * ⚠️ 为什么用窄接口而不是整个 `Services`：
 *    health 每次探针都要算一遍 SLA 计数。若为此 `createServices(app.db)` 构造整套服务图
 *    （SmsService / PhotoService / GuardService…），会有两个问题：
 *      ① **浪费**：每次健康检查都建一堆没人用的对象；
 *      ② **误导**：那个临时图里的 `tasks` 登记处是**另一个实例**，
 *         于是 `tasks.sla_scan.neverRan` 会一直为 true —— 运维看到
 *         "SLA 从没跑过，但却有 overdue 计数"，这是自相矛盾的信号。
 *    ⇒ 用窄接口后，health 路径**不传** `tasks`（它本就不该写 observability），
 *      而调度器路径照旧传真实 registry。
 */
export interface SlaScanPort {
  /** 读三个 SLA 阈值（缺键/类型不对时的兜底在调用方实现里） */
  readThresholds(): Promise<{ acceptMinutes: number; graceMinutes: number; storeConfirmHours: number }>;
  /** 待受理超时计数（`status='NEW'` 且 `created_at < before`） */
  countAcceptanceOverdue(before: Date): Promise<number>;
  /** 待受理超时明细 */
  listAcceptanceOverdue(before: Date, limit: number): Promise<Array<{ id: number; ticket_no: string }>>;
  /** 门店确认超时计数（Visit `submitted_at < before`） */
  countStoreConfirmOverdue(before: Date): Promise<number>;
  /** 门店确认超时明细 */
  listStoreConfirmOverdue(
    before: Date,
    limit: number,
  ): Promise<Array<{ visitId: number; ticketId: number; ticketNo: string | null }>>;
  /** 预计上门候选（服务层粗筛；权威判定在本文件的 `appointmentOverdueFrom`） */
  listAppointmentCandidates(
    statuses: string[],
    lower: Date,
    upper: Date,
    limit: number,
  ): Promise<Array<{ id: number; ticket_no: string; expected_visit_at: unknown }>>;
  /** 该工单是否已完成上门（`visit_status='CONFIRMED'`） */
  hasConfirmedVisit(ticketId: number): Promise<boolean>;
  /** 可选的 observability 登记处（health 路径**不传**，见上） */
  tasks?: {
    start?: (name: string) => void;
    finish?: (name: string, result: string, options?: { processedCount?: number; error?: unknown }) => void;
    /**
     * 缓存派生事实（Phase 8 / P8-C）。
     * ⚠️ 由**定时任务**写入，health **只读** —— 见 `TaskRegistry.putFact` 的说明。
     */
    putFact?: (name: string, fact: unknown) => void;
  };
}

export interface SlaScanDeps {
  /** ⚠️ 窄接口：见 `SlaScanPort` 的说明 */
  port: SlaScanPort;
  logger: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
    debug?: (m: string) => void;
  };
  /** 明细条数上限（计数不受此限制） */
  detailLimit?: number;
  /** 时钟注入（测试用） */
  now?: () => Date;
  /**
   * 静默模式（health 探针路径用）。
   *
   * ⚠️ health 是**高频探针**，它触发的计算不该产生业务日志，也不该写 observability ——
   *    否则"探针"这个动作本身会污染日志与任务状态。
   */
  quiet?: boolean;
}

/** 从 `Services` 装配 SLA 扫描所需的窄接口（调度任务路径用） */
export function slaPortFromServices(services: Services): SlaScanPort {
  return {
    readThresholds: () => readThresholds(services.config),
    countAcceptanceOverdue: (before) => services.tickets.countAcceptanceOverdue(before),
    listAcceptanceOverdue: (before, limit) => services.tickets.listAcceptanceOverdue(before, limit),
    countStoreConfirmOverdue: (before) => services.visits.countOverdueSubmissions(before),
    listStoreConfirmOverdue: (before, limit) => services.visits.listOverdueSubmissions(before, limit),
    listAppointmentCandidates: (statuses, lower, upper, limit) =>
      services.tickets.listAppointmentCandidates(statuses, lower, upper, limit),
    hasConfirmedVisit: (ticketId) => services.visits.hasConfirmedVisit(ticketId),
    tasks: services.tasks,
  };
}

const DEFAULT_DETAIL_LIMIT = 50;

/**
 * 计算 `appointmentOverdue` 的起算时刻（**本模块的核心，勿改语义**）。
 *
 * @param expectedVisitAt DB 里的 `expected_visit_at`（通常是 `YYYY-MM-DDT12:00:00+08:00`）
 * @param graceMinutes `sla.appointment_overdue_grace_minutes`
 * @returns 起算时刻（Date）；无法解析日期时返回 null（该行不计入 overdue）
 *
 * ⚠️ 实现纪律（契约 §3.3）：
 *    先按 `appointmentDateOnly()` 取**裸日期**，再取当天 23:59:59.999，
 *    最后才加 grace。**任何形如 `expectedVisitAt + graceMs` 的写法都是实现错误。**
 */
export function appointmentOverdueFrom(
  expectedVisitAt: unknown,
  graceMinutes: number,
): Date | null {
  const day = appointmentDateOnly(expectedVisitAt);
  if (!day) return null;

  // 当地日期结束 = 当天 23:59:59.999（+08:00）。
  // ⚠️ 用显式偏移字符串构造，避免宿主机时区不同把结尾漂到别的日子。
  const endOfDay = new Date(`${day}T23:59:59.999${APPOINTMENT_TIMEZONE_OFFSET}`);
  if (Number.isNaN(endOfDay.getTime())) return null;

  const grace = Number.isFinite(graceMinutes) ? Math.max(0, Math.trunc(graceMinutes)) : 0;
  return new Date(endOfDay.getTime() + grace * 60_000);
}

/**
 * 取某个时刻所在**当地日期的结束**（23:59:59.999 +08:00）。
 *
 * ⚠️ 与 `appointmentOverdueFrom` 共用同一套"日期末尾"口径，避免两处漂移。
 * ⚠️ 用它做 SQL 粗筛下界（而不是直接拿 `now - 24h`）：跨天时 `now - 24h` 会落在
 *    前一天中间的某个时刻，虽然不是"错误"，但与语义上的"日界"不一致，容易在边界测试里咬人。
 */
function endOfLocalDay(at: Date): Date {
  const day = appointmentDateOnly(at.toISOString());
  const end = new Date(`${day}T23:59:59.999${APPOINTMENT_TIMEZONE_OFFSET}`);
  return Number.isNaN(end.getTime()) ? at : end;
}

/** 把 Date 转成 ISO（判空友好） */
function iso(date: Date | null): string {
  return date ? date.toISOString() : '';
}

/** 读参数并做安全兜底（缺键/类型不对时用播种值，绝不因配置问题让扫描整体失败） */
async function readThresholds(config: ConfigService): Promise<SlaScanResult['thresholds']> {
  const readInt = async (key: string, fallback: number): Promise<number> => {
    try {
      const value = await config.getInt(key, fallback);
      return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    acceptMinutes: await readInt('sla.accept_minutes', 120),
    graceMinutes: await readInt('sla.appointment_overdue_grace_minutes', 120),
    storeConfirmHours: await readInt('sla.store_confirm_hours', 48),
  };
}

/**
 * 跑一轮 SLA overdue 检测。**纯读、幂等、永不抛错**。
 *
 * ⚠️ 幂等性：本函数**不写任何行**，因此重复执行不会产生任何业务副作用
 *    （这正是契约 §6 门禁 ④ 要求的"重复执行不重复产生业务副作用"的最强形式）。
 */
export async function runSlaScan(deps: SlaScanDeps): Promise<SlaScanResult> {
  const { port, logger } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const detailLimit = Math.max(0, Math.trunc(deps.detailLimit ?? DEFAULT_DETAIL_LIMIT));

  if (!deps.quiet) port.tasks?.start?.(TASK_NAME.SLA_SCAN);

  const empty: SlaScanResult = {
    acceptanceOverdue: 0,
    appointmentOverdue: 0,
    storeConfirmOverdue: 0,
    scannedAt: now.toISOString(),
    facts: [],
    thresholds: { acceptMinutes: 120, graceMinutes: 120, storeConfirmHours: 48 },
  };

  try {
    const thresholds = await port.readThresholds();

    const acceptanceFrom = new Date(now.getTime() - thresholds.acceptMinutes * 60_000);
    const storeConfirmFrom = new Date(now.getTime() - thresholds.storeConfirmHours * 3600_000);

    // ---- ① acceptanceOverdue：status='NEW' 且 created_at 早于阈值 ----
    // ⚠️ 谓词已取证（契约 §3.3）：NEW = 客户已提交待门店受理；受理后转 PROCESSING。
    // ⚠️ 判定用 `created_at < before`（严格小于）：恰好在阈值那一刻不算超时
    //    （边界朝"不误报"一侧倒）。
    const acceptanceOverdue = await port.countAcceptanceOverdue(acceptanceFrom);
    const acceptanceList =
      detailLimit > 0 ? await port.listAcceptanceOverdue(acceptanceFrom, detailLimit) : [];

    // ---- ② storeConfirmOverdue：Visit 已提交(submitted_at) 且门店未确认 ----
    // ⚠️ 基准字段 = `service_visits.submitted_at`（契约 §3.3 O8-2 已取证：列注释「师傅提交时间」）
    //    谓词 = `visit_status='SUBMITTED'`（等门店确认）；门店确认后转 CONFIRMED 即自动移出。
    const storeConfirmOverdue = await port.countStoreConfirmOverdue(storeConfirmFrom);
    const overdueSubmitVisits =
      detailLimit > 0
        ? await port.listStoreConfirmOverdue(storeConfirmFrom, detailLimit)
        : [];

    // ---- ③ appointmentOverdue：DEV-71 日期语义 + grace ----
    // ⚠️ SQL **无法**表达"取裸日期 → 当天末尾 → 加宽限"这套语义
    //    （写成 `expected_visit_at < now - grace` 恰好是契约 §3.3 明令禁止的伪精度口径）。
    //    ⇒ 服务层只做**粗筛**，权威判定一律走 `appointmentOverdueFrom()`（本文件内，纯函数）。
    //    粗筛下界 = "昨天末尾"（任何可能的 overdue 起点都不会早于它）；
    //    上界 = now（`expected_visit_at` 存的是当天 12:00，必然小于"当天末尾 + grace"）。
    const yesterdayEnd = endOfLocalDay(new Date(now.getTime() - 24 * 3600_000));
    const appointmentCandidates = await port.listAppointmentCandidates(
      APPOINTMENT_ACTIVE_TICKET_STATUSES,
      yesterdayEnd,
      now,
      Math.max(detailLimit * 4, 200),
    );

    const facts: SlaOverdueFact[] = [];
    for (const row of acceptanceList) {
      facts.push({
        kind: 'acceptance',
        ticketId: row.id,
        ticketNo: row.ticket_no || null,
        visitId: null,
        dueFrom: acceptanceFrom.toISOString(),
      });
    }
    for (const visit of overdueSubmitVisits) {
      facts.push({
        kind: 'store_confirm',
        ticketId: visit.ticketId,
        ticketNo: visit.ticketNo,
        visitId: visit.visitId,
        dueFrom: storeConfirmFrom.toISOString(),
      });
    }

    // ---- appointment 精判（权威函数 + 终态谓词）----
    // ⚠️ 计数必须用**本轮局部变量** —— 用模块级累加器会让两次扫描相互污染，
    //    而且 `runSlaScan` 可能并发（定时器重入 + 门禁脚本同时调用）。
    let appointmentOverdue = 0;
    for (const row of appointmentCandidates) {
      const dueFrom = appointmentOverdueFrom(row.expected_visit_at, thresholds.graceMinutes);
      if (!dueFrom) continue;
      if (dueFrom.getTime() >= now.getTime()) continue; // 还没到起算时刻

      // 终态谓词（O8-1，见 APPOINTMENT_ACTIVE_TICKET_STATUSES 的取证注释）：
      // Visit 侧已被门店确认（= 上门完成）的工单**不算** overdue。
      const finished = await port.hasConfirmedVisit(row.id);
      if (finished) continue;

      appointmentOverdue += 1;
      if (facts.length < detailLimit) {
        facts.push({
          kind: 'appointment',
          ticketId: row.id,
          ticketNo: row.ticket_no || null,
          visitId: null,
          dueFrom: dueFrom.toISOString(),
        });
      }
    }

    const result: SlaScanResult = {
      acceptanceOverdue,
      appointmentOverdue,
      storeConfirmOverdue,
      scannedAt: now.toISOString(),
      facts: facts.slice(0, detailLimit),
      thresholds,
    };

    const total =
      result.acceptanceOverdue + result.appointmentOverdue + result.storeConfirmOverdue;

    // ⚠️ quiet（health 探针）路径：**既不记日志也不写 observability**。
    //    探针本身不该产生业务日志（那会让"日志里出现 overdue"变成每分钟都有的噪音），
    //    也不该把 health 的读取动作伪装成"任务跑了一轮"。
    if (!deps.quiet) {
      if (total > 0) {
        logger.info?.(
          `[sla-scan] 当前 overdue：受理 ${result.acceptanceOverdue} / 上门 ${result.appointmentOverdue} / ` +
            `门店确认 ${result.storeConfirmOverdue}（阈值 ${thresholds.acceptMinutes}min / ` +
            `${thresholds.graceMinutes}min / ${thresholds.storeConfirmHours}h）`,
        );
      } else {
        logger.debug?.('[sla-scan] 当前无 SLA overdue');
      }
      port.tasks?.finish?.(TASK_NAME.SLA_SCAN, TASK_RESULT.SUCCESS, {
        processedCount: total,
      });
      // ⚠️ 把"当前事实"缓存下来，供 health **只读**（避免每次探针重算）。
      //    health 因此能在**不跑扫描**的前提下回答"当前 SLA overdue 多少"。
      port.tasks?.putFact?.(TASK_NAME.SLA_SCAN, {
        acceptanceOverdue: result.acceptanceOverdue,
        appointmentOverdue: result.appointmentOverdue,
        storeConfirmOverdue: result.storeConfirmOverdue,
        scannedAt: result.scannedAt,
        thresholds: result.thresholds,
      });
    }

    return result;
  } catch (error) {
    // ⚠️ 关机/热重载竞态不是真失败：连接池已关，本轮静默中止，不记 FAILED
    //    （否则冒烟断言被关机噪声打红，health 把"被中断"误报成"任务坏了"）。
    if (isShutdownSignal(error)) {
      logger.debug?.(`[sla-scan] 应用关闭中，本轮中止（非故障）：${(error as Error)?.message}`);
      return empty;
    }
    logger.error?.(`[sla-scan] 本轮整体失败（下轮重试）：${(error as Error)?.message}`);
    if (!deps.quiet) {
      port.tasks?.finish?.(TASK_NAME.SLA_SCAN, TASK_RESULT.FAILED, { processedCount: 0, error });
    }
    return empty;
  }
}

/**
 * `appointmentOverdue` 精判里"尚未上门完成"的 Ticket 侧状态白名单（**O8-1 取证结论**）。
 *
 * ---------------------------------------------------------------------------
 * 取证过程（回代码，不凭印象）
 * ---------------------------------------------------------------------------
 * ① `VISIT_STATUS` 六态：ASSIGNED / SUBMITTED / CONFIRMED / REJECTED / SUPERSEDED / CANCELLED。
 *    ⚠️ **没有** "COMPLETED" 之类的状态 —— "上门完成"在数据上只体现为
 *    `visit_status='CONFIRMED'`（门店已确认，`VISIT_STATUS_LABEL` 的文案）。
 * ② `TICKET_STATUS` 六态：NEW / PROCESSING / WAIT_STORE_CONFIRM / WAIT_FEEDBACK / CLOSED / CANCELLED。
 * ③ 逐态判断"这次上门是否已经不需要再催"：
 *    · `NEW`                  客户刚提交，门店还没受理 ⇒ **上门尚未发生** ⇒ 算 overdue
 *    · `PROCESSING`           已受理/已派工，师傅还没提交 ⇒ **上门尚未完成** ⇒ 算 overdue
 *    · `WAIT_STORE_CONFIRM`   师傅已提交、等门店确认 ⇒ 上门**已发生但未确认** ⇒ 算 overdue
 *                             （同时它会进入 storeConfirmOverdue，两条 SLA 各自成立）
 *    · `WAIT_FEEDBACK`        门店已确认 ⇒ **上门已完成** ⇒ **不算**
 *    · `CLOSED` / `CANCELLED` 流程已终结 ⇒ **不算**
 *
 * ⇒ 取**最窄**谓词 = `[NEW, PROCESSING, WAIT_STORE_CONFIRM]`（即除
 *   `WAIT_FEEDBACK` / `CLOSED` / `CANCELLED` 外的全部）。
 * ⚠️ 并用 `visits.hasConfirmedVisit()` 做 Visit 侧二次确认（Ticket 状态与 Visit 状态
 *    理论上同步，但两者是不同字段 —— 双条件宁可少报不可误报）。
 *
 * ⚠️ **不新建 Ticket 状态**：以上全部复用既有状态机（契约 §3.4 / 用户明令）。
 */
export const APPOINTMENT_ACTIVE_TICKET_STATUSES: string[] = [
  TICKET_STATUS.NEW,
  TICKET_STATUS.PROCESSING,
  TICKET_STATUS.WAIT_STORE_CONFIRM,
];

/** 供门禁断言引用：SLA 三类事实的判定基准（避免测试里硬编码） */
export const SLA_SOURCE = {
  /** appointmentOverdue 的"尚未上门完成"谓词 */
  appointmentActiveTicketStatuses: APPOINTMENT_ACTIVE_TICKET_STATUSES,
  /** storeConfirmOverdue 的 Visit 侧状态（等门店确认） */
  storeConfirmVisitStatus: VISIT_STATUS.SUBMITTED,
  /** acceptanceOverdue 的 Ticket 侧状态（待受理） */
  acceptanceTicketStatus: TICKET_STATUS.NEW,
} as const;

/** SLA 扫描的默认调度：每 5 分钟（与 sms-retry 同频，两者都是"尽快发现"型） */
const DEFAULT_CRON = '*/5 * * * *';

/**
 * 把 SLA overdue 扫描注册进 `app.cronJobManager`。
 *
 * ⚠️ 本任务**纯读**（`runSlaScan` 不写任何行）⇒ 重复执行/多实例并发**天然安全**。
 *    这也是契约 §6 门禁 ④（"重复执行不重复产生业务副作用"）的最强满足形式。
 */
export function registerSlaScanJob(app: any, deps: SlaScanDeps): any | null {
  const manager = app?.cronJobManager;
  if (!manager || typeof manager.addJob !== 'function') {
    deps.logger.warn?.(
      '[sla-scan] app.cronJobManager 不可用，SLA overdue 扫描**未注册** ' +
        '（health 的 sla* 字段会在被调用时按需实时计算，仍然可用）',
    );
    return null;
  }

  const job = manager.addJob({
    cronTime: DEFAULT_CRON,
    onTick: () => {
      // 同其它任务：刻意不 await，异常已在 runSlaScan 内收干净
      void runSlaScan(deps);
    },
    start: false,
  });

  deps.logger.info?.(
    `[sla-scan] 已注册 SLA overdue 扫描任务（cron=${DEFAULT_CRON}，纯读不写库）`,
  );

  return job;
}
