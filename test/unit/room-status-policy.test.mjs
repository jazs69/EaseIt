/**
 * Unit tests for the room-status transition policy.
 *
 * ===========================================================================
 * WHAT THIS CAN AND CANNOT PROVE.
 *
 * `room-status.policy.ts` is a pure module, so the full 7x7 transition matrix
 * is asserted directly against the real implementation rather than against a
 * restatement of it. That covers every rule the policy owns:
 *
 *   * the five settable targets, and that OUT_OF_SERVICE and OUT_OF_ORDER are
 *     not among them;
 *   * OUT_OF_SERVICE as a legal SOURCE but never a target;
 *   * OUT_OF_ORDER frozen in both directions;
 *   * the occupied/vacant boundary, refused both ways.
 *
 * NOT PROVED HERE, and not claimable from a green run: that the HTTP endpoint
 * returns 400 with these messages, that the live CHECKED_IN assignment check
 * actually runs, that a cross-property room is 404, or that the `room` row is
 * written. All four need a live API and database and belong to the integration
 * suite listed as unrun in the accompanying report.
 * ===========================================================================
 */

import { readFileSync } from 'node:fs';

import {
  OCCUPIED_STATUSES,
  ROOM_STATUSES,
  SETTABLE_STATUSES,
  VACANT_STATUSES,
  evaluateStatusTransition,
  targetAssertsOccupancy,
} from '../../apps/api/src/modules/inventory/room-status.policy.ts';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const allowed = (from, to) => evaluateStatusTransition(from, to).allowed === true;
const refusalKind = (from, to) => {
  const verdict = evaluateStatusTransition(from, to);
  return verdict.allowed ? null : verdict.refusal.kind;
};

console.log('\n════ room status policy ════\n');

/* ------------------------------------------------------------------ 1 */
console.log('1. The settable set.');
{
  check(
    'exactly five statuses are settable',
    SETTABLE_STATUSES.length === 5,
    SETTABLE_STATUSES.join(','),
  );
  check(
    'OUT_OF_SERVICE is NOT settable — it is counted as stock yet blocks check-in',
    !SETTABLE_STATUSES.includes('OUT_OF_SERVICE'),
  );
  check(
    'OUT_OF_ORDER is NOT settable — the only status that changes physical eligibility',
    !SETTABLE_STATUSES.includes('OUT_OF_ORDER'),
  );
  check(
    'every settable status is a real RoomStatus value',
    SETTABLE_STATUSES.every((status) => ROOM_STATUSES.includes(status)),
  );
  check(
    'the occupancy classes partition the five settable statuses',
    SETTABLE_STATUSES.every(
      (status) => OCCUPIED_STATUSES.includes(status) !== VACANT_STATUSES.includes(status),
    ),
    'each is occupied XOR vacant',
  );
}

/* ------------------------------------------------------------------ 2 */
console.log('\n2. The full 7x7 matrix.');
{
  // The approved table. Rows are current, columns requested; `true` means the
  // policy must allow it. Written out in full rather than derived, so a change
  // to the policy fails here instead of agreeing with itself.
  const EXPECTED = {
    VACANT_DIRTY: { VACANT_CLEAN: true, INSPECTED: true },
    VACANT_CLEAN: { VACANT_DIRTY: true, INSPECTED: true },
    INSPECTED: { VACANT_DIRTY: true, VACANT_CLEAN: true },
    OUT_OF_SERVICE: { VACANT_DIRTY: true, VACANT_CLEAN: true, INSPECTED: true },
    OCCUPIED_CLEAN: { OCCUPIED_DIRTY: true },
    OCCUPIED_DIRTY: { OCCUPIED_CLEAN: true },
    OUT_OF_ORDER: {},
  };

  let cells = 0;
  let wrong = 0;
  for (const from of ROOM_STATUSES) {
    for (const to of ROOM_STATUSES) {
      if (from === to) continue;
      cells += 1;
      const expected = EXPECTED[from]?.[to] === true;
      if (allowed(from, to) !== expected) {
        wrong += 1;
        console.error(`        ${from} -> ${to}: expected ${expected}, got ${!expected}`);
      }
    }
  }

  check(
    'every off-diagonal cell matches the approved matrix',
    wrong === 0,
    `${String(cells)} transitions checked, ${String(wrong)} wrong`,
  );
  check('42 off-diagonal cells were actually exercised', cells === 42, String(cells));
}

/* ------------------------------------------------------------------ 3 */
console.log('\n3. OUT_OF_SERVICE is a source, never a target.');
{
  check(
    'no status may transition INTO OUT_OF_SERVICE',
    ROOM_STATUSES.filter((from) => from !== 'OUT_OF_SERVICE').every(
      (from) => refusalKind(from, 'OUT_OF_SERVICE') !== null,
    ),
  );
  check(
    'and the refusal says the target is not settable, not that the source is wrong',
    refusalKind('VACANT_CLEAN', 'OUT_OF_SERVICE') === 'TARGET_NOT_SETTABLE',
    String(refusalKind('VACANT_CLEAN', 'OUT_OF_SERVICE')),
  );
  check(
    'an existing OUT_OF_SERVICE room may return to any vacant state',
    VACANT_STATUSES.every((to) => allowed('OUT_OF_SERVICE', to)),
    VACANT_STATUSES.join(','),
  );
  check(
    'but not straight into an occupied state',
    OCCUPIED_STATUSES.every((to) => refusalKind('OUT_OF_SERVICE', to) === 'CROSSES_INTO_OCCUPIED'),
  );
}

/* ------------------------------------------------------------------ 4 */
console.log('\n4. OUT_OF_ORDER is frozen in both directions.');
{
  check(
    'nothing may transition INTO OUT_OF_ORDER',
    ROOM_STATUSES.filter((from) => from !== 'OUT_OF_ORDER').every(
      (from) => refusalKind(from, 'OUT_OF_ORDER') === 'TARGET_NOT_SETTABLE',
    ),
  );
  check(
    'and an OUT_OF_ORDER room may not transition out — it would raise physical',
    ROOM_STATUSES.filter((to) => to !== 'OUT_OF_ORDER').every(
      (to) => refusalKind('OUT_OF_ORDER', to) !== null,
    ),
  );
  check(
    'the refusal for a settable target names the frozen SOURCE',
    refusalKind('OUT_OF_ORDER', 'VACANT_CLEAN') === 'SOURCE_FROZEN',
    String(refusalKind('OUT_OF_ORDER', 'VACANT_CLEAN')),
  );
}

/* ------------------------------------------------------------------ 5 */
console.log('\n5. The occupied/vacant boundary.');
{
  check(
    'vacant -> occupied is refused: occupancy is set by check-in',
    VACANT_STATUSES.every((from) =>
      OCCUPIED_STATUSES.every((to) => refusalKind(from, to) === 'CROSSES_INTO_OCCUPIED'),
    ),
  );
  check(
    'occupied -> vacant is refused: that is check-out or a room move',
    OCCUPIED_STATUSES.every((from) =>
      VACANT_STATUSES.every((to) => refusalKind(from, to) === 'CROSSES_OUT_OF_OCCUPIED'),
    ),
  );
  check(
    'cleanliness within the occupied class is allowed — stayover servicing',
    allowed('OCCUPIED_DIRTY', 'OCCUPIED_CLEAN') && allowed('OCCUPIED_CLEAN', 'OCCUPIED_DIRTY'),
  );
  check(
    'a no-op transition is refused rather than silently accepted',
    ROOM_STATUSES.every((status) => refusalKind(status, status) !== null),
  );
  check(
    'NO_CHANGE is the reason for a settable no-op',
    refusalKind('VACANT_CLEAN', 'VACANT_CLEAN') === 'NO_CHANGE',
    String(refusalKind('VACANT_CLEAN', 'VACANT_CLEAN')),
  );
}

/* ------------------------------------------------------------------ 6 */
console.log('\n6. The occupancy assertion the service branches on.');
{
  check(
    'only occupied targets assert that a guest is present',
    OCCUPIED_STATUSES.every((status) => targetAssertsOccupancy(status)),
  );
  check(
    'no vacant or service target does',
    [...VACANT_STATUSES, 'OUT_OF_SERVICE', 'OUT_OF_ORDER'].every(
      (status) => !targetAssertsOccupancy(status),
    ),
  );
}

/* ------------------------------------------------------------------ 7 */
console.log('\n7. The DTO and the policy agree on what is settable.');
{
  // The two lists are maintained separately on purpose -- the DTO is the wire
  // contract and the policy must be importable from a .mjs test without the
  // types package -- so something has to assert they have not drifted.
  const dto = readFileSyncUtf8('packages/types/src/dto/room.dto.ts');
  const inEnum = /settableRoomStatusSchema = z\.enum\(\[([\s\S]*?)\]\)/.exec(dto)?.[1] ?? '';
  const dtoStatuses = [...inEnum.matchAll(/RoomStatus\.([A-Z_]+)/g)].map((match) => match[1]);

  check(
    'settableRoomStatusSchema lists exactly the policy’s settable statuses',
    dtoStatuses.length === SETTABLE_STATUSES.length &&
      dtoStatuses.every((status) => SETTABLE_STATUSES.includes(status)),
    `dto=[${dtoStatuses.join(',')}] policy=[${SETTABLE_STATUSES.join(',')}]`,
  );
}

/** Read a repository-relative file, resolved from this test's own location. */
function readFileSyncUtf8(relative) {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
}

console.log('');
if (failures > 0) {
  console.error(`${String(failures)} room status policy check(s) failed.`);
  process.exit(1);
}
console.log('All room status policy checks passed.');
