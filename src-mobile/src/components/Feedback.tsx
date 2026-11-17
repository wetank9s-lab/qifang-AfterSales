/**
 * 状态与反馈类组件：徽标 / 空态 / 加载态 / 错误态 / 无权限态 / Toast / 二次确认。
 *
 * ===========================================================================
 * 为什么这些必须集中，而不是每个页面自己写
 * ===========================================================================
 *   上一套 H5 的"空态"有 4 种写法（居中灰字、居中灰字带图标、左对齐灰字、什么都不显示），
 *   "加载中"有 3 种，错误提示有的用 alert 有的用行内红字。
 *   用户走同一条业务流程时，会在不同环节看到不同"风格"的提示 ——
 *   那不是"丰富"，那是"没做完"。
 *
 *   本文件把这些收敛成每个状态**只有一个**正确写法。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Preloader, Button, Dialog, DialogButton, Toast } from 'konsta/react';
import { TONE_CLASS, type Tone } from '../design/tokens';
import { ApiError } from '../api/http';

/* ------------------------------------------------------------------ 状态徽标 */

/**
 * 业务状态徽标。
 *
 * ⚠️ 颜色只是辅助。文字始终存在 —— 只靠颜色区分状态对色弱用户不可用，
 *    而且在户外强光下（师傅现场）饱和度差异几乎看不出来。
 */
export function ServiceStatusBadge({
  label,
  tone,
  size = 'md',
}: {
  label: ReactNode;
  tone: Tone;
  size?: 'sm' | 'md';
}) {
  const cls = TONE_CLASS[tone];
  return (
    /**
     * ⚠️ 字号在 2026-11-13（第一节）由 `11px / 12px` 提升为 `12px / 13px`。
     *
     *    用户第 ③ 条："11–12px 的辅助文字，在不破坏布局的前提下，尽量提高至 13–14px。"
     *    徽标正是这次对比度问题的**现场**（`text-svc-X` on `bg-svc-X-soft`），
     *    字号越小越吃对比度 ⇒ 优先提它。
     *
     *    ⚠️ 没直接跳到 13/14：徽标是**内联胶囊**，常与 11px 的次要信息同一行出现
     *      （见 Domain.tsx 的卡片行）。整体抬到 13 会挤掉那一行的省略号截断效果，
     *      反而让"档案编号"这类字段显示不全 —— 那才是破坏布局。
     *      ⇒ 取"每个尺寸各 +1px"：sm 11→12、md 12→13。
     *      实测（见 `.tmp-ux-final/status-color-check.png`）胶囊仍单行、无换行。
     */
    <span
      className={`${cls.bg} ${cls.text} inline-flex shrink-0 items-center gap-1 rounded-full font-medium ${
        size === 'sm' ? 'px-2 py-0.5 text-[12px]' : 'px-2.5 py-1 text-[13px]'
      }`}
    >
      <span className={`${cls.dot} h-1.5 w-1.5 rounded-full`} aria-hidden="true" />
      {label}
    </span>
  );
}

/** 纯色小圆点（时间线、列表左侧用） */
export function ToneDot({ tone }: { tone: Tone }) {
  return <span className={`${TONE_CLASS[tone].dot} mt-1.5 block h-2 w-2 shrink-0 rounded-full`} />;
}

/* ------------------------------------------------------------ 空 / 加载 / 错误 */

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-8 py-16 text-center" data-svc-state="empty">
      <div className="bg-svc-surface-2 text-svc-ink-3 mb-3 flex h-14 w-14 items-center justify-center rounded-full">
        {icon ?? <EmptyGlyph />}
      </div>
      <div className="text-svc-ink text-[15px] font-medium">{title}</div>
      {description ? (
        <div className="text-svc-ink-2 mt-1.5 max-w-[16rem] text-[13px] leading-relaxed">{description}</div>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function LoadingState({ rows = 3, label }: { rows?: number; label?: string }) {
  return (
    <div className="px-4 py-3" data-svc-state="loading" aria-busy="true" aria-live="polite">
      {label ? <div className="text-svc-ink-3 mb-2 text-xs">{label}</div> : null}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="bg-svc-surface mb-2 rounded-svc p-4">
          <div className="svc-skeleton mb-2 h-4 w-1/3" />
          <div className="svc-skeleton mb-2 h-4 w-4/5" />
          <div className="svc-skeleton h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/**
 * 错误态。
 *
 * ⚠️ 关键判断：**网络错误与业务错误要给不同的动作**。
 *   · 网络错误 / 超时 ⇒ "重试"（同一次操作再来一遍）
 *   · 403 / 404        ⇒ **不给重试**（重试一万次也一样），只给"返回"
 *   · 429              ⇒ 显示"X 秒后可再试"并禁用按钮（服务端给了 Retry-After）
 *
 *   给 403 一个"重试"按钮是这轮之前 H5 的常见做法，
 *   用户点了几次之后会以为"系统坏了"，而真实原因是他没这个权限。
 */
export function ErrorState({
  error,
  onRetry,
  onBack,
}: {
  error: unknown;
  onRetry?: () => void;
  onBack?: () => void;
}) {
  const info = describeError(error);
  return (
    <div className="flex flex-col items-center justify-center px-8 py-14 text-center" data-svc-state="error">
      <div className={`${TONE_CLASS[info.tone].bg} mb-3 flex h-14 w-14 items-center justify-center rounded-full`}>
        <span className={`${TONE_CLASS[info.tone].text} text-2xl font-semibold`}>!</span>
      </div>
      <div className="text-svc-ink text-[15px] font-medium">{info.title}</div>
      <div className="text-svc-ink-2 mt-1.5 max-w-[17rem] text-[13px] leading-relaxed">{info.message}</div>
      {info.retryAfter > 0 ? (
        <RetryCountdown seconds={info.retryAfter} onRetry={onRetry} />
      ) : null}
      <div className="mt-5 flex gap-2">
        {info.canRetry && onRetry ? (
          <Button onClick={onRetry} data-testid="state-retry">
            重试
          </Button>
        ) : null}
        {onBack ? (
          <Button tonal onClick={onBack}>
            返回
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function RetryCountdown({ seconds, onRetry }: { seconds: number; onRetry?: () => void }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    const t = setInterval(() => setLeft((n) => (n > 0 ? n - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [seconds]);
  return (
    <div className="text-svc-ink-3 mt-3 text-xs">
      {left > 0 ? `${left} 秒后可再次尝试` : '现在可以重试了'}
      {left === 0 && onRetry ? (
        <button className="text-svc-brand ml-1 underline" onClick={onRetry}>
          立即重试
        </button>
      ) : null}
    </div>
  );
}

/**
 * 无权限态。
 *
 * ⚠️ 与 `ErrorState` 分开是刻意的：403 的语义是"你不该看这个"，
 *    不该出现"重试"这种暗示"再试一次可能就行"的动作。
 */
export function PermissionDeniedState({ hint, onBack }: { hint?: string; onBack?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-8 py-14 text-center" data-svc-state="denied">
      <div className="bg-svc-neutral-soft text-svc-neutral mb-3 flex h-14 w-14 items-center justify-center rounded-full">
        <LockGlyph />
      </div>
      <div className="text-svc-ink text-[15px] font-medium">没有访问权限</div>
      <div className="text-svc-ink-2 mt-1.5 max-w-[17rem] text-[13px] leading-relaxed">
        {hint ?? '当前账号不能查看这项内容。如果需要，请联系门店负责人或总部管理员开通。'}
      </div>
      {onBack ? (
        <div className="mt-5">
          <Button tonal onClick={onBack}>
            返回
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Toast */

/**
 * 轻提示。
 *
 * ⚠️ 用它**只**表达"操作已生效"这类瞬时反馈（受理成功、已保存）。
 *    失败**不要**只用 Toast：它 2 秒就消失，用户漏看就等于没有提示，
 *    而失败恰恰是需要用户处理的那种。
 */
/**
 * 量出"视口底部被固定栏占掉的高度"，让 Toast 抬到它们**上方**。
 *
 * ⚠️ 为什么不能用一个固定的 `bottom-24` 解决（DEV-253，2026-11-14）：
 *
 *   我原以为 `bottom-24`（96px）够高，实测**根本没生效** —— Konsta 的 Toast
 *   自带 `bottom-safe-4`，两条规则**特异性相同**，而构建产物里
 *   `.bottom-safe-4`（字节 18332）排在 `.bottom-24`（18188）**之后**
 *   ⇒ 计算值恒为 `bottom: 16px`，和我写什么都没关系。
 *   这是本项目第 N 次"代码执行了但用户看不到变化"，所以判据只能是
 *   `getComputedStyle().bottom` 的真值，不是类名。
 *
 *   而 16px 的结果是：Toast **整条压在吸底主按钮上**。实测（390×844）：
 *     吸底栏 t:755 b:828，主按钮 t:768 b:816，Toast t:784 b:828
 *     ⇒ 与吸底栏重叠 **15752px²**、与主按钮重叠 **11456px²**（遮掉按钮 32/48px）
 *   对员工来说就是"点了下一步、弹出提示、按钮被盖住点不到" ——
 *   提示本是为了帮他，结果挡住了他该点的东西。
 *
 * ⚠️ 所以也不再靠类名覆盖，直接用**内联样式**（永远压过类）：
 *   把它抬到"当前真正贴在底部的那些栏"之上。底部可能同时有两层：
 *   Tabbar（`.k-toolbar`，根级页面）和吸底操作栏（`[data-svc-sticky-bar]`，表单页），
 *   吸底栏在 Tabbar **之上**，所以要取"被占高度"的最大值，不是相加。
 *
 *   判据：只统计**当前真的贴在视口下半部**的栏（`top > vh/2`）。
 *   这样顶部的吸顶搜索区（`sticky top-0`，同为 `.sticky`）不会被误算进来 ——
 *   否则会把 Toast 顶到屏幕中间。栏在自然流里没吸底时也不会被算（它不在下半部）。
 */
export function measureBottomOcclusion(): number {
  try {
    const vh = window.innerHeight;
    let lowest = 0;
    const cands = document.querySelectorAll('[data-svc-sticky-bar="1"], .k-toolbar');
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      if (r.height <= 0) continue;
      // 只算贴底的那一层：顶端必须落在视口下半部
      if (r.top <= vh / 2) continue;
      const occ = vh - r.top;
      if (occ > lowest) lowest = occ;
    }
    return lowest;
  } catch {
    /* 量不到就退回 0（= 只用安全区 + 间距），宁可低一点也不要算出个负数 */
    return 0;
  }
}

export function useToast() {
  const [msg, setMsg] = useState<{ text: string; tone: Tone; lift: number } | null>(null);
  const timer = useRef<number | null>(null);

  const show = (text: string, tone: Tone = 'success') => {
    /**
     * ⚠️ 在 **show 的这一刻**量，而不是渲染时算。
     *    Toast 的生命周期只有 2.2 秒，量一次就够；
     *    而且此刻页面已经稳定（吸底栏已吸附到位），量到的才是它真实占的位置。
     *    若改成渲染后异步量，会出现"先出现在按钮上、再跳上去"的抖动。
     */
    setMsg({ text, tone, lift: measureBottomOcclusion() });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 2200);
  };

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const node = msg ? (
    /**
     * ⚠️ 这里**不能**再写 `left-1/2 -translate-x-1/2`（DEV-250，2026-11-14）。
     *
     *    Konsta 的 Toast 自带 `left-safe-4 right-safe-4`（= left:16px / right:16px
     *    ⇒ 宽度 358px，**已经左右居中**，再配它自己的 `flex justify-center`）。
     *    我原先又叠了一层 `left-1/2` + `-translate-x-1/2`：
     *      · `left-1/2` 把 left 从 16px 覆盖成 50%（= 195px）；
     *      · `-translate-x-1/2` 在 Tailwind 4 里写的是 **`translate` 属性**，
     *        不是 `transform`（两者是独立的 CSS 属性，`transform` 实测为 `none`）。
     *    实测（390 宽）：外层 rect 左边界 **−163px**、内层文字块左边界 **−70px**
     *    ⇒ 整条提示有 **70px 跑到屏幕左侧外面**，文字被硬切。
     *    截图正是「左下角提示被截断」——用户看到的那个现象。
     *
     *    ⇒ 删掉这两个偏移类，把居中交回 Konsta。
     *
     * ⚠️ 纵向同理不能再靠类名：用 `style.bottom`（内联必然压过 `bottom-safe-4`）。
     *    值 = 被底部固定栏占掉的高度 + 16px 间距 + 底部安全区（刘海机型）。
     *    安全区用 `var(--k-safe-area-bottom)` 而不是写死，Home Indicator 机型自动正确。
     */
    <Toast
      opened
      position="center"
      className="pointer-events-none fixed z-50"
      style={{ bottom: `calc(${msg.lift}px + 16px + var(--k-safe-area-bottom, 0px))` }}
    >
      <div className="text-sm font-medium">{msg.text}</div>
    </Toast>
  ) : null;

  return { show, node };
}
/* -------------------------------------------------------- 二次确认（Dialog） */

export interface ConfirmSpec {
  title: string;
  content: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作：确认按钮用红色，且默认焦点不在确认上 */
  danger?: boolean;
}

/**
 * 二次确认。
 *
 * ⚠️ 用于**不可撤销或影响他人**的动作：派工（会给师傅发短信）、
 *    驳回回执（客户会看到）、取消工单。
 *    不用于"保存"这类可重试的动作 —— 每步都弹窗会让用户开始无脑点"确定"，
 *    那时二次确认反而失去了保护作用。
 */
export function useConfirm() {
  const [spec, setSpec] = useState<ConfirmSpec | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const ask = (s: ConfirmSpec): Promise<boolean> =>
    new Promise((resolve) => {
      resolver.current = resolve;
      setSpec(s);
    });

  const close = (ok: boolean) => {
    setSpec(null);
    resolver.current?.(ok);
    resolver.current = null;
  };

  const node = (
    <Dialog
      opened={Boolean(spec)}
      onBackdropClick={() => close(false)}
      title={spec?.title}
      content={spec?.content}
      buttons={
        <>
          <DialogButton onClick={() => close(false)}>{spec?.cancelText ?? '取消'}</DialogButton>
          <DialogButton
            strong
            className={spec?.danger ? 'text-svc-danger' : ''}
            onClick={() => close(true)}
            data-testid="confirm-ok"
          >
            {spec?.confirmText ?? '确定'}
          </DialogButton>
        </>
      }
    />
  );

  return { ask, node };
}

/* ------------------------------------------------------------- 提交中按钮 */

/**
 * 带 loading 态的主按钮。
 *
 * ⚠️ 防重复提交必须做在**按钮可点性**上，不能只靠"提交中"这个 state 判重：
 *    移动网络慢时用户会连点 3～5 下，而 React 的 state 更新是异步批处理的窗口内
 *    前几下一定会进到 onClick。所以在 handler 里用 ref 做同步闸门（见 `useSubmitGuard`）。
 */
export function BusyButton({
  busy,
  children,
  onClick,
  ...rest
}: {
  busy: boolean;
  children: ReactNode;
  onClick?: () => void;
  [k: string]: unknown;
}) {
  return (
    <Button large disabled={busy} onClick={onClick} {...rest}>
      <span className="inline-flex items-center gap-2">
        {busy ? <span className="svc-spinner" aria-hidden="true" /> : null}
        {children}
      </span>
    </Button>
  );
}

/**
 * 同步提交闸门。
 *
 * ⚠️ 为什么不用 `useState` 判重：`setBusy(true)` 不会让当前这一帧里的
 *    第二个 onClick 看到新值（React 18 的批处理 + 闭包快照）。
 *    ref 的读写是同步的，第二下必然看到 true。
 *    这不是理论问题 —— 首轮 PoC 后的手工连点就能复现"一张工单被派了两次"。
 */
export function useSubmitGuard() {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return { busy, run };
}

/* ------------------------------------------------------------------ 工具 */

/** 把任意错误翻译成"标题 + 说明 + 能不能重试" */
export function describeError(e: unknown): {
  title: string;
  message: string;
  tone: Tone;
  canRetry: boolean;
  retryAfter: number;
} {
  if (e instanceof ApiError) {
    if (e.isNetworkError) {
      return { title: '网络连接失败', message: e.userMessage, tone: 'warning', canRetry: true, retryAfter: 0 };
    }
    if (e.isRateLimited) {
      const ra = Number((e.detail as any)?.retry_after_seconds ?? 0) || 0;
      return { title: '操作过于频繁', message: e.userMessage, tone: 'warning', canRetry: true, retryAfter: ra };
    }
    if (e.isForbidden) {
      return { title: '没有操作权限', message: e.userMessage, tone: 'neutral', canRetry: false, retryAfter: 0 };
    }
    if (e.isNotFound) {
      return { title: '内容不存在', message: e.userMessage, tone: 'neutral', canRetry: false, retryAfter: 0 };
    }
    if (e.isConflict) {
      return { title: '数据已变化', message: e.userMessage, tone: 'warning', canRetry: true, retryAfter: 0 };
    }
    if (e.status >= 500) {
      return { title: '服务暂时不可用', message: e.userMessage, tone: 'warning', canRetry: true, retryAfter: 0 };
    }
    return { title: '请求未完成', message: e.userMessage, tone: 'danger', canRetry: true, retryAfter: 0 };
  }
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return { title: '出现了意外问题', message: msg || '请稍后重试', tone: 'danger', canRetry: true, retryAfter: 0 };
}

/* ------------------------------------------------------------------ 图标 */

function EmptyGlyph() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M4 7h16M4 12h10M4 17h7" strokeLinecap="round" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="4" y="10" width="16" height="10" rx="2.5" />
      <path d="M8 10V7.5a4 4 0 1 1 8 0V10" strokeLinecap="round" />
    </svg>
  );
}

export { Preloader };
