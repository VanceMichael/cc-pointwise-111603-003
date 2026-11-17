import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const STEP = Object.freeze({
  IMPORTED: 'imported',
  NEEDS_MATERIAL: 'needs-material',
  DRAFT_SUBMITTED: 'draft-submitted',
  RECOVERING: 'recovering',
  BOOKED: 'booked',
  SLOT_CONFLICT: 'slot-conflict',
  CANCELLING: 'cancelling',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
});

export const STEP_LABEL = Object.freeze({
  [STEP.IMPORTED]: '已导入，等待登记',
  [STEP.NEEDS_MATERIAL]: '资料不足，留待处理',
  [STEP.DRAFT_SUBMITTED]: '草稿已提交，待证件确认',
  [STEP.RECOVERING]: '提交后断线，待门户核实',
  [STEP.BOOKED]: '门户已确认，已取得预约编号与回执',
  [STEP.SLOT_CONFLICT]: '时段冲突，留待处理',
  [STEP.CANCELLING]: '撤销指令待门户确认',
  [STEP.CANCELLED]: '门户已撤销',
  [STEP.FAILED]: '处理失败，待人工介入',
});

const EVENT_LIMIT = 20;

export function createVisitState(reference, record) {
  return {
    reference,
    name: record.label ?? record.attributes?.name ?? null,
    slot: record.attributes?.slot ?? null,
    documentType: record.attributes?.documentType ?? null,
    sourceStatus: record.attributes?.status ?? null,
    step: STEP.IMPORTED,
    receipt: null,
    portalRevision: null,
    conflictRevision: null,
    retryEligible: false,
    detail: STEP_LABEL[STEP.IMPORTED],
    updatedAt: null,
    events: [],
  };
}

export class BookingStateRepository {
  constructor(path) { this.path = path; }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (!value || !Array.isArray(value.visits)) throw new Error('booking state file has no visits array');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, portalUrl: null, visits: [] };
      throw error;
    }
  }

  async replace(state) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.path);
  }
}

export function addEvent(visit, event) {
  visit.events.push({ at: new Date().toISOString(), ...event });
  if (visit.events.length > EVENT_LIMIT) visit.events.splice(0, visit.events.length - EVENT_LIMIT);
}

export function assignStep(visit, step, detail = STEP_LABEL[step]) {
  visit.step = step;
  visit.detail = detail;
  visit.updatedAt = new Date().toISOString();
}
