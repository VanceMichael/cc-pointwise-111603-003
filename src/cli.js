import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { BookingRepository } from './booking-repository.js';
import { PortalClient } from './portal-client.js';
import { AutomationService } from './automation.js';
import { readOperations } from './operations.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const recordsPath = resolve(root, 'var/records.json');
const workflowPath = resolve(root, 'var/workflow.json');
const defaultPortalUrl = 'http://127.0.0.1:8080';

const action = process.argv[2] ?? '--help';
if (action === '--help' || action === '-h') {
  console.log(JSON.stringify({
    usage: 'npm start -- ingest [文件] | query [来源] | automate [门户地址] | status | rearm <访客业务标识> | cancel <访客业务标识> [门户地址]',
    commands: ['ingest', 'query', 'automate', 'status', 'rearm', 'cancel'],
    portal: '门户地址可用参数或 PORTAL_URL 提供，仅允许 127.0.0.1 回环来源，默认 ' + defaultPortalUrl,
  }));
  process.exit(0);
}

const portalUrl = process.env.PORTAL_URL ?? defaultPortalUrl;

if (action === 'ingest') {
  const records = JSON.parse(await readFile(process.argv[3] ?? resolve(root, 'fixtures/records.json'), 'utf8'));
  const service = new CollectionService(new RecordRepository(recordsPath));
  console.log(JSON.stringify(await service.ingest(records), null, 2));
} else if (action === 'query') {
  const repository = new RecordRepository(recordsPath);
  const service = new CollectionService(repository);
  console.log(JSON.stringify(await service.query({ source: process.argv[3] }), null, 2));
} else if (action === 'automate') {
  const repository = new RecordRepository(recordsPath);
  const workflowRepository = new BookingRepository(workflowPath);
  const automation = new AutomationService(new PortalClient(process.argv[3] ?? portalUrl), workflowRepository, repository);
  await automation.syncFromRecords(await repository.read());
  console.log(JSON.stringify(await automation.run(), null, 2));
} else if (action === 'status') {
  const automation = new AutomationService(null, new BookingRepository(workflowPath), new RecordRepository(recordsPath));
  console.log(JSON.stringify(await automation.status(), null, 2));
} else if (action === 'rearm') {
  const reference = process.argv[3];
  if (!reference) throw new Error('rearm requires a visitor reference');
  const automation = new AutomationService(null, new BookingRepository(workflowPath), new RecordRepository(recordsPath));
  console.log(JSON.stringify(await automation.rearm(reference), null, 2));
} else if (action === 'cancel') {
  const reference = process.argv[3];
  if (!reference) throw new Error('cancel requires a visitor reference');
  const repository = new RecordRepository(recordsPath);
  const automation = new AutomationService(
    new PortalClient(process.argv[4] ?? portalUrl), new BookingRepository(workflowPath), repository);
  console.log(JSON.stringify(await automation.cancel(reference), null, 2));
} else {
  throw new Error('action must be ingest, query, automate, status, rearm or cancel');
}
