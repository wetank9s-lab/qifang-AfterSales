/**
 * _ts-resolve-hook.mjs —— 让 Node 能 import 本仓库里"无扩展名"的相对导入。
 *
 * 为什么需要：`constants.ts` 写的是 `from '../shared/svc-action'`（TS 惯例不带扩展名），
 * 但 Node 的 ESM 解析器不会自动补 `.ts`（TypeScript 的 tsc/esbuild 会）。
 * 为了让验证脚本 import **真实源码**（而不是复制一份规则），必须在解析层补上。
 *
 * ⚠️ 只对**本仓库相对路径**补扩展名，不动 node_modules：
 *    否则会把第三方包名也拿去拼 `.ts`，得到一堆 ENOENT。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve('.');

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const parentDir = path.dirname(new URL(context.parentURL).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const base = path.resolve(parentDir, specifier);
    // 只处理仓库内的路径
    if (base.startsWith(repoRoot)) {
      for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
        if (fs.existsSync(cand)) {
          return { url: pathToFileURL(cand).href, shortCircuit: true };
        }
      }
    }
  }
  return nextResolve(specifier, context);
}
