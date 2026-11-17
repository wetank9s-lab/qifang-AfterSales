/**
 * B 页之二：新建服务档案（分两步，但**提交参数与校验完全遵循原接口**）。
 *
 * ===========================================================================
 * 为什么拆两步
 * ===========================================================================
 *   一次性长表单在手机上要滚 3 屏，用户滚到"服务地址"时已经忘了第一屏填了什么；
 *   更糟的是**底部主按钮始终在屏幕外**，用户不知道下一步该点哪。
 *
 *   ⇒ 第一步 = "给谁做"（客户 + 地址 + 类型），第二步 = "做什么"（服务内容/备注）。
 *     拆步骤**只影响展示**：提交仍然是一次 `svc:archiveCreate`，参数名与后端契约一字不差。
 *     ⚠️ 千万不要为了"更自然的表单"把参数拆成两次提交 ——
 *        那会让"只填了一半的档案"落库，而服务端没有草稿态可言。
 *
 * ===========================================================================
 * 两个必须做的细节
 * ===========================================================================
 *   ① **X-Request-Id 在打开表单时生成一次**：
 *      它是服务端的幂等键（`${userId}:${requestId}` 唯一约束）。
 *      每次点提交都生成新的 ⇒ 网络超时后用户重试会**建出第二张档案**。
 *      实测这条约束在服务端是真生效的（`archive_create` + idempotencyRecords）。
 *
 *   ② **普通服务必须有 service_type，暖通没有这个字段**：
 *      服务端 `ARCHIVE_MISSING_FIELD`（400）。前端提前拦是为了少一次
 *      "填完三屏才被拒"的体验；判定权仍在服务端。
 */

import { useMemo, useState } from 'react';
import { Button } from 'konsta/react';
import { AppShell, PageHeader, StickyActionBar, findScrollContainer } from '../components/AppShell';
import { Field, FieldGroup, SegmentedField, focusFirstError, validators, useBeforeUnload } from '../components/Form';
import { useConfirm, useSubmitGuard, useToast, describeError } from '../components/Feedback';
import { ServiceStatusBadge } from '../components/Feedback';
import { ArchiveApiAdapter } from '../api/archives';
import { SERVICE_TYPE_OPTIONS } from '../design/tokens';
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

export function ArchiveNewPage({ presetType }: { presetType?: string }) {
  const { caps } = useSession();

  // 权限入口在列表页已经判过；这里再判一次是防"直接输 URL 进来"
  // （服务端仍会 403，但让用户看到"没权限"比"填完被拒"好）
  if (!caps.archiveCreate) {
    return (
      <AppShell>
        <PageHeader title="新建档案" back />
        <div className="px-6 py-16 text-center">
          <div className="text-svc-ink text-[15px] font-medium">当前账号不能新建档案</div>
          <div className="text-svc-ink-2 mt-2 text-[13px] leading-relaxed">
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
  const confirm = useConfirm();
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
  const [planned, setPlanned] = useState('');
  const [publicNote, setPublicNote] = useState('');
  const [touched, setTouched] = useState(false);

  const dirty =
    Boolean(type || name || mobile || address || serviceType || product || planned || publicNote);
  useBeforeUnload(dirty);

  const errors = {
    type: touched && !type ? '请选择服务类型' : null,
    name: touched && !name.trim() ? validators.required('客户姓名')('') : null,
    mobile: touched ? validators.mobile(mobile) : null,
    address: touched && !address.trim() ? validators.required('服务地址')('') : null,
    // ⚠️ 字段标签是「服务内容」（见下方 JSX 注释：避免同屏两个"服务类型"），
    //    错误文案必须跟着叫同一个名字 —— 否则用户按红字去找"服务类型"，
    //    而屏幕上那个「服务类型」是**另一个**已选好的字段（分组标题那格）。
    serviceType: touched && type === 'service' && !serviceType ? '请选择服务内容' : null,
    planned: touched ? validators.dateOnly(planned) : null,
  };

  const step1Ok =
    Boolean(type) && Boolean(name.trim()) && !validators.mobile(mobile) && Boolean(address.trim()) &&
    (type !== 'service' || Boolean(serviceType));

  /**
   * 校验失败时：把用户带到**第一个**要改的字段。
   *
   * ⚠️ 之后才 toast —— 顺序反过来（先 toast）会让 2.2 秒的提示与滚屏同时发生，
   *    用户的视线正在移动，等于没看到提示。
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
    // ⚠️ 用 findScrollContainer 而不是 querySelector('.k-page') ——
    //    `.k-page` 只是外壳，它 scrollHeight === clientHeight，根本不滚，
    //    这行原先是**空转**的（见 AppShell.findScrollContainer 的实测记录）。
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

    const ok = await confirm.ask({
      title: '确认提交建档？',
      content: (
        <div className="text-[13px] leading-relaxed">
          将创建一条<strong>{type === 'hvac' ? '暖通工程' : '上门服务'}</strong>档案。
          <br />
          提交后档案为<strong>草稿</strong>状态，客户暂时看不到；完成并发布后客户才能查询到。
        </div>
      ),
      confirmText: '提交',
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
            planned_date: planned || null,
            public_note: publicNote.trim() || null,
          },
          requestId,
        );
        // replace 而不是 push：返回键应回到列表，而不是回到"已提交的表单"
        navigate('/archives', { replace: true });
      } catch (e) {
        const info = describeError(e);
        // 幂等冲突（同一 requestId 回放）也要说清楚，否则用户会以为"没成功"
        toast.show(info.message, 'danger');
      }
    });
  };

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
          {/*
            第一阶段 =「填写客户信息」（用户指定措辞）。

            措辞统一：
              · 第一组问**做什么业务**（上门服务 / 暖通工程）。原来这里有两套名字 ——
                分组标题叫「档案类型」、字段标签叫「类型」，是同一个概念的两个名字，
                员工得自己推断"这俩是一回事"。⇒ 统一为「服务类型」。
              · 第二组问**具体服务内容**（送货安装 / 维修检测…）。它原本也叫「服务类型」，
                统一之后两者会**同名**，所以把它改成「服务内容」——
                按选项的实际含义命名（这些都是"做什么活"，不是"哪一类业务"），
                而不是让同一个屏幕上出现两个「服务类型」让用户猜区别。
          */}
          <FieldGroup title="填写客户信息">
            <SegmentedField
              label="服务类型"
              value={type}
              required
              error={errors.type}
              onChange={(v) => setType(v)}
              options={[
                // 「普通上门服务」→「上门服务」：卡片标题里也只有"上门服务"，两处必须一致
                { value: 'service', label: '上门服务' },
                { value: 'hvac', label: '暖通工程' },
              ]}
              testId="archive-new-type"
            />
            {type === 'service' ? (
              <SegmentedField
                label="服务内容"
                value={serviceType}
                required
                error={errors.serviceType}
                onChange={setServiceType}
                options={SERVICE_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                testId="archive-new-service-type"
              />
            ) : null}
          </FieldGroup>

          <FieldGroup title="客户与地址">
            <Field
              label="客户姓名"
              value={name}
              onChange={(v) => setName(v)}
              required
              error={errors.name}
              placeholder="如：王女士"
              testId="archive-new-name"
            />
            <Field
              label="客户手机号"
              value={mobile}
              onChange={(v) => setMobile(v.replace(/\s/g, ''))}
              type="tel"
              inputMode="numeric"
              required
              maxLength={11}
              error={errors.mobile}
              placeholder="11 位手机号"
              // 用户要求"用普通人能理解的话"：原句"客户凭这个号码查询进度，请核对后再提交"
              // 说的是"凭"和"核对"两个动作，而员工真正需要知道的是"这号码干嘛用的"。
              hint="客户以后用这个号码查进度，填错就查不到了"
              testId="archive-new-mobile"
            />
            <Field
              label="服务地址"
              value={address}
              onChange={(v) => setAddress(v)}
              required
              multiline
              error={errors.address}
              placeholder="小区 / 楼栋 / 门牌"
              testId="archive-new-address"
            />
          </FieldGroup>

          {/*
            底部固定操作区（用户要求"下一步按钮优先采用底部固定操作区"）。
            原来它是页面里一个普通的内联按钮（`px-4 py-3`），
            填到"服务地址"这一格时按钮已经被键盘和内容顶到屏幕外，
            于是"点了没反应"——实际是根本没点到。

            与第二步的「上一步 / 提交建档」用**同一个组件**，
            这样两步的主操作在同一个位置、同一个高度，形成肌肉记忆。
          */}
          <div className="h-24" />
          <StickyActionBar>
            <Button className="flex-1" large onClick={goStep2} data-testid="archive-new-next">
              下一步
            </Button>
          </StickyActionBar>
        </>
      ) : (
        <>
          <FieldGroup title="服务内容">
            <Field
              label="产品 / 机型"
              value={product}
              onChange={setProduct}
              placeholder="如：格力 3 匹柜机 KFR-72LW"
              testId="archive-new-product"
            />
            <Field
              label="计划上门日期"
              value={planned}
              onChange={setPlanned}
              type="date"
              error={errors.planned}
              hint="可留空，后续在详情里补充"
              testId="archive-new-planned"
            />
            <Field
              label="客户可见备注"
              value={publicNote}
              onChange={setPublicNote}
              multiline
              placeholder="发布后客户能看到这段说明"
              hint="内部说明请勿写在这里（它会在发布后对客户可见）"
              testId="archive-new-public-note"
            />
          </FieldGroup>

          <div className="px-4 pt-3">
            <div className="bg-svc-surface-2 rounded-svc px-3 py-2.5">
              <div className="text-svc-ink-3 mb-1 text-[11px]">即将提交</div>
              {/*
                ⚠️ 这里**不印 '—'**（用户第三节）。
                   "即将提交"是一个**预览块**：它的作用是让员工在按下提交前
                   确认"是不是这条客户"。一个「—」既不说明缺了什么，
                   也不提示该回上一步补 —— 而"未填"两个字直接告诉他下一步做什么。
                   （两种写法都是 2 个字符宽，不改变布局。）
              */}
              <div className="text-svc-ink text-[13px]">{name || '未填客户姓名'}</div>
              <div className="text-svc-ink-2 text-[12px]">{address || '未填服务地址'}</div>
              <div className="mt-1.5 flex items-center gap-2">
                <ServiceStatusBadge label={type === 'hvac' ? '暖通工程' : '上门服务'} tone="brand" size="sm" />
                <ServiceStatusBadge label="提交后为草稿" tone="neutral" size="sm" />
              </div>
            </div>
          </div>

          <div className="h-24" />
          <StickyActionBar>
            <Button tonal onClick={() => setStep(1)} className="flex-1" data-testid="archive-new-back">
              上一步
            </Button>
            <Button className="flex-[2]" large disabled={submit.busy} onClick={() => void doSubmit()} data-testid="archive-new-submit">
              {submit.busy ? '提交中…' : '提交建档'}
            </Button>
          </StickyActionBar>
        </>
      )}
    </AppShell>
  );
}
