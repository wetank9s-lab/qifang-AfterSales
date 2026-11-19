/**
 * 暖通施工阶段的**显示配置**（R2.2.1 §八）
 *
 * ===========================================================================
 * 这个服务管什么、不管什么（先把边界说死）
 * ===========================================================================
 * 管：六个阶段的**显示名称**与**阶段说明**，存在 `service_settings` 一行 JSON 里。
 * 不管：`stage_code`、施工顺序、档案数据、日期、照片、完成状态 —— 一个都不碰。
 *
 * 用户原话：「固定六个 stage_code 与顺序，不允许增删」「改显示名不重写档案数据、
 * 不改员工备注、不删历史」「配置修改不需要重建移动端」。
 *
 * ⇒ 因此本服务**只**产出 `[{ code, order, name, description }]` 这一种形状，
 *   而 `code` / `order` 永远来自代码常量 `ARCHIVE_STAGE_ORDER`，
 *   数据库里那行 JSON **只有 `name` 与 `description` 两个可写字段**。
 *   这不是"忘了支持顺序"，是**故意不支持**。
 *
 * ===========================================================================
 * 为什么用一行 JSON 而不是六行配置
 * ===========================================================================
 * `service_settings` 的 `key` 是 varchar(64)，六行 `archive.stage.survey.name` 之类的写法
 * 会让一次"保存六个阶段"变成六次写入 + 六条审计 + 六种部分失败状态
 * （第 3 个写成功、第 4 个失败 ⇒ 配置半截生效，而界面显示"保存失败"）。
 *
 * 一行 JSON + 一条审计 = **要么全变、要么全不变**，与 §八「保存即生效」的语义一致。
 *
 * ===========================================================================
 * 为什么不需要重建移动端
 * ===========================================================================
 * 移动端每次进「暖通工程记录」页都读一次配置（见 src-mobile 的 HVAC 阶段组件），
 * 名称来自响应而不是打包进 bundle 的常量。所以改配置只是改了一行数据库，
 * **不触碰构建产物**。服务端此处要做的是：把读取做到足够便宜
 * （走 ConfigService 的 10 秒缓存 + 本服务自己的内存快照两道）。
 */
import { ARCHIVE_STAGE_LABEL, ARCHIVE_STAGE_ORDER } from '../constants';

/** 阶段显示配置（对外形状，也是移动端与后台页面共用的契约） */
export interface StageDisplayConfig {
  /** 机器码，**不可修改**，来自源码常量 */
  code: string;
  /** 施工顺序，1..6，**不可修改** */
  order: number;
  /** 显示名称（可改；1–12 字） */
  name: string;
  /** 阶段说明（可改；可空；≤ 60 字） */
  description: string;
}

/** `service_settings` 里承载本配置的键名 */
export const STAGE_CONFIG_KEY = 'archive.hvac_stage_labels';

/** 名称长度上限：与后台表格列宽（240px）和移动端阶段行（16px/700）实测匹配 */
export const STAGE_NAME_MAX = 12;
/** 说明长度上限：一行 13px 在 375px 宽下再多就换三行，撑破阶段行 */
export const STAGE_DESC_MAX = 60;

/** 代码内置的默认名称（`ARCHIVE_STAGE_LABEL`，全系统唯一来源） */
export function defaultStageConfig(): StageDisplayConfig[] {
  return ARCHIVE_STAGE_ORDER.map((code, i) => ({
    code,
    order: i + 1,
    name: ARCHIVE_STAGE_LABEL[code] ?? code,
    description: '',
  }));
}

/**
 * 把库里的 JSON 归一成完整六行。
 *
 * 🔴 这里是**最容易做错的一处**，四条规则写清楚：
 *   ① 库里只有一个 `{ code: {name, description} }` 的**补丁**，不是完整快照
 *      ⇒ 缺失的 code 取默认名（不是空串，也不是报错）；
 *   ② 库里出现**未知 code** ⇒ 忽略（用户裁决：不允许增删阶段。
 *      静默丢弃比报错好：报错会让一条脏数据把整个页面打成 500，
 *      而丢弃的效果只是"那个名字没生效"，其余五个照常）；
 *   ③ 类型不对（name 是数字 / 是对象）⇒ 该字段回退默认值，**不影响其它阶段**；
 *   ④ 顺序永远按代码常量重排 —— 库里哪怕写了 order 也不采纳。
 */
export function normalizeStageConfig(raw: unknown): StageDisplayConfig[] {
  const patch: Record<string, any> = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as any) : {};

  return ARCHIVE_STAGE_ORDER.map((code, i) => {
    const fallbackName = ARCHIVE_STAGE_LABEL[code] ?? code;
    const entry = patch[code];
    const entryObj = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};

    const rawName = entryObj.name;
    const name =
      typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim().slice(0, STAGE_NAME_MAX) : fallbackName;

    const rawDesc = entryObj.description;
    const description = typeof rawDesc === 'string' ? rawDesc.trim().slice(0, STAGE_DESC_MAX) : '';

    return { code, order: i + 1, name, description };
  });
}

/** 把完整六行压回存储形状（只留 name/description，丢弃 code/order —— 它们不该入库） */
export function toStagePatch(config: StageDisplayConfig[]): Record<string, { name: string; description: string }> {
  const out: Record<string, { name: string; description: string }> = {};
  for (const s of config) out[s.code] = { name: s.name, description: s.description };
  return out;
}

export interface StageConfigValidationError {
  code: string;
  message: string;
}

/**
 * 校验一次提交（六个阶段整体提交，不做逐条局部更新）。
 *
 * 🔴 为什么要求**整体提交**而不是"改哪条传哪条"：
 *    局部提交会让"第 3 条清空名字"变成"不传 name ⇒ 不改"，
 *    而用户真正想做的恰恰可能是把名字清空（然后期望回退默认）。
 *    整体提交之后，"传了空" = "回退默认名"，语义唯一。
 *
 * 返回 `null` 表示通过。
 */
export function validateStageSubmit(input: unknown): StageConfigValidationError | null {
  if (!Array.isArray(input)) {
    return { code: 'STAGE_CONFIG_SHAPE', message: '提交内容必须是阶段数组' };
  }
  if (input.length !== ARCHIVE_STAGE_ORDER.length) {
    return {
      code: 'STAGE_CONFIG_COUNT',
      message: `必须提交全部 ${ARCHIVE_STAGE_ORDER.length} 个阶段（当前 ${input.length} 个）`,
    };
  }

  const seen = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== 'object') {
      return { code: 'STAGE_CONFIG_SHAPE', message: '阶段项格式错误' };
    }
    const code = String((item as any).code ?? '');
    if (!ARCHIVE_STAGE_ORDER.includes(code)) {
      return { code: 'STAGE_CONFIG_UNKNOWN', message: `未知阶段：${code || '(空)'}` };
    }
    if (seen.has(code)) {
      return { code: 'STAGE_CONFIG_DUPLICATE', message: `阶段重复：${code}` };
    }
    seen.add(code);

    const name = (item as any).name;
    // 名称必填：空名字会让移动端出现"没有标题的一行"，那不是"用默认值"，是坏界面
    if (typeof name !== 'string' || name.trim() === '') {
      return { code: 'STAGE_CONFIG_NAME_REQUIRED', message: '阶段名称不能为空' };
    }
    if (name.trim().length > STAGE_NAME_MAX) {
      return { code: 'STAGE_CONFIG_NAME_TOO_LONG', message: `阶段名称最多 ${STAGE_NAME_MAX} 个字` };
    }

    const desc = (item as any).description;
    if (desc !== undefined && desc !== null && typeof desc !== 'string') {
      return { code: 'STAGE_CONFIG_DESC_TYPE', message: '阶段说明必须是文本' };
    }
    if (typeof desc === 'string' && desc.trim().length > STAGE_DESC_MAX) {
      return { code: 'STAGE_CONFIG_DESC_TOO_LONG', message: `阶段说明最多 ${STAGE_DESC_MAX} 个字` };
    }
  }

  // 六个 code 必须**一个不少**（length 相等 + 全在名单 + 不重复 ⇒ 必然是全覆盖）
  const missing = ARCHIVE_STAGE_ORDER.filter((c) => !seen.has(c));
  if (missing.length > 0) {
    return { code: 'STAGE_CONFIG_MISSING', message: `缺少阶段：${missing.join(', ')}` };
  }

  return null;
}
