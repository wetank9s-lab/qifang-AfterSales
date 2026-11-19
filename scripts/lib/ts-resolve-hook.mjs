/**
 * ts-resolve-hook.mjs —— 让 Node 直接 import 本项目的 TS 源码（单测用）
 *
 * 为什么需要：
 *   项目源码里写的是 `from '../constants'`（无扩展名，TS 惯例），
 *   而 Node 的 ESM 解析要求**显式扩展名**。直接 `import('xxx.ts')` 会在
 *   第一个无扩展名的相对导入处报 ERR_MODULE_NOT_FOUND。
 *
 * 做法：只在**解析失败**时补 `.ts` 再试一次，不改变任何其它解析行为。
 *   这样跑的是**真实源码**，不是复制一份逻辑 —— 后者会随源码漂移而失真。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/lib/ts-resolve-hook.mjs <test.mjs>
 */
import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
      try {
        return await nextResolve(specifier + '.ts', context);
      } catch {
        /* 落到下面原样抛出 */
      }
    }
    throw error;
  }
}
`)}`,
  import.meta.url,
);
