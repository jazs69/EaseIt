# Phase B1 — Pre-Implementation Checklist

**Status:** checklist only. B1 is **not** implemented. No source code, Prisma schema, migration,
package file, database or business datum was changed to produce this document.
**Date:** 2026-10-26
**Revised:** 2026-10-27 — **H-1 approved** (`BAR-<room-type-code>`, subject to §1's validation),
**H-6a approved** (`EP`; the rack rate is room-only for every property).
**Revised again:** 2026-10-27 — **`RatePlan.isRefundable` is removed from the B1 design.**
`PropertyPolicy` remains the single source of truth for cancellation terms for the first release.
§2 is rewritten: it no longer proposes a refundability value, and instead answers the five
cancellation-policy questions from repository evidence. **H-7 is still unapproved and nothing in
§3 has been run.** Changed sections: §1, §2, §3.0, §4.4, §5.3, §6, §7, §8.
**Revised a third time:** 2026-10-27 — verification pass. Nine stale statements corrected across
documents 16 and 17, listed in §12; §9 presents the U-12 business decision, §10 the U-13 design
decision, §11 the consolidated gate table.
**Revised a fourth time:** 2026-10-27 — **five business decisions confirmed** (BD-1…BD-5, doc 16
§H). One changes an earlier position: a missing property cancellation policy now resolves to a
**separately defined fallback policy** rather than blocking activation, so §2.6 and §9 are
rewritten around an **approved effective policy**. §10 is refined to recommend a **dedicated
approval record**. §13 is new: the eight open questions, each marked confirmed, proposal or open.
Changed sections: header, §2.6, §9, §10, §11, §13.
**Gates:** `16-phase-b1-implementation-plan.md` §H, as revised 2026-10-27. Document 16 is updated
in step with this checklist. Documents 14 and 15 **have each gained an additive supersession
pointer** (and 15 one inline note); no original claim in either was altered or removed. The four
conflicts those pointers cover are listed in §8 — an earlier version of this line said both
documents were unmodified and named one conflict, which §8 already contradicted.

**Environment note, relevant to several items below:** PostgreSQL is **currently not running**
(port 5432 not listening). Its background shell was reaped earlier for system memory pressure.
I have not restarted it, per the reap guidance and because that is a system-state change you
have not approved. Consequently every item marked **[DB-GATED]** is specified but *not* verified
against live data, and must be run once you authorise starting the server.

Labels: **[CODE]** verified in the working tree today · **[DB]** verified earlier against the
live database and recorded · **[DB-GATED]** awaiting a database that is up · **[PROPOSED]** my
design · **[NEEDS YOU]** your decision.

---

## 1. H-1 — Does `BAR-<room-type-code>` produce unique, valid, length-safe codes?

> **Approved 2026-10-27:** option **C-a**, `'BAR-' || rt."code"`, subject to the validation
> below. §1.5's query remains a gate before the migration is applied — approval of the *shape*
> is not a substitute for running the check against the rows that exist.

### 1.1 Uniqueness — proven structurally, not statistically

`room_type` already carries a unique constraint on `(propertyId, code)`
[CODE: `schema.prisma:677`, `@@unique([propertyId, code], name: "room_type_unique_code_per_property")`].

Prefixing an already-unique value with a constant string preserves uniqueness: if
`code₁ ≠ code₂` within a property, then `'BAR-' || code₁ ≠ 'BAR-' || code₂`. So
`rate_plan.code = 'BAR-' || rt.code` **cannot collide within a property**, whatever the data
contains. This is a consequence of an existing constraint, not a property of the current rows,
so it cannot be invalidated by a reseed or by new room types.

That is the decisive answer to H-1, and it is why option **C-a** from document 16 §C.3 was
preferred over changing the `rate_plan` unique constraint. **C-a is approved** (2026-10-27).

**Contrast with the rejected constant `'BAR'`** [DB]: measured on the live database earlier,
all **21 of 21** properties have more than one room type (up to 10; 92 room types in total), so
a constant code would collide on **every property** and abort the migration on the first one
with `23505`.

### 1.2 Length safety — unbounded column, so no truncation is possible

`room_type.code` and the proposed `rate_plan.code` are both PostgreSQL `TEXT`, not `VARCHAR(n)`:

- `code String` with no `@db.VarChar` in the Prisma schema [CODE: `schema.prisma:651`].
- `"code" TEXT NOT NULL` in the shipped DDL
  [CODE: `migrations/20261016140000_inventory_and_reservations/migration.sql:17`].

`TEXT` has no length limit, so `'BAR-' || code` cannot be truncated or rejected for length.
Observed lengths from source (§1.3): 3–9 characters, giving `BAR-` codes of **8–13 characters**.

### 1.3 Validity — character set and shape, from source

Postgres is down, so this is derived from the seed sources, which are the only producers of
`room_type` rows [CODE: `createMany`/`upsert` on `roomType` appear only in
`packages/database/prisma/seed.ts` and `seed-portfolio.ts`].

Room-type codes defined at their definition sites [CODE]:

```
seed.ts  SHUBH_ROOM_TYPES : DLX DLXA EXEA EXEB QUADA QUADF DORMA DORMB SUITE FAM STD SUP SUI
seed.ts  genericRoomTypes(): STD DLX SUP FAM SUI
seed-portfolio.ts          : ALPINE COMPACT COTTAGE COVE DLX EXEC GARDEN HER HOME LAKE LODGE
                             MAHAL MONSOON15 ONEBHK PALACE PINE POOL PREM RETREAT RIVER ROYAL
                             SEA SPA STD STUDIO SUITE SUP VALLEY VILLA
```

| Property of the set | Finding |
|---|---|
| Character set | `[A-Z0-9]` only — uppercase letters and digits (`MONSOON15`, `ONEBHK`) |
| Length | 3 (`DLX`, `FAM`, `STD`, `SEA`, `SPA`, `HER`, `SUI`) to 9 (`MONSOON15`) |
| Empty or whitespace codes | **None observed** |
| Lowercase or spaces | **None observed** |
| Codes already beginning `BAR` | **None observed** — so no `BAR-BAR-…` doubling |
| Resulting `rate_plan.code` | `BAR-DLX` … `BAR-MONSOON15`, 8–13 chars, `[A-Z0-9-]` |

**No collisions and no invalid codes are identifiable from the documented findings.**

### 1.4 Residual risks — none affecting uniqueness

| # | Risk | Assessment |
|---|---|---|
| R-1 | An **empty** `room_type.code` would yield the code `BAR-` | There is **no CHECK constraint forbidding an empty `code`** [CODE: `room_type`'s only CHECK is `room_type_rate_and_occupancy_sane`, covering `baseRateMinor`, `maxGuests`, `overbookingAllowance`]. So an empty code is *representable*. It would still be **unique** (one empty code per property at most), so the migration would succeed — this is cosmetic, not a correctness failure. Worth a validity assertion in the pre-apply census (§4.2) rather than a schema change |
| R-2 | Collision with a plan an operator creates later | Not a migration concern. `(propertyId, code)` rejects it with `23505`, which is the constraint working |
| R-3 | A pre-existing `rate_plan` row with the same code | Impossible — the table does not exist yet |
| R-4 | The seed is re-run after B1, creating a room type with no matching plan | Real, and **not** a B1 defect: the backfill is a one-time migration, not a trigger. Noted for the G3 gate; a room type without a plan is detectable by the §5 orphan query |

### 1.5 [DB-GATED] Verification query — read-only, to run before applying

```sql
-- Confirms uniqueness, validity and length of every prospective plan code.
-- Read-only. Expect: collisions 0, invalid 0, max_len <= 13.
SELECT
  count(*)                                                        AS room_types,
  count(DISTINCT ("propertyId"::text || '|BAR-' || code))          AS distinct_plan_codes,
  count(*) - count(DISTINCT ("propertyId"::text || '|BAR-' || code)) AS collisions,
  count(*) FILTER (WHERE code IS NULL OR btrim(code) = '')         AS empty_codes,
  count(*) FILTER (WHERE code !~ '^[A-Za-z0-9_-]+$')               AS invalid_charset,
  count(*) FILTER (WHERE code ~* '^bar')                           AS already_bar_prefixed,
  max(length('BAR-' || code))                                      AS max_len
FROM room_type;
```

**Acceptance:** `collisions = 0`, `empty_codes = 0`, `invalid_charset = 0`,
`already_bar_prefixed = 0`, `max_len <= 13`, and `room_types = distinct_plan_codes = 92`.
Any non-zero in the middle four columns stops the migration pending a decision.

---

## 2. Backfill values, and the cancellation-policy questions answered from evidence

### 2.0 What changed, and what it replaces

**`RatePlan.isRefundable` is removed from the B1 design.** It was never implemented — no column,
no migration, no DTO, no code — and §2.4 below shows no confirmed requirement needs it. Everything
this section previously said about a nullable refundability column, its CHECK
(`rate_plan_active_requires_refundability`), and whether to backfill `true` or `false` is
**superseded**. Document 16 §A.2, §C.3, §C.3a and §C.3b carry the current design.

For the first release, `PropertyPolicy` is the source of truth for cancellation terms, and no
cancellation term is duplicated onto `RatePlan`.

### 2.1 The backfill values, as they now stand

| Column | Value | Status |
|---|---|---|
| `code` | `'BAR-' || rt."code"` | **Approved (H-1)**, subject to §1.5's query |
| `mealPlan` | `'EP'` — European Plan, room only, no meals included | **Approved (H-6a).** `RoomType.baseRateMinor` is room-only pricing without breakfast for **every** property |
| `defaultRateMinor` | `rt."baseRateMinor"` | Unchanged; the point of the backfill |
| `isActive` | `false` | Not sellable until an **approved effective cancellation policy** exists for the property — its own policy, or the separately defined fallback (BD-4), in either case approved (§2.6) |
| `archivedAt` | `NULL` | *Not yet activated*, not *retired* — the reason the archive CHECK is one-directional |
| ~~`isRefundable`~~ | — | **Column removed from the design.** Nothing is written, because nothing exists to write to |

`EP` remains correct and is now a recorded business fact rather than an inference. What it does
**not** settle is G-2 — whether a meal plan belongs to the plan or to the booking.
`Reservation.mealPlan` exists with `@default(EP)` and the create path accepts it per booking
[CODE: `schema.prisma:823`; `create-reservation.service.ts` passes `command.mealPlan`], so
`RatePlan.mealPlan` still carries **no** Prisma default: the value is settled, the modelling
question is not, and a column default would quietly answer the second one too.

### 2.2 What `null` means in each cancellation field

The model's own doc comment is the primary evidence: the structured terms exist "where the policy
has them — prose alone cannot be enforced by a cancellation path; these can"
[CODE: `schema.prisma:1401-1402`].

| Field | Type | Null means… | Confidence |
|---|---|---|---|
| `freeCancellationHours` | `Int?` | On a **non-cancellation** row: *this kind of term does not apply*. Verified by the seed, which leaves both null on `HOUSE_RULES` and `TERMS_AND_CONDITIONS` and sets only `freeCancellationHours` on `AMENDMENT` [CODE: `seed-portfolio.ts:272-300`] | **[CODE]** for non-cancellation rows |
| `freeCancellationHours` | `Int?` | On a **`CANCELLATION`** row: **not established.** No code reads it for any decision, no validation requires it, and nothing distinguishes "not configured yet" from "no free window" | **[UNRESOLVED]** — U-12 |
| `retentionChargePercent` | `Decimal(5,2)?` | Same split, for the same reasons. The `AMENDMENT` seed row carries hours with a null retention [CODE: `seed-portfolio.ts:272-281`], which shows the two are independently optional | **[CODE]** / **[UNRESOLVED]** |

I am not resolving the `CANCELLATION` case by inference. A reasonable reader could take null as
either "unconfigured" or "nothing free, nothing retained", and the difference is a guest-facing
commercial term.

**What the later decisions did and did not settle here.** BD-3 gives **`0`** its meaning in
`freeCancellationHours` (no free window), and BD-4 defines what happens when the **row** is
missing (the fallback applies). Neither settles a **null term on a row that exists** — under BD-4
that is not a missing policy, so the fallback does not obviously reach it. That remainder is
**U-22**, and it stays open.

### 2.3 What values would represent "no free cancellation" and "no retention charge"

`0` in each, and `0` is **representable and distinct from null at every layer**:

| Layer | `freeCancellationHours = 0` | `retentionChargePercent = 0` |
|---|---|---|
| Prisma / DB column | Allowed — nullable `Int` / `Decimal(5,2)` | Allowed |
| DB CHECK | **No CHECK exists on this column at all** — the only policy CHECK is `property_policy_retention_in_range` [CODE: `20261019080000_property_configuration/migration.sql:319-324`]. A direct SQL write could even store a negative value (U-15) | `CHECK (NULL OR 0–100)` permits 0 |
| Write DTO | `z.number().int().min(0).max(8760).nullable().default(null)` — 0 accepted, null the default [CODE: `property-config.dto.ts:280`] | `z.number().min(0).max(100)`, nullable, default null [CODE: `property-config.dto.ts:28,281`] |
| UI | Regex `^\d+$` accepts `"0"`; an **empty** field becomes `null` [CODE: `policies-tab.tsx:291-296`] | Regex `^\d+(\.\d{1,2})?$` accepts `"0"`; empty → `null` [CODE: `policies-tab.tsx:299-306`] |

So the encoding is **available** at every layer. What has since been *decided* about it, and what
has not:

- **`freeCancellationHours = 0` — CONFIRMED** by BD-3: it means there is **no free-cancellation
  window**. The charge and timing semantics at zero are deliberately **not** decided and must not
  be inferred from the zero (U-20, §13b).
- **`retentionChargePercent = 0` — still open** (U-21, §13c). BD-3 covers the hours field only,
  and no consumer reads either field, so nothing in the repository gives this one a meaning.

### 2.4 Is there a confirmed requirement for rate-plan-specific cancellation policy?

**No**, and the search is the evidence:

| Where a requirement would appear | Result |
|---|---|
| Prisma schema, every migration | No refundability, cancellation-charge or deposit-rule column on any rate, room-type or reservation table [CODE] |
| `packages/types` zod schemas and DTOs | No such field in any wire contract [CODE] |
| API services, controllers, both web apps | Nothing reads or writes one [CODE] |
| Tests | Nothing asserts per-plan cancellation behaviour [CODE] |
| Documents 14, 16, 17 | The only source — and all three are **my own proposals**, never a stated requirement |

Hence the removal. A second honest point: a `cancellationPolicyId` **reference** on `RatePlan`
would not duplicate terms, so it would not breach decision 1 — but it cannot work against the
current write path. `replacePolicies()` **deletes every policy row for the property and recreates
them** on each save [CODE: `property-setup.service.ts:554-559`], so policy ids are not stable
across an edit: an FK would either block the save or dangle. Making them stable is a change to
that write path, which is out of scope and unrequested. Recorded as unresolved, not designed.

### 2.5 Can the current UI save incomplete policy data?

**Yes — verified, at three independent layers.** This matters, because it means "a `CANCELLATION`
row exists" is not evidence that a policy is configured.

| Layer | What it permits | Evidence |
|---|---|---|
| UI | `parsePolicy` rejects only an empty **title** or empty **content**. A blank hours or retention field is parsed to `null` and the save proceeds | [CODE: `policies-tab.tsx:274-306`] |
| Write DTO | Both numeric fields are `.nullable().default(null)`; **no** refinement requires a `CANCELLATION` row to carry either, and none requires a `CANCELLATION` row to exist. The array bound is only `.max(40)` | [CODE: `property-config.dto.ts:272-286`] |
| Service | `replacePolicies()` deletes all rows, then `createMany` only `if (policies.length > 0)` — so saving an **empty set** leaves the property with **no policies at all** | [CODE: `property-setup.service.ts:554-559`] |

So three incomplete states are reachable through the product as it stands: a `CANCELLATION` row
with both terms null; a property with no `CANCELLATION` row; and — since there is no unique on
`(propertyId, type)`, only an index [CODE: `schema.prisma:1409`] — a property with **two**
`CANCELLATION` rows carrying different terms (U-14).

The write path is otherwise sound: it runs in one transaction, sets `app.current_property_id`, and
writes an `audit_log` row in the same transaction, per CLAUDE.md §3.2 and §3.4
[CODE: `property-setup.service.ts:538-578`].

### 2.6 What must pass before a property can enable rate-plan-based selling

**Revised 2026-10-27 by BD-4.** This section previously said a property with no cancellation
policy is **blocked** from activating. That is superseded: a missing own policy resolves to a
**separately defined fallback policy** — not a block, not an implicit zero, not an invented
default. The gate is therefore "an **effective policy** exists and is approved", where

```
effectivePolicy(property) :=  the property's own CANCELLATION row, where one exists
                              the separately defined fallback policy, otherwise
```

**The fallback does not exist yet.** Its terms, its scope (global or per-property) and its
governance are **[UNRESOLVED]** (U-17, §13a). Until it is defined there is nothing to resolve to,
so a property with no own policy still cannot be approved — a consequence of the fallback being
undefined, not a policy of blocking.

Document 16 §C.3b holds the detail. The first sentence of it is still the important one:
**this gate cannot be a database constraint.** The precondition spans the plan, the property's
`property_policy` rows and whatever holds the approval, and a PostgreSQL CHECK cannot reference
another table. So it is an **application-level** check and therefore **weaker than B1's other
guarantees**, which are constraints. What *is* durable is the three-state shape: the backfill
leaves every plan inactive and un-archived, so the default state of all 92 is "cannot be sold".

| # | Check | Status |
|---|---|---|
| V-1 | An **effective policy** resolves — exactly one own `CANCELLATION` row, counted not `findFirst` (duplicates are representable, U-14), or the defined fallback where there is none | [PROPOSED] |
| V-2 | Its terms are **present**: `freeCancellationHours IS NOT NULL` and `retentionChargePercent IS NOT NULL` (§2.5). Presence only — see the note below | [PROPOSED] |
| V-3 | Non-empty prose `content` — already guaranteed for anything saved through the UI | [CODE] |
| V-4 | An **approval record** for the effective policy's canonical fingerprint, with actor and timestamp (§10) | [PROPOSED] |
| V-5 | The plan: `archivedAt IS NULL`, `defaultRateMinor` present, room type active | [PROPOSED] |
| V-6 | **Seeded values never constitute an approval** — identical terms written to every property [CODE: `seed-portfolio.ts:259-271`] are fixtures, not commercial policy | [CODE] |
| V-7 | **The fallback, when used, is itself approved** — resolving to it must not bypass V-4. Whether one approval suffices or each property must accept its own fallback is **[UNRESOLVED]** (U-17). A **property-level** scope is **proposed** but unconfirmed (P-1, §15), so V-7's shape cannot be settled yet | [PROPOSED] |

What V-2 can and cannot claim: BD-1, BD-2 and BD-3 now fix the *meaning* of the deadline anchor,
the retention base and zero hours, so a filled-in pair is no longer semantically empty. It is
still only **presence** — it does not establish that the numbers are commercially right, which is
what V-4 is for, nor does it settle `retentionChargePercent = 0` (U-21) or a `NULL` term on an
existing row (U-22).

**Two different fallbacks, and the words collide — so, separately:**

| Fallback | Status |
|---|---|
| **Policy** fallback — a missing cancellation policy resolves to the defined fallback | **Confirmed** (BD-4). Terms are always *defined*, never absent |
| **Price** fallback — an un-activated plan sold on `RoomType.baseRateMinor` | **Forbidden.** Reservation creation keeps its current path — `solved ?? overrideNightlyRateMinor ?? baseNightlyRateMinor` [CODE: `reservation-pricing.ts:147-148`], consulting no rate plan — until the B7 cutover is implemented and validated. An un-activated plan is **not sellable** |

---

## 3. H-7 — Backup, verification and restore-feasibility commands

> **H-7 remains UNAPPROVED as of 2026-10-27, and nothing below has been run.** PostgreSQL has
> not been started, no backup exists, no database has been created, nothing has been restored and
> no migration has been run. The commands in §3.2–§3.5 are specified for you to authorise; they
> are not a record of work done.

**Nothing below has been executed.** PostgreSQL is not running, no backup exists, no restore has
been attempted, and no system state has been changed. These commands require your explicit
approval, and step 0 requires starting the server, which is itself a change you have not approved.

### 3.1 Verified prerequisites [CODE]

| Prerequisite | Status |
|---|---|
| `pg_dump.exe`, `pg_restore.exe`, `psql.exe`, `createdb.exe`, `pg_ctl.exe` | All present in `D:\easeit-devdb\pg\pgsql\bin\` |
| Client/server version match | `pg_dump (PostgreSQL) 17.6`; server is 17.6. **Matched**, so no cross-version dump caveat applies |
| Data directory size | **137 MB** → a `-Fc` compressed dump of ~50,000 rows will be a small number of MB |
| **Disk space** | **`D:` has 3.1 GB free of 12.3 GB (75% used)**; `C:` has 139.3 GB free of 441.1 GB |

**Recommendation on location:** write the dump to **`C:`**, not `D:`. `D:` holds both the
repository and the database cluster, it is already 75% full, and a backup on the same volume as
the data it protects is not a backup. A restore-feasibility test (§3.4) would add roughly another
137 MB of cluster data on `D:`, which fits but narrows the margin further.

### 3.2 Step 0 — start the server (requires approval)

```
D:\easeit-devdb\pg\pgsql\bin\pg_ctl.exe -D D:\easeit-devdb\data -l D:\easeit-devdb\server.log start
```

Then confirm it is accepting connections before continuing:

```
D:\easeit-devdb\pg\pgsql\bin\psql.exe "postgresql://<user>:<pass>@127.0.0.1:5432/easeit" -c "SELECT version();"
```

The connection string is in `packages\database\.env` as `DATABASE_URL`; strip the
`?schema=public` query parameter, which `psql` rejects as an invalid URI parameter. **Do not paste
the credentials into a shared log.**

### 3.3 Step 1 — create the backup

```
mkdir C:\easeit-backups
D:\easeit-devdb\pg\pgsql\bin\pg_dump.exe "postgresql://<user>:<pass>@127.0.0.1:5432/easeit" -Fc -Z 6 -v -f C:\easeit-backups\easeit-pre-b1-20261026.dump
```

- `-Fc` — custom format. Required for `pg_restore`'s selective restore and for `-l` listing;
  a plain SQL dump cannot be inspected the same way.
- `-Z 6` — compression. Keeps the artifact small on a drive with room to spare.
- `-v` — progress on stderr, so a silent failure is not mistaken for success.
- **No `--clean`, no `--create`.** Those belong to a restore, and including them in a dump
  invites a careless restore that drops the live database.

### 3.4 Step 2 — verify the artifact (does **not** touch the live database)

```
powershell -NoProfile -Command "Get-Item C:\easeit-backups\easeit-pre-b1-20261026.dump | Select-Object Length, LastWriteTime"

D:\easeit-devdb\pg\pgsql\bin\pg_restore.exe -l C:\easeit-backups\easeit-pre-b1-20261026.dump > C:\easeit-backups\toc.txt

powershell -NoProfile -Command "(Get-Content C:\easeit-backups\toc.txt | Measure-Object -Line).Lines"
powershell -NoProfile -Command "Select-String -Path C:\easeit-backups\toc.txt -Pattern 'TABLE DATA public (reservation|inventory_day|folio_line|room_type) ' | ForEach-Object { $_.Line }"
```

**Acceptance:** `Length` is non-zero and plausible (expect single-digit MB); `pg_restore -l`
**exits 0** — the decisive check, because it parses the archive header and table of contents, so
a truncated or corrupt dump fails here; the TOC lists `TABLE DATA` entries for `reservation`,
`inventory_day`, `folio_line` and `room_type`. A dump whose TOC cannot be listed is not a backup,
and a non-zero file size alone proves nothing.

### 3.5 Step 3 — restore-feasibility check (requires separate approval)

This **creates a new scratch database**. It never touches `easeit`.

```
D:\easeit-devdb\pg\pgsql\bin\createdb.exe -h 127.0.0.1 -U <user> easeit_restore_test

D:\easeit-devdb\pg\pgsql\bin\pg_restore.exe -h 127.0.0.1 -U <user> -d easeit_restore_test --no-owner --no-privileges -j 2 -v C:\easeit-backups\easeit-pre-b1-20261026.dump
```

Then compare the restored copy against the original:

```sql
-- Run against easeit_restore_test, then against easeit, and diff the output.
SELECT 'room_type'     AS t, count(*) FROM room_type
UNION ALL SELECT 'reservation',   count(*) FROM reservation
UNION ALL SELECT 'inventory_day', count(*) FROM inventory_day
UNION ALL SELECT 'folio_line',    count(*) FROM folio_line
UNION ALL SELECT 'property',      count(*) FROM property
ORDER BY t;

SELECT md5(string_agg(id || ':' || "totalAmountMinor" || ':' || "taxAmountMinor", ',' ORDER BY id))
FROM reservation;
```

**Acceptance:** identical counts and an identical fingerprint in both databases; composite FK
count 11, `unique_pair` index count 6, exclusion constraint count 1 in the restored copy.

**Clean-up, only after the comparison passes** — and note this is a `DROP DATABASE`, which needs
its own explicit approval:

```
D:\easeit-devdb\pg\pgsql\bin\psql.exe -h 127.0.0.1 -U <user> -d postgres -c "DROP DATABASE easeit_restore_test;"
```

**Honest caveat:** a restore test on the same cluster proves the *artifact* is restorable. It does
not prove a restore would succeed on a different machine or after a disk failure, because it
shares the same binaries, locale and filesystem. For a development database that is proportionate;
for production it would not be.

---

## 4. Migration safety — detecting removal of hand-written integrity guarantees

### 4.1 The hazard, precisely

Eleven composite foreign keys, six `unique_pair` unique indexes, one GiST exclusion constraint
and 28 CHECK constraints are **hand-written SQL that `schema.prisma` does not describe**
[CODE: `grep "id, propertyId" schema.prisma` returns no match, yet the indexes exist]. Prisma's
datamodel therefore does not know they exist, and `prisma migrate dev` generates SQL that
**drops them** to make the database match the datamodel.

Measured earlier [DB]: `prisma migrate diff --from-schema … --to-config-datasource` reports **29
lines — 11 "Added foreign key" plus 6 "Added unique index", with nothing removed or changed**.
"Added" is from the datamodel's point of view, i.e. these objects exist in the database and not in
the schema. For the outbox migration, **17 drop statements** had to be stripped by hand; after B1
the standing count becomes **19** (one more composite FK target plus one more `unique_pair`).

A migration that silently dropped `inventory_day_same_property_as_room_type` or
`reservation_room_no_overlap` would remove a CLAUDE.md §3.1 guarantee **while every existing test
still passed**, because no test asserts the constraints exist. That is why §4.2 and §4.3 are the
controls, not the test suite.

### 4.2 Pre-apply census [DB-GATED]

Capture this **before** generating or applying anything, and keep the output.

```sql
-- A. Integrity-object census. These five numbers are the contract.
SELECT 'composite_fks'   AS object, count(*) AS n FROM pg_constraint
  WHERE contype='f' AND array_length(conkey,1)=2
UNION ALL SELECT 'unique_pair_idx', count(*) FROM pg_indexes
  WHERE schemaname='public' AND indexname LIKE '%unique_pair%'
UNION ALL SELECT 'exclusion',       count(*) FROM pg_constraint WHERE contype='x'
UNION ALL SELECT 'checks',          count(*) FROM pg_constraint WHERE contype='c'
UNION ALL SELECT 'all_fks',         count(*) FROM pg_constraint WHERE contype='f'
ORDER BY object;

-- B. The exact names, so a diff is by identity and not by count.
SELECT conrelid::regclass::text || '.' || conname AS name
FROM pg_constraint WHERE contype IN ('f','c','x')
UNION ALL
SELECT 'idx:' || indexname FROM pg_indexes WHERE schemaname='public'
ORDER BY name;

-- C. The two guarantees that matter most, asserted by name.
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conname IN ('inventory_day_not_oversold','reservation_room_no_overlap',
                  'inventory_day_counters_non_negative',
                  'inventory_day_same_property_as_room_type');
```

**Expected baseline** [DB, recorded earlier]: `composite_fks = 11`, `unique_pair_idx = 6`,
`exclusion = 1`, and all four names in (C) present. `checks` and `all_fks` are recorded as
whatever (A) returns, since no earlier total was captured for them — **capture them before the
migration or the post-apply comparison has no baseline.**

### 4.3 Detecting a destructive generated migration — before applying

```
rem 1. Generate WITHOUT applying.
pnpm --filter @repo/database exec prisma migrate dev --name rate_plan --create-only

rem 2. Scan the generated SQL for anything destructive. Any hit is a stop.
findstr /I /N "DROP TRUNCATE DELETE ALTER COLUMN RENAME" packages\database\prisma\migrations\<new>\migration.sql
```

**Rules for reading that output:**

| Match | Verdict |
|---|---|
| `DROP CONSTRAINT` / `DROP INDEX` naming an **existing** table | **Strip it.** This is the 19-statement problem |
| `ALTER COLUMN` / `RENAME` on an existing table | **Stop and investigate.** B1 alters no existing column |
| `TRUNCATE`, or `DELETE FROM` an existing table | **Stop.** B1 deletes nothing |
| `DROP` naming only `rate_plan` / `rate_plan_day` | Benign if part of an idempotent create, but B1's tables are new so this should not appear |
| `ON DELETE` / `ON UPDATE` inside an `ADD CONSTRAINT` | Benign — `findstr` matches the substring `DELETE`, so expect these as false positives |

Then append the hand-written block from document 16 §A.4 and re-read the file end to end before
applying. A `findstr` pass is a tripwire, not a substitute for reading it.

### 4.4 Post-apply census [DB-GATED]

Re-run §4.2 (A), (B) and (C) and compare:

| Object | Before | After | Rule |
|---|---|---|---|
| `composite_fks` | 11 | **13** | Exactly +2, both named `rate_plan_*_same_property_as_*` |
| `unique_pair_idx` | 6 | **7** | Exactly +1, `rate_plan_property_id_unique_pair` |
| `exclusion` | 1 | **1** | **Unchanged.** Any change means `reservation_room_no_overlap` was touched |
| `checks` | baseline | baseline **+4** | The four grouped CHECKs from §A.4. Back to four: the refundability gate went away with the column (§2.0), and `rate_plan_archived_implies_inactive` *replaces* the biconditional archive CHECK before it is ever applied rather than adding to it |
| Name set (B) | baseline | superset | **Every pre-existing name must still be present.** A set difference showing any removal is a failed migration, regardless of counts |
| (C) four names | present | present, **definitions identical** | `pg_get_constraintdef` compared as text |

The name-set comparison in (B) is the real control: counts can coincidentally balance if something
is dropped and something else added, whereas a missing name cannot hide.

---

## 5. Data-preservation checks

### 5.1 Why B1 cannot change existing data, structurally

The proposed statement inventory contains **zero** `UPDATE`, `DELETE`, `TRUNCATE` or `DROP`
against any existing table [document 16 §C.1]. The only write is `INSERT … SELECT` into
`rate_plan`, a table that does not yet exist. `RoomType.baseRateMinor` is **read** and never
written. So preservation is a property of the statement set, and the checks below confirm it
rather than establish it.

### 5.2 Before the migration [DB-GATED] — capture and keep

```sql
-- Row counts
SELECT 'room_type' t, count(*) n FROM room_type            -- expect 92
UNION ALL SELECT 'reservation',   count(*) FROM reservation     -- expect 952
UNION ALL SELECT 'reservation_room', count(*) FROM reservation_room  -- expect 952
UNION ALL SELECT 'inventory_day', count(*) FROM inventory_day   -- expect 46996
UNION ALL SELECT 'folio',         count(*) FROM folio           -- expect 51
UNION ALL SELECT 'folio_line',    count(*) FROM folio_line      -- expect 200
UNION ALL SELECT 'property',      count(*) FROM property        -- expect 21
UNION ALL SELECT 'room',          count(*) FROM room            -- expect 459
ORDER BY t;

-- Price fingerprints: the mechanical proof that no money moved.
SELECT md5(string_agg(id || ':' || "totalAmountMinor" || ':' || "taxAmountMinor"
                      || ':' || currency, ',' ORDER BY id)) AS reservation_prices
FROM reservation;

SELECT md5(string_agg(id || ':' || "amountMinor" || ':' || currency
                      || ':' || "chargeDate"::text, ',' ORDER BY id)) AS folio_line_prices
FROM folio_line;

SELECT md5(string_agg(id || ':' || "baseRateMinor" || ':' || currency, ',' ORDER BY id))
       AS room_type_rates
FROM room_type;

-- Invariant that must never be violated.
SELECT count(*) AS oversold FROM inventory_day
WHERE sold + blocked > physical + "overbookingAllowance";   -- expect 0
```

### 5.3 After the migration [DB-GATED] — the assertions

**Label note (2026-10-27):** these checks were numbered `P-1…P-17` until the fallback-policy
**proposals** arrived as `P-1…P-6` (§15). Two different things sharing one prefix in a checklist
that has to fail closed is a hazard, so the data-preservation checks are now **`DP-n`** and `P-n`
means a proposal awaiting confirmation. Only the labels changed; no check was added, removed or
weakened.

| # | Check | Expected |
|---|---|---|
| DP-1 | All eight row counts | **Identical** to §5.2 |
| DP-2 | `reservation_prices` fingerprint | **Byte-identical** |
| DP-3 | `folio_line_prices` fingerprint | **Byte-identical** |
| DP-4 | `room_type_rates` fingerprint | **Byte-identical** — proves `baseRateMinor` was read, not written |
| DP-5 | `oversold` | **0** |
| DP-6 | `rate_plan` row count | **92** |
| DP-7 | Every room type has exactly one plan | `SELECT count(*) FROM room_type rt WHERE NOT EXISTS (SELECT 1 FROM rate_plan p WHERE p."roomTypeId" = rt.id)` → **0** |
| DP-8 | No room type has two plans | `SELECT count(*) FROM (SELECT "roomTypeId" FROM rate_plan GROUP BY 1 HAVING count(*) > 1) s` → **0** |
| DP-9 | Rate fidelity | `SELECT count(*) FROM rate_plan p JOIN room_type rt ON rt.id = p."roomTypeId" WHERE p."defaultRateMinor" <> rt."baseRateMinor"` → **0** |
| DP-10 | `rate_plan_day` row count | **0** — the backfill creates no day rows |
| DP-11 | Tenant coherence | `SELECT count(*) FROM rate_plan p JOIN room_type rt ON rt.id = p."roomTypeId" WHERE rt."propertyId" <> p."propertyId"` → **0** (and the composite FK makes it unrepresentable) |
| DP-12 | Currency coherence | `SELECT count(*) FROM rate_plan p JOIN property pr ON pr.id = p."propertyId" JOIN room_type rt ON rt.id = p."roomTypeId" WHERE rt.currency <> pr.currency` → recorded as a **finding**, not a failure (document 16 §B.1) |
| DP-13 | `prisma validate` / `prisma migrate status` | valid / "Database schema is up to date" |
| DP-14 | §4.4 census | 13 / 7 / 1 / **+4**, with every pre-existing name still present |
| DP-15 | **No refundability column exists** | `SELECT count(*) FROM information_schema.columns WHERE table_name = 'rate_plan' AND column_name = 'isRefundable'` → **0**. The design removed it (§2.0); this asserts the migration did not reintroduce it |
| DP-15a | Cancellation terms untouched | `SELECT count(*) FROM property_policy` and an md5 fingerprint of `(type, "freeCancellationHours", "retentionChargePercent")` ordered by `id` — **both identical** before and after. B1 must not read, rewrite or normalise a single policy row |
| DP-16 | Backfilled sellability | `SELECT count(*) FROM rate_plan WHERE "isActive"` → **0**, and `SELECT count(*) FROM rate_plan WHERE "archivedAt" IS NOT NULL` → **0**. Not sellable, and not archived either — the "not yet activated" state |
| DP-17 | Plan codes | `SELECT count(*) FROM rate_plan p JOIN room_type rt ON rt.id = p."roomTypeId" WHERE p.code <> 'BAR-' || rt.code` → **0** |

DP-4 deserves emphasis: it is the check that distinguishes "the backfill copied the rack rate" from
"the backfill *moved* the rack rate", and nothing else in the set would catch the latter.

---

## 6. Decisions required, and the acceptance tests gating implementation

### 6.1 Decisions resolved 2026-10-27

| # | Decision | Resolution | Follow-on |
|---|---|---|---|
| **H-1** | Plan code shape | **Approved: C-a**, `'BAR-' || rt."code"`. The `(propertyId, code)` unique is unchanged; C-b and C-c are closed | §1.5's validation query still runs before the migration is applied |
| **H-6a** | `mealPlan` | **Approved: `'EP'`** for all 92 backfilled plans. `RoomType.baseRateMinor` is room-only, no breakfast, for every property | G-2 (meal plan on the plan or on the booking) stays open; `RatePlan.mealPlan` keeps **no** Prisma default |
| **H-6b** | `isRefundable` | **Resolved by removing the field** (§2.0, §2.4). `PropertyPolicy` stays the source of truth for cancellation terms; nothing is duplicated onto `RatePlan`; no confirmed requirement needs a per-plan policy. The nullable-column answer recorded earlier today is superseded, and its CHECK is gone with it | Activation is gated at the application level, V-1…V-7 (§2.6). U-10 is **closed**: no silent fallback |
| **H-8** | Where cancellation terms live, and what gates activation | **Decided** (§2.6): terms on `PropertyPolicy` only; activation behind V-1…V-7, stated plainly as weaker than a constraint because the precondition spans two tables | V-4's storage is unresolved (U-13); seeded values never satisfy it |
| **H-9** | Reservation pricing during B1 | **Decided: unchanged** until the B7 cutover is implemented and validated, with **no** fallback that sells from a plan whose cancellation policy is undefined | B1 touches no pricing code |

### 6.1a Still blocking [NEEDS YOU]

| # | Decision | Why it blocks |
|---|---|---|
| **H-7** | Approval to **start PostgreSQL**, then to take and verify the backup, and separately to run the restore-feasibility test (§3) | No implementation without a verified backup. **Not approved, and nothing in §3 has been run.** This is now the only blocker on B1 |

### 6.2 Non-blocking decisions already recorded

D-1 (180-day horizon, lands at gate G2 not B1), D-2 (writes return 404 behind a flag), D-3
(`Reservation.ratePlanId` deferred to B7), D-4 (reconciliation report-only, no recurring
schedule). All four remain **proposed engineering defaults**, not business requirements.

### 6.3 Acceptance tests required before B1 is considered done

| Order | Gate | Source |
|---|---|---|
| 1 | §1.5 code-uniqueness query: collisions 0, invalid 0, `max_len <= 13` | this document |
| 1a | The generated migration contains **no** `isRefundable` column and **no** `rate_plan_active_requires_refundability` (§2.0), and `rate_plan_archived_implies_inactive` replaces the biconditional archive CHECK | this document |
| 1b | **Fail closed on unconfirmed proposals.** No artefact of B1 — migration SQL, seed, config key, comment or test — encodes any of: `48` hours, `100` percent, a property-level fallback mechanism, "zero retention means nothing retained", or dual approval. All five are **proposals awaiting confirmation** (§15), and B1 needs none of them: it creates two tables and a backfill of inactive plans, and touches no cancellation policy | this document, §15 |
| 2 | §3.4 backup verified: `pg_restore -l` exits 0 and lists the four `TABLE DATA` entries | this document |
| 3 | §4.2 pre-apply census captured, including the full name set | this document |
| 4 | §4.3 generated SQL read in full; all 19 drops stripped; nothing destructive remains | this document |
| 5 | §5.2 baseline captured: eight counts, three fingerprints, oversold 0 | this document |
| 6 | §5.3 DP-1…DP-17 all pass — DP-15/DP-15a assert the removed column and untouched policy rows, DP-17 the approved code shape | this document |
| 7 | E.1–E.9 | doc 16 §E |
| 8 | `pnpm typecheck`, `pnpm lint`, `pnpm build` clean monorepo-wide | repo convention |
| 9 | `test:concurrency`, `test:checkin`, `test:outbox`, `test:outbox:concurrency`, `test:outbox:redis` all pass **unmodified** | repo convention; `test:outbox:redis` needs the Redis container, which is **not currently available** — see below |

Tests 7 and 9 require PostgreSQL. Test 9's Redis suite also needs Redis, and **an earlier
statement in this document that the container was "still running" is now false**: `docker ps`
fails with `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`,
i.e. **Docker Desktop itself is not running**, so the `easeit-redis` container is down. Starting
it is a system-state change outside this task's permission, so the suite is simply unavailable
until you bring Docker up. `test:outbox` and `test:outbox:concurrency` need no Redis by design.

**None of E.1–E.9 or 1–6 above has been run.** They are specified, not executed.

---

## 7. Open items not resolved by this checklist

Carried forward unchanged from document 16 §H: **U-1** `MealPlan` `BB`/`HB`/`FB` members;
**U-2** whether `standardOccupancy` belongs on the plan; **U-3** plan-level LOS precedence;
**U-4** the feature-flag mechanism (no flag facility exists in the repository); **U-5** the flat
`quote.nightlyRateMinor` wire contract under per-date rates, a breaking `web-admin` change due at
B7; **U-6** the six business questions; **U-7** the four provider questions.

Added by this checklist:

| # | Item |
|---|---|
| **U-8** | `room_type.code` has **no non-empty CHECK constraint** [CODE], so an empty code is representable and would yield the plan code `BAR-`. Harmless to uniqueness; §1.5 asserts against it. Whether to add such a CHECK is a separate, additive decision |
| **U-9** | `D:` is at **75% capacity (3.1 GB free of 12.3 GB)**, holding both the repository and the database cluster. The backup should go to `C:`, and the restore-feasibility test adds ~137 MB on `D:` |
| ~~**U-10**~~ | **Closed 2026-10-27.** Asked whether B7 should require policy configuration first or keep `RoomType.baseRateMinor` as a fallback for inactive plans. Decision 4 settles it: **no silent fallback.** An un-activated plan is not sellable, and reservation creation keeps its current path until the cutover is implemented and validated (§2.6) |
| **U-11** | **[DB-GATED]** Whether any of the 21 properties has *edited* its `CANCELLATION` policy row away from the seeded `48` hours / `100.00` percent. Either way the seeded values are fixtures, never a verified commercial policy (V-6) — but it tells us how much real configuration exists. Query: `SELECT count(*) FROM property_policy WHERE type = 'CANCELLATION' AND ("freeCancellationHours" <> 48 OR "retentionChargePercent" <> 100.00)`. Requires H-7 |
| **U-12** | **[PARTLY RESOLVED 2026-10-27]** BD-1, BD-2 and BD-3 settle the deadline anchor, the retention base and the meaning of `freeCancellationHours = 0`. **The remainder is tracked separately** and is not restated here: U-20 (charge/timing at zero), U-21 (whether `retentionChargePercent = 0` retains nothing), U-22 (a `NULL` term on an existing row). See §9.2 for what is confirmed and §13b–§13c for what is open |
| **U-13** | **[DESIGN — refined 2026-10-27, still a proposal]** How an operator's explicit approval is recorded (V-4). No column, table, service or audit event exists for it; `PROPERTY_POLICIES_REPLACED` records an edit, not a sign-off. §10 compares inferring approval from an append-only audit event against a **dedicated approval record** keyed to a canonical effective-policy fingerprint, and **recommends the dedicated record**. Its open consequences are U-23…U-26 (§13h) and U-27 (§13g). Nothing is implemented |
| **U-14** | **[CODE gap]** `property_policy` has **no unique on `(propertyId, type)`** — only `@@index([propertyId, type])` [CODE: `schema.prisma:1409`] — so two `CANCELLATION` rows with different terms are representable. V-1 must count rather than take the first. Adding the unique is a separate, additive decision |
| **U-15** | **[CODE gap]** `freeCancellationHours` has **no database CHECK**; it is bounded 0–8760 by the DTO and the UI only [CODE]. A direct SQL write could store a negative free-cancellation window. Additive to fix, out of B1 scope |
| **U-16** | **[UNRESOLVED]** A stable reference from a rate plan to a policy row is currently impossible, because `replacePolicies()` deletes and recreates every row on each save [CODE: `property-setup.service.ts:554-559`]. If per-plan policy is ever required, that write path has to change first (§2.4) |

---

## 8. Conflicts with documents 14 and 15, and the cross-references added

Rechecked after the 2026-10-27 decisions. Four conflicts, all now **cross-referenced in place** —
a header block in 14, and a header block plus one inline note in 15. Nothing else in either
document was touched, and no claim in them was rewritten or deleted: each conflict is marked and
pointed forward, so both stay readable as the dated record they are.

| Doc | Location | Conflict | Now |
|---|---|---|---|
| **14** | §B.2 model block: `isRefundable Boolean`, commented "A boolean, not a policy engine: … `PropertyPolicy` already holds prose policy text" | The field is **removed from the design** (§2.0, §2.4). The comment is also factually incomplete: `PropertyPolicy` holds *structured* terms, `freeCancellationHours` and `retentionChargePercent`, not only prose [CODE: `schema.prisma:1401-1404`] | Point 1 of 14's new header block → 16 §C.3a, 17 §2 |
| **14** | §H Stage 2: "`code = 'BAR'`, … `isRefundable = true`" | Two defects. The constant `'BAR'` collides — measured, it fails on all 21 properties with `23505` — and `isRefundable = true` asserts a commercial policy the business has not stated | Point 2 → 16 §C.3 |
| **14** | §B.2 DDL and §B.5: `rate_plan_archive_matches_active`, the biconditional | Would make the backfilled state — inactive, not archived — **illegal**, so a plan could not exist un-activated at all | Point 3 → 16 §A.4 |
| **15** | Its archive bullet: "`isActive = false` ⟺ `archivedAt IS NOT NULL`, enforced by `rate_plan_archive_matches_active`", plus `isRefundable` in its field list | **The same two conflicts**, and these mattered more: 15 is the *correcting* document and carried no superseded notice, so a reader trusting the newest word on each point would have built the biconditional CHECK | Header block + an inline **[SUPERSEDED 2026-10-27]** note on the bullet itself → 16 §A.4 |

**Why 14 and 15 were edited at all**, having been left alone in the previous round: this task
asked for cross-references where documents are superseded. The edits are additive pointers only
— no original sentence was changed or removed — which is the minimum that stops 15 reading as
current on a constraint the design no longer uses.

---

## 9. Cancellation-field semantics: what is confirmed, what is still open

**Revised 2026-10-27.** Four of the six questions this section posed are now **confirmed business
decisions** (BD-1…BD-4, doc 16 §H). The rest stay open, and where a decision deliberately stops
short of a boundary case I have **recorded the boundary as unresolved rather than inferring it** —
which is explicitly what BD-3 asks for.

### 9.1 What each field is, mechanically [CODE]

| Field | Stored as | Bounded by | Read by | Written by |
|---|---|---|---|---|
| `freeCancellationHours` | `Int?` on `property_policy` | **No DB CHECK.** `0–8760` in the write DTO and the UI only [CODE: `property-config.dto.ts:280`; `policies-tab.tsx:291-296`] | Nothing, for any decision. Returned in the setup payload and rendered in the config screen [CODE: `property-setup.service.ts:218`] | `replacePolicies()` only [CODE: `:554-559`] |
| `retentionChargePercent` | `Decimal(5,2)?` | `property_policy_retention_in_range`: `NULL OR 0–100` [CODE: `20261019080000_property_configuration/migration.sql:319-324`], plus the same range in DTO and UI | Same — nothing decides on it | Same |

Both are **independently optional**: the seeded `AMENDMENT` row carries hours with a null
retention [CODE: `seed-portfolio.ts:272-281`], so the pair is not an all-or-nothing unit today.

### 9.2 Confirmed decisions

| # | Decision | Status | What is deliberately not decided |
|---|---|---|---|
| **BD-1** | The free-cancellation deadline is calculated **backward from the property's local scheduled check-in time** on the arrival date | **CONFIRMED** | Which column is authoritative — `Property.checkInTime` (`"14:00"`, read today by the calendar, drawer and folio) or `PropertySettings.standardCheckInTime` (documented as the eventual home) [CODE: `schema.prisma:327,1233-1249`] — plus timezone and DST handling. **Open: U-18, §13e** |
| **BD-2** | The retention percentage applies to **one night's room tariff** | **CONFIRMED** | *Which* night, and the treatment of discounts, meal-plan components, taxes and currency rounding. **Open: U-19, §13d** |
| **BD-3** | **`freeCancellationHours = 0` means no free-cancellation window** | **CONFIRMED** | Everything else. What is charged at zero, from what instant, and the boundary case of a cancellation at the booking instant are **not** to be inferred from the zero. **Open: U-20, §13b.** An earlier draft of this section inferred "chargeable from the moment of booking"; that inference is **withdrawn** |
| **BD-4** | A missing property cancellation policy uses a **separately defined fallback policy** — not an automatic block, not an implicit zero or default | **CONFIRMED** | The fallback's terms, whether it is global or per-property, its governance, and whether it needs its own approval. **Open: U-17, §13a.** This supersedes the earlier "block activation" position in §2.6 and doc 16 §C.3b |
| **BD-5** | `RatePlan.isRefundable` stays removed; no cancellation term is duplicated onto `RatePlan` | **CONFIRMED** | Nothing. `PropertyPolicy` is the single source of truth (§2.4) |

**Nothing else belongs in the table above.** Six fallback-policy choices were supplied on
2026-10-27 — scope, the two terms, the approval model, the meaning of zero retention, and the
demand that zero-hour timing be defined. They are **proposals awaiting confirmation**, they are
**not** confirmed decisions, and they are recorded separately in **§15**. They must not be used as
implementation values.

### 9.3 Still open, and not guessed

| # | Question | Why it cannot be closed here |
|---|---|---|
| **U-21** | Does `retentionChargePercent = 0` mean **no amount is retained**? | `0` passes the CHECK, the DTO and the UI, so it is representable — but no consumer reads the field, so nothing in the repository gives it meaning. It is the symmetric question to BD-3 and was **not** covered by it. §13c |
| **U-22** | What does `NULL` mean in either term **on an existing `CANCELLATION` row**? | BD-4 defines what happens when the **row** is missing. It says nothing about a row that exists with a null term — reachable today, since the UI saves blanks (§2.5). Under BD-4 a null term is **not** a missing policy, so the fallback does not obviously apply to it |
| **U-20** | Charge and timing semantics at zero hours | BD-3 stops at "no free window", by instruction |

### 9.4 What this adds up to [CONFIRMED where marked]

> On a `CANCELLATION` row, `freeCancellationHours = N` means a guest may cancel with no charge
> until **N hours before the property's local scheduled check-in time on the arrival date**
> [BD-1]; **`0` means no free-cancellation window exists** [BD-3], with the charge and timing at
> zero left unspecified [U-20]. `retentionChargePercent = P` means **P% of one night's room
> tariff** is retained [BD-2], with the night, the discount and meal-plan treatment, and the
> rounding unspecified [U-19]; whether `0` means nothing is retained is unspecified [U-21].
> Where a property has **no** `CANCELLATION` row, the **separately defined fallback policy**
> applies [BD-4], and that fallback is undefined [U-17].

**None of this is implemented.** No code reads either field for any decision, and this task added
no code and no schema.

## 10. U-13 — how approval is recorded: design decision only

**Nothing here is implemented.** No table, column, service or test exists for any of it; this is a
design comparison with a recommendation, as instructed.

### 10.1 The repository patterns this rests on [CODE]

| Pattern | Evidence | Bearing |
|---|---|---|
| `AuditLog` | `event` is a **free-form `String`, not an enum**; `actorUserId String?`; `createdAt timestamptz(6)`; `before`/`after Json?`; `reason String?`; indexed `(propertyId, entityType, entityId)` [CODE: `schema.prisma:1590-1617`]. Eight event values in use, e.g. `PROPERTY_POLICIES_REPLACED` [CODE: grep over `apps/api/src`] | A new audit event needs **no migration**. Audit rows are already written in the same transaction as the change they describe [CODE: `property-setup.service.ts:561-578`], per CLAUDE.md §3.4 |
| `PaymentGatewayConfig` | A per-property state record: `@@unique([propertyId, provider], name: "gateway_unique_provider_per_property")`, `@@index([propertyId, status])`, a status enum, and a nullable `activatedAt timestamptz(6)` [CODE: `schema.prisma:1627-1651`] | **The precedent for a dedicated approval record.** It carries no composite tenant FK and no `unique_pair` index, because it references only `property` |
| `replacePolicies()` | Deletes every policy row for the property and recreates them on each save [CODE: `:554-559`] | Policy row **ids are not stable**, so an approval must key on a **fingerprint of the terms**, never on a policy row id |
| Hashing idiom | `createHmac('sha256', …).digest('hex')` for secrets [CODE: `apps/api/src/common/auth/token.service.ts:187`] | A fingerprint is not a secret, so plain `createHash('sha256')` is the right analogue — same algorithm, no key |

### 10.2 Option A versus Option B

| | **A — inferred from an append-only audit event** | **B — dedicated approval record + audit logging for history** |
|---|---|---|
| Shape | A new `event` value, e.g. `PROPERTY_CANCELLATION_POLICY_VALIDATED`, with the fingerprint in `after`. Approval = "the newest such event whose fingerprint equals the live one" | A row per `(propertyId, policyScope)` holding the approved fingerprint, approver and time; **plus** an audit row on every approval, so history is still in the log |
| Schema change | **None** | One table + one migration |
| Reading current state | From an append-only **log**, by newest-match. The index supports it, but a log is not a state store | A single row read, the same shape as `PaymentGatewayConfig` |
| Uniqueness of the answer | **Unconstrained.** Two approval events can coexist; "latest wins" is a convention | `@@unique([propertyId, policyScope])` makes the answer **structurally single** |
| Withdrawal / revocation | Needs a second event type and an ordering convention to interpret | A status column, or deleting the row, with the audit row as the record |
| Migration drift cost | Zero | **Also zero to the §4.1 count:** like `payment_gateway_config`, it references only `property`, so it needs no composite tenant FK and no `unique_pair` index. The 19 statements to strip stay 19 |
| Honest weakness | State read from a log; no uniqueness; revocation awkward | One more table, and the usual tenant-scoping obligations (`propertyId` leading every index, §3.2) |

**Recommendation: Option B** [PROPOSED]. I looked for a repository constraint that would argue
against it and found none — the opposite: `PaymentGatewayConfig` is the same shape already in use,
and the drift cost is zero because the table points only at `property`. Option A's two real
weaknesses (no uniqueness, state read from an append-only log) are exactly what a gate guarding
guest-facing commercial terms should not have.

### 10.3 Option B specified [PROPOSED]

**Canonical effective-policy fingerprint.** A SHA-256 over a canonical serialisation of the
**effective** policy (§2.6) — which may be the property's own row or the fallback:

| Input | Why |
|---|---|
| The policy **source**: `OWN` or `FALLBACK` | Approving the fallback is not the same act as approving your own terms (V-7) |
| `freeCancellationHours` as an integer, or an explicit `null` marker | The term itself |
| `retentionChargePercent` normalised to a fixed 2 decimal places | `Decimal(5,2)`; `48` and `48.00` must not fingerprint differently |
| `content`, the prose, normalised for line endings and trailing space | Text that changed while the numbers did not is still a changed policy |
| The **semantic version** below | A re-reading of the same numbers under new semantics needs re-approval |
| The property's `propertyId` | So one property's approval can never satisfy another's |
| **Not** the policy row `id`, `createdAt` or `updatedAt` | They change on every unrelated save (`replacePolicies()`), which would invalidate approvals spuriously |

**Policy version.** Two distinct numbers, and conflating them is the trap: a **content version**
(the fingerprint itself) and a **semantic version** — an integer naming the interpretation under
which the terms were approved, i.e. the BD-1/BD-2/BD-3 reading. Raising the semantic version
invalidates every approval, which is the correct behaviour when U-19, U-20 or U-21 is answered and
the same `100.00` starts to mean something different.

**Actor and time.** `approvedByUserId` (not nullable — a system actor cannot approve commercial
terms, unlike an audit row where null means the night audit) and `approvedAt timestamptz(6)`,
per §3.3.

**Stale-approval behaviour.** On activation and on publication, recompute the fingerprint from the
live effective policy and compare. Mismatch or absence ⇒ **refuse**, with a typed domain error per
CLAUDE.md §5. Nothing has to *write* an invalidation, which matters: an invalidation write is a
thing that can fail to happen. **[UNRESOLVED]** whether a stale approval should be deleted, kept
as history, or kept with a `STALE` status — U-23.

**Fallback approval.** The fingerprint's `FALLBACK` source means a fallback approval is a distinct
record from an own-policy approval. Whether one global approval covers every property or each
property must accept the fallback separately is **[UNRESOLVED]** — U-17, and it is a governance
question, not a schema one.

**Transaction consistency.** The approval row and its audit row are written in **one
transaction**, as `replacePolicies()` already does for policies and their audit row [CODE:
`:538-578`]. Activation reads the policy and the approval **inside the same transaction** as the
`isActive` write, so a policy edit committing between the check and the write cannot produce an
active plan with a stale approval. Per CLAUDE.md §3.1 that transaction contains no HTTP call, no
queue publish and no Redis read.

**Activation and publication checks.** Activation runs V-1…V-7 (§2.6). Publication re-checks the
fingerprint rather than trusting `isActive`, because the two acts are separated in time and a
channel push is the point at which terms become a promise to a guest. **[UNRESOLVED]** whether an
ARI payload must carry the approved fingerprint for dispute resolution — U-24.

**Effect on active plans.** A policy edit that changes the fingerprint leaves active plans
**immediately stale**, and staleness is computed, not stored — so nothing can be missed. What that
should *do* is a business decision: deactivate the property's plans at once, or withhold
publication while leaving the PMS alone, or warn only. **[UNRESOLVED]** — U-25, §13h. My own
inclination is to withhold publication and warn rather than deactivate, because deactivating
plans in response to a policy edit is a large, surprising side effect — but that is a preference,
not a decision.

**Effect on already-created reservations.** **None, and this is not negotiable.** A reservation's
money is a stored snapshot — `totalAmountMinor`, `taxAmountMinor`, `currency` on the reservation
and immutable `FolioLine` rows [CODE: `schema.prisma:827-828`, `:1513-1521`] — and §3.4 makes folio
lines immutable with reversal semantics. A later policy change must therefore **never** be applied
retroactively to an existing booking. The policy in force at booking time is identified by the
fingerprint, which is why recording it against the reservation is worth considering — but there is
**no column for it today** and adding one is a schema change this task may not make.
**[UNRESOLVED]** — U-26.

**New schema requirements, stated plainly:** one new table (approximately `propertyId`,
`policyScope`, `approvedFingerprint`, `semanticVersion`, `approvedByUserId`, `approvedAt`,
`createdAt`, `updatedAt`), one `@@unique([propertyId, policyScope])`, one `@@index` leading with
`propertyId`, one single-column FK to `property` with `onDelete: Cascade`. **No** composite tenant
FK and **no** `unique_pair` index, since it references only `property` — so the §4.1 drift count
stays 19. Optionally one reservation column (U-26). **This is a later stage, not B1**, and B1's
scope is unchanged by it.

## 11. Remaining gates, consolidated

| Class | # | Item | State |
|---|---|---|---|
| **Confirmed business decisions** | BD-1 | Free-cancellation deadline counted back from the property's local scheduled check-in time | Confirmed 2026-10-27 — anchor field open (U-18) |
| | BD-2 | Retention percentage applies to one night's room tariff | Confirmed 2026-10-27 — night, discounts, rounding open (U-19) |
| | BD-3 | `freeCancellationHours = 0` means no free-cancellation window | Confirmed 2026-10-27 — charge/timing at zero deliberately open (U-20) |
| | BD-4 | A missing property policy resolves to a **separately defined fallback policy** | Confirmed 2026-10-27 — **supersedes the earlier "block activation" position**; fallback undefined (U-17) |
| | BD-5 | `RatePlan.isRefundable` stays removed | Confirmed 2026-10-27 |
| **Resolved decisions** | H-1 | Plan code `'BAR-' \|\| rt."code"` | Approved 2026-10-27 |
| | H-6a | `mealPlan = 'EP'`; the rack rate is room-only | Approved 2026-10-27 |
| | H-6b | `RatePlan.isRefundable` removed; `PropertyPolicy` is the source of truth | Decided 2026-10-27 |
| | H-8 | Activation gated application-level (V-1…V-7), not by a CHECK | Decided 2026-10-27 |
| | H-9 | Reservation pricing unchanged until B7; no silent fallback | Decided 2026-10-27 |
| | U-10 | B7 fallback question | **Closed** by H-9 |
| **Proposed — NOT approved** | P-1 | Fallback **scope = property-level** | **Awaiting your confirmation** (§15). Does not decide the data model, ownership, versioning or lifecycle |
| | P-2, P-3 | Fallback terms: `freeCancellationHours = 48`, `retentionChargePercent = 100` | **Awaiting your confirmation** (§15). **Not** usable as implementation values |
| | P-4 | **Dual approval** | **Awaiting your confirmation** (§15). Does **not** resolve U-27 |
| | P-5 | `retentionChargePercent = 0` means no amount retained | **Awaiting your confirmation** (§15). U-21 stays open until then |
| | P-6 | Zero-hour charge timing **must be defined** | **A requirement to decide, no rule supplied** (§15). U-20 stays open |
| **Unresolved business** | U-17 | The fallback policy's terms, scope (global or per-property), governance, and whether it needs its own approval | **Needs you.** Blocks activation in practice, not B1. Proposals P-1…P-3 are pending (§15) |
| | U-18…U-22 | Anchor field and DST (U-18); tariff night, discounts, meal plan, rounding (U-19); charge/timing at zero hours (U-20); whether `retentionChargePercent = 0` retains nothing (U-21); a `NULL` term on an existing row (U-22) | **Needs you.** §13 |
| | U-27 | Who may approve a cancellation policy, and whether editor and approver must be different people | **Needs you.** Governance; no approval-shaped permission exists [CODE] (§13g) |
| | U-6 | G-1 multiple plans per room type; G-2 meal plan on plan or booking; G-3 occupancy pricing; G-4 derived rates; G-5 restriction types; G-6 reconciliation ownership | Needs you; none blocks B1 |
| | U-11 | Whether any property has edited its seeded cancellation terms | **[DB-GATED]** behind H-7 |
| **Design decisions open** | U-13 | How operator approval is recorded (§10) | **Proposal: option B**, a dedicated approval record keyed to a canonical effective-policy fingerprint. One new table; zero added migration drift |
| | U-23…U-26 | Stale-approval disposition (U-23); whether an ARI payload carries the fingerprint (U-24); what a policy change does to active plans (U-25); whether a reservation records the policy fingerprint in force (U-26) | Open; all later than B1 |
| | U-4 | The feature-flag mechanism; no facility exists | Needs a decision before G5 |
| | U-5 | The flat `quote.nightlyRateMinor` wire contract | Breaking `web-admin` change, due at B7 |
| | U-2, U-3, U-16 | `standardOccupancy`'s home; plan-level LOS precedence; stable policy references | Open, none blocks B1 |
| **Documentation defects** | — | Nine stale statements found in this pass | **All corrected** — §12 |
| **Migration / DB safety** | H-7 | Start PostgreSQL, take and verify `pg_dump`, then separately the restore test (§3) | **NOT APPROVED. Nothing run.** The only blocker on B1 |
| | §1.5 | Plan-code validation query | [DB-GATED] |
| | §4.2 / §4.4 | Pre- and post-apply constraint census, by name set | [DB-GATED] |
| | §4.3 | Read the generated SQL; strip all 19 drops | Procedure, after H-7 |
| | §5.2 / §5.3 | Baseline and DP-1…DP-17 | [DB-GATED] |
| | U-14, U-15, U-8 | No unique on `(propertyId, type)`; no CHECK on `freeCancellationHours`; no non-empty CHECK on `room_type.code` | Additive fixes, each its own decision |
| **Provider / onboarding** | U-1 | `MealPlan` `BB`/`HB`/`FB` members | No provider contract confirmed |
| | U-7 | G-7 per-plan vs room-type restrictions; G-8 payload limits; G-9 availability scope; G-10 conditional writes | No provider contract confirmed |
| | G2 before G6 | Inventory-calendar prerequisite before any publication | Non-negotiable ordering (16 §F) |
| | — | Per-property cancellation-policy configuration and approval, **or** an approved fallback | Onboarding dependency created by H-8 and BD-4; blocks activation, not B1 |
| **Environment** | — | PostgreSQL down (port 5432 not listening); **Docker Desktop down**, so `easeit-redis` is unavailable | Unchanged by this task; starting either needs your approval |

---

## 12. Corrections made by this verification pass

Documentation-only. Nine stale or self-contradictory statements, with what each said before:

| # | Where | Was | Now |
|---|---|---|---|
| 1 | 16 header | "Neither is overwritten" | Records the additive pointers added to 14 and 15 |
| 2 | 16 §A.2 | The removed-field note used `///`, which in Prisma documents the **next** declaration — it would have become `standardOccupancy`'s description | Plain `//`, with the reason stated |
| 3 | 16 §B.5 | "B1 enforces only the `isActive` ⟺ `archivedAt` coherence CHECK" | The one-directional `rate_plan_archived_implies_inactive`, with why |
| 4 | 16 §C.4 | No assertion on the backfilled `isActive`, the absent column, or `property_policy` | Three assertions added, matching 17 DP-15/DP-15a/DP-16 |
| 5 | 16 §C.6 | "Baseline: 64 entries — 31 modified, 33 untracked" | Corrected for commit `9061481`: that work is now committed, and the tree holds documentation changes only |
| 6 | 16 §F, gate G1 | "Your approval of §A, §C and the C-a code decision" | C-a is approved; H-7 named as the only open blocker |
| 7 | 16 §G Q6 | "One incompatibility was found and is unresolved: the `BAR` code collides" | Found **and resolved** by C-a |
| 8 | 16 §G Q8 | "Baseline: 64 git entries … this task created one file and modified nothing" | Restated against the real tree, with the verification command |
| 9 | 17 header | "documents 14 and 15 are unmodified — see §8 for the one conflict" — which §8 itself contradicted | Both carry additive pointers; four conflicts, listed in §8 |

Plus two smaller ones: §1.1's "I recommend C-a" now reads as approved, and §6.3's claim that the
Redis container "is still running" is corrected — Docker Desktop is down.

**Checked and found clean:** no active `RatePlan.isRefundable` field or migration column; no
active `rate_plan_active_requires_refundability`; no obsolete refundability backfill value; no
duplicate H-6b row, heading, revision header or backfill column; census counts consistent at
13 / 7 / 1 / +4 across both documents; CHECK count 4 in 16 §C.1 matching the four in §A.4; the
backfill (`isActive = false`), the activation gate (V-1…V-7) and the B7 cutover (no silent
fallback) agree in both documents; and **no claim anywhere that a database CHECK enforces the
cross-table precondition** — 16 §C.3b, 16 §A.4's comment, 16 §E.5 and 17 §2.6 all state the
opposite explicitly.

---

## 13. Open-question register

The eight questions asked of this round, each separated into what is **confirmed**, what is a
**proposal of mine**, and what is **open**. Nothing in the "open" column has been decided or
inferred anywhere in these documents.

### 13a. Fallback policy — exact terms, and global or property-specific

| | |
|---|---|
| **Confirmed** | A missing property cancellation policy **uses a separately defined fallback policy** — not an automatic block, not an implicit zero or default (BD-4) |
| **Open** | Its `freeCancellationHours` and `retentionChargePercent`; its prose; whether it is **one global fallback or per-property**; who defines and amends it; whether amending it requires re-approval everywhere it is in force; whether it needs its own approval before a property may rely on it (V-7) |
| **Consequence today** | **The fallback does not exist in any form** — no row, column, constant or config key [CODE: nothing in `packages/database`, `packages/types` or `apps/api/src` defines one]. So a property with no own policy currently has no effective policy and cannot be approved. That is the fallback being undefined, **not** a block |
| **Proposed 2026-10-27, not approved** | **P-1** scope = **property-level** (a fallback configured per property, *not* one platform-wide policy); **P-2** `freeCancellationHours = 48`; **P-3** `retentionChargePercent = 100`. See §15. These are proposals: they do **not** decide the fallback's data model, source, configuration ownership, versioning, approval lifecycle, or what happens when a property's own fallback configuration is missing or incomplete |
| **Tracked as** | U-17, and §15 P-1…P-3 for the pending proposals |

### 13b. Zero free-cancellation hours — precise behaviour and boundaries

| | |
|---|---|
| **Confirmed** | `freeCancellationHours = 0` means **there is no free-cancellation window** (BD-3) |
| **Open** | What is actually charged on cancellation at zero — presumably the retention charge, but that is **not stated**; from what instant the charge applies; the boundary case of a cancellation in the same instant as, or before, the booking is confirmed; whether a no-show is the same case; whether zero differs from a null term |
| **Note** | An earlier draft of §9 inferred "chargeable from the moment of booking". **Withdrawn**, per the instruction not to infer beyond the decision |
| **Status 2026-10-27** | **A requirement to decide, not a rule anyone has written.** You have said this must be defined; you have **not** supplied the rule, and none is proposed here (**P-6**, §15). The specific choices needed for confirmation are enumerated in §15 under P-6 |
| **Tracked as** | U-20, and §15 P-6 |

### 13c. Does `retentionChargePercent = 0` mean no amount retained?

| | |
|---|---|
| **Open — not covered by BD-3**, which is about the hours field only |
| **Evidence** | `0` is representable and distinct from null at every layer: the CHECK permits it, the DTO is `z.number().min(0).max(100)`, the UI regex accepts `"0"` [CODE: `property-config.dto.ts:28,281`; `policies-tab.tsx:299-306`]. **No consumer reads the field**, so nothing in the repository gives `0` a meaning |
| **Why it matters** | Under BD-2 the percentage multiplies one night's tariff, so `0` reads naturally as "nothing retained" — but reading naturally is not a decision, and the symmetric question for hours was answered explicitly rather than inferred |
| **Proposed 2026-10-27, not approved** | **P-5**: `retentionChargePercent = 0` means **no amount is retained** (§15). This matches the natural reading, which is a reason to confirm it and **not** a reason to treat it as confirmed |
| **Tracked as** | U-21, and §15 P-5 |

### 13d. Nightly tariff selection, discounts, meal plan, currency rounding

| | |
|---|---|
| **Confirmed** | The retention percentage applies to **one night's room tariff** (BD-2) |
| **Open** | **Which** night — the first night, the highest, or an average over the stay (they differ on a seasonal rate); whether the base is pre- or post-discount; whether a meal-plan component is included when the plan is not `EP`; whether tax is included — CLAUDE.md §3.4 requires taxes to be their own folio lines, never folded into a base, so this must be explicit; and the **rounding policy**, which §3.4 requires to be explicit and single-pass, half-up at line level by default |
| **Evidence available** | `Money` already provides the arithmetic: `multiply`, `percentage`, `allocate` and `allocateByWeights` [CODE: `packages/types/src/money.ts:187,199,214,235` — verified by reading the file's exports]. So the computation has a home; *what* it should compute is the open part. **Incidental finding:** CLAUDE.md §3.4 names the helper `multiplyByRate`, which **does not exist** — the code has `multiply` and `percentage`. A naming discrepancy in the blueprint, not a defect in the code, but worth one line in a later cleanup |
| **Tracked as** | U-19 |

### 13e. Authoritative check-in-time field, timezone and DST

| | |
|---|---|
| **Confirmed** | The deadline is counted **backward from the property's local scheduled check-in time** (BD-1) |
| **Open** | **Which column is authoritative.** Both exist: `Property.checkInTime String @default("14:00")` [CODE: `schema.prisma:327`] and `PropertySettings.standardCheckInTime String @default("14:00")` [CODE: `:1249`]. The schema's own comment says the times "stay on `Property` as well, for now: the calendar, the drawer and the folio all read them from there", and that `PropertySettings` "is the place they will move to" [CODE: `:1233-1238`] — so today's readers use `Property`, and the documented intent is to move. A deadline calculation must name one and follow the move |
| **Also open** | DST. `Property.timezone` defaults to `"Asia/Kolkata"` [CODE: `:298`], which has no DST — so the portfolio as seeded never exercises the problem, which is exactly how it ships broken for a property in a DST zone. Whether "N hours before local check-in" is wall-clock or elapsed time across a transition is undecided, and §3.3 requires all date maths to go through the `packages/types` helpers with an explicit timezone |
| **Tracked as** | U-18 |

### 13f. Duplicate or incomplete `CANCELLATION` rows

| | |
|---|---|
| **Verified reachable** [CODE] | Three states: a row with both terms null; **no** row at all; and **two** rows with different terms — there is no unique on `(propertyId, type)`, only `@@index([propertyId, type])` [CODE: `schema.prisma:1409`], and `replacePolicies()` accepts any set of up to 40 with no refinement on type [CODE: `property-config.dto.ts:272-286`; `property-setup.service.ts:554-559`] |
| **Confirmed** | The **no-row** case resolves to the fallback (BD-4) |
| **Open** | What **two rows** mean — reject, take the newest, or treat as unconfigured; what a row with a **null term** means, since BD-4 covers a missing row and not a missing term (U-22); and whether to add the unique constraint (U-14) or a DTO refinement, each additive and each its own decision |
| **Proposal of mine** | V-1 **counts** rather than taking the first, so duplicates fail loudly instead of silently picking one [PROPOSED] |
| **Tracked as** | U-14, U-22 |

### 13g. Who may approve, and must editor and approver differ?

| | |
|---|---|
| **Open — entirely.** No approval mechanism exists, so no permission governs it |
| **Evidence** | The permission catalogue already declares `rates:read`, `rates:manage`, `channels:read`, `channels:sync` and `inventory:override` [CODE: `packages/types/src/rbac.ts:114-119`], each with a label, description and sensitivity flag in the catalogue block [CODE: `:281-313`]. **There is no approval-shaped permission at all** — `grep -n "approve\|Approval" rbac.ts` returns nothing, verified this round. Policy *edits* are authorised through `property-setup.service.ts`'s own `authorise()` [CODE: `:536`, inside `replacePolicies`] |
| **Open specifically** | Which role may approve — an existing one, or a new permission such as `policy:approve`; whether **editor and approver must be different people** (segregation of duties), which is a governance decision with a real cost at a 50-staff portfolio where one person may be the only admin; and whether the fallback's approval is a portfolio-level act requiring a different actor again |
| **Proposed 2026-10-27, not approved** | **P-4**: a **dual-approval** model (§15). It does **not** resolve U-27: the precise mechanics, which roles are eligible, whether the two approvers must be **distinct people**, whether an editor may be one of them, and the authorisation boundaries are all still undecided. A proposed model is not a governance decision |
| **Consequence for §10.3** | The approval record there carries a **single** `approvedByUserId`/`approvedAt` pair. If P-4 is confirmed, that shape needs a second actor and a partial-approval state — recorded here as a **consequence of a pending proposal**, not as a design change |
| **Note** | Option B's `approvedByUserId` is **not nullable** in my proposal (§10.3), which already encodes "a system actor cannot approve commercial terms" — that much is a design position, not a governance decision |
| **Tracked as** | U-27, and §15 P-4 |

### 13h. Policy changes affecting active rate plans and existing reservations

| | |
|---|---|
| **Confirmed consequence** | **Existing reservations are never affected.** A reservation's money is a stored snapshot — `totalAmountMinor`, `taxAmountMinor`, `currency`, plus immutable `FolioLine` rows [CODE: `schema.prisma:827-828`, `:1513-1521`] — and §3.4 makes folio lines immutable with reversal semantics. No policy change may be applied retroactively |
| **Mechanically settled** | Under option B, a policy edit changes the fingerprint and therefore makes any approval **immediately stale**, computed rather than stored, so staleness cannot be missed (§10.3) |
| **Open** | What staleness should **do** to an active plan: deactivate the property's plans at once, withhold publication while leaving the PMS untouched, or warn only (U-25); what the stale approval row becomes — deleted, retained as history, or flagged `STALE` (U-23); whether an ARI payload carries the approved fingerprint for dispute resolution (U-24); and whether a reservation should record the policy fingerprint in force at booking, for which **no column exists** (U-26) |
| **Proposal of mine** | Withhold publication and warn, rather than deactivate — deactivating plans as a side effect of a policy edit is large and surprising. **A preference, not a decision** [PROPOSED] |
| **Tracked as** | U-23, U-24, U-25, U-26 |

---

## 14. Corrections made by the post-decision consistency review

A second verification pass, run after BD-1…BD-5 were confirmed. Eleven corrections, every one
either stale text that conflicted with a confirmed decision or a missing cross-reference. **No
open question was decided, and no document was rewritten.**

| # | Document / section | Was | Now | Severity |
|---|---|---|---|---|
| F-1 | 17 §2.1, the `isActive` row | "Not sellable until the property's cancellation policy is configured **and validated** (§2.5)" — the pre-BD-4 rule, **and** a wrong cross-reference (§2.5 is the UI question; the gate is §2.6) | "an **approved effective cancellation policy** … its own policy, or the separately defined fallback (BD-4) … (§2.6)" | **Medium** — it contradicted BD-4 in a table a reader builds the backfill from |
| F-2 | 17 §2.3, the conclusion | "Whether `0` *is* the agreed encoding is a business decision that **exists nowhere in the repository** … Recorded as U-12" | Split: `freeCancellationHours = 0` **confirmed** by BD-3 with timing open (U-20); `retentionChargePercent = 0` **still open** (U-21) | **Medium** — directly contradicted BD-3 |
| F-3 | 17 §2.2, the closing note | Left the whole `CANCELLATION` null case open without reference to what BD-3 and BD-4 had since settled | Adds what each decision did and did not reach, leaving the remainder as U-22 | Low |
| F-4 | 16 §H (H-8), 16 §E.5, 17 §6.1 (H-6b), 17 §6.1 (H-8), 17 §11, 17 §12 — **six places** | "V-1…V-6" | "V-1…V-7" — V-7 (the fallback's own approval) was added with BD-4 and the ranges were never updated | Low — but it silently dropped the fallback-approval check from every summary |
| F-5 | 17 §7, the U-12 row | Restated all of U-12 as open, including "is `0` the agreed encoding" | Marked **partly resolved**, with the remainder pointing to U-20/U-21/U-22 rather than restating it | Low — same document contradicted its own §9.2 |
| F-6 | 17 §7, the U-13 row | "**[UNRESOLVED]** … Any answer is a schema change" — written before §10 existed | Marked refined-but-still-a-proposal, naming §10's recommendation and its consequence items | Low |
| F-7 | 17 §11, the gate table | **U-27 was missing entirely** — defined in §13g, absent from the consolidated gates | Added as an unresolved business row | Low — an open governance decision invisible in the table meant to list them |
| F-8 | 16 §H, the U-13 row | No pointer to U-23…U-27 | Names all five consequence items and where they live, without restating them | Low |

**Classified as valid, and deliberately left alone:** every "block activation" phrase in 16's
header, 16 §H BD-4, 17 §9.2 BD-4, 17 §11 and 17 §13a — each is a *supersession note* recording
that the rule changed, not the rule itself; 17 §11's "blocks activation, not B1" on the onboarding
row, which is the live rule (absence of **approval** does block activation — BD-4 removes the block
for a missing *policy*, not for a missing *approval*); document 14's `isRefundable Boolean` at
§B.2 and its §H Stage 2 backfill, both carrying inline **[SUPERSEDED]** markers; and document 15's
field list naming `isRefundable`, which its header block names by location.

**Re-checked after editing, all clean:** no occurrence of "configured and validated" anywhere; no
"V-1…V-6"; U-1…U-27 with no duplicate *definitions* — 16 holds U-1–7, 10, 12–15, 17–22 and
references 23–27 by pointer, while 17 holds the full register in §7 and §13; **every** mention of a
CHECK and this precondition states that a CHECK **cannot** express it (16 §A.4's comment, 16 §C.3b,
16 §B.1 for the currency analogue, 17 §2.6); the policy fallback and the price fallback are
distinguished in a two-row table in both 16 §C.3b and 17 §2.6; and the backfill state
(`isActive = false`, `archivedAt IS NULL`) is identical in 16 §C.3, 16 §C.4, 17 §2.1 and 17 DP-16.

---

## 15. Pending confirmation — the fallback-policy proposals (P-1…P-6)

> **Status: PROPOSED — AWAITING USER CONFIRMATION. None of these is an approved business
> decision, a design decision, or an implementation requirement.** They are recorded here,
> separately from the confirmed register in §9.2, precisely so that no checklist, gate or
> acceptance criterion can promote them by accident. **No implementer may use any value below
> until it is confirmed.**

Supplied 2026-10-27, alongside the confirmed BD-1…BD-5. The confirmed decisions are unchanged by
them.

| # | Proposal, exactly as given | What it does **not** decide |
|---|---|---|
| **P-1** | Fallback **scope = property-level**: a separate fallback configuration **for each property**, rather than one universal platform-level policy | Everything about *how*. Not the data model, not the fallback's source, not whether it is another `PropertyPolicy` row or a global record copied per property or any other schema, not configuration ownership, not versioning, not the approval lifecycle, and **not** what happens when a property's own fallback configuration is itself missing or incomplete. "Property-level" fixes the *scope*, nothing else |
| **P-2** | Fallback `freeCancellationHours = **48**` | Whether 48 is right; see the seed-value note below |
| **P-3** | Fallback `retentionChargePercent = **100**` | Whether 100 is right; and *of what*, since BD-2 fixes the base as one night's room tariff while U-19 leaves the night, discounts, meal plan, tax and rounding open — so "100%" does not yet denote a determinate amount |
| **P-4** | Approval model = **dual approval** | The mechanics; which roles are eligible; whether the two approvers must be **distinct people**; whether the editor of a policy may be one of them; the authorisation boundaries. **U-27 remains open** — a proposed model is not a governance decision. Consequence for §10.3, recorded but not applied: that design carries a single `approvedByUserId`/`approvedAt` pair and would need a second actor and a partial-approval state |
| **P-5** | `retentionChargePercent = 0` means **no amount is retained** | Nothing further. **U-21 stays open** until confirmed. It also does **not** define `NULL` — that is U-22, and BD-4's missing-*policy* fallback does not reach a null *term* on a row that exists |
| **P-6** | Zero-hour charge timing and boundary behaviour **must be defined** | **The rule itself. You have not supplied one, and none is proposed or inferred here.** BD-3 fixes only that `freeCancellationHours = 0` means there is no free-cancellation window. **U-20 stays open** |

### 15.1 P-6 — the choices that need deciding, stated without choosing

A requirement to decide, enumerated so confirmation is a matter of picking, not drafting. **No
option below is recommended or assumed.**

| Choice needed | The alternatives, neutrally |
|---|---|
| What is charged at zero hours | The retention charge per BD-2/P-3, or something else, or nothing |
| From what instant it applies | The moment the booking is confirmed; the start of the arrival date; the local scheduled check-in instant (the BD-1 anchor); or another instant |
| The equality boundary | Whether a cancellation **exactly at** the deadline instant is inside or outside the free window — and the same question at zero hours, where the deadline *is* the anchor |
| Cancellation at or before the booking instant | Whether an immediate cancellation is charged at all |
| Relationship to no-show | Whether a no-show is the same case as a zero-hour cancellation or a separate rule |
| Interaction with `NULL` | Whether a null term behaves as zero, as unconfigured, or as something else — overlaps U-22 and must not be settled by implication |

### 15.2 A finding you should see before confirming P-2 and P-3

**The proposed fallback terms are numerically identical to the seeded development fixtures.** The
seed writes `freeCancellationHours = 48` and `retentionChargePercent = '100.00'` to **every**
property [CODE: `seed-portfolio.ts:259-271`] — and documents 16 §C.3b (V-6) and 17 §2.6 (V-6)
record that those seeded values **never constitute an approval**, on the reasoning that identical
terms across all 21 properties are a fixture rather than commercial policy.

Both statements can hold at once, and it is worth being precise about how:

- **V-6 stands.** It is about *provenance*: a value written by a seed has not been approved by
  anyone, whatever the value is. Confirming P-2 and P-3 would not retrospectively approve the
  seeded rows; each property's effective policy would still need V-4.
- **But V-6's reasoning can no longer be used to infer that 48/100 is *wrong*.** If you confirm
  them as the fallback's terms, the coincidence stops being evidence of anything.
- **The practical consequence:** confirming P-2/P-3 makes the seeded rows **indistinguishable by
  value** from a deliberately configured policy. U-11's query — "has any property edited its
  cancellation row away from the seeded values?" — would then return nothing useful, because an
  edit *to* those same numbers is invisible to it. If distinguishing configured from seeded
  matters after confirmation, it has to come from the approval record (§10), not from the values.

This is a finding, not an objection, and it resolves nothing. It is here because it is cheaper to
see now than after implementation.

### 15.3 What is unaffected by all six proposals

| Confirmed, and unchanged | Where |
|---|---|
| BD-1…BD-5 | §9.2; doc 16 §H |
| Backfilled plans are `isActive = false`, `archivedAt IS NULL` | §2.1; doc 16 §C.3 |
| Activation/publication requires an **approved effective policy**, enforced **application-level and not by a database CHECK** | §2.6; doc 16 §C.3b |
| Reservation pricing unchanged until B7; **no** silent price fallback to `RoomType.baseRateMinor` | §2.6; doc 16 §C.3b, §H H-9 |
| Existing reservations' financial snapshots and agreed terms are **never** retroactively rewritten | §13h; doc 16 §B.6 |
| `RatePlan.isRefundable` stays removed | §2.0, §9.2 BD-5 |
| **B1 itself needs none of P-1…P-6.** It creates two tables and backfills inactive plans; it reads and writes no cancellation policy | §5.1, §5.3 DP-15a |

### 15.4 Infrastructure status, unchanged and not authorised by this round

PostgreSQL is **down**; Docker Desktop is **down**, so the Redis container is unavailable;
**H-7 remains unapproved**; **no backup exists** and **no restore test has been performed**. None
of P-1…P-6 changes that, and nothing in this document authorises starting a service, taking a
backup or running a migration.
