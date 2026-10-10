/**
 * public-url —— **对外地址**的唯一来源（Phase 11 / P11-1）
 * =============================================================================
 *
 * 为什么要有这个文件（用户 req 7 点名）：
 *
 * > Nginx 对外路径、H5 路由、服务端解析逻辑保持一致；**复制和二维码内容必须
 * > 使用实际对外地址，不得含 localhost、内部端口或后台管理地址**。
 *
 * 在它之前，"对外地址"这件事在本仓库里有**两份**实现：
 *   · `TokenService.baseUrl()`（师傅作业链接）；
 *   · 以及各处 `PUBLIC_BASE_URL` 的直接读取。
 * 两份实现一旦漂移，就会出现"师傅链接是域名、门店二维码是 localhost"这种
 * **只在一部分功能上显形**的错 —— 而二维码是**印出来贴在墙上的**，
 * 错了要重新印，代价与"页面显示错"完全不是一个量级。
 * ⇒ 收敛成本文件，两处都用它。
 *
 * ⚠️ 与"后端内部地址"严格区分：`PUBLIC_BASE_URL` 在本机是
 *    `http://localhost:8080`（**nginx 的明文端口**），那**不是**可以印进二维码的地址。
 *    因此这里优先读 `PUBLIC_H5_BASE_URL`（对外站点基址），缺失时才退回
 *    `PUBLIC_BASE_URL`，并在**生产档**下断言它不是一个"打不开/内网"的地址。
 */

/** 去掉尾部斜杠；空值返回 `''` */
function normalize(value: unknown): string {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

/**
 * 对外站点基址（用于拼接**给客户**的链接：门店报修入口、师傅作业页、评价页）。
 *
 * 读取顺序：`PUBLIC_H5_BASE_URL` → `PUBLIC_BASE_URL` → `''`。
 * ⚠️ 返回空串时调用方**不能**拼出相对链接就当成功：那会产出
 *    `/h5/report?k=…` 这种"贴到二维码里扫出来没有域名"的链接。
 */
export function publicBaseUrlOf(env: NodeJS.ProcessEnv = process.env): string {
  return normalize(env.PUBLIC_H5_BASE_URL) || normalize(env.PUBLIC_BASE_URL);
}

/** 判断一个地址是否"不适合印在二维码/对外链接里"（localhost / 内网 / 非标准端口） */
export function isNonPublicBase(url: string): boolean {
  const text = normalize(url);
  if (!text) return true; // 空 = 拼不出对外链接，同样算不可用
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return true;
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local') ||
    // 内网段（IPv4 私有 + 链路本地）
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return true;
  }
  const port = parsed.port;
  // 只允许"缺省端口（走 scheme 默认）"或标准 80/443 —— 其余都是内部端口
  if (port && port !== '80' && port !== '443') return true;
  return false;
}

/**
 * 生产档启动断言：**不允许**把 localhost / 内部端口印进二维码。
 *
 * ⚠️ 为什么是"拒绝启动"而不是"发链接时再检查"：
 *    链接一旦被复制/下载成二维码，就已经**离开系统**了；
 *    运行期再报错只能拦住后面的，拦不住已经印出去的。
 *    生产档必须在一开始就没有这个可能。
 *
 * ⚠️ 与 `profile.ts` ⑤ `PUBLIC_BASE_URL_NOT_PRODUCTION` 的关系（**不是重复**）：
 *    · `profile.ts` ⑤ 只看 `PUBLIC_BASE_URL`，判据是 https + 不含 localhost；
 *    · 本函数看的是 `publicBaseUrlOf()`（即 `PUBLIC_H5_BASE_URL` **优先**，
 *      回退 `PUBLIC_BASE_URL`），判据更严：额外拒绝**内网 IP 段**与**非 80/443 端口**。
 *    ⇒ 覆盖的是 profile ⑤ 看不到的两类错：
 *      ① 只配了 `PUBLIC_H5_BASE_URL` 而它写成 `http://192.168.x.x:8080`
 *         （profile ⑤ 检查的 `PUBLIC_BASE_URL` 完全正常，于是**静默漏过**）；
 *      ② 把 nginx 的**内部明文端口**当成对外地址。
 *    两条判据的**输入不同**（变量不同、提取函数不同），因此各自保留是合理的；
 *    若将来 `PUBLIC_H5_BASE_URL` 被废弃、两者输入合一，则本函数应删除而不是并存。
 */
export function assertPublicBaseForProduction(
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (profile !== 'production') return;
  const base = publicBaseUrlOf(env);
  if (isNonPublicBase(base)) {
    throw new Error(
      `[public-url] production 档的对外站点基址不可用：${JSON.stringify(base || '(空)')}。` +
        '门店报修二维码是**印出来贴出去**的，用 localhost / 内网 / 内部端口拼出来的链接' +
        '扫不开、且无法事后召回。请配置 PUBLIC_H5_BASE_URL 为真实对外域名（https + 默认端口）。',
    );
  }
}
