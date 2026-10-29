# Testing and the release gate

What each check needs, what it proves, and what it does not. Read the warning in
§1 before running anything in Layer B or C.

---

## 1. `pnpm test` used to mean nothing

Verified, not assumed:

```
$ pnpm exec turbo run test --dry=json   →  8 "test" tasks, every one <NONEXISTENT>
$ pnpm test                             →  "Tasks: 3 successful" (those are builds), exit 0
```

No workspace package defines a `test` script. There is no vitest in this
repository and no `*.test.ts` anywhere, despite CLAUDE.md §4 advertising both.
Turbo treats a missing script as nothing to do rather than an error, so the
command was a green light wired to no sensor.

`pnpm test` now runs the real service-free suite (`scripts/gate.mjs --no-format`).
The old fan-out is still available as `pnpm test:turbo` if you want it; it still
runs nothing.

---

## 2. The three layers

| Command                 | Needs                              | Time    | Run it                                                             |
| ----------------------- | ---------------------------------- | ------- | ------------------------------------------------------------------ |
| `pnpm gate`             | nothing                            | ~4 s    | before every commit; CI on every PR                                |
| `pnpm gate:integration` | isolated PostgreSQL + an API on it | ~25 s   | before merging anything touching reservations, inventory or folios |
| `pnpm gate:resilience`  | the above **plus** isolated Redis  | minutes | before a release; nightly in CI                                    |

Each layer refuses to start rather than skipping when a prerequisite is absent.
That is the point: a suite that quietly does nothing reports success.

### Layer A — `pnpm gate`

1. `git diff --check` — trailing whitespace, conflict markers.
2. Prettier **on changed files only** (see §5).
3. `pnpm typecheck` — 10 packages.
4. `pnpm lint` — 11 packages.
5. `test/integration/cancel-retry.test.mjs` — the only suite that contacts
   nothing. It needs `DATABASE_URL` to be _present_, because the import chain
   constructs a Prisma client, but it never opens a connection.

Stops at the first failure and exits non-zero. `--no-format` skips step 2.

### Layer B — `pnpm gate:integration`

Runs, in order: outbox (PostgreSQL only), outbox claim race, check-in,
cancellation + concurrency, creation races.

```bash
# PostgreSQL must be running. On this machine it is a portable install with no
# Windows service:
/d/easeit-devdb/pg/pgsql/bin/pg_ctl.exe -D /d/easeit-devdb/data -l /d/easeit-devdb/pg-start.log start

# A disposable database, created once (see §4 to provision it):
export DATABASE_URL='postgresql://…@127.0.0.1:5432/easeit_racetest?schema=public'

# An API pointed at THAT database, on a port of its own:
node --env-file=<override with PORT=4100 and the same DATABASE_URL> apps/api/dist/main.js

export EASEIT_API_URL=http://127.0.0.1:4100/api/v1
pnpm gate:integration
```

### Layer C — `pnpm gate:resilience`

Outbox end-to-end through real BullMQ, plus the parallel-booking stress suite.

```bash
docker run -d --name easeit-redis-test -p 6380:6379 redis:7-alpine
export REDIS_URL=redis://127.0.0.1:6380
pnpm gate:resilience            # --no-stress omits the shared-fixture suite
```

---

## 3. Why these suites must never see the development database

**Every destructive suite guards itself.** All seven call
`test/support/isolation-guard.mjs` before creating, mutating or deleting a
single fixture, so protection does not depend on choosing the right entry
point. This matters because seven npm scripts invoke the suites directly, and
run that way the release gate's preflight never executes at all.

The rule the environment **cannot** override: a known shared database name
(`easeit`) is refused absolutely, by a built-in floor that does not depend on
any file being present. Separately, names discovered from this checkout's
`.env` files are also refused -- but only when they are not one of the
built-in disposable test databases, because CI writes those env files itself
and they legitimately name `easeit_ci`.
`EASEIT_TEST_DBS` may _extend_ the allowlist (that is how CI names
`easeit_ci`); it can never authorise the development database. Verified:

```
$ pnpm test:concurrency          # with the development .env in place
Suite error: REFUSING TO RUN — the parallel-booking stress suite
  x  "easeit" is a shared development database … no environment variable can authorise it.
exit=1
```

`create-race.test.mjs` keeps its own original guard, which already did the
same work plus an API probe.

The three API-driven suites additionally prove the **API** reached the same
database, using a reservation id read from it: seeded ids are random uuids, so
an API on any other database answers 404. Read-only, and it runs before the
first fixture.

`scripts/require-services.mjs` imports the same classifier, so the gate and the
suites cannot disagree. It refuses unless:

- `DATABASE_URL` names a database on the allowlist (`EASEIT_TEST_DBS`, default
  `easeit_racetest,easeit_recovery,easeit_ci`),
- the host is local,
- `current_database()` on the live connection **agrees with the URL**,
- all four guarding constraints exist (`inventory_day_not_oversold`,
  `reservation_room_no_overlap`, `inventory_day_counters_non_negative`,
  `reservation_cancelled_at_matches_status`) — without them a green run proves
  nothing,
- the API answers `/health`,
- Redis, when required, is reachable **and not on port 6379**.

That last rule matters more than it looks. `OutboxQueue` sets no BullMQ
`prefix`, so every process on one Redis shares `bull:outbox:*`, and
`outbox-redis.test.mjs` calls `obliterate({ force: true })`. On the shared
instance that destroys real queue state.

`parallel-booking` is excluded from Layer B because it mutates **shared**
inventory fixtures rather than suite-owned rows. It lives in Layer C, where the
context is explicitly pre-release.

It never prints a connection string — only host, port and database name.

---

## 4. Provisioning a disposable database

```bash
B=/d/easeit-devdb/pg/pgsql/bin
"$B/createdb.exe" -h 127.0.0.1 -U easeit -O easeit easeit_racetest

cd packages/database
DATABASE_URL=<…/easeit_racetest> DIRECT_URL=<same> pnpm exec prisma migrate deploy
DATABASE_URL=<…/easeit_racetest> DIRECT_URL=<same> pnpm exec tsx prisma/seed.ts
```

Node's `--env-file` and `process.loadEnvFile` both let an already-set
environment variable win over the file, so exporting `DATABASE_URL` is enough to
redirect the CLI — verified, because if the file won, migrations would hit the
development database.

### Backup and restore (manual; the one gap with no suite)

`pg_dump`, `pg_restore`, `pg_dumpall`, `pg_basebackup` are all present.
**Restore into a separate target, never over the source.**

```bash
"$B/pg_dump.exe" -h 127.0.0.1 -U easeit -d easeit_racetest -Fc -f backups/snapshot.dump
"$B/createdb.exe" -h 127.0.0.1 -U easeit -O easeit easeit_restore_verify
"$B/pg_restore.exe" -h 127.0.0.1 -U easeit -d easeit_restore_verify \
  --no-owner --exit-on-error backups/snapshot.dump
```

Then verify in four layers, because matching row counts would pass on a
structurally broken restore: object inventory from `information_schema`; the
four guarding constraints; per-table counts diffed against the source; and the
business invariants (no oversold or negative counters, no orphaned
`reservation_room`). The nightly `Release checks` workflow runs exactly this.

There is no point-in-time recovery: WAL archiving is not configured.

---

## 5. Formatting is scoped, and the backlog is grandfathered

`pnpm format:check` across the repository reports style issues in **153 files**,
all predating this gate. Making that blocking would fail every run until someone
reformats everything, which is a large diff and a separate decision.

So the gate checks a changed file only when it is **new** or was **already
Prettier-clean** at the comparison point. A file that was dirty before you
touched it is skipped and reported:

```
  12 changed file(s) vs HEAD
  skip  test/integration/cancel-reservation.test.mjs - was already unformatted before this change
  newly-touched files clean; 1 pre-existing left alone
```

That second rule is not theoretical. Editing ~30 lines of the 2,300-line
cancellation suite would otherwise have obliged a full reformat of it, burying
a real fix in unrelated churn - which is how formatting gates get disabled.

New code must be clean, clean code must stay clean, and the backlog shrinks only
when someone chooses to attack it. `pnpm gate --no-format` skips the check
entirely; `pnpm format:check` is unchanged for whoever reformats the repository.

---

## 6. Service requirements per suite

| Suite                     | PostgreSQL              | API | Redis   | Mutates shared fixtures | Identity guard of its own |
| ------------------------- | ----------------------- | --- | ------- | ----------------------- | ------------------------- |
| `test:cancellation:retry` | URL only, no connection | no  | no      | no                      | n/a                       |
| `test:outbox`             | yes                     | no  | no      | no                      | no                        |
| `test:outbox:concurrency` | yes                     | no  | no      | no                      | no                        |
| `test:checkin`            | yes                     | yes | no      | no                      | no                        |
| `test:cancellation`       | yes                     | yes | no      | no                      | no                        |
| `test:races`              | yes                     | yes | no      | no                      | **yes**                   |
| `test:outbox:redis`       | yes                     | no  | **yes** | no                      | no                        |
| `test:concurrency`        | yes                     | yes | no      | **yes**                 | no                        |

SMTP is never required. `SmtpMailer.onModuleInit` catches a failed `verify()`
and logs it, so an unreachable host does not block boot; leaving `SMTP_HOST`
unset selects the logging mailer instead.

---

## 7. Pinned versions

| Tool       | Version                                   | Where                       |
| ---------- | ----------------------------------------- | --------------------------- |
| Node       | 24.14.1 in CI; `engines` allows ≥ 20.11.0 | workflow `env.NODE_VERSION` |
| pnpm       | 9.14.4                                    | `packageManager` + workflow |
| Turbo      | 2.11.8                                    | root devDependency          |
| TypeScript | 6.0.3                                     | root devDependency          |
| Prettier   | 3.9.10                                    | root devDependency          |
| Prisma     | 7.10.0                                    | `packages/database`         |
| PostgreSQL | 17 (`postgres:17`; local 17.6)            | workflow service            |
| Redis      | `redis:7-alpine`, port 6380               | workflow service            |

---

## 8. What none of this covers

- **`40001` / `40P01` retry paths are not runtime-verified.** No deadlock or
  serialization failure is induced anywhere. The classifier is unit-tested and
  the lock-ordering audit found no two-party cycle among the five writers of
  `reservation` / `reservation_room` / `inventory_day` — an argument, not a
  proof.
- **The real SIGTERM graceful-shutdown path is untested on Windows**, which has
  no deliverable SIGTERM. The outbox suite drives what the handler _calls_
  (`onModuleDestroy` in Nest's order) and proves no row is left stuck, but
  graceful-versus-forced is only fully separable on Linux or in a container.
- **No business outbox handler exists.** `OutboxEventType` has exactly one
  value, `OUTBOX_SELF_TEST`, whose handler touches nothing outside the outbox
  tables, so "no duplicated business side effect" is unobservable today; only
  row-level idempotency is.
- **No frontend tests at all.** The three Next.js apps are typechecked and
  linted, never rendered. No Playwright, despite CLAUDE.md §4 listing
  `pnpm test:e2e`.
- **No unit tests on domain logic.** CLAUDE.md §4 requires vitest coverage of
  pricing, tax, state machines and rounding. None exists. This is the largest
  coverage gap in the repository and the gate cannot invent it.
