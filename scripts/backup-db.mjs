#!/usr/bin/env node
/**
 * backup-db —— 逻辑备份（pg_dump 自定义格式）+ 自描述元数据
 * ===========================================================================
 * 解决什么问题
 * ---------------------------------------------------------------------------
 * Phase 10 / RB-5 要求"能以可恢复的形态发布"。而"有备份脚本"不等于"能恢复"：
 * 一个没人恢复过的备份，其价值等同于零 —— 甚至更差，因为它代理了**虚假的安全感**。
 *
 * ⇒ 本脚本只负责**产出**备份 + 产出一份**可与恢复结果对照的元数据**；
 *    真正证明"能恢复"的是 `scripts/verify-db-restore.mjs`（隔离恢复演练）。
 *    两者必须成对使用：单独跑本脚本**不构成**任何发布证据。
 *
 * 为什么用 `-Fc`（自定义格式）而不是纯 SQL
 * ---------------------------------------------------------------------------
 * ① 支持 `pg_restore --exit-on-error` —— 恢复过程**遇错即停且非零退出**，
 *    这是"堵半恢复假成功"的前提（纯 SQL 走 psql 默认遇错继续，退出码还可能是 0）。
 * ② 自带压缩与 TOC，`pg_restore -l` 可以**在不连数据库的情况下**列出内容 ⇒
 *    损坏检测可以在恢复前先做一次（见 verify-db-restore 的 `--corrupt` 反证）。
 * ③ 支持并行、支持只恢复部分对象（未来按需）。
 *
 * 为什么把 `--no-owner --no-privileges`
 * ---------------------------------------------------------------------------
 * 让 dump 与"恢复到哪个实例、以哪个角色登录"解耦。否则恢复到一个
 * 角色集不同的实例时会因 `ALTER ... OWNER TO` 失败 ⇒ 恢复演练变成
 * "在完全相同的环境里恢复" —— 那就证明不了任何生产场景。
 *
 * 元数据为什么要存**行数 + 唯一索引数 + schema 指纹**
 * ---------------------------------------------------------------------------
 * 因为恢复后要能回答"恢复了多少、恢复全了没有"。
 * 只记文件大小的备份，恢复后无法判断；只记 sha256 只能证明"文件没坏"。
 * ⇒ 这里把"备份那一刻库长什么样"记下来，供 verify-db-restore 逐项对照。
 *
 * 用法
 * ---------------------------------------------------------------------------
 *   node scripts/backup-db.mjs                    # 输出到 backups/
 *   node scripts/backup-db.mjs --out <dir>
 *   node scripts/backup-db.mjs --label pre-p10c   # 文件名带上标签
 *   node scripts/backup-db.mjs --quiet
 *
 * 退出码：0 = 成功；1 = 备份本身失败；2 = 环境错误（容器不在/工具缺失）。
 *
 * ⚠️ 备份产物**永不入库**：`backups/` 已在 `.gitignore:31`。
 *    该目录含真实手机号/姓名（见 B-23），且本身就是"凭证副本"。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');

const ARGS = process.argv.slice(2);
const QUIET = ARGS.includes('--quiet');
const outIdx = ARGS.indexOf('--out');
const labelIdx = ARGS.indexOf('--label');
const OUT_DIR = path.resolve(ROOT, outIdx >= 0 ? ARGS[outIdx + 1] : 'backups');
const LABEL = labelIdx >= 0 ? ARGS[labelIdx + 1] : '';

const PG_CONTAINER = process.env.PG_CONTAINER || 'svc-postgres';

/**
 * 关键行数探针。选表原则：
 *   - 覆盖**框架层**（issuedTokens / users / collections）与**业务层**（service_tickets …）
 *   - 覆盖**追加型审计表**（ticket_events / export_audits / sms_logs）——
 *     这类表最容易在"半恢复"时静默缺失，因为恢复出一张空表也能让应用"看起来正常"
 *
 * 🔴 名字大小写是有意义的：NocoBase 用**带引号**的 camelCase 建表
 *    （`issuedTokens` / `api_guards` 混用），而 PG 对**不带引号**的标识符会折成小写。
 *    实测踩过：`select count(*) from issuedTokens` ⇒ `relation "issuedtokens" does not exist`。
 *    ⇒ 本项目所有对框架表的手写 SQL **必须给标识符加双引号**，否则会静默找不到表。
 */
const COUNT_PROBES = [
  'service_tickets', 'service_visits', 'service_visit_photos', 'ticket_events',
  'sms_logs', 'attachments', 'export_audits', 'store_users',
  'users', 'issuedTokens', 'api_guards', 'daily_sequences', 'idempotency_records',
];

function docker(args, opts = {}) {
  return execFileSync('docker', args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts,
  });
}

function fail(msg, code = 1) {
  console.error(`\n  ❌ ${msg}`);
  process.exit(code);
}

function info(msg) {
  if (!QUIET) console.log(msg);
}

/** 从**容器内**读权威 env —— 比解析 .env 可靠（避免 .env 与运行态漂移） */
function containerEnv() {
  let raw;
  try {
    raw = docker(['exec', PG_CONTAINER, 'printenv', 'POSTGRES_USER', 'POSTGRES_DB']);
  } catch (e) {
    fail(`无法读取容器 ${PG_CONTAINER} 的环境变量：${e.message}\n     容器没起？docker compose up -d postgres`, 2);
  }
  const [user, db] = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!user || !db) fail(`容器 ${PG_CONTAINER} 的 POSTGRES_USER/POSTGRES_DB 为空`, 2);
  return { user, db };
}

function psql(user, db, sql) {
  const raw = docker([
    'exec', PG_CONTAINER, 'psql', '-U', user, '-d', db, '-t', '-A', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', sql,
  ]);
  return raw.split('\n').map((l) => l.trim()).filter(Boolean);
}

function countRows(user, db) {
  // 先确认探针表**按精确大小写**存在：缺表时给出可读诊断，
  // 而不是把 psql 的 'relation does not exist' 糊在脸上（那种报错会让人以为是权限问题）
  const actual = new Set(psql(user, db,
    "select tablename from pg_tables where schemaname='public'"));
  const missing = COUNT_PROBES.filter((t) => !actual.has(t));
  if (missing.length > 0) {
    fail(
      `行数探针表缺失（按精确大小写比对）：${missing.join(', ')}\n` +
      `     现有 public 表 ${actual.size} 张。若刚改过 schema，请同步更新 COUNT_PROBES。\n` +
      '     ⚠️ 不要靠改成小写来"绕过" —— 那只说明探针写错了表名。',
    );
  }
  // 一次查询拿全部行数：比 N 次 count(*) 快，且得到的是**同一快照**下的数字。
  // 标识符加双引号（见 COUNT_PROBES 上方说明）。
  const union = COUNT_PROBES
    .map((t) => `select '${t}' as t, count(*)::bigint as n from "${t}"`)
    .join(' union all ');
  const out = {};
  for (const line of psql(user, db, `select t, n from (${union}) x order by t`)) {
    const [t, n] = line.split('|');
    out[t] = Number(n);
  }
  return out;
}

function schemaFingerprint(user, db) {
  const tables = psql(user, db,
    "select tablename from pg_tables where schemaname='public' order by tablename");
  // 列指纹：table|列数|列名排序后的 sha256 前 16 位 —— 便宜且能发现"少了/多了列"
  const cols = psql(user, db,
    "select table_name, string_agg(column_name, ',' order by column_name) from information_schema.columns " +
    "where table_schema='public' group by table_name order by table_name");
  const colFp = {};
  for (const line of cols) {
    const i = line.indexOf('|');
    const table = line.slice(0, i);
    const joined = line.slice(i + 1);
    colFp[table] = {
      columns: joined.split(',').length,
      sha16: crypto.createHash('sha256').update(joined).digest('hex').slice(0, 16),
    };
  }
  const uniq = psql(user, db,
    "select tablename||' :: '||indexname from pg_indexes where schemaname='public' " +
    "and indexdef like '%UNIQUE%' order by 1");
  return {
    tableCount: tables.length,
    tables,
    columns: colFp,
    uniqueIndexCount: uniq.length,
    uniqueIndexes: uniq,
  };
}

function main() {
  const started = Date.now();
  const { user, db } = containerEnv();

  try {
    docker(['exec', PG_CONTAINER, 'pg_dump', '--version']);
  } catch {
    fail(`容器 ${PG_CONTAINER} 内没有 pg_dump`, 2);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const ts = new Date();
  const stamp = ts.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', 'T');
  const base = `svc-${db}-${stamp}${LABEL ? `-${LABEL}` : ''}`;
  const dumpPath = path.join(OUT_DIR, `${base}.dump`);
  const metaPath = path.join(OUT_DIR, `${base}.dump.meta.json`);

  info('='.repeat(78));
  info(' backup-db —— 逻辑备份（pg_dump -Fc）+ 元数据');
  info('='.repeat(78));
  info(`  容器   ：${PG_CONTAINER}`);
  info(`  目标库 ：${db}（用户 ${user}）`);
  info(`  输出   ：${path.relative(ROOT, dumpPath)}`);
  info(`  开始   ：${ts.toISOString()}`);

  // ---- 备份前快照（与 dump 同一时刻附近；恢复后要能与之一致）----------------
  const countsBefore = countRows(user, db);
  const fpBefore = schemaFingerprint(user, db);
  const totalRows = Object.values(countsBefore).reduce((a, b) => a + b, 0);
  info(`  快照   ：${fpBefore.tableCount} 张表 · ${fpBefore.uniqueIndexCount} 个唯一索引 · 探针 ${totalRows} 行`);

  // ---- pg_dump --------------------------------------------------------------
  // ⚠️ 必须直接把 fd 交给 stdout：dump 是**二进制**自定义格式，
  //    经过字符串解码（encoding:'utf8'）会被破坏。这是最容易踩的坑。
  info('\n  [1/2] pg_dump …');
  const fd = fs.openSync(dumpPath, 'w');
  let dumpErr = null;
  try {
    execFileSync('docker', [
      'exec', PG_CONTAINER, 'pg_dump',
      '-U', user, '-d', db,
      '-Fc',                  // 自定义格式：支持 --exit-on-error / TOC
      '--no-owner',           // 与角色集解耦，恢复到异构实例也能成功
      '--no-privileges',
      '-Z', '6',
    ], { cwd: ROOT, stdio: ['ignore', fd, 'inherit'] });
  } catch (e) {
    dumpErr = e;
  } finally {
    fs.closeSync(fd);
  }

  if (dumpErr) {
    try { fs.unlinkSync(dumpPath); } catch { /* 尽力清理，失败不掩盖主错误 */ }
    fail(`pg_dump 失败：${dumpErr.message}`);
  }

  const stat = fs.statSync(dumpPath);
  if (stat.size === 0) {
    fs.unlinkSync(dumpPath);
    fail('pg_dump 退出码为 0 但产物为 0 字节 —— 拒绝把空文件当成备份');
  }

  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(dumpPath)).digest('hex');

  // ---- TOC 自检：不连数据库就能判断 dump 结构是否完整 ------------------------
  info('  [2/2] 校验 TOC 可读（pg_restore -l）…');
  let tocEntries = 0;
  try {
    const toc = docker(['exec', '-i', PG_CONTAINER, 'pg_restore', '-l'], {
      input: fs.readFileSync(dumpPath),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    tocEntries = toc.split('\n').filter((l) => /^\d+;/.test(l)).length;
  } catch (e) {
    fail(`pg_restore -l 读不出 TOC ⇒ 这份 dump 从生成那一刻就不可用：${e.message}`);
  }
  if (tocEntries === 0) fail('TOC 里 0 个对象 —— dump 结构异常，拒绝报告成功');

  const meta = {
    schemaVersion: 1,
    createdAt: ts.toISOString(),
    durationMs: Date.now() - started,
    container: PG_CONTAINER,
    database: db,
    owner: user,
    dumpFile: path.basename(dumpPath),
    bytes: stat.size,
    sha256,
    format: 'custom (-Fc, -Z6, --no-owner --no-privileges)',
    pgDumpVersion: docker(['exec', PG_CONTAINER, 'pg_dump', '--version']).trim(),
    serverVersion: psql(user, db, 'show server_version')[0],
    tocEntries,
    tableCount: fpBefore.tableCount,
    uniqueIndexCount: fpBefore.uniqueIndexCount,
    columns: fpBefore.columns,
    rowCounts: countsBefore,
    rowCountsProbed: COUNT_PROBES,
    probeTotalRows: totalRows,
    gitRev: (() => {
      // ⚠️ 这里必须调 `git`，不是 `docker` —— 曾经写成 docker 而静默拿到 null
      try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
      } catch { return null; }
    })(),
    note: '本文件含行数/结构指纹，不含业务数据。恢复演练见 scripts/verify-db-restore.mjs。',
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  info('');
  info('  ✅ 备份完成');
  info(`     dump  ：${path.relative(ROOT, dumpPath)}  (${(stat.size / 1024).toFixed(1)} KiB)`);
  info(`     sha256：${sha256.slice(0, 16)}…（全长见 meta）`);
  info(`     TOC   ：${tocEntries} 个对象 · ${fpBefore.tableCount} 张表 · ${fpBefore.uniqueIndexCount} 个唯一索引`);
  info(`     探针  ：${totalRows} 行（${COUNT_PROBES.length} 张表）`);
  info(`     meta  ：${path.relative(ROOT, metaPath)}`);
  info(`     耗时  ：${((Date.now() - started) / 1000).toFixed(1)}s`);
  info('');
  info('  ⚠️ 这不是发布证据。"能恢复"只能由 verify-db-restore.mjs 的隔离演练证明。');

  // 供 verify-db-restore 复用的机器可读输出（最后一行）
  console.log(`BACKUP_RESULT=${JSON.stringify({ dumpPath, metaPath, bytes: stat.size, sha256 })}`);
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`\n  ❌ backup-db 执行失败：${e && e.message ? e.message : e}`);
  process.exit(1);
}
