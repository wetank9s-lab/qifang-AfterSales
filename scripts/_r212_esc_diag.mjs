import fs from 'node:fs';
const s = fs.readFileSync('storage/plugins/@local/service-ticket/dist/client/index.js', 'utf8');

const BS = String.fromCharCode(92); // 反斜杠，避免源码里出现转义歧义
function escForm(zh) {
  let out = '';
  for (const ch of zh) out += BS + 'u' + ch.codePointAt(0).toString(16).padStart(4, '0');
  return out;
}

for (const zh of ['处理', '跟进', '审核', '详情', '日常业务', '管理与设置', '派工记录']) {
  const e = escForm(zh);
  console.log(
    zh.padEnd(6),
    'raw=' + String(s.split(zh).length - 1).padStart(3),
    'esc=' + String(s.split(e).length - 1).padStart(3),
    '| form=' + JSON.stringify(e),
  );
}

// label / hint 键值对：直接数 occurrences of `label: "` + esc
console.log('\n--- 键值对（直接 indexOf 累加，不走正则）---');
function countKV(key, zh) {
  const needle = key + ': "' + escForm(zh) + '"';
  let i = -1, n = 0;
  while ((i = s.indexOf(needle, i + 1)) !== -1) n += 1;
  return n;
}
for (const [k, z] of [['label', '处理'], ['label', '跟进'], ['label', '审核'], ['label', '详情'], ['hint', '处理工单'], ['hint', '审核师傅回执'], ['label', '处理工单'], ['label', '审核回执']]) {
  console.log(`${k}:"${z}"`.padEnd(28), countKV(k, z));
}
