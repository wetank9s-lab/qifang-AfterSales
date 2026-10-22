/**
 * `ConfigEditActionModel` —— UX-01C：总部**配置项编辑**的行动作（「服务时效」页用）。
 *
 * 为什么是自定义动作模型（而不是原生表格编辑弹窗）：
 *   本项目页面种子 **约束 3** 明确"页面不挂蓝图弹窗"（DEV-53：蓝图编译出的 popup
 *   `defaults` 为 `undefined`，其内 edit 必然 400）。所以编辑表单只能像
 *   `store-entry-action.tsx` / `ticket-create-action.tsx` 一样**自建**。
 *
 * 安全边界（与 `svc:updateSetting` 对齐，前端**不判权限**）：
 *   · 只发**受控接口** `svc:updateSetting`（服务端校验 hq_admin + 白名单 + 类型/范围 + 并发）；
 *   · 前端**不拼**任何"任意键写入"请求；
 *   · 带上**当前值**作为 `expected_value` ⇒ 服务端做并发冲突检测（409）。
 */
import React from 'react';
// ⚠️ 只从 antd 取**已在宿主导出名单内**的成员（`verify-types` 判据② 会拦未核实者）。
//    `InputNumber` 不在名单内 ⇒ 改用普通 `Input`：类型/范围由**服务端** `svc:updateSetting` 校验。
import { Alert, Input, message } from 'antd';
import { openClosableModal } from './modal-kit';
import { newRequestId, sendSvcRequest } from '../shared/svc-request';

type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

interface Spec {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  type: string;
  effect: string;
  consumer: string;
  supported: boolean;
}

export function buildConfigEditActionModel(deps: {
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

  class ConfigEditActionModel extends ActionModel {
    static scene = ActionSceneEnum?.record ?? 'record';
    defaultProps: any = { type: 'link', iconOnly: false, children: '修改' };

    currentRecord(): any {
      return (this as any).context?.record ?? {};
    }

    onClick(): void {
      const record = this.currentRecord();
      const key = String(pick(record, 'key') ?? '').trim();
      const currentValue = String(pick(record, 'value') ?? '');
      if (!key) {
        message.error('取不到配置键');
        return;
      }
      void (async () => {
        // 规格（中文名/单位/范围/说明/生效时机）来自**服务端白名单**，不在前端另写一份。
        let spec: Spec | undefined;
        try {
          const payload = await request('svc:listSettingSpecs', 'get');
          const list: Spec[] = payload?.data?.specs ?? payload?.specs ?? [];
          spec = list.find((s) => s.key === key);
        } catch (e: any) {
          message.error(`读取配置规格失败：${e?.response?.data?.message ?? e?.message ?? e}`);
          return;
        }
        if (!spec || !spec.supported) {
          message.error(`配置「${key}」不在可写白名单内，不能在此修改`);
          return;
        }

        let next: string = currentValue;
        const kit = openClosableModal({
          title: `修改：${spec.label}`,
          testid: 'config-edit-modal',
          okText: '保存',
          cancelText: '取消',
          hasUnsavedChanges: () => String(next) !== currentValue,
          unsavedHint: '改动还没保存，关闭会丢弃。',
          onOk: async () => {
            try {
              await sendSvcRequest(request as any, {
                action: 'updateSetting',
                ticketId: undefined as any,
                body: { key, value: next, expected_value: currentValue, scene: 'update' },
                requestId: newRequestId(),
              });
              message.success(`已保存：${spec!.label} = ${next} ${spec!.unit}`);
              const block = (this as any).context?.blockModel;
              try { block?.refresh?.(); } catch { /* noop */ }
              kit.close();
            } catch (e: any) {
              const status = e?.response?.status;
              const code = e?.response?.data?.errors?.[0]?.code ?? status;
              const msg = e?.response?.data?.errors?.[0]?.message ?? e?.message ?? e;
              const block = (this as any).context?.blockModel;
              // 409（并发冲突）：用户看到的是**过期值**，光报错不够 —— 必须把最新值读回来，
              // 否则他会在一个已知过期的界面上反复重试（用户 §三.9 明确要求"正确重新读取"）。
              if (status === 409 || code === 'CONFIG_CONFLICT') {
                message.warning(`保存失败（409 ${code ?? ''}）：${msg}`);
                try { block?.refresh?.(); } catch { /* noop */ }
                kit.close();
                return;
              }
              // 422 等可原地改正的错误：把 **HTTP 状态 + 业务码** 都给出来 ——
              // 只给业务码（如 SETTING_VALUE_INVALID）用户不知道该找谁；
              // 只给 422 又看不出是"范围错"还是"键不可写"。
              message.error(`保存失败（${status ?? '?'}${code ? ` ${code}` : ''}）：${msg}`);
              throw e; // 保持打开（422 等可原地改正的错误）
            }
          },
          content: React.createElement(
            'div',
            null,
            React.createElement(Alert, {
              type: 'info',
              showIcon: true,
              style: { marginBottom: 12 },
              message: `${spec.label}（单位：${spec.unit}）`,
              description: `取值范围 ${spec.min} ~ ${spec.max} ${spec.unit}；${spec.effect}`,
            }),
            React.createElement('div', { style: { marginBottom: 6, color: '#8c8c8c', fontSize: 12 } }, `配置键：${key}（由系统登记，不可手输）`),
            React.createElement('div', { style: { marginBottom: 6 } }, `当前值：${currentValue || '(空)'} ${spec.unit}`),
            React.createElement(Input, {
              'data-testid': 'config-edit-input',
              defaultValue: currentValue,
              placeholder: `${spec.min} ~ ${spec.max}（${spec.unit}）`,
              onChange: (e: any) => { next = e.target.value; },
            }),
          ),
        });
      })();
    }

    renderButton(): any {
      const node = super.renderButton();
      if (!node) return node;
      return React.cloneElement(node, {
        'data-testid': 'config-edit-action',
        'data-config-key': String(pick(this.currentRecord(), 'key') ?? ''),
      });
    }
  }
  Object.defineProperty(ConfigEditActionModel, 'name', { value: 'ConfigEditActionModel' });
  ConfigEditActionModel.define?.({ label: '修改' });
  return { ConfigEditActionModel };
}
