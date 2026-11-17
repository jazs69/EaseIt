/**
 * Runtime redaction of personal data in log text (SE-02).
 *
 * ===========================================================================
 * The backstop for what a source scan cannot see. `scripts/check-log-pii.mjs`
 * rejects log calls that name a personal-data field. It cannot see a value
 * that arrives inside someone else's text:
 *
 * - a mail relay's error ("550 5.1.1 <guest@example.com>: Recipient address
 *   rejected"), logged by the password-reset, invitation and OTP paths;
 * - a Prisma validation error, whose message reprints the failing call's
 *   arguments (a guest's name, email and phone on a reservation create).
 *
 * So every log line passes through `redactText` before it is written
 * (`RedactingLogger`):
 *
 * - email addresses become `[email]`;
 * - Indian mobile numbers (with or without +91, spaces, dashes) become
 *   `[phone]`;
 * - card-number-like runs (15-19 digits, or 13-19 in groups) that pass the
 *   Luhn check become `[card]`;
 * - Aadhaar-like 12-digit numbers in 4-4-4 groups become `[id-number]`;
 * - a Prisma "Invalid `prisma...` invocation" message body is cut to its
 *   first line, so the reprinted arguments never reach the log. A stack
 *   trace keeps its `at ...` frames.
 *
 * It is deliberately conservative about what it touches: UUIDs, booking codes,
 * timestamps, epoch milliseconds and minor-unit amounts pass through, because
 * a log that has lost its identifiers cannot be used to find anything.
 * ===========================================================================
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MOBILE = /(?<![\w-])(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?![\w-])/g;
const CARD = /(?<![\w-])(?:\d[ -]?){12,18}\d(?![\w-])/g;
// Not part of a longer digit run: a card written in groups of four is a card.
const AADHAAR = /(?<![\w-])(?<!\d[ -])\d{4}[ -]\d{4}[ -]\d{4}(?![ -]?\d)(?![\w-])/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Keeps the first line and stack frames of a Prisma invocation error; drops the reprinted call. */
function stripPrismaInvocation(text: string): string {
  if (!/Invalid `[^`]*` invocation/.test(text)) return text;
  const lines = text.split('\n');
  const kept = [lines[0] ?? '', '    [prisma call arguments removed]'];
  for (const line of lines.slice(1)) if (/^\s+at\s/.test(line)) kept.push(line);
  return kept.join('\n');
}

export function redactText(text: string): string {
  let out = stripPrismaInvocation(text);
  out = out.replace(EMAIL, '[email]');
  // Cards before Aadhaar, so a grouped card is never read as an ID number.
  out = out.replace(CARD, (match) => {
    const digits = match.replace(/[ -]/g, '');
    const grouped = /[ -]/.test(match);
    const plausible = grouped ? digits.length >= 13 : digits.length >= 15;
    return plausible && luhn(digits) ? '[card]' : match;
  });
  out = out.replace(AADHAAR, '[id-number]');
  out = out.replace(MOBILE, '[phone]');
  return out;
}

/** Redacts every string inside a log argument (strings, error stacks, plain objects). */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value instanceof Error) {
    const copy = new Error(redactText(value.message));
    copy.name = value.name;
    if (value.stack !== undefined) copy.stack = redactText(value.stack);
    return copy;
  }
  if (depth < 4 && value !== null && typeof value === 'object') {
    if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        redactValue(v, depth + 1),
      ]),
    );
  }
  return value;
}
