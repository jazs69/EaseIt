'use client';

/**
 * The Summary tab's rollup.
 *
 * ===========================================================================
 * Seven nights become one "Booking Price"; payments leave entirely.
 *
 * The Summary and Itemized tabs used to show the same rows, which made one of
 * them pointless. Summary now answers "what is this stay costing?" in as few
 * lines as possible, and Itemized stays the full night-by-night ledger
 * including every settlement. Service charges are not rolled up — a guest
 * querying a ₹903 food bill needs to see that bill, not a "services"
 * subtotal.
 *
 * Grouped on the server-supplied `group`, never on the description: a clerk
 * can rename a line, and a rollup keyed on free text starts dropping rows out
 * of its own total the first time somebody does.
 *
 * POSTED AND SCHEDULED NIGHTS ROLL UP TOGETHER, AND SAY SO
 * A stay mid-way through has its arrival night in the ledger and the rest
 * derived from the agreed tariff. Rolling only the posted ones would show a
 * "Booking Price" smaller than the stay; splitting into two rows would answer
 * the question twice. They combine, and the row carries the posted share so
 * the UI can mark it — because an invoice may only be raised from the posted
 * part, and that distinction must not vanish into an aggregate.
 * ===========================================================================
 */

import { useMemo } from 'react';
import type { FolioTransaction } from '@repo/types';

/** A Summary row: either a real transaction or the consolidated tariff. */
export interface FolioSummaryRow extends FolioTransaction {
  /** How many ledger lines and scheduled nights this row stands for. */
  rolledUpCount: number;
  /** The posted part of `grossMinor`, when the row mixes both. */
  postedGrossMinor: number;
}

export function useFolioSummaryRows(
  transactions: readonly FolioTransaction[],
  roomNumber: string | null,
): FolioSummaryRow[] {
  return useMemo(() => {
    /**
     * Chargeable items only. Money movements are excluded.
     *
     * ===========================================================================
     * Summary answers "what is this stay costing?", not "what has been paid?"
     *
     * Mixing payments into the same table made it answer neither cleanly: a
     * clerk adding up the GROSS column got a figure that was the charges minus
     * some of the settlements, which is not a number that means anything. The
     * charges live here; the settlements live in the Payments tab, the
     * PAYMENTS & DEPOSITS block and the top KPI bar.
     *
     * **Filtered on `group`, not on the sign.** A refund is stored positive —
     * giving money back increases what the guest owes — so it reads as a
     * `DEBIT` and a sign test would leave it sitting in the charges table. The
     * question is what a row *is*, and `group` answers that: `MONEY` covers
     * payments and refunds whichever way their sign happens to point.
     *
     * Nothing about the totals changes. The KPI bar and the bottom dock are
     * computed server-side from the whole ledger, not from these rows, so
     * payments still count towards PAYMENTS and BALANCE DUE exactly as before.
     * ===========================================================================
     */
    const chargeable = transactions.filter((entry) => entry.group !== 'MONEY');

    const tariff = chargeable.filter((entry) => entry.group === 'ROOM_TARIFF');
    const rest = chargeable.filter((entry) => entry.group !== 'ROOM_TARIFF');

    const rows: FolioSummaryRow[] = rest.map((entry) => ({
      ...entry,
      rolledUpCount: 1,
      postedGrossMinor: entry.isPosted ? entry.grossMinor : 0,
    }));

    if (tariff.length > 0) {
      // Integer minor units throughout: these are sums of already-rounded
      // figures, so they reconcile exactly with the rows they replace
      // (CLAUDE.md section 3.4).
      const netMinor = tariff.reduce((sum, entry) => sum + entry.netMinor, 0);
      const taxMinor = tariff.reduce((sum, entry) => sum + entry.taxMinor, 0);
      const grossMinor = tariff.reduce((sum, entry) => sum + entry.grossMinor, 0);
      const postedGrossMinor = tariff
        .filter((entry) => entry.isPosted)
        .reduce((sum, entry) => sum + entry.grossMinor, 0);

      // Earliest night, which is the stay's first — the rows arrive sorted by
      // date, but reducing is cheaper than trusting that.
      const first = tariff.reduce((earliest, entry) =>
        entry.date < earliest.date ? entry : earliest,
      );

      /**
       * Correctable only when every night is in the ledger.
       *
       * A scheduled night has no line to correct: its figure comes from the
       * reservation's agreed total, and changing that is a re-quote rather
       * than a folio correction. The server refuses such a request; the UI
       * does not offer it.
       */
      const allPosted = tariff.every((entry) => entry.isPosted);

      rows.unshift({
        id: 'summary-booking-price',
        date: first.date,
        // One room for the whole stay reads better as its number; a stay that
        // has moved rooms reads as "All rooms" because no single one is true.
        room: new Set(tariff.map((entry) => entry.room)).size === 1 ? roomNumber : 'All rooms',
        description: 'Booking Price',
        kind: 'ROOM_CHARGE',
        direction: 'DEBIT',
        netMinor,
        taxMinor,
        grossMinor,
        isPosted: allPosted,
        group: 'ROOM_TARIFF',
        isCorrectable: allPosted,
        originalGrossMinor: tariff.reduce(
          (sum, entry) => sum + entry.originalGrossMinor,
          0,
        ),
        correctionCount: tariff.reduce((sum, entry) => sum + entry.correctionCount, 0),
        paymentMethod: null,
        reversesLineId: null,
        postedAt: first.postedAt,
        rolledUpCount: tariff.length,
        postedGrossMinor,
      });
    }

    return rows;
  }, [transactions, roomNumber]);
}
