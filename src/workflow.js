// 门户分步表单的可恢复状态机。每一步都持久化，重启任务后可直接说明每位访客停在哪一步。

export const Step = Object.freeze({
  PENDING: 'pending',                       // 已导入，尚未开始门户操作
  WAITING_MATERIALS: 'waiting-materials',   // 资料不足，留待处理
  AWAITING_CONFIRM: 'awaiting-confirm',     // 草稿页已提交，停在证件类型确认页
  CONFIRM_UNKNOWN: 'confirm-unknown',       // 确认提交后断连，门户事实待核实
  SLOT_FULL: 'slot-full',                   // 时段冲突，留待处理
  BOOKED: 'booked',                         // 已拿到预约编号与回执
  CANCELLING: 'cancelling',                 // 撤销请求已发出，结果待核实
  CANCELLING_UNKNOWN: 'cancelling-unknown', // 撤销提交后断连，门户事实待核实
  CANCELLED: 'cancelled',                   // 门户状态已确认撤销
  FAILED: 'failed',                         // 门户异常，下一轮自动重试
});

export const StepLabel = Object.freeze({
  [Step.PENDING]: '待提交',
  [Step.WAITING_MATERIALS]: '资料不足留待处理',
  [Step.AWAITING_CONFIRM]: '已到证件类型确认页',
  [Step.CONFIRM_UNKNOWN]: '提交结果待核实',
  [Step.SLOT_FULL]: '时段冲突留待处理',
  [Step.BOOKED]: '已预约',
  [Step.CANCELLING]: '撤销中',
  [Step.CANCELLING_UNKNOWN]: '撤销结果待核实',
  [Step.CANCELLED]: '已撤销',
  [Step.FAILED]: '门户异常待重试',
});

export const DOCUMENT_TYPES = Object.freeze(['passport', 'identity-card']);

const DRAFT_FIELDS = ['reference', 'name', 'slot'];

// 草稿页（第一步）所需资料：门户表单要 reference/name/slot，业务标识即 reference。
export function missingDraftMaterials(attributes) {
  const missing = [];
  for (const field of DRAFT_FIELDS) {
    if (!String(attributes?.[field] ?? '').trim()) missing.push(field);
  }
  return missing;
}

// 证件类型确认页（第二步）所需资料。
export function missingDocumentMaterials(attributes, requiresDocument) {
  if (!requiresDocument) return [];
  return DOCUMENT_TYPES.includes(attributes?.documentType) ? [] : ['documentType'];
}

export function createEntry(attributes, now = new Date().toISOString()) {
  return {
    reference: String(attributes.reference),
    step: Step.PENDING,
    label: String(attributes.name ?? attributes.reference),
    slot: String(attributes.slot ?? ''),
    documentType: attributes.documentType ?? null,
    receipt: null,
    bookingRevision: null,
    missing: missingDraftMaterials(attributes),
    note: null,
    attempts: 0,
    updatedAt: now,
  };
}

// 仅刷新资料快照；步骤不回退，避免把已经在途的门户操作覆盖掉。
export function refreshEntry(entry, attributes, now = new Date().toISOString()) {
  entry.label = String(attributes.name ?? entry.reference);
  entry.slot = String(attributes.slot ?? '');
  if (DOCUMENT_TYPES.includes(attributes.documentType)) entry.documentType = attributes.documentType;
  entry.updatedAt = now;
  return entry;
}
