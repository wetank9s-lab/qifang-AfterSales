/**
 * store-entry —— 门店**专属报修入口**的签名与解析（Phase 11 / P11-1）
 * =============================================================================
 *
 * 用户 2026-10-10 的产品决定：15 家门店各自独立运营、各自拥有稳定的报修链接与二维码。
 * 其中最关键的一条安全要求（req 2）：
 *
 * > 新入口使用**经服务端验证**的门店专属标识**或签名**。不得仅依赖可随意改写的
 * > `store=S01` 参数、请求 body、隐藏字段、Referer 或前端本地状态确定门店归属。
 *
 * ⇒ 本文件实现**带 HMAC 签名**的入口标识。这是"签名"而不是"标识"的理由：
 *    · 纯标识（如 `S01`）可以被**任意改写**成 `S02` —— 那正是要把关掉的东西；
 *    · 签名标识把门店编码**绑在签名里**：改一个字符，签名就对不上 ⇒ 服务端拒绝。
 *
 * -----------------------------------------------------------------------------
 * 两种来源，**诚实区分**（req 5）
 * -----------------------------------------------------------------------------
 * | 形态 | 例子 | 服务端动作 | provenance |
 * |---|---|---|---|
 * | **签名入口**（新） | `?k=S01.Mf3k…` | 校验 HMAC | `signed` |
 * | **旧参数入口**（旧二维码） | `?store=S01` → 转成 `k=S01` | **无签名可验**，仅按启用状态校验 | `legacy` |
 *
 * ⚠️ **旧入口的诚实声明**：`legacy` 形态**只有"门店编码是合法的、门店是启用的"这层保证**，
 *    没有任何防篡改能力 —— 任何人把 URL 里的 `S01` 改成 `S02` 都能拿到 S02 的入口。
 *    这不是可以掩盖的细节，因此：
 *      · 它作为 `provenance` **随建单事件落库**
 *        （`ticket_events.metadata_json.entry_provenance`，`created` 那一条 ——
 *          **不是** `service_tickets.extra_json`，那里装的是隐私同意证据），
 *        事后可审计；
 *      · 页面与文档都**不得**把它宣称为与新入口同等安全。
 *
 * ⚠️ **坏签名不回落成 legacy**：`S01.坏签名` 一律**拒绝**。
 *    若允许回落，篡改者只要把 `.` 后面的部分删掉就绕过了签名 —— 那签名等于没有。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** 入口来源（随工单落库，用于事后审计"这单是从哪种入口进来的"） */
export const STORE_ENTRY_PROVENANCE = {
  /** 新入口：HMAC 签名，篡改会被拒绝 */
  SIGNED: 'signed',
  /** 旧入口：只有门店编码，**无防篡改保证**（旧二维码兼容用） */
  LEGACY: 'legacy',
} as const;
export type StoreEntryProvenance =
  (typeof STORE_ENTRY_PROVENANCE)[keyof typeof STORE_ENTRY_PROVENANCE];

/** 签名与编码之间用 `.` 分隔（`. ` 不在门店编码字符集里，不会歧义） */
const SEPARATOR = '.';
/** 门店编码的合法形态（与 `constants.STORE_CODE_PATTERN` 同口径：S + 两位数字，预留更长） */
const STORE_CODE_RE = /^[A-Za-z0-9_-]{1,16}$/;
/** 签名长度（base64url 截断；22 字符 ≈ 132 bit，远超"防篡改"所需） */
const SIGNATURE_LENGTH = 22;

export type StoreEntryResolution =
  | { ok: true; code: string; provenance: StoreEntryProvenance }
  | { ok: false; error: 'MISSING_STORE_ENTRY' | 'INVALID_STORE_ENTRY' | 'ENTRY_NOT_CONFIGURED' };

/** 入口签名（服务端**唯一**的签名实现；客户端/文档都不得各写一份） */
function signatureOf(code: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`store-entry:${code}`)
    .digest('base64url')
    .slice(0, SIGNATURE_LENGTH);
}

/**
 * 生成门店的**签名入口标识**（后台"复制链接/下载二维码"用它）。
 *
 * ⚠️ **稳定**：同一 `(门店编码, SIGN_SECRET)` 永远产出同一个串 ⇒
 *    已经印出去的二维码不会因为重启/重新生成而失效。
 * ⚠️ **密钥轮换会让旧链接全部失效** —— 这是签名的固有代价，属于运维决策，
 *    因此 `SIGN_SECRET` 的存在性由启动断言守住（见 `assertEntrySecret`）。
 */
export function signStoreEntry(code: string, secret: string): string {
  const normalized = String(code ?? '').trim();
  if (!STORE_CODE_RE.test(normalized)) {
    throw new Error(`[store-entry] 门店编码不合法：${JSON.stringify(code)}`);
  }
  return `${normalized}${SEPARATOR}${signatureOf(normalized, secret)}`;
}

/** 校验签名入口。**坏签名返回 null**（不抛错 —— 调用方按"入口无效"处理）。 */
export function verifyStoreEntry(
  token: unknown,
  secret: string,
): { code: string; provenance: typeof STORE_ENTRY_PROVENANCE.SIGNED } | null {
  const raw = String(token ?? '').trim();
  const at = raw.indexOf(SEPARATOR);
  if (at <= 0 || at === raw.length - 1) return null;
  const code = raw.slice(0, at);
  const given = raw.slice(at + 1);
  if (!STORE_CODE_RE.test(code) || given.length !== SIGNATURE_LENGTH) return null;
  if (!secret) return null; // 密钥缺失 ⇒ 无法验证 ⇒ fail-closed（不放行任何签名）

  const expected = signatureOf(code, secret);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  // 定时安全比较：避免"逐字符不同则耗时不同"把签名变成可爆破的密码
  if (!timingSafeEqual(a, b)) return null;
  return { code, provenance: STORE_ENTRY_PROVENANCE.SIGNED };
}

/**
 * 把"请求里带来的入口值"解析成门店编码 + 来源。
 *
 * 判定顺序（**顺序本身就是规则**）：
 *   ① 空值            ⇒ `MISSING_STORE_ENTRY`（不再有"只看 body 就能建单"这条路）
 *   ② 含 `.`          ⇒ 走**签名校验**；过了是 `signed`，没过是 `INVALID_STORE_ENTRY`
 *   ③ 不含 `.` 且形态合法 ⇒ `legacy`（旧二维码；**无防篡改保证**，如实标注）
 *
 * ⚠️ 明文写在这里，是为了让"旧入口被接受"这件事**一眼可见**，
 *    而不是藏在一个 `??` 兜底里（那种写法会让下一个人以为所有入口都是签名的）。
 */
export function resolveStoreEntry(raw: unknown, secret: string): StoreEntryResolution {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: 'MISSING_STORE_ENTRY' };

  if (text.includes(SEPARATOR)) {
    const verified = verifyStoreEntry(text, secret);
    return verified
      ? { ok: true, code: verified.code, provenance: verified.provenance }
      : { ok: false, error: 'INVALID_STORE_ENTRY' };
  }

  if (!STORE_CODE_RE.test(text)) return { ok: false, error: 'INVALID_STORE_ENTRY' };
  // 旧入口：形态合法即接受。**它的安全性只有"门店启用"这一层**（见文件头）。
  return { ok: true, code: text, provenance: STORE_ENTRY_PROVENANCE.LEGACY };
}

/**
 * 读取进程内的**入口签名密钥**（`SIGN_SECRET`）—— **唯一**的读取点。
 *
 * ⚠️ 为什么要有这个函数而不是各处写 `process.env.SIGN_SECRET`：
 *    本仓库已经因为"同一个常量/同一段解析逻辑出现两份"付过多次代价
 *    （见 `src/shared/svc-action.ts` 文件头、`docs/ENGINEERING-RULES.md` 铁律 ④）。
 *    签名密钥的读取口径一旦分裂（一处 trim、一处不 trim），
 *    表现是**只在部分链路**出现的"签名忽然验不过"—— 极难定位。
 *    因此：产出侧（`svc:storeEntryLinks`）与校验侧（建单 / 解析）都必须从这里取。
 *
 * ⚠️ 返回值可能是空串（未配置）。调用方**必须**按 fail-closed 处理：
 *    空密钥下**既不能签发也不能校验**（`verifyStoreEntry` 遇空密钥直接返回 null）。
 *    绝不降级成"用空 key 签 / 用空 key 验"—— 那等于人人可伪造门店归属。
 */
export function signingSecretOf(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.SIGN_SECRET ?? '').trim();
}

/**
 * ⚠️ 关于"旧入口无签名"这件事为什么**不**做成可配置开关：
 *    做成开关意味着"某天有人把它打开"就会被当成正常操作，
 *    而它的后果是"15 家门店的报修归属可以被任意改写"。
 *    旧入口之所以被接受，只因为它**已经印出去了**（req 5）——
 *    这是一个既成事实的兼容，不是一个特性。
 */

/**
 * 启动期**需要**配 `SIGN_SECRET` —— 但本文件**刻意不再单独写一个断言**。
 *
 * 原因（`docs/ENGINEERING-RULES.md` 铁律 ④：同一段逻辑出现两次 = 同一个坑有两条腿）：
 *   `profile.ts` 的 `collectProductionViolations()` ④ `SIGN_SECRET_MISSING`
 *   已经在 production 档拒绝启动，且它排在**所有 IO 之前**。
 *   再写一个"只判 SIGN_SECRET 非空"的断言，就是同一个判据的第二份实现：
 *   两份一旦分叉（比如一处加了长度要求），表现是"启动时通过、签链接时才炸"。
 *
 * ⇒ 因此密钥缺失的守卫只有**两处**，且职责不重叠：
 *   · **启动期**：`profile.ts` ④（production 拒绝启动）；
 *   · **运行期**：`signingSecretOf()` 返回空串时，产出侧回 503
 *     （`actions/svc/store-entry.ts` 的 `ENTRY_SECRET_MISSING`），
 *     校验侧 `verifyStoreEntry` 遇空密钥一律返回 null —— **两侧都 fail-closed**。
 */
