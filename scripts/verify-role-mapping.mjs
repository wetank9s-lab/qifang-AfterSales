#!/usr/bin/env node
/**
 * verify-role-mapping.mjs —— P0-HQ-MENU-02 / 三、角色映射
 *
 * 目标（用户 2026-11-06 批准的范围）：
 *   · 修复 `normalizeRoles` 的角色识别问题；
 *   · 采用**显式业务角色映射**；
 *   · **不允许未知角色自动继承总部权限**；
 *   · 至少验证 hq_admin / hq_after_sales / viewer / store_after_sales / 未登记自定义角色；
 *   · 未知角色必须 fail closed。
 *
 * 测试纪律（本项目铁律）：
 *   ① 跑的是**真实源码**（`permission-service.ts` / `constants.ts`），不复制一份逻辑；
 *   ② 每条断言都必须**能变红** —— 文件末尾用**变异测试**证明：
 *      把 `normalizeRoles` 改回旧的 `ROLE_VALUES.includes` 写法，本套件必须失败；
 *   ③ 判 `scopeOf` 只比**集合语义**（kind / storeIds 集合），不比顺序。
 *
 * 运行：
 *   node --experimental-strip-types --no-warnings \
 *        --import ./scripts/lib/ts-resolve-hook.mjs scripts/verify-role-mapping.mjs
 *
 * ⚠️ **直接 `node scripts/verify-role-mapping.mjs` 会报 ERR_MODULE_NOT_FOUND。**
 *    原因不是脚本坏了：本项目源码用**无扩展名相对导入**（`from '../constants'`），
 *    而 `--experimental-strip-types` 只负责剥类型、**不负责补扩展名**。
 *    所以必须挂 `ts-resolve-hook.mjs`（只在 ERR_MODULE_NOT_FOUND + specifier 以 `.` 开头时补 `.ts`）。
 *    这个坑在 2026-11-06 又踩了一次 —— 当时把"缺 --import"误读成"映射逻辑坏了"。
 *    于是下面加了一段**前置自检**：如果没有挂 hook，就直接打印正确命令并退出，
 *    而不是抛一段栈让人再去猜。
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// 前置自检：hook 没挂时给出可执行的下一步，而不是让开发去看 ERR_MODULE_NOT_FOUND
{
  const srcDir = path.resolve('nocobase/plugins/service-ticket/src/server');
  const constTs = path.join(srcDir, 'constants.ts');
  const constJs = path.join(srcDir, 'constants.js');
  if (fs.existsSync(constTs) && !fs.existsSync(constJs)) {
    try {
      await import(pathToFileURL(constTs).href);
    } catch (e) {
      if (e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'ERR_UNSUPPORTED_ESM_URL_SCHEME') {
        console.error('');
        console.error('  ⛔ 缺少 TS resolve hook —— 请改用：');
        console.error('     node --experimental-strip-types --no-warnings \\');
        console.error('          --import ./scripts/lib/ts-resolve-hook.mjs scripts/verify-role-mapping.mjs');
        console.error('');
        console.error(`  （原始错误：${String(e.code)} ${String(e.message).split('\n')[0]}）`);
        console.error('');
        process.exit(2);
      }
      // 其他错误（比如源码本身有语法错）交给下面的正常流程去暴露
    }
  }
}

const SRC = path.resolve('nocobase/plugins/service-ticket/src/server');
const PS_PATH = path.join(SRC, 'services/permission-service.ts');
const CONST_PATH = path.join(SRC, 'constants.ts');

const results = [];
const check = (pass, label, detail = '') => {
  results.push({ pass, label, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};
const section = (t) => console.log(`\n--- ${t} ---`);

/**
 * 加载被测模块。`sourceOverride` 用于变异测试：传入被篡改的源码文本后，
 * 走 data: URL 加载（单文件、需已内联依赖）—— 所以变异测试只改
 * **不依赖外部 import 的那段**，即 normalizeRoles 本体。
 */
async function loadPs() {
  return import(pathToFileURL(PS_PATH).href);
}

const ps = await loadPs();
const C = await import(pathToFileURL(CONST_PATH).href);

console.log('══════════════════════════════════════════════════════════');
console.log('  P0-HQ-MENU-02  角色映射测试（真实源码）');
console.log('══════════════════════════════════════════════════════════');
console.log(`  被测文件：${path.relative(process.cwd(), PS_PATH)}`);
console.log(`  常量文件：${path.relative(process.cwd(), CONST_PATH)}`);

// ---------------------------------------------------------------------------
section('1. 显式映射：四个业务角色都能被认出');
// ---------------------------------------------------------------------------
const CASES = [
  ['store_after_sales', C.ROLE.STORE_AFTER_SALES, 'store'],
  ['hq_after_sales', C.ROLE.HQ_AFTER_SALES, 'hq'],
  ['hq_admin', C.ROLE.HQ_ADMIN, 'hq'],
  ['viewer', C.ROLE.VIEWER, 'hq'],
];
for (const [input, expected, kind] of CASES) {
  const got = ps.normalizeRoles([input]);
  check(
    got.length === 1 && got[0] === expected,
    `${input} → ${expected}`,
    `实际 [${got.join(',')}]（归类：${kind}）`,
  );
}

// ---------------------------------------------------------------------------
section('2. 写法归一（大小写 / 首尾空白 / 连字符别名）');
// ---------------------------------------------------------------------------
for (const [input, expected] of [
  ['  HQ_ADMIN  ', C.ROLE.HQ_ADMIN],
  ['Hq_Admin', C.ROLE.HQ_ADMIN],
  ['hq-admin', C.ROLE.HQ_ADMIN],
  ['viewer', C.ROLE.VIEWER],
  ['  Viewer\n', C.ROLE.VIEWER],
]) {
  const got = ps.normalizeRoles([input]);
  check(got.length === 1 && got[0] === expected, `"${input.replace(/\n/g, '\\n')}" → ${expected}`, `实际 [${got.join(',')}]`);
}

// ---------------------------------------------------------------------------
section('3. ★ 未登记角色必须 fail closed（这是本轮的核心）');
// ---------------------------------------------------------------------------
const UNKNOWN = [
  'p0hqm02_hq_custom', // 后台新建的"总部管理员2"
  'hq_admin2',
  '总部管理员2',
  'hq_manager',
  'sales_admin',
  'probe_role_x',
];
for (const name of UNKNOWN) {
  const got = ps.normalizeRoles([name]);
  check(got.length === 0, `未登记角色 "${name}" 不被认作任何业务角色`, `实际 [${got.join(',')}]`);
}

// 关键反例：绝不能"因为长得像总部角色就继承总部权限"
const looksHq = ['hq_admin', 'hq_after_sales', 'viewer'];
for (const prefix of ['hq', 'hq_', 'admin', 'viewer']) {
  const fake = `${prefix}_unknown_suffix`;
  const got = ps.normalizeRoles([fake]);
  check(!got.some((r) => looksHq.includes(r)), `"${fake}" 未继承任何总部角色`, `实际 [${got.join(',')}]`);
}

// ---------------------------------------------------------------------------
section('4. 混合绑定：合法的保留，未登记的丢弃（不误伤合法账号）');
// ---------------------------------------------------------------------------
const mixed = ps.normalizeRoles(['member', 'hq_admin', '自定义角色', 'admin']);
check(
  mixed.length === 1 && mixed[0] === C.ROLE.HQ_ADMIN,
  'member + hq_admin + 自定义角色 + admin → 只剩 hq_admin',
  `实际 [${mixed.join(',')}]（内置 member/admin 不参与业务角色，符合 filterPlatformRoles 的设计）`,
);

const mixed2 = ps.normalizeRoles(['store_after_sales', 'p0hqm02_hq_custom']);
check(
  mixed2.length === 1 && mixed2[0] === C.ROLE.STORE_AFTER_SALES,
  'store_after_sales + 未登记角色 → 只剩 store_after_sales（不因未知项失效）',
  `实际 [${mixed2.join(',')}]`,
);

// 去重
const dup = ps.normalizeRoles(['hq_admin', 'HQ_ADMIN', 'hq-admin']);
check(dup.length === 1, '三种写法的同一个角色 → 去重为 1 条', `实际 [${dup.join(',')}]`);

// ---------------------------------------------------------------------------
section('5. 可观测性：unknown 必须被报出来（否则"数据为空"永远查不到原因）');
// ---------------------------------------------------------------------------
const det = ps.normalizeRolesDetailed(['hq_admin', 'p0hqm02_hq_custom', 'member', 'admin']);
check(
  det.roles.length === 1 && det.roles[0] === C.ROLE.HQ_ADMIN,
  'roles 只含 hq_admin',
  `实际 [${det.roles.join(',')}]`,
);
check(
  det.unknown.length === 1 && det.unknown[0] === 'p0hqm02_hq_custom',
  'unknown 只报真正的未登记角色（member/admin/root 不算）',
  `实际 [${det.unknown.join(',')}]`,
);

// ---------------------------------------------------------------------------
section('6. scopeOf：未登记角色 → none（fail closed），绝不 all');
// ---------------------------------------------------------------------------
const svc = new ps.PermissionService({}, { warn: () => {}, debug: () => {}, info: () => {} });
const actorOf = (roles) => ({ userId: 999, roles, platformRoles: [], storeIds: [] });

for (const name of UNKNOWN) {
  const a = actorOf(ps.normalizeRoles([name]));
  const scope = svc.scopeOf(a);
  check(
    scope.kind === 'none',
    `未登记角色 "${name}" 的 scopeOf = none`,
    `实际 kind=${scope.kind}`,
  );
}

// 四个真实角色分别落到预期范围
for (const [name, kind, roles] of [
  ['hq_admin', 'all', [C.ROLE.HQ_ADMIN]],
  ['hq_after_sales', 'all', [C.ROLE.HQ_AFTER_SALES]],
  ['viewer', 'all', [C.ROLE.VIEWER]],
]) {
  const scope = svc.scopeOf(actorOf(roles));
  check(scope.kind === kind, `${name} 的 scopeOf = ${kind}`, `实际 kind=${scope.kind}`);
}
// store_after_sales 必须有门店才有范围（否则也是 none —— 与未知角色同样的 fail-closed）
const storeActorNoStores = actorOf([C.ROLE.STORE_AFTER_SALES]);
check(
  svc.scopeOf(storeActorNoStores).kind === 'none',
  'store_after_sales 但无授权门店 → none（不降级成全量）',
  `实际 kind=${svc.scopeOf(storeActorNoStores).kind}`,
);
const storeActor = { ...storeActorNoStores, storeIds: [1, 4] };
const sScope = svc.scopeOf(storeActor);
check(
  sScope.kind === 'stores' && JSON.stringify([...sScope.storeIds].sort()) === JSON.stringify([1, 4]),
  'store_after_sales + 授权门店 [1,4] → stores[1,4]（集合相等）',
  `实际 kind=${sScope.kind} storeIds=${JSON.stringify(sScope.storeIds)}`,
);

// ---------------------------------------------------------------------------
section('7. 常量契约：映射表覆盖 ROLE_VALUES，且别名不跨角色');
// ---------------------------------------------------------------------------
const mappedValues = new Set(Object.values(C.ROLE_ROLE_NAME_MAP));
check(
  C.ROLE_VALUES.every((r) => mappedValues.has(r)),
  `ROLE_ROLE_NAME_MAP 覆盖全部 ${C.ROLE_VALUES.length} 个业务角色`,
  `缺失：[${C.ROLE_VALUES.filter((r) => !mappedValues.has(r)).join(',') || '无'}]`,
);
const aliasKeys = Object.keys(C.ROLE_ROLE_NAME_MAP).filter(
  (k) => !C.ROLE_VALUES.includes(k),
);
check(aliasKeys.length > 0, `别名条目 ${aliasKeys.length} 条（仅写法归一）`, aliasKeys.join(', '));
check(
  C.BUILTIN_NON_BUSINESS_ROLES.includes('member') &&
    C.BUILTIN_NON_BUSINESS_ROLES.includes('root') &&
    C.BUILTIN_NON_BUSINESS_ROLES.includes('admin'),
  '内置非业务角色清单含 member/root/admin',
  C.BUILTIN_NON_BUSINESS_ROLES.join(', '),
);

// ---------------------------------------------------------------------------
section('8. ★ 变异测试：证明上面的断言真的会红');
// ---------------------------------------------------------------------------
// 变异体：把 normalizeRoles 换回旧实现（只认 ROLE_VALUES.includes）
const originalSrc = fs.readFileSync(PS_PATH, 'utf8');
const mutated = originalSrc.replace(
  /export function normalizeRoles\(names: string\[\]\): RoleName\[\] \{[\s\S]*?\n\}/,
  `export function normalizeRoles(names: string[]): RoleName[] {
  const result: RoleName[] = [];
  for (const name of names) {
    const normalized = String(name).trim().toLowerCase();
    if ((ROLE_VALUES as string[]).includes(normalized) && !result.includes(normalized as RoleName)) {
      result.push(normalized as RoleName);
    }
  }
  return result;
}`,
);
check(mutated !== originalSrc, '变异体已成功注入（源码被改动）');

if (mutated !== originalSrc) {
  // 用 data: URL 加载变异体不可行（有本地相对 import），
  // 改为：把变异体写到同目录的临时文件，加载后删除。
  const tmpPath = path.join(SRC, 'services', `__mutant_${Date.now()}.ts`);
  fs.writeFileSync(tmpPath, mutated, 'utf8');
  try {
    const mut = await import(pathToFileURL(tmpPath).href);
    // 旧实现对未登记角色同样返回 []（因为它本来也只认 4 个名字）——
    // 所以"未登记 → []"这条断言**区分不了新旧实现**。真正的区分点在：
    // ① 别名归一（hq-admin 旧实现认不出）；
    // ② normalizeRolesDetailed 根本不存在（旧实现没有这个导出）。
    const aliasResult = mut.normalizeRoles(['hq-admin']);
    check(
      aliasResult.length === 0,
      '变异体下 "hq-admin" 别名失效（旧实现认不出）—— 说明别名断言有区分力',
      `变异体实际 [${aliasResult.join(',')}]`,
    );
    // 第二条变异：把 normalizeRolesDetailed 的函数体**整段**换掉（不读映射表、不报 unknown）
    //
    // ⚠️ 三个边界坑（全部实测踩过，写在这里免得下次重犯）：
    //    ① 函数签名跨多行（`): {` / `roles: RoleName[];` / `unknown: string[];` / `} {`），
    //       所以锚点必须落到**收尾的 `} {`** 上，不能只写函数名；
    //    ② 必须把原来的 `return { roles, unknown };` **一起**吃掉 —— 否则它留在前面，
    //       新加的 return 变成死代码，变异体行为与原文一模一样（第一版就这样假绿）；
    //    ③ 用 `slice` 按固定锚点切，不用贪婪/懒惰量词去"猜"结尾。
    const HEAD = 'export function normalizeRolesDetailed(names: string[]): {';
    const TAIL = '\n  return { roles, unknown };\n}\n';
    const h = originalSrc.indexOf(HEAD);
    const t = originalSrc.indexOf(TAIL, h);
    const mutated2 =
      h < 0 || t < 0
        ? originalSrc
        : originalSrc.slice(0, h) +
          HEAD +
          '\n  roles: RoleName[];\n  unknown: string[];\n} {\n' +
          // ⚠️ 不能再写 `normalizeRoles(names)` —— 变异体里 normalizeRoles 也已被改成
          //    走 detailed（见第一处变异），两边互调会无限递归（实测 RangeError）。
          //    这里内联一份"旧的、不带 unknown 的"实现。
          '  const roles: RoleName[] = [];\n' +
          '  for (const name of names) {\n' +
          '    const n = String(name).trim().toLowerCase();\n' +
          '    if ((ROLE_VALUES as string[]).includes(n) && !roles.includes(n as RoleName)) roles.push(n as RoleName);\n' +
          '  }\n' +
          '  return { roles, unknown: [] };\n}\n' +
          originalSrc.slice(t + TAIL.length);
    check(mutated2 !== originalSrc, '第二条变异体（unknown 恒空）已注入', `锚点 h=${h} t=${t}`);
    check(
      !/return \{ roles, unknown \};/.test(mutated2),
      '变异体里原 return 已被移除（否则变异体等于没变异）',
    );
    const tmp2 = path.join(SRC, 'services', `__mutant2_${Date.now()}.ts`);
    fs.writeFileSync(tmp2, mutated2, 'utf8');
    try {
      const mut2 = await import(pathToFileURL(tmp2).href);
      const d = mut2.normalizeRolesDetailed(['hq_admin', 'p0hqm02_hq_custom', 'member']);
      check(
        d.unknown.length === 0,
        '变异体下 unknown 恒为空 —— 说明"未登记角色必须被报出来"这条断言有区分力',
        `变异体 unknown=[${d.unknown.join(',')}]（期望为空，证明该断言能变红）`,
      );
    } finally {
      fs.rmSync(tmp2, { force: true });
    }
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log('');
console.log('══════════════════════════════════════════════════════════');
console.log(`  结论：${results.length - failed.length} PASS / ${failed.length} FAIL（共 ${results.length} 条）`);
console.log('══════════════════════════════════════════════════════════');
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.label}  ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
