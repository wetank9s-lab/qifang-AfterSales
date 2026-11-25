-- 迁移结果取证：页面 / Tab / 区块 / 授权 / 父分组
\echo '=== 1. 页面节点 ==='
SELECT r.id, r.type, r.title, r."parentId", p.title AS parent_title, r."schemaUid", r.sort
  FROM "desktopRoutes" r
  LEFT JOIN "desktopRoutes" p ON p.id = r."parentId"
 WHERE r.title = '上门服务档案'
    OR r."parentId" IN (SELECT id FROM "desktopRoutes" WHERE title = '上门服务档案');

\echo '=== 2. 区块（name=uid，类名在 options.use）==='
SELECT fm.uid, fm.name, fm.options->>'use' AS use, fm.options->>'parentId' AS parent,
       fm.options#>>'{stepParams,__flowSurfaceMeta,declaredKey}' AS declared_key
  FROM "flowModels" fm
 WHERE fm.options->>'use' = 'ServiceArchivesAdminModel';

\echo '=== 3. 区块父节点是否等于 Tab 的 schemaUid（挂载关系）==='
SELECT (fm.options->>'parentId') = t."schemaUid" AS mounted_on_tab
  FROM "flowModels" fm, "desktopRoutes" t
 WHERE fm.options->>'use' = 'ServiceArchivesAdminModel'
   AND t.type = 'tabs'
   AND t."parentId" = (SELECT id FROM "desktopRoutes"
                        WHERE type='flowPage' AND title='上门服务档案');

\echo '=== 4. 角色授权 ==='
SELECT r."roleName", r."desktopRouteId", r."createdAt"
  FROM "rolesDesktopRoutes" r
 WHERE r."desktopRouteId" = (SELECT id FROM "desktopRoutes"
                              WHERE type='flowPage' AND title='上门服务档案')
 ORDER BY r."roleName";
