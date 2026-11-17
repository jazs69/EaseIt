/**
 * The reservation state machine (CLAUDE.md sections 3.1.1 and 3.4).
 *
 * Every rule is asserted for EVERY status, as a table, so adding a status to
 * the enum without deciding each rule for it fails here instead of falling
 * through a switch at runtime.
 */

import { ReservationStatus } from '@repo/types';
import { describe, expect, it } from 'vitest';

import {
  cancelRefusal,
  checkOutRefusal,
  consumesInventory,
  dateChangeRule,
  noShowRefusal,
} from './reservation.state.js';

const ALL = Object.values(ReservationStatus);

type Row = {
  consumes: boolean;
  cancel: ReturnType<typeof cancelRefusal>;
  checkOut: ReturnType<typeof checkOutRefusal>;
  noShow: ReturnType<typeof noShowRefusal>;
  dates: ReturnType<typeof dateChangeRule>;
};

/** The whole machine on one screen. */
const EXPECTED: Record<ReservationStatus, Row> = {
  // Holds a room without consuming inventory; nobody has arrived.
  TENTATIVE: {
    consumes: false,
    cancel: null,
    checkOut: 'NOT_IN_HOUSE',
    noShow: null,
    dates: 'REFUSED',
  },
  ON_HOLD: {
    consumes: false,
    cancel: null,
    checkOut: 'NOT_IN_HOUSE',
    noShow: null,
    dates: 'REFUSED',
  },
  // Sold; nobody has arrived, so everything may still change.
  CONFIRMED: { consumes: true, cancel: null, checkOut: 'NOT_IN_HOUSE', noShow: null, dates: 'ANY' },
  // A guest is in the room: only check-out and a later departure.
  CHECKED_IN: {
    consumes: true,
    cancel: 'CHECKED_IN',
    checkOut: null,
    noShow: 'CHECKED_IN',
    dates: 'DEPARTURE_ONLY',
  },
  // History: still counted in `sold`, never released, never changed.
  CHECKED_OUT: {
    consumes: true,
    cancel: 'CHECKED_OUT',
    checkOut: 'ALREADY_CHECKED_OUT',
    noShow: 'CHECKED_OUT',
    dates: 'REFUSED',
  },
  CANCELLED: {
    consumes: false,
    cancel: 'ALREADY_CANCELLED',
    checkOut: 'NOT_IN_HOUSE',
    noShow: 'CANCELLED',
    dates: 'REFUSED',
  },
  NO_SHOW: {
    consumes: false,
    cancel: 'NO_SHOW',
    checkOut: 'NOT_IN_HOUSE',
    noShow: 'ALREADY_NO_SHOW',
    dates: 'REFUSED',
  },
};

describe('reservation state machine', () => {
  it('has an expected row for every status in the enum, and no extra ones', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ALL].sort());
  });

  describe.each(ALL)('%s', (status) => {
    const row = EXPECTED[status];

    it(`consumes inventory: ${String(row.consumes)}`, () => {
      expect(consumesInventory(status)).toBe(row.consumes);
    });
    it(`cancel: ${row.cancel ?? 'allowed'}`, () => {
      expect(cancelRefusal(status)).toBe(row.cancel);
    });
    it(`check-out: ${row.checkOut ?? 'allowed'}`, () => {
      expect(checkOutRefusal(status)).toBe(row.checkOut);
    });
    it(`no-show: ${row.noShow ?? 'allowed'}`, () => {
      expect(noShowRefusal(status)).toBe(row.noShow);
    });
    it(`date change: ${row.dates}`, () => {
      expect(dateChangeRule(status)).toBe(row.dates);
    });
  });
});

describe('invariants the services rely on', () => {
  it('a cancellation never releases inventory a stay did not consume', () => {
    // Allowed cancellations of non-consuming stays must not decrement `sold`;
    // the service asks consumesInventory, so the two must agree.
    for (const status of ALL) {
      if (cancelRefusal(status) === null && !consumesInventory(status)) {
        expect([ReservationStatus.TENTATIVE, ReservationStatus.ON_HOLD]).toContain(status);
      }
    }
  });

  it('a consuming stay that has been checked out can never be cancelled (that would oversell history)', () => {
    expect(consumesInventory(ReservationStatus.CHECKED_OUT)).toBe(true);
    expect(cancelRefusal(ReservationStatus.CHECKED_OUT)).not.toBeNull();
  });

  it('exactly one status may check out', () => {
    expect(ALL.filter((status) => checkOutRefusal(status) === null)).toEqual([
      ReservationStatus.CHECKED_IN,
    ]);
  });

  it('cancellation and no-show accept the same source statuses (nobody has arrived)', () => {
    const cancellable = ALL.filter((status) => cancelRefusal(status) === null).sort();
    const noShowable = ALL.filter((status) => noShowRefusal(status) === null).sort();
    expect(noShowable).toEqual(cancellable);
  });

  it('terminal statuses refuse every transition', () => {
    for (const status of [
      ReservationStatus.CANCELLED,
      ReservationStatus.NO_SHOW,
      ReservationStatus.CHECKED_OUT,
    ]) {
      expect(cancelRefusal(status)).not.toBeNull();
      expect(noShowRefusal(status)).not.toBeNull();
      expect(dateChangeRule(status)).toBe('REFUSED');
    }
  });
});
