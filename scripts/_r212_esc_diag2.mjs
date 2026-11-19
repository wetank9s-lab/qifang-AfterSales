import fs from 'node:fs';
const s = fs.readFileSync('storage/plugins/@local/service-ticket/dist/client/index.js', 'utf8');
const BS = String.fromCharCode(92);

// esbuild 用小写 hex
function escLower(zh) {
  let out = '';
  for (const ch of zh) out += BS + 'u' + ch.codePointAt(0).toString(16).padStart(4, '0');
  return out;
}

function countKV(key, zh) {
  const needle = key + ': "' + escLower(zh) + '"';
  let i = -1, n = 0;
  while ((i = s.indexOf(needle, i + 1)) !== -1) n += 1;
  return n;
}
console.log('--- 键值对（小写 hex，直接 indexOf）---');
for (const [k, z] of [['label', '处理'], ['label', '跟进'], ['label', '审核'], ['label', '详情'], ['hint', '处理工单'], ['hint', '记录工单跟进情况'], ['hint', '审核师傅回执'], ['hint', '查看工单详情'], ['label', '处理工单'], ['label', '审核回执']]) {
  console.log(`${k}:"${z}"`.padEnd(30), countKV(k, z));
}

console.log('\n--- 菜单分组字符串（小写 hex）---');
for (const z of ['日常业务', '管理与设置', '派工记录', '工单事件时间线', '门店报修入口', '售后服务工作台', '总部售后工作台', '所有工单', '我的门店工单', '历史售后档案']) {
  const e = escLower(z);
  console.log(z.padEnd(8), 'esc=', s.split(e).length - 1);
}
