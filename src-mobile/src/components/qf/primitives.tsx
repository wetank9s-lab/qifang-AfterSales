/**
 * QF 基础块：按钮 / 图标按钮 / 状态徽标 / 卡片。
 *
 * ===========================================================================
 * 为什么不用 Konsta 的 Button 直接写业务按钮
 * ===========================================================================
 *   Konsta `Button` 在 5.5.0 里默认 `shape="square"` ⇒ `rounded`(8px)，
 *   传 `rounded` prop 才变 `rounded-full`。所以"主按钮不是胶囊"这件事当前**是对的**
 *   （审计 P-02 已核实，不能一刀切地改）。
 *
 *   ⚠️ 但它的**尺寸档位只有三档**：small `h-7`(28) / medium `h-8.5`(34) / large `h-12`(48)，
 *      全部低于 iOS 的 44pt 下限，靠 app.css 的 `.k-button{min-height:44px}` 兜底。
 *      而 44 也不是用户要求的 50–52（用户第 五 节：「主按钮 50–52px」）。
 *
 *   ⇒ 本组件把"高度"这件事收口：只有 `primary`(52) / `secondary`(50) / `compact`(44) 三档，
 *     颜色/层级由 `variant` 决定（`buttons.md › Style`：「Use style — not size —
 *     to visually distinguish the preferred choice」）。
 *     **不提供 size prop** —— 提供尺寸档位就等于允许页面自己决定按钮多高。
 *
 * ===========================================================================
 * 颜色分离（R2.2.1 A-02）
 * ===========================================================================
 *   · 主按钮：蓝底 `brand`(#007AFF) + 白字 17px Semibold ⇒ 4.02:1 走 3:1 门槛，达标
 *   · 文字按钮：用 `brand-text`(#0062CC) ⇒ 白底 5.80:1，达标
 *   ⚠️ 这两者**不能混用**：蓝底上写 `brand-text` 会变成深蓝底深蓝字。
 */

import type { ReactNode } from 'react';
import { TONE_CLASS, type Tone } from '../../design/qf-tokens';

/* ------------------------------------------------------------------ 按钮 */

export type QFButtonVariant =
  /** 蓝底白字。**同一屏最多两个**（`buttons.md › Style`） */
  | 'primary'
  /** 白底 + 描边。次要动作 */
  | 'secondary'
  /** 浅灰底、无描边。并列的中间态（如"上一步"） */
  | 'tonal'
  /** 纯文字。用于"清空""查看全部"这类低权重动作 */
  | 'plain'
  /** 红字白底描边。**只能用于删除/撤销**（`buttons.md › Role`） */
  | 'destructive';

/**
 * 主按钮。
 *
 * ⚠️ 不复用 Konsta `<Button>`：它的三档高度都不符合用户要求，
 *    而"覆盖它的高度类"会与 `app.css` 的 `.k-button{min-height:44px}` 打两轮架。
 *    用原生 `<button>` 更可控，也更少一层包装。
 *
 * ⚠️ `type="button"` 必须显式写：表单里不写默认是 `submit`，
 *    点"上一步"会顺带提交表单（真实踩过的坑）。
 */
export function QFButton({
  children,
  variant = 'primary',
  onClick,
  disabled,
  busy,
  block,
  testId,
  ariaLabel,
  type = 'button',
}: {
  children: ReactNode;
  variant?: QFButtonVariant;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** 撑满父容器（吸底栏里并排时用 flex-1 而不是 block） */
  block?: boolean;
  testId?: string;
  ariaLabel?: string;
  type?: 'button' | 'submit';
}) {
  const base =
    'qf-pressable inline-flex items-center justify-center gap-1.5 px-4 font-semibold ' +
    'disabled:opacity-45 disabled:pointer-events-none';

  const byVariant: Record<QFButtonVariant, string> = {
    primary: 'bg-svc-brand text-svc-brand-ink',
    secondary: 'bg-svc-surface text-svc-brand-text border border-svc-line-strong',
    tonal: 'bg-svc-surface-2 text-svc-ink',
    plain: 'bg-transparent text-svc-brand-text px-2 font-medium',
    destructive: 'bg-svc-surface text-svc-danger border border-svc-danger',
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      aria-label={ariaLabel}
      data-testid={testId}
      /**
       * ⚠️ 高度：primary/secondary → `qf-cta`(52) ；tonal/plain/destructive → `qf-control`(50)
       *    plain 例外地更矮（44），因为它常嵌在列表行尾 —— 但 44 仍是下限，不再往下。
       */
      className={`${base} ${byVariant[variant]} ${
        variant === 'plain' ? 'min-h-touch' : variant === 'primary' ? 'qf-cta' : 'qf-control'
      } ${block ? 'w-full' : ''} ${variant === 'plain' ? '' : 'rounded-svc'}`}
    >
      {busy ? <span className="svc-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/**
 * 图标按钮（44×44）。
 *
 * ⚠️ 宽度也必须是 44：`.svc-icon-btn` 已经保证，但这里是 QF 版本，
 *    避免页面直接依赖 app.css 里的旧类（两者同名同值，迁移期可以共存）。
 */
export function QFIconButton({
  children,
  onClick,
  ariaLabel,
  tone = 'brand',
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  /** 无障碍名称：图标按钮**必须**有，否则屏幕阅读器读成"按钮" */
  ariaLabel: string;
  tone?: 'brand' | 'ink' | 'danger';
  testId?: string;
}) {
  const color =
    tone === 'danger' ? 'text-svc-danger' : tone === 'ink' ? 'text-svc-ink' : 'text-svc-brand';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      data-testid={testId}
      className={`qf-pressable svc-icon-btn ${color}`}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------ 状态徽标 */

/**
 * 状态徽标。
 *
 * ⚠️ 这里是**唯一**允许胶囊圆角的地方（`qf-badge`）：
 *    iOS 里 tag/badge 就是胶囊，且它不是操作、是信息标注
 *    （`lists-and-tables.md › Content`）。门禁按 `qf-badge` 放行。
 *
 * ⚠️ 文字始终存在，颜色只是辅助：只靠颜色区分状态对色弱用户不可用，
 *    在户外强光下（师傅现场）饱和度差异几乎看不出来。
 */
export function QFStatusBadge({
  label,
  tone,
  dot = true,
  testId,
}: {
  label: ReactNode;
  tone: Tone;
  /** 小圆点。单看颜色已经能区分时可关掉以省宽度 */
  dot?: boolean;
  testId?: string;
}) {
  const cls = TONE_CLASS[tone];
  return (
    <span
      data-testid={testId}
      className={`qf-badge ${cls.bg} ${cls.text} qf-caption inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium`}
      style={{ borderRadius: 9999 }}
    >
      {dot ? <span className={`${cls.dot} h-1.5 w-1.5 rounded-full`} aria-hidden="true" /> : null}
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ 卡片 */

/**
 * 卡片容器（白面 + hairline + 10px 圆角）。
 *
 * ⚠️ **不用阴影**：经典 iOS 的分组列表靠"灰底 + 白面 + 发丝线"分层，
 *    不靠投影。阴影在 iOS 上是"浮起"的语义（弹层、拖拽中），
 *    列表项用阴影会被误读为可以长按拖动。
 */
export function QFCard({
  children,
  onClick,
  className = '',
  testId,
  pressable = true,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  testId?: string;
  pressable?: boolean;
}) {
  const interactive = Boolean(onClick);
  return (
    <div
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      data-testid={testId}
      className={`bg-svc-surface overflow-hidden rounded-svc border border-svc-line ${
        interactive && pressable ? 'qf-pressable' : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}
