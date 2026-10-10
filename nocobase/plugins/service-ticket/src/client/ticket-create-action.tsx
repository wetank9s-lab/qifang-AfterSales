/**
 * 门店**人工新建服务单**（Phase 11 / P11-2 · 用户裁决二）
 * =============================================================================
 *
 * 用户在真实门店后台要一个**明显的「新建服务单」入口**：挂在**工单列表区块的工具栏**上
 * （`TableBlock` 的 `actions`），**不是**行级主动作、也**不恢复按钮墙**。
 *
 * ===========================================================================
 * 挂载点为什么是"区块工具栏"（而不是行操作列）
 * ===========================================================================
 *   · 「新建」是**区块级**行为 —— 它不针对任何一行。挂到行操作列下会**每行渲染一次**
 *     （20 行 = 20 个「新建服务单」），既荒谬又会被 `verify-store-ui-primary-action`
 *     的"行内只有一个主动作"判据当成旧按钮墙复活。
 *   · 同构参照：`TicketTabFilterModel` 同样挂 `parentId=blockUid, subKey='actions'`
 *     （见 `scripts/ticket-page-actions.mjs` 的 `tabFilterRow()`），
 *     用的就是这一条挂载路径。
 *
 * ===========================================================================
 * 六类与"按类型显示必要字段"（用户第 2/3 条）
 * ===========================================================================
 * 表单**不是**一张大而全的表：每一类只问它真正需要的东西 ——
 *   · 投诉：不问家电类别 / 品牌型号 / 服务地址（用户原话"不要求投诉填写故障资料"）；
 *   · 其他：问服务地址，不问家电类别 / 品牌型号；
 *   · 维修 / 安装 / 调试保养 / 移机拆机：问家电类别 + 品牌型号 + 服务地址。
 * 连"问题内容"这一栏的**标题也是按类型变的**（故障情况 / 安装需求 / 投诉内容…），
 * 否则安装单上写着"故障情况"本身就荒谬。
 *
 * ===========================================================================
 * 三条交互纪律（用户第 7 条）
 * ===========================================================================
 *   · **取消 / 关闭**：用 `openClosableModal`（有 ×、ESC 可关、点遮罩不关 —— 见 modal-kit）；
 *   · **未保存提示**：表单里只要填过东西，关闭前会二次确认（`hasUnsavedChanges`）；
 *   · **提交中防重复**：`setBusy(true)` 会让 OK 变 loading，`onOk` 里还有一道 busy 闸。
 *
 * ⚠️ 与匿名 H5 的边界：本入口调的是 **`svc:createTicket`**（内部接口，六类 + 可设紧急）；
 *    客户 H5 走 `/api/public/tickets`（两类 + 无紧急字段）。**两者都不放宽对方**。
 */
import { Modal, Select, Input, Checkbox, Alert } from 'antd';
import { message } from '@nocobase/client';
import React from 'react';

import { openClosableModal } from './modal-kit';

/** 请求函数签名（由 `index.ts` 注入；返回**响应信封**，取值要 `.data`） */
type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

/**
 * 六类 + 每类"该问什么"。
 *
 * ⚠️ 这张表是**唯一**的类型→字段映射：服务端只做"字段是否合法"的校验，
 *    不做"哪一类该显示什么"的判断（那是界面职责）。
 *    两处各写一份的下场是"页面上没问、后端要求必填"这种死循环。
 */
const TYPE_CONFIG = [
  {
    value: 'repair',
    label: '维修',
    contentLabel: '故障情况',
    contentPlaceholder: '例如：空调不制冷，出风有异味',
    showAppliance: true,
    showAddress: true,
  },
  {
    value: 'installation',
    label: '安装',
    contentLabel: '安装需求',
    contentPlaceholder: '例如：新装 1.5 匹挂机，客户要求周末上门',
    showAppliance: true,
    showAddress: true,
  },
  {
    value: 'maintenance',
    label: '调试保养',
    contentLabel: '调试 / 保养需求',
    contentPlaceholder: '例如：清洗内机 + 检查制冷剂',
    showAppliance: true,
    showAddress: true,
  },
  {
    value: 'relocation',
    label: '移机拆机',
    contentLabel: '移机 / 拆机需求',
    contentPlaceholder: '例如：从 3 楼搬到 5 楼，需拆装空调',
    showAppliance: true,
    showAddress: true,
  },
  {
    value: 'complaint',
    label: '投诉',
    // ⚠️ 投诉**不问**家电类别 / 品牌型号 / 服务地址（用户明令）
    contentLabel: '投诉内容',
    contentPlaceholder: '例如：上周报修的师傅未按约定时间上门',
    showAppliance: false,
    showAddress: false,
  },
  {
    value: 'other',
    label: '其他',
    contentLabel: '事项说明',
    contentPlaceholder: '例如：需要开具收费明细',
    showAppliance: false,
    showAddress: true,
  },
];

/** 与后端同源的字段上限（`actions/_new-ticket-fields.ts`；超了会被 422 拒） */
const SERVICE_ADDRESS_MAX = 200;
const BRAND_MODEL_MAX = 64;
const NAME_MAX = 32;
const CONTENT_MIN = 5;
const CONTENT_MAX = 500;
const MOBILE_PATTERN = /^1[3-9]\d{9}$/;

/** 家电类别（与 `shared/appliance-category.ts` 逐项一致；界面只负责展示标签） */
const APPLIANCE_OPTIONS = [
  { value: 'air_conditioner', label: '空调' },
  { value: 'refrigerator', label: '冰箱' },
  { value: 'washer', label: '洗衣机' },
  { value: 'tv', label: '电视' },
  { value: 'kitchen_bath', label: '厨卫电器' },
  { value: 'small_appliance', label: '小家电' },
  { value: 'other', label: '其他' },
];

/** 生成请求号（幂等键）。格式与后端 `readRequestId` 的 UUID v4 校验一致。 */
function newRequestId(): string {
  const g: any = globalThis as any;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // 兜底：极老浏览器。**必须**是合规 v4，否则后端回 422。
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildTicketCreateActionModel(deps: {
  ActionModel: any;
  ActionSceneEnum?: any;
  request: Requester;
}): Record<string, any> {
  const { ActionModel, ActionSceneEnum, request } = deps;
  if (!ActionModel) return {};

  const Field = (props: { label: string; required?: boolean; children: React.ReactNode }) =>
    React.createElement(
      'div',
      { style: { marginBottom: 12 } },
      React.createElement(
        'div',
        { style: { marginBottom: 4, fontWeight: 500 } },
        props.label,
        props.required ? React.createElement('span', { style: { color: '#d4380d' } }, ' *') : null,
      ),
      props.children,
    );

  /** 表单组件。用函数组件 + hooks —— 与 `ticket-drawer.tsx` 同一套写法。 */
  /**
   * 表单与模型之间的**共享句柄**。
   *
   * ⚠️ 为什么不给函数组件挂 `ref`：函数组件不接受 `ref`（除非 forwardRef），
   *    而 `ref` 回调里拿到的会是 `null` —— 表现是"点确定什么都不发生"，
   *    与 `store-entry-action.tsx` 记下的"有按钮、无行为"同型。
   *    ⇒ 用**一个普通的可变对象**做通道：父（模型）与子（表单）都能读写，
   *      没有框架约定、没有时序假设。
   */
  interface CreateFormHandle {
    submit?: () => Promise<void>;
    setBusy?: (busy: boolean) => void;
    hasUnsaved?: () => boolean;
  }

  function CreateTicketForm(props: { onClose: () => void; handle: CreateFormHandle }): any {
    const { onClose, handle } = props;
    const setBusy = (b: boolean): void => handle.setBusy?.(b);

    /**
     * 门店（要在**弹窗里**取，不能从页面上下文里猜）。
     *
     * 🔴 2026-10-10 实录：第一版从 `context.blockModel.resource.getDataSource()` /
     *    `globalThis.__svcStoreCode` 里"猜"门店编码 —— 那些东西**都不存在**，
     *    于是 `store_code` 传空串，服务端如实回
     *    **422 `MISSING_STORE`**（"必须提供 storeId 或 storeCode"）。
     *    表现是"点创建没反应"（弹窗不关、也不报错得很清楚）。
     *    ⇒ 正确做法：用**已有的受控接口** `svc:storeOptions`
     *      （`actions/svc/ticket.ts` 的 I20）—— 它按 `scopeOf(actor)` 裁，
     *      门店角色**只看到自己被授权的门店**，而且它的注释里就写着
     *      "那适合**新建服务单**（只能建在自己店里）"。
     *    ⇒ 一处授权口径、一个接口，前端不猜。
     */
    const [stores, setStores] = React.useState<Array<{ code: string; name: string }>>([]);
    const [storeCode, setStoreCode] = React.useState('');
    const [storeError, setStoreError] = React.useState('');

    React.useEffect(() => {
      let alive = true;
      void (async () => {
        try {
          const payload = await request('svc:storeOptions', 'get');
          const options = (payload?.data?.options ?? payload?.options ?? []) as Array<{
            code: string;
            name: string;
          }>;
          if (!alive) return;
          setStores(options);
          if (options.length >= 1) setStoreCode(options[0].code);
          else setStoreError('你没有被授权的门店，无法新建服务单');
        } catch (error: any) {
          if (!alive) return;
          setStoreError(
            `取门店失败：${error?.response?.data?.message ?? error?.message ?? '未知错误'}`,
          );
        }
      })();
      return () => {
        alive = false;
      };
    }, []);

    const storeName =
      stores.find((s) => s.code === storeCode)?.name ?? storeCode ?? '（未选择门店）';
    const [ticketType, setTicketType] = React.useState('repair');
    const [form, setForm] = React.useState({
      customer_name: '',
      customer_mobile: '',
      content: '',
      service_address: '',
      appliance_category: '',
      brand_model: '',
    });
    const [urgent, setUrgent] = React.useState(false);
    const [errors, setErrors] = React.useState<Record<string, string>>({});
    const config = TYPE_CONFIG.find((c) => c.value === ticketType) ?? TYPE_CONFIG[0];

    const patch = (key: string, value: string): void => {
      setForm((prev) => ({ ...prev, [key]: value }));
    };

    /** 未保存判定：**任一**字段有内容（含紧急）就算有未保存内容 */
    handle.hasUnsaved = () =>
      Object.values(form).some((v) => String(v).trim() !== '') ||
      urgent === true ||
      ticketType !== 'repair';

    const validate = (): Record<string, string> => {
      const next: Record<string, string> = {};
      const name = form.customer_name.trim();
      if (!name) next.customer_name = '请填写联系人';
      else if (name.length > NAME_MAX) next.customer_name = `联系人最多 ${NAME_MAX} 字`;
      const mobile = form.customer_mobile.trim();
      if (!mobile) next.customer_mobile = '请填写联系电话';
      else if (!MOBILE_PATTERN.test(mobile)) next.customer_mobile = '手机号格式不正确（11 位，1 开头）';
      const content = form.content.trim();
      if (content.length < CONTENT_MIN) next.content = `请填写${config.contentLabel}（至少 ${CONTENT_MIN} 字）`;
      else if (content.length > CONTENT_MAX) next.content = `${config.contentLabel}最多 ${CONTENT_MAX} 字`;
      if (config.showAddress && form.service_address.trim().length > SERVICE_ADDRESS_MAX) {
        next.service_address = `服务地址最多 ${SERVICE_ADDRESS_MAX} 字`;
      }
      if (config.showAppliance && form.brand_model.trim().length > BRAND_MODEL_MAX) {
        next.brand_model = `品牌/型号最多 ${BRAND_MODEL_MAX} 字`;
      }
      return next;
    };

    const submit = async (): Promise<void> => {
      const next = validate();
      setErrors(next);
      if (Object.keys(next).length > 0) {
        // 校验不过 ⇒ **抛错**，弹窗保持打开（用户要能改，而不是重填一遍）
        throw new Error('表单还有未填写或不合规的内容，请检查标红的项');
      }
      setBusy(true);
      try {
        if (!storeCode) {
          throw new Error(storeError || '还没有确定要创建到哪家门店，请稍后重试');
        }
        const body: Record<string, unknown> = {
          store_code: storeCode,
          ticket_type: ticketType,
          content: form.content.trim(),
          customer_name: form.customer_name.trim(),
          customer_mobile: form.customer_mobile.trim(),
          urgent,
        };
        if (config.showAddress && form.service_address.trim()) {
          body.service_address = form.service_address.trim();
        }
        if (config.showAppliance && form.appliance_category) {
          body.appliance_category = form.appliance_category;
        }
        if (config.showAppliance && form.brand_model.trim()) {
          body.brand_model = form.brand_model.trim();
        }
        const payload = await request('svc:createTicket', 'post', body, {
          headers: { 'X-Request-Id': newRequestId() },
        });
        // ⚠️ 注入的 `request` 返回的是**响应信封** ⇒ 必须多剥一层 `.data`
        //    （`store-entry-action.tsx` 就是在这里栽过一次，见其注释）
        const data = payload?.data ?? payload;
        message.success(`已创建服务单 ${data?.ticket_no ?? ''}（状态：待处理）`);
        onClose();
      } catch (error: any) {
        // 弹窗**保持打开**让用户改（modal-kit 的契约：抛错不关）
        throw new Error(
          error?.response?.data?.message ?? error?.message ?? '创建失败，请稍后重试',
        );
      } finally {
        setBusy(false);
      }
    };

    // 暴露给 modal-kit 的 onOk：把 submit 挂到弹窗的「创建」上
    handle.submit = submit;

    const err = (key: string): any =>
      errors[key]
        ? React.createElement(
            'div',
            { style: { color: '#cf1322', fontSize: 12, marginTop: 2 } },
            errors[key],
          )
        : null;

    return React.createElement(
      'div',
      { 'data-testid': 'create-ticket-form' },
      React.createElement(Alert, {
        type: storeError ? 'error' : 'info',
        showIcon: true,
        style: { marginBottom: 12 },
        message: storeError || `将创建到：${storeName}（${storeCode}）`,
        description: '只能创建到你被授权的门店；总部账号没有跨店创建权限。',
      }),
      // 多门店时才出现选择器；单一门店直接固定（少一步操作）
      stores.length > 1
        ? React.createElement(Field, {
            label: '门店',
            required: true,
            children: React.createElement(Select, {
              value: storeCode,
              style: { width: '100%' },
              'data-testid': 'create-ticket-store',
              onChange: (v: string) => setStoreCode(v),
              options: stores.map((s) => ({ value: s.code, label: `${s.name}（${s.code}）` })),
            }),
          })
        : null,
      React.createElement(Field, {
        label: '服务类型',
        required: true,
        children: React.createElement(Select, {
          value: ticketType,
          style: { width: '100%' },
          'data-testid': 'create-ticket-type',
          onChange: (v: string) => {
            setTicketType(v);
            setErrors({});
          },
          options: TYPE_CONFIG.map((c) => ({ value: c.value, label: c.label })),
        }),
      }),
      React.createElement(Field, {
        label: '联系人',
        required: true,
        children: React.createElement(Input, {
          value: form.customer_name,
          maxLength: NAME_MAX,
          placeholder: '客户姓名',
          'data-testid': 'create-ticket-name',
          onChange: (e: any) => patch('customer_name', e.target.value),
        }),
      }),
      err('customer_name'),
      React.createElement(Field, {
        label: '联系电话',
        required: true,
        children: React.createElement(Input, {
          value: form.customer_mobile,
          maxLength: 11,
          placeholder: '11 位手机号',
          'data-testid': 'create-ticket-mobile',
          onChange: (e: any) => patch('customer_mobile', e.target.value),
        }),
      }),
      err('customer_mobile'),
      React.createElement(Field, {
        label: config.contentLabel,
        required: true,
        children: React.createElement(Input.TextArea, {
          value: form.content,
          rows: 3,
          maxLength: CONTENT_MAX,
          placeholder: config.contentPlaceholder,
          'data-testid': 'create-ticket-content',
          onChange: (e: any) => patch('content', e.target.value),
        }),
      }),
      err('content'),
      // ---- 按类型显示：地址 / 家电类别 / 品牌型号 ----
      config.showAddress
        ? React.createElement(
            'div',
            null,
            React.createElement(Field, {
              label: '服务地址（选填）',
              children: React.createElement(Input, {
                value: form.service_address,
                maxLength: SERVICE_ADDRESS_MAX,
                placeholder: '安排上门前可留空，门店后续补全',
                'data-testid': 'create-ticket-address',
                onChange: (e: any) => patch('service_address', e.target.value),
              }),
            }),
            err('service_address'),
          )
        : null,
      config.showAppliance
        ? React.createElement(
            'div',
            null,
            React.createElement(Field, {
              label: '家电类别（选填）',
              children: React.createElement(Select, {
                value: form.appliance_category || undefined,
                allowClear: true,
                style: { width: '100%' },
                placeholder: '请选择',
                'data-testid': 'create-ticket-appliance',
                onChange: (v: string) => patch('appliance_category', v ?? ''),
                options: APPLIANCE_OPTIONS,
              }),
            }),
            React.createElement(Field, {
              label: '品牌 / 型号（选填）',
              children: React.createElement(Input, {
                value: form.brand_model,
                maxLength: BRAND_MODEL_MAX,
                placeholder: '例如：海尔 BCD-216STPT',
                'data-testid': 'create-ticket-brand',
                onChange: (e: any) => patch('brand_model', e.target.value),
              }),
            }),
            err('brand_model'),
          )
        : null,
      React.createElement(
        Field,
        {
          label: '紧急标记（授权门店员工可设）',
          children: React.createElement(
            Checkbox,
            {
              checked: urgent,
              'data-testid': 'create-ticket-urgent',
              onChange: (e: any) => setUrgent(e.target.checked),
            },
            '标记为紧急（仅提示门店优先处理，不改变流程与时限口径）',
          ),
        },
      ),
      !config.showAppliance
        ? React.createElement(
            'div',
            { style: { color: '#8c8c8c', fontSize: 12 } },
            `${config.label}不需要填写家电类别 / 品牌型号${config.showAddress ? '' : '与服务地址'}。`,
          )
        : null,
    );
  }

  class TicketCreateActionModel extends (ActionModel as any) {
    /**
     * ⚠️ **`collection`** 而不是 `record`：本动作挂在**区块**上，不针对某一行。
     *    写成 `record` 会让框架按行级动作解析它（`context.record` 为空）。
     */
    static scene = ActionSceneEnum?.collection ?? 'collection';

    defaultProps: any = { type: 'primary', iconOnly: false, children: '新建服务单' };

    onClick(): void {
      const blockModel = (this as any).context?.blockModel;
      /** 表单 ↔ 模型 的共享句柄（见 CreateFormHandle 的说明） */
      const formHandle: CreateFormHandle = {};

      const modal = openClosableModal({
        title: '新建服务单',
        testid: 'create-ticket-modal',
        okText: '创建',
        cancelText: '取消',
        hasUnsavedChanges: () => formHandle.hasUnsaved?.() === true,
        unsavedHint: '表单里已经有内容，关闭后需要重新填写。确定关闭吗？',
        content: React.createElement(CreateTicketForm, {
          // ⚠️ 这里引用 `modal` 是**闭包延迟**：调用时 `modal` 早已赋值。
          onClose: () => {
            modal.close();
            // 关窗后刷新列表 —— 新建成功的单要**立刻**出现在自己的列表里
            // （用户裁决二 · 第 6 条）。用 `blockModel.refresh()`，
            // 与 `primary-action.tsx` 同一条路径。
            try {
              blockModel?.refresh?.();
            } catch {
              /* 刷新失败不影响"已创建"这个事实 */
            }
          },
          handle: formHandle,
        } as any),
        onOk: async () => {
          // 提交由表单自己实现（它才拿得到各字段）；这里只做转发。
          // 表单**抛错 ⇒ 弹窗保持打开**（modal-kit 的契约），用户能改后重试。
          if (!formHandle.submit) throw new Error('表单尚未就绪，请稍后重试');
          await formHandle.submit();
        },
      });
    }
  }

  return { TicketCreateActionModel };
}
