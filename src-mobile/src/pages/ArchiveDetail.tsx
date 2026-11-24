/**
 * B 页之三：档案详情（阶段时间线 + 照片 + 现场完成/撤回）。
 *
 * ===========================================================================
 * R2.2.1 重做（用户第 7.4 / 第八节 / 第十三节）
 * ===========================================================================
 *   ① 页面标题按类型取「服务档案」/「暖通工程记录」，**档案号移到副标题**
 *      —— 用户第 7.1 条：「档案编号放次要位置」。
 *   ② 「手机号」→「客户手机号」（第 十三 节统一字段名）。
 *   ③ **预约上门日期只在普通上门服务时显示**：暖通各阶段单独记实际日期，
 *      一个"计划上门"会让门店以为"填了就会这天去"。
 *   ④ 接 `QFStageTimeline` + `QFStagePanel`（完成 / 修改两模式）
 *      —— 用户裁决「移动端可现场操作」。服务端三条规则（顺序 / 照片必填 / ≤6 张）
 *      在前端**只呈现不自创**，裁决权永远在服务端。
 *
 *   ⑥ R2.2.1 §七（本轮业务重点）：已完成阶段的主操作由「撤回」改为「修改」。
 *      走 `svc:archiveStageUpdate` —— 只改 stage_date / note，状态保持 done，
 *      后续阶段**不连带撤回**，照片**保持发布**。撤回接口仍保留在服务端，
 *      但移动端时间线不再把它当作主操作（用户原文：「主操作统一『修改』」）。
 *   ⑦ 阶段名来自后台配置（`svc:archiveStageConfigGet`），改配置**不需要重建移动端**；
 *      代码常量 `HVAC_STAGE_META` 只作接口失败时的降级值。
 *   ⑤ 删除「发布档案（客户可查询）」按钮 —— 保存即发布之后它没有使用场景了。
 *      存量草稿（生产实测 id=26）按用户第 7.4 条要求**不自动发布**，
 *      改由详情页给出**准确说明**而不是一个会误伤存量数据的按钮。
 *
 * ===========================================================================
 * 照片是**私有资源**，只有一种取法
 * ===========================================================================
 *   `<img src="/api/svc:archivePhotoFile?...">` 必然 401（浏览器不带 Bearer 头）。
 *   必须 `fetch(带 token) → blob → objectURL`，见 `api/media.ts` 的 `useSecurePhoto`，
 *   并且 objectURL 用完必须 revoke（否则翻十张图后开始卡）。
 *
 * ===========================================================================
 * 暖通阶段为什么必须"按顺序"
 * ===========================================================================
 *   服务端 `ARCHIVE_STAGE_ORDER` 六阶段是**业务规则本身**。前端显示的 done/pending
 *   全部来自服务端，这里不推断"跳过某个阶段"。
 */

import { useCallback, useEffect, useState } from 'react';
import { AppShell, PageHeader } from '../components/AppShell';
import { StickyActionBar } from '../components/AppShell';
import { useToast } from '../components/Feedback';
import {
  QFButton,
  QFErrorState,
  QFInfoRow,
  QFListSection,
  QFLoadingSkeleton,
  QFPhotoAlbum,
  QFPhotoViewer,
  QFProductSummary,
  QFStagePanel,
  QFStageTimeline,
  QFStatusBadge,
  describeQFError,
  type QFPhotoAlbumGroup,
} from '../components/qf';
import {
  ArchiveApiAdapter,
  type ArchivePhotoRow,
  type ArchiveProductRow,
  type ArchiveRow,
  type ArchiveStageRow,
} from '../api/archives';
import {
  ARCHIVE_STATUS_META,
  ARCHIVE_TYPE_META,
  HVAC_STAGE_META,
  HVAC_STAGE_ORDER,
  metaOf,
  serviceTypeLabel,
} from '../design/qf-tokens';
import { fetchStageConfig } from '../api/stage-config';
import { ApiError, newRequestId } from '../api/http';
import { navigate } from '../router';
import { useSession } from '../app/session-context';

/**
 * 当前打开的面板。
 *
 * 🔴 R2.2.1 §七：`'update'` 取代了 `'withdraw'`。
 *    已完成阶段的主操作是「修改」（`svc:archiveStageUpdate`：只改日期/备注/照片，
 *    状态保持 done、后续阶段不受影响），**不是**撤回。
 *    把"修改"接到 `archiveStageWithdraw` 上 → 员工改个备注，后面三个已完成阶段
 *    会一起退回未开始，客户看到的进度当场倒退。
 */
type Panel = { kind: 'complete' | 'update'; stageId: number } | null;

export function ArchiveDetailPage({ id }: { id: string }) {
  const { caps } = useSession();
  const toast = useToast();
  const [row, setRow] = useState<ArchiveRow | null>(null);
  const [stages, setStages] = useState<ArchiveStageRow[]>([]);
  const [photos, setPhotos] = useState<ArchivePhotoRow[]>([]);
  /**
   * 产品清单（R2.2.4 §C）。
   *
   * ⚠️ `null` 与 `[]` **必须分开**：
   *    `null` = 还没读到 / 读失败了；`[]` = 确实没有产品。
   *    把两者塌缩成 `[]` 会让"读失败"显示成"这条档案没有产品"，
   *    而在多产品改造之前**每条档案都至少有一条**（迁移已回填 53 条），
   *    员工会因此以为"数据丢了"并重新录入 —— 那正是重复数据的来源。
   */
  const [products, setProducts] = useState<ArchiveProductRow[] | null>(null);
  /**
   * 产品清单表**从来没有过行**（服务端 `legacy_only`）。
   *
   * 🔴 这是 §四「旧字段与清单清空后不显示矛盾」的唯一判据。
   *    `products === []` 时：
   *      true  ⇒ 迁移前的老档案，旧列是唯一数据来源 ⇒ 可以显示；
   *      false ⇒ 用户把产品删光了 ⇒ **什么都不显示**（旧列是历史残留）。
   *    ⚠️ 默认为 `false`（不回落）：宁可少显示，也不要把已删除的产品显示出来。
   */
  const [legacyOnly, setLegacyOnly] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [photoStage, setPhotoStage] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  /** 大图查看（R2.2.4 §A：点击缩略图看大图） */
  const [viewing, setViewing] = useState<number | null>(null);
  /** 阶段显示名（后台配置）；失败时保持 `HVAC_STAGE_META` 的代码默认名 */
  const [stageNames, setStageNames] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 🔴 DEV-272：阶段**不能**和主数据并行发。
      // 并行时还不知道 archive_type，只能对每个档案都问一次阶段；
      // 普通上门服务档案根本没有阶段，服务端就报了 500 `ARCHIVE_STAGE_ROWS_BROKEN`。
      // ⇒ 先拿主数据，确认是 hvac 再拉阶段与照片；
      //    `archive_type` 未知时**不发**阶段请求（宁可不显示，也不制造错误日志）。
      const r = await ArchiveApiAdapter.get(id);
      setRow(r);

      /**
       * 产品清单（R2.2.4 §C）：**独立失败**，不拖垮主数据。
       *
       * ⚠️ 失败时保持 `null` 而不是给 `[]`：见 `products` state 的注释。
       *    `.catch` 只在这里用一次，且**不改** `error` state ——
       *    产品清单读不到不该让整页变成错误页（客户名、地址、阶段、照片都还在）。
       */
      const pt = await ArchiveApiAdapter.productList(id).catch(() => null);
      setProducts(pt ? pt.products : null);
      setLegacyOnly(pt ? pt.legacyOnly : false);

      const isHvac = String(r?.archive_type ?? '') === 'hvac';
      if (!isHvac) {
        const ph = await ArchiveApiAdapter.photos(id).catch(() => [] as ArchivePhotoRow[]);
        setStages([]);
        setPhotos(ph);
        return;
      }

      const st = await ArchiveApiAdapter.stages(id).catch(() => [] as ArchiveStageRow[]);
      // ⚠️ 照片与阶段**有先后依赖**：服务端投影只给 `stage_id`，
      //    `stage_code` 要靠阶段表映射（见 `ArchiveApiAdapter.photos` 注释）。
      //    所以这里不能 Promise.all —— 拿不到阶段就会把照片全判成"无归属"，
      //    界面表现是「现场照片 0/6」而库里明明有照片。
      const ph = await ArchiveApiAdapter.photos(
        id,
        st.map((s) => ({ id: Number(s.id), stage_code: String(s.stage_code) })),
      ).catch(() => [] as ArchivePhotoRow[]);
      setStages(st);
      setPhotos(ph);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 阶段显示名：**与档案数据分开加载**。
   *
   * ⚠️ 为什么不并进 `load()`：配置是全局的（不属于任何门店/档案），
   *    并发进档案加载会把"配置读失败"变成"档案加载失败"——
   *    而档案的日期、照片、完成状态才是业务事实，不该被一个装饰性配置拖下水。
   *    配置读失败时 `stageNames` 保持空，时间线自动回退代码默认名。
   */
  useEffect(() => {
    let alive = true;
    void fetchStageConfig().then((r) => {
      if (!alive) return;
      const map: Record<string, string> = {};
      for (const s of r.stages) map[s.code] = s.name;
      setStageNames(map);
    });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 完成阶段。
   *
   * ⚠️ 成功后**必须重新拉阶段**：`photo_count`、`version`、`status` 都变了。
   *    只改本地 state 会让下一次提交带着旧的 `expected_version` ⇒ 409。
   */
  const onCompleteStage = async (stage: ArchiveStageRow, input: { stage_date?: string; note: string }) => {
    setBusy(true);
    try {
      /**
       * ⚠️ 首次完成必须有日期：`completeStage` 的入参在类型上是 `string`，
       *    而面板回传的是可选的（那是给"修改态省略日期"用的）。
       *    这里做**显式**兜底而不是 `?? ''`：
       *    空串送上去会被服务端判成"日期不能为空"（400），
       *    报错位置离用户看到的界面很远 —— 不如在点击处就拦下来。
       *    正常路径走不到（`canSubmit = dateOk = Boolean(date)` 已拦住），
       *    但 `canSubmit` 与这里隔着一层 props，别指望它永远同步。
       */
      if (!input.stage_date) {
        toast.show('请先选择实际施工日期', 'danger');
        return;
      }
      await ArchiveApiAdapter.completeStage(
        id,
        stage.stage_code,
        { stage_date: input.stage_date, note: input.note || null, expected_version: stage.version ?? 0 },
        newRequestId(),
      );
      setPanel(null);
      toast.show('阶段已完成');
      await load();
    } catch (e) {
      toast.show(describeQFError(e).message, 'danger');
      // ⚠️ 失败**不关面板**：用户填的日期和说明还在，关掉就得重填
    } finally {
      setBusy(false);
    }
  };

  /**
   * 修改已完成阶段的内容（§七）。
   *
   * 🔴 走 `archiveStageUpdate`，**不是** withdraw：
   *    服务层只写 `stage_date` / `note`（+ version/updated_at），
   *    `status` 进 WHERE 当乐观锁而不被写 —— 所以完成后仍是完成，
   *    后续阶段状态、照片发布状态、档案 status 一律不动。
   *
   * 🔴 R2.2.2 封版裁决（§五）：**只提交实际变化的业务字段。**
   *    面板在"用户没碰日期"时根本不带 `stage_date` 键 ⇒ 这里必须
   *    **保持 undefined，不能用 `?? ''` 兜成空串**：
   *    服务端 `paramPresence` 把 `''` 当"明确清空"（会报
   *    ARCHIVE_STAGE_MISSING_DATE 400），把 absent 当"不改这一列"。
   *    两者语义相反，兜错方向就是"只想改备注却改不动"or"把日期清掉"。
   *
   * ⚠️ 成功后**必须重新拉**：`version` 变了，不重拉下一次提交必然 409。
   */
  const onUpdateStage = async (stage: ArchiveStageRow, input: { stage_date?: string; note: string }) => {
    setBusy(true);
    try {
      const body: { stage_date?: string; note: string | null; expected_version: number } = {
        note: input.note || null,
        expected_version: stage.version ?? 0,
      };
      // 只有用户真的动过日期（面板判定 `date !== fallbackDate`）才带上
      if (input.stage_date !== undefined) body.stage_date = input.stage_date;
      await ArchiveApiAdapter.updateStage(id, stage.stage_code, body, newRequestId());
      setPanel(null);
      toast.show('修改已保存');
      await load();
    } catch (e) {
      // ⚠️ 失败**不关面板**：用户填的日期和备注还在，关掉就得重填
      toast.show(describeQFError(e).message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  const isHvac = String(row?.archive_type ?? '') === 'hvac';
  const typeLabel = isHvac ? '暖通工程记录' : '服务档案';

  if (loading) {
    return (
      <AppShell>
        <PageHeader title="服务档案" back />
        <QFLoadingSkeleton rows={3} label="正在加载档案" />
      </AppShell>
    );
  }

  if (error) {
    return (
      <AppShell>
        <PageHeader title="服务档案" back />
        <QFErrorState
          info={describeQFError(error)}
          onRetry={() => void load()}
          onBack={() => navigate('/archives')}
          testId="archive-detail-error"
        />
      </AppShell>
    );
  }

  if (!row) {
    return (
      <AppShell>
        <PageHeader title="服务档案" back />
        <QFErrorState
          info={describeQFError(new ApiError(404, 'ARCHIVE_NOT_FOUND', '档案不存在或已被移除'))}
          onBack={() => navigate('/archives')}
        />
      </AppShell>
    );
  }

  const type = ARCHIVE_TYPE_META[String(row.archive_type ?? '')];
  const status = metaOf(ARCHIVE_STATUS_META, row.status, 'neutral');

  /**
   * 阶段显示名（**优先后台配置**，缺配置才回退代码默认名）。
   *
   * 🔴 R2.2.4 修：旧实现 `stageName()` 只读 `HVAC_STAGE_META`（代码常量），
   *    而时间线与面板都读后台配置 —— 后台把「管路施工」改成「管路与开槽」后，
   *    照片区脚注显示「只看「管路施工」的照片」，同一屏出现两个叫法。
   *    现在统一走这一条解析链，任何位置**都不许再直接读 `HVAC_STAGE_META.label`**。
   */
  const stageNameOf = (code: string): string =>
    String(stageNames?.[code] ?? '').trim() || HVAC_STAGE_META[code]?.label || code;

  /**
   * 照片按阶段分组（R2.2.4 §A）。
   *
   * 三条约束：
   *  ① **复用原有 `stage_id` 关联**，不新建照片体系；
   *  ② 顺序按 `ARCHIVE_STAGE_ORDER`（业务顺序），不是按上传时间；
   *  ③ `stage_id` 为空 ⇒「未分类」，**不猜阶段**、不删除、不隐藏。
   *
   * ⚠️ 阶段列表只从 `stages`（服务端真实六行）取，不从 `HVAC_STAGE_ORDER` 凭空造：
   *    普通上门服务档案没有阶段行，硬造六组会让它显示六个空组。
   */
  const albumGroups: QFPhotoAlbumGroup[] = (() => {
    const buckets = new Map<string, ArchivePhotoRow[]>();
    for (const p of photos) {
      const code = p.stage_code ? String(p.stage_code) : '__unclassified__';
      const arr = buckets.get(code);
      if (arr) arr.push(p);
      else buckets.set(code, [p]);
    }

    const order = stages.length
      ? [...stages]
          .sort((a, b) => {
            const ia = HVAC_STAGE_ORDER.indexOf(a.stage_code as (typeof HVAC_STAGE_ORDER)[number]);
            const ib = HVAC_STAGE_ORDER.indexOf(b.stage_code as (typeof HVAC_STAGE_ORDER)[number]);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
          })
          .map((s) => s.stage_code)
      : // 无阶段行但确实有 stage_code 的形状（历史数据）：按业务顺序兜底排列，
        // 不丢组 —— 丢组等于照片从界面上消失。
        [...buckets.keys()].filter((k) => k !== '__unclassified__').sort(
          (a, b) =>
            HVAC_STAGE_ORDER.indexOf(a as (typeof HVAC_STAGE_ORDER)[number]) -
            HVAC_STAGE_ORDER.indexOf(b as (typeof HVAC_STAGE_ORDER)[number]),
        );

    const groups: QFPhotoAlbumGroup[] = order.map((code) => ({
      key: code,
      name: stageNameOf(code),
      photos: (buckets.get(code) ?? []).map((p) => ({ id: p.id })),
      status: stages.find((s) => s.stage_code === code)?.status,
    }));

    // 未分类永远最后
    const loose = buckets.get('__unclassified__') ?? [];
    if (loose.length > 0) {
      groups.push({ key: 'unclassified', name: '未分类', photos: loose.map((p) => ({ id: p.id })) });
    }
    return groups;
  })();

  /**
   * 「只看某阶段」的过滤（点时间线的照片入口时用）。
   * ⚠️ 过滤后仍然走分组渲染 —— 只有一组时组标题仍要显示，
   *    否则用户看不出"现在只看这一阶段"（返回按钮在右上角，不够显眼）。
   */
  const shownGroups = photoStage ? albumGroups.filter((g) => g.key === photoStage) : albumGroups;

  const panelStage = panel ? stages.find((s) => s.id === panel.stageId) ?? null : null;

  /**
   * 旧列能不能作为产品区的显示来源。
   *
   * 判据只有一条：**清单表从来没写过行**（服务端 `legacy_only`）。
   * ⚠️ 不要写成 `products.length === 0 && row.product_description` ——
   *    那正是"删除后仍显示"的成因：清空清单时 `mirrorToLegacy([])` 不动旧列，
   *    旧值还在，用它做判据就会把用户删掉的产品重新显示出来。
   */
  const canFallbackToLegacy = legacyOnly;
  /**
   * 能否现场操作阶段。
   *
   * ⚠️ 判据是 `caps.archiveCreate`（建档权限）—— 服务端的写权限集合
   *    `ARCHIVE_WRITE_ROLES` 当前只有 `store_sales`，与建档是同一个角色。
   *    这里不复刻角色名，只看能力位；真正的裁决仍在服务端（403）。
   */
  const canOperate = Boolean(caps.archiveCreate);

  return (
    <AppShell>
      {toast.node}
      <PageHeader title={typeLabel} subtitle={row.archive_no || `#${row.id}`} back />

      {/* 客户 / 概要 */}
      <QFListSection>
        <div className="px-4 pt-3 pb-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              {/*
                ⚠️ 客户姓名缺失时**不印 '—'**：一张写着「—」的档案头无法回答
                   "这是谁的档案"，而"（未填客户）"说明了**是什么情况**。
              */}
              <div className="text-svc-ink qf-title truncate font-semibold">
                {row.customer_name || '（未填客户）'}
              </div>
              {row.service_address ? (
                <div className="text-svc-ink-2 qf-foot mt-0.5 leading-relaxed">{row.service_address}</div>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <QFStatusBadge label={status.label} tone={status.tone} />
              {/*
                ⚠️ R2.2.1：只显示**作废**（客户再也看不到这条了，必须让人知道）。
                   「已发布」是恒态（保存即发布），显示它等于每页都写一句废话；
                   存量「草稿」按用户 7.4 要求**不自动发布**，所以仍然要显示，
                   并在下面对客户可见性给一句准确说明。
              */}
              {row.visibility === 'voided' ? <QFStatusBadge label="已作废" tone="danger" dot={false} /> : null}
              {row.visibility === 'draft' ? <QFStatusBadge label="草稿" tone="neutral" /> : null}
            </div>
          </div>
        </div>

        {row.visibility === 'draft' ? (
          <div className="bg-svc-warning-soft px-4 py-2.5">
            <div className="text-svc-warning qf-foot leading-relaxed">
              这条档案还没发布，客户查不到。它是本轮改版之前留下的草稿 ——
              如需让客户看到，请联系总部管理员处理。
            </div>
          </div>
        ) : null}

        <div className="border-svc-line border-t">
          {/*
            🔴 R2.2.4-rc.2：**手机号按服务端下发的可见性直接显示原文**。

            改之前是 `maskMobile(row.customer_mobile)` —— 服务端 `archive-read-scope.ts`
            已经按「角色 + 门店范围」判定过，本店销售拿到的是完整 11 位、
            `customer_mobile_visible === true`；前端又打一次码 ⇒
            员工在柜台**看不到客户完整号码**，回访、核对都做不到。
            用户 §六 第 9 条要求先核实"是截图保护还是运行时打码"——
            核实结论：**运行时打码**（源码里就是这一行），所以要改。

            ⚠️ 三种情况必须区分（这正是 `customer_mobile_visible` 存在的理由）：
               visible === false ⇒ 无权查看 ⇒ **整行不渲染**（不是显示掩码、
                                  也不是显示"已隐藏"——那会暴露"这里有号码"）
               visible === true 且有名  ⇒ 显示原文
               visible === true 且为空  ⇒ 那就是客户真没填，同样不渲染
            ⚠️ 若字段缺失（老接口/异常）按"无权"处理：**宁可不显示，不要误显示**。
          */}
          {row.customer_mobile_visible === true && row.customer_mobile ? (
            <QFInfoLine k="客户手机号" v={row.customer_mobile} />
          ) : null}
          {row.service_type ? <QFInfoLine k="服务内容" v={serviceTypeLabel(row.service_type)} /> : null}
          {/*
            ⚠️ 用户第 7.3 / 第八节：**暖通不显示计划上门日期**。
               判据是 `archive_type === 'service'`，不是"字段有没有值"——
               历史暖通档案里可能残留这个字段，用它判会漏。
          */}
          {row.planned_date && row.archive_type === 'service' ? (
            <QFInfoLine k="计划上门日期" v={row.planned_date} />
          ) : null}
          {/*
            🔴 R2.2.4-rc.2：**实际服务日期**与计划并列显示，两行都在就是两种事实。
               「原计划 11-28、实际提前 11-26」⇒ 两行分别写出来。
               ⚠️ **不回落**成 `completed_at` 的日期：
                  完工时间有它的业务含义（哪天点的完工），与"哪天真正上门"不是一回事，
                  拿它顶替等于伪造。
               ⚠️ 未填写时**不显示这一行**，也不写"未填"——
                  一行"实际服务日期：未填"会把"还没上门"和"忘了记"混在一起说。
          */}
          {row.service_date && row.archive_type === 'service' ? (
            <QFInfoLine k="实际服务日期" v={row.service_date.slice(0, 10)} />
          ) : null}
          {row.completed_at ? <QFInfoLine k="完成时间" v={absTime(row.completed_at)} /> : null}
          <QFInfoLine k="建档时间" v={absTime(row.created_at)} />
        </div>
      </QFListSection>

      {/*
        🔴 R2.2.4 §C：「产品 / 型号」「购买日期」两行**不再是主信息区的普通行**。
           多条产品时它们是数组，一行装不下；单条时保持原样（一条一行，不退化）。

        🔴 R2.2.4-rc.2 §四：**旧列只能在"清单表里从来没有过行"时兜底**。

           用户点名要核实的问题：
             「是否出现新员工页面无产品，但旧调用方仍显示曾被删除的产品」

           发生条件是：用户把产品全删了 ⇒ `products` 落成 `[]`，
           而 `mirrorToLegacy([])` 返回 `{}` ⇒ 旧列**保持原值**（铁律 ③，故意的：
           避免"清空"变成"把历史购买信息抹掉"）。
           于是 `products.length === 0` 且旧列有值 —— 如果这时用旧列回落显示，
           员工看到的是"我明明删光了，页面还显示一台机器"。

           ⇒ 权威读取规则（唯一口径）：
             · `products.length > 0`                ⇒ 只读清单，**不读旧列**
             · `products.length === 0` 且 `legacyOnly` ⇒ 读旧列（迁移前的老档案）
             · `products.length === 0` 且 非 legacyOnly ⇒ **什么都不显示**
             · `products === null`（读失败）        ⇒ 旧列兜底（宁缺不错的前提是"不能丢"）

           `legacyOnly` 由服务端 `archiveProductList` 回来的 `legacy_only` 标记给出
           （= 该档案的清单表从未写入过任何行）。前端**不自己推断**：
           "表里有没有行"只有服务端知道，前端拿 `[]` 分不清"从没有过"与"被清空了"。
      */}
      {products && products.length > 0 ? (
        <QFListSection title="产品清单" testId="archive-products">
          <QFProductSummary products={products} testId="archive-product-summary" />
        </QFListSection>
      ) : products && products.length === 0 ? (
        canFallbackToLegacy ? (
          <QFListSection title="产品清单" testId="archive-products">
            <div className="svc-product-summary">
              <div className="svc-product-summary-row">
                <div className="svc-product-summary-name qf-body">
                  {row.product_description || '（未填写产品）'}
                </div>
                <div className="svc-product-summary-meta qf-foot">
                  {row.purchase_date ? row.purchase_date : '未填购买日期'}
                </div>
              </div>
            </div>
          </QFListSection>
        ) : null
      ) : row.product_description || row.purchase_date ? (
        // `products === null`：清单没读到（网络/权限）。此时旧列是唯一的线索，
        // 显示它比显示"什么都没有"安全 —— 员工至少不会以为数据丢了去重录。
        <QFListSection title="产品清单" testId="archive-products">
          <div className="px-4 py-2.5">
            {row.product_description ? <QFInfoLine k="产品 / 型号" v={row.product_description} /> : null}
            {row.purchase_date ? <QFInfoLine k="购买日期" v={row.purchase_date} /> : null}
          </div>
        </QFListSection>
      ) : null}

      {/* 品牌 / 类型说明（一行，不抢视线） */}
      <div className="text-svc-ink-3 qf-foot px-5 pt-2">{type?.desc}</div>

      {/* 暖通：施工阶段 */}
      {isHvac && stages.length > 0 ? (
        <QFListSection title="施工阶段" testId="archive-stages">
          <div className="px-4 py-3">
            <QFStageTimeline
              stages={stages}
              canOperate={canOperate}
              activeStage={photoStage}
              stageNames={stageNames}
              onViewPhotos={(s) => setPhotoStage((cur) => (cur === s.stage_code ? null : s.stage_code))}
              onAction={(s, action) => {
                if (!action) return;
                setPanel({ kind: action, stageId: s.id });
              }}
            />
          </div>
        </QFListSection>
      ) : null}

      {/* 阶段面板（完成 / 修改）—— §七：主操作统一「修改」，不再有「撤回」入口 */}
      {panel && panelStage ? (
        <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40" role="dialog" aria-modal="true">
          <button type="button" aria-label="关闭" className="flex-1" onClick={() => setPanel(null)} />
          {/*
            ⚠️ 面板用白底 + 上方圆角，**不用毛玻璃**（用户明令禁止）。
               内容可滚动：师傅手机小屏上，照片区 + 日期 + 说明 + 按钮可能超一屏。
          */}
          <div className="bg-svc-bg max-h-[88vh] overflow-y-auto rounded-t-svc-xl pb-2">
            <div className="sticky top-0 z-10 flex items-center justify-between bg-svc-bg px-4 pt-3 pb-1">
              <span className="text-svc-ink qf-foot font-medium">
                {panel.kind === 'complete' ? '完成阶段' : '修改阶段'}
              </span>
              <button
                type="button"
                onClick={() => setPanel(null)}
                className="text-svc-brand-text qf-foot qf-pressable inline-flex min-h-touch min-w-touch items-center justify-center px-2 font-medium"
              >
                关闭
              </button>
            </div>

            {/*
              ⚠️ 两种模式共用一个组件（`QFStagePanel`），只切 `mode`：
                  · 完成 → `archiveStageComplete`（会改 status、校验照片/顺序）
                  · 修改 → `archiveStageUpdate`（只改日期/备注，状态与后续阶段不动）
                拆成两个组件会让照片区各写一套，而旧版正是这样把照片逻辑丢在了
                撤回面板外面。`key` 里带 `version`：提交成功后 version 变化，
                面板会重新挂载并拿到最新的日期/备注，而不是停在旧值上。
            */}
            <QFStagePanel
              key={`${panel.kind}-${panelStage.id}-${panelStage.version ?? 0}`}
              mode={panel.kind}
              stage={panelStage}
              archiveId={id}
              photos={photos}
              busy={busy}
              // 面板标题必须与时间线用同一份显示名（后台可改），否则一处新一处旧
              stageName={
                String(stageNames?.[panelStage.stage_code] ?? '').trim() ||
                HVAC_STAGE_META[panelStage.stage_code]?.label
              }
              onUploaded={() => load()}
              onSubmit={(input) =>
                panel.kind === 'complete'
                  ? void onCompleteStage(panelStage, input)
                  : void onUpdateStage(panelStage, input)
              }
              onCancel={() => setPanel(null)}
            />
          </div>
        </div>
      ) : null}

      {/* 照片（R2.2.4 §A：按阶段分组相册） */}
      <QFListSection
        title="现场照片"
        testId="archive-photos"
        footnote={photoStage ? `只看「${stageNameOf(photoStage)}」的照片` : undefined}
      >
        <div className="px-3 py-3">
          {photoStage ? (
            <div className="mb-2 flex justify-end px-1">
              <button
                type="button"
                onClick={() => setPhotoStage(null)}
                className="text-svc-brand-text qf-foot qf-pressable inline-flex min-h-touch min-w-touch items-center justify-center px-2 font-medium"
                data-testid="photos-show-all"
              >
                显示全部
              </button>
            </div>
          ) : null}
          <QFPhotoAlbum
            groups={shownGroups}
            columns={3}
            onOpen={setViewing}
            testId="archive-photo-album"
          />
        </div>
      </QFListSection>

      {/* 大图查看：纯黑遮罩，无毛玻璃 */}
      <QFPhotoViewer photoId={viewing} onClose={() => setViewing(null)} />

      {/* 底部主操作：返回列表 + 编辑档案（R2.2.4-rc.2 §二 / §三） */}
      <div className="h-20" />
      <StickyActionBar>
        {/*
          🔴 「编辑档案」入口（用户 §二 明写「提供清晰的『编辑档案』入口」）。

          ⚠️ 判据用 `caps.archiveCreate`（写权限位），与服务端
             `ARCHIVE_WRITE_ROLES` 一致 —— 这是详情页已有 `canOperate` 的同一个位。
             店长 / 总部进来**看不到这个按钮**，即使直接输 URL 也会被服务端 403 拦下
             （`ArchiveEditPage` 里还有一层前端拦截，是为了不让用户"填完才被拒"）。

          ⚠️ **完工后照样显示**：用户 §三 明确「包括完工后的信息纠错」。
             若在这里按 `status === 'completed'` 隐藏，等于把刚批准的能力又收回。
             完工状态下能改什么由服务端列白名单决定（日期/内容/清单可改，
             status / completed_at 结构上改不了）。
        */}
        <div className="flex-1">
          <QFButton variant="secondary" block onClick={() => navigate('/archives')} testId="archive-back-list">
            返回列表
          </QFButton>
        </div>
        {canOperate ? (
          <div className="flex-1">
            <QFButton
              variant="primary"
              block
              onClick={() => navigate(`/archives/${id}/edit`)}
              testId="archive-edit-entry"
            >
              编辑档案
            </QFButton>
          </div>
        ) : null}
      </StickyActionBar>
    </AppShell>
  );
}

/* ------------------------------------------------------------------ 局部件 */

/**
 * 一行信息（标签左、值右）。
 *
 * ⚠️ 不自己实现左右两列，直接用 `QFInfoRow`（标签在上、值在下）。
 *    中文标签「客户手机号」在 390px 下与 11 位号码 + 标签共处一行会很挤，
 *    标签在上是 iOS 详情页处理"长标签"的常见做法，也免得每个页面各写一套列宽
 *    （用户第 十四 节：不得在不同页面重复编写同一套样式）。
 */
function QFInfoLine({ k, v }: { k: string; v: string }) {
  return <QFInfoRow label={k} value={v} />;
}

/**
 * 阶段显示名（照片区脚注用）—— **已废弃，不要再调用**。
 *
 * R2.2.4 §A 起改由组件内的 `stageNameOf(code)` 统一解析（后台配置 → 代码默认），
 * 它闭包在 `stageNames` 上，能保证同一屏所有位置用同一个叫法。
 *
 * 保留这段说明而不是直接删干净，是因为"照片区标题写死代码默认名"这个缺陷
 * 曾经真实存在（时间线显示后台改名后的新名、照片区仍是旧名），
 * 而门禁看不见它 —— 只有对着同一屏截图比对才能发现。
 *
 * ⚠️ 判据（验收脚本）：页面内不得再出现 `HVAC_STAGE_META[...].label` 的直接读取，
 *    只允许经 `stageNameOf` 这**一条**链路。
 */

/**
 * 🔴 **本页不再有 `maskMobile`**（R2.2.4-rc.2 已删除）。
 *
 * 曾经这里是 `maskMobile(row.customer_mobile)` —— 而服务端
 * `archive-read-scope.ts` 已经按「角色 + 门店范围」判定过可见性，
 * 本店销售拿到的是完整 11 位。前端再打一次码的后果是**运行时打码**：
 * 员工在柜台看不到客户完整号码，回访、核对都做不了
 * （用户 §六 第 9 条要求核实的就是这件事）。
 *
 * ⚠️ 不要以"防肩窥"为理由把它加回来：
 *    门店柜台场景的防护应该是"什么时候显示"（服务端权限），
 *    不是"显示了也不给全"—— 那既挡不住窥视，又废掉了业务能力。
 *    真正的边界在 `customer_mobile_visible`，它是**服务端下发的事实**。
 *
 * 共享的 `maskMobile` 仍在 `components/qf/list.tsx`，供客户 H5 / 列表页
 * 等**确实需要脱敏**的场景使用；本页不是那种场景。
 */

/** 绝对时间（详情页用；列表用 MM-DD） */
function absTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
