/**
 * _b36-admin-probe.mjs —— B-36 后台配置区（任务 #267）的**契约探针**
 *
 * 为什么单独一个探针，而不是并进 `_b36-banner-e2e.mjs`：
 *   e2e 只管"客户端看到的对不对"（公众面），它**只测了** viewer 被 403 这一条后台路径。
 *   而"后台配置区能不能用"是另一条腿：`bannerList` 是这块 UI 的**唯一数据来源**，
 *   它的返回结构一改，页面就会静默退化成空下拉/空列表 —— 构建期看不出来。
 *
 * =============================================================================
 * 🔴 本探针是被一个**真实缺陷**逼出来的（记在这里，免得以后又踩）
 * =============================================================================
 * 初版 `BannerManager` 写了 `request('svc:storeOptions')` 取门店下拉，并读
 * `data.items`。两处都错：
 *   ① 我曾以为"这个动作不存在"—— **不对**，它确实存在（`actions/svc/ticket.ts:410`）；
 *   ② 但它回的是 `{options:[{code,name}]}` —— **没有主键 id**，读 `data.items` 必然 undefined，
 *      下拉静默为空。而 `bannerUpload` 的 `store_id` 要的是**正整数主键**，
 *      `code`（'S01'）填进去会被 `intOf` 判 422。
 * ⇒ 后果形态：**页面能加载、不报错、只是"选不了门店"** —— 最难看出来的那一类。
 * ⇒ 所以本探针的判据不含糊：**必须真的能拿到 id**，并且拿到的 id **真的能用于上传**。
 *
 * =============================================================================
 * 退出码
 * =============================================================================
 *   0 = 全绿（后台契约成立）
 *   1 = 产品红（契约不成立）
 *   2 = 环境未就绪（限流/登录不了/基线脏 —— **不给产品结论**）
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import {
  APP_DIRECT,
  CONFIG_TTL_WAIT_MS,
  createRateLimitGate,
  purgeBanners,
  readEnv,
  signIn,
  makeApi,
  psql,
} from './_b36-lib.mjs';

const BASE = 'https://127.0.0.1';
const env = readEnv();

const gate = createRateLimitGate();
const note = gate.note;
const api = makeApi(BASE, note);

let pass = 0;
const fails = [];
function ok(msg) { pass += 1; console.log(`  ✅ ${msg}`); }
function no(msg) { fails.push(msg); console.log(`  ❌ ${msg}`); }
function chk(cond, msg) { if (cond) ok(msg); else no(msg); }

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  B-36 后台配置区契约探针（#267）');
console.log('══════════════════════════════════════════════════════════════');

gate.raise();
console.log(`  ⏳ 等待配置 TTL（${CONFIG_TTL_WAIT_MS}ms）…`);
await new Promise((r) => setTimeout(r, CONFIG_TTL_WAIT_MS));

try {
  // 起始基线干净：门店 1 与 4 都不留 Banner（后面要按 id 精确断言）
  const clean = await purgeBanners([1, 4], 'admin-probe 前置');
  if (!clean) throw new Error('前置清理未归零 ⇒ 环境未就绪');

  const hqToken = await signIn(BASE, 'uat.hqadmin@svc.local', env.UAT_HQADMIN_PASSWORD);
  const storeAToken = await signIn(BASE, 'uat.store.a@svc.local', env.UAT_STORE_A_PASSWORD);
  const viewerToken = await signIn(BASE, 'uat.viewer@svc.local', env.UAT_VIEWER_PASSWORD);
  ok('三类账号登录成功（hq_admin / store_a / viewer）');

  // ───────────────────────────────────────────── ① 总部管理员：清单 + 门店下拉
  console.log('\n【①】总部管理员 `svc:bannerList` —— 页面唯一数据来源');
  const r1 = await api(hqToken, '/api/svc:bannerList');
  chk(r1.status === 200, `HTTP 200（实际 ${r1.status}）`);
  const d1 = r1.json?.data ?? {};

  chk(Array.isArray(d1.items), '`data.items` 是数组（列表渲染的输入）');
  chk(d1.can_manage_global === true, '`can_manage_global=true`（总部可配"总部通用"）');

  // ★ 本探针的**核心判据**：门店下拉必须带 **数字主键 id**
  const opts = d1.store_options;
  chk(Array.isArray(opts), '`data.store_options` 是数组（门店下拉的输入）');
  if (Array.isArray(opts) && opts.length) {
    const allNumeric = opts.every((o) => Number.isInteger(o?.id) && o.id > 0);
    chk(allNumeric, `每个选项都有**正整数主键 id**（${opts.length} 项：${opts.slice(0, 3).map((o) => `${o.id}:${o.name}`).join(' / ')}）`);
    const allNamed = opts.every((o) => typeof o.name === 'string' && o.name.length > 0);
    chk(allNamed, '每个选项都有非空 `name`（下拉显示文本）');
  } else {
    no('总部管理员看到**空**门店下拉 —— 后台"指定适用门店"将不可用');
  }

  // ★★ 「id 必须是主键」的**偏序判据**（双向，见下方 ①b 的反向用例）
  //
  //   初版这里写的是 `id 不是门店编码字符串（形如 S01）` —— 那是一条**永远为真**的断言：
  //   服务端是拿 `Number(p.id)` 拼出来的，`String(Number(...))` 必然是纯数字。
  //   它不会红，等于没有断言（docs/ENGINEERING-RULES.md 铁律 ①）。
  //
  //   真正会红、也真正有关的形态是：**id 与 code 错位**。
  //   判据改成"与数据库对账"：下拉里的每个 id **在 stores 表里真实存在**，
  //   且**该 id 那一行的 name 与下拉里的 name 一致**（错位就是这里先红）。
  //   `psql` 用 `-A -t -F '|'` ⇒ 每行形如 `1|新都圣大家电`
  const truthRows = psql('select id, name from stores where active = true;');
  const truth = new Map();
  for (const line of String(truthRows).split('\n')) {
    const parts = line.split('|');
    if (parts.length >= 2 && /^\d+$/.test(parts[0].trim())) {
      truth.set(Number(parts[0].trim()), parts.slice(1).join('|').trim());
    }
  }
  if (Array.isArray(opts) && opts.length && truth.size) {
    const mismatched = opts.filter((o) => truth.get(Number(o.id)) !== String(o.name));
    chk(
      mismatched.length === 0,
      `下拉里的 (id,name) 与数据库 ` + `**逐行一致**（对齐 ${opts.length} 项；错位项 ${mismatched.length}）`,
    );
  } else {
    no('无法与数据库对账（下拉为空或真值表为空）');
  }

  // ───────────────────────────────────────────── ② 下拉里的 id 真的能用于上传
  console.log('\n【②】下拉拿到的 id **真的能用**（不是"看着有、用不了"）');
  const pick = (opts ?? []).find((o) => Number(o.id) === 1) ?? opts?.[0];
  if (!pick) {
    no('没有可用门店 ⇒ 无法验证 id 可用性');
  } else {
    // 这里刻意**只验证到"服务端受理了 store_id"为止**：上传本身由 e2e 覆盖。
    // 若 id 形态不对，`intOf` 会回 422 BANNER_BAD_INT —— 正是我们要排除的。
    const ul = await api(hqToken, `/api/svc:bannerUpload?store_id=${pick.id}`, {
      method: 'POST',
      json: {},
      headers: { 'X-Request-Id': crypto.randomUUID() },
    });
    // 空 body 且非 multipart ⇒ 期望 422 BANNER_NO_FILE（说明 **store_id 已通过校验**）
    const code = ul.json?.errors?.[0]?.code ?? ul.json?.code ?? '';
    const text = String(ul.text);
    chk(
      !/BANNER_BAD_INT/.test(text) && !/门店 \d+ 不存在|BANNER_STORE_NOT_FOUND/.test(text),
      `下拉里的 id=${pick.id} 被服务端接受（未报 BANNER_BAD_INT / STORE_NOT_FOUND；实际 HTTP ${ul.status} ${code || text.slice(0, 80)}）`,
    );
    chk(ul.status === 422, `空上传被拒为 422（实际 ${ul.status}）`);
  }

  // ───────────────────────────────────────────── ③ 门店角色：范围收紧但下拉非空
  console.log('\n【③】门店角色（store_a）：**只能看到自己的门店**，但下拉不为空');
  const r3 = await api(storeAToken, '/api/svc:bannerList');
  chk(r3.status === 200, `HTTP 200（实际 ${r3.status}）`);
  const d3 = r3.json?.data ?? {};
  const opts3 = d3.store_options;
  chk(Array.isArray(opts3) && opts3.length > 0, `门店角色下拉**非空**（${Array.isArray(opts3) ? opts3.length : 'n/a'} 项）`);
  if (Array.isArray(opts3) && opts3.length && Array.isArray(opts)) {
    const hqIds = opts.map((o) => Number(o.id)).sort((a, b) => a - b);
    const storeIds = opts3.map((o) => Number(o.id));
    const subset = storeIds.every((id) => hqIds.includes(id));
    chk(subset, `门店角色的下拉是总部下发的**子集**（[${storeIds}] ⊂ [${hqIds}]）`);
    chk(storeIds.length < hqIds.length, `门店角色看到的比总部**少**（${storeIds.length} < ${hqIds.length}）—— 范围真的收紧了`);
  }
  chk(d3.can_manage_global === false, '`can_manage_global=false`（门店角色不该能配"总部通用"）');

  // ───────────────────────────────────────────── ④ viewer 仍被拒（回归）
  console.log('\n【④】只读角色仍被拒（回归：收口没被这轮改动破坏）');
  const r4 = await api(viewerToken, '/api/svc:bannerList');
  chk(r4.status === 403, `viewer ⇒ 403（实际 ${r4.status}）`);
  chk(!Array.isArray(r4.json?.data?.store_options), 'viewer **拿不到**门店下拉（403 响应里没有泄露清单）');

  // ───────────────────────────────────────────── ⑤ 停用门店不进下拉（**双向**）
  //
  // ⚠️ 初版这里写的是 `总部下拉有 N 家门店可核对` —— 那**根本不是断言**：
  //    只要下拉不为空就恒真，永远不会红（铁律 ① 的教科书反例）。
  //
  //    真正的判据必须能**看见"停用的店消失"**。做法：临时把一家店置为停用，
  //    确认它从下拉里**消失**，再恢复 —— 并且**两个方向都断言**
  //    （⑨ 之前有、置停用后没有、恢复后又有），否则"下拉本来就是空的"也会假绿。
  console.log('\n【⑤】停用门店不进下拉（双向：先证"它在"，再证"它没了"）');
  const probeStore = 15;   // S15 峨眉诚信电器：真实存在且启用，拿它做探针
  const namesBefore = (opts ?? []).map((o) => Number(o.id));
  const hadBefore = namesBefore.includes(probeStore);
  chk(hadBefore, `置停用**之前**：门店 ${probeStore} 在下拉里（前 ${namesBefore.length} 项）`);

  if (hadBefore) {
    // 直接改库（app 里没有"停用门店"的写动作，且本探针只验证**读**的过滤口径）
    psql(`update stores set active = false where id = ${probeStore};`);
    // 门店下拉走的是**实时查询**（不像限流配置有 TTL 缓存），但仍留一点缓冲
    await new Promise((r) => setTimeout(r, 800));

    const r5 = await api(hqToken, '/api/svc:bannerList');
    const opts5 = r5.json?.data?.store_options ?? [];
    const idsAfter = opts5.map((o) => Number(o.id));
    chk(
      !idsAfter.includes(probeStore),
      `置停用**之后**：门店 ${probeStore} **消失**了（现 ${idsAfter.length} 项）—— 过滤真的在生效`,
    );
    chk(idsAfter.length === namesBefore.length - 1, `数量恰好少 1（${namesBefore.length} → ${idsAfter.length}），不是"整片空掉"`);
    // 反向控制：**其它**门店必须还在（否则"整个下拉失败了"也会假绿）
    const othersKept = namesBefore.filter((id) => id !== probeStore).every((id) => idsAfter.includes(id));
    chk(othersKept, '其它门店**仍然在**（排除"整片下拉失败"这种假绿）');

    psql(`update stores set active = true where id = ${probeStore};`);
    await new Promise((r) => setTimeout(r, 800));
    const r5b = await api(hqToken, '/api/svc:bannerList');
    const idsBack = (r5b.json?.data?.store_options ?? []).map((o) => Number(o.id));
    chk(idsBack.includes(probeStore), `恢复启用**之后**：门店 ${probeStore} 又回来了（${idsBack.length} 项）—— 三个方向都自洽`);
  }
} catch (error) {
  console.log(`\n  ⚠️ 探针中断：${String(error?.message ?? error)}`);
  fails.push(`探针中断：${String(error?.message ?? error)}`);
} finally {
  // ⚠️ ⑤ 段会临时停用门店 15。若探针中途抛错，`finally` 必须**无条件**把它恢复 ——
  //    否则一次失败的探针会**留下一个被停用的真实门店**（客户 H5 下拉里从此少一家店）。
  //    这里不复用 ⑤ 里的变量（那段可能根本没跑到），直接按 id 写死恢复。
  try {
    psql('update stores set active = true where id = 15;');
    const back = psql('select count(*) from stores where id = 15 and active = true;');
    const n = Number(String(back).replace(/[^0-9]/g, ''));
    if (n !== 1) console.log('  ⚠️ 收尾未能确认门店 15 已恢复启用 —— 请人工核对！');
  } catch (e) {
    console.log(`  ⚠️ 收尾恢复门店 15 时出错：${String(e?.message ?? e)}`);
  }
  // 清掉本探针可能留下的行（② 里那次空上传按理不会建行，但清理要独立复核 —— 铁律 13）
  try {
    const cleaned = await purgeBanners([1, 4], 'admin-probe 收尾');
    if (!cleaned) console.log('  ⚠️ 收尾清理未归零');
  } catch { /* 清理失败不改判产品结论，但上面会提示 */ }
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
if (gate.state.sawRateLimit) {
  console.log('  ⚠️ 环境未就绪：探针期间撞到限流（429）—— 本结论**不作数**');
  console.log(`  通过 ${pass} 项 / 失败 ${fails.length} 项`);
  console.log('══════════════════════════════════════════════════════════════');
  process.exit(2);
}
if (fails.length) {
  console.log(`  ❌ 后台契约不成立：通过 ${pass} 项 / 失败 ${fails.length} 项`);
  // ⚠️ 这两行的**格式**是契约的一部分：`_b36-banner-src-mutation.mjs` 的红灯解析器
  //    认的就是「失败项：」+「  - x」这一对形态（两个观测器的输出格式必须统一，
  //    否则源码变异会得到"逃逸"的假结论）。
  console.log('  失败项：');
  for (const f of fails) console.log(`    - ${f}`);
  console.log('══════════════════════════════════════════════════════════════');
  process.exit(1);
}
console.log(`  ✅ 后台配置区契约全部通过：${pass} 项`);
console.log('══════════════════════════════════════════════════════════════');
process.exit(0);
