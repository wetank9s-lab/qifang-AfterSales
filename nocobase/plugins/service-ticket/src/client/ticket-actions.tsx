/**
 * H6 —— 四个业务动作（受理 / 派工 / 改派 / 改约）+ H3 的详情入口
 *
 * ⚠️ 三条不能越过的边界：
 *
 *  1. **UI 状态矩阵只是 UX，不是权限控制。**
 *     按钮按工单状态决定"显示/禁用"，只是为了让售后人员少点几次必然失败的按钮；
 *     真正的裁决永远在服务端（PermissionService 能力校验 + 对象级校验 + 状态机）。
 *     用户明确要求："不能把按钮隐藏当权限控制，实际 action 仍必须继续跑
 *     PermissionService + 状态机"。因此即使按钮可见，服务端返回 409/422 时
 *     这里也**原样展示服务端的错误码**，而不是自己编一句"操作失败"。
 *
 *  2. **不开新的状态写入路径。** 四个动作一律 POST 既有的 `/api/svc:*`，
 *     没有任何一处直接改库或调原生 update —— 状态只能经 TicketService /
 *     VisitService 的业务 action 修改。
 *
 *  3. **详情是只读的。** 抽屉只展示，不提交；它不提供"顺手改一下"的输入框。
 *
 * 为什么把"该显示哪些按钮"抽成纯函数 `availableActionsOf()`：
 *   它是矩阵的唯一事实来源，且能被 Node 直接调用做离线断言
 *   （scripts/verify-plugin-load.mjs），否则"NEW 状态下居然没有受理按钮"
 *   这种错误只能在真人走查时被发现 —— 而那正是复核方要求避免的。
 */
import React from 'react';
import ReactDOM from 'react-dom';
import { Alert, Button, Form, Input, Modal, Select, message } from 'antd';

import { openTicketDrawer } from './ticket-drawer';
// 矩阵与标签在 action-matrix.ts（零依赖纯模块，离线断言用同一份）
import {
  TICKET_ACTION,
  TICKET_ACTION_LABEL,
  type TicketActionName,
} from './action-matrix';

/** 派工/改派需要填写的字段（改约只需要时间与原因） */
const DISPATCH_FIELDS = [
  { name: 'technician_name', label: '师傅姓名', required: true },
  { name: 'technician_mobile', label: '师傅手机号', required: true },
  { name: 'expected_visit_at', label: '预计上门时间', required: true },
  { name: 'service_mode', label: '服务方式', required: true },
  { name: 'provider_name', label: '厂家/第三方名称', required: false },
];

/**
 * 打开一个收集参数的模态框。
 *
 * 刻意用 `Input` + `datetime-local` 而不是 antd 的 DatePicker：
 * 后者在 v4/v5 之间的 `picker` 与受控值写法差异较大，而这里只需要一个
 * 能提交 ISO 时间字符串的控件 —— 稳定性优先。
 */
function openParamsModal(opts: {
  title: string;
  fields: Array<{ name: string; label: string; required: boolean }>;
  extraText?: string;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
}): void {
  const container = document.createElement('div');
  document.body.appendChild(container);

  const close = () => {
    ReactDOM.unmountComponentAtNode(container);
    container.remove();
  };

  const FormModal = () => {
    const [form] = Form.useForm();
    const [submitting, setSubmitting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    return (
      <Modal
        open
        title={opts.title}
        onCancel={close}
        okText="提交"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={async () => {
          let values: Record<string, unknown>;
          try {
            values = await form.validateFields();
          } catch {
            return;
          }
          setSubmitting(true);
          setError(null);
          try {
            await opts.onSubmit(values);
            close();
          } catch (e) {
            setError((e as Error)?.message ?? String(e));
          } finally {
            setSubmitting(false);
          }
        }}
      >
        {opts.extraText ? (
          <Alert type="info" showIcon message={opts.extraText} style={{ marginBottom: 12 }} />
        ) : null}
        {error ? (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
        ) : null}
        <Form form={form} layout="vertical">
          {opts.fields.map((f) => (
            <Form.Item
              key={f.name}
              name={f.name}
              label={f.label}
              rules={f.required ? [{ required: true, message: `请填写${f.label}` }] : []}
            >
              {f.name === 'service_mode' ? (
                <Select
                  options={[
                    { value: 'self', label: '自营' },
                    { value: 'third_party', label: '第三方/厂家' },
                  ]}
                />
              ) : f.name === 'expected_visit_at' ? (
                <Input type="datetime-local" />
              ) : (
                <Input />
              )}
            </Form.Item>
          ))}
        </Form>
      </Modal>
    );
  };

  ReactDOM.render(<FormModal />, container);
}

/**
 * 组装四个动作 + 详情入口，并注册到引擎。
 *
 * @param ActionModel  基类（运行时从引擎取，见 index.ts）
 * @param request      请求函数（由插件注入，带鉴权）
 * @param register     把模型注册进引擎的回调
 */
export function buildTicketActionModels({
  ActionModel,
  ActionSceneEnum,
  request,
}: {
  ActionModel: any;
  ActionSceneEnum: any;
  request: (url: string, method?: string, body?: unknown) => Promise<any>;
}): Record<string, any> {
  if (!ActionModel) return {};

  /** 从流上下文里取当前行数据（不同小版本位置略有差异，逐个兜底） */
  const recordOf = (ctx: any): any =>
    ctx?.model?.context?.record ?? ctx?.record ?? ctx?.model?.context?.row ?? {};

  /** 统一错误处理：优先展示**服务端**给的错误码，不自己编文案 */
  async function callSvc(ctx: any, action: TicketActionName, body?: unknown): Promise<void> {
    const record = recordOf(ctx);
    const id = record?.id ?? record?.ticket_id;
    if (id == null) {
      message.error('取不到工单 id，无法执行');
      return;
    }
    try {
      await request(`svc:${action}?filterByTk=${id}`, 'post', body ?? {});
      message.success(`${TICKET_ACTION_LABEL[action]}成功`);
      // 刷新列表，让状态变化立刻可见（不刷的话用户会以为没生效）
      ctx?.model?.context?.blockModel?.refresh?.();
      ctx?.model?.context?.refresh?.();
    } catch (error: any) {
      const payload = error?.response?.data ?? error?.data ?? {};
      const first = payload?.errors?.[0];
      const code = first?.code ?? payload?.code;
      const msg = first?.message ?? payload?.message ?? error?.message ?? '操作失败';
      // 409/422 是**服务端的合法裁决**（状态机拒绝 / 责任人未变），
      // 必须原样呈现，否则售后人员会以为系统坏了。
      message.error(code ? `${msg}（${code}）` : msg);
    }
  }

  function makeAction(name: TicketActionName, needsParams: 'none' | 'dispatch' | 'reschedule') {
    class TicketActionModel extends ActionModel {
      static scene = ActionSceneEnum?.record ?? 'record';

      defaultProps: any = { children: TICKET_ACTION_LABEL[name] };
    }
    Object.defineProperty(TicketActionModel, 'name', { value: `Ticket${name}ActionModel` });

    TicketActionModel.define?.({ label: TICKET_ACTION_LABEL[name] });

    TicketActionModel.registerFlow?.({
      key: 'clickFlow',
      title: TICKET_ACTION_LABEL[name],
      on: 'click',
      steps: {
        run: {
          async handler(ctx: any) {
            if (needsParams === 'none') {
              await callSvc(ctx, name);
              return;
            }
            const fields =
              needsParams === 'dispatch'
                ? DISPATCH_FIELDS
                : [{ name: 'expected_visit_at', label: '新的上门时间', required: true }];
            if (name === TICKET_ACTION.REASSIGN || name === TICKET_ACTION.RESCHEDULE) {
              fields.push({ name: 'reason', label: '原因', required: true });
            }
            openParamsModal({
              title: TICKET_ACTION_LABEL[name],
              fields,
              extraText:
                name === TICKET_ACTION.REASSIGN
                  ? '改派会终止当前派工并新建一条；责任人完全相同时服务端会拒绝。'
                  : undefined,
              onSubmit: async (values) => {
                await callSvc(ctx, name, values);
              },
            });
          },
        },
      },
    });

    return TicketActionModel;
  }

  /** H3 入口：打开只读详情抽屉 */
  class TicketDetailActionModel extends ActionModel {
    static scene = ActionSceneEnum?.record ?? 'record';
    defaultProps: any = { children: '详情' };
  }
  Object.defineProperty(TicketDetailActionModel, 'name', { value: 'TicketDetailActionModel' });
  TicketDetailActionModel.define?.({ label: '详情' });
  TicketDetailActionModel.registerFlow?.({
    key: 'clickFlow',
    title: '详情',
    on: 'click',
    steps: {
      open: {
        async handler(ctx: any) {
          const record = recordOf(ctx);
          const id = record?.id;
          if (id == null) {
            message.error('取不到工单 id');
            return;
          }
          openTicketDrawer({
            ticketId: id,
            request: (url) => request(url, 'get'),
          });
        },
      },
    },
  });

  return {
    TicketAcceptActionModel: makeAction(TICKET_ACTION.ACCEPT, 'none'),
    TicketDispatchActionModel: makeAction(TICKET_ACTION.DISPATCH, 'dispatch'),
    TicketReassignActionModel: makeAction(TICKET_ACTION.REASSIGN, 'dispatch'),
    TicketRescheduleActionModel: makeAction(TICKET_ACTION.RESCHEDULE, 'reschedule'),
    TicketDetailActionModel,
  };
}
