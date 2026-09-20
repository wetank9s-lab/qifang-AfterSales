import { defineAppCollection, int, str } from './_helpers';

/**
 * dailySequences —— 业务编号取号器
 *
 * 用途：生成工单号 FW20260920-0001 的每日流水。
 *
 * 为什么不用 count(*)+1：并发下必然重复。
 * 为什么不用 PG 序列：序列是全局的，我们需要"按日期重置"。
 *
 * 唯一允许的原生 SQL（已参数化，无拼接）：
 *
 *   INSERT INTO daily_sequences (seq_key, current_value, updated_at)
 *   VALUES ($1, 1, now())
 *   ON CONFLICT (seq_key)
 *   DO UPDATE SET current_value = daily_sequences.current_value + 1, updated_at = now()
 *   RETURNING current_value;
 *
 * 这条语句在 PG 里是原子的（行锁 + upsert），并发下无重复、无空洞。
 * 实现见 services/sequence-service.ts。
 *
 * ⚠️ 手写原生 SQL 时的列名约定（已按真机 `\d` 实测确认，务必照抄上面的写法）：
 *   时间戳列是 **snake_case 的 `created_at` / `updated_at`**，不加双引号。
 *   之所以不是 NocoBase 默认的 camelCase `"updatedAt"`，是因为本插件所有 collection
 *   都经 defineAppCollection 强制 `underscored: true`（见 _helpers.ts 的说明与 DEV-14）。
 *   （本文件早期注释曾写"时间戳是 camelCase updatedAt，必须加双引号"——
 *    那是 underscored 修复之前的旧结论，按它写会在真机上报 42703 列不存在。）
 *   NocoBase 不会自动填这两个列（列上无 DB default），因此原生 INSERT 必须显式赋值。
 *   常量见 _helpers.ts 的 CREATED_AT_COLUMN / UPDATED_AT_COLUMN。
 */
export default defineAppCollection({
  name: 'dailySequences',
  title: '每日取号器',
  fields: [
    str('seq_key', '取号键', {
      length: 32,
      allowNull: false,
      unique: true,
      comment: 'FW-20260920（前缀-日期）；Visit 取号用 V-<ticketId>',
    }),
    int('current_value', '当前值', {
      allowNull: false,
      defaultValue: 0,
      comment: '已发出的最大序号',
    }),
  ],
  // 唯一性只由字段级 `unique: true` 声明（生成 PG UNIQUE CONSTRAINT，索引名 daily_sequences_seq_key_key）。
  // 早期这里还额外写过 `indexes: [{ fields: ['seq_key'], unique: true }]`，
  // 会在同一列上再建一个同义索引（daily_sequences_seq_key），纯属浪费，已清理（DEV-17）。
  indexes: [],
});
