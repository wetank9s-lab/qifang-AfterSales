/**
 * ensure-indexes.ts —— 在 db.sync() 之后显式核对并补齐 collection 级索引。
 *
 * ============================================================================
 * 为什么必须有这一步（Phase 1 真机启动踩到的坑，详见 docs/DEVIATIONS.md DEV-16）
 * ============================================================================
 *
 * NocoBase 建表建索引的调用链是：
 *     app.load() → db.sync() → SyncRunner.runSync() → sequelize.Model.sync()
 *
 * 而 Sequelize 的 Model.sync() 建索引读的是 **model._indexes**，不是 collection
 * 定义里的 options.indexes：
 *     sequelize/lib/model.js:989
 *       const missingIndexes = this._indexes.filter(...)
 *
 * model._indexes 在 @nocobase/database 里被 `collection.refreshIndexes()` 重建过：
 *     collection.js:673 refreshIndexes() {
 *       ...
 *       this.model._indexes = _.uniqBy(
 *         indexes.filter((item) => item.fields.every((field) => {
 *           const name = this.normalizeFieldName(field);
 *           return attributes[name];          // ← attributes 来自 model.getAttributes()
 *         })).map(...), 'name');
 *     }
 *
 * 也就是说：**只要某一列的 attribute 还没注册到 model 上，引用它的索引就被整条丢掉**，
 * 而且是 `.filter()` 静默丢弃 —— 不抛错、不告警、不重试。
 * refreshIndexes() 只由 addIndex()/removeIndex() 触发，而它们由字段级索引注册触发
 * （fields/field.js:140 与 fields/belongs-to-field.js:130），
 * 因此触发时机完全取决于字段注册顺序 —— 有的 collection 落在"业务字段已就绪"之后，
 * 有的落在"只有 FK 列与时间戳列"的时候。
 *
 * 真机实测（在 Postgres 打开 log_statement=all 抓到的真实 DDL，可复现）：
 *   serviceVisitPhotos / ticketEvents / smsLogs 三张表共 **8 条**声明式索引被丢弃，
 *   Postgres 从未收到对应的 CREATE INDEX 语句。例如 sms_logs 只收到了
 *     sms_logs_ticket_id / sms_logs_created_at / sms_logs_visit_id
 *   （恰好只涉及 FK 列 ticket_id/visit_id 与时间戳列 created_at），
 *   而 unique(provider, biz_id)、scene、send_status、delivery_status、
 *   (send_status, retry_count) 全部没有下发。
 *
 * 这 8 条绝不是"可有可无的性能优化"：
 *   · sms_logs.unique(provider, biz_id)        —— 短信回执幂等的唯一手段
 *   · service_visit_photos.unique(file_id)     —— 同一文件不得挂两次
 * 丢了就是**数据完整性**问题，所以本插件不接受"静默缺失"。
 *
 * ============================================================================
 * 做法：把"表结构对不对"的判断权拿回自己手里
 * ============================================================================
 * 不依赖 NocoBase 内部的 _indexes 重建逻辑（那是私有实现，跨版本会变），
 * 而是自己拿 Sequelize 的**公开** QueryInterface 做一次幂等对账：
 *     showIndex(table)  → 库里现有索引（含 UNIQUE CONSTRAINT 背后的索引）
 *     逐条比对 collection 定义里声明的 indexes
 *     缺了就 addIndex()
 *
 * 比对口径是"**列集合 + 是否唯一**"，而不是索引名 —— 因为
 *   · 字段级 unique: true 由 PG 自动命名成 `<table>_<col>_key`，
 *     collection 级的等价索引叫 `<table>_<col>`，两者名字不同但语义等价；
 *     按名字比会误判成"缺失"从而建出重复索引（本插件早期就是这样，
 *     库里出现过 service_tickets_ticket_no 与 service_tickets_ticket_no_key 并存）。
 *   · 按语义比天然幂等：重启多少次都不会重复建。
 *
 * 副作用：本函数**只增不删**。发现语义等价的索引就当作"已满足"，绝不擅自删别人的索引。
 */
import { createHash } from 'node:crypto';

import { ALL_COLLECTIONS } from './collections';

/** 单条索引的核对结果 */
export interface EnsureIndexesResult {
  created: number;
  satisfied: number;
  /** 每条新建索引的可读描述，便于日志与排障 */
  createdDetail: string[];
  /** 无法核对/补齐的项（表不存在、QueryInterface 不可用……），非空即代表调用方应当警觉 */
  failures: string[];
  /** 整体是否可用（false 表示环境不支持，已跳过而非失败） */
  applicable: boolean;
  skippedReason?: string;
}

/** 索引名的 PostgreSQL 标识符上限 */
const PG_IDENTIFIER_MAX = 63;

/**
 * 把 collection 定义里的字段名解析成**真实列名**。
 *
 * 本插件所有 collection 都开了 underscored，业务字段本身就是 snake_case，
 * 所以通常 field === 列名。但时间戳例外：NocoBase 注入的属性叫 createdAt，
 * 列名才是 created_at —— 必须经由 model 的 attribute.field 拿，不能猜。
 */
function resolveColumns(collection: any, fields: string[]): string[] {
  const attributes: Record<string, any> =
    typeof collection?.model?.getAttributes === 'function' ? collection.model.getAttributes() : {};

  return fields.map((field) => {
    for (const [attrName, attr] of Object.entries(attributes)) {
      if (attr && attr.field === field) return attr.field;
      if (attrName === field) return attr?.field || attrName;
    }
    // 兜底：拿不到 model attributes 时按原样使用（本插件字段本来就是列名）
    return field;
  });
}

/** 索引签名：列顺序敏感的列集合。用于语义等价判定。 */
function signature(columns: string[]): string {
  return columns.join('|');
}

/**
 * 生成索引名，与 Sequelize/NocoBase 的默认命名保持一致（`<table>_<col>_<col>`）。
 *
 * 超过 PG 的 63 字符标识符上限时退化为 md5（与 NocoBase collection.js:652 同一策略），
 * 否则 PG 会静默截断，可能撞名。
 *
 * `collisionSuffix` 用于"同一组列上已经存在一个**非唯一**索引，但定义要求唯一"的场景：
 * 此时默认名已被占用，必须换一个名字，否则 PG 报 relation already exists。
 */
function buildIndexName(table: string, columns: string[], collisionSuffix = ''): string {
  const base = `${table}_${columns.join('_')}${collisionSuffix}`;
  if (base.length <= PG_IDENTIFIER_MAX) return base;
  return `i_${createHash('md5').update(base).digest('hex')}`;
}

/** 取库中现有索引：签名 → { unique 是否为唯一索引 } */
async function readExistingIndexes(
  queryInterface: any,
  table: string,
): Promise<Map<string, { unique: boolean; names: string[] }>> {
  const map = new Map<string, { unique: boolean; names: string[] }>();
  const indexes: any[] = await queryInterface.showIndex(table);

  for (const index of indexes) {
    const columns: string[] = (index.fields || []).map((f: any) =>
      typeof f === 'string' ? f : f.attribute || f.field || String(f),
    );
    if (columns.length === 0) continue;

    const key = signature(columns);
    const prev = map.get(key);
    if (prev) {
      prev.unique = prev.unique || !!index.unique;
      prev.names.push(index.name);
    } else {
      map.set(key, { unique: !!index.unique, names: [index.name] });
    }
  }

  return map;
}

/**
 * 核对并补齐全部 collection 的声明式索引。
 *
 * 调用时机必须是 **db.sync() 之后**（表已经建好），
 * plugin.ts 里挂在 app 的 `afterLoad` 事件上 —— application.js 的时序是
 *   emitAsync('beforeLoad') → pm.load()(= 插件 load() + 建表) → db.sync() → emitAsync('afterLoad')
 */
export async function ensureIndexes(app: any, logger?: any): Promise<EnsureIndexesResult> {
  const result: EnsureIndexesResult = {
    created: 0,
    satisfied: 0,
    createdDetail: [],
    failures: [],
    applicable: true,
  };

  const db: any = app?.db;
  const queryInterface: any = db?.sequelize?.getQueryInterface?.();

  if (!queryInterface || typeof queryInterface.showIndex !== 'function' || typeof queryInterface.addIndex !== 'function') {
    // 不是"失败"，是"这个环境不适用"（例如非 SQL 数据源、离线桩、单元测试）。
    // 绝不在这里抛错 —— 否则任何非 Postgres 场景都起不来。
    result.applicable = false;
    result.skippedReason = 'sequelize queryInterface(showIndex/addIndex) 不可用';
    logger?.debug?.(`[service-ticket] 索引核对跳过：${result.skippedReason}`);
    return result;
  }

  for (const options of ALL_COLLECTIONS as Array<Record<string, any>>) {
    const collectionName = options.name;
    const declared: Array<Record<string, any>> = Array.isArray(options.indexes) ? options.indexes : [];
    if (declared.length === 0) continue;

    const collection = db.hasCollection?.(collectionName) ? db.getCollection?.(collectionName) : null;
    const table: string =
      collection?.model?.getTableName?.() ??
      (typeof collectionName === 'string'
        ? collectionName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
        : String(collectionName));

    let existing: Map<string, { unique: boolean; names: string[] }>;
    try {
      existing = await readExistingIndexes(queryInterface, table);
    } catch (error) {
      result.failures.push(`${table}：读取现有索引失败（${(error as Error)?.message}）`);
      continue;
    }

    for (const index of declared) {
      const fields: string[] = Array.isArray(index.fields)
        ? index.fields.map((f: any) => (typeof f === 'string' ? f : f?.name)).filter(Boolean)
        : [];
      if (fields.length === 0) continue;

      const columns = resolveColumns(collection, fields);
      const unique = !!index.unique;

      // 语义等价判定：列集合一致，且唯一性要求不被削弱
      const hit = existing.get(signature(columns));
      if (hit && (!unique || hit.unique)) {
        result.satisfied += 1;
        continue;
      }

      // hit 存在但不够唯一 → 默认名已被占，改用 _uk 后缀，避免 relation already exists
      const name = buildIndexName(table, columns, hit ? '_uk' : '');
      const existsAlready = hit ? hit.names.includes(name) : false;

      if (!existsAlready) {
        try {
          await queryInterface.addIndex(table, columns, { unique, name });
          result.created += 1;
          result.createdDetail.push(`${table}(${columns.join(', ')})${unique ? ' UNIQUE' : ''}`);

          // 建完立刻登记，避免同批次里重复处理（本插件不会声明重复索引，属于防御）
          const prev = existing.get(signature(columns));
          if (prev) {
            prev.unique = prev.unique || unique;
            prev.names.push(name);
          } else {
            existing.set(signature(columns), { unique, names: [name] });
          }
        } catch (error) {
          result.failures.push(
            `${table}(${columns.join(', ')})${unique ? ' UNIQUE' : ''}：${(error as Error)?.message}`,
          );
        }
      }
    }
  }

  if (logger) {
    const summary = `索引核对：新建 ${result.created} 条 / 已存在 ${result.satisfied} 条`;
    if (result.failures.length > 0) {
      logger.error?.(`[service-ticket] ${summary} / 失败 ${result.failures.length} 条：${result.failures.join('；')}`);
    } else {
      logger.info?.(`[service-ticket] ${summary}`);
    }
  }

  return result;
}
