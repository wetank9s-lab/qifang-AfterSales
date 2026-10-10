#!/usr/bin/env node
/**
 * verify-store-official-list.mjs —— 门店**正式清单**落库的可复核门禁
 * （Phase 11 / P11-2 · 用户 A 段，2026-10-10）
 *
 * ===========================================================================
 * 这一段要防的是什么
 * ===========================================================================
 * 用户给了 10 条真实「门店名称 + 门店地址」，并逐条划了红线：
 *   · **不得假定**这十条按顺序对应 S01～S10；
 *   · 只有"名称唯一、匹配无歧义"才能更新；简称/别名须给证据；
 *   · 无法确认的**列为待核对**，**不得猜测绑定**，也不得新建重复门店；
 *   · 只更新确认匹配的**展示名称与 address**，不覆盖已有有效联系方式或其他业务配置；
 *   · 电话号码未提供 ⇒ **一律保持 NULL，不得生成虚假号码**；
 *   · H5 电话为空时**隐藏整行**（不出现 "null"、空链接、测试号码）；
 *   · **不得改变已有二维码签名或工单归属**；
 *   · ⚠️ `stores.address`（门店**经营**地址）与 `serviceTickets.service_address`
 *     （客户**服务**地址）**绝不能互相填充**。
 *
 * 这些红线有一个共同特点：**写错了都不会报错**。
 *   占位名被替换成"看起来对"的名字、地址被借给别家、电话被补一个测试号 ——
 *   页面照样渲染，接口照样 200。所以判据必须落在**可核对的具体值**上，
 *   而且每一条都要有**反向**（正例+反例成对）。
 *
 * ===========================================================================
 * 本文件覆盖 / **不**覆盖（诚实边界）
 * ===========================================================================
 * 覆盖：清单逐字、匹配结论（confirmed/pending）、种子派生、真库落库值、
 *      未确认行"一字未动"、匿名 API 四字段、**签名/二维码不变量**、
 *      以及"两个 address 不得互填"的**源码 tripwire**（带变异自测）。
 *
 * ⚠️ **不**覆盖：H5 门店卡的**真实渲染**。那一段需要浏览器与登录态，
 *    已并进 `scripts/verify-store-entry.mjs` §8（同一处 harness，不另起第三个
 *    Chrome 启动实现 —— 本项目已经因为"同一件事两份实现"吃过 DEV-132）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { SVC_BASE_URL, SVC_TLS_INSECURE } from './lib/base-url.mjs';
import { storeEntryToken } from './lib/store-entry-token.mjs';
import {
  EnvNotReady,
  assert,
  http,
  makeChecker,
  psqlRows,
  psqlScalar,
  runMain,
} from './technician-harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OFFICIAL_TS = path.join(
  ROOT,
  'nocobase/plugins/service-ticket/src/server/seeds/store-official-list.ts',
);
const SEED_STORES_TS = path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/seeds/stores.ts');
const MIGRATION_TS = path.join(
  ROOT,
  'nocobase/plugins/service-ticket/src/server/migrations/202610105-store-official-profile.ts',
);


const BASE = SVC_BASE_URL;

// ---------------------------------------------------------------------------
// 期望值：**用户 2026-10-10 提供的 10 条原文**（手写，不从被测源码派生）
// ---------------------------------------------------------------------------
// ⚠️ 为什么手抄一份：从被测文件里读出来的"期望值"永远等于被测文件
//    ⇒ 那等于没有断言。这里抄的是**用户消息里的原文**，是外部事实。
const USER_PROVIDED = [
  { name: '新都圣大家电', address: '新都区新城市广场和信中心1-3楼' },
  { name: '金堂华林电器', address: '金堂县赵镇十里大道一段428号' },
  { name: '龙泉东山电器', address: '龙泉驿区驿都东路38号锦宏时代商场' },
  { name: '蒲江江华家电', address: '蒲江县城仙鹤桥头' },
  { name: '崇州九兴电器', address: '崇州市蜀州中路96号' },
  { name: '青神易田电器', address: '眉山市青神县振兴路224号' },
  { name: '新津欣盛电器', address: '新津区武阳中路27号' },
  { name: '郫都康乐电器', address: '郫都区南大街66号' },
  { name: '茂县国茂电器', address: '茂县凤仪镇内南街54号（城门洞）' },
  { name: '峨眉诚信电器', address: '峨眉山市绥山西路坤大鑫城' },
];

/** 本轮**允许**落库的匹配（证据充分）；其余一律待核对 */
const EXPECT_CONFIRMED = {
  S01: { name: '新都圣大家电', address: '新都区新城市广场和信中心1-3楼' },
  S04: { name: '金堂华林电器', address: '金堂县赵镇十里大道一段428号' },
};
/** 落库前的占位名（用于证明"只改了这两行、且只从占位名改成正式名"） */
const PLACEHOLDER_NAMES = {
  S01: '圣大家电新都店',
  S04: '金堂华林电器',
};

const read = (p) => fs.readFileSync(p, 'utf8');

async function main() {
  const { check, checkAsync, summary } = makeChecker({ heading: '门店正式清单' });

  // -------------------------------------------------------------------------
  console.log('\n── 1 清单层：10 条原文逐字保留，匹配结论结构上只能落 confirmed ────');
  // -------------------------------------------------------------------------
  const officialTs = read(OFFICIAL_TS);

  check('① 清单里恰好 10 条，且 name/address 与用户原文**逐字**一致', () => {
    // 解析 `name: '…'` / `address: '…'` / `code: 'Sxx' | null` / `status: '…'`
    const blocks = officialTs.split(/\n  \{\n/).slice(1);
    assert(blocks.length === USER_PROVIDED.length, `解析到 ${blocks.length} 条，期望 ${USER_PROVIDED.length} 条`);
    const parsed = blocks.map((b) => ({
      name: /name:\s*'([^']*)'/.exec(b)?.[1] ?? null,
      address: /address:\s*'([^']*)'/.exec(b)?.[1] ?? null,
      code: /code:\s*(?:'([^']*)'|(null))/.exec(b)?.[1] ?? null,
      status: /status:\s*'([^']*)'/.exec(b)?.[1] ?? null,
    }));
    for (const [i, expect] of USER_PROVIDED.entries()) {
      assert(parsed[i].name === expect.name, `第 ${i + 1} 条名称被改写了：${JSON.stringify(parsed[i].name)} ≠ ${JSON.stringify(expect.name)}`);
      assert(
        parsed[i].address === expect.address,
        `第 ${i + 1} 条地址被改写了：${JSON.stringify(parsed[i].address)} ≠ ${JSON.stringify(expect.address)}`,
      );
      assert(['confirmed', 'pending'].includes(parsed[i].status), `第 ${i + 1} 条 status 非法：${parsed[i].status}`);
    }
    return `10 条逐字一致（${parsed.filter((p) => p.status === 'confirmed').length} confirmed / ${parsed.filter((p) => p.status === 'pending').length} pending）`;
  });

  check('① 匹配结论：confirmed **恰好这 2 条**（S01 / S04），一条不多', () => {
    const confirmed = [...officialTs.matchAll(/code:\s*'([^']+)',[\s\S]{0,200}?status:\s*'confirmed'/g)].map(
      (m) => m[1],
    );
    assert(
      JSON.stringify(confirmed.sort()) === JSON.stringify(Object.keys(EXPECT_CONFIRMED).sort()),
      `confirmed 是 ${JSON.stringify(confirmed)}，期望 ${JSON.stringify(Object.keys(EXPECT_CONFIRMED))}`,
    );
    return confirmed.join(' / ');
  });

  check('① **反向**：8 条待核对的 `code` 必须是 `null`（结构上无法被写库）', () => {
    const pendingBlocks = officialTs
      .split(/\n  \{\n/)
      .slice(1)
      .filter((b) => /status:\s*'pending'/.test(b));
    assert(pendingBlocks.length === 8, `pending 有 ${pendingBlocks.length} 条，期望 8 条`);
    for (const b of pendingBlocks) {
      assert(/code:\s*null/.test(b), `待核对条目竟然带了 code：${b.slice(0, 120)}`);
    }
    return `${pendingBlocks.length} 条 pending 均为 code:null`;
  });

  // -------------------------------------------------------------------------
  console.log('\n── 2 产物层：种子从同一份清单派生（重跑 seed 不会写回占位名/空值）──');
  // -------------------------------------------------------------------------
  // ⚠️ 为什么在**容器内**跑这一小段，而不是在宿主机 require 构建产物：
  //    构建产物把 `@nocobase/server` 等宿主包声明为 **external**（本来就不该打进插件），
  //    宿主机仓库里没有它们的 `node_modules` ⇒
  //      · 按包名 require：`Cannot find module '@local/service-ticket'`
  //        （包名只在容器里被挂链接）；
  //      · 按绝对路径 require：`Cannot find module '@nocobase/server'`。
  //    两条都试过（这一节因此红了两轮）。容器里这两个都能解析，
  //    而且那才是**真正会被执行的那份产物** —— 比在宿主机上造桩更接近事实。
  //    （`verify-plugin-load` 能在宿主机跑，是因为它先搭了一个带链接的临时应用目录。）
  const IN_CONTAINER_PROBE = `
    const m = require('@local/service-ticket');
    const codes = ['S01', 'S04', 'S02', 'S05'];
    const rows = {};
    for (const code of codes) {
      const seed = m.STORE_SEEDS.find((s) => s.code === code);
      rows[code] = seed ? m.toStoreRow(seed) : null;
    }
    console.log(JSON.stringify({
      total: m.STORE_SEEDS.length,
      rows,
      nullAddress: m.STORE_SEEDS.filter((s) => s.address === null || s.address === undefined).map((s) => s.code),
      anyPhone: m.STORE_SEEDS.filter((s) => s.contactPhone).map((s) => s.code),
    }));
  `;

  let probe = null;
  check('② 容器内可加载构建产物（`@local/service-ticket` 可解析）', () => {
    let out = '';
    try {
      out = execFileSync('docker', ['exec', 'svc-app', 'node', '-e', IN_CONTAINER_PROBE], {
        encoding: 'utf8',
        timeout: 60000,
      });
    } catch (e) {
      throw new EnvNotReady(
        `容器内加载产物失败（容器在跑吗？产物构建了吗？）：${String(e.stderr || e.message).slice(0, 200)}`,
      );
    }
    const line = out.split('\n').find((l) => l.trim().startsWith('{'));
    assert(line, `容器内没有输出 JSON：${out.slice(0, 200)}`);
    probe = JSON.parse(line);
    assert(probe.total === 15, `STORE_SEEDS ${probe.total} 条，期望 15`);
    return `${probe.total} 条种子`;
  });

  check('② STORE_SEEDS 里 S01/S04 已是**正式名**，且带上了 address', () => {
    assert(probe, '上一步未取得探针结果');
    for (const [code, expect] of Object.entries(EXPECT_CONFIRMED)) {
      const row = probe.rows[code];
      assert(row, `${code} 的种子行缺失`);
      assert(row.name === expect.name, `${code} 种子名 ${JSON.stringify(row.name)} ≠ ${JSON.stringify(expect.name)}`);
      assert(
        row.address === expect.address,
        `${code} 种子地址 ${JSON.stringify(row.address)} ≠ ${JSON.stringify(expect.address)}`,
      );
      assert(row.contact_phone === null, `${code} 种子 contact_phone=${JSON.stringify(row.contact_phone)}，期望 null`);
    }
    return Object.keys(EXPECT_CONFIRMED).join(' / ');
  });

  check('② **反向**：未确认的门店种子 `address` 必须是 null（不得借用别家地址）', () => {
    assert(probe, '上一步未取得探针结果');
    const expectedNull = 15 - Object.keys(EXPECT_CONFIRMED).length;
    assert(
      probe.nullAddress.length === expectedNull,
      `address 为 null 的有 ${probe.nullAddress.length} 条，期望 ${expectedNull}（实际：${probe.nullAddress.join(',')}）`,
    );
    for (const code of Object.keys(EXPECT_CONFIRMED)) {
      assert(!probe.nullAddress.includes(code), `${code} 已确认却仍没有地址`);
    }
    assert(
      probe.rows.S05 && probe.rows.S05.address === null,
      `未确认的 S05 竟然有地址：${JSON.stringify(probe.rows.S05.address)}`,
    );
    return `${expectedNull} 条 address=null（含未确认的 S05）`;
  });

  check('② `toStoreRow()` 的产出就是落库值（seed 一旦运行也只写正式资料）', () => {
    // 这是"重新运行门店 seed 不得恢复旧空值"的**直接证明**：
    // 种子路径只增不改（seeds/apply.ts），因此"再跑一次会写什么"完全由 toStoreRow 决定。
    assert(probe, '上一步未取得探针结果');
    assert(probe.anyPhone.length === 0, `这些门店的种子带了电话：${probe.anyPhone.join(',')}`);
    return 'S01/S04 正式值 · 其余 address=null · 无任何种子电话';
  });

  // -------------------------------------------------------------------------
  console.log('\n── 3 真库：恰好 2 行被改，其余一字未动 ───────────────────────────');
  // -------------------------------------------------------------------------
  const rows = psqlRows(
    'SELECT code, name, coalesce(address,\'<NULL>\'), coalesce(contact_phone,\'<NULL>\'), active::text FROM stores ORDER BY code',
  );
  check('③ 库里恰好 15 家门店（**没有**因为"待核对"而新建门店）', () => {
    assert(rows.length === 15, `库里 ${rows.length} 家，期望 15（待核对条目不得新建门店）`);
    return '15 家';
  });

  check('③ S01 / S04 的 name + address 与清单**逐字**一致', () => {
    for (const [code, expect] of Object.entries(EXPECT_CONFIRMED)) {
      const row = rows.find((r) => r[0] === code);
      assert(row, `库里没有 ${code}`);
      assert(row[1] === expect.name, `${code} name=${JSON.stringify(row[1])} ≠ ${JSON.stringify(expect.name)}`);
      assert(row[2] === expect.address, `${code} address=${JSON.stringify(row[2])} ≠ ${JSON.stringify(expect.address)}`);
    }
    return Object.keys(EXPECT_CONFIRMED).join(' / ');
  });

  check('③ **反向**：未确认的 13 家 name 仍是占位名、address 仍为 NULL', () => {
    const others = rows.filter((r) => !(r[0] in EXPECT_CONFIRMED));
    const withAddress = others.filter((r) => r[2] !== '<NULL>');
    assert(withAddress.length === 0, `这些门店有地址：${withAddress.map((r) => `${r[0]}=${r[2]}`).join(', ')}`);
    const brokenPlaceholder = others.filter((r) => !r[1].startsWith('圣大家电'));
    assert(
      brokenPlaceholder.length === 0,
      `未知来源的门店名：${brokenPlaceholder.map((r) => `${r[0]}=${r[1]}`).join(', ')}`,
    );
    return `13 家：占位名 + address NULL`;
  });

  check('③ **反向**：S01 的旧占位名「圣大家电新都店」在库里**已不存在**（改名真的生效）', () => {
    const left = Number(psqlScalar(`SELECT count(*) FROM stores WHERE name = '${PLACEHOLDER_NAMES.S01}'`));
    assert(left === 0, `仍有 ${left} 行叫「${PLACEHOLDER_NAMES.S01}」`);
    return '旧占位名已消失';
  });

  check('③ 全部 15 家 `contact_phone` 仍为 NULL（**未生成任何虚假号码**）', () => {
    const nonNull = rows.filter((r) => r[3] !== '<NULL>');
    assert(nonNull.length === 0, `这些门店有电话：${nonNull.map((r) => `${r[0]}=${r[3]}`).join(', ')}`);
    return '15/15 为 NULL';
  });

  check('③ 全部 15 家 `active` 仍为 true（停用状态未被顺手改掉）', () => {
    const inactive = rows.filter((r) => r[4] !== 'true');
    assert(inactive.length === 0, `被停用的：${inactive.map((r) => r[0]).join(', ')}`);
    return '15/15 active';
  });

  // -------------------------------------------------------------------------
  console.log('\n── 4 匿名 API：入口解析带上正式资料，但**不下发**内部字段 ────────');
  // -------------------------------------------------------------------------
  await checkAsync('④ `publicStore:entry` 对 S01/S04 回 {code,name,phone,address}，且与库一致', async () => {
    const out = [];
    for (const code of Object.keys(EXPECT_CONFIRMED)) {
      const r = await http(`${BASE}/api/public/store-entry?k=${encodeURIComponent(storeEntryToken(code))}`, {
        timeout: 15000,
      });
      assert(r.status === 200, `${code} HTTP ${r.status}：${String(r.body).slice(0, 160)}`);
      const d = r.json?.data;
      assert(d, `${code} 没有 data`);
      const keys = Object.keys(d).sort();
      assert(
        JSON.stringify(keys) === JSON.stringify(['address', 'code', 'name', 'phone']),
        `${code} 的字段集合是 ${keys.join(',')}，期望 address,code,name,phone`,
      );
      assert(d.name === EXPECT_CONFIRMED[code].name, `${code} API name=${JSON.stringify(d.name)}`);
      assert(d.address === EXPECT_CONFIRMED[code].address, `${code} API address=${JSON.stringify(d.address)}`);
      assert(d.phone === null, `${code} API phone=${JSON.stringify(d.phone)}，期望 null`);
      out.push(`${code}:${d.name}`);
    }
    return out.join(' · ');
  });

  await checkAsync('④ **反向**：响应体里不得出现字符串 "null"（电话为空不是把 null 渲染成文本）', async () => {
    const r = await http(`${BASE}/api/public/store-entry?k=${encodeURIComponent(storeEntryToken('S01'))}`, {
      timeout: 15000,
    });
    const body = String(r.body);
    assert(!body.includes('"null"'), `响应体里出现了字符串 "null"：${body.slice(0, 200)}`);
    assert(/"phone":\s*null/.test(body), 'phone 应该是 JSON null');
    return 'phone 是 JSON null，不是字符串';
  });

  // -------------------------------------------------------------------------
  console.log('\n── 5 不变量：门店资料更新**不得**改变二维码签名 ──────────────────');
  // -------------------------------------------------------------------------
  await checkAsync('⑤ 抽样核对：被改过资料的 S01/S04 与未改动的 S02，入口**都仍然有效**', async () => {
    // ⚠️ 为什么不逐一核 15 条：`publicStore:entry` 与 §1.1 共用一个 **IP 分钟限流桶**，
    //    连打 15 次会拿到 429，而 429 会被误读成"签名对不上了"（第一版就是这么红的
    //    —— S09~S15 全报 429）。判据要的是"资料更新**没有破坏**入口解析"，
    //    抽样 3 条（2 条被改 + 1 条未改作对照）就足以证伪，且不消耗完额度。
    //    15 条的**逐一**核对由 `verify-store-entry.mjs` §9 负责（它有自己的节流）。
    const targets = ['S01', 'S04', 'S02'];
    const mismatched = [];
    const detail = [];
    for (const code of targets) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 1200));
      // 宿主侧用**产品实现**重算（不重写 HMAC），与服务端返回的门店比对
      // eslint-disable-next-line no-await-in-loop
      const r = await http(`${BASE}/api/public/store-entry?k=${encodeURIComponent(storeEntryToken(code))}`, {
        timeout: 15000,
      });
      if (r.status !== 200 || r.json?.data?.code !== code) {
        mismatched.push(`${code}:HTTP ${r.status}`);
      } else {
        detail.push(`${code}→${r.json.data.name}`);
      }
    }
    assert(
      mismatched.length === 0,
      `这些门店的签名入口在资料更新后对不上了：${mismatched.join(', ')} —— 签名输入里混进了 name/address`,
    );
    return `${detail.join(' · ')}（含 2 条被改资料 + 1 条未改对照）`;
  });

  check('⑤ 签名实现**只**以 (编码, SIGN_SECRET) 为输入（源码断言，不是口头承诺）', () => {
    const signer = read(path.join(ROOT, 'nocobase/plugins/service-ticket/src/server/services/store-entry.ts'));
    // 反向：签名材料里不得出现 name / address
    const material = /createHmac\([^)]*\)[\s\S]{0,240}?\.update\(([^)]*)\)/.exec(signer)?.[1] ?? '';
    assert(material, '解析不到 createHmac(...).update(...) 的签名材料');
    assert(!/name|address/.test(material), `签名材料里出现了 name/address：${material.trim()}`);
    return `update(${material.trim().slice(0, 60)}…)`;
  });

  // -------------------------------------------------------------------------
  console.log('\n── 6 隔离 tripwire：两个 address 绝不能互相填充 ─────────────────');
  // -------------------------------------------------------------------------
  check('⑥ 清单文件与迁移源码里**不得**出现 serviceTickets / service_tickets', () => {
    for (const [label, file] of [
      ['store-official-list.ts', OFFICIAL_TS],
      ['202610105-…', MIGRATION_TS],
    ]) {
      const src = read(file)
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)) // 注释不算（注释里正说明"不得互填"）
        .join('\n');
      const hit = /service_tickets|serviceTickets/.test(src);
      assert(!hit, `${label} 的**代码**里引用了工单表 —— stores.address 与客户服务地址有互填风险`);
    }
    // 迁移也不得写 contact_phone
    const mig = read(MIGRATION_TS)
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    assert(
      !/SET[^;]*contact_phone/i.test(mig),
      '迁移里出现了给 contact_phone 赋值的语句 —— 用户未提供电话，不得写它',
    );
    return '两个文件均不引用工单表 · 迁移不写 contact_phone';
  });

  check('⑥ 变异自测：把上述 tripwire 的判据喂进"坏样本"，必须判红', () => {
    const probe = (src) =>
      /service_tickets|serviceTickets/.test(
        src
          .split('\n')
          .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
          .join('\n'),
      );
    assert(probe('await sequelize.query(`UPDATE service_tickets SET x=1`)') === true, 'tripwire 抓不到 UPDATE service_tickets');
    assert(probe('  // 只说明不得写 service_tickets') === false, '注释被误判为违规');
    const phoneProbe = (src) => /SET[^;]*contact_phone/i.test(src);
    assert(phoneProbe('UPDATE stores SET contact_phone = $1') === true, 'tripwire 抓不到写 contact_phone');
    return '两个 tripwire 都有区分力';
  });

  // -------------------------------------------------------------------------
  console.log('\n── 7 迁移可复核：登记在册 + 审计可读 ─────────────────────────────');
  // -------------------------------------------------------------------------
  check('⑦ 迁移已在 `migrations` 表登记', () => {
    const names = psqlRows(`SELECT name FROM migrations WHERE name LIKE '202610105%'`).map((r) => r[0]);
    assert(
      names.includes('202610105-store-official-profile/@local/service-ticket'),
      `未登记，命中：${names.join(', ') || '<无>'}`,
    );
    return names.join(', ');
  });

  check('⑦ 审计记录可读，且**如实**列出 applied 与 pending', () => {
    const raw = psqlScalar(`SELECT value FROM service_settings WHERE key = 'store.profile.official-list.audit'`);
    assert(raw, '没有审计记录');
    const audit = JSON.parse(raw);
    assert(audit.applied?.length === 2, `applied 有 ${audit.applied?.length} 条，期望 2`);
    assert(audit.pending?.length === 8, `pending 有 ${audit.pending?.length} 条，期望 8`);
    assert(audit.total_provided === 10, `total_provided=${audit.total_provided}，期望 10`);
    for (const p of audit.pending) {
      assert(p.reason && p.reason.length > 4, `pending 条目缺少理由：${JSON.stringify(p)}`);
    }
    return `applied ${audit.applied.length} · pending ${audit.pending.length} · 来源 ${audit.source}`;
  });

  // -------------------------------------------------------------------------
  console.log('\n── 8 工单归属未被破坏 ──────────────────────────────────────────');
  // -------------------------------------------------------------------------
  check('⑧ **真实工单**（单号 `FW…`）没有一张变成"孤儿"', () => {
    // ⚠️ 第一版写成"任何工单都不许孤儿"，结果抓出 4 张 —— 查下去发现是
    //    **2026-09-26 的 Phase 7 走查夹具**（单号形如 `P7W-…` / `P7PROBE-…`，
    //    不是 `FW…` 形态，`store_id` 本来就为空），与本轮改动无关。
    //    ⇒ 判据收窄到"**真实单号**不得孤儿"：既有区分力（真单归属被破坏必红），
    //      又不会把历史夹具的已知形态误报成回归。
    //    ⚠️ 但也**不掩盖**：历史夹具的数量一并报出来，谁都能看见它们还在。
    const orphans = psqlRows(
      `SELECT t.ticket_no FROM service_tickets t
         LEFT JOIN stores s ON s.id = t.store_id
        WHERE s.id IS NULL`,
    ).map((r) => r[0]);
    const realOrphans = orphans.filter((no) => /^FW\d{8}-\d{4}$/.test(String(no)));
    assert(realOrphans.length === 0, `真实工单成了孤儿：${realOrphans.join(', ')}`);
    const total = Number(psqlScalar('SELECT count(*) FROM service_tickets'));
    return `${total} 张工单，真实单号孤儿 0 张（另有 ${orphans.length} 张历史走查夹具无 store_id，属既有形态）`;
  });

  summary();
}

await runMain({ name: '门店正式清单 · 落库可复核', main });

if (SVC_TLS_INSECURE) {
  /* 自签演练证书：base-url.mjs 已打印过提示，这里不再重复 */
}
