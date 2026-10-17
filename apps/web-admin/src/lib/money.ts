/**
 * Money formatting for display.
 *
 * ===========================================================================
 * The only place in the web app where a minor-unit integer becomes a decimal.
 *
 * CLAUDE.md section 3.4 bans float arithmetic on money. The division by 100
 * here is the single sanctioned exception, and it is safe because the result is
 * handed straight to a formatter and never fed back into a calculation — the
 * float exists for the length of one function call. Any component that needs
 * to *add* two amounts adds the integers and formats once at the end.
 *
 * Grouping goes through `Intl.NumberFormat`, which replaced a hand-rolled
 * regex that was wrong above ₹99,999: Indian digit grouping is the last three
 * digits then pairs (1,23,456.78), and the regex produced 123,456.78. None of
 * the seeded fixtures reached a lakh so nothing on screen looked wrong, which
 * is exactly why it would have shipped. `Intl` knows this per locale and is
 * built in, so there is nothing to get wrong and no dependency to add.
 * ===========================================================================
 */

/** The locale whose grouping convention each currency expects. */
const CURRENCY_LOCALE: Record<string, string> = {
  INR: 'en-IN',
  LKR: 'en-LK',
  USD: 'en-US',
  EUR: 'de-DE',
  GBP: 'en-GB',
  AED: 'en-AE',
};

/**
 * Formatters are expensive to construct and immutable once built, so they are
 * cached per currency rather than created per render. A reservation feed of 200
 * rows would otherwise build 400 of them.
 */
const formatterCache = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string, fractionDigits: number): Intl.NumberFormat {
  const key = `${currency}:${String(fractionDigits)}`;
  const cached = formatterCache.get(key);
  if (cached !== undefined) return cached;

  const created = new Intl.NumberFormat(CURRENCY_LOCALE[currency] ?? 'en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  formatterCache.set(key, created);
  return created;
}

/** `655901, 'INR'` -> `₹6,559.01`. */
export function formatMoney(amountMinor: number, currency: string): string {
  try {
    return formatterFor(currency, 2).format(amountMinor / 100);
  } catch {
    // An unknown or malformed ISO code makes Intl throw. Degrade to something
    // readable rather than blanking a folio total.
    return `${currency} ${(amountMinor / 100).toFixed(2)}`;
  }
}

/**
 * The same, without the decimals.
 *
 * For rate columns in narrow layouts, where ".00" on every row is noise. Only
 * ever for display of a *rate*; a balance always shows its minor units,
 * because "₹6,559" when ₹6,559.01 is owed is a wrong number.
 */
export function formatMoneyRounded(amountMinor: number, currency: string): string {
  try {
    return formatterFor(currency, 0).format(Math.round(amountMinor / 100));
  } catch {
    return `${currency} ${String(Math.round(amountMinor / 100))}`;
  }
}

/**
 * Axis-tick form: `₹25L`, `₹1.2Cr`, `₹6,500`.
 *
 * For chart axes, where the full figure collides with its neighbour. Indian
 * numbering, because that is what the grouping in `formatMoney` already uses —
 * a ₹1.03 crore bar labelled "₹10,300,000" is both wrong for the locale and
 * too wide for the gutter.
 *
 * Display only, and lossy by design: the exact amount is always available in
 * the value column and the tooltip beside it.
 */
export function formatMoneyCompact(amountMinor: number, currency: string): string {
  const major = amountMinor / 100;
  const symbol = currency === 'INR' ? '₹' : `${currency} `;

  if (major >= 10_000_000) return `${symbol}${trimZero(major / 10_000_000)}Cr`;
  if (major >= 100_000) return `${symbol}${trimZero(major / 100_000)}L`;
  if (major >= 1_000) return `${symbol}${trimZero(major / 1_000)}k`;
  return formatMoneyRounded(amountMinor, currency);
}

/** `1.0` -> `1`, `1.25` -> `1.3`. One decimal, and never a trailing `.0`. */
function trimZero(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
