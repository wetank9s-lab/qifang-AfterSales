-- 清掉 smoke/并发脚本刚造的噪声工单（id ≥ 1041，customer_name='并发验收'）
-- 走查基线只保留 4 张：35 / 886 / 1039 / 1040
BEGIN;

-- 前置断言：待删的必须都是"脚本噪声"，且不挂 Visit（若挂了说明是真验收数据，别删）
DO $$
DECLARE n int; bad int;
BEGIN
  SELECT count(*) INTO n FROM service_tickets
   WHERE id >= 1041 AND customer_name IN ('并发验收','Phase31 手工验证','探针');
  IF n = 0 THEN
    RAISE EXCEPTION '没有可清噪声（id>=1041 且已知脚本客户名）—— 数据已变化，中止以免误删';
  END IF;
  SELECT count(*) INTO bad FROM service_tickets t
   WHERE t.id >= 1041
     AND t.customer_name NOT IN ('并发验收','Phase31 手工验证','探针')
     AND NOT EXISTS (SELECT 1 FROM service_visits v WHERE v.ticket_id = t.id);
  IF bad > 0 THEN
    RAISE EXCEPTION 'id>=1041 里有 % 张**非脚本**工单（可能是真人数据），中止清理', bad;
  END IF;
  IF EXISTS (SELECT 1 FROM service_visits WHERE ticket_id >= 1041) THEN
    RAISE EXCEPTION '待删工单已挂 Visit（可能是验收证据），中止';
  END IF;
END $$;

DELETE FROM idempotency_records
 WHERE resource_type = 'serviceTicket' AND resource_id >= 1041;
DELETE FROM ticket_events   WHERE ticket_id >= 1041;
DELETE FROM service_visits  WHERE ticket_id >= 1041;
DELETE FROM service_tickets WHERE id        >= 1041
   AND customer_name IN ('并发验收','Phase31 手工验证','探针');

-- 后置断言：必须正好剩 4 张且就是走查基线
DO $$
DECLARE n int; kept text;
BEGIN
  SELECT count(*) INTO n FROM service_tickets;
  IF n <> 4 THEN RAISE EXCEPTION '清理后工单数=%（期望 4）—— ROLLBACK', n; END IF;
  SELECT string_agg(id::text, ',' ORDER BY id) INTO kept FROM service_tickets;
  IF kept <> '35,886,1039,1040' THEN
    RAISE EXCEPTION '清理后清单=%（期望 35,886,1039,1040）—— ROLLBACK', kept;
  END IF;
  IF (SELECT count(*) FROM service_visits) <> 0 THEN
    RAISE EXCEPTION '清理后仍有 Visit —— 走查起点应为 0，ROLLBACK';
  END IF;
END $$;

COMMIT;
