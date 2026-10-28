/**
 * Typed domain failures (CLAUDE.md section 5).
 *
 * Every expected failure in the system is one of these, carrying a stable
 * machine `code` that clients may branch on. Infrastructure errors — Prisma
 * codes, driver messages, stack traces — are translated into these at the
 * repository boundary and never reach a client.
 */

import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '@repo/types';

export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: HttpStatus;

  /** Safe, structured context for the client. Never PII, never SQL. */
  readonly details?: Record<string, unknown>;

  protected constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/**
 * A write could not commit because another transaction held what it needed.
 *
 * Uses the `CONFLICT` code, which already existed in the `ErrorCode` taxonomy
 * with no class behind it. The alternative was to reuse `RoomUnavailableError`
 * for a cancellation, which would tell a clerk a room is unavailable when
 * nothing is unavailable and nothing is being sold — so a thin class on an
 * existing code is the smaller lie-free option.
 *
 * Carries no SQLSTATE, Prisma code or driver text: the client is told to try
 * again, not how the database failed (CLAUDE.md section 5).
 */
export class TransactionConflictError extends DomainError {
  readonly code = ErrorCode.CONFLICT;
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor(operation: string) {
    super(
      'That change could not be completed because the booking was being ' +
        'changed at the same time. Try again.',
      { operation },
    );
  }
}

/**
 * The room, or the room type on those dates, cannot be sold. Thrown when the
 * oversell CHECK constraint or the room-overlap exclusion constraint rejects a
 * write and the retries are exhausted (CLAUDE.md section 3.1).
 */
export class RoomUnavailableError extends DomainError {
  readonly code = ErrorCode.ROOM_UNAVAILABLE;
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor(details?: Record<string, unknown>) {
    super('The selected room is no longer available for those dates.', details);
  }
}

export class InvalidStateTransitionError extends DomainError {
  readonly code = ErrorCode.INVALID_STATE_TRANSITION;
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor(entity: string, from: string, to: string) {
    super(`A ${entity} cannot move from ${from} to ${to}.`, { entity, from, to });
  }
}

export class FolioAlreadyClosedError extends DomainError {
  readonly code = ErrorCode.FOLIO_ALREADY_CLOSED;
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor(folioId: string) {
    super('This folio is closed; post a reversing entry instead.', { folioId });
  }
}

export class BusinessDateClosedError extends DomainError {
  readonly code = ErrorCode.BUSINESS_DATE_CLOSED;
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor(businessDate: string) {
    super(
      `The business date ${businessDate} is closed. Post an adjustment on the ` +
        `current business date rather than mutating history.`,
      { businessDate },
    );
  }
}

export class EntityNotFoundError extends DomainError {
  readonly code = ErrorCode.NOT_FOUND;
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor(entity: string) {
    super(`${entity} not found.`, { entity });
  }
}

/**
 * A request tried to reach data belonging to another property.
 *
 * Deliberately reported as 404, not 403: a 403 confirms the record exists,
 * which is itself a cross-tenant information leak (CLAUDE.md section 3.2).
 */
export class TenantScopeViolationError extends DomainError {
  readonly code = ErrorCode.NOT_FOUND;
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor(entity: string) {
    super(`${entity} not found.`, { entity });
  }
}

export class ValidationFailedError extends DomainError {
  readonly code = ErrorCode.VALIDATION_FAILED;
  readonly httpStatus = HttpStatus.BAD_REQUEST;

  constructor(issues: Record<string, string>) {
    super('The request body failed validation.', { issues });
  }
}

export class RoleNameTakenError extends DomainError {
  readonly code = ErrorCode.ROLE_NAME_TAKEN;
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor(name: string) {
    super(`A role named "${name}" already exists at this property.`, { name });
  }
}

/**
 * System role templates are shared by all ten hotels. One property editing a
 * template would silently change access at the other nine, so they are
 * read-only and a property customises by creating its own role instead.
 */
export class RoleImmutableError extends DomainError {
  readonly code = ErrorCode.ROLE_IMMUTABLE;
  readonly httpStatus = HttpStatus.CONFLICT;

  constructor(name: string) {
    super(
      `"${name}" is a system role template and cannot be edited. ` +
        'Create a custom role for this property instead.',
      { name },
    );
  }
}

export class ForbiddenError extends DomainError {
  readonly code = ErrorCode.FORBIDDEN;
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor(requiredPermission?: string) {
    super(
      'You do not have permission to perform this action.',
      requiredPermission !== undefined ? { requiredPermission } : undefined,
    );
  }
}

export class UnauthenticatedError extends DomainError {
  readonly code = ErrorCode.UNAUTHENTICATED;
  readonly httpStatus = HttpStatus.UNAUTHORIZED;

  constructor() {
    super('Authentication is required.');
  }
}

/* -------------------------------------------------------------------------- */
/*  Sign-in                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Wrong password, or no account at that address.
 *
 * One error class for both on purpose. A distinct "no such user" response
 * turns the login form into an account-enumeration oracle: an attacker learns
 * which of ten thousand guessed addresses are real staff without ever
 * guessing a password. `AuthService` additionally spends the same bcrypt work
 * on a miss as on a hit, so the response *time* does not leak it either.
 */
export class InvalidCredentialsError extends DomainError {
  readonly code = ErrorCode.INVALID_CREDENTIALS;
  readonly httpStatus = HttpStatus.UNAUTHORIZED;

  constructor() {
    super('That email and password combination was not recognised.');
  }
}

export class AccountDisabledError extends DomainError {
  readonly code = ErrorCode.ACCOUNT_DISABLED;
  readonly httpStatus = HttpStatus.FORBIDDEN;

  constructor() {
    super('This account has been deactivated. Contact your property administrator.');
  }
}

/**
 * Unknown, already-used, revoked or expired-past-rescue challenge id.
 *
 * Reported as 404 rather than 401 for the same reason a cross-tenant read is
 * (CLAUDE.md section 3.2): a 401 would confirm that *some* challenge exists
 * under that id.
 */
export class OtpChallengeNotFoundError extends DomainError {
  readonly code = ErrorCode.OTP_CHALLENGE_NOT_FOUND;
  readonly httpStatus = HttpStatus.NOT_FOUND;

  constructor() {
    super('That verification request is no longer valid. Please sign in again.');
  }
}

/** Wrong code, with the remaining budget so the UI can warn before lockout. */
export class OtpInvalidError extends DomainError {
  readonly code = ErrorCode.OTP_INVALID;
  readonly httpStatus = HttpStatus.UNAUTHORIZED;

  constructor(attemptsRemaining: number) {
    super(
      attemptsRemaining === 1
        ? 'That code is not correct. One more attempt before you have to sign in again.'
        : `That code is not correct. ${String(attemptsRemaining)} attempts remaining.`,
      { attemptsRemaining },
    );
  }
}

export class OtpExpiredError extends DomainError {
  readonly code = ErrorCode.OTP_EXPIRED;
  readonly httpStatus = HttpStatus.UNAUTHORIZED;

  constructor() {
    super('That code has expired. Request a new one.');
  }
}

export class OtpAttemptsExceededError extends DomainError {
  readonly code = ErrorCode.OTP_ATTEMPTS_EXCEEDED;
  readonly httpStatus = HttpStatus.TOO_MANY_REQUESTS;

  constructor() {
    super('Too many incorrect codes. For your security, please sign in again.');
  }
}

export class OtpResendTooSoonError extends DomainError {
  readonly code = ErrorCode.OTP_RESEND_TOO_SOON;
  readonly httpStatus = HttpStatus.TOO_MANY_REQUESTS;

  constructor(retryAfterSeconds: number) {
    super(`Wait ${String(retryAfterSeconds)}s before requesting another code.`, {
      retryAfterSeconds,
    });
  }
}

export class OtpResendLimitError extends DomainError {
  readonly code = ErrorCode.OTP_RESEND_LIMIT;
  readonly httpStatus = HttpStatus.TOO_MANY_REQUESTS;

  constructor() {
    super('No more codes can be sent for this sign-in. Please start again.');
  }
}

/**
 * The mail transport refused the message.
 *
 * Deliberately a failure rather than a silent success: answering "code sent"
 * when nothing was sent leaves the operator staring at an empty inbox with no
 * way to tell that retrying is pointless. `AuthService` revokes the challenge
 * before raising this, so nothing unusable is left behind.
 */
export class OtpDeliveryFailedError extends DomainError {
  readonly code = ErrorCode.OTP_DELIVERY_FAILED;
  readonly httpStatus = HttpStatus.SERVICE_UNAVAILABLE;

  constructor() {
    super('We could not send your verification code. Please try again in a moment.');
  }
}

export class RateLimitedError extends DomainError {
  readonly code = ErrorCode.RATE_LIMITED;
  readonly httpStatus = HttpStatus.TOO_MANY_REQUESTS;

  constructor(retryAfterSeconds: number) {
    super('Too many attempts. Please wait before trying again.', { retryAfterSeconds });
  }
}
