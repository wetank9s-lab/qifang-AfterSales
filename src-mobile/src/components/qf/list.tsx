/**
 * QF 列表件：分组列表 / 信息行 / 搜索框 / 档案卡。
 *
 * ===========================================================================
 * 档案卡的信息层级（用户第 7.1 条）
 * ===========================================================================
 *   "列表突出：客户姓名、服务内容、联系电话、服务类型、档案编号、创建日期。
 *    **客户姓名和服务内容优先，档案编号放次要位置**。"
 *
 *   卡片从上到下：
 *     ① 客户姓名（title 20px）+ 服务类型徽标（右上）
 *     ② 服务内容（body 17px）—— "做了什么活"，与姓名同级重要
 *     ③ 联系电话（foot 13px）—— 打码，防肩窥
 *     ④ 分隔线
 *     ⑤ 档案编号 + 创建日期（caption 12px，ink-3）—— 核对时才看
 *
 * ⚠️ 删掉的东西（用户明令）：
 *   · 「草稿 / 已发布」徽标 —— 保存即发布后每张卡都写"已发布"，是纯噪音
 *   · 「草稿筛选 / 已发布筛选」—— 见 ArchiveList 页
 *   ⚠️ 保留「业务进度」徽标（待开始 / 服务中 / 已完成）：那是这单做到哪一步，
 *      与"客户能不能看到"是两回事，混为一谈会让员工分不清。
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { QFStatusBadge } from './primitives';
import {
  ARCHIVE_STATUS_META,

  SERVICE_TYPE_OPTIONS,
  HVAC_STAGE_META,
  metaOf,
  type Tone,
} from '../../design/qf-tokens';

/* ------------------------------------------------------------ 分组容器 */

/**
 * 分组列表（iOS inset grouped）。
 *
 * ⚠️ 圆角与描边在**外层**，行与行之间只有 hairline。
 *    这是 iOS 分组列表的定义特征，也是它比"每行一张卡片"更省屏幕的原因。
 *
 * ⚠️ 分组标题用 `foot`(13px) 大写式小字 + `ink-3`：
 *    iOS 的 group header 就是这么做的（比正文小、比正文淡、不抢视线）。
 *    但**不能再往下取 11px** —— 13 已是本项目的下限档。
 */
export function QFListSection({
  title,
  children,
  footnote,
  testId,
}: {
  title?: string;
  children: ReactNode;
  /** 分组下方的补充说明（小字） */
  footnote?: string;
  testId?: string;
}) {
  return (
    <section className="px-4 pt-4" data-testid={testId}>
      {title ? <div className="text-svc-ink-3 qf-foot mb-1.5 px-1 font-medium">{title}</div> : null}
      <div className="qf-section">{children}</div>
      {footnote ? <div className="text-svc-ink-3 qf-foot mt-1.5 px-1 leading-relaxed">{footnote}</div> : null}
    </section>
  );
}

/** 列表行（左右两端布局） */
export function QFRow({
  label,
  value,
  tone,
  testId,
}: {
  label: string;
  value: ReactNode;
  /** 值用状态色（避免"已完成"这种文字与正文同色） */
  tone?: Tone;
  testId?: string;
}) {
  const toneText: Record<Tone, string> = {
    success: 'text-svc-success',
    warning: 'text-svc-warning',
    danger: 'text-svc-danger',
    info: 'text-svc-info',
    neutral: 'text-svc-neutral',
    brand: 'text-svc-brand-text',
  };
  return (
    <div className="flex min-h-touch items-start gap-3 px-4 py-2.5" data-testid={testId}>
      <span className="text-svc-ink-2 qf-sub w-[84px] shrink-0">{label}</span>
      <span
        className={`qf-body min-w-0 flex-1 break-words ${tone ? toneText[tone] : 'text-svc-ink'}`}
      >
        {value}
      </span>
    </div>
  );
}

/** 信息行（label 在上、值在下，长文本用这个而不是 QFRow） */
export function QFInfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="px-4 py-2.5">
      <div className="text-svc-ink-3 qf-foot mb-0.5">{label}</div>
      <div className="text-svc-ink qf-body break-words">{value}</div>
    </div>
  );
}

/* -------------------------------------------------------------- 搜索框 */

/**
 * 搜索框（iOS search field 形态）。
 *
 * ⚠️ 三个必须做对的细节：
 *   ① `type="search"` + `enterKeyHint="search"` —— 键盘右下角显示「搜索」而不是「换行」
 *   ② **300ms debounce**：`search-fields.md › Best practices`
 *      "If possible, start search immediately when a person types."
 *      本项目原先三处搜索三种行为（输入即搜无防抖 / 回车才搜 / 手动提交）。
 *      ⇒ 统一到这里，页面只拿"稳定后的关键词"。
 *   ③ 「清空」按钮**必须是 44×44**：旧实现在 ServiceSearch 里是 `px-1 text-[15px]`，
 *      实测约 34×20 —— 手指点不中（审计 A-03）。
 */
export function QFSearchField({
  value,
  onChange,
  placeholder = '搜索',
  debounceMs = 300,
  testId,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  debounceMs?: number;
  testId?: string;
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const timer = useRef<number | null>(null);
  /** 用户正在输入中的"原始值"，用于清空按钮的显示判定 */
  const typing = useRef(value);

  useEffect(() => {
    typing.current = value;
  }, [value]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const schedule = (v: string) => {
    typing.current = v;
    if (timer.current) window.clearTimeout(timer.current);
    if (!debounceMs) {
      onChange(v);
      return;
    }
    timer.current = window.setTimeout(() => onChange(v), debounceMs);
  };

  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    typing.current = '';
    onChange('');
    inputRef.current?.focus();
  };

  return (
    <div className="flex items-center gap-2">
      <div className="bg-svc-bg flex min-h-touch flex-1 items-center gap-2 rounded-svc px-3">
        <SearchGlyph />
        <input
          ref={inputRef}
          type="search"
          enterKeyHint="search"
          autoFocus={autoFocus}
          /**
           * ⚠️ 必须给 `qf-input`（它带 `min-height: 44` + `-webkit-appearance: none`）。
           *
           * 2026-11-19 验收实测：这里原来只写 `qf-body ...`，没有 `qf-input`，
           * 于是这个 `<input>` 的高度由内容决定 = **38px**，被列表页的
           * 「可点元素触控 ≥44」判据抓了出来。
           *
           * 为什么不能只靠父容器的 `min-h-touch`：父容器 44px 只是**视觉外壳**，
           * 点在外壳上下那 3px 空白上不会聚焦输入框 —— 用户以为点中了其实没中。
           * 输入框自己 44px 才是真的"整条都能点"。
           *
           * `type="search"` 在 WebKit 里带内建外观（2em 行高、内建圆角），
           * 会顶掉 min-height ⇒ 这正是 `qf-input` 里那条 `-webkit-appearance: none` 的用途。
           */
          className="qf-input qf-body placeholder:text-svc-placeholder min-w-0 flex-1 bg-transparent outline-none"
          value={value}
          placeholder={placeholder}
          /**
           * ⚠️ 中文输入法：composition 期间不调度，结束时一次性提交。
           *    否则拼音每敲一个字母都会触发一次搜索，手机上表现为"卡"
           *    且会在搜到一半的中文上闪"没有找到"。
           */
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            schedule((e.target as HTMLInputElement).value);
          }}
          onChange={(e) => {
            const v = e.target.value;
            typing.current = v;
            if (composing.current) return;
            schedule(v);
          }}
          data-testid={testId}
        />
      </div>
      {value ? (
        <button
          type="button"
          onClick={clear}
          aria-label="清空搜索"
          data-testid={testId ? `${testId}-clear` : undefined}
          className="qf-pressable svc-icon-btn text-svc-brand-text shrink-0"
        >
          <ClearGlyph />
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ 档案卡片 */

/** 档案行（与本页 ArchiveRow 结构兼容，不 import 以免循环依赖） */
export interface QFArchiveLike {
  id: number;
  archive_no?: string | null;
  archive_type?: string | null;
  customer_name?: string | null;
  customer_mobile?: string | null;
  service_address?: string | null;
  service_type?: string | null;
  product_description?: string | null;
  status?: string | null;
  visibility?: string | null;
  created_at?: string | null;
}

/**
 * 档案卡片。
 *
 * ⚠️ 服务内容 = `service_type` 的中文（暖通则是"暖通工程"）；
 *    它缺失时才回退到 `product_description`（产品/机型）——
 *    两个都缺就**整行不渲染**，不印 '—'（'—' 与"地址写的是横杠"无法区分）。
 */
export function QFServiceCard({
  row,
  onOpen,
  stageSummary,
}: {
  row: QFArchiveLike;
  onOpen?: () => void;
  /** 暖通：已完成阶段数 / 6 */
  stageSummary?: { done: number; total: number };
}) {
  const typeKey = String(row.archive_type ?? '');
  const status = metaOf(ARCHIVE_STATUS_META, row.status);
  const serviceContent =
    typeKey === 'hvac'
      ? '暖通工程'
      : (SERVICE_TYPE_OPTIONS.find((o) => o.value === row.service_type)?.label ?? row.product_description ?? '');

  /** 作废是**必须**显示的业务状态（客户看不到这条了）；草稿/已发布不显示（用户明令） */
  const showVoided = String(row.visibility ?? '') === 'voided';

  return (
    <div
      onClick={onOpen}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen();
              }
            }
          : undefined
      }
      data-testid={`archive-card-${row.id}`}
      data-qf-card="archive"
      className="bg-svc-surface qf-pressable mb-2.5 overflow-hidden rounded-svc border border-svc-line"
    >
      <div className="px-4 pt-3 pb-2.5">
        {/* ① 客户姓名（主） + ② 服务类型徽标（右上） */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-svc-ink qf-title truncate font-semibold">
              {row.customer_name || '（未填客户）'}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <QFStatusBadge label={status.label} tone={status.tone} />
            {showVoided ? <QFStatusBadge label="已作废" tone="danger" dot={false} /> : null}
          </div>
        </div>

        {/* ③ 服务内容（与姓名同级重要） */}
        {serviceContent ? (
          <div className="text-svc-ink-2 qf-body mt-0.5 truncate">{serviceContent}</div>
        ) : null}

        {/* ④ 电话 + 地址 */}
        <div className="text-svc-ink-3 qf-foot mt-1 flex min-w-0 items-center gap-1.5">
          {row.customer_mobile ? <span className="tabular shrink-0">{maskMobile(row.customer_mobile)}</span> : null}
          {row.customer_mobile && row.service_address ? <span aria-hidden="true">·</span> : null}
          {row.service_address ? <span className="truncate">{row.service_address}</span> : null}
        </div>

        {/* 暖通进度：只在有阶段数据时出现 */}
        {stageSummary ? (
          <div className="mt-2">
            <StageBar done={stageSummary.done} total={stageSummary.total} />
          </div>
        ) : null}
      </div>

      {/* ⑤ 档案编号 + 创建日期：核对时才用，放脚注 */}
      <div className="border-svc-line flex items-center justify-between gap-2 border-t px-4 py-1.5">
        <span className="text-svc-ink-3 qf-caption tabular truncate">{row.archive_no || `#${row.id}`}</span>
        <span className="text-svc-ink-3 qf-caption shrink-0">{absDate(row.created_at)}</span>
      </div>
    </div>
  );
}

/** 六阶段细进度条（卡片内的小版本） */
function StageBar({ done, total }: { done: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="bg-svc-line flex h-1 flex-1 gap-0.5 overflow-hidden rounded-full">
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={`h-1 flex-1 ${i < done ? 'bg-svc-success' : 'bg-svc-line'}`}
            aria-hidden="true"
          />
        ))}
      </div>
      <span className="text-svc-ink-3 qf-caption tabular shrink-0">
        {done}/{total}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ 工具 */

/** 手机号掩码（防肩窥：门店柜台是公共场景） */
export function maskMobile(m: string | null | undefined): string {
  const s = String(m ?? '').replace(/\s/g, '');
  if (s.length < 7) return s ? '***' : '';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

/** MM-DD（列表用） */
export function absDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 阶段摘要（暖通卡片用） */
export function stageSummaryOf(stages: { status: string }[]): { done: number; total: number } {
  return {
    done: stages.filter((s) => s.status === 'done').length,
    total: Math.max(stages.length, 6),
  };
}

/** 阶段中文名（导出给页面用，避免页面各自写一份） */
export function stageLabel(code: string): string {
  return HVAC_STAGE_META[code]?.label ?? code;
}

/* ----------------------------------------------------------------- 图标 */

function SearchGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true" className="text-svc-ink-3 shrink-0">
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4 4" strokeLinecap="round" />
    </svg>
  );
}

function ClearGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6M15 9l-6 6" strokeLinecap="round" />
    </svg>
  );
}
