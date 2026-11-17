/**
 * _b36-banner-e2e.mjs —— B-36 端到端验证（**接口层**）
 *
 * 覆盖用户 §五 要求的三个真实场景（浏览器侧另由浏览器探针取证）：
 *   ① 后台上传并发布后，客户侧能读到图片（HTTP 200 + 正确 Content-Type + 字节一致）；
 *   ② 切换门店时，只显示"该门店的 Banner"或"总部通用"（不会串到别家）；
 *   ③ 下架后客户端读不到，**且原有客户私有附件仍不可匿名读取**。
 *
 * 另含**反向用例**（缺了它们，"PASS"就只是"没试出错"）：
 *   · SVG / 伪装成 jpg 的 HTML / 过小图 / 超大尺寸 ⇒ 必须被拒（415/422）
 *   · DRAFT（未发布）⇒ 公开面必须读不到
 *   · 非法文件名形态（路径穿越、任意名）⇒ 必须 404，且**不构成存在性探测**：
 *     存在但未发布 与 完全不存在 必须回**同一个响应**
 *   · 无权限角色（viewer）上传 ⇒ 403；跨店角色操作他店 Banner ⇒ 403
 *   · 客户私有附件（publicMedia:file）在**无凭证**下仍必须被拒 —— 回归"隔离未被破坏"
 *
 * =============================================================================
 * 🔴 关于场景 ② 的判据形态（这是本探针第 2 版最重要的改动）
 * =============================================================================
 * 第 1 版在脚本里用 **SQL 重写**了一遍"门店优先 → 总部回退"的选择逻辑
 * （`select coalesce((select ... store_id=1 ...), (select ... store_id is null ...))`）
 * 再拿结果去比。这是**错的**，而且是本仓库反复付过代价的那一类错：
 *
 *   · `docs/ENGINEERING-RULES.md` 铁律 ④：**同一段解析逻辑出现两次 = 同一个坑有两条腿**。
 *     脚本复算的是"我以为服务端会怎么选"，而客户看到的是"服务端**实际**选了什么"。
 *     两者一旦分叉（比如服务端排序键加了 `-id`，脚本没加），脚本会**照样全绿**。
 *   · 更直接的问题：SQL 复算版**根本测不到** `publicStore:entry` 有没有把 Banner 带上。
 *
 * ⇒ 现版一律**打真实客户端接口**：`GET /api/public/store-entry?k=<签名入口>`，
 *   与 H5 完全同一条路（签名 → 门店解析 → 选图 → 投影）。脚本只做两件事：
 *   ① 用**产品自己的** `signStoreEntry` 签入口（不再抄一遍 HMAC，见 `_b36-lib.mjs`）；
 *   ② 断言接口**返回的 URL** 是不是该显示的那一张。
 *
 * =============================================================================
 * 🔴 关于限流：两道独立的闸，跑前临时调大、跑完还原
 * =============================================================================
 * 本探针要打几十次匿名读，撞在两道**相互独立**的闸上：
 *   ① nginx：`svc_public` = `rate=30r/m burst=10 nodelay`（漏桶：连放 11 次，之后每 2s 回填 1）
 *   ② 应用：`security.ip_minute_limit` = 30/分钟（落 `api_guards` 表）
 * 两道任一被打满，**所有断言都会拿到 429** —— 屏幕读起来像"产品全线崩溃"，
 * 而产品其实一条都没错（`docs/DEVIATIONS.md` 里这个坑吃过不止一次）。
 * 既有约定见 `_b36-lib.mjs` 的 `createRateLimitGate()`：只调 burst、绝不动 `rate`，
 * 跑完必须还原，真撞 429 就按"**环境未就绪**"报（exit 2），**不给产品结论**。
 *
 * 纪律：本脚本**会写数据**（`store_banners` 行 + 独立公开目录的文件），
 *       跑前清掉自己会碰的那几家店的既有 Banner，跑完再清一遍并**独立复核**。
 *
 * 用法：`node scripts/_b36-banner-e2e.mjs`
 *   退出码：0 = 全绿；1 = 有产品级红灯；2 = 环境未就绪（脚本/限流/前置清理失败）
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  APP_DIRECT, FIX, ROOT,
  createRateLimitGate, fingerprintOf, loadSignStoreEntry, makeApi, psql,
  purgeBanners, readEnv, sha16, signIn, uuid,
} from './_b36-lib.mjs';

const BASE = process.env.SVC_BASE_URL || 'https://127.0.0.1';
const env = readEnv();

const results = [];
const ck = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`);
};

const gate = createRateLimitGate();
const api = makeApi(BASE, gate.note);

// ---------------------------------------------------------------------------
// HTTP 工具（本脚本特有的几个）
// ---------------------------------------------------------------------------
/** 上传：真 multipart（**不是** JSON），与服务端 koaMulter 读法对应 */
async function uploadBanner(token, filePath, storeId, altText) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('banner', new Blob([buf]), path.basename(filePath));
  const qs = new URLSearchParams();
  if (storeId !== null && storeId !== undefined) qs.set('store_id', String(storeId));
  if (altText) qs.set('alt_text', altText);
  const q = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetch(`${BASE}/api/svc:bannerUpload${q}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Request-Id': uuid() },
    body: form,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  gate.note(res.status, text);
  return { status: res.status, json, text };
}

/**
 * 发布 / 下架。
 *
 * ⚠️ **必须带 `X-Request-Id`（合法 UUID v4）**：服务端的 `requireRequestId` 会
 *    先校验它，不合法直接 422 且**不进业务** ⇒ 响应里没有 `data`，
 *    断言读到的就是 `replayed=undefined`（第 1 版在这里自造了一个假红）。
 */
const publish = (token, id) => api(token, '/api/svc:bannerPublish', {
  method: 'POST', json: { banner_id: id }, headers: { 'X-Request-Id': uuid() },
});
const revoke = (token, id) => api(token, '/api/svc:bannerRevoke', {
  method: 'POST', json: { banner_id: id }, headers: { 'X-Request-Id': uuid() },
});

/** 公开读一张 Banner 的原始字节 */
async function fetchPublicBanner(fileName) {
  const res = await fetch(`${BASE}/api/public/banner/${encodeURIComponent(fileName)}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  const text = isJson ? bytes.toString('utf8') : '';
  gate.note(res.status, text);
  return {
    status: res.status,
    bytes,
    text,
    contentType: res.headers.get('content-type'),
    cacheControl: res.headers.get('cache-control'),
    nosniff: res.headers.get('x-content-type-options'),
  };
}

/** 走**真实客户端那条路**取某门店当前应显示的 Banner（与 H5 完全一致） */
async function storeEntryBanner(entryValue) {
  const res = await fetch(`${BASE}/api/public/store-entry?k=${encodeURIComponent(entryValue)}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  gate.note(res.status, text);
  return { status: res.status, json, banner: json?.data?.banner ?? null };
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('\n════════════ B-36 Banner 端到端验证 ════════════');

  // ---- 限流闸门：跑前临时调大（两道闸都要），跑完由 process.on('exit') 还原 ----
  console.log('\n── 前置：临时调大两道限流闸（跑完自动还原） ──');
  gate.raise();
  console.log('  · nginx svc_public burst 与 security.ip_minute_limit 已临时调大');
  // 应用侧 ConfigService 有 TTL 缓存 ⇒ 必须等它过期，否则读到旧值（假绿/假红都可能）
  console.log(`  · 等 ${11_500} ms 让配置缓存过期 …`);
  await new Promise((r) => setTimeout(r, 11_500));

  if (!fs.existsSync(path.join(FIX, 'banner-a.png'))) {
    console.log('  · 素材缺失，先生成 …');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/_b36-make-fixtures.mjs')], { stdio: 'inherit' });
  }
  const FP_A = sha16(fs.readFileSync(path.join(FIX, 'banner-a.png')));
  const FP_B = sha16(fs.readFileSync(path.join(FIX, 'banner-b.png')));
  console.log(`  · 素材指纹：A=${FP_A}  B=${FP_B}（两者必须不同）`);

  // ---- 账号 ----
  const admin = await signIn(BASE, 'uat.hqadmin@svc.local', env.UAT_HQADMIN_PASSWORD);
  const storeA = await signIn(BASE, 'uat.store.a@svc.local', env.UAT_STORE_A_PASSWORD);
  const storeB = await signIn(BASE, 'uat.store.b@svc.local', env.UAT_STORE_B_PASSWORD);
  const viewer = await signIn(BASE, 'uat.viewer@svc.local', env.UAT_VIEWER_PASSWORD);
  console.log('  账号就绪：hqadmin / store_a / store_b / viewer');

  // 门店 1 = 新都圣大家电（store_a 授权）；门店 4 = 金堂华林电器（store_b 授权）
  const STORE_A = 1;
  const STORE_B = 4;
  const SIGN = loadSignStoreEntry();
  const entryA = SIGN('S01', env.SIGN_SECRET);
  const entryB = SIGN('S04', env.SIGN_SECRET);
  const entryG = SIGN('S11', env.SIGN_SECRET); // 第三家：用来验"谁都没配 ⇒ null"

  // ---- ① 前置清理（否则上一轮的残留会让"上传后应为 DRAFT"变假红） ----
  console.log('\n── 前置：清空本脚本会碰的门店 Banner（含总部通用） ──');
  if (!purgeBanners([STORE_A, STORE_B], '前置')) {
    throw new Error('前置清理后仍有残留行 —— 环境未就绪');
  }

  // =====================================================================
  // A. 上传侧的形态拒绝（反向用例）
  // =====================================================================
  console.log('\n── A. 上传侧的形态拒绝（反向用例） ──');
  for (const [file, label, expectStatus] of [
    ['active.svg', 'SVG（可内嵌 script）必须被拒', 415],
    ['fake.jpg', '伪装成 .jpg 的 HTML 必须被拒（只看 magic bytes）', 415],
    ['tiny.png', '过小图（64×32）必须被拒', 422],
    ['huge.png', '超尺寸图（5000×100）必须被拒', 422],
  ]) {
    const r = await uploadBanner(admin, path.join(FIX, file), STORE_A, 'x');
    ck(r.status === expectStatus, label, `status=${r.status} code=${r.json?.errors?.[0]?.code ?? '-'}`);
  }

  // =====================================================================
  // B. 授权边界（反向用例）
  // =====================================================================
  console.log('\n── B. 授权边界（反向用例） ──');
  {
    const r = await uploadBanner(viewer, path.join(FIX, 'banner-a.png'), STORE_A, 'viewer 不该能传');
    ck(r.status === 403, 'viewer（无写工单能力）上传 ⇒ 403', `status=${r.status} code=${r.json?.errors?.[0]?.code ?? '-'}`);
  }
  {
    const r = await uploadBanner(storeB, path.join(FIX, 'banner-a.png'), STORE_A, '跨店');
    ck(r.status === 403, 'store_b 给非授权门店（id=1）上传 ⇒ 403', `status=${r.status} code=${r.json?.errors?.[0]?.code ?? '-'}`);
  }
  {
    const r = await uploadBanner(storeA, path.join(FIX, 'banner-a.png'), null, '门店角色建通用');
    ck(r.status === 403, '门店角色创建「总部通用」Banner ⇒ 403（只有 hq_admin）', `status=${r.status} code=${r.json?.errors?.[0]?.code ?? '-'}`);
  }
  {
    const r = await api(viewer, '/api/svc:bannerList');
    ck(r.status === 403, 'viewer 读取 Banner 列表 ⇒ 403', `status=${r.status}`);
  }

  // =====================================================================
  // 场景 ①：上传 + 发布 ⇒ 客户侧可读
  // =====================================================================
  console.log('\n── 场景 ①：后台上传并发布后，客户侧可读到图片 ──');
  const upA = await uploadBanner(admin, path.join(FIX, 'banner-a.png'), STORE_A, '门店A横幅');
  ck(upA.status === 200, '门店A Banner 上传成功', `status=${upA.status}`);
  const idA = Number(upA.json?.data?.id);
  const nameA = String(upA.json?.data?.file_name ?? '');
  ck(/^banner-[0-9a-f]{16}\.png$/.test(nameA), '文件名 = 内容指纹（banner-<sha16>.png）', `got="${nameA}"`);
  ck(nameA === `banner-${FP_A}.png`, '文件名指纹 == 本地算出的 sha256 前 16 位', `got=${nameA}`);
  ck(String(upA.json?.data?.status) === 'DRAFT', '上传后状态为 DRAFT（未发布）', `status=${upA.json?.data?.status}`);

  // 未发布 ⇒ 公开面必须读不到（**这是"发布"这件事有意义的证明**）
  {
    const pub = await fetchPublicBanner(nameA);
    ck(pub.status === 404, 'DRAFT 未发布 ⇒ 公开面 404（不是"上传即生效"）', `status=${pub.status}`);
  }
  // ⚠️ 上面那条只证了「**文件**读不到」。需求原文要的是
  //    「未发布的 Banner **不再出现在客户端配置结果中**」—— 那是**选图**这一步的事，
  //    与文件读取是**两条不同的路径**（`pickBannerForStore` vs `findPublicBannerByFileName`）。
  //    只测前者的话，"选图时忘了判 status"这个洞会完全漏过（源码级变异 V1 实测抓到了这个缺口）。
  {
    const seen = await storeEntryBanner(entryA);
    ck(seen.banner === null, 'DRAFT 未发布 ⇒ **客户端配置结果里也没有它**（选图那一步就排除）',
      `banner=${JSON.stringify(seen.banner)}`);
  }

  const pubA = await publish(admin, idA);
  ck(pubA.status === 200, '发布成功', `status=${pubA.status} → ${pubA.json?.data?.status}`);

  {
    const pub = await fetchPublicBanner(nameA);
    const expected = fs.readFileSync(path.join(FIX, 'banner-a.png'));
    ck(pub.status === 200, '发布后客户侧 GET 200', `status=${pub.status}`);
    ck(pub.contentType === 'image/png', 'Content-Type 正确（image/png）', `got=${pub.contentType}`);
    ck(pub.bytes.equals(expected), '**取回的字节与原图逐字节一致**', `len=${pub.bytes.length}`);
    ck(String(pub.cacheControl ?? '').includes('public'), '缓存头是 public（与客户附件的 no-store 相反）', `got=${pub.cacheControl}`);
    ck(String(pub.cacheControl ?? '').includes('immutable'), '缓存头含 immutable', `got=${pub.cacheControl}`);
    // ⚠️ 用 includes 而不是全等：nginx 的 server 级 `add_header ... always` 与
    //    handler 各写一次，最终是 `nosniff, nosniff`。**重复不代表失效**，
    //    判据应落在"这个头存在且值为 nosniff"上（比全等更贴近真正要守的性质）。
    ck(String(pub.nosniff ?? '').split(',').map((s) => s.trim()).includes('nosniff'),
      '响应带 X-Content-Type-Options: nosniff', `got=${pub.nosniff}`);
  }

  // 幂等：同一张图再传一次 ⇒ 复用同一行、文件名不变（**不是**产生第二个文件）
  {
    const again = await uploadBanner(admin, path.join(FIX, 'banner-a-copy.png'), STORE_A, '门店A横幅');
    ck(again.status === 200 && Number(again.json?.data?.id) === idA,
      '同内容重复上传 ⇒ 复用同一行（幂等）',
      `id=${again.json?.data?.id} reused=${again.json?.data?.reused}`);
  }

  // 换图 ⇒ 文件名必须变（缓存自然失效的**唯一**依据）
  {
    const upB = await uploadBanner(admin, path.join(FIX, 'banner-b.png'), STORE_A, '门店A横幅v2');
    const idB = Number(upB.json?.data?.id);
    const nameB = String(upB.json?.data?.file_name ?? '');
    ck(nameB && nameB !== nameA, '换一张图 ⇒ 文件名（内容指纹）随之改变', `${nameA} → ${nameB}`);
    await publish(admin, idB);
    const pub = await fetchPublicBanner(nameB);
    ck(pub.status === 200, '新版发布后新 URL 可读', `status=${pub.status}`);
    // ⚠️ 这条判据走**真实客户端接口**，不在脚本里复算"应该选哪张"（见文件头）
    const seen = await storeEntryBanner(entryA);
    ck(fingerprintOf(seen.banner) === FP_B,
      '门店 1 客户侧看到的 = 最新发布的那版（换图后客户看到新图）',
      `seen=${fingerprintOf(seen.banner)} expected=${FP_B}`);
  }

  // =====================================================================
  // 场景 ②：门店匹配（各自看到各家的；谁都没配 ⇒ 不显示）
  //     全程走 `/api/public/store-entry`，与 H5 同一条路。
  // =====================================================================
  console.log('\n── 场景 ②：切换门店只显示有权适用的 Banner 或总部通用 ──');
  purgeBanners([STORE_A, STORE_B], '场景②前');

  // ②-A 谁都没配 ⇒ 必须**不渲染**（banner === null），而不是回退成别人的图。
  //      这条是"回退恒真"的照妖镜：少了它，一个"永远返回最近一条已发布"的
  //      错误实现（无视 store_id）也会全绿。
  {
    const g = await storeEntryBanner(entryG);
    ck(g.status === 200 && g.banner === null,
      '门店与总部都没配 ⇒ banner 为 null（不留空白占位、不回退成别人的图）',
      `status=${g.status} banner=${JSON.stringify(g.banner)}`);
  }

  // ②-B 只配总部通用 ⇒ 任何门店都看到它
  const upG = await uploadBanner(admin, path.join(FIX, 'banner-a.png'), null, '总部通用');
  const idG = Number(upG.json?.data?.id);
  await publish(admin, idG);
  ck(upG.status === 200, 'hq_admin 创建「总部通用」Banner 成功', `status=${upG.status}`);
  {
    const forB = await storeEntryBanner(entryB); // 门店 4：没自己的
    const forG = await storeEntryBanner(entryG); // 门店 11：没自己的
    ck(fingerprintOf(forB.banner) === FP_A, '门店 4 无自有 Banner ⇒ 回退到总部通用',
      `seen=${fingerprintOf(forB.banner)} expected=${FP_A}`);
    ck(fingerprintOf(forG.banner) === FP_A, '另一家无自有 Banner 的门店同样命中总部通用',
      `seen=${fingerprintOf(forG.banner)}`);
  }

  // ②-C 门店 1 配了自己的 ⇒ 只有门店 1 看到它，别的店**不得**串到
  const upA2 = await uploadBanner(admin, path.join(FIX, 'banner-b.png'), STORE_A, '门店1专属');
  const idA2 = Number(upA2.json?.data?.id);
  await publish(admin, idA2);
  {
    const forA = await storeEntryBanner(entryA);
    const forB = await storeEntryBanner(entryB);
    ck(fingerprintOf(forA.banner) === FP_B, '门店 1 有自有 Banner ⇒ 优先显示自己的（不回退总部）',
      `seen=${fingerprintOf(forA.banner)} expected=${FP_B}`);
    ck(fingerprintOf(forB.banner) === FP_A, '门店 4 **不会**看到门店 1 的 Banner（不串店）',
      `seen=${fingerprintOf(forB.banner)} expected=${FP_A}`);
    ck(fingerprintOf(forA.banner) !== fingerprintOf(forB.banner),
      '两家门店看到的是**不同**的图（A/B 两指纹确实被区分开）',
      `A=${fingerprintOf(forA.banner)} B=${fingerprintOf(forB.banner)}`);
  }

  // =====================================================================
  // 场景 ③：下架 ⇒ 客户端读不到；私有附件仍不可匿名读
  // =====================================================================
  console.log('\n── 场景 ③：下架后客户端不再显示；私有附件仍不可匿名读取 ──');
  const rev = await revoke(admin, idA2);
  ck(rev.status === 200 && rev.json?.data?.status === 'REVOKED', '下架成功', `status=${rev.status} → ${rev.json?.data?.status}`);

  {
    // 门店 1 的自有图已下架 ⇒ 客户侧应**回到**总部通用（而不是显示一张已下架的图）
    const forA = await storeEntryBanner(entryA);
    ck(fingerprintOf(forA.banner) === FP_A,
      '下架后客户侧立刻改回总部通用（已下架的图不再出现在配置结果里）',
      `seen=${fingerprintOf(forA.banner)} expected=${FP_A}`);
  }
  {
    const pub = await fetchPublicBanner(`banner-${FP_B}.png`);
    ck(pub.status === 404, '**下架后持旧 URL 直连也 404**（文件名不是权限）', `status=${pub.status}`);
  }
  {
    // 全下架（含总部通用）⇒ 客户侧必须回到 null
    await revoke(admin, idG);
    const forA = await storeEntryBanner(entryA);
    ck(forA.banner === null, '总部通用也下架 ⇒ 门店侧 banner 回到 null（不残留旧图）',
      `banner=${JSON.stringify(forA.banner)}`);
  }
  {
    // ⚠️ 与上一段**同一维度的选图侧对照**：库里此时还留着两条**已下架**的行。
    //    若选图那一步漏了"下架"判定，它们会被选中 ⇒ 客户看到一张已经下架的图。
    //    这是需求「已下架的 Banner 不再出现在客户端配置结果中」的正面判据。
    //
    // ⚠️ 判据写 `revoked_at is not null` 而**不是** `status='PUBLISHED' and revoked_at is not null`：
    //    `revokeBanner` 会把 status 一并改成 `REVOKED`，所以"已下架"的行 status 就是 REVOKED。
    //    第 3 版这里写错了前提，得到"已下架行数=0" ⇒ 断言恒假绿（前提永远不会成立）。
    //    **断言的前提条件本身也要能被验证**：这里额外把行数打出来，就是为了让
    //    "前提不成立"一眼可见，而不是伪装成"产品通过"。**选图那一步到底拦的是
    //    `status` 还是 `revoked_at`，由 `_b36-banner-mutation.mjs` 的 M2 专门证**
    //    （那里直插 `status='PUBLISHED'` 且 `revoked_at` 有值的行，专门打 revoked_at 这个条件）。
    const alive = Number(psql(
      `select count(*) from store_banners where revoked_at is not null;`,
    ) || '0');
    const forB = await storeEntryBanner(entryB);
    ck(alive > 0 && forB.banner === null,
      '库里存在已下架的行，但客户端配置结果里**没有**它们（选图那一步就排除）',
      `已下架行数=${alive} banner=${JSON.stringify(forB.banner)}`);
  }
  // 不存在 与 已下架 必须**同形**（否则可用来探测）
  {
    const ghost = await fetchPublicBanner('banner-0000000000000000.png');
    const revoked = await fetchPublicBanner(`banner-${FP_B}.png`);
    ck(ghost.status === revoked.status && ghost.text === revoked.text,
      '「不存在」与「已下架」回同一响应（不可作存在性探测）',
      `ghost=${ghost.status} revoked=${revoked.status}`);
  }
  // 路径穿越 / 非法形态
  //
  // ⚠️ 判定用 **403 或 404 都算通过**，理由：
  //    nginx 自己有一条防目录穿越规则（`location ~ /\.` 等），对 `../../.env`
  //    这类请求它**先于**应用返回 403。这说明请求**没有到达业务层** ——
  //    更严，不是缺陷。真正要守的性质是"拿不到内容"，403/404 都满足。
  //    服务端守卫**本身**是否有效，另见下面直连 13000 的一组断言
  //    （不经过 nginx，才能证到应用自己那层正则）。
  for (const bad of ['../../.env', '....//....//etc/passwd', 'banner-x.png', 'anything.jpg']) {
    const r = await fetch(`${BASE}/api/public/banner/${encodeURIComponent(bad)}`);
    gate.note(r.status, await r.text().catch(() => ''));
    ck([403, 404].includes(r.status), `非法文件名「${bad}」取不到 ⇒ 403/404`, `status=${r.status}`);
  }
  // 直连应用：证"服务端自己的形态守卫"（不看 nginx）
  {
    const APP = `${APP_DIRECT}/api/publicBanner:file/`;
    let allOk = true;
    const detail = [];
    for (const bad of ['../../.env', '....//....//etc/passwd', 'banner-x.png', 'anything.jpg', 'banner-0000000000000000.png']) {
      const r = await fetch(APP + encodeURIComponent(bad));
      const body = await r.text();
      gate.note(r.status, body);
      detail.push(`${bad}=${r.status}`);
      if (r.status !== 404 || !body.includes('BANNER_NOT_FOUND')) allOk = false;
    }
    ck(allOk, '服务端形态守卫：非 `banner-<16hex>.<jpg|png|webp>` 一律 404（直连应用，不经 nginx）',
      detail.join(' '));
  }
  // 真正尝试读一个**实际存在**的私有文件路径：必须取不到内容
  {
    const r = await fetch(`${BASE}/api/public/banner/..%2Fuploads-private%2Fsecret.jpg`);
    gate.note(r.status, await r.text().catch(() => ''));
    ck([403, 404].includes(r.status), '尝试读私有目录下的文件名 ⇒ 取不到（403/404）', `status=${r.status}`);
  }

  // 🔴 隔离回归：客户私有附件接口在**无凭证**下仍必须被拒
  {
    const r = await fetch(`${BASE}/api/publicMedia:file/1`);
    ck([401, 403, 404].includes(r.status),
      '客户私有附件（publicMedia:file）无凭证仍被拒 —— 隔离未被破坏',
      `status=${r.status}`);
  }
  {
    // 这条要证的是"Banner 通道**没有**顺带把附件路径打开"。
    // ⚠️ 用**私有目录下的名字**去打 Banner 接口（而不是已下架 Banner 的名字）——
    //    后者命中的是"下架 ⇒ 404"，与"附件隔离"是两件事，混在一起会给出假绿。
    const r = await fetch(`${BASE}/api/public/banner/uploads-private%2Fsecret.jpg`);
    gate.note(r.status, await r.text().catch(() => ''));
    ck([403, 404].includes(r.status),
      'Banner 接口**不**因放开图片而连带放开私有目录路径',
      `status=${r.status}`);
  }

  // =====================================================================
  // D. 幂等头与状态机
  // =====================================================================
  console.log('\n── D. 幂等与状态机 ──');
  {
    // ⚠️ 这一段**必须自造一张**，不能复用场景①②的 id。
    //    第 2 版曾复用 `idA` —— 而场景②开头就把它清掉了，
    //    于是 publish 回 404、`data` 为空、断言读到 `replayed=undefined`，
    //    表现为"幂等回放坏了"。**跨段落复用被清理过的状态**是探针最难查的一类假红：
    //    它看起来像产品丢了幂等语义，实际只是对象已经不存在。
    const up = await uploadBanner(admin, path.join(FIX, 'banner-b.png'), STORE_B, '幂等用例');
    const id = Number(up.json?.data?.id);
    ck(up.status === 200 && up.json?.data?.status === 'DRAFT',
      '幂等用例：新上传处于 DRAFT', `status=${up.json?.data?.status}`);
    const p1 = await publish(admin, id);
    const p2 = await publish(admin, id);
    ck(p1.status === 200 && p1.json?.data?.replayed === false,
      '首次发布 ⇒ replayed=false（真的写了状态）',
      `status=${p1.status} replayed=${p1.json?.data?.replayed}`);
    ck(p2.status === 200 && p2.json?.data?.replayed === true,
      '重复发布 ⇒ 幂等回放 replayed=true（不重复写时间戳）',
      `status=${p2.status} replayed=${p2.json?.data?.replayed}`);
    const r1 = await revoke(admin, id);
    const r2 = await revoke(admin, id);
    ck(r1.status === 200 && r1.json?.data?.replayed === false, '首次下架 ⇒ replayed=false',
      `replayed=${r1.json?.data?.replayed}`);
    ck(r2.status === 200 && r2.json?.data?.replayed === true, '重复下架 ⇒ 幂等回放 replayed=true',
      `replayed=${r2.json?.data?.replayed}`);
  }
  {
    // 状态机：已下架的可以重新发布（REVOKED → PUBLISHED 是白名单内流转）
    const up = await uploadBanner(admin, path.join(FIX, 'banner-a-copy.png'), STORE_B, '状态机用例');
    const id = Number(up.json?.data?.id);
    await publish(admin, id);
    await revoke(admin, id);
    const r = await publish(admin, id);
    ck(r.status === 200 && r.json?.data?.status === 'PUBLISHED', '已下架可重新发布（REVOKED→PUBLISHED）', `status=${r.json?.data?.status}`);
    // 反向：对不存在的 id 发布 ⇒ 必须 404（与 409「状态不允许」区分开）
    const ghost = await publish(admin, 99999999);
    ck(ghost.status === 404, '发布不存在的 Banner ⇒ 404（不是 409）', `status=${ghost.status}`);
  }
  {
    const r = await api(admin, '/api/svc:bannerPublish', {
      method: 'POST', json: { banner_id: 1 }, headers: { 'X-Request-Id': 'not-a-uuid' },
    });
    ck(r.status === 422 || r.status === 400, '非法 X-Request-Id ⇒ 拒绝（幂等头是强校验）', `status=${r.status}`);
  }
  {
    const r = await api(admin, '/api/svc:bannerPublish', { method: 'POST', json: { banner_id: 1 } });
    ck(r.status === 422 || r.status === 400, '缺 X-Request-Id ⇒ 同样拒绝', `status=${r.status}`);
  }

  // ---- 清理（收尾也按门店或 null 精确清理，并独立复核） ----
  console.log('\n── 清理 ──');
  purgeBanners([STORE_A, STORE_B], '收尾');

  // ---- 汇总 ----
  console.log('\n════════════════════════════════════════════════');
  const failed = results.filter((r) => !r.pass);
  console.log(`  合计 ${results.length} 项，PASS ${results.length - failed.length}，FAIL ${failed.length}`);

  if (gate.state.sawRateLimit) {
    console.log('\n  ⚠️ 本轮出现过 429 —— 按既有约定判【环境未就绪】，**不给产品结论**。');
    console.log('     （见 docs/ENGINEERING-RULES.md 第 10/11 条：先冷却或隔离，别为此放宽产品限流）');
    process.exit(2);
  }
  if (failed.length) {
    console.log('  失败项：');
    for (const f of failed) console.log(`    - ${f.label}  [${f.detail}]`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(2);
});
