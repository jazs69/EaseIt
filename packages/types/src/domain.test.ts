/**
 * Business-date math (CLAUDE.md section 3.3): calendar dates are strings with
 * no zone, stays are half-open `[arrival, departure)`, and "today" at a
 * property comes from its IANA zone, never the server's clock.
 */

import { describe, expect, it } from 'vitest';

import {
  addDays,
  businessDateSchema,
  currentDateInTimeZone,
  enumerateStayDates,
  nightCount,
  stayRangeSchema,
  type BusinessDate,
  type StayRange,
} from './domain.js';

const d = (value: string): BusinessDate => value as BusinessDate;
const stay = (arrivalDate: string, departureDate: string): StayRange => ({
  arrivalDate: d(arrivalDate),
  departureDate: d(departureDate),
});

describe('businessDateSchema', () => {
  it.each(['2026-11-17', '2028-02-29', '2026-12-31', '2027-01-01'])('accepts %s', (value) => {
    expect(businessDateSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['2026-02-30', 'a day February does not have (Date.parse rolls it to 2 March)'],
    ['2026-02-29', 'the 29th in a non-leap year'],
    ['2026-04-31', 'the 31st of a 30-day month'],
    ['2026-13-01', 'month 13'],
    ['2026-00-10', 'month 0'],
    ['2026-1-5', 'missing zero padding'],
    ['2026-11-17T00:00:00Z', 'an instant, not a calendar date'],
    ['', 'nothing'],
  ])('refuses %s: %s', (value) => {
    expect(businessDateSchema.safeParse(value).success).toBe(false);
  });
});

describe('stayRangeSchema', () => {
  it('needs at least one night: departure strictly after arrival', () => {
    expect(stayRangeSchema.safeParse(stay('2026-11-17', '2026-11-18')).success).toBe(true);
    expect(stayRangeSchema.safeParse(stay('2026-11-17', '2026-11-17')).success).toBe(false);
    expect(stayRangeSchema.safeParse(stay('2026-11-18', '2026-11-17')).success).toBe(false);
  });
});

describe('nightCount and enumerateStayDates: half-open stays', () => {
  it.each([
    ['2026-11-17', '2026-11-18', 1, 'one night'],
    ['2026-12-30', '2027-01-02', 3, 'across New Year'],
    ['2028-02-28', '2028-03-01', 2, 'across a leap day'],
    ['2027-02-28', '2027-03-01', 1, 'across February in a common year'],
    // US clocks change on 8 March 2026 and 1 November 2026; a calendar date
    // has no clock, so neither changes the count.
    ['2026-03-07', '2026-03-09', 2, 'across the US spring-forward weekend'],
    ['2026-10-31', '2026-11-02', 2, 'across the US fall-back weekend'],
  ])('%s -> %s is %i night(s) (%s)', (arrival, departure, nights) => {
    const range = stay(arrival, departure);
    expect(nightCount(range)).toBe(nights);
    const dates = enumerateStayDates(range);
    expect(dates).toHaveLength(nights);
    // Arrival is a stay date; departure never is (it is sellable that night).
    expect(dates[0]).toBe(arrival);
    expect(dates).not.toContain(departure);
  });

  it('lists every night in order', () => {
    expect(enumerateStayDates(stay('2026-12-30', '2027-01-02'))).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
    ]);
  });
});

describe('addDays', () => {
  it.each([
    ['2026-11-17', 1, '2026-11-18'],
    ['2026-11-30', 1, '2026-12-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2027-01-01', -1, '2026-12-31'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2027-02-28', 1, '2027-03-01'],
    ['2026-03-08', 1, '2026-03-09'], // US spring-forward day is still 24h of calendar
    ['2026-11-17', 0, '2026-11-17'],
    ['2026-11-17', 365, '2027-11-17'],
  ])('%s %+i day(s) = %s', (date, days, expected) => {
    expect(addDays(d(date), days)).toBe(expected);
  });

  it('is the inverse of itself', () => {
    let date = d('2026-01-01');
    for (let i = 0; i < 800; i += 37) {
      expect(addDays(addDays(date, i), -i)).toBe(date);
      date = addDays(date, 1);
    }
  });
});

describe('currentDateInTimeZone: the property decides what day it is', () => {
  // 20:00 UTC on 16 November 2026.
  const instant = new Date('2026-11-16T20:00:00Z');

  it.each([
    ['Asia/Kolkata', '2026-11-17'], // +05:30 -> 01:30 next day
    ['Asia/Dubai', '2026-11-17'], // +04:00 -> 00:00 next day, exactly
    ['Europe/London', '2026-11-16'], // +00:00
    ['America/New_York', '2026-11-16'], // -05:00 -> 15:00
    ['Pacific/Kiritimati', '2026-11-17'], // +14:00
    ['Pacific/Pago_Pago', '2026-11-16'], // -11:00
  ])('in %s it is %s', (zone, expected) => {
    expect(currentDateInTimeZone(zone, instant)).toBe(expected);
  });

  it('turns over at local midnight, not UTC midnight', () => {
    // Midnight in Kolkata is 18:30 UTC the previous day.
    expect(currentDateInTimeZone('Asia/Kolkata', new Date('2026-11-16T18:29:59Z'))).toBe(
      '2026-11-16',
    );
    expect(currentDateInTimeZone('Asia/Kolkata', new Date('2026-11-16T18:30:00Z'))).toBe(
      '2026-11-17',
    );
  });

  it('two properties can be on different business days at the same instant', () => {
    const at = new Date('2026-11-17T02:00:00Z');
    expect(currentDateInTimeZone('Asia/Kolkata', at)).toBe('2026-11-17');
    expect(currentDateInTimeZone('America/Los_Angeles', at)).toBe('2026-11-16');
  });
});
