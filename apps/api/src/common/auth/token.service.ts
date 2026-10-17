/**
 * Session token signing and verification (HS256), plus the OTP pepper.
 *
 * ===========================================================================
 * Why this is ~120 lines of node:crypto rather than a JWT dependency.
 *
 * CLAUDE.md section 6.4 asks for a reason before adding a runtime dependency,
 * and here the platform already does the job: an HS256 JWT is two base64url
 * JSON objects and one HMAC-SHA256. What a library buys is the *care*, so this
 * file spends it explicitly on the three ways hand-rolled JWT verification
 * normally goes wrong:
 *
 *   1. **Algorithm confusion.** The header is parsed and `alg` must equal the
 *      literal `HS256`. `none` is rejected like anything else, because the
 *      check is an allowlist of one rather than a lookup of whatever the
 *      token asked for.
 *   2. **Non-constant-time comparison.** Signatures go through
 *      `timingSafeEqual`, after a length check, so a byte-by-byte early exit
 *      cannot leak the expected signature.
 *   3. **Trusting the payload once the signature checks out.** A valid
 *      signature proves the bytes are ours, not that the claims are
 *      well-formed. The payload is parsed with `jwtClaimsSchema` from
 *      @repo/types, so a token signed by an older version of this code with a
 *      different claim shape is rejected rather than half-understood.
 *
 * The one-time-password pepper is derived here too, by HMAC-ing a label with
 * the same secret. That is domain separation: the key that peppers OTP hashes
 * is not the key that signs sessions, so neither is usable in place of the
 * other, and rotating `JWT_SECRET` invalidates both together as it should.
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { jwtClaimsSchema, type JwtClaims } from '@repo/types';

import { ClockService } from '../../modules/platform/clock.service.js';

/** The only algorithm this service will sign or accept. */
const ALGORITHM = 'HS256';

/**
 * Domain-separation labels. Changing one of these rotates that derived key
 * without touching the other, which is the point of having them.
 */
const OTP_PEPPER_LABEL = 'easeit.otp-pepper.v1';

interface JwtHeader {
  alg: string;
  typ: string;
}

/** Claims as they are handed to `sign`: identity, minus the server's dates. */
export type IssuableClaims = Omit<JwtClaims, 'iat' | 'exp'>;

export interface SignedToken {
  token: string;
  /** Seconds until expiry. The cookie's Max-Age is set from this same number. */
  expiresIn: number;
  expiresAt: Date;
}

function base64UrlEncode(input: Buffer | string): string {
  return (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url');
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly secret: Buffer;
  private readonly otpPepper: Buffer;
  private readonly ttlSeconds: number;

  constructor(
    config: ConfigService,
    private readonly clock: ClockService,
  ) {
    const secret = config.get<string>('JWT_SECRET');
    if (secret === undefined || secret.length < 32) {
      // validateEnv has already enforced this; asserted again because a weak
      // key here silently weakens every session in the system.
      throw new Error('JWT_SECRET is missing or too short.');
    }

    this.secret = Buffer.from(secret, 'utf8');
    this.otpPepper = createHmac('sha256', this.secret).update(OTP_PEPPER_LABEL).digest();
    this.ttlSeconds = config.get<number>('JWT_EXPIRES_IN', 28_800);
  }

  /** Seconds a freshly issued session token is good for. */
  get sessionTtlSeconds(): number {
    return this.ttlSeconds;
  }

  /* -- Signing ------------------------------------------------------------ */

  sign(claims: IssuableClaims): SignedToken {
    const issuedAt = Math.floor(this.clock.nowMs() / 1_000);
    const expiresAtSeconds = issuedAt + this.ttlSeconds;

    const header: JwtHeader = { alg: ALGORITHM, typ: 'JWT' };
    const payload: JwtClaims = { ...claims, iat: issuedAt, exp: expiresAtSeconds };

    const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
      JSON.stringify(payload),
    )}`;

    return {
      token: `${signingInput}.${this.signature(signingInput)}`,
      expiresIn: this.ttlSeconds,
      expiresAt: new Date(expiresAtSeconds * 1_000),
    };
  }

  /* -- Verification ------------------------------------------------------- */

  /**
   * Returns the claims, or null for *any* reason the token is not acceptable.
   *
   * Null rather than a thrown error with a reason: the caller's only correct
   * response is 401 regardless, and distinguishing "expired" from "forged" in
   * a response tells an attacker which of their guesses was closer.
   */
  verify(token: string): JwtClaims | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (
      encodedHeader === undefined ||
      encodedPayload === undefined ||
      encodedSignature === undefined
    ) {
      return null;
    }

    // Allowlist of exactly one algorithm, checked before any HMAC work. This
    // is the check that makes `{"alg":"none"}` and an RS256/HS256 confusion
    // attack both dead on arrival.
    const header = this.decodeJson(encodedHeader);
    if (header === null) return null;
    const alg = (header as Partial<JwtHeader>).alg;
    if (alg !== ALGORITHM) {
      this.logger.warn(`Rejected a token presenting alg=${String(alg)}`);
      return null;
    }

    if (!this.signatureMatches(`${encodedHeader}.${encodedPayload}`, encodedSignature)) {
      return null;
    }

    const payload = this.decodeJson(encodedPayload);
    if (payload === null) return null;

    // A valid signature proves provenance, not shape. Validate anyway.
    const parsed = jwtClaimsSchema.safeParse(payload);
    if (!parsed.success) return null;

    const nowSeconds = Math.floor(this.clock.nowMs() / 1_000);
    if (parsed.data.exp <= nowSeconds) return null;
    // A token claiming to have been issued in the future is either a clock
    // problem or a forgery attempt. Small leeway for ordinary skew.
    if (parsed.data.iat > nowSeconds + 60) return null;

    return parsed.data;
  }

  /* -- One-time-password hashing ------------------------------------------ */

  /**
   * HMAC-SHA256 of a code under the derived pepper, as lowercase hex.
   *
   * A six-digit code has only a million possible values, so an *unkeyed*
   * digest of one is reversible by exhaustive search in milliseconds and is
   * therefore no better than storing the code itself. The keyed construction
   * is what makes a stolen database row useless without also stealing
   * `JWT_SECRET` from the process environment.
   *
   * A slow hash (bcrypt) is the wrong tool here for the same reason it is the
   * right one for passwords: the secret is not low-entropy *and* long-lived,
   * it is low-entropy and dead in ten minutes, so the defence has to be the
   * key rather than the work factor.
   */
  hashOtp(code: string): string {
    return createHmac('sha256', this.otpPepper).update(code, 'utf8').digest('hex');
  }

  /** Constant-time comparison of two OTP hashes. */
  otpHashMatches(candidateCode: string, storedHash: string): boolean {
    const candidate = Buffer.from(this.hashOtp(candidateCode), 'utf8');
    const stored = Buffer.from(storedHash, 'utf8');
    if (candidate.length !== stored.length) return false;
    return timingSafeEqual(candidate, stored);
  }

  /* -- Internals ---------------------------------------------------------- */

  private signature(signingInput: string): string {
    return createHmac('sha256', this.secret).update(signingInput, 'utf8').digest('base64url');
  }

  private signatureMatches(signingInput: string, presented: string): boolean {
    const expected = Buffer.from(this.signature(signingInput), 'utf8');
    const actual = Buffer.from(presented, 'utf8');
    // timingSafeEqual throws on a length mismatch, so the lengths are compared
    // first. Length is not a secret; the bytes are.
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  private decodeJson(segment: string): unknown {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
      return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
      // Malformed base64 or malformed JSON. Either way the token is not ours.
      return null;
    }
  }
}
