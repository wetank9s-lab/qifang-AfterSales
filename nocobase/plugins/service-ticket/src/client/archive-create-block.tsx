/**
 * `ArchiveCreateBlockModel` —— ARC-V1 / A5-B：「档案移动测试」页的**建档区块**。
 *
 * ===========================================================================
 * 为什么要有它（用户 2026-11-10 §二 裁决：方案 B）
 * ===========================================================================
 *   原生 `CreateFormModel` 在渲染前会对 `serviceArchives` 做 `aclCheck(actionName:'create')`，
 *   失败即 `model.hidden=true` + `exitAll()` ⇒ **静默不渲染、控制台零报错**。
 *   要让它出现，唯一办法是给 `store_sales` 授予原生 `create`（含字段级 ACL）——
 *   而这被用户**明确禁止**（§一：不授予原生 create；不修改 ROLE_NATIVE_READ_ACTIONS）。
 *
 *   因此换掉载体：这个区块**不声明任何 collection 绑定**，不参与 Collection ACL 判定，
 *   只用普通 React + Ant Design 收集输入，然后走 `svc:archiveCreate` 写库。
 *   `store_sales` 对该 `svc` 动作本来就有授权（这是既定的唯一放行路径）。
 *
 * ===========================================================================
 * 四条不可退让的边界（对应用户 §三/§四/§五）
 * ===========================================================================
 *   ① **不显示可编辑 store_id**：表单上根本没有这个控件。
 *      门店由服务端从「当前登录销售的唯一有效门店绑定」推导（archive.ts:96-130），
 *      零店 / 多店 / 悬空绑定一律 fail closed。前端不猜、不传、不写死。
 *
 *   ② **archive_type 固定 `service`**：本题只支持普通上门服务，不做类型选择器。
 *
 *   ③ **业务错误不清空已填内容**：受控组件，状态只在提交成功后才重置。
 *      这一点很关键 —— 失败即清空会让销售把整张表重打一遍。
 *
 *   ④ **提交中禁用按钮**：`submitting` 为真时 `disabled`，防连点。
 *
 * ===========================================================================
 * X-Request-Id 的幂等状态（本轮前半 vs 后半，如实区分）
 * ===========================================================================
 *   改动前（取证结论）：`archive.ts` 里 7 个 action 拿到 requestId 后**从未使用**
 *     （既不查 `idempotencyRecords`，也不调 `replay()`），`ArchiveService.create()`
 *     也没有任何幂等逻辑 ⇒ **同一 X-Request-Id 重放会真的建出第二条档案。**
 *     当时它只是"格式校验 + 链路追踪锚点"，不能叫作防重复。
 *
 *   本轮已在服务端补上真幂等（见 `archive.ts` §A5-B，复用既有
 *     `idempotency_records (scene, idempotency_key)` 唯一索引，未新增表/迁移）：
 *     · 键 = `archive_create` + `${actor.userId}:${requestId}`（含操作者，避免跨人回放）
 *     · 命中即按首次响应体回放，并回写 `X-Idempotent-Replay: 1`
 *   实测：同号两次 → 两条 200、**同一个档案编号**、库里只有一条档案。
 *
 *   但**本区块自己**仍不负责幂等：它每次新业务提交就换一个新号，这是对的
 *     （一次逻辑操作 = 一个号）。网络层重试要复用同一个号 —— 那是 `sendSvcRequest` 的事。
 *
 *   本区块对"用户连点"的第一道防线仍是 **UI 层**：提交中禁用 + 成功后切到结果态
 *   （结果态下提交按钮不再渲染）。UI 防线和幂等是两件事，不能互相顶替。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Form, Input, Select, Space, Tag } from 'antd';
import { newRequestId, REQUEST_ID_HEADER } from '../shared/svc-request';
import { parseDateOnly } from '../shared/date-only';
import { DateOnlyInput } from './date-only-input';
import { ARCHIVE_SERVICE_TYPE, ARCHIVE_SERVICE_TYPE_LABEL } from '../server/constants';

type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

const EMPTY = {
  /** 'service' 普通上门服务 / 'hvac' 暖通工程（A5-F 起可选） */
  archive_type: 'service' as 'service' | 'hvac',
  customer_name: '',
  customer_mobile: '',
  service_address: '',
  service_type: undefined as string | undefined,
  product_description: '',
  planned_date: '',
  public_note: '',
};

type FormValues = typeof EMPTY;

/**
 * ⚠️ 宿主包（antd / react）在本仓库是 external + stub 出来的 `any`，
 *    因此 **不能用 `Form.useForm<FormValues>()` 这类类型参数** ——
 *    TS 会报 TS2347「Untyped function calls may not accept type arguments」，
 *    而构建门禁 BUILD-TS-GATE-01 会因此拒绝构建。
 *    取值后自己断言成目标形状即可，类型信息不丢。
 */
const useTypedForm = (): any => (Form as any).useForm();

/** 取服务端返回体的数据段（`ok()` 包了一层 `{ data }`） */
function payloadOf(r: any): any {
  if (r && typeof r === 'object' && 'data' in r) return r.data;
  return r;
}

/** 把 axios / 业务错误整理成一句人话 */
function messageOf(e: any): string {
  const body = e?.response?.data;
  const first = body?.errors?.[0];
  if (first?.message) return String(first.message);
  if (body?.message) return String(body.message);
  if (e?.response?.status) return `请求失败（HTTP ${e.response.status}）`;
  return String(e?.message ?? e ?? '未知错误');
}

interface CreateResult {
  archive_no: string;
  id: number;
  store_id: number;
  visibility: string;
  status: string;
}

function ArchiveCreateForm({ request }: { request: Requester }) {
  const [form] = useTypedForm();
  // 档案类型只影响**表单展示**（暖通没有服务类型）；真正的取值在 values.archive_type
  const [archiveType, setArchiveType] = useState('service' as string);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null as string | null);
  const [result, setResult] = useState(null as CreateResult | null);
  // A5-G：只读角色（负责人 / 总部 / viewer）**不进建档流程**。
  // 页面路由已开放给他们看列表与详情，但这个区块必须自己判断 —— 否则他们会在页面上
  // 看到一个能填的建档表单，提交后才被服务端 403，体验与"有权限"的错觉都说不通。
  // 角色读不到时按"无写权限"处理（fail closed），与服务端 ARCHIVE_WRITE_ROLES 一致。
  const [canCreate, setCanCreate] = useState(false as boolean);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await request('auth:check', 'get');
        const me = payloadOf(res) ?? {};
        const roles = Array.isArray(me.roles) ? me.roles.map((r: any) => String(r?.name ?? '')) : [];
        if (alive) setCanCreate(roles.indexOf('store_sales') >= 0);
      } catch {
        if (alive) setCanCreate(false);
      }
    })();
    return () => { alive = false; };
  }, [request]);


  const onSubmit = useCallback(async () => {
    if (submitting) return;

    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      // 前端校验未通过：Ant Design 已在字段下方标红，这里不额外报错，
      // 更不能清空 —— 用户刚填的内容必须原样留着。
      return;
    }

    setSubmitting(true);
    setError(null);

    // ---- `dateOnly` 字段的**提交前**校验（DEV-217）----
    //
    // 真机实测 500 的根因：移动端把"没选日期"暴露成字符串 `'Invalid date'`
    // （桌面 Chrome 的原生 `<input type="date">` 是 `''`，所以本机复现不出来）。
    // 服务端已加 400 兜底，但**用户不该为了收到一句"日期格式不对"而先吃一次 500**。
    // 这里用**同一个** `parseDateOnly`（前后端共享）先判一遍，口径不可能漂移。
    const plannedDate = parseDateOnly(values.planned_date);
    if (!plannedDate.ok) {
      setError(`预约上门日期${plannedDate.reason}。请重新选择（或留空）`);
      setSubmitting(false);
      return;
    }

    // 每次**新业务提交**一个新 UUID v4（重试由 sendSvc 层复用同一个号，
    // 见 shared/svc-request.ts；本区块不自行换号）。
    const requestId = newRequestId();
    try {
      const res = await request(
        'svc:archiveCreate',
        'post',
        {
          // A5-F 起由用户选择：service 普通上门服务 / hvac 暖通工程
          // ⚠️ 暖通**不传 service_type**（服务端会强制置 null，传了也没用）
          archive_type: values.archive_type,
          customer_name: values.customer_name,
          customer_mobile: values.customer_mobile,
          service_address: values.service_address,
          ...(values.archive_type === 'hvac' ? {} : { service_type: values.service_type }),
          // 可用字段留空时传 null 而不是空串：服务端 `str()` 会把空串当"没传"
          product_description: values.product_description || null,
          // ⚠️ 用**解析后**的值（`''`→null，`'2026-11-15'`→原值），不要直接传控件原始值
          planned_date: plannedDate.value,
          public_note: values.public_note || null,
          // ⚠️ 这里**故意不传 store_id**：由服务端按单店绑定推导。
        },
        { headers: { [REQUEST_ID_HEADER]: requestId } },
      );

      const data = payloadOf(res) ?? {};
      const archive = data.archive ?? data;
      if (!archive?.archive_no) {
        // 服务端回了 200 但结构不对：当成失败处理，**不清空表单**
        throw new Error('服务端未返回档案编号，请刷新后到档案列表确认');
      }
      setResult({
        archive_no: String(archive.archive_no),
        id: Number(archive.id),
        store_id: Number(archive.store_id),
        visibility: String(archive.visibility ?? ''),
        status: String(archive.status ?? ''),
      });

      // 🔴 通知**同页的档案列表**去刷新（2026-11-11 A5-G 修）。
      //
      // 为什么需要这一下：建档区块与档案列表区块是**两个独立的 FlowModel**，
      // 同一个页面上互不知道对方存在。而列表是在页面挂载时拉的（`loadList()`），
      // 建档完成后它不会自己重拉 —— 用户看到"创建成功"、返回列表却找不到刚建的那条，
      // 只能手动刷新整页。这不是测试脚本的问题，是真实体验缺陷。
      //
      // 用 window 上的自定义事件而不是共享状态：两个区块分属不同的 FlowModel 实例，
      // 硬塞一个共享 store 会把耦合写进加载顺序里；事件让"谁关心谁监听"。
      // 监听方见 `archive-edit-block.tsx` 的 `svc:archive-created` effect。
      try {
        window.dispatchEvent(
          new CustomEvent('svc:archive-created', {
            detail: { id: Number(archive.id), archive_no: String(archive.archive_no) },
          }),
        );
      } catch {
        // 老浏览器 / 非浏览器环境：刷新失败不应影响"已经创建成功"这个事实
      }
      // 成功才清空（用户 §四.3：业务错误不清空）
      form.resetFields();
    } catch (e: any) {
      setError(messageOf(e));
    } finally {
      setSubmitting(false);
    }
  }, [form, request, submitting]);

  const onReset = useCallback(() => {
    // 仅用于「再建一条」：清掉结果态，回到表单
    setResult(null);
    setError(null);
    form.resetFields();
  }, [form]);

  // ---- 结果态 -------------------------------------------------------------
  if (result) {
    return React.createElement(
      'div',
      { 'data-testid': 'arc-create-done' },
      React.createElement(
        Alert,
        { type: 'success', showIcon: true, message: '档案已创建' },
      ),
      React.createElement(
        'div',
        { style: { margin: '14px 0 6px', fontSize: 13, color: '#595959' } },
        '档案编号',
      ),
      React.createElement(
        'div',
        {
          'data-testid': 'arc-create-no',
          style: { fontSize: 22, fontWeight: 600, letterSpacing: 0.5, color: '#1f1f1f' },
        },
        result.archive_no,
      ),
      React.createElement(
        Space,
        { size: 6, wrap: true, style: { marginTop: 10 } },
        React.createElement(Tag, { color: 'default' }, `门店 ${result.store_id}`),
        React.createElement(
          Tag,
          { color: result.visibility === 'draft' ? 'orange' : 'green' },
          result.visibility === 'draft' ? '草稿（客户不可查）' : result.visibility,
        ),
        React.createElement(Tag, { color: 'blue' }, result.status || '—'),
      ),
      React.createElement(
        'div',
        { style: { marginTop: 12, fontSize: 12, color: '#8c8c8c', lineHeight: 1.7 } },
        '新档案保持草稿状态，客户目前查不到。',
        React.createElement('br'),
        '需要客户可查时，请回到后台按正式流程发布。',
      ),
      React.createElement(
        Button,
        {
          style: { marginTop: 14 },
          onClick: onReset,
          'data-testid': 'arc-create-again',
        },
        '再建一条',
      ),
    );
  }

  // ---- 表单态 -------------------------------------------------------------
  if (!canCreate) {
    return React.createElement(
      'div',
      { 'data-testid': 'arc-create-forbidden', style: { fontSize: 13, color: '#8c8c8c', padding: '8px 0' } },
      '当前账号为只读（无建档权限），这里不提供建档入口。',
    );
  }

  return React.createElement(
    Form,
    {
      form,
      layout: 'vertical',
      requiredMark: true,
      disabled: submitting,
      // A5-F：archive_type 有默认值，必须显式给 initialValues；
      // 否则 values.archive_type 是 undefined，服务端会以 ARCHIVE_BAD_TYPE 拒绝。
      initialValues: EMPTY,
      'data-testid': 'arc-create-form',
      style: { maxWidth: 520 },
    },
    error
      ? React.createElement(Alert, {
          type: 'error',
          showIcon: true,
          message: '创建失败',
          description: error,
          style: { marginBottom: 14 },
          'data-testid': 'arc-create-error',
        })
      : null,

    // A5-F：档案类型。默认「普通上门服务」，暖通工程选第二个。
    React.createElement(
      Form.Item,
      {
        name: 'archive_type',
        label: '档案类型',
        rules: [{ required: true, message: '请选择档案类型' }],
      },
      React.createElement(Select, {
        'data-testid': 'arc-create-type',
        options: [
          { value: 'service', label: '普通上门服务' },
          { value: 'hvac', label: '暖通工程（六阶段）' },
        ],
        // 只用来切换下方「服务类型」的显隐；取值仍由 Form 管
        onChange: (v: string) => setArchiveType(v === 'hvac' ? 'hvac' : 'service'),
      }),
    ),
    React.createElement(
      Form.Item,
      {
        name: 'customer_name',
        label: '客户姓名',
        rules: [{ required: true, whitespace: true, message: '请填写客户姓名' }],
      },
      React.createElement(Input, { placeholder: '例：张先生', maxLength: 40 }),
    ),
    React.createElement(
      Form.Item,
      {
        name: 'customer_mobile',
        label: '客户手机号',
        rules: [
          { required: true, message: '请填写客户手机号' },
          { pattern: /^1[3-9]\d{9}$/, message: '手机号格式不正确（11 位）' },
        ],
      },
      React.createElement(Input, {
        placeholder: '11 位手机号',
        maxLength: 11,
        inputMode: 'numeric',
      }),
    ),
    React.createElement(
      Form.Item,
      {
        name: 'service_address',
        label: '服务地址',
        rules: [{ required: true, whitespace: true, message: '请填写服务地址' }],
      },
      React.createElement(Input.TextArea, {
        placeholder: '小区 / 楼栋 / 门牌',
        autoSize: { minRows: 2, maxRows: 4 },
        maxLength: 200,
      }),
    ),
    // 暖通档案没有「服务类型」（服务端会强制置 null），所以选择暖通时整项不渲染
    archiveType === 'hvac'
      ? null
      : React.createElement(
          Form.Item,
          {
            name: 'service_type',
            label: '服务类型',
            rules: [{ required: true, message: '请选择服务类型' }],
          },
          React.createElement(
            Select,
            {
              placeholder: '请选择',
              options: Object.values(ARCHIVE_SERVICE_TYPE).map((v) => ({
                value: v,
                label: ARCHIVE_SERVICE_TYPE_LABEL[v] ?? v,
              })),
            },
          ),
        ),
    React.createElement(
      Form.Item,
      { name: 'product_description', label: '产品 / 机型描述' },
      React.createElement(Input, { placeholder: '选填，例：美的 KFR-35GW 空调', maxLength: 120 }),
    ),
    React.createElement(
      Form.Item,
      { name: 'planned_date', label: '计划上门日期（选填）' },
      // 🔴 必须是**日期选择器**，不能是文本框（用户 2026-11-11 明确要求）。
      //    旧写法 `Input + placeholder:'选填，YYYY-MM-DD'` 要求用户自己记格式，
      //    打错就提交不了 —— 而现在这个控件**结构上产不出**非法格式。
      //    为什么不用 antd 的 `DatePicker`：见 `date-only-input.tsx` 文件头
      //    （v2 bundle 的 external 里没有 dayjs，引了会让移动页构建/运行直接挂）。
      React.createElement(DateOnlyInput, { testId: 'arc-create-planned-date' }),
    ),
    React.createElement(
      Form.Item,
      { name: 'public_note', label: '对客户说明' },
      React.createElement(Input.TextArea, {
        placeholder: '选填，会展示给客户',
        autoSize: { minRows: 2, maxRows: 4 },
        maxLength: 500,
      }),
    ),

    // 门店来源说明：让销售知道"为什么不用选门店"，也避免他把地址当门店填。
    React.createElement(
      'div',
      { style: { marginBottom: 16, fontSize: 12, color: '#8c8c8c', lineHeight: 1.7 } },
      '建档门店由系统按你的账号自动确定，无需选择。',
    ),

    React.createElement(
      Button,
      {
        type: 'primary',
        block: true,
        loading: submitting,
        disabled: submitting,
        onClick: onSubmit,
        'data-testid': 'arc-create-submit',
      },
      submitting ? '提交中…' : '提交建档',
    ),
  );
}

/**
 * 构建建档区块模型。
 *
 * 🔴 基类必须是**纯 `FlowModel`**，不能是 `MarkdownBlockModel` / `DataBlockModel`。
 *
 *   实测（2026-11-10）：继承 `MarkdownBlockModel`（它是 `DataBlockModel` 的子类）后，
 *   页面抛
 *     `TypeError: Cannot read properties of undefined (reading 'dataSourceKey')`
 *   抛出点在 `DataBlockModel.onInit` 里那段**无条件**建立的派生属性：
 *
 *     getResourceSettingsInitParams(){ return this.getStepParams('resourceSettings','init') }
 *     defineProperty('collection', { get: () => {
 *        const e = this.getResourceSettingsInitParams();   // ← 无 collection 时为 undefined
 *        return this.context.dataSourceManager.getCollection(e.dataSourceKey, ...)
 *     }})
 *
 *   也就是说：**任何 DataBlockModel 子类都假定自己有 collection**。
 *   我们这条路线的全部意义恰恰是"不要 collection 绑定"（否则就回到原生 ACL 那条路），
 *   所以只能退到最普通的 `FlowModel` —— 它只需要 `render()` 就能被 `FlowModelRenderer` 渲染。
 *
 *   ⚠️ 代价：没有内置的区块卡片外壳/标题。对我们的用法是**好事**
 *      （用户明确要的是"一个能填能交的最小表单"，不是装修过的区块）。
 */
export function buildArchiveCreateBlockModel(deps: {
  FlowModelBase: any;
  request: Requester;
}): Record<string, any> {
  const { FlowModelBase, request } = deps;
  if (!FlowModelBase) return {};
  class ArchiveCreateBlockModel extends FlowModelBase {
    render(): any {
      return React.createElement(ArchiveCreateForm, { request });
    }
  }
  Object.defineProperty(ArchiveCreateBlockModel, 'name', {
    value: 'ArchiveCreateBlockModel',
  });
  return { ArchiveCreateBlockModel };
}
