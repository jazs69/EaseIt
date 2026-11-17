/** BE-03: the signed price hold and booking access tokens cannot be forged or repurposed. */

import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';

import { BookingTokens, type QuotePayload } from './booking-tokens.js';

const config = (secret: string) => ({ get: () => secret }) as unknown as ConfigService;
const tokens = new BookingTokens(config('a'.repeat(48)));

const payload = (): QuotePayload =>
  ({
    quoteId: '11111111-1111-4111-8111-111111111111',
    propertyId: '22222222-2222-4222-8222-222222222222',
    roomTypeId: '33333333-3333-4333-8333-333333333333',
    roomTypeName: 'Deluxe',
    ratePlanId: null,
    ratePlanName: 'Standard rate',
    arrivalDate: '2026-12-01',
    departureDate: '2026-12-03',
    adults: 2,
    children: 0,
    promoCode: null,
    quote: { totalMinor: 1_120_000 },
    expiresAt: 1_800_000_000_000,
  }) as unknown as QuotePayload;

describe('quote tokens', () => {
  it('round-trip unchanged', () => {
    const token = tokens.signQuote(payload());
    expect(tokens.verifyQuote(token)).toEqual(payload());
  });

  it('refuse a lowered price, a moved expiry, a forged or truncated MAC', () => {
    const token = tokens.signQuote(payload());
    const [body, mac] = token.split('.') as [string, string];
    const tampered = (change: (p: Record<string, unknown>) => void) => {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      change(p);
      return `${Buffer.from(JSON.stringify(p)).toString('base64url')}.${mac}`;
    };
    expect(
      tokens.verifyQuote(tampered((p) => ((p.quote as Record<string, number>).totalMinor = 1))),
    ).toBeNull();
    expect(tokens.verifyQuote(tampered((p) => (p.expiresAt = 9_999_999_999_999)))).toBeNull();
    expect(tokens.verifyQuote(`${body}.${'A'.repeat(mac.length)}`)).toBeNull();
    expect(tokens.verifyQuote(body)).toBeNull();
    expect(tokens.verifyQuote('')).toBeNull();
  });

  it('a token signed under another secret is refused', () => {
    const other = new BookingTokens(config('b'.repeat(48)));
    expect(tokens.verifyQuote(other.signQuote(payload()))).toBeNull();
  });
});

describe('access tokens', () => {
  it('open exactly one booking at one property', () => {
    const token = tokens.access('p1', 'r1');
    expect(tokens.verifyAccess('p1', 'r1', token)).toBe(true);
    expect(tokens.verifyAccess('p1', 'r2', token)).toBe(false);
    expect(tokens.verifyAccess('p2', 'r1', token)).toBe(false);
    expect(tokens.verifyAccess('p1', 'r1', `${token}x`)).toBe(false);
  });

  it('an access token is not a quote token (purpose is inside the MAC)', () => {
    const body = Buffer.from(JSON.stringify(payload())).toString('base64url');
    expect(tokens.verifyQuote(`${body}.${tokens.access('p1', 'r1')}`)).toBeNull();
  });

  it('refuses to start without a real secret', () => {
    expect(() => new BookingTokens(config('short'))).toThrow(/JWT_SECRET/);
  });
});
