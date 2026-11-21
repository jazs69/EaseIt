/**
 * Channex wire format <-> the domain's channel values. Pure functions, no I/O,
 * so the mapping is unit-tested without a network (CM-05: mapping only).
 *
 * Per docs.channex.io (API v1), as used here:
 * - Auth header `user-api-key`; JSON bodies.
 * - `POST /api/v1/availability` `{ values: [{ property_id, room_type_id,
 *   date_from, date_to, availability }] }`.
 * - `POST /api/v1/restrictions` `{ values: [{ property_id, rate_plan_id,
 *   date_from, date_to, rate, min_stay_arrival, closed_to_arrival,
 *   closed_to_departure, stop_sell }] }`. `rate` is sent as a decimal string
 *   ("4500.00"), which is unambiguous about the currency's minor unit.
 * - `GET /api/v1/booking_revisions/feed?filter[property_id]=…` returns
 *   unacknowledged revisions `{ data: [{ id, type, attributes }] }`;
 *   `POST /api/v1/booking_revisions/{id}/ack` acknowledges one.
 * - A revision's `attributes`: `booking_id`, `status` (new | modified |
 *   cancelled), `ota_name`, `ota_reservation_code`, `currency`, `amount`,
 *   `ota_commission`, `payment_collect` (property | ota), `customer` { name,
 *   surname, mail, phone, country }, `rooms` [{ room_type_id, rate_plan_id,
 *   checkin_date, checkout_date, days { date: amount }, occupancy { adults,
 *   children, infants } }], `notes`, and `guarantee` (card details), which is
 *   removed before anything is stored.
 * - Errors: `{ errors: { code, title, details } }`.
 */

import { minorUnitExponent, type BookingSource } from '@repo/types';

import {
  ChannelPayloadError,
  type AvailabilityValue,
  type ChannelBooking,
  type ChannelBookingRoom,
  type InboundEnvelope,
  type RateValue,
  type RevisionKind,
} from '../channel-adapter.js';

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/* ----------------------------------------------------------- money ---- */

/** Minor units -> "4500.00" in the currency's own exponent. Integers only. */
export function toDecimalString(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor)) throw new Error('A money amount must be an integer.');
  const exponent = minorUnitExponent(currency);
  const negative = amountMinor < 0;
  const digits = String(Math.abs(amountMinor)).padStart(exponent + 1, '0');
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(-exponent)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/**
 * "4500.00", "4500.5" or 4500 -> minor units, by string arithmetic so no float
 * ever touches the amount. More decimals than the currency has is refused
 * unless they are zeros: a provider sending "45.005" INR is a payload this
 * system must not round on its own.
 */
export function parseAmount(value: unknown, currency: string, field: string): number {
  const raw = typeof value === 'number' ? String(value) : text(value);
  if (raw === null || !/^\d+(\.\d+)?$/.test(raw)) {
    throw new ChannelPayloadError(`${field} is not an amount.`);
  }
  const exponent = minorUnitExponent(currency);
  const [whole = '0', fraction = ''] = raw.split('.');
  const extra = fraction.slice(exponent);
  if (extra !== '' && !/^0+$/.test(extra)) {
    throw new ChannelPayloadError(`${field} has more decimals than ${currency} allows.`);
  }
  const minor = Number(`${whole}${fraction.slice(0, exponent).padEnd(exponent, '0')}`);
  if (!Number.isSafeInteger(minor)) throw new ChannelPayloadError(`${field} is out of range.`);
  return minor;
}

/* -------------------------------------------------------- outbound ---- */

export function availabilityBody(
  externalPropertyId: string,
  values: readonly AvailabilityValue[],
): { values: Record<string, unknown>[] } {
  return {
    values: values.map((value) => ({
      property_id: externalPropertyId,
      room_type_id: value.externalRoomTypeId,
      date_from: value.dateFrom,
      date_to: value.dateTo,
      availability: value.availability,
    })),
  };
}

export function restrictionsBody(
  externalPropertyId: string,
  values: readonly RateValue[],
): { values: Record<string, unknown>[] } {
  return {
    values: values.map((value) => ({
      property_id: externalPropertyId,
      rate_plan_id: value.externalRatePlanId,
      date_from: value.dateFrom,
      date_to: value.dateTo,
      // A stopped night carries no price: there is nothing to sell it at.
      ...(value.rateMinor === null
        ? {}
        : { rate: toDecimalString(value.rateMinor, value.currency) }),
      // Channex's "no minimum" is 1.
      min_stay_arrival: value.minStayArrival ?? 1,
      closed_to_arrival: value.closedToArrival,
      closed_to_departure: value.closedToDeparture,
      stop_sell: value.stopSell,
    })),
  };
}

/** Channex's error body -> its short title, never our request. */
export function describeChannexError(body: unknown): string {
  const errors = record(record(body)['errors']);
  return (
    text(errors['title']) ??
    text(errors['code']) ??
    text(record(body)['message']) ??
    'no description'
  );
}

/* --------------------------------------------------------- inbound ---- */

/**
 * Card data never reaches storage. `guarantee` is Channex's card block, and
 * any key that names a card number or security code is dropped wherever it
 * appears, in case a provider adds one somewhere new.
 */
export function redactForStorage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForStorage);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'guarantee' || /card_?number|cvv|cvc|card_?code|security_?code/i.test(key))
      continue;
    out[key] = redactForStorage(inner);
  }
  return out;
}

/** The feed body -> envelopes. Only structural fields are read here. */
export function feedEnvelopes(body: unknown): InboundEnvelope[] {
  const data = record(body)['data'];
  if (!Array.isArray(data)) return [];
  const envelopes: InboundEnvelope[] = [];
  for (const item of data) {
    const id = text(record(item)['id']);
    // A revision with no id cannot be acknowledged or deduplicated; Channex
    // will send it again, so it is left for the next pull rather than stored
    // under an invented key.
    if (id === null) continue;
    const attributes = record(record(item)['attributes']);
    envelopes.push({
      externalMessageId: id,
      externalBookingId: text(attributes['booking_id']),
      raw: redactForStorage(item),
    });
  }
  return envelopes;
}

const OTA_SOURCES: Record<string, BookingSource> = {
  bookingcom: 'BOOKING_COM',
  'booking.com': 'BOOKING_COM',
  expedia: 'EXPEDIA',
  agoda: 'AGODA',
  makemytrip: 'MAKEMYTRIP',
  goibibo: 'MAKEMYTRIP',
  cleartrip: 'CLEARTRIP',
};

/** Channex `ota_name` -> this system's booking source; `OTA` for one with no member. */
export function sourceFor(otaName: string | null): BookingSource {
  if (otaName === null) return 'OTA';
  return OTA_SOURCES[otaName.toLowerCase().replace(/\s+/g, '')] ?? 'OTA';
}

const KINDS: Record<string, RevisionKind> = {
  new: 'NEW',
  modified: 'MODIFIED',
  cancelled: 'CANCELLED',
};

function count(value: unknown, field: string, min: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > 20)
    throw new ChannelPayloadError(`${field} is not a guest count.`);
  return n;
}

function date(value: unknown, field: string): string {
  const raw = text(value);
  if (raw === null || !DATE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    throw new ChannelPayloadError(`${field} is not a date.`);
  }
  return raw;
}

function nightsOf(arrival: string, departure: string): string[] {
  const from = Date.parse(`${arrival}T00:00:00Z`);
  const to = Date.parse(`${departure}T00:00:00Z`);
  const nights = Math.round((to - from) / DAY_MS);
  return Array.from({ length: Math.max(0, nights) }, (_, i) =>
    new Date(from + i * DAY_MS).toISOString().slice(0, 10),
  );
}

/** A stored revision -> the domain booking. Throws `ChannelPayloadError`. */
export function readRevision(raw: unknown): ChannelBooking {
  const item = record(raw);
  const a = Object.keys(record(item['attributes'])).length > 0 ? record(item['attributes']) : item;

  const externalBookingId = text(a['booking_id']);
  if (externalBookingId === null) throw new ChannelPayloadError('booking_id is missing.');
  const kind = KINDS[text(a['status'])?.toLowerCase() ?? ''];
  if (kind === undefined)
    throw new ChannelPayloadError('status is not new, modified or cancelled.');
  const currency = text(a['currency'])?.toUpperCase() ?? null;
  if (currency === null || !/^[A-Z]{3}$/.test(currency))
    throw new ChannelPayloadError('currency is missing.');
  try {
    minorUnitExponent(currency);
  } catch {
    throw new ChannelPayloadError(`currency ${currency} is not supported.`);
  }

  const customer = record(a['customer']);
  const otaName = text(a['ota_name']);
  const rawRooms = Array.isArray(a['rooms']) ? a['rooms'] : [];

  const rooms: ChannelBookingRoom[] = rawRooms.map((rawRoom, index) => {
    const room = record(rawRoom);
    const label = `rooms[${String(index)}]`;
    const externalRoomTypeId = text(room['room_type_id']);
    if (externalRoomTypeId === null)
      throw new ChannelPayloadError(`${label}.room_type_id is missing.`);
    const arrivalDate = date(room['checkin_date'] ?? a['arrival_date'], `${label}.checkin_date`);
    const departureDate = date(
      room['checkout_date'] ?? a['departure_date'],
      `${label}.checkout_date`,
    );
    const dates = nightsOf(arrivalDate, departureDate);
    if (dates.length === 0) throw new ChannelPayloadError(`${label} has no nights.`);
    const days = record(room['days']);
    const nights = dates.map((stayDate) => {
      if (!(stayDate in days))
        throw new ChannelPayloadError(`${label}.days has no price for ${stayDate}.`);
      return {
        stayDate,
        amountMinor: parseAmount(days[stayDate], currency, `${label}.days.${stayDate}`),
      };
    });
    const occupancy = record(room['occupancy']);
    return {
      externalRoomTypeId,
      externalRatePlanId: text(room['rate_plan_id']),
      arrivalDate,
      departureDate,
      nights,
      adults: count(occupancy['adults'] ?? 1, `${label}.occupancy.adults`, 1),
      children: count(occupancy['children'] ?? 0, `${label}.occupancy.children`, 0),
      infants: count(occupancy['infants'] ?? 0, `${label}.occupancy.infants`, 0),
    };
  });
  // A cancellation may name no rooms; a new or modified booking must.
  if (rooms.length === 0 && kind !== 'CANCELLED') throw new ChannelPayloadError('rooms is empty.');

  const firstName = text(customer['name']) ?? text(customer['surname']) ?? 'Guest';
  const lastName = text(customer['name']) === null ? '' : (text(customer['surname']) ?? '');
  const email = text(customer['mail']);
  const country = text(customer['country'])?.toUpperCase() ?? null;

  return {
    externalBookingId,
    kind,
    source: sourceFor(otaName),
    otaName,
    otaReservationCode: text(a['ota_reservation_code']),
    currency,
    otaCommissionMinor:
      a['ota_commission'] === undefined || a['ota_commission'] === null
        ? 0
        : parseAmount(a['ota_commission'], currency, 'ota_commission'),
    collectedByOta: text(a['payment_collect'])?.toLowerCase() === 'ota',
    totalMinor:
      a['amount'] === undefined || a['amount'] === null
        ? null
        : parseAmount(a['amount'], currency, 'amount'),
    booker: {
      firstName: firstName.slice(0, 80),
      lastName: lastName.slice(0, 80),
      email:
        email !== null && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 254) : null,
      phone: text(customer['phone'])?.slice(0, 32) ?? null,
      countryCode: country !== null && /^[A-Z]{2}$/.test(country) ? country : null,
    },
    rooms,
    notes: text(a['notes'])?.slice(0, 1000) ?? null,
  };
}
