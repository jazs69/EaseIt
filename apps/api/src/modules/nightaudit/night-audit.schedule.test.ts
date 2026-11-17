/**
 * When a property's night audit is due (CLAUDE.md section 3.3): judged in the
 * property's own zone, at most one day behind, never from the server clock.
 */

import type { BusinessDate } from '@repo/types';
import { describe, expect, it } from 'vitest';

import { auditDue, localTimeInTimeZone } from './night-audit.schedule.js';

const due = (businessDate: string, timeZone: string, nowIso: string, auditTime = '03:00') =>
  auditDue({
    businessDate: businessDate as BusinessDate,
    timeZone,
    now: new Date(nowIso),
    auditTime,
  });

describe('localTimeInTimeZone', () => {
  it('is the wall clock at the property, 24-hour, zero-padded', () => {
    const at = new Date('2026-11-15T21:30:00Z');
    expect(localTimeInTimeZone('Asia/Kolkata', at)).toBe('03:00');
    expect(localTimeInTimeZone('America/New_York', at)).toBe('16:30');
    expect(localTimeInTimeZone('UTC', new Date('2026-11-15T00:05:00Z'))).toBe('00:05');
  });
});

describe('auditDue in Asia/Kolkata (+05:30)', () => {
  // Business day 15 Nov is audited at 03:00 IST on 16 Nov = 21:30 UTC on 15 Nov.
  it('due at exactly the audit time on the next local day', () => {
    expect(due('2026-11-15', 'Asia/Kolkata', '2026-11-15T21:30:00Z')).toEqual({ due: true });
  });

  it('not yet one minute before', () => {
    expect(due('2026-11-15', 'Asia/Kolkata', '2026-11-15T21:29:00Z')).toEqual({
      due: false,
      reason: 'NOT_YET',
    });
  });

  it('not yet while it is still the business date locally (even though UTC agrees on the date)', () => {
    expect(due('2026-11-15', 'Asia/Kolkata', '2026-11-15T12:00:00Z')).toEqual({
      due: false,
      reason: 'NOT_YET',
    });
  });

  it('still due later on the next day', () => {
    expect(due('2026-11-15', 'Asia/Kolkata', '2026-11-16T12:00:00Z')).toEqual({ due: true });
  });

  it('two or more days behind is STALE: a person catches it up, not the scheduler', () => {
    expect(due('2026-11-15', 'Asia/Kolkata', '2026-11-16T19:00:00Z')).toEqual({
      due: false,
      reason: 'STALE',
    });
  });

  it('a business date ahead of the local calendar is AHEAD', () => {
    expect(due('2026-11-20', 'Asia/Kolkata', '2026-11-16T12:00:00Z')).toEqual({
      due: false,
      reason: 'AHEAD',
    });
  });
});

describe('the same instant, different properties', () => {
  // 22:00 UTC 15 Nov: 03:30 IST on the 16th, 17:00 EST on the 15th.
  it('Kolkata is due while New York is not', () => {
    expect(due('2026-11-15', 'Asia/Kolkata', '2026-11-15T22:00:00Z')).toEqual({ due: true });
    expect(due('2026-11-15', 'America/New_York', '2026-11-15T22:00:00Z')).toEqual({
      due: false,
      reason: 'NOT_YET',
    });
  });
});

describe('across a daylight-saving change (America/New_York, clocks back 02:00 EDT -> 01:00 EST on 1 Nov 2026)', () => {
  // 03:00 EST on 1 Nov is 08:00 UTC; before the change it would have been 07:00 UTC.
  it('waits for 03:00 on the local clock after the change', () => {
    expect(due('2026-10-31', 'America/New_York', '2026-11-01T07:30:00Z')).toEqual({
      due: false,
      reason: 'NOT_YET',
    });
    expect(due('2026-10-31', 'America/New_York', '2026-11-01T08:00:00Z')).toEqual({ due: true });
  });

  it('spring forward (8 Mar 2026, 02:00 EST -> 03:00 EDT): 03:00 local is 07:00 UTC', () => {
    expect(due('2026-03-07', 'America/New_York', '2026-03-08T06:59:00Z')).toEqual({
      due: false,
      reason: 'NOT_YET',
    });
    expect(due('2026-03-07', 'America/New_York', '2026-03-08T07:00:00Z')).toEqual({ due: true });
  });
});
