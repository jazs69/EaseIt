/**
 * Monetary values for EaseIt.
 *
 * CLAUDE.md section 3.4 is absolute: money is an integer count of the
 * currency's minor unit (paise, cents) paired with an ISO-4217 code. There is
 * no float anywhere in this module, and `Money` is the only shape money is
 * allowed to take as it crosses a module or wire boundary.
 *
 * Rounding happens exactly once, where a charge is created, via `multiply`
 * or `allocate`. Never round a total that was computed from unrounded parts.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Currency                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Minor-unit exponent per currency. Most currencies are 2; a few are 0.
 * Extend this when a property is onboarded in a new currency — defaulting
 * silently to 2 would mis-scale JPY by a factor of 100.
 */
const MINOR_UNIT_EXPONENT: Record<string, number> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  SGD: 2,
  AUD: 2,
  CAD: 2,
  LKR: 2,
  NPR: 2,
  THB: 2,
  MYR: 2,
  JPY: 0,
  KRW: 0,
  VND: 0,
  IDR: 0,
};

export const SUPPORTED_CURRENCIES = Object.keys(MINOR_UNIT_EXPONENT);

export const currencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter uppercase ISO-4217 code');

export function minorUnitExponent(currency: string): number {
  const exponent = MINOR_UNIT_EXPONENT[currency];
  if (exponent === undefined) {
    throw new MoneyError(
      `Unsupported currency "${currency}". Add its minor-unit exponent to ` +
        `packages/types/src/money.ts before using it.`,
    );
  }
  return exponent;
}

/* -------------------------------------------------------------------------- */
/*  Money                                                                     */
/* -------------------------------------------------------------------------- */

export const moneySchema = z.object({
  /** Integer count of the currency's minor unit. 150000 INR = Rs 1,500.00 */
  amountMinor: z.number().int(),
  currency: currencySchema,
});

export type Money = z.infer<typeof moneySchema>;

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

/** Rounding policy. A property's configured policy is applied, not guessed. */
export const RoundingMode = {
  /** 0.5 away from zero. The default for guest-facing charges. */
  HALF_UP: 'HALF_UP',
  /** 0.5 to the nearest even integer. Reduces cumulative drift. */
  HALF_EVEN: 'HALF_EVEN',
  /** Toward zero. Use where the house must not over-charge. */
  DOWN: 'DOWN',
  /** Away from zero. */
  UP: 'UP',
} as const;

export type RoundingMode = (typeof RoundingMode)[keyof typeof RoundingMode];

export function money(amountMinor: number, currency: string): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new MoneyError(
      `Money must be an integer in minor units, received ${amountMinor}. ` +
        `A fractional value here means a float leaked into a price calculation.`,
    );
  }
  if (!Number.isSafeInteger(amountMinor)) {
    throw new MoneyError(`Amount ${amountMinor} exceeds the safe integer range.`);
  }
  minorUnitExponent(currency);
  return { amountMinor, currency };
}

export function zero(currency: string): Money {
  return money(0, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      `Cannot combine ${a.currency} with ${b.currency}. Convert explicitly ` +
        `through a dated exchange rate first.`,
    );
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function sum(amounts: readonly Money[], currency: string): Money {
  return amounts.reduce<Money>((total, amount) => add(total, amount), zero(currency));
}

export function negate(amount: Money): Money {
  return money(-amount.amountMinor, amount.currency);
}

export function isZero(amount: Money): boolean {
  return amount.amountMinor === 0;
}

export function isNegative(amount: Money): boolean {
  return amount.amountMinor < 0;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

/* -------------------------------------------------------------------------- */
/*  Rounding and scaling                                                      */
/* -------------------------------------------------------------------------- */

function roundToInteger(value: number, mode: RoundingMode): number {
  switch (mode) {
    case RoundingMode.HALF_UP: {
      return Math.sign(value) * Math.round(Math.abs(value));
    }
    case RoundingMode.HALF_EVEN: {
      const floor = Math.floor(value);
      const diff = value - floor;
      if (diff > 0.5) return floor + 1;
      if (diff < 0.5) return floor;
      return floor % 2 === 0 ? floor : floor + 1;
    }
    case RoundingMode.DOWN: {
      return Math.trunc(value);
    }
    case RoundingMode.UP: {
      return value < 0 ? Math.floor(value) : Math.ceil(value);
    }
  }
}

/**
 * Scale an amount by a rate (a tax percentage, an occupancy multiplier, a
 * discount factor) and round once to a whole minor unit.
 *
 * The `rate` is the one place a non-integer is legitimate — it is a ratio, not
 * money. The result is always a clean integer.
 */
export function multiply(
  amount: Money,
  rate: number,
  mode: RoundingMode = RoundingMode.HALF_UP,
): Money {
  if (!Number.isFinite(rate)) {
    throw new MoneyError(`Rate must be a finite number, received ${rate}.`);
  }
  return money(roundToInteger(amount.amountMinor * rate, mode), amount.currency);
}

/** Percentage helper: `percentage(total, 18)` for 18% GST. */
export function percentage(
  amount: Money,
  percent: number,
  mode: RoundingMode = RoundingMode.HALF_UP,
): Money {
  return multiply(amount, percent / 100, mode);
}

/**
 * Split an amount into `parts` pieces without losing or inventing a single
 * minor unit — the largest-remainder method. Use this to spread a stay total
 * across nights, or a package rate across its components.
 *
 * `allocate(money(10_00, 'INR'), 3)` -> [334, 333, 333]
 */
export function allocate(amount: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new MoneyError(`Cannot allocate across ${parts} parts.`);
  }
  const base = Math.trunc(amount.amountMinor / parts);
  let remainder = amount.amountMinor - base * parts;
  const step = remainder >= 0 ? 1 : -1;

  const result: Money[] = [];
  for (let index = 0; index < parts; index += 1) {
    const extra = remainder !== 0 ? step : 0;
    remainder -= extra;
    result.push(money(base + extra, amount.currency));
  }
  return result;
}

/**
 * Split by weights (e.g. per-night rates driving a prorated discount),
 * preserving the exact total. Weights need not sum to anything in particular.
 */
export function allocateByWeights(amount: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) {
    throw new MoneyError('Cannot allocate across an empty weight list.');
  }
  if (weights.some((weight) => weight < 0 || !Number.isFinite(weight))) {
    throw new MoneyError('Allocation weights must be finite and non-negative.');
  }

  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  if (totalWeight === 0) {
    return allocate(amount, weights.length);
  }

  const result: Money[] = [];
  let allocated = 0;
  for (let index = 0; index < weights.length - 1; index += 1) {
    const weight = weights[index] ?? 0;
    const share = Math.trunc((amount.amountMinor * weight) / totalWeight);
    allocated += share;
    result.push(money(share, amount.currency));
  }
  // The last slice absorbs the rounding remainder so the parts always re-sum.
  result.push(money(amount.amountMinor - allocated, amount.currency));
  return result;
}

/* -------------------------------------------------------------------------- */
/*  Conversion at the edges                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Parse a human-entered major-unit value ("1500.50") into `Money`.
 * Only for the UI boundary — never call this on a value already in minor units.
 */
export function fromMajorUnitString(value: string, currency: string): Money {
  const trimmed = value.trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new MoneyError(`"${value}" is not a valid monetary amount.`);
  }

  const exponent = minorUnitExponent(currency);
  const negative = trimmed.startsWith('-');
  const [wholePart = '0', fractionPart = ''] = trimmed.replace('-', '').split('.');

  if (fractionPart.length > exponent) {
    throw new MoneyError(
      `${currency} supports ${exponent} decimal place(s); "${value}" has ` +
        `${fractionPart.length}. Round at the UI before submitting.`,
    );
  }

  const paddedFraction = fractionPart.padEnd(exponent, '0');
  const minor = Number(`${wholePart}${paddedFraction}`);
  return money(negative ? -minor : minor, currency);
}

/** Major-unit number, for display and export only. Never for arithmetic. */
export function toMajorUnitNumber(amount: Money): number {
  return amount.amountMinor / 10 ** minorUnitExponent(amount.currency);
}

/** Locale-aware display string, e.g. "Rs 1,500.50". */
export function format(amount: Money, locale = 'en-IN'): string {
  const exponent = minorUnitExponent(amount.currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: amount.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(toMajorUnitNumber(amount));
}
