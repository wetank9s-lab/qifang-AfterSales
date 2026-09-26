/**
 * 极简路由（4 个页面，不引入 vue-router）。
 *
 * 取舍说明：本工程是 `/report`、`/report/success`、`/technician/visit/:token`
 * 三条路由（Phase 7 会加评价页）。用一个 ~80 行、只做
 * 「读路径 + 参数提取 + pushState + popstate」的实现，
 * 换掉一个额外依赖与一套需要理解的路由匹配规则。
 *
 * ⚠️ 本文件当初的约定是「路由超过 5 条或出现嵌套/守卫需求就换 vue-router」。
 *    P5-1 加师傅页时**没有**触发这条：只多了 1 条路由，且参数只有一段
 *    （`/technician/visit/:token`），不是嵌套、也不需要守卫
 *    （失效链接由**服务端 401**回答，页面照着显示"链接不可用"即可 ——
 *    前端守卫在这里毫无价值，它既拦不住任何人，也判断不准）。
 *    真到 Phase 7 加评价页时，若再需要参数或重定向规则，**直接换 vue-router**，
 *    别在这个文件上继续加功能。
 *
 * 路径基准：nginx 把 SPA 挂在 `/h5/`（见 h5/vite.config.ts 的 base）。
 * 因此浏览器地址是 `/h5/report?store=S03`，而内部路由是 `/report?store=S03`。
 * 这里统一剥掉 BASE_URL，让页面代码只面对 `/report`，
 * 与 docs/DEV-PLAN.md Phase 3-H 的「`/report` 页面」写法一致 ——
 * 将来把站点从 `/h5/` 挪到根路径，只改 vite 的 base，页面代码一行不用动。
 */
import { readonly, ref, type DeepReadonly, type Ref } from 'vue';

const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

/**
 * 师傅作业页：`/technician/visit/:token`
 *
 * ⚠️ 这里**刻意不校验 token 的长度**（服务端常量是 43）。
 *    在 H5 里再写一遍长度就是同一个常量两个副本：它一漂移，
 *    表现是"门店刚发的合法链接被前端判成格式错误"——用户连重试入口都没有，
 *    而且前端**永远不可能**比服务端更权威地判断"这枚 Token 是否有效"。
 *    所以这里只做"token 段存在且是 URL 安全字符"的粗筛，
 *    **有效性一律由服务端的 401 回答**。
 */
const TECHNICIAN_VISIT = /^\/technician\/visit\/([A-Za-z0-9_-]{8,256})$/;

/**
 * 客户评价页：`/customer/review/:token`（Phase 7）
 *
 * 与师傅页**完全同构**的一条动态路由：同样一段参数、同样不做长度校验
 * （理由见上面 TECHNICIAN_VISIT 的注释 —— 有效性由服务端 404/410/409 回答）。
 *
 * ⚠️ 对外地址是 `/f/{token}`，nginx 302 到 `/h5/customer/review/{token}`；
 *    剥掉 base 后本文件看到的就是 `/customer/review/{token}`。
 */
const CUSTOMER_REVIEW = /^\/customer\/review\/([A-Za-z0-9_-]{8,256})$/;

export interface RouteState {
  /** 已剥离 base 的路径，如 `/report`、`/technician/visit/xxx` */
  path: string;
  /** 命中的命名路由；静态路径为 `null` */
  name: 'technician-visit' | 'customer-review' | null;
  /** 路径参数（目前只有 `token`） */
  params: Record<string, string>;
  query: Record<string, string>;
}

function stripBase(pathname: string): string {
  if (BASE && pathname.startsWith(BASE)) {
    const rest = pathname.slice(BASE.length);
    return rest.startsWith('/') ? rest : `/${rest}`;
  }
  return pathname || '/';
}

function parseQuery(search: string): Record<string, string> {
  const query: Record<string, string> = {};
  new URLSearchParams(search).forEach((value, key) => {
    query[key] = value;
  });
  return query;
}

function read(): RouteState {
  const path = stripBase(window.location.pathname);
  const query = parseQuery(window.location.search);

  const visit = TECHNICIAN_VISIT.exec(path);
  if (visit) {
    return { path, name: 'technician-visit', params: { token: visit[1] }, query };
  }

  const review = CUSTOMER_REVIEW.exec(path);
  if (review) {
    return { path, name: 'customer-review', params: { token: review[1] }, query };
  }

  return { path, name: null, params: {}, query };
}

const current: Ref<RouteState> = ref(read());

window.addEventListener('popstate', () => {
  current.value = read();
});

/** 只读的当前路由。页面用它取 path / query，不允许直接改 */
export function useRoute(): DeepReadonly<Ref<RouteState>> {
  return readonly(current) as DeepReadonly<Ref<RouteState>>;
}

/**
 * 跳转。`replace: true` 用于 /report → /report/success 这种跳转：
 * 用户按返回键应该回到"填单页"或"上一站"，而不是回到刚刚提交成功的那一步
 * （否则返回一下就是一屏空白表单，看起来像提交丢了，容易诱发二次提交）。
 */
export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const target = `${BASE}${to}`;
  if (options.replace) window.history.replaceState({}, '', target);
  else window.history.pushState({}, '', target);
  current.value = read();
}
