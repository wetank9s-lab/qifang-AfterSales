/**
 * 极简路由 —— 与 H5（Vue）那套同构，但**不引 react-router**。
 *
 * ===========================================================================
 * 为什么不引路由库
 * ===========================================================================
 *   本应用的路由形态极其简单：一条静态前缀（`/m/`）+ 少量一/两段参数路径
 *   （`/m/tickets/:id`、`/m/archive/new/:type`）。
 *   react-router 会带来 ~14KB 与一整套需要理解的概念（loader / outlet / ...），
 *   换来的能力（嵌套布局、数据加载）本项目**一个都不用**。
 *
 *   更重要的是：本项目对"路由"的安全要求是**服务端回答**，不是前端守卫。
 *   Token 有效性、工单归属、门店范围全部由 `/api` 判；前端路由器
 *   就算被绕过也拿不到任何数据。既然如此，路由器就该尽可能简单。
 *
 * ⚠️ 一旦出现"嵌套布局 + 多级 tab 切换 + 回退栈管理"的需求，**立刻换 react-router**，
 *    不要在这个文件上继续加功能（H5 那边犯过一次：规则写着"超过 5 条就换"，
 *    然后一条一条加到了 5 条）。
 */

import { useEffect, useState } from 'react';

/** `/m` —— 与 vite.config 的 base 必须一致 */
const BASE = '/m';

export interface RouteState {
  /** 已剥离 base 的路径，如 `/tickets`、`/tickets/123` */
  path: string;
  /** 命名路由 */
  name:
    | 'home'
    | 'tickets'
    | 'ticket-detail'
    | 'archives'
    | 'archive-detail'
    | 'archive-edit'
    | 'archive-new'
    | 'archive-query'
    | 'search'
    | 'login'
    | 'components'
    | 'poc'
    | 'not-found';
  params: Record<string, string>;
  query: URLSearchParams;
}

/**
 * ⚠️ 参数段只做**粗筛**（字符集与长度下限），**不校验业务合法性**。
 *    有效性一律由服务端 401/403/404 回答。
 *    在 H5 那边已经踩过：前端再写一遍长度常量，服务端一改前端就误判
 *    "合法链接格式错误"，而用户连重试入口都没有。
 */
const RE = {
  ticketDetail: /^\/tickets\/(\d{1,20})$/,
  archiveDetail: /^\/archives\/(\d{1,20})$/,
  /**
   * 编辑档案（R2.2.4-rc.2）。
   *
   * ⚠️ **必须排在 `archiveDetail` 之前**吗？不需要 —— 这两条正则互不重叠：
   *    `/archives/123/edit` 不会命中 `/^\/archives\/(\d{1,20})$/`（末尾多了 `/edit`）。
   *    但顺序仍然写在 detail 之后，因为它是 detail 的"子路径"，
   *    读起来与 URL 结构一致，也免得将来有人把 detail 改成宽松匹配时先吃掉它。
   */
  archiveEdit: /^\/archives\/(\d{1,20})\/edit$/,
  archiveNew: /^\/archives\/new(?:\/(service|hvac))?$/,
};

function stripBase(pathname: string): string {
  if (pathname === BASE) return '/';
  if (pathname.startsWith(`${BASE}/`)) {
    const rest = pathname.slice(BASE.length);
    return rest.startsWith('/') ? rest : `/${rest}`;
  }
  return pathname || '/';
}

export function parseRoute(pathname: string, search: string): RouteState {
  const path = stripBase(pathname);
  const query = new URLSearchParams(search);

  const t = RE.ticketDetail.exec(path);
  if (t) return { path, name: 'ticket-detail', params: { id: t[1]! }, query };

  const a = RE.archiveDetail.exec(path);
  if (a) return { path, name: 'archive-detail', params: { id: a[1]! }, query };

  const e = RE.archiveEdit.exec(path);
  if (e) return { path, name: 'archive-edit', params: { id: e[1]! }, query };

  const n = RE.archiveNew.exec(path);
  if (n) {
    return { path, name: 'archive-new', params: n[1] ? { type: n[1] } : {}, query };
  }

  switch (path) {
    case '/':
      return { path, name: 'home', params: {}, query };
    case '/tickets':
      return { path, name: 'tickets', params: {}, query };
    case '/archives':
      return { path, name: 'archives', params: {}, query };
    case '/search':
      return { path, name: 'search', params: {}, query };
    /**
     * `/m/login` —— 登录页的**显式地址**。
     *
     * ⚠️ 为什么必须存在（2026-11 实测缺陷）：
     *    `RouteGuard` 的逻辑是"未登录 + 需要登录 ⇒ 渲染 LoginPage"，
     *    它对 URL **不做任何改变**。于是员工如果在 `/m/login` 这个地址上登录成功，
     *    `status` 变成 authenticated 之后 `RouteView` 拿到的是 `/login` ——
     *    一个不存在的路由 ⇒ 渲染"页面不存在"。
     *    表现极具迷惑性：**登录其实成功了**（token 已写入），
     *    但屏幕上是一张 404，员工会以为系统坏了。
     *    ⇒ 把 `/login` 显式登记为一个路由名，由 AppRouter 在已登录时转到工作台。
     */
    case '/login':
      return { path, name: 'login', params: {}, query };
    case '/archive-query':
      return { path, name: 'archive-query', params: {}, query };
    case '/components':
      return { path, name: 'components', params: {}, query };
    case '/poc':
      return { path, name: 'poc', params: {}, query };
    default:
      return { path, name: 'not-found', params: {}, query };
  }
}

export function useRoute(): RouteState {
  const [route, setRoute] = useState<RouteState>(() =>
    parseRoute(location.pathname, location.search),
  );

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location.pathname, location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return route;
}

/**
 * 跳转。
 *
 * `replace` 用于"提交成功后离开表单页"这类场景：
 * 用户按返回键应该回到列表，而不是回到刚提交完的那一屏
 * （否则返回一下就是一个已经填好、按钮已禁用的表单，看起来像"提交丢了"）。
 */
export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const url = `${BASE}${to.startsWith('/') ? to : `/${to}`}`;
  if (opts.replace) history.replaceState({}, '', url);
  else history.pushState({}, '', url);
  // pushState 不触发 popstate，必须自己派发一次让订阅者更新
  window.dispatchEvent(new PopStateEvent('popstate'));
}
