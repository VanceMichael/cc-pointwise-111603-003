import {
  STEP, STEP_LABEL, createVisitState, addEvent, assignStep,
} from './booking-state.js';
import {
  PortalClient, PortalHttpError, PortalSessionExpired, PortalConnectionLost,
} from './portal-client.js';

const TRANSIENT_STEPS = new Set([
  STEP.IMPORTED,
  STEP.DRAFT_SUBMITTED,
  STEP.RECOVERING,
  STEP.SLOT_CONFLICT,
  STEP.FAILED,
]);

function evaluateMaterial(visit) {
  const missing = [];
  if (!visit.reference) missing.push('reference');
  if (!visit.name) missing.push('name');
  if (!visit.slot) missing.push('slot');
  if (!visit.documentType || !['passport', 'identity-card'].includes(visit.documentType)) {
    missing.push('documentType');
  }
  return missing;
}

export class BookingAutomation {
  constructor(bookingRepository, recordRepository, portalClient, { retryConflicts = true } = {}) {
    if (!(portalClient instanceof PortalClient)) throw new TypeError('portalClient required');
    this.bookingRepository = bookingRepository;
    this.recordRepository = recordRepository;
    this.portal = portalClient;
    this.retryConflicts = retryConflicts;
    this.state = null;
  }

  async #load() {
    if (!this.state) {
      this.state = await this.bookingRepository.read();
      this.state.portalUrl = this.portal.baseUrl.toString();
    }
    return this.state;
  }

  async #save() {
    await this.bookingRepository.replace(this.state);
  }

  #visitMap() { return new Map(this.state.visits.map((visit) => [visit.reference, visit])); }

  async #ensureSession() {
    if (this.portal.hasSession) return;
    const form = await this.portal.openSession();
    for (const visit of this.state.visits) {
      if (visit.step === STEP.IMPORTED) addEvent(visit, { kind: 'session', detail: '打开门户会话，首页需要字段：' + form.fields.join(',') });
    }
  }

  async #withSession(work) {
    try {
      await this.#ensureSession();
      return await work();
    } catch (error) {
      if (error instanceof PortalSessionExpired) {
        this.portal.resetSession();
        await this.#ensureSession();
        return work();
      }
      throw error;
    }
  }

  async #lookup(reference) {
    const result = await this.portal.lookup(reference);
    return { bookings: result.bookings ?? [], revision: result.revision ?? null };
  }

  #applyPortalBooking(visit, booking) {
    visit.receipt = booking.receipt;
    visit.portalRevision = booking.revision ?? visit.portalRevision;
    if (booking.status === 'cancelled') {
      assignStep(visit, STEP.CANCELLED, `门户核实为已撤销，回执 ${booking.receipt}`);
    } else {
      assignStep(visit, STEP.BOOKED, `门户已确认，预约编号 ${booking.reference}，回执 ${booking.receipt}`);
    }
    addEvent(visit, { kind: 'verify', step: visit.step, receipt: booking.receipt, detail: '以业务标识核实门户记录' });
  }

  // 断线恢复：只用业务标识核实门户事实，绝不重复预约。
  async reconcile(visit) {
    const outcome = await this.#withSession(() => this.#lookup(visit.reference));
    const live = outcome.bookings.filter((booking) => booking.status === 'confirmed');
    if (live.length) {
      this.#applyPortalBooking(visit, live[0]);
      await this.#save();
      return true;
    }
    const cancelled = outcome.bookings.filter((booking) => booking.status === 'cancelled');
    if (cancelled.length) {
      this.#applyPortalBooking(visit, cancelled[0]);
      await this.#save();
      return true;
    }
    return false;
  }

  async #bookOnce(visit) {
    await this.portal.submitDraft({ reference: visit.reference, name: visit.name, slot: visit.slot });
    assignStep(visit, STEP.DRAFT_SUBMITTED, '草稿页已提交，门户要求确认证件类型 ' + visit.documentType);
    addEvent(visit, { kind: 'draft', slot: visit.slot, detail: '第一步草稿已提交，等待证件类型确认页' });
    await this.#save();
    try {
      const booking = await this.portal.confirm({ documentType: visit.documentType });
      visit.receipt = booking.receipt;
      visit.portalRevision = booking.revision ?? null;
      assignStep(visit, STEP.BOOKED, `门户已确认，预约编号 ${booking.reference}，回执 ${booking.receipt}`);
      addEvent(visit, { kind: 'booked', receipt: booking.receipt, revision: visit.portalRevision });
      await this.#save();
      return STEP.BOOKED;
    } catch (error) {
      if (error instanceof PortalConnectionLost) {
        assignStep(visit, STEP.RECOVERING, '确认后连接中断，本地未收到回执，需先用业务标识核实门户');
        addEvent(visit, { kind: 'disconnect', detail: error.message });
        await this.#save();
        return STEP.RECOVERING;
      }
      throw error;
    }
  }

  async #bookWithRetry(visit) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.#withSession(() => this.#bookOnce(visit));
      } catch (error) {
        if (error instanceof PortalHttpError && error.status === 409 && error.body.error === 'no draft') {
          // 会话在两步之间失效，门户草稿已丢失：重建会话后重走两步表单。
          this.portal.resetSession();
          addEvent(visit, { kind: 'retry', detail: '门户草稿随会话失效，重新开始两步提交' });
          continue;
        }
        throw error;
      }
    }
    throw new Error(`booking retries exhausted for ${visit.reference}`);
  }

  async #book(visit) {
    // 提交前先核实门户，已存在预约则直接同步事实，避免重复预约。
    const existing = await this.#withSession(() => this.#lookup(visit.reference));
    const live = existing.bookings.find((booking) => booking.status === 'confirmed');
    if (live) {
      this.#applyPortalBooking(visit, live);
      addEvent(visit, { kind: 'verify', detail: '提交前门户核实发现既有预约，不重复提交' });
      await this.#save();
      return STEP.BOOKED;
    }
    const cancelled = existing.bookings.find((booking) => booking.status === 'cancelled');
    if (cancelled) {
      this.#applyPortalBooking(visit, cancelled);
      await this.#save();
      return STEP.CANCELLED;
    }
    // 冲突留待项：只有前台修改时段或证件资料后才重试，门户其它预约造成的 revision 变化不解除留待。
    if (visit.step === STEP.SLOT_CONFLICT && !visit.retryEligible) {
      addEvent(visit, { kind: 'conflict-hold', revision: existing.revision, detail: '时段资料未调整，继续留待改约' });
      return STEP.SLOT_CONFLICT;
    }
    if (visit.step === STEP.SLOT_CONFLICT && visit.retryEligible) {
      visit.retryEligible = false;
    }

    const missing = evaluateMaterial(visit);
    if (missing.length) {
      assignStep(visit, STEP.NEEDS_MATERIAL, `资料不足：缺少 ${missing.join('、')}，留待前台补充`);
      addEvent(visit, { kind: 'blocked', missing, detail: '当前页面所需资料未齐备，不提交' });
      await this.#save();
      return STEP.NEEDS_MATERIAL;
    }
    visit.retryEligible = false;

    const outcome = await this.#bookWithRetry(visit);
    return outcome;
  }

  async #cancelWithReceipt(visit, reason) {
    try {
      const booking = await this.#withSession(() => this.portal.cancel(visit.receipt));
      visit.portalRevision = booking.revision ?? visit.portalRevision;
      assignStep(visit, STEP.CANCELLED, `门户已撤销，回执 ${visit.receipt}`);
      addEvent(visit, { kind: 'cancel', receipt: visit.receipt, reason, detail: '门户确认撤销' });
      await this.#save();
      return STEP.CANCELLED;
    } catch (error) {
      if (error instanceof PortalHttpError && error.status === 404) {
        // 门户查无此回执：以业务标识核实，防止本地状态与门户漂移。
        const found = await this.reconcile(visit);
        if (!found) {
          assignStep(visit, STEP.CANCELLED, '门户无对应回执与预约，按已撤销登记');
          addEvent(visit, { kind: 'cancel', reason, detail: '门户查无回执，核实无预约记录' });
          await this.#save();
        }
        return visit.step;
      }
      if (error instanceof PortalConnectionLost) {
        assignStep(visit, STEP.CANCELLING, '撤销请求后连接中断，需核实门户撤销结果');
        addEvent(visit, { kind: 'disconnect', detail: error.message });
        await this.#save();
        return STEP.CANCELLING;
      }
      throw error;
    }
  }

  async #cancelVisit(visit, reason) {
    if (visit.step === STEP.CANCELLED) return visit.step;
    if (visit.receipt) return this.#cancelWithReceipt(visit, reason);
    // 未取得回执：先核实门户，门户有预约则撤销，没有则本地关闭。
    const outcome = await this.#withSession(() => this.#lookup(visit.reference));
    const live = outcome.bookings.find((booking) => booking.status === 'confirmed');
    if (live) {
      this.#applyPortalBooking(visit, live);
      await this.#save();
      return this.#cancelWithReceipt(visit, reason);
    }
    assignStep(visit, STEP.CANCELLED, '门户无预约记录，无需撤销');
    addEvent(visit, { kind: 'cancel', reason, detail: '核实门户无预约，本地标记撤销' });
    await this.#save();
    return STEP.CANCELLED;
  }

  #refreshFromRecords(records) {
    const byReference = this.#visitMap();
    for (const record of records) {
      const reference = record.sourceId;
      let visit = byReference.get(reference);
      if (!visit) {
        visit = createVisitState(reference, record);
        this.state.visits.push(visit);
        addEvent(visit, { kind: 'import', detail: '待办已纳入门户自动化' });
      } else {
        const nextName = record.label ?? visit.name;
        const nextSlot = record.attributes?.slot ?? visit.slot;
        const nextDocument = record.attributes?.documentType ?? visit.documentType;
        // 冲突/缺资料留待后，只有关键资料被修改才允许再次尝试门户。
        if (visit.step === STEP.SLOT_CONFLICT && (nextSlot !== visit.slot || nextDocument !== visit.documentType)) {
          visit.retryEligible = true;
          addEvent(visit, { kind: 'retry-eligible', detail: '时段或证件资料已变更，允许再次尝试预约' });
        }
        if (visit.step === STEP.NEEDS_MATERIAL && nextDocument !== visit.documentType) {
          visit.retryEligible = true;
        }
        visit.name = nextName;
        visit.slot = nextSlot;
        visit.documentType = nextDocument;
      }
      visit.sourceStatus = record.attributes?.status ?? null;
    }
  }

  async sync() {
    const state = await this.#load();
    const records = await this.recordRepository.read();
    this.#refreshFromRecords(records);
    await this.#save();

    const summary = { processed: 0, booked: 0, needsMaterial: 0, slotConflicts: 0,
      cancelled: 0, recovering: 0, failed: 0, pending: 0 };
    const pending = [];
    for (const visit of state.visits) {
      summary.processed += 1;
      if (visit.step === STEP.CANCELLED) {
        summary.cancelled += 1;
        continue;
      }
      if (visit.step === STEP.BOOKED && visit.sourceStatus !== 'cancelled') {
        summary.booked += 1;
        continue;
      }
      pending.push(visit);
    }

    for (const visit of pending) {
      try {
        const sourceCancelled = visit.sourceStatus === 'cancelled';
        if (visit.step === STEP.RECOVERING) {
          const found = await this.reconcile(visit).catch((error) => {
            if (error instanceof PortalConnectionLost || (error instanceof PortalHttpError && error.status >= 500)) {
              addEvent(visit, { kind: 'unreachable', detail: `门户暂不可达，保留在 ${visit.step}` });
              return false;
            }
            throw error;
          });
          if (!found) {
            summary.recovering += 1;
            continue;
          }
          // 已用门户事实定案（已预约/已撤销），不再进入提交流程，杜绝重复预约。
          if (visit.step === STEP.BOOKED) summary.booked += 1;
          if (visit.step === STEP.CANCELLED) summary.cancelled += 1;
          continue;
        }
        if (sourceCancelled) {
          await this.#cancelVisit(visit, '来源待办标记为取消');
        } else if (visit.step === STEP.CANCELLING) {
          await this.#cancelVisit(visit, '重启后续做撤销');
        } else {
          if (visit.step === STEP.SLOT_CONFLICT && !this.retryConflicts) {
            summary.slotConflicts += 1;
            continue;
          }
          await this.#book(visit);
          // 本轮仍判定为冲突：计入留待，等资料变更后再重试。
          if (visit.step === STEP.SLOT_CONFLICT) {
            summary.slotConflicts += 1;
            continue;
          }
        }
      } catch (error) {
        if (error instanceof PortalHttpError && error.status === 409) {
          visit.conflictRevision = error.body.revision ?? visit.portalRevision ?? null;
          assignStep(visit, STEP.SLOT_CONFLICT, `时段 ${visit.slot} 冲突（${error.body.error ?? 'capacity changed'}），留待改约`);
          addEvent(visit, { kind: 'conflict', status: 409, revision: visit.conflictRevision });
          await this.#save();
          summary.slotConflicts += 1;
          continue;
        } else if (error instanceof PortalConnectionLost) {
          if (visit.step !== STEP.RECOVERING && visit.step !== STEP.CANCELLING) {
            assignStep(visit, STEP.RECOVERING, '连接中断，下次运行先用业务标识核实门户');
            addEvent(visit, { kind: 'disconnect', detail: error.message });
            await this.#save();
          }
        } else {
          assignStep(visit, STEP.FAILED, error.message);
          addEvent(visit, { kind: 'error', detail: error.message });
          await this.#save();
        }
      }

      switch (visit.step) {
        case STEP.BOOKED: summary.booked += 1; break;
        case STEP.NEEDS_MATERIAL: summary.needsMaterial += 1; break;
        case STEP.SLOT_CONFLICT: summary.slotConflicts += 1; break;
        case STEP.CANCELLED: summary.cancelled += 1; break;
        case STEP.RECOVERING:
        case STEP.CANCELLING: summary.recovering += 1; break;
        case STEP.FAILED: summary.failed += 1; break;
        default: summary.pending += 1;
      }
    }
    return { ...summary, visits: state.visits.map((visit) => this.#view(visit)) };
  }

  async cancel(reference) {
    const state = await this.#load();
    const visit = state.visits.find((entry) => entry.reference === reference);
    if (!visit) throw new Error(`unknown visitor reference: ${reference}`);
    await this.#cancelVisit(visit, '前台发起撤销');
    return this.#view(visit);
  }

  async status() {
    const state = await this.#load();
    return {
      portalUrl: state.portalUrl,
      visits: state.visits.map((visit) => this.#view(visit)),
    };
  }

  #view(visit) {
    return {
      reference: visit.reference,
      name: visit.name,
      slot: visit.slot,
      documentType: visit.documentType,
      sourceStatus: visit.sourceStatus,
      step: visit.step,
      stepLabel: STEP_LABEL[visit.step] ?? visit.step,
      receipt: visit.receipt,
      portalRevision: visit.portalRevision,
      conflictRevision: visit.conflictRevision ?? null,
      detail: visit.detail,
      updatedAt: visit.updatedAt,
      events: visit.events,
    };
  }
}
