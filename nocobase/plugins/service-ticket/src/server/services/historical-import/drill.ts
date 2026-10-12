/**
 * 历史导入 —— **演练夹具的签发**（P11-3 第 5 项 · 用户第一项）
 * =============================================================================
 *
 * ===========================================================================
 * 用户原话
 * ===========================================================================
 *  「增加服务端安全约束：**仅经过服务端确认的合成测试批次**允许使用 drill 门店归档演练。
 *    真实文件不能通过前端修改 scope 或**请求体伪装成 drill 批次**。
 *    为浏览器验收提供**隔离的合成夹具**，真实历史样本原则上只用于只读解析、
 *    映射预览和不改变正式归属的验证。」
 *
 * ===========================================================================
 * 为什么不是"上传时带一个 `?drill=1` 参数"
 * ===========================================================================
 * 那种做法的安全性完全依赖"调用方自觉"：只要改一下请求体，
 * 任意真实 Excel 都能变成"演练批次"，再配上 drill 门店就能绕过
 * "未确认门店不得归属"这条线。用户点的正是这件事。
 *
 * ===========================================================================
 * 这里的设计：**内容哈希白名单 + 只有服务端能往里加**
 * ===========================================================================
 *   ① 服务端自己**生成**一份合成工作簿（内置模板，手机号只用 `138 0000 01xx`
 *      这类明显合成的号段），算出它的 sha256，记进 `service_settings`
 *      的签发清单（`historical.drill-fixtures`）；
 *   ② 上传任意文件时，服务端**按内容哈希**去清单里查：
 *        命中 ⇒ `data_origin = 'synthetic'`
 *        未命中 ⇒ `data_origin = 'real'`
 *   ③ `drill` 范围的归属确认**要求** `data_origin === 'synthetic'`。
 *
 * ⇒ 真实 Excel 想成为 drill 批次，必须使自己的 sha256 等于服务端刚生成的
 *    那份合成工作簿 —— 而那要求它**就是**那份合成工作簿。
 *   **请求体里的一切都不参与判定**，所以"改请求体伪装"这条路不存在。
 *
 * ⚠️ 清单只保留最近 N 条（不需要无限增长），且**只存哈希 + 生成时间 + 生成人**，
 *    不存文件内容（内容是确定性的，随时可再生成一份等价的）。
 */
import { IMPORT_REJECT, HistoricalImportRejected } from './limits';

/** 签发清单的 settings key（**必须**在 `constants.ts` 的 DEFAULT_SETTINGS 里声明） */
export const DRILL_FIXTURE_KEY = 'historical.drill-fixtures';

/** 清单保留条数（超出丢弃最旧的） */
const KEEP = 20;

export interface DrillFixtureRecord {
  /** 合成工作簿的 sha256（上传时按它判定 synthetic） */
  sha256: string;
  /** 文件名（**只作记录**，判定完全不看它） */
  fileName: string;
  issuedAt: string;
  issuedBy: string;
}

/** 内置合成模板：列名与真实样本**同族**，但数据全部是明显的合成值 */
export const DRILL_TEMPLATE_HEADER = [
  '回访时间',
  '安装时间',
  '姓名',
  '电话',
  '机器信息',
  '数量',
  '销售单位',
  '性质',
  '回访结果',
];

/**
 * 合成数据行（**无任何真实客户信息**）。
 *
 * ⚠️ 刻意包含三种"真实形态"以便演练能覆盖到：
 *   · 一格多号（`…/…`）
 *   · 缺手机号（空单元格）
 *   · 服务结果取值不在已知集合（「来电表扬」——**必须原样保留**的那种）
 * 同时保证**至少两行是完全干净的**（可导入、无待处理），这样归档闭环能走通。
 */
/**
 * 夹具**用途**（P11-3 第 5 项）。
 *
 * 🔴 为什么需要两种：两种验收要的东西**正好相反** ——
 *   · `anomalies`（默认）：刻意带上"一格多号 / 缺手机号 / 服务结果未识别"
 *     ⇒ 用来验证**异常确认**与"归档前必须处理完待确认项"（被拦下）；
 *   · `clean`：**全部干净可导入**
 *     ⇒ 用来验证**归档闭环本身**（不用先把一堆待确认点掉才能走到归档）。
 *
 * 第一版只有一种（带异常），于是浏览器侧"归档演示"卡在 2 条待确认上 ——
 * 而"为了演示把该确认的点掉"恰恰是用户禁止的那种做法。
 * ⇒ 需求不同就**给两个夹具**，而不是让演示去将就。
 */
export type DrillProfile = 'anomalies' | 'clean';

export function drillTemplateRows(runMarker: string, profile: DrillProfile = 'anomalies'): Array<Array<string | number>> {
  const m = runMarker || 'DRILL';
  /**
   * 第 4 行的日期**由运行标记派生**（两次签发必然不同），其余三行用固定日期。
   *
   * 🔴 这不是为了"内容多样"，而是为了让演练能覆盖到**跨文件去重的两种强度**：
   *    · 前 3 行跨文件同名同日期同型号 ⇒ 命中多项 ⇒ **强证据**（同一件事被录两遍）
   *    · 第 4 行跨文件**只共用手机号**（姓名/日期/型号都不同）⇒ **弱证据**
   *      （同一客户**多次真实售后**的形态 —— 用户点名要求"不得只凭手机号就合并"）
   * 没有第 4 行，"弱证据"这条判据在任何一次演练里都无法被观测到。
   */
  // ⚠️ 用**字符和**派生，不能用 `m.length`：两次签发的标记长度相同（都是 9 位），
  //    按长度派生会让两边的日期**相同** ⇒ 那一行反而命中"业务日期相同"
  //    变成强证据，弱证据那条判据就永远观测不到（实测正是这么踩的）。
  const seed = [...m].reduce((a, c) => a + c.charCodeAt(0), 0);
  const day = 2 + (seed % 20);
  const derived = `2026-08-${String(day).padStart(2, '0')}`;
  return [
    DRILL_TEMPLATE_HEADER,
    ['2026-09-01', '2026-09-02', `合成甲${m}`, '13800000101', `合成空调 KFR-01-${m}`, 1, '合成门店', '安装', '满意'],
    ['2026-09-03', '2026-09-04', `合成乙${m}`, '13800000101/13800000102', `合成冰箱 BCD-02-${m}`, 1, '合成门店', '维修', '满意'],
    ['2026-09-05', '2026-09-06', `合成丙${m}`, '13800000103', `合成洗衣机 XQG-03-${m}`, 1, '合成门店', '安装', '来电表扬'],
    // 弱证据行：手机号固定，其余全部随运行标记变化
    [derived, derived, `合成丁${m}`, '13800000109', `合成微波炉 MW-09-${m}`, 1, '合成门店', '维修', '满意'],
    /**
     * 第 5 行：**缺手机号** ⇒ 另一类待确认。
     *
     * 🔴 为什么非要有两行不同性质的待确认（而不是只有第 2 行的"一格多号"）：
     *    验收流程里必然会有"人工修正一行"的动作，而**修正会让那一行变成已确认**。
     *    如果全批只有一行待确认，修正它之后"归档前仍有待处理记录 ⇒ 应当被拦下"
     *    这条判据就**永远触发不了**（实测报 HTTP 200，看起来像闸门失灵）。
     *    ⇒ 夹具要能同时支撑"改一行"与"还剩一行待处理"两件事。
     */
    ['2026-09-07', '2026-09-08', `合成戊${m}`, '', `合成热水器 RS-05-${m}`, 1, '合成门店', '安装', '满意'],
  ];
}

/** `clean` 夹具：**全部可导入**（无待确认）—— 供"归档闭环"这类演示使用 */
export function drillCleanRows(runMarker: string): Array<Array<string | number>> {
  const m = runMarker || 'DRILL';
  return [
    DRILL_TEMPLATE_HEADER,
    ['2026-09-11', '2026-09-12', `合成演甲${m}`, '13800000201', `合成空调 KFR-11-${m}`, 1, '合成门店', '安装', '满意'],
    ['2026-09-13', '2026-09-14', `合成演乙${m}`, '13800000202', `合成冰箱 BCD-12-${m}`, 1, '合成门店', '维修', '满意'],
    // 与 anomalies 夹具**共用** 13800000201 这个号、但日期/型号不同 ⇒ 跨文件只命中手机号 ⇒ 弱证据
    ['2026-08-25', '2026-08-26', `合成演丙${m}`, '13800000201', `合成微波炉 MW-13-${m}`, 1, '合成门店', '维修', '满意'],
  ];
}

export interface DrillDeps {
  db: any;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export function createDrillFixtureService(deps: DrillDeps) {
  const { db, logger } = deps;

  const settingsRepo = () => {
    const r = db?.getRepository?.('serviceSettings');
    if (!r) {
      throw new HistoricalImportRejected(IMPORT_REJECT.DEPENDENCY_UNAVAILABLE, '拿不到 service_settings 的 repository');
    }
    return r;
  };

  /** 读签发清单（读不到/解析失败 ⇒ 空清单 ⇒ 一律按真实数据处理） */
  async function readIssued(): Promise<DrillFixtureRecord[]> {
    try {
      const row = await settingsRepo().findOne({ filter: { key: DRILL_FIXTURE_KEY } });
      const v = row?.value;
      const parsed = typeof v === 'string' ? JSON.parse(v) : v;
      const list = Array.isArray(parsed?.issued) ? parsed.issued : [];
      return list.filter((x: any) => typeof x?.sha256 === 'string');
    } catch (e) {
      logger?.warn?.(`[historical-drill] 签发清单读取失败 ⇒ 视为空（一律按真实数据处理）：${String(e)}`);
      return [];
    }
  }

  /** 判定一份内容是不是服务端签发的夹具 —— **只看哈希**，不看文件名、不看请求体 */
  async function isIssuedFixture(sha256: string): Promise<boolean> {
    if (!sha256) return false;
    const list = await readIssued();
    return list.some((x) => x.sha256 === sha256);
  }

  async function recordIssued(rec: DrillFixtureRecord): Promise<void> {
    const list = await readIssued();
    const next = [rec, ...list.filter((x) => x.sha256 !== rec.sha256)].slice(0, KEEP);
    const payload = {
      note:
        '历史导入**演练夹具**的签发清单。上传时按内容 sha256 比对：命中 ⇒ data_origin=synthetic；' +
        '未命中 ⇒ real。**drill 范围的归属确认只接受 synthetic 批次**（用户 P11-3 第 5 项）。',
      issued: next,
    };
    const repo = settingsRepo();
    /**
     * 🔴 `service_settings.value` 是 **text** 列，集合注释写得很清楚：
     *    「统一以字符串存储，按 `value_type` 解析」。
     *
     * ⚠️ 第一版直接 `values: { value: payload }`（塞对象），于是 PG 侧
     *    落到 `String(payload)` ⇒ 库里存成 **`[object Object]`**。
     *    后果非常隐蔽：写入"成功"（200）、列表里能看到这一行、
     *    读回来 `JSON.parse` 失败 ⇒ `readIssued()` 返回空清单 ⇒
     *    **所有夹具上传都会被判成 real**，而错误只表现为"drill 归属被拒"。
     *    ⇒ 必须自己 `JSON.stringify`。
     */
    const serialized = JSON.stringify(payload);
    const existed = await repo.findOne({ filter: { key: DRILL_FIXTURE_KEY } });
    if (existed) {
      await repo.update({ filter: { key: DRILL_FIXTURE_KEY }, values: { value: serialized } });
    } else {
      await repo.create({
        values: {
          key: DRILL_FIXTURE_KEY,
          value: serialized,
          value_type: 'json',
          description: '历史导入演练夹具签发清单（P11-3 第 5 项）',
        },
      });
    }
  }

  /**
   * 生成一份**新的**合成工作簿。
   *
   * @returns `{ fileName, base64, sha256, bytes }` —— 调用方把它交给浏览器当普通文件上传
   */
  function buildFixture(
    runMarker: string,
    profile: DrillProfile = 'anomalies',
  ): { fileName: string; base64: string; sha256: string; bytes: number; profile: DrillProfile } {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const xlsx = require('xlsx');
    const crypto = require('node:crypto');
    const rows = profile === 'clean' ? drillCleanRows(runMarker) : drillTemplateRows(runMarker, profile);
    const ws = xlsx.utils.aoa_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, '合成');
    const buf: Buffer = xlsx.write(wb, { bookType: 'xlsx', type: 'buffer' });
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    return {
      fileName: `合成演练夹具-${profile}-${runMarker}.xlsx`,
      base64: buf.toString('base64'),
      sha256,
      bytes: buf.length,
      profile,
    };
  }

  return { readIssued, isIssuedFixture, recordIssued, buildFixture };
}

export type DrillFixtureService = ReturnType<typeof createDrillFixtureService>;
