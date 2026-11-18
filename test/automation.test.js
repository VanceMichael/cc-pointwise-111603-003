import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPortal } from '../source/portal.js';
import { PortalClient, SessionExpiredError } from '../src/portal-client.js';
import { RecordRepository } from '../src/repository.js';
import { BookingRepository } from '../src/booking-repository.js';
import { CollectionService } from '../src/service.js';
import { AutomationService } from '../src/automation.js';
import { readOperations } from '../src/operations.js';
import { Step } from '../src/workflow.js';

const fixtureUrl = new URL('../fixtures/visitors.json', import.meta.url);

async function buildStack(portal, directory) {
  const recordRepo = new RecordRepository(join(directory, 'records.json'));
  const workflowRepo = new BookingRepository(join(directory, 'workflow.json'));
  const records = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  await new CollectionService(recordRepo).ingest(records);
  const service = new AutomationService(new PortalClient(portal.url), workflowRepo, recordRepo);
  return { recordRepo, workflowRepo, service };
}

const stepMap = (status) => Object.fromEntries(status.map((entry) => [entry.reference, entry.step]));

test('完整一轮：资料齐全者拿到回执才显示已预约，状态可重启回读且重跑幂等', async () => {
  const portal = await startPortal({ capacity: 2 });
  const directory = await mkdtemp(join(tmpdir(), 'automation-happy-'));
  try {
    const stack = await buildStack(portal, directory);
    assert.deepEqual(await stack.service.syncFromRecords(await stack.recordRepo.read()), { tracked: 6 });
    const run = await stack.service.run();
    assert.equal(run.processed, 6);
    const steps = stepMap(await stack.service.status());
    assert.equal(steps['visit-1'], Step.BOOKED);
    assert.equal(steps['visit-2'], Step.BOOKED);
    assert.equal(steps['visit-5'], Step.BOOKED);
    assert.equal(steps['visit-3'], Step.WAITING_MATERIALS);
    assert.equal(steps['visit-4'], Step.WAITING_MATERIALS);
    assert.equal(steps['visit-6'], Step.SLOT_FULL);

    // 只有拿到门户回执的行出现 booking，前台标签为“已预约”。
    const view = await readOperations(stack.recordRepo, stack.workflowRepo);
    const row1 = view.rows.find((row) => row.sourceId === 'visit-1');
    assert.equal(row1.workflow.stepLabel, '已预约');
    assert.ok(row1.booking.receipt);
    assert.equal(row1.booking.status, 'confirmed');
    const row3 = view.rows.find((row) => row.sourceId === 'visit-3');
    assert.equal(row3.booking, undefined);
    assert.deepEqual(row3.workflow.missing, ['documentType']);

    // 模拟交接重启：新实例从磁盘恢复，再跑一轮不产生重复预约。
    const restarted = new AutomationService(new PortalClient(portal.url), stack.workflowRepo, stack.recordRepo);
    assert.deepEqual(stepMap(await restarted.status()), steps);
    assert.equal((await restarted.run()).processed, 0);
    for (const reference of ['visit-1', 'visit-2', 'visit-5']) {
      const found = await new PortalClient(portal.url).findBookings(reference);
      assert.equal(found.filter((booking) => booking.status === 'confirmed').length, 1);
    }
  } finally { await portal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('资料不足在发门户请求前留待处理：缺时段不提交草稿，缺证件停在确认页', async () => {
  const portal = await startPortal({ capacity: 2 });
  const directory = await mkdtemp(join(tmpdir(), 'automation-materials-'));
  try {
    const { recordRepo, workflowRepo, service } = await buildStack(portal, directory);
    await service.syncFromRecords(await recordRepo.read());
    await service.run();
    const status = await service.status();
    const noSlot = status.find((entry) => entry.reference === 'visit-4');
    assert.equal(noSlot.step, Step.WAITING_MATERIALS);
    assert.deepEqual(noSlot.missing, ['slot']);
    const noDocument = status.find((entry) => entry.reference === 'visit-3');
    assert.equal(noDocument.step, Step.WAITING_MATERIALS);
    assert.deepEqual(noDocument.missing, ['documentType']);
    // 5 位资料够开草稿的访客各提交一次，visit-4 从未提交。
    const drafts = portal.requests.filter((request) => request.method === 'POST' && request.path === '/portal/draft');
    assert.equal(drafts.length, 5);
    assert.deepEqual((await new PortalClient(portal.url).findBookings('visit-3')), []);
    assert.deepEqual((await new PortalClient(portal.url).findBookings('visit-4')), []);

    // 前台补齐证件资料后重跑：资料快照更新，visit-3 完成预约。
    const records = await recordRepo.read();
    records.find((record) => record.sourceId === 'visit-3').attributes.documentType = 'passport';
    await recordRepo.replace(records);
    await service.syncFromRecords(records);
    await service.run();
    assert.equal(stepMap(await service.status())['visit-3'], Step.BOOKED);
  } finally { await portal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('时段冲突留待处理且不会反复撞容量', async () => {
  const portal = await startPortal({ capacity: 1 });
  const directory = await mkdtemp(join(tmpdir(), 'automation-slot-'));
  try {
    const { recordRepo, service } = await buildStack(portal, directory);
    await service.syncFromRecords(await recordRepo.read());
    await service.run();
    const steps = stepMap(await service.status());
    assert.equal(steps['visit-1'], Step.BOOKED);
    assert.equal(steps['visit-2'], Step.SLOT_FULL);
    const secondRun = await service.run();
    assert.equal(secondRun.processed, 0, 'slot-full 属于留待处理，不自动重试');
    const slotA = (await new PortalClient(portal.url).findBookings('visit-2'));
    assert.equal(slotA.length, 0);
  } finally { await portal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('确认提交后断连：先核实门户，已落单则采纳回执且绝不重复预约', async () => {
  const portal = await startPortal({ capacity: 2 });
  portal.loseNextReceipt();
  const directory = await mkdtemp(join(tmpdir(), 'automation-lost-'));
  try {
    const { recordRepo, service } = await buildStack(portal, directory);
    await service.syncFromRecords(await recordRepo.read());
    await service.run();
    const entry = (await service.status()).find((item) => item.reference === 'visit-1');
    assert.equal(entry.step, Step.BOOKED);
    assert.match(entry.note ?? '', /核实/);
    const found = await new PortalClient(portal.url).findBookings('visit-1');
    assert.equal(found.length, 1);
    assert.equal(found[0].receipt, entry.receipt);
  } finally { await portal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('断连后核实门户无记录才允许再约；核实请求本身失败则保持待核实', async () => {
  const portal = await startPortal();
  const directory = await mkdtemp(join(tmpdir(), 'automation-unknown-'));
  try {
    const { recordRepo, workflowRepo, service } = await buildStack(portal, directory);
    await service.syncFromRecords(await recordRepo.read());
    // 场景一：查询通道断连，条目留在 confirm-unknown，不做任何预约。
    portal.loseNextBookings();
    await workflowRepo.replace([{
      reference: 'visit-1', step: Step.CONFIRM_UNKNOWN, label: 'Local Guest', slot: 'A',
      documentType: 'passport', receipt: null, bookingRevision: null, missing: [],
      note: 'seeded', attempts: 1, updatedAt: new Date().toISOString(),
    }]);
    service.entries = null;
    await service.run();
    assert.equal(stepMap(await service.status())['visit-1'], Step.FAILED);
    assert.deepEqual(await new PortalClient(portal.url).findBookings('visit-1'), []);

    // 场景二：门户确实无记录，下一轮核实后重新提交并成功。
    const restarted = new AutomationService(new PortalClient(portal.url), workflowRepo, recordRepo);
    const fixed = (await restarted.status()).find((entry) => entry.reference === 'visit-1');
    await workflowRepo.replace([{ ...fixed, step: Step.CONFIRM_UNKNOWN }]);
    restarted.entries = null;
    await restarted.run();
    const entry = (await restarted.status()).find((item) => item.reference === 'visit-1');
    assert.equal(entry.step, Step.BOOKED);
    assert.ok(entry.receipt);
  } finally { await portal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('会话失效后重建会话：草稿中断重放、确认中断下一轮恢复', async () => {
  const portal = await startPortal();
  const directory = await mkdtemp(join(tmpdir(), 'automation-session-'));
  try {
    const { recordRepo, workflowRepo } = await buildStack(portal, directory);
    await recordRepo.read();
    // 预置一个停在确认页的条目，客户端持有旧会话且门户已使会话失效。
    const stale = new PortalClient(portal.url);
    await stale.startSession();
    await stale.submitDraft({ reference: 'visit-1', name: 'Local Guest', slot: 'A' });
    portal.expireSessions();
    await workflowRepo.replace([{
      reference: 'visit-1', step: Step.AWAITING_CONFIRM, label: 'Local Guest', slot: 'A',
      documentType: 'passport', receipt: null, bookingRevision: null, missing: [],
      note: 'seeded', attempts: 1, updatedAt: new Date().toISOString(),
    }]);
    const service = new AutomationService(stale, workflowRepo, recordRepo);
    await service.run();
    assert.equal(stepMap(await service.status())['visit-1'], Step.BOOKED);

    // 确认瞬间 403：条目回到确认页，下一轮换会话完成。
    const flapping = new PortalClient(portal.url);
    const originalConfirm = flapping.confirmBooking.bind(flapping);
    let confirmCalls = 0;
    flapping.confirmBooking = async (doc) => {
      if (confirmCalls++ === 0) throw new SessionExpiredError();
      return originalConfirm(doc);
    };
    const other = new AutomationService(flapping, workflowRepo, recordRepo);
    await workflowRepo.replace([{
      reference: 'visit-2', step: Step.AWAITING_CONFIRM, label: 'Second Guest', slot: 'A',
      documentType: 'identity-card', receipt: null, bookingRevision: null, missing: [],
      note: 'seeded', attempts: 1, updatedAt: new Date().toISOString(),
    }]);
    other.entries = null;
    await other.run();
    assert.equal(stepMap(await other.status())['visit-2'], Step.AWAITING_CONFIRM);
    await other.run();
    assert.equal(stepMap(await other.status())['visit-2'], Step.BOOKED);
  } finally { await portal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('撤销与门户状态对齐：成功、断连核实、重复撤销幂等、无记录拒绝撤销', async () => {
  const portal = await startPortal({ capacity: 2 });
  const directory = await mkdtemp(join(tmpdir(), 'automation-cancel-'));
  try {
    const { recordRepo, workflowRepo, service } = await buildStack(portal, directory);
    await service.syncFromRecords(await recordRepo.read());
    await service.run();
    const before = (await service.status()).find((entry) => entry.reference === 'visit-1');
    assert.equal(before.step, Step.BOOKED);

    portal.loseNextCancel();
    const cancelled = await service.cancel('visit-1');
    assert.equal(cancelled.step, Step.CANCELLED);
    assert.equal(cancelled.reconciled, true);
    const again = await service.cancel('visit-1');
    assert.equal(again.unchanged, true);
    const portalState = await new PortalClient(portal.url).findBookings('visit-1');
    assert.equal(portalState[0].status, 'cancelled');

    // 门户查不到预约时不能假装撤销成功。
    const missing = await service.cancel('visit-4');
    assert.equal(missing.step, Step.FAILED);
    assert.match((await service.status()).find((entry) => entry.reference === 'visit-4').note, /查不到/);
  } finally { await portal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('进程在撤销断连后重启，新实例仍能凭门户事实说明状态', async () => {
  const portal = await startPortal();
  const directory = await mkdtemp(join(tmpdir(), 'automation-cancel-restart-'));
  try {
    const { recordRepo, workflowRepo, service } = await buildStack(portal, directory);
    await service.syncFromRecords(await recordRepo.read());
    await service.run();
    const booked = (await service.status()).find((entry) => entry.reference === 'visit-1');
    // 模拟撤销请求已发出、响应丢失后进程崩溃。
    await workflowRepo.replace([{
      ...booked, step: Step.CANCELLING_UNKNOWN, note: 'connection lost',
    }]);
    const restarted = new AutomationService(new PortalClient(portal.url), workflowRepo, recordRepo);
    await restarted.run();
    const entry = (await restarted.status()).find((item) => item.reference === 'visit-1');
    assert.equal(entry.step, Step.CANCELLED);
    assert.ok(entry.receipt);
  } finally { await portal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('改期与人工 rearm 让留待条目重新进入队列，终态拒绝重置', async () => {
  const portal = await startPortal({ capacity: 1 });
  const directory = await mkdtemp(join(tmpdir(), 'automation-rearm-'));
  try {
    const { recordRepo, service } = await buildStack(portal, directory);
    await service.syncFromRecords(await recordRepo.read());
    await service.run();
    assert.equal(stepMap(await service.status())['visit-2'], Step.SLOT_FULL);

    // 改期：来源观察中的 slot 变化后，下一次同步自动重新排入。
    const records = await recordRepo.read();
    const visit2 = records.find((record) => record.sourceId === 'visit-2');
    visit2.attributes.slot = 'B';
    visit2.observedAt = '2026-11-18T10:00:00Z';
    await recordRepo.replace(records);
    await service.syncFromRecords(records);
    assert.equal(stepMap(await service.status())['visit-2'], Step.PENDING);
    await service.run();
    assert.equal(stepMap(await service.status())['visit-2'], Step.BOOKED);

    // 人工 rearm：把资料不足条目重新排入；对已预约终态拒绝。
    await assert.rejects(service.rearm('visit-2'), /cannot be re-armed/);
    const armed = await service.rearm('visit-4');
    assert.equal(armed.step, Step.PENDING);
    assert.equal(stepMap(await service.status())['visit-4'], Step.PENDING);
  } finally { await portal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('不传工作流仓库时业务读取保持原有结构', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automation-ops-'));
  try {
    const recordRepo = new RecordRepository(join(directory, 'records.json'));
    const records = JSON.parse(await readFile(fixtureUrl, 'utf8'));
    await new CollectionService(recordRepo).ingest(records);
    const view = await readOperations(recordRepo);
    assert.equal(view.product, '访客预约登记台');
    assert.equal(view.rows.length, 6);
    assert.equal(view.rows[0].workflow, undefined);
    assert.equal(view.rows[0].booking, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
