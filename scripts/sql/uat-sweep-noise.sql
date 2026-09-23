-- 清掉 smoke / 并发 / 契约验收脚本造出来的噪声工单（id ≥ 1041）
-- 走查基线只保留 4 张：35 / 886 / 1039 / 1040
--
-- ⚠️ 本脚本只负责"删噪声"；把 4 张 UAT 单**打回全新状态**是另一件事，
--    见 uat-reset-fixtures.sql（真人走查会往夹具上写 Visit/事件，那个必须单独复位）。
--    两个脚本的顺序固定：**先 sweep（删噪声）→ 再 reset fixtures（打回起点）**。
BEGIN;

-- 前置断言：待删的必须都是"脚本噪声"
DO $$
DECLARE n int; bad int;
BEGIN
  SELECT count(*) INTO n FROM service_tickets
   WHERE id >= 1041 AND customer_name IN ('并发验收','Phase31 手工验证','探针','P0契约验收');
  IF n = 0 THEN
    RAISE EXCEPTION '没有可清噪声（id>=1041 且已知脚本客户名）—— 数据已变化，中止以免误删';
  END IF;
  SELECT count(*) INTO bad FROM service_tickets t
   WHERE t.id >= 1041
     AND t.customer_name NOT IN ('并发验收','Phase31 手工验证','探针','P0契约验收')
     AND NOT EXISTS (SELECT 1 FROM service_visits v WHERE v.ticket_id = t.id);
  IF bad > 0 THEN
    RAISE EXCEPTION 'id>=1041 里有 % 张**非脚本**工单（可能是真人数据），中止清理', bad;
  END IF;
  -- ⚠️ 这一条原本是"只要 id>=1041 挂着 Visit 就中止"（保护验收证据）。
  --    但 `verify-reassign-contract.mjs` 的契约验收单**天然会挂 Visit**
  --    （它要走的正是 受理→派工→改派）。于是判据收窄成
  --    "**非脚本客户名**的单挂了 Visit 才中止" —— 保护意图不变，
  --    但不再把"客户名明显是脚本造的"那张当成真人证据。
  IF EXISTS (
    SELECT 1 FROM service_visits v JOIN service_tickets t ON t.id = v.ticket_id
     WHERE t.id >= 1041
       AND t.customer_name NOT IN ('并发验收','Phase31 手工验证','探针','P0契约验收')
  ) THEN
    RAISE EXCEPTION '待删范围里有**非脚本**工单挂着 Visit（可能是验收证据），中止';
  END IF;
END $$;

-- 依赖顺序：幂等记录与短信日志都要在删 Visit / 工单之前处理
DELETE FROM idempotency_records
 WHERE resource_type = 'serviceTicket' AND resource_id >= 1041;
DELETE FROM idempotency_records
 WHERE resource_type = 'serviceVisit'
   AND resource_id IN (SELECT id FROM service_visits WHERE ticket_id >= 1041);
-- ⚠️ 短信日志此前**被漏掉了**：噪声工单的 sms_logs 一直在库里累积，
--    于是下一轮"短信条数/三 scene"类断言会读到一个越来越大的背景值。
DELETE FROM sms_logs       WHERE ticket_id >= 1041;
DELETE FROM ticket_events   WHERE ticket_id >= 1041;
DELETE FROM service_visits  WHERE ticket_id >= 1041;
DELETE FROM service_tickets WHERE id        >= 1041
   AND customer_name IN ('并发验收','Phase31 手工验证','探针','P0契约验收');

-- 后置断言：噪声清干净了，且**噪声范围内**不再有 Visit。
-- ⚠️ 这里刻意**不**断言"全库 Visit = 0"：真人走查会在 UAT 夹具上留下 Visit，
--    那是 uat-reset-fixtures.sql 的职责（它跑在后面）。
--    断言写错位置会让"走查结束后复位"这一步永远失败（实测踩过）。
DO $$
DECLARE n int; kept text;
BEGIN
  SELECT count(*) INTO n FROM service_tickets;
  IF n <> 4 THEN RAISE EXCEPTION '清理后工单数=%（期望 4）—— ROLLBACK', n; END IF;
  SELECT string_agg(id::text, ',' ORDER BY id) INTO kept FROM service_tickets;
  IF kept <> '35,886,1039,1040' THEN
    RAISE EXCEPTION '清理后清单=%（期望 35,886,1039,1040）—— ROLLBACK', kept;
  END IF;
  IF EXISTS (SELECT 1 FROM service_visits WHERE ticket_id >= 1041) THEN
    RAISE EXCEPTION '清理后噪声范围内仍有 Visit —— ROLLBACK';
  END IF;
END $$;

COMMIT;
