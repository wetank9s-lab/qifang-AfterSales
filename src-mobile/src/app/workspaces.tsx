/**
 * 顶层工作区（底部导航的**唯一**来源）。
 *
 * ===========================================================================
 * 这个文件为什么必须存在
 * ===========================================================================
 *   整改前，底部栏是**每个页面自己写一行字面量**：
 *     · `Home.tsx`        → `[{ key:'home', label:'工作台', path:'/' }]`
 *     · `ArchiveList.tsx` → `[{ key:'archives', label:'档案', path:'/archives' }]`
 *     · `TicketList.tsx`  → 干脆不传 tabs（无底栏）
 *   于是"有几个工作区"这件事没有事实来源，只能靠人记住。后果有两个：
 *     ① **单项底栏**：销售进档案页看到底部只有"档案"一个 Tab，点了还在原地 ——
 *        没有导航价值，只是白白占掉 50px + 安全区。
 *     ② **同页冒充两个工作区**：销售账号 `caps.tickets=false`，
 *        访问 `/` 落到 `ArchiveListPage`，访问 `/archives` 还是它 ——
 *        两个 URL 渲染同一个组件实例，截图逐字节相同（DEV-239），
 *        而页面上的底栏还写着"档案"，看起来像"这里是另一个工作区"。
 *
 *   ⇒ 现在"哪些工作区存在、叫什么、按什么顺序"**只在本文件回答一次**，
 *     页面只声明"我属于哪个 key"（`activeTab`），不再自己造 Tab 数组。
 *
 * ===========================================================================
 * 为什么销售没有底栏
 * ===========================================================================
 *   门店销售的实际工作只有一个：服务档案（建档 / 查档 / 跟进）。
 *   一个工作区 + 一个 Tab 不构成导航 —— 那是把"有底栏"当成了设计目标。
 *   用户的要求写得很清楚：「取消没有实际导航价值的单项 Tabbar；
 *   若存在多个真实工作区，才按岗位设置 2–3 个明确的顶层入口。」
 *   ⇒ 销售侧返回空数组，`AppShell` 见空即不渲染底栏。
 *
 *   ⚠️ 底栏不是权限展示位。"这个角色有几个 Tab"必须等于"他真有几种活儿"，
 *      不是"能拼出几个入口"。
 */

import { useMemo, type ReactNode } from 'react';
import type { Capabilities } from '../api/session';
import { useSession } from './session-context';

export interface Workspace {
  /** 与页面 `activeTab` 对应 */
  key: string;
  label: string;
  path: string;
  icon: ReactNode;
}

/**
 * 角色能力 → 顶层工作区。
 *
 * 顺序 = 使用频率，不是字母序：
 *   售后早上先看工作台（"今天哪几单要跟进"），再去工单列表做全量检索。
 *
 * 三个组合是穷尽的（`capabilitiesOf` 只产出这几种）：
 *   · `tickets`            → 售后 / 负责人 / 总部：工作台 + 工单（2 项）
 *   · `tickets && archives` → 负责人 / 总部：再加"服务档案"（3 项）
 *   · `archives` 单独       → 门店销售：**0 项**（单工作区，无底栏）
 */
export function workspacesOf(caps: Capabilities): Workspace[] {
  const out: Workspace[] = [];

  if (caps.tickets) {
    out.push({ key: 'home', label: '工作台', path: '/', icon: <IconHome /> });
    out.push({ key: 'tickets', label: '工单', path: '/tickets', icon: <IconTicket /> });
  }

  /**
   * ⚠️ 档案必须在 `caps.tickets` 之外单独判断（2026-11-14 修）。
   *
   *   原先它嵌在 `if (caps.tickets)` 里面，理由是"只有负责人/总部才需要并列档案"。
   *   但这样一旦给销售加了"查询"Tab，销售就只剩**一个** Tab ——
   *   又是那种"只有一项的底栏"，没有导航价值（这正是本文件开头反对的）。
   *   ⇒ 档案属于"有档案权限就有这个工作区"，与有没有工单无关。
   */
  if (caps.archives) {
    out.push({ key: 'archives', label: '档案', path: '/archives', icon: <IconArchive /> });
  }

  /**
   * 服务查询（2026-11-14）：所有有业务权限的角色都有这一项。
   *
   *   用户要求"员工端建设一个『服务查询』入口"，且"搜索范围按照角色与门店权限
   *   自动确定"。所以它对每种角色都存在，只是页面内会按 caps 裁剪分类：
   *     · 只有档案 → 页面只出"服务档案"，不出工单分类；
   *     · 只有工单 → 只出"售后工单"；
   *     · 两类都有 → 出"全部 / 售后工单 / 服务档案"。
   *
   *   ⚠️ 销售此前是"零 Tab"（单工作区无底栏）。现在多了"查询"这个真实目的地，
   *      档案 / 查询 = 两个并列工作区，底栏就有导航价值了 ——
   *      这与当初删除单项底栏的理由并不冲突（那时确实只有一项）。
   */
  if (caps.tickets || caps.archives) {
    out.push({ key: 'search', label: '查询', path: '/search', icon: <IconSearch /> });
  }

  return out;
}

/** 页面用它取底栏；`activeTab` 由页面自己声明"我是哪个工作区" */
export function useWorkspaces(): Workspace[] {
  const { caps } = useSession();
  return useMemo(() => workspacesOf(caps), [caps]);
}

/* ---------------------------------------------------------------- 图标 */

/**
 * 图标内联在手，不引图标库：Konsta 自带的是 Material 风格，与 iOS 观感不一致。
 * 三个图标放在这里而不是各自页面里，是为了让"同一件事只有一个画法" ——
 * 底栏的"工作台"和空态里的"工作台"必须是同一个图形。
 */

export function IconHome() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z" strokeLinejoin="round" />
    </svg>
  );
}

export function IconTicket() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path
        d="M4 9.5V7a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2.5a2.5 2.5 0 0 0 0 5V17a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2.5a2.5 2.5 0 0 0 0-5z"
        strokeLinejoin="round"
      />
      <path d="M12 8.5v7" strokeLinecap="round" strokeDasharray="1.5 2.5" />
    </svg>
  );
}

export function IconSearch() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconArchive() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="4" width="18" height="4.5" rx="1" />
      <path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M10 12.5h4" strokeLinecap="round" />
    </svg>
  );
}
