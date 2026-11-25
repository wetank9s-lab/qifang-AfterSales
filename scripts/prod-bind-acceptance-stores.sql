-- 给两个验收账号补绑门店（幂等；只增不删，不动任何既有绑定）
\echo '=== 绑定前 ==='
SELECT u.id, u.email,
       (SELECT count(*) FROM "store_users" su WHERE su.user_id = u.id) AS bound
  FROM "users" u WHERE u.email LIKE 'r224acc.%' ORDER BY u.id;

INSERT INTO "store_users" (created_at, updated_at, user_id, store_id)
SELECT now(), now(), u.id, 1
  FROM "users" u
 WHERE u.email LIKE 'r224acc.%'
ON CONFLICT (user_id, store_id) DO NOTHING;

\echo '=== 绑定后 ==='
SELECT u.id, u.email,
       (SELECT string_agg(su.store_id::text, ',') FROM "store_users" su WHERE su.user_id = u.id) AS stores
  FROM "users" u WHERE u.email LIKE 'r224acc.%' ORDER BY u.id;

\echo '=== 断言：两个账号各绑 1 家店，且是门店 1 ==='
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM "users" u JOIN "store_users" su ON su.user_id = u.id
   WHERE u.email LIKE 'r224acc.%' AND su.store_id = 1;
  IF n <> 2 THEN RAISE EXCEPTION '绑定失败：应有 2 条，实际 %', n; END IF;
  RAISE NOTICE '绑定通过：2 个验收账号均已绑门店 1';
END $$;
