/**
 * 历史 Excel 导入 —— **解析器依赖的运行时守卫**（P11-3 第 2 项）
 *
 * ===========================================================================
 * 为什么"容器里已经有 xlsx"还不够，必须加一道运行时守卫
 * ===========================================================================
 * 用户要求：「容器内已存在 xlsx（SheetJS），可以优先复用，但必须检查**实际版本、来源、
 * 适用安全公告和生产运行时可用性**」，并且"重新部署后仍可用"。
 *
 * 事实（2026-10-12 实测 + 公开公告核对）：
 *
 *   · 生产容器 `/app/nocobase/node_modules/xlsx` = **0.20.3**，Apache-2.0。
 *   · 两个与该库相关的公开 CVE：
 *       - **CVE-2023-30533**（原型链污染，读恶意文件触发）—— 影响 `< 0.19.3`
 *       - **CVE-2024-22363**（ReDoS，读恶意文件触发）—— 影响 `< 0.20.2`
 *     0.20.3 **同时高于两者**，不受影响。
 *   · ⚠️ **但 npm 注册表永远停在 0.18.5**（SheetJS 已停止发布到 npm，官方 CDN 才是
 *     权威源）。也就是说：**任何"顺手 npm i xlsx"都会把版本降到两个 CVE 都命中**。
 *   · ⚠️ 另一个坑：GitHub Advisory 的这两条记录只有 `introduced: 0`、**没有 `fixed` 事件**
 *     （因为 npm 生态里没有可以指名的修复版本）⇒ osv-scanner / Dependabot / Snyk 这类
 *     严格按 OSV 语义匹配的扫描器会**永远**把 0.20.3 标成受影响（误报）。
 *     `npm audit` / Trivy / Grype 按逐条 range 匹配，0.20.3 是干净的。
 *
 * ⇒ 结论：**复用**容器内那份，并且用这个守卫把"实际版本"变成**可判红的断言**：
 *   一旦某次镜像升级把 xlsx 换成了 < 0.20.2（或干脆删掉），
 *   这里立刻以**明确错误码**拒绝解析，而不是静默地用一个有 CVE 的解析器去读客户文件。
 *
 * ⚠️ 这属于本项目"宿主提供的传递依赖"那一类耦合，与 `@napi-rs/canvas` 同类：
 *    必须在**代码里显式声明**、在**构建产物里可见**、并有**门禁盯着**。
 *    （把 xlsx 打进产物是另一种选择，本轮没选：见 docs 里的取舍说明。）
 */
import { IMPORT_REJECT, HistoricalImportRejected } from './limits';

/** 修复版本的**下限**（每个 CVE 各自的下限，取严格更严的那个用于比较） */
export const XLSX_MIN_SAFE_VERSION = '0.20.2';
/** 更早一个 CVE 的下限，单独保留以便报告里分别说明 */
export const XLSX_MIN_SAFE_VERSIONS = {
  'CVE-2023-30533': '0.19.3',
  'CVE-2024-22363': '0.20.2',
} as const;

/** 把 `1.2.3-beta.4` 这类版本号拆成数字数组（只比较前 3 段） */
export function parseSemver(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a >= b ？ */
export function gteSemver(a: string, b: string): boolean {
  const [a1, a2, a3] = parseSemver(a);
  const [b1, b2, b3] = parseSemver(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 >= b3;
}

let cached: { version: string; module: any } | null = null;

/**
 * 取到 xlsx 模块并**校验版本**。
 *
 * ⚠️ 用 `require` 而不是静态 `import`：静态 import 会让 esbuild 把 xlsx **打进产物**
 *    （它是宿主提供的，必须保持外置）。动态 require 同时满足两件事：
 *    产物里留下 `require("xlsx")`（可被构建自检断言），且版本判断能在**用到之前**完成。
 */
export function loadXlsx(): { version: string; module: any } {
  if (cached) return cached;

  let mod: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('xlsx');
  } catch (err) {
    throw new HistoricalImportRejected(
      IMPORT_REJECT.DEPENDENCY_UNAVAILABLE,
      '历史导入所需的解析器 xlsx（SheetJS）在运行环境中不可用：' + (err as Error).message,
      { hint: '宿主镜像应自带 /app/nocobase/node_modules/xlsx；若已移除，需改为把锁定版本打进产物' },
    );
  }

  const version = String(mod?.version ?? '');
  if (!gteSemver(version, XLSX_MIN_SAFE_VERSION)) {
    throw new HistoricalImportRejected(
      IMPORT_REJECT.DEPENDENCY_UNSAFE_VERSION,
      `解析器 xlsx 版本 ${JSON.stringify(version)} 低于安全下限 ${XLSX_MIN_SAFE_VERSION}，` +
        `拒绝解析客户文件（CVE-2023-30533 影响 < 0.19.3；CVE-2024-22363 影响 < 0.20.2）。`,
      { version, minSafe: XLSX_MIN_SAFE_VERSION, affected: XLSX_MIN_SAFE_VERSIONS },
    );
  }

  cached = { version, module: mod };
  return cached;
}

/** 仅供验收脚本使用：把缓存清掉，便于注入不同版本做反向验证 */
export function __resetXlsxCacheForTest(): void {
  cached = null;
}
