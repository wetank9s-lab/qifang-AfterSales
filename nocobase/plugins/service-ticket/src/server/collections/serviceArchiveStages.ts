import {
  belongsTo,
  defineAppCollection,
  enumStr,
  int,
  str,
  text,
  ts,
} from './_helpers';
import { ARCHIVE_STAGE_CODE_OPTIONS, ARCHIVE_STAGE_STATUS_OPTIONS } from './_options';

/**
 * serviceArchiveStages —— 暖通工程六阶段（ARC-V1 / A1）
 *
 * 一行一个阶段，建档案时**一次性写入六行**（顺序固定），而不是"完成时才插入"。
 * 理由：只有六行都在，"跳过阶段"才能被服务端检出——如果第二阶段不存在，
 * 你无法区分"还没做"和"被删了"。
 *
 * 顺序约束**不写进数据库**（没有 CHECK 能表达"前一行必须 done"），
 * 由 `archive-stage-service.ts` 在事务里校验：`ARCHIVE_STAGE_ORDER` 是本表的
 * 排序事实来源，校验逻辑必须从它派生，不能另写一份数组。
 *
 * 撤回（withdrawn）**保留行**，不物理删除：执行令要求"不能无痕删除历史"。
 * 撤回后 `status=withdrawn`、`stage_date/completed_at` 保留原值作为历史，
 * 服务端另行记录 `stage_withdrawn` 事件。
 */
export default defineAppCollection({
  name: 'serviceArchiveStages',
  title: '暖通工程阶段',
  fields: [
    belongsTo('archive', '所属档案', 'serviceArchives', 'archive_id', {
      allowNull: false,
      comment: '级联只在应用层做（受控撤回），不做数据库级 ON DELETE CASCADE',
    }),
    enumStr('stage_code', '阶段', ARCHIVE_STAGE_CODE_OPTIONS, {
      allowNull: false,
    }),
    int('stage_order', '阶段序号', {
      allowNull: false,
      comment: '1..6，来自 ARCHIVE_STAGE_ORDER 的下标+1；顺序规则的机器可读来源',
    }),
    enumStr('status', '阶段状态', ARCHIVE_STAGE_STATUS_OPTIONS, {
      allowNull: false,
      defaultValue: 'pending',
    }),
    {
      type: 'dateOnly',
      name: 'stage_date',
      interface: 'date',
      uiSchema: {
        title: '完成日期',
        type: 'string',
        'x-component': 'DatePicker',
        'x-component-props': { dateOnly: true },
      },
      allowNull: true,
      comment: '标记完成时必填（服务端校验，不依赖前端 required）',
    },
    text('note', '阶段说明', { allowNull: true }),
    ts('completed_at', '完成时间', { allowNull: true }),
    belongsTo('completed_by_user', '完成人', 'users', 'completed_by', { allowNull: true }),
    int('version', '版本号', {
      allowNull: false,
      defaultValue: 1,
      comment: '与主档案各自独立并发控制：改阶段不应连带锁住档案主表',
    }),
    str('withdraw_reason', '撤回原因', {
      length: 255,
      allowNull: true,
      comment: '受控纠错留痕；撤回时必须填写',
    }),
  ],
  indexes: [
    { fields: ['archive_id', 'stage_code'], unique: true },
    { fields: ['archive_id', 'stage_order'] },
    { fields: ['status'] },
  ],
});
