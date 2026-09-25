/**
 * expected-settings.mjs —— **参数种子键**的单一事实来源（供 smoke / verify-plugin-load 共用）
 *
 * 为什么单独抽出来：
 *   这段"从 constants.ts 读 `DEFAULT_SETTINGS` 的全部 key"的逻辑原先在
 *   `smoke-test.mjs` 与 `verify-plugin-load.mjs` 里**各抄了一份**，两份的解析正则完全一样。
 *   2026-09-23（Phase 5 P5-0）把 `visit.photo_max_count` 等 3 个键提为
 *   `TECHNICIAN_SETTING_KEY.*` 常量后，**两份解析器同时变瞎**：
 *   真实的 `DEFAULT_SETTINGS` 有 17 项（代码完全正确），而解析器只认字符串字面量、
 *   只数出 14 项 —— 于是 smoke 报"service_settings 有 17 行，期望 14"
 *   并断言"多出 [……3 个键]"，verify-plugin-load 报 4 条红灯。
 *
 *   **红灯全在解析器身上，不在被测代码身上。** 这类"过期期望"比没有断言更糟：
 *   它训练人忽略红灯，下次真正的漂移就会被淹没（工程铁律 2）。
 *   抽成一份 = 以后只需修一处；而且"两份解析器漂移"这类问题从根上不会再有。
 *
 * 现在的口径（双向防呆）：
 *   · 认 `key: '字面量'` 与 `key: SOME_CONST.PROP` 两种形态（后者回到同名常量对象取值）；
 *   · 引用解析不到时**硬失败**，绝不静默少算 —— 静默少算正是上面那批假红灯的成因。
 *
 * ⚠️ 新增参数种子时：**别**在这里补数字。本模块的存在意义就是让断言跟着常量走，
 *    数字（几行、哪几行）永远由真机数据回答。
 *
 * ---------------------------------------------------------------------------
 * 两个导出：键集合 与 键→值
 * ---------------------------------------------------------------------------
 * `readDefaultSettingKeys()`   —— 只关心"有哪些键"（smoke / verify-plugin-load 的种子对账）
 * `readDefaultSettingValueMap()` —— 还要值，用于**跨层**断言。P5-1 的第一例是
 *   "nginx 的 `client_max_body_size` 必须大于应用宣称的单张照片上限"：
 *   那个上限的**唯一事实来源**是 constants.ts 的种子值，断言里手写 `5` 就是造假。
 *
 * 两者的定位与常量索引逻辑共用（`locateSettingsBlock` / `indexConstMembers`）——
 * 刻意如此：**同一个坑不要有两条腿**（见文件开头的教训）。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONSTANTS_TS = path.join(
  ROOT,
  'nocobase',
  'plugins',
  'service-ticket',
  'src',
  'server',
  'constants.ts',
);

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/**
 * 纯函数内核：从给定的 constants.ts 源码里解析出 `DEFAULT_SETTINGS` 的全部 key。
 * 独立出来是为了能被自检直接喂合成源码（验证"认常量引用"与"悬空引用硬失败"）。
 */
export function parseDefaultSettingKeys(src) {
  const block = locateSettingsBlock(src);

  const keys = [];
  const unresolved = [];
  for (const m of block.matchAll(
    /key:\s*(?:'([^']+)'|([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*))/g,
  )) {
    if (m[1]) {
      keys.push(m[1]);
      continue;
    }
    const ref = `${m[2]}.${m[3]}`;
    const value = indexConstMembers(src).get(ref);
    if (value) keys.push(value);
    else unresolved.push(ref);
  }

  assert(
    unresolved.length === 0,
    `DEFAULT_SETTINGS 里有解析不出值的 key 引用：${unresolved.join(', ')} —— ` +
      '请在常量表里补齐该成员（或改回字符串字面量）。**不要**放任它静默少算：' +
      '少算会让"17 项种子"被读成 14 项，进而报出一堆与代码无关的假红灯。',
  );
  assert(keys.length > 0, 'DEFAULT_SETTINGS 里没解析出任何 key');
  return keys;
}

/**
 * 纯函数内核：解析出 `DEFAULT_SETTINGS` 的 **key → 默认值** 映射。
 *
 * 为什么要连**值**一起解析（原先只有 key）：
 *   Phase 5 需要一条**跨层**断言 —— nginx 的 `client_max_body_size` 必须大于
 *   应用宣称的单张照片上限（`visit.photo_max_size_mb` 的种子值）。
 *   拿这个值只能从 constants.ts 读。**绝不能**在断言里手写 `5`：
 *   手写的数字一旦与种子漂移，断言就会开始"照着旧世界判新世界"，
 *   而且它红的理由与真实缺陷毫无关系（本项目已踩过同类假红灯）。
 *
 * 与 `parseDefaultSettingKeys` 共用同一个常量索引与同一块定位逻辑 ——
 * 这是刻意的：**同一个坑不要有两条腿**。
 */
export function parseDefaultSettingValues(src) {
  const block = locateSettingsBlock(src);
  const constMembers = indexConstMembers(src);
  const values = new Map();

  // 逐条目切分（`DEFAULT_SETTINGS` 的每个成员都是一个 `{ ... }` 字面量）
  for (const entry of block.matchAll(/\{([^{}]*)\}/g)) {
    const body = entry[1];
    const keyRef = /key:\s*(?:'([^']+)'|([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*))/.exec(body);
    if (!keyRef) continue;
    const key = keyRef[1] ?? constMembers.get(`${keyRef[2]}.${keyRef[3]}`);
    assert(key, `有一条种子的 key 解析不出来：${body.trim().slice(0, 80)}`);

    const valueRef = /value:\s*(?:'([^']*)'|([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*))/.exec(body);
    if (!valueRef) continue; // 允许"没有 value 的种子条目"（当前不存在，但不硬失败）
    const value = valueRef[1] ?? constMembers.get(`${valueRef[2]}.${valueRef[3]}`);
    assert(
      value !== undefined,
      `种子 ${key} 的 value 解析不出来（${valueRef[0]}）—— 请改用字面量或补进常量表`,
    );
    values.set(key, value);
  }

  assert(values.size > 0, 'DEFAULT_SETTINGS 里没解析出任何 value');
  return values;
}

/** 定位 `DEFAULT_SETTINGS` 数组块（两个解析器共用，避免各写一份正则） */
function locateSettingsBlock(src) {
  const block = /export const DEFAULT_SETTINGS[\s\S]*?\n\];/.exec(src);
  assert(block, '未能在 constants.ts 中定位 DEFAULT_SETTINGS');
  return block[0];
}

/**
 * 索引"常量对象成员 → 字面量值"，供 `TECHNICIAN_SETTING_KEY.PHOTO_MAX_SIZE_MB`
 * 这类引用回查。只认 `'单引号字面量'` 成员（本文件的键值全是这种形态）。
 *
 * ⚠️ 注意 `envKey:` 里的 K 是大写，不会被 `key:` 的正则误匹配
 *    （大小写敏感救了这一条，但别依赖它 —— 若要放宽正则必须同时收紧这里）。
 */
function indexConstMembers(src) {
  const constMembers = new Map();
  for (const obj of src.matchAll(
    /export const ([A-Za-z_$][\w$]*)\s*=\s*\{([\s\S]*?)\n\} as const;/g,
  )) {
    for (const prop of obj[2].matchAll(
      /^[ \t]*([A-Za-z_$][\w$]*)\s*:\s*'([^']*)'[ \t]*,?[ \t]*$/gm,
    )) {
      constMembers.set(`${obj[1]}.${prop[1]}`, prop[2]);
    }
  }
  return constMembers;
}

/** 从**真实的** constants.ts 读参数种子键（顺序与源码一致） */
export function readDefaultSettingKeys() {
  return parseDefaultSettingKeys(fs.readFileSync(CONSTANTS_TS, 'utf8'));
}

/** 从**真实的** constants.ts 读 key → 默认值 */
export function readDefaultSettingValueMap() {
  return parseDefaultSettingValues(fs.readFileSync(CONSTANTS_TS, 'utf8'));
}

export const CONSTANTS_TS_PATH = CONSTANTS_TS;
