#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
r211_prod_inspect.py —— R2.1.1 生产侧【只读】模型核对
======================================================
只执行 SELECT；不做任何写入、删除、重启。

输出：
  storage/tmp/r211/prod-flowmodels.json   —— 全部 Filter* / TableBlock / Tabs 模型快照
  控制台语义报告 —— 定位六个状态页签下的 FilterActionModel
"""
import io
import json
import os
import sys

import paramiko

HOST = "162.14.121.180"
USER = "root"
PASS = os.environ["S6_SSH_PASS"]
PG = "scqf-as-postgres"
DB = "scqf_aftersales_candidate"
U = "scqf_as"

OUT_DIR = os.path.join("storage", "tmp", "r211")
OUT = os.path.join(OUT_DIR, "prod-flowmodels.json")


def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, 22, username=USER, password=PASS, timeout=30)

    def q(sql, timeout=180):
        cmd = "docker exec -i %s psql -U %s -d %s -t -A -v ON_ERROR_STOP=1 -f -" % (PG, U, DB)
        i, o, e = c.exec_command(cmd, timeout=timeout)
        i.write(sql)
        i.channel.shutdown_write()
        return o.channel.recv_exit_status(), o.read().decode("utf-8", "replace"), e.read().decode("utf-8", "replace")

    sql = """
SELECT json_build_object(
  'uid', m.uid,
  'name', m.name,
  'options', m.options,
  'parent', p.ancestor,
  'sort', p.sort
)::text
FROM "flowModels" m
LEFT JOIN "flowModelTreePath" p
  ON p.descendant = m.uid AND p.depth = 1
WHERE m.name IN ('FilterActionModel','FilterFormBlockModel','FilterFormActionModel',
                 'TableBlockModel','TabsModel','PageModel','MenuModel','ChildPageModel',
                 'TicketTabFilterModel','SvcFilterMoreActionModel')
ORDER BY m.name, m.uid;
"""
    rc, o, e = q(sql.strip())
    if rc != 0:
        print("✗ SQL 失败:", e[:800])
        return 1

    rows = []
    bad = 0
    for line in o.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            bad += 1

    print("取回模型行数: %d（解析失败 %d）" % (len(rows), bad))

    os.makedirs(OUT_DIR, exist_ok=True)
    io.open(OUT, "w", encoding="utf-8").write(json.dumps(rows, ensure_ascii=False, indent=2))
    print("已写出: %s" % OUT)

    # ---- 语义聚合 ----
    by_name = {}
    for r in rows:
        by_name.setdefault(r["name"], []).append(r)
    print("\n=== 各类模型数量 ===")
    for k in sorted(by_name):
        print("  %-24s %d" % (k, len(by_name[k])))

    print("\n=== FilterActionModel 明细 ===")
    for r in by_name.get("FilterActionModel", []):
        opts = r.get("options") or {}
        sp = opts.get("stepParams") or {}
        title = ((sp.get("title") or {}).get("value")) or []
        txt = ""
        try:
            txt = json.dumps(title, ensure_ascii=False)
        except Exception:
            txt = str(title)
        print("  uid=%-14s parent=%-14s anc=%-14s title=%s"
              % (r["uid"], r.get("parent") or "-", r.get("ancestor") or "-", txt[:120]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
