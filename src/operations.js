const fields = ["reference", "name", "slot", "requestedAt", "documentType", "status"];

export async function readOperations(repository) {
  const records = await repository.read();
  return { product: "访客预约登记台", rows: records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  })) };
}
