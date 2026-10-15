/**
 * Core domain primitives shared by the API and both web apps.
 *
 * Identifiers are branded so that a `PropertyId` can never be passed where a
 * `UserId` is expected. Cross-tenant bugs are overwhelmingly "the right-shaped
 * string in the wrong position", and the compiler can catch that class
 * outright (CLAUDE.md section 5).
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Branded identifiers                                                       */
/* -------------------------------------------------------------------------- */

declare const brand: unique symbol;

type Brand<T, TBrand extends string> = T & { readonly [brand]: TBrand };

export type PropertyId = Brand<string, 'PropertyId'>;
export type UserId = Brand<string, 'UserId'>;
export type RoleId = Brand<string, 'RoleId'>;
export type PermissionId = Brand<string, 'PermissionId'>;
export type ReservationId = Brand<string, 'ReservationId'>;
export type FolioId = Brand<string, 'FolioId'>;
export type RoomId = Brand<string, 'RoomId'>;
export type RoomTypeId = Brand<string, 'RoomTypeId'>;

export const propertyIdSchema = z.uuid().transform((value) => value as PropertyId);
export const userIdSchema = z.uuid().transform((value) => value as UserId);
export const roleIdSchema = z.uuid().transform((value) => value as RoleId);
export const reservationIdSchema = z.uuid().transform((value) => value as ReservationId);
export const folioIdSchema = z.uuid().transform((value) => value as FolioId);
export const roomIdSchema = z.uuid().transform((value) => value as RoomId);
export const roomTypeIdSchema = z.uuid().transform((value) => value as RoomTypeId);

/* -------------------------------------------------------------------------- */
/*  Dates                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A calendar date in `YYYY-MM-DD` form, with no time and no zone.
 *
 * Arrival dates, departure dates, stay dates and the property business date
 * are all of this kind. They are never derived from `new Date()` on a server
 * in another timezone, and never serialised as an ISO instant — a timestamp
 * silently shifts a stay by a day either side of midnight.
 */
export type BusinessDate = Brand<string, 'BusinessDate'>;

export const businessDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar date in YYYY-MM-DD form')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), {
    message: 'Not a real calendar date',
  })
  .transform((value) => value as BusinessDate);

/** An instant in time, always UTC on the wire. */
export const instantSchema = z.iso.datetime({ offset: true });

/**
 * A stay range, half-open: arrival inclusive, departure exclusive. The
 * departure day is sellable, which is why every range in this system is `[)`
 * and why the Postgres exclusion constraint uses `daterange(..., '[)')`.
 */
export const stayRangeSchema = z
  .object({
    arrivalDate: businessDateSchema,
    departureDate: businessDateSchema,
  })
  .refine((range) => range.departureDate > range.arrivalDate, {
    message: 'Departure must be strictly after arrival (minimum one night)',
    path: ['departureDate'],
  });

export type StayRange = z.infer<typeof stayRangeSchema>;

/** Nights in a half-open stay range. */
export function nightCount(range: StayRange): number {
  const arrival = Date.parse(`${range.arrivalDate}T00:00:00Z`);
  const departure = Date.parse(`${range.departureDate}T00:00:00Z`);
  return Math.round((departure - arrival) / 86_400_000);
}

/** Every stay date in a half-open range: arrival..departure-1. */
export function enumerateStayDates(range: StayRange): BusinessDate[] {
  const dates: BusinessDate[] = [];
  const cursor = new Date(`${range.arrivalDate}T00:00:00Z`);
  const end = new Date(`${range.departureDate}T00:00:00Z`);
  while (cursor < end) {
    dates.push(cursor.toISOString().slice(0, 10) as BusinessDate);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** Shift a calendar date by whole days without tripping over DST. */
export function addDays(date: BusinessDate, days: number): BusinessDate {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10) as BusinessDate;
}

/**
 * The calendar date it currently is at a property, from an IANA timezone.
 * This is how a scheduler decides whether a property's night audit is due —
 * never the server's own clock (CLAUDE.md section 3.3).
 */
export function currentDateInTimeZone(timeZone: string, now: Date): BusinessDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  // en-CA formats as YYYY-MM-DD.
  return parts as BusinessDate;
}

/* -------------------------------------------------------------------------- */
/*  Operational enums                                                         */
/* -------------------------------------------------------------------------- */

export const ReservationStatus = {
  /** Held but not yet confirmed — expires. Does not consume inventory. */
  TENTATIVE: 'TENTATIVE',
  CONFIRMED: 'CONFIRMED',
  CHECKED_IN: 'CHECKED_IN',
  CHECKED_OUT: 'CHECKED_OUT',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
} as const;

export type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus];

export const reservationStatusSchema = z.enum(ReservationStatus);

/** Statuses that occupy a physical room and so block the exclusion constraint. */
export const BLOCKING_RESERVATION_STATUSES: readonly ReservationStatus[] = [
  ReservationStatus.CONFIRMED,
  ReservationStatus.CHECKED_IN,
  ReservationStatus.CHECKED_OUT,
];

export const RoomStatus = {
  VACANT_CLEAN: 'VACANT_CLEAN',
  VACANT_DIRTY: 'VACANT_DIRTY',
  OCCUPIED_CLEAN: 'OCCUPIED_CLEAN',
  OCCUPIED_DIRTY: 'OCCUPIED_DIRTY',
  INSPECTED: 'INSPECTED',
  OUT_OF_SERVICE: 'OUT_OF_SERVICE',
  OUT_OF_ORDER: 'OUT_OF_ORDER',
} as const;

export type RoomStatus = (typeof RoomStatus)[keyof typeof RoomStatus];

export const roomStatusSchema = z.enum(RoomStatus);

export const FolioStatus = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  TRANSFERRED: 'TRANSFERRED',
} as const;

export type FolioStatus = (typeof FolioStatus)[keyof typeof FolioStatus];

export const folioStatusSchema = z.enum(FolioStatus);

export const BookingSource = {
  DIRECT_WEB: 'DIRECT_WEB',
  FRONT_DESK: 'FRONT_DESK',
  PHONE: 'PHONE',
  WALK_IN: 'WALK_IN',
  OTA: 'OTA',
  CORPORATE: 'CORPORATE',
  TRAVEL_AGENT: 'TRAVEL_AGENT',
} as const;

export type BookingSource = (typeof BookingSource)[keyof typeof BookingSource];

export const bookingSourceSchema = z.enum(BookingSource);

/* -------------------------------------------------------------------------- */
/*  Transport envelopes                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Cursor pagination for anything unbounded — reservations, folio lines, audit
 * log. Offset pagination is not used: it double-counts rows under concurrent
 * inserts, which an operational system has constantly.
 */
export const paginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * The single error shape the API returns, produced by the global
 * `DomainExceptionFilter`. `code` is machine-readable and stable; `message` is
 * for humans and may change. Infrastructure detail never appears here.
 */
export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  requestId: z.string(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

/** Stable machine codes carried by `DomainError` subclasses in the API. */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  ROOM_UNAVAILABLE: 'ROOM_UNAVAILABLE',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  FOLIO_ALREADY_CLOSED: 'FOLIO_ALREADY_CLOSED',
  RATE_NOT_BOOKABLE: 'RATE_NOT_BOOKABLE',
  RESTRICTION_VIOLATED: 'RESTRICTION_VIOLATED',
  BUSINESS_DATE_CLOSED: 'BUSINESS_DATE_CLOSED',
  NIGHT_AUDIT_IN_PROGRESS: 'NIGHT_AUDIT_IN_PROGRESS',
  CHANNEL_REJECTED: 'CHANNEL_REJECTED',
  TENANT_SCOPE_VIOLATION: 'TENANT_SCOPE_VIOLATION',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
