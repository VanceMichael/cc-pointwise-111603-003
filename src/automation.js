import { Step, StepLabel, createEntry, missingDraftMaterials, missingDocumentMaterials, refreshEntry, DOCUMENT_TYPES } from './workflow.js';
import { AmbiguousOutcome, SessionExpiredError, SlotFullError, MissingMaterialError } from './portal-client.js';

const MAX_ATTEMPTS = 3;

// 可向前推进的步骤；已预约/已撤销等终态与留待处理状态不会被自动跳过。
const ACTIONABLE = new Set([
  Step.PENDING, Step.AWAITING_CONFIRM, Step.CONFIRM_UNKNOWN,
  Step.CANCELLING, Step.CANCELLING_UNKNOWN, Step.FAILED,
]);

export class AutomationService {
  constructor(portal, workflowRepository, recordRepository, { now = () => new Date().toISOString() } = {}) {
    this.portal = portal;
    this.workflowRepository = workflowRepository;
    this.recordRepository = recordRepository;
    this.now = now;
    this.entries = null;
  }

  async #load() {
    if (this.entries === null) this.entries = await this.workflowRepository.read();
    return this.entries;
  }

  async #persist() {
    await this.workflowRepository.replace(this.entries);
  }

  #find(reference) {
    return this.entries.find((entry) => entry.reference === reference);
  }

  // 以本地待办集合为准同步工作流条目：新增的访客进入 pending，已存在的只刷新资料快照。
  async syncFromRecords(records) {
    await this.#load();
    for (const record of records) {
      const attributes = { ...record.attributes, reference: String(record.attributes?.reference ?? record.sourceId) };
      const existing = this.#find(attributes.reference);
      if (!existing) {
        this.entries.push(createEntry(attributes, this.now()));
        continue;
      }
      const previouslyMissing = existing.missing ?? [];
      const previousSlot = existing.slot;
      refreshEntry(existing, attributes, this.now());
      // 留待处理的条目：此前缺失的资料已补齐才重新排入队列，未补齐保持留待。
      if (existing.step === Step.WAITING_MATERIALS && previouslyMissing.length
        && previouslyMissing.every((field) => this.#hasMaterial(attributes, field))) {
        await this.#mark(existing, Step.PENDING, { missing: [], note: '资料已补齐，重新提交' });
      } else if (existing.step === Step.SLOT_FULL && previousSlot
        && attributes.slot && previousSlot !== String(attributes.slot)) {
        // 前台改期：请求时段变化后允许重新提交。
        await this.#mark(existing, Step.PENDING, { missing: [], note: '时段已调整，重新提交' });
      }
    }
    this.entries.sort((left, right) => left.reference.localeCompare(right.reference));
    await this.#persist();
    return { tracked: this.entries.length };
  }

  #hasMaterial(attributes, field) {
    if (field === 'documentType') return DOCUMENT_TYPES.includes(attributes.documentType);
    return Boolean(String(attributes[field] ?? '').trim());
  }

  // 跑一轮：所有可推进的条目按当前步骤恢复执行；单条失败不影响其它访客。
  async run() {
    await this.#load();
    const results = [];
    for (const entry of [...this.entries]) {
      if (!ACTIONABLE.has(entry.step)) continue;
      try {
        const outcome = await this.#processEntry(entry);
        if (outcome) results.push({ reference: entry.reference, ...outcome });
      } catch (error) {
        await this.#mark(entry, Step.FAILED, {
          note: `${error.name ?? 'Error'}: ${error.message}`,
        });
        results.push({ reference: entry.reference, step: Step.FAILED, error: error.message });
      }
    }
    return { processed: results.length, results };
  }

  async status() {
    await this.#load();
    return this.entries.map((entry) => ({ ...entry, stepLabel: StepLabel[entry.step] ?? entry.step }));
  }

  // 人工处理完留待事项后重新排入队列；终态（已预约/已撤销/在途）不允许重置。
  static REARMABLE = new Set([
    Step.WAITING_MATERIALS, Step.SLOT_FULL, Step.CONFIRM_UNKNOWN,
    Step.CANCELLING_UNKNOWN, Step.FAILED,
  ]);

  async rearm(reference) {
    await this.#load();
    const entry = this.#find(reference);
    if (!entry) throw new Error(`unknown visitor reference: ${reference}`);
    if (!AutomationService.REARMABLE.has(entry.step)) {
      throw new Error(`reference ${reference} at ${entry.step} cannot be re-armed`);
    }
    await this.#mark(entry, Step.PENDING, { missing: [], note: '人工处理后重新排入队列' });
    return { reference, step: Step.PENDING };
  }

  #mark(entry, step, patch = {}) {
    Object.assign(entry, patch, { step, updatedAt: this.now() });
    return this.#persist();
  }

  async #processEntry(entry) {
    switch (entry.step) {
      case Step.PENDING:
      case Step.FAILED:
        return this.#book(entry);
      case Step.AWAITING_CONFIRM:
        // 会话失效后重启：重新建会话并从第一步重放草稿，门户草稿本就绑定会话。
        return this.#book(entry);
      case Step.CONFIRM_UNKNOWN:
        return this.#reconcileConfirm(entry);
      case Step.CANCELLING:
      case Step.CANCELLING_UNKNOWN:
        return this.#reconcileCancel(entry);
      default:
        return null;
    }
  }

  // ---- 预约主流程：识别当前页面所需资料，拿到回执才算已预约 -------------------
  async #book(entry) {
    if (entry.attempts >= MAX_ATTEMPTS) {
      return { step: entry.step, note: 'max attempts reached; waiting for manual handling' };
    }
    entry.attempts += 1;
    const attributes = await this.#latestAttributes(entry.reference);

    // 第一步页面：草稿所需资料不足，留待处理，不向门户发任何请求。
    const draftMissing = missingDraftMaterials(attributes);
    if (draftMissing.length) {
      await this.#mark(entry, Step.WAITING_MATERIALS, { missing: draftMissing, note: '草稿页资料不足' });
      return { step: Step.WAITING_MATERIALS, missing: draftMissing };
    }

    await this.#ensureSession();
    let confirmPage;
    try {
      confirmPage = await this.portal.submitDraft({
        reference: entry.reference, name: attributes.name, slot: attributes.slot,
      });
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        await this.#ensureSession(true);
        confirmPage = await this.portal.submitDraft({
          reference: entry.reference, name: attributes.name, slot: attributes.slot,
        });
      } else throw error;
    }
    await this.#mark(entry, Step.AWAITING_CONFIRM, {
      missing: [], note: '草稿已提交，等待证件类型确认',
    });

    // 第二步页面：按页面实际要求核对证件类型。
    const documentMissing = missingDocumentMaterials(attributes, confirmPage.requiresDocument);
    if (documentMissing.length) {
      await this.#mark(entry, Step.WAITING_MATERIALS, {
        missing: documentMissing, note: '证件类型确认页资料不足',
      });
      return { step: Step.WAITING_MATERIALS, missing: documentMissing };
    }
    if (!confirmPage.requiresDocument) entry.documentType = null;

    try {
      const booking = await this.portal.confirmBooking(attributes.documentType);
      await this.#mark(entry, Step.BOOKED, {
        receipt: booking.receipt,
        bookingRevision: booking.revision ?? null,
        slot: booking.slot ?? entry.slot,
        missing: [], note: '门户已确认预约',
      });
      return { step: Step.BOOKED, receipt: booking.receipt };
    } catch (error) {
      if (error instanceof AmbiguousOutcome) {
        // 本地没收到响应绝不重约，先落 unknown，再用业务标识核实门户记录。
        await this.#mark(entry, Step.CONFIRM_UNKNOWN, { note: '确认提交后连接中断，待核实门户事实' });
        return this.#reconcileConfirm(entry);
      }
      if (error instanceof SlotFullError) {
        await this.#mark(entry, Step.SLOT_FULL, { note: '时段容量已满，留待改期' });
        return { step: Step.SLOT_FULL };
      }
      if (error instanceof MissingMaterialError) {
        await this.#mark(entry, Step.WAITING_MATERIALS, {
          missing: ['documentType'], note: '门户要求补充证件类型',
        });
        return { step: Step.WAITING_MATERIALS, missing: ['documentType'] };
      }
      if (error instanceof SessionExpiredError) {
        // 会话在确认前过期：草稿随会话失效，下一轮从第一步重新提交即可，门户没有落单。
        await this.#mark(entry, Step.AWAITING_CONFIRM, { note: '会话失效，需重建会话重放' });
        return { step: Step.AWAITING_CONFIRM, retry: true };
      }
      throw error;
    }
  }

  // 核实“确认提交后断连”：以 reference 查询门户，已落单就采纳回执，未查到才允许再约。
  async #reconcileConfirm(entry) {
    let bookings;
    try {
      bookings = await this.portal.findBookings(entry.reference);
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        await this.#ensureSession(true);
        bookings = await this.portal.findBookings(entry.reference);
      } else throw error;
    }
    const confirmed = bookings.filter((booking) => booking.status === 'confirmed');
    const cancelled = bookings.filter((booking) => booking.status === 'cancelled');
    if (confirmed.length) {
      const booking = confirmed[confirmed.length - 1];
      await this.#mark(entry, Step.BOOKED, {
        receipt: booking.receipt,
        bookingRevision: booking.revision ?? null,
        slot: booking.slot ?? entry.slot,
        note: '断连后经门户核实：预约已存在，采纳门户回执',
      });
      return { step: Step.BOOKED, receipt: booking.receipt, reconciled: true };
    }
    if (cancelled.length && !confirmed.length) {
      const booking = cancelled[cancelled.length - 1];
      await this.#mark(entry, Step.CANCELLED, {
        receipt: booking.receipt, bookingRevision: booking.revision ?? null,
        note: '经门户核实：该预约已撤销',
      });
      return { step: Step.CANCELLED, reconciled: true };
    }
    // 门户无记录：确认请求没有落单，才允许重新提交；限次避免故障期反复请求。
    if (entry.attempts >= MAX_ATTEMPTS) {
      await this.#mark(entry, Step.CONFIRM_UNKNOWN, { note: '门户暂未查到记录且重试次数已尽，留待人工核实' });
      return { step: Step.CONFIRM_UNKNOWN, note: 'manual verification required' };
    }
    await this.#mark(entry, Step.PENDING, { note: '门户无此预约，重新提交' });
    return this.#book(entry);
  }

  // ---- 撤销：先对齐门户状态再动作，结果不明同样先核实 -------------------------
  async cancel(reference) {
    await this.#load();
    const entry = this.#find(reference);
    if (!entry) throw new Error(`unknown visitor reference: ${reference}`);
    if (entry.step === Step.CANCELLED) return { reference, step: Step.CANCELLED, unchanged: true };

    // 撤销前先用业务标识核实门户记录，撤销必须与门户状态对上。
    let bookings;
    try {
      bookings = await this.portal.findBookings(reference);
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        await this.#ensureSession(true);
        bookings = await this.portal.findBookings(reference);
      } else throw error;
    }
    const live = bookings.filter((booking) => booking.status === 'confirmed');
    if (!live.length) {
      const known = bookings[bookings.length - 1];
      if (known) {
        await this.#mark(entry, Step.CANCELLED, {
          receipt: known.receipt, bookingRevision: known.revision ?? null,
          note: '门户记录已是撤销状态',
        });
      } else {
        await this.#mark(entry, Step.FAILED, { note: '门户查不到该预约，无法撤销' });
      }
      return { step: entry.step };
    }
    const booking = live[live.length - 1];
    await this.#ensureSession();
    await this.#mark(entry, Step.CANCELLING, {
      receipt: booking.receipt, bookingRevision: booking.revision ?? null, note: '撤销请求已发出',
    });
    try {
      const updated = await this.portal.cancelBooking(booking.receipt);
      await this.#mark(entry, Step.CANCELLED, {
        receipt: updated.receipt ?? booking.receipt,
        bookingRevision: updated.revision ?? entry.bookingRevision,
        note: '门户已确认撤销',
      });
      return { step: Step.CANCELLED, receipt: entry.receipt };
    } catch (error) {
      if (error instanceof AmbiguousOutcome) {
        await this.#mark(entry, Step.CANCELLING_UNKNOWN, { note: '撤销提交后连接中断，待核实门户状态' });
        return this.#reconcileCancel(entry);
      }
      if (error instanceof SessionExpiredError) {
        await this.#mark(entry, Step.CANCELLING, { note: '会话失效，下一轮重建会话后核实' });
        return { step: Step.CANCELLING, retry: true };
      }
      throw error;
    }
  }

  async #reconcileCancel(entry) {
    let bookings;
    try {
      bookings = await this.portal.findBookings(entry.reference);
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        await this.#ensureSession(true);
        bookings = await this.portal.findBookings(entry.reference);
      } else throw error;
    }
    const confirmed = bookings.filter((booking) => booking.status === 'confirmed');
    const cancelled = bookings.filter((booking) => booking.status === 'cancelled');
    if (cancelled.length) {
      const booking = cancelled[cancelled.length - 1];
      await this.#mark(entry, Step.CANCELLED, {
        receipt: booking.receipt, bookingRevision: booking.revision ?? null,
        note: '断连后经门户核实：撤销已生效',
      });
      return { step: Step.CANCELLED, reconciled: true };
    }
    if (!confirmed.length) {
      await this.#mark(entry, Step.FAILED, { note: '门户查不到该预约，无法继续撤销' });
      return { step: Step.FAILED };
    }
    // 门户仍是 confirmed：撤销没有生效，重新撤销，限次保护。
    if (entry.attempts >= MAX_ATTEMPTS) {
      await this.#mark(entry, Step.CANCELLING_UNKNOWN, { note: '撤销重试次数已尽，留待人工处理' });
      return { step: Step.CANCELLING_UNKNOWN, note: 'manual handling required' };
    }
    entry.attempts += 1;
    const booking = confirmed[confirmed.length - 1];
    await this.#ensureSession();
    await this.#mark(entry, Step.CANCELLING, { receipt: booking.receipt, note: '门户仍为已预约，重新撤销' });
    try {
      const updated = await this.portal.cancelBooking(booking.receipt);
      await this.#mark(entry, Step.CANCELLED, {
        receipt: updated.receipt ?? booking.receipt,
        bookingRevision: updated.revision ?? entry.bookingRevision,
      });
      return { step: Step.CANCELLED, retried: true };
    } catch (error) {
      if (error instanceof AmbiguousOutcome) {
        await this.#mark(entry, Step.CANCELLING_UNKNOWN, { note: '再次断连，待核实' });
        return { step: Step.CANCELLING_UNKNOWN };
      }
      if (error instanceof SessionExpiredError) {
        await this.#mark(entry, Step.CANCELLING, { note: '会话失效，下一轮重试' });
        return { step: Step.CANCELLING, retry: true };
      }
      throw error;
    }
  }

  async #ensureSession(force = false) {
    if (!force && this.portal.csrf) return;
    await this.portal.startSession();
  }

  // 工作流只存资料快照，真正的资料以本地业务集合中的最新观察为准。
  async #latestAttributes(reference) {
    const records = await this.recordRepository.read();
    const record = records.find((item) => String(item.attributes?.reference ?? item.sourceId) === reference);
    return { reference, ...(record?.attributes ?? {}) };
  }
}
