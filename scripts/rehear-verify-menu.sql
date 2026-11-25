-- 复现「门店销售看不到菜单」并验证修正效果
-- 判据：模拟 listAccessible 的树裁剪 —— 只保留"自身被授权"的节点，
--       且父节点不可达时子节点也不可见（NocoBase 的菜单树就是这个语义）。

\echo '=== A. 现状（迁移前）：store_sales 的授权明细 ==='
SELECT d.id, d.type, d.title, d."parentId"
  FROM "rolesDesktopRoutes" r JOIN "desktopRoutes" d ON d.id = r."desktopRouteId"
 WHERE r."roleName" = 'store_sales' ORDER BY d.id;

\echo '=== B. 现状：这个角色能看到「售后工单」分组吗（根可达性）==='
SELECT EXISTS (
  SELECT 1 FROM "rolesDesktopRoutes" r
   WHERE r."roleName"='store_sales'
     AND r."desktopRouteId" = (SELECT id FROM "desktopRoutes" WHERE type='group' AND title='售后工单')
) AS group_reachable;

\echo '=== C. 迁移后：store_sales 的授权数（分组+页面+Tab）==='
SELECT count(*) AS total_grants,
       count(*) FILTER (WHERE d.type='group')    AS group_grants,
       count(*) FILTER (WHERE d.type='flowPage') AS page_grants,
       count(*) FILTER (WHERE d.type='tabs')     AS tab_grants
  FROM "rolesDesktopRoutes" r JOIN "desktopRoutes" d ON d.id = r."desktopRouteId"
 WHERE r."roleName" = 'store_sales';

\echo '=== D. 迁移后：根可达性（必须为 t）==='
SELECT EXISTS (
  SELECT 1 FROM "rolesDesktopRoutes" r
   WHERE r."roleName"='store_sales'
     AND r."desktopRouteId" = (SELECT id FROM "desktopRoutes" WHERE type='group' AND title='售后工单')
) AS group_reachable;

\echo '=== E. 迁移后：store_sales 能看到的页面清单（模拟树裁剪）==='
WITH granted AS (
  SELECT r."desktopRouteId" AS id FROM "rolesDesktopRoutes" r WHERE r."roleName"='store_sales'
)
SELECT p.title AS visible_page
  FROM "desktopRoutes" p
 WHERE p.type = 'flowPage'
   AND p.id IN (SELECT id FROM granted)
   AND (p."parentId" IS NULL OR p."parentId" IN (SELECT id FROM granted))
 ORDER BY p.title;
