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
  REASSIGN_FORM_FIELDS,
  RESCHEDULE_FORM_FIELDS,
  buildDispatchPayload,
  buildReassignPayload,
  buildReschedulePayload,
  dispatchServiceModeOptions,
  missingDispatchFields,
  missingReassignFields,
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
  options?: { headers?: Record<string, string>; responseType?: string },
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
  // ⚠️ 叫「日期」不叫「时间」—— 本项目**不采集**技师签到 / 实际到达 / GPS /
  //    精细排班时段，因此没有能力承诺"几点几分到"。让门店填一个精确到分钟的时间
  //    等于逼他编一个假精度。UI 只收日期，时分由存储层统一规范化（见 DATE_INPUT）。
  expected_visit_at: '预计上门日期',
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

/**
 * 改派 = 派工全部字段 + **改派原因**（必填）。
 *
 * ⚠️ 这个列表与 `buildReassignPayload` 的字段清单**必须同源**。
 *    原实现只在这里加了 reason 字段，却没让它进载荷白名单，
 *    结果"填了原因 → 服务端说没填"（见 service-mode.ts 的 REASSIGN_FORM_FIELDS 注释）。
 *    现在两侧都从 `REASSIGN_FORM_FIELDS` 派生，**不可能再各自漂移**。
 */
const REASSIGN_FIELDS: ModalField[] = REASSIGN_FORM_FIELDS.map((name) => ({
  name,
  label: name === 'reason' ? '改派原因' : FIELD_LABEL[name] ?? name,
  // provider_name 是**条件必填**（只在厂家/第三方时必填），交给下面的
  // `requiresProviderName(serviceMode)` 动态判定，这里不能一律记 true ——
  // 否则"门店自修改派"会被 UI 逼着填一个不存在的厂家名。
  required: name !== 'provider_name',
}));

/** 改约只需要这两个字段（改约不换人，所以没有 service_mode / provider_name） */
const RESCHEDULE_FIELDS: ModalField[] = RESCHEDULE_FORM_FIELDS.map((name) => ({
  name,
  label: name === 'reason' ? '改约原因' : '新的预计上门日期',
  required: true,
}));

/**
 * 打开一个收集参数的模态框。
 *
 * 时间字段用原生 `Input type="date"`（只到天），理由见字段渲染处的注释与
 * `shared/service-mode.ts` 的 `APPOINTMENT_CANONICAL_TIME`：
 * 本项目不采集到分钟级别的到达能力，就不该让界面产生"精确到分钟"的错觉。
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
                  // ⚠️ **date 而不是 datetime-local**：本项目不采集签到/实际到达/GPS/
                  //    排班时段，没有能力承诺到分钟。让门店选到"天"就够，
                  //    时分由共享契约统一规范化（见 APPOINTMENT_CANONICAL_TIME），
                  //    且**任何地方都不会把它显示出来**。
                  <Input type="date" />
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

  function makeAction(
    name: TicketActionName,
    needsParams: 'none' | 'dispatch' | 'reassign' | 'reschedule',
  ) {
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
            // ⚠️ **三个动作各自一份配置**，不再用 `isDispatch` 把派工与改派揉在一起。
            //
            //   原因见 service-mode.ts 的 REASSIGN_FORM_FIELDS：改派的服务端契约
            //   本来就比派工多一个必填 reason。共用同一个 payload 构造器时，
            //   "表单多挂一个字段"不会自动变成"载荷多一个字段" ——
            //   于是用户填的原因在出口处被静默丢弃，服务端回 MISSING_REASON。
            //   所以**字段列表 / 必填判定 / 载荷构造器三者必须成组绑定**，
            //   让"加了字段却忘了进载荷"在结构上不可能发生。
            interface ParamConfig {
              fields: ModalField[];
              validate: (values: Record<string, unknown>) => string[];
              payloadOf: (values: Record<string, unknown>) => Record<string, unknown>;
              extraText?: string;
            }
            const PARAM_CONFIG: Record<'dispatch' | 'reassign' | 'reschedule', ParamConfig> = {
              dispatch: {
                fields: DISPATCH_FIELDS,
                validate: missingDispatchFields,
                payloadOf: buildDispatchPayload,
              },
              reassign: {
                fields: REASSIGN_FIELDS,
                validate: missingReassignFields,
                payloadOf: buildReassignPayload,
                extraText:
                  '改派会终止当前派工并新建一条；责任人完全相同时服务端会拒绝。',
              },
              reschedule: {
                fields: RESCHEDULE_FIELDS,
                validate: missingRescheduleFields,
                payloadOf: buildReschedulePayload,
              },
            };

            openParamsModal({
              title: TICKET_ACTION_LABEL[name],
              fields: PARAM_CONFIG[needsParams].fields,
              validate: PARAM_CONFIG[needsParams].validate,
              payloadOf: PARAM_CONFIG[needsParams].payloadOf,
              extraText: PARAM_CONFIG[needsParams].extraText,
              onSubmit: async (values) => {
                // ⚠️ 载荷由共享契约构造：空值的 provider_name 必须在到达后端之前消失，
                //    否则服务端会把空串当成"填了名字"，与"没填"混为一谈。
                //    同理 reason 必须在**这里**就已经在载荷里 —— 不能指望服务端补。
                await callSvc(ctx, name, PARAM_CONFIG[needsParams].payloadOf(values));
              },
            });
          },
        },
      },
    });

    return TicketActionModel;
  }

  /**
   * H3 入口：打开只读详情抽屉。
   *
   * ⚠️ P6-0 起，抽屉里会**按需**多渲染一个「技师回执」只读区块
   *    （`docs/PHASE-6.md` §6.3）—— 这就是"门店能看到技师回执与照片"的落点。
   *    它**不是**第 6 个按钮：那需要往 `flowModels` 播种动作实例、且会对
   *    所有角色/所有状态都多一个按钮（而审核对象只存在于一种状态）。
   *    因此这里**原样传完整的 `request`**：抽屉里的照片走
   *    `authenticated fetch → Blob`（§4.3a），需要 `responseType` 透传能力。
   */
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
          openTicketDrawer({ ticketId: id, request });
        },
      },
    },
  });

  return {
    TicketAcceptActionModel: makeAction(TICKET_ACTION.ACCEPT, 'none'),
    TicketDispatchActionModel: makeAction(TICKET_ACTION.DISPATCH, 'dispatch'),
    TicketReassignActionModel: makeAction(TICKET_ACTION.REASSIGN, 'reassign'),
    TicketRescheduleActionModel: makeAction(TICKET_ACTION.RESCHEDULE, 'reschedule'),
    TicketDetailActionModel,
  };
}
