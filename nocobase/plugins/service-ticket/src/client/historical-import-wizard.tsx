/**
 * P11-3 第 3 项：**历史 Excel 导入向导**（后台界面）
 * =============================================================================
 *
 * 门店人员要走的七步，全部在这一个弹窗里：
 *   选文件 → 看识别到的工作表与行数 → 选表头行 → 把 Excel 的列对上业务字段
 *   → 看「清洗前 / 清洗后」对照 → 看异常清单与原因 → 改映射重新校验 → 安全暂存
 *
 * ===========================================================================
 * 三条界面纪律（用户第 3 条）
 * ===========================================================================
 *  ① **非技术人员看得懂**：预览里出现的是"客户姓名、联系电话"这类中文标签，
 *     不出现 JSON、不出现数据库列名、不出现字段元数据。
 *  ② **不同文件的列顺序可以不一样**：映射是"这个字段用第几列"的逐字段选择，
 *     不是"第 1 列必须是姓名"的位置约定 —— 七份真实门店文件的表头本来就各不相同。
 *  ③ **自动映射错了必须能看出来、能改**：同一字段命中多列时（真实样本：康乐 Sheet2
 *     的「用户电话」与「手机号」），界面**直接把候选列摆出来让人选**，
 *     而不是悄悄取第一个 —— 取第一个就会把 104 行有电话的数据读成"没电话"。
 *
 * ===========================================================================
 * 🔴 这个弹窗**不做**什么
 * ===========================================================================
 *   · 不选门店、不写归属：门店归属未确认，界面上**根本没有**门店下拉；
 *   · 不创建工单：暂存只是"存进隔离区"，文案里明确写"未生成任何服务单"；
 *   · 不合并重复：疑似重复只标出来，不自动并。
 */
// ⚠️ 这里**刻意没有** `Table`：antd 是浏览器侧的 AMD 依赖（服务端 node_modules 里
//    根本没有 antd），无法离线核实它是否具名导出 `Table`。而 P11-3 的门禁规则
//    明令"不得把成员直接塞进白名单而不核实"—— 那等于把一条真断言改成一句谎话。
//    ⇒ 预览表用**朴素 HTML table** 渲染（它本来就只是只读对照，不需要排序/分页），
//      既避开了未核实的导入，也让门店人员看到的排版更可控。
import { Alert, Button, Input, Select, Space, Tag, message } from 'antd';
// ⚠️ 全部 UI 组件从 `antd` 取（DEV-147）：`@nocobase/client` 不导出它们。
import React from 'react';

import { openClosableModal } from './modal-kit';

type Requester = (
  url: string,
  method?: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; responseType?: string },
) => Promise<any>;

/** 业务字段（由服务端 `historicalUpload` 的 mappingFields 下发；这里是**兜底**，防止接口没给） */
const FALLBACK_FIELDS: Array<{ field: string; label: string; hint: string }> = [
  { field: 'customerName', label: '客户姓名', hint: '' },
  { field: 'customerPhone', label: '联系电话', hint: '' },
  { field: 'customerAddress', label: '服务地址', hint: '' },
  { field: 'device', label: '牌名型号', hint: '' },
  { field: 'quantity', label: '数量', hint: '' },
  { field: 'serviceKind', label: '服务性质', hint: '' },
  { field: 'purchaseDate', label: '购机日期', hint: '' },
  { field: 'deliveryDate', label: '配送/安装日期', hint: '' },
  { field: 'receiveDate', label: '接件日期', hint: '' },
  { field: 'finishDate', label: '完工日期', hint: '' },
  { field: 'dispatchDate', label: '派单日期', hint: '' },
  { field: 'reviewDate', label: '回访日期', hint: '' },
  { field: 'fault', label: '报修故障', hint: '' },
  { field: 'measure', label: '维修措施', hint: '' },
  { field: 'technician', label: '服务人员', hint: '' },
  { field: 'reviewResult', label: '服务结果', hint: '' },
  { field: 'reviewNote', label: '回访记录', hint: '' },
  { field: 'storeHint', label: '销售单位', hint: '仅供参考，不会据此写归属门店' },
];

/** 分类的人话标签（与服务端 disposition 枚举逐项一致） */
const DISPOSITION_TAG: Record<string, { text: string; color: string }> = {
  importable: { text: '可导入候选', color: 'green' },
  'needs-confirm': { text: '需人工确认', color: 'orange' },
  duplicate: { text: '疑似重复', color: 'gold' },
  excluded: { text: '非售后排除', color: 'default' },
  'parse-error': { text: '解析错误', color: 'red' },
};

const CLASSIFICATION_TEXT: Record<string, string> = {
  'service-install': '安装类售后',
  'service-repair': '维修类售后',
  'sales-or-delivery': '销售 / 配送资料（不进售后）',
  'needs-review': '业务类型待确认',
};

/**
 * 上传用 FormData 而不是把文件读成 base64 塞进 JSON：
 * 20 MB 的文件做 base64 会胀到 ~27 MB 且多一次全量拷贝，
 * 而 multipart 由 axios 直接流式提交。
 */
async function uploadFile(
  request: Requester,
  file: any,
): Promise<any> {
  const form = new FormData();
  form.append('file', file, file.name);
  const payload = await request('svc:historicalUpload', 'post', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return payload?.data ?? payload;
}

export function buildHistoricalImportActionModel(deps: {
  ActionModel: any;
  ActionSceneEnum?: any;
  request: Requester;
  /** BE-02A-S3：页面入口用的 BlockModel 基类（ActionModel 挂不上 markdown，见下方 EntryPanel 注释） */
  BaseBlockModel?: any;
}): Record<string, any> {
  const { ActionModel, ActionSceneEnum, request, BaseBlockModel } = deps;
  if (!ActionModel) return {};

  interface Handle {
    hasUnsaved?: () => boolean;
  }

  function Wizard(props: { onClose: () => void; handle: Handle; refresh?: () => void }): any {
    const { onClose, handle, refresh } = props;

    const [busy, setBusy] = React.useState(false);
    const [step, setStep] = React.useState('pick');
    const [file, setFile] = React.useState(null);
    const [upload, setUpload] = React.useState(null);
    const [error, setError] = React.useState('');

    /** 当前选中的工作表名 */
    const [sheetName, setSheetName] = React.useState('');
    /** 表头行（1-based） */
    const [headerRow, setHeaderRow] = React.useState(1);
    /** 映射：逻辑字段 → 列下标（-1 = 不映射） */
    const [mapping, setMapping] = React.useState({} as Record<string, number>);
    const [preview, setPreview] = React.useState(null);
    const [staged, setStaged] = React.useState(null);
    /** B：概览（含"需要人工确认的**唯一记录数**"与异常类型） */
    const [summary, setSummary] = React.useState(null);
    /** B：逐行核对（原始值 / 机器值 / 人工值 / 异常原因） */
    const [reviewRows, setReviewRows] = React.useState([]);
    /** C：跨文件疑似重复 */
    const [dups, setDups] = React.useState(null);
    /** D：归档前置（门店 + 范围）与结果 */
    const [attribution, setAttribution] = React.useState({
      storeCode: '',
      // ⚠️ 默认**正式归属**（保守）：点下去会被拒，而"被拒的理由"正是要给人看到的东西。
      scope: 'production',
    });
    const [archiveResult, setArchiveResult] = React.useState(null);

    const fields: Array<{ field: string; label: string; hint: string }> =
      upload?.mappingFields ?? FALLBACK_FIELDS;
    const sheet = (upload?.sheets ?? []).find((s: any) => s.sheet === sheetName) ?? null;

    handle.hasUnsaved = () => file !== null || upload !== null;

    // ---------------------------------------------------------------- 上传
    const doUpload = async (): Promise<void> => {
      if (!file) {
        setError('请先选择一份 Excel 文件（.xlsx 或 .xls）');
        return;
      }
      setBusy(true);
      setError('');
      try {
        const data = await uploadFile(request, file);
        setUpload(data);
        const first = (data?.sheets ?? [])[0];
        if (first) {
          setSheetName(first.sheet);
          setHeaderRow(Number(first.headerRow ?? 1));
          setMapping({ ...(first.autoMapping ?? {}) });
        }
        setStep('map');
        if (data?.batch?.reused) {
          message.info('这份文件此前已经上传过，已直接打开原批次（不会重复生成）');
        }
      } catch (e: any) {
        setError(
          e?.response?.data?.errors?.[0]?.message ??
            e?.response?.data?.message ??
            e?.message ??
            '上传失败',
        );
      } finally {
        setBusy(false);
      }
    };

    // ---------------------------------------------------------------- 预览
    const doPreview = async (): Promise<void> => {
      if (!upload?.batch?.id || !sheetName) return;
      setBusy(true);
      setError('');
      try {
        const fields_: Record<string, number> = {};
        for (const [k, v] of Object.entries(mapping)) {
          if (typeof v === 'number' && v >= 0) fields_[k] = v;
        }
        const payload = await request('svc:historicalPreview', 'post', {
          batchId: upload.batch.id,
          sheets: [{ sheetName, headerRow, fields: fields_ }],
          limit: 20,
        });
        setPreview(payload?.data ?? payload);
        setStep('preview');
      } catch (e: any) {
        setError(
          e?.response?.data?.errors?.[0]?.message ??
            e?.response?.data?.message ??
            e?.message ??
            '预览失败',
        );
      } finally {
        setBusy(false);
      }
    };

    // ---------------------------------------------------------------- 暂存
    const doStage = async (): Promise<void> => {
      if (!upload?.batch?.id || !sheetName) return;
      setBusy(true);
      setError('');
      try {
        const fields_: Record<string, number> = {};
        for (const [k, v] of Object.entries(mapping)) {
          if (typeof v === 'number' && v >= 0) fields_[k] = v;
        }
        const payload = await request('svc:historicalStage', 'post', {
          batchId: upload.batch.id,
          sheets: [{ sheetName, headerRow, fields: fields_ }],
        });
        setStaged(payload?.data ?? payload);
        message.success('已安全暂存（未生成任何服务单，也未确定门店归属）');
        try {
          refresh?.();
        } catch {
          /* 刷新失败不影响"已暂存"这个事实 */
        }
      } catch (e: any) {
        setError(
          e?.response?.data?.errors?.[0]?.message ??
            e?.response?.data?.message ??
            e?.message ??
            '暂存失败',
        );
      } finally {
        setBusy(false);
      }
    };

    // ---------------------------------------------------------------- 异常确认 / 去重 / 归档
    /**
     * 拉取核对数据。
     *
     * ⚠️ `gotoReview` 控制**是否跳转**到异常确认步骤。
     *    第一版没有这个参数、总是 `setStep('review')`，于是
     *    「在归档步骤里点了『确认归属』」→ 刷新数据 → **界面被弹回异常确认步骤**
     *    → 紧接着要点的「确认归档」按钮**根本不存在**（点了没反应，也没有报错）。
     *    实测由浏览器门禁抓到（断言"归档成功"恒为假，而接口侧明明是好的）。
     */
    const loadReview = async (gotoReview = true): Promise<void> => {
      if (!upload?.batch?.id) return;
      setBusy(true);
      setError('');
      try {
        const s1 = await request(`svc:historicalReviewSummary?batchId=${upload.batch.id}`, 'get');
        setSummary((s1?.data ?? s1) ?? null);
        const s2 = await request(`svc:historicalBatches?batchId=${upload.batch.id}&limit=200`, 'get');
        setReviewRows((((s2?.data ?? s2) ?? {}).candidates ?? []) as any[]);
        const s3 = await request('svc:historicalDuplicates', 'get');
        setDups((s3?.data ?? s3) ?? null);
        if (gotoReview) setStep('review');
      } catch (e: any) {
        setError(e?.response?.data?.errors?.[0]?.message ?? e?.message ?? '读取核对信息失败');
      } finally {
        setBusy(false);
      }
    };

    const doReview = async (candidateId: number, action: string): Promise<void> => {
      if (!upload?.batch?.id) return;
      setBusy(true);
      setError('');
      try {
        await request('svc:historicalReviewRow', 'post', { batchId: upload.batch.id, candidateId, action });
        message.success(action === 'confirm' ? '已确认这一行' : '已记录你的判断');
        await loadReview();
      } catch (e: any) {
        setError(e?.response?.data?.errors?.[0]?.message ?? e?.message ?? '操作失败');
      } finally {
        setBusy(false);
      }
    };

    const doConfirmAttribution = async (): Promise<void> => {
      if (!upload?.batch?.id) return;
      setBusy(true);
      setError('');
      try {
        await request('svc:historicalConfirmAttribution', 'post', {
          batchId: upload.batch.id,
          storeCode: attribution.storeCode,
          scope: attribution.scope,
        });
        message.success(
          `已确认归属：${attribution.storeCode}（${attribution.scope === 'drill' ? '演练范围' : '正式范围'}）`,
        );
        // ⚠️ `false`：刷新数据但**留在归档步骤**（见 loadReview 的说明）
        await loadReview(false);
      } catch (e: any) {
        setError(e?.response?.data?.errors?.[0]?.message ?? e?.message ?? '确认归属失败');
      } finally {
        setBusy(false);
      }
    };

    const doArchiveNow = async (): Promise<void> => {
      if (!upload?.batch?.id) return;
      setBusy(true);
      setError('');
      try {
        const payload = await request('svc:historicalArchive', 'post', { batchId: upload.batch.id });
        setArchiveResult((payload?.data ?? payload) ?? null);
        message.success('已归档到历史售后档案（未生成任何当前服务单）');
        refresh?.();
      } catch (e: any) {
        setError(e?.response?.data?.errors?.[0]?.message ?? e?.message ?? '归档失败');
      } finally {
        setBusy(false);
      }
    };

    // ---------------------------------------------------------------- 渲染
    const colOptions = (sheet?.header ?? []).map((h: string, i: number) => ({
      value: i,
      label: `第 ${i + 1} 列 · ${String(h ?? '').trim() || '（空表头）'}`,
    }));
    const colOptionsWithNone = [{ value: -1, label: '不导入这一项' }, ...colOptions];

    const counts = preview?.sheets?.[0]?.counts ?? {};
    const quality = preview?.sheets?.[0]?.quality ?? {};
    const previewRows: any[] = preview?.sheets?.[0]?.preview ?? [];

    /** 一行的"清洗前 / 清洗后 / 需要留意"三栏（朴素表格，不用 antd.Table） */
    const renderPreviewRow = (r: any) => {
      const st = r?.standardized ?? {};
      const t = DISPOSITION_TAG[r?.disposition] ?? { text: r?.disposition, color: 'default' };
      const rawEntries = Object.entries(r?.raw ?? {}).slice(0, 6);
      return React.createElement(
        'tr',
        { key: r.sourceRow },
        React.createElement(
          'td',
          { style: { whiteSpace: 'nowrap' } },
          React.createElement('span', { 'data-testid': 'hi-row-no' }, r.sourceRow),
        ),
        React.createElement(
          'td',
          { style: { whiteSpace: 'nowrap' } },
          React.createElement(Tag, { color: t.color, 'data-testid': 'hi-disposition' }, t.text),
        ),
        React.createElement(
          'td',
          { 'data-testid': 'hi-raw', style: { color: '#595959' } },
          rawEntries.length === 0
            ? '（这一行没有映射到的列）'
            : rawEntries.map(([k, v], i) =>
                React.createElement(
                  'div',
                  { key: i, style: { fontSize: 12 } },
                  `${k}：${v === null || v === '' ? '（空）' : String(v)}`,
                ),
              ),
        ),
        React.createElement(
          'td',
          { 'data-testid': 'hi-standardized' },
          React.createElement(
            'div',
            { style: { fontSize: 12 } },
            `姓名：${st?.customerName ?? '（未取到）'}`,
          ),
          React.createElement(
            'div',
            { style: { fontSize: 12 } },
            `电话：${
              (st?.customerPhones ?? []).length === 0
                ? '（未取到）'
                : (st.customerPhones as any[])
                    .map((p: any) => `${p.masked}${p.valid ? '' : '（号码形态异常）'}`)
                    .join(' / ')
            }`,
          ),
          st?.devices?.length
            ? React.createElement(
                'div',
                { style: { fontSize: 12 } },
                `设备：${(st.devices as any[]).map((d: any) => d.model).join(' / ')}`,
              )
            : null,
          Object.entries(st?.dates ?? {})
            .slice(0, 3)
            .map(([k, d]: [string, any], i: number) =>
              React.createElement(
                'div',
                { key: i, style: { fontSize: 12, color: d?.iso ? undefined : '#d46b08' } },
                `${k}：${d?.iso ?? `保留原值「${d?.raw ?? ''}」（${d?.basis ?? ''}）`}`,
              ),
            ),
        ),
        React.createElement(
          'td',
          null,
          (r?.issues ?? []).length === 0
            ? React.createElement('span', { style: { color: '#8c8c8c' } }, '—')
            : React.createElement(
                'div',
                { 'data-testid': 'hi-issues' },
                (r.issues as string[]).map((s: string, i: number) =>
                  React.createElement(
                    'div',
                    { key: i, style: { fontSize: 12, color: '#d46b08' } },
                    `· ${s}`,
                  ),
                ),
              ),
        ),
      );
    };

    return React.createElement(
      'div',
      { 'data-testid': 'historical-import-wizard' },
      React.createElement(Alert, {
        type: 'info',
        showIcon: true,
        style: { marginBottom: 12 },
        message: '导入的是历史 Excel，先进入隔离暂存区',
        description:
          '本步骤不会生成任何服务单，也不会确定这批数据属于哪家门店（门店对应关系还在确认中）。',
      }),
      error
        ? React.createElement(Alert, {
            type: 'error',
            showIcon: true,
            style: { marginBottom: 12 },
            message: error,
            'data-testid': 'hi-error',
          })
        : null,

      // ---------------- 第一步：选文件 ----------------
      step === 'pick'
        ? React.createElement(
            'div',
            null,
            React.createElement(Input, {
              type: 'file',
              accept: '.xlsx,.xls',
              'data-testid': 'hi-file',
              onChange: (e: any) => {
                const f = e?.target?.files?.[0] ?? null;
                setFile(f ?? null);
                setUpload(null);
                setPreview(null);
                setStaged(null);
              },
            }),
            React.createElement(
              'div',
              { style: { color: '#8c8c8c', fontSize: 12, marginTop: 6 } },
              '支持 .xlsx / .xls，单个文件不超过 20MB。文件内容会被识别真实类型，改扩展名没用。',
            ),
          )
        : null,

      // ---------------- 第二步：识别结果 + 映射 ----------------
      step !== 'pick' && upload
        ? React.createElement(
            'div',
            null,
            React.createElement(
              'div',
              { style: { marginBottom: 10 } },
              React.createElement(Space, { wrap: true }, [
                React.createElement(Tag, { key: 'b', color: 'blue' }, `批次 ${upload.batch?.batchNo ?? ''}`),
                React.createElement(
                  Tag,
                  { key: 'v', color: 'purple' },
                  `解析器 ${upload.batch?.parserVersion ?? ''}`,
                ),
                React.createElement(
                  Tag,
                  { key: 's' },
                  `共识别 ${upload.sheets?.length ?? 0} 张工作表 / ${upload.totals?.dataRows ?? 0} 行数据`,
                ),
              ]),
            ),
            // 台账（人话版）
            upload.ledger
              ? React.createElement(
                  Alert,
                  {
                    type: 'info',
                    style: { marginBottom: 10 },
                    'data-testid': 'hi-ledger',
                    message: `行数核对：物理行 ${upload.ledger.excelRows} = 表头 ${upload.ledger.headerRows} + 重复表头 ${upload.ledger.repeatedHeaderRows} + 空行 ${upload.ledger.blankRows} + 售后 ${upload.ledger.afterSalesRows} + 排除 ${upload.ledger.excludedRows} + 待判 ${upload.ledger.undeterminedRows}`,
                    description: `其中售后 ${upload.ledger.afterSalesRows} 行、销售配送等排除 ${upload.ledger.excludedRows} 行。`,
                  },
                )
              : null,
            // 工作表选择
            React.createElement(
              'div',
              { style: { marginBottom: 8, fontWeight: 500 } },
              '选择工作表',
            ),
            React.createElement(Select, {
              value: sheetName || undefined,
              style: { width: '100%', marginBottom: 10 },
              'data-testid': 'hi-sheet',
              onChange: (v: string) => {
                const s = (upload?.sheets ?? []).find((x: any) => x.sheet === v);
                setSheetName(v);
                if (s) {
                  setHeaderRow(Number(s.headerRow ?? 1));
                  setMapping({ ...(s.autoMapping ?? {}) });
                }
                setPreview(null);
              },
              options: (upload?.sheets ?? []).map((s: any) => ({
                value: s.sheet,
                label: `${s.sheet} · ${CLASSIFICATION_TEXT[s.classification] ?? s.classification} · ${s.rowCount} 行`,
              })),
            }),
            sheet?.ambiguous?.length
              ? React.createElement(Alert, {
                  type: 'warning',
                  showIcon: true,
                  style: { marginBottom: 10 },
                  'data-testid': 'hi-ambiguous',
                  message: '这张表里有几个字段对应多列，请确认选的是哪一列',
                  description: (sheet.ambiguous as any[])
                    .map((a: any) => `${a.field}：${(a.headers as string[]).join(' / ')}`)
                    .join('；'),
                })
              : null,
            // 表头行
            React.createElement(
              'div',
              { style: { marginBottom: 4, fontWeight: 500 } },
              '表头在第几行',
            ),
            React.createElement(Select, {
              value: headerRow,
              style: { width: 160, marginBottom: 10 },
              'data-testid': 'hi-header-row',
              onChange: (v: number) => {
                setHeaderRow(v);
                setPreview(null);
              },
              options: [1, 2, 3, 4, 5].map((n) => ({ value: n, label: `第 ${n} 行` })),
            }),
            // 字段映射
            React.createElement(
              'div',
              { style: { marginBottom: 4, fontWeight: 500 } },
              '把 Excel 的列对上要导入的字段',
            ),
            React.createElement(
              'div',
              { style: { maxHeight: 260, overflowY: 'auto', border: '1px solid #f0f0f0', padding: 8 } },
              fields.map((f) =>
                React.createElement(
                  'div',
                  { key: f.field, style: { marginBottom: 6 } },
                  React.createElement(
                    'div',
                    { style: { fontSize: 12, marginBottom: 2 } },
                    f.label,
                    f.hint ? React.createElement('span', { style: { color: '#8c8c8c' } }, `（${f.hint}）`) : null,
                  ),
                  React.createElement(Select, {
                    value: mapping[f.field] ?? -1,
                    style: { width: '100%' },
                    size: 'small',
                    'data-testid': `hi-map-${f.field}`,
                    onChange: (v: number) => {
                      setMapping((prev) => ({ ...prev, [f.field]: v }));
                      setPreview(null);
                    },
                    options: colOptionsWithNone,
                  }),
                ),
              ),
            ),
          )
        : null,

      // ---------------- 第三步：预览 ----------------
      step === 'preview' && preview
        ? React.createElement(
            'div',
            null,
            React.createElement(Space, { wrap: true, style: { marginBottom: 8 } }, [
              React.createElement(Tag, { key: 'i', color: 'green' }, `可导入 ${counts.importable ?? 0}`),
              React.createElement(Tag, { key: 'n', color: 'orange' }, `需人工确认 ${counts['needs-confirm'] ?? 0}`),
              React.createElement(Tag, { key: 'd', color: 'gold' }, `疑似重复 ${counts.duplicate ?? 0}`),
              React.createElement(Tag, { key: 'e' }, `非售后排除 ${counts.excluded ?? 0}`),
              React.createElement(Tag, { key: 'p', color: 'red' }, `解析错误 ${counts['parse-error'] ?? 0}`),
            ]),
            React.createElement(
              'div',
              { style: { fontSize: 12, color: '#595959', marginBottom: 8 }, 'data-testid': 'hi-quality' },
              `字段质量：一格多号 ${quality.multiPhoneRows ?? 0} 行 · 日期含糊 ${quality.ambiguousDateRows ?? 0} 行 · 缺手机号 ${quality.missingPhoneRows ?? 0} 行 · 服务结果异常 ${quality.abnormalReviewRows ?? 0} 行`,
            ),
            previewRows.length === 0
              ? React.createElement(
                  'div',
                  { style: { color: '#8c8c8c', padding: 12 }, 'data-testid': 'hi-preview-empty' },
                  '这一张表按当前映射没有取到任何行。',
                )
              : React.createElement(
                  'div',
                  { style: { maxHeight: 300, overflow: 'auto', border: '1px solid #f0f0f0' } },
                  React.createElement(
                    'table',
                    { style: { width: '100%', borderCollapse: 'collapse' }, 'data-testid': 'hi-preview-table' },
                    React.createElement(
                      'thead',
                      null,
                      React.createElement(
                        'tr',
                        { style: { background: '#fafafa', textAlign: 'left' } },
                        ['Excel 行号', '分类', '清洗前（Excel 原值）', '清洗后（系统候选值）', '需要留意'].map(
                          (h, i) =>
                            React.createElement(
                              'th',
                              { key: i, style: { padding: '6px 8px', fontSize: 12, borderBottom: '1px solid #f0f0f0' } },
                              h,
                            ),
                        ),
                      ),
                    ),
                    React.createElement('tbody', null, previewRows.map(renderPreviewRow)),
                  ),
                ),
          )
        : null,

      // ---------------- 第四步：异常确认（用户 B 条）----------------
      step === 'review' && summary
        ? React.createElement(
            'div',
            { 'data-testid': 'hi-review' },
            React.createElement(
              'div',
              { style: { marginBottom: 8, fontWeight: 500 } },
              '这份文件的记录分类',
            ),
            React.createElement(Space, { wrap: true, style: { marginBottom: 8 } }, [
              React.createElement(Tag, { key: 'a', color: 'green', 'data-testid': 'hi-c-importable' }, `售后候选 ${summary.summary?.importableCount ?? 0}`),
              React.createElement(Tag, { key: 'b', 'data-testid': 'hi-c-excluded' }, `非售后排除 ${summary.summary?.excludedCount ?? 0}`),
              React.createElement(Tag, { key: 'c', color: 'gold', 'data-testid': 'hi-c-duplicate' }, `疑似重复 ${summary.summary?.duplicateCount ?? 0}`),
              React.createElement(Tag, { key: 'd', color: 'orange', 'data-testid': 'hi-c-needsconfirm' }, `需人工确认 ${summary.summary?.needsConfirmCount ?? 0}`),
            ]),
            // 🔴 两件事**必须分开显示**（用户第四项）：
            //    「必须处理」（阻塞归档） 与 「原值保留的提示」（不阻塞归档）。
            //    只给一个"异常命中 N 次"会让人读成"有 N 条要处理"，
            //    而真实情况常常是"必须处理 0 条 + 提示 105 条"。
            React.createElement(Alert, {
              type: summary.summary?.blockingUniqueRowCount > 0 ? 'warning' : 'success',
              style: { marginBottom: 8 },
              'data-testid': 'hi-anomaly-note',
              message:
                `**必须处理**：${summary.summary?.blockingUniqueRowCount ?? 0} 条（按原始行去重；` +
                `未处理完不允许归档）`,
              description:
                `其中需人工确认 ${summary.summary?.needsConfirmUniqueRowCount ?? 0} 条、` +
                `疑似重复 ${summary.summary?.duplicateCount ?? 0} 条。`,
            }),
            React.createElement(Alert, {
              type: 'info',
              style: { marginBottom: 10 },
              'data-testid': 'hi-advisory',
              message: `**原值保留的提示**：${summary.summary?.advisoryUniqueRowCount ?? 0} 条（不阻塞归档）`,
              description:
                `系统已按"保留原值"处理，不需要你做任何事 —— 例如日期缺年份就留空（不猜 20xx）、` +
                `服务结果「来电表扬」原样保留（不会改成"满意"）。` +
                `异常命中合计 ${summary.summary?.anomalyHitCount ?? 0} 次（同一行可命中多类，与行数不相等）。`,
            }),
            React.createElement(
              'div',
              { style: { fontSize: 12, marginBottom: 6, color: '#595959' }, 'data-testid': 'hi-anomaly-types' },
              `主要异常类型：${(summary.summary?.anomalyTypes ?? [])
                .map((t: any) => `${t.label} ${t.hitCount} 处（如第 ${(t.sampleRows ?? []).map((r: any) => r.sourceRow).join('、')} 行）`)
                .join('；') || '无'}`,
            ),
            React.createElement(
              'div',
              { style: { maxHeight: 220, overflow: 'auto', border: '1px solid #f0f0f0' } },
              React.createElement(
                'table',
                { style: { width: '100%', borderCollapse: 'collapse' }, 'data-testid': 'hi-review-table' },
                React.createElement(
                  'thead',
                  null,
                  React.createElement(
                    'tr',
                    { style: { background: '#fafafa', textAlign: 'left' } },
                    ['Excel 行号', '分类', '系统识别结果', '需要留意', '处理'].map((h, i) =>
                      React.createElement('th', { key: i, style: { padding: '6px 8px', fontSize: 12 } }, h),
                    ),
                  ),
                ),
                React.createElement(
                  'tbody',
                  null,
                  reviewRows.slice(0, 40).map((c: any) =>
                    React.createElement(
                      'tr',
                      { key: c.id, 'data-testid': 'hi-review-row' },
                      React.createElement('td', { style: { fontSize: 12, padding: '4px 8px' } }, c.sourceRow ?? ''),
                      React.createElement(
                        'td',
                        { style: { fontSize: 12, padding: '4px 8px' } },
                        (DISPOSITION_TAG[c.disposition] ?? { text: c.disposition }).text,
                      ),
                      React.createElement(
                        'td',
                        { style: { fontSize: 12, padding: '4px 8px' } },
                        `姓名 ${c.fields?.customerName ?? '（空）'} · 电话 ${
                          (c.fields?.customerPhones ?? []).map((p: any) => p.masked).join('/') || '（空）'
                        }${c.fields?.reviewResult?.raw ? ` · 服务结果「${c.fields.reviewResult.raw}」` : ''}`,
                      ),
                      React.createElement(
                        'td',
                        { style: { fontSize: 12, padding: '4px 8px', color: '#d46b08' } },
                        (c.issues ?? []).join('；') || '—',
                      ),
                      React.createElement(
                        'td',
                        { style: { padding: '4px 8px', whiteSpace: 'nowrap' } },
                        React.createElement(
                          Button,
                          {
                            size: 'small',
                            type: c.manualStatus === 'pending' ? 'primary' : 'default',
                            loading: busy,
                            'data-testid': `hi-confirm-${c.id}`,
                            onClick: () => void doReview(c.id, 'confirm'),
                          },
                          c.manualStatus === 'pending' ? '确认' : '已处理',
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            React.createElement(
              'div',
              { style: { fontSize: 12, color: '#8c8c8c', marginTop: 6 } },
              '修正只记录你的填写，**系统识别结果与 Excel 原值都不会被改动**；' +
                '「来电表扬」这类系统不认识的写法会原样保留，不会被改成"满意"。',
            ),
            dups
              ? React.createElement(Alert, {
                  type: 'warning',
                  style: { marginTop: 10 },
                  'data-testid': 'hi-dups',
                  message: `疑似重复：${dups.strongCount ?? 0} 处强证据 · ${dups.weakCount ?? 0} 处弱证据`,
                  description:
                    '仅提示，**不会自动合并、不会删除任何原始记录**。' +
                    '只凭手机号相同只能算弱证据 —— 同一客户可能有多次真实售后。',
                })
              : null,
          )
        : null,

      // ---------------- 第五步：确认归档（用户 D 条）----------------
      step === 'archive'
        ? React.createElement(
            'div',
            { 'data-testid': 'hi-archive' },
            React.createElement(Alert, {
              type: 'info',
              showIcon: true,
              style: { marginBottom: 10 },
              message: `当前归属：${summary?.batch?.attributionState === 'confirmed' ? '已确认' : '未确认'}`,
              description:
                '归档写入的是**独立的历史售后档案**，不是当前服务单；不会影响当前的工单数量与 SLA/KPI。',
            }),
            React.createElement(
              'div',
              { style: { marginBottom: 4, fontWeight: 500 } },
              '归属门店（只有身份已确认的门店才能承接）',
            ),
            React.createElement(Select, {
              value: attribution.storeCode || undefined,
              style: { width: '100%', marginBottom: 8 },
              placeholder: '请选择',
              'data-testid': 'hi-attribution-store',
              onChange: (v: string) => setAttribution((prev) => ({ ...prev, storeCode: v })),
              options: (summary?.confirmedStores ?? []).map((st: any) => ({
                value: st.code,
                label: `${st.code} · ${st.storeName}（${st.scope === 'drill' ? '演练范围' : '正式范围'}）`,
              })),
            }),
            React.createElement(
              'div',
              { style: { marginBottom: 4, fontWeight: 500 } },
              '归属范围',
            ),
            React.createElement(Select, {
              value: attribution.scope,
              style: { width: '100%', marginBottom: 8 },
              'data-testid': 'hi-attribution-scope',
              onChange: (v: string) => setAttribution((prev) => ({ ...prev, scope: v })),
              options: [
                { value: 'production', label: '正式归属（真实历史资料）' },
                { value: 'drill', label: '演练归属（合成文件演练）' },
              ],
            }),
            React.createElement(
              'div',
              { style: { textAlign: 'right' } },
              React.createElement(
                Button,
                {
                  loading: busy,
                  'data-testid': 'hi-confirm-attribution',
                  onClick: () => void doConfirmAttribution(),
                },
                '确认归属',
              ),
            ),
            React.createElement(
              'div',
              { style: { marginTop: 12, textAlign: 'right' } },
              React.createElement(
                Button,
                {
                  type: 'primary',
                  loading: busy,
                  'data-testid': 'hi-archive-now',
                  onClick: () => void doArchiveNow(),
                },
                '确认归档',
              ),
            ),
            archiveResult
              ? React.createElement(Alert, {
                  type: 'success',
                  showIcon: true,
                  style: { marginTop: 10 },
                  'data-testid': 'hi-archived',
                  message: `已归档 ${archiveResult.created} 条（复用 ${archiveResult.reused} 条）到历史售后档案`,
                  description:
                    `未生成任何当前服务单（ticketsCreated=${archiveResult.ticketsCreated}），` +
                    '也未影响当前 SLA / KPI。排除的非售后记录没有进入档案。',
                })
              : null,
          )
        : null,

      staged
        ? React.createElement(Alert, {
            type: 'success',
            showIcon: true,
            style: { marginTop: 10 },
            'data-testid': 'hi-staged',
            message: `已暂存：映射版本 v${staged.mappingVersion}，写入 ${staged.written} 行`,
            description: '未生成任何服务单，也未确定门店归属。旧版本的清洗结果仍然保留，可随时对照。',
          })
        : null,

      // ---------------- 底部按钮 ----------------
      React.createElement(
        'div',
        { style: { marginTop: 12, textAlign: 'right' } },
        React.createElement(Space, null, [
          step === 'pick'
            ? React.createElement(
                Button,
                {
                  key: 'up',
                  type: 'primary',
                  loading: busy,
                  'data-testid': 'hi-upload',
                  onClick: () => void doUpload(),
                },
                '上传并识别',
              )
            : null,
          step === 'map'
            ? React.createElement(
                Button,
                {
                  key: 'pv',
                  type: 'primary',
                  loading: busy,
                  'data-testid': 'hi-preview',
                  onClick: () => void doPreview(),
                },
                '预览清洗结果',
              )
            : null,
          step === 'preview'
            ? React.createElement(
                Button,
                { key: 'bk', 'data-testid': 'hi-back', onClick: () => setStep('map') },
                '回去改映射',
              )
            : null,
          step === 'preview'
            ? React.createElement(
                Button,
                {
                  key: 'st',
                  type: 'primary',
                  loading: busy,
                  'data-testid': 'hi-stage',
                  onClick: () => void doStage(),
                },
                '安全暂存',
              )
            : null,
          step === 'preview'
            ? React.createElement(
                Button,
                { key: 'rv', 'data-testid': 'hi-goto-review', onClick: () => void loadReview() },
                '下一步：异常确认',
              )
            : null,
          step === 'review'
            ? React.createElement(
                Button,
                { key: 'ar', type: 'primary', 'data-testid': 'hi-goto-archive', onClick: () => setStep('archive') },
                '下一步：确认归档',
              )
            : null,
          step === 'archive'
            ? React.createElement(
                Button,
                { key: 'bk2', 'data-testid': 'hi-back-review', onClick: () => setStep('review') },
                '返回异常确认',
              )
            : null,
          React.createElement(Button, { key: 'cl', onClick: onClose }, '关闭'),
        ]),
      ),
    );
  }

  class HistoricalImportWizardModel extends (ActionModel as any) {
    /** 挂在**区块**上（不针对某一行）—— 与 TicketCreateActionModel 同一条挂载路径 */
    static scene = ActionSceneEnum?.collection ?? 'collection';

    defaultProps: any = { type: 'default', iconOnly: false, children: '上传历史 Excel' };

    onClick(): void {
      const blockModel = (this as any).context?.blockModel;
      const handle: Handle = {};
      const modal = openClosableModal({
        title: '历史 Excel 导入',
        testid: 'historical-import-modal',
        width: 960,
        hideFooter: true,
        hasUnsavedChanges: () => handle.hasUnsaved?.() === true,
        unsavedHint: '已经上传或映射过内容，关闭后需要重新来一遍。确定关闭吗？',
        content: React.createElement(Wizard, {
          onClose: () => {
            modal.close();
            try {
              blockModel?.refresh?.();
            } catch {
              /* 刷新失败不影响已暂存的事实 */
            }
          },
          handle,
          refresh: () => blockModel?.refresh?.(),
        } as any),
      });
    }
  }

  /**
   * BE-02A-S3：**页面入口**用的 BlockModel。
   *
   * 为什么不直接把 `HistoricalImportWizardModel` 挂到 markdown 区块上：
   *   markdown 区块**没有 actions 容器**，ActionModel 写进库里也不会渲染出按钮
   *   （实测：节点在 `flowModels` 里、页面上什么都没有）。
   * 所以改成与 `StoreWorkbenchModel` 同一套：把宿主 markdown 的 `use` 换成这个 BlockModel，
   * 由它渲染一个按钮，点击复用同一个 `Wizard`（**不重写引擎**）。
   */
  function EntryPanel(): any {
    const handle: Handle = {};
    const open = () => {
      const modal = openClosableModal({
        title: '历史 Excel 导入',
        testid: 'historical-import-modal',
        width: 960,
        hideFooter: true,
        hasUnsavedChanges: () => handle.hasUnsaved?.() === true,
        unsavedHint: '已经上传或映射过内容，关闭后需要重新来一遍。确定关闭吗？',
        content: React.createElement(Wizard, { onClose: () => modal.close(), handle }),
      });
    };
    return React.createElement(
      'div',
      { style: { padding: 16 }, 'data-testid': 'historical-import-entry' },
      React.createElement(
        'div',
        { style: { marginBottom: 12, color: '#666' } },
        '从这里上传历史 Excel：先预览、核对异常，再由你确认归档。归档后可在「历史售后档案」里查询。',
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'ant-btn ant-btn-primary',
          onClick: open,
          'data-testid': 'historical-import-open',
        },
        '上传历史 Excel',
      ),
    );
  }

  class HistoricalImportEntryBlockModel extends (BaseBlockModel as any) {
    render(): any {
      return React.createElement(EntryPanel);
    }
  }
  Object.defineProperty(HistoricalImportEntryBlockModel, 'name', { value: 'HistoricalImportEntryBlockModel' });

  return { HistoricalImportWizardModel, HistoricalImportEntryBlockModel };
}
