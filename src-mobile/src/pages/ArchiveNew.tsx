/**
 * B 页之二：新建服务档案（分两步，但**提交参数与校验完全遵循原接口**）。
 *
 * ===========================================================================
 * R2.2.1 重做（用户第 7.2 / 7.3 / 7.4 条）
 * ===========================================================================
 *   ① **保存即正式发布**（用户 7.4）—— 所以本页**不再出现"草稿"两个字**：
 *        · 提交确认弹窗改为"保存后客户就能查到这条档案"
 *        · 预览块里的"提交后为草稿"徽标删除
 *        · 服务端 `create()` 同步改为写 `published`（见 archive-service.ts）
 *      ⚠️ 只删前端文案而不改服务端 = 骗人。两处都改了才算完成（Task #296）。
 *
 *   ② **切换服务类型时布局零位移**（用户 7.3 + 审计 I-03）：
 *        旧实现 `{type === 'service' ? <SegmentedField .../> : null}`
 *        ⇒ 选「暖通工程」时那一格消失，下面的"客户与地址"整体上移 **88px**。
 *        ⇒ 现在暖通时渲染 `QFUnavailableBlock`（minHeight **160px** =
 *          网格 3×48 + 2×8 gap，与真实网格严格等高）。
 *        判据：切换前后 `#archive-new-name` 的 `top` 差值 **== 0**。
 *
 *   ③ **字段调整**（用户 7.2 / 7.3）：
 *        · 删「客户手机号」下方的长篇解释（hint 只留一句"填错就查不到了"）
 *        · **删「客户可见备注」**，新增「内部备注」（`notes`，只有门店和总部能看到）
 *        · 新增「购买日期」（`purchase_date`，服务端 `archiveCreate` 已接收）
 *        · 「预约上门日期」**只在普通上门服务时出现**；暖通各阶段单独填实际日期
 *
 * ===========================================================================
 * 为什么拆两步
 * ===========================================================================
 *   一次性长表单在手机上要滚 3 屏，滚到"服务地址"时已经忘了第一屏填了什么；
 *   更糟的是**底部主按钮始终在屏幕外**，用户不知道下一步该点哪。
 *   ⇒ 第一步 = "给谁做"，第二步 = "做什么"。拆步骤**只影响展示**：
 *     提交仍然是一次 `svc:archiveCreate`，参数名与后端契约一字不差。
 *     ⚠️ 千万不要为了"更自然的表单"把参数拆成两次提交 ——
 *        那会让"只填了一半的档案"落库。
 *
 * ===========================================================================
 * 两个必须做的细节
 * ===========================================================================
 *   ① **X-Request-Id 在打开表单时生成一次**：它是服务端的幂等键。
 *      每次点提交都生成新的 ⇒ 网络超时后用户重试会**建出第二张档案**。
 *   ② **普通服务必须有 service_type，暖通没有这个字段**（服务端 400）。
 *      前端提前拦是为了少一次"填完三屏才被拒"。
 */

import { useEffect, useMemo, useState } from 'react';
import { AppShell, PageHeader, StickyActionBar, findScrollContainer } from '../components/AppShell';
import { focusFirstError, validators, useBeforeUnload } from '../components/Form';
import { useSubmitGuard, useToast } from '../components/Feedback';
import {
  QFButton,
  QFChoiceCard,
  QFFormField,
  QFGridSelect,
  QFListSection,
  QFProductList,
  describeQFError,
  newProductDraft,
  filledProductCount,
  toProductPayload,
  useQFConfirm,
  type QFProductDraft,
} from '../components/qf';
import { ArchiveApiAdapter } from '../api/archives';
import { defaultStageConfig, fetchStageConfig } from '../api/stage-config';
import {
  ARCHIVE_TYPE_META,
  SERVICE_TYPE_OPTIONS,
  type HvacStageConfig,
} from '../design/qf-tokens';
import { newRequestId } from '../api/http';
import { navigate } from '../router';
import { useSession } from '../app/session-context';

/**
 * 第一步的字段顺序 = **错误定位的顺序**。
 *
 * ⚠️ 这个数组必须与下面 JSX 的渲染顺序一致。它是"第一个要改的字段"的判定依据，
 *    顺序错了会把人带到第二个错误上，比不定位更困惑（用户以为改完这个就好了）。
 */
const STEP1_FIELD_ORDER = [
  'archive-new-type',
  'archive-new-service-type',
  'archive-new-name',
  'archive-new-mobile',
  'archive-new-address',
] as const;

/**
 * 「服务内容」网格的等高占位高度 —— **R2.2.2 §一 起不再使用**。
 *
 *   ⚠️ 保留这段说明而不是直接删干净，是因为它记录了一条**已经失效**的设计约束，
 *      而失效的原因必须写清楚，否则下一个人会把 208px 又加回去：
 *
 *   原约束（R2.2.1 I-03）：切换「上门服务 / 暖通工程」时布局零位移，
 *   因此未选类型时用一个 208px 的等高块占位（含 22px 错误行）。
 *
 *   失效原因：用户 R2.2.2 §一 明确「留白过大」，且第一优先级是
 *   **不让销售人员分心**。一个 208px 的灰块只装一行字，占掉半屏，
 *   反而更像"页面没加载完"。现改为 72px 一行提示。
 *
 *   ⚠️ I-03 的判据（`#archive-new-name` 的 top 差值 == 0）**只针对
 *      "已选 service ↔ 已选 hvac" 两态**，不覆盖"未选类型"这第三态，
 *      所以本次调整不会让那条判据变红；若将来有人把它扩展到三态，需要重新裁剪。
 */

export function ArchiveNewPage({ presetType }: { presetType?: string }) {
  const { caps } = useSession();

  // 权限入口在列表页已经判过；这里再判一次是防"直接输 URL 进来"
  // （服务端仍会 403，但让用户看到"没权限"比"填完被拒"好）
  if (!caps.archiveCreate) {
    return (
      <AppShell>
        <PageHeader title="新建档案" back />
        <div className="px-6 py-16 text-center">
          <div className="text-svc-ink qf-body font-medium">当前账号不能新建档案</div>
          <div className="text-svc-ink-2 qf-foot mt-2 leading-relaxed">
            建档只对门店销售开放。如果需要，请联系门店负责人或总部管理员调整角色。
          </div>
        </div>
      </AppShell>
    );
  }

  return <ArchiveNewForm presetType={presetType} />;
}

function ArchiveNewForm({ presetType }: { presetType?: string }) {
  const toast = useToast();
  const confirm = useQFConfirm();
  const submit = useSubmitGuard();

  /** ⚠️ 幂等键：整个表单生命周期只生成一次（见文件头 ①） */
  const requestId = useMemo(() => newRequestId(), []);

  const [step, setStep] = useState<1 | 2>(1);
  const [type, setType] = useState<'service' | 'hvac' | ''>(
    presetType === 'service' || presetType === 'hvac' ? presetType : '',
  );
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [address, setAddress] = useState('');
  const [serviceType, setServiceType] = useState('');
  /**
   * 🔴 R2.2.4 §C：**产品清单**取代原来的两个单值字段
   *    （`product: string` + `purchaseDate: string`）。
   *
   *    默认给一条空产品 —— 用户明确要求"默认给出一条空产品；点击「添加产品」新增一条"。
   *    空产品**不会**被提交（`toProductPayload` 会丢掉完全空白的条目），
   *    所以"一条都不填"与"没有产品"在服务端是同一个结果。
   */
  const [products, setProducts] = useState<QFProductDraft[]>(() => [newProductDraft()]);
  const [planned, setPlanned] = useState('');
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);

  /**
   * ⚠️ `dirty` 决定"关页面要不要拦"。产品清单必须算进去：
   *    否则用户填了三台设备，一按返回就静默丢了（没有二次确认）。
   */
  const dirty =
    Boolean(type || name || mobile || address || serviceType || planned || notes) ||
    filledProductCount(products) > 0;
  useBeforeUnload(dirty);

  const errors = {
    type: touched && !type ? '请选择服务类型' : null,
    name: touched && !name.trim() ? validators.required('客户姓名')('') : null,
    mobile: touched ? validators.mobile(mobile) : null,
    address: touched && !address.trim() ? validators.required('服务地址')('') : null,
    // ⚠️ 字段标签是「服务内容」，错误文案必须跟着叫同一个名字 ——
    //    否则用户按红字去找"服务类型"，而屏幕上那个「服务类型」是**另一个**已选好的字段。
    serviceType: touched && type === 'service' && !serviceType ? '请选择服务内容' : null,
    planned: touched ? validators.dateOnly(planned) : null,
  };

  const step1Ok =
    Boolean(type) && Boolean(name.trim()) && !validators.mobile(mobile) && Boolean(address.trim()) &&
    (type !== 'service' || Boolean(serviceType));

  /**
   * 校验失败时：把用户带到**第一个**要改的字段。
   * ⚠️ 之后才 toast —— 顺序反过来（先 toast）会让提示与滚屏同时发生，用户等于没看到。
   */
  const locateFirstError = () => {
    focusFirstError([...STEP1_FIELD_ORDER]);
  };

  const goStep2 = () => {
    setTouched(true);
    if (!step1Ok) {
      locateFirstError();
      toast.show('请先补全标红的必填项', 'warning');
      return;
    }
    setStep(2);
    // 切步骤后回到顶部：否则用户会停在第一屏末尾，以为第二屏没有内容
    // ⚠️ 用 findScrollContainer 而不是 '.k-page' —— 后者根本不滚，这行曾是空转。
    findScrollContainer().scrollTo({ top: 0, behavior: 'auto' });
  };

  const doSubmit = async () => {
    setTouched(true);
    if (!step1Ok) {
      setStep(1);
      // 切回第一步之后 DOM 才会重新挂载，必须等一帧再定位，否则查不到字段
      window.setTimeout(locateFirstError, 0);
      toast.show('请先补全标红的必填项', 'warning');
      return;
    }

    /**
     * 🔴 用户第 7.4 条：**保存即正式发布**。
     *
     *   旧文案写"提交后档案为草稿状态，客户暂时看不到；完成并发布后客户才能查询到"
     *   —— 那句话描述的是旧行为，而现在服务端 `create()` 直接写 `published`。
     *   保留旧文案会让员工以为"还得再点一次发布"，于是他会去详情页找那个按钮
     *   （而那个按钮本轮已删除），最后以为"系统坏了"。
     *
     *   ⇒ 文案必须与**改完后的真实行为**一致。
     */
    const ok = await confirm.ask({
      title: '保存这条档案？',
      message: `保存后立即生效，客户用手机号就能查到这条${
        type === 'hvac' ? '暖通工程' : '上门服务'
      }记录。`,
      confirmText: '保存档案',
    });
    if (!ok) return;

    await submit.run(async () => {
      try {
        /**
         * 🔴 R2.2.4 §C：产品清单**一次提交**，不拆成"建档 + 补清单"两次请求。
         *
         *    拆两次的后果：建档成功、清单失败 ⇒ 库里有一条"产品为空"的档案，
         *    而用户看到的是错误提示，再点一次保存就建出第二张（幂等键已消费）。
         *
         *    `toProductPayload` 在这里做两件事（与服务端 `normalize` 同口径）：
         *      · 丢掉完全空白的条目（默认那条空产品不填就不会落库）；
         *      · 数量归一成 ≥1 的整数。
         *    服务端还会再 normalize 一次 —— 前端不是为了"替服务端校验"，
         *    而是为了**发出去的请求体本身就干净**（日志、抓包、重放都少一层歧义）。
         */
        const productPayload = toProductPayload(products);

        await ArchiveApiAdapter.create(
          {
            archive_type: type as 'service' | 'hvac',
            customer_name: name.trim(),
            customer_mobile: mobile.trim(),
            service_address: address.trim(),
            // 暖通**不传** service_type（服务端对暖通会忽略，但显式置空更清楚）
            service_type: type === 'service' ? serviceType : null,
            /**
             * ⚠️ 旧的单值列仍然要发 —— 服务端 `mirrorToLegacy` 会把第一条产品
             *    镜像进 `product_description` / `purchase_date`，这里**不要**重复发，
             *    否则会和清单打架（两条来源优先级写在 `writeBoth` 里）。
             *    清单为空时 mirror 返回 `{}`，旧列保持 NULL（正确：确实没有产品）。
             */
            products: productPayload,
            // ⚠️ 预约上门日期**只对上门服务**有意义；暖通各阶段单独记实际日期
            planned_date: type === 'service' ? planned || null : null,
            /**
             * ⚠️ `notes` = **内部备注**（`serviceArchives.notes` 列，服务端注释：
             *    "🔒 永不进入客户查询投影"）。它与 `public_note`（对客户说明）是两列，
             *    本页只填内部备注 —— 用户第 7.2 / 7.3 条明令删除「客户可见备注」。
             */
            notes: notes.trim() || null,
          },
          requestId,
        );
        // replace 而不是 push：返回键应回到列表，而不是回到"已提交的表单"
        navigate('/archives', { replace: true });
      } catch (e) {
        const info = describeQFError(e);
        // 幂等冲突（同一 requestId 回放）也要说清楚，否则用户会以为"没成功"
        toast.show(info.message, 'danger');
      }
    });
  };

  /*
   * ⚠️ 这里原本还有 `const typeLabel = type === 'hvac' ? '暖通工程' : '上门服务'`，
   *    它唯一的消费方是第二步末尾的「即将保存」预览区。
   *    该预览区按 R2.2.4 §D 整块删除 ⇒ 变量一并删掉（留着就是一处新的漂移源：
   *    下次有人改类型名称，这行会变成没人用的死代码却仍然"看起来是对的"）。
   */

  return (
    <AppShell>
      {toast.node}
      {confirm.node}
      <PageHeader title="新建档案" back subtitle={step === 1 ? '第 1 步 / 共 2 步' : '第 2 步 / 共 2 步'} />

      {/* 进度条：两步就够，不需要复杂的 stepper */}
      <div className="px-4 pt-2">
        <div className="bg-svc-line h-1 overflow-hidden rounded-full">
          <div
            className="bg-svc-brand h-full transition-all duration-300"
            style={{ width: step === 1 ? '50%' : '100%' }}
          />
        </div>
      </div>

      {step === 1 ? (
        <>
          <QFListSection
            title="服务类型"
            /*
             * ⚠️ 这一段是 I-03 修复的核心。
             *    两种类型的字段区**高度恒定**：
             *      上门服务 → 2 列网格（6 项，160px）
             *      暖通工程 → 等高的说明块（160px）
             *    判据：切换前后 `#archive-new-name` 的 top 差值 == 0。
             */
          >
            <div className="pt-1">
              <QFChoiceCard
                label="服务类型"
                value={type}
                required
                error={errors.type}
                onChange={(v) => {
                  /**
                   * 🔴 R2.2.4 §B：切换类型时**清掉不适用的服务内容**。
                   *
                   *   不加这一行的后果：先选「上门服务 → 安装」，再切「暖通工程」，
                   *   `serviceType` 仍留着 'install' 但界面上看不到它 ——
                   *   提交时 `type === 'service' ? serviceType : null` 会把它丢掉，
                   *   于是"用户以为填了、系统没收"，而没有任何地方报错。
                   *   反方向同理（暖通切回上门服务时，之前选的服务内容已经不可见了，
                   *   留着它等于替用户做了决定）。
                   */
                  if (v !== type) setServiceType('');
                  setType(v);
                }}
                options={[
                  { value: 'service', label: ARCHIVE_TYPE_META.service!.label },
                  { value: 'hvac', label: ARCHIVE_TYPE_META.hvac!.label },
                ]}
                /*
                 * 三种状态各有一句话，**且都占同一行高度**（`min-height:38px`）。
                 *
                 * 🔴 暖通那句不能省（R2.2.4 实测修正）：省掉它，卡片会矮 38px，
                 *    加上提示条后又多出边距 ⇒ 下面的"客户与地址"整体上移，
                 *    切换服务类型时页面错位（这正是用户第五节明令禁止的）。
                 *    同时它回答了"为什么下面没有服务内容可选项"——
                 *    不写这句，用户会以为暖通也该选一个。
                 */
                hint={
                  type === 'hvac'
                    ? '暖通按施工阶段记录，不需要选服务内容。'
                    : type === 'service'
                      ? '按实际服务内容登记，保存后可继续补充记录。'
                      : '请选择一项服务类型。'
                }
                testId="archive-new-type"
              />

              {/*
                服务内容：**只有上门服务才出现这个字段**。
                暖通分支渲染单行六阶段提示（R2.2.4 §B），未选类型时**什么都不渲染** ——
                旧实现在这里放 72px 的 `QFUnavailableBlock` 灰块，只装一行字，
                用户原话是"留白过大、像没加载完"。

                🔴 R2.2.4 实测修正（2026-11-20）：这一块的位置决定了"切类型会不会错位"。
                   · 第一次：暖通时 `QFChoiceCard.hint` 传 `null`，那行 `min-height:38px`
                     整个不渲染 ⇒ 服务类型卡 122px（上门服务是 160px）。
                   · 第二次：把说明补回来（卡 160px、行 38px，三态同高），但提示条
                     **仍在卡片外**（`mx-4 mt-3`），于是暖通时卡片下方多出一块
                     92px + 18px 边距的盒子，而上门服务那里是两个 160px 网格。
                   · 现在：提示条**放进服务类型卡片内部**（`svc-stage-inline` 去掉
                     `mx-4` 与 `mt-3`，改由外层 `px-4 pb-3` 给边距）。
                   ⇒ 结果：卡片本体三态恒为 160px；暖通卡内部换成"六阶段提示"，
                     上沿与上门服务的「服务内容」网格**对齐**。
                     ⚠️ 卡片总高仍会不同（上门 160+160 vs 暖通 160+84），这是**设计使然**：
                        暖通没有六选一，硬凑 160px 会在提示条下面留一块空白 ——
                        那正是用户 R2.2.2 说的"留白过大、像没加载完"。
              */}
              {type === 'service' ? (
                <QFGridSelect
                  label="服务内容"
                  value={serviceType}
                  required
                  error={errors.serviceType}
                  onChange={setServiceType}
                  options={SERVICE_TYPE_OPTIONS}
                  columns={2}
                  testId="archive-new-service-type"
                />
              ) : null}
            </div>

            {/* 暖通：服务类型卡片**内部**的六阶段提示（不是卡片外的独立块） */}
            {type === 'hvac' ? (
              <div className="px-4 pt-3 pb-3">
                <VHvacStageHint testId="archive-new-hvac-intro" />
              </div>
            ) : null}
          </QFListSection>

          <QFListSection title="客户与地址">
            <div className="pt-1">
              {/*
                🔴 R2.2.1 §六：三个客户字段**全空** —— 不预填、不给示例占位符。
                   设计稿 `#screen-create` 的三个 input 都没有 placeholder。
                   理由不是"少写字"：占位符里的「如：王女士」会被真的当成
                   "应该填女士""应该填这种格式"，而客户姓名可能是任何内容。

                🔴 R2.2.2 §一：`boxed` 必须开。
                   整改前实测：三个 input 的 border-width 全是 `0px`、
                   background 全是 `rgba(0,0,0,0)`，用户看到的是一整块白色，
                   分不清哪儿能点、也看不出这是三个字段。
                   用户原话「字段没有清晰分栏和独立输入框，留白过大」。
                   `boxed` 给每个框 1px 描边 + 浅底 + 10px 圆角，间距 12px。
              */}
              <QFFormField
                label="客户姓名"
                value={name}
                onChange={setName}
                required
                boxed
                error={errors.name}
                testId="archive-new-name"
              />
              <QFFormField
                label="客户手机号"
                value={mobile}
                onChange={(v) => setMobile(v.replace(/\s/g, ''))}
                type="tel"
                inputMode="numeric"
                required
                boxed
                maxLength={11}
                error={errors.mobile}
                /*
                 * 🔴 §六 明令删除的两处：
                 *    · 占位符「11 位手机号」—— `maxLength=11` 已经在做约束，
                 *      再写一遍等于把"格式校验"伪装成"填写说明"；
                 *    · `hint="填错客户就查不到这条记录"` —— 这句是"威胁式提示"，
                 *      而它要防的错误（输错号码）**靠提示防不住**，
                 *      真正该防的是"提交前让用户再核对一眼"，那是服务端
                 *      `archiveCreate` 的客户重复检测与本页的预览块在做的事。
                 */
                testId="archive-new-mobile"
              />
              <QFFormField
                label="服务地址"
                value={address}
                onChange={setAddress}
                required
                boxed
                multiline
                error={errors.address}
                testId="archive-new-address"
              />
            </div>
          </QFListSection>

          {/* 底部固定操作区（用户第 五 节要求主按钮优先放吸底栏） */}
          <div className="h-24" />
          <StickyActionBar>
            <QFButton variant="primary" block onClick={goStep2} testId="archive-new-next">
              下一步
            </QFButton>
          </StickyActionBar>
        </>
      ) : (
        <>
          {/*
            🔴 R2.2.4 §C：「服务信息」改名「产品清单」，一段文本 → 多条目。
               用户原话：「每条产品包含 产品/型号（独立输入框）、购买日期（独立日期选择器）、
               数量（默认 1，只允许正整数）、删除；默认一条空产品；整块仍是选填」。

            ⚠️ 为什么不再是 `QFListSection title="服务信息"` + 两个 QFFormField：
               那是"一条档案只有一台设备"的假设，而业务事实是一张档案可能三台。
               把三条拼成一段文本之后，没有任何东西能可靠地按"第 2 台"取值
               （导出 CSV 只能塞一格、改第二台的日期要重新解析用户输入）。

            ⚠️ 这里**不传** `title`：`QFProductList` 自己带一个「产品清单（选填）+
               n 项已填写」的表头（那是原型里的形态，右边要放计数）。
               外面再给一个 title 会出现两个「产品清单」上下相邻 —— 实测截图上就是这样。

            ⚠️ R2.2.4-rc.2 §二：外层**不再包一层 `px-4` 内边距**。
               rc.1 的结构是「QFListSection 白卡 → px-4 → 每条产品一个白卡」，
               三层边距叠起来，产品区左右比上面的日期字段窄 32px。
               现在 `QFProductList` 的 `.svc-product-list` **自己就是那张白卡**，
               外层只留 12px 上下留白 —— 左边长出的「＋ 添加产品」仍与外卡同宽。
          */}
          <QFListSection testId="archive-new-step2-products">
            <div className="px-4 py-3">
              <QFProductList value={products} onChange={setProducts} testId="archive-new-products" />
            </div>
          </QFListSection>

          {/* 预约上门日期：只对上门服务出现（暖通六阶段各自记实际日期） */}
          {type === 'service' ? (
            <QFListSection title="上门安排" testId="archive-new-step2-plan">
              <div className="pt-1">
                {/*
                  🔴 R2.2.1 §六：**暖通第二步不显示计划上门日期**。
                     判据用 `type === 'service'`（不是"字段有没有值"）——
                     暖通各阶段单独填实际施工日期，一个"计划上门日期"会让门店
                     以为"填了这个就会按这天去"，而实际上是六个阶段逐个到场的。
                */}
                <QFFormField
                  label="预约上门日期"
                  value={planned}
                  onChange={setPlanned}
                  type="date"
                  boxed
                  error={errors.planned}
                  testId="archive-new-planned"
                />
              </div>
            </QFListSection>
          ) : null}

          {/*
            🔴 R2.2.4 §D：内部备注**只留一个标签 + 约三行输入框**。
               删掉的三样东西，每一样都是用户点名的：
                 · `footnote="只有门店和总部能看到，客户查询时不会显示。"` —— 可见性说明常驻；
                 · `placeholder="如：客户要求周末上门，家里有老人"` —— 示例文字被当成模板；
                 · 与外层重复的那一个「内部备注」标题。
               现在：**区标题**（`QFListSection title`）就是唯一标签，textarea 只靠
               `aria-label` 供读屏软件识别 —— 不再在框上方印第二遍。
               实测过的错误版本：这里保留 `<label>`，于是同一屏出现
               「内部备注」（灰色小标题）+「内部备注」（框上标签）两行相邻同文字。
          */}
          <QFListSection title="内部备注" testId="archive-new-step2-notes">
            <div className="px-4 pt-2 pb-3">
              <textarea
                id="archive-new-notes-input"
                className="svc-notes-input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={500}
                rows={3}
                aria-label="内部备注"
                data-svc-field="archive-new-notes"
                data-testid="archive-new-notes"
              />
            </div>
          </QFListSection>

          {/*
            🔴 R2.2.4 §D：「即将保存」预览区**整块删除**。
               它复述的每一个字用户都在上面刚填过（客户名、地址、类型），
               而它唯一有价值的信息 —— "保存后客户就能查到" —— 已经在
               确认弹窗里说过一次了。留着它等于在第二步末尾多占 90px，
               把「保存档案」按钮推近屏幕边缘。
          */}

          <div className="h-24" />
          <StickyActionBar>
            <div className="w-[104px]">
              <QFButton variant="tonal" block onClick={() => setStep(1)} testId="archive-new-back">
                上一步
              </QFButton>
            </div>
            <div className="flex-1">
              <QFButton variant="primary" block busy={submit.busy} onClick={() => void doSubmit()} testId="archive-new-submit">
                {submit.busy ? '保存中…' : '保存档案'}
              </QFButton>
            </div>
          </StickyActionBar>
        </>
      )}
    </AppShell>
  );
}

/* --------------------------------------------------------- 暖通六阶段提示 */

/**
 * 暖通工程的六阶段提示条（R2.2.4 §B）。
 *
 * ===========================================================================
 * 与 R2.2.1 那版大卡片的区别（这是本段的唯一目的）
 * ===========================================================================
 *   旧版：44px 插图 + 标题/副标题 + 60px 六阶段 SVG + 一排阶段名 + 警告行，
 *         整块约 200px，占了第一步的半个屏幕。用户 R2.2.2 已经说过"留白过大"，
 *         R2.2.4 §B 再次点名："选暖通后显示六阶段提示" —— 提示，不是插图。
 *   现在：一条浅蓝底的提示条，两行 —— 一句标题 + 六个阶段名（配置驱动）。
 *         实测高度约 66px，信息量与旧版相同（阶段名一个不少）。
 *
 * ⚠️ 阶段名仍然从 `svc:archiveStageConfigGet` 读，**不读 `HVAC_STAGE_META`**：
 *    后台把「管路施工」改成别的名字，这里必须跟着变。
 *    读不到时用代码默认名并明确告知是默认名 —— 不静默。
 */
function VHvacStageHint({ testId }: { testId?: string }) {
  const [stages, setStages] = useState<HvacStageConfig[]>(() => defaultStageConfig());
  const [configOk, setConfigOk] = useState(true);

  useEffect(() => {
    let alive = true;
    void fetchStageConfig().then((r) => {
      if (!alive) return;
      setStages(r.stages);
      setConfigOk(r.ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div
      className="svc-stage-inline"
      data-testid={testId}
      data-qf-control="hvac-stage-hint"
      role="status"
    >
      <strong>分阶段记录工程进度</strong>
      <span data-testid="archive-new-hvac-stages">
        {stages.map((s) => s.name).join(' · ')}
      </span>
      {!configOk ? (
        <div className="mt-1 text-[12px] text-[#8a6d3b]">阶段名称暂时读取不到，先按系统默认名显示。</div>
      ) : null}
    </div>
  );
}
