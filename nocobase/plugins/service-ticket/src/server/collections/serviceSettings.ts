import { defineAppCollection, str, text } from './_helpers';
import { DEFAULT_SETTINGS } from '../constants';

/**
 * serviceSettings —— 运行期可调参数（本平台的"参数配置"表）
 *
 * 所有阈值（SLA 分钟数、低分阈值、限流上限、照片张数…）必须放这里，
 * 不允许写死在代码里（工程约定：禁止魔法数）。
 *
 * 首次安装时由 ServiceTicketPlugin.seedSettings() 写入默认值，
 * 默认值可被 .env 中同名变量覆盖（见 constants.ts 的 DEFAULT_SETTINGS.envKey）。
 *
 * ⚠️ 为什么叫 serviceSettings 而不是文档里的 systemSettings？
 *    NocoBase 核心**已经**有一个名为 `systemSettings` 的集合（由
 *    @nocobase/plugin-system-settings、plugin-acl、plugin-users 共同定义，
 *    字段是 title / logoId / enabledLanguages / allowSignUp …，落库表名 "systemSettings"）。
 *    若本插件沿用 `systemSettings` 这个逻辑名，ServiceTicketPlugin.registerCollections()
 *    的 hasCollection() 会判定"已存在"从而**静默跳过注册**，
 *    随后 seedSettings() 会写进 NocoBase 核心表并报
 *    `column systemSettings.key does not exist` —— 参数一条都种不进去，
 *    /api/svc:health 也会因为缺表长期 degraded。
 *    因此改用不与核心冲突的 `serviceSettings`（表名 service_settings）。
 *    详见 docs/DEVIATIONS.md DEV-15。
 */
export default defineAppCollection({
  name: 'serviceSettings',
  title: '参数配置',
  fields: [
    str('key', '配置键', {
      length: 64,
      allowNull: false,
      unique: true,
      comment: `如 ${DEFAULT_SETTINGS[0].key}`,
    }),
    text('value', '配置值', {
      allowNull: true,
      comment: '统一以字符串存储，按 value_type 解析',
    }),
    {
      type: 'string',
      name: 'value_type',
      interface: 'select',
      allowNull: false,
      defaultValue: 'string',
      uiSchema: {
        title: '值类型',
        type: 'string',
        'x-component': 'Select',
        enum: [
          { label: '整数', value: 'int' },
          { label: '布尔', value: 'bool' },
          { label: '字符串', value: 'string' },
          { label: 'JSON', value: 'json' },
        ],
      },
      comment: 'int / bool / string / json',
    },
    str('description', '说明', {
      length: 255,
      allowNull: true,
    }),
    str('updated_by', '最后修改人', {
      length: 64,
      allowNull: true,
      comment: 'NocoBase 用户名；系统写入时为 system',
    }),
  ],
  // 唯一性只由字段级 `unique: true` 声明（生成 PG UNIQUE CONSTRAINT，索引名 service_settings_key_key）。
  // 早期这里还额外写过 `indexes: [{ fields: ['key'], unique: true }]`，
  // 会在同一列上再建一个同义索引（service_settings_key），纯属浪费，已清理（DEV-17）。
  indexes: [],
});
