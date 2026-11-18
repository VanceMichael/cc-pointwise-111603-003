import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { startPortal } from '../source/portal.js';
import { PortalClient } from './portal-client.js';
import { RecordRepository } from './repository.js';
import { BookingRepository } from './booking-repository.js';
import { CollectionService } from './service.js';
import { AutomationService } from './automation.js';
import { readOperations } from './operations.js';

const portal = await startPortal({ capacity: 2 });
const directory = await mkdtemp(join(tmpdir(), 'portal-demo-'));
try {
  const recordRepo = new RecordRepository(join(directory, 'records.json'));
  const workflowRepo = new BookingRepository(join(directory, 'workflow.json'));
  const records = JSON.parse(await readFile(new URL('../fixtures/visitors.json', import.meta.url), 'utf8'));
  await new CollectionService(recordRepo).ingest(records);

  const automation = new AutomationService(new PortalClient(portal.url), workflowRepo, recordRepo);
  await automation.syncFromRecords(await recordRepo.read());
  console.log('第一轮处理：', JSON.stringify(await automation.run()));

  // 值班交接：换一个全新实例从磁盘恢复，说明每位访客停在哪一步。
  const restarted = new AutomationService(new PortalClient(portal.url), workflowRepo, recordRepo);
  console.log('重启后状态：', JSON.stringify(await restarted.status(), null, 2));

  // 断连场景：门户已写入但响应丢失，先核实门户事实再决定。
  portal.loseNextReceipt();
  await new CollectionService(recordRepo).ingest([{
    sourceId: 'visit-7', source: '访客预约登记台', observedAt: '2026-11-18T09:00:00Z',
    label: 'Reconnect Guest', attributes: {
      reference: 'visit-7', name: 'Reconnect Guest', slot: 'D',
      requestedAt: '2026-11-18T09:00:00Z', documentType: 'identity-card', status: 'requested',
    },
  }]);
  await restarted.syncFromRecords(await recordRepo.read());
  await restarted.run();

  // 撤销与门户状态对齐。
  console.log('撤销 visit-7：', JSON.stringify(await restarted.cancel('visit-7')));
  console.log('业务读取：', JSON.stringify(await readOperations(recordRepo, workflowRepo), null, 2));
} finally {
  await portal.close();
  await rm(directory, { recursive: true, force: true });
}
