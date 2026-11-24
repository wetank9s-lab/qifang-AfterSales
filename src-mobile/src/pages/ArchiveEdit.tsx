/**
 * 编辑服务档案（R2.2.4-rc.2 · 用户 §三「普通上门服务必须可以随时修改」）。
 *
 * ===========================================================================
 * 为什么这一页是"必须"的，而不是"锦上添花"
 * ===========================================================================
 *   用户原话：
 *     「不得因为档案已经创建，就要求销售重新创建一条档案才能修改日期或产品。」
 *
 *   在此之前，移动端只有「新建档案」和「阶段完成/修改」两个写入口，
 *   档案主体的日期、服务内容、产品清单**建完就改不动**。
 *   一线真实场景：客户临时改期、销售把型号录错一个字、实际提前上门 ——
 *   旧流程下这些都要"作废重开一张"，而作废会连带客户侧查询记录消失。
 *
 * ===========================================================================
 * 计划日期 / 实际日期：两列，谁都不覆盖谁
 * ===========================================================================
 *   用户给的例子：「原计划 2026-11-28、实际提前 11-26」
 *     ⇒ `planned_date = 2026-11-28`、`service_date = 2026-11-26`
 *   也允许「提前调整计划」：把 `planned_date` 改成 11-26，此时 `service_date` 不动。
 *
 *   ⚠️ 所以页面上是**两个独立日期控件**，绝不做"改了一个自动同步另一个"：
 *      那会让上面两种业务语义塌缩成同一个结果，用户再也无法表达
 *      "计划改了，但实际还是那天"这种真实情况。
 *
 *   ⚠️ `completed_at` **不进本页**：它是完工动作的产物（时分秒 + 推进状态），
 *      改它等于篡改状态流转证据。服务端 `ARCHIVE_UPDATE_DATE_ONLY` 里也没有它。
 *
 *   ⚠️ **编辑上门日期 ≠ 执行完工操作**：保存日期不会改 `status`，
 *      也不会写 `completed_at`。要做到 completed 只能走详情页的完工动作
 *      （那里有照片校验 + 状态机）。这是用户明确要求的分界。
 *
 * ===========================================================================
 * 三条硬约束（都在服务端兜底，这里只是"让用户提前知道"）
 * ===========================================================================
 *   ① `expected_version` 必传：并发修改时后保存的会被 409 拦住。
 *      前端**不自己判断**"有没有别人改过" —— 那是服务端的事。
 *   ② 字段未提交即不改动：所以本页**只提交用户真正动过的字段**
 *      （见 `buildPatch` 的 `changed()`）。整份提交会把"我没动手机号"
 *      变成"我把手机号写回去了"，一旦中间有人改过，就打回去了。
 *   ③ 可选字段明确清空才清空：日期清空 ⇒ `null`；备注清空 ⇒ `null`；
 *      必填项清空 ⇒ 前端先拦（服务端也会 400）。
 *
 * ===========================================================================
 * 手机号显示
 * ===========================================================================
 *   🔴 服务端 `archive-read-scope.ts` 已按门店范围决定
 *      `customer_mobile_visible`：本店销售拿完整 11 位，其他角色拿 `null`。
 *      本页**按这个标记决定是否回填**，不再自己打码 ——
 *      打了码之后用户一保存就把真实号码写成了 `139****5678`（服务端 400 手机号格式错），
 *      或者更糟：把掩码当新值存进另一个字段。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell, PageHeader, StickyActionBar } from '../components/AppShell';
import { focusFirstError, useBeforeUnload, validators } from '../components/Form';
import { useSubmitGuard, useToast } from '../components/Feedback';
import {
  QFButton,
  QFErrorState,
  QFFormField,
  QFGridSelect,
  QFListSection,
  QFLoadingSkeleton,
  QFProductList,
  describeQFError,
  newProductDraft,
  toProductPayload,
  useQFConfirm,
  type QFProductDraft,
} from '../components/qf';
import {
  ArchiveApiAdapter,
  type ArchiveRow,
  type ArchiveUpdateInput,
} from '../api/archives';
import { SERVICE_TYPE_OPTIONS } from '../design/qf-tokens';
import { newRequestId } from '../api/http';
import { navigate } from '../router';
import { useSession } from '../app/session-context';

/** 校验失败时按这个顺序找第一个要改的字段（与页面视觉顺序一致） */
const FIELD_ORDER = [
  'archive-edit-name',
  'archive-edit-mobile',
  'archive-edit-address',
];

/** 把 `YYYY-MM-DD`（或 null）落成受控 input 需要的字符串 */
const dstr = (v: string | null | undefined): string => String(v ?? '').slice(0, 10);

/**
 * 只把"真的变了"的字段放进 patch。
 *
 * ⚠️ 为什么不是整份提交：
 *    整份提交 = 把页面上看到的每一个值都写回服务端。
 *    若两次编辑之间别人改过其中一个字段（例如总部改了服务地址），
 *    本页保存时会把**旧地址**写回去 —— 看起来"用户改的是日期"，
 *    实际把别人的修改静默抹掉了。
 *    `expected_version` 能挡住这种情况（409），但那条路会让用户白填一次；
 *    只提交变化字段，则这类冲突**根本不会发生**。
 */
function changed(original: string | null | undefined, next: string): string | null {
  const a = dstr(original);
  const b = next.trim();
  return a === b ? null : b;
}

export function ArchiveEditPage({ id }: { id: string }) {
  const { caps } = useSession();

  // 权限入口在详情页已经判过；这里再判一次是防"直接输 URL 进来"
  if (!caps.archiveCreate) {
    return (
      <AppShell>
        <PageHeader title="编辑档案" back />
        <div className="px-6 py-16 text-center">
          <div className="text-svc-ink qf-body font-medium">当前账号不能编辑档案</div>
          <div className="text-svc-ink-2 qf-foot mt-2 leading-relaxed">
            档案编辑只对门店销售开放。如果需要，请联系门店负责人或总部管理员调整角色。
          </div>
        </div>
      </AppShell>
    );
  }

  return <ArchiveEditForm id={id} />;
}

function ArchiveEditForm({ id }: { id: string }) {
  const toast = useToast();
  const confirm = useQFConfirm();
  const submit = useSubmitGuard();

  const [row, setRow] = useState<ArchiveRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  /* ---- 表单态（初始为 ''，加载完成后回填） ---- */
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [address, setAddress] = useState('');
  const [serviceType, setServiceType] = useState('');
  const [planned, setPlanned] = useState('');
  const [actual, setActual] = useState('');
  const [notes, setNotes] = useState('');
  const [products, setProducts] = useState<QFProductDraft[]>([]);
  /**
   * 产品清单是否成功读过。
   *
   * ⚠️ 与 `products.length` 分开：读失败时 `products` 会是 `[空行]`，
   *    看着像"还没有产品"。若此时允许保存，用户一点就把真实清单清空了。
   *    ⇒ 失败 ⇒ 禁用提交并提示重新加载。
   */
  const [productsLoaded, setProductsLoaded] = useState(true);
  /**
   * 产品清单的**初始快照**（加载完成那一刻冻结成 JSON 字符串）。
   *
   * ⚠️ 判"清单有没有被改过"必须拿它比，而不是拿 `row.product_description`：
   *    旧列只有第一条，三台设备时永远不相等 ⇒ 每次保存都整表替换。
   *    整表替换本身不丢数据，但会推进一次不必要的 version，
   *    并在事件表里多一条"清单已改"的假记录。
   */
  const [initialProducts, setInitialProducts] = useState<string>('[]');

  /**
   * 手机号是否可编辑。
   *
   * 🔴 只有服务端说 `customer_mobile_visible === true` 才回填与提交。
   *    `false` ⇒ 无权查看 ⇒ 本页**不显示这一栏**（不是显示掩码）。
   *    这与 `ARCHIVE_MOBILE_READABLE_ROLES = ['store_sales']` + 门店范围一致：
   *    店长/总部进本页看不到手机号，也不会因为"留空"而把它清掉 ——
   *    因为这一栏根本不提交（键不出现 = 不改）。
   */
  const mobileVisible = row?.customer_mobile_visible === true;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await ArchiveApiAdapter.get(id);
      if (!r) {
        setRow(null);
        setError({ status: 404 });
        return;
      }
      setRow(r);
      setName(r.customer_name ?? '');
      // 无权查看 ⇒ 强制留空，避免把服务端没给的 null 当成"客户没填"再写回去
      setMobile(r.customer_mobile_visible === true ? r.customer_mobile ?? '' : '');
      setAddress(r.service_address ?? '');
      setServiceType(r.service_type ?? '');
      setPlanned(dstr(r.planned_date));
      setActual(dstr(r.service_date));
      setNotes(r.notes ?? '');

      /**
       * 产品清单单独一次请求。
       *
       * ⚠️ 读失败**不要**当成"没有产品"：
       *    那会让本页显示"产品 0 项"，用户一保存就把真实清单清空。
       *    ⇒ 失败时**保留空数组但禁用提交**（`productsLoaded` 标记），
       *      让人看到"清单读取失败，请重试"，而不是一个静默的清空。
       */
      let list: Array<{ product_name: string | null; purchase_date: string | null; quantity: number }> = [];
      try {
        list = await ArchiveApiAdapter.products(id);
        setProductsLoaded(true);
      } catch {
        setProductsLoaded(false);
        // 旧列兜底：迁移前的老档案在清单表里可能没有行
        if (r.product_description || r.purchase_date) {
          list = [
            { product_name: r.product_description ?? null, purchase_date: r.purchase_date ?? null, quantity: 1 },
          ];
        }
      }
      setProducts(
        list.length > 0
          ? list.map((p) => ({
              key: newProductDraft().key,
              product_name: p.product_name ?? '',
              purchase_date: dstr(p.purchase_date),
              quantity: String(p.quantity ?? 1),
            }))
          : // 一条产品都没有时给一条空行，与新建页的默认形态一致
            [newProductDraft()],
      );
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 加载成功后**只冻结一次**清单快照。
   *
   * ⚠️ 依赖只有 `loading`：如果依赖 `products`，用户每改一个字快照都会跟着变，
   *    "清单被改过"就永远判不出来（`initialProducts` 恒等于当前值）。
   */
  useEffect(() => {
    if (loading) return;
    setInitialProducts(JSON.stringify(toProductPayload(products)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  /**
   * 脏检查：只要有任何一项与快照不同就算脏。
   *
   * ⚠️ 产品清单也必须算进去：用户加了一台设备然后按返回，
   *    没有二次确认就等于静默丢输入（与新建页同一条规则）。
   */
  const dirty = useMemo(() => {
    if (!row) return false;
    return (
      changed(row.customer_name, name) !== null ||
      (mobileVisible && changed(row.customer_mobile, mobile) !== null) ||
      changed(row.service_address, address) !== null ||
      (String(row.archive_type ?? '') !== 'hvac' && changed(row.service_type, serviceType) !== null) ||
      changed(row.planned_date, planned) !== null ||
      changed(row.service_date, actual) !== null ||
      changed(row.notes, notes) !== null ||
      // 产品清单必须算进去：加了设备再按返回，没有二次确认就是静默丢输入
      JSON.stringify(toProductPayload(products)) !== initialProducts
    );
  }, [row, name, mobile, address, serviceType, planned, actual, notes, products, mobileVisible, initialProducts]);
  useBeforeUnload(dirty);

  const [touched, setTouched] = useState(false);
  const errors = {
    name: touched && !name.trim() ? validators.required('客户姓名')('') : null,
    mobile: touched && mobileVisible ? validators.mobile(mobile) : null,
    address: touched && !address.trim() ? validators.required('服务地址')('') : null,
    planned: touched ? validators.dateOnly(planned) : null,
    actual: touched ? validators.dateOnly(actual) : null,
  };
  const formOk =
    Boolean(name.trim()) &&
    (!mobileVisible || !validators.mobile(mobile)) &&
    Boolean(address.trim()) &&
    !errors.planned &&
    !errors.actual;

  const doSave = async () => {
    setTouched(true);
    if (!formOk) {
      focusFirstError([...FIELD_ORDER]);
      toast.show('请先补全标红的必填项', 'warning');
      return;
    }
    if (!productsLoaded) {
      toast.show('产品清单没有读取成功，请重新加载后再保存', 'danger');
      return;
    }

    const ok = await confirm.ask({
      title: '保存修改？',
      message:
        row?.status === 'completed'
          ? '这条档案已完工，保存只会更正记录内容，不会退回或推进服务状态。'
          : '保存后立即生效，客户用手机号查询时看到的就是修改后的内容。',
      confirmText: '保存修改',
    });
    if (!ok) return;

    await submit.run(async () => {
      try {
        const body: ArchiveUpdateInput = {
          // 乐观锁：值来自本次加载的 row.version
          expected_version: Number(row?.version ?? 0),
        };

        const nName = changed(row?.customer_name, name);
        if (nName !== null) body.customer_name = nName;

        // 只有能看到手机号才可能"改了手机号"；看不到时这个键**完全不出现**
        if (mobileVisible) {
          const nMob = changed(row?.customer_mobile, mobile);
          if (nMob !== null) body.customer_mobile = nMob;
        }

        const nAddr = changed(row?.service_address, address);
        if (nAddr !== null) body.service_address = nAddr;

        // service_type 对暖通无意义（服务端不接受），只在普通上门服务时提交
        if (row?.archive_type !== 'hvac') {
          const nType = changed(row?.service_type, serviceType);
          if (nType !== null) body.service_type = nType;
        }

        /*
         * 🔴 两个日期**分别判断、分别提交**。
         *    写成 `body.planned_date = planned || null` 会把"没改"变成"清空"，
         *    更糟的是有人会把"实际日期没填"顺手补成计划日期 —— 那是伪造。
         */
        const nPlanned = changed(row?.planned_date, planned);
        if (nPlanned !== null) body.planned_date = nPlanned || null;

        const nActual = changed(row?.service_date, actual);
        if (nActual !== null) body.service_date = nActual || null;

        const nNotes = changed(row?.notes, notes);
        if (nNotes !== null) body.notes = nNotes || null;

        /*
         * 产品清单：三态语义由服务端分流
         *   · 键不出现 ⇒ 不动清单
         *   · []       ⇒ 明确清空（用户把产品全删了）
         *   · 数组     ⇒ 整表替换
         * ⇒ 这里只在**真的变了**时才带这个键。用户只改日期时不带，
         *   避免"整表替换"把别人刚加的产品顶掉。
         */
        const nextProducts = toProductPayload(products);
        if (JSON.stringify(nextProducts) !== initialProducts) {
          body.products = nextProducts;
        }

        // 一个字段都没变：不发请求，也不报"保存成功"（那会让人以为改了
        // 而且会白推进一次 version）
        if (Object.keys(body).length === 1) {
          toast.show('没有需要保存的修改');
          navigate(`/archives/${id}`, { replace: true });
          return;
        }

        await ArchiveApiAdapter.update(id, body, newRequestId());
        toast.show('修改已保存');
        // replace：返回键应回到详情页，而不是回到"已保存的表单"
        navigate(`/archives/${id}`, { replace: true });
      } catch (e) {
        const info = describeQFError(e);
        /*
         * 409（ARCHIVE_STALE）的处理：**不切页、不清表单**。
         * 用户填的内容还在，让他核对后再决定是否重新加载 ——
         * 服务端文案已经写明"你填写的当前内容仍在页面上"。
         */
        toast.show(info.message, 'danger');
      }
    });
  };

  /** 产品清单初始快照（加载完成时冻结），用于判"清单是否被改过" */
  const isHvac = String(row?.archive_type ?? '') === 'hvac';

  if (loading) {
    return (
      <AppShell>
        <PageHeader title="编辑档案" back />
        <QFLoadingSkeleton rows={4} label="正在加载档案" />
      </AppShell>
    );
  }

  if (error || !row) {
    return (
      <AppShell>
        <PageHeader title="编辑档案" back />
        <QFErrorState
          info={describeQFError(error)}
          onRetry={() => void load()}
          onBack={() => navigate(`/archives/${id}`)}
          testId="archive-edit-error"
        />
      </AppShell>
    );
  }

  return (
    <AppShell>
      {toast.node}
      <PageHeader title="编辑档案" subtitle={row.archive_no || `#${row.id}`} back />

      {/*
        ⚠️ 已完工提示：**不是**警告，是说明。
           用户 §三 明确"包括完工后的信息纠错"，所以这里不能写成
           "已完工，不可修改"（那等于把用户刚批准的能力又收回）。
      */}
      {row.status === 'completed' ? (
        <div className="px-4 pt-3" data-archive-completed-hint>
          <div className="svc-stage-inline">
            <strong>这条档案已完工</strong>
            这里只更正记录内容（日期、服务内容、产品清单等），不会改变服务状态，也不会退回或推进进度。
          </div>
        </div>
      ) : null}

      <QFListSection title="客户与地址">
        <div className="pt-1">
          <QFFormField
            label="客户姓名"
            value={name}
            onChange={setName}
            required
            boxed
            error={errors.name}
            testId="archive-edit-name"
          />
          {/*
            🔴 无权查看时**整行不渲染**（不是填掩码、不是 disabled）：
               disabled 输入框里写着 139****5678，用户会以为"这就是客户的号码"，
               截屏发出去也照样泄露格式。不渲染是最干净的边界。
          */}
          {mobileVisible ? (
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
              testId="archive-edit-mobile"
            />
          ) : null}
          <QFFormField
            label="服务地址"
            value={address}
            onChange={setAddress}
            required
            boxed
            multiline
            error={errors.address}
            testId="archive-edit-address"
          />
        </div>
      </QFListSection>

      {/*
        服务内容：普通上门服务才有。暖通按六个阶段记录，没有"服务内容"这个概念。
        ⚠️ 不渲染 ≠ 提交空值：`body.service_type` 在暖通时根本不出现，服务端就不动这一列。
      */}
      {!isHvac ? (
        <QFListSection title="服务内容" testId="archive-edit-service-type">
          <div className="pt-1">
            <QFGridSelect
              label=""
              value={serviceType}
              options={SERVICE_TYPE_OPTIONS}
              onChange={(v) => setServiceType(v)}
              columns={2}
              testId="archive-edit-service-type-grid"
            />
          </div>
        </QFListSection>
      ) : null}

      <QFListSection testId="archive-edit-products">
        <div className="px-4 py-3">
          <QFProductList
            value={products}
            onChange={setProducts}
            testId="archive-edit-products-list"
          />
        </div>
      </QFListSection>

      {/*
        上门日期：**两个独立控件**，任何一方都不自动同步另一方。
        ⚠️ 暖通不显示（各阶段单独记实际日期），与新建页同一判据：看 `archive_type`。
      */}
      {!isHvac ? (
        <QFListSection title="上门日期" testId="archive-edit-dates">
          <div className="pt-1">
            <QFFormField
              label="计划上门日期"
              value={planned}
              onChange={setPlanned}
              type="date"
              boxed
              error={errors.planned}
              testId="archive-edit-planned"
            />
            <QFFormField
              label="实际服务日期"
              value={actual}
              onChange={setActual}
              type="date"
              boxed
              error={errors.actual}
              testId="archive-edit-actual"
            />
            {/*
              一句解释放在两个日期下方，而不是各写一遍：
              写两遍会让两组说明互相冲突（"可以早于计划"只属于实际日期那一格）。
            */}
            <div className="text-svc-ink-3 qf-foot px-1 pb-3 leading-relaxed">
              实际可以早于计划。填写实际日期只是记录，不会改变服务状态。
            </div>
          </div>
        </QFListSection>
      ) : null}

      <QFListSection title="内部备注" testId="archive-edit-notes">
        <div className="px-4 pt-2 pb-3">
          <textarea
            id="archive-edit-notes-input"
            className="svc-notes-input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={500}
            rows={3}
            aria-label="内部备注"
            data-svc-field="archive-edit-notes"
            data-testid="archive-edit-notes"
          />
        </div>
      </QFListSection>

      <div className="h-24" />
      <StickyActionBar>
        <div className="flex-1">
          <QFButton
            variant="secondary"
            block
            onClick={() => navigate(`/archives/${id}`)}
            testId="archive-edit-cancel"
          >
            取消
          </QFButton>
        </div>
        <div className="flex-1">
          <QFButton
            variant="primary"
            block
            busy={submit.busy}
            onClick={() => void doSave()}
            testId="archive-edit-save"
          >
            保存修改
          </QFButton>
        </div>
      </StickyActionBar>
    </AppShell>
  );
}
