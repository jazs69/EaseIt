# Channel Connectivity Strategy — 10 Properties, India-First

**Date checked:** 2026-10-23. All pricing and capability statements carry this
date; treat anything commercial as re-confirmable only in writing.
**Scope:** Which connectivity route a production PMS with ~10 hotel properties
in India should take.

Facts are graded `DOC` (official provider documentation), `VENDOR` (provider
marketing), `THIRD-PARTY` (someone else's claim), `INACCESSIBLE` (we tried and
could not read it), `ESTIMATE` (ours, labelled).

---

## 1. The finding that decides this

**An aggregator removes the eligibility barrier entirely, and the barrier was
the whole problem.**

Becoming a *certified connectivity partner* with Booking.com, Expedia or Agoda
means qualifying as a technology provider — which reportedly includes a
**minimum property count varying by region** (`EV-008`). Ten properties is very
unlikely to clear that.

Going through an aggregator inverts the relationship. The aggregator holds the
certifications. **Our hotels hold their own OTA contracts** — ordinary hotel
commercial relationships they may already have — and authorise the aggregator
against them. We never apply to be anyone's connectivity partner.

Channex states this directly: it sells **wholesale only to PMS vendors**, does
not sell to hotels, and names *"hotel groups building in-house systems"* as a
target customer (`EV-015`). That is a precise description of this project.

---

## 2. Comparison matrix

Scored 1–5 (5 best) against the evidence below. **Read the two gating columns
first** — a cost advantage on an option we cannot enter is worth nothing.

| Criterion | **Channex** | Rentals United | Direct Agoda | Direct Booking.com | Direct Expedia | Direct MMT |
|---|---:|---:|---:|---:|---:|---:|
| **Startup feasibility (new PMS, 10 props)** | **5** | 2 | 3 | 1 | 1 | 2 |
| **India OTA coverage** | **5** | 3 | 1 | 1 | 1 | 4 |
| Technical readiness (docs + sandbox) | **5** | 2 | 2 | 3 | 1 | 1 |
| Licence cost at 10 properties | 4 | 3 | 5 | 5 | 5 | 5 |
| Time to first integration | **5** | 2 | 2 | 1 | 1 | 2 |
| Operational risk | 4 | 2 | 3 | 3 | 3 | 2 |
| Long-term flexibility | 4 | 3 | 2 | 2 | 2 | 1 |
| **Total (unweighted)** | **32** | 17 | 18 | 16 | 14 | 17 |

**Why the unweighted total understates the gap:** direct options score 5 on
licence cost because the licence is free. That is not an advantage — it is the
absence of a product. Weighting by the two gating criteria (feasibility, time)
puts Channex further ahead, because every direct route is blocked at the door.

### Scoring justification

**Channex — 32.** Free staging, no card (`EV-015`). Published pricing. **Built
for PMS vendors**, explicitly including in-house hotel-group systems. Supports
**MakeMyTrip/Goibibo** (channel code `GMT`), plus Yatra and TBO India
(`EV-016`). No setup fee, no minimum contract, 30 days' notice. Documents a
real ordering protocol (§5). Loses a point on cost (a real recurring fee) and
on risk (single dependency).

**Rentals United — 17.** Self-described **vacation-rental** channel manager; the
search surfaced nothing hotel-specific. Its PMS-partner FAQ reportedly states
that pushing prices and availability **is not enough** — most channels need the
PMS to push and store *photos, descriptions and amenities*, so the **content API
is effectively mandatory** (`EV-017`). That is a far larger build than Channex,
which does not support content at all. It also reportedly requires a **PCI
compliance certificate** to pass card details, recommends allowing **at least
three months**, and its own *"minimum inventory requirements for White Label
Channel Manager"* page returned **HTTP 403** to us (`EV-018`) — the one document
that would settle our eligibility is unreadable. Acquired by **Guesty in May
2024** (`EV-017`, third-party), which adds consolidation risk.

**Direct Agoda — 18.** The only OTA whose own docs describe a new-partner route
(`EV-011`). But it is one OTA, with no sandbox documented, no published auth
model, and no MakeMyTrip.

**Direct Booking.com — 16.** Best developer docs of the four and real published
rate limits (`EV-007`), but the requirements page will not render (`EV-008`) and
**two independent third-party sources now say new connectivity providers are
paused or periodically closed** (`EV-009`, `EV-019`). Not official, but two
sources pointing the same way is worth weighting.

**Direct Expedia — 14.** Requirements portal gated (`EV-010`). Certification is
end-to-end with their teams, scoped by a named contact we do not have.

**Direct MakeMyTrip — 17.** Highest India value and the friendliest credential
model (per-property token issued by the hotel from the GOMMT extranet), but
**no official partner documentation exists at all** and appearing in the
extranet dropdown implies prior approval with no public application path
(`EV-013`, `U-030`).

---

## 3. Recommendation

**Integrate via Channex. Do not pursue direct OTA certification now.**

Three reasons, in order of weight:

1. **It is the only option we are eligible for today.** Every direct route is
   gated behind a partner programme we probably cannot enter at ten properties.
2. **It covers the India-critical channel.** MakeMyTrip/Goibibo is in the
   supported directory. Nothing else in the comparison gives us MMT *and*
   Booking.com/Expedia/Agoda through one integration.
3. **We can start today at zero cost and zero commitment.** Free staging, no
   card, no minimum contract. The decision is reversible for the price of 30
   days' notice.

**Ranked:** 1 Channex · 2 Direct Agoda (only credible direct route) ·
3 Direct MakeMyTrip (highest value, no door) · 4 Rentals United (wrong product
shape) · 5 Direct Booking.com (likely closed) · 6 Direct Expedia (gated).

### What this does not solve
Channex connects *existing* OTA listings. Its MMT guide states you need **a
direct contract with MakeMyTrip first**, then the Hotel ID and access token
(`EV-016`). So each hotel still needs its own OTA contracts — ordinary hotel
commerce, not a technology certification, but it is **not zero work** and it is
owned by the business, not engineering. It also does **not** create listings or
push content: Booking.com and Airbnb listing creation is a **2027 roadmap item,
not a commitment** (`EV-015`).

---

## 4. Preliminary 12-month cost model

**All figures `ESTIMATE` built on `DOC` unit prices of 2026-10-23.** Not a
quote. Channex publishes prices; it has not quoted us.

### Channex, 10 hotel properties

| Component | Unit (`DOC`) | Monthly | Annual |
|---|---|---:|---:|
| WhiteLabel platform fee | $130/mo flat | $130 | $1,560 |
| Per-property (hotel) | $7/property/mo | $70 | $840 |
| **Baseline total** | | **$200** | **$2,400** |

Phased variant, since **only properties with at least one active channel are
billed** (`EV-015`) and staging is free:

| Phase | Months | Billed properties | Cost |
|---|---|---:|---:|
| Build on staging | 1–3 | 0 | **$0** |
| Pilot, 1 property | 4 | 1 | $137 |
| Ramp, 3 properties | 5–6 | 3 | $302 |
| Full, 10 properties | 7–12 | 10 | $1,200 |
| **Year-1 total (`ESTIMATE`)** | | | **~$1,639** |

**Deliberately excluded:** Chat & Reviews add-on ($7/hotel/mo = $840/yr — not
needed); Stripe tokenisation ($0.02/txn — optional, and we should not handle
cards); overage charges (apply above 20 room types or 200 rate plans per hotel —
our properties carry 3–4 room types, so none expected).

### Rentals United (`ESTIMATE`, low confidence)
~EUR 107/mo on a yearly plan for 10–19 properties (`THIRD-PARTY`), ≈ **$1,300–
1,400/yr** at a ~1.08 USD/EUR assumption — **our FX assumption, not a quoted
rate**. Official pricing is quote-based. The licence looks cheaper than Channex;
the **total cost is higher**, because the mandatory content API is engineering
work Channex does not require, plus a PCI certificate and a stated three-month
project.

### Direct OTA
$0 licence. Engineering and certification effort for four adapters, plus
partner applications we are probably ineligible for. **Not costed, because the
cost of an unavailable option is not a number.**

---

## 5. What Channex resolved that no OTA would

Channex documents the mechanism four OTAs were silent about (`EV-015`):

- **Booking Revisions Feed with explicit acknowledgement** — poll the feed and
  **acknowledge each revision after saving it**. That is a real at-least-once
  delivery contract with a consumer-side commit point: exactly the primitive
  U-001 (idempotency) and U-002 (ordering) needed.
- **Webhooks *and* polling, both.** Channex sends an HTTPS POST and expects
  `200 OK`, and recommends **polling the feed every 15–20 minutes as a backup**.
  This independently confirms the design in `07-...md` §3.6 — arrived at from
  Agoda's `BookingHint` fallback — and it is now `DOC` rather than our inference.
- **Inbound covers new, modified and cancelled** reservations.
- **Limitation worth designing around:** you generally **cannot change dates or
  cancel an OTA reservation through Channex**. Some channel-specific actions
  exist (e.g. reporting a no-show to Booking.com). So outbound reservation
  *mutation* is largely not available — our UI must not offer it.

---

## 6. Vendor-independent build list

Everything here is worth building before any provider is chosen, is testable
against a fake adapter, and survives a change of provider.

1. **Outbox + BullMQ worker.** Required by every route (`07-...md` §1). Nothing
   can push ARI safely without it.
2. **`RatePlan` model.** Every mapping needs something to map to; this schema
   has only a `MealPlan` enum.
3. **ARI push scheduler** — debounce per `(propertyId, roomTypeId, dateRange)`,
   serialise per key, enqueue-time version gating, token-bucket rate limiting,
   jittered backoff, dead-letter that alerts.
4. **Full-state push builder** — assemble availability, rates and restrictions
   for a window from `inventory_day` and the rate calendar.
5. **Inbound reservation ingestion** — store the raw payload first, normalise
   second, idempotent on `(channel, external id)`. Already supported by
   `reservation_unique_ota_id_per_property`.
6. **Revision-feed consumer with acknowledge-after-save** — now a documented
   requirement, not a guess.
7. **Reconciliation differ** — read back a window, diff against our truth,
   report discrepancies.
8. **Channel Status surface** — the operator-facing truth check.
9. **`ChannelConnection` with two credential scopes** — partner-level and
   property-level. Channex is partner-level; MMT direct is property-level.

Items 1 and 2 are on the critical path for the whole product, not just this
feature.

---

## 7. Draft enquiries — NOT SENT

Per instruction, no vendor has been contacted. These are drafts for you to send,
edit or discard.

### 7.1 Channex

> **Subject:** PMS vendor enquiry — WhiteLabel eligibility, India coverage and onboarding
>
> Hello,
>
> We are building an in-house property management system for a group of
> approximately **10 hotel properties in India**, and are evaluating Channex as
> our channel connectivity layer. We have in-house development capacity and are
> integrating via your API directly.
>
> Could you confirm the following in writing:
>
> 1. **Eligibility.** Is a hotel group operating its own in-house PMS across
>    ~10 properties eligible for the WhiteLabel plan? Is there any minimum
>    property count or minimum commitment?
> 2. **India coverage.** Your directory lists MakeMyTrip/Goibibo (`GMT`), Yatra
>    and TBO India. Are all three currently live and available to a new account
>    operating in India? Are there market or region restrictions?
> 3. **MakeMyTrip prerequisites.** Your mapping guide indicates a direct
>    contract with MakeMyTrip is required first, then a Hotel ID and access
>    token. Is that still current, and does it differ for Goibibo?
> 4. **Existing listings.** Our properties already hold OTA accounts. Can those
>    existing listings be connected without recreating them?
> 5. **Staging and certification.** Is `staging.channex.io` available before any
>    commercial agreement? What does certification involve, and what is a
>    realistic elapsed time from first API call to first live property?
> 6. **Pricing confirmation.** We read $130/month platform fee plus $7 per hotel
>    property, billed only for properties with an active channel, no setup fee
>    and 30 days' notice to cancel. Please confirm this is current for our case.
> 7. **Contract terms.** Could you share the Customer Agreement, specifically
>    on **data ownership**, who owns the hotel relationship, white-label rights,
>    and any restriction on us later connecting an OTA directly?
> 8. **Reservation mutation.** We understand date changes and cancellations
>    generally cannot be pushed to an OTA through Channex. Which channel-specific
>    actions *are* supported?
>
> Thank you,
> [name, role, company]

### 7.2 Rentals United

> **Subject:** White Label Channel Manager — hotel support, eligibility and India coverage
>
> Hello,
>
> We are building an in-house PMS for approximately **10 conventional hotel
> properties in India** and are comparing white-label channel connectivity
> providers.
>
> Could you confirm:
>
> 1. **Hotel support.** Your product is presented for vacation rentals. Are
>    conventional hotels — multiple room types, multiple rate plans, per-date
>    inventory — fully supported, and does the API differ for them?
> 2. **Minimum inventory.** Your article *"Understanding minimum inventory
>    requirements for White Label Channel Manager"* returns HTTP 403 to us.
>    What is the minimum, and does a 10-property hotel group qualify?
> 3. **Content API.** Your PMS-partner FAQ indicates pushing rates and
>    availability is insufficient and that most channels require content
>    (photos, descriptions, amenities). Is the content API mandatory for hotel
>    channels, and which channels accept ARI-only?
> 4. **India coverage.** Which Indian OTAs are live — specifically
>    MakeMyTrip/Goibibo and Yatra — and are they available to a new account in
>    the Indian market?
> 5. **PCI.** You require a PCI compliance certificate to pass card details. We
>    intend never to receive card data. Can reservations be delivered with card
>    data suppressed, removing that requirement?
> 6. **Pricing.** Please quote for 10 hotel properties: setup, recurring,
>    per-property and any minimum.
> 7. **Timeline and sandbox.** Is a sandbox available pre-contract? You suggest
>    allowing three months — what drives that for a hotel-only, ARI-only scope?
> 8. **Ownership post-Guesty.** Any change to white-label rights, data ownership
>    or the commitment not to compete with partners' customers?
>
> Thank you,
> [name, role, company]

**A third enquiry is also required** and is not optional: **MakeMyTrip/GOMMT**,
to confirm (a) that our properties can hold MMT listings, (b) that Channex is a
selectable channel manager in their extranet for our account and market, and
(c) how the hotel-side access token is issued. Channex's coverage claim does not
establish availability to *our* account — the instruction not to assume that
applies here.

---

## 8. Go / No-Go

**GO — build against Channex staging.** Immediately, at zero cost and zero
commitment. Specifically: items 1–6 of the build list, verified against
`staging.channex.io`.

**NO-GO — direct OTA certification.** All four are gated behind partner
programmes we are probably ineligible for at ten properties, two third-party
sources suggest Booking.com is not accepting new providers, and three of four
hide their requirements behind portals we cannot read. Revisit only if the
portfolio grows materially or an OTA relationship arrives through other means.

**NO-GO — Rentals United.** Wrong product shape (vacation rentals), mandatory
content API we would otherwise not build, PCI certificate we would rather not
need, and an eligibility document we cannot read.

**CONDITIONAL — the commercial track runs in parallel.** The Channex enquiry and
the MMT enquiry should go out now, because the technical build does not depend
on their answers but **going live does**. If MMT turns out to be unavailable to
our account or market, the India case weakens materially and the recommendation
should be revisited — that is the single assumption most capable of overturning
this analysis.

### Written confirmation required before committing
1. Channex eligibility at 10 properties, and no minimum commitment.
2. MakeMyTrip/Goibibo live and available to our account **in India**.
3. Channex Customer Agreement: data ownership, white-label rights, no
   restriction on later direct connections.
4. Whether each of our hotels already holds the OTA contracts Channex requires.
5. Realistic elapsed time from first staging call to first live property.
