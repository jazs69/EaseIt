# Implementation Backlog

**Status:** Not started. Scaffold only.
**Blocked on:** Phases 4 and 5. Estimates would be invented without the protocol documentation.

## Dependency order established so far

Research has already fixed part of the build order, independently of any estimate:

1. **Outbox + BullMQ worker** -- nothing can push ARI safely without it (see `07-...md`).
2. **RatePlan model** -- channel rate mapping has nothing to map to without it.
3. **Channel / ChannelConnection / room + rate mappings** -- the configuration surface.
4. **Outbound ARI push** -- debounced per `(propertyId, roomTypeId, dateRange)`, ordered
   per property, every attempt logged.
5. **Inbound reservation ingestion** -- store the raw payload first, normalise second,
   idempotent on the channel reservation id. `Reservation.otaBookingId` with
   `reservation_unique_ota_id_per_property` already supports this.
6. **Reconciliation + a Channel Status screen** -- the operator-facing truth check.

Backlog IDs `BL-*` are referenced from `01-feature-inventory.csv` and expand here once
Phase 5 gives them real shape.

## Revision — 2026-10-23

Steps 1 and 2 are unchanged and remain safe to start: the **outbox + worker** is
required by every path, and the **RatePlan model** is required by every mapping.

Steps 3 to 5 are now **contingent on Q-008**. If EaseIt presents only its ten
properties to an OTA, direct certification with Booking.com, Expedia and Agoda
may be unattainable, and the work becomes **one aggregator adapter** rather than
four OTA adapters. Do not begin adapter work until Q-008 and U-033 are answered.

Step 6 (reconciliation by read-back) is unchanged and is now evidenced as
constructible — both Agoda and Booking.com expose retrieval (see 07-...md §3.5).

## Revision — 2026-10-26 (strategy decided)

Q-008 is resolved in effect and the provider is chosen, so the contingency on
steps 3-5 is lifted. Revised order:

1. **Outbox + BullMQ worker** — unchanged, on the critical path for the product.
2. **`RatePlan` model** — unchanged; every mapping needs it.
3. **Channex staging integration** — create property, room types and rate plans;
   send ARI; receive a test booking. Free, no card, no commitment.
4. **ARI push scheduler** — debounce and serialise per
   `(propertyId, roomTypeId)`, enqueue-time version gating, token bucket,
   jittered backoff, dead-letter that alerts.
5. **Revision-feed consumer** — webhook plus a 15–20 minute backup poll,
   acknowledging each revision *after* saving. Now a documented Channex
   requirement, not our inference.
6. **Reconciliation differ + Channel Status surface.**

Deferred indefinitely: direct OTA adapters for Booking.com, Expedia and Agoda.
Revisit only if the portfolio grows enough to make certification attainable.
