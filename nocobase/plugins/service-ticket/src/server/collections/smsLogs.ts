import { belongsTo, CREATED_AT_COLUMN, defineAppCollection, enumStr, int, str, ts } from './_helpers';
import {
  SMS_DELIVERY_STATUS_OPTIONS,
  SMS_SCENE_OPTIONS,
  SMS_SEND_STATUS_OPTIONS,
} from './_options';

/**
 * smsLogs —— 短信全链路日志
 *
 * 为什么要单独一张表而不是只打日志：
 *  1) 门店/总部要能回答"这条工单到底通知到客户没有"；
 *  2) 供应商回执是异步且会重复推送的，需要幂等落库；
 *  3) 失败要能重试且最多重试 1 次（文档要求）。
 *
 * 幂等键：unique(provider, biz_id)。
 *  - biz_id 是我们提交给供应商时产生的业务流水号（也是回执里回带的值）；
 *  - 同一 biz_id 的回执反复推送只产生一次状态变化，且**不重复写 TicketEvent**。
 *
 * 隐私：只存脱敏手机号（recipient_masked），不存明文完整号码。
 */
export default defineAppCollection({
  name: 'smsLogs',
  title: '短信日志',
  fields: [
    belongsTo('ticket', '所属工单', 'serviceTickets', 'ticket_id', { allowNull: true }),
    belongsTo('visit', '关联回执', 'serviceVisits', 'visit_id', { allowNull: true }),

    enumStr('scene', '业务场景', SMS_SCENE_OPTIONS, { allowNull: false }),
    {
      type: 'string',
      name: 'provider',
      interface: 'select',
      allowNull: false,
      uiSchema: {
        title: '通道',
        type: 'string',
        'x-component': 'Select',
        enum: [
          { label: '阿里云', value: 'aliyun' },
          { label: '腾讯云', value: 'tencent' },
          { label: '模拟（开发）', value: 'mock' },
        ],
      },
      comment: '与 biz_id 组成幂等键',
    },

    str('template_code', '模板CODE', { length: 64, allowNull: false }),
    str('recipient_masked', '接收号码（脱敏）', {
      length: 20,
      allowNull: false,
      comment: '如 138****8000',
    }),
    str('provider_request_id', '供应商请求流水', { length: 64, allowNull: true }),
    str('biz_id', '业务流水（幂等键）', { length: 64, allowNull: true }),

    enumStr('send_status', '提交状态', SMS_SEND_STATUS_OPTIONS, {
      allowNull: false,
      comment: 'accepted 已受理 / rejected 被拒 / error 异常',
    }),
    enumStr('delivery_status', '送达状态', SMS_DELIVERY_STATUS_OPTIONS, {
      allowNull: false,
      defaultValue: 'pending',
      comment: '由供应商回执更新',
    }),

    str('error_code', '错误码', { length: 64, allowNull: true }),
    str('error_message', '错误信息', {
      length: 255,
      allowNull: true,
      comment: '截断存储，避免超长',
    }),

    int('retry_count', '重试次数', {
      allowNull: false,
      defaultValue: 0,
      comment: '上限取 serviceSettings 的 sms.retry_count（默认 1）',
    }),

    ts('sent_at', '提交时间', { allowNull: true }),
    ts('delivered_at', '送达时间', { allowNull: true }),
  ],
  indexes: [
    { fields: ['ticket_id'] },
    // 回执幂等：同一通道同一业务流水只允许一条
    { fields: ['provider', 'biz_id'], unique: true },
    { fields: ['delivery_status'] },
    { fields: ['send_status'] },
    { fields: ['scene'] },
    // smsRetry 定时任务扫描：失败且未超重试上限
    { fields: ['send_status', 'retry_count'] },
    // 时间戳列必须用 CREATED_AT_COLUMN（NocoBase 注入 camelCase createdAt）
    { fields: [CREATED_AT_COLUMN] },
  ],
});
