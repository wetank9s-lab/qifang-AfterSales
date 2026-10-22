/**
 * `StoreAccountsModel` —— SEC-STORE-01：总部「门店账号」管理区块。
 *
 * =============================================================================
 * 解决什么
 * =============================================================================
 * 后端一直按 `store_users` 做数据隔离，但**没有后台入口**维护它：账号有了
 * `store_after_sales` 角色却没有任何门店绑定 ⇒ `scope=none`（看不到任何业务），
 * 而管理员只能改 SQL。本页把这件事变成受控操作：
 *
 *   · 列出门店角色账号 + 当前授权门店（未绑定会显式标红）；
 *   · 勾选真实门店 → 保存（整体替换）→ 重新读取生效结果；
 *   · 保存走 `svc:updateStoreAccountStores`（事务 + 并发 + 幂等 + 审计），
 *     **不开放** users / roles / storeUsers 的原生写权限。
 *
 * ⚠️ 多门店授权是允许的（一人管多店是真实业务），但**默认不勾选**、不自动给全部门店。
 */
import React from 'react';
import { Alert, Button, Tag, message } from 'antd';
import { openClosableModal } from './modal-kit';
import { newRequestId, sendSvcRequest } from '../shared/svc-request';

type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

interface Account {
  user_id: number;
  email: string;
  nickname: string | null;
  username: string | null;
  roles: string[];
  store_ids: number[];
  store_codes: string[];
  unbound: boolean;
}
interface StoreOption {
  id: number;
  code: string;
  name: string;
  active: boolean;
}
interface Payload {
  accounts: Account[];
  stores: StoreOption[];
}

const h = React.createElement;
const CARD: React.CSSProperties = { border: '1px solid #f0f0f0', borderRadius: 8, padding: 14, background: '#fff' };
const SECTION: React.CSSProperties = { fontWeight: 600, margin: '0 0 10px', fontSize: 13, color: '#262626' };
const TH: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', background: '#fafafa', fontSize: 12, color: '#595959', whiteSpace: 'nowrap' };
const TD: React.CSSProperties = { padding: '8px 10px', borderTop: '1px solid #f0f0f0', fontSize: 13, verticalAlign: 'top' };
const HINT: React.CSSProperties = { fontSize: 11.5, color: '#8c8c8c', marginTop: 6, lineHeight: 1.6 };

function unwrap(res: any): any {
  return res?.data?.data ?? res?.data ?? res;
}

function StoreAccounts({ request }: { request: Requester }) {
  const [loading, setLoading] = React.useState(true);
  const [denied, setDenied] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [data, setData] = React.useState<Payload | null>(null);
  const [savingUser, setSavingUser] = React.useState<number | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await request('svc:storeAccounts');
      setData(unwrap(res) as Payload);
    } catch (e: any) {
      const status = Number(e?.status ?? e?.response?.status ?? 0);
      if (status === 403) setDenied(true);
      else setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [request]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const openEdit = (account: Account) => {
    const stores = data?.stores ?? [];
    const selected = new Set<number>(account.store_ids);
    const box = { nodes: new Map<number, any>() };

    const content = h(
      'div',
      { 'data-testid': 'sa-modal' },
      h(
        'p',
        { style: { margin: '0 0 8px', fontSize: 13 } },
        `账号：${account.email}${account.nickname ? `（${account.nickname}）` : ''}`,
      ),
      h(
        'p',
        { style: { margin: '0 0 10px', fontSize: 12, color: '#8c8c8c' } },
        '勾选该账号要负责的门店；不勾选 = 撤销全部门店（该账号将看不到任何门店业务）。',
      ),
      h(
        'div',
        { style: { display: 'grid', gap: 6, maxHeight: 320, overflow: 'auto' } },
        stores.map((s) =>
          h(
            'label',
            { key: s.id, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              defaultChecked: selected.has(s.id),
              'data-testid': `sa-store-${s.id}`,
              ref: (el: any) => {
                if (el) box.nodes.set(s.id, el);
              },
              onChange: (e: any) => {
                if (e.target.checked) selected.add(s.id);
                else selected.delete(s.id);
              },
            }),
            h('span', null, `${s.code} · ${s.name}`),
            s.active ? null : h(Tag, { color: 'default' }, '已停用'),
          ),
        ),
      ),
    );

    openClosableModal({
      title: '配置授权门店',
      okText: '保存',
      testid: 'sa-edit-modal',
      content,
      onOk: async () => {
        const nextIds = [...selected].sort((a, b) => a - b);
        setSavingUser(account.user_id);
        try {
          const res = await sendSvcRequest(request, {
            action: 'updateStoreAccountStores',
            ticketId: undefined as any,
            body: {
              user_id: account.user_id,
              store_ids: nextIds,
              expected_store_ids: account.store_ids,
            },
            requestId: newRequestId(),
          });
          const out = unwrap(res);
          message.success(
            `已保存：${account.email} → ${(out?.store_codes ?? []).join(', ') || '无门店（已撤销全部）'}`,
          );
          await load();
        } catch (e: any) {
          const status = Number(e?.status ?? e?.response?.status ?? 0);
          if (status === 409) {
            message.error('该账号的门店授权刚被其他管理员修改，已刷新，请确认后重试');
            await load();
          } else {
            message.error(`保存失败：${String(e?.message ?? e)}`);
          }
          throw e; // 失败保持弹窗打开
        } finally {
          setSavingUser(null);
        }
      },
    });
  };

  if (denied) {
    return h(Alert, { type: 'warning', showIcon: true, message: '仅总部管理员可维护门店账号授权', 'data-testid': 'sa-denied' });
  }
  if (loading || !data) {
    return h('div', { style: { padding: 16, color: '#8c8c8c' }, 'data-testid': 'sa-loading' }, '加载门店账号…');
  }

  const unboundCount = data.accounts.filter((a) => a.unbound).length;

  return h(
    'div',
    { 'data-testid': 'store-accounts' },
    error ? h(Alert, { type: 'error', showIcon: true, message: error, style: { marginBottom: 12 } }) : null,

    h(
      'div',
      { style: { ...CARD, marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
      h(Tag, { color: 'blue' }, `门店角色账号 ${data.accounts.length}`),
      unboundCount > 0
        ? h(Tag, { color: 'red' }, `未绑定门店 ${unboundCount}`)
        : h(Tag, { color: 'green' }, '全部已绑定'),
      h('span', { style: { fontSize: 12, color: '#8c8c8c' } },
        '数据隔离按「账号 → 门店」计算；未绑定的门店账号看不到任何门店业务（fail-closed）。'),
      h('span', { style: { flex: 1 } }),
      h(Button, { size: 'small', 'data-testid': 'sa-refresh', onClick: () => void load() }, '刷新'),
    ),

    h(
      'div',
      { style: CARD },
      h('div', { style: SECTION }, '账号与授权门店'),
      data.accounts.length === 0
        ? h('div', { style: { fontSize: 13, color: '#8c8c8c' } }, '还没有门店角色账号')
        : h(
            'table',
            { style: { width: '100%', borderCollapse: 'collapse' }, 'data-testid': 'sa-table' },
            h('thead', null, h('tr', null, ['账号', '姓名', '业务角色', '授权门店', '操作'].map((t) => h('th', { key: t, style: TH }, t)))),
            h(
              'tbody',
              null,
              data.accounts.map((a) =>
                h(
                  'tr',
                  { key: a.user_id, 'data-testid': `sa-row-${a.user_id}` },
                  h('td', { style: TD }, a.email || `#${a.user_id}`),
                  h('td', { style: TD }, a.nickname ?? '—'),
                  h(
                    'td',
                    { style: TD },
                    (a.roles ?? []).join(' / ') || '—',
                    (a.roles ?? []).includes('member')
                      ? h(Tag, { color: 'orange', style: { marginLeft: 6 } }, '含 member：可能以该角色访问')
                      : null,
                  ),
                  h(
                    'td',
                    { style: TD },
                    a.unbound
                      ? h(Tag, { color: 'red', 'data-testid': `sa-unbound-${a.user_id}` }, '未绑定（无任何门店权限）')
                      : h('span', { 'data-testid': `sa-stores-${a.user_id}` }, a.store_codes.join('、')),
                  ),
                  h(
                    'td',
                    { style: TD },
                    h(
                      Button,
                      {
                        size: 'small',
                        'data-testid': `sa-edit-${a.user_id}`,
                        loading: savingUser === a.user_id,
                        onClick: () => openEdit(a),
                      },
                      '配置门店',
                    ),
                  ),
                ),
              ),
            ),
          ),
      h('div', { style: HINT }, '多门店授权只应在真实业务确需时使用；保存后该账号**下一次请求**即按新范围裁剪。'),
    ),
  );
}

export function buildStoreAccountsModel(deps: { BaseBlockModel: any; request: Requester }): Record<string, any> {
  const { BaseBlockModel, request } = deps;
  if (!BaseBlockModel) return {};
  class StoreAccountsModel extends BaseBlockModel {
    render(): any {
      return h(StoreAccounts, { request });
    }
  }
  Object.defineProperty(StoreAccountsModel, 'name', { value: 'StoreAccountsModel' });
  return { StoreAccountsModel };
}
