# Phase B1 — Implementation-Ready Plan: RatePlan Schema and Migration

**Status:** plan only. Not authorised for implementation. No application code, Prisma schema,
migration, package file, database row or business datum was changed to produce it.
**Date:** 2026-10-26
**Builds on:** `14-phase-b-rateplan-and-sync-contract.md` (proposal),
`15-phase-b-design-review.md` (correction). Neither is overwritten.
**Scope of B1:** two new tables, their constraints, and a behaviour-preserving backfill.
Nothing else. No endpoints, no services, no outbox producer, no inventory lifecycle, no
pricing change, no provider.

Labels used throughout:

| Label | Meaning |
|---|---|
| **[CODE]** | Verified in the working tree or the live dev database on this date, with the evidence shown |
| **[PROPOSED]** | My design. Not in the code. Open to rejection |
| **[UNRESOLVED]** | Not determinable from the code; needs a decision or a document I do not have |

---

## 0. The four recorded decisions

**All four are proposed engineering defaults awaiting your final approval. None is an
established business requirement.**

### D-1 — Inventory horizon: 180 days, configurable [PROPOSED]

A configurable default of **180 days** for inventory-calendar initialisation, deliberately
**not immutable**.

- **Configuration surface:** a new `PropertySettings.inventoryHorizonDays Int @default(180)`.
  `PropertySettings` is the established home for per-property operational numbers and already
  carries `autoHoldReleaseHours` and `nightAuditHour` [CODE: `schema.prisma:1240-1270`], so
  this needs no new table.
- **Per-property, not global**, because `PropertySettings` is per-property by construction
  (`propertyId @unique`) and a 20-room resort and a 200-room city hotel do not sell the same
  distance out.
- **This column is NOT part of B1.** It lands with the inventory-calendar prerequisite (§D),
  because B1 adds no inventory behaviour. Recorded here only so the decision is on file.
- **Must be validated before production:**
  1. Row-count impact at the chosen horizon. Measured baseline: **46,996 `inventory_day`
     rows** today [CODE: live count]. 180 days × 92 room types ≈ 16,560 rows for a forward
     window, which is well inside §1's "per-date rows are affordable".
  2. That the horizon is **≥ the furthest arrival date any live reservation already holds** —
     otherwise extension would skip dates that are already sold. This must be a pre-flight
     query, not an assumption.
  3. That it is ≥ the booking window the chosen channel exposes. [UNRESOLVED: no provider
     contract is confirmed; `09-unknowns-and-open-questions.md` records this gap.]
  4. That raising it later is a pure extension (it is — §D's statement is
     `ON CONFLICT DO NOTHING`) and that **lowering it deletes nothing**. A reduced horizon
     must stop creating new dates, never remove existing ones.

### D-2 — Rate-write endpoints disabled behind a flag [PROPOSED]

Writes stay disabled until booking pricing actually resolves from the new source (stage B7).
Reads may be enabled independently.

- **Disabled behaviour, specified:** a disabled write endpoint returns **HTTP 404**, not 403
  and not 501. It is routed but behaves as though it does not exist, so no client can
  discover a surface that will later change shape. 403 would wrongly imply a permission
  problem the operator could fix.
- **Reads are safe to enable** because, until B7, the tables are not consulted by any booking
  path [CODE: nothing in `apps/api/src` references a rate-plan table — the tables do not
  exist]. A read cannot mislead as long as the UI states that edits are not yet live.
- **The real hazard this prevents** is the window identified in `15-…` §2.3: between the
  backfill (B3) and the pricing switch (B7), editing a plan's price changes nothing a guest
  pays. A UI that accepts such an edit silently lies.
- **Not implemented now.** No flag, no endpoint, no config key is created in B1. The flag
  mechanism itself is [UNRESOLVED]: this repository has no feature-flag facility, and
  `apps/api/src/config/env.ts` is the only configuration surface, so the likely shape is a
  zod-validated boolean env var defaulting to `false`.

### D-3 — `Reservation.ratePlanId` deferred to B7 [PROPOSED]

Deferred. I looked for a compelling earlier requirement in the code and **did not find one**:

- Nothing reads a rate plan from a reservation, because no rate-plan table exists [CODE].
- The price a guest pays is already snapshotted independently of any plan:
  `Reservation.totalAmountMinor`, `taxAmountMinor` and `currency` are **stored columns**
  [CODE: `schema.prisma:827-828`, `:864-869`], and per-night figures become immutable
  `FolioLine` rows with `amountMinor` + `chargeDate` at check-in
  [CODE: `schema.prisma:1513-1521`].
- Therefore attribution is the only thing a `ratePlanId` would add, and nothing in B1–B6
  consumes attribution.

**No reservation write path and no booking schema is touched.** Existing reservation and folio
price snapshots are preserved exactly as they are.

### D-4 — Reconciliation: report-only, manually or job-callable [PROPOSED]

- A service with **no writes to business data at all** — not to `inventory_day`, `sold`,
  `blocked`, `rate_plan_day`, or any reservation row.
- Callable manually (an authenticated endpoint behind `channels:read`) or by a controlled job
  invocation. **Recurring scheduling is deferred** until visibility, alerting and ownership are
  defined — which is honest, because the alerting gap is an open Phase A limitation
  (`15-…` §4.6 L-1) and there is no `nightaudit` module to own a schedule
  [CODE: `ls apps/api/src/modules/` — 14 modules, no `nightaudit`].
- Output is a drift report: differences per `(scope, date)`, plus the inventory gaps from §D
  and the currency mismatches from §B.2.

---

## A. Exact schema proposal

### A.1 Conventions this proposal copies, verified first

Every structural choice below matches a pattern already in the repository. Verified today:

| Convention | Evidence |
|---|---|
| `id String @id @default(uuid()) @db.Uuid` | [CODE] every model, e.g. `schema.prisma:1292` |
| `propertyId String @db.Uuid` + `property Property @relation(..., onDelete: Cascade)` on every tenant-scoped model | [CODE] `:1294-1295` |
| `createdAt DateTime @default(now()) @db.Timestamptz(6)` / `updatedAt DateTime @updatedAt @db.Timestamptz(6)` | [CODE] `:1309-1310` |
| Calendar values are `@db.Date`, never a timestamp | [CODE] `InventoryDay.stayDate :740`, `Property.businessDate :306` |
| Money is `Int` in minor units, paired with a currency | [CODE] `RoomType.baseRateMinor :661`, `FolioLine.amountMinor :1513` |
| `@@map("snake_case")` on every model | [CODE] `:1318` |
| Newer models name a unique with `map:`; older ones with `name:` | [CODE] `map:` at `:1317`; `name:` at `:677`. **`map:` is the newer convention and is what B1 uses** |
| A unique is declared **in Prisma** when the seed or a service needs it as an upsert target | [CODE] the comment at `:1312-1316`: "a hand-written index the client cannot see is an index the seed cannot upsert against" |
| Related CHECK predicates are **grouped into one named constraint**, not split | [CODE] `room_type_rate_and_occupancy_sane` = `baseRateMinor >= 0 AND maxGuests >= 1 AND overbookingAllowance >= 0`; `property_tax_slab_bounds_non_negative` bundles two |
| CHECK naming: `<table>_<predicate_in_snake_case>` | [CODE] 28 existing CHECKs follow it |
| Tenant-coherence FK naming: `<table>_same_property_as_<parent>` | [CODE] all 11 composite FKs |
| The composite FK form for a room-type parent | [CODE] `room.room_same_property_as_room_type` = `FOREIGN KEY ("roomTypeId", "propertyId") REFERENCES room_type(id, "propertyId") ON UPDATE CASCADE ON DELETE RESTRICT` |
| Single-column Prisma FKs **coexist** with the hand-written composite FK | [CODE] `inventory_day` carries all three: `..._propertyId_fkey`, `..._roomTypeId_fkey`, `..._same_property_as_room_type` |
| `unique_pair` indexes are **SQL-only**, absent from `schema.prisma` | [CODE] `grep "id, propertyId" schema.prisma` → no match; the indexes exist live |

**Correction to document 14:** it proposed six separate CHECK constraints across the two
tables. That does not match the convention above. B1 consolidates them into **four** grouped
CHECKs. Same coverage, repository-idiomatic naming.

**A fact that removes work from document 14:** `room_type_property_id_unique_pair` on
`(id, "propertyId")` **already exists** [CODE: live `pg_indexes`]. So `rate_plan`'s composite
FK to `room_type` needs **no ALTER to `room_type`**. Document 14 implied one might be needed.

### A.2 `RatePlan` — every field

```prisma
/// A sellable product: what a room type costs under a named commercial policy.
///
/// Property-scoped by design. There is no portfolio-wide rate catalogue: ten
/// independently-operated hotels negotiate their own rates, and a shared row
/// would mean editing one property's price changed another's — the coupling
/// CLAUDE.md section 3.2 forbids. `RatePlan` must never be added to
/// PORTFOLIO_GLOBAL_MODELS in packages/database/src/index.ts.
model RatePlan {
  id String @id @default(uuid()) @db.Uuid

  propertyId String   @db.Uuid
  property   Property @relation(fields: [propertyId], references: [id], onDelete: Cascade)

  /// The one room type this plan prices. A plan spanning categories would need
  /// a price per category, which is two plans.
  roomTypeId String   @db.Uuid
  roomType   RoomType @relation(fields: [roomTypeId], references: [id], onDelete: Restrict)

  code        String
  name        String
  description String?

  mealPlan MealPlan

  isRefundable Boolean

  standardOccupancy Int @default(2)

  /// Fallback nightly rate in the PROPERTY's currency minor unit. Authoritative
  /// for any date with no RatePlanDay override.
  defaultRateMinor Int

  sortOrder Int @default(0)

  isActive   Boolean   @default(true)
  archivedAt DateTime? @db.Timestamptz(6)

  createdAt DateTime @default(now()) @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @db.Timestamptz(6)

  days RatePlanDay[]

  @@unique([propertyId, code], map: "rate_plan_unique_code_per_property")
  @@unique([propertyId, roomTypeId, name], map: "rate_plan_unique_name_per_room_type")
  @@index([propertyId, roomTypeId, isActive, sortOrder])
  @@map("rate_plan")
}
```

| Field | Type | Null? | Purpose | Authority |
|---|---|---|---|---|
| `id` | `uuid` | no | Stable identity a future provider mapping can point at. Never reused (archive, not delete) | authoritative |
| `propertyId` | `uuid` | no | Tenant key. Leads both uniques and the index (§3.2) | authoritative |
| `roomTypeId` | `uuid` | no | What is being priced. `Restrict` so a room type cannot vanish under a live plan | authoritative |
| `code` | `text` | no | Operator-facing, e.g. `BAR`. Unique per property | authoritative |
| `name` | `text` | no | Display name. Unique per `(property, roomType)` | authoritative |
| `description` | `text` | yes | Optional operator note | authoritative |
| `mealPlan` | `MealPlan` enum | no | What the guest gets. **No default** — `EP` must be an explicit decision, not an assumption | authoritative |
| `isRefundable` | `boolean` | no | **No default**, for the same reason: refundability is a commercial choice. A boolean, not a policy engine — `PropertyPolicy` already holds prose policy [CODE: `schema.prisma:1390`] |
| `standardOccupancy` | `int` | no, dflt `2` | The occupancy the price is quoted for. **2 because Indian hotel tariffs are conventionally quoted per double room**; explicit so single-occupancy is representable. Not occupancy *pricing* — see §B.7 |
| `defaultRateMinor` | `int` | no | Fallback nightly rate, minor units | authoritative from B7; see §B.3 |
| `sortOrder` | `int` | no, dflt `0` | Display order. Mirrors `RoomType.sortOrder` [CODE: `:668`] |
| `isActive` | `boolean` | no, dflt `true` | Sellable flag | authoritative |
| `archivedAt` | `timestamptz(6)` | yes | When retired. Coupled to `isActive` by CHECK | authoritative |
| `createdAt` / `updatedAt` | `timestamptz(6)` | no | Convention | — |

**No `currency` column.** `Property.currency` is authoritative (§B.1). A second column would
be a second answer.

### A.3 `RatePlanDay` — every field

```prisma
/// One row per (rate plan, stay date): the price and the restrictions for a night.
///
/// Sparse. A row exists only where the operator has set something; the plan's
/// defaultRateMinor answers every other date.
///
/// Deliberately NOT columns on inventory_day: that table is locked FOR UPDATE on
/// every stay date of every booking, so putting revenue-management writes there
/// would put them in lock contention with the front desk, and one price per
/// room-type-date could not represent two rate plans.
model RatePlanDay {
  id String @id @default(uuid()) @db.Uuid

  /// Denormalised deliberately: section 3.2 requires every composite index to
  /// lead with propertyId, and a tenant predicate reached through a join is one
  /// someone will forget.
  propertyId String   @db.Uuid
  property   Property @relation(fields: [propertyId], references: [id], onDelete: Cascade)

  ratePlanId String   @db.Uuid
  ratePlan   RatePlan @relation(fields: [ratePlanId], references: [id], onDelete: Cascade)

  /// A calendar date, never an instant (section 3.3).
  stayDate DateTime @db.Date

  /// NULL = no override for this date, fall back to the plan default.
  /// 0 = a genuinely free night. The two are not the same.
  rateMinor Int?

  closedToArrival   Boolean @default(false)
  closedToDeparture Boolean @default(false)
  stopSell          Boolean @default(false)
  minLengthOfStay   Int?
  maxLengthOfStay   Int?

  createdAt DateTime @default(now()) @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @db.Timestamptz(6)

  @@unique([propertyId, ratePlanId, stayDate], map: "rate_plan_day_unique_per_date")
  @@index([propertyId, stayDate])
  @@map("rate_plan_day")
}
```

| Field | Type | Null? | Purpose |
|---|---|---|---|
| `rateMinor` | `int` | **yes** | `NULL` = no override; `0` = free night. Nullable precisely to keep those distinct (§B.4) |
| `closedToArrival` / `closedToDeparture` / `stopSell` | `boolean` | no, dflt `false` | Restrictions. Defaulted `false` because "no row" and "a row with no restriction" must mean the same thing — otherwise a row created only to set a price would accidentally close out sale |
| `minLengthOfStay` / `maxLengthOfStay` | `int` | yes | `NULL` = unrestricted. Applies to a stay **arriving** on this date |

The `(propertyId, ratePlanId, stayDate)` unique is declared **in Prisma** with `map:`, because
a bulk calendar write is naturally an upsert and the convention comment at `schema.prisma:1312`
is explicit that a SQL-only index cannot be an upsert target.

### A.4 Hand-written SQL: indexes, CHECKs, composite FKs

Prisma cannot express any of these. They go in the same migration and are never removed (§6.2).

```sql
-- 1. The unique pair rate_plan_day's composite FK needs. SQL-only, matching the
--    existing six (room, room_type, reservation, company, folio,
--    property_amenity_link). Column order (id, "propertyId") matches
--    room_type_property_id_unique_pair so the FK clause reads the same way.
CREATE UNIQUE INDEX "rate_plan_property_id_unique_pair"
  ON "rate_plan" ("id", "propertyId");

-- 2. Tenant coherence. Exactly the form room.room_same_property_as_room_type uses.
--    RESTRICT, not CASCADE: a room type must not disappear under a live plan.
ALTER TABLE "rate_plan"
  ADD CONSTRAINT "rate_plan_same_property_as_room_type"
  FOREIGN KEY ("roomTypeId", "propertyId")
  REFERENCES "room_type" ("id", "propertyId")
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "rate_plan_day"
  ADD CONSTRAINT "rate_plan_day_same_property_as_plan"
  FOREIGN KEY ("ratePlanId", "propertyId")
  REFERENCES "rate_plan" ("id", "propertyId")
  ON UPDATE CASCADE ON DELETE CASCADE;

-- 3. Grouped CHECKs, matching room_type_rate_and_occupancy_sane's style.
ALTER TABLE "rate_plan"
  ADD CONSTRAINT "rate_plan_rate_and_occupancy_sane"
  CHECK ("defaultRateMinor" >= 0 AND "standardOccupancy" >= 1);

ALTER TABLE "rate_plan"
  ADD CONSTRAINT "rate_plan_archive_matches_active"
  CHECK (("archivedAt" IS NULL) = ("isActive" = true));

ALTER TABLE "rate_plan_day"
  ADD CONSTRAINT "rate_plan_day_rate_non_negative"
  CHECK ("rateMinor" IS NULL OR "rateMinor" >= 0);

ALTER TABLE "rate_plan_day"
  ADD CONSTRAINT "rate_plan_day_los_window_coherent"
  CHECK (
    ("minLengthOfStay" IS NULL OR "minLengthOfStay" >= 1) AND
    ("maxLengthOfStay" IS NULL OR "maxLengthOfStay" >= 1) AND
    ("minLengthOfStay" IS NULL OR "maxLengthOfStay" IS NULL
      OR "minLengthOfStay" <= "maxLengthOfStay")
  );
```

**Why `rate_plan_day_rate_non_negative` is separate from the LOS check** rather than grouped:
they fail for unrelated reasons, and a grouped constraint makes the error message ambiguous
about which rule was broken. The existing `property_tax_slab` table groups *bounds* separately
from *ordering* for the same reason [CODE: `property_tax_slab_bounds_non_negative` and
`property_tax_slab_band_is_ordered` are two constraints].

### A.5 Uniqueness and overlap rules

- **`(propertyId, code)` unique.** Archiving does **not** free the code. A recycled code would
  silently re-point a future provider mapping at a different commercial product. Reclaiming a
  code is a deliberate rename of the archived plan.
- **`(propertyId, roomTypeId, name)` unique.** Two plans on one room type must not share a
  display name; two different room types may each have a "Best Available Rate".
- **`(propertyId, ratePlanId, stayDate)` unique** — one row per plan per night. This is the
  overlap rule, and it is total: there are no ranges to overlap, because the calendar is
  per-date. That is a deliberate simplification over a `daterange`-with-exclusion design:
  per-date rows match `inventory_day`'s proven shape [CODE: `inventory_day_unique_per_date`],
  make a bulk upsert trivial, and cost ~22,500 rows at full population against 46,996 already
  present.
- **No exclusion constraint is needed or proposed.** `btree_gist` is already enabled for
  `reservation_room_no_overlap` [CODE: `migration.sql:232`], but per-date uniqueness makes a
  range-overlap guard unnecessary here.

### A.6 Archive and delete behaviour

| Action | Behaviour |
|---|---|
| Retire a plan | `isActive = false` **and** `archivedAt = now()`, together, enforced by `rate_plan_archive_matches_active` |
| Archived plan's day rows | **Retained.** The historical price of a past night is part of why a folio says what it says |
| Archived plan in ARI projection / booking | Excluded (from B6/B7; in B1 nothing projects or books) |
| Archived plan in historical reads | Included |
| Hard delete | Permitted **only** when no `RatePlanDay`, no reservation and no channel mapping references the plan — i.e. created by mistake, never used. `ON DELETE CASCADE` on `rate_plan_day` means a hard delete takes the day rows with it, which is why the "no `RatePlanDay`" precondition matters |
| Room type deletion | Blocked by `ON DELETE RESTRICT` while any plan exists, including archived ones |
| Property deletion | `ON DELETE CASCADE`, matching every other tenant-scoped table |

**B1 adds no service**, so these are constraints and intentions, not enforced application
behaviour yet. The CHECK is the only part of this that B1 actually ships.

### A.7 Authoritative vs derived

| Value | Status |
|---|---|
| `RatePlan.defaultRateMinor` | Authoritative **from B7**. Between B3 and B7 it is a copy; `RoomType.baseRateMinor` remains authoritative (§B.3) |
| `RatePlanDay.rateMinor` | Authoritative for its date when non-null |
| Effective price | **Derived**, by the pure resolver in §B.4. Never stored |
| Currency | Authoritative on `Property`. `RatePlan` has none; `RoomType.currency` is advisory (§B.1) |
| `Reservation.totalAmountMinor`, `FolioLine.amountMinor` | Authoritative **snapshots**. Never recomputed from a plan |

### A.8 Unresolved schema details

| # | Item | Why unresolved |
|---|---|---|
| **U-1** | Should `MealPlan` gain `BB`/`HB`/`FB`? | OTAs commonly use those labels, but no provider contract is confirmed and `MealPlan` is consumed by `Reservation.mealPlan` on 952 live rows. Adding members is additive and safe; mapping is adapter work. Not B1 |
| **U-2** | Does `standardOccupancy` belong on the plan at all, or only on a future occupancy-price table? | Depends on the occupancy-pricing decision (G-3). Keeping it as one integer is the smallest thing that is not wrong |
| **U-3** | Should `RatePlan` carry `minLengthOfStay`/`maxLengthOfStay` plan-level defaults, with the day row overriding? | Two levels of the same rule need a documented precedence, and no requirement calls for it. Day-level only, for now |
| **U-4** | What the feature-flag mechanism is (D-2) | No flag facility exists in the repo |

---

## B. Pricing and currency

### B.1 `Property.currency` vs `RoomType.currency` — resolved

Four currency columns exist today [CODE]: `Property.currency :301` (default `INR`),
`RoomType.currency :662`, `Reservation.currency :828`, `FolioLine.currency :1518`.

**`Property.currency` is authoritative.** [PROPOSED]

- `RatePlan` stores no currency.
- Every rate write validates the submitted currency equals `Property.currency`, else
  `ValidationFailedError`. Mixing currencies throws, per §3.4's `Money` contract.
- `RoomType.currency` is **not modified, not dropped, not read** by B1. It becomes advisory.
  A read-only consistency check (`room_type.currency <> property.currency`) belongs in the §D-4
  drift report.
- `Reservation.currency` and `FolioLine.currency` are **snapshots on historical rows** and are
  never touched.

**Why not enforce it with a CHECK or FK?** A cross-table CHECK is not expressible in
PostgreSQL, and a composite FK on `(currency)` would require `property` to have a unique index
on `(id, currency)` and would cascade a currency change into every child row. Validation at the
service boundary plus the drift report is the proportionate control. [PROPOSED; the alternative
is a trigger, which this repository uses nowhere.]

### B.2 `RatePlan.defaultRateMinor` vs `RoomType.baseRateMinor`

The duplication is real and temporary. Its lifecycle, with the authority stated per window:

| Window | Authoritative | Drift possible? |
|---|---|---|
| B1–B2 | `RoomType.baseRateMinor` | No — plan tables exist but hold no rows |
| B3 (backfill instant) | both, forced equal | No — the migration sets them equal |
| **B3 → B7** | `RoomType.baseRateMinor` | **Yes.** Editing a plan changes nothing a guest pays. This is exactly what D-2's flag exists to prevent an operator from doing |
| B7 onward | `RatePlan.defaultRateMinor` | No |
| After B7 | `RoomType.baseRateMinor` is vestigial | Must become read-only in the room-type service, then dropped in a later, separate migration |

`RoomType.baseRateMinor` is **not dropped in B1 or B7.** It is referenced through
`QuoteInput.baseNightlyRateMinor` [CODE: `reservation-pricing.ts:60`] and may be read by report
queries; dropping it is its own review.

### B.3 Effective-price resolution

```
effectiveRateMinor(plan, stayDate) :=
    day.rateMinor          if a RatePlanDay row exists for (plan, stayDate)
                              AND day.rateMinor IS NOT NULL
    plan.defaultRateMinor  otherwise
```

- A **pure function** of `(plan, day)` — no clock, no database — matching
  `reservation-pricing.ts`, which is already pure [CODE: its header states "Pure functions, no
  database, no clock"]. Unit-testable without a container.
- **Resolution does not consider restrictions.** A `stopSell` or `closedToArrival` date still
  has a price. Sellability and price are independent facts; conflating them would make
  "closed but priced at X" unreportable to a channel that wants both.
- **Archived/inactive plans are not resolved at all** — the caller must exclude them before
  asking for a price. See §G question 1.
- **B1 ships none of this.** The resolver is B5/B7 code. It is specified here so the schema can
  be judged against its intended use.

### B.4 Null versus zero

| `rateMinor` | Meaning | Resolution |
|---|---|---|
| `NULL` | **No override for this date.** The row exists only to carry restrictions | Falls back to `plan.defaultRateMinor` |
| `0` | **A genuinely free night** (complimentary, a staff stay) | Resolves to `0` |
| `> 0` | A priced override | Resolves to itself |

This is why the column is nullable rather than `@default(0)`, and
`rate_plan_day_rate_non_negative` permits `0` while forbidding negatives. Both branches get an
explicit acceptance test (§E.7), because an implementation that treats `0` as "unset" would
silently charge the rack rate for a complimentary night — a money bug, not a display bug.

`Reservation.isTaxExempt` already exists [CODE: `schema.prisma:869`] and is orthogonal: a free
night and an exempt stay are different things.

### B.5 Inactive and archived plans

Excluded from any sellable or publishable context; included in historical reads. B1 enforces
only the `isActive` ⟺ `archivedAt` coherence CHECK; the exclusion is service behaviour from B5
onward. §G question 1 states the residual risk honestly.

### B.6 Snapshot preservation

**Nothing in B1 reads or writes a reservation or a folio.** The snapshots that must survive,
and why they do:

| Snapshot | Evidence it is a stored snapshot, not derived |
|---|---|
| `Reservation.totalAmountMinor`, `taxAmountMinor`, `currency` | [CODE] stored columns, `schema.prisma:827-828` |
| `Reservation.isTaxExempt` | [CODE] `:869` — recorded "so an exempt stay is never taxed later by a derivation" |
| `FolioLine.amountMinor`, `currency`, `chargeDate` | [CODE] `:1513-1521`; lines are immutable with reversal semantics (§3.4) |

A later rate change therefore cannot alter a booked stay, and that property holds **before**
Phase B and must hold after. `RatePlanDay` rows for past dates are never edited or deleted by
any job.

### B.7 Day-one vs deferred

| Required day one (in B1's schema) | Deferred, with reason |
|---|---|
| `code`, `name`, `roomTypeId`, `mealPlan`, `isRefundable`, `defaultRateMinor`, `sortOrder`, `isActive`, `archivedAt` | **Derived/linked rates** (NR = BAR − 10%): needs a derivation source, cycle detection, recomputation on parent change. [UNRESOLVED G-4] |
| `RatePlanDay`: `rateMinor` + the five restrictions | **Occupancy pricing** (extra adult, child): a per-occupancy rate table, not a column. [UNRESOLVED G-3] |
| `standardOccupancy` as a single integer | Promotions, `validFrom`/`validTo`, advance-booking restrictions, `ratePlanType` — no product requirement, and each presupposes a distribution model |

---

## C. Migration and preservation

**No migration file is created by this task.** What follows describes one for your review.

### C.1 Proposed migration shape

Directory: `packages/database/prisma/migrations/<timestamp>_rate_plan/migration.sql`, with the
banner-comment header the repository uses — stating effect on existing rows, why it is
additive, and what is deliberately absent [CODE: the convention at
`migrations/20261019080000_property_configuration/migration.sql:1-40`].

Statement inventory, all additive:

| Kind | Count | Detail |
|---|---|---|
| `CREATE TABLE` | 2 | `rate_plan`, `rate_plan_day` |
| `CREATE INDEX` | 2 | the two `@@index` |
| `CREATE UNIQUE INDEX` | 4 | 2 Prisma uniques + 1 `rate_plan_day` unique + `rate_plan_property_id_unique_pair` |
| `ALTER TABLE … ADD CONSTRAINT` (FK) | 4 | 3 single-column Prisma FKs + 2 composite — see note |
| `ALTER TABLE … ADD CONSTRAINT` (CHECK) | 4 | §A.4 |
| `CREATE TYPE` | **0** | `MealPlan` already exists [CODE: `schema.prisma:80`] |
| `DROP` / `TRUNCATE` / `DELETE` / `UPDATE` of an existing table | **0** | — |

No existing table is altered. No existing column is renamed, retyped or dropped.

### C.2 The operational hazard: migrate-diff drift

**This is the single most error-prone step and it must be in the migration's header.**

The 11 composite FKs and 6 `unique_pair` indexes are hand-written and absent from
`schema.prisma` [CODE: verified]. Consequently `prisma migrate diff` already reports them as
drift — measured today: **29 lines, 11 "Added foreign key" + 6 "Added unique index", nothing
removed or changed**. Any `prisma migrate dev` run will generate SQL that **drops them**.

So the procedure for B1 is, and this is not optional:

1. Generate the diff.
2. **Strip every `DROP CONSTRAINT` and `DROP INDEX` for an existing table** — previously 17
   such statements had to be stripped for the outbox migration; after B1 the standing count
   becomes **19** (one more composite FK target and one more `unique_pair`).
3. Append the hand-written block from §A.4.
4. Re-verify with the `pg_constraint` / `pg_indexes` queries in §C.4 that the pre-existing 11
   FKs and 6 indexes are **still present**, not merely that the new ones arrived.

A migration that silently drops `inventory_day_same_property_as_room_type` or
`reservation_room_no_overlap` would remove a §3.1 guarantee while every test still passed, so
step 4 is the control that matters.

### C.3 The BAR backfill

One plan per existing room type, inside the same migration, as `INSERT … SELECT` from existing
data:

```sql
INSERT INTO "rate_plan" (
  "id","propertyId","roomTypeId","code","name","description",
  "mealPlan","isRefundable","standardOccupancy","defaultRateMinor",
  "sortOrder","isActive","archivedAt","createdAt","updatedAt")
SELECT
  gen_random_uuid(), rt."propertyId", rt."id",
  'BAR', 'Best Available Rate',
  'Backfilled from room type rack rate when rate plans were introduced.',
  'EP'::"MealPlan", true, 2, rt."baseRateMinor",
  rt."sortOrder", true, NULL, now(), now()
FROM "room_type" rt;
```

Expected: **92 rows** (the live `room_type` count [CODE]). No `rate_plan_day` rows.

Why each value is what it is:

- `defaultRateMinor := rt."baseRateMinor"` — the whole point. **It cannot violate
  `rate_plan_rate_and_occupancy_sane`**, because `room_type_rate_and_occupancy_sane` already
  guarantees `baseRateMinor >= 0` [CODE: live constraint definition]. That is a verified
  migration-safety fact, not an assumption.
- `'EP'` and `isRefundable = true` — the most conservative reading of a bare rack rate: room
  only, cancellable. Both are **[UNRESOLVED G-1/G-2]** as *business* facts; the backfill makes
  them explicit and editable rather than implied.
- `standardOccupancy = 2` — D-1-adjacent default, per §A.2.
- `gen_random_uuid()` — available in PostgreSQL 17 core [CODE: server is 17.6]; the existing
  outbox migration already relies on it.
- `'BAR'` as a constant **cannot work.** One row per room type, with `(propertyId, code)`
  unique, means a property with several room types gets several rows carrying code `BAR` —
  which violates the unique constraint.

**That is a real defect in document 14's backfill, found and then measured while writing this
plan.** `(propertyId, code)` is unique per *property*, but the backfill inserts one plan per
*room type*. Measured on the live dev database today:

```
 properties | properties_with_multiple_room_types | max_room_types | total_room_types
         21 |                                  21 |             10 |               92
```

**All 21 properties** have more than one room type, up to 10. So 92 inserts would attempt to
produce at most 21 distinct codes and the migration would abort on the first property with
`23505`. This is not an edge case — it fails everywhere, immediately. Options, needing your decision:

| Option | Code shape | Consequence |
|---|---|---|
| **C-a** (recommended) | `'BAR-' \|\| rt."code"` e.g. `BAR-DLX` | Unique per property; readable; ties the plan to its category |
| C-b | Make the unique `(propertyId, roomTypeId, code)` | Allows `BAR` everywhere, but then a "code" is no longer a property-wide identifier, which weakens it as a future mapping key |
| C-c | One plan per property, not per room type | Contradicts "a plan prices exactly one room type" (§A.2) |

I recommend **C-a** and have **not** changed §A.2's unique constraint. [UNRESOLVED until you
choose.]

### C.4 Verification — queries to run, not executed here

**Pre-migration baseline** (capture and keep):

```sql
SELECT count(*) FROM room_type;                   -- expect 92
SELECT count(*) FROM reservation;                 -- expect 952
SELECT count(*) FROM inventory_day;               -- expect 46996
SELECT count(*) FROM folio_line;                  -- expect 200
SELECT count(*) FROM property;                    -- expect 21
SELECT count(*) FROM inventory_day
 WHERE sold + blocked > physical + "overbookingAllowance";   -- expect 0
SELECT count(*) FROM pg_constraint WHERE contype='f' AND array_length(conkey,1)=2; -- expect 11
SELECT count(*) FROM pg_indexes
 WHERE schemaname='public' AND indexname LIKE '%unique_pair%';                     -- expect 6
SELECT count(*) FROM pg_constraint WHERE contype='x';                              -- expect 1
SELECT md5(string_agg(id || ':' || "totalAmountMinor" || ':' || "taxAmountMinor", ','
       ORDER BY id)) FROM reservation;            -- the price-preservation fingerprint
SELECT md5(string_agg(id || ':' || "amountMinor", ',' ORDER BY id)) FROM folio_line;
```

**Post-migration assertions:**

| Check | Expected |
|---|---|
| All nine counts above | **Unchanged** |
| Both reservation and folio_line fingerprints | **Byte-identical** |
| Composite FKs | **13** (11 pre-existing + 2 new) |
| `unique_pair` indexes | **7** (6 + 1) |
| Exclusion constraints | **1**, unchanged |
| `rate_plan` rows | 92, exactly one per room type: `SELECT count(*) FROM room_type rt WHERE NOT EXISTS (SELECT 1 FROM rate_plan p WHERE p."roomTypeId"=rt.id)` → **0** |
| `rate_plan_day` rows | **0** |
| `defaultRateMinor` fidelity | `SELECT count(*) FROM rate_plan p JOIN room_type rt ON rt.id=p."roomTypeId" WHERE p."defaultRateMinor" <> rt."baseRateMinor"` → **0** |
| Currency coherence | `SELECT count(*) FROM rate_plan p JOIN property pr ON pr.id=p."propertyId" JOIN room_type rt ON rt.id=p."roomTypeId" WHERE rt.currency <> pr.currency` → recorded as a **finding**, not a failure (§B.1) |
| Tenant coherence | `SELECT count(*) FROM rate_plan p JOIN room_type rt ON rt.id=p."roomTypeId" WHERE rt."propertyId" <> p."propertyId"` → **0** (and the composite FK makes it unrepresentable) |
| `prisma migrate status` | "Database schema is up to date" |
| `prisma validate` | valid |
| Existing suites | `test:concurrency`, `test:checkin`, `test:outbox`, `test:outbox:concurrency`, `test:outbox:redis` all pass |

### C.5 Rollback and recovery

**This repository has no down migrations.** The convention is explicit: *"Migrations are never
edited after merge; roll forward instead"* [CODE: CLAUDE.md §4].

| Stage | Reversibility | Mechanism |
|---|---|---|
| Tables + constraints, **before** the backfill | **Clean** | `DROP TABLE rate_plan_day, rate_plan` — no existing table is touched, so nothing else is affected |
| **After** the backfill, before any operator edit | **Clean in practice** | The 92 rows are identifiable (`code LIKE 'BAR%'`, `rate_plan_day` empty) and unreferenced |
| After any operator creates or edits a plan or a day row | **NOT cleanly reversible** | A `DROP TABLE` destroys real configuration work. Recovery is **restore from `pg_dump`**, not a down migration |
| After B6 adds `OutboxEventType` values | **Enum additions are permanent** | PostgreSQL cannot drop an enum value. Harmless but irreversible. Not a B1 concern; stated for the record |

**Required before applying B1 to any database holding work:** a `pg_dump -Fc` taken and
verified restorable with `pg_restore -l`. That is the only honest rollback for anything past
the backfill.

### C.6 Preservation of pre-existing uncommitted work

Baseline captured before this task: **64 entries — 31 modified tracked files, 33 untracked.**

B1 must be built **on top of** the uncommitted `schema.prisma` (which already contains the
property-configuration models `PropertySettings`, `PropertyTaxSlab`, `PropertyMedia`,
`Amenity`, `PropertyAmenityLink`, `PropertyPolicy`, `FeeAndSurcharge`, plus the outbox
models). The two new models are **appended**; nothing above them is edited.

Specifically not to be touched: `packages/database/src/client-factory.ts` (the timezone fix),
the five uncommitted migration directories, and every file under
`apps/web-admin/src/components/property-config/`.

---

## D. Inventory-calendar lifecycle — prerequisite, explicitly NOT in B1

**B1 implements none of this.** It is recorded as a named prerequisite that must complete
before any availability is published to any provider. Full specification is
`15-phase-b-design-review.md` §1; what follows is the summary plus the code evidence, because
the brief rightly asks that no algorithm be asserted safe without it.

### D.1 Why it is a prerequisite

`InventoryDay.physical` is documented as "Sellable rooms of this type on this date, excluding
OUT_OF_ORDER" [CODE: `schema.prisma:745`], but **no application code computes it** — every
application writer is an `updateMany` on `sold`, and the only `createMany`/`deleteMany` are in
`seed.ts` and `seed-portfolio.ts` [CODE]. So `physical` can be arbitrarily stale, and
publishing availability derived from it would broadcast that staleness to an OTA.

### D.2 Required properties, with the evidence each rests on

| Requirement | Evidence it is implementable safely |
|---|---|
| **Idempotent initialisation and extension** | `inventory_day_unique_per_date` on `(propertyId, roomTypeId, stayDate)` [CODE: live] makes `INSERT … ON CONFLICT DO NOTHING` idempotent and race-safe. **`DO NOTHING`, never `DO UPDATE`** — an upsert here is the mechanism that would reset a counter |
| **Never reset or decrement `sold`/`blocked` during construction** | Construction inserts only. `DO NOTHING` cannot modify an existing row, so an existing `sold` is untouchable by it |
| **Never silently clamp `physical`** | A rebuild computes `target` from `Room` and compares against `sold + blocked − overbookingAllowance`. If `target` is lower it **collects a conflict and writes nothing**. Clamping upward to make the CHECK pass would invent capacity, which §6.2 forbids |
| **Detect conflicts and stop** | All-or-nothing per scope: any conflicting date rolls the whole transaction back and returns the conflicting dates with their counters |
| **Concurrency-safe** | `inventory_day_not_oversold` (`sold + blocked <= physical + overbookingAllowance`) and `inventory_day_counters_non_negative` are the backstops [CODE: live definitions]. A rebuild reads `sold` under `FOR UPDATE`, so its floor is never stale |
| **Consistent lock order** | **Verified, not assumed:** booking locks `FOR UPDATE … ORDER BY "stayDate" ASC` [CODE: `create-reservation.service.ts:262-271`]; a category change locks both room types `ORDER BY "stayDate" ASC, "roomTypeId" ASC` [CODE: `room-move.service.ts:259-266`]. Both lead with `stayDate`, so **no lock-order inversion exists between the two existing writers**. Any new writer must join that order |
| **No publication from missing or unverified inventory** | A date with no row emits nothing. A booking for such a date already fails loudly [CODE: `create-reservation.service.ts:276-283`], and the gap is reported by §D-4 rather than papered over |

### D.3 Two hazards recorded from code inspection

- **The room-move decrement is guarded, the increment is not.** `sold: { gt: 0 }` on the source
  row [CODE: `room-move.service.ts:273`] means that if a source row's `sold` were already 0 the
  decrement silently no-ops while the target increment still applies — net +1 sold. Unreachable
  today because nothing resets `sold`; reachable the instant a lifecycle job touches it. This is
  the concrete reason for "no lifecycle code writes `sold`, ever".
- **There is no cancellation write path at all.** `CANCELLED`/`NO_SHOW` appear only as read
  filters, check-in blockers and report columns; no service sets `cancelledAt` or decrements
  `sold` [CODE: searched all of `apps/api/src/modules`]. So availability is never released
  today, and whoever implements cancellation must also bump the ARI revision or the OTA will
  under-sell — the quieter failure, and therefore the easier one to ship broken.

---

## E. Acceptance tests

Format: **invariant → setup → action → expected**. All run against a real PostgreSQL per §5,
in the repository's existing `.mjs` convention under `test/`.

### E.1 Existing data and price preservation

- **Invariant:** the migration changes no existing row.
- **Setup:** capture the nine counts and both md5 fingerprints from §C.4 on the current database.
- **Action:** apply the B1 migration including the backfill.
- **Expected:** every count unchanged; both fingerprints **byte-identical**; 0 oversold rows;
  `reservation`, `folio`, `folio_line`, `inventory_day`, `room`, `room_type` all untouched by
  `xmin` comparison on a sampled 100 rows.

### E.2 Tenant isolation

- **Invariant:** a plan is reachable only through its own property.
- **Setup:** two properties A and B, each with a room type and a backfilled plan.
- **Action:** authenticate as a user granted only on A; read, update and archive B's plan by id.
- **Expected:** **404 on all three**, never 403 — matching `TenantScopeViolationError`'s
  existing use [CODE: `property-setup.service.ts:750`]. A 403 would confirm the row exists.

### E.3 Composite foreign keys

- **Invariant:** a plan cannot reference another property's room type; a day row cannot
  reference another property's plan.
- **Setup:** properties A and B with room types RT-A and RT-B.
- **Action:** raw `INSERT` into `rate_plan` with `propertyId = A`, `roomTypeId = RT-B`; then a
  raw `INSERT` into `rate_plan_day` with a mismatched `propertyId`.
- **Expected:** both rejected with SQLSTATE **`23503`**, read via the three-place extraction in
  `apps/api/src/common/errors/sql-state.ts` [CODE] — Prisma wraps a raw failure as `P2010`, so
  reading `error.code` alone would miss it.

### E.4 Uniqueness

- **Invariant:** codes and names do not collide, and archiving does not free a code.
- **Setup:** a property with a plan `code='BAR-DLX'`, archived.
- **Action:** insert a second plan with the same code; separately, two day rows for one
  `(plan, stayDate)`.
- **Expected:** both rejected with **`23505`**. The archived plan's code remains taken.

### E.5 Archive behaviour

- **Invariant:** `isActive = false` ⟺ `archivedAt IS NOT NULL`.
- **Setup:** an active plan.
- **Action:** four raw updates — `isActive=false` alone; `archivedAt=now()` alone;
  both together; both cleared together.
- **Expected:** the first two rejected with **`23514`**
  (`rate_plan_archive_matches_active`); the last two accepted.

### E.6 Currency and minor units

- **Invariant:** money is an integer in the property's currency's minor unit.
- **Setup:** a property with `currency='INR'`.
- **Action:** raw `INSERT` with `defaultRateMinor = -1`; then `= 0`; then `= 350000`.
- **Expected:** `-1` rejected **`23514`**; `0` and `350000` accepted. **Plus a static check:**
  `rate_plan` has no `currency` column, and no float or `Decimal` column (§3.4 bans Decimal for
  money).

### E.7 Null versus zero

- **Invariant:** `NULL` means "no override"; `0` means "free night".
- **Setup:** a plan with `defaultRateMinor = 350000`, and two day rows — one with
  `rateMinor = NULL`, one with `rateMinor = 0`.
- **Action:** call the pure resolver (§B.3) for both dates and for a third date with no row.
- **Expected:** `350000`, **`0`**, `350000`. A resolver that returned `350000` for the zero row
  would be charging a complimentary night at rack rate; this test is the guard.

### E.8 Migration compatibility and rollback limitation

- **Invariant:** the migration is additive, and the pre-existing hand-written constraints
  survive it.
- **Setup:** the baseline constraint census from §C.4 (11 composite FKs, 6 `unique_pair`, 1
  exclusion, `inventory_day_not_oversold` present).
- **Action:** apply the migration; then, on a disposable copy, `DROP TABLE rate_plan_day,
  rate_plan`.
- **Expected:** after apply — 13 / 7 / 1, and `inventory_day_not_oversold` and
  `reservation_room_no_overlap` **still present**; `prisma migrate status` up to date. After the
  drop — the nine baseline counts unchanged, proving the pre-backfill rollback is clean.
  **Documented limitation:** this test proves reversibility only while no operator has edited a
  plan; past that point the test is not re-runnable and recovery is dump-restore.

### E.9 Existing regression suites

- **Invariant:** Phase B1 changes no existing behaviour.
- **Setup:** none beyond the migration being applied.
- **Action:** `pnpm test:concurrency`, `test:checkin`, `test:outbox`,
  `test:outbox:concurrency`, `test:outbox:redis`; plus `pnpm typecheck`, `lint`, `build`.
- **Expected:** all pass, **unmodified**. The parallel-booking suite in particular must prove
  the oversell guarantee is untouched. None of these suites may be edited or skipped.

### E.10 Later pricing-switch regressions (B7, recorded now)

- **Invariant:** switching the price source moves no figure.
- **Setup:** the backfilled state — every plan's `defaultRateMinor` equals its room type's
  `baseRateMinor`, and `rate_plan_day` is empty.
- **Action:** quote a stay before and after the switch, for every room type.
- **Expected:** identical `nightlyRateMinor`, `exTaxMinor`, `taxMinor`, `totalMinor`,
  `taxRatePercent` and nightly breakdown. `test:checkin` must pass unchanged, proving no folio
  figure moved.
- **[UNRESOLVED] — a wire-contract problem found during this review:**
  `reservationQuoteSchema` carries a **top-level scalar `nightlyRateMinor`** alongside the
  `nightly[]` array [CODE: `packages/types/src/dto/create-reservation.dto.ts:191-230`], and the
  admin UI consumes it in four places, including seeding the rate-override input and a "Per
  night (pre tax)" row [CODE: `apps/web-admin/src/components/calendar/create-reservation-modal.tsx:364,
  860, 862, 1051`]. Once per-date rates exist, a single flat value is ambiguous. B7 must decide
  whether it becomes the first night's rate, an average, or is deprecated — and that is a
  breaking response change for `web-admin`. **Not a B1 problem, but it must not be discovered
  during B7.**

---

## F. Phase gates

No gate includes a real OTA integration, credentials, or any external network call.

| Gate | Entry criteria | Depends on | Acceptance | Excluded |
|---|---|---|---|---|
| **G1 — B1 schema + migration** | Your approval of §A, §C and the C-a code decision; `pg_dump` taken and verified | — | E.1–E.9 pass; 13 composite FKs; 7 `unique_pair`; fingerprints identical | Any service, endpoint, resolver, outbox producer or pricing change |
| **G2 — Inventory-calendar prerequisite** | G1 complete; D-1 horizon approved | G1 | `15-…` AC-1.1–AC-1.9; rebuild refuses rather than clamps; `test:concurrency` byte-identical; `PropertySettings.inventoryHorizonDays` added | Any ARI publication; any write to `sold` or `blocked` |
| **G3 — BAR backfill verification** | G1 applied | G1 | 92 plans, one per room type; 0 `defaultRateMinor` mismatches; 0 `rate_plan_day` rows | Editing any backfilled plan while D-2's flag is off |
| **G4 — ARI contract types** | G1 | — | `test:ari:contract` rejects: `to < from`, a date outside the window, duplicate dates, `AVAILABILITY` with a plan id, `RATE` without one, `minLOS > maxLOS`, `DELTA` from a producer | Any producer, handler or provider |
| **G5 — Feature-flagged rates API** | G1, G3; flag mechanism decided (U-4) | G1 | Reads work and are tenant-isolated (404); **writes return 404 while the flag is off**; every mutation writes an `audit_log` row in the same transaction (§3.4 names rates explicitly) | Enabling writes before G7 |
| **G6 — Sync state + fake-provider tests** | G2 complete (availability must not be published from unverified inventory); G4 | G2, G4 | `test:ari:ordering`, `test:ari:idempotency`, `test:ari:outbox` pass; `SUPERSEDED` consumes no attempt; the handler performs **zero** writes to `inventory_day` or reservations; per-scope lease prevents two concurrent pushes for one scope | Any real provider; any delta producer |
| **G7 — Pricing switch (separately approved)** | **Your explicit, separate approval.** G1, G3, G5 | G3 | E.10 passes: every quote identical; `test:checkin` and `test:concurrency` unchanged; the `nightlyRateMinor` wire decision made | Enabling writes before the quote-identity test passes |
| **G8 — Report-only reconciliation + alerting** | G6 | G6 | Drift detected; **zero writes** to business data, asserted by row-count and checksum comparison; lag visible per scope | Recurring scheduling until ownership and alerting are defined (D-4) |

**G2 before G6 is the one non-negotiable ordering constraint:** publishing availability from an
uncomputed `physical` projection would broadcast staleness to a channel.

---

## G. Self-review

**1. Can an inactive or archived plan accidentally be sold?**
In B1, no — nothing sells anything, because no service exists. From B5/B7, **only if a caller
forgets to filter.** The schema does not prevent it: there is no database-level way to make a
price resolver skip an inactive plan, and the resolver (§B.3) deliberately does not consult
`isActive` so that sellability and price stay separate concerns. **Mitigation:** every
booking- and projection-path query must carry `isActive: true`, the composite index
`(propertyId, roomTypeId, isActive, sortOrder)` makes that the cheap path, and E.2-style tests
must assert it when those paths exist. **Residual risk, stated: convention, not constraint.**

**2. Can a plan reference another property's room type?**
**No.** `rate_plan_same_property_as_room_type` makes it unrepresentable, and
`room_type_property_id_unique_pair` — which it requires — **already exists** [CODE]. Likewise
`rate_plan_day_same_property_as_plan` for day rows. This is mechanical, not conventional, which
matters because neither §3.2 backstop exists: `createPrismaClient()` applies no tenancy
extension and the 14 `set_config('app.current_property_id')` calls are no-ops without RLS
policies [CODE].

**3. Can the migration silently change existing prices or reservation totals?**
**No, and it is provable.** The statement inventory contains zero `UPDATE`, `DELETE`,
`TRUNCATE` or `DROP` against an existing table (§C.1); the only write is `INSERT … SELECT` into
a brand-new table. The md5 fingerprints over `reservation(totalAmountMinor, taxAmountMinor)`
and `folio_line(amountMinor)` are the mechanical proof (§C.4, E.1). `RoomType.baseRateMinor` is
read, never written.

**4. Is currency ownership unambiguous?**
**In the design, yes** — `Property.currency` (§B.1), with `RatePlan` carrying no currency
column. **In the database, not yet:** `RoomType.currency` still exists and B1 neither drops nor
reads it, so two columns remain where one is authoritative. That is a deliberate scope
boundary, surfaced by the §C.4 coherence query as a *finding* rather than a failure. **Honest
answer: unambiguous by policy, not yet by schema.**

**5. Can B1 affect allocation or inventory counters?**
**No.** B1 adds two tables that no allocation path reads, and touches no existing table.
`inventory_day`, `sold`, `blocked`, `physical`, `inventory_day_not_oversold` and
`reservation_room_no_overlap` are all untouched. `test:concurrency` passing byte-identically is
the acceptance proof (E.9). The inventory lifecycle — the only part of Phase B that writes
inventory — is explicitly excluded (§D).

**6. Are the constraints compatible with the actual schema?**
**Yes, each verified against the live database today:** the composite FK form is copied from
`room.room_same_property_as_room_type`; its target index `room_type_property_id_unique_pair
(id, "propertyId")` exists; single-column Prisma FKs coexisting with a composite FK is the
established pattern (`inventory_day` has three FKs); grouped CHECK naming matches
`room_type_rate_and_occupancy_sane`; `gen_random_uuid()` is available on PostgreSQL 17.6;
`MealPlan` already exists so no `CREATE TYPE` is needed. **One incompatibility was found and
is unresolved: the `BAR` code collides under `(propertyId, code)` when a property has several
room types** — §C.3, options C-a/C-b/C-c.

**7. Are the rollback limitations accurate?**
**Yes, and they are worse than document 14 implied.** There are no down migrations in this
repository [CODE: CLAUDE.md §4 "roll forward instead"]. `DROP TABLE` is clean only until an
operator edits a plan; after that, recovery is dump-restore. Enum additions (B6, not B1) are
permanently irreversible in PostgreSQL. A `pg_dump -Fc`, verified with `pg_restore -l`, is
required before applying.

**8. Are pre-existing changes preserved?**
**Yes.** Baseline recorded: 64 git entries (31 modified, 33 untracked). This task created one
file and modified nothing. B1, when authorised, appends two models to the **uncommitted**
`schema.prisma` and must not edit the property-configuration models, the five uncommitted
migration directories, or `client-factory.ts`'s timezone fix.

**9. What still requires approval?**
§H.

---

## H. Open items

### Requires your approval before B1 can be implemented

| # | Item | Blocking? |
|---|---|---|
| **H-1** | The `BAR` code collision — choose **C-a** (`BAR-<roomTypeCode>`), C-b or C-c (§C.3) | **Yes.** The backfill fails without it |
| **H-2** | D-1: 180-day horizon, configurable via `PropertySettings.inventoryHorizonDays` (lands in G2, not B1) | No for B1 |
| **H-3** | D-2: writes return **404** while flagged off; reads may be enabled | No for B1 |
| **H-4** | D-3: `Reservation.ratePlanId` deferred to B7 | No for B1 |
| **H-5** | D-4: reconciliation report-only, manual or controlled-job, no recurring schedule yet | No for B1 |
| **H-6** | `mealPlan='EP'` and `isRefundable=true` as backfill values (§C.3) | **Yes** — they become visible operator-facing data |
| **H-7** | Confirmation that `pg_dump` is taken before applying | **Yes** |

### Unresolved, not guessed

| # | Item |
|---|---|
| **U-1** | Should `MealPlan` gain `BB`/`HB`/`FB`? No provider contract confirmed |
| **U-2** | Does `standardOccupancy` belong on the plan, or only on a future occupancy-price table? |
| **U-3** | Plan-level LOS defaults with day-level override — precedence undefined, no requirement |
| **U-4** | The feature-flag mechanism; no flag facility exists in the repository |
| **U-5** | The flat `quote.nightlyRateMinor` wire contract under per-date rates (§E.10) — a breaking `web-admin` change, due in B7 |
| **U-6** | Business: G-1 multiple plans per room type day one; G-2 meal plan on plan or booking; G-3 occupancy pricing; G-4 derived rates; G-5 which restriction types the channels need; G-6 reconciliation ownership |
| **U-7** | Provider: G-7 per-plan vs room-type restrictions; G-8 payload/range limits; G-9 availability scope; G-10 does any provider support a conditional/versioned write |
