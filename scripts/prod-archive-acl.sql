\echo '=== A. actions 表结构 ==='
\d "dataSourcesRolesResourcesActions"

\echo '=== B. actions 总行数 / 指向档案的行数 ==='
SELECT count(*) AS total FROM "dataSourcesRolesResourcesActions";
SELECT count(*) AS archive_related
  FROM "dataSourcesRolesResourcesActions" a
  JOIN "dataSourcesRolesResources" r ON r.id = a."rolesResourceId"
 WHERE r.name LIKE '%rchive%';

\echo '=== C. 档案资源的具体动作（按 roleName+name 关联）==='
SELECT r."roleName", r.name AS res, a.name AS action
  FROM "dataSourcesRolesResources" r
  JOIN "dataSourcesRolesResourcesActions" a ON a."rolesResourceId" = r.id
 WHERE r.name LIKE '%rchive%'
 ORDER BY r.name, r."roleName", a.name;

\echo '=== D. 角色表实况 ==='
SELECT name, title, hidden FROM "roles"
 WHERE name IN ('root','admin','member','hq_admin','hq_after_sales',
                'store_after_sales','store_sales','store_manager','viewer')
 ORDER BY name;
