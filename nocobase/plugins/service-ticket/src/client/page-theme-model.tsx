/**
 * `PageThemeModel` —— UX-01D M1：「客户页面装修」后台区块。
 *
 * =============================================================================
 * 页面里有什么（用户 §七）
 * =============================================================================
 *   · 顶部状态条：草稿修订号 / 当前线上版本 / 是否有未保存或未发布改动；
 *   · 左侧表单：五项（平台名称、副标题、主题预设、媒体帮助文案、帮助条显隐）；
 *   · 右侧预览：**真实 H5 页面**的同源 iframe，375/390/420 三档宽度 + 报修/投诉切换；
 *   · 底部：发布差异（服务端算好）+ 发布历史 + 回滚。
 *
 * =============================================================================
 * 四条前端纪律
 * =============================================================================
 *   1. **前端不判权限**：所有读写走 `svc:uiTheme*`，服务端才是边界；
 *      403 就提示"仅总部管理员"，不自己猜角色。
 *   2. **预览是真实页面，不是截图**：iframe 指向 `/h5/report?uiPreview=1`，
 *      结构与线上完全一致；只是把提交/采集入口禁用（服务端也只给草稿本身）。
 *   3. **预览凭证不进 URL**：iframe 的 src 里没有 token；加载完成后用
 *      **同源 postMessage** 交给页面，页面再用 POST body 换草稿。
 *   4. **主题切换不重建表单**：宽度/模式只改 CSS 与 postMessage，
 *      不重新 `src`（重载 iframe 会丢掉管理员正在对比的输入）。
 *
 * ⚠️ 控件刻意只用**已核实存在的宿主成员**（Alert/Button/Input/Tag/message），
 *    主题选择与开关用原生 button/checkbox —— 不为了"好看"去登记未核实的新组件。
 */
import React from 'react';
import { Alert, Button, Input, Tag, message } from 'antd';
import { openClosableModal } from './modal-kit';
import { newRequestId, sendSvcRequest } from '../shared/svc-request';

type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

interface UiDoc {
  schema_version: number;
  brand: { name: string; subtitle: string };
  theme: { preset: 'classic-blue' | 'brand-red' | 'graphite' };
  copy: { media_help: string };
  modules: { media_help: boolean };
}

interface DraftView {
  doc: UiDoc;
  revision: number;
  base_version: number;
  updated_at: string | null;
  updated_by: string | null;
}
interface PublishedView {
  version: number;
  doc: UiDoc;
  published_at: string | null;
}
interface DiffItem {
  field: string;
  label: string;
  from: string;
  to: string;
}
interface DraftPayload {
  scope: string;
  defaults: UiDoc;
  draft: DraftView | null;
  published: PublishedView | null;
  diff: DiffItem[];
}
interface ReleaseRow {
  version: number;
  doc: UiDoc;
  published_at: string | null;
  published_by: string | null;
  note: string | null;
  rolled_back_from: number | null;
}

const h = React.createElement;

const PRESETS: Array<{ value: UiDoc['theme']['preset']; label: string; hint: string; color: string }> = [
  { value: 'classic-blue', label: '经典蓝', hint: '当前默认', color: '#2f6fed' },
  { value: 'brand-red', label: '品牌红', hint: '家电连锁常用', color: '#c8362c' },
  { value: 'graphite', label: '石墨灰', hint: '低饱和', color: '#475569' },
];

const WRAP: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(380px, 560px) 1fr', gap: 20, alignItems: 'start' };
const CARD: React.CSSProperties = { border: '1px solid #f0f0f0', borderRadius: 8, padding: 14, background: '#fff' };
const SECTION: React.CSSProperties = { fontWeight: 600, margin: '0 0 10px', fontSize: 13, color: '#262626' };
const LABEL: React.CSSProperties = { fontSize: 13, fontWeight: 500 };
const HINT: React.CSSProperties = { fontSize: 11.5, color: '#8c8c8c', marginTop: 4, lineHeight: 1.6 };
const FIELD: React.CSSProperties = { marginBottom: 14 };

/** 响应解包：兼容 `{data}` 与 `{data:{data}}` 两种包装 */
function unwrap(res: any): any {
  return res?.data?.data ?? res?.data ?? res;
}

const len = (text: string): number => Array.from(text ?? '').length;

function fmtTime(raw: string | null): string {
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sameDoc(a: UiDoc | null, b: UiDoc | null): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function SegButton(props: {
  active: boolean;
  onClick: () => void;
  testid: string;
  children: React.ReactNode;
}): any {
  return h(
    'button',
    {
      type: 'button',
      'data-testid': props.testid,
      onClick: props.onClick,
      style: {
        padding: '4px 10px',
        fontSize: 12,
        borderRadius: 6,
        cursor: 'pointer',
        border: `1px solid ${props.active ? '#1677ff' : '#d9d9d9'}`,
        background: props.active ? '#e6f4ff' : '#fff',
        color: props.active ? '#1677ff' : '#595959',
      },
    },
    props.children,
  );
}

function PageTheme({ request }: { request: Requester }) {
  const [loading, setLoading] = React.useState(true);
  const [denied, setDenied] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [payload, setPayload] = React.useState<DraftPayload | null>(null);
  const [doc, setDoc] = React.useState<UiDoc | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [publishing, setPublishing] = React.useState(false);
  const [releases, setReleases] = React.useState<ReleaseRow[]>([]);
  const [frameWidth, setFrameWidth] = React.useState(390);
  const [previewMode, setPreviewMode] = React.useState<'repair' | 'complaint'>('repair');
  const [previewAt, setPreviewAt] = React.useState<string | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const iframeRef = React.useRef<any>(null);
  /** 最近一次预览内容（凭证**不交给 iframe**：由本页消费后只下发 doc） */
  const previewRef = React.useRef<any>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await request('svc:uiThemeDraft');
      const data = unwrap(res) as DraftPayload;
      setPayload(data);
      setDoc(data.draft?.doc ?? data.defaults);
      const rel = await request('svc:uiThemeReleases?limit=20');
      setReleases((unwrap(rel)?.releases ?? []) as ReleaseRow[]);
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

  /**
   * 把**预览内容**交给 iframe。
   *
   * 🔴 只发 `doc`，**不发凭证**：凭证由本页（登录态 + hq_admin）消费，
   *    iframe（H5 匿名上下文）从头到尾看不到它 —— 即便被调试器读出页面变量也没有凭证。
   * 🔴 `targetOrigin` 必须是**明确的同源 origin**，不能用 `'*'`。
   */
  const postPreview = React.useCallback(() => {
    const host = (globalThis as any).window;
    const win = iframeRef.current?.contentWindow;
    if (!host || !win) return;
    const origin = host.location.origin;
    if (previewRef.current) {
      win.postMessage({ type: 'svc-ui-preview-doc', ...previewRef.current }, origin);
    }
    win.postMessage({ type: 'svc-ui-preview-mode', mode: previewMode }, origin);
  }, [previewMode]);

  React.useEffect(() => {
    const host = (globalThis as any).window;
    if (!host) return undefined;
    const onMessage = (event: any) => {
      // ① 同源；② **来源必须是我们自己的 iframe**（不接受任意窗口发来的 ready）
      if (event.origin !== host.location.origin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: string } | null;
      if (data?.type === 'svc-ui-preview-ready') postPreview();
    };
    host.addEventListener('message', onMessage);
    return () => host.removeEventListener('message', onMessage);
  }, [postPreview]);

  React.useEffect(() => {
    postPreview();
  }, [previewMode, postPreview]);

  const draftDoc = payload?.draft?.doc ?? null;
  const defaults = payload?.defaults ?? null;
  const dirty = Boolean(doc && defaults && !sameDoc(doc, draftDoc ?? defaults));
  const diff = payload?.diff ?? [];

  const patch = (mut: (next: UiDoc) => void) => {
    if (!doc) return;
    const next: UiDoc = JSON.parse(JSON.stringify(doc));
    mut(next);
    setDoc(next);
  };

  const validate = (): string | null => {
    if (!doc) return '配置尚未加载';
    const nameLen = len(doc.brand.name);
    if (nameLen < 2 || nameLen > 20) return '平台名称需 2–20 个字符';
    if (len(doc.brand.subtitle) > 24) return '副标题最多 24 个字符';
    if (len(doc.copy.media_help) > 40) return '媒体帮助文案最多 40 个字符';
    const texts = [doc.brand.name, doc.brand.subtitle, doc.copy.media_help];
    if (texts.some((t) => /[<>]/.test(t))) return '文案不能包含 < 或 >（页面按纯文本渲染）';
    return null;
  };

  const save = async (): Promise<boolean> => {
    const issue = validate();
    if (issue) {
      message.error(issue);
      return false;
    }
    setSaving(true);
    try {
      const res = await sendSvcRequest(request, {
        action: 'uiThemeSave',
        ticketId: undefined as any,
        body: { doc, expected_revision: payload?.draft?.revision ?? 0 },
        requestId: newRequestId(),
      });
      const out = unwrap(res);
      message.success(`草稿已保存为 v${out?.revision ?? '?'}`);
      await load();
      return true;
    } catch (e: any) {
      const status = Number(e?.status ?? e?.response?.status ?? 0);
      if (status === 409) message.error('草稿已被其他管理员修改，已为你刷新，请确认后重试');
      else message.error(`保存失败：${String(e?.message ?? e)}`);
      if (status === 409) await load();
      return false;
    } finally {
      setSaving(false);
    }
  };

  const preview = async () => {
    setPreviewError(null);
    try {
      const res = await sendSvcRequest(request, {
        action: 'uiThemePreview',
        ticketId: undefined as any,
        body: {},
        requestId: newRequestId(),
      });
      const out = unwrap(res);
      const token = String(out?.token ?? '');
      if (!token) throw new Error('服务端未返回预览凭证');

      // ② 用凭证**在本页**换草稿（受控动作：登录 + hq_admin + 签发者本人 + revision 未变）
      const docRes = await sendSvcRequest(request, {
        action: 'uiThemePreviewDoc',
        ticketId: undefined as any,
        body: { token },
        requestId: newRequestId(),
      });
      const view = unwrap(docRes);
      previewRef.current = {
        doc: view?.doc,
        store: view?.store,
        revision: view?.revision,
      };
      setPreviewAt(String(view?.expires_at ?? out?.expires_at ?? ''));
      postPreview();
      message.success('预览已刷新（10 分钟内有效）');
    } catch (e: any) {
      const text = String(e?.message ?? e);
      setPreviewError(text);
      message.error(text);
    }
  };

  const publish = () => {
    if (!payload?.draft) {
      message.warning('请先保存一次草稿');
      return;
    }
    if (dirty) {
      message.warning('有未保存的修改，请先保存草稿再发布');
      return;
    }
    if (diff.length === 0) {
      message.info('草稿与线上版本没有差异，无需发布');
      return;
    }
    openClosableModal({
      title: '确认发布到线上？',
      okText: '发布',
      testid: 'pt-publish-confirm',
      content: h(
        'div',
        null,
        h(
          'p',
          { style: { margin: '0 0 8px' } },
          `发布后客户下次打开页面即生效（当前线上 v${payload.published?.version ?? 0}）。`,
        ),
        h(
          'ul',
          { style: { margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.9 }, 'data-testid': 'pt-diff' },
          diff.map((d) =>
            h(
              'li',
              { key: d.field },
              h('span', { style: { color: '#8c8c8c' } }, `${d.label}：`),
              h('span', { style: { textDecoration: 'line-through', color: '#8c8c8c' } }, d.from || '（空）'),
              ' → ',
              h('strong', null, d.to || '（空）'),
            ),
          ),
        ),
      ),
      onOk: async () => {
        setPublishing(true);
        try {
          const res = await sendSvcRequest(request, {
            action: 'uiThemePublish',
            ticketId: undefined as any,
            body: { expected_revision: payload.draft!.revision, note: '后台发布' },
            requestId: newRequestId(),
          });
          const out = unwrap(res);
          message.success(`已发布 v${out?.version ?? '?'}`);
          await load();
        } catch (e: any) {
          const status = Number(e?.status ?? e?.response?.status ?? 0);
          if (status === 409) message.error('发布冲突：草稿或版本已变化，已为你刷新');
          else message.error(`发布失败：${String(e?.message ?? e)}`);
          await load();
          throw e; // 失败保持弹窗打开（用户能看到 diff 与原因）
        } finally {
          setPublishing(false);
        }
      },
    });
  };

  const rollback = (row: ReleaseRow) => {
    openClosableModal({
      title: `回滚到 v${row.version}？`,
      okText: '确认回滚',
      testid: 'pt-rollback-confirm',
      content: h(
        'p',
        { style: { margin: 0 } },
        `将以 v${row.version} 的快照**再发布一个新版本**（历史版本不会被改写）。`,
      ),
      onOk: async () => {
        try {
          const res = await sendSvcRequest(request, {
            action: 'uiThemeRollback',
            ticketId: undefined as any,
            body: { to_version: row.version, note: `回滚到 v${row.version}` },
            requestId: newRequestId(),
          });
          const out = unwrap(res);
          message.success(`已回滚：新版本 v${out?.version ?? '?'}（内容等于 v${row.version}）`);
          await load();
        } catch (e: any) {
          message.error(`回滚失败：${String(e?.message ?? e)}`);
          throw e;
        }
      },
    });
  };

  if (denied) {
    return h(Alert, {
      type: 'warning',
      showIcon: true,
      message: '仅总部管理员可维护客户页面装修',
      'data-testid': 'pt-denied',
    });
  }
  if (loading || !doc || !payload) {
    return h('div', { style: { padding: 16, color: '#8c8c8c' }, 'data-testid': 'pt-loading' }, '加载装修配置…');
  }

  const published = payload.published;
  const draftRevision = payload.draft?.revision ?? 0;

  return h(
    'div',
    { 'data-testid': 'page-theme' },
    error ? h(Alert, { type: 'error', showIcon: true, message: error, style: { marginBottom: 12 } }) : null,

    // ---------------------------------------------------------- 状态条
    h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          marginBottom: 12,
          padding: '8px 10px',
          background: '#fafafa',
          border: '1px solid #f0f0f0',
          borderRadius: 8,
        },
        'data-testid': 'pt-status',
      },
      h(Tag, { color: 'blue' }, `草稿 v${draftRevision}`),
      h(Tag, { color: published ? 'green' : 'default' }, published ? `线上 v${published.version}` : '线上未发布'),
      published ? h('span', { style: { fontSize: 12, color: '#8c8c8c' } }, `发布于 ${fmtTime(published.published_at)}`) : null,
      dirty ? h(Tag, { color: 'orange' }, '有未保存修改') : null,
      !dirty && draftRevision > 0 && diff.length > 0 ? h(Tag, { color: 'gold' }, `${diff.length} 项未发布`) : null,
      h('span', { style: { flex: 1 } }),
      h(
        Button,
        { size: 'small', 'data-testid': 'pt-reset-default', onClick: () => setDoc(JSON.parse(JSON.stringify(defaults))) },
        '恢复默认值',
      ),
    ),

    h(
      'div',
      { style: WRAP },
      // ---------------------------------------------------------- 左：表单
      h(
        'div',
        null,
        h(
          'div',
          { style: CARD },
          h('div', { style: SECTION }, '基础品牌'),
          h(
            'div',
            { style: FIELD },
            h('div', { style: LABEL }, '平台显示名称'),
            h(Input, {
              value: doc.brand.name,
              maxLength: 20,
              'data-testid': 'pt-name',
              onChange: (e: any) => patch((n) => { n.brand.name = e.target.value; }),
            }),
            h('div', { style: HINT }, `显示在客户页顶部与浏览器页签；2–20 字（当前 ${len(doc.brand.name)}）。`),
          ),
          h(
            'div',
            { style: FIELD },
            h('div', { style: LABEL }, '副标题（可留空）'),
            h(Input, {
              value: doc.brand.subtitle,
              maxLength: 24,
              placeholder: '留空则不显示',
              'data-testid': 'pt-subtitle',
              onChange: (e: any) => patch((n) => { n.brand.subtitle = e.target.value; }),
            }),
            h('div', { style: HINT }, `显示在平台名下方一行；0–24 字（当前 ${len(doc.brand.subtitle)}）。`),
          ),
        ),

        h(
          'div',
          { style: { ...CARD, marginTop: 12 } },
          h('div', { style: SECTION }, '主题外观'),
          h(
            'div',
            { style: { display: 'grid', gap: 8 } },
            PRESETS.map((p) =>
              h(
                'button',
                {
                  key: p.value,
                  type: 'button',
                  'data-testid': `pt-preset-${p.value}`,
                  'aria-pressed': doc.theme.preset === p.value,
                  onClick: () => patch((n) => { n.theme.preset = p.value; }),
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    borderRadius: 8,
                    background: doc.theme.preset === p.value ? '#f0f7ff' : '#fff',
                    border: `1px solid ${doc.theme.preset === p.value ? '#1677ff' : '#e5e7eb'}`,
                  },
                },
                h('span', { style: { width: 16, height: 16, borderRadius: 4, background: p.color } }),
                h('span', { style: { fontSize: 13, fontWeight: 500 } }, p.label),
                h('span', { style: { fontSize: 11, color: '#8c8c8c' } }, p.hint),
                h('span', { style: { flex: 1 } }),
                doc.theme.preset === p.value ? h(Tag, { color: 'blue' }, '当前') : null,
              ),
            ),
          ),
          h('div', { style: HINT }, '只影响颜色变量，不改变排版、字号与触控尺寸。M1 只提供"实心按钮"。'),
        ),

        h(
          'div',
          { style: { ...CARD, marginTop: 12 } },
          h('div', { style: SECTION }, '页面文案'),
          h(
            'div',
            { style: FIELD },
            h('div', { style: LABEL }, '媒体帮助文案'),
            h(Input, {
              value: doc.copy.media_help,
              maxLength: 40,
              'data-testid': 'pt-media-help',
              onChange: (e: any) => patch((n) => { n.copy.media_help = e.target.value; }),
            }),
            h(
              'div',
              { style: HINT },
              `显示在媒体卡片下方；0–40 字（当前 ${len(doc.copy.media_help)}）。不得改变"文字或材料任选一种"的规则。`,
            ),
          ),
          h('div', { style: HINT }, '报修引导 / 投诉引导 / 成功页说明按裁决留到 M2。'),
        ),

        h(
          'div',
          { style: { ...CARD, marginTop: 12 } },
          h('div', { style: SECTION }, '模块展示'),
          h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: doc.modules.media_help,
              'data-testid': 'pt-module-media-help',
              onChange: (e: any) => patch((n) => { n.modules.media_help = Boolean(e.target.checked); }),
              style: { width: 16, height: 16 },
            }),
            h('span', { style: { fontSize: 13 } }, '显示媒体帮助条'),
          ),
          h('div', { style: HINT }, '只控制这条提示的显隐；媒体采集能力本身不可关闭。'),
        ),

        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' } },
          h(Button, { type: 'primary', loading: saving, 'data-testid': 'pt-save', onClick: () => void save() }, '保存草稿'),
          h(Button, { onClick: () => void preview(), 'data-testid': 'pt-preview', disabled: !payload.draft }, '刷新预览'),
          h(
            Button,
            { type: 'primary', danger: true, loading: publishing, 'data-testid': 'pt-publish', onClick: publish, disabled: dirty || diff.length === 0 },
            '发布',
          ),
        ),
        h(
          'div',
          { style: HINT },
          dirty ? '有未保存修改：请先保存草稿，发布按钮才会启用。' : '发布前会显示实际变更；发布后客户下次打开即生效。',
        ),
      ),

      // ---------------------------------------------------------- 右：预览
      h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: 13 } }, '预览'),
          SegButton({ active: previewMode === 'repair', onClick: () => setPreviewMode('repair'), testid: 'pt-mode-repair', children: '报修' }),
          SegButton({ active: previewMode === 'complaint', onClick: () => setPreviewMode('complaint'), testid: 'pt-mode-complaint', children: '投诉' }),
          h('span', { style: { width: 8 } }),
          [375, 390, 420].map((w) =>
            SegButton({ active: frameWidth === w, onClick: () => setFrameWidth(w), testid: `pt-width-${w}`, children: String(w) }),
          ),
          previewAt ? h('span', { style: { fontSize: 11, color: '#8c8c8c' } }, `凭证有效至 ${fmtTime(previewAt)}`) : null,
        ),
        previewError ? h(Alert, { type: 'warning', showIcon: true, message: previewError, style: { marginBottom: 8 } }) : null,
        h(
          'div',
          {
            style: {
              background: '#f0f2f5',
              border: '1px solid #e8e8e8',
              borderRadius: 10,
              padding: 12,
              display: 'flex',
              justifyContent: 'center',
            },
          },
          h('iframe', {
            ref: iframeRef,
            src: '/h5/report?uiPreview=1',
            title: '客户页面预览',
            'data-testid': 'pt-preview-frame',
            onLoad: postPreview,
            style: { width: frameWidth, height: 720, border: '1px solid #d9d9d9', borderRadius: 8, background: '#fff' },
          }),
        ),
        h(
          'div',
          { style: HINT },
          '预览是真实 H5 页面：结构、字段、媒体入口都与线上一致；提交与采集已禁用，不产生工单/短信/上传。',
        ),
      ),
    ),

    // ---------------------------------------------------------- 发布历史
    h(
      'div',
      { style: { ...CARD, marginTop: 16 } },
      h('div', { style: SECTION }, `发布历史（${releases.length} 条）`),
      releases.length === 0
        ? h('div', { style: { fontSize: 13, color: '#8c8c8c' }, 'data-testid': 'pt-history-empty' }, '还没有发布记录')
        : h(
            'table',
            { style: { width: '100%', borderCollapse: 'collapse', fontSize: 13 }, 'data-testid': 'pt-history' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                ['版本', '发布时间', '发布人', '说明', '操作'].map((t) =>
                  h(
                    'th',
                    { key: t, style: { textAlign: 'left', padding: '6px 8px', background: '#fafafa', fontWeight: 500, color: '#595959' } },
                    t,
                  ),
                ),
              ),
            ),
            h(
              'tbody',
              null,
              releases.map((r) =>
                h(
                  'tr',
                  { key: r.version, 'data-testid': `pt-history-row-${r.version}` },
                  h(
                    'td',
                    { style: { padding: '6px 8px', borderTop: '1px solid #f0f0f0' } },
                    `v${r.version}${r.rolled_back_from ? `（回滚自 v${r.rolled_back_from}）` : ''}`,
                  ),
                  h('td', { style: { padding: '6px 8px', borderTop: '1px solid #f0f0f0' } }, fmtTime(r.published_at)),
                  h('td', { style: { padding: '6px 8px', borderTop: '1px solid #f0f0f0' } }, r.published_by ?? '—'),
                  h('td', { style: { padding: '6px 8px', borderTop: '1px solid #f0f0f0' } }, r.note ?? '—'),
                  h(
                    'td',
                    { style: { padding: '6px 8px', borderTop: '1px solid #f0f0f0' } },
                    h(Button, { size: 'small', 'data-testid': `pt-rollback-${r.version}`, onClick: () => rollback(r) }, '回滚到此版本'),
                  ),
                ),
              ),
            ),
          ),
    ),
  );
}

export function buildPageThemeModel(deps: { BaseBlockModel: any; request: Requester }): Record<string, any> {
  const { BaseBlockModel, request } = deps;
  if (!BaseBlockModel) return {};
  class PageThemeModel extends BaseBlockModel {
    render(): any {
      return h(PageTheme, { request });
    }
  }
  Object.defineProperty(PageThemeModel, 'name', { value: 'PageThemeModel' });
  return { PageThemeModel };
}
