# Coverage Report

**As of:** 2026-10-23, after the first research pass
**Verdict: NOT reverse-engineered. Material unknowns remain.**

Per the directive — "Do not claim full reverse engineering if material unknowns
remain" — this report exists to make the gap measurable rather than rhetorical.

---

## 1. Counts

### Feature inventory (`01-feature-inventory.csv`) — 57 items

| Status | Count | Meaning |
|---|---:|---|
| `verified-doc` | 2 | Named in official documentation with a navigation path |
| `verified-vendor` | 1 | Stated unambiguously by the vendor (pooled inventory) |
| `partial` | 34 | Evidence that the capability exists; no operational detail |
| `unknown` | 19 | No public evidence at all |
| `unverified` | 1 | Vendor claim we decline to accept (5-second latency) |

**Nothing is `verified-observed`.** No feature has been seen working, because
no product access exists.

### By investigation category

| Category | Items | Partial or better | Unknown | Est. coverage |
|---|---:|---:|---:|---:|
| A — Connections & mapping | 8 | 6 | 2 | ~45% |
| B — Inventory & restrictions | 10 | 8 | 2 | ~45% |
| C — Rates | 11 | 8 | 3 | ~40% |
| D — Sync semantics | 10 | 4 | 6 | **~15%** |
| E — Reservations | 7 | 4 | 3 | ~30% |
| F — Observability | 6 | 4 | 2 | ~35% |
| G — Access & reporting | 5 | 4 | 1 | ~45% |

### Screens (`02-screen-inventory.csv`) — 9 identified

| Access status | Count |
|---|---:|
| documentation-only (named + navigation path) | 3 |
| not-yet-fetched (article exists, unread) | 5 |
| not-located (existence unproven) | 1 |
| **observed in the product** | **0** |

### Evidence (`08-evidence-register.csv`) — 6 items
3 direct fetches of official documentation, 1 vendor marketing page, 2
search-summary-only (weaker; flagged for direct re-fetch).

---

## 2. Phase completion

| Phase | State | Note |
|---|---|---|
| 1 — Discovery | **Partial** | All 7 categories touched; D (sync) barely |
| 2 — Screen inventory | **Partial** | 9 screens named, 0 inspected, 0 field-level detail |
| 3 — Workflows | **Not started** | Requires product access or much deeper doc reading |
| 4 — Business rules & design | **Not started** | Blocked on Tier-1 unknowns |
| 5 — Integrations | **Not started** | OTA partner docs unread — and they need no access from you |
| 6 — Files | **Scaffolded** | 13 files created; 6 substantive, 7 structured placeholders |
| 7 — Completeness | **This document** | First omission pass done; second pending |

**Overall: an estimated 15–20% of the investigation surface.**

---

## 3. The honest shape of the gap

Coverage is not evenly thin. It is thinnest exactly where it matters.

**What public sources give up readily:** the feature *surface*. Which buttons
exist, which screens are reachable, what the product claims. Categories A, B, C
and G are at ~40–45% after one pass and could plausibly reach 70% with more
reading alone.

**What public sources will not give up at all:** category D, sync semantics, at
~15%. Idempotency, out-of-order events, conflict resolution, retry policy,
reconciliation (`U-001`–`U-006`). These are invisible from outside a running
system. No amount of reading Stayflexi's help centre will recover them.

This matters because **category D is where a channel manager is correct or
wrong.** A feature list is easy to match; not overselling a room when two
channels confirm the same night within the same second is the actual product.
Our repo already solves that for the *local* case — one pooled counter, an
oversell CHECK, an exclusion constraint, and a passing parallel-booking race
test. The distribution layer is where it gets reintroduced as a risk.

So the research conclusion after one pass is: **stop trying to recover sync
semantics from Stayflexi, and get them from the OTAs' own published protocols
instead.** Those documents are public, authoritative, binding on every channel
manager equally, and completely unread. That is a better source than the thing
we set out to study.

---

## 4. What would move the numbers most

| Action | Needs from you | Expected effect |
|---|---|---|
| Fetch Booking.com / Expedia / Agoda / Airbnb partner docs | Nothing | Category D 15% → 50%+; populates Phase 5 entirely |
| Read the 5 unread KB articles already identified | Nothing | Categories B/C/F up ~15 points each |
| Open the 2 screenshots in `EV-005` | A look, or a paste | Resolves `U-007` (status values) outright |
| Demo/sandbox product access | Account | Phase 2 and 3 become real; 0 → 9 screens observed |
| Confirm target channels (`Q-005`) | A decision | Lets Phase 5 go deep rather than broad |

## 5. Second omission pass — not yet performed

Phase 7 requires two passes. One has been done (it added categories B-009/010,
C-009/010/011 and E-005/006/007, and surfaced the pooling-vs-override tension
now logged as `Q-006`). The second should run once Phase 5 exists, since OTA
protocol documentation will almost certainly reveal capability categories that
Stayflexi's help centre never names — certification requirements, rate-limit
regimes and mandatory message types among them.


---

# Coverage update — 2026-10-23 (after the OTA provider pass)

## Revised counts

Evidence register: **6 -> 14 items** (EV-007 to EV-014 added; 3 direct official
fetches, 2 gated/failed fetches recorded as such, 2 search summaries of official
pages, 1 unofficial spec, 1 company press item).

Integration matrix: **9 placeholder rows -> 5 researched rows** (the four
requested providers plus the aggregator option). Rows for Hotels.com,
Google Hotel Ads, Cleartrip and Airbnb were dropped from the matrix this pass
to avoid carrying nine empty rows as if they were findings; they remain in
`01-feature-inventory.csv` context and should return when researched.

### Category D — sync semantics: ~15% -> ~55%

The single biggest movement, and not in the way expected. Six Tier-1 unknowns
were reclassified:

| Before | After |
|---|---|
| 6 unknown | 1 resolved as a design decision; 4 partially resolved; 1 resolved-for-one-provider-unofficially |

The reclassification is honest rather than generous: **no provider documents
idempotency, retries, ordering, conflict resolution or reconciliation.** We
searched the official documentation of four providers and found explicit silence
(Booking.com) or no mention at all. That moves these items from "we have not
found the answer" to "there is no external answer; it is our design" — which is
genuinely resolved, in kind.

What is *not* resolved is any provider's message-level detail. Every one of the
four hides its specifications behind a partner portal.

### Access reality — the finding that reframes the phase

| Provider | Official docs readable? | New-partner path documented? |
|---|---|---|
| Agoda | **Yes** (introduction; updated 2026-09-09) | **Yes** — "new partners should follow Agoda's partner onboarding guideline" |
| Booking.com | Developer docs yes; **requirements article will not render** | No — and conflicting third-party claims about whether applications are open |
| Expedia | **No** — redirects to a gated portal that returned nothing | No |
| MakeMyTrip | **No documentation found of any kind** | No |

**Agoda is the only one of the four whose own documentation describes a route
for a new partner.** That is a stronger result than the breadth of the
Booking.com docs, because readable documentation for a programme you cannot
enter is worth less than a documented door.

## Phase status

| Phase | Before | Now |
|---|---|---|
| 1 Discovery | Partial | Partial (unchanged) |
| 2 Screen inventory | Partial | Partial (unchanged — needs Stayflexi access) |
| 3 Workflows | Not started | Not started |
| 4 Business rules & design | Not started | **Partial** — `07-...md` now separates confirmed requirements from recommendations |
| 5 Integrations | Not started | **Partial** — 4 providers researched, all gated at the detail level |
| 6 Files | Scaffolded | Updated: 05, 07, 08, 09, 10, 12 |
| 7 Completeness | First pass | Second omission pass still pending |

**Overall: ~15-20% -> an estimated 30-35%.**

## Still not reverse-engineered, and now for a different reason

The first pass could not recover sync semantics from Stayflexi. This pass
establishes that **they cannot be recovered from the OTAs either, because no
OTA publishes them.** The gap is therefore not a research gap at all — it is
design work, and `07-...md` §3 now proposes it explicitly and labels it as ours.

The remaining research gap is narrower and sharper: **four partner portals, all
gated, and one unresearched aggregator** (U-033) that may make three of the four
unnecessary.


---

# Coverage update — 2026-10-26 (connectivity strategy pass)

## Counts

Evidence register: **14 -> 19** (`EV-015` to `EV-019`). Two of the five are
**recorded failures** — Rentals United's eligibility page (HTTP 403) and, from
the previous pass, Booking.com's requirements article — kept in the register
because an inaccessible document is a finding about the provider, not a gap in
our notes.

Integration matrix: **5 -> 6 options**, now with 22 columns covering eligibility,
hotel-vs-vacation-rental shape, India coverage, sandbox, certification, fees at
our scale, white-label/ownership and contractual risk. **Ranked.**

New file: `13-connectivity-strategy.md` — scored comparison, recommendation,
12-month cost model, vendor-independent build list, two draft enquiries, go/no-go.

## Category D — sync semantics: ~55% -> ~75%

The second large movement, and this time from a provider that actually documents
the mechanism. Channex publishes:

- webhook delivery **plus** mandatory polling of a **Booking Revisions Feed**,
- **acknowledgement after save** per revision,
- a 15-20 minute backup poll interval.

That is a real at-least-once delivery contract. It independently confirms the
design in `07-...md` §3.6 — which we had reached from Agoda's `BookingHint`
fallback — and upgrades it from inference to `DOC`.

What remains unknown in category D is per-channel ceiling semantics (`U-039`)
and the message-level detail still behind the OTA portals.

## Phase status

| Phase | Before | Now |
|---|---|---|
| 1 Discovery | Partial | Partial |
| 2 Screen inventory | Partial | Partial (unchanged — needs Stayflexi access) |
| 3 Workflows | Not started | Not started |
| 4 Business rules & design | Partial | **Partial, strengthened** — one design rule now `DOC`-backed |
| 5 Integrations | Partial | **Substantially advanced** — 6 options compared, a decision reached |
| 6 Files | Updated | 05, 07, 08, 09, 10, 11, 12 + new 13 |
| 7 Completeness | 1st omission pass | 2nd omission pass **done** (see below) |

**Overall: ~30-35% -> an estimated 45-50%.**

## Second omission pass — performed

Deliberately re-read the brief's categories against what we hold. Gaps it found,
now logged: per-channel inventory **ceilings** vs pooled truth (`U-039`); whether
our hotels already hold the required OTA contracts (`U-036`, a *business*
dependency we had not recorded as one); and Channex **data ownership**, which is
the single term most capable of creating lock-in and is absent from everything
readable (`U-034`).

It also surfaced an omission in our own reasoning worth stating: the previous
pass recommended "an aggregator" generically on the strength of Stayflexi using
Rentals United. That was the wrong hub for a hotel PMS. The useful question was
not *whether* to use a hub but *which shape of hub* — vacation-rental hubs
require a content API we would otherwise never build.

## Still not reverse-engineered

Unchanged and worth repeating: Stayflexi's own screens remain documentation-only
(0 of 9 observed), Phase 3 workflows are not started, and the OTAs' message-level
specifications are behind four portals. What *is* now settled is the **strategy**
— which was the decision blocking everything downstream.
