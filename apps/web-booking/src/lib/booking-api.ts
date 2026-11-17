/**
 * The booking site's only way to the API, and it runs on the server.
 *
 * The property travels as the slug in the PATH; the API resolves it (BE-05),
 * so nothing a browser sends can name a hotel. The guest's own address is
 * forwarded, so the API throttles per guest, not per web server.
 *
 * Server-only by construction: `next/headers` cannot be imported by a client
 * component, so the build fails if one ever reaches for this.
 */

import { headers } from 'next/headers';

const API = (
  process.env['API_INTERNAL_URL'] ??
  process.env['NEXT_PUBLIC_API_URL'] ??
  'http://localhost:4000'
).replace(/\/$/, '');

export class BookingApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: Record<string, string>,
  ) {
    super(message);
    this.name = 'BookingApiError';
  }

  /** The most useful sentence for a guest. */
  get guestMessage(): string {
    const first = Object.values(this.issues)[0];
    if (first !== undefined) return first;
    if (this.code === 'ROOM_UNAVAILABLE')
      return 'Sorry, that room has just been booked by someone else. Please choose another.';
    if (this.code === 'RATE_LIMITED')
      return 'Too many attempts. Please wait a few minutes and try again.';
    if (this.status === 404) return 'We could not find that.';
    return this.message || 'Something went wrong. Please try again.';
  }
}

async function clientAddress(): Promise<string | null> {
  const h = await headers();
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip');
}

export async function bookingApi<T>(
  path: string,
  schema: { parse(input: unknown): T },
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  const ip = await clientAddress();
  const response = await fetch(`${API}/api/v1/public/properties${path}`, {
    method: init.method ?? 'GET',
    cache: 'no-store',
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(ip === null ? {} : { 'x-forwarded-for': ip }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload ?? {}) as {
      code?: string;
      message?: string;
      details?: { issues?: Record<string, string> };
    };
    throw new BookingApiError(
      response.status,
      error.code ?? 'ERROR',
      error.message ?? '',
      error.details?.issues ?? {},
    );
  }
  return schema.parse(payload);
}
