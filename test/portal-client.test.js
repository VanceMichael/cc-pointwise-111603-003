import test from 'node:test';
import assert from 'node:assert/strict';
import { startPortal } from '../source/portal.js';
import {
  PortalClient, SessionExpiredError, SlotFullError, MissingMaterialError, AmbiguousOutcome, parseForm,
} from '../src/portal-client.js';

const guest = { reference: 'visit-1', name: 'Local Guest', slot: 'A' };

test('客户端走完草稿与证件确认两步并取得回执', async () => {
  const portal = await startPortal();
  try {
    const client = new PortalClient(portal.url);
    const draftForm = await client.startSession();
    assert.equal(draftForm.action, '/portal/draft');
    const confirmPage = await client.submitDraft(guest);
    assert.equal(confirmPage.requiresDocument, true);
    assert.deepEqual(confirmPage.requiredFields, ['documentType']);
    const booking = await client.confirmBooking('passport');
    assert.equal(booking.reference, 'visit-1');
    assert.ok(booking.receipt);
    const found = await client.findBookings('visit-1');
    assert.equal(found[0].receipt, booking.receipt);
    const cancelled = await client.cancelBooking(booking.receipt);
    assert.equal(cancelled.status, 'cancelled');
  } finally { await portal.close(); }
});

test('确认页不要证件时不提交 documentType 也能完成', async () => {
  const portal = await startPortal({ requireDocument: false });
  try {
    const client = new PortalClient(portal.url);
    await client.startSession();
    const confirmPage = await client.submitDraft(guest);
    assert.equal(confirmPage.requiresDocument, false);
    const booking = await client.confirmBooking(null);
    assert.equal(booking.reference, 'visit-1');
  } finally { await portal.close(); }
});

test('资料不足与时段冲突映射为类型化错误', async () => {
  const portal = await startPortal({ capacity: 1 });
  try {
    const client = new PortalClient(portal.url);
    await client.startSession();
    await assert.rejects(client.confirmBooking('driving-license'), (error) => {
      assert.ok(error instanceof MissingMaterialError);
      return true;
    });
    await client.submitDraft(guest);
    await client.confirmBooking('passport');
    const other = new PortalClient(portal.url);
    await other.startSession();
    await other.submitDraft({ reference: 'visit-2', name: 'Other', slot: 'A' });
    await assert.rejects(other.confirmBooking('passport'), (error) => {
      assert.ok(error instanceof SlotFullError);
      assert.equal(typeof error.revision, 'number');
      return true;
    });
  } finally { await portal.close(); }
});

test('回执写入后断连抛 AmbiguousOutcome 且门户记录确实存在', async () => {
  const portal = await startPortal();
  portal.loseNextReceipt();
  try {
    const client = new PortalClient(portal.url);
    await client.startSession();
    await client.submitDraft(guest);
    await assert.rejects(client.confirmBooking('passport'), (error) => {
      assert.ok(error instanceof AmbiguousOutcome);
      assert.equal(error.stage, 'confirm');
      return true;
    });
    // 会话仍然有效，可直接用业务标识核实。
    const found = await client.findBookings('visit-1');
    assert.equal(found.length, 1);
    assert.equal(found[0].status, 'confirmed');
  } finally { await portal.close(); }
});

test('会话过期后 POST 返回 SessionExpiredError，新建会话可继续', async () => {
  const portal = await startPortal();
  try {
    const client = new PortalClient(portal.url);
    await client.startSession();
    await client.submitDraft(guest);
    portal.expireSessions();
    await assert.rejects(client.confirmBooking('passport'), SessionExpiredError);
    assert.equal(client.csrf, null);
    await client.startSession();
    await client.submitDraft(guest);
    const confirmed = await client.confirmBooking('passport');
    assert.ok(confirmed.receipt);
  } finally { await portal.close(); }
});

test('撤销与查询断连同样以可区分方式暴露，且只允许回环门户', async () => {
  assert.throws(() => new PortalClient('https://example.com'), /local portal required/);
  const portal = await startPortal();
  try {
    const client = new PortalClient(portal.url);
    await client.startSession();
    await client.submitDraft(guest);
    const confirmed = await client.confirmBooking('passport');
    portal.loseNextCancel();
    await assert.rejects(client.cancelBooking(confirmed.receipt), (error) => {
      assert.ok(error instanceof AmbiguousOutcome);
      assert.equal(error.stage, 'cancel');
      return true;
    });
    portal.loseNextBookings();
    await assert.rejects(client.findBookings('visit-1'), (error) => {
      assert.ok(!(error instanceof AmbiguousOutcome), 'GET 断连不应伪装成写请求的状态未知');
      return true;
    });
  } finally { await portal.close(); }
});

test('parseForm 提取动作、隐藏值与必填字段', () => {
  const form = parseForm('<form action="/portal/confirm" method="post">'
    + '<input name="csrf" type="hidden" value="t-1"><input name="documentType" required></form>');
  assert.equal(form.action, '/portal/confirm');
  assert.deepEqual(form.inputs.map((input) => input.name), ['csrf', 'documentType']);
  assert.deepEqual(form.requiredFields, ['documentType']);
});
