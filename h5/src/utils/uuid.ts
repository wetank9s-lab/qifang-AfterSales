/**
 * 请求号生成。
 *
 * 后端校验的正则（`actions/svc/_http.ts` 的 UUID_V4）：
 *   /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
 * 也就是**必须是 RFC 4122 的 version 4**：第 13 位十六进制是 `4`、
 * 第 17 位是 8/9/a/b。随手拼一个 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` 全随机串
 * 有 15/16 的概率被拒成 422（"写接口必须携带 x-request-id（UUID v4）"），
 * 而且这种失败在真机上极难定位 —— 因为它取决于运气。
 *
 * 优先用平台的 crypto.randomUUID()（浏览器/Node 都已支持，且是 CSPRNG）；
 * 退化实现也**必须**按 v4 的位规则来拼，不能图省事全随机。
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fallbackRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }
  // 最后的兜底（老 WebView 且无 crypto）。仅用于生成幂等键，
  // 不承担任何安全职责 —— 它不参与签名/加密，只要求"碰撞概率足够低"。
  for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

export function newRequestId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();

  const bytes = fallbackRandomBytes(16);
  // version 4
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // variant 10xx
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < 16; i += 1) hex.push(bytes[i].toString(16).padStart(2, '0'));
  return (
    `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-` +
    `${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
  );
}

/**
 * 自检：生成的号必须能过后端那条正则。
 * 生产路径不会调用它（每次提交多跑一次正则不值当），
 * 但验收脚本会用它把"号合不合规"变成一条断言，而不是等真机 422 才发现。
 */
export function isValidRequestId(value: string): boolean {
  return UUID_V4.test(value);
}
