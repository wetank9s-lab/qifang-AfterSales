#!/usr/bin/env node
/**
 * _p0-1-backend-rules.mjs —— 直接跑**真实源码**的 validateServiceNote 规则矩阵。
 *
 * 为什么不用"起服务发 HTTP"：
 *   ① 生产要真实工单 + 一次性 Token ⇒ 验证就得建测试工单 / 消耗 Token，用户明确禁止；
 *   ② 规则函数的边界比 HTTP 更容易穷举（null / undefined / 全角空格 / 换行 / Tab）；
 *   ③ HTTP 能证明的只是"规则函数被调用了"，这里证明的是"规则本身对"。
 *      两者都要有：HTTP 层用生产只读探针单独证（probe-p0-1-api-reject.py）。
 *
 * 为什么用 Node 的 --experimental-strip-types 而不是 esbuild：
 *   本仓库没有装 esbuild（vite 8 用 rolldown）。**不为此新增依赖** ——
 *   装个构建器只为了跑一个规则函数，成本大于收益，而且会让"验证环境"与"生产环境"多出一层差异。
 *   Node 22 原生剥类型足够：constants.ts 只 import 了同仓库的 shared/svc-action。
 *
 * ⚠️ 这个脚本 import 的是**源码**，不是副本。改了源码而测试不红 = 规则没被覆盖到。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = path.resolve('nocobase/plugins/service-ticket/src/server/constants.ts');
const mod = await import(pathToFileURL(SRC).href);
const { validateServiceNote, countEffectiveChars, SERVICE_NOTE_MIN_EFFECTIVE, SERVICE_NOTE_MAX } = mod;

if (typeof validateServiceNote !== 'function') {
  console.log(`P01B|${JSON.stringify({ allOk: false, why: '导出缺失：validateServiceNote 不是函数（源码形状变了）' })}`);
  process.exit(0);
}

const cases = [
  // [标签, 输入, 期望通过?, 期望错误码]
  ['null（完全没传）', null, false, 'SERVICE_NOTE_TOO_SHORT'],
  ['undefined（字段缺失）', undefined, false, 'SERVICE_NOTE_TOO_SHORT'],
  ['空字符串', '', false, 'SERVICE_NOTE_TOO_SHORT'],
  ['半角空格 x10', '          ', false, 'SERVICE_NOTE_TOO_SHORT'],
  ['全角空格 x6（U+3000）', '\u3000\u3000\u3000\u3000\u3000\u3000', false, 'SERVICE_NOTE_TOO_SHORT'],
  ['换行 + Tab', '\n\t\n\t\n', false, 'SERVICE_NOTE_TOO_SHORT'],
  ['4 个有效字（差 1 个）', '换了水泵', false, 'SERVICE_NOTE_TOO_SHORT'],
  ['4 字 + 空格凑长度', '换 了 水 泵', false, 'SERVICE_NOTE_TOO_SHORT'],
  ['5 个有效字（刚好达标）', '更换水泵组', true, null],
  ['5 字 + 前后空白', '  更换水泵组  ', true, null],
  ['超长 501 字', '维'.repeat(501), false, 'SERVICE_NOTE_TOO_LONG'],
  ['刚好 500 字', '维'.repeat(500), true, null],
  ['正常一段维修措施', '检查发现排水管堵塞，已清理并更换排水泵，试机 30 分钟排水正常', true, null],
];

const rows = cases.map(([label, input, shouldPass, expectCode]) => {
  const r = validateServiceNote(input);
  const passed = r === null;
  return {
    label,
    passed,
    ok: passed === shouldPass && (expectCode === null ? r === null : r?.code === expectCode),
    code: r?.code ?? null,
    message: r?.message ?? null,
    effective: countEffectiveChars(String(input ?? '').trim()),
  };
});

// 顺序自证：前端"先判超长再判太短"，后端必须同序，否则提示会指向错方向
const orderProbe = validateServiceNote('短'.padEnd(600, ' '));
const orderOk = orderProbe?.code === 'SERVICE_NOTE_TOO_SHORT';

// 文案一致性：前后端共用同一句
const MSG = '请填写维修措施，至少 5 个字';
const msgOk = validateServiceNote('')?.message === MSG;

const allOk = rows.every((r) => r.ok);
console.log(`P01B|${JSON.stringify({
  allOk, orderOk, msgOk,
  rule: { MIN: SERVICE_NOTE_MIN_EFFECTIVE, MAX: SERVICE_NOTE_MAX },
  pass: rows.filter((r) => r.ok).length, total: rows.length,
  rows, orderProbe,
})}`);
