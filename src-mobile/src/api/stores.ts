/**
 * 门店上下文（StoreContextAdapter）。
 *
 * ===========================================================================
 * 一个反直觉的事实：门店由**服务端**决定，不由前端选
 * ===========================================================================
 *   建档（`svc:archiveCreate`）服务端 A5-B3 的规则是：
 *     · 请求**不传** store_id ⇒ 取当前登录销售**唯一**的有效门店绑定；
 *     · 请求**传了** store_id ⇒ 仍然走门店一致性校验（不放宽）；
 *     · 零店 / 多店 / 悬空绑定 ⇒ 一律 fail closed。
 *
 *   所以本应用**不提供"选门店"控件**，也不在前端保存 store_id。
 *   前端唯一需要知道的是"我这家店叫什么"——那只是为了在页头显示，
 *   拿不到也不影响任何写操作。
 *
 * ===========================================================================
 * 为什么门店名要单独取
 * ===========================================================================
 *   业务角色对 `stores` 表的读权限是按行裁的；`users` 表干脆没读权限
 *   （见 session.ts 关于 auth:check 的注释）。因此这里走受控的
 *   `svc:storeOptions` —— 它只回 {code, name}，且按当前账号的门店范围裁。
 *   拿不到就是拿不到，**不要**为了显示一个店名去拓宽任何 ACL。
 */

import { request } from './http';

export interface StoreOption {
  code: string;
  name: string;
}

let cache: StoreOption[] | null = null;
let inflight: Promise<StoreOption[]> | null = null;

/**
 * 读当前账号可见的门店（只读，结果缓存在内存里）。
 *
 * ⚠️ 缓存是**会话级**的：角色/门店被撤掉后，界面上的店名可能还会显示旧值，
 *    但下一次业务请求服务端会重新裁 —— 所以缓存只影响"显示"，不影响"能不能写"。
 *    `clearStoreCache()` 在登出时调用。
 */
export async function listStores(force = false): Promise<StoreOption[]> {
  if (!force && cache) return cache;
  if (!inflight) {
    inflight = request<any>('/svc:storeOptions')
      .then((r) => {
        const arr = Array.isArray(r?.stores) ? r.stores : Array.isArray(r?.options) ? r.options : Array.isArray(r) ? r : [];
        const out: StoreOption[] = arr
          .map((s: any) => ({ code: String(s.code ?? s.value ?? ''), name: String(s.name ?? s.label ?? '') }))
          .filter((s: StoreOption) => s.code && s.name);
        cache = out;
        return out;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function clearStoreCache(): void {
  cache = null;
}

/**
 * 唯一门店名（单店账号用）。
 *
 * 返回 `null` 表示"取不到或不唯一"——两种情况都**不应该**显示某个具体店名，
 * 因为猜错店名比不显示更糟（销售会以为自己建到了别家店）。
 */
export async function singleStoreName(): Promise<string | null> {
  try {
    const list = await listStores();
    if (list.length === 1) return list[0]!.name;
    return null;
  } catch {
    // 门店选项接口失败（网络 / 权限）不应阻断页面 —— 它只是装饰信息
    return null;
  }
}
