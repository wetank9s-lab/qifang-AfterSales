import { execFileSync } from 'node:child_process';
const USE = `COALESCE(fm.options->>'use', fm.options->'schema'->>'use')`;
function q(sql) {
  return execFileSync('docker', ['exec', '-i', 'svc-postgres', 'psql', '-U', 'svc_app', '-d', 'service_ticket',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|'], { input: sql, encoding: 'utf8', maxBuffer: 60 * 1024 * 1024 });
}

console.log('=== 6 个 TicketPrimaryActionModel 各自的祖先链（向上追到 RouteModel）===');
console.log(q(`
WITH targets AS (
  SELECT fm.name AS uid FROM "flowModels" fm WHERE ${USE} = 'TicketPrimaryActionModel'
)
SELECT tgt.uid || ' <= d' || t3.depth || ' ' ||
       COALESCE(anc.options->>'use', anc.options->'schema'->>'use') || ' <= ' || anc.name
FROM targets tgt
JOIN "flowModelTreePath" t3 ON t3.descendant = tgt.uid
JOIN "flowModels" anc ON anc.name = t3.ancestor
WHERE COALESCE(anc.options->>'use', anc.options->'schema'->>'use') IN ('RouteModel','RootPageModel','PageModel','TableBlockModel','BlockGridModel')
ORDER BY tgt.uid, t3.depth DESC;
`));

console.log('\n=== 反查：这 6 个 uid 对应哪个 desktopRoutes 标题 ===');
console.log(q(`
WITH targets AS (
  SELECT fm.name AS uid FROM "flowModels" fm WHERE ${USE} = 'TicketPrimaryActionModel'
)
SELECT DISTINCT dr.title || '  [' || dr.type || ']'
FROM targets tgt
JOIN "flowModelTreePath" t ON t.descendant = tgt.uid
JOIN "desktopRoutes" dr ON dr."schemaUid" = t.ancestor
ORDER BY 1;
`));

console.log('\n=== 全部含 PrimaryAction 的表格块，其所属路由标题 ===');
console.log(q(`
WITH tbl AS (
  SELECT fm.name AS uid FROM "flowModels" fm WHERE ${USE} = 'TableBlockModel'
)
SELECT dr.title || ' | ' || tbl.uid
FROM tbl
JOIN "flowModelTreePath" t ON t.descendant = tbl.uid
JOIN "desktopRoutes" dr ON dr."schemaUid" = t.ancestor
ORDER BY 1;
`));
