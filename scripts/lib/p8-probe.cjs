#!/usr/bin/env node
/**
 * p8-probe.cjs —— Phase 8 的**单进程探针**（在 svc-app 容器内运行，由宿主脚本 `docker exec -i` 调用）
 * =============================================================================
 *
 * 为什么不能只在宿主进程里跑
 * --------------------------
 * P8-B 的并发门要检验的是「两个 retry worker 重叠时，同一 SmsLog 最多抢到一次发送资格」。
 * 真实部署里的竞争面是：`cronJobManager` 的 `onTick` **不 await**
 * （见 `sms-retry-scheduler.ts`：`void runSmsRetrySweep(deps)`），
 * 所以两轮 5 分钟 tick 叠在一起时，是**同一个进程内的两个 async 调用**在抢同一个 `SmsService`。
 *
 * 于是：
 *   · 在宿主另起 node 去 `require` 插件 dist —— 拿不到 NocoBase 的连接池，
 *     验的是"另一个程序的另一套东西"；
 *   · 在这里 `docker exec -i` 进容器，`require` **正在运行的那份产物**并用
 *     `app.db` 的真实连接池发 `SMS_CLAIM_SQL` —— 争的才是线上会争的那一行。
 *
 * ⚠️ 本文件**不做**"源码接口对齐"检查。
 *    原因（2026-09-26 实测）：容器产物是 esbuild **打包后的单文件**，
 *    `require(dist/server/index.js)` 只导出 `index.ts` 的具名导出，
 *    `SmsService` / `createTaskRegistry` 不在其中。接口对齐改由**宿主侧源码字面断言**
 *    完成（见 `verify-task-reliability.mjs`）。
 *
 * ⚠️ **请求走 stdin、响应走 stdout，日志一律走 stderr**。
 *    理由：`docker exec -i` 下 stdout 必须是一行可 `JSON.parse` 的内容；
 *    NocoBase `app.load()` 会往 stderr 打日志。Rust 那边正好相反，如果反过来，
 *    宿主脚本要先从几百行日志里捞 JSON —— 那属于把"解析"变成"正则猜谜"。
 *
 * 退出码：0 = 探针自身跑完（**不表示断言通过**，断言在宿主侧判）
 *         3 = 探针类错误（宿主据此报"环境未就绪"而不是"断言失败"）
 *
 * 通道约定（**结论走文件，不走 stdout**）：见 `OUT_PATH` 注释 —— NocoBase 的
 * 结构化日志走 stdout，任何"靠行序取结论"的做法都必然被日志冲掉。
 */
'use strict';

const fs = require('node:fs');

const PLUGIN_ENTRY = '/app/nocobase/node_modules/@local/service-ticket/dist/server/index.js';

/**
 * 结论文档的落盘位置。
 *
 * ⚠️ 由宿主通过 **环境变量 `P8_PROBE_OUT`** 指定，且宿主会：
 *   ① 先在容器里 `rm -f` 它 —— **防止读到上一次运行的陈旧结论**（假绿经典成因：
 *      探针这次崩了没写文件，宿主却读到了上一轮的 ok）；
 *   ② 收工后 `cat` 它再把文件删掉。
 * 缺省值用来兜底，正常路径不该走到。
 */
const OUT_PATH = process.env.P8_PROBE_OUT || '/tmp/p8-conclusion.json';

/**
 * 只写**结论**；stdout 仅出一个一行标记。
 *
 * ⚠️ 为什么不像最初那样 `process.stdout.write` 一行 JSON 就完事（2026-09-26 实测踩到）：
 *    NocoBase 的 Application 把**结构化日志写到 stdout**（不是 stderr！），
 *    一次 `app.load()` 就打 ~50 行 JSON。宿主那侧再"取最后一行当结论"就完全不可靠 ——
 *    `app.destroy()` 的日志还在后面，最后一行永远是 `app has stopped`。
 *    于是宿主收到的是一个日志对象，报错变成"探针失败：undefined"，
 *    排查方向会被带偏到 docker / 网络上去（这次真的被骗了一轮）。
 *
 *    解法：结论写文件，stdout 只出一个 `P8PROBE OK|ERR` 标记（供宿主尽早发现
 *    "探针根本没跑起来"）。与"响应走文件"同一理由：通道不混，就不必靠行序猜。
 */
function writeOut(obj) {
  try {
    fs.writeFileSync(OUT_PATH, `${JSON.stringify(obj)}\n`, 'utf8');
  } catch {
    /* 写不进去（如目录不存在）时下面仍有 stdout 标记 + 退出码，宿主会报"环境未就绪" */
  }
  process.stdout.write(`P8PROBE ${obj.ok ? 'OK' : 'ERR'}\n`);
}

/**
 * 从环境变量拼数据库配置。
 *
 * ⚠️ 为什么不用 `/app/nocobase/config/config.js`：那个文件在官方镜像里**不存在**
 *    （实测 `ls /app/nocobase` 只有 packages/ storage/ node_modules/ …）。
 *    NocoBase 在容器里是**纯 env 驱动**的：`DB_DIALECT/DB_HOST/DB_PORT/DB_DATABASE/DB_USER/DB_PASSWORD`。
 *    所以这里直接读 env，与 `docker-compose.yml` 的 app 服务同源。
 *    （写死 config.js 会得到一个"环境未就绪"的红，而真因是路径假设错了 ——
 *     这类假红会把人往错误方向带。）
 */
function databaseOptionsFromEnv() {
  return {
    dialect: process.env.DB_DIALECT || 'postgres',
    host: process.env.DB_HOST || 'postgres',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_DATABASE || 'service_ticket',
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    logging: false,
  };
}

async function main() {
  const reqPath = process.argv[2];
  if (!reqPath) {
    writeOut({ ok: false, error: '用法：p8-probe.cjs <请求文件>（结论写 P8_PROBE_OUT）' });
    process.exit(3);
  }
  const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
  const expect = req.expect ?? {};

  let database;
  try {
    ({ database } = require('@nocobase/database'));
  } catch (error) {
    writeOut({ ok: false, error: `require('@nocobase/database') 失败：${error?.message}` });
    process.exit(3);
  }
  const { Application } = require('@nocobase/server');

  const app = new Application({
    database: databaseOptionsFromEnv(),
    logger: { level: 'warn' },
  });

  let probe;
  try {
    await app.load();
    probe = require(PLUGIN_ENTRY);
  } catch (error) {
    writeOut({ ok: false, error: `app.load()/require 插件失败：${error?.stack ?? error}` });
    process.exit(3);
  }

  try {
    const sequelize = app.db.sequelize;

    const queryClaim = async (id) => {
      // ⚠️ 用 `bind` 而不是 `replacements` —— 与 `SmsService.rawQuery` 同一约定
      //    （见 `sms-service.ts` 的 `rawQuery`）。用错只会在带引号/类型转换的参数上显形，
      //    这里参数是数字所以两种都能跑，但门禁必须验**线上那一版**调用形状。
      // SQL 取自插件导出的**同一条** `SMS_CLAIM_SQL`，两处各写一份必会漂移。
      const [out] = await sequelize.query(probe.SMS_CLAIM_SQL, {
        bind: [
          id,
          expect.retryLimit ?? 1,
          probe.SMS_SEND_STATUS.PENDING,
          probe.SMS_SEND_STATUS.ERROR,
        ],
      });
      const rows = Array.isArray(out) ? out : (out?.rows ?? []);
      return rows.length === 1;
    };

    const readRow = async (id) => {
      const rows = await sequelize.query(
        'SELECT id::text, retry_count::text, send_status FROM sms_logs WHERE id = $1',
        { bind: [id], type: sequelize.QueryTypes.SELECT },
      );
      return rows?.[0] ?? null;
    };

    const result = {};

    if (expect.mode === 'claim') {
      const before = await readRow(expect.primaryId);
      const ids = expect.seedIds ?? [];

      // 🔴 真并发：同一 tick 里 N 个 worker 同时抢**同一行**
      const workerCount = Number(expect.workerCount ?? 8);
      const claims = await Promise.all(Array.from({ length: workerCount }, () => queryClaim(expect.primaryId)));

      // 并发结束后再抢一次 —— 必须仍是 false（上限已到 / 状态已非 error）
      const afterConcurrent = await queryClaim(expect.primaryId);

      // 第二个（未被发过的）SMS 日志：验证谓词对"已经 pending 的行"也拒绝
      const rowB = await readRow(expect.secondaryId);
      const secondaryClaim = await queryClaim(expect.secondaryId);

      result.primary = { before, claims, afterConcurrent, after: await readRow(expect.primaryId) };
      result.secondary = { row: rowB, claim: secondaryClaim };
      result.rows = [];
      for (const id of ids) result.rows.push(await readRow(id));
      result.sqlText = String(probe.SMS_CLAIM_SQL).replace(/\s+/g, ' ').trim();
      result.claimParamOrder = Array.from(probe.SMS_CLAIM_PARAMS ?? []);
    } else if (expect.mode === 'sla-boundary') {
      const { appointmentOverdueFrom, registerSlaScanJob } = probe;
      if (typeof appointmentOverdueFrom !== 'function') {
        writeOut({ ok: false, error: '期望导出 appointmentOverdueFrom，实际不是函数（插件产物过旧？）' });
        process.exit(3);
      }
      result.boundaries = (expect.cases ?? []).map((c) => ({
        name: c.name,
        expectedAt: c.expectedAt,
        grace: c.grace,
        from: appointmentOverdueFrom(c.expectedAt, c.grace),
      }));
      result.jobRegistrarType = typeof registerSlaScanJob;
    } else if (expect.mode === 'registry') {
      // P8-D：调度器在"没有 cronJobManager"时只 warn、不抛错（可观测性不能成为单点）
      const silent = { info() {}, warn() {}, error() {}, debug() {} };
      const fakeApp = {}; // 刻意没有 cronJobManager
      // ⚠️ 走 `plugin.ts` 导出的 `__p8RegisterProbe`（真实调用三个 register*Job），
      //    而不是 probe 自己 `typeof` 一下导出名 —— 后者证明的是"名字存在"，
      //    不是"坏 app 下返回 null"，而 G1 要的正是后者。
      const reg = probe.__p8RegisterProbe;
      if (!reg) {
        writeOut({ ok: false, error: '插件产物未导出 __p8RegisterProbe（产物过旧或导出被删）' });
        process.exit(3);
      }
      const safe = (fn) => {
        try {
          return { threw: false, value: fn() };
        } catch (error) {
          return { threw: true, error: String(error?.message ?? error) };
        }
      };
      result.degraded = {
        reviewExpiry: safe(() => reg.reviewExpiry(fakeApp, { services: {}, logger: silent })),
        smsRetry: safe(() => reg.smsRetry(fakeApp, { services: {}, logger: silent })),
        slaScan: safe(() => reg.slaScan(fakeApp, { port: {}, logger: silent })),
      };
    } else {
      writeOut({ ok: false, error: `未知 mode: ${expect.mode}` });
      process.exit(3);
    }

    writeOut({ ok: true, result });
    await app.destroy();
    process.exit(0);
  } catch (error) {
    try {
      await app.destroy();
    } catch {
      /* app.load 失败时 destroy 也会失败，忽略 */
    }
    writeOut({ ok: false, error: `探针执行失败：${error?.stack ?? error}` });
    process.exit(3);
  }
}

main().catch((error) => {
  writeOut({ ok: false, error: `未捕获异常：${error?.stack ?? error}` });
  process.exit(3);
});
