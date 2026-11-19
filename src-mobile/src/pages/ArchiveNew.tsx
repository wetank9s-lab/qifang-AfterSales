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

import { useMemo, useState } from 'react';
import { AppShell, PageHeader, StickyActionBar, findScrollContainer } from '../components/AppShell';
import { focusFirstError, validators, useBeforeUnload } from '../components/Form';
import { useSubmitGuard, useToast } from '../components/Feedback';
import {
  QFButton,
  QFFormField,
  QFGridSelect,
  QFListSection,
  QFSegmented,
  QFUnavailableBlock,
  describeQFError,
  useQFConfirm,
} from '../components/qf';
import { ArchiveApiAdapter } from '../api/archives';
import { ARCHIVE_TYPE_META, SERVICE_TYPE_OPTIONS } from '../design/qf-tokens';
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
 * 「服务内容」网格的等高占位高度。
 *
 * ⚠️ 这里是**整个网格区块**的高度，不是网格本身：
 *     标签行 20px(label) + 2px(margin) + 网格 160px + 4px(mt-1) + 错误行 22px = **208px**
 *
 *   2026-11-19 验收实测抓住了这个差：先前按"网格 160"占位，
 *   选完类型后错误行消失 ⇒ 下方内容上移 **22px**（正是那行错误文案的高度）。
 *
 *   为什么把错误行也算进来：`QFGridSelect` 与 `QFSegmented` 都有**恒定 22px 的错误行**
 *   （见 fields.tsx），未选项时它是空的但仍占位。占位块必须包含这一行，
 *   否则"切换类型"这个动作改变的是**它下面所有内容**的位置，而不是网格本身。
 *
 * ⚠️ 改这里必须同时改 `QFGridSelect` 的 `min-h-[48px]`、gap（8px）与错误行（22px）——
 *    任意一个变了，切换类型的位移判据就会变红（这是设计如此，不是误报）。
 */
const SERVICE_GRID_HEIGHT = 208;

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
  const [product, setProduct] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [planned, setPlanned] = useState('');
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);

  const dirty =
    Boolean(type || name || mobile || address || serviceType || product || purchaseDate || planned || notes);
  useBeforeUnload(dirty);

  const errors = {
    type: touched && !type ? '请选择服务类型' : null,
    name: touched && !name.trim() ? validators.required('客户姓名')('') : null,
    mobile: touched ? validators.mobile(mobile) : null,
    address: touched && !address.trim() ? validators.required('服务地址')('') : null,
    // ⚠️ 字段标签是「服务内容」，错误文案必须跟着叫同一个名字 ——
    //    否则用户按红字去找"服务类型"，而屏幕上那个「服务类型」是**另一个**已选好的字段。
    serviceType: touched && type === 'service' && !serviceType ? '请选择服务内容' : null,
    purchaseDate: touched ? validators.dateOnly(purchaseDate) : null,
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
        await ArchiveApiAdapter.create(
          {
            archive_type: type as 'service' | 'hvac',
            customer_name: name.trim(),
            customer_mobile: mobile.trim(),
            service_address: address.trim(),
            // 暖通**不传** service_type（服务端对暖通会忽略，但显式置空更清楚）
            service_type: type === 'service' ? serviceType : null,
            product_description: product.trim() || null,
            purchase_date: purchaseDate || null,
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

  const typeLabel = type === 'hvac' ? '暖通工程' : '上门服务';

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
              <QFSegmented
                label="服务类型"
                value={type}
                required
                error={errors.type}
                onChange={(v) => setType(v)}
                options={[
                  { value: 'service', label: ARCHIVE_TYPE_META.service!.label },
                  { value: 'hvac', label: ARCHIVE_TYPE_META.hvac!.label },
                ]}
                testId="archive-new-type"
              />

              {/*
                服务内容：上门服务才能选。
                暖通分支**不是**不渲染 —— 必须占住完全等高的位置，否则下方整体上移。
                文案回答"为什么这里没有可选项"，不写"请选择"。
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
              ) : type === 'hvac' ? (
                <QFUnavailableBlock height={SERVICE_GRID_HEIGHT}>
                  暖通工程按施工阶段记录（勘察、方案、管路、设备、调试、验收），不需要选服务内容。
                </QFUnavailableBlock>
              ) : (
                /*
                 * ⚠️ **一个都没选**时也要占住同样的高度。
                 *    否则"选类型"这个动作本身会让下方内容跳 160px ——
                 *    那和暖通分支漏渲染是同一个 bug，只是发生在更早一步。
                 */
                <QFUnavailableBlock height={SERVICE_GRID_HEIGHT}>
                  先选上面的服务类型。选「上门服务」后这里会出现服务内容选项。
                </QFUnavailableBlock>
              )}
            </div>
          </QFListSection>

          <QFListSection title="客户与地址">
            <div className="pt-1">
              <QFFormField
                label="客户姓名"
                value={name}
                onChange={setName}
                required
                error={errors.name}
                placeholder="如：王女士"
                testId="archive-new-name"
              />
              <QFFormField
                label="客户手机号"
                value={mobile}
                onChange={(v) => setMobile(v.replace(/\s/g, ''))}
                type="tel"
                inputMode="numeric"
                required
                maxLength={11}
                error={errors.mobile}
                placeholder="11 位手机号"
                /**
                 * ⚠️ 用户第 7.2 条：「**删除客户手机号下方的长篇解释**」。
                 *    旧文案是"客户凭这个号码查询进度，请核对后再提交"（两步动作 + 规则陈述）。
                 *    留一句就够 —— 员工真正需要知道的是"填错会怎样"。
                 */
                hint="填错客户就查不到这条记录"
                testId="archive-new-mobile"
              />
              <QFFormField
                label="服务地址"
                value={address}
                onChange={setAddress}
                required
                multiline
                error={errors.address}
                placeholder="小区 / 楼栋 / 门牌"
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
          <QFListSection title="服务内容" footnote={type === 'hvac' ? undefined : '都可以留空，之后在档案详情里补充。'}>
            <div className="pt-1">
              <QFFormField
                label="产品 / 型号"
                value={product}
                onChange={setProduct}
                placeholder="如：格力 3 匹柜机 KFR-72LW"
                testId="archive-new-product"
              />
              <QFFormField
                label="购买日期"
                value={purchaseDate}
                onChange={setPurchaseDate}
                type="date"
                error={errors.purchaseDate}
                testId="archive-new-purchase-date"
              />
              {/*
                ⚠️ 预约上门日期**只在普通上门服务时出现**（用户 7.3）。
                   暖通工程各阶段单独填实际日期，一个"计划上门日期"没有意义
                   —— 而且它会让门店以为"填了这个就会按这个日期上门"。
              */}
              {type === 'service' ? (
                <QFFormField
                  label="预约上门日期"
                  value={planned}
                  onChange={setPlanned}
                  type="date"
                  error={errors.planned}
                  hint="客户期望的上门时间，可留空"
                  testId="archive-new-planned"
                />
              ) : null}
            </div>
          </QFListSection>

          <QFListSection
            title="内部备注"
            footnote="只有门店和总部能看到，客户查询时不会显示。"
          >
            <div className="pt-1">
              <QFFormField
                label="内部备注"
                value={notes}
                onChange={setNotes}
                multiline
                maxLength={500}
                placeholder="如：客户要求周末上门，家里有老人"
                testId="archive-new-notes"
              />
            </div>
          </QFListSection>

          {/* 即将保存预览 */}
          <div className="px-4 pt-4">
            <div className="bg-svc-surface-2 rounded-svc px-4 py-3" data-testid="archive-new-preview">
              <div className="text-svc-ink-3 qf-foot mb-1">即将保存</div>
              <div className="text-svc-ink qf-body font-medium">{name || '未填客户姓名'}</div>
              <div className="text-svc-ink-2 qf-foot mt-0.5">{address || '未填服务地址'}</div>
              <div className="text-svc-ink-2 qf-foot mt-1">
                {typeLabel}
                {type === 'service' && serviceType
                  ? ` · ${SERVICE_TYPE_OPTIONS.find((o) => o.value === serviceType)?.label ?? serviceType}`
                  : ''}
              </div>
            </div>
          </div>

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
