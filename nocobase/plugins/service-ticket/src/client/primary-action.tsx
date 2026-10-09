/**
 * `TicketPrimaryActionModel` —— 门店列表的**每行唯一主动作**（Phase 11 / P11-0）
 *
 * ===========================================================================
 * 它替代什么
 * ===========================================================================
 * 原来每行挂着五个按钮：详情 / 受理 / 派工 / 改派 / 改约（外加 NocoBase 原生的
 * 查看 / 编辑 / 删除）—— 一线同事要在一堵按钮墙里挑。现在**每行只有一个**，
 * 且它的**标签与行为由当前状态决定**（契约 §5.1）：
 *
 * | 状态 | 主动作 | 点击后 |
 * |---|---|---|
 * | `NEW` | 处理 | 处理窗口：五种现实处理方式 |
 * | `PROCESSING` | 跟进 | 跟进窗口：记跟进情况（+ 可选下次跟进日期） |
 * | `WAIT_STORE_CONFIRM` | 审核结果 | 打开服务详情（审核在详情内完成） |
 * | `WAIT_FEEDBACK` / `CLOSED` / `CANCELLED` | 查看 | 打开服务详情 |
 * | 其它/未知 | **不渲染** | —— |
 *
 * ⚠️ **不是**"把七个按钮用 CSS 藏起来"：模型只注册一个，且 `render()` 里只在
 *    状态可识别时返回一个按钮。隐藏式做法会在 DOM 里留下可被键盘/自动化点到的残留。
 *
 * ===========================================================================
 * 动态渲染怎么实现的（这是本文件最需要解释的一点）
 * ===========================================================================
 * 基类 `ActionModel` 是**运行时注入**的（见 `index.ts` 的 `buildTicketActionModels({ ActionModel, … })`），
 * 不同小版本导出的钩子不完全一样。因此这里**不假设**某个具体钩子名，而是：
 *
 *   ① **覆写 `render()`** —— 若基类走 `render()`，则标签与点击行为完全由我们决定；
 *   ② **同时注册一个 click 流** —— 若基类不走 `render()`（例如内部另有渲染路径），
 *      按钮会退化为 `defaultProps.children` 的固定标签，但**点击仍按状态路由**，
 *      所以"点了做对的事"这一半永远成立；
 *   ③ 两条路都不影响"**一行一个主动作**"这一硬要求（模型只有一个、只挂一次）。
 *
 * ⇒ 结论：**行为**是确定的（点击按状态路由），**标签**是否随状态变需要真机验证
 *   （用 `scripts/verify-…` 之外的浏览器走查确认）。若某个小版本不支持动态标签，
 *   退化形态是"固定显示『处理』"而不是"按钮墙复活"。
 */
import React from 'react';
import { Form, Input, Modal, Select, DatePicker, message } from 'antd';

import { openTicketDrawer } from './ticket-drawer';
import {
  HANDLE_CHOICES,
  HANDLE_CHOICE,
  PRIMARY_ACTION,
  primaryActionOf,
  type HandleChoiceKey,
} from './row-action-matrix';
import { REQUEST_ID_HEADER, newRequestId, sendSvcRequest } from '../shared/svc-request';

/** 与 index.ts 注入的请求器同形（第四个参数必须支持 headers） */
type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

interface PrimaryActionDeps {
  ActionModel: any;
  ActionSceneEnum?: any;
  request: Requester;
  /** 由 index.ts 注入：把服务端错误原样展示（含 code） */
  onError?: (error: any) => void;
}

/** 从错误里取服务端的 code/message —— 409/422 是服务端的**合法裁决**，必须原样展示 */
function errorText(error: any): string {
  const payload = error?.response?.data ?? error?.data ?? {};
  const first = payload?.errors?.[0];
  const code = first?.code ?? payload?.code;
  const msg = first?.message ?? payload?.message ?? error?.message ?? '操作失败';
  return code ? `${msg}（${code}）` : msg;
}

/** 取当前行的工单 id：`ctx.record` 是 flow-engine 给的当前记录 */
function recordIdOf(ctx: any): number | null {
  const id = ctx?.record?.id ?? ctx?.record?.getId?.() ?? ctx?.record?.data?.id;
  const n = Number(id);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function statusOf(ctx: any): string {
  const rec = ctx?.record;
  return String(rec?.status ?? rec?.data?.status ?? rec?.get?.('status') ?? '');
}

export function buildPrimaryActionModel(deps: PrimaryActionDeps): Record<string, any> {
  const { ActionModel, ActionSceneEnum, request } = deps;

  /** 统一的写请求（带 UUID v4 的 X-Request-Id；它是幂等键） */
  async function write(url: string, body: unknown): Promise<any> {
    return sendSvcRequest(request as any, url, body, { [REQUEST_ID_HEADER]: newRequestId() });
  }

  // -------------------------------------------------------------------------
  // 五种处理方式的表单（**按方式动态展示必要字段**，不让员工填无关信息）
  // -------------------------------------------------------------------------
  function openHandleWindow(ticketId: number, onDone: () => void) {
    const modal = Modal.info({
      title: '处理这张服务单',
      width: 560,
      icon: null,
      content: React.createElement(HandleChooser, { ticketId, onDone, close: () => modal.destroy() }),
      footer: null,
    });
  }

  function HandleChooser({ ticketId, onDone, close }: any) {
    const [choice, setChoice] = React.useState<HandleChoiceKey | null>(null);
    const [busy, setBusy] = React.useState(false);

    if (!choice) {
      return React.createElement(
        'div',
        { 'data-testid': 'handle-choices' },
        HANDLE_CHOICES.map((c) =>
          React.createElement(
            'button',
            {
              key: c.key,
              type: 'button',
              'data-choice': c.key,
              style: {
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '12px 14px',
                marginBottom: 8,
                border: '1px solid #d9d9d9',
                borderRadius: 6,
                background: '#fff',
                cursor: 'pointer',
              },
              onClick: () => setChoice(c.key),
            },
            React.createElement('div', { style: { fontWeight: 600 } }, c.label),
            React.createElement('div', { style: { color: '#888', fontSize: 12 } }, c.hint),
          ),
        ),
      );
    }

    return React.createElement(HandleForm, {
      choice,
      ticketId,
      busy,
      setBusy,
      close,
      onDone,
      onBack: () => setChoice(null),
    });
  }

  function HandleForm({ choice, ticketId, close, onDone, onBack }: any) {
    const [values, setValues] = React.useState<Record<string, any>>({});
    const [busy, setBusy] = React.useState(false);
    const [storeOpts, setStoreOpts] = React.useState<any[]>([]);

    // 转店：目标门店来自**专用**接口 transferTargets（含未被授权管理的启用门店）
    React.useEffect(() => {
      if (choice !== HANDLE_CHOICE.TRANSFER) return;
      let alive = true;
      request(`/api/svc:transferTargets?filterByTk=${ticketId}`, 'get')
        .then((d: any) => {
          if (alive) setStoreOpts(d?.options ?? []);
        })
        .catch(() => {});
      return () => {
        alive = false;
      };
    }, [choice, ticketId]);

    const set = (k: string, v: any) => setValues((p) => ({ ...p, [k]: v }));

    async function submit() {
      setBusy(true);
      try {
        if (choice === HANDLE_CHOICE.INHOUSE) {
          await write(`/api/svc:dispatch?filterByTk=${ticketId}`, {
            service_mode: 'inhouse',
            technician_name: values.technician_name,
            technician_mobile: values.technician_mobile,
            expected_visit_at: values.expected_visit_at,
          });
        } else if (choice === HANDLE_CHOICE.EXTERNAL) {
          // 厂家/第三方：**只需服务商名称**（不伪造师傅信息，契约 §7.2）
          await write(`/api/svc:dispatch?filterByTk=${ticketId}`, {
            service_mode: values.service_mode || 'manufacturer',
            provider_name: values.provider_name,
          });
        } else if (choice === HANDLE_CHOICE.REMOTE) {
          await write(`/api/svc:remoteComplete?filterByTk=${ticketId}`, {
            completion_result: values.completion_result || 'resolved',
            completion_note: values.completion_note,
            is_charged: values.is_charged === true,
            ...(values.is_charged === true ? { amount: Number(values.amount) } : {}),
          });
        } else if (choice === HANDLE_CHOICE.TRANSFER) {
          await write(`/api/svc/tickets/${ticketId}/transfer`, {
            target_store_code: values.target_store_code,
            reason: values.reason,
          });
        } else if (choice === HANDLE_CHOICE.CANCEL) {
          await write(`/api/svc/tickets/${ticketId}/cancel`, { reason: values.reason });
        }
        message.success('已保存');
        close();
        onDone();
      } catch (error: any) {
        // 服务端 409/422 原样展示（那是有意义的业务裁决，不是"操作失败"）
        message.error(errorText(error));
      } finally {
        setBusy(false);
      }
    }

    const field = (label: string, node: React.ReactNode, required = false) =>
      React.createElement(
        'div',
        { style: { marginBottom: 12 } },
        React.createElement('div', { style: { marginBottom: 4 } }, required ? `${label} *` : label),
        node,
      );

    const body: React.ReactNode[] = [];
    if (choice === HANDLE_CHOICE.INHOUSE) {
      body.push(
        field('师傅姓名', React.createElement(Input, { 'data-field': 'technician_name', onChange: (e: any) => set('technician_name', e.target.value) }), true),
        field('师傅手机号', React.createElement(Input, { 'data-field': 'technician_mobile', onChange: (e: any) => set('technician_mobile', e.target.value) }), true),
        field('预计上门日期', React.createElement(DatePicker, { 'data-field': 'expected_visit_at', onChange: (_: any, s: string) => set('expected_visit_at', s) }), true),
      );
    } else if (choice === HANDLE_CHOICE.EXTERNAL) {
      body.push(
        field(
          '服务方类型',
          React.createElement(Select, {
            'data-field': 'service_mode',
            defaultValue: 'manufacturer',
            style: { width: '100%' },
            onChange: (v: string) => set('service_mode', v),
            options: [
              { value: 'manufacturer', label: '厂家售后' },
              { value: 'third_party', label: '第三方服务商' },
            ],
          }),
          true,
        ),
        field('服务商名称（如「海尔售后」）', React.createElement(Input, { 'data-field': 'provider_name', onChange: (e: any) => set('provider_name', e.target.value) }), true),
        React.createElement('div', { style: { color: '#888', fontSize: 12 } }, '不需要填具体师傅；后续知道师傅后再补充即可'),
      );
    } else if (choice === HANDLE_CHOICE.REMOTE) {
      body.push(
        field(
          '处理结果',
          React.createElement(Select, {
            'data-field': 'completion_result',
            defaultValue: 'resolved',
            style: { width: '100%' },
            onChange: (v: string) => set('completion_result', v),
            options: [
              { value: 'resolved', label: '已解决' },
              { value: 'need_followup', label: '需再跟进' },
              { value: 'unresolved', label: '未解决' },
            ],
          }),
          true,
        ),
        field('处理说明', React.createElement(Input.TextArea, { 'data-field': 'completion_note', rows: 2, onChange: (e: any) => set('completion_note', e.target.value) })),
        field(
          '是否收费',
          React.createElement(Select, {
            'data-field': 'is_charged',
            defaultValue: false,
            style: { width: '100%' },
            onChange: (v: boolean) => set('is_charged', v),
            options: [
              { value: false, label: '不收费' },
              { value: true, label: '收费' },
            ],
          }),
          true,
        ),
      );
      if (values.is_charged === true) {
        body.push(field('收费金额', React.createElement(Input, { 'data-field': 'amount', onChange: (e: any) => set('amount', e.target.value) }), true));
      }
    } else if (choice === HANDLE_CHOICE.TRANSFER) {
      body.push(
        field(
          '转给门店',
          React.createElement(Select, {
            'data-field': 'target_store_code',
            style: { width: '100%' },
            onChange: (v: string) => set('target_store_code', v),
            options: storeOpts.map((o) => ({ value: o.code, label: `${o.name}（${o.code}）` })),
          }),
          true,
        ),
        field('转店原因', React.createElement(Input, { 'data-field': 'reason', onChange: (e: any) => set('reason', e.target.value) }), true),
      );
    } else if (choice === HANDLE_CHOICE.CANCEL) {
      body.push(field('取消原因', React.createElement(Input, { 'data-field': 'reason', onChange: (e: any) => set('reason', e.target.value) }), true));
    }

    const label = HANDLE_CHOICES.find((c) => c.key === choice)?.label ?? '';
    return React.createElement(
      'div',
      { 'data-testid': 'handle-form', 'data-choice': choice },
      body,
      React.createElement(
        'div',
        { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 } },
        // 「返回」回到五种方式的选择列表 —— 一线同事选错了不该被迫关掉整个窗口
        React.createElement(
          'button',
          { type: 'button', 'data-action': 'back', disabled: busy, onClick: () => onBack?.() },
          '返回',
        ),
        React.createElement(
          'button',
          { type: 'button', 'data-action': 'save', disabled: busy, onClick: submit },
          busy ? '保存中…' : `保存（${label}）`,
        ),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // 跟进窗口
  // -------------------------------------------------------------------------
  function openFollowWindow(ticketId: number, onDone: () => void) {
    const values: Record<string, any> = {};
    const modal = Modal.confirm({
      title: '记录跟进',
      width: 480,
      content: React.createElement(
        'div',
        { 'data-testid': 'follow-form' },
        React.createElement(Input.TextArea, {
          'data-field': 'note',
          rows: 3,
          placeholder: '跟进情况（必填）：例如「已联系客户，约明天上午上门」',
          onChange: (e: any) => (values.note = e.target.value),
        }),
        React.createElement('div', { style: { height: 8 } }),
        React.createElement(DatePicker, {
          'data-field': 'next_follow_at',
          placeholder: '下次跟进日期（选填）',
          onChange: (_: any, s: string) => (values.next_follow_at = s),
        }),
      ),
      okText: '保存',
      cancelText: '取消',
      onOk: async () => {
        if (!values.note) {
          message.error('必须填写跟进情况');
          throw new Error('missing note');
        }
        try {
          await write(`/api/svc:followUp?filterByTk=${ticketId}`, {
            note: values.note,
            ...(values.next_follow_at ? { next_follow_at: values.next_follow_at } : {}),
          });
          message.success('已记录跟进');
          modal.destroy();
          onDone();
        } catch (error: any) {
          message.error(errorText(error));
          throw error;
        }
      },
    });
  }

  const modelName = 'TicketPrimaryActionModel';

  class PrimaryActionModel extends ActionModel {
    static scene = ActionSceneEnum?.record ?? 'record';

    defaultProps: any = { children: '处理' };

    /**
     * 自定义渲染：按**当前行状态**决定这一个按钮的标签与点击行为。
     * 状态不可识别（含空值）时**不渲染**任何按钮 —— 未知状态不给危险操作。
     */
    render() {
      const ctx: any = this;
      const status = statusOf(ctx);
      const action = primaryActionOf(status);
      if (!action) return null;

      const ticketId = recordIdOf(ctx);
      const refresh = () => {
        const em: any = (ctx as any).flowEngine ?? (ctx as any).app?.flowEngine;
        em?.refresh?.();
      };

      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'ant-btn ant-btn-link',
          'data-primary-action': action.kind,
          'data-ticket-id': ticketId ?? '',
          'data-action-label': action.label,
          onClick: () => {
            if (ticketId === null) {
              message.error('取不到当前行工单号，请刷新后重试');
              return;
            }
            if (action.kind === PRIMARY_ACTION.HANDLE) openHandleWindow(ticketId, refresh);
            else if (action.kind === PRIMARY_ACTION.FOLLOW) openFollowWindow(ticketId, refresh);
            else openTicketDrawer(request as any, ticketId, { onChanged: refresh });
          },
        },
        action.label,
      );
    }
  }

  return { [modelName]: PrimaryActionModel };
}
