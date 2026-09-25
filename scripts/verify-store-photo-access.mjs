#!/usr/bin/env node
/**
 * verify-store-photo-access.mjs —— Phase 6 · P6-0 的门店审核读模型 / 私有照片访问**总门禁**
 * =============================================================================
 *
 * 覆盖 `docs/PHASE-6.md` §5 的**冻结验收矩阵**（不再扩）：
 *   四边界      B1 / B2 / B3 / B4 / B5
 *   反向与边界  N1 / R1 / R2 / S1 / O1
 *   人眼项      U1（脚本只做"可否渲染"的前置断言，人眼步骤在 §U1 输出清单里）
 *
 * -----------------------------------------------------------------------------
 * 为什么这些断言必须存在（而不是"看代码就知道对"）
 * -----------------------------------------------------------------------------
 * P6-0 的整个命题是"**门店能安全地看到自己该看的、看不到不该看的**"。
 * 这三件事各自都能"看起来对、实际错"：
 *   · 授权写错 → 门店看得到别家的照片（B3/B4 是唯一能咬住它的东西）；
 *   · 失败路径可区分 → `404 越权` 与 `404 不存在` 文案不同 ⇒ **存在性探测器**
 *     （B4 要求两者响应体**逐字节相同**）；
 *   · "不在白名单里"被误当成"不可读" → 实测证明这条**不成立**（见 N1）。
 *
 * ⚠️ N1 是本脚本抓到过的**真实缺陷**（2026-09-25）：
 *   此前的口径是"`serviceVisitPhotos` 不在 `NATIVE_READ_ALLOWLIST` ⇒ 不可读"。
 *   真机实测：门店角色 `GET /api/serviceVisitPhotos:list` → **200**，
 *   且整行下发 `storage_key` / `upload_ip_hash`。
 *   根因：NocoBase ACL 在"资源级没有条目"时**回退到角色 strategy**，
 *   而 `ACLAvailableStrategy.allow()` **完全忽略资源名**（只比 action 名）——
 *   于是 `{actions:['view','list','get']}` 等于"任何集合都可读"。
 *   修法：`middleware/store-scope.ts` 新增 `NATIVE_FORBIDDEN_RESOURCES` 整资源封禁
 *   （框架层、对所有角色生效、含 root），并在 `plugin.ts` 加启动断言。
 *
 * -----------------------------------------------------------------------------
 * 反向验证（`--reverse`，铁律 8："断言不会变红 = 没有断言"）
 * -----------------------------------------------------------------------------
 * 以**故意写错的期望**重放同一组事实，要求**每一条都必须变红**。
 * 例如 `reverse-B3` 断言"跨店读本店照片 = 200"——它必须失败，
 * 因为事实上是 404。若它**通过**了，说明 B3 根本没有区分力（比红更糟）。
 * 这把"这组断言会不会只是恒绿"从"希望"变成"可执行的事实"。
 *
 * -----------------------------------------------------------------------------
 * 前置 / 副作用 / 退出码
 * -----------------------------------------------------------------------------
 *   · 需要 `.env` 的 `UAT_STORE_A_PASSWORD` / `UAT_STORE_B_PASSWORD` / `UAT_HQ_PASSWORD`
 *     （先跑 `node scripts/uat-accounts.mjs --create`）
 *   · **自建自删**两套夹具（都走真实接口，不直接写库造数据）：
 *       夹具 A：S01 工单 → 受理 → 派工 → 师傅传图 → 提交
 *                ⇒ Ticket=WAIT_STORE_CONFIRM，Visit=SUBMITTED（审核对象）
 *       夹具 B：S01 工单 → 受理 → 派工 → 师傅传图 → **改派**
 *                ⇒ Visit#1=SUPERSEDED（历史 Visit，仍有照片）
 *     跑完在 `finally` 里按**自己的 ticket id 精确删除**（含私盘文件、附件行）。
 *     绝不使用 `WHERE ticket_no LIKE ...` 这类范围条件（走查基线 4 张单不能碰）。
 *   · 证据落 `.tmp-verify/store-photo-access-<run_id>.json`（**带 run_id**：
 *     本机 Bash 工具有"同一条命令跑两遍"的历史问题，固定文件名会让第二遍覆盖第一遍）。
 *   · 退出码：0 全绿 / 1 真红灯 / 2 环境未就绪
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  BASE_URL,
  ROOT,
  EnvNotReady,
  assert,
  createScratchTicket,
  acceptAndDispatch,
  cleanupTicket,
  ensureFixtureJpeg,
  envValue,
  http,
  localDateOnly,
  makeChecker,
  photoRows,
  psqlScalar,
  runMain,
  signIn,
  smsSwitch,
  svcPost,
  tokenFromOutbox,
  twoSessions,
  technicianSubmit,
  technicianUpload,
  visitSnapshots,
  errorCodeOf,
  errorMessageOf,
} from './technician-harness.mjs';

const argv = process.argv.slice(2);
const REVERSE = argv.includes('--reverse');
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto
  .randomBytes(3)
  .toString('hex')}`;

const { checkAsync, summary, state } = makeChecker({
  heading: 'P6-0 门店审核读模型 / 照片访问',
});

// ---------------------------------------------------------------------------
// 本地工具
// ---------------------------------------------------------------------------
const STORE_B_EMAIL = 'uat.store.b@svc.local';

/** 只取状态 + 头 + 原始字节：**不能**复用 harness 的 `http()` 读图片 */
async function fetchRaw(url, token) {
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    disposition: res.headers.get('content-disposition') ?? '',
    cacheControl: res.headers.get('cache-control') ?? '',
    nosniff: res.headers.get('x-content-type-options') ?? '',
    bytes: buf,
    text: buf.toString('utf8'),
  };
}

/** 取 I11 读模型（JSON） */
async function fetchVisitDetail(visitId, token) {
  return http(`${BASE_URL}/api/svc/visits/${visitId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

/** 取 I14 照片（二进制） */
async function fetchPhoto(photoId, token) {
  return fetchRaw(`${BASE_URL}/api/svc/photos/${photoId}`, token);
}

const PHOTO_FORBIDDEN_KEYS = ['storage_key', 'upload_ip_hash', 'file_id', 'access_token_hash'];
const VISIT_DETAIL_ALLOWED = new Set([
  'id',
  'visit_no',
  'visit_status',
  'store_confirm_status',
  'service_result',
  'service_note',
  'is_charged',
  'reported_charge_amount',
  'submitted_at',
  'technician_name',
  'service_mode',
  'provider_name',
  'expected_visit_at',
  'assigned_at',
]);
const PHOTO_ALLOWED = new Set([
  'id',
  'photo_type',
  'mime',
  'size',
  'width',
  'height',
  'sort_order',
  'uploaded_at',
]);

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
/** 把一张真实 JPEG 经师傅 Token 传到该 Visit */
async function uploadPhotos(token, count) {
  const jpeg = ensureFixtureJpeg();
  for (let i = 0; i < count; i += 1) {
    const up = await technicianUpload(token, jpeg, { filename: `p6-${i}.jpg`, photoType: 'onsite' });
    assert(
      up.status === 200 || up.status === 201,
      `第 ${i + 1} 张照片上传失败 HTTP ${up.status} ${errorMessageOf(up)}`,
    );
  }
}

/** 夹具 A：造一条"待门店确认 + 已提交 + 有照片"的审核对象 */
async function buildReviewFixture(storeToken, hqToken) {
  const { ticketId, ticketNo } = await createScratchTicket({
    tag: 'P6-0',
    content: '门店审核读模型验收',
  });
  await acceptAndDispatch(ticketId, storeToken);

  // ⚠️ `tokenFromOutbox` 返回 `{ token, seq, matches }`（**不是**裸字符串）——
  //    直接当 token 用，URL 会变成 `.../visits/[object Object]/files` → 404。
  const { token } = await tokenFromOutbox({ sessionToken: hqToken, ticketNo });
  if (!token) throw new EnvNotReady(`工单 ${ticketNo} 取不到师傅 Token（发件箱里没有匹配项）`);

  await uploadPhotos(token, 2);

  const submit = await technicianSubmit(token, {
    service_result: 'resolved',
    service_note: 'P6-0 验收：已更换主板并测试通过（脚本自建，跑完自删）',
    is_charged: true,
    reported_charge_amount: 268.0,
  });
  assert(
    submit.status === 200,
    `师傅提交失败 HTTP ${submit.status} ${errorMessageOf(submit)}`,
  );

  const [visitId, status] = String(
    psqlScalar(
      `SELECT id || '|' || visit_status FROM service_visits WHERE ticket_id = ${ticketId} ORDER BY visit_no DESC LIMIT 1`,
    ),
  ).split('|');
  assert(String(status) === 'SUBMITTED', `夹具 A 的 Visit 状态应为 SUBMITTED，实际 ${status}`);

  const photos = photoRows(ticketId);
  assert(photos.length === 2, `夹具 A 应有 2 张照片，实际 ${photos.length}`);
  return { ticketId, ticketNo, visitId: Number(visitId), photos, storeToken };
}

/** 夹具 B：造一条"仍是本店工单、但当前 Visit 已被改派作废"的历史 Visit（含照片） */
async function buildHistoricalFixture(storeToken, hqToken) {
  const { ticketId, ticketNo } = await createScratchTicket({
    tag: 'P6-0-HIST',
    content: '历史 Visit 照片可读性验收',
  });
  await acceptAndDispatch(ticketId, storeToken);

  const { token: token1 } = await tokenFromOutbox({ sessionToken: hqToken, ticketNo });
  if (!token1) throw new EnvNotReady(`工单 ${ticketNo} 取不到师傅 Token`);
  await uploadPhotos(token1, 1);

  const historicalVisitId = Number(
    psqlScalar(
      `SELECT id FROM service_visits WHERE ticket_id = ${ticketId} ORDER BY visit_no DESC LIMIT 1`,
    ),
  );

  // 改派：Visit#1 → SUPERSEDED，新建 Visit#2。改派必须带 reason。
  const re = await svcPost(
    'reassign',
    ticketId,
    storeToken,
    {
      technician_name: '李师傅（改派后）',
      technician_mobile: '13900020002',
      expected_visit_at: localDateOnly(2),
      service_mode: 'manufacturer',
      provider_name: 'P6-0验收厂家',
      reason: 'P6-0 验收：需要历史 Visit 夹具',
    },
    crypto.randomUUID(),
  );
  assert(re.status === 200, `改派失败 HTTP ${re.status} ${errorMessageOf(re)}`);

  const after = visitSnapshots(ticketId);
  const sup = String(after[0] ?? '');
  assert(
    sup.includes('SUPERSEDED'),
    `改派后 Visit#1 应为 SUPERSEDED，实际快照：${after.join(' || ')}`,
  );

  const photos = photoRows(ticketId).filter((r) => Number(r[1]) === historicalVisitId);
  assert(photos.length === 1, `历史 Visit 应有 1 张照片，实际 ${photos.length}`);
  return { ticketId, ticketNo, historicalVisitId, photos, storeToken };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const storeBPassword = envValue('UAT_STORE_B_PASSWORD');
  if (!storeBPassword) {
    throw new EnvNotReady('.env 缺 UAT_STORE_B_PASSWORD —— 先跑 node scripts/uat-accounts.mjs --create');
  }

  const health = await http(`${BASE_URL}/api/svc/health`);
  if (health.status !== 200) {
    throw new EnvNotReady(`应用未就绪（/api/svc/health → ${health.status}）`);
  }

  const { store, hq } = await twoSessions();
  const storeB = await signIn(STORE_B_EMAIL, storeBPassword);
  if (!storeB) throw new EnvNotReady(`跨店账号 ${STORE_B_EMAIL} 登录失败`);

  const fixtures = [];
  let fixtureA;
  let fixtureB;
  /**
   * 取师傅 Token 的**唯一**可行路径是 mock 短信发件箱，而本机 `sms.enabled=false`
   * ⇒ 派工短信 `send_status=rejected`、发件箱为空 ⇒ 拿不到 Token。
   * 因此临时打开开关，跑完**无条件恢复原值**（见 harness 的 smsSwitch 注释：
   * 必须等 11 秒过掉 ConfigService 的 10s 缓存 TTL，否则读到上一个值）。
   */
  const sms = smsSwitch();
  try {
    if (sms.original !== 'true') {
      console.log(`\n【短信开关】临时开启 sms.enabled（原值 "${sms.original}"），跑完恢复 …`);
      await sms.enable();
    }

    console.log('\n【夹具】自建两条一次性工单（走真实接口；跑完按 ticket id 精确删除）');
    fixtureA = await buildReviewFixture(store, hq);
    fixtures.push(fixtureA.ticketId);
    console.log(
      `  · 夹具 A：ticket=${fixtureA.ticketNo}(#${fixtureA.ticketId}) visit=#${fixtureA.visitId}` +
        ` 照片=[${fixtureA.photos.map((r) => r[0]).join(', ')}]`,
    );
    fixtureB = await buildHistoricalFixture(store, hq);
    fixtures.push(fixtureB.ticketId);
    console.log(
      `  · 夹具 B：ticket=${fixtureB.ticketNo}(#${fixtureB.ticketId}) 历史 visit=#${fixtureB.historicalVisitId}` +
        ` 照片=[${fixtureB.photos.map((r) => r[0]).join(', ')}]`,
    );

    const photoA = Number(fixtureA.photos[0][0]);
    const photoA2 = Number(fixtureA.photos[1][0]);
    const histPhoto = Number(fixtureB.photos[0][0]);

    /** 保证"不存在"的 photoId：取当前最大 id 再往后跳，并复核库里确实没有 */
    const maxId = Number(psqlScalar('SELECT COALESCE(MAX(id), 0) FROM service_visit_photos')) || 0;
    const ghostPhoto = maxId + 5000;
    assert(
      Number(psqlScalar(`SELECT COUNT(*) FROM service_visit_photos WHERE id = ${ghostPhoto}`)) === 0,
      `用于 B4 的"不存在 photoId"(${ghostPhoto}) 竟然存在，夹具前提被破坏`,
    );

    // =====================================================================
    if (!REVERSE) {
      console.log('\n【I11】门店回执读模型（GET /api/svc/visits/:id）');
      await checkAsync('I11-a 本店授权用户读本店 Visit → 200 + visit/photos', async () => {
        const r = await fetchVisitDetail(fixtureA.visitId, store);
        assert(r.status === 200, `HTTP ${r.status} ${errorMessageOf(r)}`);
        const d = r.json?.data;
        assert(d && d.visit && Array.isArray(d.photos), `响应缺少 visit/photos：${r.body.slice(0, 200)}`);
        assert(
          d.visit.visit_status === 'SUBMITTED',
          `审核对象状态应为 SUBMITTED，实际 ${d.visit.visit_status}`,
        );
        assert(d.photos.length === 2, `应回 2 张照片元数据，实际 ${d.photos.length}`);
        return `visit#${d.visit.id} · photos=${d.photos.length}`;
      });

      await checkAsync('I11-b 读模型字段是白名单（逐字段列举，无越界列）', async () => {
        const r = await fetchVisitDetail(fixtureA.visitId, store);
        const d = r.json?.data ?? {};
        const visitKeys = Object.keys(d.visit ?? {});
        const extra = visitKeys.filter((k) => !VISIT_DETAIL_ALLOWED.has(k));
        assert(extra.length === 0, `visit 出现白名单外的列：${extra.join(', ')}`);
        for (const p of d.photos ?? []) {
          const pExtra = Object.keys(p).filter((k) => !PHOTO_ALLOWED.has(k));
          assert(pExtra.length === 0, `photos[] 出现白名单外的列：${pExtra.join(', ')}`);
        }
        return `${visitKeys.length} 列全部在白名单内`;
      });

      await checkAsync('I11-c 跨店用户读本店 Visit → 404（不可区分于不存在）', async () => {
        const cross = await fetchVisitDetail(fixtureA.visitId, storeB);
        const ghost = await fetchVisitDetail(maxId + 5000, storeB);
        assert(cross.status === 404, `跨店应 404，实际 ${cross.status}`);
        assert(ghost.status === 404, `读不存在的 Visit 应 404，实际 ${ghost.status}`);
        assert(
          cross.body === ghost.body,
          `跨店与不存在必须**逐字节相同**：\n  跨店=${cross.body}\n  不存在=${ghost.body}`,
        );
        return '跨店 404 与不存在 404 响应体一致';
      });

      await checkAsync('I11-d 匿名读 Visit → 401', async () => {
        const r = await fetchVisitDetail(fixtureA.visitId, null);
        assert(r.status === 401, `匿名应 401，实际 ${r.status}`);
        return '401';
      });

      console.log('\n【B】四边界（私有照片受控读取）');
      await checkAsync('B1 本店授权用户读本店照片 → 200 image/*', async () => {
        const r = await fetchPhoto(photoA, store);
        assert(r.status === 200, `HTTP ${r.status}（期望 200）`);
        assert(
          r.contentType.startsWith('image/'),
          `Content-Type 应为 image/*，实际 ${r.contentType}`,
        );
        assert(r.bytes.length > 1000, `响应体过小（${r.bytes.length} 字节），疑似不是真图片`);
        assert(
          r.bytes[0] === 0xff && r.bytes[1] === 0xd8,
          '响应体不是 JPEG（magic bytes 不符）',
        );
        return `photo#${photoA} · ${r.contentType} · ${r.bytes.length}B`;
      });

      await checkAsync('B1b 响应头为私有内容口径（nosniff / no-store / inline）', async () => {
        const r = await fetchPhoto(photoA, store);
        // ⚠️ **按集合比较，不按字符串全等**（与 verify-technician-upload 的 B6 同一理由）：
        //    同一个响应头由两层各写一次 —— 应用层（`visit-review.ts` 的 photo handler，
        //    刻意不依赖反代存在）与 nginx（`service.conf` 的全局 `add_header ... always`）。
        //    nginx 的 add_header 是**追加**语义，于是线上看到的是 "nosniff, nosniff"。
        //    两者语义完全一样（去重后都是 {nosniff}）；写成字符串全等会把这个
        //    **正确**实现判红，属于"会误报的检查"。
        const nosniff = String(r.nosniff)
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        assert(
          nosniff.includes('nosniff'),
          `X-Content-Type-Options 必须含 nosniff（实际 ${JSON.stringify(r.nosniff)}）`,
        );
        assert(
          new Set(nosniff).size === 1,
          `X-Content-Type-Options 混入了别的指令：${JSON.stringify(r.nosniff)}`,
        );
        assert(
          r.cacheControl.includes('no-store'),
          `Cache-Control 应含 no-store，实际 ${r.cacheControl}`,
        );
        assert(
          r.disposition.toLowerCase().startsWith('inline'),
          `Content-Disposition 应为 inline，实际 ${r.disposition}`,
        );
        return `${r.nosniff} · ${r.cacheControl} · ${r.disposition}`;
      });

      await checkAsync('B2 HQ 授权用户读照片 → 200', async () => {
        const r = await fetchPhoto(photoA, hq);
        assert(r.status === 200, `HTTP ${r.status}（期望 200）`);
        assert(r.contentType.startsWith('image/'), `Content-Type 应为 image/*，实际 ${r.contentType}`);
        return `HQ → 200 ${r.contentType}`;
      });

      await checkAsync('B2b 本店用户读**第二张**照片也 200（不是只放了第一张）', async () => {
        const r = await fetchPhoto(photoA2, store);
        assert(r.status === 200, `HTTP ${r.status}（期望 200）`);
        return `photo#${photoA2} → 200`;
      });

      let crossBody = '';
      await checkAsync('B3 跨店用户读**已知合法** photoId → 404', async () => {
        const r = await fetchPhoto(photoA, storeB);
        crossBody = r.text;
        assert(r.status === 404, `跨店应 404，实际 ${r.status}（${r.text.slice(0, 120)}）`);
        return `404 · ${r.text.slice(0, 60)}`;
      });

      await checkAsync('B4 跨店读**不存在** photoId → 与 B3 逐字节相同（防存在性泄露）', async () => {
        const ghost = await fetchPhoto(ghostPhoto, storeB);
        assert(ghost.status === 404, `应 404，实际 ${ghost.status}`);
        assert(
          crossBody !== '' && ghost.text === crossBody,
          `两者响应体必须逐字节相同：\n  已知合法=${crossBody}\n  不存在  =${ghost.text}`,
        );
        return '同状态码 + 同响应体';
      });

      await checkAsync('B4b 畸形 photoId 与不存在/越权**不可区分**（同一出口）', async () => {
        const bad = await http(`${BASE_URL}/api/svc:photo?filterByTk=abc`, {
          headers: { Authorization: `Bearer ${storeB}` },
        });
        assert(bad.status === 404, `应 404，实际 ${bad.status}`);
        assert(
          bad.body === crossBody,
          `畸形 id 必须与越权/不存在同形：\n  越权=${crossBody}\n  畸形=${bad.body}`,
        );
        return '404 同形';
      });

      await checkAsync('B5 匿名读照片 → 401（两条路径都要）', async () => {
        const a = await fetchPhoto(photoA, null);
        const b = await http(`${BASE_URL}/api/svc:photo?filterByTk=${photoA}`);
        assert(a.status === 401, `对外路径匿名应 401，实际 ${a.status}`);
        assert(b.status === 401, `原生形态匿名应 401，实际 ${b.status}`);
        assert(errorCodeOf(b) === 'EMPTY_TOKEN', `错误码应为 EMPTY_TOKEN，实际 ${errorCodeOf(b)}`);
        return '401 EMPTY_TOKEN ×2';
      });

      console.log('\n【N】原生 collection API 必须不可读（N1）');
      for (const [label, action] of [
        ['list', 'list'],
        ['get', 'get'],
      ]) {
        await checkAsync(`N1 业务角色 GET /api/serviceVisitPhotos:${label} → 不可读`, async () => {
          const r = await http(
            `${BASE_URL}/api/serviceVisitPhotos:${action}?pageSize=1&filterByTk=${photoA}`,
            { headers: { Authorization: `Bearer ${store}` } },
          );
          assert(
            r.status === 403 || r.status === 404,
            `业务角色必须读不到原生照片表，实际 HTTP ${r.status}：${r.body.slice(0, 160)}`,
          );
          assert(
            !r.body.includes('storage_key'),
            '响应体出现了 storage_key —— 这正是 N1 要拦的泄漏',
          );
          return `${r.status} ${errorCodeOf(r) ?? ''}`;
        });
      }

      await checkAsync('N1-HQ HQ 角色同样不可读（整资源封禁，含总部）', async () => {
        const r = await http(`${BASE_URL}/api/serviceVisitPhotos:list?pageSize=1`, {
          headers: { Authorization: `Bearer ${hq}` },
        });
        assert(r.status === 403 || r.status === 404, `HQ 也应读不到，实际 ${r.status}`);
        return `${r.status}`;
      });

      await checkAsync('N1-回归 受管资源仍可读（封禁没有误伤）', async () => {
        const r = await http(`${BASE_URL}/api/serviceTickets:list?pageSize=1`, {
          headers: { Authorization: `Bearer ${store}` },
        });
        assert(r.status === 200, `serviceTickets:list 应仍可读，实际 ${r.status}`);
        return 'serviceTickets:list → 200';
      });

      console.log('\n【R】反向与边界');
      await checkAsync('R1 畸形 / 伪造 photoId → 安全失败（404/400，**不得 500**）', async () => {
        const cases = [
          ['非数字', 'abc'],
          ['注入', "1' OR 1=1"],
          ['负数', '-5'],
          ['零', '0'],
          ['超长', '99999999999999999999'],
          ['小数点', '1.5'],
        ];
        const seen = [];
        for (const [name, raw] of cases) {
          const r = await http(
            `${BASE_URL}/api/svc:photo?filterByTk=${encodeURIComponent(raw)}`,
            { headers: { Authorization: `Bearer ${storeB}` } },
          );
          assert(r.status !== 500, `「${name}」不得 500，实际 ${r.status}`);
          assert(
            r.status === 404 || r.status === 400,
            `「${name}」应 404/400，实际 ${r.status}`,
          );
          seen.push(`${name}:${r.status}`);
        }
        return seen.join(' ');
      });

      await checkAsync('R2 成功响应 / 读模型**不泄露**存储实现字段', async () => {
        const detail = await fetchVisitDetail(fixtureA.visitId, store);
        const photo = await fetchPhoto(photoA, store);
        const blobText = photo.text;
        const detailText = detail.body;
        for (const key of PHOTO_FORBIDDEN_KEYS) {
          assert(!detailText.includes(key), `I11 读模型泄露了 ${key}`);
          // 照片本身是二进制，理论上不该含 JSON 字段名；仍做一次文本层面检查
          assert(!blobText.includes(`"${key}"`), `照片响应出现字段名 ${key}`);
        }
        assert(
          !/\/app\/nocobase\/storage/.test(detailText),
          'I11 读模型泄露了容器内绝对路径',
        );
        assert(!/(^|[^a-z])visits\/\d{6}\//.test(detailText), 'I11 读模型泄露了 storage_key 形态的路径');
        return `${PHOTO_FORBIDDEN_KEYS.join('/')} 均未出现`;
      });

      console.log('\n【O】历史 Visit 与越店（O1）');
      await checkAsync('O1 本店用户读本店**历史 Visit**（SUPERSEDED）照片 → 200', async () => {
        const r = await fetchPhoto(histPhoto, store);
        assert(r.status === 200, `应 200，实际 ${r.status}（${r.text.slice(0, 120)}）`);
        return `历史 photo#${histPhoto} → 200`;
      });

      await checkAsync('O1b 历史 Visit 的**读模型**也 200（不只照片本体）', async () => {
        const r = await fetchVisitDetail(fixtureB.historicalVisitId, store);
        assert(r.status === 200, `应 200，实际 ${r.status}`);
        const st = r.json?.data?.visit?.visit_status;
        assert(st === 'SUPERSEDED', `历史 Visit 状态应为 SUPERSEDED，实际 ${st}`);
        return `读模型 200 · status=${st}`;
      });

      await checkAsync('O1c 但**跨店**读这条历史 Visit 照片仍 404（越店不因历史而放开）', async () => {
        const r = await fetchPhoto(histPhoto, storeB);
        assert(r.status === 404, `跨店应 404，实际 ${r.status}`);
        return '404';
      });

      console.log('\n【S】登录会话失效（S1）');
      await checkAsync('S1 会话失效后重新取图 → 401（blob 只是内存副本）', async () => {
        // 用**独立的一次性会话**，避免把上面各条断言用的会话登出
        const storePassword = envValue('UAT_STORE_A_PASSWORD');
        const temp = await signIn('uat.store.a@svc.local', storePassword);
        assert(temp, '临时会话登录失败');

        const before = await fetchPhoto(photoA, temp);
        assert(before.status === 200, `登出前应 200，实际 ${before.status}`);

        const out = await http(`${BASE_URL}/api/auth:signOut`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${temp}`, 'Content-Type': 'application/json' },
          body: '{}',
        });
        assert(out.status === 200, `signOut 失败 HTTP ${out.status}`);

        const after = await fetchPhoto(photoA, temp);
        assert(after.status === 401, `会话失效后重新取图应 401，实际 ${after.status}`);

        const afterDetail = await fetchVisitDetail(fixtureA.visitId, temp);
        assert(afterDetail.status === 401, `会话失效后读模型也应 401，实际 ${afterDetail.status}`);
        return '登出前 200 → 登出后 401（照片与读模型一致）';
      });

      console.log('\n【U】门店只读 UI 的可渲染性前置断言（U1，人眼步骤见清单）');
      await checkAsync('U1-a 读模型含 UI 需要的全部字段（缺一项 UI 就会显示空白）', async () => {
        const r = await fetchVisitDetail(fixtureA.visitId, store);
        const v = r.json?.data?.visit ?? {};
        const need = [
          'technician_name',
          'service_result',
          'service_note',
          'is_charged',
          'reported_charge_amount',
          'submitted_at',
          'visit_status',
          'store_confirm_status',
        ];
        const missing = need.filter((k) => !(k in v));
        assert(missing.length === 0, `读模型缺少 UI 必需字段：${missing.join(', ')}`);
        assert(v.service_note && String(v.service_note).length > 0, '处理说明为空');
        assert(v.is_charged === true, '夹具应含收费信息（is_charged=true）');
        return `${need.length} 项齐备`;
      });

      // ------------------------------------------------------------------
      // U1-b：回执区块**真的接在 H3 详情抽屉上**、且只在"待确认回执"时出现
      // ------------------------------------------------------------------
      // 为什么非要有这一条（而不是"U1-a 够了"）：
      //   U1-a 只证明"服务端给回的字段够 UI 用" —— 它**完全不证明 UI 渲染了它**。
      //   本项目吃过一次同型的亏（DEV-68）：`ActionModel` "已注册"被当成
      //   "动作已挂到页面"，结果页面上一个按钮都没有、而全部断言是绿的。
      //
      //   ⚠️ 阶段演进（2026-09-25 P6-2 落地）：P6-0 时期这条断言还额外卡"无任何
      //      写入口"（`<Form`/`onOk=`/`/confirm`/`/reject` 一律禁止），因为那时
      //      "确认/驳回"还没实现 —— 一旦出现就是 P6-0 越界成 P6-1/P6-2。
      //      **现在 P6-2 已正式落地**，确认/驳回两个写动作是**本阶段的本职交付**，
      //      再把它们当"越界痕迹"禁止就是错的。所以这条断言改盯一件**在 P6-2 之后
      //      依然成立、且更本质**的事：写入口**只能挂在"待确认回执"上**（区块本身
      //      仍由 `submittedVisitOf()` 门控，不是对所有状态/所有角色都渲染）。
      //   ⇒ "接了但没挂对地方"同样是"看代码就知道对"会漏掉的问题，必须盯住。
      await checkAsync('U1-b 回执区块内联进 H3 抽屉，且**只挂在待确认回执上**（源码口径）', async () => {
        const clientDir = path.join(ROOT, 'nocobase', 'plugins', 'service-ticket', 'src', 'client');
        const raw = (name) => fs.readFileSync(path.join(clientDir, name), 'utf8');
        // ⚠️ 先剥注释再扫关键字。否则"本文档注释里写的『不渲染任何 `<form>`』"
        //    会被当成真的渲染了表单 —— 这类**注释导致的假红**在本项目出现过，
        //    代价是让人开始不信任断言。只剥块注释与整行 `//` 注释（不剥行尾注释，
        //    避免把 `http://` 之类切坏）。
        const stripComments = (src) =>
          src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const drawer = stripComments(raw('ticket-drawer.tsx'));
        const review = stripComments(raw('ticket-store-review.tsx'));

        // ① 必须真的接在 H3 上（不是"引擎里注册了一个没人调用的类"）
        assert(drawer.includes("from './ticket-store-review'"), 'H3 抽屉没有 import 回执区块');
        assert(drawer.includes('<StoreReviewSection'), 'H3 抽屉没有渲染 StoreReviewSection');
        assert(drawer.includes('submittedVisitOf('), 'H3 抽屉没有按**状态**挑审核对象');

        // ② P6-2 之后盯"挂对地方"：区块（含确认/驳回写入口）仍只出现在
        //    `submittedVisit` 存在时 —— 抽屉里的渲染点必须包在
        //    `submittedVisit?.id != null` 条件内，不能落到所有状态都渲染的分支。
        assert(
          /submittedVisit\?\.id\s*!=\s*null[\s\S]{0,400}<StoreReviewSection/.test(drawer),
          '回执区块（含写入口）没有包在 submittedVisit 条件内，可能对非审核状态也渲染',
        );

        // ③ 照片必须走 blob 且成对释放（§4.3a）；否则 `<img>` 带不上登录态的老问题会复发
        for (const need of ["responseType: 'blob'", 'createObjectURL', 'revokeObjectURL']) {
          assert(review.includes(need), `回执区块缺少取图必需项：${need}`);
        }
        return 'H3 内联渲染 + 写入口只挂在待确认回执上 + blob 取图并释放';
      });
    }

    // =====================================================================
    // 反向验证：以**故意写错的期望**重放，每条都必须变红
    // =====================================================================
    if (REVERSE) {
      console.log('\n【反向验证】以下每条都**必须失败**；若某条通过，说明对应用断没有区分力');
      const redExpectations = [
        {
          name: 'R-B3 反向：断言"跨店用户能读到本店照片 200"',
          claim: 'B3 的 404 有区分力（不是恒绿）',
          fn: async () => {
            const r = await fetchPhoto(photoA, storeB);
            assert(r.status === 200, `反向期望(200)未成立：实际 ${r.status} —— 这正是 B3 的区分力`);
          },
        },
        {
          name: 'R-B4 反向：断言"越权 404 与不存在 404 的响应体**不同**"',
          claim: 'B4 的"逐字节相同"有区分力',
          fn: async () => {
            const cross = await fetchPhoto(photoA, storeB);
            const ghost = await fetchPhoto(ghostPhoto, storeB);
            assert(
              cross.text !== ghost.text,
              '反向期望(两者不同)未成立：实际两者相同 —— 这正是 B4 的区分力',
            );
          },
        },
        {
          name: 'R-R2 反向：断言"I11 读模型**包含** storage_key"',
          claim: 'R2 的"不得泄露"有区分力',
          fn: async () => {
            const r = await fetchVisitDetail(fixtureA.visitId, store);
            assert(
              r.body.includes('storage_key'),
              '反向期望(含 storage_key)未成立：实际不含 —— 这正是 R2 的区分力',
            );
          },
        },
        {
          name: 'R-N1 反向：断言"业务角色可读原生 serviceVisitPhotos:list（200）"',
          claim: 'N1 的封禁真的生效（不是"看起来封了"）',
          fn: async () => {
            const r = await http(`${BASE_URL}/api/serviceVisitPhotos:list?pageSize=1`, {
              headers: { Authorization: `Bearer ${store}` },
            });
            assert(
              r.status === 200,
              `反向期望(200)未成立：实际 ${r.status} —— 这正是 N1 的区分力（封禁生效）`,
            );
          },
        },
        {
          name: 'R-S1 反向：断言"会话失效后仍能取图 200"',
          claim: 'S1 的 401 有区分力',
          fn: async () => {
            const storePassword = envValue('UAT_STORE_A_PASSWORD');
            const temp = await signIn('uat.store.a@svc.local', storePassword);
            await http(`${BASE_URL}/api/auth:signOut`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${temp}`, 'Content-Type': 'application/json' },
              body: '{}',
            });
            const after = await fetchPhoto(photoA, temp);
            assert(
              after.status === 200,
              `反向期望(200)未成立：实际 ${after.status} —— 这正是 S1 的区分力`,
            );
          },
        },
        {
          name: 'R-R1 反向：断言"畸形 photoId 会 500"',
          claim: 'R1 的"不得 500"有区分力',
          fn: async () => {
            const r = await http(`${BASE_URL}/api/svc:photo?filterByTk=abc`, {
              headers: { Authorization: `Bearer ${storeB}` },
            });
            assert(r.status === 500, `反向期望(500)未成立：实际 ${r.status} —— 这正是 R1 的区分力`);
          },
        },
        {
          name: 'R-B5 反向：断言"匿名可读照片 200"',
          claim: 'B5 的 401 有区分力',
          fn: async () => {
            const r = await fetchPhoto(photoA, null);
            assert(r.status === 200, `反向期望(200)未成立：实际 ${r.status} —— 这正是 B5 的区分力`);
          },
        },
        {
          name: 'R-O1 反向：断言"跨店能读历史 Visit 照片 200"',
          claim: 'O1c 的 404 有区分力',
          fn: async () => {
            const r = await fetchPhoto(histPhoto, storeB);
            assert(r.status === 200, `反向期望(200)未成立：实际 ${r.status} —— 这正是 O1c 的区分力`);
          },
        },
        {
          name: 'R-U1b 反向：断言"回执区块**没有**包在 submittedVisit 条件内"（即所有状态都渲染）',
          claim: 'U1-b 的"写入口只挂在待确认回执上"有区分力（不是恒绿）',
          fn: async () => {
            // 与 U1-b 用**同一份源码、同一种剥注释方式**，只把期望反过来：
            // 这里**故意断言**"抽屉里渲染 StoreReviewSection 时**没有** submittedVisit 门控"。
            // 若本反向条目**通过**，说明源码里真的把回执区块渲染到了所有状态 ——
            // 那 U1-b 从今往后就不可能再变绿，两条一起把这件事钉死。
            const clientDir = path.join(
              ROOT,
              'nocobase',
              'plugins',
              'service-ticket',
              'src',
              'client',
            );
            const src = fs
              .readFileSync(path.join(clientDir, 'ticket-drawer.tsx'), 'utf8')
              .replace(/\/\*[\s\S]*?\*\//g, '')
              .replace(/^\s*\/\/.*$/gm, '');
            assert(
              /<StoreReviewSection/.test(src) &&
                !/submittedVisit\?\.id\s*!=\s*null[\s\S]{0,400}<StoreReviewSection/.test(src),
              '反向期望(回执区块无 submittedVisit 门控)未成立：实际有门控 —— 这正是 U1-b 的区分力',
            );
          },
        },
      ];

      for (const item of redExpectations) {
        await checkAsync(item.name, async () => {
          let wentRed = false;
          let detail = '';
          try {
            await item.fn();
          } catch (error) {
            wentRed = true;
            detail = error?.message ?? String(error);
          }
          assert(
            wentRed,
            `⚠️ 反向期望竟然**成立**了 —— 说明「${item.claim}」不成立（对应用断没有区分力）`,
          );
          return `已按预期变红（${item.claim}）`;
        });
      }
    }
  } finally {
    for (const id of fixtures) {
      try {
        const r = cleanupTicket(id);
        console.log(`  · 已清理 ticket #${id}（删文件 ${r.filesDeleted} / 附件 ${r.attachmentsDeleted}）`);
      } catch (error) {
        console.log(`  ⚠️ 清理 ticket #${id} 失败：${error?.message ?? String(error)}`);
      }
    }
    // 短信开关必须恢复到最后（清理过程本身不再依赖它）
    const restored = sms.restore();
    if (!restored.ok) console.log(`  ⚠️ sms.enabled 恢复失败：${restored.note}`);
  }

  summary();

  // 证据落盘（**带 run_id**：本机 Bash 工具有"同一条命令跑两遍"的历史问题）
  const evidenceDir = path.join(ROOT, '.tmp-verify');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidence = {
    run_id: RUN_ID,
    mode: REVERSE ? 'reverse' : 'normal',
    at: new Date().toISOString(),
    base_url: BASE_URL,
    passed: state.passed,
    failed: state.failures.length,
    failures: state.failures,
  };
  const evidencePath = path.join(evidenceDir, `store-photo-access-${RUN_ID}.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`  证据：${path.relative(ROOT, evidencePath)}`);
  console.log(`  共 ${state.passed} 通过 / ${state.failures.length} 失败\n`);

  if (state.failures.length > 0) process.exitCode = 1;
}

runMain({
  name: REVERSE
    ? 'verify-store-photo-access（反向验证：每条都必须变红）'
    : 'verify-store-photo-access（P6-0 验收矩阵）',
  main,
  // 夹具在 main 内部清理（要按 run 的 ticket id 精确删，见文件头）
  cleanup: () => {},
});

if (!REVERSE) {
  console.log('  U1（人眼）清单：门店账号登录后台 → 工单列表找到 WAIT_STORE_CONFIRM 的单 → 点行内「详情」→');
  console.log('     在抽屉里应看到「技师回执」区块：技师 / 服务结果 / 处理说明 / 是否收费 / 技师报费');
  console.log('     / 1–6 张照片（真图，不是空白或"照片读取失败"）/ 提交时间 / Visit 标识 / 「待门店确认」。');
  console.log('     ⚠️ 该区块**不应**出现任何"确认 / 驳回 / 金额输入"控件（那是 P6-1）。');
  console.log('     另见 preflight §3.7（机器点开「详情」并核对真实网络状态码）。');
  console.log('     ⚠️ 本阶段**没有**像 P5-1 那样的专用浏览器走查脚本 —— 机器侧已由');
  console.log('        `node scripts/uat-preflight.mjs` §3.7 第③层覆盖（真实点开 + 照片真的解码），');
  console.log('        人眼项只要求"看一眼真图"，故不另造脚本。');
  console.log('     人眼走查清单：docs/PHASE-6-P6-0-UAT-SHEET.md\n');
}
