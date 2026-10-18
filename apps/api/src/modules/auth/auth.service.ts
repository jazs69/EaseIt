/**
 * Two-step staff sign-in: password, then an emailed one-time code.
 *
 * ===========================================================================
 * The threat this is shaped around is a *stolen password* — reused from
 * another breach, shoulder-surfed at a front desk, or left in a browser on a
 * shared terminal. A PMS password opens folios, refunds and rate overrides, so
 * step 1 deliberately issues no session at all: a correct password buys only a
 * challenge, and the challenge is useless without the operator's mailbox.
 *
 * The specific defences, each marked at its site below:
 *
 *   1. One live challenge per account. A new sign-in retires the previous one,
 *      so N attempts do not yield N simultaneously-valid codes.
 *   2. Attempts counted by the database, not read-then-written, so parallel
 *      guesses each cost an attempt.
 *   3. A code is consumed by a conditional update, so it is single-use even
 *      under a race.
 *   4. Equal work on a credential miss as on a hit, so response time does not
 *      reveal which addresses are real staff accounts.
 *   5. Resend is both rate-limited and capped, so it cannot be used to mail-
 *      bomb an address or to farm codes.
 *   6. Failure messages never say whether the email, the password, or the
 *      account's existence was the problem.
 * ===========================================================================
 */

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  maskEmail,
  TWO_FACTOR,
  type LoginRequest,
  type LoginResult,
  type Permission,
  type PropertyGrant,
  type PropertyId,
  type Session,
  type TwoFactorChallenge,
  type UserId,
  type VerifyOtpRequest,
} from '@repo/types';
import { compare, hash } from 'bcryptjs';

import {
  AccountDisabledError,
  InvalidCredentialsError,
  OtpAttemptsExceededError,
  OtpChallengeNotFoundError,
  OtpDeliveryFailedError,
  OtpExpiredError,
  OtpInvalidError,
  OtpResendLimitError,
  OtpResendTooSoonError,
  RateLimitedError,
} from '../../common/errors/domain-error.js';
import { TokenService } from '../../common/auth/token.service.js';
import { ClockService } from '../platform/clock.service.js';
import { MAILER, type Mailer } from '../platform/mail/mailer.js';
import { RateLimiterService } from '../platform/rate-limiter.service.js';
import { AuthRepository, type ChallengeRow, type GrantRow } from './auth.repository.js';
import { generateOtpCode } from './otp-code.js';
import { describeDevice, otpEmailHtml, otpEmailSubject, otpEmailText } from './otp-email.js';

/**
 * Throttles, chosen for ~50 staff across 10 properties.
 *
 * The per-IP login budget is deliberately loose: a hotel's terminals sit
 * behind one NAT address, so a tight per-IP limit locks out a whole front desk
 * at shift change. The per-*account* budget is the tight one, because that is
 * the thing an attacker is actually grinding at.
 */
const LIMITS = {
  LOGIN_PER_IP: { limit: 40, windowSeconds: 600 },
  LOGIN_PER_EMAIL: { limit: 5, windowSeconds: 900 },
  /** Guards against sweeping random challenge ids, not against wrong codes — */
  /** the per-challenge attempt counter in the database does that. */
  VERIFY_PER_IP: { limit: 30, windowSeconds: 600 },
  RESEND_PER_IP: { limit: 10, windowSeconds: 600 },
} as const;

/** Work factor for password hashing, matching the seed. */
const BCRYPT_COST = 12;

/** Where the request came from. Resolved by the controller, never trusted. */
export interface RequestOrigin {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface VerifiedSession {
  session: Session;
  token: string;
  expiresIn: number;
}

/**
 * What `login` returns.
 *
 * `token` is present only on the `authenticated` branch — i.e. only when the
 * account has the second factor disabled and the password alone completed
 * sign-in. The controller sets the session cookie when it is there, and sets
 * nothing when it is not, which is what keeps "a correct password is not a
 * session" true for every normal account.
 */
export interface LoginOutcome {
  result: LoginResult;
  token?: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  /**
   * A real bcrypt hash of a value nobody knows, compared against when the
   * email matches no account.
   *
   * Without it, a miss returns as soon as the user lookup comes back empty
   * while a hit pays ~250ms of bcrypt — a difference an attacker can measure
   * over a few requests, which turns the login form into an account-
   * enumeration oracle. Computed once at boot rather than hardcoded so the
   * cost parameter cannot drift away from the real hashes'.
   */
  private decoyHash = '';

  constructor(
    private readonly repository: AuthRepository,
    private readonly tokens: TokenService,
    private readonly clock: ClockService,
    private readonly rateLimiter: RateLimiterService,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  async onModuleInit(): Promise<void> {
    // Startup work belongs in a lifecycle hook, not a constructor, so a
    // failure is visible at boot (CLAUDE.md section 5).
    this.decoyHash = await hash(globalThis.crypto.randomUUID(), BCRYPT_COST);

    if (!this.mailer.delivers) {
      this.logger.warn(
        'No SMTP transport configured: two-factor codes will be written to ' +
          'this log instead of being emailed. Development only.',
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Step 1 — password                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * End every session this account holds.
   *
   * Stamped from the injected clock, never from anything a caller supplies —
   * the endpoint takes no date at all, so a future instant that would lock the
   * account out cannot be requested (CLAUDE.md section 5: the clock is
   * injected).
   *
   * All sessions rather than one: the token carries no per-session identity to
   * revoke. For staff accounts on shared front-desk machines that is the safer
   * default — signing out at the desk should not leave a session alive on
   * somebody's phone.
   */
  async revokeSessions(userId: string): Promise<void> {
    await this.repository.revokeSessions(userId, this.clock.now());
  }

  async login(request: LoginRequest, origin: RequestOrigin): Promise<LoginOutcome> {
    this.enforce(`login:ip:${origin.ipAddress ?? 'unknown'}`, LIMITS.LOGIN_PER_IP);
    this.enforce(`login:email:${request.email}`, LIMITS.LOGIN_PER_EMAIL);

    const candidate = await this.repository.findLoginCandidate(request.email);

    // DEFENCE 4: equal work either way. The decoy comparison runs on a miss so
    // the timing of a miss matches the timing of a hit.
    const passwordMatches = await compare(
      request.password,
      candidate?.passwordHash ?? this.decoyHash,
    );

    if (candidate === null || !passwordMatches) {
      // DEFENCE 6: one message for "no such account" and "wrong password".
      this.logger.warn(`Failed password attempt [${origin.requestId}]`);
      throw new InvalidCredentialsError();
    }

    // Checked only *after* the password, so a disabled account is not
    // detectable without already knowing its password.
    if (!candidate.isActive) {
      throw new AccountDisabledError();
    }

    // ---------------------------------------------------------------------
    // The second factor is on by default and off only by explicit decision.
    //
    // When it is off, the password alone completes sign-in — which is exactly
    // the weakening this whole flow exists to avoid, so it is logged as a
    // warning every time rather than passing silently. The branch exists for
    // accounts that genuinely cannot receive mail; it is not a convenience.
    // ---------------------------------------------------------------------
    if (!candidate.isTwoFactorEnabled) {
      this.logger.warn(
        `Two-factor is DISABLED for user ${candidate.id}; a password alone ` +
          `completed sign-in [${origin.requestId}]`,
      );

      const session = await this.buildSession(candidate, request.propertyId ?? null);
      await this.repository.touchLastLogin(candidate.id, this.clock.now());

      const signed = this.tokens.sign({
        sub: candidate.id,
        email: candidate.email,
        pid: session.activePropertyId,
        // Truthfully records that only a password was presented. A route that
        // one day demands a freshly two-factored session for a refund will
        // refuse this token, which is the point of carrying `amr` at all.
        amr: ['pwd'],
      });

      this.rateLimiter.reset(`login:email:${candidate.email}`);

      return {
        result: { status: 'authenticated', expiresIn: signed.expiresIn, session },
        token: signed.token,
      };
    }

    const challenge = await this.issueChallenge({
      userId: candidate.id,
      email: candidate.email,
      firstName: candidate.firstName,
      requestedPropertyId: request.propertyId ?? null,
      origin,
    });

    return { result: { status: 'two_factor_required', challenge } };
  }

  /* ---------------------------------------------------------------------- */
  /*  Step 2 — the emailed code                                              */
  /* ---------------------------------------------------------------------- */

  async verifyOtp(request: VerifyOtpRequest, origin: RequestOrigin): Promise<VerifiedSession> {
    this.enforce(`verify:ip:${origin.ipAddress ?? 'unknown'}`, LIMITS.VERIFY_PER_IP);

    const now = this.clock.now();
    const challenge = await this.requireLiveChallenge(request.challengeId, now);

    if (challenge.attempts >= TWO_FACTOR.MAX_ATTEMPTS) {
      await this.repository.revoke(challenge.id, now);
      throw new OtpAttemptsExceededError();
    }

    if (challenge.expiresAt.getTime() <= now.getTime()) {
      // Not revoked: a resend can still rescue this challenge, and forcing a
      // full re-login because the operator was slow is needless friction.
      throw new OtpExpiredError();
    }

    if (!this.tokens.otpHashMatches(request.code, challenge.codeHash)) {
      // DEFENCE 2: the database does the increment.
      const attempts = await this.repository.recordFailedAttempt(challenge.id, now);
      const remaining = Math.max(0, TWO_FACTOR.MAX_ATTEMPTS - attempts);

      this.logger.warn(
        `Incorrect verification code, ${String(remaining)} attempts left ` +
          `[${origin.requestId}]`,
      );

      if (remaining === 0) {
        await this.repository.revoke(challenge.id, now);
        throw new OtpAttemptsExceededError();
      }
      throw new OtpInvalidError(remaining);
    }

    // DEFENCE 3: conditional update. If a second request got here first with
    // the same code, this changes no rows and we fail rather than issue a
    // second session from one code.
    const consumed = await this.repository.consume(challenge.id, now);
    if (!consumed) {
      this.logger.warn(`Verification raced or replayed and lost [${origin.requestId}]`);
      throw new OtpChallengeNotFoundError();
    }

    // The account could have been deactivated during the ten minutes the code
    // was outstanding.
    if (!challenge.user.isActive) {
      throw new AccountDisabledError();
    }

    const session = await this.buildSession(challenge.user, challenge.requestedPropertyId);
    await this.repository.touchLastLogin(challenge.userId, now);

    const signed = this.tokens.sign({
      sub: challenge.userId,
      email: challenge.user.email,
      pid: session.activePropertyId,
      // Both factors cleared. A route can require this later for a refund or
      // a rate override rather than accepting any valid token.
      amr: ['pwd', 'otp'],
    });

    // A completed sign-in should not leave the operator part-way to a
    // lockout; it is failures that accumulate, not successful use.
    this.rateLimiter.reset(`login:email:${challenge.user.email}`);

    this.logger.log(
      `Sign-in complete for user ${challenge.userId} ` +
        `(property ${session.activePropertyId ?? 'none selected'}) [${origin.requestId}]`,
    );

    return { session, token: signed.token, expiresIn: signed.expiresIn };
  }

  /* ---------------------------------------------------------------------- */
  /*  Resend                                                                 */
  /* ---------------------------------------------------------------------- */

  async resendOtp(challengeId: string, origin: RequestOrigin): Promise<TwoFactorChallenge> {
    this.enforce(`resend:ip:${origin.ipAddress ?? 'unknown'}`, LIMITS.RESEND_PER_IP);

    const now = this.clock.now();
    const challenge = await this.requireLiveChallenge(challengeId, now);

    // DEFENCE 5, part one: a hard cap. After this the operator signs in again,
    // which is a new password check rather than another free code.
    if (challenge.resendCount >= TWO_FACTOR.MAX_RESENDS) {
      throw new OtpResendLimitError();
    }

    // DEFENCE 5, part two: the cooldown, measured from the last send rather
    // than from the request, so repeated clicks do not each earn a mail.
    const readyAtMs =
      challenge.lastSentAt.getTime() + TWO_FACTOR.RESEND_COOLDOWN_SECONDS * 1_000;
    if (now.getTime() < readyAtMs) {
      throw new OtpResendTooSoonError(Math.ceil((readyAtMs - now.getTime()) / 1_000));
    }

    const code = generateOtpCode();
    const rotated = await this.repository.rotateCode(challenge.id, {
      codeHash: this.tokens.hashOtp(code),
      expiresAt: this.clock.plusSeconds(TWO_FACTOR.CODE_TTL_SECONDS),
      lastSentAt: now,
    });

    await this.deliver(code, rotated, challenge.user.firstName, origin);

    return this.toDto(rotated);
  }

  /* ---------------------------------------------------------------------- */
  /*  Session for an already-authenticated request                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Rebuilds the session from the database for a request that already carries
   * a verified token.
   *
   * Deliberately rebuilt rather than read back from the token: permissions are
   * resolved per request so that a revoked role stops working on the next call
   * rather than at token expiry (CLAUDE.md section 5).
   */
  async sessionFromAuthenticatedUser(
    userId: string,
    preferredPropertyId: string | null,
  ): Promise<Session> {
    const user = await this.repository.findUserProfile(userId);

    if (user === null) {
      // The guard verified the token and found the account live; between then
      // and now it was deleted or deactivated. Treat it as signed out.
      throw new AccountDisabledError();
    }

    return this.buildSession(user, preferredPropertyId);
  }

  /* ---------------------------------------------------------------------- */
  /*  Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private async issueChallenge(input: {
    userId: string;
    email: string;
    firstName: string;
    requestedPropertyId: string | null;
    origin: RequestOrigin;
  }): Promise<TwoFactorChallenge> {
    const now = this.clock.now();
    const code = generateOtpCode();

    // DEFENCE 1: `supersedeAndCreate` revokes any outstanding challenge for
    // this account in the same transaction as it creates the new one.
    const challenge = await this.repository.supersedeAndCreate(
      {
        userId: input.userId,
        email: input.email,
        codeHash: this.tokens.hashOtp(code),
        expiresAt: this.clock.plusSeconds(TWO_FACTOR.CODE_TTL_SECONDS),
        lastSentAt: now,
        requestedPropertyId: input.requestedPropertyId,
        ipAddress: input.origin.ipAddress,
        userAgent: input.origin.userAgent,
      },
      now,
    );

    await this.deliver(code, challenge, input.firstName, input.origin);

    return this.toDto(challenge);
  }

  /**
   * Sends the code, and revokes the challenge if the send fails.
   *
   * Reporting success when nothing was sent would leave the operator watching
   * an empty inbox with a challenge that can never be satisfied; revoking it
   * means the honest answer is "try again" and trying again actually helps.
   */
  private async deliver(
    code: string,
    challenge: ChallengeRow,
    firstName: string,
    origin: RequestOrigin,
  ): Promise<void> {
    const device = describeDevice(origin.userAgent ?? undefined);
    const context = {
      code,
      expiresInMinutes: Math.round(TWO_FACTOR.CODE_TTL_SECONDS / 60),
      firstName,
      ...(device !== undefined ? { deviceDescription: device } : {}),
      ...(origin.ipAddress !== null ? { ipAddress: origin.ipAddress } : {}),
    };

    try {
      await this.mailer.send({
        to: challenge.email,
        subject: otpEmailSubject(code),
        text: otpEmailText(context),
        html: otpEmailHtml(context),
        headers: {
          // Stops vacation auto-responders replying to a security notice.
          'Auto-Submitted': 'auto-generated',
          'X-Auto-Response-Suppress': 'All',
          // Keeps Gmail from collapsing successive codes into one thread,
          // which is how an operator ends up reading yesterday's code.
          'X-Entity-Ref-ID': challenge.id,
        },
      });
    } catch (error) {
      await this.repository.revoke(challenge.id, this.clock.now());
      // Logged with the challenge id, never the address or the code.
      this.logger.error(
        `Failed to deliver a verification code for challenge ${challenge.id} ` +
          `[${origin.requestId}]`,
        error instanceof Error ? error.message : String(error),
      );
      throw new OtpDeliveryFailedError();
    }
  }

  /**
   * Loads a challenge and asserts it is still usable, collapsing every
   * "no longer valid" case into one indistinguishable answer.
   */
  private async requireLiveChallenge(challengeId: string, now: Date): Promise<ChallengeRow> {
    const challenge = await this.repository.findChallenge(challengeId);

    if (challenge === null || challenge.consumedAt !== null || challenge.revokedAt !== null) {
      throw new OtpChallengeNotFoundError();
    }

    // The absolute ceiling, independent of resends: a tab left open on a
    // front-desk terminal must not stay verifiable for a whole shift.
    const deadlineMs =
      challenge.createdAt.getTime() + TWO_FACTOR.CHALLENGE_TTL_SECONDS * 1_000;
    if (now.getTime() > deadlineMs) {
      await this.repository.revoke(challenge.id, now);
      throw new OtpChallengeNotFoundError();
    }

    return challenge;
  }

  private async buildSession(
    user: { id: string; email: string; firstName: string; lastName: string },
    preferredPropertyId: string | null,
  ): Promise<Session> {
    const grants = await this.repository.loadGrants(user.id);

    // The property named at login is honoured only if the operator actually
    // holds a grant there. An ungranted request falls back to the normal
    // selection rather than erroring: the field is a preference, not an
    // assertion of access (CLAUDE.md section 3.2).
    const requested =
      preferredPropertyId === null
        ? undefined
        : grants.find((grant) => grant.propertyId === preferredPropertyId);

    // One property means do not make them choose. Several means they must, so
    // the active property stays null and the shell shows a picker; nothing is
    // guessed on their behalf.
    const active = requested ?? (grants.length === 1 ? grants[0] : undefined);

    return {
      userId: user.id as UserId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      activePropertyId: (active?.propertyId ?? null) as PropertyId | null,
      grants: grants.map(toPropertyGrant),
      // Only ever the active property's set. An empty list when no property is
      // selected is correct, not a bug: authority is per property.
      permissions: (active?.permissions ?? []) as Permission[],
      isPortfolioUser: grants.some((grant) => grant.roles.includes('SUPER_ADMIN')),
    };
  }

  private toDto(challenge: ChallengeRow): TwoFactorChallenge {
    return {
      challengeId: challenge.id,
      maskedEmail: maskEmail(challenge.email),
      codeLength: TWO_FACTOR.CODE_LENGTH,
      expiresAt: challenge.expiresAt.toISOString(),
      resendAvailableAt: new Date(
        challenge.lastSentAt.getTime() + TWO_FACTOR.RESEND_COOLDOWN_SECONDS * 1_000,
      ).toISOString(),
      attemptsRemaining: Math.max(0, TWO_FACTOR.MAX_ATTEMPTS - challenge.attempts),
      resendsRemaining: Math.max(0, TWO_FACTOR.MAX_RESENDS - challenge.resendCount),
      devMailFallback: !this.mailer.delivers,
    };
  }

  private enforce(key: string, policy: { limit: number; windowSeconds: number }): void {
    const decision = this.rateLimiter.consume(key, policy.limit, policy.windowSeconds);
    if (!decision.allowed) {
      throw new RateLimitedError(decision.retryAfterSeconds);
    }
  }
}

function toPropertyGrant(grant: GrantRow): PropertyGrant {
  return {
    propertyId: grant.propertyId as PropertyGrant['propertyId'],
    propertyCode: grant.propertyCode,
    propertySlug: grant.propertySlug,
    propertyName: grant.propertyName,
    propertyLogoUrl: grant.propertyLogoUrl,
    propertyEmail: grant.propertyEmail,
    timezone: grant.timezone,
    currency: grant.currency,
    businessDate: grant.businessDate as PropertyGrant['businessDate'],
    roles: grant.roles,
    customRoleNames: grant.customRoleNames,
  };
}
