/**
 * 极简路由（只有 3 个页面，不引入 vue-router）。
 *
 * 取舍说明：本工程目前只有 `/report`、`/report/success` 两条路由（Phase 5/7 会加
 * 师傅作业页与评价页，届时再评估是否换成 vue-router）。
 * 用一个 60 行、只做「读路径 + pushState + popstate」的实现，
 * 换掉一个额外依赖与一套需要理解的路由匹配规则 —— 在只有两条路由时是划算的。
 * 若路由数量增长到 5 条以上或出现嵌套/守卫需求，应当直接换 vue-router，
 * **不要**在这个文件上继续加功能。
 *
 * 路径基准：nginx 把 SPA 挂在 `/h5/`（见 h5/vite.config.ts 的 base）。
 * 因此浏览器地址是 `/h5/report?store=S03`，而内部路由是 `/report?store=S03`。
 * 这里统一剥掉 BASE_URL，让页面代码只面对 `/report`，
 * 与 docs/DEV-PLAN.md Phase 3-H 的「`/report` 页面」写法一致 ——
 * 将来把站点从 `/h5/` 挪到根路径，只改 vite 的 base，页面代码一行不用动。
 */
import { readonly, ref, type DeepReadonly, type Ref } from 'vue';

const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

export interface RouteState {
  /** 已剥离 base 的路径，如 `/report`、`/report/success` */
  path: string;
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
  return {
    path: stripBase(window.location.pathname),
    query: parseQuery(window.location.search),
  };
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
