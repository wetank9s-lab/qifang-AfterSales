#!/usr/bin/env node
/**
 * verify-bundle-delivery.mjs —— **产物交付链**断言（唯一事实来源）
 * =============================================================================
 *
 * 回答的问题：**"代码改对了"之后，浏览器到底拿不拿得到？**
 *
 * 为什么这是独立的一条（Phase 4-I 第三轮「详情 404」的真结论，DEV-74）：
 *   那一轮的僵局是「自动化全绿 + 真人仍 404」。请求 URL 早就修好了，
 *   问题出在**另一端** —— 交付：
 *     · 插件产物 URL 形如 `/static/plugins/<pkg>/dist/client/index.js?hash=b77ddccc`；
 *     · 那个 `?hash=` 由 NocoBase = sha256(**产物 mtime(ms)** + APP_KEY + 插件 version
 *       + appVersion + PLUGIN_URL_HASH_SALT)[:8]，**且被 `PackageUrls.items` 进程内缓存**；
 *     · 于是「**重建了产物、但没重启 app**」时，服务端**继续下发旧的 hash** ——
 *       同一个 URL、内容却已经变了 ⇒ 浏览器缓存键不变 ⇒ 永远拿不到新产物；
 *     · 再叠加当时 nginx 对它发 `Cache-Control: public, max-age=604800`（7 天，且无 ETag），
 *       浏览器连回源校验都不做 ⇒ 真人被粘在旧产物上。
 *   ⇒ 精确定性：**不是"hash 不会变"，而是"hash 被进程内缓存粘住，必须重启才更新"**；
 *     处置有两件：① 重建后**必须重启 app**；② 该路径**不得长缓存**（兜底）。
 *
 * 四条断言（都可反向验证）：
 *   ① 服务端实际返回的产物字节数 == 刚构建的产物字节数（防"部署漂移"）
 *   ② 静态产物的缓存策略**不得长缓存**（否则"修了但真人还是旧行为"）
 *   ③ 产物里带得走"构建标记"（让浏览器能自证跑的是哪一版）
 *   ④ 产物**不得晚于服务进程启动时间**（否则服务端在下发重建前的 `?hash=` —— 见上）
 *
 * 退出码：0 = 全部达标；1 = 真红灯；2 = 环境未就绪（产物没构建 / 服务不可达）
 *
 * 用法：node scripts/verify-bundle-delivery.mjs
 *
 * 人工取证（需要时）：登录后 `GET /api/pm:listEnabled`，即可看到服务端下发给浏览器的
 * 产物 URL 与 `?hash=` —— 就是本脚本要守的那个缓存键（见 docs/DEVIATIONS.md DEV-74）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { SVC_SCHEME, SVC_BASE_URL_PORT, SVC_BASE_URL } from './lib/base-url.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = SVC_BASE_URL_PORT;
const BASE = `${SVC_SCHEME}://127.0.0.1:${PORT}`;
const PLUGIN_DIST = 'storage/plugins/@local/service-ticket/dist';

/**
 * 🔴 两条产物通道，**都必须验**（A5-D 收口 2026-11-11）
 * ---------------------------------------------------------------------------
 *   v1  `dist/client/index.js`    —— AMD/UMD，后台桌面端加载
 *   v2  `dist/client-v2/index.js` —— ESM，**移动页（/v/mobile）唯一加载的那一条**
 *
 * 为什么之前只验 v1 是个真盲区：
 *   移动页的 HTML 里**连一行 plugin bundle 都没有**（`/v/mobile` 只有 `/v/assets/*`）。
 *   真正的加载发生在 `index-*.js` 的 `aN()`：`await import(l.url)`，
 *   而 `l.url` 来自服务端 `GET /api/pm:listEnabled` 的 **`clientV2Url`** 字段。
 *   实测（`/api/pm:listEnabled`）：service-ticket 同时下发两个 URL
 *     url        = …/dist/client/index.js?hash=24d04614
 *     clientV2Url = …/dist/client-v2/index.js?hash=b557172f   ← 移动页要的
 *   且 77 个启用插件里有 **69 个**带 `clientV2Url`、不带它的只有 8 个纯服务端插件。
 *   ⇒ 「v1 字节数对得上」**推不出**"手机上拿到的是新代码"，两者是不同文件、不同 hash。
 *
 * 两条通道的**契约不同**，不能共用一套判据：
 *   · 两者的 URL **都**带 `?hash=`（由「产物 mtime + APP_KEY + version + …」派生），
 *     且服务端把它**缓存在进程内** ⇒ 有 DEV-74 那条"重建了但没重启"的风险，两条都要验。
 *   · 关键差异在**校验目标**：v1 的 URL 是固定已知的；v2 的 hash **只能从
 *     `/api/pm:listEnabled` 读出来**。直接拼一个不带 ?hash= 的裸路径去比字节，
 *     验的是"文件在位"，而不是"移动页真正会请求的那个 URL 返回的是这份内容"。
 *     更糟的是：拿宿主这边的裸路径做反向测试会**两边一起变**（典型假绿，实测踩过）。
 *   · v2 是 **ESM 固定路径 + 长缓存**没有任何兜底 ⇒ Cache-Control 必须 no-cache。
 */

/** 产物清单：每一项都独立跑「服务端下发 URL → 字节一致 → 缓存策略 → 构建标记」 */
const BUNDLES = [
  {
    id: 'v1',
    label: '桌面后台（AMD/UMD）',
    file: `${PLUGIN_DIST}/client/index.js`,
    // 服务端下发字段名；拿不到就退回裸路径（但会明确标注为"未按真实 URL 验证"）
    serverField: 'url',
    bareUrl: '/static/plugins/@local/service-ticket/dist/client/index.js',
    hashQueryPin: true,
  },
  {
    id: 'v2',
    label: '移动页 /v/mobile（ESM，**唯一被加载**）',
    file: `${PLUGIN_DIST}/client-v2/index.js`,
    serverField: 'clientV2Url',
    bareUrl: '/static/plugins/@local/service-ticket/dist/client-v2/index.js',
    hashQueryPin: true, // 实测也带 ?hash=（b557172f），不是裸路径
  },
];

const LOCAL = path.join(ROOT, BUNDLES[0].file);

const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);

/** 长缓存的判据：超过 5 分钟的 max-age 就算"长"（本项目的产物 URL 不是内容寻址的） */
const LONG_CACHE_SECONDS = 300;

let hardFail = 0;

if (!fs.existsSync(LOCAL)) {
  console.log(`  ⚠️  找不到刚构建的客户端产物：${BUNDLES[0].file}`);
  console.log('      → 先跑 `node scripts/build-plugin.mjs`（这属于"环境未就绪"，不是缺陷）');
  process.exit(2);
}

/**
 * 从服务端读「浏览器真正会请求的产物 URL」。
 *
 * 为什么要走这一步而不是直接拼路径：
 *   DEV-74 的失效形态是"文件是新的、但服务端下发的 hash 还是旧的"。
 *   只有拿**下发值**去请求，才能验到浏览器实际拿到的东西。
 *   直接请求裸路径时，nginx/app 每次都读当前文件 ⇒ **永远不会红**（假绿）。
 *
 * 取不到时**不降级成"通过"**：进程内缓存粘住恰恰可能让接口异常，
 * 这时退回裸路径会把最需要报出来的场景掩盖掉。所以标 `serverUrlKnown: false`
 * 并让 v2（移动页唯一入口）直接判红。
 */
let pluginData = null;
try {
  const r = await fetch(`${BASE}/api/pm:listEnabled`, { headers: { 'accept-encoding': 'identity' } });
  if (r.ok) pluginData = (await r.json())?.data ?? null;
} catch {
  /* 下面统一处理 */
}

const localSize = fs.statSync(LOCAL).size;
const localText = fs.readFileSync(LOCAL, 'utf8');

// ①～③ 对**每一条产物通道**各跑一遍（v1 桌面后台 / v2 移动页）
// ⚠️ v2 不存在时必须判红、而不是跳过：它是移动页唯一加载的那一条，
//    "产物没构建"= 手机上整页白屏，这种情况绝不能因为"文件不在"就静默放过。
for (const B of BUNDLES) {
  console.log('');
  console.log(`【产物通道 ${B.id}】${B.label}`);
  console.log(`  ${B.file}`);

  const abs = path.join(ROOT, B.file);
  if (!fs.existsSync(abs)) {
    bad(`产物不存在：${B.file} —— 该通道的**所有**页面都会失败（不是"跳过不算"）`);
    hardFail++;
    continue;
  }
  const localBuf = fs.readFileSync(abs);
  const text = localBuf.toString('utf8');

  // ① 取「浏览器真正会请求的 URL」= `/api/pm:listEnabled` 下发的带 hash 地址
  const entry = pluginData?.find((p) => p.packageName === '@local/service-ticket');
  const serverUrlRaw = entry?.[B.serverField];
  const serverUrlKnown = typeof serverUrlRaw === 'string' && serverUrlRaw.startsWith('/static/');
  const targetUrl = serverUrlKnown ? serverUrlRaw : B.bareUrl;
  if (serverUrlKnown) {
    ok(`服务端下发 ${B.serverField} = ${serverUrlRaw}`);
    // 🔴 `?hash=` 必须与刚构建的产物**派生自同一个 mtime**
    // -------------------------------------------------------------------------
    // 实测（2026-11-11，M4 变异）：改了 v2 文件、不重启 app 后，服务端仍下发
    //   …client-v2/index.js?hash=b557172f（旧），而请求那个 URL 拿到的是 **163649 字节的新文件**。
    // ⇒ 关键事实：**`?hash=` 只参与缓存键，不参与文件选取**（静态服务按路径读盘，忽略 query）。
    //    所以"字节比对"在"重建未重启"时**依然全绿** —— 它证明不了下发的 hash 是新的。
    //    而 hash 一旦是旧的，浏览器（或任何中间缓存）会把这个旧键当成"还是那个东西"，
    //    再叠加长缓存就永远拿不到新代码 —— 这正是 DEV-74 的真实形态。
    //
    // 判据：hash 由 `sha256(产物 mtime(ms) + APP_KEY + version + appVersion + SALT)[:8]` 派生，
    //   而 mtime 在我这边可读 ⇒ 只需确认「服务端下发的 hash **不等于**按**旧** mtime 算的值」不够，
    //   更直接的判据是下面第 ⑤ 项的时间比较（产物 mtime 不得晚于 app 进程启动）。
    //   这里补的是同一件事的**间接证据**：下发的 hash 必须在"app 启动之后"才可能出现。
    //   —— 见 ⑤，本处只记录下发值，不作判断。
  } else if (B.id === 'v2') {
    // 移动页唯一入口 —— 拿不到下发值就没有可信判据，必须红
    bad(
      `/api/pm:listEnabled 里读不到 @local/service-ticket 的 clientV2Url（实际 ${JSON.stringify(serverUrlRaw)}）—— ` +
        '移动页将退化成"加载不到插件"，或本项**无法按浏览器真实 URL 验证**（不能当通过）',
    );
    hardFail++;
  } else {
    warn(`读不到 ${B.serverField}，退回裸路径验证（**未按浏览器真实 URL 验**）`);
  }

  // ② 服务端发的 == 刚构建的
  // ⚠️ 必须显式 identity：默认的 gzip 协商会让 nginx 转成 chunked、**不带 Content-Length**
  //    （第一版用 Content-Length 判等，读到 0 字节 → 报出"部署漂移"的**假红**）。
  let res;
  let servedBuf;
  try {
    res = await fetch(`${BASE}${targetUrl}`, { headers: { 'accept-encoding': 'identity' } });
    servedBuf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.log(`  ⚠️  无法访问 ${BASE}${targetUrl}：${e.message}（环境未就绪）`);
    process.exit(2);
  }

  if (res.status !== 200) {
    bad(`${targetUrl} 返回 ${res.status} —— 该通道会整页 App error`);
    hardFail++;
  } else if (servedBuf.length !== localBuf.length) {
    bad(
      `服务端实际返回 ${servedBuf.length} 字节 ≠ 刚构建的 ${localBuf.length} 字节 —— ` +
        '**部署漂移**：浏览器拿到的不是这一版产物',
    );
    hardFail++;
  } else if (!servedBuf.equals(localBuf)) {
    // 字节数相同但内容不同 = 最阴的一种漂移：长度对得上，肉眼判据全过
    bad(`${localBuf.length} 字节长度相同但**内容不同**（md5 不一致）—— 部署漂移`);
    hardFail++;
  } else {
    ok(`服务端实际返回的产物与刚构建的一致（${localBuf.length} 字节，md5 相同）`);
  }

  // ③ 缓存策略
  // 两条通道的 URL 都带 `?hash=`（实测 v2 是 b557172f），而该 hash 来自 **mtime**
  // 且被进程内缓存粘住 ⇒ 它**不是**内容寻址的健壮版本号，不能靠它做缓存失效。
  // 所以 `Cache-Control: no-cache` 是两条通道共同的硬要求，不是"v1 的历史包袱"。
  const cacheControl = String(res.headers.get('cache-control') || '');
  const m = /max-age=(\d+)/i.exec(cacheControl);
  const maxAge = m ? Number(m[1]) : 0;
  if (/no-store|no-cache/i.test(cacheControl)) {
    ok(`缓存策略正确：Cache-Control: ${cacheControl}（每次回源校验，未变则 304）`);
  } else if (maxAge > LONG_CACHE_SECONDS) {
    bad(
      `Cache-Control = "${cacheControl}" —— **长缓存**。` +
        '两条产物通道的 `?hash=` 都是 mtime 派生且被进程内缓存粘住，' +
        '等价于没有内容哈希 ⇒ 浏览器会一直跑旧产物（DEV-74）',
    );
    hardFail++;
  } else {
    warn(`缓存策略偏宽松：Cache-Control: ${cacheControl || '（缺失）'}（建议 no-cache）`);
  }

  // ④ 构建标记（浏览器自证用）
  // ⚠️ 不要拿中文当锚点：esbuild 默认 charset=ascii，会把中文串转义成 \uXXXX，
  //    所以在产物里搜「客户端产物构建」**永远搜不到**（实测踩过）。
  //    改搜 ISO 时间戳本身 —— 实测它在整个产物里唯一出现。
  const stamps = [...new Set(text.match(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z/g) || [])];
  if (stamps.length === 1) {
    ok(`构建标记：${stamps[0]} —— 走查时浏览器 Console / 网络面板里应出现同一串`);
  } else if (stamps.length === 0) {
    warn('产物里找不到构建标记 —— 浏览器将无法自证跑的是哪一版产物');
  } else {
    warn(`产物里有 ${stamps.length} 个 ISO 时间戳（${stamps.join(', ')}）—— 无法确定哪个是构建标记`);
  }
}
console.log('');

// ④ **服务端下发的 URL 必须与当前产物一致** —— 「重建了但没重启」检测
// ---------------------------------------------------------------------------
// DEV-74 的**真机制**（2026-09-23 实测确认，比最初的理解更精确）：
//   服务端下发给浏览器的产物 URL 形如
//     /static/plugins/<pkg>/dist/client/index.js?hash=<8 位>
//   而那个 hash 由 NocoBase 计算：
//     sha256(产物文件 mtime(ms) + APP_KEY + 插件 version + appVersion + PLUGIN_URL_HASH_SALT)[:8]
//   （实现见容器内 @nocobase/server/lib/plugin-manager/options/resource.js 的 PackageUrls.fetch）
//   ⇒ **它确实随产物变化**（mtime 变了 hash 就变）—— 但结果被 `PackageUrls.items` **进程内缓存**！
//   ⇒ **重建产物而不重启 app**，服务端会**继续下发旧 hash**：
//       浏览器那个 URL 的缓存键没变 → 缓存里还带着旧的 max-age → **永远拿不到新产物**。
//   ⚠️ 最初我把这条误判成「?hash= 不是内容哈希、所以不会变」；实测复算后纠正为
//      「**是 mtime 哈希，但被进程内缓存粘住**」。两者结论不同、处置也不同：
//      前者的解法是"别长缓存"，后者的解法是"**重建后必须重启**"。
//
// 判据（不需要登录、不需要复算 hash，只比时间）：
//   产物的 mtime **不得晚于** app 容器进程的启动时间。
//   若晚于 ⇒ 进程里缓存的是重建前的 hash ⇒ 服务端正在发一个「旧 URL 指向新文件」的状态。
const APP_CONTAINER = process.env.SVC_APP_CONTAINER || 'svc-app';
try {
  const startedAt = execFileSync('docker', ['inspect', '-f', '{{.State.StartedAt}}', APP_CONTAINER], {
    encoding: 'utf8',
    timeout: 20000,
  }).trim();
  const appMs = Date.parse(startedAt);
  if (!Number.isFinite(appMs)) {
    warn(`无法解析 ${APP_CONTAINER} 的启动时间（${startedAt}）—— 本项未验到`);
  } else {
    // ⚠️ **两条通道都要比**。最初只比了 v1（`LOCAL`），而移动页只加载 v2 ⇒
    //    "只重建 v2、不重启 app"这一种最常见的情形会被完全放过（实测确认：放过）。
    let stale = [];
    for (const B of BUNDLES) {
      const p = path.join(ROOT, B.file);
      if (!fs.existsSync(p)) continue;
      const ms = fs.statSync(p).mtimeMs;
      if (ms > appMs) stale.push(`${B.id}（${new Date(ms).toISOString()}）`);
    }
    if (stale.length) {
      bad(
        `产物 ${stale.join('、')} **比服务进程启动时间（${startedAt}）更新** —— ` +
          '服务端仍在下发**重建前的 `?hash=`**（进程内缓存）。' +
          '⚠️ 注意这一条**不会**被上面的字节比对抓到：`?hash=` 只参与缓存键、不参与文件选取，' +
          '静态服务按路径读盘 ⇒ 旧 hash 的 URL 也能拿到新文件（实测 163649 字节照常返回）。' +
          ` 处置：\`docker compose restart app\`（或 \`docker restart ${APP_CONTAINER}\`）后重跑本脚本`,
      );
      hardFail++;
    } else {
      ok('两条产物通道的 mtime 都不晚于服务进程启动时间（下发的 ?hash= 对应的是当前产物）');
    }
  }
} catch (e) {
  warn(`无法判定"产物 vs 服务进程启动时间"：${e.message}（这属于环境未就绪，不代表达标）`);
}

console.log('');
if (hardFail) {
  console.log(`  ❌ 产物交付链不合格：${hardFail} 项（退出码 1）`);
  process.exit(1);
}
console.log('  ✅ 产物交付链达标');
process.exit(0);
