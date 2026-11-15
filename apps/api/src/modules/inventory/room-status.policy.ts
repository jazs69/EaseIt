/**
 * Which housekeeping status changes the room-status endpoint may make.
 *
 * ===========================================================================
 * A PURE MODULE, with no relative imports and no Nest decorators, so a `.mjs`
 * unit test can import it directly -- the same shape as
 * `inventory-horizon.policy.ts`.
 *
 * WHY A MATRIX AT ALL, when the DTO already limits the target.
 *
 * Room occupancy is written by the reservation lifecycle and nowhere else:
 * `check-in-posting.ts` sets OCCUPIED_*, `check-out.service.ts` sets
 * VACANT_DIRTY, and `room-move.service.ts` sets both as a guest moves. If this
 * endpoint could cross the occupied/vacant boundary, `room.status` and
 * `reservation_room` would disagree about whether anyone is in the room -- and
 * check-in reads exactly that field to decide whether it may proceed. So the
 * boundary is the rule, and the matrix is how it is stated.
 *
 * TWO STATUSES ARE EXCLUDED AS TARGETS, for different reasons.
 *
 *   OUT_OF_ORDER is the only status that changes physical eligibility:
 *   inventory generation counts every room whose status is not OUT_OF_ORDER.
 *   Setting it would make every already-created night's `physical` wrong, and
 *   correcting that needs the forward-only recompute, which is deferred.
 *
 *   OUT_OF_SERVICE is counted as physical stock, stays sellable and stays
 *   assignable, yet blocks check-in. A room put there can be sold and then
 *   refused at the desk. Rooms are withheld with a room block instead. It
 *   remains a legal SOURCE -- a room already in that state must be able to
 *   come back -- but never a target.
 *
 * THE MATRIX IS NOT THE AUTHORITY. It is a cheap pre-check over the stored
 * status, which can itself be stale. The service additionally requires a live
 * CHECKED_IN `reservation_room` row before setting OCCUPIED_*, and its absence
 * before setting a vacant state. Data decides; this table explains.
 * ===========================================================================
 */

/** Every value of the `RoomStatus` enum, as the database spells it. */
export const ROOM_STATUSES = [
  'VACANT_CLEAN',
  'VACANT_DIRTY',
  'INSPECTED',
  'OCCUPIED_CLEAN',
  'OCCUPIED_DIRTY',
  'OUT_OF_SERVICE',
  'OUT_OF_ORDER',
] as const;

export type RoomStatusValue = (typeof ROOM_STATUSES)[number];

/** Somebody is in the room. Mirrors `OCCUPIED_ROOM_STATES` in check-in-posting. */
export const OCCUPIED_STATUSES: readonly RoomStatusValue[] = ['OCCUPIED_CLEAN', 'OCCUPIED_DIRTY'];

/** Nobody is in the room and it is not withheld. */
export const VACANT_STATUSES: readonly RoomStatusValue[] = [
  'VACANT_CLEAN',
  'VACANT_DIRTY',
  'INSPECTED',
];

/**
 * Targets this endpoint may set. Mirrors `settableRoomStatusSchema`.
 *
 * Kept here as well as in the DTO so the matrix can be reasoned about -- and
 * unit-tested -- without importing the types package into a `.mjs` test. A
 * test asserts the two lists agree.
 */
export const SETTABLE_STATUSES: readonly RoomStatusValue[] = [
  'VACANT_CLEAN',
  'VACANT_DIRTY',
  'INSPECTED',
  'OCCUPIED_CLEAN',
  'OCCUPIED_DIRTY',
];

/** Why a transition was refused. Discriminated so the service can map each. */
export type StatusRefusal =
  | { kind: 'TARGET_NOT_SETTABLE'; target: RoomStatusValue }
  | { kind: 'SOURCE_FROZEN'; current: RoomStatusValue }
  | { kind: 'CROSSES_INTO_OCCUPIED' }
  | { kind: 'CROSSES_OUT_OF_OCCUPIED' }
  | { kind: 'NO_CHANGE' };

/**
 * Whether this transition is permitted, and why not when it is not.
 *
 * Expected-and-recoverable is a result, not an exception (section 5): this
 * returns a reason and never throws. The service turns a refusal into the
 * typed error with the message that names the supported path.
 */
export function evaluateStatusTransition(
  current: RoomStatusValue,
  target: RoomStatusValue,
): { allowed: true } | { allowed: false; refusal: StatusRefusal } {
  if (!SETTABLE_STATUSES.includes(target)) {
    return { allowed: false, refusal: { kind: 'TARGET_NOT_SETTABLE', target } };
  }

  // OUT_OF_ORDER is frozen in both directions: leaving it would raise
  // `physical` on every existing night just as entering it would lower it.
  if (current === 'OUT_OF_ORDER') {
    return { allowed: false, refusal: { kind: 'SOURCE_FROZEN', current } };
  }

  if (current === target) {
    return { allowed: false, refusal: { kind: 'NO_CHANGE' } };
  }

  const currentOccupied = OCCUPIED_STATUSES.includes(current);
  const targetOccupied = OCCUPIED_STATUSES.includes(target);

  if (!currentOccupied && targetOccupied) {
    return { allowed: false, refusal: { kind: 'CROSSES_INTO_OCCUPIED' } };
  }
  if (currentOccupied && !targetOccupied) {
    return { allowed: false, refusal: { kind: 'CROSSES_OUT_OF_OCCUPIED' } };
  }

  // Remaining cases are cleanliness changes within one occupancy class, plus
  // the one-way exit from OUT_OF_SERVICE into any vacant state.
  return { allowed: true };
}

/**
 * Whether the target asserts that a guest is in the room.
 *
 * The service uses this to decide which way to apply the live-assignment
 * check, so the rule lives in one place rather than being re-derived at the
 * call site.
 */
export function targetAssertsOccupancy(target: RoomStatusValue): boolean {
  return OCCUPIED_STATUSES.includes(target);
}
