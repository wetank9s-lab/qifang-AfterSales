#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
r211_prod_locate.py —— R2.1.1 生产侧【只读】按语义定位六个状态页签的 FilterActionModel
=====================================================================================
严格只读。不写入、不删除、不重启。

定位原理（三级证据链）：
  1. FilterActionModel 节点 → 沿 flowModelTreePath 闭包向上找祖先
  2. 祖先链里必须有 TableBlockModel（说明这是表格工具栏上的筛选按钮）
  3. TableBlockModel 所在的页面（RouteModel/ChildPageModel/页面容器）的标题或
     TicketTabFilterModel 的筛选值，决定它属于哪个状态页签

输出 storage/tmp/r211/prod-locate.json
"""
import io
import json
import os
import sys

import paramiko

HOST, USER = "162.14.121.180", "root"
PASS = os.environ["S6_SSH_PASS"]
PG, DB, U = "scqf-as-postgres", "scqf_aftersales_candidate", "scqf_as"
OUT_DIR = os.path.join("storage", "tmp", "r211")
OUT = os.path.join(OUT_DIR, "prod-locate.json")


def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, 22, username=USER, password=PASS, timeout=30)

    def q(sql, timeout=240):
        cmd = "docker exec -i %s psql -U %s -d %s -t -A -v ON_ERROR_STOP=1 -f -" % (PG, U, DB)
        i, o, e = c.exec_command(cmd, timeout=timeout)
        i.write(sql)
        i.channel.shutdown_write()
        return o.channel.recv_exit_status(), o.read().decode("utf-8", "replace"), e.read().decode("utf-8", "replace")

    # 一次取回：所有模型 + 所有闭包关系（2177 模型 / 闭包行数量级不大，但先看规模）
    rc, o, e = q('SELECT count(*) FROM "flowModelTreePath";')
    if rc != 0:
        print("✗", e[:500]); return 1
    closure_n = int((o or "0").strip() or 0)
    print("flowModelTreePath 行数: %d" % closure_n)

    print("取回全部模型 …")
    sql = """SELECT json_build_object(
  'uid', uid,
  'name', name,
  'use', COALESCE(options->>'use', options->'schema'->>'use'),
  'parentId', options->>'parentId',
  'subKey', options->>'subKey',
  'subType', options->>'subType',
  'sortIndex', options->>'sortIndex',
  'title', options->'stepParams',
  'props', options->'props'
)::text FROM "flowModels";"""
    rc, o, e = q(sql.strip(), timeout=300)
    if rc != 0:
        print("✗ SQL 失败:", e[:800]); return 1
    models = {}
    for line in o.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
            models[d["uid"]] = d
        except Exception:
            pass
    print("模型数: %d" % len(models))

    print("取回闭包关系 …")
    sql = """SELECT json_build_object('ancestor', ancestor, 'descendant', descendant, 'depth', depth)::text
FROM "flowModelTreePath" WHERE depth <= 12;"""
    rc, o, e = q(sql.strip(), timeout=300)
    if rc != 0:
        print("✗ SQL 失败:", e[:800]); return 1
    parents = {}   # descendant -> [ancestor...] 按 depth 排序
    for line in o.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d["depth"] <= 0:
            continue
        parents.setdefault(d["descendant"], []).append((d["depth"], d["ancestor"]))
    for k in parents:
        parents[k].sort()

    # ---- 定位每个 FilterActionModel ----
    results = []
    for uid, m in models.items():
        if m["use"] != "FilterActionModel":
            continue
        chain = [a for _d, a in parents.get(uid, [])]
        chain_models = []
        for a in chain:
            am = models.get(a)
            if am:
                chain_models.append({"uid": a, "use": am["use"], "title": extract_title(am)})
        # 找最近的 TableBlockModel 与页面容器
        table_uid = next((x["uid"] for x in chain_models if x["use"] == "TableBlockModel"), None)
        tabfilter = next((x for x in chain_models if x["use"] == "TicketTabFilterModel"), None)
        page_uid = None
        page_title = None
        for x in reversed(chain_models):
            if x["use"] in ("RouteModel", "ChildPageModel", "RootPageModel", "MobileRootPageModel", "ChildPageTabModel"):
                page_uid = x["uid"]
                page_title = x["title"]
                break
        results.append({
            "filterUid": uid,
            "filterTitle": extract_title(m),
            "tableUid": table_uid,
            "tabFilterUid": tabfilter["uid"] if tabfilter else None,
            "tabFilterTitle": tabfilter["title"] if tabfilter else None,
            "pageUid": page_uid,
            "pageTitle": page_title,
            "chain": chain_models,
        })

    print("\n=== 生产 FilterActionModel 共 %d 个 ===" % len(results))
    for r in results:
        print("  filter=%-14s title=%-10s table=%-14s tabfilter=%-14s page=%-14s"
              % (r["filterUid"], (r["filterTitle"] or "-")[:10], r["tableUid"] or "-",
                 r["tabFilterUid"] or "-", r["pageUid"] or "-"))

    os.makedirs(OUT_DIR, exist_ok=True)
    io.open(OUT, "w", encoding="utf-8").write(
        json.dumps({"models": list(models.values()), "locate": results}, ensure_ascii=False, indent=2)
    )
    print("\n已写出: %s" % OUT)
    return 0


def extract_title(m):
    """从 stepParams 里尽力取标题；取不到再退回 props。"""
    if not m:
        return None
    sp = m.get("title")
    if isinstance(sp, dict):
        for path in (("title", "value"),):
            cur = sp
            for p in path:
                cur = cur.get(p) if isinstance(cur, dict) else None
            if cur:
                return parse_title_array(cur)
    props = m.get("props")
    if isinstance(props, dict):
        for k in ("title", "content", "label", "text"):
            v = props.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
    return None


def parse_title_array(v):
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        out = []
        for it in v:
            if isinstance(it, dict):
                t = it.get("text") or it.get("value") or ""
                out.append(str(t))
            else:
                out.append(str(it))
        return "".join(out) or None
    return None


if __name__ == "__main__":
    sys.exit(main())
