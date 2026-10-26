# The transactional outbox

Phase A of the Channel Manager. This is the delivery foundation only: there is no
channel, no mapping, no ARI push and no inbound reservation handling here, and the
only registered handler is a fake that performs no network call.

---

## What it is for

A reservation change has to reach an OTA, and `CLAUDE.md` §3.1 forbids HTTP calls,
queue publishes and mail sends inside a database transaction. So the transaction
writes a **row promising the work**, and a separate process performs it:

```
POST /reservations ──┐
                     │  one transaction
                     ├─ reservation rows
                     └─ outbox_event row          (OutboxService.enqueue)
                                 │
                   ┌─────────────┴───────────── worker process ──────────────┐
                   │  dispatcher: claim due rows, publish to BullMQ          │
                   │  worker:     run the handler, write the outcome back    │
                   └────────────────────────────────────────────────────────┘
```

Either the business change and the promise both commit, or neither does. There is
no window in which a booking exists with nothing to publish it.

---

## Running it locally

The API does **not** drain the outbox. It only enqueues, so it holds no Redis
connection and boots fine without Redis. Draining is a second process:

```bash
# 1. Redis. Docker only — do not install a native Windows Redis.
docker run -d --name easeit-redis -p 6379:6379 redis:7-alpine

# 2. The worker, in watch mode.
pnpm worker:dev            # or, from apps/api: pnpm worker
```

Redis must be reachable before the worker starts: it checks PostgreSQL and Redis
up front and exits non-zero if either is missing, so a supervisor restarts it
rather than letting it idle quietly. Stopping Redis later does not stop the API.

`REDIS_URL` defaults to `redis://localhost:6379`. The `OUTBOX_*` variables in
`apps/api/src/config/env.ts` tune the poll interval, batch size, lease, handler
timeout, concurrency and backoff; every one has a default, and the env schema
refuses a lease shorter than twice the handler timeout.

### Observing it

| Where | What |
| --- | --- |
| `GET /api/v1/health` | liveness — touches nothing |
| `GET /api/v1/health/ready` | readiness — **PostgreSQL only**, deliberately not Redis |
| `GET /api/v1/health/outbox` | backlog gauge — always 200, never a readiness verdict |
| worker log | backlog line every `OUTBOX_BACKLOG_LOG_MS`; `warn` when a dead letter or a stale lease exists |
| `pnpm queue:ui` | Bull Board, for the Redis side |

A backlog is a workload signal. Ten thousand pending events means the system is
working as designed; pulling the API out of a load balancer for it would turn a
queue into an outage.

### Tests

```bash
pnpm test:outbox              # enqueue, dedupe, claim, lease, retry, dead letter, constraints
pnpm test:outbox:concurrency  # N dispatchers racing one batch; concurrent reapers
pnpm test:outbox:redis        # end to end through real BullMQ — needs Redis
```

The first two need no Redis, because everything they assert is PostgreSQL-owned by
design. The third says `NOT RUN` and fails loudly rather than skipping silently, and
covers end to end: drain with nobody stepping it, retry to success, a worker killed
mid-handler, a bounded budget running out into DEAD, **total queue loss**
(`obliterate`, then the work is rediscovered from PostgreSQL via the lease), a job
replayed against a finished row, real concurrency, and shutdown mid-flight.

One gap worth naming: **the SIGTERM path itself is not tested on Windows**, which has
no deliverable SIGTERM — `Stop-Process` is a hard kill and `process.kill` terminates
unconditionally. The suite exercises what the signal handler *calls*
(`onModuleDestroy` on each component, in Nest's order) and asserts the row is never
stuck, but the handler wiring in `worker.ts` is verified by reading it, not by
signal. On Linux or in a container it would be testable directly.

---

## The decisions worth knowing

**PostgreSQL owns retries, exclusively.** Jobs are published with `attempts: 1`, so
BullMQ never retries on its own. The attempt counter, the backoff schedule and the
terminal verdict all live in the row, because two counters advancing at different
rates have no answer to "how many times has this been tried".

**IN_FLIGHT is a lease, not a lock.** No transaction spans PostgreSQL and Redis, so
a process can die between claiming a row and publishing it, or between a handler
succeeding and the row recording it. A claim therefore carries `leaseExpiresAt`,
and expired leases return to PENDING. A crash costs one lease duration of latency.

**A claim carries a token, and every outcome write quotes it.** `claimedBy` travels
to the worker in the job, and the success, retry and dead-letter writes all end
`AND "claimedBy" = $token`. Status alone cannot tell *my* claim from *someone
else's*: after a lease expiry a row goes PENDING and straight back to IN_FLIGHT
under a new token, and a job holding the old one would look perfectly current. With
the token, a worker whose lease was reclaimed mid-handler writes zero rows, logs a
warning naming `OUTBOX_LEASE_MS`, and leaves the outcome to whoever owns the row.
This is defence in depth, not the primary control — the env schema already refuses a
lease shorter than twice the handler timeout.

**A reclaim increments `recoveries`, never `attempts`.** A worker dying is an
operational event, not a handler failure; otherwise three unlucky restarts would
dead-letter a healthy job.

**Lease and schedule arithmetic happens in SQL, not in Node.** `now() + interval`,
compared against the same `now()`. Two clocks were already observed disagreeing by
5h30m on this machine (see below), and worker hosts drift from each other anyway.

**Job ids are per attempt** — `<rowId>:<attempts>:<recoveries>`. BullMQ ignores an
`add` for a job id it already knows, so a row-id-only job id would silently fail to
republish a row that had failed and become due again.

**Two dedupe modes, and they are not interchangeable.**

| Mode | Index | Means |
| --- | --- | --- |
| `COALESCE` | unique on `(propertyId, dedupeKey)` **where PENDING** | "the latest intent for this scope wins" — five enqueues before the worker drains become one push carrying the newest state. The key is free again once the row is terminal. |
| `UNIQUE_FOREVER` | unique on `(propertyId, dedupeKey)`, unconditional | "this must happen exactly once, ever" — a second enqueue is suppressed as success, now and in a year. |

**Payloads carry identifiers only.** No guest name, email, government ID or card
detail, and no credentials. A row outlives the request that wrote it, is read by a
second process, and reaches logs and backlog dashboards. Handlers re-read what they
need from the database under the tenant scope the row names.

**Error metadata is scrubbed.** `lastError` is name and message, truncated to fit
`VARCHAR(500)`; never a stack, SQL string, or provider response body. A validation
failure records the field *paths*, never the values.

---

## Limitations, stated rather than discovered later

**Delivery is at-least-once, never exactly-once.** The enqueue is genuinely atomic
with its transaction, and that is a real guarantee. The external call is not: once a
provider request times out, we do not know whether it was applied — a timeout means
*unknown*, not *failed*. A handler must buy its own safety, by full-state writes
(push the whole window rather than a delta), a provider-side idempotency key, or an
acknowledgement the provider owns. **A handler that does none of these is unsafe to
retry, and nothing in this module fixes that.**

**A dead letter logs at `error` and nothing else.** §5 requires that a permanently
failed job alert rather than vanish, and `error` plus the backlog warning is the
loudest this stack currently has. Wiring it to a real alerting channel belongs with
the monitoring work; `GET /health/outbox` is the thing to scrape until then.

**There is no automated replay of a dead letter.** Reviving one today means an
explicit `UPDATE` back to PENDING with `attempts` reset. That is deliberate for
Phase A — a one-click retry of an unknown-outcome provider call is exactly the
button that double-charges somebody — but a reviewed, audited replay path is owed.

**In-process counters reset on restart.** `processedSinceBoot` and friends are
in-memory; §6.4 says not to add a metrics backend without a reason and four
counters at ten properties is not one. The durable history is `outbox_event`.

**Latency is bounded by the poll interval**, 1s by default. Polling rather than a
post-commit publish is a deliberate trade: a post-commit publish that fails loses
the event unless something later notices, and a poller *is* that something, so it
has to exist anyway. One mechanism, and restart recovery comes free.

**The dispatcher's claim and the reaper are cross-property.** They read the whole
table, which is the same system-process exception §3.2 grants night-audit
orchestration, and the drain index `(status, availableAt)` therefore does not lead
with `propertyId`. Per-property views use `(propertyId, status, createdAt)`.

**Several worker processes are safe; several dispatchers are safe.** `FOR UPDATE
SKIP LOCKED` is proven under 8 concurrent dispatchers in the race suite. There is
no ordering guarantee between events yet — the per-property ordering an ARI push
needs is Phase B work, not something this module provides today.

---

## A bug this work uncovered

While building the dispatcher, `WHERE "leaseExpiresAt" < now()` was true for a
lease claimed one second earlier with sixty seconds to run. The cause was not the
outbox: the Postgres driver serialises a JS `Date` as its UTC wall-clock digits
with **no offset**, and Postgres interpreted those digits in the session time zone
(`Asia/Calcutta`), storing every timestamp early by 5h30m. Reads shifted back by
the same amount, so ORM round trips looked correct and the error only appeared when
SQL did arithmetic.

Left in place it would have reclaimed every in-flight row on the next tick and
re-delivered every side effect indefinitely. It also meant every stored timestamp
was the wrong instant to any other reader — `psql`, a backup, a BI query — which is
contrary to §3.3's requirement that timestamps be stored in UTC.

`packages/database/src/client-factory.ts` now pins every session with
`-c timezone=UTC`, and this module takes lease and schedule times from the database
so it stays correct even if that setting is ever lost. `pnpm test:outbox` carries a
regression guard that fails if either protection is removed.

**Existing rows were written under the old behaviour and are therefore 5h30m off.**
Nothing has been migrated or reset. In development, `pnpm db:seed` regenerates
them; a production correction, if this ever reached one, would be a reviewed
one-off migration.

---

## Next phase

Phase B, in rough order:

1. **`Channel` and `ChannelConnection`** — per-property channel registration and
   credentials, with secrets outside the outbox payload.
2. **Room-type and rate-plan mapping** — `(propertyId, channel, externalId)`, with
   the unavoidable question of what an unmapped room type does to a push.
3. **A channel-independent sync contract** — one adapter interface, mapping only,
   no business rules, so a provider swap is an adapter and not a rewrite.
4. **Real ARI event types**, replacing `OUTBOX_SELF_TEST`, with per-property
   ordering and debouncing per `(propertyId, roomTypeId, dateRange)`.
5. **Inbound reservations** — store the raw payload first, normalise in a second
   step, idempotent on the channel's reservation id, so a parser bug cannot lose a
   booking.
6. **Ordering and rate limiting per provider**, plus a circuit breaker, so a
   failing OTA degrades the sync layer and never the front desk.
7. **A reviewed dead-letter replay path**, and alerting that is not a log line.
