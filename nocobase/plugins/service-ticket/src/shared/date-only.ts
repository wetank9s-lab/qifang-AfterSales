/**
 * `dateOnly` 列的**唯一**日期解析口径（客户端 / 服务端 / 断言脚本共用）
 * =============================================================================
 *
 * 为什么需要它（2026-11-11 真机实测，DEV-217）：
 *   真机建档第一次提交就 500：
 *     `invalid input syntax for type date: "Invalid date"`
 *   而**同一台机器用桌面浏览器走同一段代码是成功的**。
 *   两者唯一的差别是控件实现：
 *     · 桌面（Chrome/Edge）：原生 `<input type="date">`，空值时 `value === ''`；
 *     · 移动端浏览器 / 系统 WebView：很多实现把"没选日期"暴露成 **`'Invalid date'`**
 *       （dayjs / moment 的 `format()` 对无效日期就返回这个字符串）。
 *   于是这个字符串被原样 POST 上去，数据库把它当 date 解析 ⇒ 500。
 *
 * ---------------------------------------------------------------------------
 * 三条硬规则
 * ---------------------------------------------------------------------------
 * ① **只接受 `YYYY-MM-DD`**。
 *    不用 `new Date(str)` —— 它对 `2026/11/15`、`15/11/2026`、`2026年11月15日`
 *    各有不同的宽松解析，其中 `2026/11/15` 在 UTC+8 会被解析成 11-14（本地零点），
 *    也就是**静默错一天**。日期列宁可拒收，也不要猜。
 *
 * ② **日历合法性要真校验**，不能只看形状。
 *    `2026-02-31` 形状完全合法但这一天不存在；JS 的 `new Date('2026-02-31')`
 *    会**自动滚到 3 月 3 日** —— 又一个静默错日期。所以这里做回读比对。
 *
 * ③ **不可解析 ⇒ 明确报错（400），不是静默落 NULL**。
 *    静默丢掉用户填的日期，等于"提交成功但内容没保存"，比报错更难发现。
 *    但 ⚠️ **空值（`''` / `null` / `undefined`）是合法的"没填"**，仍然返回 `null`。
 *    区分这两者正是本模块存在的意义：
 *      `''`            → `null`（用户没填，允许）
 *      `'Invalid date'`→ 抛 `DATE_INVALID`（控件没给值，必须让用户重选）
 */

/** 只接受这一种形状：4 位年-2 位月-2 位日 */
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 上限/下限：挡住 `0000-01-01` 这类"形状合法但明显不是业务日期"的输入 */
const MIN_YEAR = 1900;
const MAX_YEAR = 2999;

/**
 * 解析结果。
 *
 * ⚠️ 为什么用「可选字段 + 判别式收窄」而不是 `{ok:true}|{ok:false}` 两个接口：
 *    本仓库这两处判据都是 `if (!parsed.ok) { … parsed.reason … }`。
 *    在**布尔判别式**上做否定收窄，能否把联合类型收窄到另一半，
 *    取决于 TS 版本与 `strictNullChecks`（本插件 `tsconfig.check.json` 里它是关的），
 *    实测在关掉 `strictNullChecks` 时会保留 `DateOnlyParseOk | DateOnlyParseErr`，
 *    于是 `parsed.reason` 报 TS2339、构建门禁直接拒绝构建（BUILD-TS-GATE-01）。
 *    ⇒ 改成**同一个对象类型 + `ok` 字面量类型**，两个分支都能稳定收窄，
 *      也不影响任何调用写法（`if (!r.ok)` / `if (r.ok)` 都照旧）。
 */
export type DateOnlyParseResult = {
  /** 判别式。`true` = 解析成功（`value` 为 `YYYY-MM-DD` 或 `null`）；`false` = 必须报错 */
  ok: boolean;
  /** 仅 `ok:true` 时非空：`YYYY-MM-DD`，或 `null` 表示"没填" */
  value?: string | null;
  /** 仅 `ok:false` 时非空 */
  code?: 'DATE_INVALID';
  /** 仅 `ok:false` 时非空：给人看的一句话（已含字段值，便于现场对照） */
  reason?: string;
  /** 仅 `ok:false` 时有意义：原始输入，便于日志与断言复现 */
  raw?: unknown;
};

/** @deprecated 保留别名，避免外部引用断裂；新代码用 `DateOnlyParseResult` */
export type DateOnlyParseOk = DateOnlyParseResult;
/** @deprecated 保留别名，避免外部引用断裂；新代码用 `DateOnlyParseResult` */
export type DateOnlyParseErr = DateOnlyParseResult;

/**
 * 解析一个 `dateOnly` 输入。
 *
 * @param raw  来自表单 / 请求体的原始值
 * @returns `{ ok:true, value }` —— `value` 为 `YYYY-MM-DD` 或 `null`（未填）
 *          或 `{ ok:false, code, reason }` —— 调用方必须**当着用户的面**报错，不得吞掉
 */
export function parseDateOnly(raw: unknown): DateOnlyParseResult {
  // ---- 合法的"没填" ----
  // ⚠️ 这里**只**把真正的空值当没填。
  //     `'Invalid date'` / `'null'` / `'undefined'` 这些**字符串**绝不在白名单里 ——
  //     它们正是本轮 500 的元凶，必须走到下面的报错分支。
  if (raw === undefined || raw === null) return { ok: true, value: null };

  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s === '') return { ok: true, value: null };

    const m = DATE_ONLY_PATTERN.exec(s);
    if (!m) {
      return {
        ok: false,
        code: 'DATE_INVALID',
        reason: `格式必须是 YYYY-MM-DD（收到 ${JSON.stringify(s.slice(0, 32))}）`,
        raw,
      };
    }

    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (y < MIN_YEAR || y > MAX_YEAR) {
      return { ok: false, code: 'DATE_INVALID', reason: `年份超出范围（${y}）`, raw };
    }
    if (mo < 1 || mo > 12) {
      return { ok: false, code: 'DATE_INVALID', reason: `月份不存在（${s}）`, raw };
    }
    if (d < 1 || d > 31) {
      return { ok: false, code: 'DATE_INVALID', reason: `日不存在（${s}）`, raw };
    }

    // 回读比对：`2026-02-31` 用 Date 会被"滚动"成 3 月 3 日，只有回读才能发现。
    // 用 UTC 构造 + UTC 回读，避免本地时区把日期挪一天。
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (
      probe.getUTCFullYear() !== y ||
      probe.getUTCMonth() !== mo - 1 ||
      probe.getUTCDate() !== d
    ) {
      return { ok: false, code: 'DATE_INVALID', reason: `这一天不存在（${s}）`, raw };
    }

    return { ok: true, value: s };
  }

  // Date 对象：只取它的"日历日"（按 UTC，避免本地时区偏移）。
  // ⚠️ 无效 Date 必须报错 —— `new Date('x').toISOString()` 会直接抛 RangeError，
  //    而 `String(new Date('x'))` 得到的就是 `'Invalid date'`。这里显式挡在源头。
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) {
      return { ok: false, code: 'DATE_INVALID', reason: '不是有效日期（Invalid Date）', raw };
    }
    const y = raw.getUTCFullYear();
    const mo = raw.getUTCMonth() + 1;
    const d = raw.getUTCDate();
    const s = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return parseDateOnly(s);
  }

  return {
    ok: false,
    code: 'DATE_INVALID',
    reason: `的值类型不对（收到 ${typeof raw}）`,
    raw,
  };
}

/** 客户端用的便捷判定：`true` = 这是"没填"，可以放心提交 `null` */
export function isBlankDateInput(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === 'string') return raw.trim() === '';
  return false;
}
