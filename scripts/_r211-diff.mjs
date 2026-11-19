// 比对本地 uiLayouts/布局模型与生产快照（prodcfg/flowModels.json）里 admin-layout-model 的结构差异
import fs from 'node:fs';
const base = JSON.parse(fs.readFileSync('storage/tmp/r211/prodcfg/flowModels.json','utf8'));
const rows = Array.isArray(base) ? base : (base.data||base.rows||[]);
const hit = rows.filter(r => /layout/i.test(r.uid||'') || /admin-layout/i.test(JSON.stringify(r.options||{}).slice(0,200)));
console.log('候选行:', hit.map(h=>h.uid));
for (const h of hit.slice(0,5)) console.log('---', h.uid, '---', JSON.stringify(h.options).slice(0,600));
