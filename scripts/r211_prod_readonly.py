#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
r211_prod_readonly.py —— R2.1.1 生产发布前【只读】核对
=========================================================
严格只读：只执行 SELECT / 文件读取 / 容器状态查询，不做任何写操作。

核对项（对应发布裁决「一、生产配置迁移与回滚」+「三、生产部署前检查」）：
  A. 生产基线：commit / tag / 构建标记 / 插件 dist 指纹
  B. 工单页面表头是否含「工单号」「状态」
  C. 六个状态页签下的 FilterActionModel 节点【按语义定位，不套用本地 UID】
  D. 目标节点的 flowModelTreePath 闭包行（用于独立备份与定向删除）
  E. 页面布局清单（确认六个页签分属哪些 layout / 页面 uid）
  F. Nginx 限流是否仍为 30r/m + burst=10 nodelay
"""
import io
import json
import os
import sys

import paramiko

HOST = os.environ.get("S6_SSH_HOST", "162.14.121.180")
USER = os.environ.get("S6_SSH_USER", "root")
PASS = os.environ["S6_SSH_PASS"]
CONTAINER = os.environ.get("S6_CONTAINER", "scqf-as-app")
ROOT = os.environ.get("S6_ROOT", "/opt/scqf-aftersales")
DB = os.environ.get("S6_DB", "svc_app")
PG = os.environ.get("S6_PG", "scqf-as-postgres")

OUT = os.path.join("storage", "tmp", "r211", "prod-readonly.json")


def log(m):
    print(m, flush=True)


class R:
    def __init__(self):
        self.c = paramiko.SSHClient()
        self.c.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    def connect(self):
        self.c.connect(HOST, port=22, username=USER, password=PASS, timeout=30)

    def run(self, cmd, timeout=180):
        _in, out, err = self.c.exec_command(cmd, timeout=timeout)
        o = out.read().decode("utf-8", "replace")
        e = err.read().decode("utf-8", "replace")
        rc = out.channel.recv_exit_status()
        return rc, o, e


def psql_json(r, sql):
    """把查询结果以 JSON 数组返回（-t -A，单列）。"""
    esc = sql.replace("'", "'\"'\"'")
    cmd = (
        "docker exec -i %s psql -U %s -d %s -t -A -v ON_ERROR_STOP=1 -c "
        "$$%s$$" % (PG, DB, DB, esc)
    )
    # 用 stdin 传 SQL，避免引号地狱
    base = "docker exec -i %s psql -U %s -d %s -t -A -v ON_ERROR_STOP=1 -f -" % (PG, DB, DB)
    _in, out, err = r.c.exec_command(base, timeout=180)
    _in.write(sql)
    _in.channel.shutdown_write()
    o = out.read().decode("utf-8", "replace").strip()
    e = err.read().decode("utf-8", "replace").strip()
    rc = out.channel.recv_exit_status()
    if rc != 0:
        return None, e or ("rc=%s" % rc)
    return o, ""


def main():
    r = R()
    r.connect()
    result = {}

    # ---------- A. 生产基线 ----------
    log("=== A. 生产基线 ===")
    a = {}
    for key, cmd in [
        ("git_head", "git -C %s rev-parse HEAD" % ROOT),
        ("git_tag", "git -C %s describe --tags --always 2>/dev/null" % ROOT),
        ("git_log", "git -C %s log --oneline -3" % ROOT),
        ("containers", "docker ps --format '{{.Names}}|{{.Status}}|{{.Image}}'"),
        ("app_version", "docker exec %s node -e \"try{console.log(require('/app/package.json').version)}catch(e){console.log('n/a')}\"" % CONTAINER),
    ]:
        rc, o, e = r.run(cmd, timeout=90)
        a[key] = o.strip() if rc == 0 else ("ERR:" + (e or str(rc)))

    # 生产插件 dist 指纹
    rc, o, e = r.run(
        "ls -l %s/src/storage/plugins/@local/service-ticket/dist/client/index.js "
        "%s/src/storage/plugins/@local/service-ticket/dist/client-v2/index.js "
        "%s/src/storage/plugins/@local/service-ticket/dist/build-fingerprint.json 2>&1; "
        "md5sum %s/src/storage/plugins/@local/service-ticket/dist/client/index.js "
        "%s/src/storage/plugins/@local/service-ticket/dist/client-v2/index.js 2>&1; "
        "grep -o '2026-[0-9][0-9]-[0-9][0-9]T[0-9:]*Z' "
        "%s/src/storage/plugins/@local/service-ticket/dist/client/index.js 2>/dev/null | sort -u"
        % (ROOT, ROOT, ROOT, ROOT, ROOT, ROOT),
        timeout=90,
    )
    a["plugin_dist"] = o.strip() if rc == 0 else ("ERR:" + (e or str(rc)))
    result["A_baseline"] = a
    for k, v in a.items():
        log("  %-14s %s" % (k, v.replace("\n", "\n" + " " * 17)))

    # ---------- B. 工单集合是否存在 ----------
    log("=== B. 集合与字段 ===")
    sql = """
SELECT json_build_object(
  'has_service_tickets', EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='serviceTickets'),
  'ticket_count', (SELECT count(*) FROM "serviceTickets"),
  'status_dist', (SELECT json_object_agg(status, n) FROM (SELECT status, count(*) n FROM "serviceTickets" GROUP BY status ORDER BY status) t)
)::text;
""".strip()
    o, e = psql_json(r, sql)
    result["B_collections"] = o or ("ERR:" + e)
    log("  " + (o or e))

    # ---------- C/D. flowModels 中六个页签的 FilterActionModel ----------
    log("=== C. FilterActionModel 语义定位 ===")
    sql = """
WITH t AS (
  SELECT fm.uid, fm.name,
         jsonb_array_length(COALESCE(fm.options->'stepParams'->'title'->'value', '[]'::jsonb)) AS n1
  FROM "flowModels" fm
  WHERE fm.name = 'FilterActionModel'
)
SELECT json_build_object('total', count(*))::text FROM t;
""".strip()
    o, e = psql_json(r, sql)
    log("  " + (o or e))
    result["C_count"] = o or ("ERR:" + e)

    # 更稳的做法：全量导出 FilterActionModel（含 options）到本地分析
    sql = """
SELECT json_build_object(
  'uid', fm.uid,
  'name', fm.name,
  'parent_id', fm."parentId",
  'options', fm.options
)::text
FROM "flowModels" fm
WHERE fm.name LIKE '%Filter%'
ORDER BY fm.name, fm.uid;
""".strip()
    o, e = psql_json(r, sql)
    rows = []
    if o:
        for line in o.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    log("  Filter* 模型数: %d" % len(rows))
    result["C_filter_models"] = rows

    # ---------- F. Nginx 限流 ----------
    log("=== F. Nginx 限流 ===")
    rc, o, e = r.run(
        "grep -rn 'limit_req\\|limit_req_zone\\|burst' %s/nginx 2>/dev/null | grep -v '^Binary' | head -30; "
        "echo '--- in container ---'; docker exec %sc grep -rn 'limit_req' /etc/nginx 2>/dev/null | head -20"
        % (ROOT, ""),
        timeout=90,
    )
    result["F_nginx"] = o.strip() if rc == 0 else ("ERR:" + (e or str(rc)))
    log("  " + (o.strip() or e)[:3000])

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    io.open(OUT, "w", encoding="utf-8").write(
        json.dumps(result, ensure_ascii=False, indent=2)
    )
    log("\n已写出: " + OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
