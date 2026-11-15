/**
 * The wire contract for room-type configuration.
 *
 * ===========================================================================
 * A room type is a sellable category: "Deluxe King". It owns the rack rate,
 * the occupancy limits, and the identity every `inventory_day` row, rate and
 * reservation points at.
 *
 * `overbookingAllowance` is DELIBERATELY ABSENT from both the request and the
 * response, even though the column exists on `room_type`. Nothing reads that
 * column at runtime -- sellability comes from `inventory_day.overbookingAllowance`
 * (`create-reservation.service.ts`), which is the single source of truth per
 * stay date. Exposing the room-type field would create a second, ambiguous
 * one, and would let a holder of `rooms:manage` set oversell headroom without
 * `inventory:override` -- the permission that exists precisely because
 * overbooking must always be deliberate. Per-date allowance is changed through
 * the inventory allowance endpoint, nowhere else.
 *
 * Nothing server-owned crosses the wire inbound: no `propertyId` (it comes
 * from the authenticated grant and the `:hotelId` path parameter), no `id`,
 * no timestamps, no room counts (CLAUDE.md section 5).
 * ===========================================================================
 */

import { z } from 'zod';

import { moneySchema } from '../money.js';

/**
 * The operator-facing short code, e.g. `DLX`. Unique within the property.
 *
 * Uppercase alphanumerics with `-` and `_`: it appears in reports, on the
 * timeline and in channel mappings, so it has to survive being read aloud and
 * pasted into a spreadsheet.
 */
export const roomTypeCodeSchema = z
  .string()
  .trim()
  .min(1, 'Give the category a short code.')
  .max(16, 'A code may be at most 16 characters.')
  .regex(/^[A-Z0-9_-]+$/, 'Use uppercase letters, digits, hyphen or underscore only.');

/**
 * A rack rate: money that cannot be negative.
 *
 * ===========================================================================
 * `moneySchema` is deliberately signed and is NOT changed by this: a folio
 * line, a refund and a reversal are all legitimately negative, so a lower
 * bound belongs on the field that cannot be, never on the shared type.
 *
 * Without this, a negative `baseRateMinor` passed validation and was refused
 * by `room_type_rate_and_occupancy_sane` instead -- a CHECK violation, which
 * is not `P2002` and so was not translated at the repository boundary. The
 * caller got an opaque 500 for what is an ordinary typo. The database still
 * holds the line either way; this is about which layer answers, and with what.
 *
 * Zero is accepted on purpose. A complimentary or allowance-only category has
 * a rack rate of nothing, which is a real configuration rather than a mistake.
 * ===========================================================================
 */
export const rackRateSchema = moneySchema.refine((value) => value.amountMinor >= 0, {
  message: 'A rack rate cannot be negative.',
  path: ['amountMinor'],
});

export const createRoomTypeRequestSchema = z
  .object({
    code: roomTypeCodeSchema,
    name: z.string().trim().min(1, 'Give the category a name.').max(120),
    description: z.string().trim().max(2000).optional(),
    maxGuests: z.number().int().min(1).max(20),
    /** Optional sub-limit. Never above `maxGuests`. */
    maxAdults: z.number().int().min(1).max(20).optional(),
    /** Rack rate, as integer minor units plus an ISO-4217 currency. */
    baseRate: rackRateSchema,
    sortOrder: z.number().int().min(0).max(999).default(0),
  })
  .refine((value) => value.maxAdults === undefined || value.maxAdults <= value.maxGuests, {
    message: 'The adult limit cannot exceed the total guest limit.',
    path: ['maxAdults'],
  });

export type CreateRoomTypeRequest = z.infer<typeof createRoomTypeRequestSchema>;

/**
 * Everything except `code`.
 *
 * The code is the category's operator-facing identity: it is quoted in
 * reports, on the timeline and in channel mappings, so renaming it would
 * orphan every one of those references. A category that needs a different
 * code is a different category.
 */
export const updateRoomTypeRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    maxGuests: z.number().int().min(1).max(20).optional(),
    maxAdults: z.number().int().min(1).max(20).nullable().optional(),
    baseRate: rackRateSchema.optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Supply at least one field to change.',
  })
  .refine(
    (value) =>
      value.maxAdults === undefined ||
      value.maxAdults === null ||
      value.maxGuests === undefined ||
      value.maxAdults <= value.maxGuests,
    { message: 'The adult limit cannot exceed the total guest limit.', path: ['maxAdults'] },
  );

export type UpdateRoomTypeRequest = z.infer<typeof updateRoomTypeRequestSchema>;

export const roomTypeSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  maxGuests: z.number().int().positive(),
  maxAdults: z.number().int().positive().nullable(),
  baseRate: rackRateSchema,
  sortOrder: z.number().int().nonnegative(),
  /**
   * Physical rooms currently assigned to this category.
   *
   * A live count from the `room` table, NOT `inventory_day.physical`. The two
   * can legitimately disagree: `physical` is computed once when an inventory
   * row is created and is never recomputed, so a room added today does not
   * change capacity on nights that already exist. Reporting the live count
   * here and the configured figure on the calendar is what makes that visible
   * instead of silent (limitation L1).
   */
  roomCount: z.number().int().nonnegative(),
});

export type RoomTypeView = z.infer<typeof roomTypeSchema>;

export const roomTypeListResponseSchema = z.object({
  items: z.array(roomTypeSchema),
});

export type RoomTypeListResponse = z.infer<typeof roomTypeListResponseSchema>;
