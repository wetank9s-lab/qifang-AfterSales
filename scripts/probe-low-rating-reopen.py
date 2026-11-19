#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
P0-LOW-RATING-CLOSE · 只读排查：找出因"低评分 / 收费不一致"被自动重开的工单。

**全程只读**：只执行 SELECT。不建工单、不发短信、不改任何状态字段。

判据来源（从源码抄，不猜）：
  · `ticket-service.ts:3780-3799` 在 reopen 时补写一条 `reopened` 事件，
    summary 区分两种原因：
      - '客户评分低于阈值（N 星），工单已重开待门店处理'   ← 低评分
      - '客户反馈收费金额不一致，工单已重开待门店处理'     ← 收费不一致
    metadata 带 `reopen_reason`（`low_score` / `charge_mismatch`）与 `reopen_count_after`。
  · Ticket 侧字段：`reopen_count` / `escalated` / `status` / `closed_at` / `close_reason`
    / `review_status` / `rating` / `reviewed_at`。
"""
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("dep", os.path.join(ROOT, "scripts", "prod-deploy-sms-fix-01.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

QUERIES = [
    ("1. 全部 reopened 事件（时间倒序，最多 50 条）", """
SELECT e.id, e.ticket_id, t.ticket_no, t.status, t.review_status, t.rating,
       t.reopen_count, t.escalated, t.closed_at, t.close_reason, t.reviewed_at,
       e.created_at AS reopened_at,
       COALESCE(e.metadata_json->>'reopen_reason','(无)') AS reason,
       LEFT(REPLACE(e.summary, chr(10), ' '), 50) AS summary
FROM ticket_events e
JOIN service_tickets t ON t.id = e.ticket_id
WHERE e.event_type = 'reopened'
ORDER BY e.id DESC
LIMIT 50
"""),
    ("2. 按 reopen_reason 汇总", """
SELECT COALESCE(metadata_json->>'reopen_reason','(无)') AS reason,
       COUNT(*) AS cnt, MIN(created_at) AS first_at, MAX(created_at) AS last_at
FROM ticket_events
WHERE event_type = 'reopened'
GROUP BY 1 ORDER BY 2 DESC
"""),
    ("3. 因低评分重开、当前仍 PROCESSING（=尚未闭环）", """
SELECT t.id, t.ticket_no, t.status, t.rating, t.reopen_count, t.escalated,
       t.closed_at, t.reviewed_at,
       (SELECT MAX(e.created_at) FROM ticket_events e
         WHERE e.ticket_id=t.id AND e.event_type='reopened') AS reopened_at
FROM service_tickets t
WHERE t.reopen_count >= 1 AND t.status = 'PROCESSING'
ORDER BY t.id DESC
LIMIT 50
"""),
    ("4. 已评价工单的评分分布（低分样本量）", """
SELECT rating, COUNT(*) AS cnt FROM service_tickets
WHERE review_status='submitted' GROUP BY rating ORDER BY rating
"""),
    ("5. reopen_count 分布（不限状态）", """
SELECT reopen_count, COUNT(*) AS cnt FROM service_tickets
GROUP BY reopen_count ORDER BY reopen_count
"""),
]


def main() -> int:
    r = m.R()
    try:
        for title, sql in QUERIES:
            print()
            print("=" * 100)
            print(title)
            print("=" * 100)
            try:
                out, err = r.psql(sql)
            except Exception as ex:  # noqa: BLE001
                print("[FAIL] %s" % ex)
                continue
            if err and str(err).strip():
                print("[stderr] " + str(err).strip()[:400])
            print(out.strip() if out and out.strip() else "(空)")
    finally:
        r.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
