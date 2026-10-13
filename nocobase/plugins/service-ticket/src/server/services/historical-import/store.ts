/**
 * 历史 Excel 导入 —— **双层持久化**（P11-3 第 3 项 · 3.2 / 3.5 / 3.6）
 *
 * ===========================================================================
 * 原始层 vs 标准化层：为什么必须分开
 * ===========================================================================
 *   · 原始层（`historicalImportRows`）**只追加**：写入后不再 UPDATE。
 *     它存在的唯一理由是"事后还能看到 Excel 里原来写着什么"。
 *   · 标准化层（`historicalImportCandidates`）**按 mapping_version 分代**：
 *     每次改映射 ⇒ 版本 +1 ⇒ 新写一批行，旧行**一个字都不动**。
 *
 *   ⇒ 于是任何时刻都能回答三个问题：
 *        "原文件这一格是什么？"（原始层）
 *        "按上一版映射洗成了什么？"（旧版本标准化层）
 *        "按现在这一版又是什么？"（当前版本标准化层）
 *
 * ===========================================================================
 * 🔴 本阶段的四条硬闸
 * ===========================================================================
 *  ① **不写 store_id**：`attribution_state` 为 `unconfirmed` 时，
 *     任何写入 `store_id` 的调用都直接抛错（不靠调用方自觉）。
 *  ② **不产生正式工单**：本模块没有任何一条路径会写 `service_tickets`。
 *  ③ **重复上传可识别**：按 `file_hash` 查已有批次；命中就返回原批次，
 *     不新建第二个批次、不重复写原始行。
 *  ④ **可见范围**：`visibility_scope` 只有 `uploader` / `hq` 两种；
 *     读取侧按"上传者本人 或 总部"裁剪，门店之间互不可见。
 *
 * ===========================================================================
 * ⚠️ 跨表一致性的实现方式（与本项目既有约定一致）
 * ===========================================================================
 *   DB 表与列由**插件 collection 定义**经 `db.sync()` 落库（与 exportAudits 同路径），
 *   本文件**不**手写 CREATE TABLE —— 手写会让"代码里的字段定义"与"库里的 DDL"
 *   变成两个事实来源，而它们漂移时**不会有任何断言变红**。
 *   三层的对齐由 `scripts/verify-historical-import.mjs` 在**重启之后**实测证明。
 */
import { buildSourceKey } from './mapping';

/** 归属状态（与 collection 的枚举逐项一致） */
export type AttributionState = 'unconfirmed' | 'confirmed' | 'rejected';
export type VisibilityScope = 'uploader' | 'hq';
export type BatchStage = 'staging' | 'archived' | 'voided';

export interface UploaderContext {
  userId: number | null;
  username: string | null;
  /** 是否总部视角（决定能否看别人的批次） */
  isHq: boolean;
}

export interface CreateBatchInput {
  fileName: string;
  fileHash: string;
  fileBytes: number;
  detectedKind: string;
  parserName: string;
  parserVersion: string;
  date1904: boolean;
  uploader: UploaderContext;
  totals: Record<string, unknown>;
  ledger: Record<string, unknown>;
  quality: Record<string, unknown>;
  warnings: string[];
  /** 逐表映射（首次 = 自动探测结果） */
  mapping: Record<string, { headerRow: number; fields: Record<string, number> }>;
  /**
   * 数据来源（`real` / `synthetic`）。
   *
   * 🔴 **由调用方（action 层）按"内容哈希是否在服务端签发清单里"判定后传入**，
   *    绝不来自请求体 —— 这是用户第一项那句"请求体不能伪装成 drill 批次"的落点。
   *    默认 `real`（保守）。
   */
  dataOrigin?: 'real' | 'synthetic';
}

export interface StoredBatch {
  id: number;
  batchNo: string;
  fileHash: string;
  fileName: string;
  stage: BatchStage;
  attributionState: AttributionState;
  visibilityScope: VisibilityScope;
  mappingVersion: number;
  /** 是否复用了本人已有的批次（幂等的表现） */
  reused: boolean;
  /** 数据来源（服务端判定） */
  dataOrigin: 'real' | 'synthetic';
  /**
   * 同一内容是否已被**不可见的其它主体**上传过。
   *
   * 🔴 只回布尔，**不带任何标识**（不含 batch_id / batch_no / 上传者）。
   *    用户要的是"识别重复上传"，不是"让对方看见别人的批次"。
   */
  previouslyUploadedByOthers: boolean;
}

export class HistoricalImportError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = 'HistoricalImportError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 批次号：HI-<yyyyMMdd>-<6 位随机>。人能念、能口头核对，哈希不适合。 */
function newBatchNo(now = new Date()): string {
  const d = now;
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `HI-${day}-${rand}`;
}

/**
 * 计算文件内容哈希（**判重的唯一依据**）。
 *
 * ⚠️ 为什么不用文件名：门店发来的文件叫什么的都有
 *    （`新建 Microsoft Excel 工作表.xlsx`、带日期后缀、带"最终版"），
 *    同名不代表同内容，不同名也不代表不同内容。
 */
/**
 * 去重键 = `sha256(文件哈希 | 上传者 id)`。
 *
 * ⚠️ 上传者 id 缺失（用户已被删除等）时退化成 `匿名` —— 仍然是一个确定的值，
 *    于是"匿名上传同一文件两次"也会被去重，而不是每次都新建。
 */
export function buildDedupKey(fileHash: string, actor: UploaderContext): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('node:crypto');
  const owner = actor?.userId == null ? 'anonymous' : String(actor.userId);
  return crypto.createHash('sha256').update(`${fileHash}|${owner}`).digest('hex');
}

export function hashFile(buf: Buffer): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export interface HistoricalImportStoreDeps {
  db: any;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

export function createHistoricalImportStore(deps: HistoricalImportStoreDeps) {
  const { db, logger } = deps;

  const repo = (name: string): any => {
    const r = db?.getRepository?.(name);
    if (!r) throw new HistoricalImportError('REPO_UNAVAILABLE', `拿不到 ${name} 的 repository`, 500);
    return r;
  };

  /**
   * 一个主体能否看见某个批次（**读取与复用的同一把尺子**）。
   *
   * ⚠️ 复用判据与读取判据必须是**同一个函数**。各写一份的下场是：
   *    读取时守得住、复用时守不住（或反过来），而两条路都不会报错。
   */
  function canSeeBatch(batch: any, actor: UploaderContext): boolean {
    if (!batch) return false;
    if (actor.isHq) return true;
    const scope = String(batch.visibility_scope ?? '');
    if (scope === 'hq') return false;
    return String(batch.uploader_user_id ?? '') === String(actor.userId ?? '');
  }

  /**
   * 按文件哈希找**当前主体可以安全复用**的批次。
   *
   * ===========================================================================
   * 🔴 2026-10-12 用户第 A.2 条：**去重范围必须收窄到可见范围**
   * ===========================================================================
   *  用户原话：「同一上传人重复上传应安全复用；**不同授权主体上传相同文件，
   *  不得复用对方不可见的批次、泄漏 batch_id 或跨门店读取原始数据**。」
   *
   *  修复前的实现是 `findOne({ filter: { file_hash } })` —— **全局**取第一条。
   *  后果（真实缺陷，不是理论风险）：
   *    · A 门店上传了某文件 ⇒ B 门店上传**同一个文件**时，会**复用 A 的批次**：
   *      ① 响应里回的是 A 的 `batch_id` / `batch_no` ⇒ **泄漏了 A 的批次标识**；
   *      ② B 随后用这个 id 去 `historicalPreview`，而 `getBatchForActor` 会拒绝
   *         （因为不是他上传的）⇒ **表现为"上传成功但一点就 404"**；
   *      ③ 更糟的是：如果将来把复用路径也接到读取上，就是**跨门店读原始数据**。
   *    ⇒ 所以复用必须限定在「**当前主体自己看得见的批次**」里找。
   *
   *  ⚠️ 这里刻意**不**对总部放宽到"复用门店的批次"：总部**看得见**所有批次（读取那侧没问题），
   *     但复用会让"这个批次是谁传的"变得含混（`uploader_user_id` 与操作者不符），
   *     而批次归属正是本阶段一切权限判断的基础。⇒ 复用**一律按上传者**匹配。
   *
   * @returns 可复用的批次；没有就 null（调用方据此新建）
   */
  async function findReusableBatch(fileHash: string, actor: UploaderContext): Promise<any | null> {
    // 先按**去重键**直接命中（索引唯一 ⇒ 最多一条，且天然只含本人）
    const byKey = await repo('historicalImportBatches').findOne({
      filter: { dedup_key: buildDedupKey(fileHash, actor) },
    });
    if (byKey) return byKey;

    // 兜底：历史批次（本列是后加的，可能为 NULL）仍按"哈希 + 上传者相同"找一遍
    const rows = await repo('historicalImportBatches').find({
      filter: { file_hash: fileHash },
      sort: ['id'],
    });
    for (const b of rows ?? []) {
      if (String(b.uploader_user_id ?? '') === String(actor.userId ?? '')) return b;
    }
    return null;
  }

  /**
   * 同一内容是否已被**别人**上传过 —— 只回一个是/否。
   *
   * 🔴 刻意只回布尔：回 `batch_id` / 上传者账号就构成跨主体信息泄漏
   *    （B 门店能借此推断"A 门店也在用这个系统、上传了这个文件"）。
   *    用户要的是"识别重复"，不是"让对方看见别人的批次"。
   */
  async function isUploadedBySomeoneElse(fileHash: string, actor: UploaderContext): Promise<boolean> {
    const rows = await repo('historicalImportBatches').find({
      filter: { file_hash: fileHash },
      fields: ['id', 'uploader_user_id', 'visibility_scope'],
    });
    return (rows ?? []).some((b: any) => !canSeeBatch(b, actor));
  }

  /**
   * 新建一个批次（**隔离暂存**）。
   *
   * 🔴 这里**不接受** `storeId` 参数 —— 结构上让"未确认就写归属"不可能发生，
   *    比"记得别传"可靠。要归属，走 `confirmAttribution()`，且它要求
   *    `attribution_state` 已经不是 unconfirmed 之外的流程都还没打通。
   */
  async function createBatch(input: CreateBatchInput): Promise<StoredBatch> {
    const existing = await findReusableBatch(input.fileHash, input.uploader);
    if (existing) {
      logger?.info?.(
        `[historical-import] 同一内容文件重复上传（同一主体），复用已有批次 ${existing.batch_no}` +
          '（不新建、不重复写原始行）',
      );
      return {
        id: Number(existing.id),
        batchNo: String(existing.batch_no),
        fileHash: String(existing.file_hash),
        fileName: String(existing.file_name),
        stage: String(existing.stage) as BatchStage,
        attributionState: String(existing.attribution_state) as AttributionState,
        visibilityScope: String(existing.visibility_scope) as VisibilityScope,
        mappingVersion: Number(existing.mapping_version ?? 1),
        reused: true,
        dataOrigin: (String(existing.data_origin ?? 'real') as 'real' | 'synthetic'),
        /**
         * ⚠️ 复用路径**也要如实算**这一个布尔，不能写死 false。
         *
         * 第一版写死成 false，理由是"本人复用自己的批次 ⇒ 不算别人传过"——
         * **理由是错的**：这个字段回答的是"**同一内容**是否也被别的主体传过"，
         * 与"我这次是不是复用了自己的批次"是两件不同的事。
         * 写死 false 的后果：B 第二次上传同一文件时收到 false，
         * 于是"这份材料别家也交过"这个**本来就该知道**的事实被静默吞掉。
         * （由 `verify-historical-dedup-identity.mjs` 在重跑时抓到 ——
         *   门禁第二次跑就红，正是因为它读的是真实语义而不是写死的值。）
         */
        previouslyUploadedByOthers: await isUploadedBySomeoneElse(input.fileHash, input.uploader),
      };
    }

    // 别人（不可见主体）传过同一文件 ⇒ 只提示，**不给任何标识**
    const othersHaveIt = await isUploadedBySomeoneElse(input.fileHash, input.uploader);
    const dedupKey = buildDedupKey(input.fileHash, input.uploader);

    let created: any;
    try {
      created = await createBatchRow(input, dedupKey);
    } catch (error) {
      // ---------------------------------------------------------------- 并发兜底
      //
      // 🔴 这一段是**幂等的真正落点**（用户第 A.2 / D 条："重复点击、网络重试
      //    不会生成重复批次"）。两个请求同时上传同一文件时，"先查后建"都会查不到，
      //    于是都走到这里 —— **唯一索引会让第二个插入失败**，我们捕获它、
      //    回查第一个请求刚建好的那条并复用它。
      //    ⇒ 结果：双击两次 = 一个批次。而且这条路径**不靠时序运气**。
      const msg = String((error as any)?.message ?? '');
      const isUniqueViolation =
        (error as any)?.name === 'SequelizeUniqueConstraintError' ||
        /duplicate key|unique constraint|uniq/i.test(msg);
      if (!isUniqueViolation) throw error;

      const raced = await repo('historicalImportBatches').findOne({ filter: { dedup_key: dedupKey } });
      if (!raced) throw error; // 不是我们预期的冲突 ⇒ 原样抛出，不吞
      logger?.info?.(
        `[historical-import] 并发上传同一文件：唯一键拦住重复插入，复用批次 ${raced.batch_no}`,
      );
      return {
        id: Number(raced.id),
        batchNo: String(raced.batch_no),
        fileHash: String(raced.file_hash),
        fileName: String(raced.file_name),
        stage: String(raced.stage) as BatchStage,
        attributionState: String(raced.attribution_state) as AttributionState,
        visibilityScope: String(raced.visibility_scope) as VisibilityScope,
        mappingVersion: Number(raced.mapping_version ?? 1),
        reused: true,
        dataOrigin: (String(raced.data_origin ?? 'real') as 'real' | 'synthetic'),
        previouslyUploadedByOthers: await isUploadedBySomeoneElse(input.fileHash, input.uploader),
      };
    }

    return {
      id: Number(created.id),
      batchNo: String(created.batch_no),
      fileHash: String(created.file_hash),
      fileName: String(created.file_name),
      stage: 'staging',
      attributionState: 'unconfirmed',
      visibilityScope: 'uploader',
      mappingVersion: 1,
      reused: false,
      dataOrigin: (String(created.data_origin ?? 'real') as 'real' | 'synthetic'),
      previouslyUploadedByOthers: othersHaveIt,
    };
  }

  /** 真正插一行（单独抽出来，是为了让上面的并发兜底读起来是一条直线） */
  async function createBatchRow(input: CreateBatchInput, dedupKey: string): Promise<any> {
    return repo('historicalImportBatches').create({
      values: {
        batch_no: newBatchNo(),
        file_name: input.fileName,
        file_hash: input.fileHash,
        dedup_key: dedupKey,
        // 🔴 服务端判定，请求体无法影响
        data_origin: input.dataOrigin ?? 'real',
        file_bytes: input.fileBytes,
        detected_kind: input.detectedKind,
        parser_name: input.parserName,
        parser_version: input.parserVersion,
        // 🔴 归属与阶段：本阶段**恒为**未确认 + 隔离暂存
        attribution_state: 'unconfirmed',
        store_id: null,
        visibility_scope: 'uploader',
        stage: 'staging',
        uploader_user_id: input.uploader.userId,
        uploader_username: input.uploader.username,
        uploaded_at: new Date(),
        mapping_version: 1,
        mapping_json: input.mapping,
        totals_json: input.totals,
        ledger_json: input.ledger,
        quality_json: input.quality,
        warnings_json: input.date1904
          ? [...input.warnings, '工作簿使用 1904 日期系统，已按 1904 制转换']
          : input.warnings,
      },
    });
  }

  /**
   * 写入**原始层**。
   *
   * ⚠️ 只追加：用 `source_key` 先查，已存在就跳过。
   *    重复上传（哈希命中 ⇒ 复用批次）走到这里时，所有行的 source_key 都已存在
   *    ⇒ 实际写入 0 行 —— 这正是"不产生无限个相同批次"的落点。
   */
  async function appendRawRows(
    batchId: number,
    fileHash: string,
    sheets: Array<{
      sheetName: string;
      sheetIndex: number;
      headerRow: number;
      header: string[];
      classification: string;
      rows: Array<{ sourceRow: number; cells: Record<string, string | null> }>;
    }>,
  ): Promise<{ inserted: number; skipped: number }> {
    const rowsRepo = repo('historicalImportRows');
    let inserted = 0;
    let skipped = 0;

    for (const sheet of sheets) {
      // 先查本批次已有哪些 source_key（一次查询，不逐行查）
      const existing = await rowsRepo.find({
        filter: { batch_id: batchId, sheet_name: sheet.sheetName },
        fields: ['id', 'source_key'],
      });
      const seen = new Set<string>((existing ?? []).map((r: any) => String(r.source_key)));

      for (const row of sheet.rows) {
        const sourceKey = buildSourceKey(fileHash, sheet.sheetName, row.sourceRow);
        if (seen.has(sourceKey)) {
          skipped += 1;
          continue;
        }
        await rowsRepo.create({
          values: {
            batch_id: batchId,
            sheet_name: sheet.sheetName,
            sheet_index: sheet.sheetIndex,
            source_row: row.sourceRow,
            header_row: sheet.headerRow,
            classification: sheet.classification,
            cells_json: row.cells,
            header_json: sheet.header,
            source_key: sourceKey,
          },
        });
        seen.add(sourceKey);
        inserted += 1;
      }
    }
    return { inserted, skipped };
  }

  /**
   * 写入**标准化层**的一个新版本。
   *
   * 🔴 **不删旧版本**：`mapping_version` 递增后新写一批行，
   *    旧版本的行原样留在库里 —— "上次是怎么清洗的"永远查得到。
   *
   * @returns 新版本号与各分类计数
   */
  /**
   * 把"第 N 版用的是哪套映射"记进 `mapping_json`（**按版本累积**）。
   *
   * 格式：`{ "<version>": { "<sheet>": { headerRow, fields } } }`。
   * ⚠️ 读到**旧的扁平格式**（`{ "<sheet>": {…} }`，没有数字键）时，
   *    把它整体包成 `{ "1": <扁平> }` 再合并 —— 这样"新写的版本"与"历史那一版"
   *    能共存在同一个字段里，不必为兼容再开第二个列。
   */
  async function writeMappingSnapshot(
    batchId: number,
    version: number,
    mapping: Record<string, unknown>,
  ): Promise<void> {
    const b = await repo('historicalImportBatches').findOne({
      filter: { id: batchId },
      fields: ['id', 'mapping_json'],
    });
    const raw = (b?.mapping_json ?? {}) as Record<string, unknown>;
    const isVersioned = Object.keys(raw).length > 0 && Object.keys(raw).every((k) => /^\d+$/.test(k));
    const base: Record<string, unknown> = isVersioned ? { ...raw } : { '1': raw };
    base[String(version)] = mapping;
    await repo('historicalImportBatches').update({
      filter: { id: batchId },
      values: { mapping_json: base },
    });
  }

  /**
   * 取出**指定版本**的映射（供"由原始层重算"这类审计使用）。
   *
   * @returns 该版本的映射；查不到返回 null（**不猜某一版**）
   */
  async function mappingOfVersion(batchId: number, version: number): Promise<Record<string, unknown> | null> {
    const b = await repo('historicalImportBatches').findOne({
      filter: { id: batchId },
      fields: ['id', 'mapping_json'],
    });
    const raw = (b?.mapping_json ?? {}) as Record<string, unknown>;
    if (Object.keys(raw).length === 0) return null;
    const isVersioned = Object.keys(raw).every((k) => /^\d+$/.test(k));
    if (isVersioned) return (raw[String(version)] as Record<string, unknown>) ?? null;
    // 旧扁平格式：按"第 1 版"解释
    return version === 1 ? raw : null;
  }

  /**
   * **破坏性维护的唯一边界**（P11-3 第 5 项 · 用户 A 段）
   * ===========================================================================
   * 用户原话：「要求所有会 UPDATE、DELETE、重建版本、回滚或注入错误的**破坏性验收**，
   *   只能使用**隔离的合成测试批次**。**服务端必须验证真实数据来源与执行权限**，
   *   不能仅依赖脚本作者遵守约定或前端 scope 标记。」
   *
   * ---------------------------------------------------------------------------
   * 为什么必须有这个函数，而不是"让变异脚本自己小心"
   * ---------------------------------------------------------------------------
   * DEV-158 的教训就是：变异自证 M3 为了证明"分代留痕"，在**真实批次**上执行了
   * `DELETE ... WHERE mapping_version <> <current>` —— 变异结束后源码还原了，
   * 但**被删掉的那些行不会自己回来**。那是"靠作者自觉"必然的结局。
   *
   * ⇒ 现在把"删历史版本"这件事**收成一个服务端函数**，并在里面读**库里的
   *    `data_origin`**（服务端事实）来决定放不放行：
   *      · `synthetic` ⇒ 允许（那本来就是可再生的合成夹具）
   *      · `real`      ⇒ **409 拒绝**（真实历史数据的任何一代都不许被删）
   *
   * ⚠️ 判据**不看调用方**、不看请求参数、不看脚本声明 —— 只看那条批次记录的
   *    `data_origin`。而那一列**只能由服务端按内容哈希写**（见 `drill.ts`），
   *    所以真实文件无论如何都拿不到放行。
   */
  async function purgeOtherVersions(
    batchId: number,
    keepVersion: number,
  ): Promise<{ removed: number; batchNo: string; keepVersion: number }> {
    const b = await repo('historicalImportBatches').findOne({ filter: { id: batchId } });
    if (!b) throw new HistoricalImportError('BATCH_NOT_FOUND', '批次不存在', 404);
    const origin = String(b.data_origin ?? 'real');
    if (origin !== 'synthetic') {
      throw new HistoricalImportError(
        'DESTRUCTIVE_REQUIRES_SYNTHETIC',
        `破坏性维护（删除历史版本）只允许作用于**服务端签发的合成夹具批次**；` +
          `批次 ${b.batch_no} 的数据来源是「真实数据」，其任何一代标准化结果都不得被删除`,
        409,
      );
    }
    const candidates = repo('historicalImportCandidates');
    const rows = await candidates.find({
      filter: { batch_id: batchId, mapping_version: { $ne: keepVersion } },
      fields: ['id'],
    });
    const ids = (rows ?? []).map((r: any) => Number(r.id));
    if (ids.length > 0) {
      await candidates.destroy({ filter: { id: { $in: ids } } });
    }
    logger?.warn?.(
      `[historical-import] 破坏性维护：删除了合成批次 ${b.batch_no} 的 ${ids.length} 条历史版本候选（保留 v${keepVersion}）`,
    );
    return { removed: ids.length, batchNo: String(b.batch_no), keepVersion };
  }

  async function writeCandidates(
    batchId: number,
    mappingVersion: number,
    rows: Array<{
      rowId: number;
      sheetName: string;
      sourceRow: number;
      disposition: string;
      dispositionReason: string;
      fields: Record<string, unknown>;
      rawRefs: Record<string, unknown>;
      issues: string[];
    }>,
    /** 🔴 本版使用的映射快照（按 `sheet -> { headerRow, fields }`）—— 见 writeMappingSnapshot */
    mapping: Record<string, unknown> = {},
  ): Promise<{ mappingVersion: number; written: number }> {
    const cRepo = repo('historicalImportCandidates');
    let written = 0;
    for (const r of rows) {
      await cRepo.create({
        values: {
          batch_id: batchId,
          row_id: r.rowId,
          mapping_version: mappingVersion,
          disposition: r.disposition,
          fields_json: r.fields,
          raw_refs_json: r.rawRefs,
          issues_json: r.issues,
          manual_status: 'pending',
          // 🔴 归属门店本阶段恒空
          store_id: null,
        },
      });
      written += 1;
    }
    /**
     * 回写批次的当前映射版本 **并记下"这一版的映射是什么"**。
     *
     * ===========================================================================
     * 🔴 2026-10-12（用户第 5 项核对）修的一个真实缺陷
     * ===========================================================================
     * 原先只写 `mapping_version` 这个**数字**，而 `mapping_json` 只在**建批次时**
     * 写过一次（那时还是自动映射）。于是：
     *   · 候选表里躺着 v96…v100 五代结果、每代都记着"我是第几版"；
     *   · 但**没有任何地方记着"第 97 版当初用的是哪套列映射"**；
     *   ⇒ 那些候选**无法复现**。想做"机器结果有没有被篡改"的核对时，
     *     只能拿一个不知道是哪一版的 mapping_json 去重算，结果自然对不上
     *     （实测：用 `customerPhone=6`（用户电话列）重算，而库里那代是 `=7`（手机号列））。
     *
     * 这条缺陷不影响"数据没被改"这个结论，但它**破坏可审计性** ——
     * 而"分代留痕"的全部意义就是"若干代之后还能说清每一代是怎么算出来的"。
     *
     * 修法：`mapping_json` 改为**按版本存**：
     *   `{ "96": {Sheet1:{…},Sheet2:{…}}, "97": {…} }`
     * 读取侧（本函数下方 `mappingOfVersion`）对**旧的扁平格式**保持兼容
     * ——旧批次按 `{ "1": <扁平> }` 解释（它们都是建批次后只 stage 过一次的那批）。
     */
    await writeMappingSnapshot(batchId, mappingVersion, mapping);
    await repo('historicalImportBatches').update({
      filter: { id: batchId },
      values: { mapping_version: mappingVersion },
    });
    return { mappingVersion, written };
  }

  /** 取某批次当前的映射版本号（用于"改映射 ⇒ +1"） */
  async function currentMappingVersion(batchId: number): Promise<number> {
    const b = await repo('historicalImportBatches').findOne({ filter: { id: batchId } });
    return Number(b?.mapping_version ?? 1);
  }

  /**
   * 读取一个批次 —— **带可见范围裁剪**。
   *
   * 🔴 门店角色只能读自己上传的；总部可读全部。
   *    `visibility_scope='hq'` 的批次连上传者本人也读不到（那是"只给总部看"的语义）。
   */
  async function getBatchForActor(batchId: number, actor: UploaderContext): Promise<any | null> {
    const b = await repo('historicalImportBatches').findOne({ filter: { id: batchId } });
    if (!b) return null;
    if (actor.isHq) return b;
    const scope = String(b.visibility_scope);
    if (scope === 'hq') return null;
    if (String(b.uploader_user_id ?? '') !== String(actor.userId ?? '')) return null;
    return b;
  }

  /**
   * 列出可见批次。
   *
   * ⚠️ 未确认归属的数据**不得**对全部门店开放 ⇒ 门店角色永远只看自己的。
   */
  async function listBatchesForActor(actor: UploaderContext, limit = 50): Promise<any[]> {
    const filter: Record<string, unknown> = actor.isHq
      ? {}
      : { uploader_user_id: actor.userId, visibility_scope: 'uploader' };
    const rows = await repo('historicalImportBatches').find({
      filter,
      sort: ['-createdAt'],
      limit,
    });
    return rows ?? [];
  }

  /**
   * 正式归档到某家门店 —— **本阶段一律拒绝**。
   *
   * 🔴 用户第 5 条：「正式归档到具体门店必须在门店映射确认 + 权限校验 + 人工确认之后。」
   *    15 家门店与系统编码的对应**尚未确认**，所以这里**没有任何一条路径会成功**。
   *    把它写成会失败的显式函数，而不是"以后再说"，是为了让这个约束
   *    **有地方被断言**：验收脚本能证明它确实拒绝了。
   */
  async function archiveToStore(batchId: number, _storeId: number, actor: UploaderContext): Promise<never> {
    // -------------------------------------------------------------------------
    // 🔴 判据顺序是**安全属性**，不是风格问题
    // -------------------------------------------------------------------------
    // 第一版把「归属是否已确认」判在「能不能看见这个批次」之前，于是：
    //   · 别人（无权限）拿一个**不存在**的 batchId → 404
    //   · 别人拿一个**存在但未确认**的 batchId   → **409**
    // ⇒ 两个不同的响应码就把"这个批次存不存在"泄露了出去。
    //   实测由 `verify-historical-dedup-identity.mjs` 抓到（期望 404，实得 409）。
    //
    // ⇒ 顺序固定为：**先可见性（越权一律 404）→ 再业务状态**。
    //   这与 PermissionService 既有口径一致："越权一律以'不存在'对外表达"。
    const b = await getBatchForActor(batchId, actor);
    if (!b) throw new HistoricalImportError('BATCH_NOT_FOUND', '批次不存在或你无权访问', 404);
    const state = String(b.attribution_state);
    if (state !== 'confirmed') {
      throw new HistoricalImportError(
        'ATTRIBUTION_UNCONFIRMED',
        '门店归属尚未确认（15 家门店与系统编码的对应未完成），本阶段不允许把历史数据正式归档到具体门店',
        409,
      );
    }
    if (!actor.isHq) {
      throw new HistoricalImportError('FORBIDDEN', '只有总部可以执行正式归档', 403);
    }
    throw new HistoricalImportError(
      'NOT_IMPLEMENTED',
      '正式归档属于 P11-3 后续项，本阶段刻意不实现',
      501,
    );
  }

  /**
   * 供**门禁脚本**直接调用内部判据的只读包装。
   *
   * ⚠️ 为什么要把内部函数暴露出来：第 A.2 条的验收要求"用两个真实门店账号做
   *    **正反向**验证"。走 HTTP 只能验证"B 看不到 A 的批次"这一半；
   *    "B 上传同文件时**不会**复用 A 的批次"需要能直接问服务层拿到了什么。
   *    这两个包装**只读、不改状态**，且名字里带 ForTest，避免被业务代码误用。
   */
  function isUploadedByOthersForTest(fileHash: string, actor: UploaderContext): Promise<boolean> {
    return isUploadedBySomeoneElse(fileHash, actor);
  }

  function canSeeBatchForTest(batch: any, actor: UploaderContext): boolean {
    return canSeeBatch(batch, actor);
  }

  return {
    hashFile,
    findReusableBatch,
    writeMappingSnapshot,
    mappingOfVersion,
    purgeOtherVersions,
    isUploadedByOthersForTest,
    canSeeBatchForTest,
    createBatch,
    appendRawRows,
    writeCandidates,
    currentMappingVersion,
    getBatchForActor,
    listBatchesForActor,
    archiveToStore,
  };
}

export type HistoricalImportStore = ReturnType<typeof createHistoricalImportStore>;
