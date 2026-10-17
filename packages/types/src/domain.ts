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
  /**
   * Awaiting payment or a decision. Holds a room but is not a sale yet, so
   * like TENTATIVE it is absent from BLOCKING_RESERVATION_STATUSES below and
   * does not consume inventory.
   */
  ON_HOLD: 'ON_HOLD',
} as const;

export type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus];

export const reservationStatusSchema = z.enum(ReservationStatus);

/** Statuses that occupy a physical room and so block the exclusion constraint. */
export const BLOCKING_RESERVATION_STATUSES: readonly ReservationStatus[] = [
  ReservationStatus.CONFIRMED,
  ReservationStatus.CHECKED_IN,
  ReservationStatus.CHECKED_OUT,
];

/**
 * Statuses that are live but consume no inventory.
 *
 * Kept as its own list rather than inferred as "everything not blocking",
 * because CANCELLED and NO_SHOW are also non-blocking and must not be
 * confused with these: a held room is still expected to become a sale, a
 * cancelled one is not.
 */
export const NON_CONSUMING_RESERVATION_STATUSES: readonly ReservationStatus[] = [
  ReservationStatus.TENTATIVE,
  ReservationStatus.ON_HOLD,
];

/**
 * Where a property sits in its own lifecycle.
 *
 * Replaces an `isActive` boolean. A hotel being configured is neither trading
 * nor retired, and a boolean forces that third case to be represented
 * somewhere else — usually a second flag that then disagrees with the first.
 */
export const PropertyStatus = {
  /** Trading. The only status the booking engine will sell. */
  ACTIVE: 'ACTIVE',
  /** Being configured. Staff may sign in; it is not sellable. */
  ONBOARDING: 'ONBOARDING',
  /** Retired. Read-only, kept for reporting and audit history. */
  INACTIVE: 'INACTIVE',
} as const;

export type PropertyStatus = (typeof PropertyStatus)[keyof typeof PropertyStatus];

export const propertyStatusSchema = z.enum(PropertyStatus);

export const PROPERTY_STATUS_LABELS: Record<PropertyStatus, string> = {
  ACTIVE: 'Active',
  ONBOARDING: 'Onboarding',
  INACTIVE: 'Inactive',
};

/** Statuses a staff member may still sign into and operate. */
export const OPERABLE_PROPERTY_STATUSES: readonly PropertyStatus[] = [
  PropertyStatus.ACTIVE,
  PropertyStatus.ONBOARDING,
];

/**
 * Board basis. EP is room-only; the rest add meals.
 *
 * An enum, not a string: these four are the entire set, and the rate a stay is
 * priced at depends on which one applies — a typo in a free-form column
 * silently becomes a plan the pricing code cannot interpret.
 */
export const MealPlan = {
  /** European — room only. */
  EP: 'EP',
  /** Continental — breakfast included. */
  CP: 'CP',
  /** Modified American — breakfast plus one meal. */
  MAP: 'MAP',
  /** American — all meals. */
  AP: 'AP',
} as const;

export type MealPlan = (typeof MealPlan)[keyof typeof MealPlan];

export const mealPlanSchema = z.enum(MealPlan);

export const MEAL_PLAN_LABELS: Record<MealPlan, string> = {
  EP: 'Room only',
  CP: 'Breakfast',
  MAP: 'Half board',
  AP: 'Full board',
};

export const PaymentGatewayStatus = {
  /** Onboarding started, identity checks outstanding. Cannot take payments. */
  PENDING_KYC: 'PENDING_KYC',
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
} as const;

export type PaymentGatewayStatus =
  (typeof PaymentGatewayStatus)[keyof typeof PaymentGatewayStatus];

export const paymentGatewayStatusSchema = z.enum(PaymentGatewayStatus);

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

/**
 * How a booking reached the hotel. Mirrors the Prisma enum of the same name.
 *
 * Two granularities in one field, deliberately: the first seven are a source
 * *type*, the named OTAs below are a channel *identity*. A reservation has to
 * be able to say "Agoda" rather than the unactionable "OTA", which is what the
 * booking-source report groups on via [BOOKING_SOURCE_BUCKET]. When the
 * `channels` module lands it owns channel identity as mapping rows and these
 * named members become a foreign key.
 *
 * `OTA` is kept for a channel with no member of its own, so nothing has to be
 * forced into a wrong bucket. There is no `DIRECT_WEBSITE` — that is
 * `DIRECT_WEB`; only its report label differs.
 */
export const BookingSource = {
  DIRECT_WEB: 'DIRECT_WEB',
  FRONT_DESK: 'FRONT_DESK',
  PHONE: 'PHONE',
  WALK_IN: 'WALK_IN',
  OTA: 'OTA',
  CORPORATE: 'CORPORATE',
  TRAVEL_AGENT: 'TRAVEL_AGENT',
  MAKEMYTRIP: 'MAKEMYTRIP',
  AGODA: 'AGODA',
  BOOKING_COM: 'BOOKING_COM',
  EXPEDIA: 'EXPEDIA',
  CLEARTRIP: 'CLEARTRIP',
} as const;

export type BookingSource = (typeof BookingSource)[keyof typeof BookingSource];

export const bookingSourceSchema = z.enum(BookingSource);

/* -------------------------------------------------------------------------- */
/*  Booking source reporting buckets                                          */
/* -------------------------------------------------------------------------- */

/**
 * The buckets the booking-source report groups into, in display order.
 *
 * ===========================================================================
 * Distinct from `BookingSource` above, and the distinction is the point.
 *
 * `BookingSource` is what a reservation *stores*. It carries two
 * granularities: a source type (how the booking arrived — walk-in, phone,
 * corporate) and, for the named OTAs, a channel identity. These are what the
 * report *shows*, and a GM reading it wants named channels: "Agoda earned
 * ₹1.2L" is actionable, "OTA earned ₹8L" is not.
 *
 * Keeping them as two types rather than one means the report's buckets can be
 * reordered, merged or renamed without a migration, and the storage enum can
 * gain a channel without the report silently growing a bar nobody designed.
 * `BOOKING_SOURCE_BUCKET` below is the only mapping between them.
 *
 * `DIRECT_WEBSITE` here is stored as `DIRECT_WEB` — the label differs, the
 * concept does not. `OTHERS` is a real bucket, not a dumping ground for
 * unmapped values: every member of the storage enum maps somewhere, and the
 * `Record` type makes a new one a compile error rather than a silent omission.
 * ===========================================================================
 */
export const BOOKING_SOURCES = [
  'WALK_IN',
  'MAKEMYTRIP',
  'AGODA',
  'BOOKING_COM',
  'EXPEDIA',
  'CLEARTRIP',
  'DIRECT_WEBSITE',
  'OTHERS',
] as const;

export type BookingSourceKey = (typeof BOOKING_SOURCES)[number];

export const bookingSourceKeySchema = z.enum(BOOKING_SOURCES);

/** Operator-facing labels. Punctuated the way the brands actually write them. */
export const BOOKING_SOURCE_LABELS: Record<BookingSourceKey, string> = {
  WALK_IN: 'WALK-IN',
  MAKEMYTRIP: 'MAKEMYTRIP',
  AGODA: 'AGODA',
  BOOKING_COM: 'BOOKING.COM',
  EXPEDIA: 'EXPEDIA',
  CLEARTRIP: 'CLEARTRIP',
  DIRECT_WEBSITE: 'DIRECT WEBSITE',
  OTHERS: 'OTHERS',
};

/**
 * Stored source -> report bucket. Exhaustive by type.
 *
 * `FRONT_DESK`, `PHONE`, `CORPORATE` and `TRAVEL_AGENT` fold into `OTHERS`
 * because the report's axis is sales channel, and none of them is one — a
 * front-desk booking is a booking the hotel took itself, which is what
 * `WALK_IN` already says when the guest was standing there. `OTA` folds in too:
 * it means "an OTA we have not named", so it cannot be charged to Agoda or
 * Booking.com without inventing attribution.
 */
export const BOOKING_SOURCE_BUCKET: Record<BookingSource, BookingSourceKey> = {
  WALK_IN: 'WALK_IN',
  MAKEMYTRIP: 'MAKEMYTRIP',
  AGODA: 'AGODA',
  BOOKING_COM: 'BOOKING_COM',
  EXPEDIA: 'EXPEDIA',
  CLEARTRIP: 'CLEARTRIP',
  DIRECT_WEB: 'DIRECT_WEBSITE',
  FRONT_DESK: 'OTHERS',
  PHONE: 'OTHERS',
  OTA: 'OTHERS',
  CORPORATE: 'OTHERS',
  TRAVEL_AGENT: 'OTHERS',
};

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
  ROLE_NAME_TAKEN: 'ROLE_NAME_TAKEN',
  ROLE_IMMUTABLE: 'ROLE_IMMUTABLE',

  /* -- Authentication ---------------------------------------------------- */

  /**
   * Returned for a wrong password *and* for an address with no account. The
   * two are deliberately indistinguishable: a distinct "no such user" code
   * turns the login form into an account-enumeration oracle.
   */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  /** The second factor is outstanding; finish it at /auth/verify-otp. */
  TWO_FACTOR_REQUIRED: 'TWO_FACTOR_REQUIRED',
  /** Unknown, already-used, or superseded challenge id. */
  OTP_CHALLENGE_NOT_FOUND: 'OTP_CHALLENGE_NOT_FOUND',
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  /** Too many wrong codes. The challenge is burned; sign in again. */
  OTP_ATTEMPTS_EXCEEDED: 'OTP_ATTEMPTS_EXCEEDED',
  OTP_RESEND_TOO_SOON: 'OTP_RESEND_TOO_SOON',
  OTP_RESEND_LIMIT: 'OTP_RESEND_LIMIT',
  /** The code could not be mailed. No challenge is left behind. */
  OTP_DELIVERY_FAILED: 'OTP_DELIVERY_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',

  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
