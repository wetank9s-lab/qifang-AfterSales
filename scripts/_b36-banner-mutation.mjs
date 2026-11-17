/**
 * _b36-banner-mutation.mjs —— B-36 Banner 的**变异测试**（证明探针真的会红）
 *
 * =============================================================================
 * 为什么必须有这个脚本（`docs/ENGINEERING-RULES.md` 铁律 ① / ⑤）
 * =============================================================================
 * `_b36-banner-e2e.mjs` 报了全绿 —— 但"全绿"有两种可能：
 *   ① 产品真的守住了；② 那些断言**根本没有观测能力**（判据写错了字段、写宽了）。
 * 不区分这两者，"全绿"就只是一句话。本项目为这个已付过多次代价：
 *   · `/customer_/` 判据撞上**合法**枚举值 `customer_absent` ⇒ 假红；
 *   · "公共目录里有没有图片"撞上后台 logo PNG ⇒ 假绿；
 *   · 同一个解析逻辑在脚本里复算一遍 ⇒ 脚本复算的与服务端实际做的分叉，照样绿。
 *
 * ⇒ 手法：**数据层变异**（**不改产品源码**）。
 *   直接用 SQL 往 `store_banners` 插"脏行"，每行**故意违反一个过滤维度**，
 *   然后走**真实客户端接口**（`/api/public/store-entry`）看产品会不会把它选出来。
 *
 *   · 产品正确 ⇒ 脏行**不被选中**（e2e 的关键断言仍应绿）；
 *   · 某个维度在产品里失效 ⇒ 脏行**被选中** ⇒ 本脚本判**变异逃逸**（exit 1）。
 *
 * 逐维度对照（`services/banner-service.ts` 的 `pickBannerForStore` 有四个过滤条件）：
 * | 变异 | 插入的脏行 | 若产品漏了这个条件 … |
 * |---|---|---|
 * | M1 | `status='DRAFT'` 且 `published_at` **最新** | 草稿会被客户看到（未发布就上线） |
 * | M2 | `status='PUBLISHED'` 但 `revoked_at` 有值且**最新** | **已下架的图仍在服务**（最严重） |
 * | M3 | `enabled=false` 且**最新** | 被停用的图仍在服务 |
 * | M4 | 属于**另一家门店**且**最新** | 门店串图（看到别家的 Banner） |
 * | M5 | 总部通用但 `revoked_at` 有值，且门店无自有 | 总部下架后门店仍看到旧图 |
 *
 * ⚠️ 另有两条**观测力自证**（不插脏行，而是证"探针看得见变化"）：
 *   · S1：把一张**合法已发布**的行插进去 ⇒ 客户端**必须**能看到它。
 *        若这一步失败，说明本脚本的观测链路本身是断的 —— 那么 M1~M5 的"没被选中"
 *        就毫无意义（"看不见任何东西"当然也"看不见脏行"）。**这是变异测试的假绿入口。**
 *
 * ⚠️ 本脚本**只做数据层注入**：不改产品代码、不改 nginx、不写别的门店的行。
 *    自己造的行用 `request_id` 前缀标记，结束时精确删除并**独立复核**清空。
 *
 * 用法：`node scripts/_b36-banner-mutation.mjs`
 *   退出码：0 = 全部变异被拦住（产品正确且探针有观测力）；
 *          1 = **有变异逃逸**；2 = 环境未就绪（观测力自证失败 / 限流 / 清理不干净）。
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  FIX, createRateLimitGate, fingerprintOf, loadSignStoreEntry,
  psql, purgeBanners, readEnv, sha16, sqlStr,
} from './_b36-lib.mjs';

const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const env = readEnv();
const STORE_A = 1; // 新都圣大家电 —— 客户侧要"看不到脏行"的那家
const STORE_B = 4; // 金堂华林电器 —— M4 的"别家"
/** 本脚本造的行都带这个前缀，便于**精确**清理（绝不动别人的行） */
const MARK = 'mutation-b36';

const gate = createRateLimitGate();

// ---------------------------------------------------------------------------
// 造一张"具有辨识度"的合法 PNG，保证它的指纹与既有素材都不同
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** 与 `_b36-make-fixtures.mjs` 同一套编码（此处 seed 取一个不冲突的值） */
function makePng(width, height, seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const o = rowStart + 1 + x * 3;
      const band = Math.floor((x * 3 + seed * 53) / width);
      const stripe = (x + y + seed * 13) % 19 === 0 ? 60 : 0;
      raw[o] = (band === 0 ? 15 : band === 1 ? 240 : 120) + stripe;
      raw[o + 1] = (band === 0 ? 200 : band === 1 ? 20 : 90) + stripe;
      raw[o + 2] = (band === 0 ? 80 : band === 1 ? 200 : 40) + stripe;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 走真实客户端那条路（与 H5 完全一致） */
async function storeEntryBanner(entryValue) {
  const res = await fetch(`${BASE}/api/public/store-entry?k=${encodeURIComponent(entryValue)}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  gate.note(res.status, text);
  return { status: res.status, json, banner: json?.data?.banner ?? null };
}

/**
 * 插一行**脏行**（绕过产品写入路径，直插数据库）。
 *
 * ⚠️ 为什么要直插而不是调接口：接口**本来就**不允许造出这些状态
 *    （比如"已发布但 revoked_at 有值"在接口上不可达）。
 *    变异测试要问的正是"**如果**库里出现了这种行，客户侧会不会看到它"——
 *    因为真实事故里脏数据的来源从来不是接口，而是手工 SQL、旧版本残留、导入。
 */
function insertDirty(opts) {
  const {
    storeId = null, fileName, contentHash, mime = 'image/png', w = 1280, h = 360,
    status, enabled = true, publishedAt = null, revokedAt = null, tag,
  } = opts;
  // ⚠️ `created_at` / `updated_at` 是 NocoBase 给每张表的通用列，**NOT NULL 且无默认值**
  //    （由 ORM 层负责写入，不走 DB default）⇒ 直插必须自己补上，
  //    否则报 `null value in column "created_at" violates not-null constraint`。
  const sql = `insert into store_banners
    (store_id, file_name, storage_key, mime, byte_size, width, height, content_hash,
     status, enabled, alt_text, uploaded_at, published_at, revoked_at, request_id,
     created_at, updated_at)
  values (${storeId === null ? 'null' : storeId}, ${sqlStr(fileName)}, ${sqlStr('mut/' + fileName)},
     ${sqlStr(mime)}, 4096, ${w}, ${h}, ${sqlStr(contentHash)}, ${sqlStr(status)}, ${enabled},
     ${sqlStr(tag)}, now(), ${publishedAt ? sqlStr(publishedAt) : 'null'},
     ${revokedAt ? sqlStr(revokedAt) : 'null'}, ${sqlStr(`${MARK}-${tag}`)}, now(), now())
  returning id;`;
  return Number(psql(sql));
}

/** 把文件真正写进公开目录（这样"被选中"时至少 URL 是可达的，避免把 404 误读成"没选中"） */
function writeBannerFile(fileName, buf) {
  const dir = path.resolve('storage/uploads-banner');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), buf);
}

function cleanupMutations() {
  // 精确按 request_id 前缀删除（绝不动别人的行）
  const files = psql(`select file_name from store_banners where request_id like ${sqlStr(MARK + '%')};`)
    .split('\n').map((s) => s.trim()).filter(Boolean);
  psql(`delete from store_banners where request_id like ${sqlStr(MARK + '%')};`);
  for (const f of files) {
    try { fs.unlinkSync(path.resolve('storage/uploads-banner', f)); } catch { /* 忽略 */ }
  }
  const left = Number(psql(`select count(*) from store_banners where request_id like ${sqlStr(MARK + '%')};`) || '0');
  console.log(`  · 清理变异行：删 ${files.length} 个文件，复核剩余 ${left} 行`);
  return left === 0;
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('\n════════ B-36 Banner 变异测试（证明断言会红） ════════');

  console.log('\n── 前置：临时调大两道限流闸（跑完自动还原） ──');
  gate.raise();
  console.log(`  · 等 ${11_500} ms 让配置缓存过期 …`);
  await new Promise((r) => setTimeout(r, 11_500));

  if (!fs.existsSync(path.join(FIX, 'banner-a.png'))) {
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, [path.join(process.cwd(), 'scripts/_b36-make-fixtures.mjs')], { stdio: 'inherit' });
  }

  // 前置：把会碰的门店清空（含总部通用）—— 变异必须在一个**干净基线**上做
  console.log('\n── 前置：清空会碰的门店（含总部通用），建立干净基线 ──');
  if (!purgeBanners([STORE_A, STORE_B], '前置')) {
    throw new Error('前置清理后仍有残留行 —— 环境未就绪');
  }

  const SIGN = loadSignStoreEntry();
  const entryA = SIGN('S01', env.SIGN_SECRET);
  const entryB = SIGN('S04', env.SIGN_SECRET);

  // 造两张专用图（指纹与既有素材都不冲突）
  const bufDirty = makePng(1280, 360, 4242);
  const bufValid = makePng(1280, 360, 8484);
  const fpDirty = sha16(bufDirty);
  const fpValid = sha16(bufValid);
  const nameDirty = `banner-${fpDirty}.png`;
  const nameValid = `banner-${fpValid}.png`;
  console.log(`  · 变异图指纹 ${fpDirty} / 合法图指纹 ${fpValid}`);

  // =========================================================================
  // S1 · 观测力自证（**先证"看得见"，再谈"看不见是被拦住的"**）
  // =========================================================================
  console.log('\n── S1. 观测力自证：一张合法已发布的行，客户端**必须**看得到 ──');
  purgeBanners([STORE_A, STORE_B], 'S1 前');
  writeBannerFile(nameValid, bufValid);
  insertDirty({
    storeId: STORE_A, fileName: nameValid, contentHash: fpValid,
    status: 'PUBLISHED', publishedAt: new Date().toISOString(), tag: 'valid',
  });
  {
    const seen = await storeEntryBanner(entryA);
    const got = fingerprintOf(seen.banner);
    const ok = seen.status === 200 && got === fpValid;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  合法已发布行可见（观测链路通）  [seen=${got} expected=${fpValid}]`);
    if (!ok) {
      console.error('\n  ⛔ 观测力自证失败 —— 客户侧看不到一张**确实已发布**的图。');
      console.error('     此时下面所有"脏行没被选中"的结论**都不可信**（可能只是链路断了）。');
      console.error('     按纪律：这是【工具坏了】，不是产品结论。exit 2。');
      cleanupMutations();
      process.exit(2);
    }
  }

  // =========================================================================
  // M1~M5 · 逐维度变异
  // =========================================================================
  const rows = [];
  {
    // 每个维度都用同一张脏图，但排它到**最新**（published_at 最大），
    // 这样"是否被选中"只取决于那一个过滤条件，而不是时间先后。
    const newest = new Date(Date.now() + 3600_000).toISOString(); // 未来 1 小时 = 一定最新
    const spec = [
      ['M1', 'DRAFT（未发布）且最新', { status: 'DRAFT', publishedAt: newest, revokedAt: null }],
      ['M2', 'PUBLISHED 但 revoked_at 有值且最新', { status: 'PUBLISHED', publishedAt: newest, revokedAt: newest }],
      ['M3', 'enabled=false 且最新', { status: 'PUBLISHED', enabled: false, publishedAt: newest, revokedAt: null }],
      ['M5', '总部通用但已下架，且该店无自有', { storeIdNull: true, status: 'PUBLISHED', publishedAt: newest, revokedAt: newest }],
    ];
    writeBannerFile(nameDirty, bufDirty);
    for (const [id, label, o] of spec) {
      const row = {
        id, label,
        sql: {
          storeId: o.storeIdNull ? null : STORE_A,
          fileName: nameDirty, contentHash: fpDirty,
          status: o.status, enabled: o.enabled !== false,
          publishedAt: o.publishedAt, revokedAt: o.revokedAt, tag: id,
        },
      };
      rows.push(row);
    }
  }

  console.log('\n── M1~M5. 逐维度变异：脏行**都不该**被客户看到 ──');
  let escaped = 0;
  for (const row of rows) {
    // 每个变异独立跑：先清空，只留这一条脏行 ⇒ 若它被选中，说明就是它漏过去的
    purgeBanners([STORE_A, STORE_B], `${row.id} 前`);
    writeBannerFile(nameDirty, bufDirty);
    row.dbId = insertDirty(row.sql);
    const seen = await storeEntryBanner(entryA);
    const got = fingerprintOf(seen.banner);
    // 判据：**返回的指纹不能是脏图**（可以是 null，也可以是别人）
    const passed = got !== fpDirty;
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${row.id} ${row.label} 脏行未被选中  [seen=${got} dirty=${fpDirty}]`);
    if (!passed) escaped += 1;
  }

  // M4 单独做：它要的是"**另一家门店**的自有 Banner 不能被门店 1 看到"，
  // 所以对 STORE_B 插入，然后问 STORE_A。这条与门店 1 自己的配置无关。
  {
    purgeBanners([STORE_A, STORE_B], 'M4 前');
    writeBannerFile(nameDirty, bufDirty);
    insertDirty({
      storeId: STORE_B, fileName: nameDirty, contentHash: fpDirty,
      status: 'PUBLISHED', publishedAt: new Date(Date.now() + 3600_000).toISOString(), tag: 'M4',
    });
    const seenA = await storeEntryBanner(entryA);
    const got = fingerprintOf(seenA.banner);
    const passed = got !== fpDirty;
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  M4 属于门店 4 的 Banner 不会被门店 1 看到  [seen=${got} dirty=${fpDirty}]`);
    if (!passed) escaped += 1;
    // 反向对照：同一张脏行对**门店 4 自己**应当是可见的 ——
    // 否则"M4 没被看到"可能只是因为这张图根本读不出来（又一次假绿）。
    const seenB = await storeEntryBanner(entryB);
    const gotB = fingerprintOf(seenB.banner);
    const ctrl = gotB === fpDirty;
    console.log(`  ${ctrl ? 'PASS' : 'FAIL'}  M4 对照：同一行对**门店 4 自己**确实可见（证明它不是"读不出来"）  [seenB=${gotB}]`);
    if (!ctrl) escaped += 1;
  }

  // ---- 清理 ----
  console.log('\n── 清理 ──');
  const cleaned = cleanupMutations();
  const base = purgeBanners([STORE_A, STORE_B], '收尾');

  console.log('\n════════════════════════════════════════════════');
  if (gate.state.sawRateLimit) {
    console.log('  ⚠️ 本轮出现过 429 ⇒ 判【环境未就绪】，不给产品结论。exit 2');
    process.exit(2);
  }
  if (!cleaned || !base) {
    console.log('  ⚠️ 清理未复核通过 ⇒ 环境未就绪（会污染下一轮）。exit 2');
    process.exit(2);
  }
  if (escaped) {
    console.log(`  ❌ 有 ${escaped} 项**变异逃逸** —— 说明探针的观测力不足，或产品真的有洞。`);
    console.log('     两者都要查：先看那一行的过滤条件是否真被写了。exit 1');
    process.exit(1);
  }
  console.log('  ✅ 全部变异被拦住：探针有观测力，且产品的四个过滤维度都真的在生效。');
  console.log('     （M1 status / M2 revoked_at / M3 enabled / M4 store_id / M5 总部 revoked_at）');
  process.exit(0);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  try { cleanupMutations(); } catch { /* 尽力而为 */ }
  process.exit(2);
});
