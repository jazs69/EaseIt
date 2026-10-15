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
