-- 同口径既有行指纹：两侧都"排除本迁移新增的节点"后计算
-- 排除规则（按语义，不按 id）：
--   desktopRoutes: title='上门服务档案' 的 flowPage 及其子 tabs
--   flowModels:     options.use='ServiceArchivesAdminModel'
--   rolesDesktopRoutes: 指向该页面的授权
WITH np AS (
  SELECT id FROM "desktopRoutes" WHERE type='flowPage' AND title='上门服务档案'
)
SELECT 'desktopRoutes' AS t, count(*) AS rows,
  md5(string_agg(id||'|'||COALESCE(title,'')||'|'||COALESCE(type,'')||'|'
      ||COALESCE("parentId"::text,'')||'|'||COALESCE("schemaUid",''), ',' ORDER BY id)) AS fp
FROM "desktopRoutes"
WHERE id NOT IN (SELECT id FROM np)
  AND id NOT IN (SELECT id FROM "desktopRoutes" WHERE "parentId" IN (SELECT id FROM np))
UNION ALL
SELECT 'flowModels', count(*),
  md5(string_agg(uid||'|'||COALESCE(name,'')||'|'||COALESCE(options->>'use',''), ',' ORDER BY uid))
FROM "flowModels"
WHERE COALESCE(options->>'use','') <> 'ServiceArchivesAdminModel'
UNION ALL
SELECT 'rolesDesktopRoutes', count(*),
  md5(string_agg("desktopRouteId"||'|'||"roleName", ',' ORDER BY "desktopRouteId","roleName"))
FROM "rolesDesktopRoutes"
WHERE "desktopRouteId" NOT IN (SELECT id FROM np);
