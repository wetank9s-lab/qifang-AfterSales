/**
 * 迁移：NEW 的状态文案统一为「待处理」——**同步已落库的字段元数据**（Phase 11 / P11-0 · 方案 A）
 *
 * ===========================================================================
 * 为什么改了 `TICKET_STATUS_LABEL` 还**必须**有本迁移（实测踩到）
 * ===========================================================================
 * 用户 2026-10-10 正式裁决（方案 A）：NEW 的业务界面文案统一为「待处理」，
 * 界面不再出现「待受理」（`accept` 已彻底不在门店流程里）。
 *
 * 改完 `constants.ts` 的 `TICKET_STATUS_LABEL.NEW` 并重启后，**门店列表的状态列
 * 仍然显示「待受理」**。原因是本项目已经付过一次学费的那条规律
 * （见 `202610091-visit-fields-allow-null.ts` 的文件头）：
 *
 * > **NocoBase 的字段展示取自库里的字段元数据（`fields.options.uiSchema.enum`），
 * >  不是取自我们代码里的 collection 定义。已存在的集合，代码定义只在 `install`
 * >  时被写入库；之后库里的那份说了算。**
 *
 * 实测确认：`fields` 表里三处枚举**全是旧文案** ——
 *   · `serviceTickets.status`      （门店列表 / 详情里的状态标签）
 *   · `ticketEvents.from_status`   （处理记录时间线的「原状态」）
 *   · `ticketEvents.to_status`     （处理记录时间线的「新状态」）
 * 只改代码 ⇒ 这三处继续显示「待受理」，而且**没有任何报错**。
 *
 * ⚠️ 这与"页面配置"是两回事：Tab 标题走的是 `flowModels`（由 seed 重灌，
 *    见 `seed-admin-pages.mjs` 的 `STATUS_TABS`）；本迁移只管**字段元数据**。
 *    两者都必须处理，否则会出现"Tab 写待处理、状态列写待受理"的自相矛盾。
 *
 * ===========================================================================
 * 为什么不在这里重抄一遍标签
 * ===========================================================================
 * 期望值 = `TICKET_STATUS_OPTIONS`（`collections/_options.ts` 从 `TICKET_STATUS_LABEL`
 * 生成）。本文件**一个字面量标签都不写** —— 否则下次改文案时，
 * 迁移里那份会与常量的那份漂移（"同一条规则两条腿"，本项目的老毛病）。
 */
import { Migration } from '@nocobase/database';

import { TICKET_STATUS_OPTIONS } from '../collections/_options';

/** `fields.collectionName` 用的是**逻辑名**（不是表名）—— 踩过一次，见 202610091 的文件头 */
const TARGETS: Array<{ collectionName: string; fieldName: string; what: string }> = [
  { collectionName: 'serviceTickets', fieldName: 'status', what: '工单状态标签' },
  { collectionName: 'ticketEvents', fieldName: 'from_status', what: '时间线「原状态」' },
  { collectionName: 'ticketEvents', fieldName: 'to_status', what: '时间线「新状态」' },
];

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
          'NEW 的「待处理」文案未同步到字段元数据，状态列会继续显示「待受理」',
      );
    }

    const desired = JSON.stringify(TICKET_STATUS_OPTIONS);

    // ---- ① 库里的字段元数据：重建 enum ----
    // 只改**与期望值不同**的行（幂等；已经对的、以及运维自己调过的都不动）。
    // ⚠️ `options` 列的类型是 **json**，而 `jsonb_set` 只吃 jsonb
    //    ⇒ 入参 `options::jsonb`，出参再 `::json` 写回（照抄 202610091 的实测结论）。
    let changed = 0;
    for (const target of TARGETS) {
      const [result] = await sequelize.query(
        `UPDATE fields
            SET options = (jsonb_set(coalesce(options::jsonb, '{}'::jsonb), '{uiSchema,enum}', :desired::jsonb))::json
          WHERE "collectionName" = :collectionName
            AND name = :fieldName
            AND coalesce(options::jsonb #> '{uiSchema,enum}', '[]'::jsonb) IS DISTINCT FROM :desired::jsonb`,
        { replacements: { desired, collectionName: target.collectionName, fieldName: target.fieldName } },
      );
      const n = Number((result as any)?.rowCount ?? 0);
      changed += n;
      log.info?.(
        `[migration] ${target.collectionName}.${target.fieldName}（${target.what}）元数据 enum 已更新 ${n} 行`,
      );
    }

    // ---- ② 就地更新本进程已构建的字段对象 ----
    // 元数据改动只对**下次启动**建集合时生效；本次启动的那份必须就地改，
    // 否则要"重启两次"（没人记得住这种事）。照 202610091 的做法。
    try {
      for (const target of TARGETS) {
        const collection: any = db.getCollection?.(target.collectionName);
        const fieldObj: any = collection?.getField?.(target.fieldName);
        const uiSchema = fieldObj?.options?.uiSchema;
        if (uiSchema) {
          uiSchema.enum = TICKET_STATUS_OPTIONS.map((o) => ({ ...o }));
        }
      }
      log.info?.('[migration] 本进程内的集合字段 uiSchema.enum 已就地更新（避免"要重启两次"）');
    } catch (e) {
      log.warn?.(
        '[migration] 就地更新内存字段对象失败（正确性不受影响，但可能需要再重启一次才生效）：' +
          String((e as Error)?.message ?? e).slice(0, 160),
      );
    }

    // ---- ③ 自检 ----
    // 🔴 三段判据缺一不可（照抄 202610091 的教训）：
    //    第一版那种"只查有没有坏行"的自检，在**集合名写错 ⇒ 匹配 0 行**时
    //    会打印"自检通过" —— 一次什么都没检查到的假绿。
    //    ⇒ 先断言**行数**，再断言**没有旧文案**，最后断言**与期望值逐字相同**。
    const [rows] = await sequelize.query(
      `SELECT "collectionName" AS c, name AS n, coalesce(options::jsonb #> '{uiSchema,enum}', '[]'::jsonb) AS enum
         FROM fields
        WHERE ("collectionName" = 'serviceTickets' AND name = 'status')
           OR ("collectionName" = 'ticketEvents' AND name IN ('from_status', 'to_status'))`,
    );
    const list = ((rows as any[]) ?? []).filter(Boolean);
    if (list.length !== TARGETS.length) {
      throw new Error(
        `[migration] 自检查到的字段行数不符：期望 ${TARGETS.length} 行，实际 ${list.length} 行 —— ` +
          '集合名可能写错（fields.collectionName 用的是**逻辑名**）。' +
          '这种情况下"没查到坏行"不等于"都是好的"。',
      );
    }

    const stale = list.filter((r) => JSON.stringify(r.enum ?? []).includes('待受理'));
    if (stale.length) {
      throw new Error(
        '[migration] 仍有字段元数据含「待受理」，状态列会显示旧文案：' +
          stale.map((r) => `${r.c}.${r.n}`).join(', '),
      );
    }

    const mismatch = list.filter((r) => JSON.stringify(r.enum) !== JSON.stringify(TICKET_STATUS_OPTIONS));
    if (mismatch.length) {
      throw new Error(
        '[migration] 以下字段的 enum 与 TICKET_STATUS_OPTIONS 不一致（顺序或内容）：' +
          mismatch.map((r) => `${r.c}.${r.n}=${JSON.stringify(r.enum)}`).join(' | '),
      );
    }

    log.info?.(
      `[migration] 自检通过：${list.length} 个字段的状态枚举均为「${TICKET_STATUS_OPTIONS.map((o) => o.label).join(' / ')}」` +
        `（本次更新 ${changed} 行）`,
    );
  }
}
