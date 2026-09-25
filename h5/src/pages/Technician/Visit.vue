<template>
  <div class="svc-page">
    <!-- ============================ 加载中 ============================ -->
    <template v-if="view === 'loading'">
      <header class="svc-header">
        <h1>上门作业</h1>
        <p>正在读取工单信息…</p>
      </header>
    </template>

    <!-- ============================ 链接不可用 ============================ -->
    <template v-else-if="view === 'invalid'">
      <header class="svc-header">
        <h1>链接不可用</h1>
      </header>
      <div class="svc-alert danger">
        {{ invalidMessage }}
      </div>
      <p class="svc-hint">
        请与门店核对后，让门店重新发送一条作业短信。<br />
        若您已经提交过本次作业，则无需再次操作。
      </p>
    </template>

    <!-- ============================ 提交成功（终态） ============================ -->
    <template v-else-if="view === 'success'">
      <div class="svc-success">
        <div class="svc-success-mark" aria-hidden="true">✓</div>
        <!--
          ⚠️ 终态文案**用服务端给的**（`outcome.message`），不在这里手写。
          服务端口径是「已提交，等待门店确认」，**绝不能**出现"工单已完成"——
          师傅提交只把工单推到 WAIT_STORE_CONFIRM，后面还有门店确认与客户评价。
          说"已完成"会让师傅直接走人、客户以为事情办完了。
          这里连兜底值都写成同一句（`api/technician.ts` 的默认值），
          保证"服务端漏给 message"时也不会退化成一句暗示闭环的话。
        -->
        <h1>{{ outcome?.message || '已提交，等待门店确认' }}</h1>
        <div class="svc-ticketno">{{ outcome?.ticket_no || ctx?.ticket_no }}</div>
        <p class="svc-meta">本次作业已记录，门店会尽快确认处理结果。</p>
        <p class="svc-hint">作业链接已失效，无需重复提交。</p>
      </div>
    </template>

    <!-- ============================ 作业页 ============================ -->
    <template v-else>
      <header class="svc-header">
        <h1>上门作业</h1>
        <p>{{ ctx?.store_name }}</p>
      </header>

      <div v-if="banner" class="svc-alert" :class="banner.kind">{{ banner.text }}</div>

      <!-- ---- 工单信息：**只有完成任务所需的最小信息** ---- -->
      <section class="svc-card">
        <div class="svc-row">
          <span class="svc-row-key">工单号</span>
          <span class="svc-row-val svc-ticketno">{{ ctx?.ticket_no }}</span>
        </div>
        <div class="svc-row">
          <span class="svc-row-key">服务门店</span>
          <span class="svc-row-val">{{ ctx?.store_name }}</span>
        </div>
        <div class="svc-row">
          <span class="svc-row-key">预计上门</span>
          <span class="svc-row-val">{{ expectedDate }}</span>
        </div>
        <div class="svc-row is-block">
          <span class="svc-row-key">问题描述</span>
          <p class="svc-row-text">{{ ctx?.content }}</p>
        </div>
        <!--
          刻意**不**渲染客户姓名 / 手机号：师傅联系客户走门店，不由本页派号
          （docs/API.md §2.1）。服务端 `get` 也压根没查这些字段 ——
          前端不渲染是第二道闸，第一道在服务端。
        -->
      </section>

      <!-- ---- 现场照片 ---- -->
      <section class="svc-card">
        <div class="svc-field">
          <span class="svc-label">
            现场照片
            <span class="svc-count">{{ photoCount }} / {{ ctx?.max_photos }}</span>
          </span>

          <ul v-if="photos.length" class="svc-photos">
            <li v-for="p in photos" :key="p.ref" class="svc-photo">
              <!--
                `referrerpolicy="no-referrer"`：图片 URL 里带着作业 Token，
                不设的话它会被写进 Referer 发给第三方（以及本站日志）。
                这里再兜一道，不依赖 nginx 的 Referrer-Policy。
              -->
              <img
                :src="url(p.ref)"
                alt="现场照片"
                referrerpolicy="no-referrer"
                @error="onImageError(p.ref)"
              />
              <button
                v-if="!submitting"
                type="button"
                class="svc-photo-del"
                aria-label="删除这张照片"
                @click="removeLocal(p.ref)"
              >
                ×
              </button>
            </li>
          </ul>

          <p v-if="photoCount === 0" class="svc-hint">
            请至少上传 1 张现场照片后才能提交。
          </p>
          <p v-else class="svc-hint">
            刷新页面不会丢失已上传的照片；可以在提交前继续补拍。
          </p>

          <label v-if="canUpload" class="svc-photo-add">
            <input
              type="file"
              accept="image/*"
              :disabled="uploading"
              @change="onPick"
            />
            <span>{{ uploading ? '上传中…' : '＋ 拍照 / 选择照片' }}</span>
          </label>
          <p v-else-if="photoCount >= (ctx?.max_photos ?? 0)" class="svc-hint">
            已达上限 {{ ctx?.max_photos }} 张，如需更换请先删除一张。
          </p>

          <div v-if="uploadError" class="svc-error">{{ uploadError }}</div>
          <p class="svc-hint">单张不超过 {{ ctx?.max_photo_size_mb }}MB，支持 JPG / PNG / WebP。</p>
        </div>
      </section>

      <!-- ---- 处理回执 ---- -->
      <form class="svc-card" novalidate @submit.prevent="onSubmit">
        <!-- 处理结果：**枚举锁定**，只能从这里选，页面不给自由输入 -->
        <div class="svc-field">
          <span class="svc-label">处理结果<span class="svc-req">*</span></span>
          <div class="svc-segment is-wrap">
            <button
              v-for="opt in ctx?.service_results ?? []"
              :key="opt.value"
              type="button"
              :class="{ 'is-active': form.service_result === opt.value }"
              :disabled="submitting"
              @click="form.service_result = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
          <div v-if="fieldErrors.service_result" class="svc-error">
            {{ fieldErrors.service_result }}
          </div>
        </div>

        <!-- 处理说明：必填 -->
        <div class="svc-field">
          <label class="svc-label" for="f-note">处理说明<span class="svc-req">*</span></label>
          <textarea
            id="f-note"
            v-model="form.service_note"
            class="svc-textarea"
            :class="{ 'is-invalid': fieldErrors.service_note }"
            rows="4"
            maxlength="500"
            :disabled="submitting"
            placeholder="例如：更换排水泵后试机 30 分钟，无异常"
          ></textarea>
          <div v-if="fieldErrors.service_note" class="svc-error">{{ fieldErrors.service_note }}</div>
          <div v-else class="svc-hint">{{ form.service_note.length }} / 500</div>
        </div>

        <!-- 是否收费：必填 -->
        <div class="svc-field">
          <span class="svc-label">本次是否收费<span class="svc-req">*</span></span>
          <div class="svc-segment">
            <button
              type="button"
              :class="{ 'is-active': form.is_charged === false }"
              :disabled="submitting"
              @click="form.is_charged = false"
            >
              未收费
            </button>
            <button
              type="button"
              :class="{ 'is-active': form.is_charged === true }"
              :disabled="submitting"
              @click="form.is_charged = true"
            >
              已收费
            </button>
          </div>
          <div v-if="fieldErrors.is_charged" class="svc-error">{{ fieldErrors.is_charged }}</div>
        </div>

        <!-- 收费金额：**只在收费时出现**，且是必填 -->
        <div v-if="form.is_charged" class="svc-field">
          <label class="svc-label" for="f-amount">收费金额（元）<span class="svc-req">*</span></label>
          <input
            id="f-amount"
            v-model="form.reported_charge_amount"
            class="svc-input"
            :class="{ 'is-invalid': fieldErrors.reported_charge_amount }"
            type="number"
            inputmode="decimal"
            step="0.01"
            min="0.01"
            :disabled="submitting"
            placeholder="例如 128.50"
          />
          <div v-if="fieldErrors.reported_charge_amount" class="svc-error">
            {{ fieldErrors.reported_charge_amount }}
          </div>
          <p v-else class="svc-hint">最多两位小数。门店确认时会以这个金额核对。</p>
        </div>

        <button class="svc-submit" type="submit" :disabled="submitting || !canSubmit">
          {{ submitting ? '提交中…' : '提交回执' }}
        </button>
        <p class="svc-hint is-center">
          提交后本次作业即上报，链接将失效。门店确认后工单才会继续流转。
        </p>
      </form>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 师傅作业页（Phase 5 / P5-1）—— 路由 `/technician/visit/:token`
 *
 * ---------------------------------------------------------------------------
 * 这个页面存在的意义：让师傅**只做一件事，且不需要账号**
 * ---------------------------------------------------------------------------
 * 他打开短信里的短链 → nginx 302 到本页 → 填处理结果 + 传照片 → 提交。
 * 全程匿名，凭证就是 URL 路径里的那枚 Token（一次性，提交即作废）。
 *
 * 因此本页有两个硬约束，都不是"风格偏好"：
 *
 * ① **只给完成任务所需的最小信息**：工单号、门店、问题、预计上门日期。
 *    不显示客户姓名/手机号 —— 师傅联系客户走门店，不由本页派号
 *    （docs/API.md §2.1）。服务端 `get` 也没查这些字段，前端不渲染是第二道闸。
 *
 * ② **终态文案不能说"完成"**：师傅提交只把工单推到 `WAIT_STORE_CONFIRM`，
 *    后面还有门店确认与客户评价。而且这句话**由服务端下发**，本页只负责显示。
 *
 * ---------------------------------------------------------------------------
 * 刷新为什么必须能继续（而不是"重新开始"）
 * ---------------------------------------------------------------------------
 * 手机来电、微信切走、误触返回都会触发重载。若不处理，师傅会看到"0 张照片"，
 * 于是**再传一遍**，甚至以为"要重新走一遍流程"。
 * 因此：照片挂在 Visit 上（服务端事实），本页每次加载都从 `get` 重新取回；
 * 本页**不产生任何**"本地草稿"这类会与服务端分叉的状态。
 *
 * ⚠️ 本页唯一的本地持久化是"已提交"标记（`sessionStorage`），
 *    它只是**显示用**：提交成功后链接立即失效，刷新会拿到 401，
 *    那时若显示"链接不可用"，师傅会以为提交失败了，进而重复联系门店。
 *    该标记不能用于任何写操作（它连 Token 都不存），因此没有安全含义。
 */
import { computed, reactive, ref, watch } from 'vue';
import {
  ApiError,
  fetchVisitContext,
  photoUrl,
  submitReceipt,
  uploadPhoto,
  type SubmitOutcome,
  type TechnicianContext,
  type TechnicianPhoto,
} from '../../api/technician';

const props = defineProps<{ token: string }>();

type View = 'loading' | 'invalid' | 'ready' | 'success';

const view = ref<View>('loading');
const ctx = ref<TechnicianContext | null>(null);
const outcome = ref<SubmitOutcome | null>(null);
const invalidMessage = ref('这个作业链接无效或已失效。');
const banner = ref<{ kind: string; text: string } | null>(null);

/** 页面自己维护的照片列表（初值来自服务端，上传后追加） */
const photos = ref<TechnicianPhoto[]>([]);
const uploading = ref(false);
const uploadError = ref('');
const submitting = ref(false);
const brokenRefs = ref<Set<string>>(new Set());
const extraPhotoType = ref<string | null>(null);

const form = reactive({
  service_result: '',
  service_note: '',
  is_charged: null as boolean | null,
  /**
   * ⚠️ DEV-80：类型必须是 `string | number`，**不能**当它是字符串。
   * Vue 对 `<input type="number">` 的 `v-model` 会把值转成 **number**
   * （runtime-dom 的 `castToNumber = modifiers.number || el.type === 'number'`），
   * 于是这里运行期可能是 number。所有读取都必须经 `amountText()` / `toAmount()`。
   */
  reported_charge_amount: '' as string | number,
});

/**
 * 金额输入框的值 —— **唯一**的读取入口。
 *
 * 为什么不能直接 `form.reported_charge_amount.trim()`（DEV-80，真实浏览器走查发现）：
 *   已收费时那是个 **number**，`.trim` 不存在 → 在 `@submit` handler 里抛 TypeError
 *   → Vue 把它交给 `console.error`，页面上**一个字都不显示**。
 *   表现：师傅点了"提交回执"，按钮可点、无红字、无请求，**工单其实没提交**。
 *   这条路径只有"已收费"才会走到，所以只看不收费的自动化用例永远发现不了。
 */
function amountText(value: string | number | null | undefined): string {
  return String(value ?? '').trim();
}

/** 金额取数：合法（正整数/两位小数）返回数字，否则 NaN（交给调用方决定怎么提示） */
function toAmount(value: string | number | null | undefined): number {
  const raw = amountText(value);
  return /^\d+(\.\d{1,2})?$/.test(raw) ? Number(raw) : NaN;
}

const fieldErrors = reactive<Record<string, string>>({});

/** `submitted:<token>` 只记"这台设备已经提交过这条链接"，**不含任何凭据** */
const submittedKey = computed(() => `svc.tech.submitted.${props.token}`);

const photoCount = computed(() => photos.value.length);
const canUpload = computed(
  () => !!ctx.value && photoCount.value < (ctx.value.max_photos ?? 0) && !submitting.value,
);

const expectedDate = computed(() => formatDay(ctx.value?.expected_visit_at ?? null));

/**
 * 能否提交（**只是置灰提示，不是校验**）。
 * 服务端仍会独立校验一遍，页面这一层只负责"让师傅少一次失败往返"。
 */
const canSubmit = computed(
  () =>
    !!ctx.value &&
    // 下限 1 张（用户 2026-09-25 拍板）：只是置灰提示，权威校验在服务端
    photoCount.value >= 1 &&
    !!form.service_result &&
    form.service_note.trim().length > 0 &&
    form.is_charged !== null &&
    // 金额经 toAmount() 读，**不**直接对字段做字符串/正则操作（DEV-80）
    (!form.is_charged || positive(toAmount(form.reported_charge_amount))),
);

function positive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/** 只到"天"：合同里 `expected_visit_at` 对外就不带时分（避免师傅以为是精确到点） */
function formatDay(iso: string | null): string {
  if (!iso) return '待门店确认';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '待门店确认';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function url(ref: string): string {
  return photoUrl(props.token, ref);
}

function onImageError(ref: string): void {
  brokenRefs.value = new Set(brokenRefs.value).add(ref);
}

async function load(): Promise<void> {
  view.value = 'loading';
  // 先看本设备有没有"已提交过这条链接"的记忆（见文件头最后一段）。
  // ⚠️ 它只影响**显示哪个界面**，不参与任何请求；并且读出后立即核对一次服务端，
  //    万一其实没提交成功（比如提交时网络断了），就要让师傅看到真实的作业页。
  const marked = sessionStorage.getItem(submittedKey.value);
  try {
    const data = await fetchVisitContext(props.token);
    ctx.value = data;
    photos.value = data.photos;
    extraPhotoType.value = data.photo_types?.[0]?.value ?? null;
    view.value = 'ready';
    // 服务端说还待作业 → 之前那个标记是过期的（上次提交其实没成功），清掉
    sessionStorage.removeItem(submittedKey.value);
  } catch (error) {
    const apiError = error as ApiError;
    if (marked) {
      // 链接已失效 **且** 本设备记着提交成功 → 显示成功页，而不是"链接不可用"
      outcome.value = {
        ticket_no: '',
        status: '',
        visit_status: '',
        store_confirm_status: '',
        message: '已提交，等待门店确认',
        submitted_at: null,
      };
      view.value = 'success';
      return;
    }
    invalidMessage.value = apiError?.message || '这个作业链接无效或已失效。';
    view.value = 'invalid';
  }
}

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // 清空 input：不然"删掉再选同一张"不会触发 change（浏览器认为值没变）
  input.value = '';
  if (!file) return;
  void doUpload(file, input);
}

async function doUpload(file: File, input: HTMLInputElement): Promise<void> {
  uploadError.value = '';
  const maxBytes = (ctx.value?.max_photo_size_mb ?? 0) * 1024 * 1024;
  const remaining = (ctx.value?.max_photos ?? 0) - photoCount.value;

  // ---- 前端粗筛（**不是校验**，见 api/technician.ts 文件头）----
  if (remaining <= 0) {
    uploadError.value = `最多上传 ${ctx.value?.max_photos} 张照片`;
    return;
  }
  if (maxBytes > 0 && file.size > maxBytes) {
    uploadError.value = `这张照片约 ${(file.size / 1048576).toFixed(1)}MB，请压缩到 ${ctx.value?.max_photo_size_mb}MB 以内再上传`;
    return;
  }

  uploading.value = true;
  try {
    const result = await uploadPhoto(props.token, file, extraPhotoType.value);
    photos.value = [...photos.value, result.photo];
  } catch (error) {
    const apiError = error as ApiError;
    if (apiError?.status === 401) {
      // 链接在传照片的过程中失效（例如门店同时改派了）：整页切到失效态
      invalidMessage.value = apiError.message;
      view.value = 'invalid';
      return;
    }
    uploadError.value = apiError?.message || '照片上传失败，请重试';
  } finally {
    uploading.value = false;
    input.disabled = false;
  }
}

/** 只从**本页列表**里移除（不调删除接口：本阶段没有删除照片的契约） */
function removeLocal(ref: string): void {
  photos.value = photos.value.filter((p) => p.ref !== ref);
}

function onAmountInput(): void {
  // 只在收费时才校验金额；改成"未收费"时**清空**残留值，
  // 避免"师傅填了又改回不收费"的残留金额被带上去（服务端还会再兜一次）
  if (!form.is_charged) form.reported_charge_amount = '';
}

watch(() => form.is_charged, onAmountInput);

async function onSubmit(): Promise<void> {
  // 清掉上一轮的字段错误，避免"改好了但红字还挂着"
  for (const key of Object.keys(fieldErrors)) delete fieldErrors[key];
  banner.value = null;

  // ---- 逐字段本地校验（只为给出**定位到字段**的提示；服务端仍独立校验）----
  // 照片下限（用户 2026-09-25 拍板：至少 1 张）。按钮置灰挡不住回车提交表单，
  // 所以这里再拦一道；真正的权威校验在服务端（0 张 → 422 PHOTO_REQUIRED）。
  if (photoCount.value < 1) {
    banner.value = { kind: 'danger', text: '请至少上传 1 张现场照片后再提交' };
    return;
  }
  const note = form.service_note.trim();
  if (!form.service_result) fieldErrors.service_result = '请选择处理结果';
  if (!note) fieldErrors.service_note = '请填写处理说明';
  else if (note.length > 500) fieldErrors.service_note = '处理说明不能超过 500 字';
  if (form.is_charged === null) fieldErrors.is_charged = '请选择本次是否收费';

  let amount: number | null = null;
  if (form.is_charged) {
    // DEV-80：必须经 amountText()（该值运行期可能是 number，见字段注释）
    const raw = amountText(form.reported_charge_amount);
    const value = Number(raw);
    if (!raw || !Number.isFinite(value)) {
      fieldErrors.reported_charge_amount = '请填写收费金额';
    } else if (value <= 0) {
      fieldErrors.reported_charge_amount = '收费金额必须大于 0';
    } else if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
      // 与后端同一口径：numeric(12,2) 会**静默四舍五入**第三位小数，
      // 于是页面显示 30.005、库里是 30.01 —— 宁可拦住，也不要两处不一致
      fieldErrors.reported_charge_amount = '金额最多保留两位小数';
    } else {
      amount = value;
    }
  }
  if (Object.keys(fieldErrors).length > 0) return;

  submitting.value = true;
  try {
    const result = await submitReceipt(props.token, {
      service_result: form.service_result,
      service_note: note,
      is_charged: form.is_charged === true,
      reported_charge_amount: amount,
    });
    outcome.value = result;
    // 记下"这条链接已提交"（**只影响显示**，理由见文件头）。
    // 放在成功后：失败时不能留标记，否则刷新会误报成功。
    try {
      sessionStorage.setItem(submittedKey.value, '1');
    } catch {
      // 隐私模式下 sessionStorage 可能不可写 —— 不影响提交结果，忽略
    }
    view.value = 'success';
  } catch (error) {
    const apiError = error as ApiError;
    if (apiError?.status === 401) {
      invalidMessage.value = apiError.message;
      view.value = 'invalid';
      return;
    }
    // 服务端把"哪个字段不对"放在 detail / code 里；这里只显示可读的 message，
    // 其余情况一律给"重试"而不是猜原因
    banner.value = { kind: 'danger', text: apiError?.message || '提交失败，请重试' };
  } finally {
    submitting.value = false;
  }
}

// token 变了（同一标签页打开另一条链接）→ 整页重来，不留上一条的状态
watch(() => props.token, () => void load(), { immediate: true });
</script>

<style scoped>
.svc-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--svc-border);
}
.svc-row:last-child {
  border-bottom: none;
}
.svc-row.is-block {
  flex-direction: column;
  gap: 4px;
}
.svc-row-key {
  flex: none;
  color: var(--svc-text-weak);
  font-size: 13px;
}
.svc-row-val {
  font-weight: 600;
  word-break: break-all;
}
.svc-row-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.svc-count {
  float: right;
  color: var(--svc-text-weak);
  font-weight: 400;
  font-size: 13px;
}
.svc-segment.is-wrap {
  flex-wrap: wrap;
}
.svc-photos {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin: 4px 0 10px;
  padding: 0;
  list-style: none;
}
.svc-photo {
  position: relative;
  aspect-ratio: 1 / 1;
  border-radius: 10px;
  overflow: hidden;
  background: var(--svc-bg);
  border: 1px solid var(--svc-border);
}
.svc-photo img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.svc-photo-del {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 24px;
  height: 24px;
  line-height: 20px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 16px;
  cursor: pointer;
}
.svc-photo-add {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  border: 1px dashed var(--svc-border);
  border-radius: 10px;
  color: var(--svc-primary);
  cursor: pointer;
}
.svc-photo-add input {
  display: none;
}
.svc-hint.is-center {
  text-align: center;
}
</style>
