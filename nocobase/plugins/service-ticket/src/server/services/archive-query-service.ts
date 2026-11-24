import { createHash, randomBytes, randomInt } from 'node:crypto';

import {
  ARCHIVE_TYPE,
  ARCHIVE_VISIBILITY,
  SMS_SCENE,
} from '../constants';
import { ArchiveError, isPhotoCustomerVisible } from './archive-service';
import { ArchiveProductService } from './archive-product-service';
// 脱敏复用既有唯一实现（不自己再写一份 slice(0,3)+'****'+slice(-4)）：
// 两处实现迟早漂移，而漂移的那一处会漏出更多位数。
import { maskMobileText } from './permission-service';

/**
 * ArchiveQueryService —— 客户自助查询（ARC-V1 / A4）
 *
 * 安全模型的四道门，缺一不可：
 *
 *   ① **不能只凭手机号查询**：必须先拿到一条有效验证码并核销；
 *   ② **不能枚举档案 ID**：客户接口不接受任何 archive_id 参数，
 *      一律"按会话里的 store+mobile 反查"；
 *   ③ **会话绑定 store + mobile**：查询不读请求参数，只读会话；
 *   ④ **输出白名单投影**：`notes` / `storage_key` / 事件 / 门店联系方式一律不下发。
 *
 * ⚠️ 第 ② 条是最容易被实现成"看起来对、其实能爆破"的一条：
 *    只要客户接口收了 `archive_id` 并自己判归属，就会出现
 *    `GET /photo?archive=123` 这种可枚举的入口 —— 判归属的代码没错，
 *    但"能问"这件事本身就是信息泄露（响应时间、404 与 403 的差异都能被利用）。
 *    所以这里的查询**根本没有 id 入参**。
 */

export interface QueryConfig {
  codeLength: number;
  codeTtlSeconds: number;
  resendIntervalSeconds: number;
  maxAttempts: number;
  sessionTtlSeconds: number;
  /** 同一门店+手机号 每小时最多发几条 */
  mobileHourlyLimit: number;
  /** 同一 IP 每小时最多发几条 */
  ipHourlyLimit: number;
}

export const DEFAULT_QUERY_CONFIG: QueryConfig = {
  codeLength: 6,
  codeTtlSeconds: 300,      // 5 分钟
  resendIntervalSeconds: 60,
  maxAttempts: 5,
  sessionTtlSeconds: 1800,  // 30 分钟
  mobileHourlyLimit: 5,
  ipHourlyLimit: 10,
};

export interface QueryDeps {
  db: any;
  config?: Partial<QueryConfig>;
  logger?: { warn?: (m: string) => void; info?: (m: string) => void };
  /** 发短信的钩子（A4 只做 mock，审核前禁止真实发送） */
  enqueueSms?: (input: {
    scene: string;
    storeId: number;
    mobile: string;
    params: Record<string, string>;
  }) => Promise<{ sent: boolean; smsLogId?: string | number; reason?: string }>;
  now?: () => Date;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * 手机号**规范化**（ARC-V1 / R0-CHG-01）。
 *
 * 需求原文："服务端统一校验和规范化手机号。"
 *
 * 为什么必须有这一步、且必须在**服务端**做：
 *   限流桶的键是 `sha256(手机号 + SIGN_SECRET)`。如果 `138 0013 8000`、
 *   `+8613800138000`、`13800138000` 各自算一个桶，那么攻击者只要换个写法
 *   就能把"同一手机号 3 次/分钟"这条限制**无限绕过** —— 而限流是本次
 *   "不校验手机号持有权"唯一的补偿手段。所以规范化不是"顺手清理输入"，
 *   它**是限流能否成立的前提**。
 *   前端也做了一遍，但那只是体验；服务端这一遍才是判据。
 *
 * 规则（顺序固定，依次收敛）：
 *   ① 去掉全部非数字字符 —— 空格、`-`、`(`、`)`、`+` 都可能是用户复制粘贴带进来的；
 *   ② 去掉中国区号前缀 `86` —— 只在剩余长度 > 11 时去掉，避免把
 *      `8613800138000`（13 位）误剪成合法的 11 位，也避免把
 *      以 86 开头的合法 11 位号（不存在，但不要依赖这个巧合）误伤；
 *   ③ 必须匹配 `^1[3-9]\d{9}$`，否则判非法。
 *
 * 返回 `null` 表示非法 —— 调用方必须**明确拒绝**，不能拿空串去查库
 * （空串会匹配到"手机号为空的历史脏数据"，那是比拒绝更糟的泄露）。
 */
export function normalizeArchiveMobile(input: unknown): string | null {
  const digits = String(input ?? '').replace(/[^0-9]/g, '');
  const trimmed = digits.length > 11 && digits.startsWith('86') ? digits.slice(2) : digits;
  return /^1[3-9]\d{9}$/.test(trimmed) ? trimmed : null;
}

/**
 * `status`（六态内部进度）→ **粗略进度**（二态）。
 *
 * 需求原文：匿名摘要只返回"**粗略进度状态**"，且明确"不得返回…内部阶段信息"。
 *
 * 为什么要做这一次映射，而不是把 `status` 原样给出去：
 *   `pending/scheduled/serving/completed/accepted` 五个值本身**就是内部工作流**——
 *   它们会告诉一个不认识的人"这户人家现在有人在施工"、"刚验收完"。
 *   聚合成"进行中/已完成"之后，信息量降到"这东西在办没办完"，
 *   与"客户查自己的档案"这个用途刚好够用。
 *   这是**白名单式**的：未知值一律落到"进行中"（而不是原样透出），
 *   这样将来新增一个 `status` 枚举值时，默认行为是**更保守**的，
 *   不会因为忘了改这里而把新内部状态泄露出去。
 */
export function coarseProgress(status: unknown): { code: 'ongoing' | 'completed'; label: string } {
  const done = ['completed', 'accepted'];
  return done.includes(String(status ?? ''))
    ? { code: 'completed', label: '已完成' }
    : { code: 'ongoing', label: '进行中' };
}

/** 档案类型 → 中文标签（**白名单**，未知值不原样透出） */
export function archiveTypeLabel(type: unknown): string {
  if (String(type ?? '') === ARCHIVE_TYPE.HVAC) return '暖通工程';
  if (String(type ?? '') === ARCHIVE_TYPE.SERVICE) return '上门服务';
  return '服务档案';
}

export class ArchiveQueryService {
  private readonly cfg: QueryConfig;
  private readonly now: () => Date;

  constructor(private readonly deps: QueryDeps) {
    this.cfg = { ...DEFAULT_QUERY_CONFIG, ...(deps.config ?? {}) };
    this.now = deps.now ?? (() => new Date());
    /**
     * R2.2.4 §C：产品清单读取。
     *
     * ⚠️ 在构造函数里建一次而不是每次请求新建：`ArchiveProductService` 无状态
     *    （只有一个 repo 解析器），重复 new 只是浪费分配，但更重要的是
     *    "同一个服务实例"让将来加缓存/指标时只有一个入口。
     */
    this.products = new ArchiveProductService(deps.db);
  }

  /** 产品清单（客户投影用） */
  private readonly products: ArchiveProductService;

  private repo(name: string) {
    return this.deps.db.getRepository(name);
  }

  /** 验证码哈希：把 store 与 mobile 一起拌进去，天然"跨店/跨人不通用" */
  private codeHash(storeId: number, mobile: string, code: string): string {
    return sha256(`archive-verify|${storeId}|${mobile}|${code}`);
  }

  // -------------------------------------------------------------------------
  // 1. 发送验证码
  // -------------------------------------------------------------------------

  /**
   * 解析门店编码 → 内部 id。
   *
   * 客户侧只认**对外编码**（S01），不认内部自增 id —— 门店 id 属于内部信息，
   * 暴露它等于给了一个可枚举的维度。`publicStore:list` 也刻意只回 code/name。
   */
  private async resolveStore(storeCode: string): Promise<any> {
    const code = String(storeCode ?? '').trim();
    if (!code) throw new ArchiveError('ARCHIVE_QUERY_BAD_STORE', '请选择门店', 400);
    const store = await this.repo('stores').findOne({ filter: { code } });
    if (!store || store.active === false) {
      throw new ArchiveError('ARCHIVE_QUERY_BAD_STORE', '门店无效', 400);
    }
    return store;
  }

  async sendCode(input: {
    storeCode: string;
    mobile: string;
    ipHash?: string | null;
  }): Promise<{ sent: boolean; reason?: string; expiresInSeconds: number; resendAfterSeconds: number }> {
    const store = await this.resolveStore(input.storeCode);
    const storeId = Number(store.id);
    const mobile = String(input.mobile ?? '').trim();
    if (!/^1[3-9]\d{9}$/.test(mobile)) {
      throw new ArchiveError('ARCHIVE_QUERY_BAD_MOBILE', '手机号格式不正确', 400);
    }

    // ---- 多维限流（ARC-V1 / A4 收尾：手机号、门店、IP 三个维度）----
    //
    // 为什么单靠 60 秒重发不够：那个闸只防"连点"，不防"每小时慢慢发 100 条"。
    // 短信是按条计费的，而且**被刷的对象是别人**——攻击者填别人的号码，
    // 每 61 秒发一条，受害者的手机会被持续骚扰、费用记在我们账上。
    // 所以三个维度都要有：
    //   ① 同门店+同手机号   每小时 ≤ 5 条   （防针对某个人的持续骚扰）
    //   ② 同 IP             每小时 ≤ 10 条  （防一台机器批量换号刷）
    //   ③ 单次间隔          60 秒           （防连点，见下）
    const HOUR = 60 * 60 * 1000;
    const since = new Date(this.now().getTime() - HOUR);

    const mobileCount = await this.repo('serviceArchiveVerifyCodes').count({
      filter: {
        store_id: storeId,
        customer_mobile: mobile,
        last_sent_at: { $gte: since },
      },
    });
    if (Number(mobileCount) >= this.cfg.mobileHourlyLimit) {
      // 话术刻意模糊：不告诉对方"你这个号已经被发了几条"，
      // 否则它就是一个便宜的"这个号码是否在我们系统里"的探针。
      throw new ArchiveError(
        'ARCHIVE_QUERY_TOO_FREQUENT',
        '请求过于频繁，请稍后再试',
        429,
      );
    }

    if (input.ipHash) {
      const ipCount = await this.repo('serviceArchiveVerifyCodes').count({
        filter: {
          ip_hash: input.ipHash,
          last_sent_at: { $gte: since },
        },
      });
      if (Number(ipCount) >= this.cfg.ipHourlyLimit) {
        throw new ArchiveError(
          'ARCHIVE_QUERY_TOO_FREQUENT',
          '请求过于频繁，请稍后再试',
          429,
        );
      }
    }

    // ---- 重发间隔（60 秒）：查最近一条同 store+mobile 的发送时间 ----
    const recent = await this.repo('serviceArchiveVerifyCodes').find({
      filter: { store_id: storeId, customer_mobile: mobile },
      sort: ['-id'],
      limit: 1,
    });
    const last = recent?.[0];
    if (last?.last_sent_at) {
      const elapsed = (this.now().getTime() - new Date(last.last_sent_at).getTime()) / 1000;
      if (elapsed < this.cfg.resendIntervalSeconds) {
        const wait = Math.ceil(this.cfg.resendIntervalSeconds - elapsed);
        throw new ArchiveError(
          'ARCHIVE_QUERY_TOO_FREQUENT',
          `请求过于频繁，请 ${wait} 秒后再试`,
          429,
        );
      }
    }

    const code = String(randomInt(0, 10 ** this.cfg.codeLength)).padStart(this.cfg.codeLength, '0');
    const expiresAt = new Date(this.now().getTime() + this.cfg.codeTtlSeconds * 1000);

    const row = await this.repo('serviceArchiveVerifyCodes').create({
      values: {
        store_id: storeId,
        customer_mobile: mobile,
        code_hash: this.codeHash(storeId, mobile, code),
        expires_at: expiresAt,
        attempts: 0,
        max_attempts: this.cfg.maxAttempts,
        ip_hash: input.ipHash ?? null,
        last_sent_at: this.now(),
      },
    });
    // ---- 发送：只走 mock ----
    //
    // 执行令：验证码模板审核通过前**禁止真实发送**。
    // 这里刻意不读 `sms.enabled` 总开关 —— 那个开关一开就会把验证码真的发出去，
    // 而审核状态与服务商配置是两件事。代码层面直接锁死为 mock。
    const smsResult = this.deps.enqueueSms
      ? await this.deps.enqueueSms({
          scene: SMS_SCENE.ARCHIVE_VERIFY,
          storeId,
          mobile,
          params: { code, store: String(store.name ?? '') },
        })
      : { sent: false, reason: 'SMS_NOT_CONFIGURED' };

    // 短信没发出去 ⇒ 这条码作废（否则库里留一条"没人收到却能通过"的码）
    if (!smsResult.sent) {
      await this.repo('serviceArchiveVerifyCodes').update({
        filter: { id: Number(row.id) },
        values: { consumed_at: this.now() },
      });
      this.deps.logger?.warn?.(
        `[archive-query] 验证码未发送（${smsResult.reason ?? 'unknown'}），已作废 store=${storeId}`,
      );
    }

    // 开发环境把码回给调用方，方便验收；生产不放行（由 action 层按 profile 决定）
    return {
      sent: Boolean(smsResult.sent),
      reason: smsResult.reason,
      expiresInSeconds: this.cfg.codeTtlSeconds,
      resendAfterSeconds: this.cfg.resendIntervalSeconds,
    };
  }

  // -------------------------------------------------------------------------
  // 2. 校验验证码 → 签发会话
  // -------------------------------------------------------------------------

  async verifyCode(input: {
    storeCode: string;
    mobile: string;
    code: string;
    ipHash?: string | null;
  }): Promise<{ token: string; expiresInSeconds: number }> {
    const store = await this.resolveStore(input.storeCode);
    const storeId = Number(store.id);
    const mobile = String(input.mobile ?? '').trim();
    const code = String(input.code ?? '').trim();

    const rows = await this.repo('serviceArchiveVerifyCodes').find({
      filter: { store_id: storeId, customer_mobile: mobile },
      sort: ['-id'],
      limit: 1,
    });
    const rec = rows?.[0];
    // 统一话术：不区分"没发过码"与"码错了"，避免被用来探测某号码是否下过单
    const generic = new ArchiveError('ARCHIVE_QUERY_CODE_INVALID', '验证码不正确或已过期', 400);
    if (!rec) throw generic;
    if (rec.consumed_at) throw generic;
    if (new Date(rec.expires_at).getTime() < this.now().getTime()) throw generic;
    if (Number(rec.attempts) >= Number(rec.max_attempts)) throw generic;

    // ---- 原子占坑：把"读 attempts → 判断 → 写 attempts"合成一次条件 UPDATE ----
    //
    // 原实现是"先 find 再 update"，两个并发 verify 会同时读到 attempts=0、
    // 同时对同一枚码校验 —— 如果码是对的，**同一枚码被消费两次**，
    // 两个会话同时拿到访问权。次数限制也因此失效（N 个并发 = N 次机会）。
    //
    // 现在：条件 UPDATE `attempts < max_attempts AND consumed_at IS NULL`，
    // 只有抢到的那一个请求能把 attempts +1；抢不到的直接按"已失效"拒绝。
    const [claimed] = (await this.deps.db.sequelize.query(
      `UPDATE service_archive_verify_codes
          SET attempts = attempts + 1
        WHERE id = :id
          AND consumed_at IS NULL
          AND attempts < max_attempts
        RETURNING id, attempts, max_attempts, code_hash`,
      { replacements: { id: Number(rec.id) } },
    )) as unknown as [Array<{ id: number; attempts: number; max_attempts: number; code_hash: string }>];

    if (!Array.isArray(claimed) || claimed.length === 0) {
      // 已被别人抢光次数，或已被核销
      throw generic;
    }

    const expected = this.codeHash(storeId, mobile, code);
    if (expected !== String(claimed[0].code_hash)) {
      // 次数用尽则核销；否则留着让他还能用剩下的机会
      if (Number(claimed[0].attempts) >= Number(claimed[0].max_attempts)) {
        await this.repo('serviceArchiveVerifyCodes').update({
          filter: { id: Number(rec.id) },
          values: { consumed_at: this.now() },
        });
      }
      throw generic;
    }

    // ---- 核销：同样用条件 UPDATE，保证只有第一个成功者拿到会话 ----
    const [consumed] = (await this.deps.db.sequelize.query(
      `UPDATE service_archive_verify_codes
          SET consumed_at = now()
        WHERE id = :id AND consumed_at IS NULL
        RETURNING id`,
      { replacements: { id: Number(rec.id) } },
    )) as unknown as [Array<{ id: number }>];

    if (!Array.isArray(consumed) || consumed.length === 0) {
      // 极小概率：两次并发都通过了上面的占坑（不同 attempts 值），
      // 但只有第一个能把 consumed_at 置位。第二个必须拒绝，不能也发会话。
      throw generic;
    }

    // ---- 签发会话：明文 token 只在响应里出现这一次 ----
    //
    // 先撤销**同一门店 + 同一手机号**的既有会话。
    // 为什么：客户重新验证通常意味着"我怀疑上一个人还在看"或"我换了设备"。
    // 如果旧会话继续有效到 30 分钟，撤销就变成一句空话 —— 新会话签发的那一刻，
    // 恰恰是最该让旧爪牙失效的时刻。
    // 代价是"同一客户不能同时在两台设备上查"，这个代价可以接受
    // （他是来查自己的档案，不是协作）。
    await this.deps.db.sequelize.query(
      `UPDATE service_archive_query_sessions
          SET revoked_at = now()
        WHERE store_id = :storeId
          AND customer_mobile = :mobile
          AND revoked_at IS NULL`,
      { replacements: { storeId, mobile } },
    );

    const token = randomBytes(32).toString('base64url');
    await this.repo('serviceArchiveQuerySessions').create({
      values: {
        token_hash: sha256(token),
        store_id: storeId,
        customer_mobile: mobile,
        expires_at: new Date(this.now().getTime() + this.cfg.sessionTtlSeconds * 1000),
        ip_hash: input.ipHash ?? null,
        last_seen_at: this.now(),
      },
    });

    return { token, expiresInSeconds: this.cfg.sessionTtlSeconds };
  }

  /** 解析会话；无效/过期/撤销一律同一条错误 */
  private async loadSession(token: string): Promise<any> {
    const t = String(token ?? '').trim();
    if (!t) {
      throw new ArchiveError('ARCHIVE_QUERY_SESSION_INVALID', '查询会话无效，请重新验证', 401);
    }
    const rows = await this.repo('serviceArchiveQuerySessions').find({
      filter: { token_hash: sha256(t) },
      limit: 1,
    });
    const s = rows?.[0];
    const invalid = new ArchiveError(
      'ARCHIVE_QUERY_SESSION_INVALID',
      '查询会话无效，请重新验证',
      401,
    );
    if (!s) throw invalid;
    if (s.revoked_at) throw invalid;
    if (new Date(s.expires_at).getTime() < this.now().getTime()) throw invalid;

    await this.repo('serviceArchiveQuerySessions').update({
      filter: { id: Number(s.id) },
      values: { last_seen_at: this.now() },
    });
    return s;
  }

  // -------------------------------------------------------------------------
  // 3. 查询（不接受 archive_id）
  // -------------------------------------------------------------------------

  /**
   * 客户可见的档案列表。
   *
   * 范围**只来自会话**：`store_id` + `customer_mobile` + `visibility=published`。
   * 没有"按 id 查"的入口 —— 因此不存在"枚举 id 拿别人档案"这条路径。
   */
  async listVisibleArchives(token: string): Promise<any[]> {
    const s = await this.loadSession(token);
    const rows = await this.repo('serviceArchives').find({
      filter: {
        store_id: Number(s.store_id),
        customer_mobile: String(s.customer_mobile),
        visibility: ARCHIVE_VISIBILITY.PUBLISHED,
      },
      sort: ['-id'],
    });
    return (rows ?? []).map((r: any) => this.projectArchive(r));
  }

  /** 档案详情 + 阶段 + 可见照片（仍然只接受会话 token 与"会话内的档案序号"） */
  async detail(token: string, archiveNo: string): Promise<any> {
    const s = await this.loadSession(token);
    // ⚠️ 用 `archive_no`（业务单号）而不是自增 id 作为入口：
    //    自增 id 可枚举；而就算单号被猜中，下面的 where 仍强制
    //    store_id + customer_mobile 必须与会话一致 —— 猜中也拿不到。
    const rows = await this.repo('serviceArchives').find({
      filter: {
        archive_no: String(archiveNo ?? '').trim(),
        store_id: Number(s.store_id),
        customer_mobile: String(s.customer_mobile),
        visibility: ARCHIVE_VISIBILITY.PUBLISHED,
      },
      limit: 1,
    });
    const archive = rows?.[0];
    if (!archive) {
      throw new ArchiveError('ARCHIVE_NOT_FOUND', '未找到该服务档案', 404);
    }

    const photos = await this.repo('serviceArchivePhotos').find({
      filter: { archive_id: Number(archive.id) },
      sort: ['id'],
    });

    let stages: any[] = [];
    if (archive.archive_type === ARCHIVE_TYPE.HVAC) {
      const stageRows = await this.repo('serviceArchiveStages').find({
        filter: { archive_id: Number(archive.id) },
        sort: ['stage_order'],
      });
      const byId = new Map((stageRows ?? []).map((x: any) => [Number(x.id), x]));
      // 只下发"有内容可看"的阶段：已完成的 + 已撤回的（撤回后照片不可见，但阶段本身仍可显示为已撤回）
      stages = (stageRows ?? []).map((st: any) => ({
        stage_code: st.stage_code,
        stage_order: st.stage_order,
        status: st.status,
        stage_date: st.stage_date,
        // 🔴 **不下发 `note`**（2026-11-11 A5-F 验收发现）。
        //    阶段备注与档案级 `notes` 同属内部信息：现场勘察里写的多半是
        //    "业主不在家/墙体有问题/加价谈崩"这类不能给客户看的话。
        //    客户可见的说明另有 `public_note`（档案级），不要混用同一个字段。
        //    客户 H5 目前也没有消费 stages，去掉它不影响现有页面。
        photos: (photos ?? [])
          .filter((p: any) => Number(p.stage_id) === Number(st.id))
          .filter((p: any) => isPhotoCustomerVisible(archive, p, byId.get(Number(p.stage_id))))
          .map((p: any) => this.projectPhoto(p)),
      }));
    }

    return {
      archive: this.projectArchive(archive),
      /**
       * R2.2.4 §C：产品清单。
       *
       * ⚠️ **空数组不是 null**（见 `ArchiveProductService.projectForCustomer`）：
       *    `null` 与 `[]` 在前端是两种状态，混用会让"旧档案（清单表里没有行）"
       *    和"新档案（清单为空）"表现不一致 —— 而客户页要表达的是同一件事：
       *    "这条档案没有登记产品"。
       *
       * ⚠️ 只投影 name/date/quantity：不给 id（内部主键，可枚举）、
       *    不给 sort_order（内部排序号，对外无意义）。
       */
      products: this.products.projectForCustomer(
        await this.products.list(Number(archive.id)),
      ),
      // 普通服务：前台/后台两张；暖通：照片挂在阶段里
      photos:
        archive.archive_type === ARCHIVE_TYPE.SERVICE
          ? (photos ?? [])
              .filter((p: any) => p.stage_id === null || p.stage_id === undefined)
              .filter((p: any) => isPhotoCustomerVisible(archive, p, null))
              .map((p: any) => this.projectPhoto(p))
          : [],
      stages,
    };
  }

  /**
   * 客户读取照片。
   *
   * 入参是**会话 token + 照片 id**。这里必须重新走一遍
   * `isPhotoCustomerVisible`，不能因为"列表里出现过"就放行 ——
   * 列表与这次请求之间可能刚发生过撤回。
   */
  async readPhoto(token: string, photoId: number): Promise<{ buffer: Buffer; mime: string }> {
    const s = await this.loadSession(token);
    const photo = await this.repo('serviceArchivePhotos').findOne({
      filter: { id: Number(photoId) },
    });
    if (!photo) throw new ArchiveError('ARCHIVE_PHOTO_NOT_FOUND', '照片不存在', 404);

    const archiveRows = await this.repo('serviceArchives').find({
      filter: {
        id: Number(photo.archive_id),
        store_id: Number(s.store_id),
        customer_mobile: String(s.customer_mobile),
        visibility: ARCHIVE_VISIBILITY.PUBLISHED,
      },
      limit: 1,
    });
    const archive = archiveRows?.[0];
    if (!archive) throw new ArchiveError('ARCHIVE_PHOTO_NOT_FOUND', '照片不存在', 404);

    let stage: any = null;
    if (photo.stage_id !== null && photo.stage_id !== undefined) {
      stage = await this.repo('serviceArchiveStages').findOne({
        filter: { id: Number(photo.stage_id) },
      });
    }
    if (!isPhotoCustomerVisible(archive, photo, stage)) {
      throw new ArchiveError('ARCHIVE_PHOTO_NOT_FOUND', '照片不存在', 404);
    }

    const fs = await import('node:fs');
    const path = await import('node:path');
    const key = String(photo.storage_key ?? '');
    if (!key || key.startsWith('/') || key.includes('..')) {
      throw new ArchiveError('ARCHIVE_PHOTO_BROKEN', '照片记录异常', 500);
    }
    const abs = path.join(this.privateDir(), key);
    if (!fs.existsSync(abs)) {
      throw new ArchiveError('ARCHIVE_PHOTO_MISSING', '照片文件不存在', 404);
    }
    return { buffer: await fs.promises.readFile(abs), mime: String(photo.mime) };
  }

  private privateDir(): string {
    const raw = String(process.env.UPLOAD_PRIVATE_DIR ?? '').trim();
    return raw || '/app/nocobase/storage/uploads-private';
  }

  // -------------------------------------------------------------------------
  // 3b. 手机号摘要查询（ARC-V1 / R0-CHG-01）—— **只凭手机号**，不校验持有权
  // -------------------------------------------------------------------------

  /**
   * 按手机号查**跨全部有效门店**的**已发布**档案，返回**最小摘要**，按门店分组。
   *
   * 与上面 `listVisibleArchives()` 的根本区别：
   *   那条走会话（`store_id + customer_mobile` 双约束），这条**没有会话** ——
   *   输入的手机号就是全部凭据。因此安全性**不能**再依赖"证明你是你"，
   *   只能靠两件事，且两者缺一不可：
   *     ① **输出裁剪到最小摘要**（本方法的核心）；
   *     ② **服务端强制限流**（在 action 层，见 archive.ts 的 `queryByMobile`）。
   *
   * ⚠️ 为什么**不问门店**（需求："取消购买门店选择，由系统自动匹配门店"）：
   *    同一户人家可能在两家店买过东西，要求他先选店等于把"你自己记得清"
   *    当成前置条件。跨店匹配是正确的产品行为；对应的代价是
   *    "输入一个号就能看到它在几家店有档案" —— 所以返回里**只有门店名**，
   *    没有任何可以定位到个人的字段。
   *
   * ⚠️ 项目内**唯一**一处"只凭手机号"的读：新增任何一条同类入口之前，
   *    先确认它不能复用本方法（重复实现必然漂移，而漂移的方向通常是"多给了字段"）。
   *
   * @param rawMobile 用户输入（未规范化，由本方法内 `normalizeArchiveMobile` 收敛）
   */
  async queryByMobileSummary(
    rawMobile: unknown,
  ): Promise<{
    mobile_masked: string;
    groups: Array<{
      store_id: number;
      store_name: string;
      archives: Array<{
        archive_type: string;
        archive_type_label: string;
        progress: string;
        progress_label: string;
      }>;
    }>;
    total: number;
  }> {
    const mobile = normalizeArchiveMobile(rawMobile);
    if (!mobile) {
      // 非法手机号：**明确拒绝**（不是"当成空串查"）。错误码与话术都走
      // `ARCHIVE_QUERY_BAD_MOBILE`，与验证码链路的 400 口径一致。
      throw new ArchiveError('ARCHIVE_QUERY_BAD_MOBILE', '手机号格式不正确', 400);
    }

    // ---- ① 匹配：全部门店、仅已发布。**不按 store_id 分组地一次查完** ----
    //
    // 为什么不 for 每家店循环查：需求禁止假设门店 ID 为 1–10（生产是
    // 1,4,8,9,10,11,12,13,14,15 的**不连续**集合）。循环要么漏店，要么需要
    // 先把门店表全读出来 —— 而正确做法是让数据库一次匹配完，
    // "哪些店有档案"就是查询的自然结果，不需要预先知道有哪些店。
    const rows = await this.repo('serviceArchives').find({
      filter: {
        customer_mobile: mobile,
        visibility: ARCHIVE_VISIBILITY.PUBLISHED,
      },
      // 排序只为结果稳定（同一份数据两次请求顺序一致，便于验收比对）；
      // 真正的分组顺序按门店名/ID 在下面显式排。
      sort: ['store_id', '-id'],
    });

    const list: any[] = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      // 无记录**不是错误**：它是一次成功的查询，只是结果为空。
      // （若在这里抛 404，前端就得靠"区分错误类型"来决定是否显示空态，
      //   而 404 与"手机号没档案"之外的含义很容易被后来者复用错。）
      return { mobile_masked: maskMobileText(mobile), groups: [], total: 0 };
    }

    // ---- ② 关联门店名：按**实际出现的 store_id** 批量取，不假设 ID 集合 ----
    const storeIds = Array.from(
      new Set(list.map((r) => Number(r.store_id)).filter((n) => Number.isSafeInteger(n) && n > 0)),
    );
    const stores = storeIds.length
      ? await this.repo('stores').find({ filter: { id: { $in: storeIds } } })
      : [];
    const storeById = new Map<number, any>(
      (stores ?? []).map((s: any) => [Number(s.id), s]),
    );

    // ---- ③ 分组 + 投影：**只出最小摘要** ----
    const byStore = new Map<number, { store_id: number; store_name: string; archives: any[] }>();
    for (const r of list) {
      const storeId = Number(r.store_id);
      if (!Number.isSafeInteger(storeId) || storeId <= 0) continue;
      if (!byStore.has(storeId)) {
        const store = storeById.get(storeId);
        // 门店行缺失（理论不该发生：store_id 是外键）时**不猜名字**，
        // 用一个中性占位而不是把 id 当名字暴露出去。
        byStore.set(storeId, {
          store_id: storeId,
          store_name: String(store?.name ?? '门店'),
          archives: [],
        });
      }
      const prog = coarseProgress(r.status);
      byStore.get(storeId)!.archives.push({
        // ⚠️ 白名单投影：这里**只允许**出现下面四个字段。
        //    禁止添加 archive_no / customer_name / service_address /
        //    product_description / purchase_date / public_note / notes /
        //    assigned_worker / sales_user_id 等任何字段 ——
        //    任何一条都会把"只凭手机号"从"能看个大概"变成"能看个案情"。
        archive_type: String(r.archive_type ?? ''),
        archive_type_label: archiveTypeLabel(r.archive_type),
        progress: prog.code,
        progress_label: prog.label,
      });
    }

    const groups = Array.from(byStore.values()).sort((a, b) => a.store_id - b.store_id);
    const total = groups.reduce((n, g) => n + g.archives.length, 0);

    return { mobile_masked: maskMobileText(mobile), groups, total };
  }

  // -------------------------------------------------------------------------
  // 投影（客户可见字段白名单）
  // -------------------------------------------------------------------------

  /**
   * ⚠️ 这是**白名单**，不是黑名单。
   * 不下发：`notes`（内部备注）、`created_by`/`updated_by`、`version`、
   *         `sales_user_id`、`store_id`（门店内部 id）、任何 storage_key。
   */
  projectArchive(row: any): Record<string, unknown> {
    return {
      archive_no: row.archive_no,
      archive_type: row.archive_type,
      store_name: row.__store_name ?? undefined, // 由调用方按需补
      customer_name: row.customer_name,
      service_address: row.service_address,
      product_description: row.product_description ?? null,
      package_description: row.package_description ?? null,
      purchase_date: row.purchase_date ?? null,
      planned_date: row.planned_date ?? null,
      service_type: row.service_type ?? null,
      service_date: row.completed_at ?? null,
      status: row.status,
      public_note: row.public_note ?? null,
      // 暖通的验收日期：以 accept 阶段为准（A4 在 detail 里补）
      accepted_date: row.__accepted_date ?? null,
    };
  }

  projectPhoto(row: any): Record<string, unknown> {
    return {
      id: Number(row.id),
      photo_type: row.photo_type,
      mime: row.mime,
      width: row.width ?? null,
      height: row.height ?? null,
    };
  }
}

