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
  const block = /export const DEFAULT_SETTINGS[\s\S]*?\n\];/.exec(src);
  assert(block, '未能在 constants.ts 中定位 DEFAULT_SETTINGS');

  // 索引"常量对象成员 → 字面量值"，供 `key: CONST.PROP` 形态回查。
  // 只认 `'单引号字面量'` 成员（本文件的键值全是这种形态）。
  // ⚠️ 注意 `envKey:` 里的 K 是大写，不会被下面 `key:` 的正则误匹配
  //    （大小写敏感救了这一条，但别依赖它 —— 若要放宽正则必须同时收紧这里）。
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

  const keys = [];
  const unresolved = [];
  for (const m of block[0].matchAll(
    /key:\s*(?:'([^']+)'|([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*))/g,
  )) {
    if (m[1]) {
      keys.push(m[1]);
      continue;
    }
    const ref = `${m[2]}.${m[3]}`;
    const value = constMembers.get(ref);
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

/** 从**真实的** constants.ts 读参数种子键（顺序与源码一致） */
export function readDefaultSettingKeys() {
  return parseDefaultSettingKeys(fs.readFileSync(CONSTANTS_TS, 'utf8'));
}

export const CONSTANTS_TS_PATH = CONSTANTS_TS;
