#!/usr/bin/env node
/**
 * =============================================================================
 *  verify-phase3-h5.mjs
 *  —— Phase 3-H 的验收：`/report` 客户报修页（Vue3 + Vite）
 * -----------------------------------------------------------------------------
 *  DEV-PLAN 对 H 的完成判据是：**「手机端可用；连点 10 次只产生 1 单」**。
 *  这句话里"连点 10 次"是唯一需要真正设计的东西，本脚本就围绕它展开。
 *
 *  ── 「连点 10 次只产生 1 单」由**两层独立机制**共同保证 ──
 *
 *    ① 前端 single-flight（h5/src/api/public.ts）
 *       10 次点击共享同一个 Promise，只发出 1 个 HTTP 请求。
 *       作用：省请求、省频控配额（IP 30 次/分，用户连点两轮就能把整栋楼挡住）。
 *
 *    ② 后端 request_id 幂等（插件 actions/public/ticket.ts）
 *       同号重放 → 回放首次响应；不新建工单、不消耗序号。
 *       作用：兜住"响应丢了但工单已落库"—— 这是前端**不可能**自己解决的问题。
 *
 *  两层必须分别下断言。把两层混为一谈的典型后果是：
 *  前端测试全绿，真机上因为网络重试多了一张单却没人发现。
 *
 *  ── 四组检查 ──
 *
 *   【1】前后端契约对齐（源码级）
 *        前端的校验常量 / 隐私说明版本号 / 请求头名 / UUID 正则，
 *        必须与插件源码里的对应值**逐字一致**。
 *        这类漂移不会让任何测试变红，只会让线上出现"本地校验通过、提交 422"
 *        或"存证的隐私版本号与用户看到的内容不符"。
 *
 *   【2】提交器行为（把 h5/src/api/public.ts 用 esbuild 打成 ESM 后真跑）
 *        不是"读代码看一眼"，而是**执行页面真正会执行的那份代码**。
 *
 *   【3】真机端到端：同一 request_id **并发 10 次** → 恰好 1 张工单、序号恰好 +1
 *        走 HTTP → nginx → 插件 → GuardService → PG 全链路，禁止 SQL 直连。
 *
 *   【4】构建产物与 nginx 交付：dist/index.html 的 base 是 /h5/，
 *        assets 可经 nginx 取到且字节与磁盘一致，history 兜底可用。
 *
 *  ── 退出码 ──
 *    0 = 全绿
 *    1 = 有断言失败（真红灯）
 *    2 = 环境未就绪（Docker / 接口不可达，或 h5 依赖没装、esbuild 不可用）
 *
 *  用法：
 *    node scripts/verify-phase3-h5.mjs                 # 全部四组
 *    node scripts/verify-phase3-h5.mjs --offline       # 跳过第【3】组（无 Docker 环境）
 *    node scripts/verify-phase3-h5.mjs --base http://127.0.0.1:8080
 * =============================================================================
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const OFFLINE = argv.includes('--offline');
const BASE = (() => {
  const i = argv.indexOf('--base');
  return (i >= 0 ? argv[i + 1] : null) ?? process.env.SVC_BASE_URL ?? 'http://127.0.0.1:8080';
})();

/** esbuild 的 JS API 入口。Vite 8 用 rolldown，不再带 esbuild，所以默认走隔离工作区那份 */
const ESBUILD_MAIN =
  process.env.SVC_ESBUILD_MODULE ??
  'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/esbuild/lib/main.js';

const H5 = join(ROOT, 'h5');
const PLUGIN_SERVER = join(ROOT, 'nocobase/plugins/service-ticket/src/server');
const TMP = join(ROOT, '.tmp-verify/h5-bundle');

// ------------------------------------------------------------------ 结果记账
let passed = 0;
const failures = [];
const envBlockers = [];

function check(label, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push({ label, message: error?.message ?? String(error) });
    console.log(`  ❌ ${label} — ${error?.message ?? error}`);
  }
}

async function checkAsync(label, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push({ label, message: error?.message ?? String(error) });
    console.log(`  ❌ ${label} — ${error?.message ?? error}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function section(no, title) {
  console.log('');
  console.log(`【${no}】${title}`);
}
function readSource(...parts) {
  const file = join(...parts);
  assert(existsSync(file), `缺少源文件：${file}`);
  return readFileSync(file, 'utf8');
}

// ===========================================================================
// 【1】前后端契约对齐
// ===========================================================================
async function partContract() {
  section('1', '前后端契约对齐（源码级）');

  const feValidate = await import(pathToFileURL(join(TMP, 'utils/validate.js')).href);
  const feUuid = await import(pathToFileURL(join(TMP, 'utils/uuid.js')).href);
  const fePrivacy = await import(pathToFileURL(join(TMP, 'utils/privacy.js')).href);

  const beTicket = readSource(PLUGIN_SERVER, 'actions/public/ticket.ts');
  const beHttp = readSource(PLUGIN_SERVER, 'actions/svc/_http.ts');
  const beConstants = readSource(PLUGIN_SERVER, 'constants.ts');
  const beStores = readSource(PLUGIN_SERVER, 'seeds/stores.ts');

  /** 从后端源码里抽 `const NAME = <number>;` */
  function beNumber(name) {
    const m = beTicket.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)\\s*;`));
    assert(m, `后端 ticket.ts 里找不到 ${name}`);
    return Number(m[1]);
  }
  /** 从后端源码里抽 `const NAME = /regex/;` */
  function beRegex(name, file) {
    const m = file.match(new RegExp(`export const ${name}\\s*=\\s*(/.*?/\\w*)\\s*;`));
    assert(m, `后端源码里找不到 ${name}`);
    // eslint-disable-next-line no-new-func
    return new Function(`return ${m[1]}`)();
  }

  check('值班常量 CONTENT_MIN/CONTENT_MAX 与后端一致', () => {
    const beMin = beNumber('CONTENT_MIN');
    const beMax = beNumber('CONTENT_MAX');
    assert(
      feValidate.CONTENT_MIN === beMin && feValidate.CONTENT_MAX === beMax,
      `前端 ${feValidate.CONTENT_MIN}/${feValidate.CONTENT_MAX} ≠ 后端 ${beMin}/${beMax}`,
    );
    return `${feValidate.CONTENT_MIN}–${feValidate.CONTENT_MAX} 字`;
  });

  check('姓名长度 NAME_MIN/NAME_MAX 与后端一致', () => {
    const beMin = beNumber('NAME_MIN');
    const beMax = beNumber('NAME_MAX');
    assert(
      feValidate.NAME_MIN === beMin && feValidate.NAME_MAX === beMax,
      `前端 ${feValidate.NAME_MIN}/${feValidate.NAME_MAX} ≠ 后端 ${beMin}/${beMax}`,
    );
    return `${feValidate.NAME_MIN}–${feValidate.NAME_MAX} 字`;
  });

  check('手机号正则与后端一致（且不接受非中国大陆号段）', () => {
    const m = beTicket.match(/const\s+MOBILE_PATTERN\s*=\s*(\/.*?\/)\s*;/);
    assert(m, '后端 ticket.ts 里找不到 MOBILE_PATTERN');
    const be = new Function(`return ${m[1]}`)();
    assert(
      feValidate.MOBILE_PATTERN.source === be.source,
      `前端 ${feValidate.MOBILE_PATTERN} ≠ 后端 ${be}`,
    );
    // 反向验证：正则本身得真的能挡住东西，否则"一致"没有意义
    assert(!feValidate.MOBILE_PATTERN.test('12345'), '手机号正则竟然通过 12345');
    assert(
      !feValidate.MOBILE_PATTERN.test('12800000000'),
      '手机号正则竟然通过 12 号段（第二位必须是 3-9）',
    );
    return `${be}`;
  });

  check('门店编码正则与后端 STORE_CODE_PATTERN 一致', () => {
    const be = beRegex('STORE_CODE_PATTERN', beStores);
    assert(
      feValidate.STORE_CODE_PATTERN.source === be.source,
      `前端 ${feValidate.STORE_CODE_PATTERN} ≠ 后端 ${be}`,
    );
    assert(!feValidate.STORE_CODE_PATTERN.test('XX999'), '门店正则竟然通过 XX999');
    return `${be}`;
  });

  check('隐私说明版本号与后端 PRIVACY_NOTICE_VERSION 一致', () => {
    const m = beConstants.match(/export const PRIVACY_NOTICE_VERSION\s*=\s*'([^']+)'/);
    assert(m, '后端 constants.ts 里找不到 PRIVACY_NOTICE_VERSION');
    assert(
      fePrivacy.PRIVACY_NOTICE_VERSION === m[1],
      `前端 '${fePrivacy.PRIVACY_NOTICE_VERSION}' ≠ 后端 '${m[1]}' —— ` +
        '版本号不一致会让 extra_json 里的同意存证指向一份用户没看过的说明（举证失效）',
    );
    return m[1];
  });

  check('请求头名与后端 REQUEST_ID_HEADER 一致', () => {
    const m = beHttp.match(/export const REQUEST_ID_HEADER\s*=\s*'([^']+)'/);
    assert(m, '后端 _http.ts 里找不到 REQUEST_ID_HEADER');
    // 前端在 http.ts 里写死了同名常量；这里直接读源码比对（HTTP 头名大小写不敏感，但两边都该是小写）
    const feHttp = readSource(H5, 'src/api/http.ts');
    const fe = feHttp.match(/export const REQUEST_ID_HEADER\s*=\s*'([^']+)'/);
    assert(fe, '前端 http.ts 里找不到 REQUEST_ID_HEADER');
    assert(fe[1] === m[1], `前端 '${fe[1]}' ≠ 后端 '${m[1]}'`);
    return m[1];
  });

  check('前端生成的请求号能过后端的 UUID v4 校验', () => {
    const m = beHttp.match(/const UUID_V4\s*=\s*(\/.*?\/\w*)\s*;/);
    assert(m, '后端 _http.ts 里找不到 UUID_V4');
    const beRegexObj = new Function(`return ${m[1]}`)();
    assert(
      !beRegexObj.test('not-a-uuid'),
      '后端 UUID 正则竟然通过 not-a-uuid（这条断言本身失去意义）',
    );
    const samples = Array.from({ length: 2000 }, () => feUuid.newRequestId());
    const bad = samples.filter((id) => !beRegexObj.test(id));
    assert(bad.length === 0, `2000 个请求号里有 ${bad.length} 个过不了后端校验，例：${bad[0]}`);
    assert(feUuid.isValidRequestId(samples[0]), '前端自检函数与后端正则不一致');
    return `2000/2000 合规（版本位=4、变体位=8/9/a/b）`;
  });

  check('后端确实要求 UUID v4（缺失即 422）—— 前端生成规则才有意义', () => {
    assert(
      beTicket.includes('readRequestId'),
      'ticket.ts 没有校验 X-Request-Id —— 那前端维护稳定请求号就失去意义了',
    );
    return 'ticket.ts ① 步校验 readRequestId';
  });

  check('前端做了"未勾选不给提交"的门槛（与后端 400 语义对齐）', () => {
    const page = readSource(H5, 'src/pages/Report/index.vue');
    assert(
      page.includes('privacyAgreed'),
      'Report 页没有 privacyAgreed 状态 —— 谁来保证不会发出未勾选的请求？',
    );
    assert(
      page.includes('PRIVACY_NOT_AGREED'),
      'Report 页没有处理后端 400 PRIVACY_NOT_AGREED 的分支',
    );
    return '本地门槛 + 后端 400 分支都在';
  });
}

// ===========================================================================
// 【2】提交器行为（真跑 h5/src/api/public.ts 的构建产物）
// ===========================================================================
async function partSubmitter() {
  section('2', '提交器行为：single-flight / 请求号稳定 / 响应收敛');

  const mod = await import(pathToFileURL(join(TMP, 'api/public.js')).href);

  const DRAFT = {
    store_code: 'S01',
    ticket_type: 'repair',
    content: '冰箱不制冷，压缩机一直响',
    customer_name: '张三',
    customer_mobile: '13800001234',
    source: 'qr',
  };
  const CREATED = {
    ticket_no: 'FW20260920-0001',
    store_name: '圣大家电新都店',
    created_at: '2026-09-20T13:05:59.538Z',
  };

  /** 造一个可控的 fetch：记录每个请求的 URL / 方法 / 请求号 / body */
  function makeFetch(handlers) {
    const calls = [];
    const impl = async (url, init = {}) => {
      const headers = init.headers ?? {};
      const record = {
        url,
        method: init.method ?? 'GET',
        requestId: headers['x-request-id'] ?? headers['X-Request-Id'] ?? null,
        body: init.body ? JSON.parse(init.body) : null,
        privacyAgreed: headers['Content-Type'] ? undefined : undefined,
      };
      calls.push(record);
      const handler = handlers.shift() ?? handlers[handlers.length - 1];
      return handler(record);
    };
    return { impl, calls };
  }

  function jsonResponse(status, payload) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  }

  /** ① 10 连点 → 1 个请求 */
  await checkAsync('连点 10 次只发出 1 个 HTTP 请求（single-flight）', async () => {
    let counter = 0;
    const { impl, calls } = makeFetch([
      async () => {
        counter += 1;
        // 故意加一点延迟：模拟真实网络，制造"请求在途时后续点击到达"的窗口。
        // 没有延迟的话 10 次点击可能各自在微任务里跑完，测不出折叠效果。
        await new Promise((r) => setTimeout(r, 30));
        return jsonResponse(201, { data: CREATED });
      },
    ]);

    const sub = mod.createTicketSubmitter({ fetchImpl: impl });
    const results = await Promise.all(Array.from({ length: 10 }, () => sub.submit(DRAFT)));

    assert(calls.length === 1, `10 次连点发出了 ${calls.length} 个请求，期望 1`);
    assert(counter === 1, `服务端被调用了 ${counter} 次，期望 1`);
    assert(sub.httpCalls === 1, `httpCalls=${sub.httpCalls}，期望 1`);
    const nos = new Set(results.map((r) => r.ticket_no));
    assert(nos.size === 1 && nos.has(CREATED.ticket_no), `返回的单号集合为 ${[...nos].join(',')}`);
    assert(results.length === 10, '10 次调用都要拿到结果（不能有人卡住）');
    // 10 次调用必须共享同一个请求号 —— 否则后端幂等键就被拆成了 10 个
    assert(calls[0].requestId, '请求没有携带 X-Request-Id');
    return `10 次 submit → 1 次 fetch，单号 ${[...nos][0]}`;
  });

  /** ② 内容未变的重试 → 复用同一请求号（回放语义） */
  await checkAsync('失败后重试复用同一 request_id（重试=回放，不是再报一单）', async () => {
    const { impl, calls } = makeFetch([
      async () => {
        throw new TypeError('socket hang up');
      },
      async () => jsonResponse(201, { data: CREATED }),
    ]);

    const sub = mod.createTicketSubmitter({ fetchImpl: impl });
    await sub.submit(DRAFT).then(
      () => assert(false, '第一次应当失败'),
      (err) => assert(err.code === 'NETWORK_ERROR', `期望 NETWORK_ERROR，实际 ${err.code}`),
    );
    const firstId = calls[0].requestId;

    const created = await sub.submit(DRAFT);
    assert(calls.length === 2, `发出了 ${calls.length} 个请求，期望 2`);
    assert(
      calls[1].requestId === firstId,
      `重试换了请求号（${firstId} → ${calls[1].requestId}）—— ` +
        '这会让"响应丢了"的重试变成第二张工单',
    );
    assert(created.ticket_no === CREATED.ticket_no, '重试未拿到单号');
    return `重试沿用 ${firstId}`;
  });

  /** ③ 内容变了 → 新请求号 + 真的再发一次 */
  await checkAsync('内容变化 → 生成新 request_id 且真的再发一次请求', async () => {
    const { impl, calls } = makeFetch([
      async () => jsonResponse(201, { data: CREATED }),
      async () => jsonResponse(201, { data: { ...CREATED, ticket_no: 'FW20260920-0002' } }),
    ]);

    const sub = mod.createTicketSubmitter({ fetchImpl: impl });
    await sub.submit(DRAFT);
    await sub.submit({ ...DRAFT, content: '空调外机不转了，已过保' });

    assert(calls.length === 2, `发出 ${calls.length} 个请求，期望 2`);
    assert(
      calls[0].requestId !== calls[1].requestId,
      '内容变了却复用了同一个请求号 —— 用户改完内容再提交会被后端当成重放，永远建不了单',
    );
    return `新号 ${calls[1].requestId}`;
  });

  /** ④ 同内容且已成功 → 不再发请求 */
  await checkAsync('成功后重复提交同一内容 → 不发新请求', async () => {
    const { impl, calls } = makeFetch([async () => jsonResponse(201, { data: CREATED })]);
    const sub = mod.createTicketSubmitter({ fetchImpl: impl });
    await sub.submit(DRAFT);
    const before = calls.length;
    const again = await sub.submit(DRAFT);
    assert(calls.length === before, `又发了 ${calls.length - before} 个请求，期望 0`);
    assert(again.ticket_no === CREATED.ticket_no, '返回的单号与首次不一致');
    return '0 新增请求';
  });

  /** ⑤ 响应只透出三个字段 */
  await checkAsync('响应被收敛为 {ticket_no, store_name, created_at}（不泄漏 id/处理人）', async () => {
    const { impl } = makeFetch([
      async () =>
        jsonResponse(201, {
          data: {
            ...CREATED,
            // 模拟后端将来误加字段：页面绝不该有机会渲染它们（DEV-PLAN Phase 3-B）
            id: 35,
            handler_user_id: 7,
            customer_mobile: '13800001234',
          },
        }),
    ]);
    const sub = mod.createTicketSubmitter({ fetchImpl: impl });
    const result = await sub.submit(DRAFT);
    const keys = Object.keys(result).sort();
    assert(
      JSON.stringify(keys) === JSON.stringify(['created_at', 'store_name', 'ticket_no']),
      `透出了多余字段：${keys.join(', ')}`,
    );
    return keys.join(', ');
  });

  /** ⑥ 隐私恒定 true，且不可被外部覆盖 */
  await checkAsync('body 里 privacy_agreed 恒为 true，草稿无法把它改掉', async () => {
    const { impl, calls } = makeFetch([async () => jsonResponse(201, { data: CREATED })]);
    const sub = mod.createTicketSubmitter({ fetchImpl: impl });
    await sub.submit({ ...DRAFT, privacy_agreed: false });
    assert(calls[0].body.privacy_agreed === true, 'body 里的 privacy_agreed 不是 true');
    return 'privacy_agreed=true';
  });

  /** ⑦ 白名单：多余字段不进 body */
  await checkAsync('草稿里的白名单外字段不会进入 body（不构成 mass assignment）', async () => {
    const { impl, calls } = makeFetch([async () => jsonResponse(201, { data: CREATED })]);
    const sub = mod.createTicketSubmitter({ fetchImpl: impl });
    await sub.submit({
      ...DRAFT,
      status: 'CLOSED',
      handler_user_id: 7,
      store_id: 1,
      ticket_no: 'HACKED',
    });
    const bodyKeys = Object.keys(calls[0].body).sort();
    const expected = [
      'content',
      'customer_mobile',
      'customer_name',
      'privacy_agreed',
      'source',
      'store_code',
      'ticket_type',
    ];
    assert(
      JSON.stringify(bodyKeys) === JSON.stringify(expected),
      `body 键为 ${bodyKeys.join(', ')}，期望 ${expected.join(', ')}`,
    );
    return bodyKeys.join(', ');
  });

  /** ⑧ source 为空时不发该字段（空串会撞 INVALID_SOURCE） */
  await checkAsync('source 为空时不发送该字段（避免撞后端 INVALID_SOURCE）', async () => {
    const { impl, calls } = makeFetch([async () => jsonResponse(201, { data: CREATED })]);
    const sub = mod.createTicketSubmitter({ fetchImpl: impl });
    await sub.submit({ ...DRAFT, source: '   ' });
    assert(
      !('source' in calls[0].body),
      `source='   ' 被原样发出（${JSON.stringify(calls[0].body.source)}），后端会回 422`,
    );
    return '已省略 source';
  });

  /** ⑨ 错误映射：429 / 409 / 400 的 code 与 detail 必须能透到页面 */
  await checkAsync('429 / 409 / 400 的 code 与 detail 被正确抛出（页面据此分支）', async () => {
    const cases = [
      {
        status: 429,
        payload: {
          errors: [
            {
              code: 'RATE_LIMITED',
              message: '提交过于频繁，请稍后再试',
              detail: { scope: 'ip', window_resets_in_seconds: 42, limit: 30, used: 30 },
            },
          ],
        },
        code: 'RATE_LIMITED',
      },
      {
        status: 409,
        payload: {
          errors: [
            {
              code: 'DUPLICATE_TICKET',
              message: '请勿重复提交',
              detail: { ticket_no: 'FW20260920-0001', created_at: '2026-09-20T13:05:59.538Z' },
            },
          ],
        },
        code: 'DUPLICATE_TICKET',
      },
      {
        status: 400,
        payload: {
          errors: [
            {
              code: 'PRIVACY_NOT_AGREED',
              message: '请先勾选',
              detail: { field: 'privacy_agreed', notice_version: '2026-09-20' },
            },
          ],
        },
        code: 'PRIVACY_NOT_AGREED',
      },
    ];

    for (const item of cases) {
      const { impl } = makeFetch([async () => jsonResponse(item.status, item.payload)]);
      const sub = mod.createTicketSubmitter({ fetchImpl: impl });
      const err = await sub.submit(DRAFT).then(
        () => null,
        (e) => e,
      );
      assert(err, `${item.code}：本该抛出却被当成成功`);
      assert(err.code === item.code, `期望 code=${item.code}，实际 ${err.code}`);
      assert(err.status === item.status, `期望 status=${item.status}，实际 ${err.status}`);
      assert(err.detail && typeof err.detail === 'object', `${item.code}：detail 没透出来`);
    }
    return '3 种错误的 code/status/detail 均可分支';
  });

  /** ⑩ 服务端返回非 JSON（502 HTML 页）不能被当成成功 */
  await checkAsync('网关返回 HTML（非 JSON）时判定为失败，而不是"空成功"', async () => {
    const { impl } = makeFetch([
      async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      }),
    ]);
    const sub = mod.createTicketSubmitter({ fetchImpl: impl });
    const err = await sub.submit(DRAFT).then(
      () => null,
      (e) => e,
    );
    assert(err, '502 HTML 被当成提交成功 —— 用户会以为报上了');
    return `${err.code}（HTTP ${err.status}）`;
  });
}

// ===========================================================================
// 【3】真机端到端：同一 request_id 并发 10 次 → 1 张工单
// ===========================================================================
async function partEndToEnd() {
  section('3', '真机端到端：同 request_id 并发 10 次 → 恰好 1 张工单');

  if (OFFLINE) {
    console.log('  ⏭  已指定 --offline，跳过（这一组是"1 张单"的最终证据，正式验收不要跳）');
    return;
  }

  const health = await fetch(`${BASE}/api/svc:health`).catch(() => null);
  if (!health || !health.ok) {
    envBlockers.push(`${BASE}/api/svc:health 不可达 —— Docker 未启动或接口未就绪`);
    console.log(`  ⏸  接口不可达（${BASE}），本组记为「环境未就绪」`);
    return;
  }

  /** 本轮独立手机号：避免上一轮遗留的手机号日频控/重复单窗口把回归变成假红灯 */
  // 必须凑满 11 位：后端正则是 /^1[3-9]\d{9}$/（第 1 位 1、第 2 位 3-9、再 9 位数字）。
  // 早先这里写成了 2+3+4=9 位，10 路请求整齐地回了 422 INVALID_MOBILE ——
  // 断言确实抓到了问题，但抓的是**验收脚本自己**的问题，不是被测代码。
  // 这类"脚本写错导致红灯"最容易被误读成产品缺陷，所以位数在下面显式断言一次。
  const nonce = String(Date.now()).slice(-3);
  const mobile = `13${nonce}${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
  assert(mobile.length === 11, `生成的手机号 ${mobile} 不是 11 位（验收脚本自身缺陷）`);
  assert(/^1[3-9]\d{9}$/.test(mobile), `生成的手机号 ${mobile} 不合规（验收脚本自身缺陷）`);
  const requestId = crypto.randomUUID();
  const body = {
    store_code: 'S01',
    source: 'qr',
    ticket_type: 'repair',
    // 内容里带 nonce：既避免与历史工单文本相同，也让排障时能一眼认出是哪一轮
    content: `并发连点验收 ${nonce}：冰箱不制冷`,
    customer_name: '并发验收',
    customer_mobile: mobile,
    privacy_agreed: true,
  };

  // 序号基线必须在**发压之前**取：事后再取只能看到结果，判断不了增量。
  // 取不到（docker 不可用）时不在这里拦，留给后面的落库复核统一记"环境未就绪"。
  let seqBefore = null;
  if (dockerAvailable()) {
    try {
      seqBefore = readSequence();
    } catch (error) {
      console.log(`  ⚠️  发压前读序号失败（后续序号断言会记为未就绪）：${error.message}`);
    }
  }

  const calls = await Promise.all(
    Array.from({ length: 10 }, () =>
      fetch(`${BASE}/api/public/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
        body: JSON.stringify(body),
      }).then(async (res) => ({ status: res.status, payload: await res.json().catch(() => null) })),
    ),
  );

  await checkAsync('10 路并发无 5xx（含超时/连接重置）', async () => {
    const bad = calls.filter((c) => c.status >= 500);
    assert(bad.length === 0, `${bad.length} 个 5xx：${bad.map((b) => b.status).join(',')}`);
    const statuses = [...new Set(calls.map((c) => c.status))].sort();
    return `状态码集合 ${statuses.join(',')}`;
  });

  await checkAsync('恰好 1 个 201（真建单）+ 9 个 200（幂等回放），无 429 混入', async () => {
    const created = calls.filter((c) => c.status === 201);
    const replayed = calls.filter((c) => c.status === 200);
    const limited = calls.filter((c) => c.status === 429);
    assert(limited.length === 0, `出现 ${limited.length} 个 429 —— 先确认不是 IP 频控把结论污染了`);
    assert(
      created.length === 1 && replayed.length === 9,
      `201×${created.length} / 200×${replayed.length}，期望 201×1 / 200×9`,
    );
    return `201×1 + 200×9`;
  });

  const ticketNos = new Set(
    calls.map((c) => c.payload?.data?.ticket_no).filter((v) => typeof v === 'string'),
  );

  await checkAsync('10 次响应拿到的是**同一个** ticket_no', async () => {
    assert(ticketNos.size === 1, `出现了 ${ticketNos.size} 个不同单号：${[...ticketNos].join(', ')}`);
    return [...ticketNos][0];
  });

  await checkAsync('响应体恰好三个字段（不含 id / 处理人 / 手机号）', async () => {
    const data = calls.find((c) => c.payload?.data)?.payload.data;
    assert(data, '没有任何响应带 data');
    const keys = Object.keys(data).sort();
    assert(
      JSON.stringify(keys) === JSON.stringify(['created_at', 'store_name', 'ticket_no']),
      `实际字段 ${keys.join(', ')}`,
    );
    assert(!('id' in data) && !('handler_user_id' in data), '响应里出现了 id 或处理人');
    return keys.join(', ');
  });

  // ---- 落库复核（只读 SQL，仅用于**交叉验证 HTTP 路径已给出的结论**）----
  //
  // ⚠️ 这里用 SQL 与 Phase 2 挂起项里被明令禁止的"SQL 直连取号"是**两件事**：
  //    · 被禁止的是"用 SQL 调取号器去**替代**真实并发压测"——那是拿 PG 的行锁
  //      冒充"我们的 GuardService/TicketService 串起来是对的"。
  //    · 这里是相反的用法：结论**已经**由上面 10 路真实 HTTP 得出，
  //      SQL 只用来回答一个 HTTP 响应**无法**回答的问题——
  //      "并发路径上有没有偷偷多插一行，然后靠唯一索引冲突回滚成回放"。
  //      这种失败在响应层看起来与正常回放**完全一样**（仍是一个 201 + 九个 200），
  //      只有查库才能发现。所以这一步不是多余的，也不能被响应层断言替代。
  if (!dockerAvailable()) {
    envBlockers.push('docker 不可用，无法做落库交叉复核（10 路 HTTP 已通过，但"多插一行"无法排除）');
    console.log('  ⏸  docker 不可用，跳过落库交叉复核');
    return;
  }

  await checkAsync('库中该单号恰好 1 条、该手机号恰好 1 条（排除"并发多插一行再回放"）', async () => {
    const ticketNo = [...ticketNos][0];
    assert(ticketNo, '拿不到单号，无法复核');
    const byNo = psqlScalar(
      `select count(*) from service_tickets where ticket_no = '${escapeSql(ticketNo)}'`,
    );
    assert(byNo === '1', `按单号查到 ${byNo} 条，期望 1`);
    const byMobile = psqlScalar(
      `select count(*) from service_tickets where customer_mobile = '${escapeSql(mobile)}'`,
    );
    assert(byMobile === '1', `按手机号查到 ${byMobile} 条，期望 1`);
    return `${ticketNo} 各 1 条`;
  });

  if (!seqBefore) {
    envBlockers.push('发压前未能读到序号基线，序号增量断言无法判定');
  } else {
    await checkAsync('序号增量恰好 1（10 路并发只取一个号）', async () => {
      const after = readSequence();
      assert(after.key === seqBefore.key, `序号 key 变了（${seqBefore.key} → ${after.key}）`);
      const delta = Number(after.value) - Number(seqBefore.value);
      assert(
        delta === 1,
        `序号从 ${seqBefore.value} 变成 ${after.value}（增量 ${delta}），期望恰好 +1 —— ` +
          '增量 >1 说明有请求绕过了幂等各取各号（工单号会出现空洞）',
      );
      return `${seqBefore.key}: ${seqBefore.value} → ${after.value}`;
    });
  }

  await checkAsync('幂等记录恰好 1 条（10 路并发只写一条）', async () => {
    const count = psqlScalar(
      `select count(*) from idempotency_records ` +
        `where scene = 'public_ticket' and idempotency_key = '${escapeSql(requestId)}'`,
    );
    assert(count === '1', `idempotency_records 查到 ${count} 条，期望 1`);
    return `1 条（key=${requestId.slice(0, 8)}…）`;
  });

  await checkAsync('工单事件恰好 1 条 created（没有产生多余的事件行）', async () => {
    const ticketNo = [...ticketNos][0];
    // 列名是 event_type 而不是 action（本插件表为 snake_case，DEV-14）；
    // 直接按 metadata_json 里的 request_id 反查，能同时证明"事件挂对了工单"。
    const count = psqlScalar(
      `select count(*) from ticket_events e ` +
        `join service_tickets t on t.id = e.ticket_id ` +
        `where t.ticket_no = '${escapeSql(ticketNo)}' ` +
        `and e.event_type = 'created' ` +
        `and e.metadata_json->>'request_id' = '${escapeSql(requestId)}'`,
    );
    assert(count === '1', `ticket_events 查到 ${count} 条 created，期望 1`);
    return '1 条 created（且 metadata 里的 request_id 一致）';
  });
}

// ------------------------------------------------------------------ docker / SQL 辅助
/** 执行 docker 命令并返回 stdout */
function docker(args, opts = {}) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      timeout: opts.timeout ?? 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString().trim();
    throw new Error(`docker ${args.join(' ')} 失败：${msg.split('\n')[0] || '未知错误'}`);
  }
}

function dockerAvailable() {
  try {
    docker(['version', '--format', '{{.Server.Version}}'], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/** 从 .env 读一个值（不存在则用默认值） */
function envValue(key, fallback) {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return fallback;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, '');
  }
  return fallback;
}

const psql = (sql) =>
  docker(
    [
      'exec',
      'svc-postgres',
      'psql',
      '-U',
      envValue('POSTGRES_USER', 'svc_app'),
      '-d',
      envValue('POSTGRES_DB', 'service_ticket'),
      '-t',
      '-A',
      '-c',
      sql,
    ],
    { timeout: 30000 },
  ).trim();

/** 取单个标量（只取首行：psql 还会打印命令标签，整串 Number() 会得到 NaN） */
const psqlScalar = (sql) => psql(sql).split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? '';

/** 极小心的 SQL 字面量转义（本脚本只用于把自家的单号/手机号拼进 where） */
const escapeSql = (value) => String(value).replace(/'/g, "''");

/**
 * 读当前"最新一条"序号行。
 * 不按当天日期拼 seq_key，是为了避开"+08 与 UTC 跨零点"这种与验收无关的坑 ——
 * 我们关心的是**同一行的值有没有恰好 +1**，而不是这一行属于哪一天。
 */
function readSequence() {
  const line = psqlScalar(
    `select seq_key || '=' || current_value from daily_sequences order by id desc limit 1`,
  );
  const [key, value] = line.split('=');
  assert(key && value, `读序号失败，psql 返回：${JSON.stringify(line)}`);
  return { key, value };
}

// ===========================================================================
// 【4】构建产物与 nginx 交付
// ===========================================================================
async function partArtifacts() {
  section('4', '构建产物与 nginx 交付');

  const distDir = join(H5, 'dist');
  const indexHtml = join(distDir, 'index.html');

  check('h5/dist 存在且含 index.html（部署前必须先 npm run build）', () => {
    assert(existsSync(distDir), `缺少 ${distDir} —— 运行：cd h5 && npm run build`);
    assert(
      existsSync(indexHtml),
      '缺少 h5/dist/index.html —— 未构建就部署会得到"引用缺失 JS 的白屏首页"',
    );
    return `${statSync(indexHtml).size} bytes`;
  });

  check('dist/.gitkeep 存在（保证未构建的仓库里挂载点不缺失）', () => {
    // 这个文件由 h5/public/.gitkeep 在每次构建时被 Vite 复制进 dist。
    // 它不在 dist/ 里维护，是因为 emptyOutDir 会清空 dist。
    assert(
      existsSync(join(distDir, '.gitkeep')),
      '.gitkeep 不在 dist 里 —— 它在 h5/public/ 吗？',
    );
    assert(
      existsSync(join(H5, 'public', '.gitkeep')),
      'h5/public/.gitkeep 缺失 —— 下一次构建后挂载点又会消失',
    );
    return 'dist/.gitkeep ← h5/public/.gitkeep';
  });

  const html = readFileSync(indexHtml, 'utf8');

  check('index.html 的资源引用带 /h5/ 前缀（与 nginx 的挂载路径一致）', () => {
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    const assets = refs.filter((r) => r.includes('assets/'));
    assert(assets.length > 0, `index.html 里没有 assets 引用：${refs.join(',')}`);
    const bad = assets.filter((r) => !r.startsWith('/h5/'));
    assert(
      bad.length === 0,
      `引用没有 /h5/ 前缀：${bad.join(',')} —— ` +
        '这些请求会落到 location / 被反代给 NocoBase，表现为"页面能开、JS 全 404"',
    );
    return assets.join(', ');
  });

  check('assets 目录含 js 与 css，且文件名带内容哈希', () => {
    const assetsDir = join(distDir, 'assets');
    assert(existsSync(assetsDir), '缺少 dist/assets');
    const files = readdirSync(assetsDir);
    const js = files.filter((f) => f.endsWith('.js'));
    const css = files.filter((f) => f.endsWith('.css'));
    assert(js.length === 1 && css.length === 1, `assets 内容为 ${files.join(', ')}`);
    assert(
      /-[A-Za-z0-9_-]{8,}\./.test(js[0]) && /-[A-Za-z0-9_-]{8,}\./.test(css[0]),
      `文件名没有内容哈希（${js[0]} / ${css[0]}）—— 那样长缓存会发不出新版本`,
    );
    return `${js[0]} / ${css[0]}`;
  });

  if (OFFLINE) {
    console.log('  ⏭  已指定 --offline，跳过经 nginx 的交付复核');
    return;
  }

  const ok = await fetch(`${BASE}/api/svc:health`)
    .then((r) => r.ok)
    .catch(() => false);
  if (!ok) {
    envBlockers.push(`${BASE} 不可达，跳过经 nginx 的 H5 交付复核`);
    console.log('  ⏸  接口/静态站不可达，跳过经 nginx 的交付复核');
    return;
  }

  await checkAsync('GET /h5/report 返回 200 且是 HTML（nginx 挂载生效）', async () => {
    const res = await fetch(`${BASE}/h5/report?store=S03&source=qr`);
    assert(res.status === 200, `状态码 ${res.status}`);
    assert(
      (res.headers.get('content-type') ?? '').includes('text/html'),
      `Content-Type=${res.headers.get('content-type')}`,
    );
    const text = await res.text();
    assert(text.includes('/h5/assets/'), '返回的 HTML 里没有 /h5/assets/ 引用');
    return '200 text/html';
  });

  await checkAsync('GET /h5/report/success 命中 SPA history 兜底（深链刷新不 404）', async () => {
    const res = await fetch(`${BASE}/h5/report/success?no=FW20260920-0001`);
    assert(res.status === 200, `状态码 ${res.status} —— 深链刷新会白屏`);
    return '200（try_files → /h5/index.html）';
  });

  await checkAsync('/h5/assets/<hash>.js 与 <hash>.css 可取得，且字节与磁盘一致', async () => {
    const assetsDir = join(distDir, 'assets');
    const files = readdirSync(assetsDir);
    for (const name of files) {
      const local = readFileSync(join(assetsDir, name));
      const res = await fetch(`${BASE}/h5/assets/${name}`);
      assert(res.status === 200, `${name} 状态码 ${res.status}（DEV-29：正则 location + alias 会 301）`);
      const remote = Buffer.from(await res.arrayBuffer());
      const same =
        createHash('sha256').update(local).digest('hex') ===
        createHash('sha256').update(remote).digest('hex');
      assert(same, `${name} 字节不一致（本地 ${local.length} / 远端 ${remote.length}）`);
    }
    return `${files.length} 个文件逐一哈希一致`;
  });

  await checkAsync('/h5/assets 带长缓存头（Vite 产物带 hash，可 immutable）', async () => {
    const name = readdirSync(join(distDir, 'assets')).find((f) => f.endsWith('.js'));
    const res = await fetch(`${BASE}/h5/assets/${name}`, { method: 'HEAD' });
    const cc = res.headers.get('cache-control') ?? '';
    assert(/immutable/.test(cc), `Cache-Control=${cc}，期望含 immutable`);
    return cc;
  });
}

// ===========================================================================
// 主流程
// ===========================================================================
async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  Phase 3-H 验收：/report 客户报修页（Vue3 + Vite）');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  仓库根目录 : ${ROOT}`);
  console.log(`  目标地址   : ${OFFLINE ? '(offline，跳过真机组)' : BASE}`);
  console.log('');

  // ---- 打包前端模块（第【1】【2】组都要用真实构建产物，而不是读源码猜行为）----
  mkdirSync(TMP, { recursive: true });
  if (!existsSync(ESBUILD_MAIN)) {
    envBlockers.push(`esbuild 不可用：${ESBUILD_MAIN}`);
  } else {
    try {
      const esbuild = (await import(pathToFileURL(ESBUILD_MAIN).href)).default;
      await esbuild.build({
        entryPoints: [
          join(H5, 'src/api/public.ts'),
          join(H5, 'src/utils/uuid.ts'),
          join(H5, 'src/utils/validate.ts'),
          join(H5, 'src/utils/privacy.ts'),
        ],
        outdir: TMP,
        bundle: true,
        format: 'esm',
        platform: 'neutral',
        target: 'es2022',
        logLevel: 'silent',
      });
      console.log(`  [准备] 已用 esbuild 打包 4 个前端模块 → ${TMP}`);
    } catch (error) {
      envBlockers.push(`esbuild 打包失败：${error?.message ?? error}`);
    }
  }

  if (envBlockers.length === 0) {
    await partContract();
    await partSubmitter();
    await partEndToEnd();
    await partArtifacts();
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');

  if (envBlockers.length > 0) {
    console.log('  ⏸  环境未就绪（退出码 2）—— 这不是"验收失败"，但也**不能**据此补签 PASS');
    for (const item of envBlockers) console.log(`     · ${item}`);
    console.log('══════════════════════════════════════════════════════════════');
    process.exit(2);
  }

  if (failures.length > 0) {
    console.log(`  ❌ 断言失败 ${failures.length} 项 / 通过 ${passed} 项（退出码 1）`);
    for (const f of failures) console.log(`     · ${f.label}\n       ${f.message}`);
    console.log('══════════════════════════════════════════════════════════════');
    process.exit(1);
  }

  console.log(`  ✅ 全部通过：${passed} 项`);
  console.log('══════════════════════════════════════════════════════════════');
  process.exit(0);
}

main().catch((error) => {
  console.error('');
  console.error('  脚本自身异常：', error);
  process.exit(1);
});
