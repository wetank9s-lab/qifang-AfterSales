/**
 * 领域卡片与时间线：工单卡 / 档案卡 / 业务时间线 / 关键词高亮。
 *
 * 这三个组件共同的约束：**只做展示，不发请求，不改状态**。
 * 点击一律交给外层回调 —— 这样同一个卡片能在列表、抽屉、首页复用，
 * 而"点它会去哪"由页面决定（首页可能进详情，工单列表可能进快捷操作）。
 */

import type { ReactNode } from 'react';
import { ServiceStatusBadge, ToneDot } from './Feedback';
import {
  ARCHIVE_STATUS_META,
  ARCHIVE_VISIBILITY_META,
  ARCHIVE_TYPE_META,
  HVAC_STAGE_META,
  TICKET_STATUS_META,
  TICKET_TYPE_META,
  applianceLabel,
  metaOf,
  type Tone,
} from '../design/tokens';
import type { TicketRow } from '../api/tickets';
import type { ArchiveRow } from '../api/archives';

/* ------------------------------------------------------------------ 时间 */

/**
 * 相对时间 + 绝对时间。
 *
 * ⚠️ 列表里用相对时间（"3 分钟前"）能让人一眼看出新旧；
 *    但**详情页必须显示绝对时间** —— 售后场景要对客户说"您几点打的电话"，
 *    "2 小时前"这种答案在现场毫无用处。
 */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 0) return absTime(iso);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 天前`;
  return absDate(iso);
}

export function absTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function absDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 是否为今天 */
export function isToday(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/* -------------------------------------------------------------- 手机号掩码 */

/**
 * 手机号掩码（列表里默认打码）。
 *
 * ⚠️ 打码不是"安全措施"（数据已经到浏览器了），而是**防肩窥**：
 *    门店柜台是公共场景，客户排队时屏幕上就是一整屏手机号。
 *    详情页提供"显示完整号码"按钮，但默认是打码的。
 */
export function maskMobile(m: string | null | undefined): string {
  const s = String(m ?? '');
  if (s.length < 7) return s ? '***' : '—';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

/**
 * 拨号链接。
 *
 * ⚠️ 用 `tel:` 而不是 `sms:` —— 售后场景"打给客户"远多于"发短信"，
 *    而且短信会走公司的短信通道计费，个人手机发出去就没有留痕了。
 */
export function telHref(m: string | null | undefined): string | undefined {
  const s = String(m ?? '').replace(/[^\d+]/g, '');
  return s.length >= 7 ? `tel:${s}` : undefined;
}

/* --------------------------------------------------------------- 工单卡片 */

/**
 * 工单卡片。
 *
 * ===========================================================================
 * 五项必须一眼看到的（用户第四节明确列出）
 * ===========================================================================
 *   ① 客户或事项      → 姓名（无姓名时用报修内容首句，而不是一个"—"）
 *   ② 报修/投诉类型   → `ticket_type`
 *   ③ 当前状态        → 右上角徽标
 *   ④ 时间或优先级    → 紧急徽标 / 跟进到期 / 相对时间
 *   ⑤ **是否需要我处理** → 这是最重要的一项，见下
 *
 * ===========================================================================
 * 为什么会话里要算"是否轮到我"
 * ===========================================================================
 *   售后打开列表最想知道的是"哪几条现在卡在我这儿"。整改前卡片只给状态
 *   （"处理中"），而"处理中"既可能是师傅在外面干着（不用管），
 *   也可能是**师傅刚交了回执等着门店确认**（必须马上管）。
 *   两者在卡片上长得一模一样 ⇒ 售后得逐条点进去看。
 *
 *   ⚠️ 这里**不做权限判断**，只做"状态 → 是否待人动手"的展示映射，
 *      取值依据是服务端状态机的语义（`WAIT_STORE_CONFIRM` / `NEW` 是明确
 *      "等我们"的两个状态）。判错的后果是多一个或少一个提示标记，
 *      不会让人越权 —— 真正的裁决始终在服务端。
 */
export function TicketCard({ row, onOpen }: { row: TicketRow; onOpen?: () => void }) {
  const st = metaOf(TICKET_STATUS_META, row.status, 'neutral');
  const overdue = isOverdue(row);
  const waiting = needsMyAction(row.status);

  return (
    <article
      className="bg-svc-surface mb-2.5 overflow-hidden rounded-svc border border-svc-line active:bg-svc-surface-2"
      onClick={onOpen}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      data-testid={`ticket-card-${row.id}`}
    >
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {/*
              ⚠️ 姓名缺失时用报修内容顶上，而不是显示"（未填姓名）"。
                 匿名报修本来就可能没有姓名，此时"鞋子不制冷"这种内容
                 比一个占位符有用得多。两个都缺才退化到占位符。
            */}
            <div className="text-svc-ink qf-body mt-0.5 clamp-1 font-medium">
              {row.customer_name || firstLine(row.content) || '（无客户信息）'}
            </div>
            {/* ① 类型 + 商品：业务分类，回答"这是什么活儿" */}
            <div className="text-svc-ink-3 mt-0.5 flex items-center gap-1.5 qf-foot">
              {/*
                ⚠️ 未知 `ticket_type` 的兜底同样**不能印代码值**（同 ArchiveCard 的理由）。
                   实测库里只有 repair(527) / complaint(16) 两个值，
                   但服务端枚举还有 install/maintenance/consult/other ⇒ 新增值必然打到兜底。
              */}
              <span className="shrink-0">{TICKET_TYPE_META[String(row.ticket_type ?? '')] ?? '服务工单'}</span>
              {/* ⚠️ 品类走中文映射；未知代码**不渲染**，绝不把 air_conditioner 这种
                  数据库枚举直接印给店员看（2026-11-14 实测出现过）。 */}
              {applianceLabel(row.appliance_category) ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{applianceLabel(row.appliance_category)}</span>
                </>
              ) : null}
            </div>
          </div>
          {/* ③ 当前状态 */}
          <ServiceStatusBadge label={st.label} tone={st.tone} />
        </div>

        {/*
          ⚠️ 内容为空时整行不渲染（实测 543 条里有 137 条 content 为空/空白，
            占 25% —— 那 137 张卡片底下会各挂一个孤零零的 '—'）。
            卡片已经有客户姓名或"（无客户信息）"占位，信息不会丢。
        */}
        {row.content ? (
          <div className="text-svc-ink-2 mt-1 clamp-2 qf-sub leading-snug">{row.content}</div>
        ) : null}
      </div>

      <div className="border-svc-line flex items-center justify-between gap-2 border-t px-4 py-2">
        {/* ④ 优先级 / 时间 */}
        <div className="text-svc-ink-3 flex min-w-0 items-center gap-1.5 qf-foot">
          {row.urgent ? <span className="text-svc-danger font-medium">紧急</span> : null}
          {overdue ? (
            <span className="text-svc-danger font-medium">跟进已到期</span>
          ) : (
            <span className="shrink-0">{relTime(row.created_at)}</span>
          )}
          {/* ⚠️ 工单编号放最右、最小、最淡：核对时才用（与档案卡片同一层级原则） */}
          <span className="truncate opacity-70">{row.ticket_no || `#${row.id}`}</span>
        </div>
        {/* ⑤ 是否需要我处理 —— 最重要的一项，单独用色块顶出来 */}
        {waiting ? (
          <span className="qf-badge bg-svc-brand-soft text-svc-brand shrink-0 px-2 py-0.5 qf-caption font-medium">
            待你处理
          </span>
        ) : null}
      </div>
    </article>
  );
}

/**
 * "现在是否轮到门店动手"。
 *
 * 依据服务端状态机语义，不猜业务：
 *   · `NEW` / `new`            —— 还没人受理，等门店接单
 *   · `WAIT_STORE_CONFIRM`     —— 师傅交了回执，等门店审核确认
 *   · 其它（PROCESSING / WAIT_FEEDBACK / CLOSED / CANCELLED）—— 不在门店手上
 *
 * ⚠️ `new` 小写同样要认：生产库两种写法共存（见 api/tickets.ts 顶部）。
 *    漏掉它会让 4 条待受理工单不显示"待你处理"——而它们恰恰最该显示。
 */
function needsMyAction(status: string): boolean {
  return status === 'NEW' || status === 'new' || status === 'WAIT_STORE_CONFIRM';
}

/** 取内容首行（避免多行内容把卡片的 clamp-1 撑成"半句 + 省略号"的怪样子） */
function firstLine(s: string | null | undefined): string {
  const t = String(s ?? '').split('\n')[0] ?? '';
  return t.trim();
}

/** 跟进是否已到期（只用于视觉强调，不做业务判断） */
function isOverdue(row: TicketRow): boolean {
  if (!row.next_follow_at) return false;
  const t = new Date(row.next_follow_at).getTime();
  return Number.isFinite(t) && t < Date.now() && !['CLOSED', 'CANCELLED'].includes(row.status);
}

/* --------------------------------------------------------------- 档案卡片 */

/**
 * 档案卡片。
 *
 * ===========================================================================
 * 信息层级：客户与业务状态在前，档案编号退到脚注
 * ===========================================================================
 *   整改前编号占着**标题上方**那行（视觉上最容易被先读到），而它恰恰是
 *   最没用的信息 —— 销售在柜台前找的是"张女士那条暖通"，不是"SA-2026-000431"。
 *   ⇒ 卡片第一眼给：客户姓名 + 服务类型 + 当前进度；编号降到分隔线下方，
 *     和创建时间并列（都是"将来要核对时才有用"的字段）。
 *
 * ⚠️ 两个徽标（可见性 / 生命周期）保留在同一列：它们回答的是不同的两个问题
 *    （"客户能不能看到"与"这单做到哪一步"），合并成一个反而会丢掉信息。
 */
export function ArchiveCard({ row, onOpen }: { row: ArchiveRow; onOpen?: () => void }) {
  /**
   * ⚠️ 未知 `archive_type` 的兜底文案。
   *
   *    原写法是 `String(row.archive_type ?? '—')` —— 后端新增一个档案类型时，
   *    卡片副标题会**原样印出英文代码值**（如 `maintenance`），
   *    而它恰好出现在卡片最显眼的位置（客户姓名正下方）。
   *    ⇒ 改成中性中文：宁可说"其他服务"，也不要把代码值当业务名词给员工看。
   *      （不写"未知"：那会让整张卡片看起来像坏了；
   *        写"其他服务"语义正确且不丢"这是一条档案"的信息。
   *        真实代码值不丢 —— 详情页的 `ARCHIVE_TYPE_META` 与 DTO 原始字段都还在。）
   */
  const FALLBACK_TYPE = { label: '其他服务', short: '其他服务' };
  const type = ARCHIVE_TYPE_META[String(row.archive_type ?? '')] ?? FALLBACK_TYPE;
  const status = metaOf(ARCHIVE_STATUS_META, row.status, 'neutral');
  const vis = metaOf(ARCHIVE_VISIBILITY_META, row.visibility, 'neutral');

  return (
    <article
      className="bg-svc-surface mb-2.5 overflow-hidden rounded-svc border border-svc-line active:bg-svc-surface-2"
      onClick={onOpen}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      data-testid={`archive-card-${row.id}`}
    >
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {/* 第一眼：客户是谁、做什么业务 */}
            <div className="text-svc-ink truncate qf-sub font-medium">{row.customer_name || '（未填客户）'}</div>
            <div className="text-svc-ink-2 mt-0.5 truncate qf-caption">{type.label}</div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {/* 第一眼：这单现在什么进度 */}
            <ServiceStatusBadge label={status.label} tone={status.tone} size="sm" />
            <ServiceStatusBadge label={vis.label} tone={vis.tone} size="sm" />
          </div>
        </div>
        {/*
          ⚠️ 没地址时**整行不渲染**，不印一个 '—'。
             '—' 在这里没有信息量（它和"地址写的是横杠"无法区分），
             而卡片本来就靠"客户姓名 + 服务类型"回答"这是哪一条"。
        */}
        {row.service_address ? (
          <div className="text-svc-ink-2 mt-1 clamp-1 qf-foot">{row.service_address}</div>
        ) : null}
        {row.product_description ? (
          <div className="text-svc-ink-3 mt-0.5 clamp-1 qf-caption">{row.product_description}</div>
        ) : null}
      </div>
      <div className="border-svc-line flex items-center justify-between gap-2 border-t px-4 py-1.5">
        {/* 编号与时间：核对时才用，放脚注 */}
        <span className="text-svc-ink-3 truncate qf-caption">{row.archive_no || `#${row.id}`}</span>
        <span className="text-svc-ink-3 shrink-0 qf-caption">{relTime(row.created_at)}</span>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------- 暖通阶段条 */

/**
 * 六阶段进度条（暖通）。
 *
 * ⚠️ 顺序来自服务端 `stage_order`，**不能按名称重排**：
 *    本组件的 `order` 只用于"显示顺序"，判断"哪个阶段已完成"一律看服务端给的状态。
 */
export function HvacProgress({
  stages,
}: {
  stages: { stage_code: string; status: string }[];
}) {
  const doneCount = stages.filter((s) => s.status === 'done').length;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-svc-ink-2 text-xs">工程进度</span>
        <span className="text-svc-ink tabular text-xs font-medium">
          {doneCount}/{Math.max(stages.length, 6)}
        </span>
      </div>
      <ol className="flex gap-1" aria-label="暖通施工阶段">
        {stages.map((s) => {
          const meta = HVAC_STAGE_META[s.stage_code];
          const done = s.status === 'done';
          return (
            <li key={s.stage_code} className="flex-1">
              <div
                className={`h-1.5 rounded-full ${done ? 'bg-svc-success' : 'bg-svc-line'}`}
                aria-hidden="true"
              />
              <div
                className={`mt-1 text-center qf-caption leading-tight ${done ? 'text-svc-success font-medium' : 'text-svc-ink-3'}`}
              >
                {meta?.short ?? s.stage_code}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ---------------------------------------------------------------- 时间线 */

export interface TimelineItem {
  key: string | number;
  title: string;
  /** 副标题（操作人） */
  by?: string | null;
  at?: string | null;
  note?: string | null;
  tone?: Tone;
}

/**
 * 业务时间线。
 *
 * ⚠️ 时间线只**如实呈现**服务端给的事件，不做任何"推断性补充"：
 *    不能为了"看起来完整"自己插一条"客户已收货"这种库里没有的节点。
 *    售后纠纷时，时间线会被当证据看。
 */
export function ServiceTimeline({ items }: { items: TimelineItem[] }) {
  if (!items.length) {
    return <div className="text-svc-ink-3 px-4 py-6 text-center text-xs">暂无记录</div>;
  }
  return (
    <ol className="relative" data-testid="service-timeline">
      {items.map((it, i) => (
        <li key={it.key} className="relative flex gap-3 pb-4 last:pb-0">
          {/* 竖线：最后一条不画 */}
          {i < items.length - 1 ? (
            <span className="bg-svc-line absolute top-4 left-[3px] h-full w-px" aria-hidden="true" />
          ) : null}
          <ToneDot tone={it.tone ?? 'neutral'} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-svc-ink qf-foot font-medium">{it.title}</span>
              <span className="text-svc-ink-3 shrink-0 qf-caption">{absTime(it.at)}</span>
            </div>
            {it.by ? <div className="text-svc-ink-3 mt-0.5 qf-caption">{it.by}</div> : null}
            {it.note ? (
              <div className="bg-svc-surface-2 text-svc-ink-2 mt-1 rounded-svc-sm px-2.5 py-1.5 qf-caption leading-relaxed whitespace-pre-wrap">
                {it.note}
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------ 关键词高亮 */

/**
 * 关键词高亮。
 *
 * ⚠️ 只做**纯文本切分**，不注入 HTML。
 *    用 `dangerouslySetInnerHTML` 拼高亮是最常见的 XSS 入口，
 *    而这里渲染的内容（工单内容）**是客户自己填的**。
 */
export function Highlight({ text, keyword }: { text: string; keyword?: string }) {
  const kw = keyword?.trim();
  if (!kw) return <>{text}</>;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  const needle = kw.toLowerCase();
  let from = 0;
  let idx = lower.indexOf(needle);
  let n = 0;
  while (idx >= 0) {
    if (idx > from) parts.push(text.slice(from, idx));
    parts.push(
      <mark key={`m${n++}`} className="bg-svc-warning-soft text-svc-ink rounded-[2px] px-0.5">
        {text.slice(idx, idx + kw.length)}
      </mark>,
    );
    from = idx + kw.length;
    idx = lower.indexOf(needle, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}
