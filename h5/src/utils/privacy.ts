/**
 * 个人信息处理说明（隐私告知）——前端展示文案与版本号。
 *
 * ⚠️ `PRIVACY_NOTICE_VERSION` 必须与后端
 * `nocobase/plugins/service-ticket/src/server/constants.ts` 的
 * `PRIVACY_NOTICE_VERSION` **逐字一致**。
 *
 * 为什么较真到这个程度：客户勾选"同意"时，后端会把
 * `{ agreed: true, version, agreed_at }` 写进 `service_tickets.extra_json`，
 * 作为"当时同意的是哪一版说明"的**存证**。如果前端显示的文案改了、
 * 版本号却没改，存证就会指向一个与用户实际看到的内容不符的版本 ——
 * 这属于**举证失效**，不是文案瑕疵。
 *
 * 因此改动流程是：复制一个新版本常量 → 改文案 → **同时**改后端常量 →
 * 跑 `scripts/verify-phase3-h5.mjs`（其中有一条断言专门比对两边字符串）。
 */
export const PRIVACY_NOTICE_VERSION = '2026-09-20';

export interface NoticeSection {
  title: string;
  paragraphs: string[];
}

export const PRIVACY_NOTICE_SECTIONS: NoticeSection[] = [
  {
    title: '一、我们收集哪些信息',
    paragraphs: [
      '为安排上门服务，我们会收集您填写的姓名、手机号，以及您描述的故障情况；服务完成后还可能记录处理结果与您的评价。',
      '提交报修本身**不需要注册账号**。我们不会要求您提供身份证号、银行卡号、支付密码等与售后服务无关的信息。',
    ],
  },
  {
    title: '二、我们如何使用这些信息',
    paragraphs: [
      '仅用于：联系您确认上门时间、派单给对应门店的师傅、跟进处理进度、处理售后争议与质量回访。',
      '我们**不会**将这些信息用于与本次服务无关的营销推送，也不会出售或出租给第三方。',
    ],
  },
  {
    title: '三、信息的保存与共享',
    paragraphs: [
      '信息保存在本服务平台的内部系统中，仅门店服务人员与总部售后管理岗按职责范围可见。',
      '除法律法规要求或您明确授权外，我们不会向外部机构提供您的个人信息。',
    ],
  },
  {
    title: '四、您的权利',
    paragraphs: [
      '您可以随时联系提交门店或总部客服，要求查询、更正或删除您提交的信息。',
      '删除后，与该次服务相关的必要凭证可能会按法规要求保留一定期限。',
    ],
  },
];
