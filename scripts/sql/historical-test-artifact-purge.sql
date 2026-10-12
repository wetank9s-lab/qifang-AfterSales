-- =============================================================================
-- 定向处置：由**验收缺陷**产生的两张当前服务单
--   FW20261012-0019 / FW20261012-0020
-- =============================================================================
--
-- 背景（事故原因，写进审计）：
--   P11-3 第 4 项开发期间，"转为当前服务单"的建单返回值取错
--   （`TicketService.create()` 返回 `{ticket,event,store}`，当时按 `{id,ticket_no}` 取），
--   导致接口先建出工单、再在写转换记录时崩掉并回 500。
--   于是留下了**两张没有任何业务关联的孤儿工单** —— 接口说失败，数据却变了。
--   详见 `docs/DEVIATIONS.md` 与 `docs/P11-3-HISTORICAL-IMPORT.md` §9.8 第 2 条。
--
-- =============================================================================
-- 这份脚本的设计原则（用户 2026-10-12 第二项的原话逐条对应）
-- =============================================================================
--  「不得**静默删除历史事实**」        ⇒ 先把**前状态快照**写进审计，再删；
--                                        删的是"当前工单"，留下的是一条可追溯的处置记录。
--  「不得伪装成普通客户取消」          ⇒ **不**用 status='cancelled' 这种业务语义；
--                                        本脚本不做状态流转，只做"定向摘除 + 留痕"。
--  「不得操作其他服务单」              ⇒ 待删集合由**传入的两个工单号**决定，
--                                        并断言"库里没有第三个同类孤儿"（有则中止）。
--  「若无法证明安全条件，先隔离并报告」⇒ 前置断言不通过就 RAISE EXCEPTION
--                                        （ON_ERROR_STOP=1 ⇒ 整个事务回滚）。
--
-- ⚠️ 用法（参数由 `scripts/purge-historical-test-artifacts.mjs` 传入）：
--     psql -v ON_ERROR_STOP=1 -v t1=FW... -v t2=FW... -v operator=... -v reason=... -f -
--     ⚠️ **本脚本必须由人确认后执行**；它不在任何自动门禁里被调用。
--
-- 依赖顺序：幂等记录 / 事件 → 工单（先子后父，避免外键残留）
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- ⓿ 把传入的变量放进**事务级 GUC**
-- -----------------------------------------------------------------------------
-- ⚠️ psql 的 `:'name'` 变量替换**不会进入 `DO $$ ... $$` 的块体**
--    （块体对 psql 而言是一段字符串字面量）⇒ 直接在 DO 里写 `:'t1'` 会
--    在**运行时**报 `syntax error at or near ":"`（实测踩到）。
--    正确做法：在这里（顶层语句）把它们落成 GUC，块内用 `current_setting()` 取。
--    `set_config(..., true)` 的第三个参数 = 只在当前事务内有效。
SELECT set_config('app.t1', :'t1', true);
SELECT set_config('app.t2', :'t2', true);
SELECT set_config('app.operator', :'operator', true);
SELECT set_config('app.reason', :'reason', true);

-- -----------------------------------------------------------------------------
-- ① 前置断言：待删的必须**同时**满足全部"纯测试数据"条件
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  n int;
  bad int;
  total_historical int;
  candidates int;
BEGIN
  -- 恰好 2 张
  SELECT count(*) INTO n FROM service_tickets WHERE ticket_no IN (current_setting('app.t1'), current_setting('app.t2'));
  IF n <> 2 THEN
    RAISE EXCEPTION '待处置工单数不是 2（实得 %）—— 工单号可能已变，中止', n;
  END IF;

  -- 全部是"验收转单"留下的：客户名是合成、内容以 [历史转入] 开头、source=staff
  SELECT count(*) INTO bad FROM service_tickets
   WHERE ticket_no IN (current_setting('app.t1'), current_setting('app.t2'))
     AND NOT (
       customer_name LIKE '合成%'
       AND content LIKE '[历史转入]%'
       AND source = 'staff'
       AND status = 'NEW'
     );
  IF bad > 0 THEN
    RAISE EXCEPTION '有 % 张不满足"纯合成验收数据"的特征（客户名/内容/source/status）—— 中止', bad;
  END IF;

  -- 没有任何 Visit（有 Visit 就说明被人处理过，可能是证据）
  SELECT count(*) INTO bad FROM service_visits
   WHERE ticket_id IN (SELECT id FROM service_tickets WHERE ticket_no IN (current_setting('app.t1'), current_setting('app.t2')));
  IF bad > 0 THEN
    RAISE EXCEPTION '待处置工单挂着 % 条 Visit —— 可能是验收证据，中止', bad;
  END IF;

  -- 没有任何短信（**这一条同时回答了"会不会误发短信"**：产生它们的路径没走短信）
  SELECT count(*) INTO bad FROM sms_logs
   WHERE ticket_id IN (SELECT id FROM service_tickets WHERE ticket_no IN (current_setting('app.t1'), current_setting('app.t2')));
  IF bad > 0 THEN
    RAISE EXCEPTION '待处置工单已有 % 条短信记录 —— 中止（需要人工判断是否已触达）', bad;
  END IF;

  -- 没有任何历史转换记录（它们是"建单成功但转换记录没写成"留下的孤儿）
  SELECT count(*) INTO bad FROM historical_ticket_conversions
   WHERE ticket_id IN (SELECT id FROM service_tickets WHERE ticket_no IN (current_setting('app.t1'), current_setting('app.t2')));
  IF bad > 0 THEN
    RAISE EXCEPTION '待处置工单已被历史档案关联（% 条）—— 不能当孤儿处理，中止', bad;
  END IF;

  -- 🔴 关键的一条：库里**不允许**存在"第三个同类孤儿"。
  --    也就是说：所有以 [历史转入] 开头的工单，要么在这两个待删号里，
  --    要么**必须**有一条 historical_ticket_conversions 关联（说明它是正常转出来的）。
  SELECT count(*) INTO candidates FROM service_tickets WHERE content LIKE '[历史转入]%';
  SELECT count(*) INTO total_historical FROM service_tickets t
   WHERE t.content LIKE '[历史转入]%'
     AND t.ticket_no NOT IN (current_setting('app.t1'), current_setting('app.t2'))
     AND NOT EXISTS (SELECT 1 FROM historical_ticket_conversions c WHERE c.ticket_id = t.id);
  IF total_historical > 0 THEN
    RAISE EXCEPTION '库里还有 % 张"没有历史关联的转单工单"（不在待处置清单里）—— 影响面比已知的大，中止', total_historical;
  END IF;

  RAISE NOTICE '前置断言通过：以 [历史转入] 开头的工单共 % 张，其中待处置 2 张，其余均有历史关联', candidates;
END $$;

-- -----------------------------------------------------------------------------
-- ② 先留痕：把**前状态快照**写进审计（"不静默删除历史事实"）
-- -----------------------------------------------------------------------------
INSERT INTO service_settings (created_at, updated_at, key, value, value_type, description, updated_by)
VALUES (
  now(), now(),
  'test-artifacts.purge.audit',
  json_build_object(
    'reason', :'reason',
    'operator', :'operator',
    'purgedAt', now(),
    'tickets', (
      SELECT json_agg(json_build_object(
        'id', t.id,
        'ticketNo', t.ticket_no,
        'storeId', t.store_id,
        'source', t.source,
        'statusBefore', t.status,
        'customerName', t.customer_name,
        'content', t.content,
        'createdAt', t.created_at,
        'eventCount', (SELECT count(*) FROM ticket_events e WHERE e.ticket_id = t.id),
        'visitCount', (SELECT count(*) FROM service_visits v WHERE v.ticket_id = t.id),
        'smsCount', (SELECT count(*) FROM sms_logs s WHERE s.ticket_id = t.id),
        'conversionCount', (SELECT count(*) FROM historical_ticket_conversions c WHERE c.ticket_id = t.id)
      ) ORDER BY t.id)
      FROM service_tickets t WHERE t.ticket_no IN (:'t1', :'t2')
    ),
    'note', '由验收缺陷产生的孤儿工单，定向摘除；前状态已在此留存，不做业务状态流转（不伪装成客户取消）'
  )::text,
  'json',
  '测试事故工单的定向处置审计（P11-3 第 5 项 · 用户第二项）：事故原因 / 处理人 / 时间 / 前后状态',
  :'operator'
)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by;

-- -----------------------------------------------------------------------------
-- ③ 定向摘除（先子后父）
-- -----------------------------------------------------------------------------
-- ⚠️ 幂等记录：这些工单的建单**没有**走幂等键（当时那条路径还没接幂等），
--    所以这里按 resource_id 兜一遍 —— 万一有，也要一起摘掉，避免留下指向不存在的资源的记录。
DELETE FROM idempotency_records
 WHERE resource_type = 'serviceTicket'
   AND resource_id IN (SELECT id FROM service_tickets WHERE ticket_no IN (current_setting('app.t1'), current_setting('app.t2')));

DELETE FROM ticket_events
 WHERE ticket_id IN (SELECT id FROM service_tickets WHERE ticket_no IN (current_setting('app.t1'), current_setting('app.t2')));

DELETE FROM service_tickets WHERE ticket_no IN (current_setting('app.t1'), current_setting('app.t2'));

-- -----------------------------------------------------------------------------
-- ④ 后置断言：删对了、没删多
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  n int;
  leftover int;
BEGIN
  SELECT count(*) INTO n FROM service_tickets WHERE ticket_no IN (current_setting('app.t1'), current_setting('app.t2'));
  IF n <> 0 THEN
    RAISE EXCEPTION '后置校验失败：仍有 % 张待处置工单存在', n;
  END IF;

  -- 其余"转单工单"必须**全部**仍有历史关联（说明没误伤）
  SELECT count(*) INTO leftover FROM service_tickets t
   WHERE t.content LIKE '[历史转入]%'
     AND NOT EXISTS (SELECT 1 FROM historical_ticket_conversions c WHERE c.ticket_id = t.id);
  IF leftover > 0 THEN
    RAISE EXCEPTION '后置校验失败：出现 % 张无历史关联的转单工单（误伤？）', leftover;
  END IF;

  -- 事件表里不允许留下指向已删工单的孤儿
  SELECT count(*) INTO n FROM ticket_events e
   WHERE NOT EXISTS (SELECT 1 FROM service_tickets t WHERE t.id = e.ticket_id);
  -- ⚠️ 本库历史上可能有别的孤儿事件，所以这里只报 Notice，不作为中止条件；
  --    判据落在"本次删除的这两张"上（下面按 ticket_id 精确校验已在 ① 做过）。
  IF n > 0 THEN
    RAISE NOTICE '注意：库里另有 % 条指向不存在工单的事件（非本次操作产生）', n;
  END IF;
END $$;

COMMIT;
