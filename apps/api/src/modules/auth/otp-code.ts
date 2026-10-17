/**
 * One-time code generation.
 *
 * `randomInt` rather than `Math.random()` for the obvious reason, and rather
 * than `randomBytes(n) % 1_000_000` for a less obvious one: taking a modulus
 * of a uniform byte range that is not a multiple of the modulus biases the low
 * values. `crypto.randomInt` rejects-and-resamples internally, so every code
 * from 000000 to 999999 is equally likely — which is what the "one in a
 * million" in the threat model actually depends on.
 *
 * Leading zeros are preserved by padding, so the code space really is 10^6 and
 * not 9 * 10^5. The matching input on the client is a fixed-length digit
 * field, so a leading zero cannot be silently eaten there either.
 */

import { randomInt } from 'node:crypto';

import { TWO_FACTOR } from '@repo/types';

const UPPER_BOUND = 10 ** TWO_FACTOR.CODE_LENGTH;

export function generateOtpCode(): string {
  return String(randomInt(0, UPPER_BOUND)).padStart(TWO_FACTOR.CODE_LENGTH, '0');
}

/**
 * Groups a code for reading off one screen and typing into another.
 *
 * Even lengths split down the middle (`123 456`). Odd lengths are left alone:
 * splitting five digits gives `407 19`, which reads as a typo or a truncated
 * code rather than as a helpful grouping — worse than no grouping at all.
 *
 * Display only. Never the form the code is compared in; `otpHashMatches`
 * always sees the raw digits.
 */
export function formatOtpForDisplay(code: string): string {
  if (code.length < 6 || code.length % 2 !== 0) return code;

  const half = code.length / 2;
  return `${code.slice(0, half)} ${code.slice(half)}`;
}
