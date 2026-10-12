/**
 * P11-3 第 4 项的服务端动作：**异常确认（B）/ 去重预览（C）/ 受控归档闭环（D）**
 *
 * ===========================================================================
 * 七个动作，两条链
 * ===========================================================================
 *  异常与去重：
 *    `historicalReviewSummary`     一份文件的全部计数（含"唯一记录数"）
 *    `historicalReviewRow`         逐行人工核对 / 修正（写审计）
 *    `historicalDuplicates`        跨文件疑似重复提示（不合并）
 *    `historicalDuplicateDecision` 保留两条 / 标记重复
 *  归档与转单：
 *    `historicalConfirmAttribution` 确认批次归属到某门店（仅总部 + 门店身份须已确认）
 *    `historicalArchives`           查看历史档案（与当前工单分开）
 *    `historicalConvertToTicket`    把一条档案转为当前服务单（一次一条、必填理由）
 *
 * ===========================================================================
 * 🔴 这一层刻意只做三件事：**取操作者 → 裁可见范围 → 调服务层**
 * ===========================================================================
 * 业务规则（什么算重复、能不能归档、幂等键怎么算）全部在 `services/historical-import/*`。
 * 放在 action 层的话，规则就只能被 HTTP 调用验证 —— 而"归档"这种动作
 * 必须能被**服务层直接断言**（例如"未确认门店一定被拒"不该依赖能不能起 HTTP）。
 *
 * ===========================================================================
 * 关于「原始层不被覆盖」的结构性做法
 * ===========================================================================
 *   原始层 `historical_import_rows.cells_json` —— 本文件**没有**任何一条 UPDATE。
 *   机器标准化层 `..._candidates.fields_json` —— 本文件**没有**任何一条 UPDATE。
 *   人工修正写进 `..._candidates.manual_overrides_json`（另一个字段）+ 审计表。
 *   ⇒ "改映射/人工修正会不会把原始值改掉"这个担心，在代码里找不到落点。
 */
import { SVC_ACTION, ROLE } from '../../constants';
import { fail, ok, traceId } from './_http';
import { maskPhone } from '../../services/historical-import/normalize';
import { buildBatchSummary, detectDuplicates, validateManualValue, type CandidateLite } from '../../services/historical-import/review';
import {
  createHistoricalArchiveService,
  buildArchiveIdempotencyKey,
  buildConversionIdempotencyKey,
  type ArchiveRowInput,
} from '../../services/historical-import/archive';
import { createHistoricalImportStore, HistoricalImportError } from '../../services/historical-import/store';

export interface HistoricalReviewArchiveDeps {
  services: any;
  db: any;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

function isHqActor(actor: any): boolean {
  const roles: string[] = Array.isArray(actor?.roles) ? actor.roles.map((r: unknown) => String(r)) : [];
  const platform: string[] = Array.isArray(actor?.platformRoles)
    ? actor.platformRoles.map((r: unknown) => String(r).toLowerCase())
    : [];
  return roles.includes(ROLE.HQ_ADMIN) || roles.includes('hq_service') || platform.includes('root') || platform.includes('admin');
}

/** 出口统一脱敏：只要字段叫 phone/mobile，就掩码（不靠各分支自己记得） */
function maskFields(fields: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...(fields ?? {}) };
  if (Array.isArray(out.customerPhones)) {
    out.customerPhones = (out.customerPhones as any[]).map((p) => ({
      masked: maskPhone(String(p?.digits ?? '')),
      kind: p?.kind,
      valid: p?.valid,
    }));
  }
  return out;
}

export function createHistoricalReviewArchiveHandlers(
  deps: HistoricalReviewArchiveDeps,
): Record<string, (ctx: any, next?: any) => Promise<void>> {
  const { services, db, logger } = deps;
  const { permissions } = services ?? {};
  const store = createHistoricalImportStore({ db, logger });
  const archiveSvc = createHistoricalArchiveService({ db, logger });

  const actorOf = async (ctx: any): Promise<any> => permissions?.resolveActor(ctx);
  const uploaderOf = (actor: any) => ({
    userId: actor?.userId ?? null,
    username: actor?.raw?.username ?? actor?.raw?.nickname ?? null,
    isHq: isHqActor(actor),
  });
  const now = () => new Date();

  /** 取"当前映射版本"的候选行 + 对应的原始行信息（**已按可见范围裁剪**） */
  async function loadCandidates(batch: any, limit = 5000): Promise<Array<CandidateLite & { batchId: number; batchNo: string }>> {
    const cRepo = db.getRepository('historicalImportCandidates');
    const rRepo = db.getRepository('historicalImportRows');
    const rows = await cRepo.find({
      filter: { batch_id: batch.id, mapping_version: Number(batch.mapping_version ?? 1) },
      limit,
      sort: ['id'],
    });
    const list = (rows ?? []) as any[];
    if (list.length === 0) return [];
    const rowIds = [...new Set(list.map((c) => Number(c.row_id)))];
    const rawRows = await rRepo.find({ filter: { id: { $in: rowIds } }, fields: ['id', 'sheet_name', 'source_row'] });
    const rawById = new Map<number, any>((rawRows ?? []).map((r: any) => [Number(r.id), r]));
    return list.map((c) => {
      const raw = rawById.get(Number(c.row_id)) ?? {};
      return {
        id: Number(c.id),
        rowId: Number(c.row_id),
        sheetName: String(raw.sheet_name ?? ''),
        sourceRow: Number(raw.source_row ?? 0),
        disposition: String(c.disposition),
        fields: c.fields_json ?? {},
        issues: Array.isArray(c.issues_json) ? c.issues_json : [],
        manualStatus: String(c.manual_status ?? 'pending'),
        manualOverrides: c.manual_overrides_json ?? {},
        batchId: Number(batch.id),
        batchNo: String(batch.batch_no),
      };
    });
  }

  // -------------------------------------------------------------------------
  // ① 概览（用户 B 条要的那几个数）
  // -------------------------------------------------------------------------
  const historicalReviewSummary = async (ctx: any): Promise<void> => {
    const trace = traceId(ctx);
    try {
      const actor = await actorOf(ctx);
      const batchId = Number(ctx?.request?.query?.batchId ?? ctx?.action?.params?.batchId);
      if (!Number.isFinite(batchId) || batchId <= 0) {
        fail(ctx, 422, 'BATCH_ID_REQUIRED', '缺少 batchId');
        return;
      }
      const batch = await store.getBatchForActor(batchId, uploaderOf(actor));
      if (!batch) {
        fail(ctx, 404, 'BATCH_NOT_FOUND', '批次不存在或你无权查看');
        return;
      }
      const candidates = await loadCandidates(batch);
      const summary = buildBatchSummary(candidates);
      const identities = await archiveSvc.listConfirmedStores();
      ok(ctx, {
        action: SVC_ACTION.HISTORICAL_REVIEW_SUMMARY,
        batch: {
          id: batch.id,
          batchNo: batch.batch_no,
          fileName: batch.file_name,
          stage: batch.stage,
          attributionState: batch.attribution_state,
          visibilityScope: batch.visibility_scope,
          mappingVersion: batch.mapping_version,
        },
        summary,
        /**
         * 🔴 **两份口径同时给出**，并在这里就把话说清楚：
         *    `anomalyUniqueRowCount` = 需要看的**行数**；
         *    `anomalyHitCount`       = 异常**命中次数**（一行可以命中多类）。
         *    界面上显示"X 条待处理"时必须用前者 —— 用后者会把同一行数两遍。
         */
        anomalyNote:
          `涉及的唯一原始行数 ${summary.anomalyUniqueRowCount}；` +
          `异常命中次数 ${summary.anomalyHitCount}（同一行可命中多类，两者不相等）`,
        confirmedStores: identities,
        storesWithProductionScope: identities.filter((x) => x.scope === 'production').map((x) => x.code),
      });
    } catch (error) {
      handle(ctx, error, logger, trace, SVC_ACTION.HISTORICAL_REVIEW_SUMMARY);
    }
  };

  // -------------------------------------------------------------------------
  // ② 逐行人工核对 / 修正
  // -------------------------------------------------------------------------
  const historicalReviewRow = async (ctx: any): Promise<void> => {
    const trace = traceId(ctx);
    try {
      const actor = await actorOf(ctx);
      const body: any = ctx?.request?.body ?? {};
      const batchId = Number(body?.batchId);
      const candidateId = Number(body?.candidateId);
      const scope = String(body?.scope ?? 'anomaly');
      const action = String(body?.action ?? '');
      const allowed = ['confirm', 'correct', 'keep-pending', 'reject', 'keep-both', 'mark-duplicate'];
      if (!Number.isFinite(batchId) || !Number.isFinite(candidateId) || !allowed.includes(action)) {
        fail(ctx, 422, 'INVALID_REVIEW_PAYLOAD', `需要 batchId / candidateId 与合法 action（${allowed.join('|')}）`);
        return;
      }

      const batch = await store.getBatchForActor(batchId, uploaderOf(actor));
      if (!batch) {
        fail(ctx, 404, 'BATCH_NOT_FOUND', '批次不存在或你无权查看');
        return;
      }

      const cRepo = db.getRepository('historicalImportCandidates');
      const candidate = await cRepo.findOne({ filter: { id: candidateId, batch_id: batchId } });
      if (!candidate) {
        fail(ctx, 404, 'CANDIDATE_NOT_FOUND', '记录不存在');
        return;
      }

      const oldOverrides = candidate.manual_overrides_json ?? {};
      const newOverrides: Record<string, any> = { ...oldOverrides };
      let status = String(candidate.manual_status ?? 'pending');
      let fieldName: string | null = null;
      let oldValue: unknown = null;
      let newValue: unknown = null;

      if (action === 'confirm') {
        status = 'confirmed';
        oldValue = { manualStatus: candidate.manual_status };
        newValue = { manualStatus: 'confirmed' };
      } else if (action === 'keep-pending') {
        status = 'pending';
        oldValue = { manualStatus: candidate.manual_status };
        newValue = { manualStatus: 'pending' };
      } else if (action === 'reject') {
        status = 'rejected';
        oldValue = { manualStatus: candidate.manual_status };
        newValue = { manualStatus: 'rejected' };
      } else if (action === 'keep-both' || action === 'mark-duplicate') {
        // 去重裁决：**不改任何值**，只记人的意见（"不能自动删除原始记录"）
        status = action === 'mark-duplicate' ? 'rejected' : 'confirmed';
        oldValue = { manualStatus: candidate.manual_status };
        newValue = { manualStatus: status, decision: action };
      } else if (action === 'correct') {
        fieldName = String(body?.field ?? '');
        if (!fieldName) {
          fail(ctx, 422, 'FIELD_REQUIRED', '修正必须指明字段');
          return;
        }
        const check = validateManualValue(fieldName, body?.value);
        if (!check.ok) {
          fail(ctx, 422, 'MANUAL_VALUE_REJECTED', check.why ?? '人工值不合法');
          return;
        }
        // 机器候选值（只读出来做审计，**不回写**）
        const machineValue =
          fieldName === 'customerPhone'
            ? (candidate.fields_json?.customerPhones ?? []).map((p: any) => maskPhone(String(p?.digits ?? '')))
            : (candidate.fields_json ?? {})[fieldName];
        oldValue = machineValue ?? null;
        newValue = body.value;
        newOverrides[fieldName] = {
          value: body.value,
          by: uploaderOf(actor).username,
          at: now().toISOString(),
          note: body?.note ?? null,
        };
        // confirm 的语义包含"我核对并接受了这一行"
        status = 'confirmed';
      }

      // 🔴 只更新**人工层**字段；`fields_json`（机器结果）与原始层一个字都不动
      await cRepo.update({
        filter: { id: candidateId },
        values: {
          manual_status: status,
          manual_overrides_json: newOverrides,
          reviewed_by_user_id: uploaderOf(actor).userId,
          manual_note: body?.note ?? candidate.manual_note ?? null,
        },
      });

      // 审计：真实操作人 / 时间 / 原值 / 新值（用户 B 条）
      await db.getRepository('historicalImportReviews').create({
        values: {
          batch_id: batchId,
          row_id: Number(candidate.row_id),
          mapping_version: Number(candidate.mapping_version ?? 1),
          scope,
          action,
          field_name: fieldName,
          old_value_json: oldValue,
          new_value_json: newValue,
          reason: body?.note ?? null,
          operator_user_id: uploaderOf(actor).userId,
          operator_username: uploaderOf(actor).username,
          operated_at: now(),
        },
      });

      ok(ctx, {
        action: SVC_ACTION.HISTORICAL_REVIEW_ROW,
        candidateId,
        manualStatus: status,
        manualOverrides: newOverrides,
        // 明确回一句：机器结果与原始值都没动（这是用户最关心的那一条）
        machineFieldsUnchanged: true,
        rawLayerUnchanged: true,
      });
    } catch (error) {
      handle(ctx, error, logger, trace, SVC_ACTION.HISTORICAL_REVIEW_ROW);
    }
  };

  // -------------------------------------------------------------------------
  // ③ 跨文件疑似重复
  // -------------------------------------------------------------------------
  //
  // 🔴 范围裁剪：**只在本主体可见的批次里找**。这条不做，"疑似重复"就成了
  //    跨门店客户资料泄漏的通道（用户 C 条最后一句点名的正是这件事）。
  const historicalDuplicates = async (ctx: any): Promise<void> => {
    const trace = traceId(ctx);
    try {
      const actor = await actorOf(ctx);
      const uploader = uploaderOf(actor);
      const batchId = Number(ctx?.request?.query?.batchId ?? ctx?.action?.params?.batchId);
      const visible = await store.listBatchesForActor(uploader, 200);
      const scopeBatches = Number.isFinite(batchId) && batchId > 0 ? visible.filter((b: any) => Number(b.id) === batchId) : visible;
      if (Number.isFinite(batchId) && batchId > 0 && scopeBatches.length === 0) {
        fail(ctx, 404, 'BATCH_NOT_FOUND', '批次不存在或你无权查看');
        return;
      }

      const all: Array<CandidateLite & { batchId: number; batchNo: string }> = [];
      for (const b of scopeBatches) {
        const rows = await loadCandidates(b, 5000);
        all.push(...rows);
      }
      const groups = detectDuplicates(all);
      ok(ctx, {
        action: SVC_ACTION.HISTORICAL_DUPLICATES,
        scannedBatches: scopeBatches.length,
        scannedCandidates: all.length,
        strongCount: groups.filter((g) => g.strength === 'strong').length,
        weakCount: groups.filter((g) => g.strength === 'weak').length,
        groups: groups.slice(0, 200),
        /** 界面上要原话展示：只提示、不合并 */
        note:
          '仅提示疑似重复，**不会自动合并、不会删除任何原始记录**；' +
          '仅凭手机号相同只能算弱证据（同一客户可能有多次真实售后）',
      });
    } catch (error) {
      handle(ctx, error, logger, trace, SVC_ACTION.HISTORICAL_DUPLICATES);
    }
  };

  const historicalDuplicateDecision = async (ctx: any): Promise<void> => {
    const trace = traceId(ctx);
    // 与逐行核对同一条代码路径（动作面不同、语义相同）——
    // 刻意**不另写一份**，因为两份实现必然漂移（本项目记过多次）。
    await historicalReviewRow({
      ...ctx,
      request: { ...(ctx?.request ?? {}), body: { ...(ctx?.request?.body ?? {}), scope: 'duplicate' } },
    });
    void trace;
  };

  // -------------------------------------------------------------------------
  // ④ 确认批次的门店归属（仅总部 + 门店身份须已确认）
  // -------------------------------------------------------------------------
  const historicalConfirmAttribution = async (ctx: any): Promise<void> => {
    const trace = traceId(ctx);
    try {
      const actor = await actorOf(ctx);
      const uploader = uploaderOf(actor);
      const body: any = ctx?.request?.body ?? {};
      const batchId = Number(body?.batchId);
      const storeCode = String(body?.storeCode ?? '').trim();
      /**
       * 归属范围：默认 `production`（保守）。
       * ⚠️ 前端/脚本要传 `scope: 'drill'` 才走演练 —— 而**只有总部 + 显式传参**
       *    才能把范围放宽到 drill，且会写进批次备注（见下方 note）。
       */
      const scope = String(body?.scope ?? 'production') === 'drill' ? 'drill' : 'production';
      if (!Number.isFinite(batchId) || !storeCode) {
        fail(ctx, 422, 'INVALID_ATTRIBUTION_PAYLOAD', '需要 batchId 与 storeCode');
        return;
      }
      if (!uploader.isHq) {
        fail(ctx, 403, 'FORBIDDEN', '只有总部可以确认历史批次的门店归属');
        return;
      }
      const batch = await store.getBatchForActor(batchId, uploader);
      if (!batch) {
        fail(ctx, 404, 'BATCH_NOT_FOUND', '批次不存在或你无权查看');
        return;
      }
      // 🔴 门店身份确认关系：名单里没有它（或它不是 production 范围）⇒ 拒绝
      // 🔴 门店身份确认关系：名单里没有它、或范围不匹配 ⇒ 拒绝
      const entry = await archiveSvc.assertStoreConfirmed(storeCode, scope);
      const storeRow = await db.getRepository('stores').findOne({ filter: { code: storeCode } });
      if (!storeRow) {
        fail(ctx, 422, 'STORE_NOT_FOUND', `系统里没有门店 ${storeCode}`);
        return;
      }
      await db.getRepository('historicalImportBatches').update({
        filter: { id: batchId },
        values: {
          attribution_state: 'confirmed',
          store_id: Number(storeRow.id),
          // 🔴 范围写进批次，归档时按它验证门店身份（避免"确认时放宽、归档时忘记"）
          attribution_scope: scope,
          note:
            `[attribution:${scope}] ${storeCode} 由 ${uploader.username ?? uploader.userId} 于 ${now().toISOString()} 确认` +
            `（依据：${entry.evidence}）` + (scope === 'drill' ? ' ⚠️ 演练归属，非正式业务归属' : ''),
        },
      });
      ok(ctx, {
        action: SVC_ACTION.HISTORICAL_CONFIRM_ATTRIBUTION,
        batchId,
        storeCode,
        storeId: Number(storeRow.id),
        attributionState: 'confirmed',
        attributionScope: scope,
      });
    } catch (error) {
      handle(ctx, error, logger, trace, SVC_ACTION.HISTORICAL_CONFIRM_ATTRIBUTION);
    }
  };

  // -------------------------------------------------------------------------
  // ⑤ 归档（真正的受控归档）
  // -------------------------------------------------------------------------
  const historicalArchive = async (ctx: any): Promise<void> => {
    const trace = traceId(ctx);
    try {
      const actor = await actorOf(ctx);
      const uploader = uploaderOf(actor);
      const body: any = ctx?.request?.body ?? {};
      const batchId = Number(body?.batchId);
      if (!Number.isFinite(batchId) || batchId <= 0) {
        fail(ctx, 422, 'BATCH_ID_REQUIRED', '缺少 batchId');
        return;
      }
      // ① 批次可见性（越权一律 404）
      const batch = await store.getBatchForActor(batchId, uploader);
      if (!batch) {
        fail(ctx, 404, 'BATCH_NOT_FOUND', '批次不存在或你无权访问');
        return;
      }
      // ② 归属已确认
      if (String(batch.attribution_state) !== 'confirmed' || !batch.store_id) {
        fail(
          ctx,
          409,
          'ATTRIBUTION_UNCONFIRMED',
          '门店归属尚未确认（15 家门店与系统编码的对应未完成），本阶段不允许把历史数据正式归档到具体门店',
        );
        return;
      }
      const storeRow = await db.getRepository('stores').findOne({ filter: { id: Number(batch.store_id) } });
      if (!storeRow) {
        fail(ctx, 409, 'STORE_NOT_FOUND', '批次归属的门店已不存在');
        return;
      }
      // ②b 门店身份确认关系（防止"批次被手工改成某门店"绕过名单）。
      //     ⚠️ 用**批次上记录的范围**（而不是写死的 production）——
      //        这样"确认时按 drill 放宽"与"归档时按 drill 校验"用的是同一个值，
      //        不会出现一处放宽、另一处忘记。
      const batchScope = String(batch.attribution_scope ?? 'production') === 'drill' ? 'drill' : 'production';
      await archiveSvc.assertStoreConfirmed(String(storeRow.code), batchScope);

      // ③ 映射版本 / 异常处理状态 / 人工确认
      const candidates = await loadCandidates(batch);
      if (candidates.length === 0) {
        fail(ctx, 409, 'NOTHING_TO_ARCHIVE', '这个批次还没有任何标准化结果，先做一次映射');
        return;
      }
      const archiveRows: ArchiveRowInput[] = candidates.map((c) => ({
        rowId: c.rowId,
        sourceKey: `${c.sheetName}#${c.sourceRow}`,
        sheetName: c.sheetName,
        sourceRow: c.sourceRow,
        fields: c.fields,
        manualOverrides: c.manualOverrides as Record<string, any>,
        issues: c.issues,
        disposition: c.disposition,
        manualStatus: c.manualStatus,
      }));
      // 排除的（非售后）行**不进档案** —— 只作为"我们看过并排除了"的记录留在暂存区
      const archivable = archiveRows.filter((r) => r.disposition === 'importable');
      archiveSvc.assertReadyToArchive(archiveRows);

      const aRepo = db.getRepository('historicalServiceArchives');
      const mappingVersion = Number(batch.mapping_version ?? 1);
      let created = 0;
      let reused = 0;
      const archiveIds: number[] = [];

      for (const r of archivable) {
        const idempotencyKey = buildArchiveIdempotencyKey(Number(batch.id), r.sourceKey, mappingVersion);
        const existing = await aRepo.findOne({ filter: { idempotency_key: idempotencyKey } });
        if (existing) {
          reused += 1;
          archiveIds.push(Number(existing.id));
          continue;
        }
        const summary = archiveSvc.summarize(r);
        let row: any;
        try {
          row = await aRepo.create({
            values: {
              archive_no: archiveSvc.newArchiveNo(),
              idempotency_key: idempotencyKey,
              batch_id: Number(batch.id),
              row_id: r.rowId,
              mapping_version: mappingVersion,
              source_file_name: String(batch.file_name ?? ''),
              source_sheet: r.sheetName,
              source_row: r.sourceRow,
              store_id: Number(storeRow.id),
              store_code_snapshot: String(storeRow.code),
              customer_name: summary.customerName,
              customer_mobile: summary.customerMobile,
              customer_address: summary.customerAddress,
              device_summary: summary.deviceSummary,
              service_date: summary.serviceDate,
              fields_json: r.fields,
              manual_overrides_json: r.manualOverrides,
              anomaly_snapshot_json: { issues: r.issues, manualStatus: r.manualStatus },
              stage: 'archived',
              archived_by_user_id: uploader.userId,
              archived_by_username: uploader.username,
              archived_at: now(),
              archive_note: body?.note ?? null,
              conversion_state: 'none',
            },
          });
        } catch (error) {
          const msg = String((error as any)?.message ?? '');
          if (!/duplicate key|unique constraint|uniq/i.test(msg)) throw error;
          // 并发/重试：唯一键拦住第二次 ⇒ 回查并复用（**这就是幂等**）
          const raced = await aRepo.findOne({ filter: { idempotency_key: idempotencyKey } });
          if (!raced) throw error;
          reused += 1;
          archiveIds.push(Number(raced.id));
          continue;
        }
        created += 1;
        archiveIds.push(Number(row.id));
      }

      ok(ctx, {
        action: SVC_ACTION.HISTORICAL_ARCHIVE,
        batchId: Number(batch.id),
        storeCode: String(storeRow.code),
        mappingVersion,
        consideredRows: archivable.length,
        created,
        reused,
        excludedRowsSkipped: archiveRows.filter((r) => r.disposition === 'excluded').length,
        archiveIds,
        attributionScope: batchScope,
        // 🔴 明确回一句：**没有**创建任何当前服务单，也没动 SLA/KPI
        ticketsCreated: 0,
        slaAffected: false,
      });
    } catch (error) {
      handle(ctx, error, logger, trace, SVC_ACTION.HISTORICAL_ARCHIVE);
    }
  };

  // -------------------------------------------------------------------------
  // ⑥ 查看历史档案（与当前工单分开）
  // -------------------------------------------------------------------------
  const historicalArchives = async (ctx: any): Promise<void> => {
    const trace = traceId(ctx);
    try {
      const actor = await actorOf(ctx);
      const uploader = uploaderOf(actor);
      const query: any = ctx?.request?.query ?? {};
      const storeCode = String(query?.storeCode ?? '').trim();
      const limit = Math.min(Number(query?.limit ?? 50) || 50, 200);

      // 🔴 范围裁剪：总部看全部；门店角色只看自己**看得见的批次**产生的档案
      const visible = await store.listBatchesForActor(uploader, 500);
      const visibleIds = visible.map((b: any) => Number(b.id));
      if (!uploader.isHq && visibleIds.length === 0) {
        ok(ctx, { action: SVC_ACTION.HISTORICAL_ARCHIVES, archives: [], total: 0 });
        return;
      }
      const filter: Record<string, unknown> = { stage: 'archived' };
      if (!uploader.isHq) filter.batch_id = { $in: visibleIds };
      if (storeCode) filter.store_code_snapshot = storeCode;

      const rows = await db.getRepository('historicalServiceArchives').find({
        filter,
        sort: ['-archived_at'],
        limit,
      });
      ok(ctx, {
        action: SVC_ACTION.HISTORICAL_ARCHIVES,
        total: (rows ?? []).length,
        /** 界面上要把这句话显示出来：这是**历史档案**，不是当前在办工单 */
        kind: 'historical-archive',
        notServiceTickets: true,
        archives: (rows ?? []).map((r: any) => ({
          id: Number(r.id),
          archiveNo: r.archive_no,
          batchNo: null,
          storeCode: r.store_code_snapshot,
          sourceFileName: r.source_file_name,
          sourceSheet: r.source_sheet,
          sourceRow: r.source_row,
          mappingVersion: r.mapping_version,
          customerName: r.customer_name,
          // 出口统一脱敏
          customerMobileMasked: r.customer_mobile ? maskPhone(String(r.customer_mobile)) : null,
          deviceSummary: r.device_summary,
          serviceDate: r.service_date,
          archivedBy: r.archived_by_username,
          archivedAt: r.archived_at,
          conversionState: r.conversion_state,
          anomaly: r.anomaly_snapshot_json,
        })),
      });
    } catch (error) {
      handle(ctx, error, logger, trace, SVC_ACTION.HISTORICAL_ARCHIVES);
    }
  };

  // -------------------------------------------------------------------------
  // ⑦ 转为当前服务单（一次一条、必填理由、不批量）
  // -------------------------------------------------------------------------
  const historicalConvertToTicket = async (ctx: any): Promise<void> => {
    const trace = traceId(ctx);
    try {
      const actor = await actorOf(ctx);
      const uploader = uploaderOf(actor);
      const body: any = ctx?.request?.body ?? {};

      // 🔴 不接受数组：用户明令"**不得批量自动转单**"。
      //    写成"只接受一个 id"，就从接口形状上排除了批量调用 ——
      //    比"记得别传数组"可靠。
      if (Array.isArray(body?.archiveIds) || Array.isArray(body?.archiveId)) {
        fail(ctx, 422, 'BATCH_CONVERSION_NOT_ALLOWED', '不支持批量转单：一次只能转一条历史档案');
        return;
      }
      const archiveId = Number(body?.archiveId);
      const reason = String(body?.reason ?? '').trim();
      if (!Number.isFinite(archiveId) || archiveId <= 0) {
        fail(ctx, 422, 'ARCHIVE_ID_REQUIRED', '缺少 archiveId');
        return;
      }
      if (reason.length < 4) {
        fail(ctx, 422, 'REASON_REQUIRED', '必须填写"为什么这条历史事项仍需继续处理"（至少 4 字）');
        return;
      }
      if (!uploader.isHq) {
        fail(ctx, 403, 'FORBIDDEN', '只有总部可以把历史事项转为当前服务单');
        return;
      }

      const aRepo = db.getRepository('historicalServiceArchives');
      const archive = await aRepo.findOne({ filter: { id: archiveId, stage: 'archived' } });
      if (!archive) {
        fail(ctx, 404, 'ARCHIVE_NOT_FOUND', '历史档案不存在或已撤销');
        return;
      }
      const cRepo = db.getRepository('historicalTicketConversions');
      const idempotencyKey = buildConversionIdempotencyKey(archiveId);
      const existed = await cRepo.findOne({ filter: { idempotency_key: idempotencyKey } });
      if (existed) {
        // 重试安全：返回既有转换结果，不新建工单
        ok(ctx, {
          action: SVC_ACTION.HISTORICAL_CONVERT_TO_TICKET,
          archiveId,
          reused: true,
          ticketId: existed.ticket_id ?? null,
          ticketNo: existed.ticket_no ?? null,
        });
        return;
      }

      // 建当前服务单：走既有的服务层入口，保证与正常建单同一条路径
      const storeRow = await db.getRepository('stores').findOne({ filter: { id: Number(archive.store_id) } });
      if (!storeRow) {
        fail(ctx, 409, 'STORE_NOT_FOUND', '档案归属的门店已不存在，无法转单');
        return;
      }
      // 转单要建**当前工单**，而工单必须有合法手机号 ⇒ 在**建单之前**挡住，
      // 否则会走到 `TicketService.create` 抛校验错，错误文案与"转单"语境对不上。
      if (!archive.customer_mobile) {
        fail(
          ctx,
          422,
          'ARCHIVE_HAS_NO_MOBILE',
          '这条历史档案没有可用手机号，无法转成当前服务单（请先回到异常核对里补全）',
        );
        return;
      }
      /**
       * ⚠️ `TicketService.create()` 返回的是 **`{ ticket, event, store }`**，不是工单本身。
       *    第一版按 `{ id, ticket_no }` 取值 ⇒ `Number(undefined)` = `NaN`
       *    ⇒ PG 报 `invalid input syntax for type bigint: "NaN"`，
       *    而**工单其实已经建出来了** —— 结果是"报 500 但工单多了 2 张"。
       *    这类"部分成功"最阴：接口说失败，数据却变了。
       */
      const createdTicket = await services.tickets.create({
        storeId: Number(storeRow.id),
        ticketType: 'repair',
        source: 'staff',
        customerName: archive.customer_name,
        customerMobile: archive.customer_mobile,
        content: `[历史转入] ${reason}`,
        serviceAddress: archive.customer_address,
        ...(archive.device_summary ? { brandModel: String(archive.device_summary).slice(0, 64) } : {}),
      });
      const ticket = createdTicket?.ticket ?? createdTicket;
      if (ticket?.id == null) {
        // 建单返回了不可用的形状 ⇒ 明确报错（宁可见的红，也不要 `NaN` 落到 SQL 里）
        throw new HistoricalImportError(
          'TICKET_CREATE_RETURNED_NO_ID',
          '创建当前服务单后没有拿到工单 id（服务层返回形状与预期不符）',
          500,
        );
      }

      await cRepo.create({
        values: {
          archive_id: archiveId,
          batch_id: Number(archive.batch_id),
          row_id: Number(archive.row_id),
          idempotency_key: idempotencyKey,
          ticket_id: Number(ticket.id),
          ticket_no: ticket.ticket_no,
          reason,
          note: body?.note ?? null,
          converted_by_user_id: uploader.userId,
          converted_by_username: uploader.username,
          converted_at: now(),
          snapshot_json: {
            archiveNo: archive.archive_no,
            storeCode: archive.store_code_snapshot,
            mappingVersion: archive.mapping_version,
            sourceFileName: archive.source_file_name,
            sourceSheet: archive.source_sheet,
            sourceRow: archive.source_row,
          },
        },
      });
      // 档案侧同步状态（与转换记录**同一个事实的两面**，门禁断言二者一致）
      await aRepo.update({ filter: { id: archiveId }, values: { conversion_state: 'converted' } });

      ok(ctx, {
        action: SVC_ACTION.HISTORICAL_CONVERT_TO_TICKET,
        archiveId,
        reused: false,
        ticketId: Number(ticket.id),
        ticketNo: ticket.ticket_no,
        sourceLink: {
          archiveNo: archive.archive_no,
          mappingVersion: archive.mapping_version,
          sourceFileName: archive.source_file_name,
          sourceSheet: archive.source_sheet,
          sourceRow: archive.source_row,
        },
      });
    } catch (error) {
      handle(ctx, error, logger, trace, SVC_ACTION.HISTORICAL_CONVERT_TO_TICKET);
    }
  };

  return {
    [SVC_ACTION.HISTORICAL_REVIEW_SUMMARY]: historicalReviewSummary,
    [SVC_ACTION.HISTORICAL_REVIEW_ROW]: historicalReviewRow,
    [SVC_ACTION.HISTORICAL_DUPLICATES]: historicalDuplicates,
    [SVC_ACTION.HISTORICAL_DUPLICATE_DECISION]: historicalDuplicateDecision,
    [SVC_ACTION.HISTORICAL_CONFIRM_ATTRIBUTION]: historicalConfirmAttribution,
    [SVC_ACTION.HISTORICAL_ARCHIVE]: historicalArchive,
    [SVC_ACTION.HISTORICAL_ARCHIVES]: historicalArchives,
    [SVC_ACTION.HISTORICAL_CONVERT_TO_TICKET]: historicalConvertToTicket,
  };
}

/** 与 `historical-import.ts` 同一口径的错误出口（status 由错误实例自带） */
function handle(
  ctx: any,
  error: unknown,
  logger: { warn?: (m: string) => void; error?: (m: string) => void } | undefined,
  trace: string,
  actionName: string,
): void {
  if (error instanceof HistoricalImportError) {
    if (error.httpStatus >= 500) logger?.error?.(`[svc:${actionName}] ${error.code}（trace=${trace}）：${error.message}`);
    else logger?.warn?.(`[svc:${actionName}] ${error.httpStatus} ${error.code}（trace=${trace}）：${error.message}`);
    fail(ctx, error.httpStatus, error.code, error.message, { traceId: trace });
    return;
  }
  logger?.error?.(`[svc:${actionName}] 未预期异常（trace=${trace}）：${String((error as Error)?.message ?? error)}`);
  fail(ctx, 500, 'INTERNAL_ERROR', '服务端异常，请稍后重试', { traceId: trace });
}
