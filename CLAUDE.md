# EaseIt — Engineering Blueprint

Authoritative architecture and engineering guide for this repository. Read this before writing code.
When this file conflicts with a pattern you find in the codebase, this file wins — and the inconsistent
code is a bug worth reporting.

---

## 1. Project Overview & Scope

**EaseIt** is an all-in-one, multi-tenant hospitality platform combining three products in one codebase:

1. **Hotel PMS** — reservations, room inventory, front desk (check-in/out), folios & billing,
   housekeeping, night audit, reporting.
2. **Channel Manager sync layer** — two-way sync of Availability, Rates and Inventory (ARI) with OTAs
   (Booking.com, Expedia, Agoda, Airbnb, MakeMyTrip) and inbound reservation ingestion.
3. **Direct Booking Engine** — public, per-property booking website with payment capture.

Positioned as a **Stayflexi alternative**, scoped deliberately narrow: this is not a general-purpose SaaS
for the open market.

### Scale & shape of the problem

| Dimension          | Target                                   | Consequence for design                                       |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------ |
| Properties         | **10** (fixed portfolio)                 | A single Postgres instance is correct. Do not shard.         |
| Concurrent staff   | **~50** across all properties            | Vertical scaling suffices. Do not build for 10,000 tenants.  |
| Rooms per property | 20–200                                   | Inventory calendars are small; per-date rows are affordable. |
| Public traffic     | Direct booking engine, bursty            | Cache availability reads; never cache writes.                |
| Tenancy model      | **Single database, row-level isolation** | `propertyId` on every transactional table.                   |

### Core users

- **Admin / Owner** — full access to one or more properties, user management, rate configuration, reports.
- **Front Desk** — reservations, check-in/out, folio posting, payments, guest profiles.
- **Housekeeping** — room status board, task assignment, inspection. Read-only on financials.
- **Revenue / Channel Manager** — rate plans, restrictions, ARI pushes, channel mappings, overbooking limits.
- **Night Auditor** — triggers/reviews audit runs, closes business dates, reconciles cash.
- **Public guest** — unauthenticated, booking engine only. Sees exactly one property's data.

### Explicit non-goals

Do not build these unless the scope changes in this file first:

- Microservices, service mesh, gRPC between internal modules, Kafka.
- Multi-region or multi-database tenancy.
- A plugin marketplace, white-label theming engine, or public API for third-party developers.
- Mobile native apps (the web apps are responsive).
- A generic workflow/rules engine.

---

## 2. Architecture & Tech Stack

### Monorepo

**pnpm workspaces + Turborepo.** One repository, one deployable backend, two deployable frontends.

```
easeit/
├─ apps/
│  ├─ api/                   # NestJS + Fastify — the ONLY backend
│  ├─ web-marketing/       # yourdomain.com (Public landing page, features, pricing)
│  ├─ web-admin/             # Next.js App Router — internal staff dashboard
│  └─ web-booking/           # Next.js App Router — public guest booking engine
├─ packages/
│  ├─ database/              # Prisma schema, migrations, generated client, seed
│  ├─ types/                 # Shared zod schemas, DTO types, domain enums, Money
│  ├─ config/                # eslint, tsconfig, tailwind, prettier presets; env schema
│  └─ ui/                    # shadcn/ui components shared by both web apps
├─ turbo.json
├─ pnpm-workspace.yaml
└─ CLAUDE.md
```

### Backend — `apps/api`

- **NestJS** with the **Fastify** adapter (`@nestjs/platform-fastify`), TypeScript strict mode.
- Modular monolith. One NestJS module per bounded context; modules talk through injected services
  and an in-process event bus — **never over HTTP**.
- Module layout (each is a folder under `src/modules/`):

  | Module           | Owns                                                             |
  | ---------------- | ---------------------------------------------------------------- |
  | `auth`           | Login, sessions/JWT, RBAC guards, property-scope resolution      |
  | `properties`     | Property config, timezones, currency, tax rules, users           |
  | `inventory`      | Room types, rooms, per-date availability calendar, restrictions  |
  | `rates`          | Rate plans, rate calendar, derived/linked rates, promotions      |
  | `reservations`   | Booking lifecycle, stay segments, room assignment, modifications |
  | `frontdesk`      | Check-in/out, room moves, walk-ins, arrivals/departures boards   |
  | `folios`         | Folios, charges, taxes, payments, settlements, invoices          |
  | `housekeeping`   | Room status, tasks, assignments, inspections                     |
  | `nightaudit`     | Audit run orchestration, business date roll, daily snapshots     |
  | `channels`       | Channel mappings, ARI push outbox, inbound reservation ingestion |
  | `booking-engine` | Public search, quote, hold, book endpoints                       |
  | `reporting`      | Occupancy, ADR, RevPAR, manager flash, tax reports               |
  | `platform`       | Cross-cutting: request context, audit log, outbox, jobs, mail    |

- Transport: REST with zod-validated DTOs. GraphQL is not used.

### Database & cache

- **PostgreSQL** (16+) — single logical database, single schema.
- **Prisma ORM** — the only data access path. Raw SQL is permitted only via `$queryRaw`/`$executeRaw`
  with parameterized tagged templates, and only for cases Prisma cannot express
  (exclusion constraints, `pg_advisory_xact_lock`, window functions in reports).
- **Redis** — two distinct roles, never confused:
  - **BullMQ** queues for all asynchronous work (night audit, ARI pushes, emails, report generation).
  - Short-TTL read cache for public availability search. Caching is **always** keyed by
    `propertyId` and is **never** read inside a booking transaction.

### Web apps

Both use **Next.js (App Router)**, **Tailwind CSS**, **shadcn/ui** from `packages/ui`.

- **`apps/web-admin`** — authenticated staff dashboard. Centerpiece screens: the reservation calendar
  (room × date grid with drag-to-assign), folio management, arrivals/departures, housekeeping board,
  night audit console, rate & restriction calendar. Property is selected explicitly and persisted in
  session; every request carries it.
- **`apps/web-booking`** — public, SEO-indexed, one site per property. Tenant resolved from the URL
  (`/{propertySlug}/...` in development, `{slug}.domain.com` in production) and resolved **server-side**
  into a `propertyId`. The slug→id mapping is never trusted from a client header or query param.

Server Components for reads, Server Actions or route handlers for writes. The web apps hold no business
logic — they call `apps/api`.

### Shared packages

- **`packages/database`** — `schema.prisma`, migrations, seeds, and a `createPrismaClient()` factory with
  the tenancy extension (§3.2) applied. Nothing else imports `@prisma/client` directly.
- **`packages/types`** — zod schemas as the single source of truth for every DTO, plus domain enums,
  `Money`, `BusinessDate`, and derived TS types. Imported by `api` and both web apps.
- **`packages/config`** — shared `tsconfig`, eslint, prettier, tailwind presets, and the zod-validated
  environment schema. Every app validates env at boot and crashes on invalid config.
- **`packages/ui`** — shadcn/ui primitives and composed hospitality components (occupancy bar, stay-range
  picker, money input, room-status pill). No data fetching, no app-specific state.

---

## 3. Architectural Invariants

These are not preferences. Code that violates an invariant is broken regardless of whether tests pass.

### 3.1 Concurrency — never allow a double booking

A double booking is the single worst failure this system can produce. Two layers of defense, both required:

**Layer 1 — Database constraints (the real guarantee).**

- **Room-type level availability** is held in a per-date counter table with a `CHECK` constraint that
  physically cannot go negative:

  ```sql
  -- inventory_day: one row per (property_id, room_type_id, stay_date)
  ALTER TABLE inventory_day
    ADD CONSTRAINT inventory_day_not_oversold
    CHECK (sold + blocked <= physical + overbooking_allowance);
  ```

  Selling a room means `UPDATE ... SET sold = sold + 1` on each stay date. A conflicting concurrent
  booking fails the constraint and the whole transaction rolls back. This is correct under any
  isolation level.

- **Room-number level assignment** is guarded by a Postgres exclusion constraint, so the same physical
  room can never hold two overlapping stays:

  ```sql
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  ALTER TABLE reservation_room
    ADD CONSTRAINT reservation_room_no_overlap
    EXCLUDE USING gist (
      room_id WITH =,
      daterange(arrival_date, departure_date, '[)') WITH &&
    ) WHERE (status NOT IN ('CANCELLED', 'NO_SHOW'));
  ```

  Prisma cannot express exclusion constraints. Add them in a hand-written SQL migration and never
  remove them. Departure day is exclusive — `'[)'` — because a room checked out in the morning is
  sellable that night.

**Layer 2 — Application transactions.**

- Every operation that creates, modifies, moves, extends, or cancels a reservation runs inside a single
  `prisma.$transaction(async (tx) => { ... })`. No exceptions.
- Inside that transaction, acquire locks in a **fixed order** to avoid deadlocks: property → room type →
  stay dates ascending. Use `SELECT ... FOR UPDATE` on `inventory_day` rows, or
  `pg_advisory_xact_lock(hashtext($1))` keyed on `propertyId:roomTypeId` when locking a contended range.
- **Never** read availability, release the connection, and then write. Read-check-write must be one
  transaction. A "check availability" API response is advisory only and must be re-verified at commit time.
- Keep transactions short: no HTTP calls, no queue publishes, no email sends, no Redis reads inside a
  transaction. Side effects go through the **outbox table** written in the same transaction and drained
  by a BullMQ worker afterwards.
- Set an explicit `timeout` and treat serialization failures (`40001`) and constraint violations (`23514`,
  `23P01`) as **retryable**: retry up to 3 times with jitter, then surface a clean
  `RoomUnavailableError` to the caller.
- Overbooking is allowed **only** through an explicit, per-room-type `overbookingAllowance` set by a
  Revenue Manager. It is never a side effect of a race.

**Required test.** Every reservation write path has an integration test that fires N parallel requests
against the last available room and asserts exactly one succeeds. Deleting or weakening these tests is
not permitted.

### 3.2 Multi-tenancy — no cross-property leaks

- Every transactional/operational table carries a non-nullable `propertyId`. Reference tables shared
  across the portfolio (country codes, currencies, channel definitions) do not, and must be explicitly
  listed in `packages/database/src/global-tables.ts`.
- Every composite index and unique constraint on operational data leads with `propertyId`
  (e.g. `@@unique([propertyId, confirmationCode])`, `@@index([propertyId, arrivalDate])`).
  A unique constraint that omits `propertyId` is a bug — it couples unrelated hotels.
- The current property lives in an **AsyncLocalStorage** request context (`platform/request-context`),
  populated by a guard from the authenticated session (admin) or the resolved slug (booking engine).
  It is never read from a client-supplied header, body field, or query parameter.
- A **Prisma client extension** injects `where: { propertyId }` into every `find*`, `update*`, `delete*`,
  `count`, and `aggregate` on tenant-scoped models, and stamps `propertyId` on every `create`. Escaping
  it requires the explicit, reviewed, and logged `withoutTenantScope()` helper — permitted only for
  night-audit orchestration, cross-property admin reporting, and migrations.
- **Postgres Row-Level Security is enabled as a backstop** on tenant-scoped tables, using
  `SET LOCAL app.current_property_id` at the start of each transaction. The ORM extension is the primary
  control; RLS is the thing that saves you when someone forgets it.
- A staff user's accessible properties are an explicit allowlist (`UserPropertyAccess`). Switching
  property re-authorizes; it does not merely change a dropdown.
- **Required test.** For each module, a test that authenticates as Property A and asserts that reading,
  updating, and deleting a Property B record returns not-found — never a 403 that confirms existence.

### 3.3 Night audit — deterministic, background, per-property local time

- The night audit **never** runs synchronously on a user request. A user action can only _enqueue_ a run
  and poll its status.
- Implemented as a BullMQ job per property, scheduled from the property's configured IANA timezone
  (`Asia/Kolkata`, `America/New_York`, …). Ten properties means ten independent schedules; one property's
  failure must not block another's.
- A run is identified by `(propertyId, businessDate)` and is **idempotent**: re-running a completed audit
  is a no-op, and a run interrupted midway resumes from its last committed step. Each step is a row in
  `night_audit_step` with its own transaction and a deterministic outcome.
- Canonical step order (each step commits independently, in order):
  1. Validate preconditions (no open cashier shifts, no unassigned in-house stays).
  2. Roll no-shows for unarrived reservations past the property's cutoff.
  3. Post room charges and taxes for all in-house stays for the business date.
  4. Post recurring/scheduled charges.
  5. Settle and close zero-balance folios; flag exceptions.
  6. Snapshot daily statistics (occupancy, ADR, RevPAR, revenue by category) into an immutable table.
  7. Advance `property.businessDate` by one day.
  8. Emit reports and notifications **via the outbox**, not inline.
- **Business date is not a timestamp.** It is a calendar date owned by the property and advanced only by
  step 7. All financial postings reference the business date, never `now()`. Reports agree with the
  closed books because they read snapshots, not live aggregates.
- Timestamps are stored in UTC (`timestamptz`); calendar values (`arrivalDate`, `businessDate`,
  `stayDate`) are stored as `@db.Date` and must never be constructed from a client's local time.
  All date math goes through `packages/types`' date helpers with an explicit timezone argument.
- Snapshots are **append-only**. Correcting a closed day means posting an adjustment on the current
  business date, never mutating history.

### 3.4 Money and state — integers only

- **Every monetary amount is an integer in the currency's minor unit** (cents, paise), stored as `Int`
  (or `BigInt` where totals can exceed 2³¹) and always paired with an ISO-4217 `currency` column.
- `Float`, `Double`, and JS `number` arithmetic on money are banned. Prisma `Decimal` is permitted only
  for non-money quantities: tax _rates_, percentages, occupancy ratios, exchange rates.
- All money flows through the `Money` type in `packages/types`: `{ amountMinor: number; currency: string }`,
  with `add`, `subtract`, `multiplyByRate`, `allocate`, and `format`. Mixing currencies throws.
- Rounding is **explicit and single-pass**. A documented rounding policy per property (default:
  half-up at the line level) is applied once when a charge is created, and the rounded integer is what
  gets stored. Never round a total that was computed from unrounded intermediates.
- Taxes are stored as their own folio lines with a reference to the charge they derive from — never
  folded into a base amount. Inclusive vs. exclusive tax is a property-level setting and must be
  explicit in every quote.
- A folio balance is always derived by summing its integer lines. Never cache a balance in a mutable
  column; if a materialized balance is needed for performance, it is maintained inside the same
  transaction as the line insert and reconciled by the night audit.
- Folio lines are **immutable**. A mistake is corrected with a reversing line carrying `reversesLineId`,
  preserving the audit trail.
- Reservation and folio **status is a state machine**, not a free-form string. Legal transitions live in
  one place per aggregate (`reservations/reservation.state.ts`) and are enforced in the domain layer.
  Writing a status field directly from a controller or a Prisma call outside the aggregate is a bug.
- Every mutation of money, reservation state, rates, or restrictions writes an `audit_log` row (actor,
  property, entity, before/after, reason) in the same transaction as the change.

---

## 4. Repository Commands

Run from the repository root. Turborepo handles ordering, caching, and dependency graph.

### Day to day

```bash
pnpm install                 # install all workspace deps (pnpm only — never npm/yarn)
pnpm dev                     # api + web-admin + web-booking in watch mode
pnpm dev --filter=api        # single app
pnpm build                   # typecheck + build every package and app
pnpm lint                    # eslint across the monorepo
pnpm lint:fix
pnpm typecheck               # tsc --noEmit everywhere; must be clean before any commit
pnpm format                  # prettier
```

### Database

```bash
pnpm db:generate             # regenerate Prisma client (after any schema change)
pnpm db:migrate              # create + apply a dev migration (prompts for a name)
pnpm db:migrate:deploy       # apply pending migrations — CI/staging/production
pnpm db:seed                 # seed the 10-property dev portfolio with demo data
pnpm db:studio               # Prisma Studio
pnpm db:reset                # DROP and rebuild local dev DB — local only, destructive
```

`prisma db push` is **forbidden** outside a throwaway local scratch database. Schema changes always
ship as a reviewed migration file. Migrations are never edited after merge; roll forward instead.

### Testing

```bash
pnpm test                    # unit tests (vitest), all packages
pnpm test:watch
pnpm test:integration        # API + DB tests against a disposable Postgres/Redis (testcontainers)
pnpm test:concurrency        # parallel-booking race suite — must pass before any reservation change
pnpm test:e2e                # Playwright against web-admin and web-booking
pnpm test --filter=api
```

### Background workers

```bash
pnpm worker:dev              # BullMQ workers in watch mode
pnpm queue:ui                # Bull Board — inspect queues, retries, failures
pnpm audit:dry-run -- --property=<slug> --date=YYYY-MM-DD   # night audit, no writes
```

---

## 5. Coding Conventions

### TypeScript

- `strict: true` everywhere, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- **`any` is banned.** Use `unknown` and narrow. A genuinely unavoidable cast carries a comment
  explaining why it is safe.
- No non-null assertions (`!`) on values crossing a trust boundary — validate instead.
- Branded types for identifiers: `PropertyId`, `ReservationId`, `FolioId`. Don't pass bare strings
  where a typed id exists; it is how cross-property bugs get written.
- Prefer discriminated unions over optional-field soup. Make illegal states unrepresentable.
- `export type` for types, named exports only. No default exports outside Next.js pages.

### NestJS & dependency injection

- **Constructor injection only.** `private readonly` parameter properties. No property injection,
  no service locator, no `new SomeService()` inside business code.
- Depend on the narrowest thing that works: a service, not a module; an interface token, not a concrete
  class, wherever a boundary is likely to be faked in tests (channel adapters, payment gateways, clock,
  mailer).
- **The clock is injected** (`ClockService`). `new Date()` and `Date.now()` do not appear in domain code —
  it makes night audit and timezone behavior untestable.
- `forwardRef` is **not allowed**. A circular dependency means the module boundary is wrong: extract a
  shared module, or decouple with an event.
- Layering is strict and one-directional:
  `controller → application service → domain → repository → Prisma`.
  A controller never touches Prisma. A domain object never imports Nest decorators. A repository never
  contains business rules.
- Guards for authorization (`@Roles()`, `PropertyScopeGuard`), interceptors for logging/metrics,
  pipes for validation, filters for error mapping. Business logic lives in none of them.
- Lifecycle: no work in constructors. Use `OnModuleInit` for startup work so it is observable and
  failures are visible at boot.

### DTOs and typing at the boundary

- **One schema, one source of truth.** Every request/response shape is a zod schema in
  `packages/types`, with its TS type inferred from it. The API validates with it; both web apps import
  the same schema for forms and typed fetch clients.
- Three distinct kinds of type — never collapse them:
  1. **DTO** — the wire contract. Versioned, additive, explicit.
  2. **Domain model** — rich behavior, invariants enforced in constructors/factories.
  3. **Prisma model** — persistence shape. An implementation detail.
- **Prisma models are never returned from a controller.** Map explicitly through a mapper function.
  Returning a Prisma row leaks `propertyId`, internal flags, and future columns you did not intend
  to publish.
- Always `select` the fields you need. Bare `findMany()` and deep `include` trees are rejected in review:
  they overfetch and silently widen the response contract when the schema changes.
- Requests never accept `propertyId`, `id`, `createdAt`, `status`, or computed totals from the client.
  Server-owned fields are server-owned. Use dedicated command DTOs
  (`CreateReservationCommand`, `MoveRoomCommand`) rather than partial entity patches.
- Money crosses the wire as `{ amountMinor, currency }`. Never as a formatted string, never as a float.
- Dates: `YYYY-MM-DD` strings for calendar dates, ISO-8601 UTC for instants. Both are validated and
  parsed at the boundary, never passed through as raw strings.
- Pagination is cursor-based (`{ items, nextCursor }`) for anything that grows unbounded —
  reservations, folio lines, audit logs.

### Error handling

- Domain failures are **typed exception classes** extending `DomainError`, each with a stable machine
  code: `RoomUnavailableError` (`ROOM_UNAVAILABLE`), `InvalidStateTransitionError`,
  `FolioAlreadyClosedError`, `RateNotBookableError`, `ChannelRejectedError`.
- A single global `DomainExceptionFilter` maps `DomainError` → HTTP status + a uniform body:
  `{ code, message, details?, requestId }`. Controllers do not build error responses.
- **Never swallow an error.** No empty `catch {}`, no `catch { return null }`. Either handle it
  meaningfully, enrich and rethrow, or let it propagate.
- Never leak infrastructure errors to clients. Prisma errors (`P2002`, `P2025`, …) and driver codes are
  translated at the repository boundary into domain errors. A raw stack trace or SQL string in a
  response body is a security bug.
- Expected-and-recoverable is a **result**, not an exception: `canBook()` returns a reason, it doesn't
  throw. Reserve exceptions for broken invariants and genuine failures.
- Log with structured context (`requestId`, `propertyId`, `userId`, `reservationId`) — and **never** log
  guest PII, card data, or full channel payloads containing either. Log once, at the boundary that
  handles the error; not at every level it passes through.
- External calls (channels, payment gateways, mail) always have an explicit timeout, bounded retries
  with backoff, and a circuit breaker. A failing OTA must degrade the sync layer, never the front desk.
- BullMQ jobs are idempotent and keyed so a retry cannot double-post a charge or re-send a confirmation.
  Set `attempts`, backoff, and a dead-letter destination on every queue. A job that fails permanently
  must alert, not vanish.

### Channel sync specifics

- Inbound OTA reservations are **idempotent on the channel's reservation id**: store the raw payload
  first, then normalize in a separate step, so a parser bug never loses a booking.
- Outbound ARI pushes go through the **outbox**, debounced per `(propertyId, roomTypeId, dateRange)`, and
  are ordered per property. A push is retried until acknowledged, and every attempt is logged with
  request/response for dispute resolution.
- A channel adapter implements a single interface and contains **no** business rules — mapping only.
  Channel-specific quirks stay inside the adapter.

### Testing

- Unit tests on domain logic with no database: pricing, tax, state machines, date/business-date math,
  allocation and rounding.
- Integration tests for every write path against a real Postgres (testcontainers) — in-memory fakes
  cannot prove constraint behavior, which is where our correctness guarantees actually live.
- Mandatory suites that must never be deleted or skipped:
  - parallel-booking race tests (§3.1),
  - tenant-isolation tests per module (§3.2),
  - night-audit idempotency and resume tests (§3.3),
  - money rounding and folio-balance reconciliation tests (§3.4).
- Tests assert behavior, not implementation. No snapshotting of entire API responses as a substitute
  for asserting the fields that matter.

### Git & review

- Conventional commits (`feat(reservations): …`, `fix(folios): …`, `chore(db): …`).
- A PR touching `schema.prisma` includes the generated migration and says, in the description, what it
  does to existing rows.
- A PR touching reservations, inventory, folios, or night audit states explicitly how the invariants in
  §3 are preserved.
- `pnpm typecheck && pnpm lint && pnpm test` clean before review. No `// eslint-disable` without a
  comment explaining why.

---

## 6. Agent Working Agreement

When working in this repository:

1. **Read before writing.** Check `schema.prisma` and the relevant module before adding a model,
   endpoint, or service — this domain has many near-synonyms (`Room` vs `RoomType` vs `ReservationRoom`,
   `Rate` vs `RatePlan` vs `InventoryDay`) and picking the wrong one silently breaks invariants.
2. **Never weaken a constraint to make something pass.** If a CHECK, exclusion constraint, unique index,
   or concurrency test blocks you, the code is wrong, not the constraint.
3. **Reservation, folio, inventory, and night-audit code is high-risk.** Changes there come with tests
   in the same change, and a note on which invariant covers them.
4. **Do not introduce a new runtime dependency, queue, datastore, or service boundary** without saying
   why the existing stack can't do it. The answer at 10 properties is almost always that it can.
5. **Do not run destructive commands** (`db:reset`, `db:migrate:deploy`, anything against a non-local
   database) without explicit confirmation.
6. **Money, dates, and `propertyId` are where bugs hide.** When reviewing or generating code, check
   those three first: integer minor units, explicit timezone, and tenant scope on every query.
