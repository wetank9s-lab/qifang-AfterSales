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
 * ⚠️ **不是**"把七个按钮用 CSS 藏起来"：只注册一个模型、只挂一次，
 *    状态不可识别时 `render()` 直接返回 `null` —— DOM 里没有可被键盘或
 *    自动化点到的残留。
 *
 * ===========================================================================
 * 动态标签是怎么实现的（**已查过框架源码，不再是猜测**）
 * ===========================================================================
 * 2026-10-09 直接读容器内客户端产物
 * `/app/nocobase/node_modules/@nocobase/app/dist/client/assets/index-93181bbb.js`
 * 得到三条决定性事实：
 *
 *  ① **`FlowModelRenderer` 就是靠 `model.render()` 渲染的**，且明确拒绝没有它的模型：
 *       `"function" != typeof model.render) return console.warn(
 *          "FlowModelRenderer: Invalid model or render method not found.", model), null;`
 *     ⇒ 覆写 `render()` **不是** hack，它就是框架要求的渲染入口；
 *       不存在"框架另有渲染路径、导致覆写不生效"的情形。
 *
 *  ② **`ActionModel` 上有现成的动态标签钩子 `getTitle()`**：
 *       `renderButton() { … let o = props.children || this.getTitle();
 *                          return <Button {...props} onClick={this.onClick.bind(this)}>{o}</Button>; }`
 *       `render() { return props.tooltip ? <Tooltip…>{this.renderButton()}</Tooltip>
 *                                        : this.renderButton(); }`
 *     ⇒ 只要**不把 `children` 写进 defaultProps**，标签就走 `getTitle()`，
 *       覆写它即可得到随状态变化的标签，且按钮仍然是框架自己的 antd Button
 *       （与同列其它动作同款，带 tooltip / type / icon / 禁用态）。
 *
 *  ③ **`useProps` 不是 FlowModel 的钩子**。它在产物里出现 10 次，全部是
 *     字段组件 / UI Schema 侧的工具函数（`Rz = ({useProps = ()=>({}), ...rest}) => ({...rest, ...useProps()})`），
 *     FlowModel 这一侧**没有** `useProps`。
 *     ⇒ 曾经设想的"优先用 useProps 做动态渲染"在 2.2.15 上**不成立**；
 *       真正的稳定路径就是 ①+②。这一条同时解释了为什么之前那版自带的
 *       `defaultProps.children = '处理'` 是个隐患：一旦有人误以为"框架会自己
 *       渲染"而把 `render()` 去掉，页面就会退化成固定标签。
 *
 * ⇒ 因此本文件**不再保留固定标签 fallback**：`defaultProps` 里**不写** `children`，
 *    标签的唯一来源是 `getTitle()`。未知状态由 `render()` 返回 `null` 兜住，
 *    不会退化成一个写着「处理」却点了不处理的按钮。
 *
 * ===========================================================================
 * 当前行数据在哪
 * ===========================================================================
 * 不是 `this.record`，是 **`this.context.record`** —— 依据同样是框架源码里
 * `ActionModel.getInputArgs()`：
 *   `if (this.context.collection && this.context.record) {
 *      let filterByTk = this.context.collection.getFilterByTK(this.context.record); … }`
 * 刷新列表同理用 `this.context.blockModel?.refresh?.()`。
 */
import React from 'react';
import { Input, Modal, Select, DatePicker, message } from 'antd';

import { openTicketDrawer } from './ticket-drawer';
import {
  HANDLE_CHOICES,
  HANDLE_CHOICE,
  PRIMARY_ACTION,
  primaryActionOf,
  type HandleChoiceKey,
  type PrimaryActionKind,
} from './row-action-matrix';
import { newRequestId, sendSvcRequest } from '../shared/svc-request';
// ⚠️ 动作名**只从共享契约取**，不在这里写字面量 ——
//    手写字面量的代价本轮已经付过一次（见下方 write() 的复盘注释）。
import { SVC_ACTION } from '../shared/svc-action';

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
}

/** 从错误里取服务端的 code/message —— 409/422 是服务端的**合法裁决**，必须原样展示 */
function errorText(error: any): string {
  const payload = error?.response?.data ?? error?.data ?? {};
  const first = payload?.errors?.[0];
  const code = first?.code ?? payload?.code;
  const msg = first?.message ?? payload?.message ?? error?.message ?? '操作失败';
  return code ? `${msg}（${code}）` : msg;
}

/**
 * 当前行记录。
 *
 * ⚠️ 必须是 `context.record`（依据见文件头第 ③ 段源码引用）。
 *    上一版写的是 `this.record?.id` —— 那永远是 undefined，于是点击时
 *    只会弹「取不到当前行工单号」，而**按钮照样显示、行数照样对**，
 *    是典型的"结构对了但行为没接上"。
 */
function recordOf(model: any): any {
  return model?.context?.record ?? null;
}

/** 兜底取值：行记录可能是普通对象，也可能是带 `data`/`get()` 的封装 */
function pick(record: any, key: string): any {
  if (!record) return undefined;
  if (record[key] !== undefined) return record[key];
  if (record?.data?.[key] !== undefined) return record.data[key];
  if (typeof record?.get === 'function') {
    const v = record.get(key);
    if (v !== undefined) return v;
  }
  return undefined;
}

function recordIdOf(model: any): number | null {
  const id = pick(recordOf(model), 'id');
  const n = Number(id);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function statusOf(model: any): string {
  return String(pick(recordOf(model), 'status') ?? '');
}

/** 刷新当前表格：`context.blockModel` 是 flow-engine 的区块模型 */
function refreshBlock(model: any): void {
  const block = model?.context?.blockModel;
  block?.refresh?.();
}

export function buildPrimaryActionModel(deps: PrimaryActionDeps): Record<string, any> {
  const { ActionModel, ActionSceneEnum, request } = deps;

  /**
   * 统一的写请求。
   *
   * 🔴🔴 `sendSvcRequest` 的签名是 `(request, { action, ticketId, body, requestId })`
   *    —— **第二个参数是对象**，不是 `(url, body, headers)` 三个位置参数。
   *
   *    上一版按位置参数写成了 `sendSvcRequest(request, '/api/svc:dispatch?...', {...}, headers)`：
   *    esbuild 不做类型检查 ⇒ 构建全绿；TS 门禁只拦 TS2304/TS2552，
   *    TS2345「实参个数不符」落在"已知积压、不判红"那一类 ⇒ 也没拦住。
   *    真机上 `params.action` 为 undefined ⇒ 拼出 `svc:undefined?filterByTk=undefined`
   *    ⇒ **每个写操作都安静地打到一个不存在的端点**，工单状态纹丝不动。
   *    （2026-10-09 由真实浏览器验收捕获：五种选择都有、点保存有反应、库里没变化。）
   *
   *    ⇒ 同时纠正两件事：① 用共享 `buildSvcRequest` 拼 URL（不在这里手写 `/api/` 前缀 ——
   *      客户端 apiClient 的 baseURL 已经是 `/api/`，再写一遍会拼成 `/api//api/`）；
   *      ② 幂等号（X-Request-Id）由共享层统一注入，调用方只管业务参数。
   */
  async function write(action: string, ticketId: number, body: Record<string, unknown>): Promise<any> {
    return sendSvcRequest(request as any, { action, ticketId, body, requestId: newRequestId() });
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
      // ⚠️ 不要写 `/api/` 前缀：客户端 `apiClient` 的 baseURL 已经是 `/api/`，
      //    再写一遍会拼成 `/api//api/svc:...`（与 ticket-store-review.tsx 的既有写法一致）。
      request(`svc:${SVC_ACTION.TRANSFER_TARGETS}?filterByTk=${ticketId}`, 'get')
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
          await write(SVC_ACTION.DISPATCH, ticketId, {
            service_mode: 'inhouse',
            technician_name: values.technician_name,
            technician_mobile: values.technician_mobile,
            expected_visit_at: values.expected_visit_at,
          });
        } else if (choice === HANDLE_CHOICE.EXTERNAL) {
          // 厂家/第三方：**只需服务商名称**（不伪造师傅信息，契约 §7.2）
          await write(SVC_ACTION.DISPATCH, ticketId, {
            service_mode: values.service_mode || 'manufacturer',
            provider_name: values.provider_name,
          });
        } else if (choice === HANDLE_CHOICE.REMOTE) {
          await write(SVC_ACTION.REMOTE_COMPLETE, ticketId, {
            completion_result: values.completion_result || 'resolved',
            completion_note: values.completion_note,
            is_charged: values.is_charged === true,
            ...(values.is_charged === true ? { amount: Number(values.amount) } : {}),
          });
        } else if (choice === HANDLE_CHOICE.TRANSFER) {
          await write(SVC_ACTION.TRANSFER, ticketId, {
            target_store_code: values.target_store_code,
            reason: values.reason,
          });
        } else if (choice === HANDLE_CHOICE.CANCEL) {
          await write(SVC_ACTION.CANCEL, ticketId, { reason: values.reason });
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
          await write(SVC_ACTION.FOLLOW_UP, ticketId, {
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

  // -------------------------------------------------------------------------
  // 模型：用框架自己的 render 契约 + getTitle 钩子，不再有固定标签 fallback
  // -------------------------------------------------------------------------
  class TicketPrimaryActionModel extends ActionModel {
    static scene = ActionSceneEnum?.record ?? 'record';

    /**
     * ⚠️ **刻意不写 `children`**：写了它，`renderButton()` 里
     *    `props.children || this.getTitle()` 就会永远命中那个常量，
     *    标签再也动态不起来 —— 那正是被正式 UX 验收否掉的"固定标签 fallback"。
     *    `type` 保持与同列其它动作一致的链接样式。
     */
    defaultProps: any = { type: 'link', iconOnly: false };

    /** 当前行的主动作；状态不可识别时为 `null` ⇒ `render()` 返回 null（不渲染） */
    getPrimaryAction(): { kind: PrimaryActionKind; label: string } | null {
      return primaryActionOf(statusOf(this));
    }

    /** 框架自己的标签钩子（`renderButton()` 里 `props.children || this.getTitle()`） */
    getTitle(): string {
      return this.getPrimaryAction()?.label ?? '';
    }

    /**
     * 点击路由：按**当前行**的状态分流。
     *
     * ⚠️ 覆写 `onClick` 而不是挂 click 流 —— 基类只做
     *    `this.dispatchEvent('click', …)`，本模型没有配置任何 flow，
     *    挂流等于"点了什么都不发生"（有按钮、无行为，最难发现的一类缺陷）。
     */
    onClick(): void {
      const action = this.getPrimaryAction();
      if (!action) return;
      const ticketId = recordIdOf(this);
      if (ticketId === null) {
        message.error('取不到当前行工单号，请刷新后重试');
        return;
      }
      const refresh = () => refreshBlock(this);
      if (action.kind === PRIMARY_ACTION.HANDLE) openHandleWindow(ticketId, refresh);
      else if (action.kind === PRIMARY_ACTION.FOLLOW) openFollowWindow(ticketId, refresh);
      // ⚠️ `openTicketDrawer(options)` 的入参是**单个 options 对象**
      //    （`TicketDrawerOptions = { ticketId, request }`，见 ticket-drawer.tsx）。
      //    上一版按位置参数写成 `openTicketDrawer(request, ticketId, {...})`：
      //    esbuild **不做类型检查** ⇒ 构建全绿；TS 门禁只拦 TS2304/TS2552，
      //    这条（TS2554 实参个数不符）落在"已知积压、不判红"那一类里 ⇒ 也没拦住。
      //    真机上表现为抽屉标题 `工单 #undefined` + `request is not a function`
      //    —— **只有真实浏览器点击才暴露得出来**（本轮 2026-10-09 实测捕获）。
      //    「查看 / 审核结果」只是打开详情，不改数据 ⇒ 不需要 refresh。
      else openTicketDrawer({ ticketId, request: request as any });
    }

    /**
     * 复用框架自己的按钮（antd Button + tooltip + type/icon/禁用态），
     * 只在外面补三个**验收用的** data 属性 —— 让浏览器门禁能确认
     * "这个按钮对应哪一行、按哪个状态渲染"，而不是靠数按钮个数。
     */
    renderButton(): any {
      const node = super.renderButton();
      const action = this.getPrimaryAction();
      if (!node || !action) return node;
      return React.cloneElement(node, {
        // ⚠️ `title` 必须**一起改成动态标签**：种子落库的 `props.title` 是「处理」，
        //    而 WAIT_FEEDBACK 那几态的按钮文案是「查看」——
        //    不改就会出现"按钮写着『查看』、鼠标悬停提示『处理』"的自相矛盾。
        //    （这一类"一半动态一半静态"的残留，读代码时极难发现，只有真机 hover 才看得见。）
        title: action.label,
        'data-primary-action': action.kind,
        'data-ticket-id': recordIdOf(this) ?? '',
        'data-action-label': action.label,
      });
    }

    /** 未知状态 ⇒ **不渲染**（不是渲染一个点了没反应的按钮） */
    render(): any {
      if (!this.getPrimaryAction()) return null;
      return super.render();
    }
  }

  return { TicketPrimaryActionModel };
}
