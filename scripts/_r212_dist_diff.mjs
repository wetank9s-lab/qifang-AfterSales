/**
 * _r212_dist_diff.mjs —— 判定两次构建的产物是否**功能等价**
 *
 * 为什么不能只比 SHA256：构建标记（`SVC_BUILD_STAMP`）会进 payload，
 * 每次构建哈希必然不同。真正要回答的是「除了时间戳，内容有没有变」。
 *
 * 判据：把产物里的 ISO 时间戳统一替换为 `<STAMP>` 后逐字节比较。
 * 同时报告原始 sha256，便于在部署记录里留痕。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const PAIRS = [
  ['server', 'storage/plugins/@local/service-ticket/dist/server/index.js', 'backups/r212-dist/server-index.js'],
  ['client', 'storage/plugins/@local/service-ticket/dist/client/index.js', 'backups/r212-dist/client-index.js'],
  ['client-v2', 'storage/plugins/@local/service-ticket/dist/client-v2/index.js', 'backups/r212-dist/client-v2-index.js'],
];

const STAMP = /(\d{4}-\d{2}-\d{2}T[\d:]+Z)/g;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const out = [];
for (const [name, nowPath, refPath] of PAIRS) {
  if (!fs.existsSync(nowPath) || !fs.existsSync(refPath)) {
    out.push({ name, verdict: 'MISSING', nowPath, refPath });
    continue;
  }
  const now = fs.readFileSync(nowPath);
  const ref = fs.readFileSync(refPath);
  const nowTxt = now.toString('utf8');
  const refTxt = ref.toString('utf8');
  const normNow = nowTxt.replace(STAMP, '<STAMP>');
  const normRef = refTxt.replace(STAMP, '<STAMP>');

  let firstDiff = -1;
  if (normNow !== normRef) {
    let i = 0;
    while (i < normNow.length && normNow[i] === normRef[i]) i += 1;
    firstDiff = i;
  }
  out.push({
    name,
    bytes: { now: now.length, ref: ref.length },
    sha256: { now: sha(now), ref: sha(ref) },
    stamps: {
      now: [...new Set(nowTxt.match(STAMP) || [])],
      ref: [...new Set(refTxt.match(STAMP) || [])],
    },
    identicalRaw: sha(now) === sha(ref),
    identicalIgnoringStamp: normNow === normRef,
    firstDiffAt: firstDiff,
    sample: firstDiff >= 0
      ? { now: normNow.slice(Math.max(0, firstDiff - 40), firstDiff + 80), ref: normRef.slice(Math.max(0, firstDiff - 40), firstDiff + 80) }
      : null,
  });
}

const bad = out.filter((o) => o.verdict === 'MISSING' || o.identicalIgnoringStamp === false);
console.log(JSON.stringify({ files: out, verdict: bad.length === 0 ? '✅ 除构建标记外功能等价' : '❌ 存在实质性差异' }, null, 2));
process.exit(bad.length === 0 ? 0 : 2);
