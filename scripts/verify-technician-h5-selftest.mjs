#!/usr/bin/env node
/**
 * verify-technician-h5-selftest.mjs —— **验证器自己的验证器**（fixture 层）
 * =============================================================================
 *
 * 这一层存在的理由，是 P5-1 里连着出现的四次「产品没错、checker 错了」：
 * DEV-76（正则吞模板）· DEV-77（`eq` 用 `!==` 比数组）·
 * DEV-78（终态文案只扫单引号字面量）· DEV-79（渲染路径上 throw）。
 *
 * 这四个坑如果只写进经验文档，下一次换个人、换个文件会一模一样地再踩一遍。
 * 所以它们必须变成**机器免疫**：每一次"checker 错了"，都往这里加一条 fixture。
 *
 * -----------------------------------------------------------------------------
 * fixture 的形态：**双向判定**
 * -----------------------------------------------------------------------------
 * 每条 fixture 提供一个"判定函数" `verdict(input) -> boolean`（true = 判为违规），
 * 然后同时喂两组输入：
 *
 *     accept: [...]  → verdict 必须为 **false**（应通过）
 *     reject: [...]  → verdict 必须为 **true** （应拒绝）
 *     realSources    → 还要拿**真实源码**喂一遍，必须为 false（真实代码不得被判违规）
 *
 * 为什么强制双向：只跑一边的话，"永远返回 true 的 checker" 或
 * "永远返回 false 的 checker" 都能全绿 —— 那正是假绿的标准形态（铁律 10）。
 *
 * ⚠️ `realSources` 是**必须**的补充（本机实测教训）：只用合成输入喂 fixture，
 *    规则本身可以被测得很漂亮，而**真实源码违反它**却照样全绿 ——
 *    DEV-80（金额字段 `.trim()`）第一次加进来时就是这样逃逸的：
 *    fixture 有 accept/reject、两个方向都对，但因为没人拿真的 Visit.vue 去跑，
 *    把真实代码改回 `.trim()` **一条都不红**。
 *    所以凡是有对应源码的规则，都要声明 realSources。
 *
 * -----------------------------------------------------------------------------
 * 用法 / 退出码
 * -----------------------------------------------------------------------------
 *   node scripts/verify-technician-h5-selftest.mjs
 *     → 0 全绿 / 1 有 fixture 红 / 2 环境未就绪（缺 esbuild，只有集成类 fixture 需要）
 *
 * 也可以被 `verify-technician-h5.mjs` import 后当作【0】组跑：
 *     const { runFixtures } = await import('./verify-technician-h5-selftest.mjs');
 *     const result = await runFixtures({ Api, log });
 * 这样"门禁"与"门禁的自检"用的是同一份 fixture，不会各有一套。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  assertThat,
  eqJson,
  eqScalar,
  extractUserVisibleText,
  findTerminalCopyViolations,
  splitSfc,
  stripJsComments,
  stripSourceComments,
  TERMINAL_COPY_POLICY,
  loadEsbuild,
  bundleWith,
} from './lib/h5-contracts.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const H5 = path.join(ROOT, 'h5');
const TMP = path.join(ROOT, '.tmp-verify', 'p5-h5-selftest');
const NODE_WORKSPACE = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.workbuddy',
  'binaries',
  'node',
  'workspace',
);

const SFC = 'src/pages/Technician/Visit.vue';
const API = 'src/api/technician.ts';

const REAL_SFC = fs.readFileSync(path.join(H5, SFC), 'utf8');
const REAL_API = fs.readFileSync(path.join(H5, API), 'utf8');

/**
 * 终态判定的**判定函数**（所有 fixture 共用同一份实现 —— 就是产品用的那份）。
 * ⚠️ `kind` **必须**传对：`.vue` 与 `.ts` 的注释语法不同，拿错就等于没剥注释。
 */
const terminalVerdict = (source, kind = 'vue') =>
  findTerminalCopyViolations(extractUserVisibleText(source, kind)).length > 0;

const wrap = (body) => `<template>${body}</template>`;

/**
 * 说明字段「条件必填」的**判定函数**（DEV-82，用户 2026-09-25 拍板）。
 *
 * 口径：`resolved` 可留空、其余结果必填。但**"哪些结果可留空"这件事必须来自
 * 服务端下发**的 `note_required` —— 页面不得自己抄一份（抄了就会与后端漂移，
 * 而漂移的两边都不报错，正是 DEV-58/59 的教训形态）。
 *
 * 判为**违规（true）**，当且仅当下面任一成立：
 *   ① 页面根本没消费 `note_required`（硬编码成"一律必填"，即改动前的形态）；
 *   ② 消费了却没有把它接进提交闸门（`canSubmit` 里没有 `!noteRequired`）
 *      —— "读了但没用"，效果与无条件必填完全相同。
 *
 * ⚠️ 刻意**不**拿 `form.service_note.trim().length > 0` 当"无条件必填"的判据：
 *    那个片段在页面上还有别的正当用途（字数徽标、提交前二次提示），
 *    用它当判据会制造假红，进而被人把整条检查注释掉。见下面 accept 里的守门员。
 */
const noteRuleVerdict = (src, kind = 'vue') => {
  const code = stripSourceComments(src, kind);
  const consumesServerRule = /note_required/.test(code);
  const gateFollowsRule = /!\s*noteRequired/.test(code);
  return !(consumesServerRule && gateFollowsRule);
};

// =============================================================================
//  双向 fixture 表
// =============================================================================
const VERDICT_FIXTURES = [
  {
    id: 'TERMINAL-COPY',
    title: '终态文案：禁用短语/句式必抓，且**不**做关键词猎杀',
    realSources: ['vue', 'ts'],
    realEvidence: (src, kind) => extractUserVisibleText(src, kind).length,
    verdict: (src, kind = 'vue') => terminalVerdict(src, kind),
    accept: [
      wrap('<h1>已提交，等待门店确认</h1>'),
      wrap('<p>提交成功</p>'),
      // ⚠️ 这条是**假红守门员**：全局禁掉"完成"这个词就会把它误杀，
      //    然后整条检查会被人注释掉 —— 那才是真正的失守。
      wrap('<p>请完成以下信息后再提交</p>'),
      wrap('<p>已完成实名认证的师傅可直接进场</p>'),
      // 注释里的禁用词不算可见文案
      wrap('<!-- 工单已完成 --><p>已提交</p>'),
      '<template><p>已提交</p></template><script>\n// 服务已完成\n/* 维修已完成 */\n</script>',
    ],
    reject: [
      wrap('<h1>工单已完成</h1>'),
      wrap('<h1>服务已完成</h1>'),
      wrap('<h1>维修已完成</h1>'),
      wrap('<h1>已关闭</h1>'),
      // 句式（词之间可以有空白）
      wrap('<p>工单 已完成</p>'),
      // 属性值也是用户可见的
      wrap('<input placeholder="维修已完成？" />'),
      // 插值里的字面量同样是可见文案
      wrap("<p>{{ ok ? '工单已完成' : '已提交' }}</p>"),
    ],
  },
  {
    id: 'CUSTOMER-FIELDS',
    title: '最小信息：客户字段名出现即违规（但注释里提到不算）',
    realSources: ['vue', 'ts'],
    realEvidence: (src, kind) => stripSourceComments(src, kind).length,
    verdict: (src, kind = 'vue') =>
      ['customer_mobile', 'customer_name', 'customer_phone', 'customer_tel', 'customer_address'].some(
        (word) => stripSourceComments(src, kind).includes(word),
      ),
    accept: [
      wrap('<span>{{ ctx.ticket_no }}</span><span>{{ ctx.store_name }}</span>'),
      // 注释里出现字段名（解释"为什么不带客户资料"）不得算违规，
      // 否则那条注释会被删掉 —— 而注释是下一个人的护栏。
      wrap('<!-- 刻意不带 customer_mobile / customer_name --><p>上门作业</p>'),
    ],
    reject: [
      wrap('<span>{{ ctx.customer_mobile }}</span>'),
      wrap('<span>{{ ctx.customer_name }}</span>'),
      '<template><p>x</p></template><script>const a = row.customer_phone;</script>',
    ],
  },
  {
    id: 'AMOUNT-READ',
    title: 'DEV-80：金额字段不得被当字符串读（Vue 的 type=number v-model 会变 number）',
    realSources: ['vue'],
    realEvidence: (src, kind) => stripSourceComments(src, kind).length,
    verdict: (src, kind = 'vue') =>
      /form\.reported_charge_amount\s*\.\s*[A-Za-z_$]/.test(stripSourceComments(src, kind)),
    accept: [
      wrap('<input type="number" v-model="form.reported_charge_amount" />'),
      wrap('<p>{{ toAmount(form.reported_charge_amount) }}</p>'),
      '<template><p>x</p></template><script>\nform.reported_charge_amount = \'\';\n</script>',
      // 读取入口内部拿到的是参数，不是字段本身
      '<template><p>x</p></template><script>function amountText(v) { return String(v ?? \'\').trim(); }</script>',
    ],
    reject: [
      // ← 当年真实写下的那一行
      '<template><p>x</p></template><script>const raw = form.reported_charge_amount.trim();</script>',
      '<template><p>x</p></template><script>if (form.reported_charge_amount.length > 3) {}</script>',
    ],
  },
  {
    id: 'NOTE-CONDITIONAL',
    title: 'DEV-82：说明**条件必填** —— 规则必须来自服务端 `note_required`，且真接进提交闸门',
    realSources: ['vue'],
    realEvidence: (src, kind) => stripSourceComments(src, kind).length,
    verdict: noteRuleVerdict,
    accept: [
      // 产品当前实现的最简形态：读服务端规则 + 用 !noteRequired 放宽闸门
      '<template><label>处理说明'
        + '<span v-if="noteRequired" class="svc-req">*</span>'
        + '<span v-else class="svc-opt">（选填）</span></label>'
        + '<textarea v-model="form.service_note" maxlength="500"></textarea></template>'
        + '<script setup lang="ts">'
        + 'const noteRequired = computed(() => ctx?.service_results?.find((o) => o.value === form.service_result)?.note_required ?? true);'
        + 'const canSubmit = computed(() => (!noteRequired.value || form.service_note.trim().length > 0));'
        + '</script>',
      // 同一口径的另一种写法（options 先落到变量上）也必须是 PASS ——
      // 判定抓的是"读没读、接没接进闸门"，不是某一种代码形状。
      '<template><textarea maxlength="500" v-model="form.service_note"></textarea></template>'
        + '<script setup lang="ts">'
        + 'const option = ctx.service_results.find((o) => o.value === form.service_result);'
        + 'const noteRequired = computed(() => option?.note_required ?? true);'
        + 'const canSubmit = computed(() => !noteRequired.value || !!form.service_note.trim());'
        + '</script>',
      // ⚠️ 假红守门员：`form.service_note.trim().length > 0` 在别处有正当用途
      //    （这里是字数徽标）。规则若拿这个片段当"无条件必填"的判据就会误杀它，
      //    然后整条检查会被人注释掉 —— 那才是真正的失守。
      '<template><span>{{ form.service_note.trim().length > 0 ? "已填" : "未填" }}</span>'
        + '<textarea maxlength="500" v-model="form.service_note"></textarea></template>'
        + '<script setup lang="ts">'
        + 'const noteRequired = computed(() => opt?.note_required ?? true);'
        + 'const canSubmit = computed(() => !noteRequired.value || form.service_note.trim().length > 0);'
        + '</script>',
    ],
    reject: [
      // ① 改动前的真实形态：说明**无条件必填**（就是本次要消灭的那行）
      '<template><label>处理说明 *</label><textarea maxlength="500" v-model="form.service_note"></textarea></template>'
        + '<script setup lang="ts">const canSubmit = computed(() => form.service_note.trim().length > 0);</script>',
      // ② 另一个方向的硬编码：一律可选（把服务端口径抄成了"永远不要"）
      '<template><label>处理说明（选填）</label><textarea maxlength="500" v-model="form.service_note"></textarea></template>'
        + '<script setup lang="ts">const canSubmit = computed(() => true);</script>',
      // ③ "读了但没用"：消费了 note_required，闸门却仍是无条件必填
      '<template><textarea maxlength="500" v-model="form.service_note"></textarea></template>'
        + '<script setup lang="ts">const opts = ctx.service_results;const canSubmit = computed(() => opts.length > 0 && form.service_note.trim().length > 0);</script>',
      // ④ 只在**注释**里提到 note_required（剥注释后等于没读）也必须是违规
      '<template><textarea maxlength="500" v-model="form.service_note"></textarea></template>'
        + '<script setup lang="ts">// service_results 里带 note_required\nconst canSubmit = computed(() => form.service_note.trim().length > 0);</script>',
    ],
  },
  {
    id: 'REQUEST-ID',
    title: '师傅接口不发 X-Request-Id（一次性 Token 就是提交边界）',
    realSources: ['ts'],
    realEvidence: (src, kind) => stripSourceComments(src, kind).length,
    verdict: (src, kind = 'ts') => /X-Request-Id|requestId/.test(stripSourceComments(src, kind)),
    accept: ["fetch(url, { method: 'POST' });", "const h = { Accept: 'application/json' };"],
    reject: ["fetch(url, { headers: { 'X-Request-Id': id } });", 'const requestId = uuid();'],
  },
];

// =============================================================================
//  单条 fixture（不是双向表，而是"某个坑的最小复现"）
// =============================================================================
const SINGLE_FIXTURES = [
  {
    id: 'DEV-76',
    title: '注释剥离：真注释必须消失、`accept="image/*"` 绝不能消失',
    run: () => {
      // 同一份输入里**同时**放真注释与 image/*，两个方向一起验
      const source = [
        '<template>',
        '  <input accept="image/*" @change="onPick" />',
        '  <!-- 这里提到 工单已完成，但它只是注释 -->',
        '</template>',
        '<script setup lang="ts">',
        '/* 这里提到 服务已完成，也是注释 */',
        '// 这里提到 已关闭',
        "const dataUrl = 'http://example.test/x';",
        "const mime = 'image/*';",
        'const keep = 1;',
        '</script>',
      ].join('\n');

      const stripped = stripSourceComments(source, 'vue');

      // ① 代码必须存活（当年就是这里被吃掉的）
      assertThat(
        stripped.includes('accept="image/*"'),
        '`accept="image/*"` 被当作块注释起点吃掉了 —— DEV-76 复发',
      );
      assertThat(stripped.includes("'image/*'"), '字符串里的 `/*` 被吃掉 —— 依赖字符串的断言会假绿');
      assertThat(stripped.includes("'http://example.test/x'"), '字符串里的 `//` 被吃掉');
      assertThat(stripped.includes('const keep = 1;'), '普通代码行被吃掉');
      assertThat(stripped.includes('@change="onPick"'), '同一标签上的后续属性被吃掉');

      // ② 注释必须消失
      assertThat(!/工单已完成/.test(stripped), 'HTML 注释没剥干净');
      assertThat(!/服务已完成/.test(stripped), '块注释没剥干净');
      assertThat(!/已关闭/.test(stripped), '行注释没剥干净');

      // ③ 字节长度与行结构与源文件**严格一致**（否则报错里的行号就没法用来定位）
      eqScalar(stripped.length, source.length, '剥离后字节长度');
      eqScalar(stripped.split('\n').length, source.split('\n').length, '剥离后行数');
      eqScalar(
        stripJsComments(source).split('\n').length,
        source.split('\n').length,
        '单独用 JS 扫描器时的行数',
      );

      // ④ 双向：这份源码整体必须判 PASS（注释里的禁用词不算违规）
      assertThat(
        !terminalVerdict(source),
        '注释里的禁用词被算成了可见文案 —— 会制造假红，进而被人把整条检查注释掉',
      );

      // ⑤ 把注释换成**真文案** → 必须立刻变红
      const mutated = source.replace(
        '<!-- 这里提到 工单已完成，但它只是注释 -->',
        '<h1>工单已完成</h1>',
      );
      assertThat(mutated !== source, 'fixture 变异没生效（锚点没找到）—— 这条 fixture 白跑');
      assertThat(terminalVerdict(mutated), '把注释换成真文案后没被抓到 —— DEV-78 复发');
    },
  },
  {
    id: 'DEV-76b',
    title: '根模板里嵌套 <template v-if> 不能被截断',
    run: () => {
      // 用正则配平 `<template>...</template>` 会在第一个内层 `</template>` 处收工，
      // 模板后半段（终态分支）就"合法地"看不见了 —— 与 DEV-76 同一类失效。
      const source = [
        '<template>',
        '  <template v-if="view === \'loading\'">',
        '    <p>正在读取</p>',
        '  </template>',
        '  <template v-else-if="view === \'success\'">',
        '    <h1>工单已完成</h1>',
        '  </template>',
        '</template>',
        '<script setup lang="ts">const x = 1;</script>',
      ].join('\n');

      const { template, script } = splitSfc(source);
      assertThat(template.includes('view ==='), '根模板没被切出来');
      assertThat(!script.includes('<template'), 'script 区混进了模板内容');
      // 关键：**终态分支在后半段**，它必须被看见
      assertThat(
        template.includes('工单已完成'),
        '嵌套 <template> 把根模板截断了 —— 终态分支落在被截掉的那半段里',
      );
      assertThat(terminalVerdict(source), '被截断的模板让这条违规逃过了判定');
    },
  },
  {
    id: 'DEV-77',
    title: 'eqScalar / eqJson 语义：结构相同必须 PASS、元素不同必须 FAIL',
    run: () => {
      // ① 两个**独立创建**、内容相同的数组 → 必须 PASS
      const left = ['is_charged', 'reported_charge_amount', 'service_note', 'service_result'];
      const right = JSON.parse(JSON.stringify(left).replace(/\n/g, '')); // 另一次独立创建
      eqJson(left, right, '独立创建的同内容数组');
      eqJson(['a', 'b'], [['a', 'b']][0], '来源不同的同内容数组');
      eqJson({ x: 1, y: 2 }, { y: 2, x: 1 }, '键顺序不同的同内容对象');

      // ② 元素不同 / 长度不同 → 必须 FAIL
      const mustFail = [
        [['a', 'b'], ['a', 'c'], '元素不同'],
        [{ x: 1 }, { x: 2 }, '对象值不同'],
        [['a'], ['a', 'b'], '长度不同'],
        [['a', 'b'], ['b', 'a'], '顺序不同（本原语刻意顺序敏感）'],
      ];
      for (const [a, b, why] of mustFail) {
        let threw = false;
        try {
          eqJson(a, b, 'self');
        } catch {
          threw = true;
        }
        assertThat(threw, `eqJson 没变红（${why}）：${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
      }

      // ③ 标量必须**严格**：'1' 与 1 不是一回事
      eqScalar(1, 1, 'self');
      eqScalar(null, null, 'self');
      eqScalar(false, false, 'self');
      for (const [a, b, why] of [
        ['1', 1, "字符串 '1' vs 数字 1"],
        [0, false, '0 vs false'],
        ['', null, '空串 vs null'],
      ]) {
        let threw = false;
        try {
          eqScalar(a, b, 'self');
        } catch {
          threw = true;
        }
        assertThat(threw, `eqScalar 不够严格（${why}）`);
      }

      // ④ 记录当年那个 bug 的形态：`!==` 对结构值恒为真 → 断言**永不可能通过**
      const naiveWouldAlwaysThrow = Object.keys({ a: 1, b: 2 }).sort() !== ['a', 'b'];
      assertThat(naiveWouldAlwaysThrow, 'DEV-77 的最小复现应仍然成立（否则说明 JS 语义变了）');
    },
  },
  {
    id: 'REAL-PASS',
    title: '真实源码必须判 PASS（checker 不得误报产品）',
    run: () => {
      const page = findTerminalCopyViolations(extractUserVisibleText(REAL_SFC, 'vue'));
      const api = findTerminalCopyViolations(extractUserVisibleText(REAL_API, 'ts'));
      assertThat(page.length === 0, `真实页面被判违规：${JSON.stringify(page)}`);
      assertThat(api.length === 0, `真实 API 模块被判违规：${JSON.stringify(api)}`);
      // 反向自检：如果提取器"什么都提不到"，上面两条会**假绿**
      const texts = extractUserVisibleText(REAL_SFC, 'vue');
      assertThat(texts.length >= 20, `只从页面提取到 ${texts.length} 段文案 —— 提取器可能坏了`);
      assertThat(
        texts.some((t) => t.text.includes('等待门店确认')),
        '页面里提取不到终态文案 —— 提取器没覆盖到终态分支',
      );
    },
  },
  {
    id: 'DEV-79',
    title: 'URL 编码是纯函数：特殊字符不得改变 path/query 语义',
    requires: 'api',
    run: ({ Api }) => {
      // ① 渲染路径：畸形输入**不许抛**（抛了就是白屏）
      for (const [token, ref] of [
        ['', ''],
        ['a b', 'c d'],
        ['中文', '中文'],
        ['a/b', 'a?b'],
      ]) {
        Api.photoUrl(token, ref);
      }

      // ② 直接断言纯函数（不再靠页面渲染间接证明）
      eqScalar(Api.encodePathSegment('a b'), 'a%20b', 'encodePathSegment 空格');
      eqScalar(Api.encodePathSegment('a/b'), 'a%2Fb', 'encodePathSegment 斜杠');
      eqScalar(Api.encodePathSegment('a?b'), 'a%3Fb', 'encodePathSegment 问号');
      eqScalar(Api.encodePathSegment('a#b'), 'a%23b', 'encodePathSegment 井号');
      eqScalar(Api.encodePathSegment('%'), '%25', 'encodePathSegment 百分号');
      eqScalar(Api.encodePathSegment('a&b=c'), 'a%26b%3Dc', 'encodePathSegment 与号/等号');

      // ③ 语义断言：放进完整 URL 里，`?`/`#`/`/` 都不得改变结构
      const evil = Api.photoUrl('a/b?c', 'd#e/f');
      const parsed = new URL(evil, 'http://localhost');
      eqScalar(parsed.search, '', "token/ref 里的 '?' 不得开启 query");
      eqScalar(parsed.hash, '', "token/ref 里的 '#' 不得开启 fragment");
      eqJson(
        parsed.pathname.split('/'),
        ['', 'api', 'technician', 'visits', 'a%2Fb%3Fc', 'photos', 'd%23e%2Ff'],
        '路径段（'/' 必须仍在段内）',
      );

      // ④ 边界闸：坏 ref 必须**在进入渲染层之前**就被判掉
      assertThat(Api.isValidPhotoRef('b'.repeat(22)), '合法 ref 被判成非法');
      for (const bad of ['', 'a b', 'a/b', 'a?b', 'a#b', '中文', null, undefined, 42]) {
        assertThat(!Api.isValidPhotoRef(bad), `坏 ref 逃过形态闸：${JSON.stringify(bad)}`);
      }
    },
  },
  {
    id: 'DEV-82',
    title: '说明条件必填：真源码必须 PASS；把提交闸门改回「无条件必填」⇒ 必须立刻变红',
    run: () => {
      // ① 真源码现状：读服务端 `note_required` + 闸门用 `!noteRequired` → 必须判 PASS
      assertThat(
        !noteRuleVerdict(REAL_SFC, 'vue'),
        '真实 Visit.vue 被判成"说明无条件必填 / 没读服务端规则" —— 要么实现回退了，要么判定太宽',
      );

      // ② 反向自检（DEV-80 那条 fixture 的同一招式）：把闸门改回本次之前的写法，
      //    判定**必须**变红 —— 否则这条 fixture 只是"看着在跑"，实现回退不会被抓。
      const anchor = '!noteRequired.value || ';
      assertThat(REAL_SFC.includes(anchor), `真源码里找不到锚点「${anchor}」—— fixture 需要更新`);
      const mutated = REAL_SFC.replace(anchor, '');
      assertThat(mutated !== REAL_SFC, '变异没生效 —— 这条 fixture 白跑');
      assertThat(
        noteRuleVerdict(mutated, 'vue'),
        '把提交闸门改回"无条件必填说明"却没被抓到 —— DEV-82 会静默复发',
      );

      // ③ 另一条回退路径：连服务端下发的 `note_required` 一起删掉（改成前端硬编码）
      const mutated2 = REAL_SFC.replaceAll('note_required', 'x_removed_x');
      assertThat(mutated2 !== REAL_SFC, '变异没生效（锚点没找到）—— 这条 fixture 白跑');
      assertThat(
        noteRuleVerdict(mutated2, 'vue'),
        '删掉服务端下发的 `note_required`（前端自己判必填）却没被抓到',
      );
    },
  },
];

// -----------------------------------------------------------------------------
//  真实源码变异：把终态文案逐条换成禁用短语，checker 必须变红
// -----------------------------------------------------------------------------
const MUTATION_FIXTURES = TERMINAL_COPY_POLICY.forbidden.map((phrase) => ({
  id: `MUT-${phrase}`,
  title: `真实源码把终态文案改成「${phrase}」→ 必须变红`,
  run: () => {
    const anchor = '已提交，等待门店确认';
    assertThat(REAL_SFC.includes(anchor), `页面里找不到锚点「${anchor}」—— fixture 需要更新`);
    // replaceAll：这个短语在页面里**出现过两次** —— 一次在**注释**里解释口径，
    // 一次在模板里真的渲染。只替第一处会打在注释上，于是"变异成功"但检查不变红：
    // 一条看似在跑、其实什么都没测的 fixture。
    const mutated = REAL_SFC.replaceAll(anchor, phrase);
    assertThat(mutated !== REAL_SFC, '变异没生效 —— 这条 fixture 白跑');
    // ⚠️ 自检：变异必须落在**可见文案**上（不是只改到注释里）。
    //    这就是上面那个坑的机器化守卫 —— 一旦只改到注释，这条会立刻红，
    //    而不是让整条 fixture 静默退化成"通过"。
    assertThat(
      extractUserVisibleText(mutated, 'vue').some((t) => t.text.includes(phrase)),
      `变异没落到可见文案上（只改到了注释？）—— fixture 白跑`,
    );

    const violations = findTerminalCopyViolations(extractUserVisibleText(mutated, 'vue'));
    assertThat(violations.length > 0, `把终态文案写成「${phrase}」却没被抓到 —— 检查是假的`);
  },
}));

// =============================================================================
//  运行器
// =============================================================================

function makeLog(collector, quiet) {
  return (line) => {
    if (collector) collector.push(line);
    if (!quiet) console.log(line);
  };
}

/**
 * 跑全部 fixture。
 * @param {{ Api?: object, log?: (line:string)=>void, quiet?: boolean }} options
 *        Api —— 已 bundle 的 `h5/src/api/technician.ts`。
 *               不传的话本函数会**自己 build 一个**（standalone 用法）；
 *               传给门禁时可以复用门禁已经 build 好的那份，省一次 esbuild。
 */
export async function runFixtures({ Api = null, log = (line) => console.log(line), quiet = false } = {}) {
  let passed = 0;
  const failures = [];
  const needsApi = [...SINGLE_FIXTURES].some((f) => f.requires === 'api');

  let api = Api;
  if (needsApi && !api) {
    const esbuild = loadEsbuild({ searchDirs: [H5, NODE_WORKSPACE] });
    if (!esbuild) {
      return { passed, failures, envNotReady: '找不到 esbuild（集成类 fixture 需要它来 bundle 客户端代码）' };
    }
    const outfile = await bundleWith(esbuild, {
      h5Dir: H5,
      outDir: TMP,
      name: 'technician-api',
      entryRelative: API,
    });
    const { createRequire } = await import('node:module');
    api = createRequire(import.meta.url)(outfile);
  }

  const run = (id, title, fn) => {
    try {
      fn();
      passed += 1;
      log(`  ✅ [${id}] ${title}`);
    } catch (error) {
      failures.push({ id, title, message: error.message });
      log(`  ❌ [${id}] ${title} — ${error.message}`);
    }
  };

  log('  ── 双向判定 fixture（应通过 / 应拒绝 两边都跑）');
  for (const fixture of VERDICT_FIXTURES) {
    run(fixture.id, fixture.title, () => {
      // 只跑一边的 fixture 是假绿的温床，所以这里**强制**两组都非空
      assertThat(fixture.accept?.length > 0, `fixture ${fixture.id} 缺少 accept 用例`);
      assertThat(fixture.reject?.length > 0, `fixture ${fixture.id} 缺少 reject 用例`);
      for (const input of fixture.accept) {
        assertThat(
          fixture.verdict(input) === false,
          `应通过却被拒绝：${JSON.stringify(input).slice(0, 120)}`,
        );
      }
      for (const input of fixture.reject) {
        assertThat(
          fixture.verdict(input) === true,
          `应拒绝却被放过：${JSON.stringify(input).slice(0, 120)}`,
        );
      }
      // 真实源码也必须在 accept 侧（理由见文件头 ⚠️）
      for (const kind of fixture.realSources ?? []) {
        const real = kind === 'vue' ? REAL_SFC : REAL_API;
        // ⚠️ 先证明这条规则在**真实源码上看得见东西**：判定"什么都没看到"时
        //    它必然返回 false（判为合规）—— 那是假绿，不是通过。
        const evidence = fixture.realEvidence?.(real, kind);
        assertThat(
          typeof evidence === 'number' && evidence > 0,
          `真实 ${kind} 源码上这条规则"看得见的东西"为 0 —— 判定会假绿，先修规则`,
        );
        assertThat(
          fixture.verdict(real, kind) === false,
          `**真实 ${kind} 源码**被这条规则判为违规 —— 要么规则太宽，要么真实代码已经坏了`,
        );
      }
    });
  }

  log('  ── 单条 fixture（历史坑的最小复现）');
  for (const fixture of SINGLE_FIXTURES) {
    run(fixture.id, fixture.title, () => fixture.run({ Api: api }));
  }

  log('  ── 真实源码变异（checker 必须在真内容上咬得住）');
  for (const fixture of MUTATION_FIXTURES) {
    run(fixture.id, fixture.title, () => fixture.run({ Api: api }));
  }

  return { passed, failures };
}

// =============================================================================
//  直接运行时：打印并给退出码
// =============================================================================
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (isDirectRun) {
  const line = '═'.repeat(62);
  console.log('');
  console.log('  师傅 H5 契约检查器 —— fixture 自检（验证器自己的验证器）');
  console.log(line);

  const result = await runFixtures({});
  console.log('');

  if (result.envNotReady) {
    console.log(line);
    console.log(`  ⚠️  环境未就绪：${result.envNotReady}`);
    console.log(line);
    console.log('');
    process.exit(2);
  }

  if (result.failures.length === 0) {
    console.log(line);
    console.log(`  ✅ fixture 全部通过：${result.passed} 条`);
    console.log(line);
    console.log('');
    process.exit(0);
  }

  console.log(line);
  console.log(`  ❌ fixture 失败 ${result.failures.length} 条 / 通过 ${result.passed} 条`);
  // 带上 title：失败行同时可读（人）与可匹配（变异测试按 id/title 找它）
  for (const f of result.failures) console.log(`     · [${f.id}] ${f.title} — ${f.message}`);
  console.log(line);
  console.log('');
  process.exit(1);
}
