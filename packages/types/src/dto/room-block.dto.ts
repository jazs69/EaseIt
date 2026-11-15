/**
 * The wire contract for room blocks.
 *
 * ===========================================================================
 * SHIPPED AHEAD OF ITS ENDPOINTS, deliberately. The block endpoints belong to
 * a later increment that is blocked on a measured transaction timeout; these
 * schemas and the pure policy beside them land first so their shapes are
 * unit-tested before any writer consumes them.
 *
 * `throughDate` IS INCLUSIVE HERE and exclusive in the database. An operator
 * asked to block "10th to 15th" means six nights, and `room_block.throughDate`
 * stores the 16th so that `daterange(from, through, '[)')` lines up with
 * `reservation_room.departureDate` and the exclusion constraints. The
 * conversion happens exactly once, in `room-block.policy.ts`, which is the
 * only place that knows both representations.
 *
 * NO DATE FLOOR IS VALIDATED. There is no authoritative, advancing property
 * business date in this system -- `property.businessDate` exists but no
 * running code moves it -- so nothing here restricts past dates, and nothing
 * here may claim to. See limitation C1.
 * ===========================================================================
 */

import { z } from 'zod';

import { businessDateSchema } from '../domain.js';

export const RoomBlockReason = {
  MAINTENANCE: 'MAINTENANCE',
  OWNER_USE: 'OWNER_USE',
  TEMPORARY_CLOSURE: 'TEMPORARY_CLOSURE',
  DEEP_CLEAN: 'DEEP_CLEAN',
  RENOVATION: 'RENOVATION',
  OTHER: 'OTHER',
} as const;

export type RoomBlockReason = (typeof RoomBlockReason)[keyof typeof RoomBlockReason];

export const roomBlockReasonSchema = z.enum(RoomBlockReason);

export const ROOM_BLOCK_REASON_LABELS: Record<RoomBlockReason, string> = {
  MAINTENANCE: 'Maintenance',
  OWNER_USE: 'Owner use',
  TEMPORARY_CLOSURE: 'Temporary closure',
  DEEP_CLEAN: 'Deep clean',
  RENOVATION: 'Renovation',
  OTHER: 'Other',
};

export const RoomBlockStatus = {
  ACTIVE: 'ACTIVE',
  RELEASED: 'RELEASED',
} as const;

export type RoomBlockStatus = (typeof RoomBlockStatus)[keyof typeof RoomBlockStatus];

export const roomBlockStatusSchema = z.enum(RoomBlockStatus);

/* -------------------------------------------------------------------------- */
/*  POST /properties/:hotelId/room-blocks                                     */
/* -------------------------------------------------------------------------- */

/**
 * Exactly one of `roomId` or `rooms`.
 *
 * `roomId` set means one named physical room, contributing 1 to
 * `inventory_day.blocked` per night. `rooms` set means a count of the category
 * with no room named, contributing that many. Allowing both would make the
 * contribution ambiguous, which is the one thing the blocked-counter model
 * cannot tolerate.
 */
export const createRoomBlockRequestSchema = z
  .object({
    roomTypeId: z.string().uuid(),
    roomId: z.string().uuid().optional(),
    rooms: z.number().int().min(1).max(200).optional(),
    fromDate: businessDateSchema,
    /** INCLUSIVE at this boundary. Converted once, in the policy module. */
    throughDate: businessDateSchema,
    reason: roomBlockReasonSchema,
    note: z.string().trim().max(500).optional(),
  })
  .refine((value) => (value.roomId === undefined) !== (value.rooms === undefined), {
    message: 'Supply either roomId (one specific room) or rooms (a count), never both.',
    path: ['roomId'],
  })
  .refine((value) => value.throughDate >= value.fromDate, {
    message: 'The last night cannot fall before the first.',
    path: ['throughDate'],
  });

export type CreateRoomBlockRequest = z.infer<typeof createRoomBlockRequestSchema>;

export const roomBlockSchema = z.object({
  id: z.string().uuid(),
  roomTypeId: z.string().uuid(),
  roomTypeCode: z.string(),
  roomTypeName: z.string(),
  /** Null for a category block. */
  roomId: z.string().uuid().nullable(),
  roomNumber: z.string().nullable(),
  /** Units withheld per night. Always 1 for a specific-room block. */
  rooms: z.number().int().positive(),
  fromDate: businessDateSchema,
  /** INCLUSIVE on the way out too, so it round-trips with the request. */
  throughDate: businessDateSchema,
  /** Nights covered: `throughDate - fromDate + 1`. */
  nightCount: z.number().int().positive(),
  reason: roomBlockReasonSchema,
  note: z.string().nullable(),
  status: roomBlockStatusSchema,
  createdByUserId: z.string().uuid(),
  releasedByUserId: z.string().uuid().nullable(),
  releasedAt: z.string().nullable(),
});

export type RoomBlockView = z.infer<typeof roomBlockSchema>;

export const roomBlockListResponseSchema = z.object({
  items: z.array(roomBlockSchema),
  nextCursor: z.string().nullable(),
});

export type RoomBlockListResponse = z.infer<typeof roomBlockListResponseSchema>;

/**
 * One active specific-room block overlapping one live assignment.
 *
 * The detection path for the accepted race (limitation F1): a specific-room
 * block and a concurrent assignment share no lock, so both can commit. This
 * is how the collision is found afterwards and handed to a clerk, who resolves
 * it with an ordinary room move.
 *
 * Carries the confirmation code and the dates, and NO guest name, phone,
 * email or identity document -- section 5 keeps guest PII out of responses and
 * logs, and a confirmation code is what a clerk needs to act.
 */
export const roomBlockConflictSchema = z.object({
  blockId: z.string().uuid(),
  roomId: z.string().uuid(),
  roomNumber: z.string(),
  blockFromDate: businessDateSchema,
  blockThroughDate: businessDateSchema,
  reason: roomBlockReasonSchema,
  reservationId: z.string().uuid(),
  confirmationCode: z.string(),
  arrivalDate: businessDateSchema,
  departureDate: businessDateSchema,
  reservationStatus: z.string(),
});

export type RoomBlockConflict = z.infer<typeof roomBlockConflictSchema>;

export const roomBlockConflictResponseSchema = z.object({
  items: z.array(roomBlockConflictSchema),
});

export type RoomBlockConflictResponse = z.infer<typeof roomBlockConflictResponseSchema>;
