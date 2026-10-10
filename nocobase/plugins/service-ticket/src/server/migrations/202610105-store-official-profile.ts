/**
 * 迁移：门店**正式资料**落库（Phase 11 / P11-2 · 用户 A 段，2026-10-10）
 * =============================================================================
 *
 * 用户 2026-10-10 给出 10 条真实「门店名称 + 门店地址」，要求"安全落库"。
 * 匹配结论与逐条证据见 `seeds/store-official-list.ts`（本迁移只消费它的
 * `CONFIRMED_STORE_PROFILE` —— **待核对的条目结构上无法被写进来**）。
 *
 * 本次**实际会改的行**（只有 2 条）：
 *   S01  圣大家电新都店 → 新都圣大家电      + address = 新都区新城市广场和信中心1-3楼
 *   S04  金堂华林电器   （名称不变）        + address = 金堂县赵镇十里大道一段428号
 *
 * ===========================================================================
 * 四条硬约束（用户逐条点名，逐条都有对应实现或自检）
 * ===========================================================================
 * ① **不覆盖已有有效联系方式或其他业务配置**：
 *    本迁移**只写 name / address 两列**；`contact_phone` / `active` / `sort_order`
 *    / `code` / `id` **一个字都不动**，并在自检里**逐行比对前后快照**证明。
 * ② **可审计、可复核**：把"改了哪几行、凭什么、什么时候"写进
 *    `service_settings[store.profile.official-list.audit]`（现成的 key/value 表，不新建表）。
 * ③ **重复执行安全**（幂等）：第二次执行时读到的已是正式值 ⇒ 走 `already` 分支，0 写入。
 * ④ **重新运行门店 seed 不得恢复旧空值**：`seedStores()` 的语义是"按 code 只增不改"
 *    （见 seeds/apply.ts 注释），且 `STORE_SEEDS` 现在也从本文件同一份清单派生。
 *    本迁移**不依赖**这一点，只让它成立。
 *
 * ⚠️ 还刻意**不碰** `SIGN_SECRET` 所在的任何配置：门店专属入口的签名是
 *    `(门店编码, SIGN_SECRET)` 的纯函数，与 name/address 无关 ⇒
 *    本次改动**不可能**改变已发出二维码的 entry/url（门禁会前后逐字比对证明）。
 *
 * ⚠️ **不得**把 `stores.address`（门店**经营**地址）与 `serviceTickets.service_address`
 *    （客户**服务**地址）互相填充 —— 本迁移的 UPDATE 只落在 `stores` 表上。
 */
import { Migration } from '@nocobase/database';

import {
  CONFIRMED_STORE_PROFILE,
  STORE_PROFILE_AUDIT_KEY,
  buildStoreProfileAudit,
} from '../seeds/store-official-list';

const STORES_TABLE = 'stores';

/**
 * 每个 code 的**期望前值**（占位名）。
 *
 * 为什么要有它：UPDATE 带 `AND name = :expectedBefore` 之后，
 * **运营在后台把这家店改成别的名字**时，本迁移**不会**把它改回来 ——
 * 那是"覆盖其他业务配置"，用户明令禁止。
 * 遇到这种行就记 `conflicted` 并跳过（如实报，不假装成功）。
 */
const EXPECTED_BEFORE: Record<string, string> = {
  S01: '圣大家电新都店',
  S04: '金堂华林电器',
};

interface StoreRow {
  code: string;
  name: string;
  address: string | null;
  contact_phone: string | null;
  active: boolean;
  sort_order: number | null;
}

type Outcome = 'applied-name-address' | 'applied-address' | 'already' | 'conflicted';

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
          '门店正式资料未落地，H5 门店卡会继续显示占位名',
      );
    }

    // ---- ① 前置快照：**全部 15 行**的关键列（自检要与它逐行比对）----
    const [beforeRows] = await sequelize.query(
      `SELECT code, name, address, contact_phone, active, sort_order
         FROM ${STORES_TABLE} ORDER BY code`,
    );
    const before = new Map<string, StoreRow>(
      ((beforeRows as StoreRow[]) ?? []).filter(Boolean).map((r) => [String(r.code), r]),
    );
    if (before.size === 0) {
      // 全新库：种子还没跑（或本迁移先于 seed）。不算失败 —— 直接记录并返回，
      // 因为 `STORE_SEEDS` 已从同一份清单派生，新库里本来就是正式名。
      log.info?.('[migration] stores 表为空（全新库）—— 正式名由 STORE_SEEDS 直接落库，本迁移无事可做');
      await this.writeAudit(sequelize, 'skipped-empty-db', {});
      return;
    }

    // ---- ② 逐条应用（只有 confirmed 会被写）----
    const outcomes: Record<string, { code: string; outcome: Outcome; name: string; address: string }> = {};
    for (const [code, profile] of Object.entries(CONFIRMED_STORE_PROFILE)) {
      const current = before.get(code);
      if (!current) {
        outcomes[code] = { code, outcome: 'conflicted', name: profile.name, address: profile.address };
        log.warn?.(`[migration] ${code} 不在 stores 表里 —— 跳过（不新建门店：用户明令不得新建重复门店）`);
        continue;
      }

      const nameIsOfficial = String(current.name) === profile.name;
      const nameIsPlaceholder = String(current.name) === EXPECTED_BEFORE[code];
      const addressIsOfficial = String(current.address ?? '') === profile.address;

      if (nameIsOfficial && addressIsOfficial) {
        outcomes[code] = { code, outcome: 'already', name: profile.name, address: profile.address };
        continue;
      }
      if (!nameIsOfficial && !nameIsPlaceholder) {
        // 名字被别处改过 ⇒ **不覆盖**（这是"其他业务配置"）
        outcomes[code] = { code, outcome: 'conflicted', name: String(current.name), address: profile.address };
        log.warn?.(
          `[migration] ${code} 的当前名称 ${JSON.stringify(current.name)} 既不是占位名也不是正式名 ` +
            '—— 判定为人工改过，**不覆盖**（记 conflicted）',
        );
        continue;
      }

      // 名称：只从"占位名"改成"正式名"；已经是正式名时 UPDATE 不影响它（幂等）
      await sequelize.query(
        `UPDATE ${STORES_TABLE} SET name = $1 WHERE code = $2 AND name = $3`,
        { bind: [profile.name, code, nameIsOfficial ? profile.name : EXPECTED_BEFORE[code]] },
      );
      // 地址：**只在为空时补**（不覆盖已有地址 —— 那可能是运营手工填的）
      await sequelize.query(
        `UPDATE ${STORES_TABLE} SET address = $1 WHERE code = $2 AND address IS NULL`,
        { bind: [profile.address, code] },
      );

      outcomes[code] = {
        code,
        outcome: nameIsOfficial ? 'applied-address' : 'applied-name-address',
        name: profile.name,
        address: profile.address,
      };
    }

    // ---- ③ 后置快照 ----
    const [afterRows] = await sequelize.query(
      `SELECT code, name, address, contact_phone, active, sort_order
         FROM ${STORES_TABLE} ORDER BY code`,
    );
    const after = new Map<string, StoreRow>(
      ((afterRows as StoreRow[]) ?? []).filter(Boolean).map((r) => [String(r.code), r]),
    );

    // ---- ④ 自检 1：两个确认条目的最终形态必须**逐字**等于清单 ----
    for (const [code, profile] of Object.entries(CONFIRMED_STORE_PROFILE)) {
      const row = after.get(code);
      if (!row) continue;
      const outcome = outcomes[code]?.outcome;
      if (outcome === 'conflicted') {
        // 人工改过的行：这里只要求"地址没被我们写坏"（要么是正式地址，要么仍为空）
        const addr = String(row.address ?? '');
        if (addr !== '' && addr !== profile.address) {
          throw new Error(`[migration] 自检失败：${code} 的地址被改成了意外值 ${JSON.stringify(addr)}`);
        }
        continue;
      }
      if (String(row.name) !== profile.name) {
        throw new Error(
          `[migration] 自检失败：${code} 的名称是 ${JSON.stringify(row.name)}，期望 ${JSON.stringify(profile.name)}`,
        );
      }
      if (String(row.address ?? '') !== profile.address) {
        throw new Error(
          `[migration] 自检失败：${code} 的地址是 ${JSON.stringify(row.address)}，期望 ${JSON.stringify(profile.address)}`,
        );
      }
    }

    // ---- ⑤ 自检 2：**未确认的行必须一字未动**（name/address/phone/active/sort_order 全比对）----
    let untouched = 0;
    for (const [code, row] of before) {
      if (code in CONFIRMED_STORE_PROFILE && outcomes[code]?.outcome !== 'conflicted') continue;
      const now = after.get(code);
      if (!now) throw new Error(`[migration] 自检失败：${code} 在更新后消失了`);
      const same =
        String(now.name) === String(row.name) &&
        String(now.address ?? '') === String(row.address ?? '') &&
        String(now.contact_phone ?? '') === String(row.contact_phone ?? '') &&
        Boolean(now.active) === Boolean(row.active) &&
        String(now.sort_order ?? '') === String(row.sort_order ?? '');
      if (!same) {
        throw new Error(
          `[migration] 自检失败：**不该被改**的 ${code} 发生了变化\n` +
            `        前 ${JSON.stringify(row)}\n        后 ${JSON.stringify(now)}`,
        );
      }
      untouched += 1;
    }

    // ---- ⑥ 自检 3：联系方式必须保持 NULL（用户未提供电话，不得生成虚假号码）----
    const phones = await sequelize.query(
      `SELECT count(*)::int AS n FROM ${STORES_TABLE} WHERE contact_phone IS NOT NULL`,
    );
    const nonNullPhones = Number((phones?.[0] as any)?.[0]?.n ?? 0);
    const beforePhones = [...before.values()].filter((r) => r.contact_phone !== null).length;
    if (nonNullPhones !== beforePhones) {
      throw new Error(
        `[migration] 自检失败：contact_phone 非空行数从 ${beforePhones} 变成 ${nonNullPhones} ` +
          '—— 电话号码用户尚未提供，任何一行都不该被写',
      );
    }

    // ---- ⑦ 审计落库 ----
    await this.writeAudit(sequelize, 'applied', outcomes);

    log.info?.(
      `[migration] 门店正式资料已落库：${Object.entries(outcomes)
        .map(([code, o]) => `${code}=${o.outcome}`)
        .join(' · ')}；未确认的行 ${untouched} 行逐列比对**一字未动**；` +
        `contact_phone 非空仍为 ${nonNullPhones} 行（未生成任何号码）`,
    );
  }

  /** 把"改了哪几行、凭什么、什么时候"写进 service_settings（幂等：按 key upsert） */
  private async writeAudit(
    sequelize: any,
    phase: string,
    outcomes: Record<string, { code: string; outcome: Outcome; name: string; address: string }>,
  ): Promise<void> {
    const payload = {
      ...buildStoreProfileAudit(new Date().toISOString()),
      phase,
      outcomes: Object.values(outcomes),
    };
    await sequelize.query(
      `INSERT INTO service_settings (created_at, updated_at, key, value, value_type, description, updated_by)
       VALUES (now(), now(), $1, $2, 'json', $3, 'migration:202610105')
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      {
        bind: [
          STORE_PROFILE_AUDIT_KEY,
          JSON.stringify(payload),
          '门店正式清单落库审计（P11-2 A 段）',
        ],
      },
    );
  }
}
