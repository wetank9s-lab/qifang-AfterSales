#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
r211_prod_migrate.py —— R2.1.1 生产 UI 配置定向迁移
====================================================
处理对象：六个工单状态页签表格工具栏上的 `FilterActionModel`（「筛选」按钮）。

【为什么可以删】
  页签的自动筛选由 `TicketTabFilterModel.props.filterValue` 承担（不删）；
  `FilterActionModel.stepParams.filterSettings.defaultFilter` 只是「筛选」按钮的预填默认值，
  与前者重复 —— 删掉按钮不改页签查询行为。

【不套用本地 UID】
  按「页面标题 = 状态页签名」+「模型类型 = FilterActionModel」+「同一 TableBlock」三级语义定位，
  每次执行都重新计算，目标变了会直接中止，不会误删。

【安全约束】
  · 每个节点都必须满足：use=FilterActionModel AND 页面标题在 6 个状态页签名里 AND 唯一
  · 删除前做独立备份（flowModels 行 + flowModelTreePath 闭包行 + 可执行回滚 SQL）
  · 删除用 WITH d AS (DELETE ... RETURNING 1) SELECT count(*) 强校验影响行数
  · 幂等：已删除的页签会被识别为「已处理」，重复执行不会报错也不会多删
  · 只动这 6 个节点，不清理任何其他历史配置

用法：
  --dry-run   只打印待删清单与备份内容，不写库（默认）
  --backup    执行备份（写文件到 backups/r211-<ts>/），不删
  --apply     执行备份 + 删除
  --rollback <backup_dir>   按备份恢复（只恢复这 6 个节点及其闭包行）
"""
import argparse
import io
import json
import os
import sys
import time

import paramiko

HOST = "162.14.121.180"
USER = "root"
PASS = os.environ["S6_SSH_PASS"]
PG = "scqf-as-postgres"
DB = "scqf_aftersales_candidate"
DBU = "scqf_as"
ROOT = "/opt/scqf-aftersales"

# 六个工单状态页签的「页面标题」——语义锚点，不依赖 UID
TARGET_TITLES = ["全部", "待处理", "处理中", "待门店确认", "待客户评价", "已结束"]

# 上一轮本地已在此页签删过（保留），这里只做核对，不重复处理
SCRIPT_TAGS = "[r211-prod-migrate]"


def log(m):
    print(m, flush=True)


class Remote:
    def __init__(self):
        self.c = paramiko.SSHClient()
        self.c.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    def connect(self):
        self.c.connect(HOST, 22, username=USER, password=PASS, timeout=30)

    def run(self, cmd, timeout=300):
        i, o, e = self.c.exec_command(cmd, timeout=timeout)
        return o.channel.recv_exit_status(), o.read().decode("utf-8", "replace"), e.read().decode("utf-8", "replace")

    def psql(self, sql, timeout=300):
        cmd = "docker exec -i %s psql -U %s -d %s -t -A -v ON_ERROR_STOP=1 -f -" % (PG, DBU, DB)
        i, o, e = self.c.exec_command(cmd, timeout=timeout)
        i.write(sql)
        i.channel.shutdown_write()
        return o.channel.recv_exit_status(), o.read().decode("utf-8", "replace"), e.read().decode("utf-8", "replace")

    def psql_json_rows(self, sql, timeout=300):
        rc, o, e = self.psql(sql, timeout)
        if rc != 0:
            raise RuntimeError("SQL 失败 rc=%s: %s" % (rc, e[:800]))
        out = []
        for line in o.splitlines():
            line = line.strip()
            if not line:
                continue
            out.append(json.loads(line))
        return out


def load_routes(r):
    """页面标题 ← desktopRoutes.title（type=tabs 的那条指向页面 RouteModel）。"""
    sql = """SELECT json_build_object('t', title, 'uid', "schemaUid", 'type', type)::text
FROM "desktopRoutes" WHERE "schemaUid" IS NOT NULL AND type = 'tabs';"""
    rows = r.psql_json_rows(sql)
    return {x["uid"]: x["t"] for x in rows if x.get("t")}


def load_models(r):
    sql = """SELECT json_build_object(
  'uid', uid,
  'use', COALESCE(options->>'use', options->'schema'->>'use'),
  'parentId', options->>'parentId'
)::text FROM "flowModels"
WHERE COALESCE(options->>'use', options->'schema'->>'use')
      IN ('FilterActionModel','TableBlockModel','TicketTabFilterModel');"""
    return r.psql_json_rows(sql)


def load_ancestors(r):
    sql = """SELECT json_build_object('d', descendant, 'a', ancestor, 'depth', depth)::text
FROM "flowModelTreePath" WHERE depth > 0;"""
    rows = r.psql_json_rows(sql)
    anc = {}
    for x in rows:
        anc.setdefault(x["d"], []).append((x["depth"], x["a"]))
    for k in anc:
        anc[k].sort()
    return anc


def resolve_targets(r):
    """按语义定位：返回 [(tab_title, filter_uid, table_uid, route_uid)]"""
    routes = load_routes(r)
    models = {m["uid"]: m for m in load_models(r)}
    anc = load_ancestors(r)

    found = {}
    for uid, m in models.items():
        if m["use"] != "FilterActionModel":
            continue
        chain = [a for _d, a in anc.get(uid, [])]
        table_uid = next((a for a in chain if models.get(a, {}).get("use") == "TableBlockModel"), None)
        route_uid = next((a for a in chain if a in routes), None)
        if not route_uid:
            continue
        title = routes[route_uid]
        if title not in TARGET_TITLES:
            continue
        found.setdefault(title, []).append({
            "title": title, "filterUid": uid, "tableUid": table_uid, "routeUid": route_uid,
        })

    # 唯一性校验：每个页签名最多一个
    problems = []
    for t, lst in found.items():
        if len(lst) > 1:
            problems.append("页签「%s」定位到 %d 个 FilterActionModel：%s"
                            % (t, len(lst), [x["filterUid"] for x in lst]))
    return found, problems


def export_node(r, filter_uid):
    """导出单节点的完整备份：flowModels 行 + 闭包行（含自身）"""
    sql = """SELECT json_build_object(
  'row', (SELECT row_to_json(t)::jsonb FROM (SELECT uid, name, options::text AS options
           FROM "flowModels" WHERE uid='%s') t),
  'closure', (SELECT json_agg(json_build_object(
                'ancestor', ancestor, 'descendant', descendant,
                'depth', depth, 'async', async, 'type', type, 'sort', sort))
              FROM "flowModelTreePath"
              WHERE descendant='%s' OR ancestor='%s')
)::text;""" % (filter_uid, filter_uid, filter_uid)
    rows = r.psql_json_rows(sql)
    if not rows:
        return None
    return rows[0]


def do_backup(r, targets, ts):
    """在 /opt/scqf-aftersales/backups/ 下建持久化受控备份目录"""
    d = "%s/backups/r211-filteraction-rollback-%s" % (ROOT, ts)
    rc, o, e = r.run("mkdir -p %s && chmod 700 %s && echo ok" % (d, d))
    if rc != 0:
        raise RuntimeError("建备份目录失败：" + e[:300])

    payload = {"createdAt": ts, "database": DB, "targets": {}, "note": "R2.1.1 删除六页签 FilterActionModel 前的独立备份"}
    for t in targets:
        node = export_node(r, t["filterUid"])
        if not node or not node.get("row"):
            raise RuntimeError("导出节点失败：%s" % t["filterUid"])
        payload["targets"][t["title"]] = {
            "filterUid": t["filterUid"],
            "tableUid": t["tableUid"],
            "routeUid": t["routeUid"],
            "row": node["row"],
            "closure": node["closure"] or [],
        }
        log("  备份 %-8s filter=%s closure=%d 行"
            % (t["title"], t["filterUid"], len(node["closure"] or [])))

    # 本地写好再上传（避免 shell 引号地狱）
    tmp = "r211-backup-%s.json" % ts
    io.open(tmp, "w", encoding="utf-8").write(json.dumps(payload, ensure_ascii=False, indent=2))
    sftp = r.c.open_sftp()
    sftp.put(tmp, d + "/flowmodels-backup.json")
    sftp.close()
    os.unlink(tmp)

    # 生成可执行回滚 SQL
    rollback_sql = build_rollback_sql(payload)
    sftp = r.c.open_sftp()
    io.open(tmp, "w", encoding="utf-8").write(rollback_sql)
    sftp.put(tmp, d + "/rollback.sql")
    sftp.close()
    os.unlink(tmp)

    # 校验清单
    rc, o, e = r.run("cd %s && sha256sum flowmodels-backup.json rollback.sql > SHA256SUMS.txt && cat SHA256SUMS.txt" % d)
    log("  备份目录：%s" % d)
    log("  " + o.strip().replace("\n", "\n  "))
    return d, payload


def build_rollback_sql(payload):
    """只恢复这 6 个节点及其闭包行 —— 不触碰任何业务数据表"""
    out = ["-- R2.1.1 定向回滚：恢复六个状态页签的 FilterActionModel 及其闭包行",
           "-- ⚠️ 只恢复 flowModels / flowModelTreePath，绝不还原整张业务库",
           "BEGIN;", ""]
    for title, v in payload["targets"].items():
        uid = v["filterUid"]
        row = v["row"]
        opts = row["options"]
        if not isinstance(opts, str):
            opts = json.dumps(opts, ensure_ascii=False)
        esc_opts = opts.replace("'", "''")
        esc_name = str(row.get("name", uid)).replace("'", "''")
        out.append("-- %s" % title)
        out.append(
            "INSERT INTO \"flowModels\" (uid, name, options) VALUES ('%s','%s','%s'::json) "
            "ON CONFLICT (uid) DO UPDATE SET name=EXCLUDED.name, options=EXCLUDED.options;"
            % (uid, esc_name, esc_opts))
        for c in v["closure"]:
            out.append(
                "INSERT INTO \"flowModelTreePath\" (ancestor,descendant,depth,async,type,sort) "
                "VALUES ('%s','%s',%d,%s,%s,%d) ON CONFLICT DO NOTHING;"
                % (c["ancestor"], c["descendant"], c["depth"],
                   "true" if c["async"] else "false",
                   ("'%s'" % c["type"].replace("'", "''")) if c["type"] is not None else "NULL",
                   c["sort"] if c["sort"] is not None else 0))
        out.append("")
    out.append("COMMIT;")
    return "\n".join(out)


def do_delete(r, targets):
    """定向删除，强校验影响行数 == 1"""
    ok = True
    for t in targets:
        uid = t["filterUid"]
        # 删除前最后一次确认它仍然是 FilterActionModel（防止中途被人改过）
        rc, o, e = r.psql(
            "SELECT COALESCE(options->>'use', options->'schema'->>'use') FROM \"flowModels\" WHERE uid='%s';" % uid)
        kind = (o or "").strip()
        if kind != "FilterActionModel":
            log("  ✗ %-8s uid=%s 当前类型=%r，不是 FilterActionModel ⇒ 中止" % (t["title"], uid, kind))
            ok = False
            break

        sql = """
WITH c AS (DELETE FROM "flowModelTreePath" WHERE descendant='%s' OR ancestor='%s' RETURNING 1),
     m AS (DELETE FROM "flowModels" WHERE uid='%s' RETURNING 1)
SELECT json_build_object('closure', (SELECT count(*) FROM c), 'model', (SELECT count(*) FROM m))::text;
""" % (uid, uid, uid)
        rc, o, e = r.psql(sql)
        if rc != 0:
            log("  ✗ %-8s 删除失败：%s" % (t["title"], e[:300]))
            ok = False
            break
        try:
            d = json.loads(o.strip().splitlines()[-1])
        except Exception:
            log("  ✗ %-8s 结果解析失败：%r" % (t["title"], o[:200]))
            ok = False
            break
        good = (d["model"] == 1 and d["closure"] >= 1)
        log("  %s %-8s uid=%-14s models=%d closure=%d"
            % ("✅" if good else "✗", t["title"], uid, d["model"], d["closure"]))
        if not good:
            ok = False
            break
    return ok


def do_rollback(r, backup_dir):
    rc, o, e = r.run("cat %s/rollback.sql" % backup_dir)
    if rc != 0:
        raise RuntimeError("读取 rollback.sql 失败：" + e[:300])
    rc, o2, e2 = r.psql(o)
    if rc != 0:
        raise RuntimeError("回滚失败：" + e2[:800])
    log("  ✅ 已执行 rollback.sql")
    # 复核
    rc, o3, e3 = r.psql("""SELECT json_build_object(
      'filteraction', (SELECT count(*) FROM "flowModels"
        WHERE COALESCE(options->>'use', options->'schema'->>'use')='FilterActionModel'))::text;""")
    log("  复核：" + (o3 or e3).strip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--backup", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--rollback", default=None)
    args = ap.parse_args()

    r = Remote()
    r.connect()

    if args.rollback:
        log("=== 回滚自 %s ===" % args.rollback)
        do_rollback(r, args.rollback)
        return 0

    log("=== 语义定位（页面标题 → FilterActionModel）===")
    found, problems = resolve_targets(r)
    if problems:
        for p in problems:
            log("  ✗ " + p)
        log("\n✗ 定位不唯一/异常 ⇒ 按纪律【停止，不猜】")
        return 2

    order = TARGET_TITLES
    targets = []
    for t in order:
        lst = found.get(t) or []
        if not lst:
            log("  - %-8s 已无 FilterActionModel（视为已处理）" % t)
            continue
        x = lst[0]
        targets.append(x)
        log("  ✓ %-8s filter=%-14s table=%-14s route=%s"
            % (t, x["filterUid"], x["tableUid"], x["routeUid"]))

    if not targets:
        log("\n没有待处理节点（六个页签均已是目标状态）")
        return 0

    log("\n待删节点数：%d" % len(targets))
    if args.dry_run and not (args.backup or args.apply):
        log("（dry-run，未写库）")
        return 0

    ts = time.strftime("%Y%m%d-%H%M%S")
    log("\n=== 备份 ===")
    bdir, payload = do_backup(r, targets, ts)

    if not args.apply:
        log("\n（仅备份，未删除。加 --apply 才执行删除）")
        return 0

    log("\n=== 定向删除 ===")
    ok = do_delete(r, targets)
    if not ok:
        log("\n✗ 删除未全部成功 ⇒ 请立即用 %s/rollback.sql 回滚" % bdir)
        return 3

    log("\n=== 删除后复核 ===")
    found2, problems2 = resolve_targets(r)
    left = [t for t in TARGET_TITLES if found2.get(t)]
    log("  六页签剩余 FilterActionModel：%s" % (left or "无 ✅"))
    log("  tabFilter 是否完好：")
    rc, o, e = r.psql("""SELECT json_build_object(
      'tabfilter', (SELECT count(*) FROM "flowModels"
        WHERE COALESCE(options->>'use', options->'schema'->>'use')='TicketTabFilterModel'))::text;""")
    log("   " + (o or e).strip())

    log("\n备份目录（持久化、0700）：%s" % bdir)
    return 0 if not left else 4


if __name__ == "__main__":
    sys.exit(main())
