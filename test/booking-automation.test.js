import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPortal } from '../source/portal.js';
import { RecordRepository } from '../src/repository.js';
import { BookingStateRepository, STEP } from '../src/booking-state.js';
import { BookingAutomation } from '../src/booking-automation.js';
import { PortalClient, PortalHttpError, describeForm, PortalConnectionLost } from '../src/portal-client.js';
import { readOperations } from '../src/operations.js';

const record = (overrides = {}) => {
  const values = { reference: 'visit-1', name: 'Local Guest', slot: 'A',
    documentType: 'passport', status: 'requested', ...overrides };
  return {
    sourceId: values.reference,
    source: '访客预约登记台',
    observedAt: '2026-11-16T08:00:00Z',
    label: values.name,
    attributes: {
      reference: values.reference,
      name: values.name,
      slot: values.slot,
      requestedAt: '2026-11-16T08:00:00Z',
      documentType: values.documentType,
      status: values.status,
    },
  };
};

async function harness(portal, records, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'booking-'));
  const recordRepository = new RecordRepository(join(directory, 'records.json'));
  const bookingRepository = new BookingStateRepository(join(directory, 'bookings.json'));
  await new (await import('../src/service.js')).CollectionService(recordRepository).ingest(records);
  const automation = new BookingAutomation(
    bookingRepository, recordRepository, new PortalClient(portal.url), options,
  );
  return {
    directory,
    recordRepository,
    bookingRepository,
    automation,
    async cleanup() { await rm(directory, { recursive: true, force: true }); },
  };
}

test('两步表单识别：会话首页与证件确认页所需资料可解析', async () => {
  const portal = await startPortal();
  try {
    const client = new PortalClient(portal.url);
    const opening = await client.openSession();
    assert.deepEqual(opening.fields.sort(), ['csrf', 'name', 'reference', 'revision', 'slot'].sort());
    const confirm = await client.submitDraft({ reference: 'visit-x', name: 'N', slot: 'A' });
    assert.equal(confirm.requiresDocument, true);
    assert.deepEqual(confirm.requiredFields, ['documentType']);
    assert.throws(() => new PortalClient('http://example.com'), /local portal required/);
  } finally { await portal.close(); }
});

test('完整预约：只有取得 201 回执后才标记已预约，前台视图可见步骤', async () => {
  const portal = await startPortal();
  const h = await harness(portal, [record()]);
  try {
    const summary = await h.automation.sync();
    assert.equal(summary.booked, 1);
    const status = await h.automation.status();
    const visit = status.visits[0];
    assert.equal(visit.step, STEP.BOOKED);
    assert.ok(visit.receipt, '必须保存门户回执');
    assert.match(visit.detail, /预约编号/);
    const operations = await readOperations(h.recordRepository, h.bookingRepository);
    assert.equal(operations.rows[0].booking.step, STEP.BOOKED);
    assert.ok(operations.rows[0].booking.receipt);
    const portalRecords = await (await fetch(`${portal.url}/portal/bookings?reference=visit-1`)).json();
    assert.equal(portalRecords.bookings[0].receipt, visit.receipt);
  } finally { await portal.close(); await h.cleanup(); }
});

test('资料不足：缺少证件类型的项目留待处理，不产生门户预约', async () => {
  const portal = await startPortal();
  const h = await harness(portal, [record({ documentType: null })]);
  try {
    const summary = await h.automation.sync();
    assert.equal(summary.needsMaterial, 1);
    assert.equal(summary.booked, 0);
    const visit = (await h.automation.status()).visits[0];
    assert.equal(visit.step, STEP.NEEDS_MATERIAL);
    assert.match(visit.detail, /documentType/);
    const portalRecords = await (await fetch(`${portal.url}/portal/bookings?reference=visit-1`)).json();
    assert.equal(portalRecords.bookings.length, 0);
    // 补齐资料后再次运行即可完成预约。
    const stored = await h.recordRepository.read();
    await h.recordRepository.replace(stored.map((entry) => ({
      ...entry,
      attributes: { ...entry.attributes, documentType: 'identity-card' },
    })));
    const rerun = await h.automation.sync();
    assert.equal(rerun.booked, 1);
  } finally { await portal.close(); await h.cleanup(); }
});

test('时段冲突：409 项目保留为冲突待处理，其它访客照常预约', async () => {
  const portal = await startPortal({ capacity: 1 });
  const h = await harness(portal, [
    record({ reference: 'visit-1', slot: 'A' }),
    record({ reference: 'visit-2', name: 'Second Guest', slot: 'A' }),
    record({ reference: 'visit-3', name: 'Third Guest', slot: 'B' }),
  ]);
  try {
    const summary = await h.automation.sync();
    assert.equal(summary.booked, 2);
    assert.equal(summary.slotConflicts, 1);
    const byRef = new Map((await h.automation.status()).visits.map((visit) => [visit.reference, visit]));
    assert.equal(byRef.get('visit-2').step, STEP.SLOT_CONFLICT);
    assert.equal(byRef.get('visit-3').step, STEP.BOOKED);
  } finally { await portal.close(); await h.cleanup(); }
});

test('回执断线：先以业务标识核实门户，存在预约则补登回执，不重复预约', async () => {
  const portal = await startPortal();
  const h = await harness(portal, [record()]);
  try {
    portal.loseNextReceipt();
    const first = await h.automation.sync();
    assert.equal(first.recovering, 1, '本地未收到响应时只能停在待核实');
    const before = (await h.automation.status()).visits[0];
    assert.equal(before.step, STEP.RECOVERING);
    assert.equal(before.receipt, null);
    const requestsBefore = portal.requests.filter((request) => request.path === '/portal/confirm').length;
    const second = await h.automation.sync();
    assert.equal(second.booked, 1);
    const after = (await h.automation.status()).visits[0];
    assert.equal(after.step, STEP.BOOKED);
    assert.ok(after.receipt);
    // 恢复过程只做查询核实，不能再次提交确认。
    const requestsAfter = portal.requests.filter((request) => request.path === '/portal/confirm').length;
    assert.equal(requestsAfter, requestsBefore);
  } finally { await portal.close(); await h.cleanup(); }
});

test('提交前门户已有预约：直接同步回执，绝不重复预约', async () => {
  const portal = await startPortal();
  const h = await harness(portal, [record()]);
  try {
    // 先正常跑一次取得预约。
    await h.automation.sync();
    const receipt = (await h.automation.status()).visits[0].receipt;
    // 模拟本地状态丢失（保留记录但清空预约状态库）。
    await h.bookingRepository.replace({ version: 1, portalUrl: portal.url, visits: [] });
    const fresh = new BookingAutomation(h.bookingRepository, h.recordRepository, new PortalClient(portal.url));
    const summary = await fresh.sync();
    assert.equal(summary.booked, 1);
    assert.equal((await fresh.status()).visits[0].receipt, receipt);
    const confirms = portal.requests.filter((request) => request.path === '/portal/confirm').length;
    assert.equal(confirms, 1, '只有首次真正提交过一次确认');
  } finally { await portal.close(); await h.cleanup(); }
});

test('会话失效：过期后重启任务可自动新开会话并说明每位访客的步骤', async () => {
  const portal = await startPortal();
  const h = await harness(portal, [
    record({ reference: 'visit-1', slot: 'A' }),
    record({ reference: 'visit-2', name: 'Second Guest', slot: 'B' }),
  ]);
  try {
    await h.automation.sync();
    assert.equal((await h.automation.status()).visits.length, 2);
    portal.expireSessions();
    // 旧会话上的操作应得到 403，客户端明确区分会话失效。
    await assert.rejects(h.automation.portal.cancel('any'), /session expired/);
    // 用新进程等价的自动化实例（空内存会话）续跑，自动重新建立会话。
    const restarted = new BookingAutomation(h.bookingRepository, h.recordRepository, new PortalClient(portal.url));
    const status = await restarted.status();
    assert.deepEqual(status.visits.map((visit) => visit.step), [STEP.BOOKED, STEP.BOOKED]);
    const cancelled = await restarted.cancel('visit-2');
    assert.equal(cancelled.step, STEP.CANCELLED);
    const again = await restarted.status();
    assert.equal(again.visits.find((visit) => visit.reference === 'visit-1').step, STEP.BOOKED);
    assert.equal(again.visits.find((visit) => visit.reference === 'visit-2').step, STEP.CANCELLED);
  } finally { await portal.close(); await h.cleanup(); }
});

test('撤销与门户状态对齐：已预约撤销成功，重复撤销幂等', async () => {
  const portal = await startPortal();
  const h = await harness(portal, [record()]);
  try {
    await h.automation.sync();
    const cancelled = await h.automation.cancel('visit-1');
    assert.equal(cancelled.step, STEP.CANCELLED);
    const portalRecords = await (await fetch(`${portal.url}/portal/bookings?reference=visit-1`)).json();
    assert.equal(portalRecords.bookings[0].status, 'cancelled');
    const again = await h.automation.cancel('visit-1');
    assert.equal(again.step, STEP.CANCELLED);
    const cancels = portal.requests.filter((request) => request.method === 'POST' && request.path === '/portal/cancel').length;
    assert.equal(cancels, 1);
  } finally { await portal.close(); await h.cleanup(); }
});

test('来源标记取消：同步时自动与门户核对并撤销既有预约', async () => {
  const portal = await startPortal();
  const h = await harness(portal, [record()]);
  try {
    await h.automation.sync();
    const stored = await h.recordRepository.read();
    await h.recordRepository.replace(stored.map((entry) => ({
      ...entry,
      attributes: { ...entry.attributes, status: 'cancelled' },
    })));
    const summary = await h.automation.sync();
    assert.equal(summary.cancelled, 1);
    const portalRecords = await (await fetch(`${portal.url}/portal/bookings?reference=visit-1`)).json();
    assert.equal(portalRecords.bookings[0].status, 'cancelled');
  } finally { await portal.close(); await h.cleanup(); }
});

class FlakyClient extends PortalClient {
  constructor(portalUrl, { failConfirmOnce = false } = {}) {
    super(portalUrl);
    this.failConfirmOnce = failConfirmOnce;
  }

  async confirm(payload) {
    if (this.failConfirmOnce) {
      this.failConfirmOnce = false;
      throw new PortalConnectionLost('/portal/confirm', new Error('socket destroyed'));
    }
    return super.confirm(payload);
  }
}

class UnreachableClient extends PortalClient {
  async lookup() {
    throw new PortalConnectionLost('/portal/bookings', new Error('socket destroyed'));
  }
}

test('断线且门户暂不可达：保留待核实步骤，绝不重新提交，门户恢复后再核实', async () => {
  const portal = await startPortal();
  const directory = await mkdtemp(join(tmpdir(), 'booking-flaky-'));
  try {
    const recordRepository = new RecordRepository(join(directory, 'records.json'));
    const bookingRepository = new BookingStateRepository(join(directory, 'bookings.json'));
    await new (await import('../src/service.js')).CollectionService(recordRepository).ingest([record()]);
    const flaky = new FlakyClient(portal.url, { failConfirmOnce: true });
    const automation = new BookingAutomation(bookingRepository, recordRepository, flaky);
    await automation.sync();
    assert.equal((await automation.status()).visits[0].step, STEP.RECOVERING);

    // 第二次运行时门户核实通道整体不可达：必须保留待核实，不得重新提交。
    const offline = new BookingAutomation(bookingRepository, recordRepository, new UnreachableClient(portal.url));
    const summary = await offline.sync();
    assert.equal(summary.recovering, 1, '门户核实也断线时继续保留，绝不重约');
    assert.equal((await offline.status()).visits[0].step, STEP.RECOVERING);

    // 门户恢复后续跑：核实无果也只能继续保留待核实，确认次数始终为 0。
    const recovered = new BookingAutomation(bookingRepository, recordRepository, new PortalClient(portal.url));
    const finalRun = await recovered.sync();
    assert.equal(finalRun.recovering, 1);
    assert.equal((await recovered.status()).visits[0].step, STEP.RECOVERING);
    const confirms = portal.requests.filter((request) => request.path === '/portal/confirm').length;
    assert.equal(confirms, 0, '未核实门户事实前绝不重新提交确认');
  } finally {
    await portal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('冲突留待：资料未改前重复运行不撞门户，改时段后才重试并成功', async () => {
  const portal = await startPortal({ capacity: 1 });
  const h = await harness(portal, [
    record({ reference: 'visit-1', slot: 'A' }),
    record({ reference: 'visit-2', name: 'Second Guest', slot: 'A' }),
  ]);
  try {
    await h.automation.sync();
    const clashRef = 'visit-2';
    const confirmAfterFirst = portal.requests.filter((request) => request.path === '/portal/confirm').length;
    // 再跑两次：留待项不应再次提交。
    await h.automation.sync();
    await h.automation.sync();
    assert.equal(
      portal.requests.filter((request) => request.path === '/portal/confirm').length,
      confirmAfterFirst,
      '留待期间不得反复提交确认',
    );
    // 前台把时段改到空闲的 B。
    const stored = await h.recordRepository.read();
    await h.recordRepository.replace(stored.map((entry) => entry.sourceId === clashRef
      ? { ...entry, attributes: { ...entry.attributes, slot: 'B' } }
      : entry));
    const summary = await h.automation.sync();
    assert.equal(summary.booked, 2);
    const clash = (await h.automation.status()).visits.find((visit) => visit.reference === clashRef);
    assert.equal(clash.step, STEP.BOOKED);
    assert.equal(clash.slot, 'B');
  } finally { await portal.close(); await h.cleanup(); }
});

test('两步之间会话失效：409 no draft 触发重建会话并完成预约，无需人工干预', async () => {
  const portal = await startPortal();
  const h = await harness(portal, [record()]);
  try {
    const real = h.automation.portal;
    let firstConfirm = true;
    h.automation.portal = new Proxy(real, {
      get(target, property) {
        const value = target[property];
        if (property === 'confirm' && firstConfirm) {
          firstConfirm = false;
          return async () => {
            throw new PortalHttpError(409, '/portal/confirm', { error: 'no draft' });
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const summary = await h.automation.sync();
    assert.equal(summary.booked, 1);
    const visit = (await h.automation.status()).visits[0];
    assert.equal(visit.step, STEP.BOOKED);
    assert.ok(visit.events.some((event) => event.kind === 'retry'));
  } finally { await portal.close(); await h.cleanup(); }
});

test('表单描述工具忽略无名称按钮并按 required 标注资料', () => {
  const form = '<form><input type="hidden" name="csrf" value="t"><input name="slot"><input name="documentType" required><button>Confirm</button></form>';
  const described = describeForm(form);
  assert.deepEqual(described.fields, ['csrf', 'slot', 'documentType']);
  assert.deepEqual(described.requiredFields, ['documentType']);
});
