/**
 * QF 二次确认（经典 iOS Action Sheet 形态）。
 *
 * ===========================================================================
 * 为什么不用 Konsta 的 `<Dialog>`
 * ===========================================================================
 *   Konsta `Dialog` 在 5.5.0 上走的是 iOS 26 的浮层样式（圆角卡片 + 居中）。
 *   用户第 一 节明确要求"经典 iOS 17/18 浅色"，并且禁止"浮动玻璃"。
 *   Action Sheet（底部升起、白色分组、底部独立 Cancel 键）是 iOS 17 里
 *   "确认一个会改变数据的动作"的标准形态，也是本项目**已经用了两年**的形态
 *   （用户对它有肌肉记忆，换成居中卡片反而要重新学）。
 *
 * ===========================================================================
 * 什么时候该用它，什么时候不该
 * ===========================================================================
 *   该用：不可撤销、或会影响他人 —— 完成阶段（会通知客户）、撤回阶段（连锁撤回）、
 *         作废档案、派工（会给师傅发短信）。
 *   不该用：保存/提交这类可重试的动作。
 *     每步都弹窗会让用户开始无脑点"确定"，那时二次确认反而失去保护作用。
 *     ⇒ 本组件默认**不**给"提交建档"用（那里的确认改成"提交后立即对客户可见"
 *       这条**新信息**才有价值，但它属于表单内的说明，不是弹窗）。
 *
 * ⚠️ 危险动作的按钮**红字**且放在**下方**：iOS 的 Action Sheet 里，
 *    destructive 永远是红字、且在 visual hierarchy 上让人多看一眼。
 *    `buttons.md › Role`："Don't assign the primary role to a button that performs
 *    a destructive action"。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface QFConfirmSpec {
  title: string;
  /** 说明文字（可含换行） */
  message?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 危险动作：确认键红字 */
  danger?: boolean;
}

/**
 * 二次确认 hook。
 *
 * 用法：
 * ```tsx
 * const { ask, node } = useQFConfirm();
 * ...
 * if (await ask({ title: '完成「现场勘察」？', danger: false })) { ... }
 * ...
 * {node}
 * ```
 *
 * ⚠️ `ask()` 返回 Promise，`node` 必须挂到页面上 —— 忘了挂的话
 *    Promise 永远不 resolve，表现为"点按钮没反应"。这是最容易漏的一处，
 *    所以本文件把它做成**一个对象同时含 ask 和 node**，而不是两个独立 hook。
 */
export function useQFConfirm() {
  const [spec, setSpec] = useState<QFConfirmSpec | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const ask = (s: QFConfirmSpec): Promise<boolean> =>
    new Promise((resolve) => {
      resolver.current = resolve;
      setSpec(s);
    });

  const close = (ok: boolean) => {
    setSpec(null);
    resolver.current?.(ok);
    resolver.current = null;
  };

  const node = <QFConfirmSheet spec={spec} onClose={close} />;
  return { ask, node };
}

/**
 * 面板本体。
 *
 * ⚠️ 用 `position: fixed` + 底部对齐，**不用** `backdrop-filter`：
 *    用户明令禁止毛玻璃。遮罩用纯半透明黑（`rgba(0,0,0,0.4)`），
 *    这是经典 iOS 的做法 —— 遮罩的作用是"把注意力拉到面板上"，
 *    不需要让人还能看清后面的内容。
 *
 * ⚠️ 面板入场动画只有 220ms 上滑，不做缩放、不做弹性：
 *    `motion.md › Best practices` 要求动效"有目的、可取消、反馈要短"。
 */
export function QFConfirmSheet({
  spec,
  onClose,
}: {
  spec: QFConfirmSpec | null;
  onClose: (ok: boolean) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const open = Boolean(spec);

  useEffect(() => {
    if (!open) {
      setMounted(false);
      return;
    }
    // 下一帧再上滑，否则初始位置就是终点，"没有动画"
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!spec) return null;

  return (
    <div
      // 遮罩层级要高于 Konsta 的 nav/toolbar（z-20/z-30），否则面板会被压在下面
      className="fixed inset-0 z-[60] flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={spec.title}
      data-testid="qf-confirm"
    >
      {/* 遮罩：点它 = 取消（iOS 的 Action Sheet 也是） */}
      <button
        type="button"
        aria-label="关闭"
        className="absolute inset-0 bg-black/40 transition-opacity duration-200"
        style={{ opacity: mounted ? 1 : 0 }}
        onClick={() => onClose(false)}
      />

      <div
        className="relative px-2 pb-2 transition-transform duration-200"
        style={{
          transform: mounted ? 'translateY(0)' : 'translateY(16px)',
          opacity: mounted ? 1 : 0,
          transitionTimingFunction: 'cubic-bezier(0.32, 0.72, 0, 1)',
          paddingBottom: 'calc(8px + var(--k-safe-area-bottom, 0px))',
        }}
      >
        {/* 内容组（标题 + 说明 + 动作） */}
        <div className="bg-svc-surface overflow-hidden rounded-svc-lg">
          <div className="border-svc-line px-4 py-3 text-center">
            <div className="text-svc-ink-2 qf-foot font-medium">{spec.title}</div>
            {spec.message ? (
              <div className="text-svc-ink qf-foot mt-1.5 leading-relaxed">{spec.message}</div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => onClose(true)}
            data-testid="confirm-ok"
            className={`qf-cta qf-pressable border-svc-line flex w-full items-center justify-center border-t px-4 font-semibold ${
              spec.danger ? 'text-svc-danger' : 'text-svc-brand-text'
            }`}
            style={{ borderRadius: 0 }}
          >
            {spec.confirmText ?? '确定'}
          </button>
        </div>

        {/* Cancel 独立成组（iOS 标准形态：与动作之间有 8px 间隙） */}
        <button
          type="button"
          onClick={() => onClose(false)}
          data-testid="confirm-cancel"
          className="bg-svc-surface text-svc-brand-text qf-cta qf-pressable mt-2 flex w-full items-center justify-center rounded-svc-lg px-4 font-semibold"
        >
          {spec.cancelText ?? '取消'}
        </button>
      </div>
    </div>
  );
}
