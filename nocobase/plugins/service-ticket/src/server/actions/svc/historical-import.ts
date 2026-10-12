/**
 * P11-3 第 3 项：历史 Excel 导入的**服务端动作**
 *
 * ===========================================================================
 * 五个动作，一条链：上传 → 预览 → 暂存 → 读取 →（归档，本阶段恒拒）
 * ===========================================================================
 *   `historicalUpload`   收文件、解析、写**隔离暂存区**（原始层 + 自动映射）
 *   `historicalPreview`  **只读**算一遍：给定映射，返回原始值→标准化值对照 + 异常 + 分类
 *   `historicalStage`    按当前映射**写**标准化层，mapping_version +1（旧版本不删）
 *   `historicalBatches`  列可见批次 / 取某一批的行（手机号一律脱敏）
 *   `historicalArchive`  **本阶段恒定 409**：门店归属未确认 ⇒ 不得正式归档
 *
 * 🔴 整条链**没有任何一处**会：写 store_id / 创建正式工单 / 跨文件自动合并。
 *
 * ===========================================================================
 * 鉴权与可见范围（用户第 5 条）
 * ===========================================================================
 *   · 五个动作全部在 `AUTHENTICATED_SVC_ACTIONS` 里 ⇒ **必须登录**；
 *   · 暂存区里是**客户原始数据** ⇒ 绝不能匿名可达，这是它不进匿名白名单的原因；
 *   · 门店角色只能看**自己上传**的批次；总部看全部；
 *     `visibility_scope='hq'` 的批次连上传者本人也读不到（那是"只给总部看"的语义）。
 *
 * ===========================================================================
 * 隐私（用户第 6 条）
 * ===========================================================================
 *   · 列表/统计响应里的手机号一律 `maskPhone()`；
 *   · 解析异常与告警**不落客户信息**（warnings 里只有结构性描述）；
 *   · 原始单元格只在 `historicalBatches` 的"取某批的行"里出现，且同样受上面两条约束。
 */
// ⚠️ `koaMulter` 从 `@nocobase/utils` 取（与 `technician/visit.ts` 同款），
//    不是从 multer 直接取默认导出 —— 后者拿到的是 factory 本身，
//    调用形态与 koa 中间件不同，且这类差异不会报错，只会让上传静默拿不到文件。
import { koaMulter } from '@nocobase/utils';
import { memoryStorage } from 'multer';

import { SVC_ACTION } from '../../constants';
import { ROLE } from '../../constants';
import { fail, ok, traceId } from './_http';
import { IMPORT_LIMITS } from '../../services/historical-import/limits';
import { HistoricalImportRejected } from '../../services/historical-import/limits';
import { parseWorkbook } from '../../services/historical-import/parse';
import { applyMapping, buildSourceKey, MAPPING_FIELDS, MAPPING_FIELD_LABELS, DISPOSITIONS } from '../../services/historical-import/mapping';
import { createHistoricalImportStore, hashFile, HistoricalImportError } from '../../services/historical-import/store';
import { maskPhone } from '../../services/historical-import/normalize';

/** multipart 的字段名（与前端约定，且必须与 multer `.single()` 一致） */
const UPLOAD_FIELD_NAME = 'file';

export interface HistoricalImportActionDeps {
  services: any;
  /** 双层存储要下库：与 report 三条接口同理，services 刻意不暴露原始句柄 */
  db: any;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

/** 判定"总部视角"：总部角色 或 NocoBase 平台超管（root/admin） */
function isHqActor(actor: any): boolean {
  const roles: string[] = Array.isArray(actor?.roles) ? actor.roles.map((r: unknown) => String(r)) : [];
  const platform: string[] = Array.isArray(actor?.platformRoles)
    ? actor.platformRoles.map((r: unknown) => String(r).toLowerCase())
    : [];
  return (
    roles.includes(ROLE.HQ_ADMIN) ||
    roles.includes('hq_service') ||
    platform.includes('root') ||
    platform.includes('admin')
  );
}

/** 把标准化结果里的手机号脱敏（**出口统一**，不靠各分支自觉） */
function maskCandidate(fields: Record<string, unknown>): Record<string, unknown> {
  const phones = (fields?.customerPhones ?? []) as Array<{ digits?: string; kind?: string; valid?: boolean }>;
  return {
    ...fields,
    customerPhones: phones.map((p) => ({
      // 只保留形状与掩码：列表里出现完整号码就是一次泄漏
      masked: maskPhone(String(p.digits ?? '')),
      kind: p.kind,
      valid: p.valid,
    })),
  };
}

export function createHistoricalImportHandlers(
  deps: HistoricalImportActionDeps,
): Record<string, (ctx: any, next?: any) => Promise<void>> {
  const { services, db, logger } = deps;
  const { permissions } = services ?? {};
  const store = createHistoricalImportStore({ db, logger });

  /** 统一取操作者（未登录 ⇒ resolveActor 抛 401，不在这里另写一套） */
  const actorOf = async (ctx: any): Promise<any> => permissions?.resolveActor(ctx);

  const uploaderOf = (actor: any) => ({
    userId: actor?.userId ?? null,
    username: actor?.raw?.username ?? actor?.raw?.nickname ?? null,
    isHq: isHqActor(actor),
  });

  // -------------------------------------------------------------------------
  // ① 上传并解析 → 隔离暂存
  // -------------------------------------------------------------------------
  const historicalUpload = async (ctx: any): Promise<void> => {
    const trace = traceId(ctx);
    try {
      const actor = await actorOf(ctx);

      if (!ctx?.request?.is?.('multipart/*')) {
        fail(ctx, 415, 'UPLOAD_NOT_MULTIPART', '请用 multipart/form-data 上传，字段名 file');
        return;
      }

      // ⚠️ 字节上限在**流式阶段**就拦下（与照片上传同款做法）：
      //    等到 read 完再判，20 MB 已经进内存了 —— 那不是限额，是事后统计。
      const middleware = koaMulter({
        storage: memoryStorage(),
        limits: { files: 1, fileSize: IMPORT_LIMITS.MAX_FILE_BYTES },
      }).single(UPLOAD_FIELD_NAME);
      try {
        await middleware(ctx, async () => {});
      } catch (error: any) {
        const code = error?.code;
        if (error?.name === 'MulterError' && code === 'LIMIT_FILE_SIZE') {
          fail(
            ctx,
            413,
            'FILE_TOO_LARGE',
            `单个文件不能超过 ${Math.floor(IMPORT_LIMITS.MAX_FILE_BYTES / 1024 / 1024)}MB`,
          );
          return;
        }
        if (error?.name === 'MulterError') {
          fail(ctx, 422, 'UPLOAD_MALFORMED', `上传内容无法解析（${String(code)}）`);
          return;
        }
        throw error;
      }

      const file: any = ctx?.[UPLOAD_FIELD_NAME] ?? ctx?.request?.file ?? null;
      if (!file?.buffer) {
        fail(ctx, 422, 'UPLOAD_EMPTY', '没有收到文件内容');
        return;
      }

      const buf: Buffer = file.buffer;
      /**
       * 🔴 文件名必须从 **latin1 还原成 UTF-8**。
       *
       * multipart 头里的 `filename="…"` 是**字节串**，而 busboy/multer 按
       * latin1 逐个字节解释它 ⇒ 中文名会变成 `æ±å®¶çµ9æœˆ…` 这种乱码。
       * 2026-10-12 实测：`江华家电9月原始数据.xlsx` 入库即乱码，
       * 而**没有任何断言会红** —— 文件照样解析、批次照样建、行数照样对。
       * 唯一能发现它的地方是"人去看批次列表"。这种缺陷正是"库里有、界面丑"的典型。
       *
       * ⚠️ 只做 latin1→utf8 一次；失败（非法字节序列）时原样保留，
       *    不抛错 —— 文件名不该成为"这个文件导不进来"的理由。
       */
      const fileName = (() => {
        const raw = String(file.originalname ?? 'upload.xlsx');
        try {
          const decoded = Buffer.from(raw, 'latin1').toString('utf8');
          // 还原后若出现替换字符 U+FFFD，说明原串本来就是合法的 UTF-8（不该再转）
          return decoded.includes('\uFFFD') ? raw : decoded;
        } catch {
          return raw;
        }
      })();
      const fileHash = hashFile(buf);

      // ---- 解析（限额 / 魔数 / zip 膨胀 / 依赖版本闸都在这里）----
      let parsed: any;
      try {
        parsed = parseWorkbook(fileName, buf);
      } catch (error) {
        if (error instanceof HistoricalImportRejected) {
          // ⚠️ 只回**结构性**原因：detail 里可能带客户数据（见 limits 的注释）
          fail(ctx, 422, error.code, error.message);
          return;
        }
        throw error;
      }

      const uploader = uploaderOf(actor);
      const batch = await store.createBatch({
        fileName,
        fileHash,
        fileBytes: buf.length,
        detectedKind: parsed.file.detectedKind,
        parserName: parsed.parser.name,
        parserVersion: parsed.parser.version,
        date1904: parsed.parser.date1904,
        uploader,
        totals: parsed.totals,
        ledger: parsed.ledger,
        quality: parsed.quality,
        warnings: parsed.warnings,
        mapping: Object.fromEntries(
          parsed.sheets.map((s: any) => [s.sheet, { headerRow: s.headerRow, fields: s.mapping.fields }]),
        ),
      });

      // ---- 原始层（重复上传 ⇒ 这里实际写入 0 行）----
      const { inserted, skipped } = await store.appendRawRows(
        batch.id,
        fileHash,
        parsed.sheets.map((s: any) => ({
          sheetName: s.sheet,
          sheetIndex: s.sheetIndex,
          headerRow: s.headerRow,
          header: s.header,
          classification: s.classification,
          rows: s.rows.map((r: any) => ({ sourceRow: r.sourceRow, cells: r.raw })),
        })),
      );

      // ---- 界面要的东西：工作表清单 / 表头 / 自动映射 / 台账 / 可选字段 ----
      const sheets = parsed.sheets.map((s: any) => ({
        sheet: s.sheet,
        sheetIndex: s.sheetIndex,
        classification: s.classification,
        classificationBasis: s.classificationBasis,
        headerRow: s.headerRow,
        header: s.header,
        autoMapping: s.mapping.fields,
        /**
         * 同一逻辑字段命中了多列 ⇒ **必须**让门店人员选。
         * 真实样本：康乐 Sheet2 的电话有「用户电话」(1/105 有值) 与
         * 「手机号」(105/105 有值) 两列，自动映射取了前者 ——
         * 不让人改，就会被读成"这批数据 104 行没电话"。
         */
        ambiguous: s.mapping.ambiguous,
        unmapped: s.mapping.unmapped,
        ledger: s.ledger,
        quality: s.quality,
        rowCount: s.dataRowCount,
      }));

      ok(ctx, {
        action: SVC_ACTION.HISTORICAL_UPLOAD,
        batch: {
          id: batch.id,
          batchNo: batch.batchNo,
          fileName: batch.fileName,
          fileHash: batch.fileHash,
          fileBytes: buf.length,
          detectedKind: parsed.file.detectedKind,
          parserVersion: parsed.parser.version,
          stage: batch.stage,
          attributionState: batch.attributionState,
          visibilityScope: batch.visibilityScope,
          mappingVersion: batch.mappingVersion,
          reused: batch.reused,
          /**
           * 🔴 只回布尔：同一内容的文件**已被不可见的其它主体**传过。
           *    **不含** batch_id / batch_no / 上传者 —— 回任何一个都是跨主体信息泄漏。
           *    用户第 A.2 条要的是"识别重复上传"，不是"让对方看见别人的批次"。
           */
          previouslyUploadedByOthers: batch.previouslyUploadedByOthers,
        },
        rawRows: { inserted, skipped },
        ledger: parsed.ledger,
        quality: parsed.quality,
        totals: parsed.totals,
        warnings: parsed.warnings,
        sheets,
        mappingFields: MAPPING_FIELDS,
        dispositions: DISPOSITIONS,
      });
    } catch (error) {
      handleHistoricalError(ctx, error, logger, trace, SVC_ACTION.HISTORICAL_UPLOAD);
    }
  };

  // -------------------------------------------------------------------------
  // ② 预览：**只读**，不写库、不递增映射版本
  // -------------------------------------------------------------------------
  const historicalPreview = async (ctx: any): Promise<void> => {
    const trace = traceId(ctx);
    try {
      const actor = await actorOf(ctx);
      const uploader = uploaderOf(actor);
      const body: any = ctx?.request?.body ?? {};
      const batchId = Number(body?.batchId ?? (ctx?.action?.params as any)?.batchId);
      if (!Number.isFinite(batchId) || batchId <= 0) {
        fail(ctx, 422, 'BATCH_ID_REQUIRED', '缺少 batchId');
        return;
      }
      const batch = await store.getBatchForActor(batchId, uploader);
      if (!batch) {
        // 越权与不存在同码（不让响应码成为"批次存在性"的探测器）
        fail(ctx, 404, 'BATCH_NOT_FOUND', '批次不存在或你无权查看');
        return;
      }

      const sheetsInput = Array.isArray(body?.sheets) ? body.sheets : [];
      const limit = Math.min(Number(body?.limit ?? 20) || 20, 200);

      const rowsRepo = db.getRepository('historicalImportRows');
      const results: any[] = [];
      let previewed = 0;

      for (const req of sheetsInput) {
        const sheetName = String(req?.sheetName ?? '');
        const override: Record<string, number> = req?.fields ?? {};
        const headerRow = Number(req?.headerRow ?? 0) || undefined;
        if (!sheetName) continue;

        const rawRows = await rowsRepo.find({
          filter: { batch_id: batchId, sheet_name: sheetName },
          fields: ['id', 'source_row', 'cells_json', 'header_json', 'classification'],
          sort: ['source_row'],
        });
        if (!rawRows || rawRows.length === 0) continue;

        const header: string[] = (rawRows[0] as any).header_json ?? [];
        const classification = String((rawRows[0] as any).classification ?? 'needs-review');
        // 未指定 headerRow 时用存下来的那一个
        const effectiveHeaderRow = headerRow ?? Number((rawRows[0] as any).header_row ?? 1);

        const mapping = {
          headerRow: effectiveHeaderRow,
          // 界面传什么用什么；没传的字段**不映射**（不猜）
          fields: override,
        };

        const applied = applyMapping({
          sheetName,
          header,
          sheetClass: classification,
          mapping,
          rows: (rawRows as any[]).map((r: any) => ({
            sourceRow: Number(r.source_row),
            cells: r.cells_json ?? {},
          })),
          date1904: false,
          fileHash: String(batch.file_hash),
        });

        results.push({
          sheetName,
          headerRow: effectiveHeaderRow,
          header,
          classification,
          counts: applied.counts,
          quality: applied.quality,
          // ⚠️ 预览只给**前 N 行**，但计数给全量 —— 门店人员要的是"整批有多少问题"
          preview: applied.rows.slice(0, limit).map((r) => ({
            sourceRow: r.sourceRow,
            disposition: r.disposition,
            dispositionReason: r.dispositionReason,
            issues: r.issues,
            // 左：原始值（按映射指回的那一格）；右：标准化值
            raw: Object.fromEntries(
              Object.entries(r.rawRefs).map(([f, v]) => [MAPPING_FIELD_LABELS[f] ?? f, v.raw]),
            ),
            standardized: maskCandidate(r.fields),
          })),
          totalRows: applied.rows.length,
        });
        previewed += applied.rows.length;
      }

      ok(ctx, {
        action: SVC_ACTION.HISTORICAL_PREVIEW,
        batchId,
        mappingVersion: Number(batch.mapping_version ?? 1),
        sheets: results,
        previewedRows: previewed,
        // 🔴 提醒界面：预览**没有**写库，要留痕得调 historicalStage
        staged: false,
      });
    } catch (error) {
      handleHistoricalError(ctx, error, logger, trace, SVC_ACTION.HISTORICAL_PREVIEW);
    }
  };

  // -------------------------------------------------------------------------
  // ③ 暂存：写标准化层（mapping_version +1，旧版本不删）
  // -------------------------------------------------------------------------
  const historicalStage = async (ctx: any): Promise<void> => {
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
      const batch = await store.getBatchForActor(batchId, uploader);
      if (!batch) {
        fail(ctx, 404, 'BATCH_NOT_FOUND', '批次不存在或你无权查看');
        return;
      }

      const sheetsInput = Array.isArray(body?.sheets) ? body.sheets : [];
      const currentVersion = await store.currentMappingVersion(batchId);
      const nextVersion = currentVersion + 1;

      const rowsRepo = db.getRepository('historicalImportRows');
      const rowsRepoAll = db.getRepository('historicalImportCandidates');

      /**
       * 判重：同一 `source_key` 出现在**别的批次**（即**别的文件**）里 ⇒ 标疑似重复。
       *
       * ===========================================================================
       * 🔴 2026-10-12 修正：**同一批次自己的旧版本不算重复**
       * ===========================================================================
       * 第一版把"这一行在本批次的**上一代**里出现过"也算作 `duplicate`。
       * 后果（真实踩到）：把同一份文件、同一套映射**再暂存一次**（换个 mapping_version），
       * 全部行都会被标成"疑似重复" —— 于是：
       *   · 界面上"疑似重复 105"这个数字**与跨文件去重毫无关系**（它只是"重跑过"）；
       *   · 归档前置的"待处理重复行"把整批卡住，而人根本无从"处理"——
       *     那不是重复，那就是同一批数据。
       *
       * ⇒ 判重的**范围必须是跨批次**（不同的 source file），这才对得上
       *   用户 C 条那句「**跨文件**可根据客户联系方式、业务日期、家电信息等提示疑似重复」。
       *   同批次重跑同映射是**幂等**，不该产生任何"待处理"。
       *
       * ⚠️ 范围同时收在**本主体看得见的批次**内（用 `listBatchesForActor`）——
       *    否则"疑似重复"就成了跨门店客户资料泄漏的通道。
       */
      const visibleBatches = await store.listBatchesForActor(uploaderOf(actor), 200);
      const otherBatchIds = (visibleBatches ?? [])
        // 🔴 **作废批次不参与跨文件判重**。
        //    第一版把它们算进来了，后果：本机因为早前的验收/变异跑留下若干
        //    `stage='voided'` 的重复批次，于是"同一份文件的同一行"在那些作废批次里
        //    也能找到 ⇒ 每一次正常暂存都会把整批标成"疑似重复"。
        //    实测表现：康乐 Sheet2 的 105 行全部变成 `duplicate`，
        //    而它们与"跨文件重复"毫无关系。
        //    ⚠️ 作废不等于删除：行仍然在库里（可审计），只是**不再参与判重**。
        .filter((b: any) => String(b.stage) !== 'voided')
        .map((b: any) => Number(b.id))
        .filter((id: number) => id !== Number(batchId));
      const priorKeys = new Set<string>();
      if (otherBatchIds.length > 0) {
        const priorRows = await rowsRepo.find({
          filter: { batch_id: { $in: otherBatchIds } },
          fields: ['id', 'source_key'],
        });
        for (const r of priorRows ?? []) priorKeys.add(String((r as any).source_key));
      }

      const toWrite: any[] = [];
      const perSheet: any[] = [];

      for (const req of sheetsInput) {
        const sheetName = String(req?.sheetName ?? '');
        if (!sheetName) continue;
        const rawRows = await rowsRepo.find({
          filter: { batch_id: batchId, sheet_name: sheetName },
          fields: ['id', 'source_row', 'cells_json', 'header_json', 'classification'],
          sort: ['source_row'],
        });
        if (!rawRows || rawRows.length === 0) continue;

        const header: string[] = (rawRows[0] as any).header_json ?? [];
        const classification = String((rawRows[0] as any).classification ?? 'needs-review');
        const applied = applyMapping({
          sheetName,
          header,
          sheetClass: classification,
          mapping: { headerRow: Number(req?.headerRow ?? 1), fields: req?.fields ?? {} },
          rows: (rawRows as any[]).map((r: any) => ({
            sourceRow: Number(r.source_row),
            cells: r.cells_json ?? {},
          })),
          date1904: false,
          fileHash: String(batch.file_hash),
        });

        for (let i = 0; i < applied.rows.length; i++) {
          const r = applied.rows[i];
          const sourceKey = buildSourceKey(String(batch.file_hash), sheetName, r.sourceRow);
          const disposition = priorKeys.has(sourceKey) ? 'duplicate' : r.disposition;
          toWrite.push({
            rowId: Number((rawRows[i] as any).id),
            sheetName,
            sourceRow: r.sourceRow,
            disposition,
            dispositionReason: priorKeys.has(sourceKey)
              ? '同一份材料此前已从**另一个文件**导入过（同一来源行），请人工判断是否重复'
              : r.dispositionReason,
            fields: r.fields,
            rawRefs: r.rawRefs,
            issues: r.issues,
          });
        }
        perSheet.push({ sheetName, counts: applied.counts, quality: applied.quality });
      }

      const { mappingVersion, written } = await store.writeCandidates(batchId, nextVersion, toWrite);

      // 分类求和（互斥）：按 disposition 分组
      const counts: Record<string, number> = { importable: 0, 'needs-confirm': 0, duplicate: 0, excluded: 0, 'parse-error': 0 };
      for (const r of toWrite) counts[r.disposition] = (counts[r.disposition] ?? 0) + 1;

      ok(ctx, {
        action: SVC_ACTION.HISTORICAL_STAGE,
        batchId,
        mappingVersion,
        written,
        counts,
        sheets: perSheet,
        // 🔴 明确回一句"还没归属、也没变成工单"，避免界面误以为导入完成
        attributionState: 'unconfirmed',
        ticketsCreated: 0,
      });
    } catch (error) {
      handleHistoricalError(ctx, error, logger, trace, SVC_ACTION.HISTORICAL_STAGE);
    }
  };

  // -------------------------------------------------------------------------
  // ④ 读取批次 / 行（手机号脱敏）
  // -------------------------------------------------------------------------
  const historicalBatches = async (ctx: any): Promise<void> => {
    const trace = traceId(ctx);
    try {
      const actor = await actorOf(ctx);
      const uploader = uploaderOf(actor);
      const params: any = ctx?.action?.params ?? {};
      const query: any = ctx?.request?.query ?? {};
      const batchId = Number(params?.batchId ?? query?.batchId);

      if (Number.isFinite(batchId) && batchId > 0) {
        const batch = await store.getBatchForActor(batchId, uploader);
        if (!batch) {
          fail(ctx, 404, 'BATCH_NOT_FOUND', '批次不存在或你无权查看');
          return;
        }
        const limit = Math.min(Number(query?.limit ?? 50) || 50, 200);
        const candidates = await db.getRepository('historicalImportCandidates').find({
          filter: { batch_id: batchId, mapping_version: Number(batch.mapping_version ?? 1) },
          fields: ['id', 'row_id', 'disposition', 'fields_json', 'issues_json', 'manual_status'],
          limit,
        });
        ok(ctx, {
          action: SVC_ACTION.HISTORICAL_BATCHES,
          batch: {
            id: batch.id,
            batchNo: batch.batch_no,
            fileName: batch.file_name,
            fileBytes: batch.file_bytes,
            detectedKind: batch.detected_kind,
            stage: batch.stage,
            attributionState: batch.attribution_state,
            visibilityScope: batch.visibility_scope,
            mappingVersion: batch.mapping_version,
            uploaderUsername: batch.uploader_username,
            uploadedAt: batch.uploaded_at,
            totals: batch.totals_json,
            ledger: batch.ledger_json,
            quality: batch.quality_json,
            warnings: batch.warnings_json,
            mapping: batch.mapping_json,
          },
          candidates: (candidates ?? []).map((c: any) => ({
            id: c.id,
            disposition: c.disposition,
            manualStatus: c.manual_status,
            issues: c.issues_json,
            fields: maskCandidate(c.fields_json ?? {}),
          })),
        });
        return;
      }

      const list = await store.listBatchesForActor(uploader);
      ok(ctx, {
        action: SVC_ACTION.HISTORICAL_BATCHES,
        batches: (list ?? []).map((b: any) => ({
          id: b.id,
          batchNo: b.batch_no,
          fileName: b.file_name,
          fileBytes: b.file_bytes,
          detectedKind: b.detected_kind,
          stage: b.stage,
          attributionState: b.attribution_state,
          visibilityScope: b.visibility_scope,
          mappingVersion: b.mapping_version,
          uploaderUsername: b.uploader_username,
          uploadedAt: b.uploaded_at,
          totals: b.totals_json,
          ledger: b.ledger_json,
        })),
      });
    } catch (error) {
      handleHistoricalError(ctx, error, logger, trace, SVC_ACTION.HISTORICAL_BATCHES);
    }
  };

  // -------------------------------------------------------------------------
  // ⑤ 正式归档 —— **已迁出本文件**
  // -------------------------------------------------------------------------
  //
  // ⚠️ 2026-10-12（P11-3 第 4 项）：归档从"恒定拒绝的占位实现"变成了
  //    **真正的受控归档闭环**，实现在 `./historical-review-archive.ts`。
  //    两处都注册会导致 plugin.ts 只取先命中的那一个（**另一份静默不生效**）——
  //    这正是本项目记过的"同一段逻辑两条腿"。
  //    ⇒ 这里**只保留一个返回 404 的空壳**是不行的；干脆不注册：
  //      `handlerSets` 里由 `createHistoricalReviewArchiveHandlers` 提供。
  //
  //    本文件由此**不再** import `archiveToStore`（它也已被换成真实实现）。

  return {
    [SVC_ACTION.HISTORICAL_UPLOAD]: historicalUpload,
    [SVC_ACTION.HISTORICAL_PREVIEW]: historicalPreview,
    [SVC_ACTION.HISTORICAL_STAGE]: historicalStage,
    [SVC_ACTION.HISTORICAL_BATCHES]: historicalBatches,
    // ⚠️ **不在这里注册** `HISTORICAL_ARCHIVE`：
    //    它已迁到 `./historical-review-archive.ts`（真实受控归档）。
    //    plugin.ts 的 handlerSets 按数组顺序取**第一个**命中的 handler ——
    //    两处都注册的话，后注册的那份**永远不会被执行**，且没有任何报错。
    //    这正是本项目记过的"同一段逻辑两条腿，一条漏了就是一次事故"。
  };
}

/**
 * 本组动作的错误出口。
 *
 * ⚠️ `HistoricalImportError` 自带 `httpStatus` ⇒ **按 code 二次判定**是错的，
 *    两处一旦不同步就会出现"错误类说 409、响应却是 400"。
 *    与 `ValidationError` / `VisitValidationError` 同口径：status 由实例自带。
 */
function handleHistoricalError(
  ctx: any,
  error: unknown,
  logger: { warn?: (m: string) => void; error?: (m: string) => void } | undefined,
  trace: string,
  actionName: string,
): void {
  if (error instanceof HistoricalImportError) {
    if (error.httpStatus >= 500) {
      logger?.error?.(`[svc:${actionName}] ${error.code}（trace=${trace}）：${error.message}`);
    } else {
      logger?.warn?.(`[svc:${actionName}] ${error.httpStatus} ${error.code}（trace=${trace}）：${error.message}`);
    }
    fail(ctx, error.httpStatus, error.code, error.message, { traceId: trace });
    return;
  }
  if (error instanceof HistoricalImportRejected) {
    logger?.warn?.(`[svc:${actionName}] 422 ${error.code}（trace=${trace}）：${error.message}`);
    fail(ctx, 422, error.code, error.message, { traceId: trace });
    return;
  }
  logger?.error?.(
    `[svc:${actionName}] 未预期异常（trace=${trace}）：${String((error as Error)?.message ?? error)}`,
  );
  fail(ctx, 500, 'INTERNAL_ERROR', '服务端异常，请稍后重试', { traceId: trace });
}
