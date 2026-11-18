// 园区门户 HTTP 客户端：只负责协议，所有业务决策由 automation 编排。
// 关键约束：连接在请求已发出之后中断时，门户可能已经落单，不能当作普通失败重试，
// 统一抛出 AmbiguousOutcome，由调用方先用业务标识 reference 核实门户事实。

export class PortalError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'PortalError';
    this.status = status ?? null;
    this.body = body ?? null;
  }
}
export class SessionExpiredError extends PortalError {
  constructor() {
    super('portal session expired', { status: 403, body: { error: 'session expired' } });
    this.name = 'SessionExpiredError';
  }
}
export class SlotFullError extends PortalError {
  constructor(revision) {
    super('portal slot full', { status: 409, body: { error: 'capacity changed', revision } });
    this.name = 'SlotFullError';
    this.revision = revision ?? null;
  }
}
export class MissingMaterialError extends PortalError {
  constructor(message, fields = []) {
    super(message, { status: 422, body: { error: message, fields } });
    this.name = 'MissingMaterialError';
    this.fields = fields;
  }
}
// 请求已送达但响应丢失（断连/超时），门户侧状态未知。
export class AmbiguousOutcome extends Error {
  constructor(stage, cause) {
    super(`portal ${stage} outcome unknown: connection lost before response`);
    this.name = 'AmbiguousOutcome';
    this.stage = stage;
    this.cause = cause;
  }
}

const DOCUMENT_TYPES = ['passport', 'identity-card'];

export function parseForm(html) {
  const tags = [...html.matchAll(/<input\b[^>]*>/gi)].map((tag) => {
    const attr = (name) => tag[0].match(new RegExp(`${name}=("|')([^"']*)\\1`, 'i'))?.[2] ?? null;
    return { name: attr('name'), value: attr('value'), required: /\brequired\b/i.test(tag[0]) };
  });
  const action = html.match(/<form\b[^>]*\baction=("|')([^"']*)\1/i)?.[2] ?? null;
  const inputs = tags.filter((input) => input.name);
  return { action, inputs, requiredFields: inputs.filter((input) => input.required).map((input) => input.name) };
}

export class PortalClient {
  constructor(baseUrl) {
    const address = new URL(baseUrl);
    if (address.hostname !== '127.0.0.1') throw new Error('local portal required');
    this.baseUrl = address;
    this.cookie = null;
    this.csrf = null;
  }

  async startSession() {
    const response = await this.#request('GET', '/portal', null, { raw: true });
    const html = await response.text();
    this.csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? null;
    if (!this.csrf) throw new PortalError('portal draft form missing csrf');
    return parseForm(html);
  }

  // 返回确认页解析结果：是否需要证件类型，以及该页面还缺哪些必填资料。
  async submitDraft({ reference, name, slot }) {
    const html = await this.#sendForm('/portal/draft', { reference, name, slot }, { raw: true });
    const form = parseForm(await html.text());
    const documentField = form.inputs.find((input) => input.name === 'documentType');
    return {
      form,
      requiresDocument: Boolean(documentField),
      requiredFields: form.inputs.filter((input) => input.required).map((input) => input.name),
    };
  }

  async confirmBooking(documentType) {
    if (documentType && !DOCUMENT_TYPES.includes(documentType)) {
      throw new MissingMaterialError('unsupported documentType', ['documentType']);
    }
    const booking = await this.#sendForm('/portal/confirm', documentType ? { documentType } : {}, { stage: 'confirm' });
    if (!booking?.receipt || !booking?.reference) throw new PortalError('portal confirmed without receipt');
    return booking;
  }

  // 门户事实查询，业务标识是 reference。
  async findBookings(reference) {
    const response = await this.#request(
      'GET', `/portal/bookings?reference=${encodeURIComponent(reference)}`, null, { stage: 'bookings' });
    if (!Array.isArray(response?.bookings)) throw new PortalError('portal bookings payload malformed');
    return response.bookings;
  }

  async cancelBooking(receipt) {
    return this.#sendForm('/portal/cancel', { receipt }, { stage: 'cancel' });
  }

  async #sendForm(pathname, values, { raw = false, stage } = {}) {
    return this.#request('POST', pathname, new URLSearchParams({ csrf: this.csrf, ...values }), { raw, stage });
  }

  async #request(method, pathname, body, { raw = false, stage = pathname } = {}) {
    const address = new URL(pathname, this.baseUrl);
    if (address.origin !== this.baseUrl.origin) throw new Error('portal origin changed');
    let response;
    try {
      response = await fetch(address, {
        method,
        headers: {
          ...(this.cookie ? { cookie: this.cookie } : {}),
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body,
        signal: AbortSignal.timeout(2000),
      });
    } catch (error) {
      // 写请求断连：门户可能已经处理，状态未知，必须先核实再决定。
      if (method === 'POST') throw new AmbiguousOutcome(stage, error);
      throw error;
    }
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    if (response.status === 403) {
      this.csrf = null;
      throw new SessionExpiredError();
    }
    if (!response.ok) {
      let payload = null;
      try { payload = await response.json(); } catch { /* 保留状态码即可 */ }
      if (response.status === 409) throw new SlotFullError(payload?.revision);
      if (response.status === 422) {
        throw new MissingMaterialError(payload?.error ?? 'portal rejected missing material', payload?.fields ?? []);
      }
      throw new PortalError(`portal ${response.status}: ${pathname}`, { status: response.status, body: payload });
    }
    if (raw) return response;
    try {
      return await response.json();
    } catch (error) {
      throw new PortalError(`portal response not json: ${pathname}`, { cause: error });
    }
  }
}
