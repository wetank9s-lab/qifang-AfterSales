import fs from 'node:fs';
const s = fs.readFileSync('storage/plugins/@local/service-ticket/dist/client/index.js', 'utf8');
const BS = String.fromCharCode(92);
const hexLower = (zh) => [...zh].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('');
const up = (h) => h.toUpperCase();

function probe(label, needle) {
  let i = -1, n = 0, first = -1;
  while ((i = s.indexOf(needle, i + 1)) !== -1) { n += 1; if (first < 0) first = i; }
  console.log(label.padEnd(34), 'n=' + String(n).padStart(3), 'first@' + first);
}

const cases = ['处理', '跟进', '审核', '详情', '处理工单', '审核师傅回执', '日常业务', '管理与设置', '派工记录', '门店报修入口'];
console.log('--- 大写 hex ---');
for (const z of cases) probe(z, BS + 'u' + up(hexLower(z)).match(/.{4}/g).join(BS + 'u'));
console.log('\n--- 小写 hex ---');
for (const z of cases) probe(z, BS + 'u' + hexLower(z).match(/.{4}/g).join(BS + 'u'));

// 单个汉字的两种形态，确认到底哪种被用
console.log('\n--- 单字 ---');
for (const z of ['处', '跟', '审', '详', '日', '管', '派', '门']) {
  const up1 = BS + 'u' + up(hexLower(z));
  const lo1 = BS + 'u' + hexLower(z);
  console.log(z, 'UP=' + String(s.split(up1).length - 1).padStart(3), 'LO=' + String(s.split(lo1).length - 1).padStart(3));
}
