/**
 * Moving a stay between rooms, and assigning an unassigned one.
 *
 * ===========================================================================
 * One operation, three shapes.
 *
 * Assigning a room to an unassigned booking, moving a confirmed booking from
 * one room to another, and relocating an in-house guest are the same write:
 * `reservation_room.roomId` changes. Splitting them into three endpoints would
 * split the exclusion constraint's retry handling and the room-status
 * bookkeeping three ways too, and one of the three would drift.
 *
 * What differs is only the *consequences*, and they are decided server-side:
 * an in-house move has to vacate the room behind the guest, and a move across
 * room categories has to move the inventory counter with it.
 * ===========================================================================
 */

import { z } from 'zod';

import { businessDateSchema, propertyIdSchema, roomIdSchema } from '../domain.js';

export const moveRoomSchema = z.object({
  /**
   * Where the stay is going. `null` returns it to the unassigned queue.
   *
   * Unassigning is a real front-desk action — a room goes out of order and the
   * booking has to wait for a reallocation — so it is the same endpoint rather
   * than a separate "unassign" one that would duplicate the bookkeeping.
   */
  roomId: roomIdSchema.nullable(),

  /**
   * Required when the target room is a different category.
   *
   * A cross-category move is not a reassignment, it is a re-sale: the
   * inventory counter for the old category has to come down and the new one go
   * up, under the oversell CHECK (CLAUDE.md section 3.1). An operator doing
   * that on purpose — an upgrade, a maintenance relocation — says so; one
   * doing it by misreading a dropdown gets stopped.
   */
  acknowledgeCategoryChange: z.boolean().default(false),

  reason: z.string().trim().max(200).nullable().default(null),
});

export type MoveRoomCommand = z.infer<typeof moveRoomSchema>;

/** A room the stay could move into. */
export const moveCandidateSchema = z.object({
  id: roomIdSchema,
  number: z.string(),
  roomTypeId: z.uuid(),
  roomTypeName: z.string(),
  housekeepingStatus: z.string(),
  isClean: z.boolean(),
  /** True when this room is not the stay's booked category. */
  isCategoryChange: z.boolean(),
  /**
   * Free for every night of the stay.
   *
   * Advisory, like an availability quote: the exclusion constraint is what
   * actually guarantees it, and it holds under concurrency where this read
   * cannot. What this buys is a clear answer before the clerk commits.
   */
  isFree: z.boolean(),
});

export type MoveCandidate = z.infer<typeof moveCandidateSchema>;

export const moveRoomOptionsSchema = z.object({
  reservationId: z.uuid(),
  propertyId: propertyIdSchema,
  bookingCode: z.string(),
  guestName: z.string(),
  status: z.string(),
  arrivalDate: businessDateSchema,
  departureDate: businessDateSchema,
  nights: z.number().int().positive(),

  bookedRoomTypeId: z.uuid(),
  bookedRoomTypeName: z.string(),
  currentRoomId: roomIdSchema.nullable(),
  currentRoomNumber: z.string().nullable(),

  /** Every room that could take this stay, same category first. */
  candidates: z.array(moveCandidateSchema),
});

export type MoveRoomOptions = z.infer<typeof moveRoomOptionsSchema>;

export const moveRoomResultSchema = z.object({
  reservationId: z.uuid(),
  fromRoomNumber: z.string().nullable(),
  toRoomNumber: z.string().nullable(),
  categoryChanged: z.boolean(),
  movedAt: z.iso.datetime({ offset: true }),
});

export type MoveRoomResult = z.infer<typeof moveRoomResultSchema>;
