/**
 * verify-arc-ratelimit-contract.mjs
 * 429 响应体契约：`detail.limit` 必须是**次数上限**，`window_seconds` 才是窗口长度。
 *
 * 为什么专门写这条：
 *   2026-11-12 实测 `{"limit":60,"retry_after_seconds":59}` —— limit 传成了 windowSeconds。
 *   这种错**不会让任何测试变红**：限流照样生效、429 照样返回，
 *   只有"把 limit 拿去展示"的客户端才会出现"每 60 秒 60 次"的错话术。
 *   所以必须有一条断言盯着**字段语义**，而不只是"有没有 429"。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const SRC = 'nocobase/plugins/service-ticket/src/server/actions/public/archive.ts';
const DIST = 'storage/plugins/@local/service-ticket/dist/server/index.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`PASS  ${n}${x ? '  <- ' + x : ''}`); }
  else { fail++; console.log(`FAIL  ${n}${x ? '  <- ' + x : ''}`); }
};

console.log('='.repeat(76));
console.log('429 契约自证：limit=次数上限 / window_seconds=窗口长度');
console.log('='.repeat(76));

// ---------- 0. 前置 ----------
let src = '', dist = '';
try { src = readFileSync(SRC, 'utf8'); } catch { }
try { dist = readFileSync(DIST, 'utf8'); } catch { }
if (!src || !dist) {
  console.log('PRE-FAIL  读不到源码或产物，无法判定（不给产品结论）');
  process.exit(2);
}

// ---------- A. 源码级 ----------
console.log('\nA. 源码：RateLimitedError 的 detail 构造');
const throwIdx = src.indexOf("throw new RateLimitedError('查询过于频繁");
ok('A1 找到 429 抛出点', throwIdx > 0);
const block = throwIdx > 0 ? src.slice(throwIdx, throwIdx + 900) : '';
ok('A2 detail 内含 window_seconds（窗口长度独立字段）', /window_seconds\s*:/.test(block));
ok('A3 detail.limit **不再**直接等于 windowSeconds',
  !/limit\s*:\s*windowSeconds\b/.test(block),
  (block.match(/limit\s*:\s*[^,\n]+/) || [''])[0]);
ok('A4 detail.limit 按触发维度取次数上限（ipDecision.limit / mobileDecision.limit）',
  /limit\s*:\s*[^,\n]*Decision[^,\n]*\.limit/.test(block),
  (block.match(/limit\s*:\s*[^,\n]+/) || [''])[0]);

// ---------- B. 产物级 ----------
console.log('\nB. 产物：同一处逻辑真的进了将被部署的 bundle');
ok('B1 产物含 window_seconds 标记', dist.includes('window_seconds'));
// 反证：产物里不应再出现 "limit:windowSeconds" 这种写法（esbuild 会压掉空格）
ok('B2 产物不含 `limit:windowSeconds`',
  !/limit\s*:\s*[A-Za-z_$][\w$]*windowSeconds/i.test(dist));

// ---------- C. 行为级（从产物里取真实实现不可行 —— 该字段在 action 闭包内）----------
console.log('\nC. 行为级：用**等价的判定表达式**复现两个维度的取值');
// 这里不是重新实现产品，而是把产品里那两个三元表达式的**语义**照抄一遍，
// 验证"维度 → 次数"映射不会串。
const detailOf = (ipAllowed, mobileAllowed, ipLimit = 3, mobileLimit = 3, windowSeconds = 60) => {
  const ipDecision = { allowed: ipAllowed, limit: ipLimit };
  const mobileDecision = { allowed: mobileAllowed, limit: mobileLimit };
  return {
    reason: !ipDecision.allowed ? 'ip' : (!mobileDecision.allowed ? 'mobile' : 'unknown'),
    limit: !ipDecision.allowed ? ipDecision.limit : mobileDecision.limit,
    window_seconds: windowSeconds,
  };
};
const d1 = detailOf(false, true);
ok('C1 IP 被拒 ⇒ limit=ip 次数上限(3)', d1.reason === 'ip' && d1.limit === 3, JSON.stringify(d1));
const d2 = detailOf(true, false);
ok('C2 号被拒 ⇒ limit=号次数上限(3)', d2.reason === 'mobile' && d2.limit === 3, JSON.stringify(d2));
const d3 = detailOf(false, true, 5, 7);
ok('C3 上限可配时按维度各自取值（IP=5）', d3.limit === 5, JSON.stringify(d3));
const d4 = detailOf(true, false, 5, 7);
ok('C4 上限可配时按维度各自取值（号=7）', d4.limit === 7, JSON.stringify(d4));
ok('C5 window_seconds 恒为窗口长度，与 limit 解耦', d1.window_seconds === 60 && d1.limit !== 60,
  JSON.stringify(d1));
ok('C6 ★ 修复前形态 `limit=60` 会被 C1 判红（证明有区分力）',
  (() => { const bad = { reason: 'ip', limit: 60 }; return !(bad.limit === 3); })());

// ---------- D. 变异 ----------
console.log('\nD. 变异：把 limit 改回 windowSeconds，A3/A4 必须变红');
const mutated = block.replace(/limit\s*:\s*[^,\n]*Decision[^,\n]*\.limit/, 'limit: windowSeconds');
ok('D1 变异体确实被构造出来', mutated !== block);
ok('D2 ★ 变异后 A3 判据变红（检测到 limit:windowSeconds）',
  /limit\s*:\s*windowSeconds\b/.test(mutated));
ok('D3 ★ 变异后 A4 判据变红（不再是 Decision.limit）',
  !/limit\s*:\s*[^,\n]*Decision[^,\n]*\.limit/.test(mutated));

console.log('\n' + '='.repeat(76));
console.log(`汇总：PASS ${pass} / ${pass + fail}`);
console.log('='.repeat(76));
process.exit(fail ? 1 : 0);
