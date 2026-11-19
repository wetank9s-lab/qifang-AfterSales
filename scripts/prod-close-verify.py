#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""关单后五项验收的定量核验（只读）。

验收口径（用户第四部分）：
  1 应用正常、产物正确         → 由 prod-deploy 的健康检查与指纹复核覆盖
  2 新规则不因 1 星评价重开     → 产物内 `|| lowScore` 已消失（见 feature-survival）
  3 快照中应关的均已 CLOSED、原 CANCELLED 不变
  4 无残留有效作业权限、无重复事件、无意外短信
  5 原始评价与工单历史完整保留
"""
import importlib.util
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("deploy", os.path.join(ROOT, "scripts", "prod-deploy-lrc.py"))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

SNAP = os.path.join(ROOT, ".tmp-verify/prod-close-test/snapshot-latest.json")
snap = json.load(open(SNAP, encoding="utf-8"))
targets = [int(t["id"]) for t in snap["targets"]]
lst = ",".join(str(x) for x in targets)

r = deploy.R()
ok = True


def chk(name, got, want, note=""):
    global ok
    good = str(got).strip() == str(want).strip()
    if not good:
        ok = False
    print("  %-46s %-10s 期望 %-8s %s %s" % (name, got, want, "PASS" if good else "**FAIL**", note))


try:
    print("\n【3】快照目标集终态 + 原 CANCELLED 不变")
    o, _ = r.psql("SELECT status,count(*) FROM service_tickets WHERE id IN (%s) GROUP BY status" % lst)
    print("      目标集状态分布：", o.strip().replace("\n", " / "))
    o, _ = r.psql("SELECT count(*) FROM service_tickets WHERE id IN (%s) AND status='CLOSED'" % lst)
    chk("目标集 CLOSED 数", o.strip(), len(targets))

    o, _ = r.psql("SELECT count(*) FROM service_tickets WHERE status='CANCELLED'")
    chk("全表 CANCELLED 数（应与快照 29 相同）", o.strip(), 29)
    o, _ = r.psql("SELECT count(*) FROM service_tickets WHERE status='CANCELLED' AND close_reason<>'cancelled'")
    chk("CANCELLED 但 close_reason 被改的（应为 0）", o.strip(), 0)

    print("\n【4a】无残留有效作业权限")
    o, _ = r.psql("SELECT count(*) FROM service_visits WHERE visit_status='ASSIGNED'")
    chk("全表 ASSIGNED Visit（应为 0）", o.strip(), 0)
    o, _ = r.psql(
        "SELECT count(*) FROM service_visits WHERE visit_status='CANCELLED' AND token_revoked_at IS NULL")
    chk("CANCELLED 但 Token 未吊销（应为 0）", o.strip(), 0)

    print("\n【4b】无重复事件")
    o, _ = r.psql(
        "SELECT count(*) FROM (SELECT ticket_id,count(*) c FROM ticket_events "
        "WHERE event_type='closed' AND metadata_json->>'repair'='P0-LOW-RATING-CLOSE' "
        "GROUP BY ticket_id HAVING count(*)>1) x")
    chk("本批 closed 事件重复的工单数（应为 0）", o.strip(), 0)
    o, _ = r.psql(
        "SELECT count(*) FROM ticket_events WHERE event_type='closed' "
        "AND (metadata_json->>'repair' IS NULL OR metadata_json->>'repair'<>'P0-LOW-RATING-CLOSE')")
    # ⚠️ 口径修正：历史 128 张 CLOSED 里只有 review_expired 的 79 张留了 `closed` 事件，
    #    review_expired/reviewed 两条路径当年只记 `reviewed` 事件。所以"原有 closed 事件"= 79，
    #    不是 128。全表 closed 应为 79 + 368 = 447。
    hist_closed = int(o.strip())
    print("      本批之外的 closed 事件（历史遗留，应为 79）：", hist_closed)
    o, _ = r.psql("SELECT count(*) FROM ticket_events WHERE event_type='closed'")
    chk("全表 closed 事件数（79 历史 + 368 本批）", o.strip(), hist_closed + len(targets))

    print("\n【4c】无意外短信")
    o, _ = r.psql("SELECT count(*) FROM sms_logs")
    chk("sms_logs 总数（快照基线 860）", o.strip(), snap["baseline_sms"])
    o, _ = r.psql(
        "SELECT count(*) FROM sms_logs WHERE created_at > now() - interval '30 minutes'")
    chk("近 30 分钟新增短信（应为 0）", o.strip(), 0)
    o, _ = r.psql("SELECT count(*) FROM ticket_events")
    chk("ticket_events 总数（2023 + 368）", o.strip(), 368 + snap["baseline_events"])

    print("\n【5】原始评价与工单历史完整保留")
    o, _ = r.psql("SELECT count(*) FROM service_tickets WHERE rating IS NOT NULL")
    print("      有评分的工单数：", o.strip())
    o, _ = r.psql("SELECT count(*) FROM service_tickets WHERE review_comment IS NOT NULL AND review_comment<>''")
    print("      有评价内容的工单数：", o.strip())
    o, _ = r.psql("SELECT count(*) FROM service_tickets WHERE reopen_count>0")
    print("      reopen_count>0 的工单数（未被清零）：", o.strip())
    o, _ = r.psql("SELECT count(*) FROM service_visits")
    chk("service_visits 总数（快照基线 299，不得删）", o.strip(), snap["baseline_visits"])
    o, _ = r.psql("SELECT count(*) FROM ticket_events WHERE event_type='reopened'")
    print("      历史 reopened 事件数（保留）：", o.strip())

    print("\n【5b】低分评价是否被误改")
    o, _ = r.psql(
        "SELECT count(*) FROM service_tickets WHERE rating<=2 AND status='CLOSED' "
        "AND reviewed_at IS NOT NULL")
    print("      1~2 星且已 CLOSED（正常闭环）：", o.strip())
    o, _ = r.psql("SELECT count(*) FROM service_tickets WHERE status='CLOSED' AND closed_at IS NULL")
    chk("CLOSED 但 closed_at 为空（应为 0）", o.strip(), 0)
    o, _ = r.psql(
        "SELECT count(*) FROM service_tickets WHERE status='CLOSED' AND close_reason IS NULL")
    chk("CLOSED 但 close_reason 为空（应为 0）", o.strip(), 0)

    print("\n【3b】本批事件的可追溯性")
    o, _ = r.psql(
        "SELECT count(*) FROM ticket_events WHERE event_type='closed' "
        "AND metadata_json->>'repair'='P0-LOW-RATING-CLOSE' AND operator_kind='hq'")
    chk("本批事件 operator_kind='hq' 数（应为 368）", o.strip(), 368)
    o, _ = r.psql(
        "SELECT count(*) FROM ticket_events WHERE event_type='closed' "
        "AND metadata_json->>'repair'='P0-LOW-RATING-CLOSE' AND summary LIKE '%测试数据统一关单%'")
    chk("本批事件含「测试数据统一关单」文案数", o.strip(), 368)

    print("\n【异常工单】")
    o, _ = r.psql("SELECT status,close_reason,count(*) FROM service_tickets GROUP BY status,close_reason ORDER BY status")
    print(o)

finally:
    r.close()

print("\n===== 总结论：" + ("全部 PASS" if ok else "存在 FAIL 项，需人工复核") + " =====")
