#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
P0-LOW-RATING-CLOSE 生产部署 + 一次性关闭全部测试工单

    python scripts/prod-close-test-tickets.py --snapshot          # 只读：快照 + 定 ID
    python scripts/prod-close-test-tickets.py --dry-run           # 只读：预演关单计划（不改库）
    python scripts/prod-close-test-tickets.py --apply             # 执行（部署已单独完成）

硬闸：
  · 快照写盘后**固定** ID 集合；apply 时逐张用 WHERE 幂等谓词推进，不做全表 UPDATE；
  · 已 CLOSED 跳过、已 CANCELLED 保留终态；
  · 结束权限（不让客户再评价、不让师傅再提交）**必须真的失效**，不能只改 status；
  · 每张单写一条 `closed` 事件，metadata 带 repair 标记与原因；
  · 任何一步异常立即停止，不"尽力而为"地继续。
"""
import hashlib
import io
import json
import os
import posixpath
import sys
import time

HOST = os.environ.get("S6_HOST", "162.14.121.180")
USER = os.environ.get("S6_USER", "root")
APP = os.environ.get("S6_APP", "scqf-as-app")
PG = os.environ.get("S6_PG", "scqf-as-postgres")
DB_USER = os.environ.get("S6_PG_USER", "scqf_as")
DB_NAME = os.environ.get("S6_PG_DB", "scqf_aftersales_candidate")
KEY = os.environ.get("S6_SSH_KEY", os.path.join(os.path.expanduser("~"), ".ssh", "id_ed25519"))
PASS = os.environ.get("S6_SSH_PASS", "")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAP_DIR = os.path.join(ROOT, ".tmp-verify", "prod-close-test")
REPAIR_TAG = "P0-LOW-RATING-CLOSE"
CLOSE_REASON = "manual"
EVENT_SUMMARY = "测试数据统一关单（P0-LOW-RATING-CLOSE 上线收口）"

import paramiko


def shq(s):
    return "'" + str(s).replace("'", "'\"'\"'") + "'"


def die(msg, code=1):
    print("\n⛔ " + msg)
    sys.exit(code)


class R:
    def __init__(self):
        c = paramiko.SSHClient()
        c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        c.connect(HOST, port=22, username=USER, password=PASS or None,
                  key_filename=KEY if os.path.exists(KEY) else None,
                  timeout=20, banner_timeout=25, auth_timeout=25,
                  look_for_keys=True, allow_agent=False)
        self.c = c
        self.sftp = c.open_sftp()

    def run(self, cmd, timeout=180):
        _, o, e = self.c.exec_command(cmd, timeout=timeout)
        return (o.read().decode("utf-8", "replace"), e.read().decode("utf-8", "replace"))

    def psql(self, sql, timeout=180):
        out, err = self.run(
            "docker exec -i %s psql -U %s -d %s -X -A -t -F '|' -v ON_ERROR_STOP=1 -c %s"
            % (shq(PG), shq(DB_USER), shq(DB_NAME), shq(sql)), timeout)
        return out.strip(), err.strip()

    def rows(self, sql, timeout=180):
        out, err = self.psql(sql, timeout)
        if err.strip():
            die("SQL 失败：%s\nSQL=%s" % (err.strip()[:400], sql[:300]), 9)
        return [line.split("|") for line in out.splitlines() if line.strip()]

    def close(self):
        try:
            self.sftp.close()
        except Exception:
            pass
        self.c.close()


def nowstamp():
    return time.strftime("%Y%m%d-%H%M%S")


# ---------------------------------------------------------------------------
# 快照
# ---------------------------------------------------------------------------
def snapshot(r):
    os.makedirs(SNAP_DIR, exist_ok=True)
    stamp = nowstamp()

    print("=" * 78)
    print("  只读快照（不改任何数据）  %s" % stamp)
    print("=" * 78)

    total = r.rows("SELECT count(*) FROM service_tickets")[0][0]
    dist = r.rows("SELECT status, count(*) FROM service_tickets GROUP BY status ORDER BY 2 DESC")
    print("\n[1] 工单总数 = %s" % total)
    print("    各状态：")
    for s, n in dist:
        print("      %-12s %s" % (s, n))

    # 需要处理的：快照内所有非终态（NEW / PROCESSING / WAIT_* ）
    toclose = r.rows(
        "SELECT id, ticket_no, status, coalesce(review_status,'-'), "
        "coalesce(reopen_count,0), escalated, coalesce(source,'-') "
        "FROM service_tickets WHERE status NOT IN ('CLOSED','CANCELLED') ORDER BY id")
    print("\n[2] 待关单（非 CLOSED/CANCELLED） = %d 张" % len(toclose))
    by_status = {}
    for row in toclose:
        by_status[row[2]] = by_status.get(row[2], 0) + 1
    for s, n in sorted(by_status.items()):
        print("      %-12s %d" % (s, n))

    # 关联的有效作业权限：还有 ASSIGNED Visit 的
    assigned = r.rows(
        "SELECT v.id, v.ticket_id, v.visit_status, coalesce(v.technician_name,'-') "
        "FROM service_visits v JOIN service_tickets t ON t.id=v.ticket_id "
        "WHERE v.visit_status='ASSIGNED' AND t.status NOT IN ('CLOSED','CANCELLED') ORDER BY v.ticket_id")
    print("\n[3] 待关单中仍有 ASSIGNED Visit 的 = %d 条" % len(assigned))

    # 待评价（评价 Token 仍可用）的工单 —— 关闭后必须失效
    pending_review = r.rows(
        "SELECT id, ticket_no FROM service_tickets "
        "WHERE review_status='pending' AND status NOT IN ('CLOSED','CANCELLED') ORDER BY id")
    print("[4] 待关单中 review_status=pending（Token 仍可用） = %d 张" % len(pending_review))

    # 未完成待办
    todo = r.rows("SELECT count(*) FROM service_tickets WHERE next_follow_at IS NOT NULL "
                  "AND status NOT IN ('CLOSED','CANCELLED')")[0][0]
    print("[5] 待关单中带跟进计划（next_follow_at） = %s" % todo)

    ev_cnt = r.rows("SELECT count(*) FROM ticket_events")[0][0]
    vis_cnt = r.rows("SELECT count(*) FROM service_visits")[0][0]
    sms_cnt = r.rows("SELECT count(*) FROM sms_logs")[0][0]
    print("[6] 基线：事件 %s / Visit %s / 短信日志 %s" % (ev_cnt, vis_cnt, sms_cnt))

    snap = {
        "stamp": stamp,
        "total": int(total),
        "status_dist": {s: int(n) for s, n in dist},
        "targets": [
            {"id": int(a), "ticket_no": b, "status": c, "review_status": d,
             "reopen_count": int(e), "escalated": f == "t", "source": g}
            for a, b, c, d, e, f, g in toclose
        ],
        "assigned_visits": [{"id": int(a), "ticket_id": int(b), "visit_status": c, "technician": d}
                            for a, b, c, d in assigned],
        "pending_review_ids": [int(a) for a, _ in pending_review],
        "follow_todo_count": int(todo),
        "baseline_events": int(ev_cnt),
        "baseline_visits": int(vis_cnt),
        "baseline_sms": int(sms_cnt),
    }
    p = os.path.join(SNAP_DIR, "snapshot-%s.json" % stamp)
    with io.open(p, "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False, indent=2)
    with io.open(os.path.join(SNAP_DIR, "snapshot-latest.json"), "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False, indent=2)

    # 同时在服务器侧留一份不可变基线（含逐行原文，便于事后审计）
    r.run("mkdir -p /root/p0-lrc-%s" % stamp, 30)
    dump_sql = (
        "SELECT id||'|'||ticket_no||'|'||status||'|'||coalesce(review_status,'-')||'|'||"
        "coalesce(rating::text,'-')||'|'||coalesce(reopen_count,0)||'|'||escalated||'|'||"
        "coalesce(close_reason,'-')||'|'||coalesce(closed_at::text,'-') "
        "FROM service_tickets ORDER BY id")
    out, _ = r.psql(dump_sql)
    r.run("mkdir -p /root/p0-lrc-%s" % stamp, 30)
    with io.open(os.path.join(SNAP_DIR, "tickets-before-%s.txt" % stamp), "w", encoding="utf-8") as f:
        f.write(out)
    r.sftp.put(os.path.join(SNAP_DIR, "tickets-before-%s.txt" % stamp),
               "/root/p0-lrc-%s/tickets-before.txt" % stamp)

    print("\n[7] 快照与基线已存：")
    print("      本地 %s" % p)
    print("      远端 /root/p0-lrc-%s/" % stamp)
    return snap


# ---------------------------------------------------------------------------
# 关单计划（只读预演）
# ---------------------------------------------------------------------------
def build_plan(r, snap):
    """逐张判定"怎么关"，并把需要同步终止的凭证列出来。"""
    ids = [t["id"] for t in snap["targets"]]
    idlist = ",".join(str(i) for i in ids) or "0"
    plan = []

    visits = {}
    for vid, tid, vst in r.rows(
            "SELECT id, ticket_id, visit_status FROM service_visits WHERE ticket_id IN (%s) ORDER BY id" % idlist):
        visits.setdefault(int(tid), []).append((int(vid), vst))

    for t in snap["targets"]:
        tid = t["id"]
        vs = visits.get(tid, [])
        active = [v for v in vs if v[1] == "ASSIGNED"]
        plan.append({
            "id": tid,
            "ticket_no": t["ticket_no"],
            "from_status": t["status"],
            "review_pending": t["review_status"] == "pending",
            "assigned_visits": [v[0] for v in active],
            "visits_total": len(vs),
        })
    return plan


def print_plan(plan):
    print("\n[8] 关单计划（%d 张）" % len(plan))
    print("      %-8s %-18s %-14s %-8s %-10s" % ("id", "ticket_no", "from", "评价待办", "ASSIGNED"))
    for p in plan:
        print("      %-8d %-18s %-14s %-8s %-10s" % (
            p["id"], p["ticket_no"], p["from_status"],
            "是" if p["review_pending"] else "-",
            ",".join(str(x) for x in p["assigned_visits"]) or "-"))


def dry_run(r, snap):
    plan = build_plan(r, snap)
    print_plan(plan)
    n_review = sum(1 for p in plan if p["review_pending"])
    n_visit = sum(len(p["assigned_visits"]) for p in plan)
    print("\n[9] 影响面：")
    print("      Ticket → CLOSED（close_reason=%s）：%d 张" % (CLOSE_REASON, len(plan)))
    print("      评价 Token 失效（review_status submitted + used_at）：%d 张" % n_review)
    print("      ASSIGNED Visit 终止（→ CANCELLED）：%d 条" % n_visit)
    print("      next_follow_at 清空：%d 张（有计划的才清）" % snap["follow_todo_count"])
    print("      新增 closed 事件：%d 条（每张 1 条）" % len(plan))
    print("\n[10] 确定性判据（apply 后必须成立）：")
    print("      · 事件增量 == %d（只多 closed 事件，不改历史）" % len(plan))
    print("      · Visit 条数不变（只改状态，不删）")
    print("      · 短信日志零新增")
    print("      · CANCELLED 工单数与状态完全不变")
    return plan


def main():
    mode = "--snapshot" if "--snapshot" in sys.argv else ("--dry-run" if "--dry-run" in sys.argv else ("--apply" if "--apply" in sys.argv else ""))
    if not mode:
        die("用法：--snapshot | --dry-run | --apply", 2)

    r = R()
    try:
        if mode == "--snapshot":
            snap = snapshot(r)
            print("\n✅ 快照完成（未改任何数据）")
            return 0

        p = os.path.join(SNAP_DIR, "snapshot-latest.json")
        if not os.path.exists(p):
            die("没有快照，先跑 --snapshot", 3)
        with io.open(p, encoding="utf-8") as f:
            snap = json.load(f)
        print("使用快照 %s（%d 张目标）" % (snap["stamp"], len(snap["targets"])))

        if mode == "--dry-run":
            plan = dry_run(r, snap)
            print("\n✅ 预演完成（未改任何数据）")
            return 0

        die("apply 见第二步实现", 99)
    finally:
        r.close()


if __name__ == "__main__":
    sys.exit(main() or 0)
