import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { PortalClient } from './portal-client.js';
import { BookingStateRepository } from './booking-state.js';
import { BookingAutomation } from './booking-automation.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const recordsPath = resolve(root, 'var/records.json');
const bookingsPath = resolve(root, 'var/bookings.json');
const action = process.argv[2] ?? '--help';

const COMMANDS = ['ingest', 'query', 'portal-sync', 'portal-status', 'portal-cancel'];

if (action === '--help' || action === '-h') {
  console.log(JSON.stringify({
    usage: 'npm start -- ingest [文件] | query [来源] | portal-sync [门户URL] | portal-status | portal-cancel <业务标识> [门户URL]',
    commands: COMMANDS,
  }, null, 2));
  process.exit(0);
}

if (action === 'ingest') {
  const records = JSON.parse(await readFile(process.argv[3] ?? resolve(root, 'fixtures/records.json'), 'utf8'));
  const service = new CollectionService(new RecordRepository(recordsPath));
  console.log(JSON.stringify(await service.ingest(records), null, 2));
} else if (action === 'query') {
  const service = new CollectionService(new RecordRepository(recordsPath));
  console.log(JSON.stringify(await service.query({ source: process.argv[3] }), null, 2));
} else if (action === 'portal-sync' || action === 'portal-cancel' || action === 'portal-status') {
  const portalArg = action === 'portal-cancel' ? process.argv[4] : process.argv[3];
  const bookingRepository = new BookingStateRepository(bookingsPath);
  let portalUrl = portalArg;
  if (!portalUrl) {
    portalUrl = (await bookingRepository.read()).portalUrl;
  }
  if (!portalUrl) throw new Error('门户 URL 缺失：首次运行请传入 http://127.0.0.1:<端口>');
  const automation = new BookingAutomation(
    bookingRepository,
    new RecordRepository(recordsPath),
    new PortalClient(portalUrl),
  );
  if (action === 'portal-sync') {
    console.log(JSON.stringify(await automation.sync(), null, 2));
  } else if (action === 'portal-status') {
    console.log(JSON.stringify(await automation.status(), null, 2));
  } else {
    const reference = process.argv[3];
    if (!reference) throw new Error('portal-cancel 需要业务标识 reference');
    console.log(JSON.stringify(await automation.cancel(reference), null, 2));
  }
} else {
  throw new Error('action must be ingest or query or a portal action');
}
