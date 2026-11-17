/**
 * FO-15: the Razorpay client, against the request and response shapes in
 * razorpay.com/docs (read 2026-11-17), with a fake fetch. The real API is
 * exercised with the owner's test keys; the payment flow end to end is in
 * `test/integration/payment-links.test.mjs`.
 */

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  folioMethodFor,
  mapRazorpayLink,
  RazorpayClient,
  verifyRazorpaySignature,
  type FetchLike,
} from './razorpay.client.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fake(answer: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(answer(url, init));
  };
  return { fn, calls };
}

const LINK = {
  id: 'plink_ExjpAUN3gVHrPJ',
  short_url: 'https://rzp.io/i/nxrHnLJ',
  status: 'paid',
  amount: 150000,
  amount_paid: 150000,
  reference_id: 'r',
  payments: [
    {
      amount: 150000,
      created_at: 1,
      method: 'card',
      payment_id: 'pay_KBnebtRrhTEatJ',
      plink_id: 'plink_ExjpAUN3gVHrPJ',
      status: 'captured',
      updated_at: 1,
    },
  ],
};

describe('mapRazorpayLink', () => {
  it('reads id, short_url, status, amount_paid and the captured payments', () => {
    expect(mapRazorpayLink(LINK)).toEqual({
      id: 'plink_ExjpAUN3gVHrPJ',
      shortUrl: 'https://rzp.io/i/nxrHnLJ',
      status: 'paid',
      amountPaid: 150000,
      payments: [
        { paymentId: 'pay_KBnebtRrhTEatJ', amount: 150000, method: 'card', status: 'captured' },
      ],
    });
  });

  it('payments: null (nothing captured yet) is an empty list', () => {
    expect(
      mapRazorpayLink({ ...LINK, status: 'created', amount_paid: 0, payments: null }).payments,
    ).toEqual([]);
  });
});

describe('RazorpayClient', () => {
  it('creates a link with Basic auth, paise, reference id, notes and notify flags', async () => {
    const { fn, calls } = fake(() => json(200, { ...LINK, status: 'created', payments: null }));
    const client = new RazorpayClient(fn, 'https://api.razorpay.com', 'rzp_test_abc', 'sec', 5_000);
    const link = await client.createLink({
      referenceId: '6f1c4b8e-2d3a-4c5b-9e7f-0a1b2c3d4e5f',
      amountMinor: 150000,
      currency: 'INR',
      description: 'Hotel - booking BK1',
      expireBySeconds: 1_800_000_000,
      customer: { name: 'Asha K', email: 'asha@example.com', contact: null },
      notifySms: true,
      notifyEmail: true,
      notes: { property_id: 'p', link_id: 'l' },
    });
    expect(link.id).toBe('plink_ExjpAUN3gVHrPJ');
    expect(calls[0]?.url).toBe('https://api.razorpay.com/v1/payment_links');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(
      `Basic ${Buffer.from('rzp_test_abc:sec').toString('base64')}`,
    );
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      amount: 150000,
      currency: 'INR',
      accept_partial: false,
      reference_id: '6f1c4b8e-2d3a-4c5b-9e7f-0a1b2c3d4e5f',
      customer: { name: 'Asha K', email: 'asha@example.com' },
      // No phone on the booking: Razorpay is not asked to text.
      notify: { sms: false, email: true },
      notes: { property_id: 'p', link_id: 'l' },
    });
    expect((body['customer'] as Record<string, unknown>)['contact']).toBeUndefined();
  });

  it("an error carries Razorpay's description, and flags a duplicate reference id", async () => {
    const { fn } = fake(() =>
      json(400, {
        error: {
          code: 'BAD_REQUEST_ERROR',
          description: 'payment link creation with reference ID already attempted',
        },
      }),
    );
    const client = new RazorpayClient(fn, 'https://x', 'k', 's', 5_000);
    await expect(client.fetchLink('plink_1')).rejects.toMatchObject({
      status: 400,
      duplicateReference: true,
      message:
        'Razorpay returned HTTP 400: payment link creation with reference ID already attempted',
    });
  });

  it('reads card last four and network from the expanded payment', async () => {
    const { fn, calls } = fake(() =>
      json(200, { id: 'pay_1', card: { last4: '0153', network: 'Visa', issuer: 'HDFC' } }),
    );
    const client = new RazorpayClient(fn, 'https://x', 'k', 's', 5_000);
    expect(await client.fetchCard('pay_1')).toEqual({ last4: '0153', issuer: 'Visa' });
    expect(calls[0]?.url).toBe('https://x/v1/payments/pay_1?expand[]=card');
  });

  it('a network failure is a RazorpayError with no status', async () => {
    const fn: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
    const client = new RazorpayClient(fn, 'https://x', 'k', 's', 5_000);
    await expect(client.cancelLink('plink_1')).rejects.toMatchObject({ status: null });
  });
});

describe('verifyRazorpaySignature', () => {
  const secret = 'whsec_test';
  const raw = Buffer.from('{"event":"payment_link.paid","payload":{}}');
  const good = createHmac('sha256', secret).update(raw).digest('hex');

  it('accepts the hex HMAC-SHA256 of the exact raw body', async () => {
    expect(await verifyRazorpaySignature(raw, good, secret)).toBe(true);
  });

  it('refuses a missing, malformed or wrong signature, and a changed body', async () => {
    expect(await verifyRazorpaySignature(raw, undefined, secret)).toBe(false);
    expect(await verifyRazorpaySignature(raw, 'not-hex', secret)).toBe(false);
    expect(
      await verifyRazorpaySignature(
        raw,
        good.replace(/^./, good.startsWith('0') ? '1' : '0'),
        secret,
      ),
    ).toBe(false);
    expect(await verifyRazorpaySignature(Buffer.from(`${raw.toString()} `), good, secret)).toBe(
      false,
    );
  });
});

describe('folioMethodFor', () => {
  it('maps Razorpay methods onto the folio methods', () => {
    expect(folioMethodFor('card')).toBe('CARD');
    expect(folioMethodFor('upi')).toBe('UPI');
    expect(folioMethodFor('netbanking')).toBe('BANK_TRANSFER');
    expect(folioMethodFor('bank_transfer')).toBe('BANK_TRANSFER');
    expect(folioMethodFor('wallet')).toBe('OTHER');
    expect(folioMethodFor('emi')).toBe('OTHER');
  });
});
