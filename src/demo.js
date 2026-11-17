import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { startPortal } from '../source/portal.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { BookingStateRepository } from './booking-state.js';
import { BookingAutomation } from './booking-automation.js';
import { PortalClient } from './portal-client.js';
import { readOperations } from './operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const portal = await startPortal();
const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
try {
  const page = parsePage(await new SourceClient(source.url).read(entryPath));
  const repository = new RecordRepository(join(directory, 'records.json'));
  await new CollectionService(repository).ingest(page.records);
  const bookingRepository = new BookingStateRepository(join(directory, 'bookings.json'));
  const automation = new BookingAutomation(
    bookingRepository, repository, new PortalClient(portal.url),
  );
  await automation.sync();
  console.log(JSON.stringify(await readOperations(repository, bookingRepository), null, 2));
} finally {
  await source.close();
  await portal.close();
  await rm(directory, { recursive: true, force: true });
}
