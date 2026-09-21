/**
 * expected-indexes.mjs —— 索引验收清单（单一事实来源）
 *
 * 为什么单独抽一个文件：
 *   Phase 1 真机启动时踩到一个很隐蔽的坑（见 docs/DEVIATIONS.md DEV-16）：
 *   NocoBase 的 `collection.refreshIndexes()` 会把"列还没注册到 model 上"的声明式索引
 *   **静默丢弃**，导致 serviceVisitPhotos / ticketEvents / smsLogs 三张表共 8 条索引
 *   从未下发到 Postgres，其中包含 2 条业务幂等键。
 *
 *   更麻烦的是：离线校验（桩环境）全绿、日志里没有任何报错、表也都建出来了 ——
 *   仅靠"表存在 + 健康检查 200"完全发现不了。所以必须把
 *   「哪些索引**必须**存在」这件事从代码里独立出来，写成一份可被反复核对的清单。
 *
 * 三处共用同一份清单，形成闭环：
 *   1) scripts/verify-plugin-load.mjs —— 离线比对：插件**声明**的索引 == 清单里 from:'collection' 的项
 *   2) scripts/smoke-test.mjs         —— 真机比对：Postgres **实际**索引 ⊇ 清单全部项
 *   3) docs/DATA-MODEL.md §13         —— 人读的索引核查清单
 *
 * 清单来源：docs/DATA-MODEL.md §2–§12 的「约束/索引」列。
 * 每条记录：
 *   columns  必填，列顺序敏感（复合索引的顺序决定它能不能被复用）
 *   unique   是否要求唯一
 *   from     'collection' = 由 collection 定义里的 indexes 声明
 *            'field'      = 由字段级 unique: true 声明（落库是 PG UNIQUE CONSTRAINT）
 *                        —— 离线校验只比对 'collection' 项，因为字段级根本不出现在 indexes 数组里
 *
 * ⚠️ 表名必须用**下划线**形式：本插件所有 collection 都经 defineAppCollection 强制
 *    underscored: true（见 _helpers.ts），表名/时间戳列全部是 snake_case。
 */

/** @typedef {{ columns: string[], unique?: boolean, from: 'collection'|'field' }} ExpectedIndex */

/** @type {Record<string, ExpectedIndex[]>} */
export const EXPECTED_INDEXES = {
  // §2 stores
  stores: [
    { columns: ['active', 'sort_order'], from: 'collection' },
    { columns: ['code'], unique: true, from: 'field' },
  ],

  // §3 store_users
  store_users: [
    { columns: ['user_id', 'store_id'], unique: true, from: 'collection' },
    { columns: ['user_id'], from: 'collection' },
    { columns: ['store_id'], from: 'collection' },
  ],

  // §4 service_tickets
  service_tickets: [
    { columns: ['store_id', 'status'], from: 'collection' },
    { columns: ['store_id'], from: 'collection' },
    { columns: ['status'], from: 'collection' },
    { columns: ['status', 'expected_visit_at'], from: 'collection' },
    { columns: ['customer_mobile'], from: 'collection' },
    { columns: ['customer_mobile', 'store_id', 'ticket_type'], from: 'collection' },
    { columns: ['created_at'], from: 'collection' },
    { columns: ['escalated'], from: 'collection' },
    { columns: ['review_status'], from: 'collection' },
    // 唯一性由字段级声明（PG UNIQUE CONSTRAINT），不在 collection.indexes 里
    { columns: ['ticket_no'], unique: true, from: 'field' },
    { columns: ['feedback_token_hash'], unique: true, from: 'field' },
  ],

  // §5 service_visits
  service_visits: [
    { columns: ['ticket_id'], from: 'collection' },
    { columns: ['ticket_id', 'visit_no'], unique: true, from: 'collection' },
    { columns: ['technician_mobile'], from: 'collection' },
    { columns: ['store_confirm_status'], from: 'collection' },
    // Phase 4-A 新增：Visit 生命周期状态。后台"当前派工 / 历史派工"都按它过滤。
    { columns: ['visit_status'], from: 'collection' },
    { columns: ['access_token_hash'], unique: true, from: 'field' },
  ],

  // §6 service_visit_photos
  service_visit_photos: [
    { columns: ['visit_id'], from: 'collection' },
    // ⚠️ 这条曾经被 NocoBase 静默丢弃过 —— file_id 是 belongsTo 外键，没有字段级 unique，
    //    唯一性**完全**依赖 collection 级声明。丢了就等于"同一文件可重复挂多次"。
    { columns: ['file_id'], unique: true, from: 'collection' },
    { columns: ['uploaded_at'], from: 'collection' },
  ],

  // §7 ticket_events
  ticket_events: [
    { columns: ['ticket_id', 'created_at'], from: 'collection' },
    { columns: ['event_type'], from: 'collection' },
    { columns: ['operator_user_id'], from: 'collection' },
    { columns: ['created_at'], from: 'collection' },
  ],

  // §8 sms_logs
  sms_logs: [
    { columns: ['ticket_id'], from: 'collection' },
    // ⚠️ 短信回执幂等的唯一手段，曾经被 NocoBase 静默丢弃过（DEV-16）
    { columns: ['provider', 'biz_id'], unique: true, from: 'collection' },
    { columns: ['delivery_status'], from: 'collection' },
    { columns: ['send_status'], from: 'collection' },
    { columns: ['scene'], from: 'collection' },
    { columns: ['send_status', 'retry_count'], from: 'collection' },
    { columns: ['created_at'], from: 'collection' },
  ],

  // §9 daily_sequences
  daily_sequences: [{ columns: ['seq_key'], unique: true, from: 'field' }],

  // §10 api_guards
  api_guards: [
    { columns: ['scene', 'scope', 'guard_key', 'window_start'], unique: true, from: 'collection' },
    { columns: ['expires_at'], from: 'collection' },
  ],

  // §11 idempotency_records
  idempotency_records: [
    { columns: ['scene', 'idempotency_key'], unique: true, from: 'collection' },
    { columns: ['created_at'], from: 'collection' },
  ],

  // §12 service_settings
  // 注：文档里叫 systemSettings，本插件实际叫 serviceSettings（核心已占用该名，见 DEV-15）
  service_settings: [{ columns: ['key'], unique: true, from: 'field' }],
};

/** 清单覆盖的表（顺序与 collections/index.ts 的 EXPECTED_TABLE_NAMES 一致） */
export const EXPECTED_INDEX_TABLES = Object.keys(EXPECTED_INDEXES);

/** 索引签名：列顺序敏感的列集合，用于语义等价判定（不看索引名） */
export const indexSignature = (columns) => columns.join('|');

/**
 * 把 Postgres `pg_indexes.indexdef` 解析成 { columns, unique }。
 * 例：`CREATE UNIQUE INDEX xxx ON public.sms_logs USING btree (provider, biz_id)`
 */
export function parseIndexDef(indexdef) {
  const unique = /^\s*CREATE\s+UNIQUE\s+INDEX/i.test(indexdef);
  const m = /\((.*)\)\s*$/.exec(indexdef);
  const inner = m ? m[1] : '';
  const columns = inner
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    // 去掉排序/操作符类后缀，如 `created_at DESC NULLS LAST`、`name varchar_pattern_ops`
    .map((s) => s.split(/\s+/)[0])
    .filter(Boolean);
  return { columns, unique };
}
