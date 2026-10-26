# Sync and Failure Handling

**Status:** Partially evidenced (Phase 4 in progress).
**Updated:** 2026-10-23, after the OTA provider research pass.

This file is split deliberately into **§2 Confirmed provider requirements** and
**§3 Our engineering recommendations**. Nothing in §3 is attributable to any
OTA. Mixing the two is how a design acquires requirements nobody actually
imposed.

---

## 1. Hard precondition: this repository has no queue

Unchanged from the first pass, and now decisive.

BullMQ, ioredis and Redis are **not installed**; there is no outbox table and no
`worker:dev` script. CLAUDE.md §3.1 requires side effects to leave a transaction
through an outbox drained by a worker, and §2 specifies ARI pushes as debounced
per `(propertyId, roomTypeId, dateRange)`, ordered per property, retried until
acknowledged, with every attempt logged.

The provider research makes this concrete rather than theoretical. Booking.com
publishes a hard rate limit of **10,000 calls/min globally and 75/min on several
OTA notification endpoints**, returning **HTTP 429** on breach, and states the
limits **may change without notice** (`EV-007`). A system that pushes inline
from a request thread cannot honour a shared rate budget, cannot back off on
429, and cannot reorder. The queue is not an architectural preference here; it
is the only place a rate budget can live.

---

## 2. Confirmed provider requirements

Every row is attributable to a provider source. Grades: `DOC` official docs,
`DOC-via-summary` official page read through a search summary, `UNOFFICIAL`
third-party spec of unknown provenance.

### 2.1 Transport and authentication

| Requirement | Provider | Grade | Evidence |
|---|---|---|---|
| HTTPS with **TLS 1.2** | Booking.com | `DOC` | `EV-007` |
| **TLS 1.2**; **direct IP-address connections not supported** | Expedia | `DOC-via-summary` | `EV-010` |
| Token-based auth (**Bearer JWT**) *and* credential-based auth both offered | Booking.com | `DOC` | `EV-007` |
| Reservation endpoints served from a **separate PCI host** | Booking.com | `DOC` | `EV-007` |
| Per-property **access token + hotel code**, issued by the hotel from the GOMMT extranet | MakeMyTrip | `VENDOR` | `EV-013` |
| Authorised **API key** scoping property access | Agoda | `UNOFFICIAL` | `EV-012` |

**The finding that matters:** the credential *scope* differs per channel.
Booking.com and Agoda issue **partner-level** credentials; MakeMyTrip issues a
**property-level** token that the hotel generates and hands over. A
`ChannelConnection` model that assumes one shape will not hold both.

### 2.2 Rate limits — the only published numbers we have

Booking.com (`DOC`, `EV-007`):

| Scope | Limit |
|---|---|
| All endpoints, global | 10,000 / min |
| Reservations summary | 700 / min |
| Request-to-Book endpoints | 200 / min, **warnings from 170** |
| Several OTA notification endpoints | 75 / min |
| Breach response | **HTTP 429** |
| Stability | **May change without notice** |

No other provider publishes limits. Agoda's only published size constraint is
`UNOFFICIAL`: a **1,000,000-byte** cap on `SetAriV2` (`EV-012`).

### 2.3 Update semantics

| Behaviour | Provider | Grade |
|---|---|---|
| Partners should "strive to" support all API functions and **load a full year of rates and availability per property** | Booking.com | `DOC` |
| Updates are **"strict in nature": old data is completely overwritten; partial updates are not allowed** | Agoda | `UNOFFICIAL` |
| Product API **creates and updates Room Types and Rate Plans**; reads single and multiple Room Types | Expedia | `DOC-via-summary` |

If Agoda's full-overwrite semantics are confirmed, it is the single most
consequential fact in this file — see §3.1.

### 2.4 Reservation delivery

| Model | Provider | Grade |
|---|---|---|
| Push **and** retrieval; reservations on a separate PCI host | Booking.com | `DOC` |
| **Retrieval**: booking lists and booking details | Agoda | `DOC` (`EV-011`) |
| **No push booking** — only `BookingHint` notification, then `GetBookingList` / `GetBookingDetails`; setup requires a URL endpoint **and a fallback email** for when `BookingHint` fails | Agoda | `UNOFFICIAL` (`EV-012`) |
| Certification is **test reservations with variations of newly introduced fields** | Expedia | `DOC-via-summary` |

**Architectural consequence:** we cannot assume a webhook carries the booking.
Agoda's documented capability is *retrieval*, and the unofficial spec says the
notification is a **hint** with an email fallback. A design built purely on
"webhook delivers payload" fails on the channel that is officially open to new
partners.

### 2.5 What no provider documents

Searched for and **not found anywhere**:

- **Idempotency keys or semantics.** Booking.com's docs are explicitly silent.
- **Retry or backoff policy.** Only the 429 signal is published.
- **Event ordering or sequence numbers.**
- **Conflict resolution** when PMS and channel disagree.
- **Reconciliation endpoints or guidance** (though Agoda and Booking.com both
  expose *retrieval*, which makes read-back reconciliation constructible).
- **A sandbox.** Booking.com recommends "a tutorial for creating a test
  property"; no provider documents an isolated test environment.

This silence is the answer to U-001 through U-006: **these are not provider
requirements we failed to find. They are our design responsibility.** That is a
materially different conclusion from "unknown", and it unblocks the design.

### 2.6 Compliance

| Requirement | Provider | Grade |
|---|---|---|
| **PCI and PII compliance** required of the partner | Booking.com | `DOC-via-summary` (`EV-008`) |
| Reservations isolated on a dedicated PCI host | Booking.com | `DOC` |

---

## 3. Our engineering recommendations

**None of this is imposed by any OTA.** It is what the evidence above implies
for a correct implementation here.

### 3.1 Make every ARI push a full-state write for its scope

If Agoda overwrites wholesale and Booking.com wants a full year loaded, then
modelling pushes as **full state for a `(roomType, dateRange)` window** rather
than as deltas gives us idempotency for free: re-sending the same window
produces the same remote state, so a retry after an ambiguous timeout is safe
without an idempotency key no provider offers.

This resolves U-001 by construction rather than by protocol. It costs bandwidth
and buys correctness, which is the right trade for ten properties.

### 3.2 Serialise per `(propertyId, roomTypeId)`, and stamp a version

Full-overwrite semantics have a sharp edge: **a stale push that arrives late
wins.** Since no provider exposes sequence numbers, ordering must be enforced on
our side.

Recommend: a single in-flight job per `(propertyId, roomTypeId)`, debounced over
a short window, carrying a monotonic `version` taken at enqueue time. A worker
drops any job whose version is older than the last successfully acknowledged
version for that key. This answers U-002 without provider support.

### 3.3 Treat the PMS as authoritative for ARI, the channel as authoritative for reservations

A defensible split that needs no provider ruling (U-003):

- **ARI** — we own it. Full-overwrite pushes mean the channel holds whatever we
  last sent; divergence is our bug, found by reconciliation.
- **Reservations** — the channel owns them. Inbound bookings are facts, stored
  raw first and normalised second, idempotent on
  `(channel, external reservation id)`.

`Reservation.otaBookingId` with `reservation_unique_ota_id_per_property` already
enforces the second half.

### 3.4 Budget-aware retry with a dead-letter destination

Given 429 is the only published failure signal and limits can change without
notice: a token-bucket per channel sized *below* the published limit, exponential
backoff with jitter on 429 and 5xx, bounded attempts, then a dead-letter row
that **alerts rather than vanishes**. A failing OTA must degrade the sync layer
and never the front desk (CLAUDE.md §5).

### 3.5 Reconciliation by read-back, nightly per property

Both Agoda and Booking.com expose retrieval. Recommend a nightly job per
property that reads back a window and diffs it against `inventory_day` and the
rate calendar, writing discrepancies to an operator-visible report — the
honest version of Stayflexi's "Channel Status Report" (`SCR-002`). This is the
only mechanism that catches silent drift (U-005).

### 3.6 Poll as well as listen

Because Agoda's notification is a *hint* with an email fallback, inbound
reservation ingestion should not depend solely on a webhook. Recommend a
reconciling poll of `GetBookingList`-equivalents per connected channel, with
webhook delivery as the fast path and the poll as the correctness guarantee.

### 3.7 Never store card data

Booking.com isolates reservations on a PCI host and requires partner PCI
compliance. We should keep our existing posture: store **`cardLast4` only**,
under the digits-only CHECK already in the schema, and never accept a PAN. This
keeps us out of PCI scope entirely rather than claiming compliance with it.
