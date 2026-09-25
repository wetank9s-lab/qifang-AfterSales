/**
 * DEV-84 · 单张照片「方向归一化」端到端验片（走真实链路：nginx → 插件 → 私有存储）
 *
 * 用法：
 *   node scripts/verify-photo-orientation-e2e.mjs
 *   node scripts/verify-photo-orientation-e2e.mjs --photo D:/DCIM/IMG_1234.jpg
 *   node scripts/verify-photo-orientation-e2e.mjs --photo X.jpg --out Y.jpg --keep
 *
 * 它做的事（只有三步，判据交给 Python 侧用 Pillow 独立解码，不自己给自己判绿）：
 *   ① 造一张一次性工单 → 接单派工 → 从短信发件箱取师傅 Token；
 *   ② 把 --photo 指向的文件**原样**上传（multipart，真实 HTTP）；
 *   ③ 从**容器私有目录**把落盘字节取回来存成 --out。
 *
 * ⚠️ 本脚本**不判断**"方向对不对" —— 那是 Pillow 的事（见 .tmp-orient/check-phone-shot.py）。
 *    机器给自己判绿是本项目反复踩过的坑（DEV-67 / DEV-77），所以判据一律外置。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  ROOT,
  PRIVATE_DIR,
  acceptAndDispatch,
  assert,
  cleanupTicket,
  createScratchTicket,
  eq,
  errorMessageOf,
  inApp,
  psqlRows,
  smsSwitch,
  technicianUpload,
  tokenFromOutbox,
  twoSessions,
} from './technician-harness.mjs';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const SHOT_DIR = path.join(ROOT, '.tmp-orient', 'phone-shot');
const photoPath = argOf('photo', path.join(SHOT_DIR, 'phone-shot-as-phone-stores.jpg'));
const outPath = argOf('out', path.join(SHOT_DIR, 'stored-after-fix.jpg'));
const keep = argv.includes('--keep');

/** nginx 粗粒度限流（svc_upload 60r/m，IP 维度）会返回扁平信封的 429 —— 与应用级限流区分开 */
function isNginxThrottle(r) {
  return r.status === 429 && !Array.isArray(r.json?.errors);
}

async function main() {
  assert(fs.existsSync(photoPath), `找不到输入照片：${photoPath}`);
  const bytes = fs.readFileSync(photoPath);
  console.log(`输入照片：${photoPath}（${bytes.length} 字节）`);

  const sms = smsSwitch();
  const { store, hq } = await twoSessions();
  console.log(`  · 打开 ${'SMS_ENABLED'}（原值 ${sms.original}），等待 11s 让配置缓存过期…`);
  await sms.enable();

  const t = await createScratchTicket({ tag: 'DEV84-ORIENT', content: 'DEV-84 单张照片方向验片' });
  await acceptAndDispatch(t.ticketId, store);
  const { token } = await tokenFromOutbox({ sessionToken: hq, ticketNo: t.ticketNo });
  console.log(`  · 工单 ${t.ticketNo}（id=${t.ticketId}）`);

  let r;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    r = await technicianUpload(token, bytes, { filename: 'phone-shot.jpg', photoType: 'onsite' });
    if (!isNginxThrottle(r)) break;
    console.log(`  · nginx 限流（429），退避 ${attempt * 1.2}s 后重试…`);
    await new Promise((s) => setTimeout(s, 1200 * attempt));
  }
  eq(r.status, 201, `上传 HTTP（${errorMessageOf(r)}）`);

  const photo = r.json?.data?.photo;
  assert(photo, `响应缺 photo：${JSON.stringify(r.json).slice(0, 300)}`);
  console.log(`  · 响应当场回报：${photo.width}x${photo.height} · ${photo.mime} · ${photo.size} 字节`);

  // ⚠️ `service_visit_photos` 上**没有** meta 列（DEV-84 的 exif_orientation / rotated_from
  //    写在 attachments.meta 上）。列名必须对着真库写，不能凭"应该有个 meta"猜。
  const rows = psqlRows(
    `SELECT p.storage_key, p.mime, p.size, coalesce(p.width::text,'-'), coalesce(p.height::text,'-')` +
      ` FROM service_visit_photos p JOIN service_visits v ON v.id = p.visit_id` +
      ` WHERE v.ticket_id = ${t.ticketId} ORDER BY p.id DESC LIMIT 1`,
  );
  assert(rows.length === 1, `库里应有 1 条照片行，实际 ${rows.length}`);
  const [storageKey, mime, size, w, h] = rows[0];
  console.log(`  · 库内记录：${w}x${h} · ${mime} · ${size} 字节 · key=${storageKey}`);

  const metas = psqlRows(
    `SELECT coalesce(meta::text,'-') FROM attachments` +
      ` WHERE filename LIKE '%${storageKey.split('/').pop()}%' OR meta::text LIKE '%${storageKey}%'` +
      ` ORDER BY id DESC LIMIT 3`,
  );
  console.log(`  · attachments.meta（可追溯原朝向）：${metas.map((r) => r[0]).join(' ｜ ').slice(0, 300)}`);

  const out = inApp(`base64 -w0 ${PRIVATE_DIR}/${storageKey}`);
  assert(out.ok, `从容器私有目录取字节失败：${storageKey}`);
  const stored = Buffer.from(out.out.replace(/\s+/g, ''), 'base64');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, stored);
  console.log(`\n已取回落盘字节 → ${outPath}（${stored.length} 字节）`);
  console.log('（方向是否"正"由 Pillow 独立判定，不在本脚本里自证）');

  if (!keep) {
    cleanupTicket(t.ticketId);
    console.log(`  · 已清理工单 ${t.ticketNo}`);
  }
  const back = sms.restore();
  console.log(`  · 短信开关还原为 ${back}`);
}

main().catch((e) => {
  console.error(`\n❌ ${e?.message ?? e}`);
  process.exit(1);
});
