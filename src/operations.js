import { STEP_LABEL } from './booking-state.js';

const fields = ["reference", "name", "slot", "requestedAt", "documentType", "status"];

export async function readOperations(recordRepository, bookingRepository = null) {
  const records = await recordRepository.read();
  const bookings = bookingRepository
    ? new Map((await bookingRepository.read()).visits.map((visit) => [visit.reference, visit]))
    : new Map();
  return { product: "访客预约登记台", rows: records.map((record) => {
    const visit = bookings.get(record.sourceId);
    return {
      sourceId: record.sourceId,
      source: record.source,
      observedAt: record.observedAt,
      attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
      booking: visit ? {
        step: visit.step,
        stepLabel: STEP_LABEL[visit.step] ?? visit.step,
        receipt: visit.receipt,
        detail: visit.detail,
        updatedAt: visit.updatedAt,
      } : null,
    };
  }) };
}
