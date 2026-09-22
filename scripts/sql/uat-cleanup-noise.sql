-- UAT 走查前清理：只清脚本造的噪声工单，保留真人 UAT 工单
-- 保留：id 885 FW20260922-0001 / 886 FW20260922-0002 / 887 FW20260922-0003
-- 注意：本条 SQL 自带事务与自校验，任一步不符即 ROLLBACK。
BEGIN;

CREATE TEMP TABLE noise ON COMMIT DROP AS
SELECT id FROM service_tickets
WHERE id NOT IN (885, 886, 887)
  AND (
        customer_name IN ('并发验收', 'Phase31 手工验证', '探针')
     OR customer_name LIKE '测2026%'
     OR customer_name LIKE '幂等-%'
     OR ticket_no    LIKE 'FWPROBE%'
     OR ticket_no    ~ '^FW[A-Z][0-9]'
     OR content      LIKE '[并发压测%'
     OR content      LIKE '[幂等验证%'
     OR content      LIKE '[PROBE]%'
  );

-- 前置断言：噪声必须恰好 231 条（235 - 4 保留）
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM noise;
  IF n <> 231 THEN
    RAISE EXCEPTION '噪声条数不符：期望 231，实际 % —— 数据已变化，中止清理', n;
  END IF;
  -- 保留清单必须一条不少
  IF (SELECT count(*) FROM service_tickets WHERE id IN (885, 886, 887)) <> 3 THEN
    RAISE EXCEPTION 'UAT 保留工单缺失，中止清理';
  END IF;
END $$;

-- 按依赖顺序删除
DELETE FROM idempotency_records
 WHERE resource_type = 'serviceTicket' AND resource_id IN (SELECT id FROM noise);
DELETE FROM ticket_events      WHERE ticket_id IN (SELECT id FROM noise);
DELETE FROM service_visits     WHERE ticket_id IN (SELECT id FROM noise);
DELETE FROM service_tickets    WHERE id        IN (SELECT id FROM noise);

-- 后置断言：必须正好剩 4 条，且就是保留清单
DO $$
DECLARE n int; kept text;
BEGIN
  SELECT count(*) INTO n FROM service_tickets;
  IF n <> 4 THEN
    RAISE EXCEPTION '清理后工单数不符：期望 4，实际 % —— ROLLBACK', n;
  END IF;
  SELECT string_agg(id::text, ',' ORDER BY id) INTO kept FROM service_tickets;
  IF kept <> '35,885,886,887' THEN
    RAISE EXCEPTION '清理后保留清单不符：实际 % —— ROLLBACK', kept;
  END IF;
END $$;

COMMIT;
