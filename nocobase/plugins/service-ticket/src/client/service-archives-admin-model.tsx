/**
 * `ServiceArchivesAdminModel` —— R2.2.1 第十条：后台「上门服务档案」区块。
 *
 * =============================================================================
 * 解决什么
 * =============================================================================
 * 移动端已经能把档案做出来（员工端 `src-mobile/`），但**后台一个入口都没有**：
 * 总部想核一遍"某家店这周做了几单上门服务"、门店负责人想看看本店档案，
 * 都得回到手机上翻。而档案里存的是客户住址与住宅现场照片 ——
 * 让总部/负责人只能在手机上翻，等于没有日常核查手段。
 *
 * =============================================================================
 * 边界（不得越过）
 * =============================================================================
 *   · **只读**。新建/编辑/照片/阶段操作只在移动端做（用户裁决"移动端可现场操作"）；
 *     后台不提供任何写入口，也就不需要给后台角色开档案写权限。
 *   · 数据走受控动作 `svc:archiveAdminList`，**不依赖** `serviceArchives` 进
 *     `collections:listMeta`，也不依赖原生 Collection ACL（V2 页面会 403）。
 *   · 门店裁剪由**服务端**按 `store_users` 做，前端拿到什么就是什么；
 *     前端不做"我猜你只能看这些"的本地过滤（那样会把人眼看成权限正常）。
 *   · 列表默认**只显示已发布**（`visibility=published`）。草稿是移动端保存中的半成品，
 *     混进来会让"这周做了几单"这个数字失真。
 */
import React from 'react';
import { Alert, Button, Segmented, Tag } from 'antd';

type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

interface ArchiveRow {
  id: number;
  archive_no: string | null;
  customer_name: string | null;
  customer_phone_masked?: string | null;
  /**
   * 🔴 分类**必须**看 `archive_type`，不能看 `service_type`。
   *
   * 两者是不同层级：`archive_type` 是档案大类（`service` / `hvac`，固定两值），
   * `service_type` 只是「上门服务」内部的细分（`repair` / `install` …），暖通为 NULL。
   * 第一版按 `service_type === 'hvac_project'` 分类，结果页面上
   * 「上门服务 0 / 暖通工程 0」而「全部 30」—— 数值自相矛盾却没报错，
   * 因为它只是把每一行都分到了「都不是」那一桶。
   */
  archive_type: string;
  /** 仅 `archive_type='service'` 时有值；暖通为 null */
  service_type: string | null;
  hvac_stage?: string | null;
  status: string;
  visibility: string;
  store_code: string | null;
  store_name: string | null;
  sales_name?: string | null;
  created_at: string | null;
  published_at?: string | null;
}

interface Payload {
  rows: ArchiveRow[];
  total: number;
  stores: Array<{ id: number; code: string; name: string }>;
  scope: string;
}

const h = React.createElement;
/**
 * 样式常量**不写 `React.CSSProperties` 注解**。
 *
 * ⚠️ 理由不是"懒得写"：本仓库的 `react` 是**无体声明** stub（`types/ambient-stubs.d.ts`
 *    只有一行 `declare module 'react'`），`React.CSSProperties` 解析成
 *    `Namespace '"react"' has no exported member 'CSSProperties'`（TS2694）。
 *    那属于**新增诊断** ⇒ `build-plugin` 的 BUILD-TS-GATE-01 会判红、不构建。
 *    而把它登记进基线，等于让这个文件永久失去类型保护 —— 门禁注释里明确写了不许这么做。
 *    ⇒ 用字面量 + 内联 `as const` 之外的自然推断，键名照样受 IDE 提示，只是没有类型断言。
 */
const CARD = { border: '1px solid #f0f0f0', borderRadius: 8, padding: 14, background: '#fff' };
const SECTION = { fontWeight: 600, margin: '0 0 10px', fontSize: 13, color: '#262626' };
const TH = {
  textAlign: 'left',
  padding: '8px 10px',
  background: '#fafafa',
  fontSize: 12,
  color: '#595959',
  whiteSpace: 'nowrap',
};
const TD = { padding: '8px 10px', borderTop: '1px solid #f0f0f0', fontSize: 13, verticalAlign: 'top' };
const HINT = { fontSize: 11.5, color: '#8c8c8c', marginTop: 6, lineHeight: 1.6 };

/** 服务类型的中文名（与移动端 `SERVICE_TYPE_LABEL` 同口径） */
const SERVICE_TYPE_LABEL: Record<string, string> = {
  home_service: '上门服务',
  hvac_project: '暖通工程',
  repair: '维修',
  install: '安装',
  maintain: '保养',
  inspect: '检测',
  other: '其他',
};

/** 档案大类中文名（取自服务端 `ARCHIVE_TYPE`：`service` / `hvac`） */
const ARCHIVE_TYPE_LABEL: Record<string, string> = {
  service: '上门服务',
  hvac: '暖通工程',
};

/** 暖通档案的细分列显示「暖通工程 · 当前阶段」；上门服务档案显示服务类型 */
function subtypeText(r: ArchiveRow): string {
  if (r.archive_type === 'hvac') {
    const stage = HVAC_STAGE_LABEL[String(r.hvac_stage ?? '')] ?? String(r.hvac_stage ?? '');
    return stage ? `暖通工程 · ${stage}` : '暖通工程';
  }
  const t = r.service_type;
  if (!t) return '—';
  return SERVICE_TYPE_LABEL[t] ?? String(t);
}

/** 六阶段中文名（与移动端 `HVAC_STAGE_LABEL` 同口径） */
const HVAC_STAGE_LABEL: Record<string, string> = {
  survey: '勘察',
  plan: '方案',
  pipe: '布管',
  device: '安装',
  test: '调试',
  accept: '验收',
};

/** 业务状态中文名（`ARCHIVE_STATUS`） */
const STATUS_LABEL: Record<string, string> = {
  pending: '待上门',
  scheduled: '已预约',
  serving: '服务中',
  completed: '已完工',
  accepted: '已验收',
};

const STATUS_COLOR: Record<string, string> = {
  pending: 'default',
  scheduled: 'blue',
  serving: 'processing',
  completed: 'green',
  accepted: 'success',
};

function unwrap(res: any): any {
  return res?.data?.data ?? res?.data ?? res;
}

function fmtTime(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ServiceArchivesAdmin({ request }: { request: Requester }) {
  const [loading, setLoading] = React.useState(true);
  const [denied, setDenied] = React.useState(false);
  // ⚠️ 不写 `React.useState<string>(...)`：`react` 在本仓库是**无体声明** stub，
  //    泛型形式会触发 TS2347（Untyped function calls may not accept type arguments），
  //    而那是**新增诊断**，会让构建门禁判红。用字面量联合 + 收窄代替。
  const [error, setError] = React.useState(null);
  const [data, setData] = React.useState(null);
  const [tab, setTab] = React.useState('all');

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await request('svc:archiveAdminList');
      const payload = unwrap(res) as Payload;
      setData({
        rows: Array.isArray(payload?.rows) ? payload.rows : [],
        total: Number(payload?.total ?? 0),
        stores: Array.isArray(payload?.stores) ? payload.stores : [],
        scope: String(payload?.scope ?? 'unknown'),
      });
    } catch (e: any) {
      const status = Number(e?.status ?? e?.response?.status ?? 0);
      if (status === 401 || status === 403) {
        setDenied(true);
      } else {
        setError(String(e?.message ?? e ?? '读取失败'));
      }
    } finally {
      setLoading(false);
    }
  }, [request]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (denied) {
    return h(Alert, {
      type: 'warning',
      showIcon: true,
      message: '当前账号没有查看上门服务档案的权限',
      description: '需要「门店销售 / 门店负责人 / 总部售后 / 总部管理员」角色，且已绑定至少一家门店。',
      'data-testid': 'sa2-denied',
    });
  }
  if (loading || !data) {
    return h('div', { style: { padding: 16, color: '#8c8c8c' }, 'data-testid': 'sa2-loading' }, '加载上门服务档案…');
  }

  const all = data.rows;
  // 🔴 按 `archive_type`（档案大类）分类，不是 `service_type`。见 ArchiveRow 注释。
  const homeRows = all.filter((r) => r.archive_type === 'service');
  const hvacRows = all.filter((r) => r.archive_type === 'hvac');
  const rows = tab === 'home' ? homeRows : tab === 'hvac' ? hvacRows : all;

  const scopeText =
    data.scope === 'all'
      ? '总部视角：全部门店'
      : data.scope === 'stores'
        ? `门店视角：${data.stores.map((s) => s.code).join('、') || '（无门店）'}`
        : data.scope;

  return h(
    'div',
    { 'data-testid': 'service-archives-admin' },
    error
      ? h(Alert, { type: 'error', showIcon: true, message: error, style: { marginBottom: 12 } })
      : null,

    h(
      'div',
      { style: { ...CARD, marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
      h(Tag, { color: 'blue', 'data-testid': 'sa2-total' }, `已发布档案 ${data.total}`),
      h(Tag, null, `上门服务 ${homeRows.length}`),
      h(Tag, null, `暖通工程 ${hvacRows.length}`),
      h('span', { style: { fontSize: 12, color: '#8c8c8c' }, 'data-testid': 'sa2-scope' }, scopeText),
      h('span', { style: { flex: 1 } }),
      h(Button, { size: 'small', 'data-testid': 'sa2-refresh', onClick: () => void load() }, '刷新'),
    ),

    h(
      'div',
      { style: CARD },
      h('div', { style: SECTION }, '档案列表'),
      h(
        'div',
        { style: { marginBottom: 10 }, 'data-testid': 'sa2-tabs' },
        h(Segmented, {
          size: 'small',
          value: tab,
          onChange: (v: any) => setTab(String(v)),          options: [
            { label: `全部 ${all.length}`, value: 'all' },
            { label: `上门服务 ${homeRows.length}`, value: 'home' },
            { label: `暖通工程 ${hvacRows.length}`, value: 'hvac' },
          ],
        }),
      ),
      rows.length === 0
        ? h(
            'div',
            { style: { fontSize: 13, color: '#8c8c8c', padding: '12px 0' }, 'data-testid': 'sa2-empty' },
            tab === 'hvac'
              ? '本范围内还没有暖通工程档案'
              : tab === 'home'
                ? '本范围内还没有上门服务档案'
                : '本范围内还没有已发布的档案',
          )
        : h(
            'table',
            { style: { width: '100%', borderCollapse: 'collapse' }, 'data-testid': 'sa2-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                ['档案号', '类型', '服务类型', '门店', '客户', '手机号', '状态', '创建时间'].map((t) =>
                  h('th', { key: t, style: TH }, t),
                ),
              ),
            ),
            h(
              'tbody',
              null,
              rows.map((r) =>
                h(
                  'tr',
                  { key: r.id, 'data-testid': `sa2-row-${r.id}` },
                  h('td', { style: TD }, r.archive_no ?? `#${r.id}`),
                  h(
                    'td',
                    { style: TD },
                    h(
                      Tag,
                      { color: r.archive_type === 'hvac' ? 'purple' : 'blue' },
                      ARCHIVE_TYPE_LABEL[r.archive_type] ?? r.archive_type,
                    ),
                  ),
                  h('td', { style: TD }, subtypeText(r)),
                  h('td', { style: TD }, r.store_name ?? r.store_code ?? '—'),
                  h('td', { style: TD }, r.customer_name ?? '—'),
                  h('td', { style: TD }, r.customer_phone_masked ?? '—'),
                  h(
                    'td',
                    { style: TD },
                    h(Tag, { color: STATUS_COLOR[r.status] ?? 'default' }, STATUS_LABEL[r.status] ?? r.status),
                  ),
                  h('td', { style: TD }, fmtTime(r.published_at ?? r.created_at)),
                ),
              ),
            ),
          ),
      h(
        'div',
        { style: HINT },
        // ⚠️ 这里是 React 文本节点，**不解析 markdown**。第一版写了「这里**只读**」，
        //    页面上原样显示成「这里**只读**」（星号被当成字符）。强调一律用「」。
        '这里只读。新建档案、补照片、阶段完成/撤回都要在手机端「七方上门服务」里做（现场操作）。',
        h('br'),
        '列表只显示「已发布」档案；移动端还在编辑的草稿不在此处出现，避免「本周做了几单」这个数字被半成品撑大。',
      ),
    ),
  );
}

export function buildServiceArchivesAdminModel(deps: { BaseBlockModel: any; request: Requester }): Record<string, any> {
  const { BaseBlockModel, request } = deps;
  if (!BaseBlockModel) return {};
  class ServiceArchivesAdminModel extends BaseBlockModel {
    render(): any {
      return h(ServiceArchivesAdmin, { request });
    }
  }
  Object.defineProperty(ServiceArchivesAdminModel, 'name', { value: 'ServiceArchivesAdminModel' });
  return { ServiceArchivesAdminModel };
}
