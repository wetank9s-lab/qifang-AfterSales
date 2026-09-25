#!/usr/bin/env node
/**
 * verify-technician-h5.mjs —— **师傅作业页的契约门禁**（P5-1）
 * =============================================================================
 *
 * 这个页面跑在师傅的手机上、匿名、且链路上一环都不能错。它没有 DOM 断言，
 * 但它的**契约**几乎全部可以在离线断言掉 —— 而且必须断言，因为：
 *
 *   · 页面里多渲染一个 `customer_mobile` → 客户资料泄漏到匿名页面（**没人会报错**）
 *   · 终态文案写成"工单已完成" → 师傅直接走人、客户以为事情办完了（**没人会报错**）
 *   · 上传时手写 `Content-Type: multipart/form-data` → boundary 丢失、上传必失败
 *   · 提交时多发一个 `X-Request-Id` → 暗示"重放是被允许的"，与 R2 的语义冲突
 *
 * 以上四件事都不会让任何构建/类型检查变红。所以这里逐条钉住。
 *
 * -----------------------------------------------------------------------------
 * 四组检查
 * -----------------------------------------------------------------------------
 * 【0】fixture 自检 —— **验证器自己的验证器**（真源在同目录的
 *     `verify-technician-h5-selftest.mjs`）。它的原语坏了，后面全是假绿/假红：
 *     本轮 P5-1 连着踩了 DEV-76/77/78/79 四个"产品没错、checker 错了"的坑。
 *     ⚠️ fixture 一旦红，本脚本**不产出产品结论**（exit 2）：
 *        "工具坏了"与"产品坏了"必须分开报，不能拿坏工具的绿灯当依据。
 * 【1】源码级封条（**结构化**扫 SFC 与 API 模块）
 *     最小信息、终态文案红线、不发请求号、表单规则、分区完整性
 * 【2】把真正会跑的代码跑起来（esbuild → Node + 注入 fake fetch）
 *     提交报文的**逐字段**形状、multipart 的**不手写** Content-Type、
 *     URL 编码的纯函数契约、URL ↔ nginx rewrite 的跨层契约、数据边界闸
 * 【3】路由行为（注入 window 后加载 router.ts）
 *     `/technician/visit/:token` 认得、畸形路径不认
 *
 * ⚠️ 本脚本**不**替代真实浏览器走查（见 docs/PHASE-5.md 的走查清单）。
 *    它挡的是"契约被改坏"，挡不住"样式在真机上错位"这类问题。
 *
 * 用法 / 退出码：
 *   0 全绿 / 1 真红灯（产品契约坏了）/ 2 环境或**工具**未就绪（含 fixture 自检失败）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  assertThat,
  bundleWith,
  eqJson,
  eqScalar,
  extractUserVisibleText,
  findTerminalCopyViolations,
  loadEsbuild,
  splitSfc,
  stripSourceComments,
  TERMINAL_COPY_POLICY,
} from './lib/h5-contracts.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const H5 = path.join(ROOT, 'h5');
const TMP = path.join(ROOT, '.tmp-verify', 'p5-h5');
const NODE_WORKSPACE = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.workbuddy',
  'binaries',
  'node',
  'workspace',
);

const SFC = 'src/pages/Technician/Visit.vue';
const API = 'src/api/technician.ts';
const ROUTER = 'src/router.ts';

const LINE = '═'.repeat(62);

let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push({ label, message: error.message });
    console.log(`  ❌ ${label} — ${error.message}`);
  }
}

async function checkAsync(label, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push({ label, message: error.message });
    console.log(`  ❌ ${label} — ${error.message}`);
  }
}

/** 读源码：`raw` 原样、`code` 已按文件类型**分区**剥掉注释 */
function readSource(relative, kind = 'vue') {
  const full = path.join(H5, relative);
  assertThat(fs.existsSync(full), `找不到 ${relative}`);
  const raw = fs.readFileSync(full, 'utf8');
  return { raw, code: stripSourceComments(raw, kind) };
}

// ---------------------------------------------------------------------------
// esbuild：产物 build 一次，fixture 自检与【2】共用（避免 build 两遍）
// ---------------------------------------------------------------------------
function requireFrom(outfile) {
  return createRequire(import.meta.url)(outfile);
}

async function main() {
  const rSfc = readSource(SFC, 'vue');
  const rApi = readSource(API, 'ts');

  const esbuild = loadEsbuild({ searchDirs: [H5, NODE_WORKSPACE] });
  if (!esbuild) {
    console.log('');
    console.log(LINE);
    console.log('  ⚠️  环境未就绪：找不到 esbuild（无法 bundle 客户端代码，断言无法取证）');
    console.log(LINE);
    console.log('');
    process.exit(2);
  }

  const apiOut = await bundleWith(esbuild, {
    h5Dir: H5,
    outDir: TMP,
    name: 'technician-api',
    entryRelative: API,
  });
  const Api = requireFrom(apiOut);

  // =========================================================================
  console.log('\n【0】fixture 自检（验证器自己的验证器）');
  const { runFixtures } = await import('./verify-technician-h5-selftest.mjs');
  const fixtureResult = await runFixtures({ Api });

  if (fixtureResult.envNotReady) {
    console.log(LINE);
    console.log(`  ⚠️  环境未就绪：${fixtureResult.envNotReady}`);
    console.log(LINE);
    process.exit(2);
  }

  if (fixtureResult.failures.length > 0) {
    // ⚠️ 关键取舍：fixture 红了 → **不产出产品结论**。
    //    否则就是"带着坏掉的验证器跑总绿数"——正是这四轮反复出问题的地方。
    console.log('');
    console.log(LINE);
    console.log(`  ⛔ 工具自身未通过自检：fixture 失败 ${fixtureResult.failures.length} 条`);
    for (const f of fixtureResult.failures) console.log(`     · [${f.id}] ${f.message}`);
    console.log('     → 本次**不给产品结论**（既不是 PASS 也不是 FAIL）。先修 checker。');
    console.log(LINE);
    console.log('');
    process.exit(2);
  }
  passed += fixtureResult.passed;
  console.log(`  ✅ fixture 全绿：${fixtureResult.passed} 条（含历史四个坑的最小复现）`);

  // =========================================================================
  console.log('\n【1】源码级封条');

  check('页面只带**最小信息**：不出现客户姓名/手机号（以及任何客户字段）', () => {
    // 这几个名字一旦出现在页面或 API 模块里，就说明有人"顺手把客户资料带进去了"。
    // 后端 `get` 根本没查这些字段（第一道闸），这里是第二道。
    // ⚠️ 扫的是**剥掉注释后**的源码：注释里解释"为什么不带客户资料"不算违规，
    //    否则那条注释会被删掉 —— 而注释是下一个人的护栏。
    const forbidden = [
      'customer_mobile',
      'customer_name',
      'customer_phone',
      'customer_tel',
      'customer_address',
    ];
    for (const word of forbidden) {
      assertThat(!rSfc.code.includes(word), `${SFC} 里出现了 ${word} —— 匿名页不得带客户资料`);
      assertThat(!rApi.code.includes(word), `${API} 里出现了 ${word} —— 匿名接口不得带客户资料`);
    }
    // 反向自检：页面里**确实**有该有的东西（否则"什么都不渲染"也能全绿）
    for (const required of ['ticket_no', 'store_name', 'content', 'expected_visit_at']) {
      assertThat(rSfc.code.includes(required), `${SFC} 缺少必需字段 ${required}（最小信息不等于信息不足）`);
    }
    return `${forbidden.length} 个客户字段均未出现；4 个必需字段齐备`;
  });

  check('终态文案：只准"已提交 / 等待门店确认 / 提交成功"，禁止"已完成 / 已关闭"式收尾', () => {
    // 判据是**用户可见文案**（模板文本 + 可见属性 + JS 字面量），
    // 而且只查**终态句式**，不做关键词猎杀 —— "请完成以下信息"这类正常文案必须放行。
    const page = findTerminalCopyViolations(extractUserVisibleText(rSfc.raw, 'vue'));
    assertThat(
      page.length === 0,
      `${SFC} 出现终态违规：${JSON.stringify(page)} —— ` +
        '师傅提交只到 WAIT_STORE_CONFIRM，说"已完成/已关闭"会让师傅直接走人',
    );
    const api = findTerminalCopyViolations(extractUserVisibleText(rApi.raw, 'ts'));
    assertThat(api.length === 0, `${API} 出现终态违规：${JSON.stringify(api)}`);

    // 正向：终态**必须**指向门店确认（只说"已提交"不够，师傅不知道后面还有环节）
    assertThat(
      rSfc.code.includes('等待门店确认'),
      `${SFC} 没有"等待门店确认"的文案 —— 终态必须明确指向门店确认`,
    );
    assertThat(rApi.code.includes('等待门店确认'), `${API} 的兜底文案里没有"等待门店确认"`);

    // 终态标题必须由**服务端**下发，页面不得自己手写一句
    assertThat(
      rSfc.code.includes('outcome?.message'),
      '终态标题没有用服务端下发的 `outcome.message` —— 页面自己写文案会与服务端口径漂移',
    );
    return `可见文案无终态违规；允许集合 ${JSON.stringify(TERMINAL_COPY_POLICY.allowed)}`;
  });

  check('SFC 分区完整：根模板没被嵌套 <template> 截断（终态分支必须看得见）', () => {
    // DEV-76b 的正向守卫：用正则配平 `<template>...</template>` 会在第一个
    // 内层 `</template>` 处收工，终态分支落在被截掉的那半段里 —— 检查"看着在跑"。
    const { template, script } = splitSfc(rSfc.raw);
    assertThat(template.includes("view === 'success'"), '根模板里看不到 success 分支 —— 分区被截断');
    assertThat(template.includes('outcome?.message'), '终态分支的标题不在根模板里');
    assertThat(template.includes('referrerpolicy'), '照片分支不在根模板里');
    assertThat(script.includes('watch(() => props.token'), 'script 区没切出来');
    assertThat(!script.includes('svc-card'), 'script 区混进了模板内容');
    return `模板 ${template.length} 字节 / script ${script.length} 字节，两端关键内容都在`;
  });

  check('源码剥离器安全网：`accept="image/*"` 这类代码不许被当成注释吃掉', () => {
    // 完整矩阵在 fixture 层；这里是**廉价的现场保险**：
    // 即便 fixture 被误跳过，这条也能立刻照出 DEV-76 的复发。
    for (const token of [
      'accept="image/*"', // ← DEV-76 就是被这一处吃掉的
      'referrerpolicy="no-referrer"',
      'v-for="opt in ctx?.service_results',
      'maxlength="500"',
    ]) {
      assertThat(rSfc.code.includes(token), `剥离器把**代码**吞掉了：${token} 不见了`);
    }
    assertThat(
      rSfc.code.includes("if (!form.is_charged) form.reported_charge_amount = ''"),
      '剥离器吞掉了"切换不收费时清空金额"的那行代码',
    );
    return '5 处关键代码片段在剥离后均存活';
  });

  check('师傅接口**不发** X-Request-Id（一次性 Token 本身就是提交边界）', () => {
    for (const word of ['X-Request-Id', 'REQUEST_ID_HEADER', 'requestId', 'newRequestId']) {
      assertThat(
        !rApi.code.includes(word),
        `${API} 里出现了 ${word} —— 发了请求号就等于宣称"重放是允许的"，` +
          '而 R2 反向测试要求提交成功后同一 Token 重放必须 401',
      );
    }
    // 反向自检：内部写动作**必须**发它（否则这条断言只是在描述"文件里没有这个词"）
    const http = readSource('src/api/http.ts', 'ts').code;
    assertThat(http.includes('X-Request-Id'), 'api/http.ts 应当仍然负责内部写动作的请求号');
    return '师傅接口零请求号；内部通道保持原样';
  });

  check('表单规则：service_note 必填、金额**只在收费时**渲染、且切换时不收费会清空金额', () => {
    // 处理结果是**枚举选择**（v-for 渲染服务端下发的选项），不是自由输入
    assertThat(
      /v-for="opt in ctx\?\.service_results/.test(rSfc.code),
      '处理结果必须由服务端下发的枚举渲染（不许页面自己手写一份选项）',
    );
    assertThat(/maxlength="500"/.test(rSfc.code), 'service_note 必须限长 500（与后端 NOTE_MAX 一致）');
    // 金额字段必须是条件渲染，而不是"始终渲染、提交时忽略"
    assertThat(
      /v-if="form\.is_charged"/.test(rSfc.code),
      '收费金额必须是 v-if="form.is_charged" 条件渲染 —— 不收费时不该出现这个输入框',
    );
    // 切换成"不收费"时必须清空残留金额（服务端还会再兜一次）
    assertThat(
      /if \(!form\.is_charged\) form\.reported_charge_amount = ''/.test(rSfc.code),
      '缺少"切换为不收费时清空金额"的逻辑 —— 残留值会跟着提交上去',
    );
    return 'note 必填限长 / 金额条件渲染 / 切换清空';
  });

  check('DEV-80 回归门：金额字段不得被当字符串读（Vue 会把 type=number 的 v-model 变成 number）', () => {
    // 真实事故（P5-1 真实浏览器走查发现）：`onSubmit` 里写 `form.reported_charge_amount.trim()`，
    // 而该字段运行期是 **number** → TypeError；异常抛在 `@submit` handler 里，
    // Vue 交给 `console.error`，页面上**什么都不显示**：
    // 按钮可点、无红字、无请求，**工单其实没提交**。只有"已收费"才走这条路径，
    // 所以只测不收费的用例永远看不见它。
    const code = rSfc.code;

    // 正向：必须存在唯一的读取入口
    assertThat(/function amountText\(/.test(code), '缺少金额读取入口 amountText()');
    assertThat(/function toAmount\(/.test(code), '缺少金额读取入口 toAmount()');

    const occurrences = [...code.matchAll(/form\.reported_charge_amount/g)].length;
    assertThat(
      occurrences >= 3,
      `页面里只出现 ${occurrences} 次金额字段 —— 太少，这条断言可能已经什么都没检`,
    );

    // 禁止：在字段后面直接调方法（.trim() / .length / .toString() …）
    const direct = [...code.matchAll(/form\.reported_charge_amount\s*\.\s*([A-Za-z_$][\w$]*)/g)].map(
      (m) => m[1],
    );
    assertThat(
      direct.length === 0,
      `对金额字段直接调了方法：${JSON.stringify(direct)} —— ` +
        'Vue 会把 type=number 的 v-model 变成 number，运行期这些方法不存在，' +
        '表现为"点提交毫无反应、页面不报错、工单没提交"',
    );

    // 反向自检：检测正则本身必须能咬住当年的写法（否则这条门是假的）
    assertThat(
      /form\.reported_charge_amount\s*\.\s*([A-Za-z_$][\w$]*)/.test(
        "const raw = form.reported_charge_amount.trim();",
      ),
      'DEV-80 的检测正则失效了 —— 它抓不到当年的写法',
    );
    return `${occurrences} 处引用、0 处直接方法调用，且正则反向自检通过`;
  });

  check('照片是最小可读：图片请求带 referrerpolicy="no-referrer"', () => {
    assertThat(
      /referrerpolicy="no-referrer"/.test(rSfc.code),
      '照片 <img> 必须设 referrerpolicy="no-referrer" —— URL 里带着作业 Token，' +
        '不设的话会被写进 Referer',
    );
    return 'no-referrer 已设置';
  });

  // =========================================================================
  console.log('\n【2】真跑那份代码（esbuild → Node + 注入 fake fetch）');

  check('token 形态校验：拒绝空/非 base64url，接受合法形态（且**不校验长度**）', () => {
    let threw = 0;
    for (const bad of ['', '   ', 'has space', 'a/b', 'a+b', '中文', 'a'.repeat(300) + '!']) {
      try {
        Api.assertTokenShape(bad);
      } catch {
        threw += 1;
      }
    }
    eqScalar(threw, 7, '非法形态被拒的条数');
    // ⚠️ 关键：**长度不在这里校验**。前端不复制服务端的 43 这个数字 ——
    //    复制了就会在常量漂移时把合法链接判成非法（而用户没有重试入口）。
    eqScalar(Api.assertTokenShape('A'.repeat(20)), 'A'.repeat(20), '20 位 token 应放行（长度由服务端判定）');
    return '7 种非法形态被拒；长度不参与前端判定';
  });

  check('数据边界闸：不合形态的 ref 在这里被丢掉，渲染层只消费已校验数据', () => {
    // DEV-79 的正解：形态校验在**数据入口**，不在渲染期。
    assertThat(Api.isValidPhotoRef('b'.repeat(22)), '合法 ref 被判成非法');
    for (const bad of ['', 'a b', 'a/b', 'a?b', 'a#b', '中文', null, undefined, 42]) {
      assertThat(!Api.isValidPhotoRef(bad), `坏 ref 逃过形态闸：${JSON.stringify(bad)}`);
    }
    // `normalizePhoto` 是唯一的收敛点（列表与上传共用，不再各写一遍）
    assertThat(Api.normalizePhoto({ ref: 'good' })?.ref === 'good', '合法 ref 应被收敛');
    eqScalar(Api.normalizePhoto({ ref: 'a b' }), null, '坏 ref 应被丢弃（返回 null）');
    eqScalar(Api.normalizePhoto({}), null, '缺 ref 应被丢弃');
    return 'isValidPhotoRef + normalizePhoto 双闸就位';
  });

  await checkAsync('列表接口里的坏 ref 必须被**丢在边界**（不得流进渲染层）', async () => {
    const good = 'b'.repeat(22);
    const payload = {
      data: {
        ticket_no: 'FW-TEST',
        store_name: '测试门店',
        content: '不制冷',
        photos_count: 2,
        max_photos: 6,
        photos: [
          { ref: good, photo_type: 'onsite', mime: 'image/jpeg', size: 1 },
          { ref: 'a b/c?d', photo_type: 'onsite', mime: 'image/jpeg', size: 1 }, // 恶意 ref
        ],
      },
    };
    const ctx = await Api.fetchVisitContext('A'.repeat(43), {
      fetchImpl: async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    eqJson(ctx.photos.map((p) => p.ref), [good], '收敛后的照片 ref 集合');
    return `服务端回了 2 张、其中 1 张 ref 非法 → 客户端只留下 1 张（${good.slice(0, 6)}…）`;
  });

  await checkAsync('上传返回坏 ref 时必须报错（不能静默塞进列表）', async () => {
    let caught = null;
    try {
      await Api.uploadPhoto('A'.repeat(43), new File([new Uint8Array([1])], 'x.jpg'), 'onsite', {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ data: { photo: { ref: '../etc/passwd' }, photos_count: 1, max_photos: 6 } }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          ),
      });
    } catch (error) {
      caught = error;
    }
    assertThat(caught, '上传返回坏 ref 却静默成功了 —— 列表里会多一张永远加载不出来的照片');
    eqScalar(caught.code, 'MALFORMED_RESPONSE', '错误码');
    return '201 + 坏 ref → MALFORMED_RESPONSE';
  });

  check('URL 编码是纯函数：特殊字符不得改变 path/query 语义', () => {
    // 直接断言纯函数（不再靠页面渲染间接证明）
    eqScalar(Api.encodePathSegment('a b'), 'a%20b', 'encodePathSegment 空格');
    eqScalar(Api.encodePathSegment('a/b'), 'a%2Fb', 'encodePathSegment 斜杠');
    eqScalar(Api.encodePathSegment('a?b'), 'a%3Fb', 'encodePathSegment 问号');
    eqScalar(Api.encodePathSegment('a#b'), 'a%23b', 'encodePathSegment 井号');
    eqScalar(Api.encodePathSegment('%'), '%25', 'encodePathSegment 百分号');

    // 语义断言：放进完整 URL 里，`?`/`#`/`/` 都不得改变结构
    const parsed = new URL(Api.photoUrl('a/b?c', 'd#e/f'), 'http://localhost');
    eqScalar(parsed.search, '', "token/ref 里的 '?' 不得开启 query");
    eqScalar(parsed.hash, '', "token/ref 里的 '#' 不得开启 fragment");
    eqJson(
      parsed.pathname.split('/'),
      ['', 'api', 'technician', 'visits', 'a%2Fb%3Fc', 'photos', 'd%23e%2Ff'],
      '路径段',
    );

    // 渲染路径上**零抛错**（抛错 = 整页白屏，比 404 难查得多）
    for (const [token, ref] of [
      ['', ''],
      ['a b', 'c d'],
      ['中文', '中文'],
    ]) {
      Api.photoUrl(token, ref);
    }
    return '5 条编码契约 + path/query/fragment 语义 + 渲染路径零抛错';
  });

  await checkAsync('客户端真发的每条 URL 都能被 nginx 的 rewrite 接住（跨层契约）', async () => {
    // "客户端拼对了"与"nginx 真能接住"是**两件事**。任何一边改了而另一边没改，
    // 现象都是照片 404 / 上传失败 / 提交失败 —— 而且**不报错**，
    // 只在 nginx 日志里留一条看起来毫不相干的记录（DEV-18 那个坑的同一形状）。
    // 所以这里把 nginx 的 rewrite 正则读出来，拿客户端**真发出去的** URL 去跑。
    const conf = fs.readFileSync(path.join(ROOT, 'nginx', 'conf.d', 'service.conf'), 'utf8');
    const rewrites = new Map();
    for (const m of conf.matchAll(/rewrite\s+"([^"]+)"\s+\/api\/technicianVisit:(\w+)\?/g)) {
      rewrites.set(m[2], new RegExp(m[1]));
    }
    eqJson(
      [...rewrites.keys()].sort(),
      ['get', 'photo', 'submit', 'upload'],
      'nginx 里师傅接口的 rewrite 动作集合（应显式枚举四条）',
    );

    // ⚠️ 长度**从 nginx 正则里读出来**：客户端不复制 43/22，这个脚本也不复制。
    //    复制了就是"同一个常量两个副本"，它一漂移，检查反而会替漂移背书。
    const tokenLen = Number([...rewrites.get('get').source.matchAll(/\{(\d+)\}/g)][0][1]);
    const photoLens = [...rewrites.get('photo').source.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));
    eqScalar(photoLens.length, 2, 'photo 的 rewrite 应有两处长度限制（token 与 ref）');
    const [photoTokenLen, refLen] = photoLens;
    eqScalar(photoTokenLen, tokenLen, '同一个 token 在两条 rewrite 里的长度必须一致');
    const token = 'A'.repeat(tokenLen);
    const ref = 'b'.repeat(refLen);

    // 用 fake fetch 抓**真正会跑的那份代码**拼出来的 URL
    const urls = [];
    const fakeFetch = async (url) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({ data: { photo: { ref, photos_count: 1, max_photos: 6 } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    await Api.fetchVisitContext(token, { fetchImpl: fakeFetch });
    await Api.uploadPhoto(
      token,
      new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'a.jpg', { type: 'image/jpeg' }),
      'onsite',
      { fetchImpl: fakeFetch },
    );
    await Api.submitReceipt(
      token,
      { service_result: 'resolved', service_note: 'n', is_charged: false, reported_charge_amount: null },
      { fetchImpl: fakeFetch },
    );

    eqScalar(urls.length, 3, '客户端发起的请求数');
    const hit = urls.map((url) => [...rewrites.entries()].find(([, re]) => re.test(url))?.[0] ?? null);
    eqJson(hit, ['get', 'upload', 'submit'], 'get/upload/submit 三条各自命中的 rewrite');
    assertThat(
      rewrites.get('photo').test(Api.photoUrl(token, ref)),
      'photoUrl 没能命中 photo 的 rewrite —— 师傅会看不到自己刚传的照片',
    );
    return `四条 URL 全部被 nginx 接住（token ${tokenLen} 位 / ref ${refLen} 位，长度读自 nginx 配置）`;
  });

  await checkAsync('提交报文逐字段：不收费时 reported_charge_amount 必须**显式为 null**', async () => {
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          data: {
            ticket_no: 'FW-TEST',
            status: 'WAIT_STORE_CONFIRM',
            visit_status: 'SUBMITTED',
            store_confirm_status: 'pending',
            message: '已提交，等待门店确认',
            submitted_at: '2026-09-23T12:00:00.000Z',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const out = await Api.submitReceipt(
      'A'.repeat(43),
      {
        service_result: 'resolved',
        service_note: '已更换排水泵',
        is_charged: false,
        // 故意传一个残留金额：不收费时它**必须**在报文里变成 null
        reported_charge_amount: 300,
      },
      { fetchImpl: fakeFetch },
    );
    eqScalar(calls.length, 1, 'HTTP 调用次数');
    eqScalar(calls[0].url, `/api/technician/visits/${'A'.repeat(43)}/submit`, '请求 URL');
    eqScalar(calls[0].init.method, 'POST', 'method');
    const body = JSON.parse(calls[0].init.body);
    // ⚠️ 这一条就是 DEV-77 的现场：字段集合必须比**结构**，不能比引用
    eqJson(
      Object.keys(body).sort(),
      ['is_charged', 'reported_charge_amount', 'service_note', 'service_result'],
      '报文字段集合',
    );
    eqScalar(body.reported_charge_amount, null, '不收费时金额（必须显式 null，不能省略字段）');
    eqScalar(body.is_charged, false, 'is_charged');
    // 请求头不得带请求号（与【1】的封条互相印证）
    assertThat(
      !Object.keys(calls[0].init.headers ?? {}).some((h) => /request-id/i.test(h)),
      '提交请求头里带了 request-id',
    );
    eqScalar(out.message, '已提交，等待门店确认', '返回的终态文案');
    return '4 个字段、金额 null、无请求号';
  });

  await checkAsync('收费时金额按数值发送，且 401 会被转成 ApiError', async () => {
    let seen = null;
    await Api.submitReceipt(
      'B'.repeat(43),
      { service_result: 'resolved', service_note: 'x', is_charged: true, reported_charge_amount: 128.5 },
      {
        fetchImpl: async (_url, init) => {
          seen = JSON.parse(init.body);
          return new Response(JSON.stringify({ data: { message: '已提交，等待门店确认' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
    );
    eqScalar(seen.reported_charge_amount, 128.5, '收费时的金额');

    let caught = null;
    try {
      await Api.submitReceipt(
        'B'.repeat(43),
        { service_result: 'resolved', service_note: 'x', is_charged: false, reported_charge_amount: null },
        {
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                errors: [{ code: 'TOKEN_INVALID', message: '链接无效或已失效，请联系门店重新获取' }],
              }),
              { status: 401, headers: { 'Content-Type': 'application/json' } },
            ),
        },
      );
    } catch (error) {
      caught = error;
    }
    assertThat(caught, '401 必须抛错（不能静默成功）');
    eqScalar(caught.status, 401, '错误 status');
    eqScalar(caught.code, 'TOKEN_INVALID', '错误 code');
    return '金额按数值发送；401 → ApiError(401, TOKEN_INVALID)';
  });

  await checkAsync('上传走 multipart 且**不手写** Content-Type（手写会丢 boundary）', async () => {
    let seen = null;
    const fakeFetch = async (url, init) => {
      seen = { url, init };
      return new Response(
        JSON.stringify({
          data: {
            photo: { ref: 'r'.repeat(22), photo_type: 'onsite', mime: 'image/jpeg', size: 123 },
            photos_count: 1,
            max_photos: 6,
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'onsite.jpg', { type: 'image/jpeg' });
    const result = await Api.uploadPhoto('C'.repeat(43), file, 'onsite', { fetchImpl: fakeFetch });

    eqScalar(seen.url, `/api/technician/visits/${'C'.repeat(43)}/files`, '上传 URL');
    eqScalar(seen.init.method, 'POST', 'method');
    assertThat(seen.init.body instanceof FormData, 'body 必须是 FormData');
    eqScalar(seen.init.body.get('photo_type'), 'onsite', 'photo_type 字段');
    assertThat(seen.init.body.get('file') instanceof File, 'file 字段必须存在');
    // ⚠️ 这一条是重点：**不能**出现 Content-Type。
    //    手写 `multipart/form-data` 会把 boundary 丢掉 → 服务端解析失败，
    //    而现象只是"上传失败"，极难指向真正的原因。
    const headers = seen.init.headers ?? {};
    assertThat(
      !Object.keys(headers).some((h) => /content-type/i.test(h)),
      `上传请求手写了 Content-Type（${JSON.stringify(headers)}）—— boundary 会丢，服务端解析必然失败`,
    );
    return `FormData(file, photo_type)；Content-Type 交给浏览器补 boundary；ref=${result.photo.ref}`;
  });

  await checkAsync('上传失败时把服务端错误码原样带出（页面据此区分 401 与 422）', async () => {
    let caught = null;
    try {
      await Api.uploadPhoto('D'.repeat(43), new File([new Uint8Array([1])], 'x.jpg'), null, {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ errors: [{ code: 'PHOTO_LIMIT_REACHED', message: '本次上门最多上传 6 张照片' }] }),
            { status: 422, headers: { 'Content-Type': 'application/json' } },
          ),
      });
    } catch (error) {
      caught = error;
    }
    assertThat(caught, '上传失败必须抛错');
    eqScalar(caught.status, 422, 'status');
    eqScalar(caught.code, 'PHOTO_LIMIT_REACHED', 'code');
    return '422 PHOTO_LIMIT_REACHED 原样透出';
  });

  // =========================================================================
  console.log('\n【3】路由行为（注入 window 后加载 router.ts）');

  const routerOut = await bundleWith(esbuild, {
    h5Dir: H5,
    outDir: TMP,
    name: 'router',
    entryRelative: ROUTER,
    // router.ts 读 import.meta.env.BASE_URL —— 离线环境里必须显式注入，
    // 值必须与 h5/vite.config.ts 的 base 一致（'/h5/'），否则剥 base 的行为就测错了
    extra: { define: { 'import.meta.env.BASE_URL': '"/h5/"' } },
  });

  const requireRouter = createRequire(import.meta.url);

  /** 在给定的浏览器路径下加载 router，返回 RouteState */
  function routeAt(pathname, search = '') {
    // router.ts 在**模块加载时**就会读 window.location 并注册 popstate，
    // 所以每次都必须清掉 require 缓存、重设 window，才能测到不同路径。
    delete requireRouter.cache[requireRouter.resolve(routerOut)];
    globalThis.window = {
      location: { pathname, search },
      addEventListener() {},
      history: { pushState() {}, replaceState() {} },
    };
    return requireRouter(routerOut).useRoute().value;
  }

  check('识别 /h5/technician/visit/<token> → name=technician-visit、params.token 已剥离', () => {
    const token = 'Zm9yZ2VkLXRva2VuLTEyMzQ1Njc4OTAxMjM0NTY3ODkw';
    const state = routeAt(`/h5/technician/visit/${token}`);
    eqScalar(state.name, 'technician-visit', 'name');
    eqScalar(state.params.token, token, 'params.token');
    eqScalar(state.path, `/technician/visit/${token}`, 'path（已剥离 /h5）');
    return `name=${state.name}，token 长度 ${state.params.token.length}`;
  });

  check('不把畸形路径误判成作业页（少 token / 含非法字符 / 多余段）', () => {
    const cases = [
      ['/h5/technician/visit', '缺少 token 段'],
      ['/h5/technician/visit/a b c', '含空格'],
      ['/h5/technician/visit/abc/extra', '多了一段'],
      ['/h5/technician/', '只有前缀'],
      ['/h5/report', '是报修页'],
    ];
    for (const [pathname, why] of cases) {
      eqScalar(routeAt(pathname).name, null, `${pathname}（${why}）不应命中作业页`);
    }
    // 反向自检：绝不能"所有路径都返回 null"（那样这条断言什么都没验）
    eqScalar(routeAt(`/h5/technician/visit/${'x'.repeat(43)}`).name, 'technician-visit', '反向自检：合法路径必须命中');
    return `${cases.length} 种畸形路径被排除；合法路径仍命中`;
  });

  // =========================================================================
  console.log('');

  if (failures.length === 0) {
    console.log(LINE);
    console.log(`  ✅ 全部通过：${passed} 项（含 fixture 自检 ${fixtureResult.passed} 条）`);
    console.log(LINE);
    console.log('');
    process.exit(0);
  }
  console.log(LINE);
  console.log(`  ❌ 失败 ${failures.length} 项 / 通过 ${passed} 项`);
  for (const f of failures) console.log(`     · ${f.label}: ${f.message}`);
  console.log(LINE);
  console.log('');
  process.exit(1);
}

main().catch((error) => {
  console.error('[verify-technician-h5] 脚本异常：');
  console.error(error);
  process.exit(2);
});
