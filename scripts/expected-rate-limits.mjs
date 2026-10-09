/**
 * nginx 限流值的**单一事实来源**
 *
 * 为什么需要这个文件（Phase 10 · §6 #2）：
 *   `rate=30r/m` 是**对客承诺**，写在 docs/SECURITY.md 里，但在此之前
 *   **没有任何断言钉住它** —— `verify-config.mjs` 只断言：
 *     · 「limit_req 引用的 zone 已定义」（:465，只管存在，不管多少）
 *     · 「limit_req_status 429」（:557，只管状态码）
 *     · 「规格文档不许复写 rate/burst 数值」（:1184，只管文档，不管配置）
 *   三条都与"值是多少"无关 ⇒ **顺手把 30r/m 放宽成 300r/m 再提交，门禁全绿**。
 *   这类改动没有任何报错、没有任何日志，只有"对客承诺被单方面改掉"这一个后果。
 *
 *   所以限流值必须能被断言，而不是靠人记得 —— 改本文件 = 发起一次安全口径变更。
 *
 * ⚠️ 改本文件 = 发起一次限流口径变更，必须同时：
 *   ① 说明是谁、为什么批准放宽/收紧（对客承诺的变更要能被追溯）；
 *   ② 同步 nginx/nginx.conf（rate）与 nginx/conf.d/service.conf（burst）；
 *   ③ 重跑 verify-config.mjs（正向）+ 反向注入（证明新值真被钉住）。
 *
 * ⚠️ 关于 burst 的一个历史误记（2026-10-04 实测订正）：
 *   nginx.conf 里曾有一段注释称「burst 做成环境变量而不是写死」，
 *   并称「默认值保持 10」。这两句**都与事实不符**：
 *     · burst 是 service.conf 各 location 里的**硬编码字面量**；
 *     · nginx/ 目录下 `grep -rnE '\$\{[A-Z_]+\}'` **零命中** ⇒ 没有任何模板机制；
 *     · 三个 zone 的 burst 实际是 10 / 20 / 60，只有 svc_public 恰好是 10。
 *   注释已被改写。保留这段说明，是为了防止有人照着旧注释去"找环境变量"。
 */

/**
 * 冻结的限流口径。
 *
 * rate  —— 定义在 `nginx/nginx.conf` 的 `limit_req_zone`（长期速率，对客承诺）
 * burst —— 定义在 `nginx/conf.d/service.conf` 的各 `limit_req`（突发容量，运维旋钮）
 *
 * 两者分处两个文件，所以必须**成对**钉住：只钉 rate 的话，
 * 把 burst 从 10 改成 1000 依然无人发现（30r/m 配 burst=1000 ≈ 速率限制被架空）。
 */
export const RATE_LIMIT_ZONES = {
  svc_public: {
    rate: '30r/m',
    burst: 10,
    purpose: '匿名客户接口（提单 / 查门店 / 评价）—— 对客承诺 30 次/分钟',
  },
  svc_upload: {
    rate: '60r/m',
    burst: 20,
    purpose: '师傅端接口（含照片上传）',
  },
  svc_general: {
    rate: '600r/m',
    burst: 400,
    purpose:
      '其余 /api 请求。**含后台 SPA 的 schema 加载**（一次页面渲染会发几十~几百个 ' +
      'flowModels:findOne）—— burst=60 时真实浏览器打开后台会 429（2026-10-09 P11-0 实测）。',
  },
  svc_static: {
    rate: '1200r/m',
    burst: 400,
    purpose:
      '静态资源（插件 bundle 等）。**单独一档**：一次后台 SPA 加载会并发拉几十个 ' +
      '客户端 bundle，复用 svc_general 会当场 503 把 SPA 打挂（2026-10-09 P11-0 实测）。',
  },
};

/** 冻结日期与依据，写在断言输出里，方便一眼看出这条 pin 是什么时候定的 */
export const RATE_LIMIT_PINNED_AT = '2026-10-04';

/**
 * 各 zone 的 burst 在 service.conf 里**每个 location 各写一次**。
 * 同一 zone 的所有出现必须一致 —— 否则"限流值"取决于落在哪个 location，
 * 而"钉住的值"就变成了一句空话。
 */
export const ZONE_NAMES = Object.keys(RATE_LIMIT_ZONES);
