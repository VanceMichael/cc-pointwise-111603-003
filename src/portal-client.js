export class PortalHttpError extends Error {
  constructor(status, path, body = {}) {
    super(`portal ${status} on ${path}: ${body.error ?? 'request failed'}`);
    this.name = 'PortalHttpError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export class PortalSessionExpired extends PortalHttpError {
  constructor(path, body) {
    super(403, path, body);
    this.name = 'PortalSessionExpired';
  }
}

export class PortalConnectionLost extends Error {
  constructor(path, cause) {
    super(`connection lost on ${path}: ${cause?.message ?? cause}`);
    this.name = 'PortalConnectionLost';
    this.path = path;
    this.cause = cause;
  }
}

export function parseInputs(html) {
  return [...String(html).matchAll(/<input\b([^>]*)>/g)].map((match) => {
    const attributes = match[1];
    return {
      name: attributes.match(/name="([^"]*)"/)?.[1] ?? null,
      type: attributes.match(/type="([^"]+)"/)?.[1] ?? 'text',
      required: /\brequired\b/.test(attributes),
      hidden: /type="hidden"/.test(attributes),
    };
  });
}

export function describeForm(html) {
  const inputs = parseInputs(html);
  const fields = inputs.filter((input) => input.name).map((input) => input.name);
  return {
    fields,
    requiredFields: inputs.filter((input) => input.name && input.required).map((input) => input.name),
    inputs,
  };
}

export class PortalClient {
  constructor(baseUrl) {
    const address = new URL(baseUrl);
    if (address.hostname !== '127.0.0.1') throw new Error('local portal required');
    this.baseUrl = address;
    this.cookie = null;
    this.csrf = null;
    this.draftForm = null;
    this.confirmForm = null;
  }

  resetSession() {
    this.cookie = null;
    this.csrf = null;
    this.draftForm = null;
    this.confirmForm = null;
  }

  get hasSession() { return Boolean(this.cookie && this.csrf); }

  async openSession() {
    const response = await this.#send('GET', '/portal');
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('portal did not establish a session');
    const html = await response.text();
    const form = describeForm(html);
    const csrfInput = form.inputs.find((input) => input.name === 'csrf');
    const csrf = html.match(/name="csrf"[^>]*value="([^"]+)"/)?.[1]
      ?? html.match(/value="([^"]+)"[^>]*name="csrf"/)?.[1];
    if (!csrf) throw new Error('portal draft form has no csrf token');
    this.cookie = cookie;
    this.csrf = csrf;
    this.draftForm = form;
    this.confirmForm = null;
    return { csrf, ...form };
  }

  async submitDraft({ reference, name, slot }) {
    const html = await this.#postForm('/portal/draft', { reference, name, slot });
    const form = describeForm(html);
    this.confirmForm = {
      ...form,
      requiresDocument: form.fields.includes('documentType'),
      documentRequired: form.requiredFields.includes('documentType'),
    };
    return this.confirmForm;
  }

  async confirm({ documentType } = {}) {
    const payload = documentType ? { documentType } : {};
    return this.#postForm('/portal/confirm', payload, { json: true });
  }

  async lookup(reference) {
    const path = `/portal/bookings?reference=${encodeURIComponent(reference)}`;
    const response = await this.#send('GET', path);
    return response.json();
  }

  async cancel(receipt) {
    return this.#postForm('/portal/cancel', { receipt }, { json: true });
  }

  async #postForm(path, fields, { json = false } = {}) {
    const response = await this.#send('POST', path, { fields });
    const text = await response.text();
    if (json) return JSON.parse(text);
    return text;
  }

  async #send(method, path, { fields } = {}) {
    const address = new URL(path, this.baseUrl);
    if (address.origin !== this.baseUrl.origin) throw new Error('portal origin changed');
    const headers = { accept: 'application/json, text/html' };
    if (this.cookie) headers.cookie = this.cookie;
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const init = { method, headers, signal: AbortSignal.timeout(2000) };
    if (method === 'POST') {
      init.body = new URLSearchParams({ csrf: this.csrf, ...fields }).toString();
    }
    let response;
    try {
      response = await fetch(address, init);
    } catch (error) {
      throw new PortalConnectionLost(path, error);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let body;
      try { body = JSON.parse(text); } catch { body = { error: text || `http ${response.status}` }; }
      if (response.status === 403) throw new PortalSessionExpired(path, body);
      throw new PortalHttpError(response.status, path, body);
    }
    return response;
  }
}
