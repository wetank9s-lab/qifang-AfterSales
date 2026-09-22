-- 收敛 UAT 工单基线：每个门店只留一张，删除被取代的旧夹具 885 / 887
-- 保留：35（历史样例）、886（S01 走查主单）、1040（S02 反证）、1039（S01 备用）
-- 注意 886/887 的旧巡检工单不再需要，改用新造的 1039/1040（单号更贴近当下库龄）
BEGIN;

-- 前置断言：待删的两张必须存在且仍为 NEW 且无 Visit（否则说明已被人动过，别删）
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM service_tickets WHERE id IN (885, 887) AND status = 'NEW';
  IF n <> 2 THEN
    RAISE EXCEPTION '待删夹具 885/887 状态异常（期望 2 张 NEW，实际 %）—— 中止', n;
  END IF;
  IF EXISTS (SELECT 1 FROM service_visits WHERE ticket_id IN (885, 887)) THEN
    RAISE EXCEPTION '待删夹具已挂 Visit（验收证据），不能删 —— 中止';
  END IF;
END $$;

DELETE FROM idempotency_records
 WHERE resource_type = 'serviceTicket' AND resource_id IN (885, 887);
DELETE FROM ticket_events    WHERE ticket_id IN (885, 887);
DELETE FROM service_visits   WHERE ticket_id IN (885, 887);
DELETE FROM service_tickets  WHERE id        IN (885, 887);

-- 后置断言：正好剩 4 张，且就是预期清单
DO $$
DECLARE n int; kept text;
BEGIN
  SELECT count(*) INTO n FROM service_tickets;
  IF n <> 4 THEN
    RAISE EXCEPTION '收敛后工单数不符：期望 4，实际 % —— ROLLBACK', n;
  END IF;
  SELECT string_agg(id::text, ',' ORDER BY id) INTO kept FROM service_tickets;
  IF kept <> '35,886,1039,1040' THEN
    RAISE EXCEPTION '收敛后清单不符：实际 % —— ROLLBACK', kept;
  END IF;
END $$;

COMMIT;
