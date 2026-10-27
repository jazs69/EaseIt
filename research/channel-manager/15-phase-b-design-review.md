# Phase B — Design Review and Correction

**Status:** design review. No application code, schema, migration, database or business data
was changed to produce it.
**Date:** 2026-10-26
**Reviews:** `14-phase-b-rateplan-and-sync-contract.md`
**Supersedes:** §D.3 and §C.4 of document 14 (see §0 below). Everything else in 14 stands
unless corrected here.
**⚠ Itself superseded on two points by `16-phase-b1-implementation-plan.md` and
`17-phase-b1-pre-implementation-checklist.md` (2026-10-27).** This document carries no such
notice elsewhere, and it is the *correcting* document, so a reader taking the newest word on each
point would otherwise take these as current:
1. **The archive rule.** This document states `isActive = false` ⟺ `archivedAt IS NOT NULL`,
   enforced by `rate_plan_archive_matches_active`. That biconditional is **replaced** by the
   one-directional `rate_plan_archived_implies_inactive`: archived ⇒ not sellable, but a plan may
   be inactive **without** being archived, which is the state every backfilled plan is in until
   an approved effective cancellation policy exists for its property — its own policy, or the
   separately defined fallback. See 16 §A.4 and §C.3b.
2. **`isRefundable`** appears in this document's rate-plan field list. The field is **removed from
   the design**: cancellation terms stay on `PropertyPolicy`. See 16 §C.3a and 17 §2.

Every claim is labelled:

| Label | Meaning |
|---|---|
| **[CODE]** | Verified in the working tree at this date. File and line given. |
| **[DESIGN]** | A proposal of mine. Not in the code. Arguable. |
| **[BUSINESS]** | Needs a product owner, not an engineer. |

---

## 0. What this review changes in document 14

Two corrections are material; the rest is specification that document 14 left as a single
line.

**Correction 1 — document 14 overstated the version check.** §D.3 said the handler
"discards the job as `SUPERSEDED` if `payload.version < appliedVersion`", and §D.6 leaned on
that for staleness safety. That is wrong in the way that matters: a check performed *before*
an outbound call cannot constrain what the call does afterwards. Worker A passes the check at
T1, stalls; Worker B pushes a newer state at T2 and the provider applies it; Worker A's
request lands at T3 and the provider applies **the older state**. Nothing local prevents
that. A local version check is a *filter that reduces* stale pushes, never a guarantee.
Corrected in §3.3.

**Correction 2 — the outbox payload must not be the frozen ARI state.** Document 14 enqueued
the full `days[]` array at produce time, which is what makes a late job carry stale numbers.
The row should instead record *that a scope is dirty*, and the handler should project the
state fresh, from the database, at send time. Corrected in §3.2. This changes no Phase A
code — `OutboxHandlerContext` already carries `{outboxEventId, propertyId, payload, attempt}`
[CODE: `apps/api/src/modules/platform/outbox/outbox-handler.registry.ts:13-20`] and a handler
is a Nest provider that can inject `PrismaService`.

Document 14's §D.2 claim of "ordered effect, not ordered delivery" survives, but only once
§3.4's per-scope lease exists. Without it the claim is not earned.

---

## 1. Inventory calendar lifecycle

Document 14 reduced this to one line ("stage B2"). It is the riskiest part of Phase B, because
it writes the table that guarantees no double booking.

### 1.1 What the code actually does today

| Fact | Evidence |
|---|---|
`inventory_day` rows are created **only** by seed scripts | [CODE] `createMany`/`deleteMany` appear in `packages/database/prisma/seed.ts` and `seed-portfolio.ts`; the application only ever runs `updateMany` |
Booking increments `sold` for every stay date | [CODE] `apps/api/src/modules/reservations/create-reservation.service.ts:298-306` |
A category change moves `sold` between two room types | [CODE] `apps/api/src/modules/reservations/room-move.service.ts:268-284` |
A missing row makes a stay unsellable, loudly | [CODE] `create-reservation.service.ts:276-283` raises `RoomUnavailableError` when `locked.length !== dates.length` |
Booking locks `FOR UPDATE … ORDER BY "stayDate" ASC` | [CODE] `create-reservation.service.ts:262-271` |
A room move locks `FOR UPDATE … ORDER BY "stayDate" ASC, "roomTypeId" ASC` for **both** room types | [CODE] `room-move.service.ts:259-266` |
The oversell CHECK is `sold + blocked <= physical + overbookingAllowance` | [CODE] `migrations/20261016140000_inventory_and_reservations/migration.sql:207` |
Uniqueness is `(propertyId, roomTypeId, stayDate)` | [CODE] `schema.prisma:755` |
**There is no cancellation write path.** `CANCELLED`/`NO_SHOW` appear only as read filters, check-in blockers and report columns | [CODE] searched all of `apps/api/src/modules`; no service sets `cancelledAt` or decrements `sold` for a cancellation |
`sold` is intended to count `CONFIRMED`, `CHECKED_IN`, `CHECKED_OUT` only | [CODE] `apps/api/src/modules/performance/performance.repository.ts:16-27` |
That intent currently holds **by construction**: create can only produce `CONFIRMED` or `CHECKED_IN` | [CODE] `create-reservation.service.ts:239-241`; `TENTATIVE`/`ON_HOLD` are unreachable from the API |

Deadlock analysis, checked rather than assumed: both writers order by `stayDate` first, so a
booking and a move competing for shared dates acquire them in the same sequence. The move's
secondary `roomTypeId` ordering is consistent with the booking's single-room-type lock set.
**No lock-order inversion exists between the two existing writers** [CODE]. Any new writer
must join that discipline, and §1.3 does.

### 1.2 Two pre-existing hazards the lifecycle must not amplify

**H-1 — `physical` is an uncomputed projection.** `InventoryDay.physical` is documented as
"Sellable rooms of this type on this date, excluding OUT_OF_ORDER" [CODE: `schema.prisma:745`],
but no application code recomputes it when a room is added, removed, or set `OUT_OF_ORDER`.
Only the seed does. So the number can be arbitrarily stale, and publishing availability
derived from it would broadcast that staleness to an OTA.

**H-2 — the room-move decrement is guarded, the increment is not.** The source-row update
carries `sold: { gt: 0 }` [CODE: `room-move.service.ts:273`], so if the source row's `sold`
were already 0 the decrement silently does nothing while the target increment still applies —
net +1 room sold. Today that state is unreachable because nothing resets `sold`. **It becomes
reachable the moment a rebuild touches `sold`**, which is why §1.3's first invariant exists.
I am not proposing to change that code in Phase B; I am proposing never to create the state
that makes it wrong.

### 1.3 Invariants [DESIGN]

These bind every inventory writer Phase B adds. Each is testable.

| # | Invariant |
|---|---|
**INV-1** | No Phase B code writes `sold`. Ever. `sold` is owned exclusively by the reservation lifecycle. A rebuild recomputes `physical`; it never touches `sold` or `blocked`. |
**INV-2** | `physical` is never set below `sold + blocked − overbookingAllowance`. The attempt is refused with a typed domain error *before* the write, and the CHECK is the backstop if the guard is ever bypassed. |
**INV-3** | Extension and rebuild are idempotent: running either twice changes nothing the second time. |
**INV-4** | Every lifecycle write locks `inventory_day` rows `FOR UPDATE ORDER BY "stayDate" ASC`, joining the existing discipline [CODE §1.1]. |
**INV-5** | A missing row is never silently created inside a booking transaction. Booking continues to fail loudly, as it does today. |
**INV-6** | Extension only ever adds dates **forward** of the property's `businessDate`. History is immutable. |
**INV-7** | A rebuild is bounded to an explicit `(roomTypeId, from, to)` scope. There is no "rebuild everything" entry point. |

### 1.4 Initialisation [DESIGN]

A room type's calendar is created when the room type is created, for
`[businessDate, businessDate + horizonDays)`. `horizonDays` is a new
`PropertySettings.inventoryHorizonDays` with a default of **450** — chosen, not invented: the
seed already builds from 1 January of last year to `INVENTORY_DAYS_FORWARD`
[CODE: `seed.ts:1319-1320`], and 450 days covers the 12–18 month booking window OTAs
typically expose. [BUSINESS: confirm the horizon.]

```sql
-- Idempotent by the existing unique constraint. No read-then-write, no race.
INSERT INTO inventory_day
  ("id","propertyId","roomTypeId","stayDate","physical","sold","blocked",
   "overbookingAllowance","createdAt","updatedAt")
SELECT gen_random_uuid(), $propertyId, $roomTypeId, d::date,
       $physical, 0, 0, rt."overbookingAllowance", now(), now()
FROM generate_series($from::date, $to::date, interval '1 day') AS d
JOIN room_type rt ON rt.id = $roomTypeId
ON CONFLICT ("propertyId","roomTypeId","stayDate") DO NOTHING;
```

`ON CONFLICT DO NOTHING` against `inventory_day_unique_per_date` is what makes this safe
under concurrency and re-runs: two extensions racing the same dates both succeed, and neither
overwrites a row that already carries `sold`. **It must be `DO NOTHING`, never `DO UPDATE`** —
an upsert here would be the exact mechanism that resets a counter.

### 1.5 Extension into the future [DESIGN]

A repeatable job per property, daily, at the property's night-audit hour
[CODE: `PropertySettings.nightAuditHour` exists, `schema.prisma:1263`], topping the calendar
back up to `businessDate + horizonDays` using the same statement. Idempotent, so a missed day
self-heals and a double run is harmless.

Because `nightaudit` does not exist as a module [CODE: `ls apps/api/src/modules/` — 14
modules, no `nightaudit`], this job is a BullMQ repeatable registered by the `rates` module,
with a comment that it folds into the audit's step list when that module lands. Duplicated
scheduling is the cost of the module not existing; it is stated, not hidden.

### 1.6 Missing-row handling [DESIGN]

Three cases, three different answers:

| Case | Behaviour |
|---|---|
Booking a date with no row | **Unchanged** — fail with `RoomUnavailableError` (INV-5). A booking must never auto-create inventory, because the row's `physical` would have to be invented inside a transaction holding locks |
Projecting ARI for a date with no row | Emit nothing for that date. A date we do not track is a date we must not describe to an OTA. The gap is reported (§4.4), not papered over |
Operator sees a gap | `POST rate-plans/../inventory:extend`-style repair, explicit and audited, using the §1.4 statement |

### 1.7 `physical` rebuild and repair [DESIGN]

Closes H-1. Scoped, explicit, audited, and **refusing** rather than clamping:

```
for each stayDate in [from, to):
  target  := count(Room WHERE roomTypeId = X AND status <> 'OUT_OF_ORDER')
  current := inventory_day row, locked FOR UPDATE, ordered by stayDate
  floor   := current.sold + current.blocked - current.overbookingAllowance
  if target < floor:  collect a conflict; do NOT write
  else:               SET physical = target
```

Conflicts are returned to the operator as a list of dates with their `sold`/`blocked`
figures. **A rebuild is all-or-nothing per scope**: if any date conflicts, the transaction
rolls back and nothing moves. Clamping `physical` up to `sold + blocked` instead would be the
textbook wrong fix — it invents capacity to make a constraint pass, which §6.2 forbids
outright.

`status <> 'OUT_OF_ORDER'` is taken from the documented intent [CODE: `schema.prisma:698-700`,
`Room.status` comment: "OUT_OF_ORDER rooms drop out of physical stock when inventory is
rebuilt; OUT_OF_SERVICE rooms stay counted"]. The rebuild implements that sentence literally.

### 1.8 Concurrency with the four existing mutators [DESIGN]

| Mutator | Interaction | Why it is safe |
|---|---|---|
**Reservation creation** | Rebuild holds `FOR UPDATE` on the same rows, same order | One waits. Rebuild reads `sold` under lock, so its floor is never stale. If a booking commits first, the floor rises and the rebuild may refuse — correct, and visible |
**Cancellation** | **Does not exist** [CODE §1.1] | Nothing to interact with *today*. When it lands it must decrement `sold` inside the same lock discipline, and it will lower the floor, never raise it — so it can only make a rebuild more likely to succeed. §4.5 records the ARI consequence |
**Room move (category change)** | Locks both room types' rows, `stayDate` then `roomTypeId` | Compatible ordering (§1.1). A rebuild scoped to one room type may interleave with a move touching it; both hold `FOR UPDATE`, so the move's net effect is applied before or after, never during |
**Inventory change (rooms added/removed/OOO)** | The rebuild *is* this path | Serialised by the same locks. Adding a room raises `target`; setting one `OUT_OF_ORDER` lowers it and may hit the floor, which refuses |

### 1.9 Transaction boundaries and partial failure [DESIGN]

- One `$transaction` per scope, with `set_config('app.current_property_id', …, true)` first,
  matching both existing writers [CODE: `create-reservation.service.ts:248`,
  `room-move.service.ts:248`].
- No HTTP, no Redis, no mail inside it (§3.1). Any ARI consequence is an outbox row written
  in the same transaction.
- Retry on `40001`/`23514`/`23P01` up to 3 times with jitter, reusing
  `isRetryableSqlState` [CODE: `apps/api/src/common/errors/sql-state.ts`], then surface a
  typed error.
- **Partial failure is impossible by construction**: a scope either commits whole or rolls
  back whole. A multi-scope operator request is executed as one transaction per scope, and
  the response lists per-scope outcomes rather than pretending to be atomic across scopes.

### 1.10 Acceptance criteria

| # | Criterion |
|---|---|
AC-1.1 | Extension run twice over the same range produces identical rows; second run reports 0 inserted |
AC-1.2 | Extension over a range where half the rows exist inserts only the missing half and alters no existing `sold`/`blocked`/`physical` |
AC-1.3 | Rebuild refuses, with the conflicting dates named, when `target < sold + blocked − overbookingAllowance`; **no row changes** |
AC-1.4 | Rebuild raises `physical` correctly after a room is added, and lowers it after a room is set `OUT_OF_ORDER`, where the floor permits |
AC-1.5 | N parallel extensions over identical ranges produce exactly one row per date (no unique violation surfaced to the caller) |
AC-1.6 | A booking committed mid-rebuild is never lost: final `sold` equals the pre-rebuild value plus the bookings committed |
AC-1.7 | `test:concurrency` passes **byte-identically** |
AC-1.8 | After any lifecycle operation, `SELECT count(*) FROM inventory_day WHERE sold + blocked > physical + "overbookingAllowance"` is 0 |
AC-1.9 | No lifecycle code path contains a write to `sold` or `blocked` (enforced by review and a grep-based test) |

---

## 2. Rate-plan domain — corrections and specification

Document 14 §B stands. These are the points it left underspecified.

### 2.1 Ownership and tenant safety [DESIGN]

`RatePlan` belongs to `(propertyId, roomTypeId)`; `RatePlanDay` belongs to
`(propertyId, ratePlanId, stayDate)`. Both carry a non-nullable `propertyId`, denormalised on
`RatePlanDay` so the tenant predicate never has to be reached through a join.

Tenant safety is *provable*, not conventional, via the composite FKs in document 14 §B.2 —
the pattern this repository already uses (6 `unique_pair` indexes and 11 composite FKs exist
live [CODE: verified in `pg_constraint`]). This matters more than usual because **neither
§3.2 backstop exists**: `createPrismaClient()` applies no tenancy extension
[CODE: `packages/database/src/client-factory.ts:70-76`] and the 14
`set_config('app.current_property_id')` calls are no-ops without RLS policies. The composite
FK is therefore the only *mechanical* guard Phase B can rely on.

### 2.2 Currency ownership — resolved [DESIGN]

`Property.currency` is authoritative. [CODE: it exists at `schema.prisma:301` with default
`INR`; `RoomType.currency` also exists at `:662`; `Reservation.currency` at `:828`;
`FolioLine.currency` at `:1518`.]

- `RatePlan` stores **no** currency column.
- Validation on every rate write: the money's `currency` must equal `Property.currency`, else
  `ValidationFailedError`. Mixing currencies throws, per §3.4's `Money` contract.
- `RoomType.currency` is **not** modified or dropped in Phase B; it is treated as advisory. A
  follow-up should reconcile it, and a read-only consistency check
  (`RoomType.currency <> Property.currency`) belongs in the §4.4 operator report.

### 2.3 `baseRateMinor` ↔ `defaultRateMinor` — the temporary relationship [DESIGN]

This duplication is the weakest point of document 14 and needs an explicit end state.

| Window | Authority | Mechanism |
|---|---|---|
Stage B1–B2 | `RoomType.baseRateMinor` | Rate tables exist; nothing reads them |
Stage B3 (backfill) | both, forced equal | Migration sets `defaultRateMinor := baseRateMinor`. **No drift possible at this instant** |
Stage B3 → B7 | `RoomType.baseRateMinor` still | Plans exist but pricing has not switched. **Drift is possible here**: editing a plan's default changes nothing a guest pays |
Stage B7 onward | `RatePlan.defaultRateMinor` | Pricing resolves from the plan |
After B7 | `RoomType.baseRateMinor` is **vestigial** | Must not be edited |

Two obligations follow, and document 14 omitted both:

1. **The B3→B7 window must be short and visible.** During it, the rate-plan editor must warn
   that changes do not yet affect bookings, or B5's write endpoints stay behind a flag. I
   prefer the flag: a UI that lies about whether an edit takes effect is worse than one that
   is not there yet.
2. **After B7, `RoomType.baseRateMinor` becomes read-only**, enforced by the room-type service
   refusing to change it and by a one-way sync at plan-creation time only. Dropping the column
   is a later migration with its own review, because three report queries and the booking
   engine may read it [CODE: it is referenced by `reservation-pricing.ts` via
   `QuoteInput.baseNightlyRateMinor`].

### 2.4 Effective-price resolution, and zero vs null [DESIGN]

```
effectiveRateMinor(plan, stayDate) :=
  RatePlanDay(plan, stayDate).rateMinor   if a row exists AND rateMinor IS NOT NULL
  plan.defaultRateMinor                   otherwise
```

- `rateMinor = NULL` means **"no override for this date"** — the row exists only to carry
  restrictions. Fall back to the plan default.
- `rateMinor = 0` means **a genuinely free night** and is allowed by
  `rate_plan_day_rate_non_negative`. It is *not* "unset". This distinction is why the column
  is nullable rather than defaulted to 0, and it is why the resolver tests both.
- A `stopSell` or `closedToArrival` date still has a price. Sellability and price are
  independent; conflating them would make "closed" unreportable to a channel that wants both.
- Resolution is a **pure function** of `(plan, day)` with no clock and no database, so it is
  unit-testable without a container — matching `reservation-pricing.ts`'s existing shape
  [CODE: that file is already pure].

### 2.5 Booking price snapshots [DESIGN + CODE]

A later rate change must never alter a booked stay. **This already holds**, and it is worth
recording why:

- `Reservation.totalAmountMinor`, `taxAmementMinor` and `currency` are **stored**, not derived
  [CODE: `schema.prisma:827-828`, `:864-869`].
- Per-night figures are snapshotted as `FolioLine` rows with `amountMinor` + `chargeDate`
  at check-in [CODE: `schema.prisma:1513-1521`], and folio lines are immutable with reversal
  semantics (§3.4).

Phase B adds one thing: **`Reservation.ratePlanId`, nullable, set at booking** — so an invoice
can say *which* product was sold, and a channel reservation can be attributed to a mapped
plan. It is nullable because 952 existing reservations predate it, and it must **never** be
used to re-derive a price. Deferred to stage B7-adjacent and gated on separate approval, since
it touches the booking write.

**`RatePlanDay` rows for past dates are never deleted or edited by any lifecycle job.** The
historical price of a past night is part of why a folio says what it says.

### 2.6 Archive behaviour and uniqueness [DESIGN]

- Uniqueness: `(propertyId, code)` and `(propertyId, roomTypeId, name)`.
  **Archiving does not free the code.** A recycled `code` would silently re-point a provider
  mapping at a different commercial product. If an operator needs the code back, that is a
  rename of the archived plan, done deliberately.
- `isActive = false` ⟺ `archivedAt IS NOT NULL`, enforced by
  `rate_plan_archive_matches_active`. **[SUPERSEDED 2026-10-27 — see the header: the biconditional
  is now a one-way `archivedAt IS NOT NULL` ⇒ `isActive = false`, so that a plan can be inactive
  without being archived. 16 §A.4.]**
- Archived plans are excluded from ARI projection and from booking, included in historical
  reads.
- Hard delete is permitted **only** when no `RatePlanDay`, no reservation and no channel
  mapping references the plan — i.e. a plan created by mistake and never used.

### 2.7 Day-one vs deferred — explicit split

| Required day one | Deferred, with the reason |
|---|---|
`code`, `name`, `roomTypeId`, `mealPlan`, `isRefundable`, `defaultRateMinor`, `isActive`/`archivedAt`, `sortOrder` | `standardOccupancy` beyond a single integer → occupancy pricing [BUSINESS G-3] |
`RatePlanDay`: `rateMinor`, the five restrictions | Derived/linked rates [BUSINESS G-4] — needs cycle detection and recomputation |
Currency validation against `Property.currency` | Promotions, `validFrom`/`validTo`, advance-booking restrictions — no product requirement |
`Reservation.ratePlanId` (nullable, stage-gated) | `ratePlanType` enum — presupposes a distribution model |

---

## 3. ARI snapshots and synchronisation — corrected

### 3.1 Snapshot scope and replacement semantics [DESIGN]

A snapshot is identified by **`(propertyId, kind, scopeId, from, to)`** where `scopeId` is
`roomTypeId` for `AVAILABILITY` and `ratePlanId` for `RATE`/`RESTRICTION`.

Replacement semantics, stated so an adapter cannot guess: **a snapshot is the complete truth
for every date in `[from, to]` inclusive, for that one scope and kind, and replaces whatever
the provider holds for exactly that window.** It says nothing about dates outside the window
and nothing about other scopes or kinds. Dates we do not track emit no entry and are
**excluded from the window** rather than sent as zero — sending `available: 0` for an
untracked date would close out sale on a date we simply have no opinion about.

Window size is capped at 400 days by the contract. That is **our** guard, not a provider's
[CODE: no provider range limit is documented — `09-unknowns-and-open-questions.md` U-001–U-006].

### 3.2 Correction: the outbox row is a dirty marker, not a frozen snapshot [DESIGN]

Document 14 enqueued `days[]` at produce time. Replace with:

```ts
// What the outbox row carries. Identifiers and a window. No numbers.
{
  payloadVersion: 1,
  kind: 'AVAILABILITY' | 'RATE' | 'RESTRICTION',
  scope: { propertyId, roomTypeId, ratePlanId? },
  range: { from, to },
  /** The local revision that made this scope dirty. Diagnosis and §3.3. */
  revision: number,
  correlationId: string,
}
```

The handler then, at send time: reads the current revision, **projects the snapshot fresh from
`inventory_day` / `rate_plan_day`**, and sends that.

Why this is strictly better, and it is the core of the correction: a job delayed by an hour,
or redelivered after a crash, carries *current* truth rather than hour-old truth. The
staleness window shrinks from "however long the job sat in the queue" to "the interval between
the handler's read and the provider's apply". It also shrinks the payload to a constant size
and keeps guest-irrelevant numbers out of Redis entirely.

Consequences, stated honestly:

- The outbox row no longer records *what* was sent. For dispute resolution the **attempt log**
  must record the projected payload — which `07-sync-and-failure-handling.md` §3.4 already
  requires ("every attempt is logged with request/response"). That is a `ChannelSyncAttempt`
  table in Phase C, not Phase B.
- `COALESCE` dedupe becomes even more clearly correct: five edits collapse to one marker, and
  the marker does not need to carry the newest state because the handler reads it.

### 3.3 Correction: what a local version check can and cannot do [DESIGN]

**A local version check cannot prevent a stale external write.** No provider in the
connectivity research is documented to support a conditional or versioned write
(`If-Match`, an expected-version parameter, or an optimistic-concurrency token)
[CODE: `07-sync-and-failure-handling.md` §2.3, §2.5 — "What no provider documents"]. Without
provider cooperation, the ordering of two concurrent requests at the provider is not ours to
determine.

What each mechanism actually buys:

| Mechanism | Prevents a stale external write? | What it genuinely does |
|---|---|---|
Local `revision < syncedRevision` check before sending | **No** | Avoids *issuing* a push already known to be superseded. Saves provider rate limit. A race between check and apply remains |
**Fresh-state projection at send time** (§3.2) | **No, but it removes the cause** | A late push carries current truth, so "late" stops meaning "stale". Residual risk only when two pushes for one scope are concurrently in flight |
**Per-scope serialisation** (§3.4) | **Yes, for staleness we cause** | With at most one push in flight per scope, there are no two of our requests to reorder. Provider-internal retries remain outside our control |
Provider conditional write | **Yes, fully** | Not available. If a provider ever offers one, use it and keep the above as defence in depth |
**Read-back reconciliation** (§4.4) | **No — it detects** | The only mechanism that catches drift whatever the cause, including causes we cannot see |

So the defensible claim, and the only one Phase B will make: *fresh-state projection plus
per-scope serialisation means we never knowingly send an older state than one we have already
sent, and reconciliation detects the residue.* Not "stale writes are prevented".

### 3.4 Per-scope serialisation — when it is necessary, and how [DESIGN]

**Necessary**, not optional, and document 14 was wrong to treat it as a later optimisation.
The Phase A worker runs at `OUTBOX_CONCURRENCY` (default 4) with no ordering
[CODE: `apps/api/src/modules/platform/outbox/outbox.worker.ts` — concurrency from config,
no per-key gating], and `COALESCE` explicitly permits a second row for a scope once the first
is `IN_FLIGHT` [CODE: the partial unique index is `WHERE … status = 'PENDING'`,
`migrations/20261026120000_transactional_outbox/migration.sql`]. So two pushes for one scope
*can* be in flight simultaneously. That is the one case fresh-state projection does not cover.

Mechanism, reusing Phase A's own pattern and adding no dependency — a **lease on the sync-state
row**:

```prisma
model AriSyncState {
  propertyId String   @db.Uuid
  kind       String                 // AVAILABILITY | RATE | RESTRICTION
  scopeId    String   @db.Uuid      // roomTypeId or ratePlanId

  /// Bumped in the SAME transaction as the local change that caused it.
  revision        BigInt    @default(0)
  /// Highest revision a provider has CONFIRMED applied.
  syncedRevision  BigInt    @default(0)
  syncedAt        DateTime? @db.Timestamptz(6)

  /// The in-flight lease. Exactly the claim-lease shape Phase A proved.
  pushLeaseUntil  DateTime? @db.Timestamptz(6)
  pushLeaseBy     String?

  @@unique([propertyId, kind, scopeId], name: "ari_sync_state_unique_key")
  @@map("ari_sync_state")
}
```

- The handler takes the lease with a conditional update (`WHERE pushLeaseUntil IS NULL OR
  pushLeaseUntil < now()`). Zero rows updated ⇒ another push owns this scope ⇒ return the job
  to PENDING as **transient with no attempt consumed** (so a busy scope cannot dead-letter).
- The provider call happens **outside** any transaction, holding only the lease.
- Lease duration must exceed the provider timeout, the same relationship the Phase A env
  schema already enforces for the outbox (`OUTBOX_LEASE_MS >= 2 × OUTBOX_HANDLER_TIMEOUT_MS`)
  [CODE: `apps/api/src/config/env.ts` refinement]. The same check is owed here.
- A crashed worker's lease expires and the scope frees itself — no stuck scope.

### 3.5 The failure matrix [DESIGN]

| Scenario | Behaviour | Residual risk |
|---|---|---|
**Out-of-order delivery** | Fresh projection (§3.2) + lease (§3.4): only one of our requests is in flight per scope, and it carries current state | Provider-internal reordering. Undetectable locally; caught by reconciliation |
**Duplicate delivery** | FULL_STATE snapshots are idempotent: re-applying produces the same remote state. Phase A's claim token already drops a job whose claim was superseded [CODE: `outbox.worker.ts` guards every outcome write on `claimedBy`] | None of consequence |
**Worker crashes after the provider accepted** (gap B) | `syncedRevision` is not advanced, so the scope looks dirty and is pushed again. The re-push is a no-op at the provider because it is full-state | One redundant call. **At-least-once; never exactly-once** |
**Partial provider failure** (e.g. 200 of 400 dates applied) | Treat the whole push as **transient**, do **not** advance `syncedRevision`, and re-send the full window. Safe only because the payload is full-state. Narrowing the window is an optimisation, never a correctness requirement | Provider left briefly half-updated between attempts |
**Local change while an older push is in flight** | The change bumps `revision` and enqueues a marker. The in-flight push completes and sets `syncedRevision` to **the revision it read**, not to the current one. `revision > syncedRevision` therefore remains true, and the queued marker pushes again | None, provided `syncedRevision` is set from the read revision. Setting it to `revision` at completion time would **lose** the newer change — the single most dangerous implementation mistake in this design |
**Provider outage** | Transient; Phase A's budget, jitter and dead letter apply unchanged | After the budget, the scope is stale until replay (§4.3) |

### 3.6 Contract scalars — unchanged from document 14, restated as requirements

| Concern | Rule |
|---|---|
**Date-only / timezone** | Every date is a calendar date in the property's own IANA zone [CODE: `Property.timezone`, `schema.prisma:298`]. Never from a server or client clock. Stored `@db.Date`; crosses the wire as `YYYY-MM-DD`. The UTC-pinned session keeps the conversion lossless [CODE: `client-factory.ts:69-73` — **not to be modified**] |
**Range inclusivity** | ARI ranges are **inclusive at both ends**, deliberately unlike `reservation_room`'s `daterange(…, '[)')` [CODE: `migration.sql:232`]. "Price the 1st to the 7th" includes the 7th; a stay's departure day is not a night. Stated in the schema, the contract, and a test |
**Monetary units** | Integer minor units + ISO-4217 currency, `{ amountMinor, currency }`, never a float or a formatted string (§3.4). `currency` validated against `Property.currency` (§2.2) |
**`payloadVersion`** | Integer, registered in `OUTBOX_PAYLOAD_SCHEMAS` keyed `'TYPE:version'` [CODE: `packages/types/src/dto/outbox.dto.ts`]. An unknown *newer* version is transient, not permanent — a rolling deploy must not poison its backlog [CODE: already implemented in `outbox.worker.ts`] |
**`idempotencyKey`** | The outbox `dedupeKey`: `ari:<kind>:<scopeId>:<from>:<to>`, `COALESCE` mode. Collapses repeated intents for one window while PENDING |
**`correlationId`** | A UUID minted by the request or job that caused the change, carried through the marker to the attempt log, so an operator can trace one edit to one provider call |

---

## 4. Failure handling and observability

### 4.1 Retryable vs permanent — reusing Phase A unchanged

| Condition | Class | Mechanism |
|---|---|---|
Provider 5xx, timeout, reset, 429 | transient | Thrown normally; PostgreSQL schedules with full jitter [CODE: `outbox.worker.ts` `backoffFor`] |
Provider 4xx rejecting the payload (unknown rate plan, bad mapping) | **permanent** | `OutboxPermanentError` → DEAD on attempt 1 [CODE: `outbox-handler.registry.ts:45-50`] |
Malformed row payload | permanent | Existing zod check; field paths logged, never values |
Unknown newer `payloadVersion` | transient | Existing behaviour |
Scope lease held by another push | **transient, no attempt consumed** | §3.4. New behaviour Phase A does not yet express — see §4.6 |
`revision <= syncedRevision` | **`SUPERSEDED`** — neither | Dropped as a normal outcome, no attempt consumed |

### 4.2 Dead-letter handling and operator visibility [DESIGN]

A DEAD `ARI_*` row means **one OTA is now selling against stale data** — a distribution
incident, not a log line. Minimum viable visibility, given no alerting exists:

- `GET /health/outbox` already reports `dead`, `staleLeases`, `oldestPendingAgeSeconds`
  [CODE: `apps/api/src/modules/health/health.controller.ts`].
- Phase B adds `GET properties/:hotelId/ari-sync-state` behind `channels:read`: per scope,
  `revision − syncedRevision` (how far behind), `syncedAt` (how long), and the count of DEAD
  events. **Lag as a number on a screen** is the substitute for alerting until alerting exists.

### 4.3 Replay [DESIGN]

Replay is **re-marking a scope dirty**, not re-sending a stored payload — which falls out of
§3.2 for free and is why that correction matters operationally as well as for correctness. An
operator with `channels:sync` triggers a re-push; the handler projects current state. There is
no mechanism to re-send a historical snapshot, and that is deliberate: re-applying an old
snapshot is the stale write we are trying to avoid.

Reviving a DEAD row remains explicit and audited, never automatic — Phase A's reasoning stands
(a one-click retry of an unknown-outcome call is the button that double-charges someone), and
here the correct action is usually to re-mark the scope rather than revive the row.

### 4.4 Report-only reconciliation [DESIGN]

Nightly per property, bounded window: read the provider's held ARI, compare with our
projection, **report differences and mutate nothing**.

**It must never write `inventory_day`, `sold`, `blocked`, or any reservation row.** This is
the hard rule of the whole phase. The PMS is authoritative for ARI; the channel is
authoritative for reservations it sends us [CODE: `07-sync-and-failure-handling.md` §3.3]. An
auto-corrector that is itself wrong corrupts both sides, and an inbound-driven inventory write
is how a sync failure becomes a double booking.

The same report carries the §1.6 inventory gaps and the §2.2 currency mismatches, because they
have the same consequence: something we cannot describe correctly to a channel.

### 4.5 One interaction the design must not forget

**Cancellation does not exist yet** [CODE §1.1]. When it lands it will decrement `sold`, which
*increases* availability — and an availability increase that is never pushed means the OTA
under-sells, which is revenue loss rather than a double booking. It is the less visible
failure, and therefore the easier one to ship broken. Whoever implements cancellation must bump
`AriSyncState.revision` in the same transaction. Recording it here so it is not discovered
later.

### 4.6 Phase A limitations that must close before a real provider

| # | Limitation | Why it blocks a real provider |
|---|---|---|
**L-1** | Dead letters log at `error` only; **no alerting** | A failed ARI push is a silent distribution outage. §4.2's lag endpoint is a mitigation, not a fix |
**L-2** | **No DEAD replay path**; reviving means a manual `UPDATE` | An operator cannot recover a stale scope without database access |
**L-3** | **No per-scope ordering primitive** in the worker | §3.4 adds it as a lease; until then two pushes per scope can race |
**L-4** | **No attempt log** (request/response per try) | `07-…` §3.4 requires it for dispute resolution, and §3.2's correction removes the payload from the outbox row, so without it nothing records what was sent |
**L-5** | In-process counters reset on restart | Lag must be computed from `AriSyncState`, not from counters |
**L-6** | No circuit breaker | §5 requires one for external calls; a failing OTA must degrade the sync layer, never the front desk |
**L-7** | SIGTERM path untested on Windows | Operational, not correctness; verify in a container before production |

L-1, L-3 and L-4 are the ones I would call genuine blockers. L-3 is inside Phase B's scope;
L-1 and L-4 belong to Phase C and must not be deferred past it.

---

## 5. Implementation safety

### 5.1 Migrations and constraints

| Stage | Migration | Reversible? |
|---|---|---|
B1 | `CREATE TABLE rate_plan`, `rate_plan_day`; 6 CHECKs; 2 composite FKs; `@@unique([id, propertyId])` on `rate_plan` | **Yes** — `DROP TABLE`; no existing table touched |
B2 | `ALTER TABLE property_settings ADD COLUMN "inventoryHorizonDays" INTEGER NOT NULL DEFAULT 450` | **Yes** — additive column with a default; `DROP COLUMN` is clean |
B3 | `INSERT … SELECT` backfill of one plan per room type | **Partially** — rows are identifiable and unreferenced, so deletable; but if an operator has edited a plan by then, deletion loses that edit |
B6 | `CREATE TABLE ari_sync_state`; 3 new `OutboxEventType` values | **Table yes. Enum values no** — PostgreSQL cannot drop an enum value. They are additive and harmless, but permanent |
B7 | `ALTER TABLE reservation ADD COLUMN "ratePlanId" UUID NULL` + FK | **Yes** while NULL-able and unread |

**Rollback limitations, stated plainly:** enum additions are one-way; the B3 backfill stops
being cleanly reversible once edited; and any `rate_plan_day` rows an operator creates are real
work that a `DROP TABLE` destroys. From B3 onward, rollback means **restore from a `pg_dump`**,
not "run the down migration". There are no down migrations in this repo — the convention is
roll forward [CODE: CLAUDE.md §4, "Migrations are never edited after merge; roll forward
instead"].

### 5.2 Tests — and what must not change

Five suites exist and are the regression baseline. **None may be modified, skipped or
deleted** [CODE: `package.json` scripts `test:concurrency`, `test:checkin`, `test:outbox`,
`test:outbox:concurrency`, `test:outbox:redis`].

| New suite | Redis? | Provider? | Proves |
|---|---|---|---|
`test:inventory:lifecycle` | no | no | AC-1.1…AC-1.4, AC-1.8 |
`test:inventory:concurrency` | no | no | AC-1.5, AC-1.6 — parallel extensions, and a booking committed mid-rebuild |
`test:rates` | no | no | Plan CRUD; both unique constraints; archive CHECK; LOS CHECK; **tenant isolation returning 404 not 403**; audit row in the same transaction; currency rejection |
`test:rates:pricing` | no | no | §2.4 resolution incl. **0 vs null**; backfilled plan reproduces `baseRateMinor` exactly |
`test:ari:contract` | no | no | Inclusive ranges; dates inside window; duplicate dates; `AVAILABILITY` with a plan id rejected; `RATE` without one rejected; `DELTA` rejected from a producer |
`test:ari:ordering` | no | no | §3.5 row 5 — the `syncedRevision`-from-read-revision rule, asserted as *not* losing a concurrent change; lease refusal consumes no attempt |
`test:ari:idempotency` | no | no | COALESCE collapse; applying a snapshot twice is a no-op |
`test:ari:outbox` | **yes** | no (fake handler) | Marker → fresh projection → apply → `syncedRevision` advanced; transient retry; budget → DEAD; lease recovery |
`test:ari:reconcile` | no | no | Drift detected; **zero writes** to `inventory_day` or `reservation` (asserted by row-count and checksum comparison) |

Everything except `test:ari:outbox` runs without Redis and without any provider, which is the
same property that made Phase A's core testable.

### 5.3 Preservation

- All pre-existing uncommitted work is untouched: property-configuration, master report,
  room-move, folio components, and the timezone fix in `client-factory.ts`.
- No reseeding, no timezone repair, no database write of any kind in this review.
- No real provider integration, no credentials, no external network call.

---

## 6. Open decisions

### Engineering decisions made here (no approval needed)

Fresh-state projection instead of a frozen payload (§3.2); per-scope lease as a **requirement**
rather than an optimisation (§3.4); `syncedRevision` set from the revision the handler *read*
(§3.5); rebuild **refuses** rather than clamps (§1.7); `ON CONFLICT DO NOTHING` for extension
idempotency (§1.4); Property owns currency (§2.2); archive does not free a code (§2.6); 0 vs
null rate semantics (§2.4).

### Needs your approval

| # | Decision | Impact if deferred |
|---|---|---|
**D-1** | `inventoryHorizonDays = 450` default | Wrong horizon means either unsellable near-term dates or 46,996 rows becoming 100,000+ |
**D-2** | Keep B5's rate-write endpoints **behind a flag** until B7, so the UI cannot imply an edit takes effect when it does not (§2.3) | An operator edits a price, nothing changes, trust is lost |
**D-3** | `Reservation.ratePlanId` — add nullable in Phase B, or defer entirely? It touches the booking write | Without it, a channel reservation cannot be attributed to a plan |
**D-4** | Is per-property reconciliation scheduled by `rates` now, or deferred until `nightaudit` exists? (§1.5, §4.4) | Duplicate schedules later, or no drift detection at all meanwhile |

### Needs business input (carried forward from document 14, unchanged)

G-1 multiple plans per room type on day one; G-2 meal plan on the plan or the booking; G-3
occupancy pricing; G-4 derived/linked rates; G-5 which restriction types the chosen channels
need; G-6 where reconciliation lives.

### Needs verified provider documentation

G-7 per-plan vs room-type-level restrictions; G-8 payload/range limits; G-9 availability
scope. **Added by this review: G-10 — does any candidate provider support a conditional or
versioned write?** If one does, §3.3's residual risk closes properly instead of being
mitigated. None blocks Phase B; all block Phase C.

---

## 7. Risks that still block implementation

1. **H-1 (`physical` is an uncomputed projection) must be closed before any availability is
   published.** If B2 slips, publishing availability broadcasts a stale projection. This is
   the one ordering constraint in the plan that is not negotiable.
2. **Cancellation does not exist.** Availability will be under-reported the moment it does,
   unless it bumps `revision` (§4.5). That is a cross-phase obligation on code Phase B is
   forbidden to touch.
3. **No tenancy extension, no RLS.** Composite FKs are the only mechanical guard; everything
   else is convention plus review.
4. **L-1 and L-4** (no alerting, no attempt log) mean a real provider integration would be
   operating blind. Phase B can proceed; Phase C cannot ship without them.
5. **Rollback is dump-restore from B3 onward**, not a down migration.
6. **§3.3's residual staleness cannot be closed locally.** Per-scope serialisation covers what
   we cause; provider-internal reordering is detected by reconciliation and nothing else.
