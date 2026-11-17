/**
 * IE-02 formatting with no database dependency, so it is unit-testable:
 * minor units to major-unit text, and runs of equal-priced nights to ranges.
 */

import { minorUnitExponent } from '@repo/types';

const DAY = 86_400_000;
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Integer minor units → "1234.50", by string arithmetic: no float touches money. */
export function formatMajor(amountMinor: number, currency: string): string {
  const exponent = minorUnitExponent(currency.trim());
  const negative = amountMinor < 0;
  const digits = String(Math.abs(amountMinor)).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent > 0 ? `.${digits.slice(-exponent)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** Consecutive nights at one amount, per plan and category, as ranges. */
export function collapseRuns(
  days: readonly {
    planCode: string;
    typeCode: string;
    day: string;
    amount: number;
    currency: string;
  }[],
): {
  planCode: string;
  typeCode: string;
  from: string;
  to: string;
  amount: number;
  currency: string;
}[] {
  const out: {
    planCode: string;
    typeCode: string;
    from: string;
    to: string;
    amount: number;
    currency: string;
  }[] = [];
  for (const d of days) {
    const last = out.at(-1);
    const next =
      last === undefined ? '' : isoDay(new Date(Date.parse(`${last.to}T00:00:00Z`) + DAY));
    if (
      last !== undefined &&
      last.planCode === d.planCode &&
      last.typeCode === d.typeCode &&
      last.amount === d.amount &&
      next === d.day
    ) {
      last.to = d.day;
    } else {
      out.push({
        planCode: d.planCode,
        typeCode: d.typeCode,
        from: d.day,
        to: d.day,
        amount: d.amount,
        currency: d.currency,
      });
    }
  }
  return out;
}
