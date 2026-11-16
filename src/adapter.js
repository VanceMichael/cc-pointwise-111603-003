export const entryPath = "/requests";

export function parsePage(response) {
  const payload = JSON.parse(response.text);
  if (!Array.isArray(payload.items)) throw new Error('source items missing');
  const items = payload.items;
  const next = payload.next ?? null;
  return { next, records: items.map((item) => ({
    sourceId: String(item["reference"]),
    source: "访客预约登记台",
    observedAt: item["requestedAt"],
    label: String(item["name"]),
    attributes: structuredClone(item),
  })) };
}
