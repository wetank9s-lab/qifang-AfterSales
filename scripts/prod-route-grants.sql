\echo '=== admin 与 store_sales 的路由授权数 ==='
SELECT r."roleName", count(*) AS routes
  FROM "rolesDesktopRoutes" r
 WHERE r."roleName" IN ('admin','root','member','store_sales','store_manager','store_after_sales')
 GROUP BY r."roleName" ORDER BY r."roleName";

\echo '=== store_sales 被授权的具体路由 ==='
SELECT d.id, d.type, d.title, d."parentId", d."hideInMenu", d.hidden
  FROM "rolesDesktopRoutes" r
  JOIN "desktopRoutes" d ON d.id = r."desktopRouteId"
 WHERE r."roleName" IN ('store_sales','store_manager')
 ORDER BY r."roleName", d."parentId" NULLS FIRST, d.id;

\echo '=== 分组节点本身的属性（store_sales 是否被授权这个 group）==='
SELECT d.id, d.type, d.title, d."hideInMenu", d.hidden,
       EXISTS (SELECT 1 FROM "rolesDesktopRoutes" r
                WHERE r."desktopRouteId" = d.id AND r."roleName" = 'store_sales') AS granted_to_sales
  FROM "desktopRoutes" d
 WHERE d.type = 'group';
