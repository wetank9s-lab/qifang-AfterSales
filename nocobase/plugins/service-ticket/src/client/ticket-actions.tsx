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
 *     且每个请求都显式带上服务端要求的 `X-Request-Id`（见 svc-request.ts）。
 *     没有任何一处直接改库或调原生 update —— 状态只能经 TicketService /
 *     VisitService 的业务 action 修改。
 *
 *  3. **详情是只读的。** 抽屉只展示，不提交；它不提供"顺手改一下"的输入框。
 *
 * 为什么把"该显示哪些按钮"抽成纯函数 `availableActionsOf()`：
 *   它是矩阵的唯一事实来源，且能被 Node 直接调用做离线断言
 *   （scripts/verify-client-logic.mjs），否则"NEW 状态下居然没有受理按钮"
 *   这种错误只能在真人走查时被发现 —— 而那正是复核方要求避免的。
 *
 * ---------------------------------------------------------------------------
 * ⚠️ service_mode 的下拉选项与 provider_name 的必填规则**不在本文件里定义**，
 *    而是取自 `src/shared/service-mode.ts`（前后端共享的单一事实来源）。
 *
 *    2026-09-21 之前这里手写过一份（`self` / `third_party`），而服务端只认
 *    `inhouse / manufacturer / third_party` —— 于是"选自营必然 422"、
 *    "厂家数据永远产生不出来"。这类缺陷静态审查查不出、单测也查不出，
 *    只有真人点下去才会爆；现在两处**不可能再各自存在**。
 */
import React from 'react';
import ReactDOM from 'react-dom';
import { Alert, Form, Input, Modal, Select, message } from 'antd';

import { openTicketDrawer } from './ticket-drawer';
// 矩阵与标签在 action-matrix.ts（零依赖纯模块，离线断言用同一份）
import {
  TICKET_ACTION,
  TICKET_ACTION_LABEL,
  type TicketActionName,
} from './action-matrix';
// 前后端共享契约：选项集合 / 条件必填 / request-id
import {
  DISPATCH_FORM_FIELDS,
  buildDispatchPayload,
  buildReschedulePayload,
  dispatchServiceModeOptions,
  missingDispatchFields,
  missingRescheduleFields,
  requiresProviderName,
} from '../shared/service-mode';
import { REQUEST_ID_HEADER, newRequestId, sendSvcRequest } from '../shared/svc-request';

/**
 * 统一请求器形态（由 index.ts 注入，实际走 `app.apiClient`）。
 *
 * 第四个参数是**必须支持 headers** 的 —— 服务端六个内部写动作一律要求
 * 合法的 UUID v4 的 X-Request-Id；没有它就 422，
 * 且它同时是幂等键（见 docs/DEVIATIONS.md DEV-58）。
 */
type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string> },
) => Promise<any>;

/** 字段描述：`required` 之外的条件必填由 UI 与共享契约共同决定 */
interface ModalField {
  name: string;
  label: string;
  required: boolean;
}

/**
 * 字段名 → 中文标签。
 *
 * 字段**清单**不在这里 —— 它取自共享契约的 `DISPATCH_FORM_FIELDS`
 * （与 `missingDispatchFields` / `buildDispatchPayload` / 服务端 `dispatchInputOf`
 * 共用同一份列表）。这里只补 UI 需要的"怎么叫它"，连 order 都由清单决定。
 */
const FIELD_LABEL: Record<string, string> = {
  technician_name: '师傅姓名',
  technician_mobile: '师傅手机号',
  expected_visit_at: '预计上门时间',
  service_mode: '服务方式',
  provider_name: '厂家/第三方名称',
  reason: '原因',
};

/** 派工/改派的字段列表：order + 是否无条件必填都写在 contract 那侧，这里只加标签 */
const DISPATCH_FIELDS: ModalField[] = DISPATCH_FORM_FIELDS.map((name) => ({
  name,
  label: FIELD_LABEL[name] ?? name,
  // ⚠️ provider_name 的必填是**条件必填**（见 requiresProviderName），此处记"否"
  required: name !== 'provider_name',
}));

/** 改约只需要这两个字段（改约不换人，所以没有 service_mode / provider_name） */
const RESCHEDULE_FIELDS: ModalField[] = [
  { name: 'expected_visit_at', label: '新的上门时间', required: true },
  { name: 'reason', label: '原因', required: true },
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
  fields: ModalField[];
  /** 共享契约里的必填复核（UI rules 之外的第二道） */
  validate?: (values: Record<string, unknown>) => string[];
  /** 提交载荷构造器由共享契约给出 —— 与 curl/自动化脚本发出去的完全一致 */
  payloadOf?: (values: Record<string, unknown>) => Record<string, unknown>;
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
    // 服务方式一变，"厂家/第三方名称"是否必填就要跟着变（条件必填的唯一依据）
    const serviceMode = Form.useWatch('service_mode', form);

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
          // 第二道复核：Form.Item 的 rules 是给人看的即时反馈，
          // 真正保证"发出去的一定合法"的是共享契约里的同一个函数。
          const missing = opts.validate ? opts.validate(values) : [];
          if (missing.length > 0) {
            const labelOf = (name: string) =>
              opts.fields.find((f) => f.name === name)?.label ?? name;
            setError(`请填写：${missing.map(labelOf).join('、')}`);
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
          {opts.fields.map((f) => {
            const required = f.required || (f.name === 'provider_name' && requiresProviderName(serviceMode));
            return (
              <Form.Item
                key={f.name}
                name={f.name}
                label={f.label}
                rules={required ? [{ required: true, message: `请填写${f.label}` }] : []}
                extra={f.name === 'provider_name' ? '选择「厂家 / 第三方」时必填' : undefined}
              >
                {f.name === 'service_mode' ? (
                  <Select options={dispatchServiceModeOptions()} placeholder="请选择服务方式" />
                ) : f.name === 'expected_visit_at' ? (
                  <Input type="datetime-local" />
                ) : (
                  <Input />
                )}
              </Form.Item>
            );
          })}
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
 * @param ActionSceneEnum
 * @param request      请求函数（由插件注入，带鉴权，且必须支持第四参 headers）
 * @param register     把模型注册进引擎的回调
 */
export function buildTicketActionModels({
  ActionModel,
  ActionSceneEnum,
  request,
}: {
  ActionModel: any;
  ActionSceneEnum: any;
  request: Requester;
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
    // ⭐ 一次**逻辑操作**一个号：网络重试由 sendSvcRequest 复用同一个号。
    //    每次重试都换新号 = 主动把服务端的幂等防线拆掉 —— 服务端会当成两次新请求。
    const requestId = newRequestId();
    try {
      await sendSvcRequest(request, { action, ticketId: id, body: body ?? {}, requestId });
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
            const isDispatch = needsParams === 'dispatch';
            const fields = isDispatch
              ? [
                  ...DISPATCH_FIELDS,
                  // 改派必须写原因：Visit 的 superseded_reason 直接取它
                  ...(name === TICKET_ACTION.REASSIGN
                    ? [{ name: 'reason', label: FIELD_LABEL.reason, required: true }]
                    : []),
                ]
              : RESCHEDULE_FIELDS;
            const payloadOf = isDispatch ? buildDispatchPayload : buildReschedulePayload;

            openParamsModal({
              title: TICKET_ACTION_LABEL[name],
              fields,
              validate: isDispatch ? missingDispatchFields : missingRescheduleFields,
              payloadOf,
              extraText:
                name === TICKET_ACTION.REASSIGN
                  ? '改派会终止当前派工并新建一条；责任人完全相同时服务端会拒绝。'
                  : undefined,
              onSubmit: async (values) => {
                // ⚠️ 载荷由共享契约构造：空值的 provider_name 必须在到达后端之前消失，
                //    否则服务端会把空串当成"填了名字"，与"没填"混为一谈。
                await callSvc(ctx, name, payloadOf(values));
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
