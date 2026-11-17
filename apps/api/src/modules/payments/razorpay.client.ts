/**
 * Razorpay Payment Links and Payments, the four calls this platform makes
 * (FO-15). Mapping only; every rule lives in `PaymentsService`.
 *
 * Per razorpay.com/docs (read 2026-11-17):
 * - HTTP Basic auth with key_id:key_secret, JSON bodies, amounts in paise.
 * - `POST /v1/payment_links` creates; `reference_id` (max 40) must be unique,
 *   a repeat is 400 "payment link creation with reference ID already
 *   attempted". `notes` (max 15 x 256) come back on every webhook.
 * - `GET /v1/payment_links/{id}` returns `status` (created, partially_paid,
 *   paid, cancelled, expired), `amount_paid`, and `payments` (captured only,
 *   null until one): `{payment_id, amount, method, status}`.
 * - `POST /v1/payment_links/{id}/cancel`.
 * - `GET /v1/payments/{id}?expand[]=card` adds `card.{last4, network, issuer}`.
 * - Errors: `{ error: { code, description } }`, 400 for validation and for a
 *   bad key.
 *
 * Every call has an explicit timeout. Nothing here retries: a link creation is
 * deduplicated by `reference_id` instead, and a status check is re-run by the
 * next webhook or click.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class RazorpayError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** Razorpay refused a reference id it has already seen. */
    readonly duplicateReference = false,
  ) {
    super(message);
    this.name = 'RazorpayError';
  }
}

export interface RazorpayLink {
  id: string;
  shortUrl: string | null;
  status: 'created' | 'partially_paid' | 'paid' | 'cancelled' | 'expired' | string;
  amountPaid: number;
  payments: { paymentId: string; amount: number; method: string; status: string }[];
}

export interface CreateLinkInput {
  referenceId: string;
  amountMinor: number;
  currency: string;
  description: string;
  expireBySeconds: number;
  customer: { name: string; email: string | null; contact: string | null };
  notifySms: boolean;
  notifyEmail: boolean;
  notes: Record<string, string>;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A Razorpay link body -> the fields this platform uses. Exported for tests. */
export function mapRazorpayLink(body: unknown): RazorpayLink {
  const r = record(body);
  const payments = Array.isArray(r['payments']) ? r['payments'] : [];
  return {
    id: text(r['id']) ?? '',
    shortUrl: text(r['short_url']),
    status: text(r['status']) ?? 'unknown',
    amountPaid: typeof r['amount_paid'] === 'number' ? r['amount_paid'] : 0,
    payments: payments.map((p) => {
      const item = record(p);
      return {
        paymentId: text(item['payment_id']) ?? '',
        amount: typeof item['amount'] === 'number' ? item['amount'] : 0,
        method: text(item['method']) ?? 'unknown',
        status: text(item['status']) ?? 'unknown',
      };
    }),
  };
}

export class RazorpayClient {
  private readonly auth: string;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl: string,
    keyId: string,
    keySecret: string,
    private readonly timeoutMs: number,
  ) {
    this.auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
  }

  async createLink(input: CreateLinkInput): Promise<RazorpayLink> {
    const customer: Record<string, string> = { name: input.customer.name };
    if (input.customer.email !== null) customer['email'] = input.customer.email;
    if (input.customer.contact !== null) customer['contact'] = input.customer.contact;
    const body = await this.call('POST', '/v1/payment_links', {
      amount: input.amountMinor,
      currency: input.currency,
      accept_partial: false,
      reference_id: input.referenceId,
      description: input.description.slice(0, 2048),
      expire_by: input.expireBySeconds,
      customer,
      notify: {
        sms: input.notifySms && input.customer.contact !== null,
        email: input.notifyEmail && input.customer.email !== null,
      },
      reminder_enable: true,
      notes: input.notes,
    });
    return mapRazorpayLink(body);
  }

  async fetchLink(linkId: string): Promise<RazorpayLink> {
    return mapRazorpayLink(
      await this.call('GET', `/v1/payment_links/${encodeURIComponent(linkId)}`),
    );
  }

  async cancelLink(linkId: string): Promise<RazorpayLink> {
    return mapRazorpayLink(
      await this.call('POST', `/v1/payment_links/${encodeURIComponent(linkId)}/cancel`),
    );
  }

  /** Card detail for a card payment; nothing else is read from it. */
  async fetchCard(paymentId: string): Promise<{ last4: string | null; issuer: string | null }> {
    const body = record(
      await this.call('GET', `/v1/payments/${encodeURIComponent(paymentId)}?expand[]=card`),
    );
    const card = record(body['card']);
    const last4Raw = card['last4'];
    const last4 = typeof last4Raw === 'number' ? String(last4Raw).padStart(4, '0') : text(last4Raw);
    return {
      last4: last4 !== null && /^\d{4}$/.test(last4) ? last4 : null,
      issuer: text(card['network']) ?? text(card['issuer']),
    };
  }

  private async call(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          authorization: this.auth,
          accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    } catch (cause) {
      throw new RazorpayError(
        `Razorpay could not be reached (${cause instanceof Error ? cause.name : 'error'})`,
        null,
      );
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      // Only Razorpay's short description: never our request, which carries
      // the guest's contact details.
      const description = text(record(record(body)['error'])['description']) ?? 'no description';
      throw new RazorpayError(
        `Razorpay returned HTTP ${String(response.status)}: ${description.slice(0, 160)}`,
        response.status,
        /reference id already attempted/i.test(description),
      );
    }
    return body;
  }
}

/**
 * Razorpay's webhook signature: hex HMAC-SHA256 of the raw body with the
 * webhook secret, compared in constant time. Exported for tests.
 */
export async function verifyRazorpaySignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): Promise<boolean> {
  if (signature === undefined || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const { createHmac, timingSafeEqual } = await import('node:crypto');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

/** Razorpay's payment method -> the folio's. */
export function folioMethodFor(method: string): 'CARD' | 'UPI' | 'BANK_TRANSFER' | 'OTHER' {
  switch (method) {
    case 'card':
      return 'CARD';
    case 'upi':
      return 'UPI';
    case 'netbanking':
    case 'bank_transfer':
      return 'BANK_TRANSFER';
    default:
      return 'OTHER';
  }
}
