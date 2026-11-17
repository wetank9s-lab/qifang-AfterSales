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
import { Button, Input, Modal, Select, DatePicker, message } from 'antd';

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
// 服务端错误 → 门店员工文案：**唯一实现**（与审核抽屉共用，不再各写一份）
import { userErrorOf } from '../shared/user-error';
// P11-1 / 裁决 C：业务弹窗的**统一开法**（有 ×、未保存确认、提交中防重复）
import { openClosableModal } from './modal-kit';
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

/**
 * 服务端错误 → 门店员工看到的文案。
 *
 * ⚠️ 这里**原本只有一行拼码逻辑**（`${msg}（${code}）`）：撞上冲突时员工看到的是
 *    「工单当前不是「待门店确认」，无法确认（TICKET_NOT_REVIEWABLE）」——
 *    原始码成了主要文案（DEV-109，P11-0 真机验收抓出）。
 *
 *    现在与审核抽屉共用共享实现 `userErrorOf()`：
 *      · 409（状态已被他人改变）⇒ 中文冲突话术 + **刷新界面**
 *        （不刷新的话，员工会对着过期画面再点一次，又撞一次 409）；
 *      · 其余 ⇒ 服务端给的中文原样回显（那是有意义的业务裁决）。
 */
function errorOutcome(error: any): { text: string; refresh: boolean } {
  return userErrorOf(error);
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
  // UX-01A：从「处理 / 跟进」窗口打开只读详情
  // -------------------------------------------------------------------------

  /**
   * 在「处理」「跟进」窗口的顶部放一个「查看工单详情」。
   *
   * 解决什么（G2 / A2）：NEW 与 PROCESSING 两态的行主按钮直接进"处理 / 跟进"窗口，
   * 员工想**先看一眼再决定怎么处理**时，过去没有任何查看入口。
   *
   * 🔴 为什么是**窗口内**的链接、而不是列表行上第二个按钮：
   *    `verify-store-ui-primary-action.mjs` 判据① 冻结了「每行操作列**总共**只有一个按钮」。
   *    再挂一个行按钮会破坏那条门禁。放进窗口内容里，行操作列仍然只有一个主按钮。
   *    详情抽屉自身**只读**（见 ticket-drawer.tsx），不改任何状态 ——
   *    所以这是"查看"，不是"第二个改状态的入口"。
   */
  function viewDetailLink(ticketId: number): any {
    return React.createElement(
      Button,
      {
        type: 'link',
        size: 'small',
        style: { padding: 0, marginBottom: 8 },
        'data-testid': 'open-detail-from-window',
        onClick: () => openTicketDrawer({ ticketId, request: request as any }),
      },
      '查看工单详情（只读）',
    );
  }

  // -------------------------------------------------------------------------
  // 四种处理方式的表单（**按方式动态展示必要字段**，不让员工填无关信息）
  // -------------------------------------------------------------------------

  /**
   * 当前「处理」弹窗里**有没有未保存的内容**（裁决 C3：关闭前要确认）。
   *
   * ⚠️ 为什么用一个模块级标志，而不是把状态提到调用方：
   *    "有没有填过"这件事只有表单自己知道（它的 state 在 HandleChooser /
   *    HandleForm 里面）。把它提上去要么把两个组件改成受控、要么层层传回调 ——
   *    都为了一个布尔值。用一个标志 + 卸载时复位，代价最小且**不会泄漏到下一个弹窗**
   *    （每次 `openHandleWindow` 都会先复位一次）。
   */
  let handleUnsaved = false;
  const handleDirty = (): boolean => handleUnsaved;

  function openHandleWindow(ticketId: number, onDone: () => void) {
    handleUnsaved = false; // 每次开窗先复位（否则上一次的残留会让新窗一开就"未保存"）
    // 🔴 走统一弹窗（裁决 C）：右上角有 ×、未保存时关闭要确认、提交中防重复。
    //    原来这里是 `Modal.info({ footer: null })` —— 那种形态**没有 ×**，
    //    用户面对一整张表单时没有任何"放弃"的入口。
    //    `hideFooter: true`：底部按钮由表单自己渲染（它要按方式动态变化，
    //    而且有「返回」这一步）—— kit 只负责 ×、未保存确认与取消语义。
    const kit = openClosableModal({
      title: '处理这张服务单',
      testid: 'handle-modal',
      hideFooter: true,
      cancelText: '取消',
      // 「未保存」的判据：选了方式、或任何字段被填过
      hasUnsavedChanges: () => handleDirty(),
      unsavedHint: '还没有保存这次处理。关闭后已选的方式与填写的内容都会丢失。',
      // UX-01A：顶部先给一个只读详情入口（先查看后处理），下方才是处理方式选择
      content: React.createElement(
        'div',
        null,
        viewDetailLink(ticketId),
        React.createElement(HandleChooser, {
          ticketId,
          onDone,
          close: () => kit.close(),
        }),
      ),
    });
  }

  function HandleChooser({ ticketId, onDone, close }: any) {
    const [choice, setChoice] = React.useState<HandleChoiceKey | null>(null);

    // 选了方式 ⇒ 已经有"未保存的选择"（关闭时应当确认）
    React.useEffect(() => {
      handleUnsaved = choice !== null;
    }, [choice]);

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
    // ⚠️ 目标门店下拉已随转店能力一起移除（`svc:transferTargets` 服务端 403）。
    //    这里**不留**"拿不到就回退到 storeOptions"的兜底 —— 那等于把撤销的能力
    //    从后门接回来（而 storeOptions 的语义本来就是"我管理哪些门店"，不是"能转去哪"）。

    const set = (k: string, v: any) => {
      // 只要有字段被写过，关闭这个窗口就需要确认（裁决 C3）
      handleUnsaved = true;
      setValues((p) => ({ ...p, [k]: v }));
    };

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
          // 🔴 P6-MANUFACTURER-DISPATCH-01：**厂家售后已不是 provider-only**。
          //    门店点"确认派工"= 确认"厂家已指定具体上门师傅"，
          //    因此姓名/手机号/预约时间与自有师傅同口径必填（服务端也会再校验一次）。
          //    只知道"已报给厂家、还没定师傅"⇒ 用「记录跟进」，不要在这里编数据。
          //    第三方（third_party）保持原 provider-only 语义。
          const mode = values.service_mode || 'manufacturer';
          const isManufacturer = mode === 'manufacturer';
          if (isManufacturer) {
            if (!String(values.provider_name ?? '').trim()) {
              message.error('请填写厂家/服务商名称');
              setBusy(false);
              return;
            }
            if (!String(values.technician_name ?? '').trim()) {
              message.error('请填写厂家安排的服务师傅姓名');
              setBusy(false);
              return;
            }
            if (!String(values.technician_mobile ?? '').trim()) {
              message.error('请填写师傅本人的手机号');
              setBusy(false);
              return;
            }
            if (!values.expected_visit_at) {
              message.error('请选择预计上门时间');
              setBusy(false);
              return;
            }
          }
          await write(SVC_ACTION.DISPATCH, ticketId, {
            service_mode: mode,
            provider_name: values.provider_name,
            ...(isManufacturer
              ? {
                  technician_name: values.technician_name,
                  technician_mobile: values.technician_mobile,
                  expected_visit_at: values.expected_visit_at,
                }
              : {}),
          });
        } else if (choice === HANDLE_CHOICE.REMOTE) {
          await write(SVC_ACTION.REMOTE_COMPLETE, ticketId, {
            completion_result: values.completion_result || 'resolved',
            completion_note: values.completion_note,
            is_charged: values.is_charged === true,
            ...(values.is_charged === true ? { amount: Number(values.amount) } : {}),
          });
        } else if (choice === HANDLE_CHOICE.CANCEL) {
          await write(SVC_ACTION.CANCEL, ticketId, { reason: values.reason });
        }
        message.success('已保存');
        handleUnsaved = false; // 已保存 ⇒ 不再是未保存内容
        close();
        onDone();
      } catch (error: any) {
        const { text, refresh } = errorOutcome(error);
        message.error(text);
        if (refresh) {
          // 冲突 ⇒ 这张单的状态已经不是画面上这个了 ⇒ 关掉过期窗口、重拉列表。
          // 不关的话，员工会照着旧状态再试一次，于是再撞一次 409。
          close();
          onDone();
        }
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
        field('厂家/服务商名称（如「海尔售后」）', React.createElement(Input, { 'data-field': 'provider_name', onChange: (e: any) => set('provider_name', e.target.value) }), true),
        // 🔴 厂家售后：必须填到"具体师傅"，否则没有 Token、也发不出师傅短信
        ...((values.service_mode || 'manufacturer') === 'manufacturer'
          ? [
              field('服务师傅姓名', React.createElement(Input, { 'data-field': 'technician_name', onChange: (e: any) => set('technician_name', e.target.value) }), true),
              field('服务师傅手机号', React.createElement(Input, { 'data-field': 'technician_mobile', onChange: (e: any) => set('technician_mobile', e.target.value) }), true),
              field('预计上门时间', React.createElement(DatePicker, { 'data-field': 'expected_visit_at', showTime: true, style: { width: '100%' }, onChange: (_: any, str: string) => set('expected_visit_at', str) }), true),
              React.createElement('div', { style: { color: '#888', fontSize: 12 } },
                '厂家尚未指定上门师傅时，请先用「记录跟进」记录进展；拿到师傅姓名和手机号后再确认派工。'),
            ]
          : [React.createElement('div', { style: { color: '#888', fontSize: 12 } }, '第三方送修只需服务商名称')]),
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
        field('维修措施', React.createElement(Input.TextArea, { 'data-field': 'completion_note', rows: 2, onChange: (e: any) => set('completion_note', e.target.value) })),
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
  function openFollowWindow(ticketId: number, onDone: () => void, model?: any) {
    const values: Record<string, any> = {};
    let busy = false;
    /**
     * **打开窗口那一刻**已有安排的日期（Phase 11 / P11-1）。
     *
     * 🔴 为什么要记它：接口区分"未传 = 保持不变"与"传 null = 明确清空"，
     *    而窗口必须能表达**两种"空"**：
     *      · 本来就空、现在也空 ⇒ 用户没打算安排 ⇒ **不传**（保持不变）
     *      · 本来有、现在被清空 ⇒ 用户**明确取消了安排** ⇒ 传 `null`
     *    只看"当前是否为空"分不出这两件事 —— 于是"取消计划"这个动作
     *    在界面上**根本做不到**（点了清空、保存后又原样回来）。
     */
    // 初始值从**当前行**取（`context.record` —— 依据见本文件文件头第 ③ 段的源码引用）
    const initialNextFollow = String(pick(recordOf(model), 'next_follow_at') ?? '').trim();

    /** 提交（由统一弹窗的 onOk 调用；它负责 busy 与"失败保持打开"） */
    async function submit(): Promise<void> {
      if (busy) return; // 防重复提交（按钮本身也已 loading+disabled）
      if (!values.note) {
        message.error('必须填写跟进情况');
        throw new Error('missing note');
      }
      busy = true;
      try {
        // 🔴 三态（与接口契约一一对应，见 services/ticket-service.ts 的
        //    `resolveNextFollowIntent`）：
        //      · 填了日期           ⇒ 传日期（设定 / 更新）
        //      · 原本有、现在被清空 ⇒ 传 **null**（明确取消计划）
        //      · 本来就空、现在也空 ⇒ **不传**（保持不变，绝不是清空）
        //    只发"当前是否为空"的话，"取消计划"这个动作在界面上根本做不到。
        const nextFollowNow = String(values.next_follow_at ?? '').trim();
        const nextFollowBody = nextFollowNow
          ? { next_follow_at: nextFollowNow }
          : initialNextFollow
            ? { next_follow_at: null }
            : {};
        await write(SVC_ACTION.FOLLOW_UP, ticketId, {
          note: values.note,
          ...nextFollowBody,
        });
        message.success('已记录跟进');
        kit.close();
        onDone();
      } catch (error: any) {
        const { text, refresh } = errorOutcome(error);
        message.error(text);
        if (refresh) {
          // 冲突 ⇒ 状态已被他人改变。关掉过期窗口并重拉列表。
          kit.close();
          onDone();
          return; // 不再抛出：窗口已关，让 antd 正常收尾
        }
        throw error; // 其余（422 等）：保持打开，让员工改正后重试
      } finally {
        busy = false;
      }
    }

    // 走统一弹窗（裁决 C）：右上角有 ×、未保存时关闭要确认、提交中防重复。
    const kit = openClosableModal({
      title: '记录跟进',
      testid: 'follow-form',
      okText: '保存',
      cancelText: '取消',
      hasUnsavedChanges: () => Boolean(values.note) || Boolean(values.next_follow_at),
      unsavedHint: '跟进情况还没保存。关闭后填写的内容会丢失。',
      onOk: () => submit(),
      content: React.createElement(
        'div',
        null,
        // UX-01A：顶部先给一个只读详情入口（先查看后跟进）
        viewDetailLink(ticketId),
        React.createElement(Input.TextArea, {
          'data-field': 'note',
          rows: 3,
          placeholder: '跟进情况（必填）：例如「已联系客户，约明天上午上门」',
          onChange: (e: any) => (values.note = e.target.value),
        }),
        React.createElement('div', { style: { height: 8 } }),
        // ⚠️ 文案必须说清这个日期**去了哪里**，不能让人以为它会变成「推送提醒」。
        //    P11-1 起它写进工单的**可查询列** `next_follow_at`，可以在
        //    「今日待跟进 / 已逾期」队列里被查到；但**没有**后台推送、也没有超时告警
        //    —— 完整的超时与异常工作台在 P11-6。
        //    ⇒ 说「可查到」，不说「会提醒你」。
        React.createElement(DatePicker, {
          'data-field': 'next_follow_at',
          placeholder: '下次跟进日期（选填；填写后可在待跟进队列中查到）',
          onChange: (_: any, v: string) => (values.next_follow_at = v),
        }),
      ),
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
      // 把 model 传进去：窗口要用**当前行**的 `next_follow_at` 区分"没安排"与"取消了安排"
      else if (action.kind === PRIMARY_ACTION.FOLLOW) openFollowWindow(ticketId, refresh, this);
      // 待门店确认 ⇒ 用户点「审核回执」的意图是"去审核这份回执"，
      // 所以带上 focus，抽屉打开后直接滚到回执区（而不是停在顶部让人自己翻）。
      else if (action.kind === PRIMARY_ACTION.REVIEW) openTicketDrawer({ ticketId, request: request as any, focus: 'store-review' });
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

    /**
     * UX-01A §四：非「查看」态额外给一个**只读**的「查看」文本链接。
     *
     * 🔴 为什么用 `<a>` 而不是 `Button`：冻结门禁判据① 要求「每行操作列**总共只有一个按钮**」，
     *    而该判据统计的是 `button, a[role="button"]`。用 `<a role="link" tabIndex=0>`：
     *      · 不算 button ⇒ 判据① 不受影响；
     *      · `tabIndex=0` + 回车/空格触发 ⇒ **真正键盘可达**（不是不可聚焦的空 `<a>`）；
     *      · 只读：只调既有 `openTicketDrawer`，不写任何数据。
     * ⚠️ 主按钮本身已是「查看」的状态（WAIT_FEEDBACK/CLOSED/CANCELLED）**不再重复**加链接。
     */
    /**
     * R2.1：把原来的只读「查看」**蓝色链接**降级为低调的「更多」入口。
     *
     * 为什么改（用户 2026-11-17 的 R2.1 裁决）：
     *   原实现是"主按钮 + 一个蓝色「查看」链接"，两个蓝块并排在行首
     *   ⇒ 视觉上分不出"这行该做什么"。用户要求：
     *   **每行一个醒目主操作 + 一个「更多」入口**。
     *
     * ⚠️ 为什么**不用** antd `Dropdown`（这是本轮的一个取舍，说明白）：
     *   本仓库的类型门禁要求"从 antd 导入的成员必须**核实过确实存在**"
     *   （DEV-147：`message` 从错误的包取，构建/tsc 全绿，运行期 undefined，
     *   表现为"详情抽屉点不开"）。而运行镜像里**没有 antd 包**（前端是预构建
     *   bundle），我无法用 `.d.ts` 核实 `Dropdown` 的导出面 ⇒ 按纪律**不登记**。
     *   ⇒ 改用已核实过的能力：点「更多」直接进**现有详情抽屉**，
     *     那里本来就有完整的操作区（确认 / 驳回 / 跟进等）。
     *     这比摆一个点了展开空菜单的假入口更可靠。
     */
    rowMoreMenu(): any {
      const ticketId = recordIdOf(this);
      if (ticketId === null) return null;
      const status = String(statusOf(this) ?? '');
      const refresh = () => refreshBlock(this);
      const openDetail = () => openTicketDrawer({ ticketId, request: request as any });

      /**
       * R2.1：点「更多」弹出**真正的操作选择面板**（不是直接跳详情）。
       *
       * 为什么用 `openClosableModal` 而不是 Dropdown：
       *   本仓库没有任何已验证可用的下拉/弹出组件（Dropdown / Popover 从未在本插件
       *   成功使用过，且运行镜像里没有 antd 包可供核实导出面）。按 DEV-147 的纪律，
       *   不核实就不导入 —— 否则会得到一个"构建全绿、点了 undefined"的假入口。
       *   `openClosableModal` 是本项目自己在 config-edit / 导入向导里跑通多次的组件，
       *   所见即所得。
       *
       * 分组按用户点名的四类收敛，**只放当前状态真实可用的**：
       *   服务安排 / 工单处理 / 查看资料 / 特殊处理 —— 后两组当前无独立动作，
       *   不摆空分组（摆一个点了没反应的按钮比没有更糟）。
       */
      const openPanel = () => {
        let kit: any = null;
        const item = (labelText: string, onClick: () => void, primary = false) =>
          React.createElement(
            Button,
            {
              block: true,
              type: primary ? 'primary' : 'default',
              style: { borderRadius: 8, justifyContent: 'flex-start' },
              onClick: () => {
                if (kit) kit.close();
                onClick();
              },
            },
            labelText,
          );
        const groupTitle = (t2: string) =>
          React.createElement('div', { style: { fontSize: 12, color: '#8c8c8c', marginTop: 10 } }, t2);

        kit = openClosableModal({
          title: '工单操作',
          hideFooter: true,
          testid: 'row-more-panel',
          content: React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            groupTitle('查看资料'),
            item('查看完整详情', openDetail),
            status === 'WAIT_STORE_CONFIRM'
              ? item('查看师傅回执', () => openTicketDrawer({ ticketId, request: request as any, focus: 'store-review' }))
              : null,
            status === 'PROCESSING' || status === 'WAIT_STORE_CONFIRM'
              ? groupTitle('工单处理')
              : null,
            status === 'PROCESSING' ? item('添加跟进', () => openFollowWindow(ticketId, refresh, this)) : null,
            status === 'NEW' ? groupTitle('服务安排') : null,
            status === 'NEW' ? item('处理工单', () => openHandleWindow(ticketId, refresh), true) : null,
          ),
        });
      };

      return React.createElement(
        'a',
        {
          'data-testid': 'row-more-action',
          'data-ticket-id': ticketId,
          role: 'link',
          tabIndex: 0,
          style: { marginLeft: 12, color: '#5a6a80', cursor: 'pointer', fontSize: 12 },
          onClick: openPanel,
          onKeyDown: (e: any) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openPanel();
            }
          },
        },
        '更多',
      );
    }

    /** 未知状态 ⇒ **不渲染**；「查看」态只给主按钮；其余态 = 主业务按钮 + 「更多」下拉 */
    render(): any {
      const action = this.getPrimaryAction();
      if (!action) return null;
      const node = super.render();
      if (action.kind === PRIMARY_ACTION.VIEW) return node;
      const more = this.rowMoreMenu();
      if (!more) return node;
      return React.createElement(React.Fragment, null, node, more);
    }
  }

  return { TicketPrimaryActionModel };
}
