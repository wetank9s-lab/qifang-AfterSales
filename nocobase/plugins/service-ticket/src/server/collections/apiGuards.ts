import { defineAppCollection, enumStr, int, str, ts } from './_helpers';
import { GUARD_SCOPE_OPTIONS } from './_options';

/**
 * apiGuards —— 限流计数（应用层精确限流）
 *
 * nginx 的 limit_req 只能按 IP 粗粒度限流；
 * 文档要求的是"按手机号 / 按 Token / 按门店"的精细限流，因此在应用层用这张表实现。
 *
 * 设计：
 *  - `guard_key` 必须已哈希：IP 存 sha256(ip + SIGN_SECRET)，手机号存 sha256(mobile + SIGN_SECRET)。
 *    **不存明文**，即使库被拖走也无法反查用户。
 *  - 窗口粒度由 window_start 决定（分钟级或天级），计数用 upsert 原子自增。
 *  - 过期数据由 guardCleanup 定时任务清理（expires_at < now）。
 *
 * 唯一约束保证同一个窗口只有一行：unique(scene, scope, guard_key, window_start)。
 */
export default defineAppCollection({
  name: 'apiGuards',
  title: '接口限流计数',
  fields: [
    str('scene', '场景', {
      length: 32,
      allowNull: false,
      comment: 'public_ticket / technician_token / review_token / technician_upload …',
    }),
    enumStr('scope', '限流维度', GUARD_SCOPE_OPTIONS, { allowNull: false }),
    str('guard_key', '维度值哈希', {
      length: 128,
      allowNull: false,
      comment: 'sha256(值 + SIGN_SECRET)；禁止存明文 IP / 手机号',
    }),
    ts('window_start', '窗口起点', {
      allowNull: false,
      comment: '分钟窗口取该分钟整点；日窗口取当日 00:00',
    }),
    int('counter', '计数', { allowNull: false, defaultValue: 0 }),
    ts('expires_at', '过期时间', {
      allowNull: false,
      comment: 'guardCleanup 依据此列清理',
    }),
  ],
  indexes: [
    { fields: ['scene', 'scope', 'guard_key', 'window_start'], unique: true },
    { fields: ['expires_at'] },
  ],
});
