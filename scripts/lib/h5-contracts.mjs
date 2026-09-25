/**
 * h5-contracts.mjs —— 师傅 H5 契约检查的**共用原语**
 * =============================================================================
 *
 * 这个文件只放**纯函数**（唯一的例外是两个 esbuild 加载器，它们要碰文件系统）。
 * 之所以独立成模块：`verify-technician-h5.mjs`（契约门禁）与
 * `verify-technician-h5-selftest.mjs`（checker 自检）必须消费**同一份**实现 ——
 * 否则"验证器"和"验证器的验证器"就会各有一套解析逻辑，
 * 正是"同一个坑两条腿"最隐蔽的形态（DEV-55 家族）。
 *
 * -----------------------------------------------------------------------------
 * 为什么这里不写"扫全文的正则"
 * -----------------------------------------------------------------------------
 * 本轮（P5-1）连着踩了四个"验证器自己错"的坑，每一个都源于**用正则对整份
 * Vue/TS 源码做语义判断**：
 *
 *   DEV-76  `/\/\*[\s\S]*?\*\//g` 在 `accept="image/*"`（模板属性）里遇到 `/*`，
 *           非贪婪地一路吃到 `<script>` 的块注释结尾 —— **静默吞掉 6KB 模板**。
 *           被吞掉的那段里写什么都不会被发现（假绿），本该命中的检查也会假红。
 *   DEV-77  `eq(actual, expected)` 用 `!==` 比数组 = **引用比较**，
 *           于是"报文字段集合"这条断言**永远不可能通过**；
 *           而报错信息里"期望/实际"逐字相同，看上去像见鬼。
 *   DEV-78  终态文案只扫 `'...'` 单引号字面量，而页面的可见文案**大半是模板文本**，
 *           把 `<h1>工单已完成</h1>` 写进模板，检查一声不吭。
 *   DEV-79  `photoUrl()`（渲染路径上被 `:src` 调用）里做了形态校验并 `throw` ——
 *           渲染期抛错 = 白屏。校验放错了层，且编码逻辑无法被**直接**断言。
 *
 * 结论不是"给正则打补丁"，而是：
 *   ① **分区**：SFC 的 template / script / style 分开处理，各自的注释语法不同；
 *   ② **结构化提取**：要判断"用户看到什么"，就真的按"注释 / 标签 / 文本节点"遍历，
 *      而不是在整份文件上撒网；
 *   ③ **断言原语语义明确**：标量用 `eqScalar`、结构用 `eqJson`，不许有一个
 *      看起来什么都能比、实际上对结构值永远为假的 `eq`。
 *
 * 本模块的每条原语都在 `verify-technician-h5-selftest.mjs` 里有 fixture：
 * 「应通过的输入 → PASS」「应拒绝的输入 → FAIL」「四个坑的最小复现 → 结果正确」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// =============================================================================
//  一、断言原语
// =============================================================================

export function assertThat(cond, message) {
  if (!cond) throw new Error(message);
}

/**
 * 标量比较（**严格**）。`Object.is` 与 `===` 只在 `NaN` / `-0` 上不同，
 * 这里要的是"NaN 等于 NaN"（否则 `eqScalar(NaN, NaN)` 会莫名其妙地红）。
 */
export function eqScalar(actual, expected, what) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/**
 * 结构比较（数组按位置、对象按键名，键顺序无关）。
 *
 * ⚠️ 调用方要"比集合不比顺序"（铁律 2）就自己先 `.sort()` ——
 *    本函数**刻意**保持数组顺序敏感：把顺序也吞掉会掩盖真实的有序契约
 *    （例如 rewrite 的命中顺序、请求的先后）。
 */
export function eqJson(actual, expected, what) {
  if (!structuralEqual(actual, expected)) {
    throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

export function normalizeForCompare(value) {
  if (Array.isArray(value)) return value.map(normalizeForCompare);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeForCompare(value[key])]),
    );
  }
  return value;
}

export function structuralEqual(a, b) {
  if (Object.is(a, b)) return true;
  const aIsObject = a !== null && typeof a === 'object';
  const bIsObject = b !== null && typeof b === 'object';
  if (!aIsObject || !bIsObject) return false;
  return JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b));
}

// =============================================================================
//  二、源码分区与注释剥离
//
//  三种注释语法**不通用**，必须分开处理：
//    template → `<!-- -->`   （`/*` 在这里是**属性值数据**，绝不能当注释）
//    script   → `//` 与 `/* */`（但字符串/模板串里的都是数据）
//    style    → `/* */`
// =============================================================================

/** 用空格顶位：抹掉内容但**保留换行**，行号与偏移不变，便于定位 */
function blankOut(text) {
  return text.replace(/[^\n]/g, ' ');
}

const LITERAL_QUOTES = new Set(['"', "'", '`']);

/**
 * 剥 JS/TS 注释。**按状态的字符扫描器**，不是正则 ——
 * 这是 DEV-76 的正面修复：正则分不清 `accept="image/*"` 里的 `/*`
 * 与真正的块注释起点，也分不清字符串里的 `//`。
 *
 * 已知边界（诚实记录）：不解析**正则字面量**，所以正则里若出现引号
 * （如 `/['"]/`）会被误判成字符串起点。本项目被扫的文件里没有这种写法；
 * 一旦出现，`verify-technician-h5-selftest.mjs` 的 fixture 会立刻变红。
 */
export function stripJsComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i];

    // ① 字符串 / 模板串：**整段原样保留**
    //    `'image/*'`、`'http://x'` 里的 `/*` `//` 都是数据，不是注释。
    if (LITERAL_QUOTES.has(c)) {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === c) {
          j += 1;
          break;
        }
        j += 1;
      }
      out += source.slice(i, j);
      i = j;
      continue;
    }

    // ② 块注释
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blankOut(source.slice(i, stop));
      i = stop;
      continue;
    }

    // ③ 行注释
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += blankOut(source.slice(i, stop));
      i = stop;
      continue;
    }

    out += c;
    i += 1;
  }
  return out;
}

/**
 * 剥 HTML 注释。这里**可以**安全用正则：`<!--` 没有歧义
 * （不像 `/*` 会出现在 `image/*` 这种属性值里）。
 */
export function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (match) => blankOut(match));
}

/** 剥 CSS 注释。CSS 里 `/*` 只可能是注释（`url()` 里不会出现） */
export function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (match) => blankOut(match));
}

/**
 * 定位一个顶层块。返回 `{ open, bodyStart, bodyEnd, end }`，找不到返回 null。
 *
 * ⚠️ 根模板里**嵌套着** `<template v-if>`（Vue 多分支的常规写法），
 *    所以**不能**用 `/<template>([\s\S]*?)<\/template>/` 配平 ——
 *    那样会在第一个内层 `</template>` 处截断，模板的后半段就"合法地"看不见了
 *    （与 DEV-76 同一类失效：检查看着在跑，其实只看了一半）。
 *    这里改用**位置切分**：根模板 = `<template ...>` 到 script/style 之前。
 */
function locateBlock(raw, tag) {
  const open = raw.indexOf(`<${tag}`);
  if (open === -1) return null;
  const gt = raw.indexOf('>', open);
  if (gt === -1) return null;

  if (tag === 'template') {
    const boundary = [raw.indexOf('<script'), raw.indexOf('<style')]
      .filter((v) => v > open)
      .sort((a, b) => a - b)[0];
    const end = boundary === undefined ? raw.length : boundary;
    return { open, bodyStart: gt + 1, bodyEnd: end, end };
  }

  const close = raw.indexOf(`</${tag}>`, gt);
  const bodyEnd = close === -1 ? raw.length : close;
  const end = close === -1 ? raw.length : close + `</${tag}>`.length;
  return { open, bodyStart: gt + 1, bodyEnd, end };
}

/**
 * 把整份文件切成**连续**的区间（含标签本身与标签外的空白，标为 'other'）。
 * 连续是关键：这样 `stripSourceComments` 可以**原地**顶空注释，
 * 保持字节长度与行号与源文件严格一致 —— 报错里给的行号才能直接拿来定位。
 */
export function sectionRanges(raw) {
  const blocks = [
    { kind: 'template', at: locateBlock(raw, 'template') },
    { kind: 'script', at: locateBlock(raw, 'script') },
    { kind: 'style', at: locateBlock(raw, 'style') },
  ]
    .filter((b) => b.at)
    .sort((a, b) => a.at.open - b.at.open);

  const ranges = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.at.open > cursor) ranges.push({ kind: 'other', start: cursor, end: block.at.open });
    ranges.push({ kind: block.kind, start: block.at.open, end: block.at.end });
    cursor = block.at.end;
  }
  if (cursor < raw.length) ranges.push({ kind: 'other', start: cursor, end: raw.length });
  return ranges;
}

/** 把 SFC 切成 template / script / style 三块（供**结构化提取**用） */
export function splitSfc(raw) {
  const pick = (tag) => locateBlock(raw, tag);
  const tpl = pick('template');
  const script = pick('script');
  const style = pick('style');
  const body = (b) => (b ? raw.slice(b.bodyStart, b.bodyEnd) : '');
  return {
    template: body(tpl),
    script: body(script),
    style: body(style),
    ranges: sectionRanges(raw),
  };
}

/**
 * 按文件类型剥注释。kind: 'vue' | 'ts'
 *
 * ⚠️ 实现方式是**原地顶空**（按分区用对应的注释语法），不是"切三块再拼起来"。
 *    拼接会让字节长度与行号跟源文件错位，报错里的行号就没法用了；
 *    而这正是"先变换再断言"的检查最容易埋雷的地方。
 */
export function stripSourceComments(raw, kind) {
  if (kind !== 'vue') return stripJsComments(raw);
  let out = '';
  for (const range of sectionRanges(raw)) {
    const slice = raw.slice(range.start, range.end);
    if (range.kind === 'template') out += stripHtmlComments(slice);
    else if (range.kind === 'script') out += stripJsComments(slice);
    else if (range.kind === 'style') out += stripCssComments(slice);
    else out += slice;
  }
  return out;
}

// =============================================================================
//  三、用户可见文案的**结构化提取**
// =============================================================================

/** 这些属性的值会直接呈现在界面上（`class` 这类不会） */
export const USER_VISIBLE_ATTRS = new Set(['placeholder', 'aria-label', 'title', 'alt']);

/**
 * 从模板里提取**用户真正会看到**的文案。
 *
 * 遍历方式（结构化，不是撒网）：
 *   · `<!-- -->`      → 整段跳过（不渲染）
 *   · `<tag ...>`     → 只从中取"可见属性"的值；标签体本身跳过
 *   · 两个标签之间     → 文本节点，原样收下（含 `{{ }}` 插值里的字面量）
 *
 * 返回 `[{ kind: 'text' | 'attr', text, name? }]`。
 */
export function extractTemplateText(template) {
  const out = [];
  let i = 0;
  const n = template.length;

  while (i < n) {
    if (template.startsWith('<!--', i)) {
      const end = template.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }

    if (template[i] === '<') {
      // 找标签结束的 `>`（跳过引号内内容，属性值里可以有 `>`）
      let j = i + 1;
      let quote = null;
      while (j < n) {
        const ch = template[j];
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === '>') {
          break;
        }
        j += 1;
      }
      const tag = template.slice(i, Math.min(j + 1, n));
      for (const m of tag.matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) {
        if (USER_VISIBLE_ATTRS.has(m[1].toLowerCase())) {
          out.push({ kind: 'attr', name: m[1], text: m[2] });
        }
      }
      i = j + 1;
      continue;
    }

    const next = template.indexOf('<', i);
    const stop = next === -1 ? n : next;
    const text = template.slice(i, stop).trim();
    if (text) out.push({ kind: 'text', text });
    i = stop;
  }

  return out;
}

/** 从 script 里提取字符串字面量（单引号 / 双引号 / 模板串） */
export function extractJsStringLiterals(script) {
  const code = stripJsComments(script);
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  const out = [];
  for (const m of code.matchAll(re)) {
    const value = m[1] ?? m[2] ?? m[3];
    if (value) out.push(value);
  }
  return out;
}

/**
 * 汇总一个文件里"用户可能看到的文案"。
 * kind: 'vue' → 模板文本 + 可见属性 + script 字面量；'ts' → 字面量。
 */
export function extractUserVisibleText(raw, kind) {
  if (kind === 'vue') {
    const s = splitSfc(raw);
    return [
      ...extractTemplateText(s.template),
      ...extractJsStringLiterals(s.script).map((text) => ({ kind: 'js', text })),
    ];
  }
  return extractJsStringLiterals(raw).map((text) => ({ kind: 'js', text }));
}

// =============================================================================
//  四、终态文案红线（P5 真闭环）
//
//  师傅提交只把工单推到 WAIT_STORE_CONFIRM，后面还有门店确认与客户评价。
//  说"已完成/已关闭"会让师傅直接走人、客户以为事情办完了。
//
//  ⚠️ 检查的是 **terminal state copy**，不是关键词猎杀：
//     "请完成以下信息" 这类正常文案**必须放行** —— 全局禁掉"完成"这个词，
//     只会制造另一轮假红，然后被人整条注释掉（那才是真正的失守）。
// =============================================================================

export const TERMINAL_COPY_POLICY = {
  allowed: ['已提交', '等待门店确认', '提交成功'],
  forbidden: ['工单已完成', '服务已完成', '维修已完成', '已关闭'],
};

/** 「<主体>已完成」这个**句式**是红线；孤零零一个"完成"不是 */
export const FORBIDDEN_TERMINAL_PATTERN = /(工单|服务|维修|作业|处理|派工|上门)\s*已完成/;

/**
 * 在"用户可见文案"里找终态违规。
 * 返回 `[{ kind, text, rules: [...] }]`（同一段文字只报一次，规则合并）。
 */
export function findTerminalCopyViolations(items) {
  const byText = new Map();
  for (const item of items) {
    const text = String(item?.text ?? '');
    if (!text) continue;
    const rules = [];
    for (const phrase of TERMINAL_COPY_POLICY.forbidden) {
      if (text.includes(phrase)) rules.push(`禁用短语「${phrase}」`);
    }
    if (FORBIDDEN_TERMINAL_PATTERN.test(text)) rules.push('「<主体>已完成」句式');
    if (rules.length === 0) continue;

    const key = `${item.kind}:${text}`;
    const found = byText.get(key);
    if (found) {
      for (const rule of rules) if (!found.rules.includes(rule)) found.rules.push(rule);
    } else {
      byText.set(key, { kind: item.kind, text, rules });
    }
  }
  return [...byText.values()];
}

// =============================================================================
//  五、esbuild 加载（唯一碰文件系统的部分）
// =============================================================================

/** 依次在若干候选目录里找 esbuild，找到就返回；找不到返回 null（调用方报"环境未就绪"） */
export function loadEsbuild({ searchDirs = [] } = {}) {
  for (const dir of searchDirs) {
    try {
      // esbuild 是 CJS 包；用 createRequire 从候选目录解析，
      // 避免依赖"本脚本自己所在目录"的 node_modules 布局。
      const esbuild = createRequire(path.join(dir, 'noop.cjs'))('esbuild');
      if (esbuild) return esbuild;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

export async function bundleWith(esbuild, { h5Dir, outDir, name, entryRelative, extra = {} }) {
  fs.mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(h5Dir, entryRelative)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    logLevel: 'warning',
    ...extra,
  });
  return outfile;
}

