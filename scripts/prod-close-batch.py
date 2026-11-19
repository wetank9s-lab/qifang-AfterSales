#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 / 上传 / 触发生产「测试数据统一关单」引导任务。

    python scripts/prod-close-batch.py --build      # 从快照生成引导文件（本地）
    python scripts/prod-close-batch.py --push       # 上传到生产 storage/.bootstrap/
    python scripts/prod-close-batch.py --verify     # 执行后核验（只读）

⚠️ 幂等由 `adminCloseTicket` 保证：已是 CLOSED / CANCELLED 的工单直接跳过、零副作用，
   所以即使重复推送同一批 ID 也不会产生重复事件。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import importlib.util

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("deploy", os.path.join(ROOT, "scripts", "prod-deploy-lrc.py"))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

SNAP = os.path.join(ROOT, ".tmp-verify/prod-close-test/snapshot-latest.json")
LOCAL_JOB = os.path.join(ROOT, ".tmp-verify/prod-close-test/admin-close-batch.json")
REMOTE_DIR = "/opt/scqf-aftersales/src/storage/.bootstrap"
REMOTE_JOB = REMOTE_DIR + "/admin-close-batch.json"

BATCH_TAG = "P0-LOW-RATING-CLOSE"
REASON = "生产环境历史工单均为测试数据，按批准一次性统一关单（测试数据统一关单）"
OPERATOR_USER_ID = 1
OPERATOR_USERNAME = "admin"


def build():
    s = json.load(open(SNAP, encoding="utf-8"))
    ids = sorted({int(t["id"]) for t in s["targets"]})
    job = {
        "batchTag": BATCH_TAG,
        "reason": REASON,
        "operatorUserId": OPERATOR_USER_ID,
        "operatorUsername": OPERATOR_USERNAME,
        "ticketIds": ids,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    with open(LOCAL_JOB, "w", encoding="utf-8") as f:
        json.dump(job, f, ensure_ascii=False, indent=1)
    print("已生成引导文件：%s" % LOCAL_JOB)
    print("  快照戳     : %s" % s["stamp"])
    print("  工单数     : %d（去重后）" % len(ids))
    print("  快照内总数 : %d" % len(s["targets"]))
    print("  batchTag   : %s" % BATCH_TAG)
    print("  操作者     : %s (id=%d)" % (OPERATOR_USERNAME, OPERATOR_USER_ID))
    if len(ids) != len(s["targets"]):
        print("  ⚠️ 去重后数量与快照不一致，请检查快照是否有重复 ID")
    return 0


def push():
    r = deploy.R()
    try:
        o, _ = r.run("mkdir -p %s && echo OK" % deploy.shq(REMOTE_DIR))
        if "OK" not in o:
            deploy.die("远端目录创建失败", 3)
        r.sftp.put(LOCAL_JOB, REMOTE_JOB)
        # 复核：远端内容与本地完全一致
        o, _ = r.run("sha256sum %s | cut -c1-16" % deploy.shq(REMOTE_JOB))
        local = deploy.sha_local(LOCAL_JOB)[:16]
        print("上传完成：%s" % REMOTE_JOB)
        print("  本地 sha256[:16] = %s" % local)
        print("  远端 sha256[:16] = %s" % o.strip())
        if o.strip() != local:
            deploy.die("引导文件传输不一致 —— 未触发", 7)
        o, _ = r.run("python3 -c \"import json,sys;d=json.load(open('%s'));print(len(d['ticketIds']),d['batchTag'])\"" % REMOTE_JOB)
        print("  远端解析：%s" % o.strip())
        return 0
    finally:
        r.close()


def verify():
    r = deploy.R()
    try:
        print("===== A. 工单状态分布 =====")
        o, _ = r.psql("SELECT status, count(*) FROM service_tickets GROUP BY status ORDER BY status")
        print(o)
        o, _ = r.psql("SELECT count(*) FROM service_tickets")
        print("总数 = %s" % o.strip())

        print("===== B. 事件 / Visit / 短信 基线对比 =====")
        o, _ = r.psql("SELECT count(*) FROM ticket_events")
        print("ticket_events = %s" % o.strip())
        o, _ = r.psql("SELECT count(*) FROM service_visits")
        print("service_visits = %s" % o.strip())
        o, _ = r.psql("SELECT count(*) FROM sms_logs")
        print("sms_logs = %s" % o.strip())

        print("===== C. 本次关单事件 =====")
        o, _ = r.psql(
            "SELECT count(*) FROM ticket_events WHERE event_type='closed' AND metadata_json->>'repair'='%s'"
            % BATCH_TAG)
        print("本批 closed 事件数 = %s" % o.strip())
        o, _ = r.psql(
            "SELECT count(DISTINCT ticket_id) FROM ticket_events WHERE event_type='closed' AND metadata_json->>'repair'='%s'"
            % BATCH_TAG)
        print("涉及工单数 = %s" % o.strip())

        print("===== D. 残留有效作业权限 =====")
        o, _ = r.psql("SELECT visit_status, count(*) FROM service_visits GROUP BY visit_status ORDER BY visit_status")
        print(o)
        o, _ = r.psql(
            "SELECT count(*) FROM service_visits v JOIN service_tickets t ON t.id=v.ticket_id "
            "WHERE v.visit_status='ASSIGNED' AND t.status IN ('NEW','PROCESSING','WAIT_STORE_CONFIRM','WAIT_FEEDBACK')")
        print("非终态工单上的 ASSIGNED Visit = %s（应为 0）" % o.strip())

        print("===== E. 残留可用评价 Token =====")
        o, _ = r.psql(
            "SELECT count(*) FROM service_tickets WHERE status IN ('NEW','PROCESSING','WAIT_STORE_CONFIRM','WAIT_FEEDBACK') "
            "AND review_status='pending'")
        print("非终态且 review_status='pending' = %s（应为 0）" % o.strip())

        print("===== F. 执行结果文件 =====")
        o, _ = r.run("ls -la %s/ 2>/dev/null" % deploy.shq(REMOTE_DIR))
        print(o)
        return 0
    finally:
        r.close()


if __name__ == "__main__":
    if "--build" in sys.argv:
        sys.exit(build())
    if "--push" in sys.argv:
        sys.exit(push())
    if "--verify" in sys.argv:
        sys.exit(verify())
    print(__doc__)
