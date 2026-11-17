/**
 * Signed tokens for the booking engine: the price hold (quote) and a guest's
 * access to their own booking.
 *
 * ===========================================================================
 * HMAC-SHA256 under the API's JWT secret, with a purpose label inside the MAC
 * ("easeit-booking-quote:", "easeit-booking-access:"), so a token minted for
 * one purpose — or a session JWT — never verifies as another. Compared in
 * constant time.
 *
 * A QUOTE token carries the whole priced quote and its expiry: booking honours
 * that price without trusting anything the browser could alter, because any
 * alteration breaks the MAC. It also names the property, so a token from one
 * hotel's site is refused at another's.
 *
 * An ACCESS token is the MAC of (property, reservation): stateless, unguessable,
 * and the only way to read or pay a booking publicly — a booking code alone is
 * not enough, because codes are printed on paper and easy to guess at.
 * ===========================================================================
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ReservationQuote } from '@repo/types';

export type QuotePayload = {
  /** One booking per quote: the double-submit key. */
  quoteId: string;
  propertyId: string;
  roomTypeId: string;
  roomTypeName: string;
  ratePlanId: string | null;
  ratePlanName: string;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  promoCode: string | null;
  quote: ReservationQuote;
  /** Epoch milliseconds. */
  expiresAt: number;
};

const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

@Injectable()
export class BookingTokens {
  private readonly secret: string;

  constructor(config: ConfigService) {
    const secret = config.get<string>('JWT_SECRET');
    if (secret === undefined || secret.length < 32) {
      throw new Error('JWT_SECRET is required to sign booking-engine tokens.');
    }
    this.secret = secret;
  }

  private mac(purpose: string, body: string): string {
    return createHmac('sha256', this.secret)
      .update(`easeit-booking-${purpose}:${body}`)
      .digest('base64url');
  }

  private same(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  }

  signQuote(payload: QuotePayload): string {
    const body = b64(JSON.stringify(payload));
    return `${body}.${this.mac('quote', body)}`;
  }

  /** The payload, or null when the token is malformed or its MAC is wrong. Expiry is the caller's check. */
  verifyQuote(token: string): QuotePayload | null {
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    if (!this.same(token.slice(dot + 1), this.mac('quote', body))) return null;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      // Signed by us, so its shape is ours; checked only enough to fail closed.
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('quoteId' in parsed) ||
        !('quote' in parsed)
      ) {
        return null;
      }
      return parsed as QuotePayload;
    } catch {
      // Unreachable for a token whose MAC verified; refused rather than thrown.
      return null;
    }
  }

  access(propertyId: string, reservationId: string): string {
    return this.mac('access', `${propertyId}:${reservationId}`);
  }

  verifyAccess(propertyId: string, reservationId: string, token: string): boolean {
    return this.same(token, this.access(propertyId, reservationId));
  }
}
