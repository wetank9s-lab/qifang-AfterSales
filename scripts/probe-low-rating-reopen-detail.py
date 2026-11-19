#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
P0-LOW-RATING-CLOSE · 只读排查（第二层）：重开工单是否已进入"第二轮业务处理"。

为什么必须查这一层：
  用户明确要求 —— 只有「仅因低评分重开、且尚无第二轮业务处理」的工单才可以关单修复；
  一旦已经派工/上门/有新 Visit/有新回执，就是真的有第二轮在跑，**不得自动关闭**。

判据（逐项给出，不做推断）：
  · 重开事件之后，是否出现 dispatched / assigned / visit_* / confirmed / submitted 等事件；
  · 是否存在 `assigned_at`（或 created_at）晚于重开时间的 ServiceVisit；
  · 当前是否存在 status='assigned'/'in_service' 的活动 Visit；
  · 收费争议：Visit.customer_charge_match = 'mismatch' 或 ticket 上有收费差异记录；
  · 短信：重开之后是否有新的 send_status='accepted' 的派工类短信。
"""
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("dep", os.path.join(ROOT, "scripts", "prod-deploy-sms-fix-01.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

TARGET_IDS = "6944, 6931, 6927, 3069"

QUERIES = [
    ("A. 4 张工单总览", """
SELECT t.id, t.ticket_no, t.status, t.rating, t.reopen_count, t.escalated,
       t.closed_at, t.close_reason, t.reviewed_at,
       t.feedback_visit_id,
       t.review_comment IS NOT NULL AS has_comment,
       t.store_id
FROM service_tickets t WHERE t.id IN (%s) ORDER BY t.id DESC
""" % TARGET_IDS),

    ("B. 每张工单的全部事件（时间正序，看重开后有没有新动作）", """
SELECT e.ticket_id, e.id AS event_id, e.created_at, e.event_type,
       e.from_status, e.to_status, e.visit_id, e.operator_kind,
       LEFT(REPLACE(e.summary, chr(10), ' '), 46) AS summary
FROM ticket_events e
WHERE e.ticket_id IN (%s)
ORDER BY e.ticket_id DESC, e.id
""" % TARGET_IDS),

    ("C. 这些工单的所有 ServiceVisit（看有没有第二轮）", """
SELECT v.id AS visit_id, v.ticket_id, v.visit_status, v.visit_no,
       v.assigned_at, v.submitted_at, v.store_confirmed_at,
       v.created_at, v.technician_name,
       v.customer_charge_match, v.customer_reported_amount, v.charge_diff_reason,
       v.confirmed_charge_amount
FROM service_visits v
WHERE v.ticket_id IN (%s)
ORDER BY v.ticket_id DESC, v.id
""" % TARGET_IDS),

    ("D. 重开时间之后是否有新事件（关键判据：应为空才可关单）", """
SELECT t.id AS ticket_id, t.ticket_no,
       r.reopened_at,
       COUNT(e.id) AS events_after_reopen,
       STRING_AGG(DISTINCT e.event_type, ',') AS types_after
FROM service_tickets t
JOIN LATERAL (
  SELECT MAX(created_at) AS reopened_at FROM ticket_events
  WHERE ticket_id=t.id AND event_type='reopened'
) r ON TRUE
LEFT JOIN ticket_events e
  ON e.ticket_id=t.id AND e.created_at > r.reopened_at
WHERE t.id IN (%s)
GROUP BY t.id, t.ticket_no, r.reopened_at
ORDER BY t.id DESC
""" % TARGET_IDS),

    ("E. 重开之后是否有新短信（派工类）", """
SELECT t.id AS ticket_id, t.ticket_no,
       COUNT(s.id) AS sms_after_reopen,
       STRING_AGG(DISTINCT s.scene, ',') AS scenes
FROM service_tickets t
JOIN LATERAL (
  SELECT MAX(created_at) AS reopened_at FROM ticket_events
  WHERE ticket_id=t.id AND event_type='reopened'
) r ON TRUE
LEFT JOIN sms_logs s ON s.ticket_id=t.id AND s.created_at > r.reopened_at
WHERE t.id IN (%s)
GROUP BY t.id, t.ticket_no
ORDER BY t.id DESC
""" % TARGET_IDS),
]


def main() -> int:
    r = m.R()
    try:
        for title, sql in QUERIES:
            print()
            print("=" * 110)
            print(title)
            print("=" * 110)
            try:
                out, err = r.psql(sql)
            except Exception as ex:  # noqa: BLE001
                print("[FAIL] %s" % ex)
                continue
            if err and str(err).strip():
                print("[stderr] " + str(err).strip()[:500])
            print(out.strip() if out and out.strip() else "(空)")
    finally:
        r.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
