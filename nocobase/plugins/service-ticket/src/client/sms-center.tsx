/**
 * `SmsCenterModel` —— UX-01C-R8：「短信通知」后台区块（自定义区块模型）。
 *
 * ===========================================================================
 * 页面显示什么（用户 §二）
 * ===========================================================================
 *   ① 三个**真实有消费点**的配置：`sms.enabled` / `sms.provider` / `sms.retry_count`；
 *   ② 每个通道的**可发送性**（实现 / 凭证 / 模板 / 原因）—— 由服务端 `svc:smsStatus` 算好；
 *   ③ 最近 20 条发送记录（原生 `smsLogs` 只读 + `appends=ticket` 取工单号）。
 *
 * ===========================================================================
 * 三条边界
 * ===========================================================================
 *   1. **前端不判权限**：先读 `svc:smsStatus`，403 就提示"仅总部管理员"并停止；
 *   2. **不回显凭证**：服务端只给"是否配置 / 缺哪些键名"，页面原样显示，不请求任何密钥值；
 *   3. **不改冻结设置**：编辑只走 `svc:updateSetting`（白名单 + 校验 + 并发 + 同事务审计），
 *      不新增第二套配置写入。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Input, Select, Spin, Tag, message } from 'antd';
import { openClosableModal } from './modal-kit';
import { newRequestId, sendSvcRequest } from '../shared/svc-request';
import { SMS_SCENE_LABEL } from '../server/constants';

type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

interface ProviderStatus {
  name: string;
  label: string;
  implemented: boolean;
  ready: boolean;
  credentials: { configured: boolean; missingKeys: string[] };
  templates: { required: boolean; total: number; missingScenes: string[] };
  reason: string;
}
interface SmsStatusPayload {
  settings: { enabled: boolean; provider: string; retryCount: number };
  providers: ProviderStatus[];
  effective: { canSend: boolean; reason: string };
}
interface Spec {
  key: string;
  label: string;
  type: 'int' | 'bool' | 'enum';
  unit?: string;
  min?: number;
  max?: number;
  options?: Array<{ label: string; value: string }>;
  effect: string;
  consumer: string;
}

const SECTION: React.CSSProperties = { fontWeight: 600, margin: '18px 0 8px' };
const TH: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', background: '#fafafa', fontSize: 12, color: '#595959', whiteSpace: 'nowrap' };
const TD: React.CSSProperties = { padding: '8px 10px', borderTop: '1px solid #f0f0f0', fontSize: 13, verticalAlign: 'top' };

function rowsOf(r: any): any[] {
  if (Array.isArray(r?.data)) return r.data;
  if (Array.isArray(r?.data?.data)) return r.data.data;
  return [];
}

function statusTag(send: string, delivery: string) {
  if (send === 'accepted') {
    return <Tag color={delivery === 'delivered' ? 'green' : 'blue'}>{delivery === 'delivered' ? '已送达' : '已受理'}</Tag>;
  }
  if (send === 'rejected') return <Tag color="orange">被拒</Tag>;
  if (send === 'error') return <Tag color="red">异常</Tag>;
  return <Tag>{send || '—'}</Tag>;
}

function SmsCenter({ request }: { request: Requester }) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SmsStatusPayload | null>(null);
  const [specs, setSpecs] = useState<Spec[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const st = await request('svc:smsStatus');
      const payload = st?.data ?? st;
      setStatus(payload as SmsStatusPayload);
      setDenied(false);
    } catch (e: any) {
      const code = e?.response?.status;
      if (code === 403) setDenied(true);
      else setError(String(e?.response?.data?.errors?.[0]?.message ?? e?.message ?? e));
      setLoading(false);
      return;
    }
    try {
      const sp = await request('svc:listSettingSpecs');
      const all: Spec[] = (sp?.data ?? sp)?.specs ?? [];
      setSpecs(all.filter((s) => s.key.startsWith('sms.')));
    } catch {
      setSpecs([]);
    }
    try {
      const lg = await request('smsLogs:list?pageSize=20&sort=-createdAt&appends[]=ticket');
      setLogs(rowsOf(lg));
    } catch {
      setLogs([]);
    }
    setLoading(false);
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  const currentValueOf = (key: string): string => {
    if (!status) return '';
    if (key === 'sms.enabled') return status.settings.enabled ? 'true' : 'false';
    if (key === 'sms.provider') return status.settings.provider;
    if (key === 'sms.retry_count') return String(status.settings.retryCount);
    return '';
  };

  const openEdit = (spec: Spec) => {
    const current = currentValueOf(spec.key);
    let next = current;

    const kit = openClosableModal({
      title: `修改：${spec.label}`,
      testid: 'sms-edit-modal',
      okText: '保存',
      cancelText: '取消',
      hasUnsavedChanges: () => next !== current,
      unsavedHint: '改动还没保存，关闭会丢弃。',
      onOk: async () => {
        try {
          const value = spec.type === 'bool' ? next === 'true' : spec.type === 'int' ? next : next;
          await sendSvcRequest(request as any, {
            action: 'updateSetting',
            ticketId: undefined as any,
            body: { key: spec.key, value, expected_value: current, scene: 'update' },
            requestId: newRequestId(),
          });
          message.success(`已保存：${spec.label}`);
          await load();
          kit.close();
        } catch (e: any) {
          const st = e?.response?.status;
          const code = e?.response?.data?.errors?.[0]?.code ?? st;
          const msg = e?.response?.data?.errors?.[0]?.message ?? e?.message ?? e;
          if (st === 409 || code === 'CONFIG_CONFLICT') {
            message.warning(`保存失败（409 ${code ?? ''}）：${msg}`);
            await load();
            kit.close();
            return;
          }
          message.error(`保存失败（${st ?? '?'}${code ? ` ${code}` : ''}）：${msg}`);
          throw e;
        }
      },
      content: React.createElement(
        'div',
        { 'data-testid': 'sms-edit-form' },
        React.createElement(Alert, {
          type: 'info',
          showIcon: true,
          style: { marginBottom: 12 },
          message: spec.label,
          description: `${spec.effect}（消费点：${spec.consumer}）`,
        }),
        React.createElement('div', { style: { marginBottom: 6, color: '#8c8c8c', fontSize: 12 } }, `配置键：${spec.key}`),
        React.createElement('div', { style: { marginBottom: 8 } }, `当前值：${current || '(空)'}`),
        spec.type === 'bool'
          ? React.createElement(
              Checkbox,
              {
                'data-testid': 'sms-edit-value',
                defaultChecked: current === 'true',
                onChange: (e: any) => { next = e.target.checked ? 'true' : 'false'; },
              },
              '启用（关闭后发送一律记为 rejected，业务不失败）',
            )
          : spec.type === 'enum'
            ? React.createElement(Select, {
                'data-testid': 'sms-edit-value',
                defaultValue: current,
                style: { width: '100%' },
                options: (spec.options ?? []).map((o) => ({ label: o.label, value: o.value })),
                onChange: (v: any) => { next = String(v); },
              })
            : React.createElement(Input, {
                'data-testid': 'sms-edit-value',
                defaultValue: current,
                placeholder: `${spec.min ?? 0} ~ ${spec.max ?? 0}（${spec.unit ?? ''}）`,
                onChange: (e: any) => { next = e.target.value; },
              }),
      ),
    });
  };

  if (loading) {
    return React.createElement('div', { style: { padding: 40, textAlign: 'center' } }, React.createElement(Spin));
  }
  if (denied) {
    return React.createElement(Alert, {
      type: 'warning',
      showIcon: true,
      message: '仅总部管理员（hq_admin）可以查看与修改短信配置',
    });
  }
  if (error) {
    return React.createElement(Alert, { type: 'error', showIcon: true, message: '加载短信配置失败', description: error });
  }
  if (!status) return null;

  const currentProvider = status.providers.find((p) => p.name === status.settings.provider);

  return React.createElement(
    'div',
    { 'data-testid': 'sms-center' },
    React.createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 } },
      React.createElement('div', { style: { fontSize: 18, fontWeight: 600 } }, '短信通知'),
      React.createElement(Button, { size: 'small', onClick: () => void load(), 'data-testid': 'sms-refresh' }, '刷新'),
    ),
    React.createElement(
      'div',
      { style: { color: '#8c8c8c', fontSize: 12, marginBottom: 12 } },
      `当前状态：${status.effective.canSend ? '可发送' : '不可发送'}${status.effective.reason ? ` —— ${status.effective.reason}` : ''}`,
    ),
    React.createElement(
      Alert,
      {
        type: status.effective.canSend ? 'success' : 'warning',
        showIcon: true,
        'data-testid': 'sms-effective',
        message: status.effective.canSend ? '当前通道可发送（发送记录见下方）' : '当前通道不可发送',
        description: status.effective.canSend ? '' : status.effective.reason,
        style: { marginBottom: 12 },
      },
    ),

    React.createElement('div', { style: SECTION }, '通道能力（服务端实时判定）'),
    React.createElement(
      'table',
      { style: { width: '100%', borderCollapse: 'collapse' }, 'data-testid': 'sms-provider-table' },
      React.createElement(
        'thead',
        null,
        React.createElement(
          'tr',
          null,
          ['通道', '实现', '凭证', '模板', '可发送', '原因'].map((h) => React.createElement('th', { key: h, style: TH }, h)),
        ),
      ),
      React.createElement(
        'tbody',
        null,
        status.providers.map((p) =>
          React.createElement(
            'tr',
            { key: p.name, 'data-testid': `sms-provider-row-${p.name}`, 'data-ready': String(p.ready) },
            React.createElement('td', { style: TD }, p.label),
            React.createElement('td', { style: TD }, p.implemented ? '已实现' : '未实现'),
            React.createElement('td', { style: TD }, p.credentials.configured ? '已配置' : `未配置（缺 ${p.credentials.missingKeys.length} 项）`),
            React.createElement(
              'td',
              { style: TD },
              p.templates.required
                ? p.templates.missingScenes.length === 0
                  ? `${p.templates.total}/${p.templates.total} 已配`
                  : `${p.templates.total - p.templates.missingScenes.length}/${p.templates.total} 已配`
                : '不需要',
            ),
            React.createElement('td', { style: TD }, p.ready ? React.createElement(Tag, { color: 'green' }, '可发送') : React.createElement(Tag, { color: 'red' }, '不可发送')),
            React.createElement('td', { style: { ...TD, color: '#8c8c8c', fontSize: 12 } }, p.reason || '—'),
          ),
        ),
      ),
    ),

    React.createElement('div', { style: SECTION }, '配置（仅这三项有真实消费点）'),
    React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      specs.map((spec) =>
        React.createElement(
          'div',
          {
            key: spec.key,
            'data-testid': `sms-setting-${spec.key}`,
            style: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', border: '1px solid #f0f0f0', borderRadius: 8 },
          },
          React.createElement('div', { style: { flex: 1 } },
            React.createElement('div', { style: { fontSize: 13, fontWeight: 500 } }, spec.label),
            React.createElement('div', { style: { fontSize: 11, color: '#8c8c8c' } }, spec.key),
          ),
          React.createElement('div', { style: { fontSize: 13 } },
            spec.key === 'sms.provider'
              ? (spec.options?.find((o) => o.value === currentValueOf(spec.key))?.label ?? currentValueOf(spec.key))
              : spec.type === 'bool'
                ? currentValueOf(spec.key) === 'true' ? '已开启' : '已关闭'
                : `${currentValueOf(spec.key)}${spec.unit ? ` ${spec.unit}` : ''}`,
          ),
          React.createElement(Button, {
            size: 'small',
            'data-testid': `sms-setting-edit-${spec.key}`,
            onClick: () => openEdit(spec),
          }, '修改'),
        ),
      ),
    ),

    React.createElement('div', { style: SECTION }, `最近发送记录（${logs.length} 条）`),
    logs.length === 0
      ? React.createElement('div', { style: { color: '#8c8c8c', fontSize: 13 }, 'data-testid': 'sms-logs-empty' }, '暂无发送记录')
      : React.createElement(
          'table',
          { style: { width: '100%', borderCollapse: 'collapse' }, 'data-testid': 'sms-logs-table' },
          React.createElement(
            'thead',
            null,
            React.createElement(
              'tr',
              null,
              ['时间', '工单', '用途', '通道', '结果', '失败原因', '接收号码'].map((h) => React.createElement('th', { key: h, style: TH }, h)),
            ),
          ),
          React.createElement(
            'tbody',
            null,
            logs.map((row) =>
              React.createElement(
                'tr',
                { key: `log-${row.id}`, 'data-testid': 'sms-log-row' },
                React.createElement('td', { style: TD }, String(row.createdAt ?? '').replace('T', ' ').slice(0, 19)),
                React.createElement('td', { style: TD }, row.ticket?.ticket_no ?? (row.ticket_id ? `#${row.ticket_id}` : '—')),
                React.createElement('td', { style: TD }, SMS_SCENE_LABEL[row.scene] ?? row.scene ?? '—'),
                React.createElement('td', { style: TD }, row.provider ?? '—'),
                React.createElement('td', { style: TD }, statusTag(String(row.send_status ?? ''), String(row.delivery_status ?? ''))),
                React.createElement(
                  'td',
                  { style: { ...TD, color: row.error_code ? '#cf1322' : '#8c8c8c', fontSize: 12 } },
                  row.error_code ? `${row.error_code}${row.error_message ? `：${row.error_message}` : ''}` : '—',
                ),
                React.createElement('td', { style: TD }, row.recipient_masked ?? '—'),
              ),
            ),
          ),
        ),
    React.createElement(
      'div',
      { style: { marginTop: 8, color: '#bfbfbf', fontSize: 11 } },
      '号码已在入库时脱敏；本页不展示短信正文、Token 或服务商密钥。',
    ),
  );
}

export function buildSmsCenterModel(deps: {
  BaseBlockModel: any;
  request: Requester;
}): Record<string, any> {
  const { BaseBlockModel, request } = deps;
  if (!BaseBlockModel) return {};
  class SmsCenterModel extends BaseBlockModel {
    render(): any {
      return React.createElement(SmsCenter, { request });
    }
  }
  Object.defineProperty(SmsCenterModel, 'name', { value: 'SmsCenterModel' });
  return { SmsCenterModel };
}
