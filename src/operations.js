import { StepLabel } from './workflow.js';

const fields = ["reference", "name", "slot", "requestedAt", "documentType", "status"];

// 业务消费入口：保留原有 source 行结构；提供工作流仓库时附加门户对齐后的预约状态。
// 只有门户确认（或经门户核实）拿到回执的访客才会显示“已预约”。
export async function readOperations(repository, workflowRepository = null) {
  const records = await repository.read();
  const entries = workflowRepository ? await workflowRepository.read() : [];
  const byReference = new Map(entries.map((entry) => [entry.reference, entry]));
  return {
    product: "访客预约登记台",
    rows: records.map((record) => {
      const row = {
        sourceId: record.sourceId,
        source: record.source,
        observedAt: record.observedAt,
        attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
      };
      const entry = byReference.get(String(record.attributes?.reference ?? record.sourceId));
      if (entry) {
        row.workflow = {
          step: entry.step,
          stepLabel: StepLabel[entry.step] ?? entry.step,
          missing: entry.missing ?? [],
          note: entry.note ?? null,
          updatedAt: entry.updatedAt,
        };
        if (entry.receipt) {
          row.booking = {
            receipt: entry.receipt,
            status: entry.step === 'cancelled' ? 'cancelled' : 'confirmed',
            slot: entry.slot ?? null,
            revision: entry.bookingRevision ?? null,
          };
        }
      }
      return row;
    }),
  };
}
