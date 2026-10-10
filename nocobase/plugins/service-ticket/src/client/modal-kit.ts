/**
 * modal-kit —— 业务弹窗的**统一开法**（Phase 11 / P11-1，用户 2026-10-10 裁决 C）
 * =============================================================================
 *
 * 为什么要有这个文件
 * -----------------------------------------------------------------------------
 * 裁决 C 要求「处理、跟进、审核等操作弹窗**保持一致**的关闭/取消行为」，
 * 而本项目此前三种弹窗各写各的 `Modal.confirm`：**都没有右上角的 ×**、
 * 有的不拦"未保存就关闭"、没有一个在提交中防重复点击。
 * 三份各自会漂移的实现，正是本项目反复强调的"同一个坑长出多条腿"。
 * ⇒ 收敛成本文件的 `openClosableModal()`，所有业务弹窗都从这里开。
 *
 * 🔴 修复的问题：**Modal 关不掉**
 * -----------------------------------------------------------------------------
 * 原来一律用 `Modal.confirm({ icon: null, footer: null })`。antd 的 `Modal.method`
 * 系列**默认 `closable: false`** —— 也就是**没有右上角那个 ×**。
 * 当内容是整个表单（「处理」的几种方式）时，用户**没有任何"放弃"的入口**：
 * 只能一路选下去，或者在一张空表单上点「取消」。
 * P11-0 的走查记录里写过这一条（"Modal.confirm 没有关闭 X ⇒ 必须退回「取消」按钮"），
 * 但当时只是**绕过**（加了个取消按钮），没有真正修 —— 本轮才是修。
 *
 * ✅ 为什么用 `closable: true` 而不是自己造一个 ×
 * -----------------------------------------------------------------------------
 * 裁决 C4 明文：**使用 NocoBase 当前支持的 Modal API 和事件**，
 * **禁止直接操作 `ant-modal-content` DOM**。
 * ⇒ 全部走 antd 的公开 props 与实例方法（`Modal.confirm` → 实例 `.update()`），
 *   不查 DOM、不注入节点、不依赖 antd 内部的 className。
 *   （自己插一个 × 进 `.ant-modal-content` 会在 antd 升级时静默失效，
 *     而且那种"补丁式 UI"没人会记得在版本升级时检查。）
 *
 * ⚠️ `closable` 是否真的渲染出 ×、点下去是否真的关掉 —— 由**真实浏览器门禁**回答，
 *    不靠读文档推测。`verify-store-ui-primary-action.mjs` 会真的点那个 × 并断言
 *    弹窗消失、遮罩不残留、页面还能继续操作。
 *
 * 两种形态（都由本文件提供，避免每个弹窗各写一遍）
 * -----------------------------------------------------------------------------
 *   · **footer 由 kit 提供**：`onOk` 就是提交动作 ⇒ kit 负责 busy（loading + disabled，
 *     防重复提交）与"失败保持打开"（不丢用户刚填的内容）。
 *   · **footer 隐藏**（`hideFooter: true`）：内容自带按钮（如「处理」窗口的
 *     返回/保存）⇒ kit 只负责 ×、未保存确认与统一的取消语义。
 */
import React from 'react';
import { Modal } from 'antd';

export interface ClosableModalContext {
  /** 关闭弹窗（等价于点 × / 取消） */
  close: () => void;
  /** 标记"正在提交"：OK 按钮变 loading 且禁用 ⇒ 防重复提交 */
  setBusy: (busy: boolean) => void;
}

export interface ClosableModalOptions {
  title: string;
  content: React.ReactNode;
  okText?: string;
  cancelText?: string;
  /** 内容自带按钮（如「处理」窗口）⇒ 不渲染 kit 的底部按钮，只保留 × 与取消语义 */
  hideFooter?: boolean;
  /**
   * 关闭（× / 取消 / ESC）前是否需要二次确认。
   *
   * 判据由调用方给（例如"表单里已经有内容"）—— kit 不猜"什么算未保存"，
   * 因为不同弹窗的"有内容"定义不同（处理窗口是选了方式、跟进窗口是填了字）。
   */
  hasUnsavedChanges?: () => boolean;
  unsavedHint?: string;
  /**
   * 点「确定」时执行（`hideFooter` 时不会被调用）。
   *
   * · **正常返回** ⇒ 弹窗关闭；
   * · **抛错** ⇒ 弹窗**保持打开**（输入错误时用户要能改，而不是重新填一遍），
   *   并且 `busy` 会被复位（否则按钮永远转圈）。
   */
  onOk?: (ctx: ClosableModalContext) => Promise<void> | void;
  /** 内容容器上的 `data-testid`（门禁用它定位） */
  testid?: string;
}

export interface ClosableModalHandle {
  /** 关闭弹窗（成功路径上调用） */
  close: () => void;
}

/** 打开一个**可关闭**的业务弹窗（统一形态：有 ×、未保存确认、提交中防重复） */
export function openClosableModal(options: ClosableModalOptions): ClosableModalHandle {
  let busy = false;
  let closed = false;
  let instance: any = null;

  const destroy = (): void => {
    if (closed) return;
    closed = true;
    try {
      instance?.destroy?.();
    } catch {
      /* 已销毁 */
    }
  };

  instance = Modal.confirm({
    title: options.title,
    icon: null,
    // 🔴 右上角的 ×。这是本轮 C 的核心修复点。
    closable: true,
    // ⚠️ 点遮罩**不**关闭：业务弹窗里的表单点到外面就消失，用户会以为
    //    "消失了 = 没保存"然后重来一遍 —— 而实际上什么都没发生。
    maskClosable: false,
    keyboard: true,
    okText: options.okText ?? '保存',
    cancelText: options.cancelText ?? '取消',
    width: 480,
    ...(options.hideFooter ? { footer: null } : {}),
    content: React.createElement(
      'div',
      { 'data-testid': options.testid ?? 'svc-modal-body' },
      options.content as any,
    ),
    onOk: async () => {
      if (busy) return; // 防重复（回车/双击路径；按钮本身也已 disabled）
      if (!options.onOk) {
        destroy();
        return;
      }
      busy = true;
      instance?.update?.({ okButtonProps: { loading: true, disabled: true } });
      try {
        await options.onOk({
          close: destroy,
          setBusy: (v: boolean) => {
            busy = v;
            instance?.update?.({ okButtonProps: { loading: v, disabled: v } });
          },
        });
      } catch (error) {
        // 失败 ⇒ 复位 busy 并**保持打开**（关掉会让用户丢掉刚填的内容）
        busy = false;
        instance?.update?.({ okButtonProps: { loading: false, disabled: false } });
        throw error;
      }
    },
    onCancel: () => {
      // × / 取消 / ESC 都走这里（antd 的统一事件，不碰 DOM）
      if (closed) return;
      if (options.hasUnsavedChanges?.()) {
        Modal.confirm({
          title: '放弃未保存的内容？',
          icon: null,
          closable: true,
          content: options.unsavedHint ?? '当前弹窗里已经有填写的内容，关闭后不会保存。',
          okText: '放弃并关闭',
          cancelText: '继续填写',
          onOk: () => destroy(),
        });
        return;
      }
      destroy();
    },
  });

  return { close: destroy };
}
