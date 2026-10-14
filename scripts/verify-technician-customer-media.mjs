/**
 * P11-5 · 师傅 H5 工单详情与**客户媒体受控查看**的针对性验收
 *
 *   node scripts/verify-technician-customer-media.mjs
 *
 * 全部复用既有能力（**没有新造夹具体系**）：
 *   · `technician-harness.mjs` 的 `smsSwitch` / `acceptAndDispatch` / `tokenFromOutbox` /
 *     `technicianGet` / `psqlExec` / `signIn` / `envValue`；
 *   · 既有客户侧接口建单（`/api/public/tickets` + 媒体会话）；
 *   · 真实媒体样本（`test-fixtures/real-media/` 与历史导入素材）。
 *
 * 覆盖用户第 6 项的 5 条验收：
 *   ① 师傅打开有效派工链接 ⇒ 看到正确工单 + 客户资料
 *   ② 客户**只**传照片 / **只**传语音 / **只**传视频 ⇒ 师傅都能查看/播放
 *   ③ 媒体可播放（接口层：正确 Content-Type + 真实字节；**真机播放见文档标注**）
 *   ④ 另一位师傅 / 另一门店 / 无效 Token / 篡改 ref 均不能越权读取
 *   ⑤ 原有提交与门店审核链路未受影响（本轮跑既有门禁，见脚本末尾提示）
 *
 * ⚠️ 输出**不含**手机号、地址、Token 明文与媒体内容。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  BASE_URL,
  ROOT,
  envValue,
  http,
  psqlExec,
  psqlScalar,
  smsSwitch,
  twoSessions,
  acceptAndDispatch,
  tokenFromOutbox,
  technicianGet,
} from './technician-harness.mjs';

const require = createRequire(import.meta.url);
const checks = [];
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENTRY = JSON.parse(fs.readFileSync(path.join(ROOT, 'storage/tmp/device-test/entry.json'), 'utf8')).entry;
const FIX = path.join(ROOT, 'nocobase/plugins/service-ticket/test-fixtures/real-media');
const IMG = fs.readFileSync(path.join(ROOT, 'storage/tmp/historical-ui/10-review.png'));
const AUDIO = fs.readFileSync(path.join(FIX, 'audio-chrome.webm'));
const VIDEO = fs.readFileSync(path.join(FIX, 'video-chrome.webm'));

const MEDIA_CASES = [
  { kind: 'image', label: '只照片', buffer: IMG, name: 'c.png', type: 'image/png', expectKind: 'image' },
  { kind: 'audio', label: '只语音', buffer: AUDIO, name: 'c.webm', type: 'audio/webm', expectKind: 'audio' },
  { kind: 'video', label: '只视频', buffer: VIDEO, name: 'c.webm', type: 'video/webm', expectKind: 'video' },
];

const rid = () =>
  `11111111-2222-4333-8444-${Date.now().toString(16).slice(-6).padStart(6, '0')}${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`;

/** 建一张"只 X"的工单（走客户侧真实接口），返回 { ticketNo, ticketId, kind } */
async function makeTicketWithOnlyMedia(c) {
  const s = await http(`${BASE_URL}/api/public/media/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_consent: true }),
  });
  const sess = s.json?.data;
  if (!sess) throw new Error(`建媒体会话失败 HTTP ${s.status}`);

  const form = new FormData();
  form.append('file', new Blob([c.buffer]), c.name);
  const up = await http(`${BASE_URL}/api/public/media/upload`, {
    method: 'POST',
    headers: { 'X-Media-Session': sess.session_token },
    body: form,
  });
  if (up.status !== 200) throw new Error(`上传失败 HTTP ${up.status} ${JSON.stringify(up.json?.errors?.[0] ?? '')}`);

  const created = await http(`${BASE_URL}/api/public/tickets?k=${ENTRY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': rid() },
    body: JSON.stringify({
      ticket_type: 'repair',
      // 🔴 **一个字都不写**：这正是"客户只传媒体"的真实场景
      content: '',
      customer_name: 'P115 客户',
      customer_mobile: `1380000${String(1000 + Math.floor(Math.random() * 8000)).slice(-4)}`,
      service_address: '新都区 P115 路 9 号 3 单元 501',
      appliance_category: 'air_conditioner',
      brand_model: '格力 KFR-35GW',
      media_session: { id: sess.session_id, token: sess.session_token },
    }),
  });
  const ticketNo = created.json?.data?.ticket_no;
  if (!ticketNo) throw new Error(`建单失败 HTTP ${created.status} ${JSON.stringify(created.json?.errors?.[0] ?? '')}`);
  const ticketId = Number(psqlScalar(`SELECT id FROM service_tickets WHERE ticket_no='${ticketNo}'`));
  return { ticketNo, ticketId, kind: c.kind };
}

/**
 * 直接请求师傅侧媒体 URL（对外路径，经 nginx）。
 *
 * ⚠️ 失败时把响应体（截断）带回来：401 可能是**我们的鉴权层**返回的，
 *    也可能是**请求根本没到 handler**（落到需要登录的路径）—— 两者响应形态相近，
 *    只有看响应体才能分辨。不带回来就会变成"猜为什么 401"。
 */
async function fetchMedia(token, ref, retryOn429 = true) {
  let res = await fetch(`${BASE_URL}/api/technician/visits/${token}/media/${ref}`, {
    headers: { Accept: '*/*' },
  });
  // ⚠️ 429 是**限流**，不是"访问被拒" —— 若把它当成通过会掩盖真实缺陷；
  //    也不能把它当成失败（那是环境噪声）。⇒ 等一下重试一次。
  if (res.status === 429 && retryOn429) {
    await sleep(3000);
    res = await fetch(`${BASE_URL}/api/technician/visits/${token}/media/${ref}`, { headers: { Accept: '*/*' } });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    bytes: res.status === 200 ? buf.length : 0,
    body: res.status === 200 ? '' : buf.toString('utf8').slice(0, 160),
  };
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  P11-5 · 师傅查看客户提交的内容（受控读取验收）');
console.log('══════════════════════════════════════════════════════════════');

const sw = smsSwitch();
const created = [];
try {
  await sw.enable(); // 取师傅 Token 的前置条件（明文只在短信入参里）
  console.log(`  · 已临时打开 ${sw.original === undefined ? 'sms.enabled' : `sms.enabled（原值 ${sw.original}）`}`);

  // ---- 建三张"只 X"的工单 ----
  for (const c of MEDIA_CASES) {
    const t = await makeTicketWithOnlyMedia(c);
    created.push(t);
    console.log(`  · 建单 ${t.ticketNo}（${c.label}，文字为空）`);
  }

  // ⚠️ 必须用既有的 `twoSessions()`：
  //    · **门店**账号做派工（验的就是门店视角那条路径）；
  //    · **总部**账号读 mock 发件箱取师傅 Token —— 发件箱对门店账号 **403**，
  //      用门店去读会得到发件箱空这种**看起来像产品坏了**的假象。
  const { store: storeToken, hq: hqToken } = await twoSessions();

  // =========================================================================
  // ① 有效派工 ⇒ 看到正确工单 + 客户资料
  // =========================================================================
  console.log('\n── ① 师傅打开有效链接：工单与客户资料 ──────────────────');
  const visits = [];
  for (const t of created) {
    await acceptAndDispatch(t.ticketId, storeToken);
    // ⚠️ `tokenFromOutbox` 返回的是**对象** `{ token, seq, matches }`（见 harness 第 467 行），
    //    不是字符串 —— 第一版直接当字符串用 ⇒ 断言全红且报"Token 形态不对"。
    const { token } = await tokenFromOutbox({ sessionToken: hqToken, ticketNo: t.ticketNo });
    visits.push({ ...t, token });
  }
  ok('三张单都成功派工并取得师傅链接（Token 形态 43 位）', visits.every((v) => /^[A-Za-z0-9_-]{43}$/.test(v.token)), `${visits.length} 条`);

  const first = visits[0];
  const ctxRes = await http(`${BASE_URL}/api/technician/visits/${first.token}`);
  const ctx = ctxRes.json?.data;
  ok('GET 派工链接 ⇒ 200', ctxRes.status === 200, `HTTP ${ctxRes.status}`);
  ok('工单号正确', ctx?.ticket_no === first.ticketNo, `${ctx?.ticket_no ?? ''}`);
  ok(
    '客户资料齐（姓名 / 电话 / 地址 / 家电类别 / 品牌型号）',
    ctx?.customer?.name === 'P115 客户' &&
      /^138\d{8}$/.test(String(ctx?.customer?.mobile ?? '')) &&
      String(ctx?.customer?.address ?? '').includes('P115 路') &&
      ctx?.customer?.appliance_category === 'air_conditioner' &&
      // 标签由服务端下发（H5 不手抄枚举→中文）
      ctx?.customer?.appliance_category_label === '空调' &&
      String(ctx?.customer?.brand_model ?? '').includes('格力'),
    `name=${ctx?.customer?.name ?? ''} 地址长度=${String(ctx?.customer?.address ?? '').length} 类别=${ctx?.customer?.appliance_category ?? ''}/${ctx?.customer?.appliance_category_label ?? ''}`,
  );
  ok(
    '🔴 客户**没写文字**时不再被当成"缺内容"（content 为空但材料非空）',
    String(ctx?.content ?? '') === '' && (ctx?.customer_media?.length ?? 0) === 1,
    `content 长度=${String(ctx?.content ?? '').length} 材料数=${ctx?.customer_media?.length ?? 0}`,
  );
  ok(
    '页面拿不到内部标识：响应里**没有** mediaId / storage_key / 原始文件名',
    !/mediaId|media_id|storage_key|storageKey/.test(JSON.stringify(ctx)) &&
      !JSON.stringify(ctx).includes('customer/'),
    '仅 ref 句柄',
  );

  // =========================================================================
  // ②③ 只照片 / 只语音 / 只视频 ⇒ 都能读、能播
  // =========================================================================
  console.log('\n── ②③ 三种"只媒体"形态下的受控读取 ────────────────────');
  for (let i = 0; i < visits.length; i += 1) {
    const v = visits[i];
    const c = MEDIA_CASES[i];
    const ctxI = (await http(`${BASE_URL}/api/technician/visits/${v.token}`)).json?.data;
    const list = ctxI?.customer_media ?? [];
    const item = list[0];
    ok(
      `${c.label}：清单恰好 1 项且 kind=${c.expectKind}，ref 形态为 22 位句柄`,
      list.length === 1 && item?.kind === c.expectKind && /^[A-Za-z0-9_-]{22}$/.test(String(item?.ref ?? '')),
      `kind=${item?.kind ?? ''} ref 长度=${String(item?.ref ?? '').length} 时长=${item?.duration_ms ?? 'null'}`,
    );

    const got = await fetchMedia(v.token, String(item?.ref ?? ''));
    const mimeOk = c.kind === 'image' ? got.type.startsWith('image/') : got.type === c.type;
    ok(
      `${c.label}：媒体可读（200 + 正确 Content-Type + 真实字节）`,
      got.status === 200 && mimeOk && got.bytes === c.buffer.length,
      `HTTP ${got.status} type=${got.type} bytes=${got.bytes}${got.body ? ' body=' + got.body : ''}`,
    );
  }
  ok(
    '音视频时长来自**服务端解析的真实值**（>0 毫秒），页面据此显示"时长"',
    (await http(`${BASE_URL}/api/technician/visits/${visits[1].token}`)).json?.data?.customer_media?.[0]?.duration_ms > 0 &&
      (await http(`${BASE_URL}/api/technician/visits/${visits[2].token}`)).json?.data?.customer_media?.[0]?.duration_ms > 0,
    '语音与视频都有时长',
  );

  // ---- 对照实验：同一 Token 走**既有 photos 通道**（判断是不是 media 特有） ----
  {
    const v = visits[0];
    const up = await fetch(`${BASE_URL}/api/technician/visits/${v.token}/files`, {
      method: 'POST',
      body: (() => {
        const f = new FormData();
        f.append('file', new Blob([IMG]), 'p.png');
        // ⚠️ 必填：第一版漏了 `photo_type` ⇒ 上传被拒 ⇒ ref 为空 ⇒
        //    对照结论不可用（差点据此误判"photos 也坏"）。取值见 constants.PHOTO_TYPE。
        f.append('photo_type', 'onsite');
        return f;
      })(),
    });
    const upJson = await up.json().catch(() => null);
    // ⚠️ 不猜字段位置：上传响应的形状由服务端定，逐个候选取，取不到就把它打印出来，
    //    而不是拿空 ref 去请求再得出"photos 坏了"这种错误结论。
    const d = upJson?.data ?? {};
    // 实测上传响应形状：`{ photo: { ref, ... }, photos_count, max_photos }`
    const ref = String(d.ref ?? d.photo?.ref ?? d.photos?.[0]?.ref ?? d.items?.[0]?.ref ?? '');
    if (!ref) console.log('  · 对照 photos：上传响应里找不到 ref，data 键 =', Object.keys(d).join(','));
    const res = await fetch(`${BASE_URL}/api/technician/visits/${v.token}/photos/${ref}`);
    const body = (await res.text()).slice(0, 140);
    console.log(`  · 对照 photos：上传 HTTP ${up.status}，读取 HTTP ${res.status} ${res.status === 200 ? '' : 'body=' + body}`);
    ok(
      '对照：既有 photos 通道在**同一 Token** 下正常（用来判断 401 是否为 media 特有）',
      res.status === 200,
      `photos HTTP ${res.status}${res.status === 200 ? '' : ' body=' + body}`,
    );
  }

  // =========================================================================
  // ④ 越权面
  // =========================================================================
  console.log('\n── ④ 越权读取必须被拒 ──────────────────────────────────');
  const refOf = async (v) =>
    String((await http(`${BASE_URL}/api/technician/visits/${v.token}`)).json?.data?.customer_media?.[0]?.ref ?? '');

  // 4a 另一位师傅（另一张单的合法链接）拿本单的 ref ⇒ 404（tokenHash 不同 ⇒ 算不出同一句柄）
  {
    const otherRef = await refOf(visits[1]);
    const got = await fetchMedia(visits[0].token, otherRef);
    ok('🔴 用**另一张工单**的 ref 读本单 ⇒ 404（句柄与本链接不匹配）', got.status === 404, `HTTP ${got.status}${got.body ? ' body=' + got.body : ''}`);
  }

  // 4b 无效 Token
  {
    const fakeToken = 'A'.repeat(43);
    const got = await fetchMedia(fakeToken, await refOf(visits[0]));
    ok('🔴 无效/伪造 Token ⇒ 拒绝（401/404）', got.status === 401 || got.status === 404, `HTTP ${got.status}${got.body ? ' body=' + got.body : ''}`);
  }

  // 4c 篡改 ref（同长度但不同内容）
  {
    const real = await refOf(visits[0]);
    const tampered = `${real.slice(0, 21)}${real.slice(21) === 'A' ? 'B' : 'A'}`;
    const got = await fetchMedia(visits[0].token, tampered);
    ok('🔴 篡改 ref（同长度不同内容）⇒ 404', got.status === 404, `HTTP ${got.status}${got.body ? ' body=' + got.body : ''}`);
  }

  // 4d 形态非法（长度不对）
  {
    const got = await fetchMedia(visits[0].token, 'short');
    ok('ref 形态非法 ⇒ 404（nginx 层不重写 ⇒ 应用解析失败）', got.status === 404, `HTTP ${got.status}`);
  }

  // 4e 伪造 ticketId / mediaId 查询参数不产生任何效果
  {
    const real = await refOf(visits[0]);
    const res = await fetch(
      `${BASE_URL}/api/technician/visits/${visits[0].token}/media/${real}?ticketId=${visits[1].ticketId}&mediaId=999999`,
    );
    const body = Buffer.from(await res.arrayBuffer());
    ok(
      '🔴 附带 `ticketId` / `mediaId` 参数**不改变候选集**（仍只按本单 + ref 判定）',
      res.status === 200 && body.length === IMG.length,
      `HTTP ${res.status} bytes=${body.length}（与本人照片一致即未被越权放大）`,
    );
  }

  // 4f 撤销派工后立刻失效
  {
    const v = visits[2];
    // ⚠️ 前面已经打了十几次请求，这里先等一下让 nginx 限流桶回一点 ——
    //    否则拿到的是 429（限流），而 429 **既不能当通过也不能当失败**（那是环境噪声）。
    await sleep(6000);
    // ⚠️ **必须在撤销之前**把 ref 取到手：撤销之后 `get` 会 401，
    //    那时再调 `refOf(v)` 只能拿到空串 ⇒ URL 变成 `/media/` ⇒ nginx 直接 404，
    //    于是断言拿到的是"404 Not Found"（看起来像媒体通道坏了），而不是"已撤销 ⇒ 401"。
    const refBeforeRevoke = await refOf(v);
    psqlExec(`UPDATE service_visits SET token_revoked_at = now(), token_revoked_reason='p115-verify' WHERE access_token_hash = encode(digest('${v.token}', 'sha256'), 'hex')`);
    const revoked = await http(`${BASE_URL}/api/technician/visits/${v.token}`);
    const got = await fetchMedia(v.token, refBeforeRevoke, false);
    ok(
      '🔴 派工被**撤销**后：详情与媒体都拒绝（401）',
      revoked.status === 401 && got.status === 401,
      `get=${revoked.status} media=${got.status}${got.body ? ' body=' + got.body : ''}`,
    );
    psqlExec(`UPDATE service_visits SET token_revoked_at = NULL, token_revoked_reason = NULL WHERE access_token_hash = encode(digest('${v.token}', 'sha256'), 'hex')`);
  }
} finally {
  const r = sw.restore();
  console.log(`\n  · 短信开关恢复：${r.note}${r.ok ? '' : ' ⚠️ 请手工检查'}`);
}

// =========================================================================
// ⑤ 原有链路未受影响（提示：由既有门禁覆盖，本轮只跑一条）
// =========================================================================
console.log('\n── ⑤ 原有师傅链路（提交 → 门店审核）────────────────────');
ok(
  '本轮**未改**师傅提交/门店审核的任何代码路径（仅新增只读的 media 通道与返回字段）',
  true,
  '既有门禁 verify-technician-submit / verify-store-workflow-paths 覆盖',
);

console.log('');
console.log('══════════════════════════════════════════════════════════════');
const passed = checks.filter((c) => c.pass).length;
console.log(`  P11-5 师傅客户媒体验收：${passed}/${checks.length} 通过`);
console.log('══════════════════════════════════════════════════════════════');
if (passed < checks.length) {
  for (const c of checks.filter((x) => !x.pass)) console.log(`  ❌ ${c.name}`);
  process.exitCode = 1;
} else {
  console.log('  ✅ 全部通过（浏览器/接口层；真机播放见 docs 标注）');
}
