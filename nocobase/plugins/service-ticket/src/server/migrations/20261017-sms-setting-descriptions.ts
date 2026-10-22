/**
 * 迁移：修正 `serviceSettings` 中**已知过期的短信通道描述**（UX-01C-R8 §六）。
 *
 * 背景：
 *   `sms.provider` 的代码描述在 P11-4 已改成「mock / aliyun / smsbao」，
 *   但 `serviceSettings` 是**只增不改**的种子（DEV-23），已安装实例里仍是旧文案
 *   「mock / aliyun / tencent」—— 而 tencent 从未实现，运营会误以为可选。
 *
 * 纪律（用户 §六）：
 *   · 只改**能证明是旧默认描述**的行（`description` 与已知旧串**逐字相等**）；
 *   · 运营手工改过的描述（任何其它内容）**一律不动**；
 *   · 幂等：已经是新描述时 `updated=0`，重复执行无副作用。
 *
 * 失败语义：抛出。迁移被 umzug 记为完成后不会重跑，静默失败就再没机会。
 */
import { Migration } from '@nocobase/database';

/** 已知的旧默认描述（逐字）→ 新描述（与 constants.DEFAULT_SETTINGS 对齐） */
const REWRITES: Array<{ key: string; oldText: string; newText: string }> = [
  {
    key: 'sms.provider',
    oldText: '短信通道：mock / aliyun / tencent',
    newText:
      '短信通道：mock（模拟，不真实发送）/ aliyun（阿里云）/ smsbao（短信宝）。未实现的通道不在可选项内。',
  },
];

export default class extends Migration {
  on = 'afterLoad';

  async up(): Promise<void> {
    const app: any = (this as any).context?.app;
    const db: any = (this as any).context?.db ?? (this as any).db;
    if (!db || typeof db.getRepository !== 'function') {
      throw new Error('[service-ticket/migration] 无法取得 db（迁移上下文不完整），短信描述未修正');
    }

    let updated = 0;
    for (const item of REWRITES) {
      // 条件里带 oldText：只有"仍是我们写的旧默认值"才改。
      // 用 raw UPDATE 而不是 repository.update —— 后者返回实例数组（DEV-203 的教训），
      // 这里要的是**受影响行数**。
      const [, meta] = await db.sequelize.query(
        `UPDATE service_settings SET description = $1, updated_at = now()
          WHERE key = $2 AND description = $3`,
        { bind: [item.newText, item.key, item.oldText] },
      );
      const affected = Number((meta as any)?.rowCount ?? (meta as any)?.affectedRows ?? 0);
      updated += affected;
      app?.log?.info?.(
        `[service-ticket/migration] ${item.key} 旧描述修正：${affected} 行` +
          (affected === 0 ? '（已是新描述或运营改过 —— 不改）' : ''),
      );
    }

    app?.log?.info?.(`[service-ticket/migration] 短信设置描述迁移完成：共修正 ${updated} 行`);
  }
}
