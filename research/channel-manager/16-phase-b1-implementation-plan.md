# Phase B1 — Implementation-Ready Plan: RatePlan Schema and Migration

**Status:** plan only. Not authorised for implementation. No application code, Prisma schema,
migration, package file, database row or business datum was changed to produce it.
**Date:** 2026-10-26
**Revised:** 2026-10-27 — **H-1 approved** (`BAR-<room-type-code>`), **H-6a approved** (`EP`;
`RoomType.baseRateMinor` is room-only for every property). **H-7 remains unapproved.**
**Revised again:** 2026-10-27 — **`RatePlan.isRefundable` is removed from the B1 design.**
`PropertyPolicy` remains the single source of truth for cancellation terms for the first release,
and no cancellation term is duplicated onto `RatePlan`. The field was never implemented, and no
confirmed requirement for rate-plan-specific cancellation policy exists in the repository
(§C.3a). Activation of rate-plan-based selling is gated by an **application-level** precondition,
not a CHECK constraint, because the precondition spans two tables — stated plainly in §C.3b.
Changed sections: §A.2, §A.4, §B.2, §B.5, §C.3, §C.3a, §C.3b, §C.4, §C.6, §E.5, §F, §G, §H.
**Revised a third time:** 2026-10-27 — **five business decisions confirmed** (BD-1…BD-5, §H), of
which one *changes* an earlier recorded position: a property with **no** cancellation policy now
falls back to a **separately defined fallback policy**, rather than being blocked from activation.
§C.3b is rewritten around an **effective policy** — the property's own, or the fallback — that must
be **approved** before selling. The fallback's own terms and governance are **unresolved**.
Changed again in: §A.2, §C.3, §C.3b, §H.
**Builds on:** `14-phase-b-rateplan-and-sync-contract.md` (proposal),
`15-phase-b-design-review.md` (correction). Neither is rewritten: on 2026-10-27 each gained an
**additive** supersession pointer in its header (and 15 one inline note), so no original claim in
either was altered or removed. Document 17 §8 records which claims those pointers cover.
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

  // NO refundability column, deliberately [DECIDED 2026-10-27].
  //
  // Cancellation terms live on `PropertyPolicy` - `freeCancellationHours` and
  // `retentionChargePercent` [CODE: schema.prisma:1401-1404] - and are not
  // duplicated here. Two homes for one commercial fact is how they drift, and
  // nothing in the repository requires a per-plan cancellation policy (C.3a).
  // If a non-refundable plan alongside a refundable one is ever a real
  // requirement, it arrives as its own reviewed change, not as a column
  // speculatively added now.
  //
  // Written with `//` and not `///` on purpose: a `///` block documents the
  // NEXT declaration, so as a doc comment it would silently become
  // `standardOccupancy`'s description in the generated client.

  standardOccupancy Int @default(2)

  /// Fallback nightly rate in the PROPERTY's currency minor unit. Authoritative
  /// for any date with no RatePlanDay override.
  defaultRateMinor Int

  sortOrder Int @default(0)

  /// Sellable. The **backfill sets this false** (§C.3): a plan may not be sold
  /// until an **approved effective cancellation policy** exists for its property
  /// — the property's own policy, or the separately defined fallback (BD-4) —
  /// and that precondition is checked in the activation service, not here. See
  /// §C.3b for why a CHECK constraint cannot express it.
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
| `code` | `text` | no | Operator-facing, e.g. `BAR-DLX`. Unique per property. Shape **approved 2026-10-27** (H-1) | authoritative |
| `name` | `text` | no | Display name. Unique per `(property, roomType)` | authoritative |
| `description` | `text` | yes | Optional operator note | authoritative |
| `mealPlan` | `MealPlan` enum | no | What the guest gets. **No default** — `EP` is an explicit decision, **approved 2026-10-27** (H-6a): `RoomType.baseRateMinor` is room-only, no breakfast, for every property | authoritative |
| ~~`isRefundable`~~ | — | — | **Removed from the design 2026-10-27.** Cancellation terms stay on `PropertyPolicy`, which holds **structured** terms and not only prose: `freeCancellationHours Int?` and `retentionChargePercent Decimal?`, with the CHECK `property_policy_retention_in_range` [CODE: `schema.prisma:1401-1404`; `20261019080000_property_configuration/migration.sql:319-324`]. This also corrects this document's earlier description of that model as holding "prose policy" | n/a |
| `standardOccupancy` | `int` | no, dflt `2` | The occupancy the price is quoted for. **2 because Indian hotel tariffs are conventionally quoted per double room**; explicit so single-occupancy is representable. Not occupancy *pricing* — see §B.7 |
| `defaultRateMinor` | `int` | no | Fallback nightly rate, minor units | authoritative from B7; see §B.3 |
| `sortOrder` | `int` | no, dflt `0` | Display order. Mirrors `RoomType.sortOrder` [CODE: `:668`] |
| `isActive` | `boolean` | no, dflt `true` | Sellable flag. **Backfilled `false`** — selling is enabled per property only once an **approved effective cancellation policy** exists: its own policy, or the separately defined fallback (BD-4), in either case approved (§C.3b) | authoritative |
| `archivedAt` | `timestamptz(6)` | yes | When retired. Archived ⇒ not sellable, by CHECK; the converse is deliberately *not* enforced, because "not yet activated" is a legitimate third state (§A.4) | authoritative |
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

-- Archiving implies not sellable, but NOT the converse. A biconditional
-- (`("archivedAt" IS NULL) = ("isActive" = true)`, as documents 14 and 15
-- proposed) conflates "retired" with "not yet activated", and would make the
-- backfilled state illegal: a backfilled plan is inactive with no archivedAt,
-- because its property has not yet had its cancellation policy validated.
-- Three states are needed and this is the cheapest way to have them.
ALTER TABLE "rate_plan"
  ADD CONSTRAINT "rate_plan_archived_implies_inactive"
  CHECK ("archivedAt" IS NULL OR "isActive" = false);

-- There is deliberately NO constraint tying activation to a configured
-- cancellation policy. A CHECK cannot reference another table, and the policy
-- lives on property_policy; see C.3b, which states what enforces it instead
-- and is honest about that being weaker than a constraint.

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
| Retire a plan | `isActive = false` **and** `archivedAt = now()`. `rate_plan_archived_implies_inactive` enforces that an archived plan is never sellable; the converse is deliberately allowed, because a backfilled plan is inactive without being archived (§C.3) |
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

Excluded from any sellable or publishable context; included in historical reads. B1 enforces only
`rate_plan_archived_implies_inactive` — archived ⇒ not sellable, **one-directional**, so that
*inactive and not archived* remains legal for a plan whose property has not yet had its
cancellation policy validated (§A.4, §C.3b). The exclusion itself is service behaviour from B5
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
| `code`, `name`, `roomTypeId`, `mealPlan`, `defaultRateMinor`, `sortOrder`, `isActive`, `archivedAt` | **Derived/linked rates** (NR = BAR − 10%): needs a derivation source, cycle detection, recomputation on parent change. [UNRESOLVED G-4] |
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
| `ALTER TABLE … ADD CONSTRAINT` (CHECK) | 4 | §A.4. Back to four: the refundability gate was removed with the column, and `rate_plan_archived_implies_inactive` *replaces* the biconditional rather than adding to it |
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
  "mealPlan","standardOccupancy","defaultRateMinor",
  "sortOrder","isActive","archivedAt","createdAt","updatedAt")
SELECT
  gen_random_uuid(), rt."propertyId", rt."id",
  'BAR-' || rt."code", 'Best Available Rate',
  'Backfilled from the room type rack rate when rate plans were introduced. '
    || 'Not sellable until an approved effective cancellation policy exists '
    || 'for this property.',
  'EP'::"MealPlan", 2, rt."baseRateMinor",
  rt."sortOrder", false, NULL, now(), now()
FROM "room_type" rt;
```

Expected: **92 rows** (the live `room_type` count [CODE]), all with `isActive = false` and
`archivedAt IS NULL`. No `rate_plan_day` rows. **No cancellation-policy column is written,
because the table does not have one.**

Why each value is what it is:

- `defaultRateMinor := rt."baseRateMinor"` — the whole point. **It cannot violate
  `rate_plan_rate_and_occupancy_sane`**, because `room_type_rate_and_occupancy_sane` already
  guarantees `baseRateMinor >= 0` [CODE: live constraint definition]. That is a verified
  migration-safety fact, not an assumption.
- `'EP'` — **approved 2026-10-27 (H-6a)**: `RoomType.baseRateMinor` represents room-only
  pricing, without breakfast, for every property. A recorded business fact rather than the
  inference it was. G-2 (whether meal plan belongs on the plan or the booking) remains open, but
  the *value* is settled.
- **No refundability value at all** — the column is gone (§A.2). The earlier plan to backfill
  `NULL` was still a column asserting that a per-plan answer would eventually exist; the decision
  of 2026-10-27 is that for the first release there is no such thing. Cancellation terms are read
  from `PropertyPolicy`, where they already live.
- `isActive = false` — a plan may not be sold until an **approved effective cancellation policy**
  exists for its property: either the property's own policy or the separately defined fallback
  (BD-4), in both cases explicitly approved (§C.3b). `archivedAt` stays `NULL`: this is *not yet
  activated*, not *retired*, which is exactly why the archive CHECK is one-directional (§A.4).
- `standardOccupancy = 2` — D-1-adjacent default, per §A.2.
- `gen_random_uuid()` — available in PostgreSQL 17 core [CODE: server is 17.6]; the existing
  outbox migration already relies on it.
- `'BAR-' || rt."code"` — **approved 2026-10-27 (H-1)**. A constant `'BAR'` cannot work: one row
  per room type with `(propertyId, code)` unique means a property with several room types would
  get several rows carrying the same code.

**The constant-`'BAR'` defect, measured.** `(propertyId, code)` is unique per *property*, but the
backfill inserts one plan per *room type*. Measured on the live dev database [DB]:

```
 properties | properties_with_multiple_room_types | max_room_types | total_room_types
         21 |                                  21 |             10 |               92
```

**All 21 properties** have more than one room type, up to 10, so 92 inserts would attempt at most
21 distinct codes and the migration would abort on the first property with `23505`. Option **C-a**
(`'BAR-' || rt."code"`) is approved; document 17 §1.1 shows the resulting uniqueness is
*structural* — prefixing an already-unique value with a constant cannot collide — so it does not
depend on today's rows. C-b (widening the unique to `(propertyId, roomTypeId, code)`) and C-c (one
plan per property) are closed.

### C.3a Is there a confirmed requirement for rate-plan-specific cancellation policy?

**No.** Searched, and the absence is the finding:

| Where a requirement would show | Result |
|---|---|
| Prisma schema and all 20-odd migrations | No refundability, cancellation-charge or deposit-rule column on any rate, room-type or reservation table [CODE] |
| `packages/types` DTOs and zod schemas | No such field in any request or response contract [CODE] |
| API services, controllers, web apps | Nothing reads or writes one [CODE] |
| Tests | No test asserts per-plan cancellation behaviour [CODE] |
| Documents 14, 16, 17 | The *only* source — and all three are my own proposals, never a stated requirement |

So the field would have been built for a requirement that does not exist. **It is removed from
the B1 design.** `PropertyPolicy` remains the source of truth for cancellation terms in the first
release, and no cancellation term is duplicated onto `RatePlan`.

**What `PropertyPolicy` actually provides** [CODE: `schema.prisma:1390-1411`]:

| Field | Type | DB-level bound |
|---|---|---|
| `type` | `PolicyType` enum, incl. `CANCELLATION` | — |
| `content` | `text`, the prose | — |
| `freeCancellationHours` | `Int?` | **none** — no CHECK exists on this column [CODE: the only policy CHECK is `property_policy_retention_in_range`]; it is bounded to 0–8760 by the DTO and the UI only |
| `retentionChargePercent` | `Decimal(5,2)?` | `CHECK (NULL OR 0–100)` — `property_policy_retention_in_range` [CODE: `20261019080000_property_configuration/migration.sql:319-324`] |

**What null means in each, from evidence.** The model's own doc comment says: structured terms
"where the policy has them — prose alone cannot be enforced by a cancellation path; these can"
[CODE: `schema.prisma:1401-1402`]. For a non-cancellation row — `HOUSE_RULES`, `AMENDMENT`'s
retention — null therefore verifiably means *this kind of term does not apply to this policy*
(the seed leaves both null on `HOUSE_RULES` and `TERMS_AND_CONDITIONS` [CODE:
`seed-portfolio.ts:282-300`]). For a `CANCELLATION` row, **null's meaning is not established by
the repository**: no code reads either field for a decision, no validation requires them, and
nothing distinguishes "not configured yet" from "no free window / no charge". That is recorded as
unresolved, not guessed — see document 17 §7.

**What would represent "no free cancellation" and "no retention charge."** The value `0` in each,
and it is representable and distinct from null at every layer: `freeCancellationHours` accepts
`0` (`z.number().int().min(0).max(8760)` [CODE: `property-config.dto.ts:280`]; the UI regex
`^\d+$` accepts `"0"` [CODE: `policies-tab.tsx:291-296`]), and `retentionChargePercent` accepts
`0` (`z.number().min(0).max(100)` [CODE: `property-config.dto.ts:28,281`], and the CHECK permits
0). **But no code assigns that meaning**, because no consumer exists. So the honest statement is:
`0` is *available* to mean it, and that `0` means it is a **business decision not yet recorded
anywhere** — not a verified behaviour.

**Why a reference to the policy row is also not the answer.** A `cancellationPolicyId` FK on
`RatePlan` would be a reference rather than a duplicate, so decision 1 would permit it — but it
cannot work against the current write path: `replacePolicies()` **deletes every policy row for
the property and recreates them** on each save [CODE: `property-setup.service.ts:554-559`], so
policy ids are not stable across an edit and any FK would either block the save or dangle. A
stable reference would require changing that write path, which is out of scope and unrequested.
Recorded as unresolved rather than designed.

### C.3b What must pass before a property can enable rate-plan-based selling

**Revised 2026-10-27 by BD-4.** The earlier version of this section said a property with no
cancellation policy is **blocked** from activating. That is no longer the decision: a missing
property policy resolves to a **separately defined fallback policy**. So the gate is not "this
property has configured a policy" but "an **effective policy** exists and has been approved".

**Effective policy, defined** [CONFIRMED by BD-4; the resolution order is the decision, the
fallback's contents are not]:

```
effectivePolicy(property) :=
    the property's own CANCELLATION policy row, where one exists
    the separately defined fallback policy, otherwise
```

Three things this deliberately does **not** do, because BD-4 forbids each: it does not block
activation for a missing policy; it does not substitute an implicit zero; and it does not invent
a default. **The fallback is a thing that must be defined before it can be resolved to**, and its
terms, its scope and who governs it are **[UNRESOLVED]** — U-17. Until the fallback is defined, a
property with no own policy has no effective policy, and therefore still cannot be approved. That
is a consequence of the fallback not existing yet, not a block.

**Proposals exist for it, and they are not confirmed.** On 2026-10-27 a **property-level** scope
and the terms `freeCancellationHours = 48` / `retentionChargePercent = 100` were **proposed**
(P-1…P-3), along with a **dual-approval** model (P-4). They are recorded in document 17 §15 as
**awaiting confirmation**, and they are deliberately **not** reflected in this plan's schema,
migration, backfill or acceptance tests. Until confirmed they decide nothing — in particular not
the fallback's data model, storage, configuration ownership, versioning or approval lifecycle —
and **no value from them may appear in B1's migration SQL or anywhere else.** B1 needs none of
them: it creates two tables and a backfill of inactive plans, and reads no cancellation policy.

**This gate cannot be a CHECK constraint.** The precondition spans tables — the plan, the
property's `property_policy` rows, and whatever holds the approval — and a PostgreSQL CHECK
cannot reference another table. The alternatives are a trigger or a materialised flag, and B1
proposes neither. So the gate is **application-level, and therefore weaker than B1's other
guarantees**, which are constraints. What *is* durable is the three-state shape: a plan can exist
un-activated without being archived (§A.4), so the default state of every backfilled plan is
"cannot be sold".

**The activation endpoint does not exist yet** — B1 adds no endpoints and no services. The checks
below are **[PROPOSED]** for the stage that adds plan activation, recorded now so the backfill's
`isActive = false` has a defined exit:

| # | Check | Status |
|---|---|---|
| V-1 | An **effective policy** resolves for the property: exactly one own `CANCELLATION` row, or — when there is none — the defined fallback. Note there is **no unique constraint on `(propertyId, type)`**, only `@@index([propertyId, type])` [CODE: `schema.prisma:1409`], so the own-policy case must **count** rather than `findFirst`; what two rows mean is **[UNRESOLVED]** — U-14 | [PROPOSED] |
| V-2 | The effective policy's terms are **present**: `freeCancellationHours IS NOT NULL` and `retentionChargePercent IS NOT NULL`. Both columns are nullable and default to null (§C.3a). This proves the fields were filled in, nothing more | [PROPOSED] |
| V-3 | Non-empty prose `content` — already guaranteed for anything saved through the UI [CODE: `policies-tab.tsx` rejects empty content; `replacePoliciesSchema` requires `min(1)`] | [CODE] |
| V-4 | An **approval record** for the effective policy's canonical fingerprint, with actor and timestamp. Document 17 §10 specifies it and recommends a **dedicated approval record** over inferring approval from the audit log. Nothing is implemented | [PROPOSED] |
| V-5 | The plan itself: `archivedAt IS NULL`, `defaultRateMinor` present, room type active | [PROPOSED] |
| V-6 | **Seeded values never constitute an approval.** The seed writes identical terms — `freeCancellationHours = 48`, `retentionChargePercent = '100.00'` — to every property [CODE: `seed-portfolio.ts:259-271`], so they are development fixtures, not a verified commercial policy for any real property. V-4 exists precisely so a human has to say so | [CODE] |
| V-7 | **The fallback, when used, is itself approved.** Resolving to a fallback must not bypass V-4; whether one global approval suffices or each property must accept the fallback is **[UNRESOLVED]** — U-17 | [PROPOSED] |

**And nothing silently falls back on price.** BD-5 and decision 4 of the previous round still
hold, and they are about two different fallbacks — worth separating, because the words collide:

| Fallback | Status |
|---|---|
| **Policy** fallback: a missing cancellation policy resolves to the defined fallback policy | **Confirmed** (BD-4). The point is that terms are always *defined*, never absent |
| **Price** fallback: an un-activated plan silently sold on `RoomType.baseRateMinor` | **Forbidden.** Reservation creation keeps its current path — `solved ?? overrideNightlyRateMinor ?? baseNightlyRateMinor` [CODE: `reservation-pricing.ts:147-148`], consulting no rate plan — until the B7 cutover is implemented and validated. An un-activated plan is **not sellable**, full stop |

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
| Backfilled state | `SELECT count(*) FROM rate_plan WHERE "isActive"` → **0**, and `WHERE "archivedAt" IS NOT NULL` → **0** — every plan un-activated and un-archived (§C.3) |
| No refundability column | `SELECT count(*) FROM information_schema.columns WHERE table_name='rate_plan' AND column_name='isRefundable'` → **0** (§A.2) |
| `property_policy` untouched | Row count and an md5 over `(type, "freeCancellationHours", "retentionChargePercent")` **identical** before and after — B1 reads no policy row and writes none |
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

**Baseline, corrected 2026-10-27.** This document originally recorded a baseline of *64 git
entries (31 modified, 33 untracked)*. That no longer describes the tree: commit **`9061481`**,
made outside the session that wrote this plan, committed 100 of those files — including
`client-factory.ts`'s timezone fix, the property-configuration work and documents 14–16. The
working tree today carries **only documentation changes** (documents 14, 15, 16 modified;
document 17 untracked), so the work this section protects is now **committed rather than
uncommitted**. The instruction is unchanged in substance and easier to honour: B1 appends to what
is already committed and edits none of it.

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

### E.5 Archive behaviour and the three states

- **Invariant:** archived ⇒ not sellable (`archivedAt IS NOT NULL` ⇒ `isActive = false`), while
  *inactive and not archived* stays legal — it is the state every backfilled plan is in.
- **Setup:** a backfilled plan — `isActive = false`, `archivedAt IS NULL`.
- **Action:** raw updates — (a) `archivedAt = now()` while `isActive = true`; (b) `isActive = true`
  alone; (c) `isActive = false, archivedAt = now()` together; (d) both cleared together.
- **Expected:** (a) rejected with **`23514`** (`rate_plan_archived_implies_inactive`); (b), (c) and
  (d) accepted. **(b) is accepted on purpose, and that is the point of this test:** activation is
  *not* constrained by the database, because the cancellation-policy precondition spans two tables
  (§C.3b). The test documents the gap rather than pretending it is closed — the service-level
  check (V-1…V-7) is what refuses activation, and it is tested when that service is built.

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
| **G1 — B1 schema + migration** | Your approval of §A and §C (the C-a code decision is **approved**, H-1); `pg_dump` taken and verified — **H-7, the only open blocker** | — | E.1–E.9 pass; 13 composite FKs; 7 `unique_pair`; fingerprints identical | Any service, endpoint, resolver, outbox producer or pricing change |
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
`MealPlan` already exists so no `CREATE TYPE` is needed. **One incompatibility was found — the
constant `BAR` code collides under `(propertyId, code)` when a property has several room types —
and it is now resolved:** option C-a, `'BAR-' || rt."code"`, approved 2026-10-27 (§C.3, H-1),
with the uniqueness argument in document 17 §1.1 resting on the existing
`(propertyId, code)` unique rather than on today's rows.

**7. Are the rollback limitations accurate?**
**Yes, and they are worse than document 14 implied.** There are no down migrations in this
repository [CODE: CLAUDE.md §4 "roll forward instead"]. `DROP TABLE` is clean only until an
operator edits a plan; after that, recovery is dump-restore. Enum additions (B6, not B1) are
permanently irreversible in PostgreSQL. A `pg_dump -Fc`, verified with `pg_restore -l`, is
required before applying.

**8. Are pre-existing changes preserved?**
**Yes, and the answer has been restated because the tree changed under it** (§C.6). The original
answer cited a 64-entry baseline and "this task created one file and modified nothing". Since
then commit **`9061481`**, made outside this work, committed 100 files including
`client-factory.ts`'s timezone fix, the property-configuration work and documents 14–16; and the
2026-10-27 review rounds modified **documents only** — 14, 15 and 16 (additively) plus the
untracked document 17. Verified: `git diff --name-only` lists nothing outside
`research/channel-manager/`. B1, when authorised, appends two models to `schema.prisma` and must
not edit the property-configuration models, the existing migration directories, or the timezone
fix.

**9. What still requires approval?**
§H.

---

## H. Open items

### Business decisions confirmed 2026-10-27

**These five are confirmed business decisions, not proposals.** Where a decision deliberately
stops short of a boundary case, the boundary is recorded as unresolved rather than inferred.

| # | Decision | Scope, and what is *not* decided |
|---|---|---|
| **BD-1** | The **free-cancellation deadline is counted backward from the property's local scheduled check-in time** on the arrival date | Which column is authoritative is **[UNRESOLVED]** — U-18: `Property.checkInTime` (default `"14:00"`) is what the calendar, drawer and folio read today, while `PropertySettings.standardCheckInTime` is documented as the eventual home [CODE: `schema.prisma:298,327,1233-1249`]. Timezone and DST handling also unresolved |
| **BD-2** | The **retention percentage applies to one night's room tariff** | *Which* night's tariff, and the treatment of discounts, meal-plan components, taxes and currency rounding, are **[UNRESOLVED]** — U-19 |
| **BD-3** | **`freeCancellationHours = 0` means there is no free-cancellation window** | Deliberately nothing further. The exact charge and timing semantics at zero — what is charged, from when, and what happens to a cancellation in the same instant as booking — are **[UNRESOLVED]** — U-20, and **must not be inferred** from the zero itself |
| **BD-4** | A **missing property cancellation policy resolves to a separately defined fallback policy** — not an automatic block, and not an implicit zero or default | The fallback's **terms**, whether it is global or per-property, and who governs it are **[UNRESOLVED]** — U-17. This *supersedes* the earlier recorded position that a missing policy blocks activation (§C.3b) |
| **BD-5** | **`RatePlan.isRefundable` stays removed**, and no cancellation term is duplicated onto `RatePlan` | Confirms the 2026-10-27 design change. `PropertyPolicy` remains the single source of truth (§A.2, §C.3a) |

### Proposals awaiting your confirmation — NOT decisions

**Recorded separately from every table in this section so nothing promotes them by accident.**
Supplied 2026-10-27 with the confirmed BD-1…BD-5, which they do not change. The full register,
with what each does *not* decide, is **document 17 §15**.

| # | Proposal | Status |
|---|---|---|
| **P-1** | Fallback **scope = property-level** (per property, not platform-wide) | **Proposed — awaiting confirmation.** Decides scope only; not the data model, source, ownership, versioning or lifecycle |
| **P-2** | Fallback `freeCancellationHours = 48` | **Proposed — awaiting confirmation.** Numerically identical to the seeded fixture — see doc 17 §15.2 |
| **P-3** | Fallback `retentionChargePercent = 100` | **Proposed — awaiting confirmation.** "100%" is not yet a determinate amount while U-19 is open |
| **P-4** | **Dual approval** | **Proposed — awaiting confirmation.** Does **not** resolve U-27 |
| **P-5** | `retentionChargePercent = 0` means no amount retained | **Proposed — awaiting confirmation.** U-21 stays open |
| **P-6** | Zero-hour charge timing **must be defined** | **A requirement to decide; no rule supplied or inferred.** U-20 stays open; the choices are enumerated in doc 17 §15.1 |

**None of these may be used as an implementation value**, and B1 requires none of them.

### Decisions recorded 2026-10-27

| # | Item | Resolution |
|---|---|---|
| **H-1** | The `BAR` code collision | **Approved: C-a**, `'BAR-' || rt."code"` (§C.3), subject to document 17 §1's validation query. C-b and C-c closed |
| **H-6a** | `mealPlan` backfill value | **Approved: `'EP'`.** `RoomType.baseRateMinor` is room-only pricing without breakfast for every property. G-2's modelling question stays open |
| **H-6b** | `isRefundable` backfill value | **Resolved by removing the field.** `PropertyPolicy` stays the source of truth for cancellation terms in the first release; no cancellation term is duplicated onto `RatePlan`, and no confirmed requirement for a per-plan policy exists (§C.3a). The earlier answer here — a nullable column gated by `rate_plan_active_requires_refundability` — is **superseded**: that constraint is gone with the column. The archive CHECK stays one-directional for a different reason, the "not yet activated" state (§A.4) |
| **H-8** | Where cancellation terms live, and what gates activation | **Decided:** terms on `PropertyPolicy` only; activation gated by an **application-level** check (V-1…V-7, §C.3b), stated plainly as weaker than a constraint because the precondition spans two tables. V-4 — where an operator's explicit validation is recorded — is **unresolved**, and seeded policy values never satisfy it |
| **H-9** | Reservation pricing during B1 | **Decided: unchanged.** `solved ?? overrideNightlyRateMinor ?? baseNightlyRateMinor` [CODE: `reservation-pricing.ts:147-148`] stays the path until the B7 cutover is implemented and validated, and that cutover must introduce **no** fallback that sells from a plan with an undefined cancellation policy |

### Requires your approval before B1 can be implemented

| # | Item | Blocking? |
|---|---|---|
| **H-2** | D-1: 180-day horizon, configurable via `PropertySettings.inventoryHorizonDays` (lands in G2, not B1) | No for B1 |
| **H-3** | D-2: writes return **404** while flagged off; reads may be enabled | No for B1 |
| **H-4** | D-3: `Reservation.ratePlanId` deferred to B7 | No for B1 |
| **H-5** | D-4: reconciliation report-only, manual or controlled-job, no recurring schedule yet | No for B1 |
| **H-7** | Confirmation that `pg_dump` is taken before applying — **still unapproved as of 2026-10-27.** PostgreSQL has not been started, no backup exists, nothing has been restored, no migration has been generated or run | **Yes.** The only remaining blocker |

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
| ~~**U-10**~~ | **Closed 2026-10-27.** Asked whether B7 should require policy configuration first or keep `RoomType.baseRateMinor` as a fallback for inactive plans. Decision 4 settles it: **no silent fallback.** An un-activated plan is not sellable; reservation creation keeps its current path untouched until the cutover is implemented and validated (§C.3b) |
| **U-12** | **[PARTLY RESOLVED 2026-10-27]** BD-1, BD-2 and BD-3 settle the deadline anchor, the retention base and the meaning of zero hours. **Still open:** whether `retentionChargePercent = 0` means nothing is retained (U-21 — **P-5 proposes "no amount retained", pending confirmation**), and what `NULL` means in either field on a `CANCELLATION` row now that a missing *row* has a defined fallback but a missing *term* does not (U-22; **P-5 does not define `NULL`**). Document 17 §13 carries the full list |
| **U-13** | **[DESIGN, refined 2026-10-27 — a proposal, not a decision]** How operator approval is recorded. Document 17 §10 compares inferring it from an append-only audit event against a **dedicated approval record** keyed to a canonical effective-policy fingerprint, and recommends the dedicated record. Its open consequences live in document 17 §13 and are **not** restated here: **U-23** stale-approval disposition, **U-24** whether an ARI payload carries the fingerprint, **U-25** what a policy change does to active plans, **U-26** whether a reservation records the policy fingerprint in force, **U-27** who may approve — which **P-4's proposed dual-approval model does not resolve**, since the roles, the mechanics and whether two *distinct* people are required remain undecided (doc 17 §15, §13g). Nothing is implemented, and no schema was added |
| **U-17** | **[BUSINESS, opened by BD-4]** The fallback policy: its exact terms, its scope, who defines and governs it, and whether resolving to it requires its own approval (V-7). **Until it is defined, there is nothing to fall back to.** **Proposals P-1…P-3 (property-level scope; 48 hours; 100 percent) are pending confirmation** and resolve none of the data-model, ownership, versioning or lifecycle questions — doc 17 §15 |
| **U-18** | **[BUSINESS/CODE, opened by BD-1]** Which check-in-time field is authoritative for the deadline — `Property.checkInTime` or `PropertySettings.standardCheckInTime` — plus timezone and DST handling for the backward calculation [CODE: both columns exist; `schema.prisma:327,1249`] |
| **U-19** | **[BUSINESS, opened by BD-2]** Which night's tariff the retention percentage multiplies, and how discounts, meal-plan components, taxes and currency rounding are treated. CLAUDE.md §3.4 requires rounding to be explicit and single-pass, so this cannot stay implicit |
| **U-20** | **[BUSINESS, opened by BD-3]** The exact charge and timing semantics when `freeCancellationHours = 0`: what is charged, from what instant, and the boundary case of a cancellation at or before the booking instant. **Not to be inferred from the zero.** **P-6 records that you want this defined but supplied no rule**, so it stays open; the choices needed are enumerated in doc 17 §15.1 |
| **U-14** | **[CODE gap]** `property_policy` has **no unique constraint on `(propertyId, type)`** — only an index [CODE: `schema.prisma:1409`] — so a property can hold two `CANCELLATION` rows with different terms. V-1 must count rather than take the first. Whether to add the unique is a separate, additive decision |
| **U-15** | **[CODE gap]** `freeCancellationHours` has **no database CHECK**; it is bounded 0–8760 only by the DTO and the UI [CODE]. A direct SQL write could store a negative free-cancellation window. Additive to fix, out of B1 scope |
