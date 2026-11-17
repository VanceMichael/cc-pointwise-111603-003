import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { startPortal } from '../source/portal.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { BookingStateRepository, STEP } from './booking-state.js';
import { BookingAutomation } from './booking-automation.js';
import { PortalClient } from './portal-client.js';
import { readOperations } from './operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const portal = await startPortal({ capacity: 1 });
const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
try {
  // —— 既有基线：来源读取、首批导入、重启回读、重放、业务查询 ——
  const page = parsePage(await new SourceClient(source.url).read(entryPath));
  assert.ok(page.records.length > 0, '初始来源须有可接收的业务记录');
  const path = join(directory, 'records.json');
  const repository = new RecordRepository(path);
  const first = await new CollectionService(repository).ingest(page.records);
  assert.equal(first.accepted, page.records.length);
  const stored = await repository.read();
  const reopened = new RecordRepository(path);
  assert.deepEqual(await new CollectionService(reopened).query({}), stored, '重新打开后读取同一份业务记录');
  const second = await new CollectionService(reopened).ingest(page.records);
  assert.equal(second.stored, stored.length, '重放首批记录不重复保存');

  // —— 门户自动化：构造资料不足、可预约、时段冲突三类待办 ——
  const records = [
    { sourceId: 'visit-1', source: '访客预约登记台', observedAt: '2026-11-16T08:00:00Z', label: 'Local Guest',
      attributes: { reference: 'visit-1', name: 'Local Guest', slot: 'A', requestedAt: '2026-11-16T08:00:00Z', documentType: 'passport', status: 'requested' } },
    { sourceId: 'visit-2', source: '访客预约登记台', observedAt: '2026-11-16T08:05:00Z', label: 'Missing Papers',
      attributes: { reference: 'visit-2', name: 'Missing Papers', slot: 'B', requestedAt: '2026-11-16T08:05:00Z', documentType: null, status: 'requested' } },
    { sourceId: 'visit-3', source: '访客预约登记台', observedAt: '2026-11-16T08:10:00Z', label: 'Slot Clash',
      attributes: { reference: 'visit-3', name: 'Slot Clash', slot: 'A', requestedAt: '2026-11-16T08:10:00Z', documentType: 'identity-card', status: 'requested' } },
  ];
  await new CollectionService(repository).ingest(records);
  const bookingPath = join(directory, 'bookings.json');
  const bookingRepository = new BookingStateRepository(bookingPath);
  const automation = new BookingAutomation(bookingRepository, repository, new PortalClient(portal.url));
  const runOne = await automation.sync();
  assert.equal(runOne.booked, 1, '只有资料齐备且时段可用的项目取得回执');
  assert.equal(runOne.needsMaterial, 1, '资料不足项目留待处理');
  assert.equal(runOne.slotConflicts, 1, '时段冲突项目留待处理');

  // —— 回执断线：门户已写入但响应丢失，重启后只核实不重约 ——
  const extra = { sourceId: 'visit-4', source: '访客预约登记台', observedAt: '2026-11-16T08:15:00Z', label: 'Lost Receipt',
    attributes: { reference: 'visit-4', name: 'Lost Receipt', slot: 'B', requestedAt: '2026-11-16T08:15:00Z', documentType: 'passport', status: 'requested' } };
  await new CollectionService(repository).ingest([extra]);
  portal.loseNextReceipt();
  await automation.sync();
  // 断线那次请求已到达门户并写入，只是响应被断开；记录此时的确认次数。
  const confirmCountAfterLostWrite = portal.requests.filter((request) => request.path === '/portal/confirm').length;
  const pending = (await automation.status()).visits.find((visit) => visit.reference === 'visit-4');
  assert.equal(pending.step, STEP.RECOVERING, '未收到响应只能停在待核实');
  assert.equal(pending.receipt, null);
  // 模拟值班交接后的全新进程与门户会话失效。
  portal.expireSessions();
  const restarted = new BookingAutomation(bookingRepository, repository, new PortalClient(portal.url));
  await restarted.sync();
  const recovered = (await restarted.status()).visits.find((visit) => visit.reference === 'visit-4');
  assert.equal(recovered.step, STEP.BOOKED, '核实到门户记录后补登回执');
  assert.ok(recovered.receipt);
  assert.equal(
    portal.requests.filter((request) => request.path === '/portal/confirm').length,
    confirmCountAfterLostWrite,
    '恢复只查询不重复确认',
  );

  // —— 撤销与门户状态对齐，且操作可在业务读取入口解释 ——
  const cancelled = await restarted.cancel('visit-4');
  assert.equal(cancelled.step, STEP.CANCELLED);
  const portalRecord = (await (await fetch(`${portal.url}/portal/bookings?reference=visit-4`)).json()).bookings[0];
  assert.equal(portalRecord.status, 'cancelled');

  const operations = await readOperations(repository, new BookingStateRepository(bookingPath));
  assert.equal(operations.rows.length, 4);
  const steps = new Map(operations.rows.map((row) => [row.sourceId, row.booking.step]));
  assert.equal(steps.get('visit-1'), STEP.BOOKED);
  assert.equal(steps.get('visit-2'), STEP.NEEDS_MATERIAL);
  assert.equal(steps.get('visit-3'), STEP.SLOT_CONFLICT);
  assert.equal(steps.get('visit-4'), STEP.CANCELLED);

  // —— 再次重启仍能说明每位访客停在哪一步 ——
  const afterReboot = await new BookingAutomation(
    new BookingStateRepository(bookingPath), repository, new PortalClient(portal.url),
  ).status();
  assert.ok(afterReboot.visits.every((visit) => visit.stepLabel && visit.detail));

  console.log(JSON.stringify({
    accepted: first.accepted, persisted: stored.length, replayStored: second.stored,
    operationRows: operations.rows.length,
    booked: runOne.booked, needsMaterial: runOne.needsMaterial, slotConflicts: runOne.slotConflicts,
    recoveredReceipt: recovered.receipt, cancelled: cancelled.step, status: 'ok',
  }));
} finally {
  await source.close();
  await portal.close();
  await rm(directory, { recursive: true, force: true });
}
