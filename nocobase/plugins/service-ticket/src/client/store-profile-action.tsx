/**
 * `StoreProfileActionModel` —— UX-01C-R7：「门店报修入口」表格行内的「门店资料」编辑动作。
 *
 * ===========================================================================
 * 边界（与用户第七轮指令逐条对应）
 * ===========================================================================
 *   · 只改**四个字段**：name / contact_phone / address / active；
 *     **`code` 只读**（它是签名二维码的输入，改了已印发的码就失效）；
 *   · 权限**不在前端判**：先调 `svc:storeProfile`，403 就提示"仅总部管理员"并停止 ——
 *     与 config-edit-action 同口径（前端猜权限迟早与服务端分叉，见 DEV-139）；
 *   · 每个字段一次受控请求（服务端逐字段审计），带 `expected_value` 做并发检测；
 *     任一字段 409 ⇒ 提示"已被其他管理员修改" + **重新读取** + 关闭（不静默覆盖）；
 *   · 422 ⇒ 原样显示服务端中文校验信息，**保持打开**让用户改。
 *
 * ⚠️ 为什么逐字段提交而不是"一次性提交四个字段"：
 *   审计表的粒度就是"门店 × 字段"（谁在什么时候把哪个字段从什么改成什么）。
 *   批量接口要么写一条含 JSON 的审计（不可按字段查询），要么在事务里拆多条 ——
 *   与"逐字段请求 + 服务端事务"相比，后者更简单且每一笔都能独立重试。
 */
import React from 'react';
// ⚠️ 只用宿主已核实的成员（verify-types 白名单）：没有 Switch，所以启用状态用 Checkbox。
import { Alert, Checkbox, Input, message } from 'antd';
import { openClosableModal } from './modal-kit';
import { newRequestId, sendSvcRequest } from '../shared/svc-request';

type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

interface ProfileField {
  field: 'name' | 'contact_phone' | 'address';
  label: string;
  max: number;
  nullable: boolean;
}

interface StoreProfile {
  id: number;
  code: string;
  name: string;
  contact_phone: string | null;
  address: string | null;
  active: boolean;
}

export function buildStoreProfileActionModel(deps: {
  ActionModel: any;
  ActionSceneEnum?: any;
  request: Requester;
}): Record<string, any> {
  const { ActionModel, ActionSceneEnum, request } = deps;
  if (!ActionModel) return {};

  function pick(record: any, key: string): any {
    if (!record) return undefined;
    if (record[key] !== undefined) return record[key];
    if (record?.data?.[key] !== undefined) return record.data[key];
    if (typeof record?.get === 'function') return record.get(key);
    return undefined;
  }

  class StoreProfileActionModel extends ActionModel {
    static scene = ActionSceneEnum?.record ?? 'record';
    defaultProps: any = { type: 'link', iconOnly: false, children: '门店资料' };

    currentRecord(): any {
      return (this as any).context?.record ?? {};
    }

    onClick(): void {
      const record = this.currentRecord();
      const storeId = Number(pick(record, 'id'));
      if (!Number.isFinite(storeId) || storeId <= 0) {
        message.error('取不到门店 ID');
        return;
      }

      void (async () => {
        let profile: StoreProfile;
        let fields: ProfileField[] = [];
        try {
          const payload = await request(`svc:storeProfile?filterByTk=${storeId}`);
          const data = payload?.data ?? payload;
          if (!data?.store) throw new Error('门店资料接口返回的形状不对（缺 store）');
          profile = data.store as StoreProfile;
          fields = (data.fields ?? []).filter((f: any) => f.field !== 'active') as ProfileField[];
        } catch (e: any) {
          const status = e?.response?.status ?? e?.status;
          if (status === 403) {
            message.warning('仅总部管理员（hq_admin）可以修改门店资料');
            return;
          }
          message.error(`读取门店资料失败（${status ?? '?'}）：${e?.response?.data?.errors?.[0]?.message ?? e?.message ?? e}`);
          return;
        }

        // ---- 表单初值（原值同时用于 expected_value）----
        const original = {
          name: profile.name ?? '',
          contact_phone: profile.contact_phone ?? '',
          address: profile.address ?? '',
          active: profile.active === true,
        };
        let next = { ...original };

        const fieldInput = (f: ProfileField) =>
          React.createElement(Input, {
            key: f.field,
            'data-testid': `store-profile-${f.field === 'contact_phone' ? 'phone' : f.field}`,
            defaultValue: (original as any)[f.field] ?? '',
            maxLength: f.max,
            placeholder:
              f.field === 'contact_phone'
                ? '可留空；支持手机 / 座机 / 400 客服号，如 028-12345678'
                : f.field === 'address'
                  ? '可留空；对客户公开的到店地址'
                  : '对外展示的门店名称',
            onChange: (e: any) => {
              next = { ...next, [f.field]: e.target.value };
            },
          });

        const kit = openClosableModal({
          title: `门店资料：${profile.name}（${profile.code}）`,
          testid: 'store-profile-modal',
          okText: '保存',
          cancelText: '取消',
          hasUnsavedChanges: () =>
            next.name !== original.name ||
            next.contact_phone !== original.contact_phone ||
            next.address !== original.address ||
            next.active !== original.active,
          unsavedHint: '改动还没保存，关闭会丢弃。',
          onOk: async () => {
            const changed: Array<{ field: keyof typeof original; value: unknown }> = [];
            if (next.name !== original.name) changed.push({ field: 'name', value: next.name });
            if (next.contact_phone !== original.contact_phone) changed.push({ field: 'contact_phone', value: next.contact_phone });
            if (next.address !== original.address) changed.push({ field: 'address', value: next.address });
            if (next.active !== original.active) changed.push({ field: 'active', value: next.active });

            if (changed.length === 0) {
              message.info('没有需要保存的修改');
              kit.close();
              return;
            }

            const block = (this as any).context?.blockModel;
            try {
              for (const item of changed) {
                await sendSvcRequest(request as any, {
                  action: 'updateStoreProfile',
                  ticketId: storeId,
                  body: {
                    field: item.field,
                    value: item.value,
                    // 期望值 = 打开弹窗时看到的值（并发检测基线）
                    expected_value: (original as any)[item.field],
                    scene: 'update',
                  },
                  requestId: newRequestId(),
                });
              }
              message.success(`已保存门店资料（${changed.map((c) => c.field).join('、')}）`);
              try { block?.refresh?.(); } catch { /* noop */ }
              kit.close();
            } catch (e: any) {
              const status = e?.response?.status;
              const code = e?.response?.data?.errors?.[0]?.code ?? status;
              const msg = e?.response?.data?.errors?.[0]?.message ?? e?.message ?? e;
              if (status === 409 || code === 'STORE_PROFILE_CONFLICT') {
                // 用户要求：409 必须**重新读取最新数据**，不能静默覆盖
                message.warning(`保存失败（409 ${code ?? ''}）：${msg}`);
                try { block?.refresh?.(); } catch { /* noop */ }
                kit.close();
                return;
              }
              message.error(`保存失败（${status ?? '?'}${code ? ` ${code}` : ''}）：${msg}`);
              throw e; // 422 等可原地改正：保持打开
            }
          },
          content: React.createElement(
            'div',
            { 'data-testid': 'store-profile-form' },
            React.createElement(Alert, {
              type: 'info',
              showIcon: true,
              style: { marginBottom: 12 },
              message: '门店编码不可修改',
              description: `编码 ${profile.code} 是签名二维码的输入；修改会让已印发的二维码全部失效。`,
            }),
            React.createElement(
              'div',
              { style: { marginBottom: 6, color: '#8c8c8c', fontSize: 12 } },
              `门店编码：${profile.code}（只读）`,
            ),
            ...fields.map((f) =>
              React.createElement(
                'div',
                { key: f.field, style: { marginBottom: 12 } },
                React.createElement(
                  'div',
                  { style: { marginBottom: 4, fontSize: 13 } },
                  `${f.label}${f.nullable ? '（可留空）' : ''}`,
                ),
                fieldInput(f),
              ),
            ),
            React.createElement(
              'div',
              { style: { marginTop: 4 } },
              React.createElement(
                Checkbox,
                {
                  'data-testid': 'store-profile-active',
                  defaultChecked: original.active,
                  onChange: (e: any) => {
                    next = { ...next, active: e.target.checked === true };
                  },
                },
                '启用该门店（停用后客户扫码无法新建报修；历史工单仍可查看）',
              ),
            ),
          ),
        });
      })();
    }

    renderButton(): any {
      const node = super.renderButton();
      if (!node) return node;
      return React.cloneElement(node, {
        'data-testid': 'store-profile-action',
        'data-store-id': String(pick(this.currentRecord(), 'id') ?? ''),
      });
    }
  }
  Object.defineProperty(StoreProfileActionModel, 'name', { value: 'StoreProfileActionModel' });
  StoreProfileActionModel.define?.({ label: '门店资料' });
  return { StoreProfileActionModel };
}
