# Business Rules (Phase 4)

**Status:** Not started. Scaffold only.
**Blocked on:** Tier-1 unknowns U-001 to U-006 in 09-unknowns-and-open-questions.md. These are sync semantics that are not observable from outside a running system, so this file should be written from OTA partner protocol documentation (Phase 5) rather than from Stayflexi material.

## Intended contents

Evidence-backed rules for: inventory ownership; mapping cardinality and constraints; sync direction and conflict resolution; reservation lifecycle and external identifiers; retry/timeout/duplicate-event/reconciliation policy; permissions; audit; concurrency.

## What is already settled in this repository

Two rules do not need researching, because they are built and tested here:

- **Pooled inventory with a hard oversell floor.** `inventory_day` holds one counter per
  `(propertyId, roomTypeId, stayDate)` under
  `CHECK (sold + blocked <= physical + overbookingAllowance)`. This matches the pooling
  Stayflexi claims (`CM-B-001`) and is proven by `test/concurrency/parallel-booking.test.mjs`.
- **No two stays in one physical room.** `reservation_room_no_overlap` is a GiST exclusion
  constraint on `(room_id, daterange)`.

The open question is not how to hold inventory correctly. It is how to **publish** it
outward idempotently, and how to reconcile when a channel disagrees.
