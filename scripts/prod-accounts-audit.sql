\echo '=== 门店售后账号（脱敏：邮箱显示前 3 字符 + 域名）==='
SELECT u.id,
       CASE WHEN u.email IS NULL OR u.email = '' THEN '(空)'
            ELSE left(u.email, 3) || '***@' || split_part(u.email, '@', 2) END AS email_masked,
       u.username,
       (SELECT count(*) FROM "store_users" su WHERE su.user_id = u.id) AS stores
  FROM "rolesUsers" r
  JOIN "users" u ON u.id = r."userId"
 WHERE r."roleName" = 'store_after_sales'
 ORDER BY u.id;

\echo '=== 多角色账号（同时持有两个及以上业务角色）==='
SELECT u.id,
       string_agg(r."roleName", ', ' ORDER BY r."roleName") AS roles
  FROM "rolesUsers" r
  JOIN "users" u ON u.id = r."userId"
 WHERE r."roleName" IN ('store_after_sales','store_sales','store_manager')
 GROUP BY u.id
HAVING count(*) > 1
 ORDER BY u.id;
