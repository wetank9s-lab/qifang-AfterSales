import { execFileSync } from 'node:child_process';

function q(sql) {
  return execFileSync('docker', [
    'exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|',
  ], { input: sql, encoding: 'utf8', maxBuffer: 60 * 1024 * 1024 });
}

const USE = `COALESCE(fm.options->>'use', fm.options->'schema'->>'use')`;

console.log('=== 1) 两个页面根下 3 层内的模型 ===');
console.log(q(`
WITH roots AS (
  SELECT title, "schemaUid" AS uid, type FROM "desktopRoutes"
  WHERE title IN ('所有工单','我的门店工单') AND "schemaUid" IS NOT NULL
)
SELECT r.title || '  [' || r.type || ']  d' || t.depth || '  ' || ${USE}
FROM roots r
JOIN "flowModelTreePath" t ON t.ancestor = r.uid
JOIN "flowModels" fm ON fm.name = t.descendant
WHERE t.depth BETWEEN 0 AND 3 AND ${USE} IS NOT NULL
ORDER BY r.title, t.depth, ${USE};
`));

console.log('\n=== 2) 每个页面里 TicketPrimaryActionModel 的个数 ===');
console.log(q(`
WITH roots AS (
  SELECT title, "schemaUid" AS uid FROM "desktopRoutes"
  WHERE "schemaUid" IS NOT NULL AND title IN ('所有工单','我的门店工单')
)
SELECT r.title || ' -> ' || count(*)
FROM roots r
JOIN "flowModelTreePath" t ON t.ancestor = r.uid
JOIN "flowModels" fm ON fm.name = t.descendant
WHERE ${USE} = 'TicketPrimaryActionModel'
GROUP BY r.title;
`));

console.log('\n=== 3) 所有挂 TicketPrimaryActionModel 的父块（看它属于哪张表/哪个页） ===');
console.log(q(`
SELECT ${USE} AS "use", fm.name AS node_uid,
       (SELECT COALESCE(p.options->>'use', p.options->'schema'->>'use') FROM "flowModels" p
        WHERE p.name = (SELECT t2.ancestor FROM "flowModelTreePath" t2
                        WHERE t2.descendant = fm.name AND t2.depth = 1 LIMIT 1)) AS parent_use
FROM "flowModels" fm
WHERE ${USE} = 'TicketPrimaryActionModel'
LIMIT 30;
`));

console.log('\n=== 4) 两条「所有工单」路由的完整信息 ===');
console.log(q(`
SELECT id || ' | ' || title || ' | type=' || type || ' | schemaUid=' || COALESCE("schemaUid"::text,'-') ||
       ' | parentId=' || COALESCE("parentId"::text,'-') || ' | menuSchemaUid=' || COALESCE("menuSchemaUid"::text,'-')
FROM "desktopRoutes" WHERE title = '所有工单' ORDER BY type;
`));
