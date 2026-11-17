/**
 * progress-stage —— 客户进度页的**阶段推导**（UX-PROGRESS-01）
 *
 * ===========================================================================
 * 为什么要单独一个纯函数，而不是在 ProgressService 里拼字符串
 * ===========================================================================
 * ① 阶段推导是这套功能里唯一"会算错却看着合理"的地方：
 *    把 `WAIT_STORE_CONFIRM` 说成"已完成"、把已改派的旧师傅当当前师傅，
 *    页面照样渲染、接口照样 200 —— 只有纯函数 + 夹具才能钉住。
 * ② 阶段**只能**由真实数据推导，不允许按"六步模板"硬套：
 *    本系统 `accept`（受理）不是必经动作（P11-0 起 NEW 可直接派工），
 *    远程电话解决没有 Visit，改派会留下 SUPERSEDED 历史，
 *    驳回会让 Visit 回到"重新处理"。硬套六步必然出现"某一步永远不亮"。
 *
 * ===========================================================================
 * 真实数据来源（写死这一张表，别在别处再抄一份）
 * ===========================================================================
 * ```
 *   ticket.status   NEW → PROCESSING → WAIT_STORE_CONFIRM → WAIT_FEEDBACK → CLOSED
 *                   NEW/PROCESSING → CANCELLED（终态）
 *   visit.visit_status
 *                   ASSIGNED → SUBMITTED → CONFIRMED
 *                   ASSIGNED → SUPERSEDED（改派，历史保留）
 *                   ASSIGNED → CANCELLED（工单取消）
 *                   SUBMITTED → REJECTED（门店驳回，需重新处理）
 *   ticket_events   dispatched / technician_submitted / store_confirmed /
 *                   remote_completed / closed / cancelled（时间取自这里）
 * ```
 *
 * ⚠️ 三条硬规则：
 *   1. **当前师傅只认 Visit**，不认 `serviceTickets.technician_*` 的冗余快照
 *      （工单级字段可能落后于最新一次改派）。
 *   2. **改派后旧师傅必须立即消失**：只取最新 visit_no，且跳过 SUPERSEDED/CANCELLED。
 *   3. **没有真实时间的节点不编时间**：`at` 给 null，前端据此不渲染时间行。
 */

import { TICKET_STATUS, VISIT_STATUS } from '../constants';

/** 客户端可见的当前阶段（比 ticket.status 更细，且不改变服务端状态机） */
export type ProgressStageKey =
  | 'submitted'
  | 'store_handling'
  | 'dispatched'
  | 'tech_submitted'
  | 'store_confirmed'
  | 'reopened'
  | 'completed'
  | 'cancelled';

/** 进度条上的里程碑（固定 5 个，全部有真实状态支撑） */
export type StepKey = 'submitted' | 'assigned' | 'service' | 'confirm' | 'done';
export type StepState = 'done' | 'current' | 'todo' | 'skipped';

export interface ProgressStep {
  key: StepKey;
  label: string;
  state: StepState;
  /** 真实发生时间（ISO）；没有数据就是 null —— **绝不造假时间** */
  at: string | null;
}

export interface NextAction {
  /** 现在该谁动：门店 / 师傅 / 客户 / 无人（终态） */
  owner: 'store' | 'technician' | 'customer' | 'none';
  text: string;
}

/**
 * 六项**必须分开**的时间（真机反馈："门店处理时间被误认为师傅上门时间"）。
 *
 * 每一项都只从**它自己的真实来源**取，绝不拿 `ticket.updatedAt` 或派工时间去冒充：
 *
 * | 字段 | 唯一来源 | 缺失时 |
 * |---|---|---|
 * | `submitted_at` | `serviceTickets.createdAt` | 理论上必有 |
 * | `dispatched_at` | **当前有效 Visit** 的 `assigned_at` | 未派工 ⇒ null |
 * | `expected_visit_at` | 该 Visit 的 `expected_visit_at`（**只到天**） | 未填 ⇒ null（页面显示"待确认"） |
 * | `arrived_at` | **无来源**（系统没有"到场打卡"记录） | 恒 null（页面显示"尚未记录"） |
 * | `tech_submitted_at` | 该 Visit 的 `submitted_at` | 未提交 ⇒ null |
 * | `store_confirmed_at` | 该 Visit 的 `store_confirmed_at` | 未确认 ⇒ null |
 */
export interface ProgressTimes {
  submitted_at: string | null;
  dispatched_at: string | null;
  expected_visit_at: string | null;
  arrived_at: string | null;
  tech_submitted_at: string | null;
  store_confirmed_at: string | null;
}

export interface ProgressSnapshot {
  stage: ProgressStageKey;
  stage_label: string;
  /** 当前状态的一句话（客户视角） */
  status_text: string;
  next_action: NextAction;
  steps: ProgressStep[];
  times: ProgressTimes;
}

export interface TechnicianView {
  name: string | null;
  /**
   * 对客联系电话（完整号码，不做掩码）。
   *
   * 🔑 2026-10-19 用户最终业务规则：
   *    内部派工填写的 `serviceVisits.technician_mobile` **就是**这次上门服务的对客号码；
   *    师傅接受派工即视为同意向**本工单客户**展示。
   *    因此不再新增 `customer_contact_phone` / `allow_customer_call`，
   *    也不做逐人授权。
   *
   * ⚠️ 但它仍然受**两条**约束，不是"任意人可见"：
   *    ① 只有持有该工单**有效进度 Token** 的请求才会走到这里（Token 校验在 service 层）；
   *    ② 只认**当前有效 Visit** 的号码（改派后旧号码立即消失，取消后整段为 null）。
   *
   * ⚠️ 号码格式必须校验：派工时 `technician_mobile` 只是 `optionalText`，
   *    没有手机号格式约束 —— 门店可能填座机、"无"、短号。非法值一律当"没有号码"，
   *    否则 `tel:` 会拨到一个错号。
   */
  phone: string | null;
  /** phone 是否可直接拨号（= 号码存在且格式合法） */
  callable: boolean;
  /** 无号码时给客户的一句可行动提示 */
  contact_hint: string | null;
  /**
   * 实际服务状态（对客户可读）。
   *
   * 2026-11-14：客户要求师傅卡显示实际服务状态，而服务端此前只给 role。
   * 在这里派生而不是让前端各自拼 —— 否则两个前端会对同一张单给出不同说法。
   * 取值只有三种，全部来自 visit 的真实字段：
   *   · completed 角色 / 已有回执 ⇒ 已完成服务
   *   · 已提交回执但工单未收口 ⇒ 已回执，待门店确认
   *   · 其余（刚派工）⇒ 待上门
   */
  status_label: string;
  /** 这张记录对应的第几次上门（改派/二次上门时客户能对上号） */
  visit_no: number;
  /** current = 正在服务的派工；completed = 已确认完成的服务记录 */
  role: 'current' | 'completed';
}

export interface DeriveInput {
  ticket: {
    status: string;
    created_at?: unknown;
    closed_at?: unknown;
    /** 工单级派生字段（**不用于解析师傅**，仅在完全没有 Visit 事件时兜底展示时间） */
    updated_at?: unknown;
  };
  visits: Array<{
    visit_no?: unknown;
    visit_status?: unknown;
    technician_name?: unknown;
    technician_mobile?: unknown;
    assigned_at?: unknown;
    submitted_at?: unknown;
    store_confirmed_at?: unknown;
    superseded_at?: unknown;
    expected_visit_at?: unknown;
  }>;
  events: Array<{ event_type?: unknown; to_status?: unknown; at?: unknown }>;
}

const STEP_LABEL: Record<StepKey, string> = {
  submitted: '已提交',
  assigned: '安排师傅',
  service: '上门服务',
  confirm: '门店确认',
  done: '已完成',
};

/**
 * 真实事件类型 → **客户能看懂的事件名**。
 *
 * 为什么要这张表（真机反馈原话）：
 *   「处理进度」里出现**重复的"处理中"**、**有时间却没标题的空行** ——
 *   因为旧实现直接拿 `to_status`（如 PROCESSING）当标题，
 *   而多个不同事件（派工/改派/跟进）都会把状态推到 PROCESSING。
 *
 * 规则：
 *   · 只列**业务动作**，不列内部技术事件；
 *   · 表里没有的事件 = **不展示**（返回 null），绝不渲染空标题；
 *   · 文案站在客户视角（"门店已安排师傅"而不是"dispatched"）。
 */
const CUSTOMER_EVENT_LABEL: Record<string, string> = {
  created: '工单已提交',
  accepted: '门店已接单',
  transferred: '工单已转交其他门店',
  dispatched: '门店已安排师傅',
  reassigned: '门店已更换服务师傅',
  rescheduled: '上门时间已调整',
  technician_submitted: '师傅已提交服务回执',
  store_confirmed: '门店已确认服务',
  store_rejected: '门店要求重新处理',
  remote_completed: '门店已通过电话处理',
  reviewed: '您已完成评价',
  closed: '服务已完成',
  cancelled: '工单已取消',
  reopened: '工单已重新打开',
};

/** 客户可见的事件名；返回 null 表示**这条事件不对客户展示** */
export function customerEventLabel(eventType: unknown): string | null {
  return CUSTOMER_EVENT_LABEL[text(eventType)] ?? null;
}

const STAGE_LABEL: Record<ProgressStageKey, string> = {
  submitted: '待门店安排',
  store_handling: '门店处理中',
  dispatched: '已派工',
  tech_submitted: '待门店确认',
  store_confirmed: '待您评价',
  // 客户已评价但工单仍在处理中（现在只剩收费金额不一致）：
  // **不是"尚未派工"**，历史必须保留
  reopened: '客户已评价，继续处理',
  completed: '已完成',
  cancelled: '已取消',
};

function iso(value: unknown): string | null {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * 只认**合法的中国大陆手机号**（11 位、1[3-9] 开头）。
 *
 * 为什么必须校验：`technician_mobile` 在派工入口只是 `optionalText`，
 * 没有格式约束 —— 历史数据里可能有座机、短号、"无"、带空格/横线的写法。
 * 把非法值直接拼进 `tel:` 会把客户拨到一个错号，比"不显示"更糟。
 */
function normalizeMobile(value: unknown): string | null {
  const digits = text(value).replace(/[\s-]/g, '');
  return /^1[3-9]\d{9}$/.test(digits) ? digits : null;
}

/** 某一类事件**最早**一次的 at（同一类事件可能重复，例如多次派工） */
function firstEventAt(events: DeriveInput['events'], types: string[]): string | null {
  for (const type of types) {
    for (const e of events) {
      if (text(e?.event_type) === type) {
        const at = iso(e?.at);
        if (at) return at;
      }
    }
  }
  return null;
}

function hasEvent(events: DeriveInput['events'], type: string): boolean {
  return events.some((e) => text(e?.event_type) === type);
}

/** 最新一次真实派工（不含被改派/取消的历史） */function currentVisit(visits: DeriveInput['visits']): DeriveInput['visits'][number] | null {
  const sorted = [...visits].sort((a, b) => num(b.visit_no) - num(a.visit_no));
  for (const v of sorted) {
    const status = text(v.visit_status);
    if (status === VISIT_STATUS.SUPERSEDED || status === VISIT_STATUS.CANCELLED) continue;
    return v;
  }
  return null;
}

/** 已确认完成的那次服务（工单闭环/待评价时用来回答"是谁修的"） */
function completedVisit(visits: DeriveInput['visits']): DeriveInput['visits'][number] | null {
  const sorted = [...visits].sort((a, b) => num(b.visit_no) - num(a.visit_no));
  return sorted.find((v) => text(v.visit_status) === VISIT_STATUS.CONFIRMED) ?? null;
}

function buildSteps(
  states: { submitted: StepState; assigned: StepState; service: StepState; confirm: StepState; done: StepState },
  times: { submitted: string | null; assigned: string | null; service: string | null; confirm: string | null; done: string | null },
): ProgressStep[] {
  const order: StepKey[] = ['submitted', 'assigned', 'service', 'confirm', 'done'];
  return order.map((key) => ({ key, label: STEP_LABEL[key], state: states[key], at: times[key] }));
}

/**
 * 把「工单状态 + 上门记录 + 业务事件」翻译成客户能看懂的阶段。
 *
 * ⚠️ 判定顺序是**故意**的：工单终态（取消/闭环）优先于 Visit 状态。
 *    否则"取消了但之前派过工"会显示成"已派工，等待师傅联系"，
 *    客户会一直等一个不会来的师傅。
 */
export function deriveProgress(input: DeriveInput): {
  progress: ProgressSnapshot;
  technician: TechnicianView | null;
} {
  const status = text(input.ticket?.status);
  const visits = Array.isArray(input.visits) ? input.visits : [];
  const events = Array.isArray(input.events) ? input.events : [];

  const tSubmitted = iso(input.ticket?.created_at);
  const tDispatched = firstEventAt(events, ['dispatched', 'reassigned']);
  const tTechSubmitted = firstEventAt(events, ['technician_submitted']);
  const tConfirmed = firstEventAt(events, ['store_confirmed', 'remote_completed']);
  const tClosed = firstEventAt(events, ['closed', 'reviewed']) ?? iso(input.ticket?.closed_at);

  const active = currentVisit(visits);
  const done = completedVisit(visits);
  const isRemoteOnly = hasEvent(events, 'remote_completed') && visits.length === 0;

  // 六项时间的**唯一来源**（见 ProgressTimes 注释）。
  // ⚠️ 一律取"当前/最近一次真实施工"这条 Visit 上的字段，不拿 ticket.updatedAt 顶替。
  const subject = active ?? done;
  const times: ProgressTimes = {
    submitted_at: tSubmitted,
    dispatched_at: subject ? iso(subject.assigned_at) : null,
    expected_visit_at: subject ? iso(subject.expected_visit_at) : null,
    arrived_at: null,
    tech_submitted_at: subject ? iso(subject.submitted_at) : null,
    store_confirmed_at: subject ? iso(subject.store_confirmed_at) : null,
  };

  // ---------------------------------------------------------------- 已取消
  if (status === TICKET_STATUS.CANCELLED) {
    return {
      progress: {
        stage: 'cancelled',
        times,
        stage_label: STAGE_LABEL.cancelled,
        status_text: '工单已取消，无需继续等待上门',
        next_action: { owner: 'none', text: '如仍需服务，请联系门店重新报修' },
        steps: buildSteps(
          { submitted: 'done', assigned: 'todo', service: 'todo', confirm: 'todo', done: 'todo' },
          { submitted: tSubmitted, assigned: null, service: null, confirm: null, done: null },
        ),
      },
      // 取消后**不返回任何师傅联系方式**（场景 8）：历史派工不再可拨
      technician: null,
    };
  }

  // ---------------------------------------------------------------- 已结束
  if (status === TICKET_STATUS.CLOSED) {
    const who = done ?? active;
    return {
      progress: {
        stage: 'completed',
        times,
        stage_label: STAGE_LABEL.completed,
        status_text: '本次服务已完成',
        next_action: { owner: 'none', text: '服务已完成，如有问题请联系门店' },
        steps: buildSteps(
          { submitted: 'done', assigned: 'done', service: 'done', confirm: 'done', done: 'done' },
          {
            submitted: tSubmitted,
            assigned: tDispatched ?? iso(who?.assigned_at),
            // ⚠️ 这一步叫「上门服务」，但系统**没有到场时间**（arrived_at 恒为 null）。
            //    旧实现填的是"回执提交时间" ⇒ 等于把提交回执说成"上门时间"，语义错误。
            //    回执时间在下面「服务时间」区块单独展示，这里宁缺勿造。
            service: null,
            confirm: tConfirmed ?? iso(who?.store_confirmed_at),
            done: tClosed,
          },
        ),
      },
      technician: toTechnician(who, 'completed'),
    };
  }

  // ---------------------------------------------------------------- 待客户评价
  if (status === TICKET_STATUS.WAIT_FEEDBACK) {
    const who = done ?? active;
    return {
      progress: {
        stage: 'store_confirmed',
        times,
        stage_label: STAGE_LABEL.store_confirmed,
        status_text: '门店已确认服务完成，等待您的评价',
        /**
         * ⚠️ R1（2026-11-14）：文案必须与**页面实际能力**一致。
         *    该页自 P6-E-NO-OTP-01 起就内置了评价表单，
         *    旧文案说"评价入口见门店短信"会让客户跑去找短信、
         *    而表单其实就在下面（实测截图里两者同屏，读起来自相矛盾）。
         *    ⚠️ 短信链接仍然有效（一次性凭证独立存在），只是不再**引导**客户离开本页。
         */
        next_action: { owner: 'customer', text: '请对本次服务作出评价（在下方直接评价即可）' },
        steps: buildSteps(
          { submitted: 'done', assigned: 'done', service: 'done', confirm: 'done', done: 'current' },
          {
            submitted: tSubmitted,
            assigned: tDispatched ?? iso(who?.assigned_at),
            service: tTechSubmitted ?? iso(who?.submitted_at),
            confirm: tConfirmed ?? iso(who?.store_confirmed_at),
            done: tClosed,
          },
        ),
      },
      technician: toTechnician(who, 'completed'),
    };
  }

  // ---------------------------------------------------------------- 待门店确认
  // 以 **Visit 的 SUBMITTED** 为首要依据：真实数据里存在
  // `ticket=PROCESSING` 但 `visit=SUBMITTED` 的短暂不一致，
  // 此时客户看到的应该是"师傅已提交回执"，而不是"还在处理中"。
  const activeStatus = text(active?.visit_status);
  if (activeStatus === VISIT_STATUS.SUBMITTED || status === TICKET_STATUS.WAIT_STORE_CONFIRM) {
    return {
      progress: {
        stage: 'tech_submitted',
        times,
        stage_label: STAGE_LABEL.tech_submitted,
        status_text: '师傅已提交服务回执，等待门店审核',
        next_action: { owner: 'store', text: '门店会尽快审核，确认后您可以评价本次服务' },
        steps: buildSteps(
          {
            submitted: 'done',
            assigned: 'done',
            service: 'done',
            confirm: 'current',
            done: 'todo',
          },
          {
            submitted: tSubmitted,
            assigned: tDispatched ?? iso(active?.assigned_at),
            service: tTechSubmitted ?? iso(active?.submitted_at),
            confirm: null,
            done: null,
          },
        ),
      },
      // ⚠️ 师傅已提交但门店未确认 ⇒ 仍是"当前服务师傅"，不是"已完成"
      technician: toTechnician(active, 'current'),
    };
  }

  // ---------------------------------------------------------------- 已派工
  if (active && (activeStatus === VISIT_STATUS.ASSIGNED || activeStatus === VISIT_STATUS.REJECTED)) {
    const rejected = activeStatus === VISIT_STATUS.REJECTED;
    const visitNo = num(active.visit_no, 1);
    const nth = visitNo > 1 ? `（第 ${visitNo} 次上门）` : '';
    const name = text(active.technician_name);
    return {
      progress: {
        stage: 'dispatched',
        times,
        stage_label: STAGE_LABEL.dispatched,
        // 用户 2026-10-19 定稿：「已安排王建国为您服务，请保持电话畅通」
        // ⚠️ 只说明"已安排"，**不说"已上门"** —— 派工 ≠ 到场，系统也没有到场记录。
        status_text: rejected
          ? `门店已要求师傅重新处理${nth}，请保持电话畅通`
          : name
            ? `已安排${name}为您服务${nth}，请保持电话畅通`
            : `门店已安排服务人员${nth}，请保持电话畅通`,
        next_action: {
          owner: 'technician',
          text: rejected ? '师傅会重新与您联系，请保持电话畅通' : '请保持电话畅通，师傅会与您联系',
        },
        steps: buildSteps(
          { submitted: 'done', assigned: 'done', service: 'current', confirm: 'todo', done: 'todo' },
          {
            submitted: tSubmitted,
            assigned: tDispatched ?? iso(active.assigned_at),
            service: null,
            confirm: null,
            done: null,
          },
        ),
      },
      technician: toTechnician(active, 'current'),
    };
  }

  // ---------------------------------------------------------------- 客户已评价 + 工单重开
  //
  // 🔴 P6-PROGRESS-SYNC-02：**这条分支必须存在**。
  //    收费金额不一致会让工单从 WAIT_FEEDBACK 落回 PROCESSING，而 Visit 仍是 CONFIRMED。
  //    旧实现落到下面"门店处理中（未派工）"兜底 ⇒ 已派工、已上门、已评价的客户
  //    却看到「尚未派工」，历史被整段抹掉（真机就是这个问题）。
  //    这里如实表达"您已评价，门店继续跟进"，并保留已完成步骤与师傅信息。
  //
  // ⚠️ 2026-11（P0-LOW-RATING-CLOSE）：低评分**不再**把工单打回 PROCESSING，
  //    因此这条分支现在只服务**收费金额不一致**这一种真实重开。
  //    `hasReviewed` 这个温和的判据故意保留（不改成"存在 reopened 事件"）：
  //    它同时兜住了历史遗留的低分重开单（含 2026-10 之前没有 reopened 事件的早单），
  //    让那批工单在人工关单之前仍然显示「继续处理中」而不是「尚未派工」——
  //    这是**显示正确性**，不是业务重开。
  const hasReviewed = events.some((e) => text(e?.event_type) === 'reviewed');
  if (
    // ⚠️ 用 status 直接判，**不能引用下面的 `isProcessing`**（它在后文才声明，
    //    提前引用会 TDZ 抛 "Cannot access 'isProcessing' before initialization"）。
    status === TICKET_STATUS.PROCESSING &&
    hasReviewed &&
    done &&
    text(done.visit_status) === VISIT_STATUS.CONFIRMED
  ) {
    return {
      progress: {
        stage: 'reopened',
        times,
        stage_label: STAGE_LABEL.reopened,
        status_text: '您已提交评价，门店正在根据您的反馈继续处理',
        next_action: { owner: 'store', text: '门店会与您联系继续跟进' },
        // ⚠️ 第五步的固定文案是「已完成」，而这里 state 是 `current` ——
        //    直接复用会出现"未完成却写着已完成"的自相矛盾。重开场景改写成「继续处理中」。
        steps: buildSteps(
          { submitted: 'done', assigned: 'done', service: 'done', confirm: 'done', done: 'current' },
          {
            submitted: tSubmitted,
            assigned: iso(done.assigned_at),
            service: null, // 同上：不把回执提交时间冒充到场时间
            confirm: iso(done.store_confirmed_at),
            done: null,
          },
        ).map((step) => (step.key === 'done' ? { ...step, label: '继续处理中' } : step)),
      },
      technician: toTechnician(done, 'completed'),
    };
  }

  // ---------------------------------------------------------------- 门店处理中（未派工）
  // remote-only：存在"电话/门店直接解决"且没有 Visit ⇒ 主动跳过上门两步，
  // 而不是让客户看着两个永远不亮的灰色节点。
  if (isRemoteOnly) {
    return {
      progress: {
        stage: 'store_confirmed',
        times,
        stage_label: STAGE_LABEL.store_confirmed,
        status_text: '门店已通过电话为您处理，无需上门',
        next_action: { owner: 'customer', text: '如问题仍未解决，请联系门店说明情况' },
        steps: buildSteps(
          {
            submitted: 'done',
            assigned: 'skipped',
            service: 'skipped',
            confirm: 'done',
            done: 'todo',
          },
          {
            submitted: tSubmitted,
            assigned: null,
            service: null,
            confirm: tConfirmed,
            done: null,
          },
        ),
      },
      technician: null,
    };
  }

  const isProcessing = status === TICKET_STATUS.PROCESSING;
  return {
    progress: {
      stage: isProcessing ? 'store_handling' : 'submitted',
      times,
      stage_label: isProcessing ? STAGE_LABEL.store_handling : STAGE_LABEL.submitted,
      status_text: isProcessing
        ? '门店正在安排服务人员，尚未派工'
        : '已收到您的报修，等待门店安排',
      next_action: { owner: 'store', text: '门店会尽快与您联系并安排服务' },
      steps: buildSteps(
        { submitted: 'done', assigned: 'current', service: 'todo', confirm: 'todo', done: 'todo' },
        { submitted: tSubmitted, assigned: null, service: null, confirm: null, done: null },
      ),
    },
    technician: null,
  };
}

function toTechnician(
  visit: DeriveInput['visits'][number] | null | undefined,
  role: 'current' | 'completed',
): TechnicianView | null {
  if (!visit) return null;
  const name = text(visit.technician_name);
  const visitNo = num(visit.visit_no, 1);
  const phone = normalizeMobile(visit.technician_mobile);
  const missingHint = '暂无师傅联系电话，请联系门店';
  /**
   * 实际服务状态 —— 只由真实字段决定，不做猜测：
   *   · 历史/已完成角色 ⇒ 已完成服务
   *   · 已有回执时间（submitted_at）⇒ 已回执，待门店确认
   *   · 其余 ⇒ 待上门（刚派工、还没上门）
   */
  const statusLabel =
    role === 'completed'
      ? '已完成服务'
      : visit.submitted_at
        ? '已回执，待门店确认'
        : '待上门';
  if (!name) {
    // 厂家代处理 / 远程形态：没有具体师傅姓名，但号码可能有（例如厂家客服手机）
    return {
      name: null,
      phone,
      callable: phone != null,
      contact_hint: phone ? null : missingHint,
      status_label: statusLabel,
      visit_no: visitNo,
      role,
    };
  }
  return {
    name,
    phone,
    callable: phone != null,
    contact_hint: phone ? null : missingHint,
    status_label: statusLabel,
    visit_no: visitNo,
    role,
  };
}
