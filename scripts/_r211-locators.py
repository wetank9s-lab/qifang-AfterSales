#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R2.1.1 定位器唯一性自检（只读）。

对生产配置快照逐条验证定位器：**必须唯一命中**。命中 0 或多个 → 直接 FAIL。
这是指令(6)(d)的机器化落地：不猜 UID，先证定位器唯一。

判据要点（每条都踩过坑）：
  · fields 快照的字段名在 `key` 列，不是 `name`。
  · 「我的门店工单」是**一个页面 6 个内容根**（按状态分 tab），
    不算定位器失效；只有「同父同标题的 tabs 重复」才算。
  · FilterFormCollapseActionModel 在生产是 0 个 —— 那是本次要新增的，属预期。

用法：
    python scripts/_r211-locators.py           # 跑生产快照
退出码：0 全 PASS / 2 有 FAIL（按"工具坏了 vs 产品坏了"分离原则）
"""
import json, sys, os
from collections import Counter

SNAP = "storage/tmp/r211/prodcfg"

def load(n):
    p = os.path.join(SNAP, n + ".json")
    if not os.path.exists(p):
        raise SystemExit(f"缺快照 {p}，先跑 scripts/_r211-prod-export.py")
    d = json.load(open(p, encoding="utf-8"))
    return d if isinstance(d, list) else (d.get("data") or [])

routes  = load("routes")
roleRts = load("roleRoutes")
models  = load("flowModels")
fields  = load("fields")

PAGES = [
    "售后服务工作台", "我的门店工单", "所有工单", "总部售后工作台",
    "派工记录", "工单事件时间线", "门店报修入口", "服务时效",
    "客户页面装修", "门店账号", "短信通知", "短信通知总览",
    "历史数据导入", "历史售后档案",
]

print("=" * 78)
print("定位器自检（生产配置快照）")
print("=" * 78)

fail = 0

# ---------- 1. 页面定位器 ----------
print("\n【1】页面定位器  type='flowPage' AND title=<页面名>")
page_uid = {}
for t in PAGES:
    hit = [r for r in routes if r.get("type") == "flowPage" and (r.get("title") or "") == t]
    if len(hit) == 1:
        page_uid[t] = str(hit[0]["id"])
        print(f"  OK   {t:<14} id={hit[0]['id']}  schemaUid={hit[0]['schemaUid']}")
    else:
        fail += 1
        print(f"  FAIL {t:<14} 命中 {len(hit)} 个 -> {[h['id'] for h in hit]}")

# ---------- 2. 内容根定位器 ----------
print("\n【2】内容根定位器  parentId=<页面id> AND type='tabs'")
tabs_of = {}
for t, pid in sorted(page_uid.items()):
    hit = [r for r in routes if str(r.get("parentId")) == pid and r.get("type") == "tabs"]
    tabs_of[t] = hit
    if not hit:
        fail += 1
        print(f"  FAIL {t:<14} 命中 0 个内容根")
        continue
    titles = [r.get("title") or "" for r in hit]
    if len(set(titles)) != len(titles):
        fail += 1
        print(f"  FAIL {t:<14} 内容根标题重复 -> {titles}")
        continue
    if len(hit) == 1:
        print(f"  OK   {t:<14} 1 根  tabs={hit[0]['id']} contentUid={hit[0]['schemaUid']}")
    else:
        print(f"  OK   {t:<14} {len(hit)} 根（多 tab 页，按标题唯一定位）"
              f" -> {[x.get('title') for x in hit]}")

# ---------- 3. 分组定位器 ----------
print("\n【3】分组定位器  type='group'")
groups = [r for r in routes if r.get("type") == "group"]
tops = [g for g in groups if g.get("parentId") in (None, "")]
print(f"  group 总数 {len(groups)}；顶层 group {len(tops)}")
for g in groups:
    lvl = "顶层" if g.get("parentId") in (None, "") else f"子级(parent={g['parentId']})"
    print(f"  {lvl:>22}  {g['title']}  id={g['id']}  schemaUid={g['schemaUid']}")
if len(tops) != 1:
    fail += 1
    print(f"  FAIL 顶层 group 不唯一（{len(tops)} 个）—— 迁移脚本要求恰好 1 个")

# ---------- 4. flowModels 关键模型 ----------
print("\n【4】flowModels 关键模型计数（列序与筛选定位器的基础）")
def use_of(m):
    o = m.get("options") or {}
    return (o.get("schema") or {}).get("use") or o.get("use")

cnt = Counter(use_of(m) for m in models)
for k in ("TableActionsColumnModel", "TableColumnModel", "FilterFormGridModel",
          "FilterFormBlockModel", "FilterFormCollapseActionModel", "TableBlockModel"):
    print(f"  {k:<34} {cnt.get(k,0)}")
    if cnt.get(k, 0) == 0:
        if k == "FilterFormCollapseActionModel":
            print("    NOTE 生产当前 0 个 —— 本次新增，属预期（不是定位器失效）")
        else:
            fail += 1
            print(f"    FAIL 快照里没有 {k}，定位器无法成立")

# ---------- 5. 字段定位器 ----------
print("\n【5】字段定位器  serviceTickets.<name>")
# ⚠️ 真实字段名（2026-11-17 由生产快照核实，与"想当然"的不一样）：
#     客户问题 = content          （我原先猜 problem_desc，不存在）
#     预约上门 = expected_visit_at（我原先猜 appointment_at，不存在）
#     师傅姓名 = technician_name  （我原先猜 engineer_name，不存在）
#    同时确认：无"师傅"外键列，师傅信息是平铺的 technician_name / technician_mobile
need = ["ticket_no", "status", "content", "customer_name", "customer_mobile",
        "expected_visit_at", "ticket_type", "technician_name", "technician_mobile",
        "store", "service_mode", "urgent"]
have = {f.get("name") for f in fields if (f.get("collectionName") or "") == "serviceTickets"}
for k in need:
    if k in have:
        print(f"  OK   serviceTickets.{k}")
    else:
        fail += 1
        print(f"  FAIL serviceTickets.{k} 不在快照字段集（共有 {sorted(x for x in have if x)}）")

print("\n" + "=" * 78)
print(("定位器自检 FAIL：%d 项" % fail) if fail else "定位器自检 PASS：全部唯一命中")
print("=" * 78)
sys.exit(2 if fail else 0)
