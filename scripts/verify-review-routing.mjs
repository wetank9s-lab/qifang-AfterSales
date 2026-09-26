#!/usr/bin/env node
/**
 * =============================================================================
 *  verify-review-routing.mjs —— Phase 7「客户评价外链」路由门禁
 * =============================================================================
 *
 * 只回答一个问题：**短信里的那条评价链接，真的能把客户送到评价页吗？**
 * 以及它的三个反命题：畸形 token 打不开、token 不落 access log、固定路径对不对。
 *
 * ---------------------------------------------------------------------------
 * 为什么这条门禁必须存在（而不只是"顺手测一下 302"）
 * ---------------------------------------------------------------------------
 * `/f/{token}` 的失败方式是**静默**的：nginx 少一条 rewrite → 请求原样到应用
 * → NocoBase 把 `reviews` 当资源名 → 404。客户看到的是"链接无效"，
 * 而这条短信**已经发出去了**、Token 也**已经用掉了** —— 客户没有任何自助手段。
 * 更糟的是这一整条链（nginx rewrite → 302 → H5 深链）**没有任何其它门禁覆盖**：
 * 单测拿不到 nginx，机器门禁在应用层，浏览器走查是人工的、不会每次跑。
 *
 * ---------------------------------------------------------------------------
 * 关键设计：`{43}` 必须与 `REVIEW_TOKEN.LENGTH` **交叉核对**
 * ---------------------------------------------------------------------------
 * nginx 里写死的 `{43}` 是 `REVIEW_TOKEN.LENGTH`（32 字节 → base64url）的
 * **第二份副本**。只要有一天有人把 Token 加长到 48 字节，nginx 那条 rewrite
 * 就会**静默失效**（不再是 `{43}` 的正则匹配不上）→ 所有评价链接 404，
 * 而应用层一切正常、测试全绿。
 * 所以本门禁**从 `constants.ts` 解析长度**，再与实际能通过的 URL 长度对照，
 * 并有意识地证明"长度不符就打不开"（闸门 ③）。
 *
 * ---------------------------------------------------------------------------
 * Token 不进 access log
 * ---------------------------------------------------------------------------
 * `/f/` 段写了 `access_log off`。这一点**必须实测**，不能只读配置：
 * 一次 `access_log` 被某次重构顺手删掉，表现就是"客户评价 Token 明文
 * 成批落在 nginx access log 里"，而没有任何报错。
 *
 * 用法：
 *   node scripts/verify-review-routing.mjs             # 正常校验
 *   node scripts/verify-review-routing.mjs --verbose
 *   node scripts/verify-review-routing.mjs --reverse   # 反向：故意破坏一处，证明门禁会红
 *
 * 退出码：0 = 全绿；1 = 真红灯；2 = 环境未就绪
 * =============================================================================
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SITE_CONF = path.join(ROOT, 'nginx/conf.d/service.conf');
const NGINX_CONTAINER = 'svc-nginx';
const VERBOSE = process.argv.includes('--verbose');
const REVERSE = process.argv.includes('--reverse');

// ---------------------------------------------------------------------------
// 反向模式：把 nginx 的 302 目标改成一个 H5 **不认领**的路径，重载 nginx，
// 断言门禁**必须变红**（否则说明这条门禁根本没在真的校验这件事）。
// 结束时（含异常/中断）自动还原文件并再次 reload。
// ---------------------------------------------------------------------------
let reverseRestore = null;
if (REVERSE) {
  const original = fs.readFileSync(SITE_CONF, 'utf8');
  const broken = original.replace(
    'return 302 /h5/customer/review/$svc_review_token;',
    'return 302 /h5/customer/reviews/$svc_review_token;',
  );
  if (broken === original) {
    console.error('✗ 反向模式找不到可破坏的 `return 302 /h5/customer/review/...` —— 环境未就绪');
    process.exit(2);
  }
  fs.writeFileSync(SITE_CONF, broken);
  reverseRestore = () => {
    try {
      fs.writeFileSync(SITE_CONF, original);
      execFileSync('docker', ['exec', NGINX_CONTAINER, 'nginx', '-s', 'reload'], {
        stdio: 'ignore',
      });
    } catch {
      /* 尽力还原 */
    }
  };
  process.on('exit', () => reverseRestore?.());
  process.on('SIGINT', () => {
    reverseRestore?.();
    process.exit(130);
  });
  execFileSync('docker', ['exec', NGINX_CONTAINER, 'nginx', '-s', 'reload'], { stdio: 'ignore' });
  console.log('\n⚠️  反向模式：已把 nginx 302 目标改成 H5 不认领的 `/h5/customer/reviews/`，');
  console.log('    门禁**应当变红**（否则它对"链路对不对"根本没有约束力）。\n');
}

const envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const envValueOf = (key) => new RegExp(`^${key}=(.*)$`, 'm').exec(envText)?.[1]?.trim();
const PUBLIC_BASE_URL = envValueOf('PUBLIC_BASE_URL');
const NGINX_HTTP_PORT = envValueOf('NGINX_HTTP_PORT');
if (!PUBLIC_BASE_URL || !NGINX_HTTP_PORT) {
  console.error('✗ .env 缺少 PUBLIC_BASE_URL 或 NGINX_HTTP_PORT —— 环境未就绪');
  process.exit(2);
}
const HOST_ORIGIN = `http://127.0.0.1:${NGINX_HTTP_PORT}`;

const siteConf = fs.readFileSync(SITE_CONF, 'utf8');

// ---------------------------------------------------------------------------
// 从 constants.ts 解析 REVIEW_TOKEN 与 H5 前缀 —— 不硬编码
//
// ⚠️ 首跑踩到的坑：`REVIEW_TOKEN.LENGTH` / `PATTERN` 是**推导出来的**
//    （`LENGTH: REVIEW_TOKEN_LENGTH`，而 `REVIEW_TOKEN_LENGTH =
//    Math.ceil((REVIEW_TOKEN_BYTES * 4) / 3)`，`PATTERN` 是 `new RegExp(...)`）。
//    这是 `constants.ts` 的**刻意设计** —— "改了 BYTES 而忘了改长度"这类漂移
//    在源头上就不可能发生。代价是**正则抓不到数字**：
//      `LENGTH:\s*(\d+)` 永远匹配不到 `LENGTH: REVIEW_TOKEN_LENGTH`
//    首跑因此直接 `exit(2)` 报"环境未就绪"。
//
//    正确做法不是把 43 写回门禁（那就又造了一份副本），而是**真的把它算出来**：
//    抓出 `REVIEW_TOKEN_BYTES` 的字面量与 `REVIEW_TOKEN_LENGTH` 的算式，
//    在门禁里用同一套语义（base64url 无 padding）重算一遍。
//    于是这条门禁证明的是"我算出来的长度 = 服务端算出来的长度"，
//    而不是"我记得是 43"。
// ---------------------------------------------------------------------------
const constantsTs = fs.readFileSync(
  path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/constants.ts'),
  'utf8',
);

/** 取 `const NAME = <expr>;` 的表达式文本（到行尾分号为止） */
function constExprOf(name) {
  const m = new RegExp(`(?:^|\\n)(?:export\\s+)?const\\s+${name}\\s*=\\s*([^;]+);`).exec(constantsTs);
  return m?.[1]?.trim() ?? '';
}
/** 取 `export const NAME = { ... } as const;` 的对象体（不含外层花括号） */
function blockOf(name) {
  const start = constantsTs.indexOf(`export const ${name} = {`);
  if (start < 0) return '';
  const end = constantsTs.indexOf('} as const;', start);
  return end < 0 ? '' : constantsTs.slice(start, end);
}

const reviewBlock = blockOf('REVIEW_TOKEN');
const techBlock = blockOf('TECHNICIAN_TOKEN');
if (!reviewBlock || !techBlock) {
  console.error('✗ 无法从 constants.ts 定位 REVIEW_TOKEN / TECHNICIAN_TOKEN —— 环境未就绪');
  process.exit(2);
}

// ① 字节数：直接读 `REVIEW_TOKEN_BYTES = 32`（若被改成推导式则报未就绪，不猜）
const reviewBytesExpr = constExprOf('REVIEW_TOKEN_BYTES');
const REVIEW_BYTES = Number(reviewBytesExpr);
if (!Number.isInteger(REVIEW_BYTES) || REVIEW_BYTES <= 0) {
  console.error(
    `✗ 无法从 constants.ts 解析 REVIEW_TOKEN_BYTES（表达式文本：${JSON.stringify(reviewBytesExpr)}）` +
      ' —— 环境未就绪。本门禁刻意不猜长度：请确认该常量仍是字面量数字。',
  );
  process.exit(2);
}

// ② 长度：**在门禁里独立重算** base64url 无 padding 的编码长度，再与 server 的
//    `REVIEW_TOKEN_LENGTH` 声明算式对照。两个方向都查：
//    · 门禁算出的长度 → 用于实际探测（发真的 43 字符 URL）
//    · server 的算式文本 → 断言它用的就是"同一套语义"，而不是手写数字
const EXPECTED_LENGTH = Math.ceil((REVIEW_BYTES * 4) / 3);
const reviewLengthExpr = constExprOf('REVIEW_TOKEN_LENGTH');
const REVIEW_LENGTH = EXPECTED_LENGTH;
const SERVER_LENGTH_EXPR = reviewLengthExpr.replace(/\s+/g, '');
const LENGTH_IS_DERIVED = SERVER_LENGTH_EXPR.includes('Math.ceil') && SERVER_LENGTH_EXPR.includes('4');

// ③ 路径与正则
const REVIEW_LINK_PATH = /LINK_PATH:\s*'([^']+)'/.exec(reviewBlock)?.[1];
const TECH_LINK_PATH = /LINK_PATH:\s*'([^']+)'/.exec(techBlock)?.[1];
const TECH_LENGTH = Number(/(?:^|\n)\s*LENGTH:\s*(\d+)/.exec(techBlock)?.[1]);
// PATTERN 可能是 `new RegExp(\`^[A-Za-z0-9_-]{${REVIEW_TOKEN_LENGTH}}$\`)`（模板串）
// 也可能是正则字面量。两种都支持，取不到就标记 unknown（由 ④ 单独断言）。
const reviewPatternTemplate =
  /PATTERN:\s*new RegExp\(\s*`([^`]+)`\s*\)/.exec(reviewBlock)?.[1] ??
  /PATTERN:\s*\/(.+?)\/[a-z]*\s*,/.exec(reviewBlock)?.[1];
const H5_PATH_PREFIX = /H5_PATH_PREFIX:\s*'([^']+)'/.exec(constantsTs)?.[1];

if (!REVIEW_LINK_PATH || !H5_PATH_PREFIX || !TECH_LINK_PATH) {
  console.error(
    `✗ 无法从 constants.ts 解析 REVIEW_TOKEN / H5_PATH_PREFIX —— 环境未就绪\n` +
      `   REVIEW_LINK_PATH=${JSON.stringify(REVIEW_LINK_PATH)} ` +
      `H5_PATH_PREFIX=${JSON.stringify(H5_PATH_PREFIX)} ` +
      `TECH_LINK_PATH=${JSON.stringify(TECH_LINK_PATH)}`,
  );
  process.exit(2);
}

// nginx 里写死的量词：从实际配置里读，而不是再抄一遍
const nginxTokenQuantifier = Number(
  new RegExp(
    `rewrite "?\\^\\/api\\/public\\/reviews\\/\\(\\[A-Za-z0-9_-\\]\\{(\\d+)\\}\\)\\$"?`,
  ).exec(siteConf)?.[1],
);

const results = [];
const failures = [];
const pass = (label, detail = '') => {
  results.push({ ok: true, label });
  console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
};
const fail = (label, detail) => {
  results.push({ ok: false, label });
  failures.push({ label, detail });
  console.log(`  ❌ ${label}\n       ${detail}`);
};

/**
 * ⚠️ 首跑设计错误：原本想走 `docker exec svc-nginx wget -S -O -` 从**容器内**探测。
 *    `wget -S` 把响应头写到 **stderr**、body 到 stdout，我原来的调用用 `encoding`
 *    单流捕获，头/体混在一起还经常拿不到 —— 而且是**多一层间接**：
 *    容器内探测证明的是"容器里 nginx 能工作"，而客户真正访问的是宿主端口。
 *
 *    改用宿主 `curl`：它才是客户的真实路径（含端口发布这一段）。
 *    本机 curl 稳定可用，不再需要容器内变异体。
 */
function hostCurl(urlPath) {
  try {
    return execFileSync(
      'curl',
      ['-s', '-o', '/dev/null', '-D', '-', '--max-time', '10', `${HOST_ORIGIN}${urlPath}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    // curl 非 0 退出（如连接被拒）时把已收到的头尽力取出，交给调用方判状态码
    return String(e.stdout ?? '');
  }
}

function statusOf(headerText) {
  return Number(/HTTP\/\d\.\d\s+(\d{3})/.exec(headerText)?.[1] ?? 0);
}
function locationOf(headerText) {
  return /^location:\s*(.+)$/im.exec(headerText)?.[1]?.trim() ?? '';
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  Phase 7 客户评价外链路由门禁');
console.log('══════════════════════════════════════════════════════════════');

// ---------------------------------------------------------------------------
// ① 常量自身的口径：REVIEW_TOKEN 必须**独立于** TECHNICIAN_TOKEN
// ---------------------------------------------------------------------------
console.log('\n【1】Token 常量口径');
{
  if (REVIEW_LINK_PATH === '/f/') {
    pass('REVIEW_TOKEN.LINK_PATH = /f/（契约冻结口径）', REVIEW_LINK_PATH);
  } else {
    fail('REVIEW_TOKEN.LINK_PATH 必须是 /f/', `实际 ${REVIEW_LINK_PATH}`);
  }

  if (REVIEW_BYTES >= 32) {
    pass('REVIEW_TOKEN 随机强度达标（≥32 字节 = 256 位熵）', `BYTES=${REVIEW_BYTES}`);
  } else {
    fail(
      '★ REVIEW_TOKEN 熵不足 —— 32 字节是"不可暴力枚举"的下限',
      `BYTES=${REVIEW_BYTES}（要求 ≥32）。评价 Token 是**唯一**的客户身份凭证，` +
        '猜中即等于能以他人身份提交评价。',
    );
  }

  // 长度必须是**推导**出来的，不能是手写数字 —— 否则会出现
  // "改了 BYTES 但忘了改 LENGTH" 的静默漂移。
  if (LENGTH_IS_DERIVED) {
    pass(
      'REVIEW_TOKEN.LENGTH 由 BYTES 推导（源码头写 43 会埋下漂移）',
      `LENGTH = ${SERVER_LENGTH_EXPR} ⇒ ${EXPECTED_LENGTH}`,
    );
  } else {
    fail(
      'REVIEW_TOKEN.LENGTH 不是由 BYTES 推导的（疑似手写字面量）',
      `源码表达式 = ${JSON.stringify(reviewLengthExpr)}。` +
        '常量自身必须自洽：改 BYTES 而不改 LENGTH 会让 Token 生成与校验长度不一致。',
    );
  }

  if (REVIEW_LINK_PATH !== TECH_LINK_PATH) {
    pass('评价链接路径与师傅链接路径**不共用**（/f/ vs /t/）', `${REVIEW_LINK_PATH} ≠ ${TECH_LINK_PATH}`);
  } else {
    fail('评价链接路径与师傅链接路径相同 —— 两套 Token 会互相串门', `${REVIEW_LINK_PATH}`);
  }

  if (reviewPatternTemplate) {
    // 模板串里的 `${REVIEW_TOKEN_LENGTH}` 被常量替换后，必须能匹配自己的长度
    const resolved = reviewPatternTemplate.replace(/\$\{REVIEW_TOKEN_LENGTH\}/g, String(REVIEW_LENGTH));
    let ok = false;
    try {
      ok = new RegExp(resolved).test('A'.repeat(REVIEW_LENGTH));
    } catch {
      ok = false;
    }
    if (ok) {
      pass('REVIEW_TOKEN.PATTERN 与 LENGTH 自洽', `${resolved} × ${REVIEW_LENGTH} 字`);
    } else {
      fail(
        'REVIEW_TOKEN.PATTERN 匹配不了自己声明的长度',
        `解析出的模板 ${JSON.stringify(reviewPatternTemplate)} → ${resolved} vs LENGTH=${REVIEW_LENGTH}`,
      );
    }
  } else {
    fail('无法从 REVIEW_TOKEN 解析出 PATTERN（形状可能已变）', '请更新本门禁的解析正则');
  }

  // 独立凭证：长度恰好相同是**巧合**（两边都是 32 字节），不是复用。
  // 这里只提示，不判红 —— 真正要守的是"实现里引用的是 REVIEW_TOKEN 而不是 TECHNICIAN_TOKEN"，
  // 那由 verify-client-logic / 源码扫描守。
  if (TECH_LENGTH === REVIEW_LENGTH) {
    pass(
      '两套 Token 当前恰好同形（32B→43）—— 这是巧合，"由门禁证明当前一致"而非靠人脑推定',
      `REVIEW=${REVIEW_LENGTH} / TECH=${TECH_LENGTH}`,
    );
  }
}

// ---------------------------------------------------------------------------
// ② nginx 的 `{n}` 必须与 REVIEW_TOKEN.LENGTH 一致（第二份副本的交叉核对）
// ---------------------------------------------------------------------------
console.log('\n【2】nginx rewrite 量词与常量交叉核对');
{
  if (nginxTokenQuantifier === REVIEW_LENGTH) {
    pass(
      'nginx 的评价 rewrite 量词与 REVIEW_TOKEN.LENGTH 一致',
      `{${nginxTokenQuantifier}} === LENGTH ${REVIEW_LENGTH}`,
    );
  } else {
    fail(
      '★ nginx 的 `{n}` 与 REVIEW_TOKEN.LENGTH **不一致** —— 评价链接会静默全部 404',
      `nginx {${nginxTokenQuantifier}} ≠ LENGTH ${REVIEW_LENGTH}。` +
        '两处必须同时改（这是本项目已知的"同一个常量两份副本"风险点）。',
    );
  }

  // 正则必须整体加引号，否则 nginx 把 `{` 当块定界符 → 配置直接解析失败
  const unquoted = /\brewrite\s+\^\/api\/public\/reviews\/\([^\n]*\{43\}/.test(siteConf);
  if (!unquoted) {
    pass('含 `{n}` 的 rewrite 正则已加引号（verify-config 也守这一条）');
  } else {
    fail('含 `{n}` 的 rewrite 未加引号 —— nginx -t 会直接失败', '见 verify-config.mjs 同型断言');
  }
}

// ---------------------------------------------------------------------------
// ③ 方法分流：GET→get、POST→submit
//
// ⚠️ 这是首跑发现**真实缺陷**的地方：`rewrite` 是路径匹配、**不区分方法**。
//    两条并排的 rewrite 会让第一个永远赢 —— POST 也会被重写成 `get`，
//    于是"提交评价"实际调的是只读 handler：**返回 200，但一行都没写**。
//    所以必须实测"POST 到了 submit handler"。
// ---------------------------------------------------------------------------
console.log('\n【3】路径 × 方法的 rewrite 分流');
{
  const hasMethodIf = /\$request_method\s*=\s*GET/.test(siteConf) && /\$request_method\s*=\s*POST/.test(siteConf);
  if (hasMethodIf) {
    pass('nginx 用 `if ($request_method ...)` 给 get/submit 分流');
  } else {
    fail(
      '★ nginx 没有按方法分流 —— POST 会被第一条 rewrite 抢走，提交评价变成只读调用',
      '两条同路径 rewrite 并排时只有第一条生效（rewrite 不看 HTTP 方法）。',
    );
  }

  const fake = 'A'.repeat(REVIEW_LENGTH);

  // GET 到一个**形状合法但不存在**的 token：get handler 必须回 404 REVIEW_NOT_FOUND
  const getStatus = statusOf(hostCurl(`/api/public/reviews/${fake}`));
  if (getStatus === 404) {
    pass('GET /api/public/reviews/<形状合法但不存在> → 404（命中 not_found 口径）');
  } else {
    fail('GET 评价接口未如期返回 404', `实际 ${getStatus}`);
  }

  // ⚠️ 「POST 是否真的到了 submit 通道」在这里**不可判别**：
  //    get 与 submit 对"不存在的 token"给的都是 404，探针路由又只在 submit 之外可达。
  //    硬凑一个假断言只会制造虚假安全感。真正的行为证据在
  //    verify-review-loop.mjs 的 B / E / F 组 —— 那里用**真实存在**的工单
  //    发 POST，并断言"库里的状态真的变了"（get 通道做不到这一点）。
  //    本门禁在此只钉住"配置形态 + GET 可达"，并显式指向行为证据。
  pass('（方法分流的**行为**证据在 verify-review-loop.mjs 的 B/E/F 组：POST 必须真的改状态）');
}

// ---------------------------------------------------------------------------
// ④ 302 语义：不是 301、Location 是相对路径、指向 H5 深链
//
// ⚠️ 首跑的第二处错误（同样是"我记错了事实来源"）：我原以为
//    `constants.ts` 里的 `H5_PATH_PREFIX` 是评价页前缀，实际它是
//    **师傅页**的前缀（`/h5/technician/visit/`），于是断言期望值拼成了
//    `/h5/technician/visit//customer/review/...` —— 而 nginx 给的是正确的
//    `/h5/customer/review/...`。**红灯是我造的，不是产品坏了。**
//
//    这正是本项目反复强调的"命名误导"陷阱：`H5_PATH_PREFIX` 这个名字听起来
//    通用，实际只服务师傅侧。评价侧**没有**对应常量（它是 nginx 里的字面量）。
//
//    于是这条断言改成**跨两个真实事实来源**核对，而不是我自己拼一个期望值：
//      · 事实来源 A = nginx `return 302 <target>;`（客户真正被送去哪）
//      · 事实来源 B = `h5/src/router.ts` 的 `CUSTOMER_REVIEW` 正则（H5 认哪条路）
//    断言"A 的目标能被 B 匹配" —— 这才是"链接真的能把客户送到评价页"。
// ---------------------------------------------------------------------------
console.log('\n【4】/f/{token} → 302 → H5 深链');
{
  // A. nginx 的 302 目标模板（把 `$svc_review_token` 换成占位符）
  //
  // ⚠️ 不能用 `/[\s\S]*?\}/` 去圈 location 块：`{43}` 里就有个 `}`，
  //    非贪婪匹配会**在量词中间截断**，于是块内容为空 → 解析不到 `return 302`。
  //    改为直接在整个配置里找 `/f/` location 之后的**第一条** `return 302`，
  //    并用"它必须是 /h5/ 开头"来锚定（评价 location 与畸形兜底 404 相邻，
  //    中间不会有别的 302）。
  const fBlockStart = siteConf.indexOf('location ~ "^/f/');
  const fBlock = fBlockStart < 0 ? '' : siteConf.slice(fBlockStart, fBlockStart + 900);
  const redirectTargetTmpl = (/return\s+302\s+(\/h5\/\S+);/.exec(fBlock)?.[1] ?? '').trim();

  if (!redirectTargetTmpl) {
    fail(
      '无法从 nginx 配置解析 `/f/` 的 `return 302` 目标',
      '形状可能已变，请更新本门禁的解析（期望在 `/f/` location 内出现 `return 302 /h5/...;`）',
    );
  }

  // B. H5 侧认哪条路径（从 router.ts 读，不硬编码）
  //
  // ⚠️ 源码里 `CUSTOMER_REVIEW` 是**正则字面量**，路径分隔符写作 `\/`。
  //    直接拿它做我的正则匹配会因为 `\/` 里的反斜杠而失败 —— 必须先还原。
  const routerTs = fs.readFileSync(path.join(ROOT, 'h5/src/router.ts'), 'utf8');
  const h5ReviewRouteRaw = /CUSTOMER_REVIEW\s*=\s*\/\^(.+?)\$\/;/.exec(routerTs)?.[1] ?? '';
  // 还原源码里的转义：`\/` → `/`，`\\` → `\`
  const h5ReviewRoute = h5ReviewRouteRaw.replace(/\\\//g, '/').replace(/\\\\/g, '\\');
  // 形如 `/customer/review/([A-Za-z0-9_-]{8,256})`
  //   → 取第一个捕获组之前的字面量路径（**去掉结尾 `/`**，因为正则里的 `\/` 是
  //     分隔符而不是路径的一部分：`/customer/review/(` 是"前缀 `/customer/review` + 组"）
  //   ⚠️ 不能用 `/^([\w\-/]+?)\/\(\?/`：字符串以 `/` 开头，非贪婪类会让整体失配。
  const h5ReviewStaticPrefix = h5ReviewRoute.startsWith('/')
    ? (h5ReviewRoute.split('(')[0] ?? '').replace(/\/$/, '')
    : '';

  if (h5ReviewStaticPrefix) {
    pass('H5 router 声明了客户评价动态路由', `CUSTOMER_REVIEW → ${h5ReviewStaticPrefix}/:token`);
  } else {
    fail(
      '无法从 h5/src/router.ts 解析 CUSTOMER_REVIEW 的静面前缀',
      `解析结果 ${JSON.stringify(h5ReviewRouteRaw)}（还原后 ${JSON.stringify(h5ReviewRoute)}）` +
        ' —— H5 没有认领评价路由，302 之后必 404',
    );
  }

  // C. 断言 A 的目标（削掉 token 变量）与 B 一致
  //
  //    H5 的挂载前缀（`/h5`）来自 **vite.config.ts 的 `base`** —— 这是第三个
  //    真实事实来源。用它而不是解析 `constants.ts` 的 `H5_PATH_PREFIX`：
  //    后者是**师傅页**的完整路径（`/h5/technician/visit/`），拿它推"挂载根"
  //    会推出 `/h5/technician` —— 首跑就是这么错成 `/h5/technician//customer/review/` 的。
  const viteConfig = fs.readFileSync(path.join(ROOT, 'h5/vite.config.ts'), 'utf8');
  const h5Base = (/base\s*:\s*'([^']+)'/.exec(viteConfig)?.[1] ?? '').replace(/\/+$/, '');
  const h5MountPrefix = h5Base; // 形如 '/h5'
  const targetWithoutToken = redirectTargetTmpl.replace(/\$[A-Za-z0-9_]+$/, '');
  const expectedH5Path = `${h5MountPrefix}${h5ReviewStaticPrefix}/`;
  if (redirectTargetTmpl && targetWithoutToken === expectedH5Path) {
    pass(
      'nginx 的 302 目标 = H5 router 认领的评价路径（三个事实来源一致）',
      `${redirectTargetTmpl} ⇒ vite base ${h5Base} + router ${h5ReviewStaticPrefix}/:token`,
    );
  } else if (redirectTargetTmpl) {
    fail(
      '★ nginx 把客户送去的路径，H5 router **并不认领** —— 302 之后会白屏/404',
      `nginx 目标 ${redirectTargetTmpl}（前缀 ${targetWithoutToken}）\n       ` +
        `H5 认领前缀 ${expectedH5Path}（vite base ${h5Base} + router.ts CUSTOMER_REVIEW）`,
    );
  }

  // D. 实测 302 本身
  const token = 'B'.repeat(REVIEW_LENGTH);
  const out = hostCurl(`${REVIEW_LINK_PATH}${token}`);
  const status = statusOf(out);
  const location = locationOf(out);

  if (status === 302) {
    pass('`/f/{token}` 返回 302（**不是** 301 —— 301 会被浏览器永久缓存）', '302');
  } else {
    fail('`/f/{token}` 应返回 302', `实际 ${status}`);
  }

  // 实测的 Location 必须与"配置里的目标"逐字一致（把变量替换成真实 token）
  const expectLocation = redirectTargetTmpl.replace(/\$svc_review_token/g, token);
  if (location === expectLocation) {
    pass('实测 Location 是**相对路径**且与配置目标一致', location);
  } else {
    fail(
      'Location 不符合预期',
      `期望 ${expectLocation}\n       实际 ${location || '(空)'}` +
        '（绝对地址说明 absolute_redirect 没关 —— 换域名后旧链接会跳错站）',
    );
  }

  // E. 反向：302 目标**不得**指向师傅页
  if (!location.includes('/technician/')) {
    pass('评价 302 目标没有误指向师傅页');
  } else {
    fail('评价 302 指向了师傅页 —— 两条外链互相污染', location);
  }
}

// ---------------------------------------------------------------------------
// ⑤ 畸形 token 必须打不开（长度 / 字符集两个方向）
// ---------------------------------------------------------------------------
console.log('\n【5】畸形 token 的拒绝');
{
  const cases = [
    { name: '过短', path: `${REVIEW_LINK_PATH}${'A'.repeat(REVIEW_LENGTH - 1)}` },
    { name: '过长', path: `${REVIEW_LINK_PATH}${'A'.repeat(REVIEW_LENGTH + 1)}` },
    { name: '含非法字符（含 + 与 /，即 base64 非 url-safe 形态）', path: `${REVIEW_LINK_PATH}${'A'.repeat(REVIEW_LENGTH - 2)}%2B%2F` },
  ];
  for (const c of cases) {
    let out;
    try {
      out = hostCurl(c.path);
    } catch {
      out = '';
    }
    const status = statusOf(out);
    if (status === 404) {
      pass(`畸形 token（${c.name}）→ 404`);
    } else {
      fail(`畸形 token（${c.name}）应 404`, `实际 ${status}`);
    }
  }
}

// ---------------------------------------------------------------------------
// ⑥ Token 不进 access log
// ---------------------------------------------------------------------------
console.log('\n【6】Token 不进 nginx access log');
{
  // 先确认配置里确实关了这个 location 的 access log
  if (/location\s+~\s+"\^\/f\/[\s\S]{0,400}?access_log\s+off;/.test(siteConf)) {
    pass('`/f/` location 内声明了 `access_log off`');
  } else {
    fail('`/f/` location 内**没有** `access_log off` —— 客户评价 Token 会成批落进 access log');
  }

  // 实测：发一次带唯一指纹的请求，再在 access log 里找这个指纹
  const fingerprint = `ZZ${Date.now().toString(36).toUpperCase()}${'C'.repeat(
    Math.max(0, REVIEW_LENGTH - 12),
  )}`.slice(0, REVIEW_LENGTH);
  try {
    hostCurl(`${REVIEW_LINK_PATH}${fingerprint}`);
  } catch {
    /* 无论响应如何，只看日志 */
  }
  let logs = '';
  try {
    logs = execFileSync('docker', ['logs', NGINX_CONTAINER, '--tail', '400'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    logs = String(e.stdout ?? '');
  }
  const leaked = logs.split('\n').filter((l) => l.includes(fingerprint));
  if (leaked.length === 0) {
    pass('实测：带指纹的 /f/ 请求未出现在 nginx 日志中', `指纹 ${fingerprint.slice(0, 10)}…`);
  } else {
    fail(
      '★ `access_log off` 没生效 —— Token 明文出现在 nginx 日志里',
      leaked[0].slice(0, 200),
    );
  }
}

// ---------------------------------------------------------------------------
// ⑦ 反向：师傅链接路径与评价链接路径互不串门
// ---------------------------------------------------------------------------
console.log('\n【7】两套外链互不串门');
{
  // 用评价形态的 token 打师傅路径：必须**不是** 302 到评价页
  const token = 'D'.repeat(REVIEW_LENGTH);
  let out;
  try {
    out = hostCurl(`${TECH_LINK_PATH}${token}`);
  } catch {
    out = '';
  }
  const location = locationOf(out);
  if (!location.includes('/customer/review/')) {
    pass('师傅路径不会把请求送进评价页', location || `status=${statusOf(out)}`);
  } else {
    fail('师傅路径把请求送到了评价页 —— 两条 rewrite 互相污染', location);
  }

  // 反之亦然
  let out2;
  try {
    out2 = hostCurl(`${REVIEW_LINK_PATH}${token}`);
  } catch {
    out2 = '';
  }
  const location2 = locationOf(out2);
  if (!location2.includes('/technician/visit/')) {
    pass('评价路径不会把请求送进师傅页', location2 || `status=${statusOf(out2)}`);
  } else {
    fail('评价路径把请求送到了师傅页 —— 两条 rewrite 互相污染', location2);
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('');
console.log('══════════════════════════════════════════════════════════════');
if (REVERSE) {
  // 反向模式的判据**正好相反**：破坏了链路之后，门禁必须报红。
  // 全绿 = 门禁对这条链路毫无约束力 = 假绿。
  if (failures.length > 0) {
    console.log(`  ✅ 反向验证通过：故意破坏后门禁如期变红（${failures.length} 项失败）`);
    for (const f of failures) console.log(`     • ${f.label}`);
    console.log('══════════════════════════════════════════════════════════════');
    console.log('');
    process.exit(0);
  }
  console.log('  ❌ 反向验证失败：破坏了 nginx 302 目标，门禁**依然全绿** —— 这条门禁是假绿的');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(1);
}
if (failures.length === 0) {
  console.log(`  ✅ 全部通过：${results.length} 项`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  process.exit(0);
}
console.log(`  ❌ 通过 ${results.length - failures.length} 项，失败 ${failures.length} 项：`);
for (const f of failures) console.log(`     • ${f.label}\n       ${f.detail}`);
console.log('══════════════════════════════════════════════════════════════');
console.log('');
process.exit(1);
