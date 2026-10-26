# Unknowns and Open Questions

Two kinds of entry, deliberately separated:

- **`Q-nnn` — questions for the repository owner.** Decisions only you can make,
  or access only you have.
- **`U-nnn` — unknowns about Stayflexi.** Facts not determinable from public
  sources, each with the reason and the cheapest way to resolve it.

---

## Questions for you

### Q-001 — Should our channel manager be a standalone screen, or live inside Rates & Inventory?
Stayflexi has no top-level Channel Manager section; channel controls sit inside
the rate and inventory surface (`EV-002`). That is probably a deliberate product
decision about the operator's mental model. Our repo currently has neither.
**Decision needed before any UI work.** Cheap to defer, expensive to reverse.

### Q-002 — Is self-serve channel connection in scope, or is onboarding-assisted mapping acceptable?
Stayflexi's team appears to perform mapping during onboarding (`EV-004`,
search-summary only). If they do it manually, a self-serve connection UI may
not exist in their product at all — and building one is then *net new product*,
not replication. This materially changes the estimate.

### Q-003 — Do you have authorised access to any channel manager (Stayflexi or another) that I may inspect?
You scoped this to "data I am authorized to access." I currently have none. With
a demo or sandbox account the screen inventory moves from documentation-derived
to observed, which is the difference between `DOC` and real evidence. Without
it, Phase 2 will stay at documentation level.

### Q-004 — Do you have, or intend to obtain, OTA partner credentials?
Booking.com Connectivity, Expedia, Agoda YCS and Airbnb all gate their APIs
behind partner programmes with certification. This is the hard external
dependency of the whole feature and it has lead time measured in weeks to
months, plus possible cost. **Nothing we build can be exercised end-to-end
without at least one.** This is the single biggest schedule risk.

### Q-005 — Which channels matter for your first release?
Your `BookingSource` enum already names MakeMyTrip, Agoda, Booking.com, Expedia
and Cleartrip. India-first suggests MakeMyTrip and Booking.com first. Confirm,
because integration effort does not amortise — each channel is its own protocol.

### Q-006 — Pooled inventory vs per-channel overrides: which wins?
Stayflexi claims inventory pooling (`CM-B-001`) *and* documents per-channel
inventory changes (`CM-B-006`). Those are in tension. Either the override is a
cap on top of a pooled figure, or pooling is partial. We must pick a rule; I
would propose "pooled truth, per-channel ceiling" and make the ceiling
explicit, but it is your call.

### Q-007 — Who computes tax on channel-facing rates, us or the channel?
Unresolved publicly (`CM-C-010`). It matters disproportionately for you because
your GST engine is banded and inclusive/exclusive is a property setting. If we
push a net rate and the channel adds its own tax, guests see a different figure
than your folio will charge.

---

## Unknowns about Stayflexi

Grouped by how much they affect correctness.

### Tier 1 — where a channel manager is actually hard
No public evidence exists for any of these. They will have to be designed from
first principles and from the OTAs' own protocol documentation, not recovered.

| ID | Unknown | Why it decides correctness | Cheapest resolution |
|---|---|---|---|
| U-001 | Idempotency of outbound pushes | A retried push that double-applies is how inventory drifts | OTA partner docs define required idempotency keys |
| U-002 | Out-of-order event handling | A late push can resurrect stale availability and oversell | Design from sequence/version numbers; OTA docs |
| U-003 | Conflict resolution (PMS vs channel) | Decides who wins when both change the same date | Design decision; no vendor evidence likely |
| U-004 | Retry, backoff and dead-letter policy | Decides whether a failing OTA degrades sync or the front desk | Design from first principles |
| U-005 | Reconciliation strategy | The only thing that catches silent drift | Design; some OTAs publish full-refresh endpoints |
| U-006 | Full vs incremental push semantics | Determines blast radius of a bad push | OTA partner docs |

**This tier is the honest reason this research cannot "reverse-engineer" the
channel manager.** These behaviours are invisible from outside the product, and
largely invisible even from inside it without instrumentation. Public sources
will not yield them.

### Tier 2 — observable with product access
| ID | Unknown | Resolution |
|---|---|---|
| U-007 | Channel Status Report columns and status value set | Product access, or the two un-alt-texted screenshots in `EV-005` |
| U-008 | Whether "View Connected Channels" edits or only displays | Product access |
| U-009 | Full contents of the "View More" submenu | Product access, or fetch sibling articles |
| U-010 | Existence and shape of a channel-connection screen | Product access |
| U-011 | Authorisation model per channel (credentials/OAuth/partner key) | Product access + OTA docs |
| U-012 | Reconnect flow and whether mappings survive | Product access |
| U-013 | Per-channel cut-off timezone handling | Product access |
| U-014 | Unmapped-inventory inbound booking behaviour | Product access; ask their support directly |
| U-015 | Whether OOO rooms reduce channel-facing availability | Product access |
| U-016 | Inventory buffer support | Product access |
| U-017 | Occupancy-based pricing pushed to channels | Product access |
| U-018 | Promotions management from the PMS | Product access |
| U-019 | No-show propagation to/from channels | Product access |
| U-020 | Guest/tax fields supplied by each channel | OTA partner docs (better source than Stayflexi) |
| U-021 | Audit coverage of channel config changes | Product access |

### Tier 3 — unverifiable vendor claims
Recorded so they are never mistaken for requirements.

| ID | Claim | Status |
|---|---|---|
| U-022 | "5 seconds" sync latency | No methodology published. Do not design to this number or quote it. |
| U-023 | "100+ OTAs" | Only 6 named. The Rentals United integration suggests some breadth is via a hub rather than direct certification. |
| U-024 | "Fully PCI DSS compliant" | Self-stated, no attestation shown. Irrelevant to us if we never store card data — and our schema deliberately caps at `cardLast4` with a digits-only CHECK. |
| U-025 | "True two-way sync with all OTAs" | Plausible in direction, unverifiable in completeness. |
| U-026 | "thousands of properties" | No supporting data. |

---

## Known limits of this research method

Stated plainly so the coverage report is not read as more than it is:

1. **No product access.** Every screen is documentation-derived. The difference
   between "the docs name this screen" and "this screen behaves this way" is
   the whole of Phase 2, and we are on the wrong side of it.
2. **The KB articles are thin.** They reliably give navigation paths and screen
   names; they almost never give columns, status values, validation or error
   states. Several key articles are a few sentences plus screenshots whose
   content is unrecoverable by text fetch.
3. **Screenshots are the richest unread source** and are inaccessible to a text
   fetch. If you can open the two images in `EV-005`, the Channel Status Report
   column and status set would resolve `U-007` immediately.
4. **Documentation lags product.** `EV-005` is dated 2026-02-16; the search tool
   reported indexed copies ~248 days old. Anything time-sensitive is suspect.
5. **The OTAs' own documentation is public, authoritative, and unread.** For
   Tier-1 unknowns it is a *better* source than Stayflexi, because the protocol
   constrains every channel manager equally. This is the highest-value next
   move and needs no access from you.


---

# Resolution pass — 2026-10-23 (OTA provider documentation)

Each unknown below carries: status, evidence, **whose decision it is**, and the
cheapest next step. "Owner" matters more than it looks: several of these were
logged as research failures when they are in fact design responsibilities, and
that distinction is what unblocks the work.

## Tier 1 — resolved in kind, not in detail

The headline result: **no provider documents idempotency, retries, ordering,
conflict resolution or reconciliation.** Searched directly; Booking.com's
developer docs are explicitly silent (`EV-007`). That silence converts U-001 to
U-006 from *unknown* into *ours to design*, which is a different and much more
tractable problem.

| ID | Status | Evidence | Owner | Cheapest next step |
|---|---|---|---|---|
| U-001 Idempotency | **Partially resolved** | No provider publishes idempotency keys (`EV-007` silent). Agoda pushes claimed full-overwrite (`EV-012`, unofficial), which makes repeat pushes naturally idempotent | **Our architecture** | Confirm Agoda overwrite semantics officially (U-031). Then adopt full-state-per-window pushes — see `07-...md` §3.1 |
| U-002 Out-of-order events | **Partially resolved** | No provider exposes sequence numbers. Full-overwrite makes a late stale push *win*, so ordering cannot be delegated | **Our architecture** | Design per-`(propertyId, roomTypeId)` serialisation with an enqueue-time version — `07-...md` §3.2 |
| U-003 Conflict resolution | **Resolved as a design decision** | No provider rules on it | **Our architecture** | Adopt: PMS authoritative for ARI, channel authoritative for reservations — `07-...md` §3.3 |
| U-004 Retry / backoff / dead-letter | **Partially resolved** | Booking.com publishes **HTTP 429** and says limits **may change without notice** (`EV-007`). No retry policy published anywhere | **Our architecture**, constrained by provider limits | Token bucket below the published limit + jittered backoff + dead-letter that alerts — `07-...md` §3.4 |
| U-005 Reconciliation | **Partially resolved** | Agoda officially supports retrieving availability and rate details for existing rooms and rates (`EV-011`); Booking.com exposes retrieval too (`EV-007`). So read-back reconciliation is *constructible* | **Our architecture** | Nightly per-property read-back diff — `07-...md` §3.5 |
| U-006 Full vs incremental | **Resolved for Agoda (unofficially)** | "Updates are strict in nature... old data will be completely overwritten... partial updates aren't allowed" (`EV-012`, UNOFFICIAL). Booking.com asks partners to load a full year of ARI (`EV-007`), implying bulk capability | **OTA** | U-031: confirm with Agoda docs or an account manager before designing on it |

## Tier 2 — the one the OTAs could answer

| ID | Status | Evidence | Owner | Cheapest next step |
|---|---|---|---|---|
| U-011 Authorisation model | **Partially resolved — and it differs per channel** | Booking.com: Bearer JWT *and* credential-based, TLS 1.2, separate PCI host for reservations (`EV-007`). MakeMyTrip: per-property access token + hotel code issued by the hotel from the GOMMT extranet (`EV-013`). Agoda: authorised API key (`EV-012`, unofficial). Expedia: not determined | **OTA** | Expedia requires portal access. The important design consequence is already known: `ChannelConnection` must model **partner-level and property-level credential scope** |
| U-020 Guest/tax fields per channel | **Still unknown** | Message-level specs sit behind all four portals | **OTA** | Needs partner access; no public path |
| U-013, U-016, U-017 | **Marginally informed** | Agoda exposes product settings including **guest limits and length of stay** (`EV-011`), which touches occupancy/LOS but not pricing-by-occupancy | **OTA** | Deeper Agoda spec pages |
| U-007 to U-010, U-012, U-014, U-015, U-018, U-019, U-021 | **Unchanged — unknown** | Require Stayflexi product access, not OTA docs | Stayflexi | Unchanged from first pass |

## Tier 3 — unchanged

U-022 to U-026 concern Stayflexi marketing claims and are **not applicable** to
this provider pass. They remain recorded so they are never mistaken for
requirements.

## New unknowns raised by this pass

| ID | Unknown | Why it matters | Owner | Next step |
|---|---|---|---|---|
| U-027 | Whether Booking.com is accepting new connectivity partners | Decides whether INT-001 is reachable at all | OTA | Contact the connectivity team. One 2026 third-party guide says the portal is not accepting new registrations; another says onboarding closes periodically (`EV-009`). **No official statement found either way** |
| U-028 | Booking.com's current 7 requirements, and the **minimum property/unit count by region** | This is the likely hard blocker — see Q-008 | OTA | The authoritative page is a JS app that will not render (`EV-008`); needs a browser or direct contact |
| U-029 | Expedia's current certification checklist | Gates INT-003 | OTA | Connectivity portal is gated (`EV-010`); requires a point of contact |
| U-030 | Whether MakeMyTrip/GOMMT has **any** partner application path | No official documentation of any kind was found (`EV-013`). Appearing in the extranet dropdown implies prior approval | OTA | Direct contact; no public path exists |
| U-031 | Official confirmation of Agoda full-overwrite semantics, the 1 MB `SetAriV2` cap, and `BookingHint` | Three architecturally load-bearing facts resting on an unofficial Postman collection (`EV-012`) | OTA | Deeper pages on developer.agoda.com, or an account manager |
| U-032 | Whether **any** provider offers a sandbox | Decides whether anything can be tested pre-certification | OTA | None documented by any of the four |
| U-033 | Rentals United (or equivalent hub) commercial and technical terms | The one route that converts N certifications into 1 | Aggregator | Unresearched. **Highest-value remaining research target** |

## New question for you

### Q-008 — How many properties will EaseIt present to an OTA at launch?

This is now the most consequential open question in the project, and it is
commercial rather than technical.

Booking.com's requirements reportedly include **a minimum number of properties
or units, varying by market segment and region** (`EV-008`). CLAUDE.md §1 fixes
this product at **10 properties**. A connectivity-partner programme exists to
onboard providers who bring volume; a ten-property portfolio is very likely
below any such threshold.

If that is right, then **direct certification with Booking.com, Expedia and
Agoda may be unattainable for this product at its stated scale**, and the
realistic path is an aggregator hub — exactly what Stayflexi itself appears to
use for part of its breadth (`EV-001`, Rentals United). That would change the
feature from "build four OTA adapters" to "build one hub adapter", which is a
materially smaller and more achievable piece of work.

I am not confident enough in `EV-008` to treat this as settled — it rests on a
search summary of a page that would not render, indexed ~1,400 days ago. But it
is the question whose answer most changes the plan, so it should be resolved
before any adapter is written.


---

# Resolution pass — 2026-10-26 (connectivity strategy)

## Q-008 — RESOLVED IN EFFECT

**The property count is 10** (CLAUDE.md §1, fixed portfolio). **The blocker it
implied is bypassed, not overcome.**

Q-008 mattered because a minimum property count would disqualify us from the
OTA connectivity-partner programmes. Going through an aggregator means **we
never apply to one.** Channex holds the certifications; our hotels hold their
own OTA contracts and authorise Channex against them. Channex names *"hotel
groups building in-house systems"* among its target customers and states no
minimum contract (`EV-015`).

The exact Booking.com minimum remains unknown (`U-028`) but is **no longer
decision-critical**. It would only matter again if the portfolio grew enough to
make direct certification attractive.

**Residual, and it is real:** eligibility for *Channex* at 10 properties is
strongly implied by its own targeting but **not explicitly stated as a
threshold**. Listed for written confirmation (`U-034` block).

## U-033 — RESOLVED, and reframed

The question was "Rentals United (or equivalent hub) commercial and technical
terms". Answered, but the answer changed the question:

- **A better hub exists for our shape.** Channex is a white-label channel-manager
  API *built for PMS vendors*, sold wholesale only, with hotels as a
  first-class tier, free staging, published pricing, and **MakeMyTrip/Goibibo
  support** (`EV-015`, `EV-016`). Rentals United is a **vacation-rental**
  channel manager whose PMS-partner requirements make the **content API
  effectively mandatory** — photos, descriptions, amenities — which is a much
  larger build for a hotel PMS that would otherwise never need it (`EV-017`).
- **Rentals United terms: partially resolved.** Quote-based pricing (~EUR 107/mo
  for 10-19 properties, third-party), PCI certificate required for card data,
  >= 3 months stated, acquired by Guesty May 2024. Its **minimum-inventory page
  returns HTTP 403** (`EV-018`) — the one document that would settle our
  eligibility is gated, so eligibility is **unresolved** and tracked as `U-038`.

**Consequence:** `07-...md` §3.6 (poll as well as listen) moves from *our
inference* to **documented requirement**. Channex requires webhook delivery
**and** polling the Booking Revisions Feed every 15-20 minutes, acknowledging
each revision after saving (`EV-015`). That is an explicit at-least-once
contract with a consumer-side commit point, which is the primitive U-001 and
U-002 needed and no OTA supplied.

## U-027 — strengthened, still not official

A **second independent third-party source** (`EV-019`, FluxPMS) now states
Booking.com is pausing new connectivity providers, agreeing with `EV-009`
(Elfsight). Two unrelated commercial sources pointing the same way raises this
from a single claim to a pattern. **Still not an official statement** and still
requires written confirmation — but it is now enough to deprioritise direct
Booking.com without further research.

## New unknowns

| ID | Unknown | Why it matters | Owner | Next step |
|---|---|---|---|---|
| U-034 | Channex Customer Agreement terms: **data ownership**, who owns the hotel relationship, white-label rights, any restriction on us later connecting an OTA directly | Decides lock-in. `EV-015` states GDPR compliance but is **silent on data ownership** | Channex | Request the Customer Agreement (channex.io/policy). Drafted in `13-...md` §7.1 |
| U-035 | Whether MakeMyTrip/Goibibo via Channex is live **and available to our account in India** | **The assumption most capable of overturning the recommendation.** A channel in a directory is not a channel available to us | Channex + MMT | Both enquiries in `13-...md` §7 |
| U-036 | Whether our 10 hotels already hold the OTA contracts Channex requires | Channex connects *existing* listings; its MMT guide requires a direct MMT contract first. This is business work, not engineering | **Business owner** | Audit each property's existing OTA accounts |
| U-037 | Channex certification elapsed time, including scheduling the live screen-share | Drives the go-live date, not the build | Channex | Ask in `13-...md` §7.1 |
| U-038 | Rentals United minimum inventory requirement | Would settle RU eligibility at 10 properties | Rentals United | Page is HTTP 403; needs the vendor |
| U-039 | Whether Channex supports per-channel inventory *ceilings* on top of pooled truth | Our `Q-006` design rule needs a mechanism to express it | Channex | Deeper API docs (docs.channex.io), no access needed |

## Questions closed this pass

- **Q-004** (do you intend to obtain OTA partner credentials?) — **effectively
  moot for now.** The recommendation is that we obtain *none*; the hotels hold
  their own OTA accounts and Channex holds the certifications.
- **Q-005** (which channels first?) — **answerable from evidence**: MakeMyTrip /
  Goibibo first, because it is the India-critical channel, it is the one Channex
  carries that nothing else in the comparison does, and the hotels' own
  contracts are the only prerequisite. Still your call to confirm.
