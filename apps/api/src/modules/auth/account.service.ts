/**
 * Password reset, invitations and deactivation (AU-08, AU-14, AU-15).
 *
 * ===========================================================================
 * **Tokens.** A reset or invitation link carries 32 random bytes; only their
 * SHA-256 is stored (`auth_token`). A token is single-use: it is consumed by
 * a conditional update -- unconsumed, unrevoked, unexpired -- so two
 * submissions of one link cannot both succeed, and an expired or reused link
 * is refused with one typed answer that does not say which. Issuing a new
 * token of a purpose revokes the person's earlier pending ones.
 *
 * **No account discovery.** "Forgot password" answers the same for every
 * address, sends nothing for an unknown or inactive one, and is rate limited
 * per address and per caller.
 *
 * **After a reset**, every session the person holds is revoked
 * (`sessionsValidFrom`), so a stolen session dies with the old password.
 *
 * **Links** point at the staff app with the token in the URL *fragment*,
 * which browsers never send to a server, so it is not written to any access
 * log or carried in a Referer header.
 *
 * **Mail is sent after the transaction commits**, never inside it (section
 * 3.1): the token exists first, and a failed send leaves a token nobody holds,
 * which simply expires.
 * ===========================================================================
 */

import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ForgotPasswordRequest,
  SetPasswordResult,
  SetPasswordWithTokenRequest,
} from '@repo/types';
import { hash } from 'bcryptjs';

import { AuthTokenInvalidError, RateLimitedError } from '../../common/errors/domain-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClockService } from '../platform/clock.service.js';
import { MAILER, type Mailer } from '../platform/mail/mailer.js';
import { RateLimiterService } from '../platform/rate-limiter.service.js';
import { invitationEmail, passwordResetEmail } from './account-email.js';

const BCRYPT_COST = 12;

/** How long a link works. A reset is short; an invitation waits for someone to read their mail. */
export const ACCOUNT_TOKEN_TTL_MS = {
  PASSWORD_RESET: 30 * 60 * 1000,
  INVITATION: 72 * 60 * 60 * 1000,
} as const;

const FORGOT_PER_EMAIL = { limit: 3, windowSeconds: 900 };
const FORGOT_PER_IP = { limit: 20, windowSeconds: 900 };
const SET_PASSWORD_PER_IP = { limit: 20, windowSeconds: 900 };

type Purpose = 'PASSWORD_RESET' | 'INVITATION';

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly rateLimiter: RateLimiterService,
    private readonly config: ConfigService,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  /* -------------------------------------------------------------------- */
  /*  AU-08: forgot / reset                                                */
  /* -------------------------------------------------------------------- */

  /**
   * Email a reset link if the address belongs to an active person. Always
   * resolves the same way; the caller cannot tell which happened.
   */
  async forgotPassword(request: ForgotPasswordRequest, ip: string): Promise<void> {
    this.enforce(`forgot:ip:${ip}`, FORGOT_PER_IP);
    this.enforce(`forgot:email:${request.email}`, FORGOT_PER_EMAIL);

    const user = await this.prisma.client.user.findUnique({
      where: { email: request.email },
      select: { id: true, email: true, firstName: true, isActive: true },
    });
    if (user === null || !user.isActive) return;

    const token = await this.issue(user.id, 'PASSWORD_RESET', null);
    const link = this.link('reset-password', token);
    try {
      await this.mailer.send(passwordResetEmail({ to: user.email, firstName: user.firstName, link, minutes: 30 }));
    } catch (error) {
      // Logged, not surfaced: the answer must not differ for a real account.
      this.logger.error(`Password reset email could not be sent: ${String(error)}`);
    }
  }

  /** Set a new password with a reset link; every existing session is revoked. */
  async resetPassword(request: SetPasswordWithTokenRequest, ip: string): Promise<SetPasswordResult> {
    this.enforce(`set-password:ip:${ip}`, SET_PASSWORD_PER_IP);
    return this.setPassword(request, 'PASSWORD_RESET');
  }

  /* -------------------------------------------------------------------- */
  /*  AU-14: invitations                                                   */
  /* -------------------------------------------------------------------- */

  /** An invited person sets their first password. */
  async acceptInvitation(request: SetPasswordWithTokenRequest, ip: string): Promise<SetPasswordResult> {
    this.enforce(`set-password:ip:${ip}`, SET_PASSWORD_PER_IP);
    return this.setPassword(request, 'INVITATION');
  }

  /** Whether this person still has an invitation they have not accepted. */
  async hasPendingInvitation(userId: string): Promise<boolean> {
    const pending = await this.prisma.client.authToken.count({
      where: { userId, purpose: 'INVITATION', consumedAt: null, revokedAt: null },
    });
    return pending > 0;
  }

  /**
   * Email an invitation link. Returns false when the message could not be
   * sent; the invited account and its roles exist either way, and inviting
   * again issues a fresh link.
   */
  async sendInvitation(input: {
    userId: string;
    email: string;
    firstName: string;
    propertyName: string;
    invitedById: string;
  }): Promise<boolean> {
    const token = await this.issue(input.userId, 'INVITATION', input.invitedById);
    const link = this.link('accept-invite', token);
    try {
      await this.mailer.send(
        invitationEmail({ to: input.email, firstName: input.firstName, propertyName: input.propertyName, link, hours: 72 }),
      );
      return true;
    } catch (error) {
      this.logger.error(`Invitation email could not be sent: ${String(error)}`);
      return false;
    }
  }

  /** Every link this person has not used stops working (deactivation). */
  async revokePendingTokens(userId: string): Promise<void> {
    await this.prisma.client.authToken.updateMany({
      where: { userId, consumedAt: null, revokedAt: null },
      data: { revokedAt: this.clock.now() },
    });
  }

  /* -------------------------------------------------------------------- */
  /*  Shared                                                               */
  /* -------------------------------------------------------------------- */

  /** A fresh token for one purpose; the person's earlier pending ones are revoked. */
  private async issue(userId: string, purpose: Purpose, createdById: string | null): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    await this.prisma.client.$transaction(async (tx) => {
      await tx.authToken.updateMany({
        where: { userId, purpose, consumedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.authToken.create({
        data: {
          userId,
          purpose,
          tokenHash: digest(token),
          expiresAt: new Date(now.getTime() + ACCOUNT_TOKEN_TTL_MS[purpose]),
          createdById,
        },
      });
    });
    return token;
  }

  /**
   * Consume the token and set the password, atomically. The conditional
   * update is what makes it single-use: a second submission, an expired link
   * and a superseded link all match no row, and get the same typed refusal.
   */
  private async setPassword(request: SetPasswordWithTokenRequest, purpose: Purpose): Promise<SetPasswordResult> {
    const passwordHash = await hash(request.newPassword, BCRYPT_COST);
    const now = this.clock.now();

    return this.prisma.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ user_id: string }[]>`
        UPDATE "auth_token"
           SET "consumedAt" = ${now}
         WHERE "tokenHash" = ${digest(request.token)}
           AND "purpose" = ${purpose}::"AuthTokenPurpose"
           AND "consumedAt" IS NULL
           AND "revokedAt" IS NULL
           AND "expiresAt" > ${now}
        RETURNING "userId" AS user_id`;
      const consumed = rows[0];
      if (consumed === undefined) throw new AuthTokenInvalidError();

      const user = await tx.user.findUnique({
        where: { id: consumed.user_id },
        select: { email: true, isActive: true },
      });
      // A deactivated person's links are revoked at deactivation; refused
      // here too, in case one was issued in between.
      if (user === null || !user.isActive) throw new AuthTokenInvalidError();

      await tx.user.update({
        where: { id: consumed.user_id },
        // Revokes every session issued before now (AU-06): a reset ends a
        // possibly stolen session along with the old password.
        data: { passwordHash, sessionsValidFrom: now },
      });
      // Any other link of either purpose is now pointless; close them.
      await tx.authToken.updateMany({
        where: { userId: consumed.user_id, consumedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      this.logger.log(`${purpose === 'INVITATION' ? 'Invitation accepted' : 'Password reset'} for user ${consumed.user_id}.`);
      return { email: user.email };
    });
  }

  private link(page: 'reset-password' | 'accept-invite', token: string): string {
    const base = this.config.get<string>('WEB_ADMIN_URL', 'http://localhost:3001').replace(/\/+$/, '');
    return `${base}/${page}#token=${token}`;
  }

  private enforce(key: string, policy: { limit: number; windowSeconds: number }): void {
    const decision = this.rateLimiter.consume(key, policy.limit, policy.windowSeconds);
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);
  }
}
