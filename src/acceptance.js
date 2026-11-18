import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { startSource } from '../source/server.js';
import { startPortal } from '../source/portal.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { BookingRepository } from './booking-repository.js';
import { CollectionService } from './service.js';
import { AutomationService } from './automation.js';
import { PortalClient } from './portal-client.js';
import { readOperations } from './operations.js';
import { Step } from './workflow.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const portal = await startPortal({ capacity: 1 });
const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
try {
  // 1. 既有本地接入：来源读取、首批导入、重启回读、重放。
  const page = parsePage(await new SourceClient(source.url).read(entryPath));
  assert.ok(page.records.length > 0, '初始来源须有可接收的业务记录');
  const recordPath = join(directory, 'records.json');
  const repository = new RecordRepository(recordPath);
  const first = await new CollectionService(repository).ingest(page.records);
  assert.equal(first.accepted, page.records.length);
  const stored = await repository.read();
  const reopened = new RecordRepository(recordPath);
  assert.deepEqual(await new CollectionService(reopened).query({}), stored, '重新打开后读取同一份业务记录');
  const second = await new CollectionService(reopened).ingest(page.records);
  assert.equal(second.stored, stored.length, '重放首批记录不重复保存');

  // 2. 门户自动化：多场景导入，资料不足与时段冲突留待，其余拿到回执。
  const visitors = JSON.parse(await readFile(new URL('../fixtures/visitors.json', import.meta.url), 'utf8'));
  await new CollectionService(repository).ingest(visitors);
  const workflowPath = join(directory, 'workflow.json');
  const workflowRepository = new BookingRepository(workflowPath);
  const automation = new AutomationService(new PortalClient(portal.url), workflowRepository, repository);
  await automation.syncFromRecords(await repository.read());
  const run = await automation.run();
  assert.ok(run.processed >= 6, '所有可推进访客都被处理');
  const status = await automation.status();
  const byRef = Object.fromEntries(status.map((entry) => [entry.reference, entry]));
  assert.equal(byRef['visit-1'].step, Step.BOOKED);
  assert.ok(byRef['visit-1'].receipt, '已预约必须有门户回执');
  assert.equal(byRef['visit-3'].step, Step.WAITING_MATERIALS);
  assert.deepEqual(byRef['visit-3'].missing, ['documentType']);
  assert.equal(byRef['visit-4'].step, Step.WAITING_MATERIALS);
  assert.equal(byRef['visit-2'].step, Step.SLOT_FULL, '容量为 1 时第二个同时段访客冲突留待');

  // 3. 断连核实：确认写入后响应丢失，重启任务先核实门户再决定，不重复预约。
  portal.loseNextReceipt();
  // 直接构造一个新的待办访客走断连场景。
  await new CollectionService(repository).ingest([{
    sourceId: 'visit-9', source: '访客预约登记台', observedAt: '2026-11-18T09:00:00Z',
    label: 'Lost Guest', attributes: {
      reference: 'visit-9', name: 'Lost Guest', slot: 'Z',
      requestedAt: '2026-11-18T09:00:00Z', documentType: 'passport', status: 'requested',
    },
  }]);
  await automation.syncFromRecords(await repository.read());
  await automation.run();
  const lostEntry = (await automation.status()).find((entry) => entry.reference === 'visit-9');
  assert.equal(lostEntry.step, Step.BOOKED);
  const portalFacts = await new PortalClient(portal.url).findBookings('visit-9');
  assert.equal(portalFacts.length, 1);
  assert.equal(portalFacts[0].receipt, lostEntry.receipt, '采纳的是门户事实中的回执');

  // 4. 会话失效后重启：新实例从持久状态说明每位访客停在哪一步。
  portal.expireSessions();
  const restarted = new AutomationService(
    new PortalClient(portal.url), new BookingRepository(workflowPath), new RecordRepository(recordPath));
  const reopenedStatus = await restarted.status();
  assert.ok(reopenedStatus.every((entry) => entry.step && entry.updatedAt), '重启后步骤与时间均可回读');
  assert.deepEqual(reopenedStatus.map((entry) => entry.reference).sort(),
    (await automation.status()).map((entry) => entry.reference).sort());

  // 5. 撤销与门户状态对齐。
  const cancelled = await restarted.cancel('visit-9');
  assert.equal(cancelled.step, Step.CANCELLED);
  const afterCancel = await new PortalClient(portal.url).findBookings('visit-9');
  assert.equal(afterCancel[0].status, 'cancelled');

  // 6. 业务读取入口同时呈现来源行与门户工作流。
  const operations = await readOperations(
    new RecordRepository(recordPath), new BookingRepository(workflowPath));
  const row = operations.rows.find((item) => item.sourceId === 'visit-9');
  assert.equal(row.booking.status, 'cancelled');
  assert.equal(row.workflow.step, Step.CANCELLED);
  console.log(JSON.stringify({
    accepted: first.accepted, persisted: stored.length, replayStored: second.stored,
    workflowEntries: reopenedStatus.length, booked: status.filter((entry) => entry.step === Step.BOOKED).length,
    waiting: status.filter((entry) => entry.step === Step.WAITING_MATERIALS).length,
    slotFull: status.filter((entry) => entry.step === Step.SLOT_FULL).length,
    reconciledAfterDisconnect: lostEntry.receipt, status: 'ok',
  }));
} finally {
  await source.close();
  await portal.close();
  await rm(directory, { recursive: true, force: true });
}
