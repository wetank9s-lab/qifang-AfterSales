import fs from 'node:fs';
const s = fs.readFileSync('storage/plugins/@local/service-ticket/dist/client/index.js', 'utf8');

// 取 FOLLOW 附近，逐字节打印出反斜杠后的真实内容
const i = s.indexOf('PRIMARY_ACTION.FOLLOW');
const seg = s.slice(i, i + 200);
console.log('SEGMENT (raw chars):');
console.log(seg);
console.log('\nHEX of segment:');
console.log(Buffer.from(seg, 'utf8').toString('hex'));
