# Load profile and query profiling (PF-02, PF-03)

Recorded 2026-11-17. Re-run with the commands at the end; every figure here
comes from `scripts/load/*` output on the data described below.

## Setup

|                |                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| Host           | Intel i5-10300H (8 logical CPUs), 8 GB RAM, Windows 11 — a developer laptop, not production hardware     |
| API            | one process (`node apps/api/dist/main.js`), production build, port 4100                                  |
| Database       | PostgreSQL 17.6 on the same host, `easeit_racetest` (disposable), API connected as `easeit_app` with RLS |
| Load generator | the same host (`scripts/load/run-load.mjs`)                                                              |

**Data** (`pnpm load:seed`, deterministic): a year back and 90 days ahead for
the nine active portfolio hotels — 34,994 reservations, 87,284 nightly rates,
154,539 folio lines, a daily snapshot per hotel per closed day, inventory
counters recomputed from the stays. Roughly a year of trading for a portfolio
this size; 26-room hotels plus one 100-room hotel.

**Profile.** 50 virtual staff (CLAUDE.md's ~50 concurrent), spread over the
hotels by room count, each signed in to one hotel; every fifth is an
administrator who also runs reports. Each loops: an action by weight, then
1-4 s of think time. Weights follow a front-desk shift — dashboard 20,
calendar 16, folio 14, reservation detail 10, search 8, boards 6+6,
availability 4, book-then-cancel 5, payments 3, work orders 2, reports and
audit log rare. Latency is request start to full body; any non-2xx except an
expected sold-out 409 is an error.

## PF-02 results (after the PF-03 indexes)

**Steady — 50 staff with think time, 304 s:** 6,158 requests (20.3/s),
**p50 19 ms, p95 104 ms, p99 142 ms, 0 errors.**

| Action                    |    n | p50 ms | p95 ms | p99 ms |
| ------------------------- | ---: | -----: | -----: | -----: |
| Dashboard summary         | 1234 |     44 |    136 |    180 |
| Room calendar (week)      | 1009 |     20 |     43 |     68 |
| Folio                     |  866 |     14 |     39 |     66 |
| Reservation detail        |  602 |     12 |     36 |     59 |
| Reservation search        |  527 |     13 |     33 |     56 |
| Front-desk board          |  382 |     27 |     84 |    128 |
| Housekeeping board        |  375 |     20 |     45 |     67 |
| Book                      |  287 |     18 |     35 |     63 |
| Cancel                    |  253 |     13 |     35 |     66 |
| Availability (30 nights)  |  234 |      9 |     22 |     34 |
| Payments ledger           |  185 |     13 |     36 |     71 |
| Work orders               |  134 |     11 |     24 |     39 |
| Master report (30 days)   |   34 |     92 |    224 |    330 |
| Sales / flash / audit log |   36 |    ≤26 |    ≤62 |    ≤62 |

**Stress — the same 50 with no think time, 61 s:** 4,014 requests,
**66.3 requests/s**, p50 732 ms, p95 995 ms, p99 1160 ms, **0 errors**. This
is the ceiling of one API process on this laptop: latency is queueing in a
single Node event loop, which spends its time on the in-process Prisma query
engine and JSON, not on Postgres (the slowest hot query is ~17 ms). The
steady profile uses about a third of it.

**Integrity under load.** Across all runs 1,121 bookings were made and
cancelled concurrently with the reads. Afterwards every one of 45,310
`inventory_day` cells (per date, per category) equalled its live
`reservation_room` count, and none was oversold.

## PF-03 — what the database actually does

`pnpm load:profile` turns on `auto_explain` for the disposable database only
(`ALTER DATABASE … SET`, reset afterwards), drives the load, and reads every
plan back from the server log: 9,668 plans, 218 query shapes, ranked by total
time. It flags two shapes that grow with the data: a sequential scan reading
more than 5,000 rows, and a `propertyId`-led index entered **without** a
`propertyId` condition (a walk of the whole index).

### Finding: child rows looked up by parent id alone

Prisma relation loads fetch children by the parent id only
(`WHERE "reservationId" IN (…)`, `WHERE "folioId" = …`), and so did the
master report's folio join. The RLS policy adds
`bypass = 'on' OR "propertyId" = …`, which Postgres can never turn into an
index condition. So these lookups could not use the `propertyId`-led indexes:

| Table                                  | Before                                                                    | After      |
| -------------------------------------- | ------------------------------------------------------------------------- | ---------- |
| `reservation_night` by `reservationId` | sequential scan of all 88k rows, every call                               | index scan |
| `folio_line` by `folioId`              | whole-index walk, ~815 buffers per folio; ~100k buffers per master report | index scan |
| `reservation_guest` by `reservationId` | whole-index walk, ~283 buffers per call                                   | index scan |

Fix: migration `20261118090000_child_lookup_indexes`, three single-column,
non-unique indexes (like `reservation_room`'s existing `reservationId`
index), so no tenancy coupling. Measured on the same data and load:

|                                     | Before               | After             |
| ----------------------------------- | -------------------- | ----------------- |
| Master report folio query (mean)    | 465 ms, 103k buffers | 50 ms, 5k buffers |
| Master report endpoint p50 / p95    | 913 / 970 ms         | 92 / 224 ms       |
| Folio endpoint p50 / p95            | 28 / 61 ms           | 14 / 39 ms        |
| Flagged shapes (seq scan / no-lead) | 1 / 4                | 0 / 0             |

### Remaining, not changed

- **Dashboard all-time counts.** The CANCELLED / NO_SHOW / ON_HOLD cards and
  lists filter by status with no date bound, so they read every such
  reservation the hotel ever had (~5,400 index entries, ~14 ms at one year;
  linear in history). Index-only and cheap today. Bounding them changes what
  the card means — a product decision, not an index — so it is recorded, not
  fixed.
- **Status lists ordered by arrival date** read ~11,600 rows through the
  `(propertyId, arrivalDate)` index to return a page (~17 ms). Same cause and
  same decision as above.
- **One API process saturates at ~66 requests/s here.** Ample for 50 staff;
  a second process behind the reverse proxy is the lever if bursty booking
  engine traffic is added on the same box.

## Not covered

- The public booking engine's anonymous traffic (search/quote/hold) — this
  profile is staff, as PF-02 asks.
- Production hardware, a networked database, or a long soak (>5 minutes).
  Durations in the profiler include `EXPLAIN ANALYZE` overhead; they rank
  queries, they are not latency.

## Re-running

Disposable database only; the scripts refuse anything else.

```bash
# a database migrated and seeded, then a year of data (clears booking tables)
DATABASE_URL=<owner url of easeit_racetest> pnpm load:seed
# an API on that database (as easeit_app), then:
DATABASE_URL=<owner url> EASEIT_API_URL=http://127.0.0.1:4100/api/v1 pnpm load:run
# profiling: enable, restart the API, drive load, disable, report
DATABASE_URL=<owner url> pnpm load:profile enable <server.log>
DATABASE_URL=<owner url> pnpm load:profile disable
pnpm load:profile report <server.log> <offset printed by enable> out.md
```

`auto_explain` output goes to the Postgres server log, which grows by tens of
megabytes per profiled minute.
