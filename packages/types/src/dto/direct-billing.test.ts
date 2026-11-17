import { describe, expect, it } from 'vitest';

import type { BusinessDate } from '../domain.js';
import { ageReceivables, type AgingTransfer } from './direct-billing.dto.js';
import { normaliseEmail, normalisePhone } from './guest-profile.dto.js';

const d = (iso: string) => iso as BusinessDate;
const t = (id: string, amountMinor: number, ageDate: string): AgingTransfer => ({
  id,
  amountMinor,
  ageDate: d(ageDate),
  postingDate: d(ageDate),
});

describe('ageReceivables', () => {
  const asOf = d('2026-11-30');
  const transfers = [
    t('c', 1_000, '2026-11-20'), // 10 days
    t('a', 2_000, '2026-08-01'), // 121 days
    t('b', 3_000, '2026-10-01'), // 60 days
  ];

  it('buckets by days since the age date, boundaries inclusive', () => {
    const { aging, openItems } = ageReceivables(transfers, 0, asOf);
    expect(aging).toEqual({
      currentMinor: 1_000,
      days31To60Minor: 3_000,
      days61To90Minor: 0,
      over90Minor: 2_000,
    });
    expect(openItems.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('applies payments to the oldest debt first', () => {
    const { aging, openItems } = ageReceivables(transfers, 2_500, asOf);
    // a (2000) cleared, 500 off b.
    expect(openItems.map((item) => [item.id, item.outstandingMinor])).toEqual([
      ['b', 2_500],
      ['c', 1_000],
    ]);
    expect(aging.over90Minor).toBe(0);
    expect(aging.days31To60Minor).toBe(2_500);
  });

  it('open items sum to transfers minus payments; fully paid leaves nothing', () => {
    const partial = ageReceivables(transfers, 4_200, asOf);
    expect(partial.openItems.reduce((sum, item) => sum + item.outstandingMinor, 0)).toBe(1_800);
    expect(ageReceivables(transfers, 6_000, asOf).openItems).toEqual([]);
  });

  it('a 30-day-old item is current and a 31-day-old one is not', () => {
    const { aging } = ageReceivables(
      [t('x', 100, '2026-10-31'), t('y', 200, '2026-10-30')],
      0,
      asOf,
    );
    expect(aging.currentMinor).toBe(100);
    expect(aging.days31To60Minor).toBe(200);
  });
});

describe('guest matching keys', () => {
  it('normalises email case and whitespace', () => {
    expect(normaliseEmail('  Asha.K@Example.COM ')).toBe('asha.k@example.com');
    expect(normaliseEmail('   ')).toBeNull();
    expect(normaliseEmail(null)).toBeNull();
  });

  it('matches a phone with or without the country code and separators', () => {
    expect(normalisePhone('+91 98765-43210')).toBe('9876543210');
    expect(normalisePhone('098765 43210')).toBe('9876543210');
    expect(normalisePhone('12345')).toBeNull();
  });
});
