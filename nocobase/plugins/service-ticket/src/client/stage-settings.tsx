/**
 * `StageSettingsModel` —— R2.2.1 §八：后台「施工阶段设置」页。
 *
 * ===========================================================================
 * 用户对本页的六条硬约束（逐条对应代码）
 * ===========================================================================
 *   ① 「管理与设置」下新增            → 页面路由由 `scripts/seed-stage-settings-page.mjs`
 *                                     播种（导航组 `售后工单`），并登记进
 *                                     `menu-groups.ts` 的 `GROUP_ADMIN.pages`
 *   ② **固定六行**（顺序/名称/说明/修改）→ 六行由服务端 `ARCHIVE_STAGE_ORDER` 决定；
 *                                     本页**不渲染任何增删按钮**
 *   ③ 仅授权管理员可改               → 服务端写动作要 `CAPABILITY.ADMIN`（仅 hq_admin）；
 *                                     读动作登录即可。前端**不猜权限**：
 *                                     `canEdit` 由服务端返回的 `can_edit` 决定
 *   ④ **保存即生效**                 → 保存后立刻重读接口，不缓存、无"发布"步骤
 *   ⑤ **不做版本流程**               → 没有草稿态/发布态；但**留审计**
 *                                     （服务端同事务写 `configChangeAudits`）
 *   ⑥ 固定六个 `stage_code` 与顺序   → 提交只送 `{code, name, description}`，
 *                                     `code`/`order` 只读展示，用户改不了
 *
 * ===========================================================================
 * 🔴 本页**不碰**任何档案数据
 * ===========================================================================
 *   用户原话：「改显示名不重写档案数据、不改员工备注、不删历史；
 *   **配置修改不需要重建移动端**」。
 *   ⇒ 这里只调 `svc:archiveStageConfigGet` / `svc:archiveStageConfigSave`，
 *     一行都不碰 `service_archives` / `service_archive_stages` / `service_archive_events`。
 *     移动端每次进暖通档案都读同一份配置，所以改名**即时生效**，
 *     不需要重新构建 `src-mobile/dist`。
 *
 * ===========================================================================
 * 为什么不用原生表格 + 行内编辑
 * ===========================================================================
 *   `serviceSettings` 原生写权限**一个角色都没给**（见 constants.ts 的
 *   `HQ_ADMIN_EXTRA_READ_RESOURCES` 注释：写只有 `svc:updateSetting` 这条受控路径）。
 *   而且六个阶段必须**整体提交**（局部提交会让"清空名字"与"不传名字"语义合并），
 *   原生表格是"一行一次写"，形状根本对不上。
 *
 * ===========================================================================
 * ⚠️ 与仓库其它客户端文件保持同一写法（函数组件 + `React.createElement`）
 * ===========================================================================
 *   初版用了 `class ... extends require('react').Component`，那是**错误**的：
 *   `react` 在本仓库是**无体声明** stub（`types/ambient-stubs.d.ts` 只有一行
 *   `declare module 'react'`），`require('react').Component` 的类型是 `any`，
 *   而 class 上声明 `state`/`props` 字段会与基类的 `any` 成员冲突，
 *   在 `tsc` 里表现为新增诊断 ⇒ BUILD-TS-GATE-01 判红、不构建。
 *   既有后台区块（`service-archives-admin-model.tsx` / `sms-center.tsx` …）
 *   一律是 `import React from 'react'` + 函数组件 + `h(...)`，这里照此办。
 *
 *   ⚠️ 同样不写 `React.useState<X>()` 泛型：无体 stub 下会触发 TS2347
 *      （Untyped function calls may not accept type arguments）—— 属于新增诊断。
 *      用字面量推断 + `as` 收窄。
 */
import React from 'react';
import { Alert, Button, Input, Space, Tag, message } from 'antd';
import { newRequestId, sendSvcRequest } from '../shared/svc-request';

type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

interface StageRow {
  code: string;
  order: number;
  name: string;
  description: string;
}

const h = React.createElement;

const CARD = { border: '1px solid #f0f0f0', borderRadius: 8, padding: 14, background: '#fff' };
const TH = {
  textAlign: 'left',
  padding: '8px 10px',
  background: '#fafafa',
  fontSize: 12,
  color: '#595959',
  whiteSpace: 'nowrap',
};
const TD = { padding: '8px 10px', borderTop: '1px solid #f0f0f0', fontSize: 13, verticalAlign: 'middle' };
const HINT = { fontSize: 11.5, color: '#8c8c8c', marginTop: 8, lineHeight: 1.7 };

function unwrap(res: any): any {
  // ⚠️ dataWrapping 包了一层 `{data: {...}}`，某些路径会再包一次。
  //    两种都认，避免"接口 200 但表格永远空"。
  return res?.data?.data ?? res?.data ?? res;
}

function errText(e: any): { status: number | null; code: string | null; message: string } {
  return {
    status: Number(e?.response?.status ?? e?.status ?? 0) || null,
    code: e?.response?.data?.errors?.[0]?.code ?? null,
    message: String(e?.response?.data?.errors?.[0]?.message ?? e?.message ?? e ?? '未知错误'),
  };
}

function StageSettings({ request }: { request: Requester }) {
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [source, setSource] = React.useState('default');
  const [updatedAt, setUpdatedAt] = React.useState(null);
  // 🔴 `can_edit` 来自**服务端**，不是前端猜角色：
  //    本页读动作登录即可，但写只有 hq_admin。前端若自行判 "我是管理员"，
  //    在授权口径变化时会显示一个永远点不动的按钮（或更糟：显示"只读"而其实能写）。
  const [canEdit, setCanEdit] = React.useState(false);
  const [err, setErr] = React.useState(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const payload = unwrap(await request('svc:archiveStageConfigGet', 'get')) as any;
      const list: StageRow[] = Array.isArray(payload?.stages) ? payload.stages : [];
      setRows(
        list.map((s: any) => ({
          code: String(s.code ?? ''),
          order: Number(s.order ?? 0),
          name: String(s.name ?? ''),
          description: String(s.description ?? ''),
        })) as never,
      );
      setSource(String(payload?.source ?? 'default'));
      setUpdatedAt(typeof payload?.updated_at === 'string' ? payload.updated_at : null);
      setCanEdit(Boolean(payload?.can_edit));
    } catch (e: any) {
      const t = errText(e);
      setErr(`读取阶段配置失败（${t.status ?? '?'}）：${t.message}`);
    } finally {
      setLoading(false);
    }
  }, [request]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const patchRow = React.useCallback((code: string, patch: Partial<StageRow>) => {
    setRows((prev: StageRow[]) => prev.map((r) => (r.code === code ? { ...r, ...patch } : r)));
  }, []);

  const save = React.useCallback(async () => {
    const list = rows as StageRow[];
    // 客户端先挡一次空名字：服务端也会 422，但让用户等一个来回没必要
    const empty = list.find((r) => !String(r.name ?? '').trim());
    if (empty) {
      message.error(`第 ${empty.order} 步的阶段名称不能为空`);
      return;
    }
    setSaving(true);
    try {
      await sendSvcRequest(request, {
        action: 'archiveStageConfigSave',
        // 只送可写字段：`code` 定身份，`order` 由服务端常量决定（送不送都不影响）
        body: {
          stages: list.map((r) => ({
            code: r.code,
            name: r.name.trim(),
            description: String(r.description ?? '').trim(),
          })),
        },
        requestId: newRequestId(),
      });
      message.success('已保存，所有页面立即使用新名称');
      // ④ 保存即生效：立刻重读，而不是拿本地 state 假装成功
      await load();
    } catch (e: any) {
      const t = errText(e);
      message.error(`保存失败（${t.status ?? '?'}${t.code ? ` ${t.code}` : ''}）：${t.message}`);
    } finally {
      setSaving(false);
    }
  }, [rows, request, load]);

  if (loading && (rows as StageRow[]).length === 0) {
    return h('div', { style: { padding: 16, color: '#8c8c8c' }, 'data-testid': 'stage-settings-loading' }, '加载施工阶段…');
  }

  const list = rows as StageRow[];

  return h(
    'div',
    { 'data-testid': 'stage-settings-page' },
    h(Alert, {
      type: 'info',
      showIcon: true,
      style: { marginBottom: 12 },
      message: '改的是「名称和说明」，不是阶段本身',
      description:
        '保存后所有页面立即使用新名称。阶段固定为六步、顺序不变、不能增删；改名不会改动任何已有档案的施工日期、员工备注和历史记录，也不需要重新发布手机端。',
    }),
    err ? h(Alert, { type: 'error', showIcon: true, style: { marginBottom: 12 }, message: err }) : null,

    h(
      'div',
      { style: CARD },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' } },
        h(Tag, { color: 'blue' }, '六个施工阶段'),
        h(
          'span',
          { style: { fontSize: 11.5, color: '#8c8c8c' }, 'data-testid': 'stage-settings-source' },
          source === 'database'
            ? `当前使用后台配置${updatedAt ? `（更新于 ${String(updatedAt).replace('T', ' ').slice(0, 16)}）` : ''}`
            : '当前使用系统默认名称（还没有保存过配置）',
        ),
        h('span', { style: { flex: 1 } }),
        canEdit
          ? h(
              Space,
              null,
              h(Button, { size: 'small', onClick: () => void load(), disabled: saving }, '重新读取'),
              h(
                Button,
                {
                  size: 'small',
                  type: 'primary',
                  loading: saving,
                  onClick: () => void save(),
                  'data-testid': 'stage-settings-save',
                },
                '保存',
              ),
            )
          : h('span', { style: { fontSize: 11.5, color: '#8c8c8c' }, 'data-testid': 'stage-settings-readonly' }, '当前账号只能查看'),
      ),

      h(
        'table',
        { style: { width: '100%', borderCollapse: 'collapse' }, 'data-testid': 'stage-settings-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            ['顺序', '阶段代码', '阶段名称', '阶段说明'].map((t) => h('th', { key: t, style: TH }, t)),
          ),
        ),
        h(
          'tbody',
          null,
          list.map((r) =>
            h(
              'tr',
              { key: r.code, 'data-testid': `stage-row-${r.code}` },
              // 🔴 顺序**不可编辑**：用户裁决「固定六个 stage_code 与顺序，不允许增删」。
              //    这里连输入框都不给 —— 让"能不能改"这件事在界面上就不含糊。
              h('td', { style: TD }, h(Tag, null, `第 ${r.order} 步`)),
              h('td', { style: TD }, h('code', { style: { fontSize: 12, color: '#8c8c8c' } }, r.code)),
              h(
                'td',
                { style: { ...TD, width: 220 } },
                h(Input, {
                  value: r.name,
                  maxLength: 12,
                  disabled: !canEdit,
                  'data-testid': `stage-name-${r.code}`,
                  onChange: (e: any) => patchRow(r.code, { name: e.target.value }),
                }),
              ),
              h(
                'td',
                { style: TD },
                h(Input.TextArea, {
                  value: r.description,
                  maxLength: 60,
                  autoSize: { minRows: 1, maxRows: 3 },
                  disabled: !canEdit,
                  placeholder: '可不填',
                  'data-testid': `stage-desc-${r.code}`,
                  onChange: (e: any) => patchRow(r.code, { description: e.target.value }),
                }),
              ),
            ),
          ),
        ),
      ),

      h(
        'div',
        { style: HINT },
        // ⚠️ 这里是 React 文本节点，**不解析 markdown**。强调一律用「」。
        '名称最多 12 个字，说明最多 60 个字。手机端「新建暖通」的六阶段图与档案详情里的阶段名都读这份配置。',
        h('br'),
        '只改显示文字：已有档案的施工日期、备注、照片和历史事件都不受影响；旧名称也不会出现在新打开的页面里。',
      ),
    ),
  );
}

export function buildStageSettingsModel(deps: { BaseBlockModel: any; request: Requester }): Record<string, any> {
  const { BaseBlockModel, request } = deps;
  if (!BaseBlockModel) return {};
  class StageSettingsModel extends BaseBlockModel {
    render(): any {
      return h(StageSettings, { request });
    }
  }
  Object.defineProperty(StageSettingsModel, 'name', { value: 'StageSettingsModel' });
  return { StageSettingsModel };
}
