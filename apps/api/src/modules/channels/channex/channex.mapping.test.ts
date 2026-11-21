import { describe, expect, it } from 'vitest';

import { ChannelPayloadError } from '../channel-adapter.js';
import {
  availabilityBody,
  feedEnvelopes,
  parseAmount,
  readRevision,
  redactForStorage,
  restrictionsBody,
  sourceFor,
  toDecimalString,
} from './channex.mapping.js';

const revision = (overrides: Record<string, unknown> = {}): unknown => ({
  id: 'rev-1',
  type: 'booking_revision',
  attributes: {
    booking_id: 'bk-1',
    status: 'new',
    ota_name: 'BookingCom',
    ota_reservation_code: '4711',
    currency: 'INR',
    amount: '9000.00',
    ota_commission: '1350.50',
    payment_collect: 'property',
    customer: {
      name: 'Asha',
      surname: 'Rao',
      mail: 'asha@example.com',
      phone: '+91 98',
      country: 'in',
    },
    rooms: [
      {
        room_type_id: 'rt-ext',
        rate_plan_id: 'rp-ext',
        checkin_date: '2026-12-01',
        checkout_date: '2026-12-03',
        days: { '2026-12-01': '4500.00', '2026-12-02': '4500' },
        occupancy: { adults: 2, children: 1, infants: 0 },
      },
    ],
    guarantee: { card_number: '411111******1111', cvv: '***' },
    ...overrides,
  },
});

describe('money on the wire', () => {
  it('formats minor units in the currency exponent, without floats', () => {
    expect(toDecimalString(450000, 'INR')).toBe('4500.00');
    expect(toDecimalString(5, 'INR')).toBe('0.05');
    expect(toDecimalString(1200, 'JPY')).toBe('1200');
  });

  it('parses decimal strings and numbers into minor units', () => {
    expect(parseAmount('4500.00', 'INR', 'x')).toBe(450000);
    expect(parseAmount('4500.5', 'INR', 'x')).toBe(450050);
    expect(parseAmount(4500, 'INR', 'x')).toBe(450000);
    expect(parseAmount('12.500', 'INR', 'x')).toBe(1250);
  });

  it('refuses extra precision and non-numbers rather than rounding', () => {
    expect(() => parseAmount('45.005', 'INR', 'x')).toThrow(ChannelPayloadError);
    expect(() => parseAmount('-1', 'INR', 'x')).toThrow(ChannelPayloadError);
    expect(() => parseAmount('abc', 'INR', 'x')).toThrow(ChannelPayloadError);
  });
});

describe('outbound bodies', () => {
  it('maps availability and restrictions to Channex fields', () => {
    expect(
      availabilityBody('prop', [
        { externalRoomTypeId: 'rt', dateFrom: '2026-12-01', dateTo: '2026-12-05', availability: 3 },
      ]),
    ).toEqual({
      values: [
        {
          property_id: 'prop',
          room_type_id: 'rt',
          date_from: '2026-12-01',
          date_to: '2026-12-05',
          availability: 3,
        },
      ],
    });
    const body = restrictionsBody('prop', [
      {
        externalRatePlanId: 'rp',
        dateFrom: '2026-12-01',
        dateTo: '2026-12-01',
        rateMinor: 450000,
        currency: 'INR',
        minStayArrival: null,
        closedToArrival: true,
        closedToDeparture: false,
        stopSell: false,
      },
      {
        externalRatePlanId: 'rp',
        dateFrom: '2026-12-02',
        dateTo: '2026-12-09',
        rateMinor: null,
        currency: 'INR',
        minStayArrival: 3,
        closedToArrival: false,
        closedToDeparture: true,
        stopSell: true,
      },
    ]);
    expect(body.values[0]).toEqual({
      property_id: 'prop',
      rate_plan_id: 'rp',
      date_from: '2026-12-01',
      date_to: '2026-12-01',
      rate: '4500.00',
      min_stay_arrival: 1,
      closed_to_arrival: true,
      closed_to_departure: false,
      stop_sell: false,
    });
    expect(body.values[1]).not.toHaveProperty('rate');
    expect(body.values[1]).toMatchObject({
      min_stay_arrival: 3,
      stop_sell: true,
      closed_to_departure: true,
    });
  });
});

describe('inbound', () => {
  it('drops card data before storage, wherever it appears', () => {
    const stored = redactForStorage(revision()) as { attributes: Record<string, unknown> };
    expect(stored.attributes).not.toHaveProperty('guarantee');
    expect(JSON.stringify(redactForStorage({ a: [{ cardNumber: '4111', CVC: '1' }] }))).toBe(
      '{"a":[{}]}',
    );
  });

  it('reads feed envelopes structurally and skips items without an id', () => {
    const envelopes = feedEnvelopes({ data: [revision(), { attributes: { booking_id: 'x' } }] });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ externalMessageId: 'rev-1', externalBookingId: 'bk-1' });
    expect(JSON.stringify(envelopes[0]?.raw)).not.toContain('411111');
  });

  it('reads a new booking into domain values', () => {
    const booking = readRevision(revision());
    expect(booking).toMatchObject({
      externalBookingId: 'bk-1',
      kind: 'NEW',
      source: 'BOOKING_COM',
      otaReservationCode: '4711',
      currency: 'INR',
      otaCommissionMinor: 135050,
      collectedByOta: false,
      totalMinor: 900000,
      booker: { firstName: 'Asha', lastName: 'Rao', email: 'asha@example.com', countryCode: 'IN' },
    });
    expect(booking.rooms[0]).toEqual({
      externalRoomTypeId: 'rt-ext',
      externalRatePlanId: 'rp-ext',
      arrivalDate: '2026-12-01',
      departureDate: '2026-12-03',
      nights: [
        { stayDate: '2026-12-01', amountMinor: 450000 },
        { stayDate: '2026-12-02', amountMinor: 450000 },
      ],
      adults: 2,
      children: 1,
      infants: 0,
    });
  });

  it('refuses a booking with a night it has no price for', () => {
    const broken = revision({
      rooms: [
        {
          room_type_id: 'rt',
          rate_plan_id: 'rp',
          checkin_date: '2026-12-01',
          checkout_date: '2026-12-03',
          days: { '2026-12-01': '10.00' },
        },
      ],
    });
    expect(() => readRevision(broken)).toThrow(/no price for 2026-12-02/);
  });

  it('reads a cancellation that names no rooms, and refuses unknown statuses', () => {
    expect(readRevision(revision({ status: 'cancelled', rooms: [] })).kind).toBe('CANCELLED');
    expect(() => readRevision(revision({ status: 'paused' }))).toThrow(ChannelPayloadError);
  });

  it('maps OTA names to booking sources, falling back to OTA', () => {
    expect(sourceFor('Expedia')).toBe('EXPEDIA');
    expect(sourceFor('Make My Trip')).toBe('MAKEMYTRIP');
    expect(sourceFor('Airbnb')).toBe('OTA');
    expect(sourceFor(null)).toBe('OTA');
  });
});
