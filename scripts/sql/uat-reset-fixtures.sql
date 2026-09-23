-- 走查后的「夹具复位」：把 4 张 UAT 工单恢复成**全新**状态，并清掉它们的 Visit/事件/短信。
-- =============================================================================
-- 为什么需要它（这不是"方便脚本"，是在补一个真的缺口）：
--   `uat-sweep-noise.sql` 只负责**删脚本噪声**（id ≥ 1041），并且会断言
--   "库里 Visit 数 = 0"。而**真人走查本身就会往 UAT 工单上写 Visit 与事件** ——
--   于是走查一结束，那个断言必然失败（实测：第二轮走查后 1039 上留下 1 条 ASSIGNED Visit、
--   11 条事件），复位流程直接卡死，下一轮走查只能靠手工改库开始。
--   ⇒ 复位必须同时包含"清噪声"与"把夹具打回起点"两件事。
--
-- 安全边界（刻意的）：
--   · 只认白名单 4 个 id，**不用任何范围条件**（不删"看起来像测试的"东西）
--   · 白名单外的工单本脚本**一行都不碰**（噪声交给 uat-sweep-noise.sql）
--   · 前后置断言：任一不符即 ROLLBACK
--
-- 幂等：可重复执行（第二次执行前后置断言都成立）
BEGIN;

-- 前置断言：白名单必须一条不少，且都是已知的 UAT 专用单
DO $$
DECLARE n int; bad int;
BEGIN
  SELECT count(*) INTO n FROM service_tickets WHERE id IN (35, 886, 1039, 1040);
  IF n <> 4 THEN
    RAISE EXCEPTION 'UAT 夹具不齐：期望 4 张，实际 % —— 中止复位', n;
  END IF;
  -- 防止"id 被复用/换过内容"：这些单必须还是 UAT 走查专用单
  SELECT count(*) INTO bad FROM service_tickets
   WHERE id IN (35, 886, 1039, 1040)
     AND content NOT LIKE '%UAT%' AND content NOT LIKE '%冰箱不制冷%';
  IF bad > 0 THEN
    RAISE EXCEPTION '白名单里有 % 张不是 UAT 夹具（内容不符）—— 中止复位', bad;
  END IF;
END $$;

-- ① 依赖行：先拆干净再删 Visit（顺序不可反）
--    幂等记录要按两类资源 id 删：工单级与 Visit 级
DELETE FROM idempotency_records
 WHERE (resource_type = 'serviceTicket' AND resource_id IN (35, 886, 1039, 1040))
    OR (resource_type = 'serviceVisit'
        AND resource_id IN (SELECT id FROM service_visits WHERE ticket_id IN (35, 886, 1039, 1040)));
--    短信日志：走查期间派工/改派会真的入队（mock 通道），不复位会污染下一轮的"短信条数"断言
DELETE FROM sms_logs     WHERE ticket_id IN (35, 886, 1039, 1040);
DELETE FROM ticket_events WHERE ticket_id IN (35, 886, 1039, 1040);
DELETE FROM service_visits WHERE ticket_id IN (35, 886, 1039, 1040);

-- ② 工单主表打回"刚建出来"的状态（保留 id / ticket_no / 客户信息 / 门店 / 内容 / extra_json）
DO $$
DECLARE
  ids int[] := ARRAY[35, 886, 1039, 1040];
  rowcount int := 0;
BEGIN
  UPDATE service_tickets t SET
    status                    = 'NEW',
    handler_user_id           = NULL,
    service_mode              = NULL,
    provider_name             = NULL,
    technician_name           = NULL,
    technician_mobile         = NULL,
    expected_visit_at         = NULL,
    dispatch_at               = NULL,
    completion_result         = NULL,
    completion_note           = NULL,
    completed_at              = NULL,
    rating                    = NULL,
    review_comment            = NULL,
    reviewed_at               = NULL,
    review_status             = NULL,
    feedback_token_hash       = NULL,
    feedback_token_expires_at = NULL,
    feedback_token_used_at    = NULL,
    escalated                 = false,
    reopen_count              = 0,
    close_reason              = NULL,
    first_response_at         = NULL,
    closed_at                 = NULL,
    feedback_visit_id         = NULL,
    updated_at                = now()
   WHERE t.id = ANY(ids);
  GET DIAGNOSTICS rowcount = ROW_COUNT;
  IF rowcount <> 4 THEN
    RAISE EXCEPTION '复位影响了 % 行（期望 4）—— ROLLBACK', rowcount;
  END IF;
END $$;

-- ③ 后置断言：必须真的是"全新"状态，而不是"看起来像"
DO $$
DECLARE
  ids int[] := ARRAY[35, 886, 1039, 1040];
  bad int;
BEGIN
  SELECT count(*) INTO bad FROM service_tickets t
   WHERE t.id = ANY(ids)
     AND (t.status <> 'NEW' OR t.handler_user_id IS NOT NULL
          OR t.service_mode IS NOT NULL OR t.provider_name IS NOT NULL
          OR t.technician_name IS NOT NULL OR t.technician_mobile IS NOT NULL
          OR t.expected_visit_at IS NOT NULL OR t.dispatch_at IS NOT NULL
          OR t.completion_result IS NOT NULL OR t.completed_at IS NOT NULL
          OR t.first_response_at IS NOT NULL OR t.closed_at IS NOT NULL
          OR t.escalated OR t.reopen_count <> 0 OR t.feedback_visit_id IS NOT NULL);
  IF bad > 0 THEN
    RAISE EXCEPTION '复位后仍有 % 张不是全新状态 —— ROLLBACK', bad;
  END IF;

  IF (SELECT count(*) FROM service_visits  WHERE ticket_id = ANY(ids)) <> 0 THEN
    RAISE EXCEPTION '复位后仍挂着 Visit —— ROLLBACK';
  END IF;
  IF (SELECT count(*) FROM ticket_events  WHERE ticket_id = ANY(ids)) <> 0 THEN
    RAISE EXCEPTION '复位后仍留着事件 —— ROLLBACK';
  END IF;
  IF (SELECT count(*) FROM sms_logs       WHERE ticket_id = ANY(ids)) <> 0 THEN
    RAISE EXCEPTION '复位后仍留着短信日志 —— ROLLBACK';
  END IF;
  -- 全库层面的最终判据（与 uat-reset-baseline.mjs 的期望一致）
  IF (SELECT count(*) FROM service_tickets) <> 4 THEN
    RAISE EXCEPTION '复位后工单总数 <> 4 —— 说明噪声没清干净，请先跑 uat-sweep-noise.sql';
  END IF;
  IF (SELECT count(*) FROM service_visits) <> 0 THEN
    RAISE EXCEPTION '复位后全库仍有 Visit —— ROLLBACK';
  END IF;
END $$;

COMMIT;
