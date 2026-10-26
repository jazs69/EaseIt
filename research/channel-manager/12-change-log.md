# Change Log

**Status:** Not started. Scaffold only.
**Blocked on:** n/a -- maintained from now on.

## 2026-10-23 -- First research pass

- Created `research/channel-manager/` with 13 files.
- 6 evidence items registered: 3 direct documentation fetches, 1 vendor product page,
  2 search-summary-only (flagged as weaker and due a direct re-fetch).
- 57 features inventoried across categories A-G; 9 screens identified, **0 observed**.
- **Structural finding:** Stayflexi publishes no top-level Channel Manager section;
  channel controls live inside Rates and Inventory (`EV-002`).
- **Architectural finding:** Stayflexi claims pooled inventory with automatic close-outs,
  which the `inventory_day` model here already implements and proves under a race test.
- **Tension logged:** pooled inventory (`CM-B-001`) versus documented per-channel
  inventory overrides (`CM-B-006`). Raised as `Q-006`.
- **Method finding:** Stayflexi KB pages carry ~100 KB of sidebar before the article body;
  fetches must pass `offset: 100000` or they return navigation only.
- **Scope finding:** sync semantics (category D, ~15%) are not recoverable from public
  Stayflexi material; OTA partner protocol docs are the better source.
- Coverage assessed at 15-20%. **Not reverse-engineered.**

## 2026-10-23 -- OTA provider research pass

Investigated Booking.com Connectivity, Agoda YCS, Expedia Group lodging
connectivity and MakeMyTrip/GOMMT. **No application code touched, no packages
installed, no live account accessed.**

### Evidence
- `EV-007` to `EV-014` registered (8 new). Three direct official fetches
  (Booking.com developer docs; Agoda introduction, updated 2026-09-09), two
  **failed/gated** fetches recorded as failures rather than omitted
  (Booking.com requirements article renders a CSS error; Expedia requirements
  page 302s to an empty portal), two search summaries of official pages, one
  unofficial Postman spec, one company press release.

### Findings
- **No provider documents idempotency, retries, event ordering, conflict
  resolution or reconciliation.** Booking.com's docs are explicitly silent.
  U-001 to U-006 reclassified from unknown to **our design responsibility**.
- **Credential scope differs per channel**: partner-level for Booking.com and
  Agoda, **property-level** for MakeMyTrip (hotel issues the token from the
  GOMMT extranet). `ChannelConnection` must model both.
- **Booking.com publishes real rate limits** (10,000/min global; 700/min
  reservations summary; 200/min RtB warning at 170; 75/min OTA notification;
  HTTP 429; may change without notice) and isolates **reservations on a
  separate PCI host**.
- **Agoda is pull-oriented.** Official docs describe retrieving booking lists
  and details; an unofficial spec says there is no push booking, only a
  `BookingHint` notification with an email fallback. A webhook-only inbound
  design would fail on the one provider with a documented new-partner route.
- **Agoda updates may be full-overwrite with partial updates disallowed**
  (unofficial). If confirmed, this gives idempotent pushes by construction.
- **Agoda is the only one of the four** whose own documentation describes a path
  for new partners.
- **Expedia** requires end-to-end certification with its teams, TLS 1.2, and no
  direct IP connections; certification is test reservations with field
  variations, scoped by a named connectivity contact.
- **MakeMyTrip has no public partner documentation at all.** The flow is
  hotel-driven via the GOMMT extranet dropdown, which implies an invisible
  prior approval gate.
- **No provider documents a sandbox** (U-032).

### Raised
- `U-027` to `U-033` (7 new unknowns), including `U-033` Rentals United /
  aggregator terms, now the highest-value remaining research target.
- **`Q-008`**: how many properties will EaseIt present to an OTA? Booking.com
  reportedly requires a regional minimum property count; CLAUDE.md fixes this
  product at 10 properties. If that threshold is real, direct certification may
  be unattainable and an aggregator hub becomes the realistic path.

### Files changed
`05-integration-matrix.csv` (rewritten with provider data, 20 columns),
`07-sync-and-failure-handling.md` (rewritten; confirmed requirements separated
from our recommendations), `08-evidence-register.csv` (+8),
`09-unknowns-and-open-questions.md` (resolution pass + 7 new unknowns + Q-008),
`10-coverage-report.md` (coverage 15-20% -> 30-35%), this log.

## 2026-10-26 -- Connectivity strategy pass

Compared Channex, Rentals United, direct Agoda, direct Booking.com, direct
Expedia and direct MakeMyTrip for a PMS launching with ~10 hotel properties in
India. **No PMS code modified, no packages installed, no live account accessed,
NO VENDOR CONTACTED, no application submitted.**

### Evidence
- `EV-015` to `EV-019` registered. One direct fetch of Channex's official
  machine-readable index plus pricing pages (the most actionable provider
  evidence in the set); one official Channex docs/help search summary; one
  Rentals United mixed official/third-party summary; one **recorded HTTP 403**
  on the Rentals United minimum-inventory page; one second third-party source
  on Booking.com pausing new connectivity providers.

### Decision
**Integrate via Channex. Do not pursue direct OTA certification now.**
Ranked: 1 Channex (32/35) · 2 direct Agoda · 3 direct MakeMyTrip ·
4 Rentals United · 5 direct Booking.com · 6 direct Expedia.

### Why
- **Eligibility is the whole problem, and an aggregator removes it.** We never
  apply as a connectivity partner; Channex holds the certifications and our
  hotels hold their own OTA contracts.
- **Channex carries MakeMyTrip/Goibibo** (code `GMT`), plus Yatra and TBO India
  -- the only option compared that covers the India-critical channel alongside
  Booking.com, Expedia and Agoda.
- **Free staging, no card, no minimum contract, 30 days notice.** We can start
  at zero cost and the decision is reversible.
- **Rentals United is the wrong shape**: vacation-rental product, content API
  effectively mandatory, PCI certificate for card data, >=3 months, and its
  eligibility page is gated (403).

### Cost (ESTIMATE on DOC unit prices)
$130/mo platform + 10 x $7/property = **$200/mo, $2,400/yr** at full rollout.
Phased year-1 **~$1,639**, since staging is free and only properties with an
active channel are billed.

### Resolved
- **Q-008 resolved in effect** -- 10 properties is a fact; the OTA minimum-count
  blocker is bypassed rather than overcome.
- **U-033 resolved and reframed** -- the question was never *whether* to use a
  hub but *which shape*; vacation-rental hubs demand a content API a hotel PMS
  would otherwise never build.
- **U-027 strengthened** -- a second independent source says Booking.com is
  pausing new connectivity providers. Enough to deprioritise; still not official.
- **`07-...md` §3.6 upgraded from inference to `DOC`** -- Channex documents
  webhook **plus** mandatory 15-20 minute polling of a Booking Revisions Feed
  with acknowledge-after-save.
- **Q-004 moot, Q-005 answerable** (MakeMyTrip first).

### Raised
`U-034` Channex data ownership (absent from everything readable -- the main
lock-in risk) · `U-035` whether MMT via Channex is available to **our account in
India** (the assumption most capable of overturning this) · `U-036` whether our
hotels already hold the required OTA contracts (a **business** dependency) ·
`U-037` certification elapsed time · `U-038` Rentals United minimum inventory ·
`U-039` per-channel inventory ceilings.

### Files changed
`05-integration-matrix.csv` (rewritten: 6 ranked options, 22 columns),
`08-evidence-register.csv` (+5), `09-unknowns-and-open-questions.md`
(Q-008 + U-033 resolved, 6 new unknowns), `10-coverage-report.md`
(35% -> 45-50%, second omission pass done), `11-implementation-backlog.md`,
**new `13-connectivity-strategy.md`**, this log.
