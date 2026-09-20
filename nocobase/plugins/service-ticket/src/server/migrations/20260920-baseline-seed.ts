/**
 * 迁移：基线数据补种（参数 / 门店 / 角色）。
 *
 * 为什么需要这个迁移 —— 三个触发路径里缺的那一个：
 *   NocoBase 的 PluginManager.upgrade()（每次 `nocobase start` 都会跑，日志里的
 *   "run upgrade"）对已安装插件**不再调用 install()**：
 *       if (!plugin.isPreset && !plugin.installed) { await plugin.install(); }
 *   于是出现这种情况：插件在上一版就装好了（installed=true），这一版才新增种子，
 *   那么重启容器 / 重新部署都不会补种 —— /api/svc:health 里
 *   rolesSeeded / storesSeeded 恒为 0，验收项 AT-03（门店隔离）因为没有第二家门店
 *   而**恒真**（等于没测）。迁移由 umzug 记录在 `migrations` 表，天生满足
 *   "在既有实例上只执行一次"，正是这里需要的东西。
 *
 * 位置为什么是 dist/server/migrations：
 *   Plugin.loadMigrations() 读的是 resolve(getPluginBasePath(pkg), 'server/migrations')，
 *   而 getPluginBasePath() = dirname(dirname(require.resolve(pkg)))，对
 *   main = ./dist/server/index.js 的包而言就是 `<包根>/dist`。
 *   所以产物必须落在 `<包根>/dist/server/migrations/`（与官方 plugin-acl 一致）。
 *
 * ⚠️ 本文件会被 esbuild **单独打包**（entry 之一），因此 `../seeds/apply` 的代码
 *    会被内联进这个产物，和 dist/server/index.js 里那一份是同一份源码编译出来的
 *    两个副本。这是刻意的：迁移产物必须能独立 require，不能依赖插件的相对路径
 *    （dist 内部没有独立的 seeds/*.js 文件）。两份数据常量不会漂移 —— 同源同次构建。
 *
 * 失败语义：**抛出**，不吞错。
 *   一个被 umzug 记为"已完成"的迁移如果静默失败，基线数据将永远不会补上，
 *   而且不会有第二次机会。宁可让部署在这一步失败并被人看到。
 *   （对比：plugin.ts 的 install()/afterEnable() 路径吞错并记 healthState.lastError，
 *    那是"每次启动都还会再试一次"的场景，策略不同是有意的。）
 */
import { Migration } from '@nocobase/database';

import { applyBaselineSeeds } from '../seeds/apply';

export default class extends Migration {
  /** 表已建好、插件已加载完毕之后执行（默认值，写出来是为了明确） */
  on = 'afterLoad';

  async up(): Promise<void> {
    const app: any = (this as any).context?.app;
    const db: any = (this as any).context?.db ?? (this as any).db;
    const logger = {
      info: (m: string) => app?.log?.info?.(m),
      warn: (m: string) => app?.log?.warn?.(m),
      error: (m: string) => app?.log?.error?.(m),
    };

    if (!db || typeof db.getRepository !== 'function') {
      throw new Error('[service-ticket/migration] 无法取得 db（迁移上下文不完整），基线数据未写入');
    }

    try {
      const result = await applyBaselineSeeds({
        db,
        app,
        logger,
        operator: 'migration:20260920-baseline-seed',
      });

      logger.info(
        `[service-ticket] 基线数据迁移完成：参数 +${result.settings.created}，` +
          `门店 +${result.stores.created}，角色 +${result.roles.created}` +
          `（已有则跳过；数据源 ${result.dataSourceKey}）`,
      );
    } catch (error) {
      throw new Error(
        `[service-ticket/migration] 基线数据写入失败：${(error as Error)?.message}。` +
          '该迁移已被记录为执行过，若要让其重跑，需从 migrations 表删除对应记录',
      );
    }
  }
}
