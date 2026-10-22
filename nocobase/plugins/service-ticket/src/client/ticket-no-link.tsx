/**
 * `TicketNoLinkModel` —— UX-01A / A2：把**工单号列**做成"可点击链接 → 只读详情抽屉"。
 *
 * ===========================================================================
 * 为什么是"派生一个字段模型"，而不是"再挂一个行按钮"
 * ===========================================================================
 *  · 冻结门禁 `verify-store-ui-primary-action.mjs` 判据① 要求
 *    **行操作列总共只有一个按钮** —— 再挂一个"查看"行按钮会直接破坏它（用户 §二 也重申保留该门禁）。
 *  · 用户 §二 明确："优先复用当前已存在的工单行点击与 ticket-drawer.tsx 只读详情能力……
 *    将工单号显示为明确可点击的链接样式……只有现有机制无法满足时，才允许最小范围的列模型扩展。"
 *  · 经核对运行实例的 `flowModels`：每个 `serviceTickets` 表的工单号列结构是
 *    `TableColumnModel`（subKey=columns）→ 子节点 `DisplayTextFieldModel`（subKey=field，
 *    declaredKey 形如 `<block>.ticket_no.field`）。NocoBase 的 `DisplayTextFieldModel`
 *    由宿主提供，其它插件（如 `@nocobase/plugin-text-copy`）就是**派生/包裹它的 `renderComponent`**
 *    来做"单元格级"增强 —— 这就是本项目"最小列模型扩展"的既有范式。
 *  · ⇒ 本文件派生 `DisplayTextFieldModel`，只把"工单号这一个字段"的单元格渲染成链接；
 *    其余字段、其它页面**完全不受影响**。点击只调用**已有的** `openTicketDrawer`（只读），
 *    不改状态、不派工、不发短信。
 *
 * ===========================================================================
 * 取不到基类 / 取不到行记录 ⇒ **静默退回普通文本**（绝不假装可点）
 * ===========================================================================
 *  基类从 `engine.getModelClass('DisplayTextFieldModel')` 取（与 index.ts 取 ActionModel 同法）。
 *  行记录从 `this.context.record` 取（与 `primary-action.tsx` 同源：框架的 `getInputArgs()`
 *  就是用 `this.context.collection/record`）。任一取不到，就返回父类原渲染 ——
 *  "点不动的文本"是可接受的降级；"点了报错的假链接"不是。
 */
import React from 'react';
import { openTicketDrawer } from './ticket-drawer';

type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

/** 行记录取 id：兼容普通对象 / 带 data / 带 get() 的封装（与 primary-action 的 pick 同形） */
function idOf(record: any): number | null {
  if (!record) return null;
  let v = record.id;
  if (v === undefined) v = record?.data?.id;
  if (v === undefined && typeof record?.get === 'function') v = record.get('id');
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function buildTicketNoLinkModel(deps: {
  BaseFieldModel: any;
  request: Requester;
}): Record<string, any> {
  const { BaseFieldModel, request } = deps;
  // 取不到宿主基类 ⇒ 返回空对象（后台其余功能不受影响；工单号退化为普通文本）
  if (!BaseFieldModel) return {};

  const baseRender: ((props: any, schema: any) => any) | undefined =
    BaseFieldModel.prototype?.renderComponent;

  class TicketNoLinkModel extends BaseFieldModel {
    renderComponent(props: any, schema: any): any {
      // 父类原渲染（拿不到就返回 null，绝不因此中断整个单元格）
      let fallback: any = null;
      try {
        fallback = baseRender ? baseRender.call(this, props, schema) : null;
      } catch {
        fallback = null;
      }

      // 值：`DisplayTextFieldModel` 的取值方法 `this.t(props)`（见 plugin-text-copy 的用法）
      let value: any;
      try {
        value = (this as any).t?.(props);
      } catch {
        value = undefined;
      }
      if (value === undefined) value = props?.value;
      if (value == null || value === '') return fallback;

      const record = (this as any)?.context?.record ?? props?.record ?? null;
      const id = idOf(record);
      // 拿不到 id ⇒ 退回普通文本（不假装可点）
      if (id == null) return fallback;

      return React.createElement(
        'a',
        {
          style: { color: '#1677ff', cursor: 'pointer' },
          // 验收用：浏览器门禁确认"这一格是可点的工单号、指向哪张单"
          'data-testid': 'ticket-no-link',
          'data-ticket-id': id,
          onClick: () => openTicketDrawer({ ticketId: id, request: request as any }),
        },
        String(value),
      );
    }
  }
  Object.defineProperty(TicketNoLinkModel, 'name', { value: 'TicketNoLinkModel' });

  return { TicketNoLinkModel };
}
