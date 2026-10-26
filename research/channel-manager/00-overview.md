# Stayflexi Channel Manager — Research Overview

**Status:** Initial pass (Phase 1 partial, Phase 2 partial). **Not complete.**
**Started:** 2026-10-23
**Researcher:** Claude (agent), directed by repository owner
**Target of study:** Stayflexi Channel Manager, as described in *public* sources only

---

## 1. Scope and method

### What this research is
A documentation-and-product-page study of Stayflexi's channel-management
capability, to inform the design of an independent implementation in this
repository (`apps/api/src/modules/channels`, not yet created).

### What this research is NOT
- **No proprietary source code was accessed.** None was sought.
- **No private or undocumented API was called.** No API reference was found to
  be public (see §5).
- **No authenticated Stayflexi product session was inspected.** No account
  access was available to this researcher at the time of writing. Every screen
  description below is derived from Stayflexi's own *public help articles*, not
  from operating the product.
- **No access control was bypassed, and no other customer's data was touched.**

### Evidence grading
Every claim in these files carries one of four labels. This is the single most
important convention in this research set, because a vendor marketing claim and
an observed behaviour are not the same kind of fact:

| Label | Meaning |
|---|---|
| `DOC` | Stated in Stayflexi's official public documentation (support.stayflexi.com) |
| `VENDOR` | Stated in Stayflexi's own marketing/product pages. Self-reported, unverified. |
| `INFER` | Our inference from `DOC`/`VENDOR` material. Explicitly reasoned, not stated by the vendor. |
| `UNKNOWN` | Not determinable from public sources. Listed in `09-unknowns-and-open-questions.md`. |

No claim in this research set is graded as *observed behaviour*, because no
product access has occurred yet.

---

## 2. Headline structural finding

**Stayflexi's public documentation has no top-level "Channel Manager" section.**

The knowledge base sidebar (`EV-002`) enumerates 20 documentation sections —
Dashboard, Reservation Calendar, Rates and Inventory, Housekeeping,
Conversations, Review management, Shops/POS, Reports, Direct Billing, Revenue
Management, Expense manager, Payments, Property Configuration, Night Audit,
Stock Management, Folio, Booking Engine, Magic link, Group Dashboard, Helpline
— and **"Channel Manager" is not among them.**

Instead, channel functionality is distributed:

- **Rates and Inventory** holds the operational channel surface (at least 17
  channel/OTA-specific articles — see `01-feature-inventory.csv`).
- **Property Configuration** holds connection/mapping setup (`DOC`, via search
  result `EV-001`).
- **Reports** holds channel reporting (`INFER`, from article titles).

### Why this matters for our design
A channel manager presented to the operator as *part of the rate and inventory
calendar* rather than as a separate subsystem is a meaningful product decision,
not an accident of documentation. It implies the operator's mental model is
"I set rates and availability, and the channels follow" — not "I manage
channels." If we build a standalone Channels screen, we are diverging from the
model the market leader has taught these users.

This is an `INFER`, and it is a design question for the repository owner rather
than a settled requirement. Recorded in `09-unknowns-and-open-questions.md` as
`Q-001`.

---

## 3. Capability summary (initial)

Graded detail is in `01-feature-inventory.csv`. Summary:

| Area | What public sources support | Grade |
|---|---|---|
| OTA breadth | Booking.com, Airbnb, Expedia, Agoda, Hotels.com, Google Hotel Ads named; "100+ more" unnamed; Rentals United as a distribution hub | `VENDOR` / `DOC` |
| Sync direction | "True two-way sync with all OTAs" | `VENDOR` |
| Sync latency | "Rates, availability, and restrictions update across all channels in just 5 seconds" | `VENDOR`, unverified |
| Inventory model | "Intelligent inventory pooling prevents double bookings"; "Automatic close-outs when rooms are sold" | `VENDOR` |
| Mapping | Room types mapped to "each OTA's categories"; per-room-type "View Connected Channels" pop-up exists | `VENDOR` / `DOC` |
| Restrictions | Min/max stay, CTA/CTD, stop-sell, per channel; per-OTA rate-plan close; per-OTA cut-off time; per-room-category restriction | `VENDOR` / `DOC` |
| Rate control | Per-OTA price increase/decrease, per-OTA rate check, copy rates between channels, rate-parity reporting | `DOC` |
| Sync visibility | "Channel Status Report" screen; sync-status view; detailed change logs across OTA channels | `DOC` |
| Payments | OTA virtual cards "processed automatically"; "Fully PCI DSS compliant" | `VENDOR`, self-stated |
| Onboarding | Stayflexi's team performs channel mapping during onboarding | `VENDOR` (blog) |

### The most load-bearing finding for our architecture
**Pooled inventory.** Stayflexi states it pools inventory across channels and
closes out automatically on sale, rather than allocating per-channel allotments.

Our existing `inventory_day` model already works this way — one counter per
`(propertyId, roomTypeId, stayDate)` guarded by
`inventory_day_not_oversold CHECK (sold + blocked <= physical + overbookingAllowance)`.
So the hardest part of matching this behaviour is **already built and tested**
(`test/concurrency/parallel-booking.test.mjs`). What is missing is the
distribution layer on top of it.

That is a genuinely useful result from this first pass: it narrows the build
from "design an inventory model for channels" to "push an already-correct
counter outwards, idempotently."

---

## 4. What was accessed

| Source | URL | Result |
|---|---|---|
| Stayflexi KB — Property Configuration overview | support.stayflexi.com/docs/documentation/configuration/overview-of-property-configuration/ | Fetched. Full sidebar recovered (134,311 chars; read to 100,000). |
| Stayflexi KB — OTA sync status article | .../rates-inventory/where-can-i-view-the-sync-status-of-my-ota-channels/ | Fetched with offset. Body recovered. |
| Stayflexi KB — room type/rate plan channel mapping | .../rates-inventory/how-to-check-what-room-types-and-rate-plans-connected-to-what-channels-otas/ | Fetched with offset. Body recovered. |
| Stayflexi product page — Channel Manager | stayflexi.com/platform/channel-manager | Fetched (after 302 from business.stayflexi.com). |
| Web search — official docs discovery | — | 10 KB article URLs identified. |

**Retrieval note worth recording:** Stayflexi KB pages are ~127–134 KB of
which the first ~100 KB is sidebar navigation. The article body begins past
character 100,000. Any future fetch of these pages **must** use
`offset: 100000` or it will return only navigation and appear to be an empty
article. This cost one wasted fetch and is noted so it costs no more.

## 5. What was NOT accessed

- **Authenticated Stayflexi PMS.** No account. Every screen below is
  documentation-derived; none is observed.
- **Stayflexi API / XML reference.** No public developer documentation was
  located. If one exists it is behind partner access. `UNKNOWN`.
- **Channel-side partner docs** (Booking.com Connectivity, Expedia EQC/Rapid,
  Agoda YCS, Airbnb API). Not yet fetched — these are *public* and are the
  highest-value remaining source, because they define the protocol any channel
  manager must speak. See `05-integration-matrix.csv`.
- **Screens behind "View More"**, column names, status values, filters, and
  error states. The articles name screens but not their contents.

---

## 6. Honest completeness statement

Per the directive not to declare full reverse engineering while material
unknowns remain: **this is an initial pass covering an estimated 15–20% of the
investigation surface.** Phase 1 categories (A)–(G) are each partially
addressed; none is complete. Phases 3, 4 and 7 are not started. Counts are in
`10-coverage-report.md`.

The largest material unknowns are the ones that decide whether an
implementation is correct rather than merely plausible: **idempotency,
out-of-order event handling, conflict resolution, retry/backoff semantics, and
reconciliation.** None of these is documented publicly, and all five are
exactly where a channel manager is hard. They will likely have to be designed
from first principles and from the OTAs' own published protocols rather than
recovered from Stayflexi.
