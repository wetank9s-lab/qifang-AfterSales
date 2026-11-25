\echo '=== 各门店档案数（确认「0」是真空数据还是被裁剪）==='
SELECT s.id AS store_id, s.code, s.name, count(a.id) AS archives
  FROM "stores" s
  LEFT JOIN "service_archives" a ON a.store_id = s.id
 GROUP BY s.id, s.code, s.name
 ORDER BY archives DESC, s.id;

\echo '=== 新建的两个验收账号 ==='
SELECT u.id, u.email, u.nickname,
       (SELECT string_agg(r."roleName", ',') FROM "rolesUsers" r WHERE r."userId" = u.id) AS roles,
       (SELECT count(*) FROM "store_users" su WHERE su.user_id = u.id) AS bound_stores
  FROM "users" u
 WHERE u.email LIKE 'r224acc.%'
 ORDER BY u.id;
