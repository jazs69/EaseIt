# Phase B — RatePlan Domain and Provider-Independent Sync Contract

**Status:** design proposal. No application code, schema, migration or data was changed to
produce it.
**⚠ Partially superseded by `15-phase-b-design-review.md`.** That review corrects §C.4 and
§D.3 of this document: the outbox row must carry a dirty *marker* rather than a frozen ARI
snapshot, and a local version check cannot prevent a stale external write. It also specifies
the inventory-calendar lifecycle that §H reduced to one line ("stage B2"). Read 15 alongside
this document; where they differ, 15 wins.
**Date:** 2026-10-26
**Scope:** the `rates` module (CLAUDE.md §2) and the canonical ARI contract the future
`channels` module will consume. **Not** in scope: any real OTA or aggregator integration,
credentials, outbound network calls, or changes to reservation, check-in, room-move, folio
or front-desk flows.

Everything in §A was read from the working tree at `4acb218` plus uncommitted changes.
Where this document contradicts `06-data-model-proposal.md` or `07-sync-and-failure-handling.md`,
the inspected code wins and the difference is called out.

---

## A. Current-state inventory

### A.1 What exists

| Concern | Model / file | Lines | State |
|---|---|---|---|
| Tenant root | `packages/database/prisma/schema.prisma` `model Property` | 274–373 | Complete. Carries `slug`, `code`, `timezone` (default `Asia/Kolkata`), `currency`, `businessDate @db.Date`, `checkInTime`, `checkOutTime` |
| Room category | `model RoomType` | 644–682 | Complete, **and carries the only price in the system**: `baseRateMinor Int` + `currency @db.Char(3)` |
| Physical room | `model Room` | 685–720 | Complete. `status RoomStatus`; comment states `OUT_OF_ORDER` rooms drop out of physical stock on rebuild |
| Availability counter | `model InventoryDay` | 721–758 | Complete. `(propertyId, roomTypeId, stayDate)` unique; `physical`, `sold`, `blocked`, `overbookingAllowance`; **no price, no restriction columns** |
| Oversell guarantee | `migrations/20261016140000_inventory_and_reservations/migration.sql:207` | — | `inventory_day_not_oversold` CHECK, live (verified: 0 oversold rows) |
| Room-overlap guarantee | same file, line 232 | — | `reservation_room_no_overlap` GiST exclusion, live (1 exclusion constraint in the database) |
| Allocation path | `apps/api/src/modules/reservations/create-reservation.service.ts:243-307` | — | `$transaction` → `set_config('app.current_property_id')` → `SELECT … FOR UPDATE ORDER BY "stayDate" ASC` → `updateMany { sold: { increment: 1 } }` |
| Stay pricing | `apps/api/src/modules/reservations/reservation-pricing.ts` | 200 | Pure functions. Per-night lines, per-night GST banding, single-pass rounding |
| Tax policy | `model PropertyTaxSlab` (1291–1320), `apps/api/src/modules/properties/tax-engine.ts` | — | Complete and data-driven |
| Outbox | `model OutboxEvent` (1740–…), `apps/api/src/modules/platform/outbox/*` (9 files) | — | Complete; `OutboxEventType` has exactly one member, `OUTBOX_SELF_TEST` |
| Permissions | `packages/types/src/rbac.ts:114-119, 281-313` | — | `rates:read`, `rates:manage`, `channels:read`, `channels:sync`, `inventory:override` **already defined and seeded** |
| Error codes | `packages/types/src/domain.ts:415-423` | — | `ROOM_UNAVAILABLE`, **`RATE_NOT_BOOKABLE`**, **`RESTRICTION_VIOLATED`**, **`CHANNEL_REJECTED`**, `CONFLICT` already defined |
| Timezone fix | `packages/database/src/client-factory.ts:69-73` | — | `options: '-c timezone=UTC'`. **Not to be modified or reversed** |

### A.2 What is missing

1. **No rate-plan model of any kind.** `grep -nE "^(model|enum) "` over the schema returns no
   `RatePlan`, `Rate`, `RateCalendar`, `Restriction` or `Channel`. The only rate-shaped thing
   is `RoomType.baseRateMinor` — one flat rack rate per category, with no date dimension.
2. **No restrictions anywhere.** A repository-wide search for `closedToArrival`, `minLos`,
   `maxLos`, `stopSell`, `closedToDeparture` finds matches only in RBAC *descriptions*
   (`rbac.ts:283,290`) and the unused error code `RESTRICTION_VIOLATED`. Nothing is
   implemented, stored or enforced.
3. **No application path creates `inventory_day` rows.** Every writer is an `updateMany` on
   rows that already exist:
   - `create-reservation.service.ts` — increments `sold`
   - `room-move.service.ts` — two `updateMany` calls
   - `seed.ts` / `seed-portfolio.ts` — the **only** `createMany`/`deleteMany`

   Consequences, and they matter for Phase B: the calendar does not extend itself forward;
   `physical` is never recomputed when a room is added, removed or set `OUT_OF_ORDER`;
   `blocked` and `overbookingAllowance` have no write path despite `inventory:override`
   existing as a permission. **A date with no row cannot be sold** — `create-reservation.service.ts:276`
   raises `RoomUnavailableError` when `locked.length !== dates.length` — and it equally
   cannot be published to a channel.
4. **No `nightaudit` module.** `ls apps/api/src/modules/` returns 14 modules; `nightaudit`,
   `rates`, `channels`, `housekeeping`, `frontdesk` and `booking-engine` are all absent.
   So there is no existing scheduled place to hang nightly reconciliation.
5. **No outbox producer in business code.** Confirmed: no file under `modules/reservations`,
   `folios`, `inventory` or `properties` imports `OutboxService`; the only mention is a
   comment at `create-reservation.service.ts:29` ("Those belong in the outbox once
   `platform` has one").

### A.3 Authoritative sources of truth, as the code stands

| Question | Authority today | Evidence |
|---|---|---|
| How many physical rooms exist | `Room` rows, filtered by `status` | `Room.status` doc comment, `schema.prisma:698-700` |
| **How many rooms are sellable on a date** | **`InventoryDay.physical + overbookingAllowance − sold − blocked`** | computed literally at `create-reservation.service.ts:263-264` |
| Whether a stay may be sold | the `inventory_day_not_oversold` CHECK | §3.1; proven by `pnpm test:concurrency` |
| Whether a physical room may be assigned | the `reservation_room_no_overlap` exclusion | §3.1 |
| What a night costs | `RoomType.baseRateMinor` | `reservation-pricing.ts` `QuoteInput.baseNightlyRateMinor` |
| Which currency | `Property.currency` **and** `RoomType.currency` — both exist | `schema.prisma:301` and `:662` |

`InventoryDay` is therefore the authoritative sellable-inventory record, and `Room` is the
authoritative physical record. **They are not reconciled by any code.** `InventoryDay.physical`
is a cached projection of `Room` that only the seed ever computes. This is the single most
important pre-existing weakness Phase B has to work around, because an ARI push publishes
`physical`-derived availability outward — a stale projection becomes a stale OTA listing.

### A.4 Conflicting or ambiguous concepts

| # | Ambiguity | Why it matters for Phase B | Proposed resolution |
|---|---|---|---|
| A-1 | `Property.currency` vs `RoomType.currency` | A rate plan needs exactly one currency authority, and a channel push must declare one | **Property is authoritative.** A rate plan inherits it and does not store its own; `RoomType.currency` is left alone (changing it is out of scope) but treated as advisory |
| A-2 | `Property.checkInTime/checkOutTime` (`:327-328`) vs `PropertySettings.standardCheckInTime/standardCheckOutTime` (`:1247-1248`) | Not load-bearing for ARI, but a future booking-engine quote will have to pick one | Out of Phase B scope. Flagged for the owner of `property-configuration` |
| A-3 | `BookingSource` enum already names OTAs (`MAKEMYTRIP`, `AGODA`, `BOOKING_COM`, `EXPEDIA`, `CLEARTRIP`, `schema.prisma:242-257`) | A future `Channel` table would be a **second** list of the same OTAs | Keep `BookingSource` as the *provenance of a reservation*; a future `Channel` row is a *connection*. They answer different questions, and the mapping between them belongs in the channel adapter, not in either enum |
| A-4 | `MealPlan` enum exists (`EP/CP/MAP/AP`) and `Reservation.mealPlan` is already set per booking | Is a meal plan an attribute of the rate plan, the booking, or both? | Rate plan declares the meal plan it *sells*; `Reservation.mealPlan` stays as-is (it is already written and must not change). See §B.4 |
| A-5 | `MealPlan` has no `BB`/`HB`/`FB` members | OTAs commonly use those labels | Not a Phase B change. Mapping `CP→BB` etc. is adapter work, and inventing enum members now would be speculative |
| A-6 | §3.2 requires a Prisma tenancy extension and RLS policies; **neither exists** | `createPrismaClient()` applies no extension, and the 14 `set_config('app.current_property_id')` calls are no-ops without policies | Pre-existing, out of Phase B scope, but it means **every new query must carry `propertyId` explicitly** — convention is the only control. Called out again in §E |

---

## B. The RatePlan domain

### B.1 Where pricing belongs — the investigation

The brief asks whether pricing attaches to a rate plan, a room type, a room, an inventory
date, or a separate rate calendar. Taking each against this codebase:

**Not the room (`Room`).** No hotel prices by room number; a room is a housekeeping and
assignment unit. `ReservationRoom` already assigns rooms independently of price, and
`reservation_room_no_overlap` guards that. Pricing per room would also multiply the ARI
payload by the room count for no gain.

**Not the room type alone.** This is today's shape (`RoomType.baseRateMinor`) and it is
exactly what blocks the product: one number per category cannot express a weekend rate, a
season, a non-refundable discount, or two OTAs on different net rates. Keeping it as the
only price makes a channel manager pointless.

**Not `InventoryDay`.** Tempting — it is already per `(property, roomType, date)` — and wrong
for two reasons found in the code. First, it would collapse rate plans into availability: one
price per room-type-date, so a refundable and a non-refundable plan could not coexist. Second,
`InventoryDay` is inside the hottest transaction in the system (`FOR UPDATE` on every stay
date of every booking, `create-reservation.service.ts:262-271`). Adding price columns puts
revenue-management writes in lock contention with the front desk, which is a correctness and
a latency problem. **Availability and price must stay in separate tables.**

**Therefore: a `RatePlan` definition plus a separate per-date `RatePlanDay` calendar.** The
rate plan carries the policy that does not vary by night (currency, meal plan, refundability,
occupancy basis); the calendar carries the figure and the restrictions that do. This also
matches what every provider's ARI model expects — a rate-plan identity plus a per-date value —
so the mapping layer stays thin.

Two further findings make this low-risk:

1. `reservation-pricing.ts:117-123` already says so, in the code: *"The nightly rate is flat
   across the stay today, because rate plans and per-date rates belong to the `rates` module
   and it is not built. The shape here is already per-night so that when it lands, only the
   source of `nightlyRateMinor` changes — not the totalling, the tax banding, or the
   rounding."* The insertion point is pre-planned: Phase B supplies `nightlyRateMinor` per
   night and touches none of the tax or rounding logic.
2. The permissions (`rates:read`, `rates:manage`) and error codes (`RATE_NOT_BOOKABLE`,
   `RESTRICTION_VIOLATED`) already exist and are seeded, so no RBAC or error-contract change
   is needed.

### B.2 Proposed models

Two models. Nothing else. Both additive; no existing table is altered.

```prisma
/// A sellable product: what a room type costs under a named commercial policy.
///
/// Definitions are per property. There is no global rate-plan catalogue, because
/// at ten independently-operated hotels a shared "Best Available Rate" row would
/// couple nine unrelated properties' pricing policy to one row — exactly the
/// coupling CLAUDE.md section 3.2 forbids in a unique constraint.
model RatePlan {
  id String @id @default(uuid()) @db.Uuid

  propertyId String   @db.Uuid
  property   Property @relation(fields: [propertyId], references: [id], onDelete: Cascade)

  /// The room type this plan sells. A plan prices exactly one category: a plan
  /// spanning categories would need a price per category, which is two plans.
  roomTypeId String   @db.Uuid
  roomType   RoomType @relation(fields: [roomTypeId], references: [id], onDelete: Restrict)

  /// Operator-facing code, e.g. "BAR", "NR-15". Unique per property.
  code String
  name String
  description String?

  /// What the guest gets. Reuses the existing enum rather than adding a parallel
  /// one; `EP` is explicit, not assumed, so "room only" is a decision on the record.
  mealPlan MealPlan

  /// Whether a booking on this plan can be cancelled without charge.
  /// A boolean, not a policy engine: the product has no cancellation-rule
  /// feature, and `PropertyPolicy` already holds prose policy text.
  isRefundable Boolean

  /// The occupancy this plan's prices are quoted for. Defaults to 2 because
  /// Indian hotel tariffs are conventionally quoted per double room; it is
  /// explicit rather than inferred so a single-occupancy plan is representable.
  /// Occupancy-derived pricing (extra-adult supplements) is NOT in this phase —
  /// see section G, open decision G-3.
  standardOccupancy Int @default(2)

  /// Fallback nightly rate in the property's currency minor unit, used for any
  /// date with no RatePlanDay row. Seeded from RoomType.baseRateMinor at
  /// migration time so behaviour is unchanged on day one (section B.6).
  defaultRateMinor Int

  /// Sell order in the booking engine and the rate calendar UI.
  sortOrder Int @default(0)

  /// Soft state, never deleted. See section B.5.
  isActive   Boolean   @default(true)
  archivedAt DateTime? @db.Timestamptz(6)

  createdAt DateTime @default(now()) @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @db.Timestamptz(6)

  days RatePlanDay[]

  @@unique([propertyId, code], name: "rate_plan_unique_code_per_property")
  @@unique([propertyId, roomTypeId, name], name: "rate_plan_unique_name_per_room_type")
  @@index([propertyId, roomTypeId, isActive, sortOrder])
  @@map("rate_plan")
}

/// One row per (rate plan, stay date): the price and the restrictions for a night.
///
/// Sparse by design. A row exists only where the operator has set something; the
/// plan's `defaultRateMinor` answers every other date. 10 properties x ~5 plans x
/// 450 days is ~22,500 rows if fully populated, which is a quarter of the existing
/// `inventory_day` table — affordable, as CLAUDE.md section 1 anticipates.
model RatePlanDay {
  id String @id @default(uuid()) @db.Uuid

  /// Denormalised deliberately: section 3.2 requires every composite index to
  /// lead with propertyId, and a tenant predicate that has to be reached through
  /// a join is a tenant predicate someone will forget.
  propertyId String   @db.Uuid
  property   Property @relation(fields: [propertyId], references: [id], onDelete: Cascade)

  ratePlanId String   @db.Uuid
  ratePlan   RatePlan @relation(fields: [ratePlanId], references: [id], onDelete: Cascade)

  /// A calendar date, never an instant (section 3.3). Built from the property's
  /// own timezone, never from a client's local time.
  stayDate DateTime @db.Date

  /// Null means "no override for this date": fall back to defaultRateMinor.
  /// Distinct from 0, which would mean a free room.
  rateMinor Int?

  /* -- Restrictions. Null everywhere means unrestricted. ------------------- */

  /// Refuse arrivals on this date.
  closedToArrival Boolean @default(false)
  /// Refuse departures on this date.
  closedToDeparture Boolean @default(false)
  /// Refuse all sale on this date, price irrelevant.
  stopSell Boolean @default(false)
  /// Minimum / maximum nights for a stay ARRIVING on this date.
  minLengthOfStay Int?
  maxLengthOfStay Int?

  createdAt DateTime @default(now()) @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @db.Timestamptz(6)

  @@unique([propertyId, ratePlanId, stayDate], name: "rate_plan_day_unique_per_date")
  @@index([propertyId, stayDate])
  @@map("rate_plan_day")
}
```

**Hand-written constraints** (Prisma cannot express these; they go in the same SQL migration
and are never removed, per §6.2):

```sql
-- A length-of-stay window must be coherent and positive.
ALTER TABLE "rate_plan_day"
  ADD CONSTRAINT "rate_plan_day_los_window_coherent"
  CHECK (
    ("minLengthOfStay" IS NULL OR "minLengthOfStay" >= 1) AND
    ("maxLengthOfStay" IS NULL OR "maxLengthOfStay" >= 1) AND
    ("minLengthOfStay" IS NULL OR "maxLengthOfStay" IS NULL
      OR "minLengthOfStay" <= "maxLengthOfStay")
  );

-- A price is never negative. Null is "no override"; 0 is a free room and is allowed.
ALTER TABLE "rate_plan_day"
  ADD CONSTRAINT "rate_plan_day_rate_non_negative"
  CHECK ("rateMinor" IS NULL OR "rateMinor" >= 0);

ALTER TABLE "rate_plan" ADD CONSTRAINT "rate_plan_default_rate_non_negative"
  CHECK ("defaultRateMinor" >= 0);
ALTER TABLE "rate_plan" ADD CONSTRAINT "rate_plan_occupancy_positive"
  CHECK ("standardOccupancy" >= 1);

-- Archive coherence: inactive iff archived.
ALTER TABLE "rate_plan" ADD CONSTRAINT "rate_plan_archive_matches_active"
  CHECK (("archivedAt" IS NULL) = ("isActive" = true));

-- Tenant coherence, matching the 11 composite FKs the repo already uses
-- (verified live: `unique_pair` indexes on room, room_type and others).
ALTER TABLE "rate_plan"
  ADD CONSTRAINT "rate_plan_same_property_as_room_type"
  FOREIGN KEY ("roomTypeId", "propertyId")
  REFERENCES "room_type"("id", "propertyId");

ALTER TABLE "rate_plan_day"
  ADD CONSTRAINT "rate_plan_day_same_property_as_plan"
  FOREIGN KEY ("ratePlanId", "propertyId")
  REFERENCES "rate_plan"("id", "propertyId");
```

The last two need `@@unique([id, propertyId])` on `rate_plan` (and `room_type` already has
its `unique_pair` index — confirmed live, 6 such indexes exist). This is the established
pattern in this repository, and it is what makes `rate_plan_day.propertyId` *provably*
consistent with its plan rather than merely conventionally so.

### B.3 Field-by-field justification, and what was deliberately left out

Every default above is explained in its doc comment. The omissions are as deliberate:

| Rejected field | Why not |
|---|---|
| `currency` on `RatePlan` | `Property.currency` is authoritative (A-1). A second column is a second answer |
| `derivedFromRatePlanId` + `adjustmentPercent` (linked/derived rates) | CLAUDE.md §2 lists "derived/linked rates" for the `rates` module, so it is in scope *eventually* — but it is a second pricing mechanism and would need its own cycle-detection and recomputation story. Phase B establishes the base; see G-4 |
| `promotionId`, `promoCode` | §2 lists promotions; no product requirement is defined yet. Speculative |
| `validFrom` / `validTo` on the plan | A plan's sellable window is expressible with `RatePlanDay.stopSell`, which already has to exist. Two mechanisms for "not sellable then" is one too many |
| `minAdvanceBookingDays`, `maxAdvanceBookingDays` | Real OTA restriction types, but nothing in this product books against them and no provider contract is confirmed. Additive later |
| `extraAdultRateMinor`, `childRateMinor` | Occupancy pricing is a genuine product question, not an engineering one (G-3) |
| `ratePlanType` enum (`PUBLIC`/`CORPORATE`/`OTA`) | Would presuppose the distribution model. A corporate rate is a rate plan a company is mapped to; the mapping belongs to a future `Channel`/`Company` link, not to an enum here |
| Channel/provider columns of any kind | Phase B is explicitly provider-independent. Provider identity lives in a future `ChannelRatePlanMapping`, which this phase only *reserves space for* (§B.4) |

### B.4 Global vs property-specific vs provider-specific

Three layers, deliberately separated, only the first two of which this phase builds:

1. **Global definitions** — none, and that is the decision. There is no portfolio-wide rate
   catalogue. `packages/database/src/index.ts:PORTFOLIO_GLOBAL_MODELS` lists the four models
   allowed to lack `propertyId` (`Role`, `Permission`, `RolePermission`, plus `Property`/`User`/
   `TwoFactorChallenge` as noted); **`RatePlan` must not be added to it.** Ten hotels in one
   portfolio still negotiate their own rates, and a shared plan row would mean editing one
   property's price changes another's — the §3.2 coupling failure in its purest form.
   `MealPlan` remains the one genuinely global vocabulary, and it already exists.
2. **Property-specific plans** — `RatePlan` + `RatePlanDay` above. The whole of Phase B.
3. **Provider-specific mappings** — *not built here.* A future `ChannelRatePlanMapping`
   keyed `(propertyId, channelId, ratePlanId) → externalRatePlanId` is the only place a
   provider's identifier may live. Phase B's obligation is simply that `RatePlan.id` is a
   stable, non-reused identity a mapping can point at, which a UUID primary key and
   archive-instead-of-delete semantics (§B.5) together guarantee.

### B.5 Deletion and archive semantics

**Rate plans are never hard-deleted** once they have been published or booked against:

- A plan's id may be referenced by a provider-side mapping we cannot transactionally update,
  and by historical reservations once §B.6 stage 4 links them. Deleting it orphans both.
- `isActive = false` + `archivedAt` set is the only retirement path, enforced by
  `rate_plan_archive_matches_active`.
- Archiving a plan **does not** delete its `RatePlanDay` rows: the historical price of a past
  night is part of why a folio says what it says.
- `onDelete: Restrict` on `roomTypeId` prevents a room type disappearing under a live plan.
  `RatePlanDay` cascades from its plan, which only matters if a plan is hard-deleted before
  ever being used — the one case where deletion is safe, and the service should permit it only
  when no mapping and no reservation reference it.
- Archiving is an auditable mutation: `audit_log` row in the same transaction, per §3.4.

### B.6 Migration compatibility — the behaviour-preserving path

The requirement is that nothing changes until someone chooses to change it.

- **Stage 1** adds the two tables and their constraints. Nothing reads them. Behaviour
  identical. Fully reversible (`DROP TABLE`, no existing data touched).
- **Stage 2** backfills exactly one plan per existing room type, inside the migration:
  `code = 'BAR'`, `name = 'Best Available Rate'`, `mealPlan = 'EP'`, `isRefundable = true`,
  `defaultRateMinor = room_type."baseRateMinor"`, no `RatePlanDay` rows. This is an INSERT
  from existing data — additive, and it makes every room type immediately representable in an
  ARI payload without changing a single price.
- **Stage 3** changes `reservation-pricing.ts`'s *caller* to resolve `nightlyRateMinor` per
  night from the rate plan (`RatePlanDay.rateMinor ?? RatePlan.defaultRateMinor`). Because the
  backfilled `defaultRateMinor` equals `RoomType.baseRateMinor` and there are no day rows, the
  resolved value is **bit-identical to today's** for every existing room type. The
  concurrency and check-in suites must pass unchanged — that is the acceptance test.
- `RoomType.baseRateMinor` is **not dropped**. It stays as the seed for new plans and as a
  fallback. Removing a column that the booking engine and three report queries may read is a
  separate, later decision with its own migration.
- **`Reservation.ratePlanId` is deliberately deferred** to stage 4 (§H), nullable when it
  lands, because adding it is additive but *using* it touches the booking flow this phase is
  forbidden from changing.

---

## C. The canonical synchronisation contract

Provider-neutral zod schemas in a new `packages/types/src/dto/ari.dto.ts`, following the
existing one-schema-per-wire-shape convention (`packages/types/src/dto/` holds 18 such files;
`outbox.dto.ts` is the closest model to copy, including its payload-versioning registry).

### C.1 Scalars and conventions

```ts
/** A calendar date. Never an instant. `YYYY-MM-DD`, validated, property-local. */
export const ariDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * An inclusive date range.
 *
 * INCLUSIVE at both ends, unlike `reservation_room`'s `daterange(..., '[)')`.
 * The difference is real and deliberate: a stay's departure day is not a night
 * sold, whereas "set this rate from the 1st to the 7th" means the 7th is priced.
 * Conflating them is how an off-by-one reaches an OTA, so the contract states it
 * and the validator enforces `from <= to`.
 */
export const ariDateRangeSchema = z.object({
  from: ariDateSchema,
  to: ariDateSchema,
}).refine((r) => r.from <= r.to, { message: 'from must not be after to' });

/** Money, exactly as it crosses every other boundary in this repo (section 3.4). */
export const ariMoneySchema = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
});
```

**Timezone semantics, stated once:** every date in this contract is a **calendar date in the
property's own IANA zone** (`Property.timezone`). It is never derived from the server clock, a
client clock, or `now()`. Conversion to a `@db.Date` column goes through the same
`toUtcMidnight` helper the reservation path already uses, and the UTC-pinned session from
`client-factory.ts` keeps that lossless.

### C.2 Mapping identity

```ts
/**
 * Who we are talking about, in OUR terms only.
 *
 * No channel id, no external id, no credentials. A provider's identifiers enter
 * at the adapter boundary via a mapping lookup; if they appeared here, every
 * producer would need to know which channels exist, and the contract would stop
 * being provider-neutral.
 */
export const ariScopeSchema = z.object({
  propertyId: z.string().uuid(),
  roomTypeId: z.string().uuid(),
  /** Absent for an availability update: availability is a room-type fact. */
  ratePlanId: z.string().uuid().optional(),
});
```

### C.3 The three update kinds

```ts
/** Availability: a room-type-level count, from InventoryDay. */
export const ariAvailabilityDaySchema = z.object({
  stayDate: ariDateSchema,
  /** physical + overbookingAllowance - sold - blocked, floored at 0. */
  available: z.number().int().nonnegative(),
});

/** Rate: a per-night price for one rate plan. */
export const ariRateDaySchema = z.object({
  stayDate: ariDateSchema,
  rate: ariMoneySchema,
});

/**
 * Restrictions: per night, per rate plan.
 *
 * Every field is present and explicit — never partial. A full-state payload with
 * an absent `stopSell` is ambiguous between "false" and "unchanged", and that
 * ambiguity is precisely what makes a replayed message dangerous.
 */
export const ariRestrictionDaySchema = z.object({
  stayDate: ariDateSchema,
  closedToArrival: z.boolean(),
  closedToDeparture: z.boolean(),
  stopSell: z.boolean(),
  minLengthOfStay: z.number().int().min(1).nullable(),
  maxLengthOfStay: z.number().int().min(1).nullable(),
});
```

Only these restriction types are offered, because they are exactly the ones §B.2 stores.
Offering a restriction the domain cannot express would be inventing a capability.

### C.4 The envelope

```ts
export const ariUpdateKindSchema = z.enum(['AVAILABILITY', 'RATE', 'RESTRICTION']);

export const ariUpdateSchema = z.object({
  /** Contract version. Bumped additively; old versions kept until no row carries them. */
  payloadVersion: z.literal(1),

  kind: ariUpdateKindSchema,
  scope: ariScopeSchema,
  range: ariDateRangeSchema,

  /**
   * FULL_STATE only, in this phase.
   *
   * Every push carries the complete truth for its (scope, range) rather than a
   * delta. The reason is recorded in 07-sync-and-failure-handling.md section 3.1
   * and it is about recovery, not elegance: a delta that is lost or applied twice
   * leaves the remote wrong and nothing can tell. A full-state write is naturally
   * idempotent — re-sending it produces the same remote state — which is the only
   * one of the three exactly-once strategies in outbox.service.ts that we can
   * implement without a provider's cooperation.
   *
   * DELTA is reserved in the enum so a future provider that only accepts deltas
   * is representable, but no producer may emit it in Phase B.
   */
  mode: z.enum(['FULL_STATE', 'DELTA']).default('FULL_STATE'),

  /**
   * Monotonic per (scope, kind). The ONLY defence against an out-of-order apply.
   * Sourced from a Postgres sequence, not a clock — see section D.3.
   */
  version: z.number().int().positive(),

  /** Stable across retries of the same intent. Becomes the outbox dedupeKey. */
  idempotencyKey: z.string().min(1).max(200),

  /** Ties a push back to the request or job that caused it, for support. */
  correlationId: z.string().uuid(),

  days: z.array(z.union([
    ariAvailabilityDaySchema, ariRateDaySchema, ariRestrictionDaySchema,
  ])).min(1).max(400),
})
.superRefine((u, ctx) => {
  // A rate or restriction update without a rate plan is meaningless; an
  // availability update with one implies a per-plan allocation model this
  // product does not have. Both are producer bugs, caught at the boundary.
  const needsPlan = u.kind !== 'AVAILABILITY';
  if (needsPlan && u.scope.ratePlanId === undefined) {
    ctx.addIssue({ code: 'custom', path: ['scope', 'ratePlanId'],
      message: `${u.kind} requires a ratePlanId` });
  }
  if (!needsPlan && u.scope.ratePlanId !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['scope', 'ratePlanId'],
      message: 'AVAILABILITY is a room-type fact and must not name a rate plan' });
  }
  // Every day in `days` must fall inside `range`, and each date appear once.
  // (Full implementation in the file; stated here so the rule is on the record.)
});
```

### C.5 Result representation

Modelled on the existing split between a *result* and an *exception*
(`outbox-handler.registry.ts` already distinguishes `OutboxPermanentError` from anything else,
and `domain.ts` already defines `CHANNEL_REJECTED`):

```ts
export const ariResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('APPLIED'),
    /** Provider's own confirmation id, where one is given. Opaque to us. */
    providerReference: z.string().max(200).optional(),
    appliedAt: z.string().datetime(),
  }),
  z.object({
    outcome: z.literal('REJECTED'),          // permanent: do not retry
    code: z.string().max(80),
    /** Safe summary only. Never the provider's raw body — it can carry guest PII. */
    message: z.string().max(500),
  }),
  z.object({
    outcome: z.literal('TRANSIENT_FAILURE'), // retry per the outbox budget
    code: z.string().max(80),
    message: z.string().max(500),
    retryAfterSeconds: z.number().int().positive().optional(),
  }),
  z.object({
    outcome: z.literal('SUPERSEDED'),        // a newer version won; not a failure
    supersededByVersion: z.number().int().positive(),
  }),
]);
```

`SUPERSEDED` exists so that discarding a stale push is recorded as a *normal outcome* rather
than a success that hides a discard or a failure that pages someone.

---

## D. Reliability and consistency

### D.1 How the existing outbox is used — and what is *not* added

No new queue, no new datastore, no new dependency. Phase B adds **three enum members** to
`OutboxEventType` (`ARI_AVAILABILITY_PUSH`, `ARI_RATE_PUSH`, `ARI_RESTRICTION_PUSH`) and three
entries to the `OUTBOX_PAYLOAD_SCHEMAS` registry in `outbox.dto.ts`. Everything else —
dispatcher, lease, claim token, retry budget, dead letter, backlog endpoint — is reused
exactly as built and tested in Phase A.

The producer call is the existing one, on the caller's transaction:

```ts
await this.outbox.enqueue(tx, {
  propertyId,
  eventType: 'ARI_AVAILABILITY_PUSH',
  payload: { /* ariUpdateSchema */ },
  dedupeKey: `ari:avail:${roomTypeId}:${from}:${to}`,
  dedupeMode: 'COALESCE',
});
```

**`COALESCE`, not `UNIQUE_FOREVER`,** and the distinction matters exactly as Phase A documented
it: ARI is a *scope of work whose latest intent wins*. Five price edits before the worker
drains must become one push carrying the newest state — which the PENDING-only partial unique
index gives for free, and which is only safe because the payload is FULL_STATE. A
`UNIQUE_FOREVER` key would mean "push this window once, ever", which is wrong for ARI and
right for a confirmation email.

**One honest limitation to carry forward:** `COALESCE` refreshes the payload of a PENDING row.
If the dispatcher has already claimed the row (`IN_FLIGHT`), a new edit creates a *second*
row, so two pushes for the same window can be in flight at once. That is what §D.3's version
stamp is for.

### D.2 Ordering

**Per `(propertyId, roomTypeId)` for availability, per `(propertyId, ratePlanId)` for rates
and restrictions.** Justified, not assumed: two pushes for the same window arriving out of
order leaves the remote holding the older value permanently, and `07-sync-and-failure-handling.md`
§2.5 records that **no provider documents ordering guarantees**, so we cannot borrow one.

The honest engineering position: the Phase A worker runs at `OUTBOX_CONCURRENCY` (default 4)
with no ordering guarantee between jobs, and adding a per-key serialisation mechanism is real
work. Phase B therefore does **not** claim ordered delivery. It claims **ordered *effect***,
via §D.3 — which is cheaper, is enforced by the database rather than by a queue, and survives
the duplicate deliveries the outbox is explicitly at-least-once about. Per-key concurrency
limiting is listed as a later option (G-5) if measurement shows the version check rejecting
often enough to waste provider rate limit.

### D.3 Stale-update prevention

A monotonic `version` per sync key, from a dedicated table — not a timestamp, because two
worker hosts' clocks disagree and §3.3 bans `now()` in domain logic anyway:

```prisma
/// The high-water mark of what we have told the outside world about one key.
model AriSyncState {
  id String @id @default(uuid()) @db.Uuid

  propertyId String   @db.Uuid
  property   Property @relation(fields: [propertyId], references: [id], onDelete: Cascade)

  /// 'AVAILABILITY' | 'RATE' | 'RESTRICTION'
  kind String
  /// roomTypeId for AVAILABILITY, ratePlanId for the others.
  scopeId String @db.Uuid

  /// Incremented in the SAME transaction as the business change that caused it.
  version BigInt @default(0)
  /// The highest version an adapter has confirmed applied.
  appliedVersion BigInt @default(0)
  appliedAt      DateTime? @db.Timestamptz(6)

  createdAt DateTime @default(now()) @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @db.Timestamptz(6)

  @@unique([propertyId, kind, scopeId], name: "ari_sync_state_unique_key")
  @@index([propertyId, kind])
  @@map("ari_sync_state")
}
```

- The producer bumps `version` and stamps it on the payload, inside the business transaction.
- The handler, **before** calling a provider, re-reads the row and discards the job as
  `SUPERSEDED` if `payload.version < appliedVersion`. A redelivered or delayed job is
  therefore cheap to drop and cannot undo a newer push.
- After a confirmed apply, the handler advances `appliedVersion` with
  `UPDATE … SET "appliedVersion" = $v WHERE … AND "appliedVersion" < $v` — a conditional write,
  so two concurrent workers cannot lower it.

`BigInt` because §3.4 permits it where a counter can exceed 2³¹ and this one is append-only
forever.

### D.4 Retryable vs permanent

Reusing Phase A's established semantics exactly, which already distinguishes these and is
tested:

| Condition | Classification | Mechanism |
|---|---|---|
| Provider 5xx, timeout, connection reset, 429 | **transient** | thrown normally; PostgreSQL schedules the retry with full jitter |
| Provider 4xx rejecting the payload (bad mapping, unknown rate plan) | **permanent** | `OutboxPermanentError` → DEAD on attempt 1, surfacing the bug immediately |
| Malformed/unparseable payload in the row | **permanent** | the worker's existing zod check; field paths logged, never values |
| Unknown *newer* `payloadVersion` | **transient** | existing behaviour — a rolling deploy must not poison its own backlog |
| `payload.version < appliedVersion` | **neither** — `SUPERSEDED` | dropped as a normal outcome, no attempt consumed |

### D.5 The transaction boundary

Unchanged from §3.1 and from Phase A, and worth restating because it is the line this phase
must not cross:

```
  ┌─ one PostgreSQL transaction ──────────────────────────────┐
  │  FOR UPDATE inventory_day (ascending stayDate)            │
  │  UPDATE  inventory_day  SET sold = sold + 1               │
  │  UPDATE  ari_sync_state SET version = version + 1         │
  │  INSERT  audit_log                                        │
  │  INSERT  outbox_event   (the promise to publish)          │
  └───────────────────────────────────────────────────────────┘
                              │  commits, or none of it does
                              ▼
     worker process: read row → call provider → record outcome
     (no HTTP, no Redis, no mail inside the transaction above)
```

**Delivery is at-least-once, never exactly-once.** A provider call that times out leaves the
outcome *unknown*, not failed. FULL_STATE payloads are what make a repeat safe; that is bought
in the contract, not promised by the queue.

### D.6 Preventing a failed channel push from corrupting PMS inventory

This is the question that matters most, and the answer is a direction rule plus three
detections:

**The direction rule.** The PMS is authoritative for ARI; the channel is authoritative for
reservations it sends us (`07-sync-and-failure-handling.md` §3.3). A failed *outbound* push
therefore never alters `inventory_day` — it means the OTA is stale, not that we are. Nothing
in the ARI handler is permitted to write `inventory_day`, `sold`, or any reservation row. The
only inbound path that may consume inventory is the normal reservation-creation transaction,
under the same CHECK as every other booking. This is what stops the feedback loop in which a
sync failure makes the PMS's own numbers wrong.

**Detection 1 — a dead letter is a distribution outage, not a log line.** A DEAD
`ARI_*_PUSH` row means one OTA is now selling against stale data. `GET /health/outbox` already
exposes `dead`; Phase B adds a per-property, per-channel staleness view so an operator can see
*which* property is drifting. Until alerting exists (a Phase A limitation, still open), this is
the compensating control.

**Detection 2 — lag is visible.** `AriSyncState.version > appliedVersion` is precisely "we
know something the channel doesn't". Surfacing `version - appliedVersion` and `appliedAt` per
key turns silent drift into a number on a screen.

**Detection 3 — nightly read-back reconciliation.** Per property, compare what the provider
holds against what we hold for a bounded window, and report differences. It **reports**; it
does not auto-correct, because an auto-corrector that is itself wrong corrupts both sides. The
natural home is a night-audit step — and `nightaudit` does not exist, so Phase B schedules it
as its own BullMQ repeatable job and notes the duplication to be resolved when that module
lands (G-6).

There is also a pre-existing hazard this phase must not make worse: `InventoryDay.physical` is
a stale projection of `Room` that only the seed computes (§A.2.3). Publishing availability
derived from it would broadcast that staleness. **Stage 2 of §H therefore builds the
`physical` rebuild path before any availability is ever published**, and the availability
projection reads `inventory_day` — never a live count of `Room` — so that what we publish is
exactly what the oversell CHECK will enforce.

---

## E. API and security

### E.1 Service boundaries

A new `apps/api/src/modules/rates/` module, following the one-module-per-bounded-context rule,
with the layering the repo already uses (`controller → service → repository → Prisma`):

| Unit | Responsibility |
|---|---|
| `RatePlanService` | CRUD and archive for plans. Writes `audit_log` in the same transaction |
| `RateCalendarService` | Bulk read/write of `RatePlanDay` over a date range |
| `AriProjectionService` | Builds an `ariUpdateSchema` payload from `InventoryDay` / `RatePlanDay`. **Pure read + enqueue. No provider knowledge** |
| `AriSyncStateRepository` | The version high-water mark (§D.3) |

`AriProjectionService` is where the sync contract meets the domain, and it is deliberately on
the *rates* side of the boundary: it knows nothing about channels, so Phase C can add a
`channels` module that consumes its payloads without `rates` learning anything about OTAs.

### E.2 Endpoints — only those a screen needs

CLAUDE.md §2 names "rate & restriction calendar" as a centrepiece admin screen, which is what
justifies these and nothing more. All are `/properties/:hotelId/...`, behind
`SessionAuthGuard` + `ActivePropertyGuard`, validated by `ZodValidationPipe`, with
`@RequirePermissions(...)` — matching `access-control` and `calendar` exactly.

| Method | Path | Permission | Why it exists |
|---|---|---|---|
| `GET` | `rate-plans` | `rates:read` | The plan list the calendar is drawn from |
| `POST` | `rate-plans` | `rates:manage` | Creating a plan |
| `PATCH` | `rate-plans/:id` | `rates:manage` | Editing; archive is `PATCH { isActive: false }` |
| `GET` | `rate-calendar?from&to&ratePlanId` | `rates:read` | The grid. Cursor pagination is unnecessary — the range is bounded by `from`/`to`, which the schema caps |
| `PUT` | `rate-calendar` | `rates:manage` | Bulk set of rate + restrictions over a range. A `PUT` because the payload is the full state of that window |
| `GET` | `ari-sync-state` | `channels:read` | Detection 2: what the channels do not yet know |

**No endpoint is created for architectural completeness.** Specifically **not** built: a public
rate-shopping endpoint (the booking engine does not exist), a manual "push now" trigger
(`channels:sync` exists as a permission but there is no channel to push to — it belongs in
Phase C), and any DELETE for a rate plan (archive only, §B.5).

### E.3 Security and tenancy

- **Every query carries `propertyId` explicitly.** The §3.2 Prisma extension and RLS policies
  do **not** exist (A-6, verified: `createPrismaClient()` applies no extension and the
  `set_config` calls are no-ops without policies). Convention is the only control, so the
  review checklist for every new repository method is: does the `where` name `propertyId`, and
  does every composite index lead with it.
- **A cross-property id returns 404, never 403.** Reuse `TenantScopeViolationError`, as
  `property-setup.service.ts:750` already does — a 403 confirms the row exists.
- **Authorisation resolves through `UserPropertyRole`**, reusing the established `authorise()`
  shape (`property-setup.service.ts:727-775`): grants → roles → `permissionsForRoles` →
  `ForbiddenError(Permission.X)`.
- **Audit**: every mutation of a rate or a restriction writes an `audit_log` row (actor,
  property, entity, before/after, reason) in the **same transaction**, per §3.4. This is not
  optional for this module — §3.4 names rates and restrictions explicitly.
- **Secrets**: none in this phase, and that is a property worth preserving. Provider
  credentials belong to a future `ChannelConnection` and must never appear in an outbox
  payload — `outbox.dto.ts`'s header already states payloads carry no PII and no secrets, and
  an ARI payload is identifiers, dates and integers only, so it complies by construction.
- **Rate limiting**: `RateLimiterService` already exists in `platform` and should guard the
  bulk `PUT` so a 400-day write cannot be issued in a loop.

---

## F. Test strategy

Following the repo's actual convention: `.mjs` suites under `test/`, run via root
`package.json` scripts, against a real Postgres. Five suites already exist
(`test:concurrency`, `test:checkin`, `test:outbox`, `test:outbox:concurrency`,
`test:outbox:redis`) and **none may be modified or deleted** — they are the regression
baseline, and §3.1/§5 forbid weakening them.

| Suite | Needs Redis? | Needs an OTA? | What it proves |
|---|---|---|---|
| `test:rates` (new) | no | no | Plan CRUD; `(propertyId, code)` uniqueness; archive coherence CHECK; LOS-window CHECK; non-negative rate CHECK; tenant isolation (Property A cannot read/update/delete B's plan → **404**); audit row written in the same transaction |
| `test:rates:pricing` (new, pure) | no | no | `RatePlanDay.rateMinor ?? defaultRateMinor` resolution per night; that a backfilled plan reproduces `RoomType.baseRateMinor` **exactly**; per-night rounding and GST banding unchanged |
| `test:ari:contract` (new, pure) | no | no | `ariUpdateSchema` accepts valid payloads and rejects: `to < from`, a date outside `range`, duplicate dates, `AVAILABILITY` with a `ratePlanId`, `RATE` without one, `minLOS > maxLOS`, `DELTA` from a Phase B producer |
| `test:ari:ordering` (new) | no | no | Version monotonicity; a payload with `version < appliedVersion` is dropped as `SUPERSEDED` with no attempt consumed; the conditional `appliedVersion` update cannot be lowered by a concurrent worker |
| `test:ari:idempotency` (new) | no | no | Same `(scope, range)` enqueued five times while PENDING → one row, newest payload (`COALESCE`); applying the same FULL_STATE payload twice is a no-op; `idempotencyKey` stable across retries |
| `test:ari:outbox` (new) | **yes** | no | End to end with the fake handler only: enqueue → dispatch → apply → `appliedVersion` advanced; transient failure retried; budget exhausted → DEAD; recovery after a lost queue job via the lease |
| `test:ari:reconcile` (new) | no | no | Read-back comparison against a fake provider snapshot detects a drifted date and **reports without mutating** `inventory_day` |
| `test:concurrency` (existing) | no | no | **Must still pass byte-identically.** The oversell race is the thing Phase B must not disturb |
| `test:checkin` (existing) | no | no | **Must still pass.** Proves stage 3's pricing swap changed no folio figure |

Most of it needs neither Redis nor a provider, which is deliberate: the version check, the
contract validation and the dedupe semantics are all PostgreSQL- or pure-function-owned, the
same property that made Phase A's core testable without Redis.

A **concurrent-inventory-mutation test** is called out separately because it is the dangerous
one: N parallel bookings against the last room while an ARI projection reads the same rows,
asserting exactly one booking succeeds, `inventory_day` is not oversold, and the projected
`available` never goes negative.

---

## G. Open decisions

### Engineering decisions I am making now (no input needed)

- Separate `RatePlan` + `RatePlanDay` rather than price columns on `InventoryDay` (§B.1).
- Property-scoped plans; no global catalogue (§B.4).
- FULL_STATE only; `DELTA` reserved but unemittable (§C.4).
- Ordered *effect* via a version high-water mark, not ordered *delivery* (§D.2–D.3).
- Archive, never delete (§B.5).
- Inclusive ARI date ranges, explicitly differing from `reservation_room`'s `'[)'` (§C.1).
- Reuse the existing permissions and error codes rather than adding any (§A.1).

### Genuinely needs product or business input

| # | Question | Impact if guessed wrong |
|---|---|---|
| **G-1** | Do these ten properties sell **multiple rate plans per room type** on day one, or one rack rate? | If one, `RatePlanDay` is still right but the UI is far simpler. If many, plan-level restrictions need a UI from the start |
| **G-2** | Is **meal plan** a property of the rate plan (CP plan vs EP plan) or chosen per booking (as `Reservation.mealPlan` implies today)? Both exist in the code | Decides whether `RatePlan.mealPlan` is authoritative or advisory, and whether two plans differ only by meal |
| **G-3** | Is **occupancy-based pricing** required (extra adult, child rates)? | A real schema addition. `standardOccupancy` is a placeholder for the single-occupancy case; full occupancy pricing is a per-occupancy rate table |
| **G-4** | Are **derived/linked rates** needed (NR = BAR − 10%)? CLAUDE.md §2 lists them | Changes `RatePlan` materially: a derivation source, cycle detection, and recomputation on parent change |
| **G-5** | What **restriction types** do the chosen channels actually require? | `07-sync-and-failure-handling.md` §2.5 records that providers document update semantics poorly. CTA/CTD/minLOS/maxLOS/stop-sell is the common core, but a provider may need min/max advance booking |
| **G-6** | Where does nightly reconciliation live, given there is **no `nightaudit` module**? | Phase B would add its own repeatable job; that becomes a duplicate schedule when night audit lands |

### Needs verified provider documentation (not resolvable internally)

| # | Question | Current evidence |
|---|---|---|
| **G-7** | Does the chosen provider accept per-rate-plan restrictions, or only room-type-level? | Unknown. `09-unknowns-and-open-questions.md` U-001–U-006 record that no provider documents this |
| **G-8** | Maximum date range and payload size per push | `07-…` §2.2 holds the only published rate limits; range caps are unverified. `days` is capped at 400 as *our* guard, not a provider's |
| **G-9** | Is availability per room type or per rate plan at the provider? | Decides whether `ariScopeSchema` stays as designed. Our domain is room-type-level (`InventoryDay`), which is the common model, but it is unconfirmed |

None of G-7..G-9 blocks Phase B: the contract is ours, and an adapter that must flatten or
split it can do so at the boundary. They block Phase C.

---

## H. Phased implementation plan

Each stage is independently reviewable, independently reversible, and leaves the repo green
(`pnpm typecheck && pnpm lint && pnpm build` plus all existing suites).

| Stage | Change | Acceptance criteria | Rollback |
|---|---|---|---|
| **B1** | `RatePlan` + `RatePlanDay` + constraints + `@@unique([id, propertyId])`. Hand-written SQL migration. Nothing reads them | `prisma validate` clean; `migrate status` up to date; all 6 CHECKs and 2 composite FKs present in `pg_constraint`; **existing row counts unchanged**; all 5 existing suites pass | `DROP TABLE rate_plan_day, rate_plan` — no existing table touched |
| **B2** | `InventoryDay` **write path**: extend the calendar forward, rebuild `physical` from `Room` excluding `OUT_OF_ORDER`, set `blocked`/`overbookingAllowance` behind `inventory:override`. Closes gap A.2.3 | Rebuild is idempotent; **never** lowers `physical` below `sold + blocked` (refuses with a typed error instead); `test:concurrency` passes unchanged; audit row per override | Revert the service; no schema change in this stage |
| **B3** | Backfill one `BAR` plan per room type, inside a migration, `defaultRateMinor = baseRateMinor` | Exactly one plan per existing room type; `test:rates:pricing` proves resolved rate == `baseRateMinor` for every room type | Delete the backfilled rows — they are identifiable and nothing references them yet |
| **B4** | `packages/types/src/dto/ari.dto.ts` + `test:ari:contract`. Types only, no producer | Schema rejects all nine invalid shapes listed in §F; `@repo/types` builds | Delete the file; nothing imports it |
| **B5** | `rates` module: `RatePlanService`, `RateCalendarService`, the six endpoints, audit, tenant tests | `test:rates` passes including the 404-not-403 isolation test; `pnpm lint` clean | Remove the module from `AppModule`; data stays |
| **B6** | `AriSyncState` + `AriProjectionService` + three `OutboxEventType` members + payload-schema registry entries + a **fake** ARI handler. No provider | `test:ari:ordering`, `test:ari:idempotency`, `test:ari:outbox` pass; `SUPERSEDED` consumes no attempt; no `inventory_day` write from the handler | Drop `ari_sync_state`; remove the enum members (additive enum values are safe to leave) |
| **B7** | Pricing swap: the reservation quote resolves its nightly rate from the rate plan | `test:checkin` and `test:concurrency` pass **unchanged** — no folio figure moves. This is the one stage that touches a booking path, and it is last for that reason | Revert to `RoomType.baseRateMinor`; no data migration needed |
| **B8** | Reconciliation job (report-only) + the `ari-sync-state` read endpoint | `test:ari:reconcile` detects drift and mutates nothing | Remove the repeatable job |

**B7 requires separate explicit approval**, because the operating rules for this task forbid
changing reservation flows. B1–B6 and B8 are additive and touch no existing business path.

---

## Stage 3 — Self-review

| Risk | Assessment |
|---|---|
| **Duplicate sources of truth** | One created and one accepted. Created: `RatePlan.defaultRateMinor` duplicates `RoomType.baseRateMinor` for a time — accepted deliberately so B3 is behaviour-preserving, with the plan being authoritative from B7 and the column dropped only in a later, separate decision. Accepted pre-existing: `InventoryDay.physical` as a projection of `Room` (A.2.3), which B2 addresses rather than inherits. `Property.currency` vs `RoomType.currency` is resolved by declaring Property authoritative and adding no third column |
| **Multi-tenant leaks** | `propertyId` on both tables, non-nullable, leading every index. The two composite FKs make `rate_plan_day.propertyId` provably equal to its plan's rather than conventionally so. Per-module isolation test mandated, asserting 404. **Residual risk, pre-existing and unchanged:** neither §3.2 backstop (Prisma extension, RLS policies) exists, so convention is the only control — stated in A-6 and E.3 rather than glossed |
| **Overselling** | Nothing in this design writes `sold`, and the ARI handler is forbidden from writing `inventory_day` at all (D.6). Price and restriction writes go to a different table, so revenue edits take no lock in the booking transaction. `test:concurrency` must pass byte-identically at every stage |
| **Date/timezone consistency** | Every date is `@db.Date` or a `YYYY-MM-DD` string, property-local, via the existing `toUtcMidnight` helper; the UTC-pinned session keeps it lossless. The one real trap is named explicitly: ARI ranges are **inclusive**, `reservation_room`'s daterange is `'[)'`. That asymmetry is documented in the schema, in the contract, and tested |
| **Out-of-order updates** | The version high-water mark, with a conditional `appliedVersion` write. I am **not** claiming ordered delivery — §D.2 says so plainly, because the Phase A worker has concurrency 4 and no per-key serialisation |
| **Retry loops / duplicate side effects** | Phase A's budget, jitter, dead letter and claim token are reused unchanged. FULL_STATE payloads make a repeat produce the same remote state. `SUPERSEDED` is a non-consuming outcome, so stale jobs cannot burn a budget. **At-least-once is stated, exactly-once is not promised** |
| **Breaking existing workflows** | B1–B6 and B8 add tables, types and a module; no existing file's behaviour changes. B7 is the only stage touching a booking path, is last, and is gated on separate approval with "no folio figure moves" as its acceptance criterion |
| **Migration / data-loss risk** | Every migration is additive: two `CREATE TABLE`s, constraints on those tables only, one `INSERT … SELECT` backfill, and additive enum values. No `DROP`, no `ALTER` of an existing column, no data mutation. `RoomType.baseRateMinor` is retained |
| **Premature OTA coupling** | The contract names no provider. `ariScopeSchema` carries our UUIDs only; no channel id, no external id, no credential. The three unverifiable provider questions (G-7..G-9) are answerable at an adapter boundary that this phase does not build. The one concession is `mode: DELTA`, reserved in the enum and forbidden to producers, so a delta-only provider is representable without being anticipated |

**Weakest points, stated rather than hidden.** (1) The `defaultRateMinor` duplication is a real
compromise — justified by behaviour preservation, but it must not outlive B7. (2) Ordering is
effect-level, not delivery-level; if measurement shows the version check rejecting often, per-key
concurrency limiting (G-5) becomes necessary rather than optional. (3) The `physical` projection
is a pre-existing correctness gap that B2 must fix *before* any availability is published, and if
B2 slips, publishing availability is unsafe. (4) Reconciliation detects drift but does not
correct it, by design; without the alerting that Phase A left open, drift is visible only to
someone who looks.
