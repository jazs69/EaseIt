/**
 * Persistence for sign-in. The only file in this module that touches Prisma
 * (CLAUDE.md section 5: controller -> service -> repository -> Prisma).
 *
 * Two things here are load-bearing rather than incidental:
 *
 *   * **`consume` and `recordFailedAttempt` are conditional updates**, not
 *     read-then-write. Both are expressed as a single `updateMany` whose
 *     `where` clause re-asserts the state the caller believed it was acting
 *     on, and both report how many rows they actually changed. That is what
 *     makes a code single-use when two requests arrive with it at once: the
 *     loser updates zero rows and is told so, instead of both passing because
 *     each read `consumedAt: null` before either wrote.
 *   * **Prisma errors do not escape this file.** They are translated into the
 *     domain errors in `common/errors`, so no `P2025` or driver string can
 *     reach a response body.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, PrismaErrorCode } from '@repo/database';
import {
  isRole,
  OPERABLE_PROPERTY_STATUSES,
  permissionsForRoles,
  type Permission,
  type Role,
} from '@repo/types';

import { PrismaService } from '../../prisma/prisma.service.js';
import { OtpChallengeNotFoundError } from '../../common/errors/domain-error.js';

export interface LoginCandidate {
  id: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  isTwoFactorEnabled: boolean;
}

export interface ChallengeRow {
  id: string;
  userId: string;
  email: string;
  codeHash: string;
  expiresAt: Date;
  lastSentAt: Date;
  attempts: number;
  resendCount: number;
  consumedAt: Date | null;
  revokedAt: Date | null;
  requestedPropertyId: string | null;
  createdAt: Date;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    isActive: boolean;
  };
}

export interface NewChallenge {
  userId: string;
  email: string;
  codeHash: string;
  expiresAt: Date;
  lastSentAt: Date;
  requestedPropertyId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/** One property a user may work in, with the authority they hold there. */
export interface GrantRow {
  propertyId: string;
  /** Operator-facing short identifier the admin shell routes by. */
  propertyCode: string;
  propertySlug: string;
  propertyName: string;
  propertyLogoUrl: string | null;
  propertyEmail: string | null;
  timezone: string;
  currency: string;
  /** `YYYY-MM-DD`, the property's own open accounting day. */
  businessDate: string;
  roles: Role[];
  customRoleNames: string[];
  permissions: Permission[];
}

@Injectable()
export class AuthRepository {
  private readonly logger = new Logger(AuthRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /* -- Credentials -------------------------------------------------------- */

  /**
   * The row needed to check a password, including `isActive` and including
   * deactivated accounts.
   *
   * Filtering deactivated users out here would be worse, not better: the
   * password check would then short-circuit before the hash comparison and
   * answer measurably faster for a disabled account than for a live one,
   * which is an enumeration oracle built out of a well-meant `where` clause.
   */
  async findLoginCandidate(email: string): Promise<LoginCandidate | null> {
    return this.prisma.client.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        firstName: true,
        lastName: true,
        isActive: true,
        isTwoFactorEnabled: true,
      },
    });
  }

  /**
   * The display fields for an already-authenticated request.
   *
   * Separate from `findLoginCandidate` specifically so `passwordHash` is not
   * selected on a path that has no business holding one — a hash that is never
   * loaded cannot be accidentally logged or serialised.
   */
  async findUserProfile(
    userId: string,
  ): Promise<{ id: string; email: string; firstName: string; lastName: string } | null> {
    return this.prisma.client.user.findFirst({
      where: { id: userId, isActive: true },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
  }

  async touchLastLogin(userId: string, at: Date): Promise<void> {
    await this.prisma.client.user.update({
      where: { id: userId },
      data: { lastLoginAt: at },
      select: { id: true },
    });
  }

  /**
   * Mark every token issued before `at` as refused.
   *
   * `updateMany` rather than `update`: signing out of an account that has
   * since been deleted is not worth raising at the caller — the session is
   * gone either way, and the cookie still needs clearing.
   */
  async revokeSessions(userId: string, at: Date): Promise<void> {
    await this.prisma.client.user.updateMany({
      where: { id: userId },
      data: { sessionsValidFrom: at },
    });
  }

  /* -- Challenges --------------------------------------------------------- */

  /**
   * Retires every live challenge for this user, then creates the new one, in
   * one transaction.
   *
   * One live challenge per account at a time is a security property, not
   * tidiness: leaving the previous code valid means N sign-in attempts give an
   * attacker N simultaneously-valid codes and N x MAX_ATTEMPTS guesses, which
   * turns a one-in-a-million code into a much better bet.
   */
  async supersedeAndCreate(challenge: NewChallenge, at: Date): Promise<ChallengeRow> {
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        await tx.twoFactorChallenge.updateMany({
          where: { userId: challenge.userId, consumedAt: null, revokedAt: null },
          data: { revokedAt: at },
        });

        return tx.twoFactorChallenge.create({
          data: challenge,
          select: this.challengeSelect(),
        });
      });
    } catch (error) {
      throw this.translate(error, 'create a verification challenge');
    }
  }

  /** Null when the id is unknown. State checks are the service's job. */
  async findChallenge(challengeId: string): Promise<ChallengeRow | null> {
    try {
      return await this.prisma.client.twoFactorChallenge.findUnique({
        where: { id: challengeId },
        select: this.challengeSelect(),
      });
    } catch (error) {
      throw this.translate(error, 'load a verification challenge');
    }
  }

  /**
   * Marks the challenge used, but only if it is still outstanding.
   *
   * Returns false when it changed nothing — the row was already consumed,
   * revoked, or expired between the read and this write. The caller must treat
   * false as a failed verification, never as a benign retry: it is exactly
   * what a replayed code looks like.
   */
  async consume(challengeId: string, at: Date): Promise<boolean> {
    try {
      const result = await this.prisma.client.twoFactorChallenge.updateMany({
        where: {
          id: challengeId,
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: at },
        },
        data: { consumedAt: at },
      });
      return result.count === 1;
    } catch (error) {
      throw this.translate(error, 'complete verification');
    }
  }

  /**
   * Counts one wrong code and reports the new total.
   *
   * The increment is done by the database (`increment`), not by reading the
   * count and writing count + 1, so parallel wrong guesses each cost an
   * attempt. The read-modify-write version lets an attacker fire ten requests
   * at once and be charged for one.
   */
  async recordFailedAttempt(challengeId: string, at: Date): Promise<number> {
    try {
      const updated = await this.prisma.client.twoFactorChallenge.update({
        where: { id: challengeId },
        data: { attempts: { increment: 1 }, updatedAt: at },
        select: { attempts: true },
      });
      return updated.attempts;
    } catch (error) {
      throw this.translate(error, 'record a failed verification attempt');
    }
  }

  async revoke(challengeId: string, at: Date): Promise<void> {
    try {
      await this.prisma.client.twoFactorChallenge.updateMany({
        where: { id: challengeId, consumedAt: null, revokedAt: null },
        data: { revokedAt: at },
      });
    } catch (error) {
      throw this.translate(error, 'revoke a verification challenge');
    }
  }

  /**
   * Swaps in a freshly generated code: new hash, new expiry, resend counted,
   * and the attempt budget reset.
   *
   * Resetting `attempts` is correct — the budget is per code, and wrong
   * guesses at a code that no longer exists should not consume the new one's.
   * The resend *count* is what bounds the total, and the database's CHECK
   * constraint refuses a row that exceeds it even if this method were called
   * once too often.
   */
  async rotateCode(
    challengeId: string,
    next: { codeHash: string; expiresAt: Date; lastSentAt: Date },
  ): Promise<ChallengeRow> {
    try {
      return await this.prisma.client.twoFactorChallenge.update({
        where: { id: challengeId },
        data: {
          codeHash: next.codeHash,
          expiresAt: next.expiresAt,
          lastSentAt: next.lastSentAt,
          attempts: 0,
          resendCount: { increment: 1 },
        },
        select: this.challengeSelect(),
      });
    } catch (error) {
      throw this.translate(error, 'issue a replacement code');
    }
  }

  /* -- Authority ---------------------------------------------------------- */

  /**
   * Every property this user may operate in, with the union of the
   * permissions their roles there confer.
   *
   * Cross-property by construction, and deliberately so: this is the sign-in
   * path, which runs *before* any property has been resolved and whose whole
   * job is to find out which ones the operator may pick from. It is one of the
   * narrow set of reads CLAUDE.md section 3.2 allows to span tenants, and it
   * is scoped by `userId` rather than left open.
   */
  async loadGrants(userId: string): Promise<GrantRow[]> {
    const rows = await this.prisma.client.userPropertyRole.findMany({
      // Retired properties drop out of the session's grants, so they never
      // appear in the group dashboard or the property switcher. ONBOARDING
      // stays: it is where configuration work happens.
      where: { userId, property: { status: { in: [...OPERABLE_PROPERTY_STATUSES] } } },
      select: {
        propertyId: true,
        property: {
          select: {
            code: true,
            slug: true,
            name: true,
            logoUrl: true,
            email: true,
            timezone: true,
            currency: true,
            businessDate: true,
          },
        },
        role: {
          select: {
            key: true,
            name: true,
            permissions: { select: { permission: { select: { key: true } } } },
          },
        },
      },
      orderBy: { property: { name: 'asc' } },
    });

    // A user holds one row per (property, role), so several rows collapse into
    // one grant whose permission set is their union — a clerk who is both
    // Front Desk and Night Auditor can do both jobs.
    const byProperty = new Map<string, GrantRow>();

    for (const row of rows) {
      let grant = byProperty.get(row.propertyId);
      if (grant === undefined) {
        grant = {
          propertyId: row.propertyId,
          propertyCode: row.property.code,
          propertySlug: row.property.slug,
          propertyName: row.property.name,
          propertyLogoUrl: row.property.logoUrl,
          propertyEmail: row.property.email,
          timezone: row.property.timezone,
          currency: row.property.currency,
          // @db.Date comes back as UTC midnight, so the first ten characters
          // are the property's calendar date with no timezone arithmetic
          // applied — which is the point of storing it as a date
          // (CLAUDE.md section 3.3).
          businessDate: row.property.businessDate.toISOString().slice(0, 10),
          roles: [],
          customRoleNames: [],
          permissions: [],
        };
        byProperty.set(row.propertyId, grant);
      }

      if (row.role.key !== null && isRole(row.role.key)) {
        grant.roles.push(row.role.key);
      } else {
        grant.customRoleNames.push(row.role.name);
      }

      for (const link of row.role.permissions) {
        grant.permissions.push(link.permission.key as Permission);
      }
    }

    return [...byProperty.values()].map((grant) => {
      const permissions = new Set(grant.permissions);

      // A portfolio operator's permissions come from code rather than from
      // their stored grant rows, matching ActivePropertyGuard: adding a
      // permission to the SUPER_ADMIN template then takes effect without a
      // re-seed.
      if (grant.roles.includes('SUPER_ADMIN')) {
        for (const permission of permissionsForRoles(['SUPER_ADMIN'])) {
          permissions.add(permission);
        }
      }

      return { ...grant, permissions: [...permissions] };
    });
  }

  /* -- Internals ---------------------------------------------------------- */

  private challengeSelect() {
    return {
      id: true,
      userId: true,
      email: true,
      codeHash: true,
      expiresAt: true,
      lastSentAt: true,
      attempts: true,
      resendCount: true,
      consumedAt: true,
      revokedAt: true,
      requestedPropertyId: true,
      createdAt: true,
      user: {
        select: { id: true, email: true, firstName: true, lastName: true, isActive: true },
      },
    } as const;
  }

  /**
   * Prisma error -> domain error. Nothing from the ORM crosses this boundary
   * (CLAUDE.md section 5).
   */
  private translate(error: unknown, action: string): Error {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === PrismaErrorCode.RECORD_NOT_FOUND) {
        return new OtpChallengeNotFoundError();
      }

      // Includes the CHECK constraints in the migration: an attempt or resend
      // count that exceeded its cap. Logged here with the Prisma code, and
      // reported to the caller as the ordinary "sign in again" outcome.
      this.logger.warn(`Prisma ${error.code} while trying to ${action}`);
      return new OtpChallengeNotFoundError();
    }

    // Not a Prisma error we recognise, so it is a bug or an outage. Enriched
    // and rethrown rather than swallowed; the global filter turns it into a
    // 500 with no detail.
    this.logger.error(
      `Unexpected failure while trying to ${action}`,
      error instanceof Error ? error.stack : String(error),
    );
    return error instanceof Error ? error : new Error(`Failed to ${action}`);
  }
}
