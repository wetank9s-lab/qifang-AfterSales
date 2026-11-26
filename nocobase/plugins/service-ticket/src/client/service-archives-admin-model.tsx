/**
 * `ServiceArchivesAdminModel` —— 后台「上门服务档案」区块
 *
 * =============================================================================
 * 它解决什么（R2.2.1 第十条 → R2.2.4 发布前 P0 扩充）
 * =============================================================================
 * 移动端已经能把档案做出来（员工端 `src-mobile/`），但**后台没有任何入口**：
 * 总部想核一遍"某家店这周做了几单上门服务"、门店负责人想看看本店档案，
 * 都得回手机上翻。而档案里存的是客户住址与住宅现场照片 ——
 * 让总部/负责人只能在手机上翻，等于没有日常核查手段。
 *
 * R2.2.4-rc.3 之前本区块是**纯只读列表**（八个固定列）。用户 §二 要求补齐成
 * 真正的管理页：分类（全部/上门服务/暖通工程）、查询（档案编号/客户姓名/手机号/门店）、
 * 列表（客户/业务类型/所属门店/服务进展及相关日期）、详情（地址/产品清单/服务信息/
 * 有权查看的内部备注）、普通服务可改计划与实际日期及服务内容、暖通可看六阶段
 * 进度/记录/分类照片、按权限显示详情与编辑。
 *
 * =============================================================================
 * 边界（不得越过 —— 这些是用户明写的约束）
 * =============================================================================
 * · **不新增另一套档案数据库**：全部读写都走既有 svc action；
 *   页面不直连 `serviceArchives` 原生 CRUD（那条路对后台角色本来就是 403，
 *   而且会绕过 ArchiveService 的列白名单与乐观锁）。
 * · **不复制业务逻辑**：门店裁剪、手机号投影、可否编辑，一律由**服务端**判定。
 *   前端只读服务端给的 `customer_mobile_visible` / `can_edit` / `scope`，
 *   不做"我猜你只能看这些"的本地过滤 —— 那样会把人眼看成权限正常。
 * · **不把手机端 iframe 嵌进后台**。
 * · **菜单显示、页面路由、业务 API 权限必须一致**：本页只出现在
 *   `ROLE_MENU_MATRIX` 登记过的角色菜单里，且每个动作都自己再判一次权限。
 *
 *    ⚠️ 特别注意：`store_after_sales` **不在** `ARCHIVE_READ_ROLES` 里
 *       （它只有工单四表权限）。所以它即使被误授权看到本页，
 *       `archiveAdminList` 也会 403 —— 这正是"菜单不能代替权限"的落地点。
 *
 * =============================================================================
 * 🔴 一个必须记住的坑：`ok()` 会把返回体压平
 * =============================================================================
 * `archiveAdminList` 用的是 `ctx.withoutDataWrapping = true`，响应体就是
 * `{ rows, total, stores, scope, can_edit }` 本身；而其余 action 走 `ok()`
 * 被包成 `{ data: <payload> }`。所以**两条路解包方式不同**，
 * `unwrap()` 必须同时兼容两种形态，否则会出现"列表有数据、详情取不到"这种一半好一半坏的状态。
 */
import React from 'react';
import { Alert, Button, Empty, Input, Modal, Segmented, Select, Space, Tag } from 'antd';
import { ArchivePhotoGallery, resolveStageLabel } from './archive-photo-gallery';

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
  customer_mobile?: string | null;
  customer_mobile_visible?: boolean;
  /**
   * 🔴 分类**必须**看 `archive_type`，不能看 `service_type`。
   *
   * `archive_type` 是档案大类（`service` / `hvac`，固定两值）；
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
  store_id?: number | null;
  store_code: string | null;
  store_name: string | null;
  sales_name?: string | null;
  created_at: string | null;
  published_at?: string | null;
  /** R2.2.4：计划与实际日期的列表投影（详情里另有权威值） */
  planned_date?: string | null;
  service_date?: string | null;
  completed_at?: string | null;
}

interface Payload {
  rows: ArchiveRow[];
  total: number;
  stores: Array<{ id: number; code: string; name: string }>;
  scope: string;
  /** 服务端算出的"当前账号能否编辑档案"，前端不自行推断 */
  can_edit?: boolean;
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
 *    ⇒ 用字面量 + 自然推断，键名照样受 IDE 提示，只是没有类型断言。
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
const KV_LABEL = { width: 96, color: '#8c8c8c', fontSize: 12.5, flex: 'none' };
const KV_VALUE = { fontSize: 13, color: '#262626', overflowWrap: 'anywhere' };
const KV_ROW = { display: 'flex', gap: 12, padding: '7px 0', alignItems: 'flex-start' };

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

/**
 * 六阶段中文名 —— **已废弃，不要再用于渲染**。
 *
 * 🔴 R2.2.4-rc.9（用户第三节）：阶段显示名必须读后台施工阶段配置。
 *    这里保留的常量只作为 `resolveStageLabel()` 内部兜底的一部分
 *    （由 `archive-photo-gallery.tsx` 的 `DEFAULT_STAGE_LABEL` 承担），
 *    本文件的所有渲染点已改用 `detail.stageNames` 解析。
 *
 * 🔍 历史（保留供追溯）：曾经这里有硬编码 `survey: '勘察' …`，
 *    而移动端已改读配置 ⇒ 后台把「布管」改成「管路与开槽」后，
 *    手机上是新名、电脑照片分组还是「布管」，同一档案两种叫法。
 */

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

/**
 * 暖通档案的细分列显示「暖通工程 · 当前阶段」；上门服务档案显示服务类型。
 *
 * `stageLabelOf` 由调用方注入（读后台配置的那一条链），**不在本函数里读常量**：
 * 列表页和详情页拿到的配置是同一份，但注入方式不同（页面级 state / 详情 state），
 * 在这里硬读常量就又回到"改名不同步"的老路上。
 */
function subtypeText(r: ArchiveRow, stageLabelOf: (code: string) => string): string {
  if (r.archive_type === 'hvac') {
    const code = String(r.hvac_stage ?? '');
    const stage = code ? stageLabelOf(code) : '';
    return stage ? `暖通工程 · ${stage}` : '暖通工程';
  }
  const t = r.service_type;
  if (!t) return '—';
  return SERVICE_TYPE_LABEL[t] ?? String(t);
}

/**
 * 解包两种响应形态。
 *
 * `archiveAdminList` 关掉了 dataWrapping（响应体自带 rows/total），
 * 其余 action 走 `ok()` 被包成 `{ data: ... }`。这里同时兼容，
 * 且**不**用 `??` 链把"空数组"压成 fallback —— `[]` 是合法结果，不是缺失。
 */
function unwrap(res: any): any {
  if (res && typeof res === 'object') {
    if (Array.isArray(res.rows)) return res; // withoutDataWrapping 的档案列表
    if (res.data !== undefined) {
      const d = res.data;
      // 有些路径是 `{ data: { data: ... } }`（框架二次包装）
      if (d && typeof d === 'object' && d.data !== undefined && !Array.isArray(d.rows)) return d.data;
      return d;
    }
  }
  return res;
}

function fmtTime(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 日期只取前 10 位（服务端是 dateOnly / ISO 串，含时间时按本地日会错一天） */
function fmtDate(v: string | null | undefined): string {
  if (!v) return '—';
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function Kv(props: { k: string; v: any }) {
  return h(
    'div',
    { style: KV_ROW },
    h('div', { style: KV_LABEL }, props.k),
    h('div', { style: KV_VALUE }, props.v === null || props.v === undefined || props.v === '' ? '—' : props.v),
  );
}

/** 详情弹窗内的只读小节 */
function InfoSection(props: { title: string; children: any }) {
  return h(
    'div',
    { style: { marginBottom: 16 } },
    h('div', { style: SECTION }, props.title),
    h('div', { style: { border: '1px solid #f0f0f0', borderRadius: 8, padding: '4px 12px' } }, props.children),
  );
}

function ServiceArchivesAdmin({ request }: { request: Requester }) {
  const [loading, setLoading] = React.useState(true);
  const [denied, setDenied] = React.useState(false);
  // ⚠️ 不写 `React.useState<string>(...)`：`react` 在本仓库是**无体声明** stub，
  //    泛型形式会触发 TS2347（Untyped function calls may not accept type arguments），
  //    而那是**新增诊断**，会让构建门禁判红。用字面量 + 收窄代替。
  const [error, setError] = React.useState(null);
  const [data, setData] = React.useState(null);
  const [tab, setTab] = React.useState('all');

  // ---- 查询条件（§二：档案编号 / 客户姓名 / 手机号 / 门店）----
  const [qNo, setQNo] = React.useState('');
  const [qName, setQName] = React.useState('');
  const [qMobile, setQMobile] = React.useState('');
  const [qStore, setQStore] = React.useState(null);

  // ---- 详情弹窗 ----
  const [detail, setDetail] = React.useState(null); // { row, stages, photos, loading, error }
  const [editing, setEditing] = React.useState(false);
  const [form, setForm] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [saveMsg, setSaveMsg] = React.useState(null);

  /**
   * 阶段显示名配置（列表列「暖通工程 · 当前阶段」要用）。
   *
   * 与详情里的 `stageNames` 是**同一次接口的两个消费者**：列表页只渲染一列文字，
   * 没必要跟详情共用 state（详情可能没打开过）。各自读一次，共用同一条解析链
   * `resolveStageLabel()` ⇒ 两处显示必然一致。
   * 读失败保持 `{}`，回退默认名，不影响列表可用性。
   */
  const [stageNames, setStageNames] = React.useState({});
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const cfg = await request('svc:archiveStageConfigGet');
        const list = unwrap(cfg)?.stages;
        if (!alive || !Array.isArray(list)) return;
        const m: Record<string, string> = {};
        for (const s of list) {
          const code = String(s?.code ?? '');
          const name = String(s?.name ?? '').trim();
          if (code && name) m[code] = name;
        }
        setStageNames(m);
      } catch {
        /* 装饰性配置：读不到就用默认名，不弹错 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [request]);

  /** 列表列专用的解析函数（闭包在页面级 `stageNames` 上） */
  const stageLabelOf = React.useCallback(
    (code: string) => resolveStageLabel(code, stageNames),
    [stageNames],
  );

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
        can_edit: payload?.can_edit === true,
      });
      setDenied(false);
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

  // -------------------------------------------------------------------------
  // 详情：一次取齐「档案 + 产品清单 + 阶段（仅暖通）+ 照片」
  //
  // 🔴 为什么详情**不**打 `/serviceArchives:get`（原生只读通道）：
  //    那条路要过 NocoBase 资源级 ACL，而本页面向的角色里
  //    `store_sales` / `store_manager` 在后台 V2 页面本来就会因为
  //    `collections:listMeta` 403 用不了原生通道；后台管理页一旦依赖它，
  //    就会出现"列表能看、点进去白的"这种一半好一半坏的状态。
  //    所以这里只用**受控动作**：
  //      · 行数据  → 直接复用列表行（`archiveAdminList` 已下发本页需要的全部列）
  //      · 产品    → `svc:archiveProductList`
  //      · 阶段    → `svc:archiveStageList`（仅暖通；普通服务问阶段服务端会 400，是正确行为）
  //      · 照片    → `svc:archivePhotoList`（只要分类计数，不取原图）
  // -------------------------------------------------------------------------
  const openDetail = React.useCallback(
    async (row: ArchiveRow) => {
      setDetail({ row, loading: true, products: null, stages: null, photos: null, error: null, legacyOnly: false });
      setEditing(false);
      setSaveMsg(null);
      try {
        let products = null;
        let legacyOnly = false;
        try {
          const pres = await request(`svc:archiveProductList?filterByTk=${row.id}`);
          const pdoc = unwrap(pres);
          products = Array.isArray(pdoc?.products) ? pdoc.products : [];
          legacyOnly = pdoc?.legacy_only === true;
        } catch {
          products = null; // 该功能在旧版本服务端尚未上线时取不到，按"无清单"展示
        }

        let stages = null;
        let stageErr = null;
        if (String(row.archive_type) === 'hvac') {
          try {
            const sres = await request(`svc:archiveStageList?filterByTk=${row.id}`);
            const sdoc = unwrap(sres);
            stages = Array.isArray(sdoc?.stages) ? sdoc.stages : [];
          } catch (se: any) {
            stageErr = String(se?.message ?? se);
          }
        }

        let photos = null;
        try {
          const phres = await request(`svc:archivePhotoList?filterByTk=${row.id}`);
          const phdoc = unwrap(phres);
          photos = Array.isArray(phdoc?.photos) ? phdoc.photos : [];
        } catch {
          photos = null; // 照片非必需，取不到不影响主信息
        }

        /**
         * 阶段显示名配置（`R2.2.4-rc.9 第三节`）。
         *
         * `svc:archiveStageConfigGet` 只回六个 `{code, name, description}`，
         * 与档案无关（全公司一份），所以**不放在暖通分支里**：
         * 普通上门档案也要用它解析列表列「暖通工程 · 当前阶段」。
         *
         * ⚠️ 失败时保持 `{}` 而不是报错：装饰性配置读不到，
         *    `resolveStageLabel()` 会回退默认名，页面照常可用。
         *    这与移动端 `stage-config.ts` 的容错规则 ① 完全一致。
         */
        let stageNames: Record<string, string> = {};
        try {
          const cfg = await request('svc:archiveStageConfigGet');
          const list = unwrap(cfg)?.stages;
          if (Array.isArray(list)) {
            for (const s of list) {
              const code = String(s?.code ?? '');
              const name = String(s?.name ?? '').trim();
              if (code && name) stageNames[code] = name;
            }
          }
        } catch {
          stageNames = {};
        }

        setDetail({
          row,
          products,
          legacyOnly,
          stages,
          stageErr,
          photos,
          stageNames,
          loading: false,
          error: null,
        });
      } catch (e: any) {
        setDetail({ row, loading: false, products: null, stages: null, photos: null, error: String(e?.message ?? e ?? '读取详情失败') });
      }
    },
    [request],
  );

  // -------------------------------------------------------------------------
  // 编辑：**只放普通服务可改的四项**（计划日期 / 实际日期 / 服务内容 / 内部备注）
  //
  // §二 原话：「普通服务可查看修改计划与实际日期以及服务内容」。
  // 暖通工程走六阶段流程，不在此处提供自由编辑（避免绕过阶段状态机）。
  // 且 `can_edit` 必须由服务端给 —— `store_manager` 是只读角色，
  // `archiveUpdate` 对它会抛 403，前端不显示按钮只是体验，服务端拒绝才是边界。
  // -------------------------------------------------------------------------
  const startEdit = () => {
    const r: any = detail?.row ?? {};
    setForm({
      planned_date: fmtDate(r.planned_date) === '—' ? '' : fmtDate(r.planned_date),
      service_date: fmtDate(r.service_date) === '—' ? '' : fmtDate(r.service_date),
      notes: r.notes ?? '',
      assigned_worker: r.assigned_worker ?? '',
      expected_version: Number(r.version ?? 0),
    });
    setEditing(true);
    setSaveMsg(null);
  };

  const submitEdit = async () => {
    if (!form) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const body: any = { expected_version: form.expected_version };
      // ⚠️ 只提交**真的变了**的字段：`archiveUpdate` 的语义是"没提交 = 不动这一列"，
      //    把所有字段都带上会把"用户没碰"变成"用户明确改了"，一旦某列受约束就会莫名 400。
      const r: any = detail?.row ?? {};
      if (form.planned_date !== (fmtDate(r.planned_date) === '—' ? '' : fmtDate(r.planned_date))) {
        body.planned_date = form.planned_date || null;
      }
      if (form.service_date !== (fmtDate(r.service_date) === '—' ? '' : fmtDate(r.service_date))) {
        body.service_date = form.service_date || null;
      }
      if (form.notes !== (r.notes ?? '')) body.notes = form.notes;
      if (form.assigned_worker !== (r.assigned_worker ?? '')) body.assigned_worker = form.assigned_worker;

      if (Object.keys(body).length <= 1) {
        setSaveMsg({ type: 'info', text: '没有需要保存的修改' });
        return;
      }

      await request(`svc:archiveUpdate?id=${r.id}`, 'POST', body, {
        headers: { 'X-Request-Id': `adm-${Date.now()}-${Math.floor(Math.random() * 1e6)}` },
      });
      setSaveMsg({ type: 'success', text: '已保存' });
      setEditing(false);
      // 重新拉列表，并把**新的那一行**喂回详情：
      // 服务端刚写完，列表行就是最新事实，不需要再为"刷新详情"开一条读接口。
      try {
        const res = await request('svc:archiveAdminList');
        const payload = unwrap(res) as Payload;
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        setData({
          rows,
          total: Number(payload?.total ?? 0),
          stores: Array.isArray(payload?.stores) ? payload.stores : [],
          scope: String(payload?.scope ?? 'unknown'),
          can_edit: payload?.can_edit === true,
        });
        const fresh = rows.find((x: ArchiveRow) => Number(x.id) === Number(r.id));
        if (fresh) {
          setDetail({ ...detail, row: fresh, loading: false, error: null });
        }
      } catch {
        /* 列表刷新失败不改变"已保存"这个事实，用户可手动点刷新 */
      }
    } catch (e: any) {
      const status = Number(e?.status ?? e?.response?.status ?? 0);
      const msg = String(e?.message ?? e ?? '保存失败');
      // 409 = 乐观锁：服务端文案已经是给人看的一句，这里原样透出，不自己编
      setSaveMsg({ type: status === 409 ? 'warning' : 'error', text: msg });
    } finally {
      setSaving(false);
    }
  };

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

  // 查询在**前端**过滤：`archiveAdminList` 返回的是本范围全部（limit 500），
  // 服务端不做关键字查询是为了让"计数/分类数字"始终等于真实总量，
  // 而不是"筛完之后的总量"（那会让人以为档案变少了）。
  const match = (r: ArchiveRow) => {
    if (qNo && !String(r.archive_no ?? '').toLowerCase().includes(qNo.toLowerCase())) return false;
    if (qName && !String(r.customer_name ?? '').includes(qName)) return false;
    if (qMobile) {
      // 无权限时服务端给 null —— 此时**不匹配**而不是"全过"，
      // 否则无权限账号一输手机号就能反推号段（命中的就是他想要的号）。
      if (!r.customer_mobile) return false;
      if (!String(r.customer_mobile).includes(qMobile)) return false;
    }
    if (qStore !== null && qStore !== undefined && Number(r.store_id ?? 0) !== Number(qStore)) return false;
    return true;
  };

  const base = tab === 'home' ? homeRows : tab === 'hvac' ? hvacRows : all;
  const rows = base.filter(match);
  const hasQuery = Boolean(qNo || qName || qMobile || qStore !== null);

  const scopeText =
    data.scope === 'all'
      ? '总部视角：全部门店'
      : data.scope === 'stores'
        ? `门店视角：${data.stores.map((s) => s.code).join('、') || '（无门店）'}`
        : data.scope;

  const canEdit = data.can_edit === true;

  return h(
    'div',
    { 'data-testid': 'service-archives-admin' },
    error
      ? h(Alert, { type: 'error', showIcon: true, message: error, style: { marginBottom: 12 } })
      : null,

    // ---- 概览条 ----
    h(
      'div',
      { style: { ...CARD, marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
      h(Tag, { color: 'blue', 'data-testid': 'sa2-total' }, `档案 ${data.total}`),
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

      // ---- 分类（§二：全部 / 上门服务 / 暖通工程）----
      h(
        'div',
        { style: { marginBottom: 10 }, 'data-testid': 'sa2-tabs' },
        h(Segmented, {
          size: 'small',
          value: tab,
          onChange: (v: any) => setTab(String(v)),
          options: [
            { label: `全部 ${all.length}`, value: 'all' },
            { label: `上门服务 ${homeRows.length}`, value: 'home' },
            { label: `暖通工程 ${hvacRows.length}`, value: 'hvac' },
          ],
        }),
      ),

      // ---- 查询（§二：档案编号 / 客户姓名 / 手机号 / 门店）----
      h(
        'div',
        { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }, 'data-testid': 'sa2-query' },
        h(Input, {
          size: 'small',
          allowClear: true,
          placeholder: '档案编号',
          style: { width: 150 },
          value: qNo,
          onChange: (e: any) => setQNo(String(e.target.value ?? '')),
          'data-testid': 'sa2-q-no',
        }),
        h(Input, {
          size: 'small',
          allowClear: true,
          placeholder: '客户姓名',
          style: { width: 130 },
          value: qName,
          onChange: (e: any) => setQName(String(e.target.value ?? '')),
          'data-testid': 'sa2-q-name',
        }),
        h(Input, {
          size: 'small',
          allowClear: true,
          placeholder: '手机号',
          style: { width: 140 },
          value: qMobile,
          onChange: (e: any) => setQMobile(String(e.target.value ?? '')),
          'data-testid': 'sa2-q-mobile',
        }),
        h(Select, {
          size: 'small',
          allowClear: true,
          placeholder: '所属门店',
          style: { width: 160 },
          value: qStore,
          onChange: (v: any) => setQStore(v ?? null),
          options: data.stores.map((s) => ({ value: s.id, label: `${s.code} ${s.name}` })),
          'data-testid': 'sa2-q-store',
        }),
        hasQuery
          ? h(
              Button,
              {
                size: 'small',
                onClick: () => {
                  setQNo('');
                  setQName('');
                  setQMobile('');
                  setQStore(null);
                },
              },
              '清除条件',
            )
          : null,
        hasQuery
          ? h('span', { style: { fontSize: 12, color: '#8c8c8c', alignSelf: 'center' } }, `命中 ${rows.length} 条`)
          : null,
      ),

      rows.length === 0
        ? h(
            'div',
            { style: { padding: '12px 0' }, 'data-testid': 'sa2-empty' },
            h(Empty, {
              image: Empty.PRESENTED_IMAGE_SIMPLE,
              description: hasQuery
                ? '没有符合查询条件的档案'
                : tab === 'hvac'
                  ? '本范围内还没有暖通工程档案'
                  : tab === 'home'
                    ? '本范围内还没有上门服务档案'
                    : '本范围内还没有档案',
            }),
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
                ['档案编号', '客户', '业务类型', '所属门店', '服务进展', '计划 / 实际', '操作'].map((t) =>
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
                  h(
                    'td',
                    { style: TD },
                    h(
                      'a',
                      {
                        onClick: () => void openDetail(r),
                        'data-testid': `sa2-open-${r.id}`,
                        style: { color: '#1677ff', cursor: 'pointer' },
                      },
                      r.archive_no ?? `#${r.id}`,
                    ),
                  ),
                  h(
                    'td',
                    { style: TD },
                    h('div', null, r.customer_name ?? '—'),
                    h(
                      'div',
                      { style: { fontSize: 12, color: '#8c8c8c', marginTop: 2 } },
                      // 无权 → 「已隐藏」；没填 → 「—」。两者语义不同，不能都显示成 —。
                      r.customer_mobile_visible === true
                        ? (r.customer_mobile ?? '—')
                        : (r.customer_mobile === null || r.customer_mobile === undefined ? '已隐藏' : '—'),
                    ),
                  ),
                  h(
                    'td',
                    { style: TD },
                    h(
                      Tag,
                      { color: r.archive_type === 'hvac' ? 'purple' : 'blue' },
                      ARCHIVE_TYPE_LABEL[r.archive_type] ?? r.archive_type,
                    ),
                    h('div', { style: { fontSize: 12, color: '#8c8c8c', marginTop: 2 } }, subtypeText(r, stageLabelOf)),
                  ),
                  h('td', { style: TD }, r.store_name ?? r.store_code ?? '—'),
                  h(
                    'td',
                    { style: TD },
                    h(Tag, { color: STATUS_COLOR[r.status] ?? 'default' }, STATUS_LABEL[r.status] ?? r.status),
                    h(
                      'div',
                      { style: { fontSize: 12, color: '#8c8c8c', marginTop: 2 } },
                      r.visibility === 'published' ? `已发布 ${fmtTime(r.published_at ?? r.created_at)}` : '草稿',
                    ),
                  ),
                  h(
                    'td',
                    { style: { ...TD, whiteSpace: 'nowrap' } },
                    h('div', null, `计划 ${fmtDate(r.planned_date)}`),
                    h('div', { style: { color: '#8c8c8c' } }, `实际 ${fmtDate(r.service_date)}`),
                  ),
                  h(
                    'td',
                    { style: { ...TD, whiteSpace: 'nowrap' } },
                    h(Button, { size: 'small', onClick: () => void openDetail(r), 'data-testid': `sa2-detail-${r.id}` }, '详情'),
                  ),
                ),
              ),
            ),
          ),

      h(
        'div',
        { style: HINT },
        // ⚠️ 这里是 React 文本节点，**不解析 markdown**。第一版写了「这里**只读**」，
        //    页面上原样显示成「这里**只读**」（星号被当成字符）。强调一律用「」。
        '建档、补照片、暖通阶段完成/撤回仍在手机端「七方上门服务」里做（现场操作）；',
        '后台可以查、可以改普通上门服务的计划/实际日期与内部备注。',
        h('br'),
        canEdit
          ? '当前账号具备档案编辑权限（门店销售 / 平台管理员）。'
          : '当前账号为只读权限，编辑入口不会出现；即使直接调接口也会被服务端拒绝。',
      ),
    ),

    // ---- 详情弹窗 ----
    detail
      ? h(
          Modal,
          {
            open: true,
            width: 760,
            title: `${detail.row?.archive_no ?? '档案 #' + (detail.row?.id ?? '')} · 详情`,
            onCancel: () => {
              setDetail(null);
              setEditing(false);
            },
            footer: h(
              Space,
              null,
              canEdit &&
              detail.row?.archive_type === 'service' &&
              !editing &&
              !detail.loading
                ? h(Button, { key: 'edit', type: 'primary', onClick: startEdit, 'data-testid': 'sa2-edit' }, '编辑')
                : null,
              editing
                ? h(
                    Space,
                    { key: 'save' },
                    h(Button, { onClick: () => { setEditing(false); setSaveMsg(null); } }, '取消'),
                    h(Button, { type: 'primary', loading: saving, onClick: () => void submitEdit(), 'data-testid': 'sa2-save' }, '保存'),
                  )
                : null,
              h(Button, { key: 'close', onClick: () => { setDetail(null); setEditing(false); } }, '关闭'),
            ),
            destroyOnClose: true,
          },
          detail.loading
            ? h('div', { style: { padding: 24, color: '#8c8c8c' } }, '加载详情…')
            : detail.error
              ? h(Alert, { type: 'error', showIcon: true, message: detail.error })
              : h(DetailBody, { detail, editing, form, setForm, saveMsg, request }),
        )
      : null,
  );
}

/** 详情正文：客户与地址 / 服务信息 / 产品清单 / 内部备注 / 暖通六阶段 / 现场照片 */
function DetailBody(props: { detail: any; editing: boolean; form: any; setForm: any; saveMsg: any; request: Requester }) {
  const { detail, editing, form, setForm, saveMsg, request } = props;
  const r: any = detail.row ?? {};
  const isHvac = String(r.archive_type) === 'hvac';

  const field = (key: string, label: string, placeholder: string) =>
    h(
      'div',
      { style: { ...KV_ROW, alignItems: 'center' }, key },
      h('div', { style: KV_LABEL }, label),
      h('div', { style: { flex: 1 } },
        h(Input, {
          size: 'small',
          value: form?.[key] ?? '',
          placeholder,
          onChange: (e: any) => setForm({ ...form, [key]: String(e.target.value ?? '') }),
          'data-testid': `sa2-f-${key}`,
        }),
      ),
    );

  const dateField = (key: string, label: string) =>
    h(
      'div',
      { style: { ...KV_ROW, alignItems: 'center' }, key },
      h('div', { style: KV_LABEL }, label),
      h('div', { style: { flex: 1, display: 'flex', gap: 8, alignItems: 'center' } },
        // 用原生 date 控件：值必须严格是 YYYY-MM-DD，服务端 parseDateOnly 只认这个形态。
        // ⚠️ 不能用 toISOString().slice(0,10)：那是 UTC 日，东八区早 8 点前会错一天。
        h('input', {
          type: 'date',
          value: form?.[key] ?? '',
          onChange: (e: any) => setForm({ ...form, [key]: String(e.target.value ?? '') }),
          'data-testid': `sa2-f-${key}`,
          style: { padding: '3px 8px', border: '1px solid #d9d9d9', borderRadius: 6, fontSize: 13 },
        }),
        h('span', { style: { fontSize: 11.5, color: '#8c8c8c' } }, '清空该日期即表示「不填」'),
      ),
    );

  return h(
    'div',
    null,
    saveMsg
      ? h(Alert, {
          type: saveMsg.type,
          showIcon: true,
          message: saveMsg.text,
          style: { marginBottom: 12 },
          'data-testid': 'sa2-save-msg',
        })
      : null,

    h(
      InfoSection,
      { title: '客户与地址' },
      h(Kv, { k: '客户姓名', v: r.customer_name }),
      h(Kv, {
        k: '客户手机号',
        v:
          r.customer_mobile_visible === true
            ? (r.customer_mobile ?? '—')
            : '已隐藏（当前角色无手机号查看权限）',
      }),
      h(Kv, { k: '服务地址', v: r.service_address }),
      h(Kv, { k: '所属门店', v: r.store_name ?? r.store_code }),
    ),

    h(
      InfoSection,
      { title: '业务信息' },
      h(Kv, { k: '档案大类', v: ARCHIVE_TYPE_LABEL[r.archive_type] ?? r.archive_type }),
      !isHvac ? h(Kv, { k: '服务类型', v: SERVICE_TYPE_LABEL[r.service_type] ?? r.service_type }) : null,
      h(Kv, { k: '当前状态', v: STATUS_LABEL[r.status] ?? r.status }),
      isHvac ? h(Kv, { k: '当前阶段', v: resolveStageLabel(String(r.hvac_stage ?? ''), detail.stageNames) }) : null,
      h(Kv, { k: '指派师傅', v: r.assigned_worker }),
      h(Kv, { k: '建档时间', v: fmtTime(r.created_at) }),
      editing ? dateField('planned_date', '计划上门日期') : h(Kv, { k: '计划上门日期', v: fmtDate(r.planned_date) }),
      editing ? dateField('service_date', '实际服务日期') : h(Kv, { k: '实际服务日期', v: fmtDate(r.service_date) }),
      // 完工时间只显示，**不**用它代替"实际服务日期"：它是动作发生时刻，不是业务日期。
      h(Kv, { k: '完工时间', v: fmtTime(r.completed_at) }),
    ),

    // ---- 产品清单 ----
    h(
      InfoSection,
      { title: '产品清单' },
      Array.isArray(detail.products) && detail.products.length > 0
        ? h(
            'table',
            { style: { width: '100%', borderCollapse: 'collapse' } },
            h('thead', null, h('tr', null,
              ['产品名称', '购买日期', '数量'].map((t) => h('th', { key: t, style: TH }, t)),
            )),
            h('tbody', null,
              detail.products.map((p: any, i: number) =>
                h('tr', { key: p.id ?? i },
                  h('td', { style: TD }, p.product_name ?? '—'),
                  h('td', { style: { ...TD, whiteSpace: 'nowrap' } }, fmtDate(p.purchase_date)),
                  h('td', { style: TD }, p.quantity ?? '—'),
                ),
              ),
            ),
          )
        : Array.isArray(detail.products) && detail.products.length === 0
          ? h('div', { style: { ...HINT, padding: '8px 0' } },
              detail.legacyOnly
                ? `尚未细分产品清单；旧字段记录为：${r.product_description || '（空）'}`
                : '尚未登记产品清单',
            )
          : h('div', { style: { ...HINT, padding: '8px 0' } }, `旧字段记录：${r.product_description || '（空）'}`),
    ),

    // ---- 暖通六阶段（仅暖通）----
    isHvac
      ? h(
          InfoSection,
          { title: '暖通工程六阶段' },
          detail.stages === null
            ? h('div', { style: { ...HINT, padding: '8px 0' } }, detail.stageErr ? `阶段读取失败：${detail.stageErr}` : '阶段读取中…')
            : h(
                'table',
                { style: { width: '100%', borderCollapse: 'collapse' }, 'data-testid': 'sa2-stages' },
                h('thead', null, h('tr', null,
                  ['阶段', '状态', '完成时间', '记录'].map((t) => h('th', { key: t, style: TH }, t)),
                )),
                h('tbody', null,
                  [...(detail.stages || [])]
                    .sort((a: any, b: any) => Number(a.stage_order ?? 0) - Number(b.stage_order ?? 0))
                    .map((s: any) =>
                      h('tr', { key: s.id ?? s.stage_code },
                        h('td', { style: TD }, resolveStageLabel(String(s.stage_code ?? ''), detail.stageNames)),
                        h('td', { style: TD },
                          h(Tag, { color: s.status === 'completed' ? 'green' : 'default' },
                            s.status === 'completed' ? '已完成' : s.status === 'withdrawn' ? '已撤回' : '待完成'),
                        ),
                        h('td', { style: { ...TD, whiteSpace: 'nowrap' } }, fmtTime(s.completed_at)),
                        h('td', { style: TD }, s.note ?? '—'),
                      ),
                    ),
                ),
              ),
        )
      : null,

    // ---- 现场照片（R2.2.4 第二阶段：后台直接看图，不再让用户回手机翻）----
    //  暖通 → 标题「施工照片」，按六阶段分组；普通上门 → 标题「现场照片」，按记录平铺。
    //  照片字节仍走私有存储 + 授权 action（`svc:archivePhotoFile`），
    //  前端只拿 blob，不碰 storage_key（服务端投影本就不含它）。
    Array.isArray(detail.photos) && detail.photos.length > 0
      ? h(
          InfoSection,
          { title: isHvac ? '施工照片' : '现场照片' },
          h(ArchivePhotoGallery, {
            request,
            photos: detail.photos as any,
            isHvac,
            stages: detail.stages,
            // 分组标题用后台配置名（暖通）；普通服务走 photo_type，不读它
            stageNames: detail.stageNames,
          }),
        )
      : null,

    // ---- 内部备注 ----
    h(
      InfoSection,
      { title: '内部备注' },
      editing
        ? h(Input.TextArea, {
            rows: 3,
            value: form?.notes ?? '',
            onChange: (e: any) => setForm({ ...form, notes: String(e.target.value ?? '') }),
            'data-testid': 'sa2-f-notes',
          })
        : h('div', { style: { padding: '7px 0', fontSize: 13, whiteSpace: 'pre-wrap' } }, r.notes || '—'),
      h(Kv, { k: '对外说明', v: r.public_note }),
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
