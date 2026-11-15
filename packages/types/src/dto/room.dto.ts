/**
 * The wire contract for physical rooms and their housekeeping status.
 *
 * ===========================================================================
 * TWO ENDPOINTS, TWO PERMISSIONS, ON PURPOSE.
 *
 * `PATCH /rooms/:roomId` is configuration (`rooms:manage`) and REFUSES
 * `status` and `roomTypeId` in its body. `POST /rooms/:roomId/status` is
 * housekeeping work (`housekeeping:update_status`) and writes nothing else.
 * Collapsing them would force configuration rights on anyone who may mark a
 * room clean.
 *
 * `roomTypeId` is absent from the update because reclassifying a room moves
 * capacity between two `inventory_day` counters while existing
 * `reservation_room` rows still name the old category -- it needs the
 * forward-only recompute that is deferred, so it is not offered at all rather
 * than offered and half-correct.
 *
 * NO AVAILABILITY IS REPORTED HERE. There is no `isBlocked`, `isAvailable` or
 * `isBookable` field. Whether a room is withheld from sale lives in
 * `room_block`, which has no read endpoint in this increment -- and a field
 * that was always `false` would read as "not blocked" rather than as "unknown".
 * ===========================================================================
 */

import { z } from 'zod';

import { RoomStatus, roomStatusSchema } from '../domain.js';

/** "101". Unique within the property, not globally. */
export const roomNumberSchema = z
  .string()
  .trim()
  .min(1, 'Give the room a number.')
  .max(16, 'A room number may be at most 16 characters.');

export const createRoomRequestSchema = z.object({
  roomTypeId: z.string().uuid(),
  number: roomNumberSchema,
  floor: z.string().trim().max(16).optional(),
  notes: z.string().trim().max(500).optional(),
});

export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;

/**
 * Configuration only.
 *
 * `status` is absent because it belongs to the housekeeping endpoint, and
 * `roomTypeId` because reclassification is deferred. A request carrying
 * either is a client that believes it can do something this endpoint will not
 * do, so both are rejected rather than ignored -- see
 * `rejectedRoomUpdateKeys`.
 */
export const updateRoomRequestSchema = z
  .object({
    number: roomNumberSchema.optional(),
    floor: z.string().trim().max(16).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Supply at least one field to change.',
  });

export type UpdateRoomRequest = z.infer<typeof updateRoomRequestSchema>;

/**
 * Body keys the update endpoint refuses outright, with the reason.
 *
 * Zod strips unknown keys by default, which would silently discard a
 * `status` a caller believed it had set. These are checked explicitly so the
 * caller is told where the field actually belongs.
 */
export const rejectedRoomUpdateKeys: Readonly<Record<string, string>> = {
  status: 'Room status is changed through the room-status endpoint, not here.',
  roomTypeId: 'Changing a room’s category is not supported yet.',
  propertyId: 'The property comes from the authenticated session.',
  id: 'Server-owned.',
};

/* -------------------------------------------------------------------------- */
/*  POST /properties/:hotelId/rooms/:roomId/status                            */
/* -------------------------------------------------------------------------- */

/**
 * The statuses this endpoint may SET. Five of the enum's seven.
 *
 * `OUT_OF_ORDER` is absent because it is the only status that changes physical
 * eligibility -- inventory generation counts every room whose status is not
 * `OUT_OF_ORDER` -- so setting it would overstate or understate capacity on
 * every already-created night, which needs the deferred recompute.
 *
 * `OUT_OF_SERVICE` is absent for a different and more awkward reason: it is
 * counted as physical stock, remains sellable and remains assignable, yet
 * blocks check-in. A room put there can therefore be sold and then refused at
 * the desk on arrival. Rooms are made unavailable with a room block instead,
 * which reduces capacity correctly. Existing `OUT_OF_SERVICE` rooms may still
 * transition OUT of it -- it is a source, never a target.
 */
export const settableRoomStatusSchema = z.enum([
  RoomStatus.VACANT_CLEAN,
  RoomStatus.VACANT_DIRTY,
  RoomStatus.INSPECTED,
  RoomStatus.OCCUPIED_CLEAN,
  RoomStatus.OCCUPIED_DIRTY,
]);

export type SettableRoomStatus = z.infer<typeof settableRoomStatusSchema>;

export const changeRoomStatusRequestSchema = z.object({
  status: settableRoomStatusSchema,
  note: z.string().trim().max(500).optional(),
});

export type ChangeRoomStatusRequest = z.infer<typeof changeRoomStatusRequestSchema>;

/* -------------------------------------------------------------------------- */
/*  Responses                                                                 */
/* -------------------------------------------------------------------------- */

export const roomSchema = z.object({
  id: z.string().uuid(),
  number: z.string(),
  floor: z.string().nullable(),
  roomTypeId: z.string().uuid(),
  roomTypeCode: z.string(),
  roomTypeName: z.string(),
  /** The full enum, including the two values that cannot be set here. */
  status: roomStatusSchema,
  notes: z.string().nullable(),
});

export type RoomView = z.infer<typeof roomSchema>;

/**
 * Cursor-paginated: a 200-room property is small, but §5 requires cursor
 * pagination for anything that grows unbounded, and room lists do.
 */
export const roomListResponseSchema = z.object({
  items: z.array(roomSchema),
  nextCursor: z.string().nullable(),
});

export type RoomListResponse = z.infer<typeof roomListResponseSchema>;

export const roomListQuerySchema = z.object({
  roomTypeId: z.string().uuid().optional(),
  status: roomStatusSchema.optional(),
  floor: z.string().trim().max(16).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export type RoomListQuery = z.infer<typeof roomListQuerySchema>;
