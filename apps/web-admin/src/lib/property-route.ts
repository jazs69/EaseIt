/**
 * Shared entry checks for property-scoped pages.
 *
 * Every screen in the `(property)` shell is addressed by `?hotelId=`, and all
 * of them need the same two lines: pull one value out of possibly-repeated
 * search params, and bail to the picker when it is missing. Written once here
 * so a new module cannot quietly ship without the guard.
 */

import { redirect } from 'next/navigation';

/** One `?key=` value, ignoring a repeated parameter's extras. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The hotelId for a property-scoped page, or a redirect away.
 *
 * Back to the group dashboard rather than a guessed default: choosing a
 * property is the operator's next action anyway, and sending them to one they
 * may hold no grant at would bounce them through an authorisation failure to
 * reach the same place.
 *
 * This is a routing convenience, never authorisation — the value is an
 * untrusted lookup key that each API call re-resolves through the caller's own
 * grants (CLAUDE.md section 3.2).
 */
export function requireHotelId(
  params: Record<string, string | string[] | undefined>,
): string {
  const hotelId = firstParam(params['hotelId']);
  if (hotelId === undefined || hotelId.trim().length === 0) {
    redirect('/group-dashboard');
  }
  return hotelId;
}
