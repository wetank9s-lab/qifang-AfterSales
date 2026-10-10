/**
 * 迁移：`ticket_type` 由两类扩展为**六类内部业务类型**（Phase 11 / P11-1 · 用户 B 段）
 * =============================================================================
 *
 * 来源：`docs/PHASE-11-REQUIREMENTS.md` §8.1 —— 维修 / 安装 / 调试保养 / 移机拆机 / 投诉 / 其他。
 *
 * ===========================================================================
 * 为什么必须单独一个迁移（而不是只改代码常量）
 * ===========================================================================
 * 🔴 这是本项目**已经实测过两次**的坑（DEV-112）：
 *    `fields.options.uiSchema.enum` 是**已落库的元数据**，
 *    改 `constants.ts` / `collections/*.ts` 的代码常量**不会**更新它。
 *    ⇒ 后台的下拉与列表列仍按**库里那份**渲染 ⇒ "代码改了、界面没变"，
 *      而所有只读代码的断言照样全绿。
 *    所以本迁移的**唯一实质工作**就是把库里那份枚举改对，并逐条自检。
 *
 * ===========================================================================
 * 历史兼容（用户明确要求"不能让存量工单无法查询，也不能静默篡改历史业务类型"）
 * ===========================================================================
 * 核对结果（迁移执行前的真库事实）：
 *   · 存量取值**只有 `repair`**（191 条）；
 *   · 库里旧枚举 = `[报修/repair, 投诉/complaint]`。
 * ⇒ 本次是**纯加法**：两个旧值**都仍在**新枚举里，含义与代码**都没有动**
 *   （只改了 `repair` 的**展示文案**：报修 → 维修，因为六类是**内部**口径，
 *     而"报修"是**客户**的说法 —— 见 `constants.TICKET_TYPE_LABEL` 的注释）。
 *   自检里**显式断言** `repair` 与 `complaint` 都在，且值集合是旧集合的超集 ——
 *   把"没有静默丢历史"变成一条可执行的判据，而不是一句承诺。
 *
 * ⚠️ 本迁移**不碰** `service_tickets.ticket_type` 的任何存量数据（没有任何 UPDATE），
 *    也不给该列加约束/枚举类型（列类型保持 `varchar`）—— 加 CHECK 会在将来
 *    再扩展时变成一次"必须先改约束才能插数据"的停机动作。
 */
import { Migration } from '@nocobase/database';

const TICKETS_COLLECTION = 'serviceTickets';

/** 目标枚举（顺序 = 后台下拉顺序）。**必须与 `collections/_options.ts` 逐字一致。** */
const TARGET_ENUM: Array<{ label: string; value: string }> = [
  { label: '维修', value: 'repair' },
  { label: '安装', value: 'installation' },
  { label: '调试保养', value: 'maintenance' },
  { label: '移机拆机', value: 'relocation' },
  { label: '投诉', value: 'complaint' },
  { label: '其他', value: 'other' },
];

/** 扩展**之前**的枚举（用于"只增不减"的反向自检） */
const LEGACY_VALUES = ['repair', 'complaint'];

export default class extends Migration {
  on = 'afterLoad';

  async up(): Promise<void> {
    const app: any = (this as any).context?.app;
    const db: any = (this as any).context?.db ?? (this as any).db;
    const log = {
      info: (m: string) => app?.log?.info?.(m),
      warn: (m: string) => app?.log?.warn?.(m),
    };

    const sequelize = db?.sequelize;
    if (!sequelize || typeof sequelize.query !== 'function') {
      throw new Error(
        '[service-ticket/migration] 无法取得 db.sequelize（迁移上下文不完整）—— ' +
          'ticket_type 的六类枚举未落到元数据层，后台仍只显示两类',
      );
    }

    // ---- ① 只改 `fields` 的 enum（列类型与数据都不动）----
    //
    // ⚠️ 必须**只**改 `uiSchema.enum` 这一个路径，不能整包覆盖 `options`：
    //    同一个 options 里还有 allowNull / comment / x-component 等，
    //    整包替换会把它们一起抹掉（那是"顺手扩大变更面"）。
    //    用 `jsonb_set` 精确落在 `{uiSchema,enum}` 上。
    //
    // 🔴 **`fields` 表没有 `updated_at` 列**（实测列只有：
    //    key / name / type / interface / description / collectionName /
    //    parentKey / reverseKey / options / sort）。
    //    第一版写了 `updated_at = now()` ⇒ 迁移抛
    //    `column "updated_at" does not exist` ⇒ **整个应用进维护模式 503**。
    //    ⇒ 教训（与 DEV-124 同型，一周内第二次）：**迁移里任何"顺手写上的列名"都必须先查列**，
    //      因为迁移失败不再是"某个接口红"，而是**全站不可用**。
    //
    // 🔴🔴🔴 第三版踩到的坑（**最值得记的一条**）：
    //    我写 `const [updated] = await sequelize.query(UPDATE …)` 然后读
    //    `updated.rowCount` —— 但**解构出来的第一个元素是"行集"**，
    //    对 UPDATE 而言它是**空数组**（`[]`），`rowCount` 在**第二个元素**（metadata）里。
    //    于是自检恒报"实际 0 行"，而 SQL 其实**执行成功了**。
    //    ⇒ 两次"改法"（replacements → bind）都在改一个**根本不是原因**的地方 ——
    //      因为报错信息是我自己写的、且它**读错了字段**。
    //      **验证器读错字段，会把排查引向完全错误的方向**（本项目反复吃这个亏）。
    //
    // ✅ 处置（**从结构上不再依赖驱动的 metadata 形状**）：
    //    · 不再断言 `rowCount` —— 那个值在不同驱动/不同语句类型下形状不一致；
    //    · 改为断言**回读结果**（下面 ③ 段）：`fields.options.uiSchema.enum`
    //      必须**逐字等于**目标枚举。SQL 没生效它就红，不依赖任何元数据字段。
    //    · `rowCount` 降级为**纯日志**：读不到就写"不可用"，绝不拿它当判据。
    const [updatedRows, updatedMeta] = await sequelize.query(
      `UPDATE fields
          SET options = jsonb_set(
                options::jsonb,
                '{uiSchema,enum}',
                $1::jsonb,
                true
              )
        WHERE "collectionName" = $2
          AND name = 'ticket_type'`,
      { bind: [JSON.stringify(TARGET_ENUM), TICKETS_COLLECTION] },
    );
    void updatedRows;
    const affected = Number((updatedMeta as any)?.rowCount);
    log.info?.(
      `[migration] fields.ticket_type 枚举 UPDATE 已执行` +
        `（rowCount=${Number.isFinite(affected) ? affected : '不可用（不作为判据，见 ③ 回读）'}）`,
    );

    // ---- ② 自检：**回读**（取代原先依赖 rowCount 的那一条，见上方第三版复盘）----
    // ⚠️ **先断行数**：`fields` 里没有这一行时，"枚举都对"这种判据会**空过**
    //    （202610091 的教训：只查"有没有坏行"的自检在匹配 0 行时会假绿）。
    // ⚠️ 取值用 `#>>`（text）。用 `#>` 会拿到 jsonb 对象，`String()` 后 JSON.parse
    //    得到 "[object Object]" —— 那条路曾把整个应用打成维护模式（DEV-124）。
    const [rows] = await sequelize.query(
      `SELECT coalesce(options::jsonb #>> '{uiSchema,enum}','[]') AS enum_text
         FROM fields
        WHERE "collectionName" = '${TICKETS_COLLECTION}' AND name = 'ticket_type'`,
    );
    const list = ((rows as any[]) ?? []).filter(Boolean);
    if (list.length !== 1) {
      throw new Error(`[migration] 自检失败：fields 元数据查到 ${list.length} 行（期望 1）`);
    }
    let actual: unknown;
    try {
      actual = JSON.parse(String((list[0] as any).enum_text || '[]'));
    } catch (e) {
      throw new Error(
        `[migration] 自检失败：uiSchema.enum 不是合法 JSON：${String((list[0] as any).enum_text).slice(0, 80)}`,
      );
    }
    if (JSON.stringify(actual) !== JSON.stringify(TARGET_ENUM)) {
      throw new Error(
        '[migration] 自检失败：枚举与契约不一致\n' +
          `         期望 ${JSON.stringify(TARGET_ENUM)}\n` +
          `         实际 ${JSON.stringify(actual)}`,
      );
    }

    // ---- ④ 自检：**只增不减**（历史值必须仍在，否则存量工单在界面上会显示成空白）----
    const values = (actual as Array<{ value: string }>).map((o) => o.value);
    const missingLegacy = LEGACY_VALUES.filter((v) => !values.includes(v));
    if (missingLegacy.length > 0) {
      throw new Error(
        `[migration] 自检失败：扩展后的枚举丢了历史取值 ${missingLegacy.join(', ')} —— ` +
          '存量工单会在界面上显示成空白，且**不会报错**。扩展只允许"只增不减"。',
      );
    }
    if (values.length !== TARGET_ENUM.length || new Set(values).size !== values.length) {
      throw new Error('[migration] 自检失败：枚举存在重复值或数量不符');
    }

    // ---- ⑤ 自检：存量数据仍可查询（用户要求"不能让存量工单无法查询"）----
    // 这里只做**读**：确认现存取值集合是新枚举的子集。
    const [distinctRows] = await sequelize.query(
      `SELECT DISTINCT ticket_type FROM service_tickets WHERE ticket_type IS NOT NULL`,
    );
    const distinct = ((distinctRows as any[]) ?? []).filter(Boolean).map((r: any) => String(r.ticket_type));
    const orphans = distinct.filter((v) => !values.includes(v));
    if (orphans.length > 0) {
      throw new Error(
        `[migration] 自检失败：库中存在新枚举之外的 ticket_type：${orphans.join(', ')} —— ` +
          '它们在后台会被渲染成空白。扩展前必须先把历史值纳入（不允许静默丢弃）。',
      );
    }
    log.info?.(
      `[migration] 自检通过：枚举 ${values.length} 项（历史 ${LEGACY_VALUES.join('/')} 均在）· ` +
        `存量取值 ${distinct.length} 种全部在新枚举内（${distinct.join('/') || '无'}）`,
    );
  }
}
