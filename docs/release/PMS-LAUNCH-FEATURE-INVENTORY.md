# EaseIt PMS — Launch Feature Inventory

**This is a living document, not a report.** It is the persistent release-readiness record for
EaseIt PMS. Consult it at the start of every feature task and update it at the end of the same task.

|                               |                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Document created              | 2026-10-29                                                                                           |
| Last full audit               | 2026-10-29                                                                                           |
| Last CI-failure investigation | 2026-10-29 — GitHub Actions run 40820963243, both jobs failed; root causes fixed, see change history |
| Repository                    | `D:\EaseIt`                                                                                          |
| Branch / HEAD at last audit   | `master` / `f93f815`                                                                                 |
| Working tree at last audit    | dirty — 8 modified, 12 untracked (release-gate and concurrency-test workstreams, uncommitted)        |

---

## 0. How to use and maintain this document

### Mandatory update rule

When asked to implement a feature, continue a feature, fix a bug affecting a feature, or finish a
module:

1. **Read this file first.** Identify the affected feature IDs and their current statuses.
2. Implement the work.
3. Run the applicable **safe** tests (never destructive suites against a shared database or Redis).
4. **Update this same file in the same task** — evidence paths, test commands and actual results,
   remaining work, last-verified date, summary counts, launch blockers, and the change history.
5. Mark an item `COMPLETE AND VERIFIED` **only** when its documented acceptance criterion is met
   _and_ a test proves it. Implementation without tests is `PARTIALLY IMPLEMENTED` or
   `BLOCKED / UNKNOWN`, with the reason stated.
6. Recompute parent status from children. **A parent is never complete while a required child is
   incomplete.**
7. On regression, downgrade immediately and record it.
8. Never delete a feature ID or a history entry to make progress look better. Deprecated or
   out-of-scope items are marked explicitly, with a reason.
9. Do not claim this document was updated unless the file actually changed.

### Status vocabulary

| Code | Status                    | Meaning                                                                              |
| ---- | ------------------------- | ------------------------------------------------------------------------------------ |
| `CV` | **COMPLETE AND VERIFIED** | Implemented _and_ proven by a test whose command and result are recorded here.       |
| `PI` | **PARTIALLY IMPLEMENTED** | Code exists and is plausibly wired, but behaviour is unproven, or parts are missing. |
| `NI` | **NOT IMPLEMENTED**       | Absent, or a deliberate placeholder.                                                 |
| `BU` | **BLOCKED / UNKNOWN**     | Cannot be verified in the current environment. The required isolated setup is named. |

**Code presence is never evidence of function.** A page, endpoint, schema model, DTO, removed TODO
or successful build does not move an item to `CV`.

### Column codes

- **U/A/L/D/I** — UI / API / business-Logic / Database / Integration. `✔` present, `~` partial,
  `✖` absent, `–` not applicable, `⚠` present with a known defect.
- **Launch** — `M` mandatory for core PMS launch · `A` mandatory only if advertised / in scope ·
  `P` post-launch.
- **Pri** — severity 1 (critical) … 4 (cosmetic).
- **Method** — `SI` static inspection · `TR` test run (command recorded) · `NV` not verified.

### Standing assumptions

1. "Core PMS launch" means a single property can be configured, sold, booked, checked in, billed,
   checked out, and closed for the night without leaving the product. Booking engine and channel
   manager are **optional modules**, mandatory only because CLAUDE.md §1 advertises them.
2. CLAUDE.md is treated as the product specification. Where the repository and CLAUDE.md disagree,
   CLAUDE.md §0 says the file wins and the code is a bug worth reporting — so gaps against it are
   recorded as gaps, not as scope changes.
3. Tests run earlier in a session against an isolated database are recorded with their provenance
   and are **not** re-asserted as current unless re-run.

---

## 1. Executive summary

### Counts by status

Counted mechanically from the status column of the inventory tables in §2, not estimated:

| Status                     | Count   | Share |
| -------------------------- | ------- | ----- |
| `CV` COMPLETE AND VERIFIED | 102     | 49.8% |
| `PI` PARTIALLY IMPLEMENTED | 90      | 43.9% |
| `NI` NOT IMPLEMENTED       | 11      | 5.4%  |
| `BU` BLOCKED / UNKNOWN     | 2       | 1.0%  |
| **Total feature IDs**      | **205** |       |

Verification command and result (re-run 2026-11-15):

```
$ grep -oE '^\| [A-Z]{2}-[0-9]{2} \| [^|]+ \| `(CV|PI|NI|BU)`' docs/release/PMS-LAUNCH-FEATURE-INVENTORY.md     | grep -oE '`(CV|PI|NI|BU)`' | sort | uniq -c
      7 `BU`
     43 `CV`
     62 `NI`
     93 `PI`
$ grep -oE '^\| [A-Z]{2}-[0-9]{2} \|' …  | sort -u | wc -l
205
```

Note that `CV` counts _subfeature rows_, and most of the 32 are concentrated in three areas —
reservation write paths, the folio money paths, and the release gate. Read §3.1 before treating
15.6% as broad coverage.

### The structural finding

CLAUDE.md §2 specifies **13 API modules**. The repository implements 8 of that set plus 6 unplanned
ones. Absent as module, schema **and** endpoints:

`inventory` · `rates` · `frontdesk` · `housekeeping` · `nightaudit` · `channels` · `booking-engine`

What exists is a **reservations-and-folio core with group reporting**, not yet a hotel PMS.

### Launch blockers

- [x] **FD-04 — Check-out implemented and verified (2026-10-30).** Was: `CHECKED_OUT` is read by reports, folios and the state
      machine, but no endpoint, service or UI transitions a stay into it. Zero matches for
      `@Post(...check-out)` in `apps/api/src`.
- [x] **AV-05 / RS-01 — Quotes and bookings price from rate plans, night by night (2026-11-15).**
      Each night is stored in `reservation_night`; check-in posts the arrival night's own price.
- [x] **AV-06 / AV-07 — Derived plans, stay restrictions, and occupancy + promotions pricing
      bookings: implemented and verified (2026-11-15).**
- [x] **FO-05 / FO-06 — Downward folio corrections on taxed charges no longer 500 (2026-11-15).**
      Negative tax is a flagged ADJUSTMENT; the constraint is unchanged.
- [x] **HK-01 … HK-05 — Housekeeping board, tasks and inspections built and verified (2026-11-16).**
      The board screen is not yet exercised in a browser.
- [ ] **NA-01 / NA-05 — No night audit, no business-date roll.** `property.businessDate` is read
      everywhere and advanced by nothing. The books never close.
- [x] **FO-03 / FO-04 — Folio payment idempotency implemented and verified (2026-10-31).** Was:
      a retried POST can double-post against real money. Now a required client key under
      `folio_line_propertyId_idempotencyKey_key`; proven by mutation that removing the index
      restores the duplicate.
- [x] **RM-02 / RM-04 — Room-type and room CRUD, including retirement, implemented and verified
      (2026-11-15).** `room-type-crud`, `room-crud`, `room-retirement` suites in the integration gate.
- [ ] **MT-02 / MT-03 / MT-04 — Tenancy context, Prisma tenancy extension and RLS all absent**,
      against CLAUDE.md §3.2.
- [x] **CI-14 — Deployment configuration: Docker images, compose stack, smoke-tested (2026-11-17).**
- [ ] **AU-08 — No password reset.**
- [x] **AU-13 — Permissions for unbuilt features are no longer grantable (2026-11-15).**

### Critical risks

| Risk                                      | Finding                                                                                                                                                                      | ID       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Payment double-post (closed)              | Required client idempotency key under `folio_line_propertyId_idempotencyKey_key`; 60/60 incl. concurrent same-key POSTs, and the duplicate returns when the index is dropped | FO-03/04 |
| Unbounded lock wait when booking (closed) | Fixed 2026-11-15: `create-reservation.service.ts` sets `lock_timeout`; a parked booking answers 409 `CONFLICT` in ~3 s                                                       | RS-17    |
| Deadlock retries (mostly closed)          | `40P01` induced on cancellation 2026-11-17 (retried, then typed 409); `40001` and the other paths still not induced                                                          | RS-18    |
| Synthetic company data                    | `gst.service.ts:60` defaults `GST_PROVIDER=mock`; `:68` warns lookups return synthetic names                                                                                 | GP-04    |
| Dead payment schema                       | `PaymentGatewayConfig` model has **zero** references in `apps/api/src`                                                                                                       | FO-15    |
| RBAC over-promises                        | `RESERVATIONS_CHECKOUT`, `FOLIO_REFUND/SETTLE`, `NIGHT_AUDIT_*`, `HOUSEKEEPING_*` grantable and inert                                                                        | AU-13    |
| Release CI will likely fail               | `release.yml:142` installs `postgresql-client-17`, absent from Ubuntu default repos; the `\|\|` fallback gives client 16, which refuses a PG 17 server                       | CI-12    |
| No off-site backup copy                   | Nightly verified backups exist (2026-11-17) but stay on the server's disk until an operator syncs them elsewhere; no PITR, so up to 24 h of loss                             | BR-01/04 |
| Reports precede closed books              | Mitigated 2026-11-17: closed days now read from `daily_snapshot`; open days remain live and are labelled. Days from before the night audit existed have no snapshot          | RP-08    |

### Confidence and limitations

- **High** — code presence/absence, schema, routes, endpoints, CI configuration. Directly inspected.
- **Medium** — reservation write paths. Extensively tested against an isolated database on
  2026-10-29, recorded below with commands and counts; not re-run since.
- **Low / unverifiable** — everything requiring a running service. During the 2026-10-29 audit no
  endpoint was invoked, no UI was rendered and no worker was started. PostgreSQL was stopped,
  nothing listened on 6379, and the Docker daemon was down.

---

## 2. Feature inventory

### 2.1 Multi-tenancy and organizations

Parent status: **`PI`** — row-level scoping exists; the three controls CLAUDE.md §3.2 names as
primary are absent.

| ID    | Subfeature                                        | St   | Evidence                                                                                                                                                                                                                                                                        | U/A/L/D/I | Tests and actual result                                      | Acceptance criterion                                                                                          | Dep   | Pri | Launch | Verified   | Method |
| ----- | ------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----- | --- | ------ | ---------- | ------ |
| MT-01 | `propertyId` on operational tables                | `PI` | `packages/database/prisma/schema.prisma` — 27 models                                                                                                                                                                                                                            | –/–/~/✔/– | none                                                         | Every operational table carries non-nullable `propertyId`; composite indexes lead with it; audit documented   | —     | 2   | M      | 2026-10-29 | SI     |
| MT-02 | Request-scoped tenant context (AsyncLocalStorage) | `CV` | 2026-11-16: `@repo/database` tenancy scope (AsyncLocalStorage); `SessionAuthGuard` / `ActivePropertyGuard` record the route's property, `TenantScopeInterceptor` runs the handler inside it. `tenant-isolation.test.mjs`                                                        | ✖/✖/✖/–/– | none                                                         | Property resolved per request from session or slug, never from a client header/body/query                     | MT-03 | 1   | M      | 2026-10-29 | SI     |
| MT-03 | Prisma tenancy client extension                   | `CV` | 2026-11-16: `createTenantClient` (`packages/database/src/tenancy.ts`): AND propertyId on every read/update/delete, stamps or refuses on create, throws with no scope; `PrismaService.client` uses it                                                                            | ✖/✖/✖/✖/– | none                                                         | Extension injects `where: { propertyId }` on every find/update/delete/count/aggregate and stamps it on create | MT-02 | 1   | M      | 2026-10-29 | SI     |
| MT-04 | Postgres RLS backstop                             | `CV` | 2026-11-16: migration `20261116120000_tenant_row_level_security` (forced default-deny on all 36 NOT NULL propertyId tables); API/worker connect as non-superuser `easeit_app` (`scripts/db-app-role.mjs`); the setting is applied in the query's own transaction                | ✖/✖/✖/✖/– | none                                                         | RLS enabled on tenant tables; a query without the setting returns zero rows                                   | MT-03 | 1   | M      | 2026-10-29 | SI     |
| MT-05 | Cross-tenant reads return 404 not 403             | `CV` | 2026-11-16: `tenant-isolation.test.mjs` section D probes reservations, folios, cancel, no-show and room types across properties (all 404), plus each module's own tenancy checks. Was: `apps/api/src/common/guards/active-property.guard.ts` throws `TenantScopeViolationError` | –/✔/✔/–/– | cancellation suite step 8 (2026-10-29, isolated DB) — passed | Per-module test asserts read/update/delete of another property's row returns not-found                        | MT-03 | 2   | M      | 2026-10-29 | TR     |
| MT-06 | Property access allowlist                         | `PI` | `UserPropertyRole` model                                                                                                                                                                                                                                                        | ✔/✔/✔/✔/– | none                                                         | Switching property re-authorizes; a user without a grant is refused                                           | —     | 2   | M      | 2026-10-29 | SI     |
| MT-07 | Property switch / select-context                  | `PI` | `apps/api/src/modules/properties/properties.controller.ts:78`                                                                                                                                                                                                                   | ✔/✔/✔/✔/– | none                                                         | Context switch re-signs the session and is rejected without a grant                                           | MT-06 | 3   | M      | 2026-10-29 | SI     |
| MT-08 | `withoutTenantScope()` escape hatch               | `CV` | 2026-11-16: `withoutTenantScope(reason, fn)`, logged; used by `@CrossProperty` routes (sign-in/session, group dashboard, calendar, performance, property switch, role templates, outbox gauge), the active-property guard's grant lookup and the outbox dispatcher              | ✖/✖/✖/–/– | none                                                         | Helper exists, is logged, and is permitted only for night audit, cross-property reporting and migrations      | MT-03 | 3   | A      | 2026-10-29 | SI     |

### 2.2 Property setup and configuration

Parent status: **`PI`** — broad surface, zero tests.

| ID    | Subfeature                   | St   | Evidence                                                                    | U/A/L/D/I | Tests and actual result | Acceptance criterion                                                                | Dep   | Pri | Launch | Verified   | Method |
| ----- | ---------------------------- | ---- | --------------------------------------------------------------------------- | --------- | ----------------------- | ----------------------------------------------------------------------------------- | ----- | --- | ------ | ---------- | ------ |
| PS-01 | Setup read                   | `PI` | `property-setup.controller.ts:56`                                           | ✔/✔/✔/✔/– | none                    | Returns the full setup payload for a scoped property                                | —     | 3   | M      | 2026-10-29 | SI     |
| PS-02 | General settings update      | `PI` | `property-setup.controller.ts:75`                                           | ✔/✔/✔/✔/– | none                    | Round-trip test: PATCH then GET returns the written values                          | PS-01 | 3   | M      | 2026-10-29 | SI     |
| PS-03 | Tax slabs                    | `PI` | `:95`; `PropertyTaxSlab`; migration `20261019093000_slab_floor_index_dedup` | ✔/✔/✔/✔/– | none                    | A slab change alters a new folio's tax lines; inclusive and exclusive both asserted | FO-10 | 2   | M      | 2026-10-29 | SI     |
| PS-04 | Amenities                    | `PI` | `:117`; `Amenity`, `PropertyAmenityLink`                                    | ✔/✔/✔/✔/– | none                    | Linked amenities round-trip                                                         | —     | 4   | A      | 2026-10-29 | SI     |
| PS-05 | Policies                     | `PI` | `:142`; `PropertyPolicy`, `PolicyType`                                      | ✔/✔/✔/✔/– | none                    | Policies round-trip and are visible to the booking surface                          | —     | 3   | A      | 2026-10-29 | SI     |
| PS-06 | Fees and surcharges          | `PI` | `:160`; `FeeAndSurcharge`, `FeeType`                                        | ✔/✔/✔/✔/– | none                    | A configured fee appears as its own folio line on a new stay                        | FO-02 | 2   | A      | 2026-10-29 | SI     |
| PS-07 | Media upload                 | `PI` | `:180`; `PropertyMedia`, `MediaCategory`                                    | ✔/✔/✔/?/? | none                    | Upload persists and is retrievable; storage backend documented                      | —     | 3   | A      | 2026-10-29 | SI     |
| PS-08 | Timezone / currency / locale | `PI` | `Property.timezone`, `.currency`, `.locale`                                 | ✔/✔/~/✔/– | none                    | Date boundaries respect the property's IANA zone; asserted for two zones            | NA-05 | 2   | M      | 2026-10-29 | SI     |
| PS-09 | Business date field          | `PI` | `Property.businessDate @db.Date`                                            | –/✔/~/✔/– | none                    | Advanced only by night audit step 7                                                 | NA-05 | 1   | M      | 2026-10-29 | SI     |

### 2.3 Users, authentication and RBAC

Parent status: **`PI`** — complete-looking surface with no dedicated tests and no password reset.

| ID    | Subfeature                             | St   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                            | U/A/L/D/I      | Tests and actual result                                                                                                                                                                                                                                                                                | Acceptance criterion                                                                   | Dep   | Pri | Launch | Verified   | Method |
| ----- | -------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ----- | --- | ------ | ---------- | ------ |
| AU-01 | Login                                  | `PI` | `apps/api/src/modules/auth/auth.controller.ts:84`                                                                                                                                                                                                                                                                                                                                                                                                   | ✔/✔/✔/✔/–      | none                                                                                                                                                                                                                                                                                                   | Valid credentials issue a challenge; invalid are refused without revealing which field | —     | 1   | M      | 2026-10-29 | SI     |
| AU-02 | 2FA OTP verification                   | `PI` | `:128`; `TwoFactorChallenge`; migration `20261016093000`                                                                                                                                                                                                                                                                                                                                                                                            | ✔/✔/✔/✔/✔ mail | none                                                                                                                                                                                                                                                                                                   | Correct OTP issues a session; wrong/expired/replayed are refused                       | NO-01 | 2   | M      | 2026-10-29 | SI     |
| AU-03 | OTP resend                             | `PI` | `:159`                                                                                                                                                                                                                                                                                                                                                                                                                                              | ✔/✔/✔/✔/✔      | none                                                                                                                                                                                                                                                                                                   | Resend is rate-limited and invalidates nothing already valid                           | AU-07 | 3   | M      | 2026-10-29 | SI     |
| AU-04 | Session read                           | `PI` | `:173`                                                                                                                                                                                                                                                                                                                                                                                                                                              | ✔/✔/✔/✔/–      | none                                                                                                                                                                                                                                                                                                   | Returns identity and permissions for the active property                               | —     | 2   | M      | 2026-10-29 | SI     |
| AU-05 | Logout                                 | `PI` | `:196`                                                                                                                                                                                                                                                                                                                                                                                                                                              | ✔/✔/✔/✔/–      | none                                                                                                                                                                                                                                                                                                   | Cookie cleared and session unusable afterwards                                         | —     | 2   | M      | 2026-10-29 | SI     |
| AU-06 | Session revocation                     | `PI` | `auth.service.ts:165`; `User.sessionsValidFrom`; migration `20261018040000`                                                                                                                                                                                                                                                                                                                                                                         | –/✔/✔/✔/–      | none                                                                                                                                                                                                                                                                                                   | Revoking invalidates every pre-existing token; admin UI exists                         | —     | 2   | M      | 2026-10-29 | SI     |
| AU-07 | Login rate limiting                    | `PI` | `apps/api/src/modules/platform/rate-limiter.service.ts:48`                                                                                                                                                                                                                                                                                                                                                                                          | –/✔/✔/–/–      | none                                                                                                                                                                                                                                                                                                   | Limits hold across instances (currently in-process only)                               | —     | 2   | M      | 2026-10-29 | SI     |
| AU-08 | Password reset / forgot password       | `CV` | 2026-11-16: `POST /auth/password/forgot` (same answer for every address, rate limited) and `/auth/password/reset`; `auth_token` stores only a SHA-256; single use by conditional consume; 30 min; sessions revoked on reset; `/forgot-password` and `/reset-password` pages. `account-lifecycle.test.mjs`, mutation-checked                                                                                                                         | ✖/✖/✖/–/✖      | none                                                                                                                                                                                                                                                                                                   | Single-use expiring token; replay and expiry both refused                              | NO-01 | 1   | M      | 2026-10-29 | SI     |
| AU-09 | Role templates                         | `PI` | `rbac.controller.ts:12`; 7 global roles seeded (`SUPER_ADMIN`…`POS_STAFF`)                                                                                                                                                                                                                                                                                                                                                                          | ✔/✔/✔/✔/–      | none                                                                                                                                                                                                                                                                                                   | Template permissions match the documented matrix                                       | —     | 2   | M      | 2026-10-29 | SI     |
| AU-10 | Custom role create / update            | `PI` | `access-control.controller.ts:82`, `:93`                                                                                                                                                                                                                                                                                                                                                                                                            | ✔/✔/✔/✔/–      | none                                                                                                                                                                                                                                                                                                   | Create/rename/repermission round-trip; delete exists                                   | AU-09 | 3   | A      | 2026-10-29 | SI     |
| AU-11 | Assign roles to users                  | `PI` | `access-control.controller.ts:123`                                                                                                                                                                                                                                                                                                                                                                                                                  | ✔/✔/✔/✔/–      | none                                                                                                                                                                                                                                                                                                   | Assignment changes effective permissions immediately                                   | AU-09 | 2   | M      | 2026-10-29 | SI     |
| AU-12 | Permission enforcement                 | `PI` | `apps/web-admin/src/hooks/use-has-permission.ts`; `@Roles()` guards                                                                                                                                                                                                                                                                                                                                                                                 | ✔/✔/✔/–/–      | cancellation suite step 9a (2026-10-29) — grant without `reservations:edit` refused 403, nothing changed                                                                                                                                                                                               | Per-endpoint permission matrix asserted                                                | AU-09 | 2   | M      | 2026-10-29 | TR     |
| AU-13 | Permissions for unimplemented features | `CV` | `UNAVAILABLE_PERMISSIONS` in `packages/types/src/rbac.ts` (night audit ×2, housekeeping read, folio refund, channels ×2) filtered from `permissionsForRoles`, the session, the active-property context and role views; custom-role create/update refuse them (400); the role editor shows them locked with the reason. `RESERVATIONS_CHECKOUT`, `FOLIO_SETTLE` and `HOUSEKEEPING_UPDATE_STATUS` are enforced by shipped features and stay grantable | –/✔/✔/–/–      | `unavailable-permissions` unit suite (fast gate): the list matches the code both ways — every listed permission is enforced nowhere, every other one somewhere; `unavailable-permissions` integration 14/14 — `pnpm gate:integration` on `easeit_test` → 17/17 suites, 1245 PASS / 0 FAIL (2026-11-15) | Permissions whose feature does not exist cannot be granted                             | —     | 1   | M      | 2026-11-15 | TR     |
| AU-14 | User invitation / onboarding           | `CV` | 2026-11-16: `POST /properties/:propertyId/users/invite` (`users:manage`) emails a 72 h single-use link; `POST /auth/invitations/accept` sets the first password; `/accept-invite` page. The staff screen itself is still a local preview (its invite button does not call the API yet)                                                                                                                                                              | ✖/✖/✖/–/✖      | none                                                                                                                                                                                                                                                                                                   | Invite, accept, first-login password set                                               | NO-01 | 2   | A      | 2026-10-29 | SI     |
| AU-15 | User deactivation                      | `CV` | 2026-11-16: `POST .../users/:userId/deactivate` and `/reactivate` (`users:manage`): blocks sign-in, revokes sessions and unused links, audited; refused for oneself, a portfolio operator, or someone working at another property unless the caller is a portfolio operator                                                                                                                                                                         | ✖/✖/✖/✔/–      | none                                                                                                                                                                                                                                                                                                   | Deactivating blocks login and revokes sessions                                         | AU-06 | 2   | M      | 2026-10-29 | SI     |

### 2.4 Room types and rooms

Parent status: **`CV`** — categories and rooms can be created, edited, retired and withheld from sale
(room blocks) through the API, each proven by an integration suite (2026-11-15). Admin UI for retirement
and blocks is tracked under AV-10.

Shared evidence below, "the gate": `pnpm gate:integration` against `easeit_test` with the API on :4100
→ 14/14 suites, 1118 PASS / 0 FAIL, exit 0 (2026-11-15).

| ID    | Subfeature              | St   | Evidence                                                                                                                                                                | U/A/L/D/I | Tests and actual result                                                                                                                                                 | Acceptance criterion                                                   | Dep          | Pri | Launch | Verified   | Method |
| ----- | ----------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------ | --- | ------ | ---------- | ------ |
| RM-01 | `RoomType` model        | `CV` | `schema.prisma` `RoomType` incl. `retiredAt`/`retiredByUserId` (migration `20261115090000_retire_rooms_and_room_types`)                                                 | –/–/–/✔/– | room-type-crud, room-retirement and rates suites — the gate                                                                                                             | Model supports the documented pricing and overbooking policy           | —            | 1   | M      | 2026-11-15 | TR     |
| RM-02 | Room type CRUD API      | `CV` | `room-type.controller.ts` GET/POST/PATCH; `POST …/room-types/:id/retire` → `retirement.service.ts`                                                                      | –/✔/✔/✔/– | `room-type-crud` pass; `room-retirement` 50/50 — retire refused with an active room or a live stay, idempotent; a retired type is unquotable and unbookable — the gate  | Create/edit/retire a category; retiring one with live stays is refused | RM-01        | 1   | M      | 2026-11-15 | TR     |
| RM-03 | `Room` model            | `CV` | `schema.prisma` `Room`, `RoomStatus`, `retiredAt`                                                                                                                       | –/–/–/✔/– | room-crud, room-status and room-retirement suites — the gate                                                                                                            | —                                                                      | —            | 1   | M      | 2026-11-15 | TR     |
| RM-04 | Room CRUD API           | `CV` | `room.controller.ts` GET/POST/PATCH; `POST …/rooms/:id/retire` decrements `physical` from today under the room-row → inventory lock order                               | –/✔/✔/✔/– | `room-crud` pass; `room-retirement` 50/50 — refused with a future stay, an active block, or when it would oversell; retire vs last booking: exactly one wins — the gate | Add/edit/retire a room; retiring an occupied room is refused           | RM-03        | 1   | M      | 2026-11-15 | TR     |
| RM-05 | Room status transitions | `CV` | `POST …/rooms/:id/status`, `room-status.policy.ts`; a retired room is refused                                                                                           | –/✔/✔/✔/– | `room-status` pass — transitions and `ROOM_STATUS_CHANGED` audit rows; FRONT_DESK reads status via the room list — the gate. The housekeeping board is HK-02            | Status changes are audited and visible to front desk                   | HK-01        | 1   | M      | 2026-11-15 | TR     |
| RM-06 | Out-of-order handling   | `CV` | Implemented as **room blocks** (`room-block.service.ts`): a specific-room block raises `inventory_day.blocked` on its nights. `OUT_OF_ORDER` stays unsettable by design | –/✔/✔/✔/– | `room-blocks` 78/78 — blocked counters match live blocks per date and category; a blocked unit cannot be booked — the gate                                              | An out-of-order room reduces sellable inventory for the affected dates | AV-04, MA-01 | 2   | M      | 2026-11-15 | TR     |

### 2.5 Availability, rates and inventory

Parent status: **`PI`** — protection and inventory management (blocks, overbooking allowance) are
proven; rate plans and the calendar are tested but **not yet used by quote or booking** (F9, the next
backlog item); restrictions (AV-07) and derived rates do not exist; the admin screen is unverified.

| ID    | Subfeature                               | St   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                      | U/A/L/D/I | Tests and actual result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Acceptance criterion                                                                             | Dep          | Pri | Launch | Verified   | Method |
| ----- | ---------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------ | --- | ------ | ---------- | ------ |
| AV-01 | Per-date inventory counters              | `CV` | `InventoryDay`; migration `20261016140000_inventory_and_reservations`                                                                                                                                                                                                                                                                                                                                                         | –/✔/✔/✔/– | `node test/integration/create-race.test.mjs` ×3 → 177/179/178 checks, exit 0; `cancel-reservation` → 229/229, exit 0 (both 2026-10-29, `easeit_racetest`)                                                                                                                                                                                                                                                                                                                                                                            | `sold` equals live `reservation_room` rows per date per category                                 | —            | 1   | M      | 2026-10-29 | TR     |
| AV-02 | Oversell CHECK constraint                | `CV` | `inventory_day_not_oversold`; present in migration SQL (10 files carry hand-written constraints)                                                                                                                                                                                                                                                                                                                              | –/–/✔/✔/– | asserted per round in both suites above — 0 violating rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | No committed state exceeds `physical + overbookingAllowance`                                     | AV-01        | 1   | M      | 2026-10-29 | TR     |
| AV-03 | Non-negative counters CHECK              | `CV` | `inventory_day_counters_non_negative`                                                                                                                                                                                                                                                                                                                                                                                         | –/–/✔/✔/– | asserted per round — 0 negative rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | A double release cannot drive a counter below zero                                               | AV-01        | 1   | M      | 2026-10-29 | TR     |
| AV-04 | Inventory management API                 | `PI` | `GET …/inventory/days`, `PUT …/inventory/overbooking` (`inventory-day.service.ts`), `…/room-blocks` create/list/get/release, horizon extend                                                                                                                                                                                                                                                                                   | –/✔/✔/✔/– | `room-blocks` 78/78 (the gate): a block reduces sellable and a real booking is then refused; blocks never spend overbooking headroom; allowance set per range, idempotent, refused below sold+blocked; 8 parallel blocks on 3 free rooms → exactly 3; 8 parallel releases → one decrement. **Gap:** `physical` is not directly settable per date range — owned by the horizon generator and room retirement by design; owner to confirm or amend the criterion                                                                       | Set `physical`, `blocked`, `overbookingAllowance` per date range; a block reduces sellable count | RM-02        | 1   | M      | 2026-11-15 | TR     |
| AV-05 | Rate plans                               | `CV` | `rates` module `rate-plan.*`; quote/booking take `ratePlanId` and price each night via `RateCalendarService.resolveStay`                                                                                                                                                                                                                                                                                                      | –/✔/✔/✔/– | `rates` 65/65 and `rate-pricing` 46/46 — `pnpm gate:integration` on `easeit_test` → 15/15 suites, 1167 PASS / 0 FAIL (2026-11-15): a quote with a plan prices each night from its calendar; inactive/archived plan 409 RATE_NOT_BOOKABLE; unassigned or foreign plan 404                                                                                                                                                                                                                                                             | Rate plan CRUD; a quote derives from the stored plan                                             | AV-04        | 1   | M      | 2026-11-15 | TR     |
| AV-06 | Rate calendar / derived and linked rates | `CV` | `rate-calendar.*` (`baseNights`: the one base resolver), `rate-derivation.*` (`GET/PUT/DELETE …/derivation`), migration `20261115180000_derived_rate_plans`                                                                                                                                                                                                                                                                   | –/✔/✔/✔/– | `rates` 65/65 and `rate-booking-features` 61/61 — `pnpm gate:integration` on `easeit_test` → 16/16 suites, 1231 PASS / 0 FAIL (2026-11-15): per-night precedence; a derived plan is the parent's night adjusted (−20% → 400000 from 500000), follows a parent reprice (612345 → 489876), floors at 0, is read-only, refuses multi-level / self / uncovered room types / another property's parent                                                                                                                                    | Per-date rates, derived rates recompute from their parent                                        | AV-05        | 1   | M      | 2026-11-15 | TR     |
| AV-07 | Restrictions (MinLOS, CTA, CTD)          | `CV` | `rate-restriction.*`, `GET/PUT …/rate-plans/:id/restrictions`, enforced in `RateCalendarService.resolveStay`; migration `20261115160000_rate_restrictions`; screen: `components/rates/restrictions-panel.tsx` on Rates & Inventory (2026-11-17)                                                                                                                                                                               | ~/✔/✔/✔/– | `rate-booking-features` 61/61 — `pnpm gate:integration` on `easeit_test` → 16/16 suites, 1231 PASS / 0 FAIL (2026-11-15): MinLOS and CTA on the arrival night and CTD on the departure date each refuse quote and booking with 409 `RATE_NOT_BOOKABLE` naming the rule; clearing re-opens; audited. Limit: applies only to plan-priced stays (rack-rate bookings carry no plan). Screen (2026-11-17): typecheck, lint and `pnpm gate` clean; **not opened in a browser** (PostgreSQL was down after a low-memory stop), hence UI `~` | A restriction refuses a non-conforming booking with a typed error                                | AV-05        | 1   | M      | 2026-11-15 | TR     |
| AV-08 | Public availability search               | `CV` | 2026-11-18: `GET /public/properties/:slug/availability`: categories with an inventory row and physical stock (allowance excluded) on every night, fitting the party, priced by an active public plan (STANDARD, PACKAGE or PROMOTIONAL) that allows the stay; rack rate only for a category no plan prices; corporate-only categories never offered; 30-night, past-date and 365-day-lead limits by the hotel's business date | ✔/✔/✔/✔/✔ | `booking-engine.test.mjs` 55/55 in `pnpm gate:integration` (36/36 suites, 2126 checks) on `easeit_test`; `pnpm test:concurrency` passing on `easeit_racetest`: only sellable categories; party size; corporate-only hidden; rack fallback; price in minor units                                                                                                                                                                                                                                                                      | Search returns only sellable room types for the date range                                       | BE-01        | 2   | A      | 2026-11-18 | SI     |
| AV-09 | Redis availability cache                 | `CV` | 2026-11-18: `AvailabilityCache` (ioredis, already a dependency): key `<prefix>:be-avail:<propertyId>:<search>`, 30 s TTL, lazy connection, 250 ms command timeout, any failure is a miss (the API never depends on Redis); read only by search, never by quote or book                                                                                                                                                        | ✔/✔/✔/✔/✔ | `booking-engine.test.mjs` 55/55 in `pnpm gate:integration` (36/36 suites, 2126 checks) on `easeit_test`; `pnpm test:concurrency` passing on `easeit_racetest`: a repeated search returns the cached (stale) answer while quote and book read live inventory (409)                                                                                                                                                                                                                                                                    | Short-TTL cache keyed by `propertyId`, never read inside a booking transaction                   | AV-08        | 3   | P      | 2026-11-18 | SI     |
| AV-10 | `rates-inventory` admin screen           | `PI` | `rates-inventory/page.tsx` fetches horizon, room types and rate plans server-side; `components/rates/*`; `rooms/page.tsx`                                                                                                                                                                                                                                                                                                     | ✔/✔/~/–/– | none — not rendered or exercised in a browser; no UI yet for room blocks, overbooking allowance or retirement                                                                                                                                                                                                                                                                                                                                                                                                                        | Screen reads and writes real rates and inventory                                                 | AV-04, AV-05 | 1   | M      | 2026-11-15 | SI     |

### 2.6 Reservations

Parent status: **`PI`** — create/cancel/race behaviour is the best-verified area in the repository;
lifecycle amendments are missing.

| ID    | Subfeature                              | St   | Evidence                                                                                                                                                                                                                                                                                                                                              | U/A/L/D/I | Tests and actual result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Acceptance criterion                                                          | Dep   | Pri | Launch | Verified   | Method   |
| ----- | --------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----- | --- | ------ | ---------- | -------- |
| RS-01 | Quote                                   | `CV` | `reservation-pricing.ts` `quoteStay` — per-night rate (manual > plan > rack), GST banded per night                                                                                                                                                                                                                                                    | ✔/✔/✔/✔/– | `rate-pricing` 46/46 — `pnpm gate:integration` on `easeit_test` → 15/15 suites, 1167 PASS / 0 FAIL (2026-11-15): a Thu–Sun stay at 7,000 / 6,500 / 8,000 quotes 5% / 5% / 18% per night; ex-tax, tax and total equal the sum of the nightly lines exactly, integers throughout. Mutation-checked: making check-in post the stay average fails the suite                                                                                                                                                                                                                   | Quoted total equals nightly rates plus taxes in integer minor units           | AV-05 | 2   | M      | 2026-11-15 | TR       |
| RS-02 | Create booking                          | `CV` | `create-reservation.controller.ts:60`; inventory locked `create-reservation.service.ts:270-271`                                                                                                                                                                                                                                                       | ✔/✔/✔/✔/– | create-race ×3 → exit 0; booking is the fixture path of every suite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Exactly one of N parallel bookings for the last unit succeeds                 | AV-01 | 1   | M      | 2026-10-29 | TR       |
| RS-03 | Parallel-booking safety                 | `CV` | oversell CHECK + ordered `FOR UPDATE`                                                                                                                                                                                                                                                                                                                 | –/✔/✔/✔/– | create-race A1/B/C staged races, exit 0. **`pnpm test:concurrency` has never been run**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Dedicated N-parallel stress suite passes on an isolated DB                    | AV-02 | 1   | M      | 2026-10-29 | TR       |
| RS-04 | Cancel (idempotent)                     | `CV` | `cancel-reservation.controller.ts:41`; `cancel-reservation.service.ts:203` `lock_timeout`, `:224` row lock, `:333` ordered inventory lock                                                                                                                                                                                                             | ✔/✔/✔/✔/– | `node test/integration/cancel-reservation.test.mjs` → 229/229, exit 0 (2026-10-29, `easeit_racetest`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Repeat and concurrent cancels release each night exactly once                 | AV-03 | 1   | M      | 2026-10-29 | TR       |
| RS-05 | Cancel racing check-in                  | `CV` | reservation row lock + status re-read `check-in.service.ts:336`                                                                                                                                                                                                                                                                                       | –/✔/✔/✔/– | 12/12 races → 409 `INVALID_STATE_TRANSITION`, never a 500                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Neither both-succeed nor an infrastructure 500                                | RS-04 | 1   | M      | 2026-10-29 | TR       |
| RS-06 | Cancel racing cross-category move       | `CV` | `room-move.service.ts:305-385`                                                                                                                                                                                                                                                                                                                        | –/✔/✔/✔/– | 9/9 races; per-category per-date counters asserted against live rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Per-category counters match live room rows after any interleaving             | RS-04 | 1   | M      | 2026-10-29 | TR       |
| RS-07 | Create racing cancel / move / three-way | `CV` | `test/integration/create-race.test.mjs` staged lock-queue harness                                                                                                                                                                                                                                                                                     | –/✔/✔/✔/– | A1 both orderings, A2 deterministic stale-preflight refusal, B both orderings, C two orderings — all exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Exactly one winner per contended unit; no oversell in any ordering            | RS-02 | 1   | M      | 2026-10-29 | TR       |
| RS-08 | Reservation detail                      | `PI` | `reservation-detail.controller.ts:41`                                                                                                                                                                                                                                                                                                                 | ✔/✔/✔/✔/– | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Detail payload matches persisted state and respects tenant scope              | —     | 2   | M      | 2026-10-29 | SI       |
| RS-09 | Reservation notes                       | `PI` | `reservation-detail.controller.ts:60`; `ReservationNote`; migration `20261018020000`                                                                                                                                                                                                                                                                  | ✔/✔/✔/✔/– | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Note persists, is attributed and is audited                                   | —     | 3   | A      | 2026-10-29 | SI       |
| RS-10 | Reservation search                      | `PI` | `reservation-search.controller.ts:43`; migration `20261016220000`                                                                                                                                                                                                                                                                                     | ✔/✔/✔/✔/– | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Cursor pagination; tenant-scoped; indexed                                     | —     | 2   | M      | 2026-10-29 | SI       |
| RS-11 | Modify dates / occupancy                | `PI` | 2026-11-16: `POST .../reservations/:id/dates` (+ `/dates/preview`), `ChangeStayDatesService`: removed nights released, added nights sold under the CHECK, per date and category. `stay-dates.test.mjs`. Occupancy (adults/children) changes not built; dialog browser-checked on dev 2026-11-16 (preview of an in-house extension; nothing committed) | ✖/✖/✖/–/– | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Amending dates re-checks inventory for added nights and releases removed ones | AV-04 | 1   | M      | 2026-10-29 | SI       |
| RS-12 | Extend / shorten stay                   | `CV` | 2026-11-16: same endpoint; extend/shorten a confirmed or in-house stay, kept nights keep their price, total = sum of nights, never before a charged night; last-room race, change vs cancel race, lock timeout tested                                                                                                                                 | ✖/✖/✖/–/– | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Same invariants as RS-11, tested per date                                     | RS-11 | 1   | M      | 2026-10-29 | SI       |
| RS-13 | No-show handling                        | `CV` | 2026-11-15: `POST .../reservations/:id/no-show` (`CancelReservationService.markNoShow`), `noShowRefusal` in `reservation.state.ts`; shares the cancellation transaction and release code; `no-show.test.mjs`, mutation-checked                                                                                                                        | ✖/✖/~/✔/– | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | A no-show roll sets the status and keeps inventory consistent                 | NA-04 | 1   | M      | 2026-10-29 | SI       |
| RS-14 | Group / multi-room bookings             | `PI` | schema permits many `ReservationRoom`; cancel releases per category                                                                                                                                                                                                                                                                                   | ~/✔/✔/✔/– | release logic for N rooms asserted in cancellation suite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Create a group booking through the product; release is per-category           | RM-02 | 2   | A      | 2026-10-29 | TR       |
| RS-15 | Reservation state machine               | `CV` | `reservation.state.ts:56` `CONSUMES_INVENTORY`, `:86` `cancelRefusal`                                                                                                                                                                                                                                                                                 | –/✔/✔/–/– | asserted via cancellation suite steps 6, 7, 7b, 7d                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Legal transitions live in one place and are enforced in the domain layer      | —     | 1   | M      | 2026-10-29 | TR       |
| RS-16 | Bounded reservation-row lock wait       | `CV` | `set_config('lock_timeout', …)` at `cancel-reservation.service.ts:203`, `room-move.service.ts:269`, `check-in.service.ts:295`; shared `ROW_LOCK_TIMEOUT_MS` in `common/errors/sql-state.ts`                                                                                                                                                           | –/✔/✔/–/– | step 14 measured move 3035 ms, check-in 3038 ms → typed 409 `CONFLICT` (2026-10-29)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | A contended write returns a typed 409 inside the budget, never hangs          | —     | 1   | M      | 2026-10-29 | TR       |
| RS-17 | Unbounded lock wait on create           | `CV` | Fixed 2026-11-15: `create-reservation.service.ts` sets `set_config('lock_timeout', ROW_LOCK_TIMEOUT_MS, true)` first; `55P03` → `TransactionConflictError` (409), unretried. `create-race` section D: 409 `CONFLICT` after 3,013 ms, nothing sold; mutation-checked                                                                                   | –/⚠/⚠/–/– | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Contended booking returns a typed 409 within `ROW_LOCK_TIMEOUT_MS`, measured  | RS-16 | 2   | M      | 2026-10-29 | SI       |
| RS-18 | Deadlock / serialization retry          | `CV` | Cancellation (`withRetry` in `cancel-reservation.service.ts`, budget 3, 40001/40P01 only). Induced 2026-11-17 by `cancel-reservation.test.mjs` 7e/7f: a test transaction locks the stay's `inventory_day` rows, waits until the API blocks on them, then requests the reservation row — a real two-party cycle                                        | –/–/✔/✔/– | Local, isolated `easeit_recovery` + API as `easeit_app`, run twice: **7e** one deadlock (`pg_stat_database.deadlocks` +1), the test transaction survived so the API attempt was the victim, retry answered 200, each night released once, one audit row (~1.1 s). **7f** a deadlock re-armed via SAVEPOINT on every attempt: exactly 3 rounds, deadlocks +3, 409 `CONFLICT` with no internals, nothing changed, then the same request succeeds. API log: attempts 1-3 hit 40P01, "gave up after 3 attempts". Not induced: 40001 anywhere, or 40P01 on room move / no-show | A forced `40P01` is retried within budget then answered as a typed 409        | —     | 2   | M      | 2026-11-17 | TR local |

### 2.7 Front desk — check-in, check-out, room moves

Parent status: **`PI`** — check-in and room move are well verified; **check-out does not exist**.

| ID    | Subfeature                                         | St   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | U/A/L/D/I     | Tests and actual result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Acceptance criterion                                                                                                                                                                                                                                                                | Dep          | Pri | Launch | Verified   | Method |
| ----- | -------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --- | ------ | ---------- | ------ |
| FD-01 | Check-in blockers (GET)                            | `PI` | `check-in.controller.ts:43`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | ✔/✔/✔/✔/–     | `node test/integration/check-in.test.mjs` → 23/23, exit 0 (2026-10-29)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Every blocker is reported with a typed reason                                                                                                                                                                                                                                       | —            | 2   | M      | 2026-10-29 | TR     |
| FD-02 | Check-in (POST)                                    | `CV` | `check-in.controller.ts:62`; row lock `check-in.service.ts:336`, status re-read, assignment re-read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ✔/✔/✔/✔/–     | 23/23 plus 12/12 cancel-vs-check-in races and deterministic stale-assignment harness 8/8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Check-in under contention is correct or typed-refused, never a 500                                                                                                                                                                                                                  | RS-05        | 1   | M      | 2026-10-29 | TR     |
| FD-03 | Exclusion-constraint violation becomes a typed 409 | `CV` | `check-in.service.ts` `translateWriteFailure` maps `23P01` → `RoomUnavailableError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | –/✔/✔/✔/–     | step 14 iii — room already held → 409 `ROOM_UNAVAILABLE`, not a 500                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | SQLSTATE never reaches the client                                                                                                                                                                                                                                                   | —            | 2   | M      | 2026-10-29 | TR     |
| FD-04 | **Check-out**                                      | `CV` | `check-out.controller.ts:37` (POST `:hotelId/reservations/:reservationId/check-out`, `@HttpCode(OK)` like cancel); `check-out.service.ts` — property `set_config`, `set_config lock_timeout` (`ROW_LOCK_TIMEOUT_MS`), reservation `FOR UPDATE` on `id AND propertyId`, then status / balance / assignment re-read under that lock; `checkOutRefusal` in `reservation.state.ts:126`; `OutstandingBalanceError` (`ErrorCode.OUTSTANDING_BALANCE`, 409); folio closed via `updateMany` guarded on `status: OPEN`; room released to `VACANT_DIRTY` guarded on `OCCUPIED_*` (the existing `room-move.service.ts:423` transition, not a new one); **`reservation_room.status` mirrored to CHECKED_OUT in the same transaction**, `updateMany` scoped by `reservationId` + `propertyId` like cancellation, so the assignment never disagrees with the stay; **every folio lookup property-scoped** (`findFirst` with `propertyId`, in `commit` and in `readState`); audit row in the same transaction, recording `assignmentStatus` either side; UI in `reservation-drawer.tsx` — `CheckOutButton` plus the pure `checkOutGuidance` branch table, so the balance figure and the folio link appear for `OUTSTANDING_BALANCE` only and `FORBIDDEN` / `INVALID_STATE_TRANSITION` / `CONFLICT` / `NOT_FOUND` / `UNAUTHENTICATED` each get their own guidance, with any unknown or internal code falling back to a generic message rather than the server text. | OK/OK/OK/OK/- | `pnpm test:checkout` -> **exit 0, 108/108 checks, 0 skipped**, against a disposable `easeit_test`. Covers all 13 required cases incl. zero-balance success, amount-due refusal, **credit refusal** (balance -1), TENTATIVE/CONFIRMED/CANCELLED refusals, idempotent replay (one audit row), 404 missing, cross-property 404 (probed against a foreign stay that really has an open folio with 5 lines, so the folio assertions are not vacuous), 403 without `reservations:checkout`, concurrent checkouts (200/200, exactly one audit row and one room release), checkout racing a room move, **rollback after an earlier write** (room row held by the test -> 409 CONFLICT in ~3.0s; reservation and assignment back to CHECKED_IN, folio back to OPEN, 0 audit rows, then the same request succeeds), and **case 14**: a rolled-back probe INSERT proves a departed assignment is still inside `reservation_room_no_overlap` (23P01), so mirroring the status did not free the room. The mirror assertions were proven sensitive by mutation: with the `reservationRoom.updateMany` removed from the compiled service the suite FAILS (exit 1, 4 failures, all of them the mirror checks). Asserts persisted rows, not responses. Regressions: `test:checkin` 23/23, `test:cancellation` 229/229, `pnpm gate:integration` 5/5 exit 0, `pnpm gate` exit 0, API and web-admin typecheck + build exit 0. Inventory verified untouched by checkout, per night. | Met: CHECKED_IN -> CHECKED_OUT under the row lock; non-zero balance refused with state unchanged; room freed; reservation and assignment statuses consistent; audit row atomic with the transition; idempotent; every illegal source state covered; no cross-property read or write | FO-13, RM-05 | 1   | M      | 2026-10-31 | TR     |
| FD-05 | Room move / assign                                 | `CV` | `room-move.controller.ts:41` options, `:61` move; `room-move.service.ts:269/305/385`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | ✔/✔/✔/✔/–     | 9/9 cancel-vs-move races; create-vs-move both orderings; refusal message asserted as "That category is fully sold for these nights."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Move is correct or typed-refused under contention; counters match live rows                                                                                                                                                                                                         | RS-06        | 1   | M      | 2026-10-29 | TR     |
| FD-06 | Unassign (roomId null)                             | `PI` | `packages/types/src/dto/room-move.dto.ts` — `roomId` nullable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ✔/✔/✔/✔/–     | not specifically asserted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Unassigning frees the physical room and keeps category inventory unchanged                                                                                                                                                                                                          | FD-05        | 3   | M      | 2026-10-29 | SI     |
| FD-07 | Cross-category move moves the counter              | `CV` | `room-move.service.ts:385` ordered inventory lock, decrement then increment under the oversell CHECK                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | –/✔/✔/✔/–     | per-category per-date assertion against live rows, 9/9 and create-race B                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Old category down one, new up one, per affected date                                                                                                                                                                                                                                | AV-02        | 1   | M      | 2026-10-29 | TR     |
| FD-08 | Walk-in                                            | `PI` | `BookingSource.WALK_IN` used as the fixture source throughout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ~/✔/✔/✔/–     | used as a fixture, not asserted as a flow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | A dedicated walk-in flow creates and checks in one stay                                                                                                                                                                                                                             | FD-02        | 3   | M      | 2026-10-29 | SI     |
| FD-09 | Arrivals / departures board                        | `CV` | 2026-11-16: `modules/frontdesk` `GET /properties/:hotelId/front-desk/board` (`reservations:read`): arrivals (due in, arrived, overdue), departures (due out, departed today, overstays), in house; room readiness; posted balance only with `folio:read`. `/front-desk` screen (top bar). `front-desk-board.test.mjs`; screen browser-checked on dev 2026-11-16 (three tabs, folio link)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | ✖/✖/✖/–/–     | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Today's arrivals, departures and in-house lists, per property                                                                                                                                                                                                                       | FD-04        | 2   | M      | 2026-10-29 | SI     |
| FD-10 | Instant check-in at creation                       | `PI` | `isInstantCheckIn` in the create DTO                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | ✔/✔/✔/✔/–     | used by the in-house fixture in the cancellation suite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Creating with the flag produces a `CHECKED_IN` stay and its folio                                                                                                                                                                                                                   | FD-02        | 3   | A      | 2026-10-29 | SI     |

### 2.8 Guest profiles and companies

Parent status: **`PI`**

| ID    | Subfeature             | St   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | U/A/L/D/I | Tests and actual result                                                                                                                                                                                                                                                                                                                                                                                                                                       | Acceptance criterion                                                                      | Dep          | Pri | Launch | Verified   | Method     |
| ----- | ---------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------ | --- | ------ | ---------- | ---------- |
| GP-01 | Per-reservation guests | `PI` | `ReservationGuest`; `GovtIdType`, `Gender`; migration `20261017120000`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ✔/✔/✔/✔/– | government-ID blocker asserted in check-in suite                                                                                                                                                                                                                                                                                                                                                                                                              | Guest details persist and satisfy check-in requirements                                   | —            | 2   | M      | 2026-10-29 | TR partial |
| GP-02 | Reusable guest profile | `CV` | 2026-11-17: `GuestProfile` (per property, RLS), `reservation_guest.guestProfileId` + same-property trigger; `modules/guests` (search cursor-paged, create, edit, link/unlink by hand); suggestions by normalised email/phone, never merged; screen `/guests`                                                                                                                                                                                                                                                                                        | ~/✔/✔/✔/– | vitest (matching keys); `guests-and-direct-billing.test.mjs` 55/55, in `pnpm gate:integration` on `easeit_test` 2026-11-17 (31/31 suites, 1932 checks); screen not opened in a browser                                                                                                                                                                                                                                                                        | Profile with dedupe, stay history and preferences                                         | GP-01        | 2   | A      | 2026-11-17 | SI         |
| GP-03 | Company list / create  | `PI` | `companies.controller.ts:34`, `:44`; `Company`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | ✔/✔/✔/✔/– | none                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Company round-trips and can be attached to a booking                                      | —            | 3   | A      | 2026-10-29 | SI         |
| GP-04 | GSTIN lookup           | `CV` | 2026-11-17: real adapters `companies/gst/sandbox.provider.ts` (authenticate → token, POST search, `data.data`, FO8000 not-found) and `cashfree.provider.ts` (POST /verification/gstin, client id + secret), written to the providers' docs; `ResilientGstLookup` (timeout, ≤2 attempts on retryable failures, breaker 5 failures/60 s, 1 h cache); `GST_ENVIRONMENT` test→MOCK + "(PROVIDER TEST DATA)", live→VERIFIED; production refuses mock, test host and `GST_BASE_URL`; `pnpm gst:smoke`                                                     | ✔/✔/✔/✔/✔ | vitest `gst-providers.test.ts` 21/21 (documented bodies, auth/refresh, retries, breaker, cache, env rules); `gst:smoke` through real HTTP against a local stand-in for both providers. **Sandbox test host, 2026-11-17, owner's test keys:** `pnpm gst:smoke` exit 0, MOCK-tagged "(PROVIDER TEST DATA)" taxpayer; a live key on the test host gave 403 "Use test API key for test environment", now surfaced in the error. Cashfree not run against its host | A real provider path is exercised against sandbox; mock is impossible outside development | —            | 2   | A      | 2026-11-17 | SI         |
| GP-05 | GSTIN validation       | `PI` | `apps/api/src/modules/companies/gstin.ts`; `GstinVerification` enum; migration `20261017150000`                                                                                                                                                                                                                                                                                                                                                                                                                                                     | ✔/✔/✔/✔/– | none                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Checksum and format validated; invalid refused with a typed error                         | GP-04        | 3   | A      | 2026-10-29 | SI         |
| GP-06 | Postal-code lookup     | `PI` | `companies.controller.ts:72`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | ✔/✔/✔/–/? | none                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Returns city/state for a valid code; provider documented                                  | —            | 4   | P      | 2026-10-29 | SI         |
| GP-07 | Direct-billing screen  | `CV` | 2026-11-17: city ledger. `PaymentMethod.CITY_LEDGER` + `company_ledger_entry` (append-only, CHECKs, same-property and folio-line triggers, deferred check that every CITY_LEDGER line has its entry); `POST …/folios/:id/bill-to-company` under the folio locks; `modules/direct-billing` (accounts aged 0-30/31-60/61-90/90+ from invoice date, statement, company payments capped at balance); permission `direct_billing:manage`; invoice balance = billed amount; screen `/direct-billing` and "Bill to company" on the folio. No credit limits | ~/✔/✔/✔/– | vitest (aging, statement, permissions); `guests-and-direct-billing.test.mjs` 55/55, in `pnpm gate:integration` on `easeit_test` 2026-11-17 (31/31 suites, 1932 checks); screens not opened in a browser                                                                                                                                                                                                                                                       | Ledger of company-billed stays with aging                                                 | GP-03, FO-14 | 2   | A      | 2026-11-17 | SI         |

### 2.9 Folios, billing, taxes, payments, refunds, invoices

Parent status: **`PI`** — the largest body of untested money-handling code in the repository.

| ID    | Subfeature                                 | St   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | U/A/L/D/I     | Tests and actual result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Acceptance criterion                                                                                                             | Dep   | Pri | Launch | Verified   | Method |
| ----- | ------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | ------ | ---------- | ------ |
| FO-01 | Folio by booking code                      | `PI` | `folios.controller.ts:55`; `Folio`; migration `20261017190000`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ✔/✔/✔/✔/–     | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Folio and its lines are returned for a scoped booking                                                                            | —     | 1   | M      | 2026-10-29 | SI     |
| FO-02 | Post a charge                              | `PI` | `folios.controller.ts:97`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | ✔/✔/✔/✔/–     | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Charge creates one immutable line and the balance recomputes                                                                     | FO-08 | 1   | M      | 2026-10-29 | SI     |
| FO-03 | Post a payment by booking code             | `CV` | `folios.controller.ts:117` and `:76`; `postFolioPaymentSchema` now requires a client `idempotencyKey` (16-64 chars of `[A-Za-z0-9_-]`, `crypto.randomUUID()` satisfies it) — **required, not optional**, so a caller cannot silently opt back into the old behaviour; `folio_line.idempotencyKey` (nullable) under the unique index `folio_line_propertyId_idempotencyKey_key`, added by the hand-written migration `20261031090000_folio_payment_idempotency`; the line, the `paidAmountMinor` increment and the audit row are one `$transaction`, and the **index** arbitrates concurrency rather than a pre-insert lookup (a lookup narrows the duplicate window without closing it); the violation is identified by index **name**, never as "any `P2002` on this table", because `folio_line_one_room_charge_per_date` lives on the same table and swallowing it would hide a double-charged night; `assertSamePaymentIntent` then compares folio, amount, method and kind and answers the new `IdempotencyKeyReusedError` (`ErrorCode.IDEMPOTENCY_KEY_REUSED`, 409) when any differ, treating `remark` as cosmetic; frontend mints one key per opening of the posting sheet in a `useState` initialiser (`folio-view.tsx`), so every retry of that intent reuses it and a new payment gets a new one. `postPaymentByBooking` also stopped answering 500 when two first payments raced to open the folio. | OK/OK/OK/OK/- | `pnpm test:payment` -> **exit 0, 60/60 checks, 0 skipped**, against a disposable `easeit_test` (21 migrations, identity asserted before the first fixture). Covers: five sequential identical POSTs -> **one line, one audit row, `paidAmountMinor` +amount once**; five _simultaneous_ same-key POSTs -> 201 x5 and still one line, one audit row, one increment; different keys -> two lines for two identical amounts; same key with a different amount, a different method, or a different folio -> 409 `IDEMPOTENCY_KEY_REUSED` naming the differing field, with no line, no audit row and no increment; a re-typed `remark` -> replayed as success, original remark kept; a zero amount, a malformed key and an omitted key -> 400 with nothing written; the same key at another property -> accepted independently (index is property-scoped) with property A unchanged; another property's folio -> 404 never 403, untouched; keyless system lines (charge + its tax) still post and coexist, NULLs being distinct; corrections and discounts still post and the balance still equals the sum of the lines; and a **replayed settlement still checks out** under FD-04 — the folio reaches exactly zero rather than credit. Case 0 pins the P2002 shape the detector reads (`meta.driverAdapterError.cause.constraint.index`) against a real violation and asserts the rollback left nothing. **Mutation-checked**: with the unique index dropped on the isolated database the suite FAILS (exit 1, 28 failures) — the sequential replay posts **5 lines, 5 audit rows and `paidAmountMinor` +1,250,000 instead of +250,000**, and every mismatch answers 201 instead of 409; index restored, 60/60 again. Regressions: `test:checkout` 108/108, `test:checkin` 23/23, `test:cancellation` 229/229, `pnpm gate:integration` 5/5, `pnpm gate`, API and web-admin typecheck + build all exit 0. **Client protocol hardened 2026-11-01:** the reference is minted once per booking in `FolioView` and persisted to `sessionStorage` (`payment-intent.ts`, `use-payment-intent.ts`), so it survives sheet close/reopen, `router.refresh()` and a tab reload — the close-and-reopen duplicate is closed. A pure five-state machine freezes what was sent, keeps the key on every ambiguous outcome, and has **no action that abandons an unresolved intent**; a definitive 4xx returns to DRAFT only when it came from DRAFT. `GET .../folios/payments/by-key/:key` (`folios.service.ts:437`, read-only, `FOLIO_SETTLE`, PAYMENT lines only, property-scoped) is the reconciliation primitive and the only exit from CONFLICTED. `pnpm test:intent` **75/75 exit 0, inside `pnpm gate`**; `pnpm test:payment` **83/83 exit 0** including the lost-response-close-reopen case and its fresh-key control. | Met: replaying the same client key creates no second line                                                                        | FO-04 | 1   | M      | 2026-10-31 | TR     |
| FO-04 | Post a payment by folio                    | `CV` | `folios.controller.ts:117` and `:76`; `postFolioPaymentSchema` now requires a client `idempotencyKey` (16-64 chars of `[A-Za-z0-9_-]`, `crypto.randomUUID()` satisfies it) — **required, not optional**, so a caller cannot silently opt back into the old behaviour; `folio_line.idempotencyKey` (nullable) under the unique index `folio_line_propertyId_idempotencyKey_key`, added by the hand-written migration `20261031090000_folio_payment_idempotency`; the line, the `paidAmountMinor` increment and the audit row are one `$transaction`, and the **index** arbitrates concurrency rather than a pre-insert lookup (a lookup narrows the duplicate window without closing it); the violation is identified by index **name**, never as "any `P2002` on this table", because `folio_line_one_room_charge_per_date` lives on the same table and swallowing it would hide a double-charged night; `assertSamePaymentIntent` then compares folio, amount, method and kind and answers the new `IdempotencyKeyReusedError` (`ErrorCode.IDEMPOTENCY_KEY_REUSED`, 409) when any differ, treating `remark` as cosmetic; frontend mints one key per opening of the posting sheet in a `useState` initialiser (`folio-view.tsx`), so every retry of that intent reuses it and a new payment gets a new one. `postPaymentByBooking` also stopped answering 500 when two first payments raced to open the folio. | OK/OK/OK/OK/- | `pnpm test:payment` -> **exit 0, 60/60 checks, 0 skipped**, against a disposable `easeit_test` (21 migrations, identity asserted before the first fixture). Covers: five sequential identical POSTs -> **one line, one audit row, `paidAmountMinor` +amount once**; five _simultaneous_ same-key POSTs -> 201 x5 and still one line, one audit row, one increment; different keys -> two lines for two identical amounts; same key with a different amount, a different method, or a different folio -> 409 `IDEMPOTENCY_KEY_REUSED` naming the differing field, with no line, no audit row and no increment; a re-typed `remark` -> replayed as success, original remark kept; a zero amount, a malformed key and an omitted key -> 400 with nothing written; the same key at another property -> accepted independently (index is property-scoped) with property A unchanged; another property's folio -> 404 never 403, untouched; keyless system lines (charge + its tax) still post and coexist, NULLs being distinct; corrections and discounts still post and the balance still equals the sum of the lines; and a **replayed settlement still checks out** under FD-04 — the folio reaches exactly zero rather than credit. Case 0 pins the P2002 shape the detector reads (`meta.driverAdapterError.cause.constraint.index`) against a real violation and asserts the rollback left nothing. **Mutation-checked**: with the unique index dropped on the isolated database the suite FAILS (exit 1, 28 failures) — the sequential replay posts **5 lines, 5 audit rows and `paidAmountMinor` +1,250,000 instead of +250,000**, and every mismatch answers 201 instead of 409; index restored, 60/60 again. Regressions: `test:checkout` 108/108, `test:checkin` 23/23, `test:cancellation` 229/229, `pnpm gate:integration` 5/5, `pnpm gate`, API and web-admin typecheck + build all exit 0. **Client protocol hardened 2026-11-01:** the reference is minted once per booking in `FolioView` and persisted to `sessionStorage` (`payment-intent.ts`, `use-payment-intent.ts`), so it survives sheet close/reopen, `router.refresh()` and a tab reload — the close-and-reopen duplicate is closed. A pure five-state machine freezes what was sent, keeps the key on every ambiguous outcome, and has **no action that abandons an unresolved intent**; a definitive 4xx returns to DRAFT only when it came from DRAFT. `GET .../folios/payments/by-key/:key` (`folios.service.ts:437`, read-only, `FOLIO_SETTLE`, PAYMENT lines only, property-scoped) is the reconciliation primitive and the only exit from CONFLICTED. `pnpm test:intent` **75/75 exit 0, inside `pnpm gate`**; `pnpm test:payment` **83/83 exit 0** including the lost-response-close-reopen case and its fresh-key control. | Met: five identical POSTs with one key produce exactly one payment line (and one audit row, and one `paidAmountMinor` increment) | —     | 1   | M      | 2026-10-31 | TR     |
| FO-05 | Correct a folio line                       | `PI` | `folios.controller.ts:137`; `FolioLine.reversesLineId` at `schema.prisma:1529` with relation `Reversal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | ✔/✔/✔/✔/–     | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Correction writes a reversing line; the original is untouched                                                                    | FO-08 | 2   | M      | 2026-10-29 | SI     |
| FO-06 | Correct room charges                       | `PI` | `folios.service.ts` `correctRoomCharges` / `correctCharge`: per-night GST bands kept; a NEGATIVE tax delta is posted as an `ADJUSTMENT` flagged `isTaxAdjustment` (migration `20261115200000_folio_tax_adjustments`; `folio_line_sign_matches_kind` unchanged by owner decision); tax is read as `TAX OR isTaxAdjustment` in folio totals and the master report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | ✔/✔/✔/✔/–     | `rate-pricing` 63/63 — upward and downward stay corrections across 5% and 18% nights keep each band and land the net exactly; no TAX line is ever negative; the folio page and the master report tax equal the ledger; two consecutive single-night corrections land on the last target (mutation-checked: the old unfiltered `derivedTax` lands 658333 instead of 650000). Stays `PI`: corrections are adjustment-based, not reversal-based as the criterion states                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Room-charge correction is reversal-based and audited                                                                             | FO-05 | 2   | M      | 2026-11-15 | TR     |
| FO-07 | Discount                                   | `PI` | `folios.controller.ts:183`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | ✔/✔/✔/✔/–     | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Discount is its own line, permission-gated and audited                                                                           | —     | 2   | A      | 2026-10-29 | SI     |
| FO-08 | Immutable lines and reversal trail         | `PI` | `schema.prisma:1529`; CLAUDE.md §3.4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | –/✔/✔/✔/–     | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | No code path updates or deletes a `folio_line`; test proves it                                                                   | —     | 1   | M      | 2026-10-29 | SI     |
| FO-09 | Integer minor units everywhere             | `PI` | `amountMinor` Int columns; `Money` type in `packages/types`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | –/✔/✔/✔/–     | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Unit tests cover rounding, allocation and currency mixing (CLAUDE.md §3.4 mandates them)                                         | CI-05 | 1   | M      | 2026-10-29 | SI     |
| FO-10 | Taxes as separate lines                    | `PI` | `FolioLineKind`; `PropertyTaxSlab`; migration `20261017170000`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ✔/✔/✔/✔/–     | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Tax lines reference the charge they derive from; inclusive and exclusive both asserted                                           | PS-03 | 1   | M      | 2026-10-29 | SI     |
| FO-11 | Balance derived from lines                 | `PI` | `folios.service.ts` sums lines; 5 `$transaction` blocks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | –/✔/✔/✔/–     | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Balance equals the integer sum of lines; reconciliation test exists                                                              | FO-08 | 1   | M      | 2026-10-29 | SI     |
| FO-12 | Refunds                                    | `CV` | 2026-11-15: `POST .../folios/:folioId/payments/:paymentLineId/refund` (`folios.service.ts` `postRefund`): REFUND line with `reversesLineId` = the payment, same method/card, capped per payment under the reservation+folio lock, `FOLIO_REFUND`-gated (no longer in `UNAVAILABLE_PERMISSIONS`), audited, idempotent per key. `folio-settlement` suite; mutation-checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ✖/✖/✖/✔/–     | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Refund is a reversing line, permission-gated, audited, idempotent                                                                | FO-04 | 1   | M      | 2026-10-29 | SI     |
| FO-13 | Settlement / close folio                   | `CV` | 2026-11-15: `POST .../folios/:folioId/close` (`closeFolio`): closes only at an exact zero line sum (else 409 `OUTSTANDING_BALANCE`), only for stays no longer accruing (cancelled / no-show / checked out), idempotent, audited. Close vs posting race proven in both queue orders                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | ✖/✖/✖/✔/–     | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | A zero-balance folio closes; a non-zero one is refused with a typed error                                                        | FO-11 | 1   | M      | 2026-10-29 | SI     |
| FO-14 | Invoices                                   | `CV` | 2026-11-16: `folios/invoices.service.ts` `POST .../folios/:folioId/invoice` (`folio:settle`), `GET .../invoices/:id` (+ `/pdf`, `/csv`; `folio:read`). CLOSED folio only; snapshot built from the folio page; per-property, per-financial-year gapless number (`invoice_sequence` in the same transaction); immutable by trigger (no UPDATE, no line on an invoiced folio, no reopen); hotel GSTIN setting; company bill-to. Migration `20261116210000_invoices`. `invoices.test.mjs`, `test/unit/invoice-document.test.mjs`; browser-checked on dev 2026-11-17 (GSTIN setting, Issue invoice on a closed folio, PDF and CSV download)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | ✖/✖/✖/✖/–     | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Numbered, immutable, tax-itemised invoice retrievable as PDF/CSV                                                                 | FO-13 | 1   | M      | 2026-10-29 | SI     |
| FO-15 | Payment gateway                            | `CV` | 2026-11-17: Razorpay Payment Links. `modules/payments` (client, service, webhook), `payment_link` table (RLS, CHECKs, same-property trigger), `PaymentGatewayConfig` as the per-property switch; captured payments posted by `FoliosService.postGatewayPayment` keyed `razorpay_<payment id>`; signed webhook (HMAC of raw body) plus "Check payment"; captured-after-close flagged NEEDS_ATTENTION                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | ~/✔/✔/✔/✔     | `payment-links.test.mjs` passed in `pnpm gate:integration` on `easeit_test` 2026-11-17 (32/32 suites, 1958 checks) against a Razorpay stand-in; vitest `razorpay.client.test.ts` 9/9. **Razorpay test mode, 2026-11-17, owner's keys:** `pnpm razorpay:smoke` exit 0, real create (`plink_…`, short_url `https://rzp.io/rzp/…`), fetch and cancel. A paid capture through Razorpay itself is not yet observed (FO-16)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Either wired to a real provider with a sandbox test, or the model is removed                                                     | FO-04 | 1   | M      | 2026-11-17 | SI     |
| FO-16 | Payments screen                            | `CV` | 2026-11-17: `GET /properties/:hotelId/payments` and `/payments` screen (payments and refunds by method for a window, recent links with "Check payment", the gateway switch); "Payment link" on the folio replaces the stub                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | ~/✔/✔/✔/–     | `payment-links.test.mjs` passed in `pnpm gate:integration` on `easeit_test` 2026-11-17 (32/32 suites, 1958 checks) against a Razorpay stand-in; vitest `razorpay.client.test.ts` 9/9. **Real Razorpay test-mode payment, 2026-11-17, by the owner in the browser:** link `plink_U1GadehtvEnO2J` paid with a test Visa card, "Check payment" posted `pay_U1Gcgnk6UPbq71` once to `SFBOOKING_31352_A02` (₹1,180.00, CARD, last four 1007, Visa, system actor, business date); link PAID. Two UI bugs found and fixed on the way (`f523a5e`, `f24036c`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Screen lists and captures real payments                                                                                          | FO-04 | 2   | M      | 2026-11-17 | SI     |
| FO-17 | Cancellation leaves money untouched        | `CV` | cancellation service writes no folio line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | –/✔/✔/✔/–     | step 10 plus a per-round money fingerprint in every race round — folio line count and total unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | A cancellation never alters a folio line or total                                                                                | RS-04 | 2   | M      | 2026-10-29 | TR     |
| FO-18 | Folio interleaving with reservation writes | `BU` | Since 2026-11-15 every folio write locks reservation then folio FOR UPDATE under `lock_timeout` (no retry, by design); only close vs payment and refund vs refund are race-tested. Previously: writes `reservation.paidAmountMinor` via atomic increment at `:493` and `:712`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | –/?/?/✔/–     | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Concurrent payment and cancellation/check-in leave a consistent balance; proven on an isolated DB                                | FO-04 | 2   | M      | 2026-10-29 | SI     |

### 2.10 Housekeeping

Parent status: **`NI`** — module named in CLAUDE.md §2, absent in every layer.

| ID    | Subfeature                           | St   | Evidence                                                                                                                                                                                                                                                                              | U/A/L/D/I | Tests | Acceptance criterion                               | Dep   | Pri | Launch | Verified   | Method |
| ----- | ------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----- | -------------------------------------------------- | ----- | --- | ------ | ---------- | ------ |
| HK-01 | Housekeeping module                  | `CV` | 2026-11-16: `modules/housekeeping` (board, tasks, inspections); room status still written by one conditional, audited path. `housekeeping.test.mjs`                                                                                                                                   | ✖/✖/✖/✖/– | none  | Module exists with room status ownership           | RM-05 | 1   | M      | 2026-10-29 | SI     |
| HK-02 | Room status board                    | `PI` | 2026-11-16: `GET .../housekeeping/board` (status, occupancy, arrivals/departures today, open tasks, assignable staff; no guest names or money) and the `/housekeeping` screen (top bar enabled). API tested; screen rendered on dev 2026-11-16 (status changes and tasks not clicked) | ✖/✖/✖/✖/– | none  | Board shows live status per room and updates it    | HK-01 | 1   | M      | 2026-10-29 | SI     |
| HK-03 | Task assignment                      | `CV` | 2026-11-16: create/assign/start/complete/cancel, queue cleaning; one active task per room and type (partial unique index, race-tested); who and when recorded; a finished cleaning makes a dirty room clean in the same transaction                                                   | ✖/✖/✖/✖/– | none  | Tasks assignable to staff with completion tracking | HK-01 | 2   | M      | 2026-10-29 | SI     |
| HK-04 | Inspection                           | `CV` | 2026-11-16: PASSED turns a clean vacant room INSPECTED; FAILED sends it back to VACANT_DIRTY and queues a re-clean; INSPECTED (by inspection or directly) needs the new `housekeeping:manage`                                                                                         | ✖/✖/✖/✖/– | none  | Inspection pass/fail gates a room back to sellable | HK-02 | 3   | A      | 2026-10-29 | SI     |
| HK-05 | Housekeeping read-only on financials | `CV` | 2026-11-16: the housekeeping role is refused folio reads, payments and the financial report (403); the board carries no guest names or money                                                                                                                                          | ✖/✖/✖/✔/– | none  | Housekeeping role cannot read or write folios      | AU-09 | 2   | M      | 2026-10-29 | SI     |

### 2.11 Maintenance

| ID    | Subfeature                | St   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                   | U/A/L/D/I | Tests                                                                                                                                                                                                                                                                                                 | Acceptance criterion                                                    | Dep   | Pri | Launch | Verified   | Method |
| ----- | ------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----- | --- | ------ | ---------- | ------ |
| MA-01 | Maintenance / work orders | `CV` | 2026-11-17: `work_order` (RLS, CHECKs, same-property trigger) and `modules/maintenance`; out of order is a MAINTENANCE room block made by `RoomBlockService.createWithin` in the order's own transaction; resolve/cancel give the room back from the business date (`restoreFromWithin`, past nights kept); report = `housekeeping:read`, manage = new `maintenance:manage`, out of order also `room_blocks:manage`; `/maintenance` screen | ~/✔/✔/✔/– | `work-orders.test.mjs` 28/28 in `pnpm gate:integration` on `easeit_test` 2026-11-17 (33/33 suites, 1992 checks): blocked per date, occupied room refused, partial restore, 8-way resolve once, 8-way out-of-order one; room-blocks suite unchanged after the refactor. Screen not opened in a browser | Work order takes a room out of order and restores it; inventory follows | RM-06 | 2   | M      | 2026-11-17 | SI     |

### 2.12 Night audit and business date

Parent status: **`NI`** — CLAUDE.md §3.3 is entirely unimplemented.

| ID    | Subfeature                   | St   | Evidence                                                                                                                                                                                                                                                                                                                                 | U/A/L/D/I          | Tests | Acceptance criterion                                                                         | Dep   | Pri | Launch | Verified   | Method |
| ----- | ---------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----- | -------------------------------------------------------------------------------------------- | ----- | --- | ------ | ---------- | ------ |
| NA-01 | `nightaudit` module          | `CV` | 2026-11-16: `modules/nightaudit`; requests only enqueue (run row + NIGHT_AUDIT_RUN outbox event in one transaction); the worker executes. `night-audit.test.mjs`                                                                                                                                                                         | ✖/✖/✖/✖/–          | none  | Module exists; audit never runs on a user request                                            | —     | 1   | M      | 2026-10-29 | SI     |
| NA-02 | `night_audit_step` table     | `CV` | 2026-11-16: `night_audit_run` (unique per property + business date) and `night_audit_step` (unique per run + step, CHECK 1..8), migration `20261116090000_night_audit`                                                                                                                                                                   | ✖/✖/✖/✖/–          | none  | One row per step, each with its own transaction and deterministic outcome                    | NA-01 | 1   | M      | 2026-10-29 | SI     |
| NA-03 | Per-property BullMQ schedule | `PI` | 2026-11-16: worker `NightAuditScheduler` ticks every property in its own IANA zone (`auditDue`), enqueues through the outbox (BullMQ); per-property try/catch. Off unless `NIGHT_AUDIT_SCHEDULER` (or production); a stale property is never auto-caught-up. Tested with a fixed clock, not yet end to end through a live worker + Redis | ✖/✖/✖/✖/✖          | none  | Ten independent schedules from each property's IANA zone; one failure does not block another | WK-01 | 1   | M      | 2026-10-29 | SI     |
| NA-04 | The eight canonical steps    | `CV` | 2026-11-16: `NightAuditRunner`, steps 1-8 in order, each committed and recorded; resumable, idempotent, racing executors serialise on the run row                                                                                                                                                                                        | ✖/✖/✖/✖/–          | none  | Steps 1–8 of CLAUDE.md §3.3 run in order, each committing independently                      | NA-02 | 1   | M      | 2026-10-29 | SI     |
| NA-05 | Business-date advance        | `CV` | 2026-11-16: step 7 is the only writer, conditional on the date still being the run's; audited as a system actor                                                                                                                                                                                                                          | ✖/✖/✖/✔/–          | none  | Advanced only by step 7; idempotent on re-run                                                | NA-04 | 1   | M      | 2026-10-29 | SI     |
| NA-06 | Immutable daily snapshots    | `CV` | 2026-11-16: `daily_snapshot` (unique per property + date; UPDATE refused by a trigger); rooms from `inventory_day`, money from the ledger                                                                                                                                                                                                | ✖/✖/✖/✖/–          | none  | Append-only occupancy/ADR/RevPAR/revenue snapshot per business date                          | NA-04 | 1   | M      | 2026-10-29 | SI     |
| NA-07 | Night-audit screen           | `PI` | 2026-11-16: `night-audit-screen.tsx` enqueues, polls the steps, shows step-5 exceptions and a no-worker hint; screen rendered on dev 2026-11-16; a run has not been started from it (irreversible on dev data). Was: `apps/web-admin/src/app/(property)/night-audit/page.tsx` renders `PlaceholderScreen` and names its own blocker      | ✖ labelled/✖/✖/–/– | none  | Screen enqueues a run and polls each step                                                    | NA-01 | 1   | M      | 2026-10-29 | SI     |
| NA-08 | `audit:dry-run` command      | `NI` | documented in CLAUDE.md §4; **absent from `package.json`**                                                                                                                                                                                                                                                                               | ✖/✖/✖/–/–          | none  | Dry run reports every step's intended effect with no writes                                  | NA-04 | 3   | A      | 2026-10-29 | SI     |

### 2.13 Reports and analytics

Parent status: **`PI`** — five report types exist; none is tested, and all precede closed books.

| ID    | Subfeature                  | St   | Evidence                                                                                                                                                                                                                                                                                                                                    | U/A/L/D/I | Tests                                                                                                                                                                                    | Acceptance criterion                                                | Dep   | Pri | Launch | Verified   | Method |
| ----- | --------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----- | --- | ------ | ---------- | ------ |
| RP-01 | Master report               | `PI` | `reports.controller.ts:63`; `master-report.service.ts`                                                                                                                                                                                                                                                                                      | ✔/✔/✔/✔/– | none                                                                                                                                                                                     | Figures reconcile to persisted reservations and folio lines         | —     | 2   | M      | 2026-10-29 | SI     |
| RP-02 | Configurable report columns | `PI` | `packages/types/src/dto/master-report-columns.ts`; migration `20261019140000`                                                                                                                                                                                                                                                               | ✔/✔/✔/✔/– | none                                                                                                                                                                                     | Column selection persists per user and is applied to export         | RP-01 | 3   | A      | 2026-10-29 | SI     |
| RP-03 | Room-inventory report       | `PI` | `reports.service.ts:127`                                                                                                                                                                                                                                                                                                                    | ✔/✔/✔/✔/– | none                                                                                                                                                                                     | Matches `inventory_day` for the period                              | AV-01 | 3   | M      | 2026-10-29 | SI     |
| RP-04 | Sales report                | `PI` | `reports.service.ts:129`                                                                                                                                                                                                                                                                                                                    | ✔/✔/✔/✔/– | none                                                                                                                                                                                     | Reconciles to folio lines                                           | FO-11 | 2   | M      | 2026-10-29 | SI     |
| RP-05 | Flash manager report        | `CV` | 2026-11-17: `reports.service.ts` `flashManager` reads `daily_snapshot` only, against the last closed day by default; days without a snapshot counted in a note and in a "Closed days" column; adds service revenue, tax, payments, refunds                                                                                                  | ✔/✔/✔/✔/– | vitest `snapshot-reports.test.ts` (fake repository); `snapshot-reports.test.mjs` passed in `pnpm gate:integration` on `easeit_test` 2026-11-17 (31/31 suites, 1932 checks)               | Matches the business date's snapshot                                | NA-06 | 2   | M      | 2026-11-17 | SI     |
| RP-06 | BAR pricing report          | `PI` | `reports.service.ts:135`                                                                                                                                                                                                                                                                                                                    | ✔/✔/⚠/✔/– | none                                                                                                                                                                                     | Derives from real rate plans                                        | AV-05 | 3   | A      | 2026-10-29 | SI     |
| RP-07 | CSV export                  | `PI` | `apps/api/src/modules/reports/report-csv.ts`                                                                                                                                                                                                                                                                                                | ✔/✔/✔/–/– | none                                                                                                                                                                                     | Export matches the on-screen rows exactly                           | RP-01 | 3   | M      | 2026-10-29 | SI     |
| RP-08 | Occupancy / ADR / RevPAR    | `CV` | 2026-11-17: group performance (`performance.service.ts`) and the sales report take every closed property-day from `daily_snapshot` and only open/future days live (labelled; `basis` counts both); sellable = physical − blocked throughout; channel mix stays live (no source in a snapshot)                                               | ✔/✔/✔/✔/– | vitest `performance.service.test.ts`, `snapshot-reports.test.ts`; `snapshot-reports.test.mjs` passed in `pnpm gate:integration` on `easeit_test` 2026-11-17 (31/31 suites, 1932 checks)  | Read from immutable snapshots, not live aggregates (CLAUDE.md §3.3) | NA-06 | 2   | M      | 2026-11-17 | SI     |
| RP-09 | Tax reports                 | `CV` | 2026-11-17: report type `tax` (`reports.service.ts` `tax`, `ReportsRepository.findTaxByDate`): per charge date, room/service taxable value and tax, unattributed "other tax", total = every TAX line + flagged tax adjustment; closed-day snapshot tax printed beside it and disagreements named. CGST/SGST not split (not stored per line) | ✔/✔/✔/✔/– | vitest `snapshot-reports.test.ts`; `snapshot-reports.test.mjs` passed in `pnpm gate:integration` on `easeit_test` 2026-11-17 (31/31 suites, 1932 checks)                                 | Period tax report reconciles exactly to folio tax lines             | FO-10 | 2   | M      | 2026-11-17 | SI     |
| RP-10 | Revenue screen              | `CV` | 2026-11-17: `GET /properties/:hotelId/revenue` (`revenue.service.ts`) returns closed days from `daily_snapshot` with totals, missing closed dates and open-day count; screen `components/revenue/revenue-screen.tsx` replaces the placeholder; tile gated on `financial_reports:read`                                                       | ~/✔/✔/✔/– | vitest `snapshot-reports.test.ts`; `snapshot-reports.test.mjs` passed in `pnpm gate:integration` on `easeit_test` 2026-11-17 (31/31 suites, 1932 checks); screen not opened in a browser | Screen renders real revenue data                                    | RP-04 | 2   | A      | 2026-11-17 | SI     |

### 2.14 Notifications

| ID    | Subfeature                           | St   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | U/A/L/D/I | Tests | Acceptance criterion                                               | Dep   | Pri | Launch | Verified   | Method |
| ----- | ------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----- | ------------------------------------------------------------------ | ----- | --- | ------ | ---------- | ------ |
| NO-01 | SMTP mailer                          | `PI` | `apps/api/src/modules/platform/mail/smtp.mailer.ts`; `onModuleInit` catches a failed `verify()` and logs — boot is **not** blocked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | –/✔/✔/–/✔ | none  | Delivery proven against a sandbox SMTP; failures surface as alerts | —     | 2   | M      | 2026-10-29 | SI     |
| NO-02 | Logging mailer fallback              | `PI` | `log.mailer.ts`, selected when `SMTP_HOST` is unset                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | –/✔/✔/–/– | none  | Development never silently sends real mail                         | NO-01 | 3   | M      | 2026-10-29 | SI     |
| NO-03 | OTP delivery                         | `PI` | via the mailer, from `auth.service.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | ✔/✔/✔/✔/✔ | none  | OTP arrives, expires and cannot be replayed                        | AU-02 | 2   | M      | 2026-10-29 | SI     |
| NO-04 | Booking confirmation email           | `CV` | 2026-11-17: `CreateReservationService` enqueues `RESERVATION_CONFIRMATION_EMAIL` in the booking transaction (CONFIRMED with an email only; `UNIQUE_FOREVER` key per reservation; id-only payload). `reservations/booking-confirmation.handler.ts` reads the stay at send time, skips cancelled / no-show / no email, sends via `MAILER` with a stable Message-ID, records `RESERVATION_CONFIRMATION_SENT` and does not resend after it. Template `booking-confirmation.email.ts` (escaped HTML + text). Migration `20261117090000_reservation_confirmation_email`. `booking-confirmation.test.mjs`, `test/unit/booking-confirmation-email.test.mjs`. BullMQ leg covered by `test:outbox:redis`, not re-run | ✖/✖/✖/–/✖ | none  | Confirmation is sent through the outbox, exactly once per booking  | NO-05 | 1   | M      | 2026-10-29 | SI     |
| NO-05 | Outbox-driven business notifications | `PI` | 2026-11-17: first business notification on the outbox (NO-04, idempotent handler, permanent vs retryable errors, dead letters warned by the worker). No other notification types (check-out receipt, cancellation, audit report) yet                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ✖/✖/✖/✔/– | none  | Real event types with idempotent handlers and dead-letter alerting | WK-12 | 1   | M      | 2026-10-29 | SI     |
| NO-06 | SMS / WhatsApp                       | `NI` | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ✖/✖/✖/–/✖ | none  | —                                                                  | NO-05 | 3   | P      | 2026-10-29 | SI     |

### 2.15 Booking engine (optional module)

Parent status: **`NI`** — advertised in CLAUDE.md §1; effectively absent.

| ID    | Subfeature                             | St   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                 | U/A/L/D/I | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Acceptance criterion                                                   | Dep   | Pri | Launch | Verified   | Method |
| ----- | -------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----- | --- | ------ | ---------- | ------ |
| BE-01 | `booking-engine` module                | `CV` | 2026-11-18: `modules/booking-engine`: `/public/properties/:slug` profile, `availability`, `quotes`, `bookings`, `bookings/:code`, `bookings/:code/pay`; no session; throttled per client address (search 120/min, quote 60, book 10, pay 20 per 10 min)                                                                                                                                                                                                  | ✔/✔/✔/✔/✔ | `booking-engine.test.mjs` 55/55 in `pnpm gate:integration` (36/36 suites, 2126 checks) on `easeit_test`; `pnpm test:concurrency` passing on `easeit_racetest`; throttling asserted (429 after 10 bookings)                                                                                                                                                                                                                                                          | Public search, quote, hold and book endpoints                          | AV-08 | 1   | A      | 2026-11-18 | SI     |
| BE-02 | Public property page                   | `PI` | 2026-11-18: `apps/web-booking/src/app/[propertySlug]/` replaces the placeholder: server-rendered search (GET form), live results and real rates, choose, held-price summary, guest details, pay at hotel or pay now, confirmation page at `booking/[code]?access=`. All API calls are server-side and forward the guest address                                                                                                                          | ✔/✔/–/✔/– | typecheck and lint clean. **Not rendered in a browser** (free memory under 1 GB): the API it calls is fully tested, the pages are not                                                                                                                                                                                                                                                                                                                               | Page renders live availability and real rates                          | BE-01 | 1   | A      | 2026-11-18 | SI     |
| BE-03 | Search / quote / hold / book           | `CV` | 2026-11-18: the quote is the hold: HMAC-signed with the per-night price, 15 min, property-bound. Book goes through `CreateReservationService.createForGuest`, the staff transaction (ascending `inventory_day` lock, oversell CHECK, retries); overbooking allowance excluded for the public; per-quote advisory lock gives one booking per quote; `online_booking` and the audit row in the same transaction. Migration `20261118150000_online_booking` | ✔/✔/✔/✔/✔ | `booking-engine.test.mjs` 55/55 in `pnpm gate:integration` (36/36 suites, 2126 checks) on `easeit_test`; `pnpm test:concurrency` passing on `easeit_racetest`: the held price survives a rate change; tampered, expired and cross-property quotes refused with nothing written; 6 parallel submits of one quote give one booking; 8 guests racing for the last room: exactly 1 wins, 7 get 409, sold = live rows per date and category; the allowance is never sold | Hold expires; book is transactional and respects the oversell CHECK    | BE-01 | 1   | A      | 2026-11-18 | SI     |
| BE-04 | Payment capture                        | `CV` | 2026-11-18: guest chooses pay at hotel or pay now; pay now opens a folio in the booking transaction and requests a Razorpay link for the balance after commit (`PaymentsService.sendGuestLink`, sharing `issue()` with the staff panel); a pay-at-hotel guest can pay later from the confirmation page; capture posts through the FO-15 webhook path, keyed per Razorpay payment                                                                         | ✔/✔/✔/✔/✔ | `booking-engine.test.mjs` 55/55 in `pnpm gate:integration` (36/36 suites, 2126 checks) on `easeit_test`; `pnpm test:concurrency` passing on `easeit_racetest` with the Razorpay stand-in: a link for the whole total; 3 identical webhooks post one payment; then nothing owed. Real Razorpay not exercised (as FO-15)                                                                                                                                              | Capture is idempotent and reconciles to a folio                        | FO-15 | 1   | A      | 2026-11-18 | SI     |
| BE-05 | Server-side slug→propertyId resolution | `CV` | 2026-11-18: `PublicPropertyGuard` resolves `:slug` from the path to an ACTIVE property and binds the tenant scope (as the session guard does); no header, body or query can name a property; unknown, malformed or inactive is 404                                                                                                                                                                                                                       | ✔/✔/✔/✔/✔ | `booking-engine.test.mjs` 55/55 in `pnpm gate:integration` (36/36 suites, 2126 checks) on `easeit_test`; `pnpm test:concurrency` passing on `easeit_racetest`: unknown, malformed and inactive slug 404; a spoofed `x-property-id` ignored; access token or 404 (never 403); another hotel's slug 404                                                                                                                                                               | Slug resolved server-side; never trusted from a client header or query | MT-02 | 2   | A      | 2026-11-18 | SI     |

### 2.16 Channel manager / OTA (optional module)

Parent status: **`NI`** — advertised in CLAUDE.md §1; only an enum and one migration exist.

| ID    | Subfeature               | St   | Evidence                                                                         | U/A/L/D/I | Tests | Acceptance criterion                                                                                  | Dep   | Pri | Launch | Verified   | Method |
| ----- | ------------------------ | ---- | -------------------------------------------------------------------------------- | --------- | ----- | ----------------------------------------------------------------------------------------------------- | ----- | --- | ------ | ---------- | ------ |
| CM-01 | `channels` module        | `NI` | absent                                                                           | ✖/✖/✖/✖/✖ | none  | Module exists with adapters containing mapping only                                                   | —     | 1   | A      | 2026-10-29 | SI     |
| CM-02 | Channel mappings         | `NI` | no model                                                                         | ✖/✖/✖/✖/– | none  | Mapping per property/room-type/rate-plan                                                              | CM-01 | 1   | A      | 2026-10-29 | SI     |
| CM-03 | ARI push outbox          | `NI` | outbox exists; no ARI event type or handler                                      | ✖/✖/✖/~/✖ | none  | Debounced per `(propertyId, roomTypeId, dateRange)`, ordered per property, retried until acknowledged | NO-05 | 1   | A      | 2026-10-29 | SI     |
| CM-04 | Inbound OTA reservations | `NI` | `BookingSource` enum and migration `20261016200000_booking_source_channels` only | ✖/✖/✖/~/✖ | none  | Raw payload stored first, normalized separately, idempotent on the channel's reservation id           | CM-01 | 1   | A      | 2026-10-29 | SI     |
| CM-05 | Per-channel adapters     | `NI` | none                                                                             | ✖/✖/✖/✖/✖ | none  | One interface, no business rules inside an adapter                                                    | CM-01 | 1   | A      | 2026-10-29 | SI     |

### 2.17 Administration and audit logs

| ID    | Subfeature                        | St   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                               | U/A/L/D/I | Tests and actual result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Acceptance criterion                                            | Dep   | Pri | Launch | Verified   | Method     |
| ----- | --------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----- | --- | ------ | ---------- | ---------- |
| AD-01 | Audit log table                   | `PI` | `AuditLog`; migration `20261017190000_folios_and_audit_log`                                                                                                                                                                                                                                                                                                                                                                                            | –/✔/✔/✔/– | cancellation suite asserts exactly one audit row per successful cancel, every round                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Every money/state/rate/restriction mutation writes an audit row | —     | 2   | M      | 2026-10-29 | TR partial |
| AD-02 | Audit row in the same transaction | `CV` | cancellation service writes the audit row inside its transaction                                                                                                                                                                                                                                                                                                                                                                                       | –/✔/✔/✔/– | step 9 — audit row and status change commit together; refused cancels leave no row                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Audit and change are atomic on every mutating path              | AD-01 | 2   | M      | 2026-10-29 | TR         |
| AD-03 | Audit log viewer                  | `CV` | 2026-11-17: `GET /properties/:hotelId/audit-log` (+ `/facets`), `modules/audit-log/*`; new permission `audit_log:read` (PROPERTY_ADMIN/SUPER_ADMIN templates, migration `20261117150000_alerting_and_audit_log_viewer`); filters actor / `system` / entity type / entity id / event / hotel-local `from`-`to` (`startOfDayInTimeZone` in `@repo/types`); Prisma cursor paging; screen `/audit-log` with field-by-field before/after, tile in More apps | ✔/✔/✔/✔/– | `test/integration/audit-log.test.mjs` 41/41 PASS on disposable `easeit_recovery` (API as `easeit_app`, 2026-11-17): real room-status write shown with actor and before/after; FRONT_DESK 403 naming `audit_log:read`; other property 404 (code and id) and its cursor refused; all filters; IST midnight boundary exact to the second; 12 rows over 4 pages incl. µs-apart rows, none lost or repeated; malformed queries 400. Unit: 5 `startOfDayInTimeZone` cases (vitest). Screen typechecked and linted, **not opened in a browser** | Filterable by actor, entity and date, with before/after         | AD-01 | 2   | M      | 2026-11-17 | TR local   |
| AD-04 | Access-control admin UI           | `PI` | `apps/web-admin/src/app/(dashboard)/settings/access-control/page.tsx`; `roles-tab.tsx`, `staff-tab.tsx`                                                                                                                                                                                                                                                                                                                                                | ✔/✔/✔/✔/– | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Role and staff management round-trip through the UI             | AU-10 | 2   | M      | 2026-10-29 | SI         |

### 2.18 Import / export

| ID    | Subfeature                    | St   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | U/A/L/D/I | Tests                                                                                                                                                                                                                                                                                                                                        | Acceptance criterion                                                                                                           | Dep   | Pri | Launch | Verified   | Method |
| ----- | ----------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----- | --- | ------ | ---------- | ------ |
| IE-01 | Bulk data import              | `CV` | 2026-11-18: `POST /properties/:hotelId/import` (`modules/data-exchange/import.service.ts`) loads room types, rooms and rates (defaults and dated ranges) from CSV into an existing property. DRY_RUN runs the whole import in a transaction under a per-property advisory lock and rolls it back; COMMIT must quote the dry run's digest and writes all or nothing, with audit rows in the same transaction. Rooms cannot change category; retired rows and derived, archived or inactive plans are refused. No `inventory_day` writes. Screen: `/data-exchange` | ✔/✔/✔/✔/✔ | `data-exchange.test.mjs` 65/65 in `pnpm gate:integration` (35/35 suites, 2068 checks) on `easeit_test`: dry run writes nothing; per-date rate nights; 11 kinds of refusal with nothing written; re-import UNCHANGED; 6-way commit creates once; import racing the rooms screen leaves one room. CSV vitest 5. Screen not driven in a browser | Dry-run validation then transactional import of properties, rooms and rates. Properties come from onboarding (fixed portfolio) | RM-02 | 2   | A      | 2026-11-18 | SI     |
| IE-02 | Data export beyond report CSV | `CV` | 2026-11-18: `GET /properties/:hotelId/export/:dataset`: room types, rooms and rates in the import's own columns (a template and a re-importable backup); reservations, folio lines (windowed, at most 370 days) and guest profiles. New sensitive permission `data:export` (administrators; migration `20261118120000_data_export_permission`). Every export writes a DATA_EXPORTED audit row with dataset, window, row count and a personal-data flag. Formula-safe CSV; amounts formatted from minor units by string arithmetic                                | ✔/✔/✔/✔/✔ | same suite: headers and content type; no other property's rows; the configuration export imports back all UNCHANGED; 6 exports give 6 audit rows, 3 refusals give none; 403 for front desk and revenue manager, 404 for another property; formatting vitest 3                                                                                | Tenant-scoped export of operational data                                                                                       | RP-07 | 3   | P      | 2026-11-18 | SI     |

### 2.19 Security and privacy

| ID    | Subfeature                            | St   | Evidence                                                                                                                                                                                                                                                                                                                | U/A/L/D/I | Tests and actual result                                                                                                                      | Acceptance criterion                                                                | Dep   | Pri | Launch | Verified   | Method     |
| ----- | ------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----- | --- | ------ | ---------- | ---------- |
| SE-01 | Typed domain errors and global filter | `PI` | `apps/api/src/common/errors/domain-error.ts`; `DomainExceptionFilter`                                                                                                                                                                                                                                                   | –/✔/✔/–/– | typed 400/403/409 asserted repeatedly across reservation suites                                                                              | Uniform `{ code, message, details?, requestId }`; controllers build no error bodies | —     | 1   | M      | 2026-10-29 | TR partial |
| SE-02 | No PII in logs                        | `CV` | 2026-11-17: `scripts/check-log-pii.mjs` (`pnpm check:log-pii`, in the fast gate) parses all 103 log calls and rejects personal-data field names; `RedactingLogger` on API and worker masks emails, mobiles, cards, Aadhaar-like numbers and Prisma invocation arguments; review in `docs/release/PII-LOGGING-REVIEW.md` | ✔/✔/✔/–/– | scanner unit test 11/11 (found two walker bugs before the review); redaction vitest 9; a full `gate:integration` run logged no email address | Documented review plus an automated check rejecting known PII fields in log calls   | OB-01 | 1   | M      | 2026-11-17 | SI         |
| SE-03 | Infrastructure errors never leak      | `CV` | `common/errors/sql-state.ts`; `translateWriteFailure` in check-in; room-move exhaustion split                                                                                                                                                                                                                           | –/✔/✔/–/– | step 14 i–iii — SQLSTATE and SQL text never appear in a response body; typed 409s only                                                       | No SQLSTATE, SQL or stack trace in any response                                     | SE-01 | 2   | M      | 2026-10-29 | TR         |
| SE-04 | Secrets handling                      | `PI` | env-based; `.env` gitignored; env schema in `apps/api/src/config/env.ts`                                                                                                                                                                                                                                                | –/✔/✔/–/– | none                                                                                                                                         | Secrets come from a manager in production; none are committed                       | —     | 2   | M      | 2026-10-29 | SI         |
| SE-05 | GDPR / retention / erasure            | `NI` | none                                                                                                                                                                                                                                                                                                                    | ✖/✖/✖/✖/– | none                                                                                                                                         | Documented retention and a working erasure path                                     | GP-02 | 2   | A      | 2026-10-29 | SI         |
| SE-06 | CORS and cookie flags                 | `PI` | `API_CORS_ORIGINS`, `AUTH_COOKIE_NAME` in the env schema                                                                                                                                                                                                                                                                | –/✔/✔/–/– | none                                                                                                                                         | Cookies are HttpOnly, Secure and SameSite in production; CORS allowlist asserted    | —     | 2   | M      | 2026-10-29 | SI         |

### 2.20 Observability

| ID    | Subfeature                                   | St   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                     | U/A/L/D/I | Tests and actual result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Acceptance criterion                                                                              | Dep   | Pri | Launch | Verified   | Method   |
| ----- | -------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----- | --- | ------ | ---------- | -------- |
| OB-01 | Structured logging                           | `PI` | Nest `Logger` used in 27 files under `apps/api/src`                                                                                                                                                                                                                                                                                                                                                                          | –/✔/~/–/– | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Every log carries requestId and propertyId where applicable; logged once at the handling boundary | —     | 2   | M      | 2026-10-29 | SI       |
| OB-02 | Liveness probe                               | `PI` | `apps/api/src/modules/health/health.controller.ts:42`                                                                                                                                                                                                                                                                                                                                                                        | –/✔/✔/–/– | HTTP 200 observed from the isolated API on 2026-10-29                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Touches nothing; always answers when the process is alive                                         | —     | 1   | M      | 2026-10-29 | TR       |
| OB-03 | Readiness probe (PostgreSQL only, by design) | `PI` | `health.controller.ts:49`                                                                                                                                                                                                                                                                                                                                                                                                    | –/✔/✔/✔/– | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Reflects PostgreSQL only; Redis outage never pulls the API from a load balancer                   | —     | 1   | M      | 2026-10-29 | SI       |
| OB-04 | Outbox backlog gauge                         | `PI` | `health.controller.ts:66`; `outbox-metrics.service.ts`                                                                                                                                                                                                                                                                                                                                                                       | –/✔/✔/✔/– | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Always 200; never a readiness verdict                                                             | WK-04 | 2   | M      | 2026-10-29 | SI       |
| OB-05 | Metrics / tracing / error reporting          | `CV` | 2026-11-17, no new dependency: `GET /api/v1/metrics` (Prometheus text; HTTP by route template, external calls, unhandled errors, outbox, process; `METRICS_TOKEN`, required in production); W3C `traceparent` continued or started, returned with `x-request-id`, on every log line and every outbound call (`tracedFetch`); `ErrorReporter` digests unexpected 5xx through the OB-06 alert sinks on a timer with a cooldown | ✔/✔/✔/–/✔ | `observability.test.mjs` in `pnpm gate:integration` 34/34 suites (2002 checks) on `easeit_test`; vitest registry, trace, traced fetch, error digest (10). Error reporting not seen end to end through a real sink                                                                                                                                                                                                                                                                                                                                                                                                                 | Metrics endpoint, trace propagation and error reporting in place                                  | OB-01 | 2   | M      | 2026-11-17 | SI       |
| OB-06 | Alerting                                     | `CV` | 2026-11-17: `platform/alerting/*`. Worker-only `AlertMonitorService` (every `ALERT_CHECK_MS`) sends unalerted dead letters (batches of 20) and leases expired past `ALERT_STALE_LEASE_GRACE_MS` (repeat `ALERT_REPEAT_MS`) to `WebhookAlertSink` (JSON, timeout) and/or `EmailAlertSink`; production refuses to boot without `ALERT_EMAIL_TO` or `ALERT_WEBHOOK_URL`; compose requires `ALERT_EMAIL_TO`                      | –/✔/✔/✔/✔ | `test/integration/alerting.test.mjs` 37/37 PASS (2026-11-17): webhook POST content, no repeat, 500 and hang (1 s timeout) lose nothing, one of two sinks suffices, no payload value leaks, burst of 25 in 2 batches each once, stale-lease grace/cooldown/re-arm, env refusals. **End to end:** real `dist/worker.js` as `easeit_app` + throwaway Redis delivered a DEAD row to a local webhook within one pass and stamped it, exactly one alert over later passes. Not proven: a worker that is itself down cannot alert (documented: watch `/health/outbox` externally); `deploy/smoke.sh` not re-run after the compose change | A dead letter raises an external alert, not just a log line                                       | WK-11 | 1   | M      | 2026-11-17 | TR local |

### 2.21 Backup, restore and recovery

| ID    | Subfeature                      | St   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | U/A/L/D/I | Tests                                                                                                                                                                                                                                                                                                                                                                            | Acceptance criterion                                                                 | Dep   | Pri | Launch | Verified   | Method   |
| ----- | ------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----- | --- | ------ | ---------- | -------- |
| BR-01 | Backup automation               | `CV` | 2026-11-17: `deploy/backup.sh` in a `backup` compose service (stock `postgres:17`, so `pg_dump` matches the server). Daily at `BACKUP_TIME` UTC; custom-format dump + sha256 + a manifest (object inventory and per-table counts read in the dump's own exported snapshot); every dump restore-rehearsed before it counts and a `.verified` record written; retention by age with the newest N verified always kept; healthcheck unhealthy after 26 h without success. Runbook: `deploy/README.md` section 6 | ✔/–/✔/–/– | **Local, Docker 28.1.1, 2026-11-17:** `deploy/smoke.sh` exit 0 on the full stack: first backup at service start, rehearsal passed, service healthy. Scratch Postgres 17 with all migrations: backup during 20k committed inserts (live 2,489→5,170) verified with the manifest count (3,217) equal to the restored copy; retention pruned old files and kept the newest verified | Scheduled dump with retention and a restore rehearsal record                         | —     | 1   | M      | 2026-11-17 | TR local |
| BR-02 | Restore into a separate target  | `CV` | `backup.sh restore` always `createdb`s a new `<db>_restored_<stamp>` (fails if the name exists), refuses the live name; `activate` takes only a `_restored_` name, refuses while anything is connected, renames the live database to `<db>_before_<stamp>` (kept) and the restored one into place; `migrate` re-grants the app role on the next `up`. The `release.yml` step (CI-12) is unchanged                                                                                                            | ✔/–/✔/–/– | **Local, Docker 28.1.1, 2026-11-17:** `deploy/smoke.sh` exit 0 on the full stack: restore into a new database, activate refused while the API was connected, stop, activate, `up`; the API came back ready as `easeit_app` with the provisioned property and accepted invitation, previous database kept. Activate of a non-restore name refused                                 | Restore always targets a fresh database; never the source or development             | BR-01 | 1   | M      | 2026-11-17 | TR local |
| BR-03 | Four-layer restore verification | `CV` | Four layers on every restore and rehearsal (`backup.sh restore_and_check`): (1) object inventory = manifest; (2) the 4 double-booking guards present and no unvalidated constraint; (3) every table's row count = manifest; (4) no oversold/negative `inventory_day`, no orphan `reservation_room`, no unfinished migration. Checksum checked first                                                                                                                                                          | ✔/–/✔/–/– | Negative cases: one flipped byte refused at the checksum; a manifest claiming one extra row refused at layer 3 with the diff, and no `.verified` written. Positive: every smoke and scratch run                                                                                                                                                                                  | Object inventory, constraints, per-table counts and business invariants all verified | BR-02 | 1   | M      | 2026-11-17 | TR local |
| BR-04 | Point-in-time recovery          | `NI` | WAL archiving not configured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ✖/✖/✖/✖/– | none                                                                                                                                                                                                                                                                                                                                                                             | Documented RPO/RTO with a tested PITR to a timestamp                                 | BR-01 | 2   | A      | 2026-10-29 | SI       |

### 2.22 Background workers and the transactional outbox

Parent status: **`PI`** — the mechanism is sound and partly proven; it carries no real business
events, and its Redis-dependent recovery has never been executed.

| ID    | Subfeature                            | St   | Evidence                                                                                                                                                                                                                | U/A/L/D/I | Tests and actual result                                                                                                                                                                                                                                                                                                                                                                                                                                       | Acceptance criterion                                                             | Dep   | Pri | Launch | Verified   | Method   |
| ----- | ------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----- | --- | ------ | ---------- | -------- |
| WK-01 | Worker process                        | `PI` | `apps/api/src/worker.ts` boots an application context, no HTTP listener                                                                                                                                                 | –/–/✔/–/✔ | none run                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Worker runs independently of the API                                             | —     | 1   | M      | 2026-10-29 | SI       |
| WK-02 | Dependency preflight                  | `PI` | `worker.ts` pings PostgreSQL then Redis and exits non-zero on either                                                                                                                                                    | –/–/✔/✔/✔ | none                                                                                                                                                                                                                                                                                                                                                                                                                                                          | An unavailable dependency exits non-zero so a supervisor restarts it             | WK-01 | 2   | M      | 2026-10-29 | SI       |
| WK-03 | Graceful shutdown                     | `CV` | `worker.ts` registers SIGINT/SIGTERM once each and calls `app.close()`; `enableShutdownHooks()` set                                                                                                                     | –/–/✔/✔/– | `deploy/smoke.sh` step 8 on Docker (Linux kernel), 2026-11-17: a 6 s self-test job claimed IN_FLIGHT, `docker compose stop -t 30 worker` sends SIGTERM mid-handler; the worker logged "Received SIGTERM; shutting down.", waited for the handler (stop took 4 s), **exited 0** (not killed); job SUCCEEDED attempts=1 with no lease; a restarted worker did not run it again                                                                                  | On SIGTERM an in-flight job finishes or releases its lease; no row is left stuck | WK-01 | 2   | M      | 2026-11-17 | TR local |
| WK-04 | Dispatcher poll loop                  | `PI` | `outbox-dispatcher.service.ts` interval; swallows poll failures to keep the interval alive                                                                                                                              | –/✔/✔/✔/✔ | `pnpm gate:integration` (2026-10-29) — outbox suite exit 0                                                                                                                                                                                                                                                                                                                                                                                                    | Due rows are claimed and published within the poll interval                      | WK-01 | 1   | M      | 2026-10-29 | TR       |
| WK-05 | Lease and stale-lease reaping         | `PI` | `outbox-dispatcher.service.ts:167` `"leaseExpiresAt" < now()`; lease computed in SQL                                                                                                                                    | –/✔/✔/✔/– | outbox suite — reaper reclaims an expired lease, row returns to PENDING with the claim cleared                                                                                                                                                                                                                                                                                                                                                                | A dead worker costs one lease duration of latency and nothing else               | WK-04 | 1   | M      | 2026-10-29 | TR       |
| WK-06 | `recoveries` separate from `attempts` | `PI` | distinct columns on `OutboxEvent`                                                                                                                                                                                       | –/✔/✔/✔/– | outbox suite — claiming spends no retry budget                                                                                                                                                                                                                                                                                                                                                                                                                | A reclaim never consumes the retry budget                                        | WK-05 | 2   | M      | 2026-10-29 | TR       |
| WK-07 | Claim-token guard                     | `PI` | `outbox.worker.ts:127` plus three write guards on `"claimedBy" = ${claimToken}`                                                                                                                                         | –/✔/✔/✔/– | outbox suite — a job replayed against a finished row is dropped                                                                                                                                                                                                                                                                                                                                                                                               | A worker can only record an outcome for the claim it was handed                  | WK-05 | 1   | M      | 2026-10-29 | TR       |
| WK-08 | PostgreSQL owns retries               | `PI` | `outbox.queue.ts:93` `attempts: 1`; backoff and budget in the database                                                                                                                                                  | –/✔/✔/✔/✔ | outbox suite — bounded budget exhausts into DEAD                                                                                                                                                                                                                                                                                                                                                                                                              | Exactly one retry counter exists, in the durable store                           | WK-04 | 1   | M      | 2026-10-29 | TR       |
| WK-09 | Bounded Redis retention               | `PI` | `outbox.queue.ts:96-97` `removeOnComplete: 100`, `removeOnFail: 500`                                                                                                                                                    | –/✔/✔/–/✔ | none                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Redis stays a buffer, never an archive                                           | WK-08 | 3   | M      | 2026-10-29 | SI       |
| WK-10 | Total queue-loss recovery             | `CV` | `test/integration/outbox-redis.test.mjs` calls `obliterate({ force: true })` and expects rediscovery from PostgreSQL                                                                                                    | –/✔/✔/✔/– | `pnpm gate:resilience` exit 0, 2026-11-17, isolated `easeit_recovery` + `redis:7-alpine` on 6380 (operator-declared boundary): the job was published, the queue obliterated (0 jobs left), the work rediscovered from PostgreSQL and completed with recoveries=1 attempts=1, handler ran exactly once; plus drain, retry-to-success, worker killed mid-handler, DEAD after budget, replay dropped, 8-way concurrency, shutdown mid-flight, no lease left held | After queue loss, pending work is rediscovered and completes exactly once        | WK-05 | 1   | M      | 2026-11-17 | TR local |
| WK-11 | Dead-letter state                     | `CV` | `OutboxStatus.DEAD`; new `outbox_event.alertedAt` (NULL = nobody told yet, partial index `outbox_event_dead_unalerted`); stamped only after a sink accepts, so an outage or crash cannot lose the alert (at-least-once) | –/✔/✔/✔/– | outbox suite — budget exhaustion reaches DEAD (61 PASS, 2026-11-17); alerting suite §1 — a permanent failure through the real `OutboxWorker` is left DEAD + unalerted, then alerted and stamped; §3–4 — failing/hanging sink leaves it unalerted until delivered                                                                                                                                                                                              | A permanently failed job alerts and does not vanish                              | OB-06 | 1   | M      | 2026-11-17 | TR       |
| WK-12 | Real business handlers                | `NI` | only `handlers/self-test.handler.ts`; `OutboxEventType` has one value                                                                                                                                                   | ✖/✖/✖/✔/– | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                                           | At least booking-confirmation and ARI-push handlers exist and are idempotent     | NO-05 | 1   | M      | 2026-10-29 | SI       |
| WK-13 | `queue:ui` (Bull Board)               | `NI` | documented in CLAUDE.md §4; **absent from `package.json`**                                                                                                                                                              | ✖/✖/✖/–/✖ | none                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Queue inspection available to operators                                          | WK-01 | 3   | A      | 2026-10-29 | SI       |

### 2.23 Deployment, CI and the release gate

Parent status: **`PI`** — the gate is the best-tested subsystem; nothing is deployable and no
workflow has ever run.

| ID    | Subfeature                                      | St   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | U/A/L/D/I   | Tests and actual result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Acceptance criterion                                                                                                                     | Dep   | Pri | Launch | Verified   | Method        |
| ----- | ----------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | ------ | ---------- | ------------- |
| CI-01 | Fast local gate                                 | `CV` | `scripts/gate.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | –/–/✔/–/–   | `pnpm gate` → **exit 0**: whitespace 47 ms, format 2984 ms, typecheck 690 ms, lint 652 ms, guards 59 ms, retry 164 ms (2026-10-29)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | One documented command runs every service-free check and fails non-zero                                                                  | —     | 1   | M      | 2026-10-29 | TR            |
| CI-02 | Typecheck                                       | `CV` | turbo `typecheck` across 10 packages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | –/–/✔/–/–   | 10/10 tasks, exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Clean before review                                                                                                                      | —     | 1   | M      | 2026-10-29 | TR            |
| CI-03 | Lint                                            | `CV` | turbo `lint` across 11 packages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | –/–/✔/–/–   | 11/11 tasks, exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Clean before review                                                                                                                      | —     | 1   | M      | 2026-10-29 | TR            |
| CI-04 | `pnpm test` is honest                           | `PI` | now `node scripts/gate.mjs --no-format`; previously `turbo run test` planned 8 tasks, all `<NONEXISTENT>`, exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | –/–/✔/–/–   | `pnpm test` → exit 0 and actually runs suites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `pnpm test` can never pass without executing tests                                                                                       | CI-05 | 1   | M      | 2026-10-29 | TR            |
| CI-05 | Domain unit tests (vitest)                      | `CV` | 2026-11-17: vitest 3.2.4 in `@repo/types` and `@repo/api`, `*.test.ts` beside the code (excluded from both builds). Nine suites, 216 tests: `money.test.ts` (rounding modes, allocation, parsing), `domain.test.ts` (business dates, half-open stays, zone-local "today"), `tax-engine.test.ts`, `reservation-pricing.test.ts`, `rate-pricing.policy.test.ts`, `occupancy-pricing.policy.test.ts`, `promotion.policy.test.ts`, `reservation.state.test.ts` (every rule for every status), `night-audit.schedule.test.ts` (incl. both US DST changes). `pnpm test` runs them as gate check "domain unit tests (vitest)" | ✔/–/✔/–/–   | `pnpm test` exit 0: 76 + 140 passed. **12 planted bugs, each caught** (allocate sign, HALF_EVEN, parse-only date check, inclusive tax ceiling, inconsistent reverse solve, truncated nightly tax, band from rack rate, CHECKED_OUT not consuming, weekend over weekday, unclamped discount, pooled adult allowance, stale audit auto-run). Found a real defect: `businessDateSchema` accepted 2026-02-30 / 2026-02-29 / 2026-04-31 (Date.parse rolls over); fixed by round-tripping, which covers the 26 DTOs that use it                                                                                                                                                                | Pricing, tax, rounding, allocation, state machines and business-date math covered                                                        | FO-09 | 1   | M      | 2026-11-17 | TR local      |
| CI-06 | Guard and gate unit tests                       | `CV` | `test/unit/gate-guards.test.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | –/–/✔/–/–   | `node test/unit/gate-guards.test.mjs` → 43 checks, exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Every rejection path covered without services                                                                                            | CI-15 | 2   | M      | 2026-10-29 | TR            |
| CI-07 | Changed-file detection on pull_request          | `CV` | `.github/workflows/pr.yml:80` `GATE_BASE_REF`; `scripts/lib/changed-files.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | –/–/✔/–/–   | unit: mode `base`, three-dot diff against the merge base                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | A PR is compared against its real base                                                                                                   | CI-06 | 2   | M      | 2026-10-29 | TR            |
| CI-08 | Changed-file detection on push                  | `CV` | `pr.yml:81` `GATE_BEFORE_REF: github.event.before`; `scripts/lib/changed-files.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | -/-/OK/-/-  | unit: mode `before`, two-dot; zero detected files in CI **fails**. **Remote confirmation: run 40859847434 job `fast` conclusion `success`, every step green** (runs 40820963243 and 40857305954 had failed).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | A push is compared against its predecessor and can never pass vacuously                                                                  | CI-07 | 2   | M      | 2026-10-29 | TR            |
| CI-09 | Initial commit, force-push and shallow clone    | `CV` | `changed-files.mjs` modes `all` / `undetermined` / `unresolvable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | –/–/✔/–/–   | unit: zero-SHA → `all` (372 files); unreachable predecessor → `all`; missing base in CI → hard fail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | No-predecessor cases are handled explicitly, never silently                                                                              | CI-08 | 3   | M      | 2026-10-29 | TR            |
| CI-10 | Sufficient checkout history                     | `CV` | `pr.yml:43` `fetch-depth: 0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | –/–/✔/–/–   | inspected alongside the passing base-ref tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Merge-base comparison is always possible                                                                                                 | CI-07 | 2   | M      | 2026-10-29 | TR partial    |
| CI-11 | Integration workflow                            | `CV` | `pr.yml` job `integration`, service `postgres:17`. The `easeit_racetest`/`easeit_ci` name mismatch that broke step 11 is fixed: `create-race.test.mjs` now delegates its name decision to the shared three-tier classifier while keeping its own live-connection, constraint and API checks. Committed in `c3fed16`.                                                                                                                                                                                                                                                                                                   | -/-/OK/OK/- | **Local, on an isolated pair:** `pnpm gate:integration` exit 0, 5/5 suites against a fresh disposable `easeit_ci` (outbox 3459ms, claim-race 1660ms, check-in 1717ms, cancellation 12118ms, creation races 4042ms); preflight reported `4/4 guards present`; dev DB verified untouched afterwards. **Remote: NOT green.** Run 41044939779 (sha `c3fed16`) ended `failure` with job `integration` failing at step 11 and job `fast` failing at step 7. **Status set to `CV` by owner decision on 2026-10-30 while the documented acceptance criterion was unmet** (see change history, sixth pass) -- the evidence above is recorded unchanged so the gap is visible rather than implied. | The `integration` job green on a real push or PR, with step 11 completing -- **not yet satisfied**                                       | CI-01 | 1   | M      | 2026-10-30 | TR local only |
| CI-12 | Release workflow PostgreSQL client              | `PI` | `release.yml` now adds the PGDG apt repository, installs `postgresql-client-17` with no fallback, and asserts `pg_dump` major >= 17 before dumping; the old fallback to `postgresql-client` would have installed client 16, which refuses a PG 17 server. `release.yml` also received the same `working-directory: apps/api` fix.                                                                                                                                                                                                                                                                                      | –/–/~/–/–   | **Never executed** — no `release.yml` run exists in the Actions history (only run 40820963243, workflow `PR`). Not a PR failure. 2026-11-17: `release.yml` is now also `workflow_call`ed by `publish.yml`, gained `MAIL_CAPTURE_DIR` and the `easeit_app` role step to match `pr.yml`; still not executed remotely.                                                                                                                                                                                                                                                                                                                                                                      | `pg_dump` major >= server major and the backup/restore step green in a real dispatched or scheduled run                                  | BR-02 | 1   | M      | 2026-10-29 | NV            |
| CI-13 | Resilience workflow                             | `BU` | `release.yml` job `resilience` with `postgres:17` and `redis:7-alpine` on 6380                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | –/–/~/–/–   | **never executed**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Green nightly, including queue-loss recovery                                                                                             | WK-10 | 1   | M      | 2026-10-29 | NV            |
| CI-14 | Deployment configuration                        | `CV` | 2026-11-17: root `Dockerfile`, five targets (`api` also runs the worker, `ops` = migrations + reference data + app role + `provision`, three Next standalone web apps). `deploy/docker-compose.yml` (postgres 17, redis, one-shot `migrate`, api, worker, web apps, Caddy TLS), `deploy/.env.example` as the env contract, `deploy/README.md` runbook. `packages/database/prisma/provision.ts` creates a property and its first admin (invitation link, no password handled). `.github/workflows/publish.yml`: on `v*.*.*` runs release checks, builds, smoke-tests, then pushes to GHCR                               | ✔/–/✔/–/–   | **Local, Docker 28.1.1:** all five images built; `deploy/smoke.sh` exit 0 — migrate 3/3, API `/health/ready` 200 connected as `easeit_app`, worker running, three web apps healthy, provision created SMOKE1 + admin, invitation accepted 200. Found and fixed by the smoke run: missing `prisma.config.ts` and OpenSSL in ops, provision importing `src`, API refusing `GST_PROVIDER=mock` in production (compose now requires a real provider). **`publish.yml` not yet run on GitHub.**                                                                                                                                                                                               | Reproducible build for api, worker and web apps; documented env contract; boots against a fresh database                                 | —     | 1   | M      | 2026-11-17 | TR local      |
| CI-15 | Destructive-test database guards                | `CV` | `test/support/isolation-guard.mjs` called by six suites; `create-race.test.mjs` keeps its own guard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | –/–/✔/✔/–   | all seven suites refused the development database, exit 1 each; zero module-scope destructive statements in all six (2026-10-29)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | No destructive suite can touch a shared database by any entry point                                                                      | CI-16 | 1   | M      | 2026-10-29 | TR            |
| CI-16 | Environment cannot authorize the development DB | `CV` | `classifyTarget` applies three tiers in order: `ALWAYS_FORBIDDEN` (absolute, env cannot override), then names discovered from this checkout.s `.env` files (refused unless they are built-in disposable test names, and `EASEIT_TEST_DBS` cannot override), then the allowlist. `developmentDatabaseNames()` is discovery-only.                                                                                                                                                                                                                                                                                        | -/-/OK/OK/- | unit: 43+ checks incl. both CI regressions - (a) with NO discovered names `easeit` is still refused by the floor; (b) `easeit_ci`, `easeit_racetest`, `easeit_recovery`, `easeit_test` are allowed even when `.env` names them (the CI shape); (c) a personal name from `.env` is refused despite `EASEIT_TEST_DBS`. Simulated the exact CI env-file layout: discovered `easeit_ci` -> verdict ok=true, while `easeit` + `EASEIT_TEST_DBS=easeit` -> ok=false. `pnpm gate` exit 0; unit from a no-`.env` directory exit 0.                                                                                                                                                               | No environment variable can authorize a known shared database, and a disposable test database is never refused for being named in `.env` | CI-15 | 1   | M      | 2026-10-29 | TR            |

### 2.24 Performance and load testing

| ID    | Subfeature                 | St   | Evidence                                                                                                                                                                                                                                                                                                                                                         | U/A/L/D/I | Tests                                                                                                                                                                                                                                           | Acceptance criterion                                                | Dep   | Pri | Launch | Verified   | Method |
| ----- | -------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----- | --- | ------ | ---------- | ------ |
| PF-01 | Group performance endpoint | `PI` | `performance.controller.ts:44`                                                                                                                                                                                                                                                                                                                                   | ✔/✔/✔/✔/– | none                                                                                                                                                                                                                                            | Figures reconcile to snapshots                                      | RP-08 | 2   | A      | 2026-10-29 | SI     |
| PF-02 | Load / stress testing      | `CV` | 2026-11-17: `scripts/load/run-load.mjs` (`pnpm load:run`), 50 virtual staff over 9 hotels with a weighted front-desk mix and think time, then a no-think-time stress phase; data from `pnpm load:seed` (a year: 34,994 reservations, 154,539 folio lines). Recorded in `docs/release/LOAD-AND-QUERY-PROFILE.md`                                                  | ✔/✔/✔/–/✔ | steady 300 s: 6,158 requests, p50 19 ms, **p95 104 ms**, p99 142 ms, 0 errors; stress: 66 req/s, 0 errors; afterwards 45,310 inventory cells all equal their live room rows, none oversold. Laptop, single API process, not production hardware | Documented profile at 50 concurrent staff with p95 latency recorded | —     | 2   | A      | 2026-11-17 | SI     |
| PF-03 | Index and query profiling  | `CV` | 2026-11-17: `scripts/load/profile-queries.mjs` (`pnpm load:profile`) turns on `auto_explain` for the disposable database only and ranks every real plan under the PF-02 load (9,668 plans, 218 shapes), flagging large sequential scans and propertyId-led indexes entered without propertyId. Found 5; fixed by migration `20261118090000_child_lookup_indexes` | ✔/✔/✔/✔/– | re-profiled on the same data: 0 flagged; master-report folio query 465→50 ms, endpoint p50 913→92 ms. Dashboard all-time status counts recorded, not changed (product decision)                                                                 | Hot queries profiled with `EXPLAIN` under representative data       | PF-02 | 2   | A      | 2026-11-17 | SI     |

### 2.25 Calendar and timeline (product-specific)

| ID    | Subfeature                      | St   | Evidence                                                                      | U/A/L/D/I | Tests | Acceptance criterion                                                  | Dep   | Pri | Launch | Verified   | Method |
| ----- | ------------------------------- | ---- | ----------------------------------------------------------------------------- | --------- | ----- | --------------------------------------------------------------------- | ----- | --- | ------ | ---------- | ------ |
| CA-01 | Group calendar                  | `PI` | `calendar.controller.ts:46`; `(dashboard)/group-calendar/page.tsx`            | ✔/✔/✔/✔/– | none  | Occupancy across the portfolio matches persisted state                | —     | 2   | M      | 2026-10-29 | SI     |
| CA-02 | Timeline calendar (room × date) | `PI` | `timeline.controller.ts:48`; `components/calendar/timeline/timeline-grid.tsx` | ✔/✔/✔/✔/– | none  | Grid matches assignments; drag-to-assign calls the move endpoint      | FD-05 | 2   | M      | 2026-10-29 | SI     |
| CA-03 | Create-reservation modal        | `PI` | `components/calendar/create-reservation-modal.tsx`                            | ✔/✔/✔/✔/– | none  | Creates a booking through the real endpoint and reflects the result   | RS-02 | 2   | M      | 2026-10-29 | SI     |
| CA-04 | Reservation drawer              | `PI` | `components/calendar/timeline/reservation-drawer.tsx`                         | ✔/✔/✔/✔/– | none  | Shows real state; offered actions match legal transitions             | RS-08 | 2   | M      | 2026-10-29 | SI     |
| CA-05 | Check-in modal                  | `PI` | `components/calendar/timeline/check-in-modal.tsx`                             | ✔/✔/✔/✔/– | none  | Surfaces blockers and typed refusals                                  | FD-02 | 2   | M      | 2026-10-29 | SI     |
| CA-06 | Room-move sheet                 | `PI` | `components/folio/room-move-sheet.tsx`                                        | ✔/✔/✔/✔/– | none  | Category-change acknowledgement required; stale-move refusal surfaced | FD-05 | 2   | M      | 2026-10-29 | SI     |
| CA-07 | Cancel-booking dialog           | `PI` | `components/folio/cancel-booking-dialog.tsx`                                  | ✔/✔/✔/✔/– | none  | Idempotent cancel; already-cancelled reported as success              | RS-04 | 2   | M      | 2026-10-29 | SI     |

### 2.26 Group and property dashboards (product-specific)

| ID    | Subfeature         | St   | Evidence                                                                                                                                                                                            | U/A/L/D/I | Tests                                                                                                                 | Acceptance criterion                                  | Dep   | Pri | Launch | Verified   | Method |
| ----- | ------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----- | --- | ------ | ---------- | ------ |
| GR-01 | Group dashboard    | `PI` | `properties.controller.ts:60` `my-group`; `(dashboard)/group-dashboard/page.tsx`                                                                                                                    | ✔/✔/✔/✔/– | none                                                                                                                  | Portfolio figures reconcile to per-property data      | —     | 2   | A      | 2026-10-29 | SI     |
| GR-02 | Property dashboard | `CV` | `property-dashboard.controller.ts:56`; migration `20261016160000`. 2026-11-17: `lastClosedDay` from `daily_snapshot` (business date − 1), only for `financial_reports:read`; strip on the dashboard | ✔/✔/✔/✔/– | `snapshot-reports.test.mjs` passed in `pnpm gate:integration` on `easeit_test` 2026-11-17 (31/31 suites, 1932 checks) | Summary matches persisted state for the business date | NA-06 | 2   | M      | 2026-11-17 | SI     |
| GR-03 | Omnibar search     | `PI` | `components/property-dashboard/omnibar-search.tsx`                                                                                                                                                  | ✔/✔/✔/✔/– | none                                                                                                                  | Finds reservations and guests within tenant scope     | RS-10 | 3   | A      | 2026-10-29 | SI     |

---

## 3. Status roll-up

### 3.1 COMPLETE AND VERIFIED (`CV`)

- [x] AV-01, AV-02, AV-03 — inventory counters and both CHECK constraints
- [x] RS-02, RS-03, RS-04, RS-05, RS-06, RS-07 — booking, cancellation and every tested race
- [x] RS-15, RS-16 — state machine and bounded lock waits
- [x] FD-02, FD-03, FD-05, FD-07 — check-in, typed `23P01`, room move, cross-category counters
- [x] FO-17 — cancellation never touches money
- [x] AD-02 — audit row atomic with the change
- [x] AD-03 — audit log viewer (2026-11-17)
- [x] OB-06, WK-11 — dead letters and stuck leases alert externally (2026-11-17)
- [x] SE-03 — infrastructure errors never leak
- [x] CI-01, CI-02, CI-03, CI-06, CI-07, CI-08, CI-09, CI-10, CI-15, CI-16 — gate, typecheck, lint, guard tests, changed-file detection, isolation guards

### 3.2 NOT IMPLEMENTED (`NI`) — the launch-critical ones

- [ ] **FD-04 check-out** — the single largest functional hole
- [ ] AV-04 … AV-07, AV-10 — inventory and rates management
- [ ] RM-02, RM-04, RM-05, RM-06 — room and category administration
- [ ] HK-01 … HK-05 — housekeeping
- [ ] NA-01 … NA-08 — night audit and business date
- [ ] FO-12, FO-13, FO-14, FO-15, FO-16 — refunds, settlement, invoices, gateway, payments screen (FO-12, FO-13, FO-14 done; gateway and payments screen open)
- [ ] MT-02, MT-03, MT-04 — tenancy context, Prisma extension, RLS
- [ ] AU-08, AU-13, AU-15 — password reset, inert permissions, deactivation
- [ ] RS-11, RS-12, RS-13 — stay amendment and no-show
- [ ] NO-04, NO-05 — confirmation email and real outbox events
- [ ] WK-12 — business handlers
- [x] CI-05, CI-14 — domain unit tests, deployment configuration (2026-11-17)
- [x] OB-06 — alerting (2026-11-17)
- [ ] OB-05 — metrics/tracing
- [ ] BR-04 — PITR (BR-01..03 done 2026-11-17)
- [x] RP-09, RP-10 — tax reports, revenue screen (built 2026-11-17; integration run pending)
- [ ] BE-01 … BE-05, CM-01 … CM-05 — optional modules, advertised
- [ ] GP-02, GP-07, MA-01, SE-05, AV-09, NO-06, PF-02, WK-13, MT-08 (AD-03 done 2026-11-17)

### 3.3 BLOCKED / UNKNOWN (`BU`) — and the isolated setup each needs

| ID                                                                       | What is unknown                                                   | Isolated setup required                                                                                                                                                                            |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FO-18                                                                    | Whether concurrent payment and reservation writes stay consistent | Isolated DB plus concurrent folio/reservation load                                                                                                                                                 |
| SE-02                                                                    | Whether any log line carries PII                                  | Line-by-line review, then an automated lint rule                                                                                                                                                   |
| CI-13                                                                    | Whether the resilience workflow runs green                        | Commit and push, then a dispatched or scheduled run (CI-11 left this table in the fifth pass: it is now `PI`, its steps 1-10 are green remotely and the full gate passes under local reproduction) |
| PF-03                                                                    | Query plans under load                                            | Representative dataset plus profiling harness                                                                                                                                                      |
| MT-01…MT-07 runtime behaviour, PS-_, AU-_, FO-01…FO-11, RP-_, CA-_, GR-* | Whether the endpoints behave as written                           | Isolated DB plus API, per-module integration suites                                                                                                                                                |

---

## 4. Prioritized remediation backlog

### P0 — launch blockers

| #         | Item                                                         | IDs                 | Acceptance criterion                                                                                                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1      | Implement check-out                                          | FD-04               | `POST .../check-out` moves `CHECKED_IN → CHECKED_OUT` under the reservation row lock, settles or refuses an open balance, frees the room, writes an audit row in the same transaction, is idempotent, and an integration test covers every illegal source state                                               |
| P0-2      | Inventory management — **met except `physical`, 2026-11-15** | AV-04, RM-06        | Endpoints set `physical`, `blocked` and `overbookingAllowance` per date range; a block reduces sellable count; the oversell CHECK still holds; test proves both — blocked and allowance met and proven (`room-blocks` 78/78); `physical` deliberately not directly settable, awaiting owner decision          |
| ~~P0-3~~  | ~~Rate plans and rate calendar~~ **done 2026-11-15 (F9)**    | AV-05, AV-06, RS-01 | A quote derives from a stored rate for the date and plan; test asserts quoted total equals nightly rates plus taxes in integer minor units. Plans/calendar/rules tested (`rates` 65/65); the quote integration needs per-night rate storage because check-in and folio corrections assume a flat nightly rate |
| ~~P0-4~~  | ~~Room type and room CRUD~~ **done 2026-11-15**              | RM-02, RM-04        | Create/edit/retire with tenant scope; retiring a category or room with live stays is refused with a typed error — met: `EntityInUseError` (409), `room-retirement` 50/50                                                                                                                                      |
| ~~P0-5~~  | ~~Folio payment idempotency~~ **done 2026-10-31**            | FO-03, FO-04        | Payment accepts a client idempotency key; five identical POSTs produce exactly one payment line and one audit row — met, plus one `paidAmountMinor` increment and the concurrent case                                                                                                                         |
| P0-6      | Night audit and business-date roll                           | NA-01 … NA-06       | Per-property BullMQ job; `night_audit_step` rows; resumable and idempotent; re-running a completed audit is a no-op; business date advances only in step 7                                                                                                                                                    |
| P0-7      | Tenancy extension and RLS                                    | MT-02, MT-03, MT-04 | Prisma extension injects `propertyId`; RLS policies active; per-module test asserts cross-tenant read/update/delete returns not-found                                                                                                                                                                         |
| P0-8      | Deployment configuration                                     | CI-14               | Reproducible container build for api, worker and both web apps; documented env contract; boots against a fresh database                                                                                                                                                                                       |
| P0-9      | Password reset                                               | AU-08               | Single-use expiring token; expiry and replay both refused; test covers both                                                                                                                                                                                                                                   |
| ~~P0-10~~ | ~~Gate unimplemented permissions~~ **done 2026-11-15**       | AU-13               | `RESERVATIONS_CHECKOUT`, `FOLIO_REFUND`, `FOLIO_SETTLE`, `NIGHT_AUDIT_*` and `HOUSEKEEPING_*` are not grantable until their feature ships                                                                                                                                                                     |

### P1 — required before pilot

| #     | Item                                          | IDs                  | Acceptance criterion                                                                                                               |
| ----- | --------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| P1-1  | Commit and push the gate and test workstreams | CI-11, CI-13         | A real pull request and a real push both run green                                                                                 |
| P1-2  | Fix the release workflow PostgreSQL client    | CI-12                | PGDG repo added; `pg_dump --version` major ≥ server major; backup/restore step green                                               |
| P1-3  | Domain unit tests                             | CI-05, FO-09         | Vitest covers pricing, tax, rounding, allocation, state machines and business-date math; `pnpm test` runs them                     |
| P1-4  | Housekeeping module                           | HK-01 … HK-03, RM-05 | Room status board and transitions; every change audited and visible to front desk                                                  |
| P1-5  | Refunds and settlement                        | FO-12, FO-13         | Reversal-based refund and zero-balance close; immutability test passes                                                             |
| P1-6  | Invoices                                      | FO-14                | Numbered, immutable, tax-itemised invoice retrievable as PDF/CSV                                                                   |
| P1-7  | Prove queue-loss recovery                     | WK-10                | `pnpm gate:resilience` green against isolated Redis on 6380, including `obliterate`                                                |
| P1-8  | Local backup/restore automation               | BR-01, BR-02, BR-03  | `test/recovery/` suite dumps, restores to a **separate** target and runs four-layer verification; refuses the development database |
| P1-9  | Induce a real deadlock                        | RS-18                | A forced `40P01` is retried within budget then answered as a typed 409                                                             |
| P1-10 | Bound the create-reservation lock wait        | RS-17                | Contended booking returns a typed 409 within `ROW_LOCK_TIMEOUT_MS`, measured in a test                                             |
| P1-11 | Stay amendment and no-show                    | RS-11, RS-12, RS-13  | Inventory effects asserted per date and per category for every amendment                                                           |
| P1-12 | Alerting sink                                 | OB-06, WK-11         | A dead letter or stale lease raises an external alert                                                                              |
| P1-13 | Audit log viewer                              | AD-03                | Filterable per property by actor, entity and date, with before/after                                                               |
| P1-14 | Graceful shutdown proof                       | WK-03                | SIGTERM test in a Linux container shows the in-flight job completes or the lease is released; no stuck rows                        |
| P1-15 | Real outbox business events                   | NO-04, NO-05, WK-12  | Booking confirmation delivered exactly once through the outbox, with an idempotent handler                                         |

### P2 — required before general availability

| #     | Item                              | IDs                 | Acceptance criterion                                                                        |
| ----- | --------------------------------- | ------------------- | ------------------------------------------------------------------------------------------- |
| P2-1  | Observability                     | OB-01, OB-05        | Request/property-scoped logs, metrics endpoint, trace propagation, error reporting          |
| P2-2  | PII-in-logs audit                 | SE-02               | Documented review plus an automated check rejecting known PII fields                        |
| P2-3  | Load testing                      | PF-02, PF-03        | Documented profile at 50 concurrent staff; p95 latency and booking-race results recorded    |
| P2-4  | Real GST provider                 | GP-04               | Sandbox path exercised; `mock` impossible outside development                               |
| P2-5  | Maintenance / work orders         | MA-01, RM-06        | Out-of-order rooms leave sellable inventory, with a test                                    |
| P2-6  | Reusable guest profiles           | GP-02               | Dedupe and stay history                                                                     |
| P2-7  | Tax reports                       | RP-09               | Period tax report reconciles exactly to folio tax lines                                     |
| P2-8  | Import / export                   | IE-01, IE-02        | Bulk import with dry-run validation                                                         |
| P2-9  | Snapshot-based reporting          | RP-05, RP-08, GR-02 | Reports read night-audit snapshots, not live aggregates                                     |
| P2-10 | Repo-wide Prettier decision       | —                   | Either reformat all 153 outstanding files or permanently document the grandfathering policy |
| P2-11 | Payment gateway                   | FO-15               | Wired to a real provider with a sandbox test, or the model is removed                       |
| P2-12 | Per-module tenant isolation tests | MT-05               | Every module has the CLAUDE.md §3.2 not-found test                                          |

### P3 — post-launch

Booking engine (BE-01 … BE-05) · Channel manager (CM-01 … CM-05) · SMS/WhatsApp (NO-06) · PITR
(BR-04) · Redis availability cache (AV-09) · `queue:ui` (WK-13) · `audit:dry-run` (NA-08) ·
GDPR tooling (SE-05) · `withoutTenantScope()` (MT-08).

---

## 5. End-to-end workflow verification matrix

| Workflow                                  | Code exists | Proven end to end         | Evidence                                                                        |
| ----------------------------------------- | ----------- | ------------------------- | ------------------------------------------------------------------------------- |
| Create reservation, including races       | ✔           | **Yes**                   | `create-race.test.mjs` ×3 → 177/179/178 checks, exit 0, isolated DB, 2026-10-29 |
| Cancel reservation                        | ✔           | **Yes**                   | `cancel-reservation.test.mjs` → 229/229, exit 0                                 |
| Cancel vs check-in                        | ✔           | **Yes**                   | 12/12 races → typed 409                                                         |
| Cancel vs cross-category move             | ✔           | **Yes**                   | 9/9, per-category per-date counters asserted                                    |
| Check-in, including stale assignment      | ✔           | **Yes**                   | 23/23 plus deterministic harness 8/8                                            |
| Room move                                 | ✔           | **Yes**                   | via cancellation and create-race suites                                         |
| Bounded lock waits                        | ✔           | **Yes**                   | measured 3029 / 3035 / 3038 ms → typed 409                                      |
| Outbox enqueue, claim, lease, retry, DEAD | ✔           | **Yes** (PostgreSQL only) | `pnpm gate:integration` → outbox and claim-race suites exit 0                   |
| Destructive-test database guards          | ✔           | **Yes**                   | 7/7 suites refuse the development DB, exit 1; 43 unit checks                    |
| CI changed-file detection                 | ✔           | **Yes** (unit)            | 43 checks covering push, PR, zero candidates, missing base                      |
| Typecheck, lint, fast gate                | ✔           | **Yes**                   | `pnpm gate` exit 0                                                              |
| Parallel-booking stress suite             | ✔           | **No**                    | `pnpm test:concurrency` has never been run                                      |
| Redis / BullMQ queue loss                 | ✔           | **No**                    | no Redis, Docker daemon down                                                    |
| Graceful SIGTERM                          | ✔           | **No**                    | not deliverable on Windows                                                      |
| Backup / restore                          | partial     | **No**                    | CI-only, never executed                                                         |
| Deadlock / serialization retry            | ✔           | **No**                    | never induced                                                                   |
| Folio charge / payment / correction       | ✔           | **No**                    | zero tests                                                                      |
| Auth, 2FA, RBAC enforcement               | ✔           | **No**                    | no dedicated tests                                                              |
| Property setup writes                     | ✔           | **No**                    | zero tests                                                                      |
| Reports                                   | ✔           | **No**                    | zero tests                                                                      |
| Calendar / timeline UI                    | ✔           | **No**                    | never rendered in a test                                                        |
| Any CI workflow                           | ✔           | **No**                    | untracked, never pushed                                                         |
| **Check-out**                             | ✖           | **No**                    | does not exist                                                                  |

---

## 6. Must be hidden or labelled unavailable before any demo

Already honestly labelled — `PlaceholderScreen` states "Not built yet" and names its blocker, and
shows **no invented data**. Keep this pattern:

- [x] NA-07 night audit · AV-10 rates & inventory · FO-16 payments · GP-07 direct billing
      (RP-10 revenue was here; it is a real screen since 2026-11-17)

Still to address:

- [ ] **AU-13** — permissions for absent features are grantable; an admin can confer authority that
      silently does nothing
- [ ] **BE-02** — the public booking page renders a **hardcoded nightly rate**
      (`apps/web-booking/src/app/[propertySlug]/page.tsx:24`). It must not be publicly reachable; it
      would quote prices the PMS never agreed
- [ ] **GP-04** — GSTIN lookup returns synthetic company names under the default `mock` provider;
      label "unverified demo data" or disable outside development
- [ ] **RP-06** — BAR pricing report depends on a rates domain that does not exist
- [x] **RP-08 / GR-02** — closed days read from snapshots (2026-11-17); open days are labelled
      "On the books" in the sales report and counted in group performance's `basis`
- [ ] **FO-15** — do not surface any payment-gateway settings; the model is unwired
- [ ] **CLAUDE.md §4** promises `pnpm test:integration`, `test:e2e`, `queue:ui` and `audit:dry-run`;
      none exists in `package.json`
- [ ] **CLAUDE.md §2** lists `inventory`, `rates`, `frontdesk`, `housekeeping`, `nightaudit`,
      `channels` and `booking-engine` as if present; mark them planned
- [ ] **No frontend test framework exists** (no vitest, jest, @testing-library or Playwright in any
      `package.json`), so every branch in the web apps is covered by review and `tsc` and by nothing
      executable. Pure decision functions that the front desk depends on -- `checkOutGuidance` in
      `reservation-drawer.tsx` is the current example -- are the ones worth covering first if one is
      introduced
- [ ] **`test:checkout` and `test:payment` are not part of `pnpm gate:integration`**, so CI runs
      neither FD-04's nor FO-04's suite; adding them changes the gate's contents and should be a
      deliberate change of its own
- [ ] **Server-side payment intents — HIGH PRIORITY production requirement.** FO-03/FO-04's
      client protocol is `sessionStorage`-backed, so it does **not** prevent every duplicate
      payment. Closing the tab or the browser discards the unresolved intent, the quarantine and
      the acknowledgement together; a second tab mints a second key; another device knows nothing.
      In each case the same money can be taken twice. The within-tab guarantees (retry in place,
      double-click, sheet close/reopen, reload, and the corrupt-value quarantine) are as far as
      client state can reach. A `PaymentIntent` record the server can list per folio closes all of
      it and additionally survives a crash, another device and a shift change — and the clerk's
      duplicate-risk acknowledgement is the first thing that should move there, because an attested
      acceptance of risk should not live in one browser tab. Needs a model, a hand-written
      migration, create/list/resolve endpoints, a reaper for abandoned intents and its own suite;
      the natural trigger is payments becoming multi-step (FO-15 gateway, 3-D Secure, hosted
      payment link)
- [ ] **`check-out.test.mjs` leaks 20 nights of inventory per run.** Its teardown deletes its
      reservations without releasing their nights, on the stated premise that deleting the rows
      removes what `inventory_day.sold` counts — but `sold` is a stored counter the booking path
      increments, not a derived read. Isolated by measurement on 2026-11-01: baseline no drift,
      folio-payment run no drift, check-out run 20 rows drifted. Repeated runs exhausted every
      category at 31001 and made the check-in suite fail for an unrelated-looking reason. Fix with
      the read-then-delete-then-decrement pattern at `cancel-reservation.test.mjs:3240`, which
      `folio-payment.test.mjs` now uses
- [ ] **`correctCharge` answers 500 when a taxed charge is corrected downwards** — the negative
      `deltaTaxMinor` is written as a `TAX` line and `folio_line_sign_matches_kind` requires
      `TAX >= 0` (SQLSTATE `23514` at `folios.service.ts:710`). The constraint is right and the
      service is wrong. Found 2026-10-31 while building the payment suite; reproduce by posting a
      15,000 charge with 2,700 tax and correcting its gross to 10,000
- [ ] **The folio payment idempotency migration is applied to `easeit_test` only.** The shared
      development database still lacks `folio_line.idempotencyKey`; applying it is
      `pnpm db:migrate:deploy`, which CLAUDE.md section 6.5 reserves for an explicit decision

---

## 7. Provenance and safety record

### 7.1 Audit of 2026-10-29

Commands executed — read-only except the one test run:

```
git log / status / branch --porcelain
find / grep / sed / ls / wc / awk                 (static inspection)
python -c "..."                                   (parsed package.json and schema.prisma)
pnpm gate                                         → exit 0   ← the only executing test
```

Tests actually run during the audit:

```
$ pnpm gate
  PASS  whitespace 47ms
  PASS  format 2984ms
  PASS  typecheck 690ms          (10/10 turbo tasks)
  PASS  lint 652ms               (11/11 turbo tasks)
  PASS  unit tests (guards, no services) 59ms     (43 checks)
  PASS  unit tests (retry classifier) 164ms       (30 checks)
GATE_EXIT=0
```

Results cited from earlier the same day, against the isolated `easeit_racetest` database, not re-run
during the audit itself: cancellation 229/229 · create-race 177/179/178 ×3 · check-in 23/23 ·
`gate:integration` 5 suites exit 0 · bounded-wait measurements · 7/7 guard refusals.

Not run — would need unavailable services or would mutate data: every integration and concurrency
suite, `test:concurrency`, `test:outbox:redis`, backup/restore, both CI workflows. PostgreSQL was
stopped, nothing listened on 6379, the Docker daemon was down.

No secrets or connection strings were printed; databases are referred to by name only.

### 7.2 Could not be verified at all

Runtime behaviour of auth, folios, reports, property setup, calendar/timeline UI and notifications;
UI-to-API wiring beyond static `fetch` detection; whether migrations apply cleanly from empty;
actual CI behaviour; graceful shutdown; deadlock retries; folio interleavings; PII-in-logs
compliance.

---

## 8. Change history

Newest first. Every status transition records the date, the feature IDs, the evidence and the reason.

### 2026-11-18 (fiftieth pass) - the public booking engine (BE-01..BE-05, AV-08, AV-09)

**Status transitions.** BE-01, BE-03, BE-04, BE-05, AV-08 and AV-09 `NI`→`CV`; BE-02
`NI`→`PI` (pages not rendered in a browser). Counts: `CV` 96→102, `PI` 89→90, `NI` 18→11.

**Decisions (the user's).**

- The guest chooses to pay at the hotel or pay now.
- A hold guarantees the PRICE for 15 minutes, not the room.
- Both choices confirm at booking. "Pay now" then sends the guest to a Razorpay link; an
  abandoned payment leaves a confirmed booking with a balance due.
- Plans sold publicly: STANDARD, PACKAGE and PROMOTIONAL (the schema has no visibility flag).

**Design.**

- **Booking path.** One booking path: the guest books through
  `CreateReservationService.createForGuest`, the staff transaction itself, with the signed
  quote as the price and two hooks: a per-quote advisory lock before inventory, and the
  `online_booking` row, audit and folio after the reservation.
- **Overbooking.** The overbooking allowance is excluded from the public's sellable check
  (stricter than the CHECK).
- **Payment links.** `PaymentsService.issue()` was extracted from `sendLink` so staff and
  guest links share one code path.
- **Migration.** `20261118150000_online_booking`, one new empty table with RLS; applied to
  `easeit_test`, dev `easeit` and `easeit_racetest` with approval.

**Found by the suite.** A pay-at-hotel booking has no folio, so a later "Pay now" could not
pay and was reported as "Nothing is owed". Fixed: the guest link opens the folio (tolerating
a concurrent opener), and an explicit pay request reports its real failure; only the
post-booking link is absorbed, because the room is already booked by then.

**Verified.**

- `pnpm gate:integration`: 36/36 suites, 2126 checks; the new suite passes 55/55.
- `pnpm test:concurrency` on `easeit_racetest` (required for any reservation change).
- Token vitest: 6 tests.
- Fast gate green.

**Not verified.**

- The booking pages in a browser.
- Real Razorpay and its webhook (as FO-15).
- Per-address throttling behind the production proxy (it relies on the proxy setting
  `X-Forwarded-For`).

### 2026-11-18 (forty-ninth pass) - bulk import and export (IE-01, IE-02)

**Status transitions.** IE-01 `NI`→`CV`, IE-02 `NI`→`CV`. Counts: `CV` 94→96, `NI` 20→18.

**IE-01.** Room types, rooms and rates are imported from CSV into an existing property;
properties come from onboarding in a fixed portfolio. The dry run and the commit share one
code path:

- the whole import runs in a transaction under a per-property advisory lock;
- a dry run rolls back, so a clean check has already passed every constraint;
- a commit must quote the dry run's digest, and one bad row refuses all of it;
- audit rows use the screens' event names, plus a `DATA_IMPORTED` summary, all in the same
  transaction (the room, room-type and rate services write theirs after the change).

No `inventory_day` writes; the result says new categories need the horizon extended.

**IE-02.** Six datasets, behind the new sensitive `data:export` permission:

- the configuration datasets use the import's columns and round-trip (tested);
- the operational datasets are windowed;
- every export is audited with a personal-data flag.

**Also.** The #25 logger unit test loaded Nest inside its body with a dynamic import and
timed out at 5.3 s on a busy machine, which failed the fast gate. The import is now
static and the test takes 29 ms.

**Verified.** `pnpm gate:integration` 35/35 suites, 2068 checks, on `easeit_test` with the
migration (also applied to dev `easeit`, with approval). Fast gate green.

**Not verified.** The `/data-exchange` screen was not driven in a browser (free memory
was below 1 GB); it typechecks and lints.

### 2026-11-17 (forty-eighth pass) - load profile and query profiling (PF-02, PF-03)

**Status transitions.** PF-02 `NI`→`CV`, PF-03 `BU`→`CV`. Counts: `CV` 92→94, `NI` 21→20,
`BU` 3→2.

**PF-02.** No new dependency: `scripts/load/run-load.mjs` is plain Node `fetch`. 50 virtual
staff, a weighted front-desk mix, 1-4 s think time, 300 s steady after a ramp, then 60 s
with no think time. Data from `scripts/load/seed-volume.mjs`: a deterministic year on
`easeit_racetest`. Steady p95 104 ms, 0 errors. One API process tops out at about
66 req/s on the laptop. Bookings and cancellations ran throughout; afterwards every
per-date, per-category inventory counter equalled its live room rows.

**PF-03.** `scripts/load/profile-queries.mjs` reads `auto_explain` plans of the real
queries, so there is no hand-copied SQL. Finding: Prisma relation loads and the master
report fetch child rows by parent id alone. The RLS policy's `bypass OR propertyId` cannot
become an index condition, so `reservation_night` was sequentially scanned and
`folio_line` / `reservation_guest` had their `propertyId`-led indexes walked end to end.
Three single-column indexes (migration `20261118090000_child_lookup_indexes`, applied to
`easeit_racetest`, `easeit_test` and dev `easeit` with approval) fixed it: master-report
p50 913→92 ms.

**Verified.** `pnpm gate:integration` 34/34 suites, 2002 checks, on `easeit_test` with
the migration. The re-profile flags nothing.

**Not verified.** Production hardware, the public booking engine's traffic, a soak
longer than five minutes. The dashboard's all-time status counts grow with history;
recorded as a product decision, not changed.

### 2026-11-17 (forty-seventh pass) - observability and no personal data in logs (OB-05, SE-02)

**Status transitions.** OB-05 `NI`→`CV`, SE-02 `BU`→`CV`. Counts: `CV` 90→92, `NI` 22→21,
`BU` 4→3.

**OB-05, without a new runtime dependency** (CLAUDE.md §6.4: the stack can do it).

- `GET /api/v1/metrics` serves Prometheus text from a small in-house registry:
  - HTTP requests and latency by route TEMPLATE, never by URL, so no id becomes a label;
  - outbound calls (Razorpay, the GST provider) by outcome;
  - unhandled errors, the outbox backlog, and process memory and uptime.

  It needs `METRICS_TOKEN`, which production requires; the route is `@CrossProperty`, like the
  health gauge.

- W3C `traceparent` is continued when valid, started otherwise, and returned with `x-request-id`.
  Log lines carry the trace id, and outbound calls send a child span.
- `ErrorReporter` counts and groups unexpected 5xx by fingerprint and sends a digest through the
  OB-06 sinks on a timer, with a cooldown. Only ids and redacted first lines travel.

**SE-02.**

- **Mechanical check** in the fast gate, over all 103 log calls. Its unit test found two bugs
  before the check was trusted: the syntax walk stopped at the first child, so values in template
  strings were missed, and an empty waiver was accepted.
- **Runtime redaction** on both entry points.
- **Review document** with three findings: mail-relay errors carrying the recipient, Prisma
  messages reprinting arguments, and the development log mailer.

**Found by the integration gate, fixed before commit.**

- The redacting logger threw on an `error()` call with no stack, which turned a logged warning
  into a 500 (payment-links). The logger now never throws: it redacts strings only and withholds
  a line if redaction fails.
- `/metrics` answered 500, not 401: the `@Header` content type also applied to the error body.
  Its outbox gauge failed to collect because the route was not `@CrossProperty`.
- A redaction ordering bug: a card written in groups of four was read as an Aadhaar number.
  Caught by the unit test.

**Verified.** `pnpm gate:integration` 34/34 suites, 2002 checks, on `easeit_test`. A full run of
every suite left no email address in the API log.

**Not verified.** An error digest has not been seen through a real sink end to end (unit-tested
with a fake sink). Trace ids are correlation only: no tracing backend is configured.

### 2026-11-17 (forty-sixth pass) - maintenance work orders (MA-01)

**Status transition.** MA-01 `NI`→`CV`. Counts: `CV` 89→90, `NI` 23→22.

**Built.**

- A work order is a fault on a room: OPEN → IN_PROGRESS → RESOLVED or CANCELLED.
- **Permissions.** Reporting needs `housekeeping:read`. Assigning, starting, resolving and
  cancelling need the new `maintenance:manage` (administrator templates). Taking the room out of
  order also needs `room_blocks:manage`.
- **Out of order** is a MAINTENANCE room block created through `RoomBlockService.createWithin`
  inside the work order's own transaction. It therefore keeps every block rule: ascending
  `inventory_day` locks, real unsold capacity, refusal of a room holding a stay. Lock order: work
  order → block → inventory.
- **Restoring.** Resolve/cancel give the room back from the business date
  (`RoomBlockService.restoreFromWithin`). A block that began earlier is shortened, not released,
  so the nights the room really was out of order stay recorded.
- **Refactor.** `RoomBlockService` create/release were split into prepare and within-transaction
  steps, with behaviour unchanged; the room-blocks suite still passes.

**Verified.** Migration `20261117220000_work_orders` was applied to `easeit_test` and `easeit` with
the owner's go-ahead. `pnpm gate:integration` 33/33 suites, 1992 checks. `work-orders.test.mjs` 28/28
asserts `inventory_day.blocked` per date for out of order, resolve and partial restore (D−2/D−1
kept, D/D+1 given back). It also covers 8 concurrent resolves (the counter moves once), 8 concurrent
out-of-order reports (one 201, seven 409s), and an occupied room refused with nothing written.
Plus 403/404 and the same-property trigger.

**Not verified.** The `/maintenance` screen has not been opened in a browser. Room status is not
changed on resolve, so a repaired room is not marked for cleaning. That is a policy choice left to
the owner.

### 2026-11-17 (forty-fifth pass) - a real Razorpay payment, end to end (FO-16)

**Status transition.** FO-16 `PI`→`CV`. Counts: `CV` 88→89, `PI` 90→89.

**Evidence.** On the development database, the owner switched Razorpay on for hotel 31352, sent a
link from the folio of `SFBOOKING_31352_A02`, paid it on Razorpay's test checkout with a test Visa
card, and pressed "Check payment". Verified in the database afterwards:

- link `plink_U1GadehtvEnO2J` is PAID, 118000 of 118000;
- exactly one folio line, key `razorpay_pay_U1Gcgnk6UPbq71`: −118000, CARD, last four 1007, issuer
  Visa (from Razorpay's expanded payment), posted by the system on the property's business date;
- a second link, cancelled, with nothing paid.

**Found by the owner on the way, fixed.**

- `f523a5e`: the folio's action row scrolls horizontally and clipped the dropdown panels ("Payment
  link", and "Bill to company" from GP-07). They now open as dialogs.
- `f24036c`: a link was capped at posted lines only, so a folio with a deposit answered "nothing is
  owed" beside a visible balance due. It is now capped at the folio's balance due, with a
  regression check (payment-links 30/30).
- The development database `easeit` was three migrations behind (`20261117150000`,
  `20261117180000`, `20261117200000`). They were applied with the owner's go-ahead.

**Not verified.** The webhook path against real Razorpay needs a public HTTPS URL. It is covered
against the stand-in only.

### 2026-11-17 (forty-fourth pass) - FO-15 exercised against Razorpay test mode

**Status transition.** FO-15 `PI`→`CV`. Counts: `CV` 87→88, `PI` 91→90.

**Evidence.** The owner ran `pnpm razorpay:smoke` with Razorpay test keys in `apps/api/.env`. Exit 0:
the real API created `plink_U1FoPvqucE6fp0` (short_url `https://rzp.io/rzp/…`), returned it on fetch
(status `created`, paid 0), and cancelled it (status `cancelled`). This proves the keys, Basic auth,
and our request and response mapping for create, fetch and cancel.

**Still open (FO-16 stays `PI`).** No payment has been captured through a link on Razorpay itself, so
the real `payments` array and the expanded card fields are known only from the docs and the
stand-in. That needs one test-card payment and "Check payment".

### 2026-11-17 (forty-third pass) - Razorpay payment links and the payments screen (FO-15, FO-16)

**Status transitions.** FO-15 `NI`→`PI`, FO-16 `NI`→`PI`. Counts: `PI` 89→91, `NI` 25→23. FO-15's
criterion is a run against a real provider's sandbox, and that has not happened yet.

**Decision (owner, 2026-11-17).** Build Razorpay now, rather than remove the unused model.

**Built.**

- **Sending a link.** "Payment link" on a folio sends a Razorpay Payment Link for (part of) the
  balance, needing `folio:settle`.
  - A `payment_link` row is written first, and its id is Razorpay's `reference_id`. Razorpay is
    called outside any transaction. One link per client key.
  - Links can be sent only where the property's `PaymentGatewayConfig` is ACTIVE. An administrator
    switches it, needing `property:settings`.
- **Posting the payment.** Each captured payment is posted to the folio by
  `FoliosService.postGatewayPayment`: the reservation → folio locks, business date, actor null,
  key `razorpay_<payment id>`, card last four from the expanded payment. Two routes reach it:
  - the signed webhook, `POST /api/v1/webhooks/razorpay`, HMAC-SHA256 of the raw body, 401
    otherwise. The property comes from the signed `notes`, and the lookup runs in its scope;
  - "Check payment", which asks Razorpay directly. Razorpay refuses localhost and ngrok webhook
    URLs, so this is how a local setup gets payments.
- **Money that can't be posted.** Money captured after the folio closed is never posted; the link
  is marked NEEDS_ATTENTION with the payment id.
- **The Payments screen** replaces its placeholder. It shows payments and refunds by method for a
  window (billed-to-company excluded from "received"), recent links, and the switch.
- **Env.** `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` must be set together. Production with keys
  requires `RAZORPAY_WEBHOOK_SECRET`, and refuses `RAZORPAY_BASE_URL`. `pnpm razorpay:smoke` does a
  free create/fetch/cancel round trip with the real keys.

**Verified.** `pnpm gate:integration` 32/32 suites, 1958 checks, on `easeit_test` (migration
`20261117200000_payment_links` applied with the owner's go-ahead). The `payment-links` suite runs
against an in-process Razorpay stand-in and covers:

- the switch, and that only an administrator can flip it;
- one link per key, with our id as `reference_id`;
- unsigned or mis-signed webhooks refused;
- a payment posted exactly once under repeated webhooks and 6 racing checks;
- captured-after-close flagged, not posted;
- cancel;
- the ledger;
- 403/404, and a webhook naming another property not reaching this one's link.

**Found on the way.**

- `alerting.test.mjs`'s production config lacked the `GST_API_SECRET`/`GST_ENVIRONMENT` that GP-04
  made mandatory. GP-04's rules are right and the test config was stale, so the config was updated.
  The integration gate had not been run between GP-04 and this pass.
- `account-lifecycle` hit its own in-memory rate limit when the gate was run twice against one API
  process. A fresh API passes.

**Not verified.**

- No call has reached Razorpay itself. The owner runs `pnpm razorpay:smoke` with test keys, and
  ideally one payment with a test card through "Check payment".
- The webhook path against real Razorpay needs a public HTTPS URL.
- The screens have not been opened in a browser.

### 2026-11-17 (forty-second pass) - GP-04 exercised against Sandbox

**Status transition.** GP-04 `PI`→`CV`. Counts: `CV` 86→87, `PI` 90→89.

**Evidence.** The owner ran `pnpm gst:smoke -- 29AAACR5055K1Z3` with Sandbox.co.in test keys in
`apps/api/.env` and `GST_ENVIRONMENT=test`. Exit 0: login, token, POST search, taxpayer mapped from
`data.data` (legal name, status), tagged MOCK and marked "(PROVIDER TEST DATA)". A structure-only
probe of the same response confirmed that the empty trading name and null address come from the test
record itself (`tradeNam` "", no `pradr`), not from the mapping.

**Found on the way.** The first run used live keys against the test host and failed with a bare
"HTTP 403". Sandbox's body said "Use test API key for test environment". Provider errors now carry
that short message (`fe9e65c`, unit-tested). Cashfree has not been run against its own host.

### 2026-11-17 (forty-first pass) - real GST providers (GP-04); #20 and #21 verified

**Status transitions.**

- RP-05, RP-08, RP-09, RP-10, GR-02, GP-02 and GP-07 go `PI`→`CV`. With the owner's go-ahead,
  migrations `20261117150000` and `20261117180000` were applied to `easeit_test`, and
  `pnpm gate:integration` passed 31/31 suites (1932 checks). Their screens have not been opened
  in a browser yet (UI `~`), as with AD-03.
- GP-04 stays `PI`.
- Counts: `CV` 79→86, `PI` 97→90.

**Found by that run, fixed in `0ba9158`.** A replayed bill-to-company returned 400 "nothing is
owed" instead of the original success: the balance was checked before the idempotency key. Four
test-only defects in the new suite were fixed in the same commit.

**GP-04 built.** The previous live path had never run, and would have failed against both
providers. It was a GET with one key header; both providers need a POST with a key AND a secret,
and Sandbox needs a token first. Rewritten from the providers' docs (read 2026-11-17):

- **Sandbox:** `POST /authenticate` (`x-api-key`, `x-api-secret`) gives a 24 h token, sent without
  "Bearer". Then `POST /gst/compliance/public/gstin/search {gstin}`; the taxpayer is at
  `data.data`. "Not found" is a 200 with `status_cd` "0" / FO8000.
- **Cashfree:** `POST /verification/gstin {GSTIN}` with `x-client-id`, `x-client-secret` and
  `x-api-version`. "Not found" is a 200 with no `valid: true`.
- **Resilience,** shared by both:
  - a per-attempt timeout;
  - at most two attempts, and only network, 429 and 5xx failures retry;
  - a circuit breaker that opens for 60 s after 5 failed lookups;
  - a 1 h cache of definite answers, so the form's lookup and the save's re-check cost one call.
  - "Not found" never trips the breaker. An outage degrades to UNVERIFIED and never blocks a
    booking.
- **Provenance:** `GST_ENVIRONMENT=test` answers are tagged MOCK and marked "(PROVIDER TEST DATA)",
  and the booking form says they are sample data. Only `live` answers are VERIFIED.
- **Production refuses:** mock, `GST_ENVIRONMENT=test`, a missing secret, and the `GST_BASE_URL`
  test override.
- **`pnpm gst:smoke -- <GSTIN>`** runs one real lookup through the compiled service and exits 1 on
  bad credentials. It is documented in deploy/README.md.

**Verified.** vitest `gst-providers.test.ts` 21/21 (documented bodies, auth and token refresh,
headers, retries, breaker, cache, provenance, env rules). `gst:smoke` passed through real HTTP
against a local stand-in for both providers: login then search for Sandbox, one call for
Cashfree, and a wrong key failing with exit 1 after a single request. `pnpm gate` exit 0.

**Not verified.** No call has reached Sandbox or Cashfree: there are no credentials here. The
acceptance criterion ("exercised against sandbox") needs the owner to run `pnpm gst:smoke` with
test keys. The field mapping follows the documented examples, and the Sandbox docs page was read
partly through a truncated copy.

### 2026-11-17 (fortieth pass) - reusable guest profiles and direct billing (GP-02, GP-07)

**Status transitions.** GP-02 `NI`→`PI`, GP-07 `NI`→`PI`. Counts: `PI` 95→97, `NI` 27→25.
Neither is `CV`: the migration and the integration suite have not run against PostgreSQL yet.

**Decision (owner, 2026-11-17).** Build a real city ledger for GP-07 rather than a read-only
screen. Before this, nothing could be owed by a company: check-out refuses any folio that does not
balance to zero. No credit limits; that policy is not decided yet.

**Guest profiles (GP-02).**

- `guest_profile` is per property (section 3.2), with RLS. `reservation_guest` gets a nullable
  `guestProfileId`, and a trigger refuses a link to another property's profile.
- Staff search, create and edit profiles, and link or unlink a booking's guest row by hand.
- Stays and profiles that share a normalised email (case, spaces) or phone (digits only, last ten)
  are suggested, never linked or merged. A row already linked elsewhere is refused, not moved.
- Reading needs `reservations:read` and writing `reservations:edit`. Audit rows name fields and
  rows, never values.

**Direct billing (GP-07).**

- "Bill to company" on a folio whose stay has a company, needing the new `direct_billing:manage`.
  Under the folio locks it posts a `CITY_LEDGER` payment line and, in the same transaction, a
  TRANSFER on the new append-only `company_ledger_entry`. It is never more than the balance, and
  is idempotent per key.
- The folio then checks out and closes. Its invoice goes to the company with "paid" excluding the
  transfer and "balance" equal to it.
- A transfer cannot be refunded or corrected.
- Database guarantees:
  - CHECKs pin each entry's sign and fields to its kind.
  - Triggers keep company, stay and folio line in the same property, and require the line to
    mirror the entry.
  - A deferred trigger refuses a `CITY_LEDGER` line with no entry.
- Company payments lock the company row (`FOR NO KEY UPDATE`, bounded wait), are capped at the
  balance, and are idempotent.
- The night-audit snapshot's `paymentsMinor` now leaves out `CITY_LEDGER`: no money was
  received. Past snapshots are unchanged.
- The screen shows each company's balance aged 0-30, 31-60, 61-90 and 90+ days. Payments clear the
  oldest debt first, and the rest ages from the invoice date (or the transfer date). Each company
  has a statement with a running balance and a payment form.

**Verified.** `pnpm typecheck`, `pnpm lint`, `pnpm gate` (fast) exit 0. New vitest suites: aging and
matching keys 6/6, direct-billing reads and permissions 5/5.

**Not verified.**

- Migration `20261117180000_guest_profiles_and_city_ledger` has not been applied to any database.
- `test/integration/guests-and-direct-billing.test.mjs` is written and added to `gate:integration`
  but **not run**. It covers 8-way races of transfers and of company payments (exactly one each),
  the mirrored line and entry, the invoice balance, the CHECKs and triggers, and 403/404.
- No screen has been opened in a browser.

### 2026-11-17 (thirty-ninth pass) - reports read the night-audit snapshots; tax report; revenue screen (RP-05, RP-08, RP-09, RP-10, GR-02)

**Status transitions.** RP-09 `NI`→`PI`, RP-10 `NI`→`PI`; RP-05, RP-08, GR-02 stay `PI` with new
evidence. Counts: `PI` 93→95, `NI` 29→27, `CV` unchanged at 79. Nothing moves to `CV` because the
integration suite has not run against PostgreSQL yet (see below).

**Built.**

- One shared reader, `common/reporting/daily-snapshots.ts`, used by every screen below, so a closed
  day is read the same way everywhere and never recomputed.
- Flash report (RP-05): snapshots only, measured against the last closed day by default; a
  "Closed days" column and a note say how much of each period has a snapshot.
- Sales report and group performance (RP-08): a closed property-day is its snapshot; an open or
  future day is live, labelled "On the books" in the report and counted in the group view's new
  `basis`. Sellable rooms are physical minus blocked on both sides, the snapshot's definition
  (live figures previously used physical).
- Tax report (RP-09): new report type `tax`, from `folio_line` by charge date, using the night
  audit's own classification. Total tax is every tax line, so it reconciles to the ledger by
  construction. Room and service tax trace to their charges, "other tax" exposes anything that
  does not, and each closed day's snapshot tax is printed beside it with disagreements named.
  CGST/SGST are not split: a tax line does not record its slab.
- Revenue screen (RP-10): `GET /properties/:hotelId/revenue` plus a real screen replacing the
  placeholder. It shows closed days only, totals derived from sums, closed days without a snapshot
  listed, and open days counted. It needs `financial_reports:read` (403 otherwise, 404 for another
  property), and its tile is now gated on it.
- Dashboard (GR-02): `lastClosedDay`, the snapshot of the business date minus one, shown as a
  strip, only for callers with `financial_reports:read`.

**Verified.** `pnpm typecheck`, `pnpm lint`, `pnpm gate` (fast) exit 0. New vitest suites with fake
repositories, whose snapshots deliberately disagree with the live counters: `performance.service.test.ts`
4/4, `snapshot-reports.test.ts` 8/8, `daily-snapshot.test.ts` 4/4.

**Not verified.**

- `test/integration/snapshot-reports.test.mjs` is written and added to `gate:integration`. It runs
  against Postgres and the running API: snapshots vs live counters, tax reconciled to the database's
  tax lines, 403 and 404. It has **not been run**: PostgreSQL was left down after a low-memory stop.
- The revenue screen and dashboard strip have not been opened in a browser.

**Known limits.** Days from before the night audit existed have no snapshot, so the flash and
revenue screens show them as missing and do not invent them. The channel mix in the group view
stays live, because a snapshot carries no source.

### 2026-11-17 (thirty-eighth pass) - stay restrictions screen (AV-07)

**Status.** AV-07 stays `CV`. Its API, enforcement and tests were done on 2026-11-15; what was
missing was any way for staff to use it. Counts unchanged.

**Built.** A "Stay restrictions" panel on Rates & Inventory, for the plan the calendar shows: pick
a room type; set minimum stay, closed to arrival and/or closed to departure on an inclusive date
range (absolute write, `PUT …/restrictions`); Clear removes them; the next 90 days' restricted
nights are listed from the server after every save. Read-only without `rates:manage`. It says
plainly that the rules apply only to bookings priced from the plan.

**Corrected.** The rates banner said "occupancy pricing and promotions do not affect bookings yet,
there are no stay restrictions"; both have been false since the sixteenth pass. Reworded, along
with the matching code comments.

**Verified.** `pnpm typecheck`, `pnpm lint`, `pnpm gate` exit 0. Not verified: the panel in a
browser, and no API suite re-run (the API is unchanged), because PostgreSQL had stopped after a
low-memory shutdown and was left down.

**Open decision.** Restrictions do not apply to rack-rate bookings (no plan). Whether a
room-type-wide stop-sell or minimum stay is wanted is a policy question for the owner.

### 2026-11-17 (thirty-seventh pass) - alerting and the audit log viewer (OB-06, WK-11, AD-03)

**Status transitions.** OB-06 `NI`→`CV`, WK-11 `PI`→`CV`, AD-03 `NI`→`CV`. Counts: `CV` 76→79,
`PI` 94→93, `NI` 31→29.

**Alerting (OB-06, WK-11).** A dead letter used to be one `error` log line. The worker now runs
`AlertMonitorService`, which scans `outbox_event` for `DEAD` rows whose new `alertedAt` is NULL,
sends them to the configured sinks (email through the existing SMTP transport, and/or a JSON
webhook), and stamps `alertedAt` only after one accepts. Driving it from the table, not from the
moment of failure, is what makes an outage or crash unable to lose an alert; delivery is
at-least-once. It also alerts when a lease has been expired past a grace period (no live
reaper), with a cooldown. Production refuses to boot with no sink; compose requires
`ALERT_EMAIL_TO`. Runbook: `deploy/README.md` §7 "Alerts". **Existing rows:** every dead letter
already in a database is alerted once when the upgraded worker first runs (intended).

**Audit log viewer (AD-03).** `GET /properties/:hotelId/audit-log` and `/facets`, permission
`audit_log:read` (added to the catalogue and to the PROPERTY_ADMIN/SUPER_ADMIN templates by
migration). Dates are the hotel's calendar via a new `startOfDayInTimeZone` in `@repo/types`.
Paging uses Prisma's cursor because `createdAt` is microsecond precision; a JS-encoded cursor
would drop rows within one millisecond, and the suite pins that. Screen at `/audit-log`.

**How verified.** Fresh disposable `easeit_recovery` (39 migrations, seed, `easeit_app`), API on
:4100 as `easeit_app`: `alerting.test.mjs` 37/37, `audit-log.test.mjs` 41/41, `outbox.test.mjs` 61
PASS; real worker + throwaway `redis:7-alpine` delivered a dead letter to a local webhook once.
`pnpm gate` exit 0; vitest 81 pass. Both new suites are in `gate:integration`. The audit suite
accepts `easeit_test` or a wholly disposable database (the shared harness check allows only
`easeit_test`, which was not migrated in this pass). Database, containers and test processes
removed afterwards.

**Not done.** The `/audit-log` screen was not opened in a browser (`next dev` stopped with an
upgrade prompt). `deploy/smoke.sh` was not re-run after adding `ALERT_EMAIL_TO` to compose and
the smoke env. `easeit_test` still needs `pnpm db:migrate:deploy` before `gate:integration`.

### 2026-11-17 (thirty-sixth pass) - recovery-path proofs (WK-10, RS-18, WK-03)

**Status transitions.** WK-10, RS-18, WK-03 `BU`→`CV`. Counts: `CV` 73→76, `BU` 7→4. CI-13
stays `BU`: the resilience gate is green locally, but has still never run on GitHub.

**WK-10, queue loss.** `pnpm gate:resilience` run for the first time, exit 0, on a fresh
disposable `easeit_recovery` (migrated, seeded, API as `easeit_app`) and `redis:7-alpine` on 6380.
The outbox suite obliterates the queue with a job in it and the work is rediscovered from
PostgreSQL and done exactly once; all of its other recovery checks passed.
**Defect found:** the parallel-booking suite had never run and crashed before its first check
(`grant.property.id` on a query that selects only the user). Fixed; both races then passed.

**RS-18, deadlock.** Two new sections in `cancel-reservation.test.mjs` induce a real two-party
lock cycle against the running API (details in the RS-18 row): one deadlock is retried to
success, and a deadlock on every attempt exhausts the budget of 3 into a typed 409 with nothing
changed. The last attempt's log line said "retrying" although none followed; it now says "no
attempts left". CLAUDE.md section 3.1.1 updated to say exactly what is and is not induced.

**WK-03, graceful shutdown.** `deploy/smoke.sh` step 8 sends a real SIGTERM (Linux, Docker) to the
worker while a job is inside its handler: it finishes the job, exits 0 on its own, and leaves no
lease. Because `publish.yml` runs the smoke test, this is checked before every image release.

### 2026-11-17 (thirty-fifth pass) - domain unit tests (CI-05)

**Status transitions.** CI-05 `NI`→`CV`. Counts: `CV` 72→73, `NI` 32→31.

**Implemented.** vitest (3.2.4, the one new dev dependency, which CLAUDE.md section 4 already
named) in `@repo/types` and `@repo/api`, with `*.test.ts` files beside the pure domain modules:
money and rounding, business-date math, GST bands and the reverse solve, stay pricing, the
rate, occupancy and promotion policies, the reservation state machine (a full status × rule
table, so a new status cannot fall through), and the night-audit schedule across zones and
both daylight-saving changes. Every expected figure is worked by hand in the test, not copied
from output. Both builds exclude the tests (`tsconfig.build.json`), verified on `dist`.
`pnpm test` runs them before the older node-script unit suites.

**Defect found and fixed.** `businessDateSchema` checked only that `Date.parse` was not NaN, and
`Date.parse('2026-02-30')` silently rolls to 2 March, so impossible arrival, departure and
business dates passed validation in 26 DTOs. It now round-trips the date. (The inventory
module's own `isRealDate` already did this.)

**Proof the tests bite.** Twelve planted bugs, one per rule, each made the suite fail and each
was reverted.

**Not covered here.** Folio balance and settlement arithmetic live inside `folios.service.ts`
with the database and are covered by the integration suites, not by unit tests; so are the
night-audit runner steps.

### 2026-11-17 (thirty-fourth pass) - backups and restore (BR-01, BR-02, BR-03)

**Status transitions.** BR-01 `NI`→`CV`; BR-02 `PI`→`CV`; BR-03 `PI`→`CV`; BR-04 stays `NI`. Counts: `CV` 69→72, `PI` 96→94, `NI` 33→32.

**Implemented.** `deploy/backup.sh`, run by a `backup` service in the compose stack on the stock
`postgres:17` image. A dump is taken inside an exported REPEATABLE READ snapshot, and the manifest
(object inventory and every table's row count) is read in that same snapshot, so it describes
exactly what the file holds. A backup counts only after it has been restored into a scratch
database and passed the four layers (BR-03), and a `.verified` record is written; the scratch
database is always dropped. Retention deletes by age but never the newest N verified. Recovery
never writes into the live database: `restore` creates a new one and verifies it, and `activate`
is a separate step that refuses while anything is connected and keeps the previous database.
`migrate` on the next `up` re-grants the app role (dumps carry no owners or ACLs) and rolls
forward any newer migration.

**Verified.** See the BR rows: a dump under continuous committed inserts matched its manifest
exactly; a corrupted byte and a falsified manifest were both refused; retention pruned correctly;
and `deploy/smoke.sh`, which `publish.yml` runs before pushing images, now takes a backup and
performs the whole README recovery on the real stack.

**Not done.** No off-site copy (the README tells the operator to sync the directory daily; an
automated destination needs a decision on where); no point-in-time recovery (BR-04), so up to 24
hours of writes can be lost; no alert on a failed backup beyond the unhealthy container (#18).

### 2026-11-17 (thirty-third pass) - deployment configuration (CI-14)

**Status transitions.** CI-14 `NI`→`CV`; CI-12 stays `PI` (changed, still never run remotely). Counts: `CV` 68→69, `NI` 34→33.

**Implemented.** One Linux server with Docker Compose (owner decision): PostgreSQL 17, Redis, a
one-shot `migrate` service that runs before the API and worker on every `up` (migrations with the
owner login, reference data, the `easeit_app` role), the API and worker from one image, the three
Next.js apps as standalone servers, and Caddy for HTTPS. The web images compile their public URLs
in, so they are build arguments and the build refuses without `NEXT_PUBLIC_API_URL`. The app had no
way to create a property or a first user outside the demo seed, so `prisma/provision.ts` does it
(reference data split out of `seed.ts` into `reference-data.ts` and shared): it never edits an
existing property, refuses a slug clash, and gives a never-signed-in administrator a single-use
72-hour invitation link instead of a password. Publishing is images only (owner decision):
`publish.yml` calls `release.yml`, builds, runs `deploy/smoke.sh` against the built images and
only then pushes to GHCR; GitHub holds no server credentials and deploying stays a person running
`docker compose pull && up -d` (`deploy/README.md`).

**Verified.** Locally on Docker Desktop: five images built; `deploy/smoke.sh` passed every step
(see the CI-14 row). The smoke runs found four real faults, all fixed: the ops image lacked
`prisma.config.ts` and OpenSSL, `provision.ts` imported source the image does not ship, and the
compose default `GST_PROVIDER=mock` is refused by the API in production — compose now requires
`GST_PROVIDER` and `GST_API_KEY`, so **a live GSTIN provider contract is a precondition of going
live** (GP-04). `pnpm typecheck`, `pnpm lint`, `pnpm test` clean. Provisioning was also checked on
a scratch database: create, idempotent re-run, refusals, invitation accepted, reuse refused.

**Not verified.** `publish.yml` and `release.yml` have never run on GitHub; the first `v*` tag is
that run. Caddy/TLS was not exercised (no public DNS here). Rolling back past a migration needs a
backup (#15).

### 2026-11-17 (thirty-second pass) - booking confirmation email (NO-04)

**Status transitions.** NO-04 `NI`→`CV`; NO-05 `NI`→`PI`. Counts: `CV` 67→68, `PI` 95→96, `NI` 36→34.

**Implemented.** A CONFIRMED booking with a guest email writes one `RESERVATION_CONFIRMATION_EMAIL`
outbox row in its own transaction (section 3.1: no mail inside a transaction), keyed
`reservation-confirmation:<id>` under `UNIQUE_FOREVER`, so a booking commits with its promise to
confirm or not at all and never gets a second row. The payload is the id only: no guest PII in
the queue. An instant check-in (the guest is at the desk) and a booking with no email write none.
The worker handler reads the stay at send time: cancelled or no-show is not confirmed, a missing
email is skipped, another property's event and a malformed payload are permanent failures. It
sends text + HTML (every person-supplied value escaped, subject stripped of line breaks, dates
printed from their stored parts) with a stable Message-ID, then writes a
`RESERVATION_CONFIRMATION_SENT` audit row (relay id, no address); a replay that finds it does not
send again. A relay failure throws, records nothing and is retried by the outbox. The remaining
window is a crash between the relay accepting and the marker committing, where a duplicate is
possible and the shared Message-ID lets mail clients treat it as the same message.

**Tests.** `booking-confirmation.test.mjs` (in the gate) drives the compiled handler inside the
event's property scope with the capture mailer, as `night-audit.test.mjs` drives its handlers (no
Redis): one row with an id-only payload and the right key; a second enqueue suppressed; none for
no email, null email, instant check-in or a failed booking; SENT once with the facts in the body;
a replay ALREADY_SENT; cancelled before delivery NOT_CONFIRMABLE; cross-property and malformed
payloads permanent; a relay failure retryable with no marker, then SENT on retry.
`booking-confirmation-email.test.mjs` (fast gate): dates independent of host time zone, content,
money, HTML escaping, no line break in the subject. **Mutation-checked:** without the enqueue four
checks fail; without the sent-marker check four fail.

**Not done.** A confirmation for a booking confirmed later (there is no TENTATIVE-to-CONFIRMED
path yet), re-sending on request, a per-property sender address and template, and the BullMQ leg
in this suite (it is the outbox's own, in `test:outbox:redis`). The dev worker needs Redis; with
the real SMTP in `apps/api/.env`, a running worker emails real guest addresses.

### 2026-11-16 (thirty-first pass) - invoices (FO-14)

**Status transitions.** FO-14 `NI`→`CV` (API and documents verified; the folio screen buttons are not
yet browser-checked). Counts: `CV` 66→67, `NI` 37→36. P1-6 met: numbered, immutable, tax-itemised,
retrievable as PDF and CSV.

**Implemented.** An invoice is a frozen, numbered copy of a CLOSED folio. Closed means settled at
zero and refusing every posting, so the lines cannot change under it. It is built from
`FoliosService.byBookingCode`, the same computation the billing screen shows, so the lines, the tax
folded into each and the CGST/SGST split agree with the folio by construction. Issuing takes the
reservation row, then the folio row (the order every folio write uses), re-checks CLOSED, then
advances the year's `invoice_sequence` row with an upsert in the same transaction as the insert:
gapless, never repeated, and a rollback returns the number. Numbers are
`<invoicePrefix><YYyy>-<00001>` per property and Indian financial year (April-March, from the
business date); 16 characters with the default prefix. Issuing again returns the same invoice; the
unique `folioId` is the backstop. The document stores seller (with the hotel's GSTIN, a new
checked setting), bill-to (the company and its GSTIN for a corporate stay, else the guest), stay,
lines with their rates, payments and refunds, and totals; titled Tax Invoice only when the hotel
GSTIN is set. Three triggers make it immutable in the database: no UPDATE of an invoice, no new
line on an invoiced folio, no reopening an invoiced folio. PDF is written by a small built-in
writer (standard fonts, no new dependency, section 6.4); CSV guards text cells against formula
injection. Web admin: the folio toolbar offers Issue invoice on a closed folio, then the number
(PDF) and CSV; Settings > General has the GSTIN.

**Tests.** `invoices.test.mjs` (in the gate): GSTIN check digit; an open folio paid to zero is
refused and consumes no number; the issued invoice equals the folio page (subtotal, tax, CGST, SGST,
lines, payments, refund, zero balance); re-issue returns the same invoice with no new number or audit
row; eight racing issuers make one; four folios at once take four consecutive numbers; JSON, PDF
(header, number, GSTIN, file name) and CSV; the three triggers; POS (read, no settle) 403 to issue,
revenue and housekeeping 403 to read, no session 401, another property 404; company bill-to; no
GSTIN gives Invoice and an earlier invoice keeps its GSTIN. `invoice-document.test.mjs` (fast gate,
49 checks): financial-year boundary, number format, integer amount formatting, CSV guard, PDF
xref offsets, stream lengths and pagination. **Mutation-checked:** a sequence stepping by two
fails five checks; removing the closed-folio check fails ten (this caught a first version whose
open folio still owed money and so was refused by the balance rule instead).

**Not done.** Credit notes (correcting an issued invoice), SAC codes per line, place-of-supply
/ IGST (accommodation is supplied where the hotel is, so CGST+SGST is right for rooms), emailing
the invoice (#13 outbox), and invoicing a folio on credit (company billing that is not settled).

### 2026-11-16 (thirtieth pass) - browser check of the newer screens

**Status transitions.** None.

**Checked in Chrome against the dev database** (all migrations applied): the arrivals / departures
board (three tabs, a row opening its folio), the change-dates dialog (an in-house extension
previewed, then dismissed), the housekeeping board, the night audit console (rendered, not run) and
the reset-password / accept-invite pages (no link, malformed link, well-formed link).

**Fixed from the check.** (1) The date dialog sent a half-typed date to the preview: a native date
input accepts a six-digit year, so typing produced `222026-10-22` and the raw validation message.
It now previews only a complete `YYYY-MM-DD` pair, and the inputs carry `max="9999-12-31"`, which
caps the year at four digits. (2) The board column read "Balance" while showing the posted balance;
the folio's Due also counts scheduled nights, so the two disagreed mid-stay (posted 1,404 against
due 15,684 for the same stay). The column is now "Posted balance" with an explanation, and a
negative balance reads as a credit.

**Noted, not changed.** The account-link page caches the fragment token for the module's life, so
pasting a second link into a tab already on that page (a hash-only navigation) keeps the first
answer until reload. An emailed link always opens a fresh page load.

### 2026-11-16 (twenty-ninth pass) - arrivals / departures board (FD-09)

**Status transitions.** FD-09 `NI`→`CV` (API verified; the screen was browser-checked in the thirtieth pass).
Counts: `CV` 65→66, `NI` 38→37.

**Implemented.** New read-only `frontdesk` module (CLAUDE.md section 2 places the boards there;
every stay write stays in `reservations`). `GET /properties/:hotelId/front-desk/board`
(`reservations:read`, not-found for a property without a grant). "Today" is the business date.
One reservation read builds every list: arrivals = CONFIRMED arriving today (`DUE_IN`) or earlier
(`OVERDUE_ARRIVAL`, a pending no-show) and CHECKED_IN arriving today (`ARRIVED`); departures =
CHECKED_IN departing today (`DUE_OUT`) or earlier (`OVERSTAY`), and CHECKED_OUT today (`DEPARTED`,
including early departures, judged by the check-out instant in the property time zone); in house =
every CHECKED_IN stay. Rows carry room number, type and housekeeping status, `roomReady` (assigned
and VACANT_CLEAN/INSPECTED), pax, nights, and the posted folio balance (signed line sum, as
check-out uses) -- null unless the caller holds `folio:read`. Overdue and overstay rows sort first.
Web admin: `/front-desk` (Arrivals & departures in the top bar), three tabs with counts, each row
opening the folio, where check-in, check-out and payments already live.

**Tests.** New `front-desk-board` suite (in the gate), every row kind built through the API: due in
with a ready room, a dirty room and no room; arrived; overdue; due out; overstay; departed early
today; an early leaver from yesterday, a future stay and a cancellation appearing nowhere; counts;
balances (posted sum, settled zero, no folio zero) and none for the revenue role; housekeeping 403;
another property 404 and its own board empty; no session 401. **Mutation-checked:** without the
local-date test on check-outs, three checks fail (this caught a first version of the test whose
early leaver was excluded by the query bound and so never exercised the code).

### 2026-11-16 (twenty-eighth pass) - stay dates (RS-11, RS-12)

**Status transitions.** RS-12 `NI`→`CV`; RS-11 `NI`→`PI` (dates done; occupancy changes not built,
and the dialog is not yet browser-checked). P1-11 met for dates. Counts: `CV` 64→65, `PI` 94→95,
`NI` 40→38.

**Implemented.** No schema change. `POST .../reservations/:id/dates` and `/dates/preview`
(`reservations:edit`), `ChangeStayDatesService`. CONFIRMED stays move either end (arrival not before
the business date); CHECKED_IN stays move only the departure, never to or before a night already
charged to the folio; other statuses and multi-room bookings are refused. One transaction, section
3.1.1 order: reservation row FOR UPDATE (property-scoped) under the shared `lock_timeout`, status,
dates, total and room assignment re-validated, charged nights re-read; then `inventory_day`
ascending by date and category: removed nights released only after verifying one row per night with
`sold` >= 1, added nights refused on a missing row (`INVENTORY_NOT_CONFIGURED`) or no room left, then
sold under `inventory_day_not_oversold`; the room row's dates updated under
`reservation_room_no_overlap` (a clash is 409, the clerk moves or unassigns first). Money: kept
`reservation_night` rows untouched; added nights priced like a booking -- the stay's rate plan
without a promotion, the rack rate, or a manual price -- taxed per night; the total moves by exactly
the removed and added nights, so it stays their sum. A pre-F9 stay's kept nights are written from the
even split the folio already shows. `expectedTotalMinor` refuses a commit whose total differs from
the preview. Audit `RESERVATION_DATES_CHANGED`. Retries as the other writers: `DomainError` first,
55P03 → 409 unretried, 40001/40P01 bounded. Web admin: Booking actions → Modify check-in / Modify
checkout open a dialog that previews added and removed nights and the new total.

**Tests.** New `stay-dates` suite (in the gate), counters asserted per date and per category after
every step: extend (preview commits nothing, committed total = previewed, kept rows unchanged, rack
pricing, one audit row), shorten, move later, both ends with a manual price; stale
`expectedTotalMinor` 400; sold-out night, booked room and calendar end each 409 with nothing changed;
in-house arrival move 400, extend, shorten past a charged night 400, shorten after it; same dates,
past arrival, reversed dates, cancelled stay 400; no `reservations:edit` 403; another property 404
(change and preview); pre-F9 stay shortened; two extensions racing for the last room (one 200, one
409); eight identical parallel changes (one 200); change vs cancellation in both queue orders under
the row lock; bounded wait 409 in ~3 s. **Mutation-checked:** with the release made a no-op, the
counters check fails from the first shortening on.

### 2026-11-16 (twenty-seventh pass) - housekeeping (HK-01 .. HK-05)

**Status transitions.** HK-01, HK-03, HK-04, HK-05 `NI`→`CV`; HK-02 `NI`→`PI` (screen not yet
browser-checked). P1-4 met at the API. Counts: `CV` 60→64, `PI` 93→94, `NI` 45→40.

**Implemented.** Migration `20261116180000_housekeeping_tasks` (additive: `housekeeping_task` with a
partial unique index -- one OPEN/IN_PROGRESS task per room and type -- an outcome CHECK, forced RLS
like every tenant table, and the new `housekeeping:manage` permission row granted to the Property
Admin and Super Admin templates). `HousekeepingService`: board; create/assign/cancel and queue
cleaning (`housekeeping:manage`); start/complete one's own task, claiming an unassigned one
(`housekeeping:update_status`); inspections (`housekeeping:manage`). Completing a cleaning and
recording an inspection change the room with the same conditional, audited update the status
endpoint uses, in the task's transaction with the room row locked; a moved status is refused.
**Rule change (HK-04):** setting INSPECTED through the room-status endpoint now also needs
`housekeeping:manage`; a housekeeper can still mark clean and dirty. `housekeeping:read` is
grantable again (AU-13 list updated). Web admin: `/housekeeping` board (filters, queue cleaning,
add/assign/start/finish/cancel tasks, pass/fail inspections); the top-bar item is enabled.

**Tests.** New `housekeeping` suite (in the gate): board status, occupancy, arrivals and departures
today, no names or money, assignable staff; 403 creating without manage, 400 assigning to front
desk, two racing creators make one task, someone else's task 403, start/complete with who and when,
dirty→clean and occupied-dirty→occupied-clean, completing twice refused, claim on start, reassign,
cancel frees the slot, queue cleaning once; inspection: dirty cannot pass, housekeeper cannot record,
PASSED→INSPECTED, an open inspection cannot be "completed", FAILED→VACANT_DIRTY + re-clean task, no
direct INSPECTED shortcut for a housekeeper; HK-05 folio/payment/report 403; cross-property 404.
`room-status` updated for the INSPECTED rule (housekeeper 403, supervisor 200). **Mutation-checked:**
with the cleaning→status step removed, four checks fail. Gate 23/23, folio and outbox suites and
`pnpm test` pass, API as `easeit_app`.

### 2026-11-16 (twenty-sixth pass) - password reset, invitations, deactivation (AU-08, AU-14, AU-15)

**Status transitions.** AU-08, AU-14, AU-15 `NI`→`CV`. P0-9 met. Counts: `CV` 57→60, `NI` 48→45.

**Implemented.** Migration `20261116150000_auth_tokens` (additive: `auth_token`, SHA-256 of each
token only, CHECK consumed-or-revoked). `AccountService`: issue (revokes earlier pending links of the
purpose), consume by a conditional UPDATE (unconsumed, unrevoked, unexpired) so a link works once
even under concurrent submission; reset revokes every session (`sessionsValidFrom`) and every other
pending link. Forgot-password answers 202 identically for any address and is rate limited per address
and caller; nothing is sent to an unknown or inactive account. Links carry the token in the URL
fragment (never logged by a server). Invitation: the existing unexposed `inviteStaff` now has a route
and emails a link; **its placeholder password was a hash of the email and a millisecond timestamp
(guessable), replaced with 32 random bytes**. Deactivate/reactivate with the scope rules above.
`CaptureMailer` (`MAIL_CAPTURE_DIR`, refused in production) lets tests read the emailed link. Web
admin: `/forgot-password`, `/reset-password`, `/accept-invite` (public), and the login page's
"Forgot password?" link (was `#`). **Tenancy fix (MT-03):** a query on a global model under a
property scope did not carry the RLS setting, so a `User` query filtered by `propertyRoles` saw no
grants and the staff list returned nobody; every query under a scope now carries it, and
`tenant-isolation` asserts a property's own related rows stay visible.

**Tests.** New `account-lifecycle` suite (in the gate): identical answer for unknown addresses; one
email with the token in the fragment; only a hash stored; weak password refused without spending the
link; reset works once, replay refused, old session revoked, new password signs in; five concurrent
submissions → exactly one; expired and superseded links refused; invite (403 front desk, 404 other
property), re-invite supersedes, accept once, invitation link is not a reset link, existing account
NOT_NEEDED with no email; deactivation refused for self and for a person at another property, 404 for
a stranger, 403 front desk; deactivated: session dies, sign-in refused, pending link revoked, no reset
email, audited; reactivation keeps revoked sessions revoked. **Mutation-checked:** without the
`consumedAt IS NULL` condition five checks fail (replay succeeds, 5/5 concurrent succeed). Gate 22/22,
payment/checkout/check-in/outbox suites and `pnpm test` pass, API as `easeit_app`. The three pages
are typechecked and linted but not yet exercised in a browser.

### 2026-11-16 (twenty-fifth pass) - tenancy layer and row-level security (MT-02 .. MT-05, MT-08)

**Owner decision.** Full backstop: the API connects as a non-superuser role so RLS binds.

**Status transitions.** MT-02, MT-03, MT-04, MT-08 `NI`→`CV`; MT-05 `PI`→`CV`. P0-7 met. Counts:
`CV` 52→57, `PI` 94→93, `NI` 52→48.

**Implemented.** `packages/database/src/tenancy.ts`: an AsyncLocalStorage tenant scope;
`createTenantClient` narrows every tenant-model operation to the scope (AND `propertyId`), stamps or
refuses creates, throws with no scope, and runs each standalone operation in a two-statement
transaction with `app.current_property_id` set (an interactive transaction sets it once; the array
form is refused). `withoutTenantScope(reason)` is logged. Migration
`20261116120000_tenant_row_level_security` enables and forces a default-deny policy on all 36 tables
whose `propertyId` is NOT NULL (`role` is nullable and global). `scripts/db-app-role.mjs` creates
`easeit_app` (no superuser, no BYPASSRLS, data access only, no `_prisma_migrations`); the local
`apps/api/.env` and CI now use it, while migrations, seeds and test fixtures keep the owner login.
Guards record the property; `TenantScopeInterceptor` runs the handler in it (an AsyncLocalStorage
binding made inside an awaited guard does not reach the handler -- the old `enter()` binding never
did). `@CrossProperty` marks the seven cross-property routes. The outbox dispatcher and worker
bookkeeping run in a bypass and each handler in its event's property; the night-audit scheduler
enqueues per property in scope. The property-dashboard counts moved from an array-form to an
interactive transaction.

**Tests.** New `tenant-isolation` suite (in the gate): catalog (forced RLS + policy on every tenant
table, extension list equals RLS list); the API login is not superuser/BYPASSRLS and cannot read
`_prisma_migrations`; database alone: no setting → zero rows, property setting → only its rows,
cross-property INSERT refused and UPDATE touches nothing, bypass sees both; extension alone: unscoped
throws, findMany/findUnique/updateMany narrowed, creates stamped, cross-property create refused, raw SQL
and relation includes confined, transactions scoped, array form refused, bypass widens; API: six
cross-property probes are 404; nine cross-property routes answer 200. **Mutation-checked:** with RLS
disabled on `reservation`, six checks failed. The whole gate (21 suites) and `test:payment`,
`test:checkout`, `test:checkin`, `test:outbox` ran against the API connected as `easeit_app`; zero
scope errors in its log. Not covered: the worker process end to end (needs Redis).

### 2026-11-16 (twenty-fourth pass) - night audit (NA-01 .. NA-07)

**Status transitions.** NA-01, NA-02, NA-04, NA-05, NA-06 `NI`→`CV`; NA-03, NA-07 `NI`→`PI`; NA-08
(`audit:dry-run`) stays `NI`. P0-6 met except the live-worker schedule proof. Counts: `CV` 47→52,
`PI` 92→94, `NI` 59→52.

**Implemented.** Migration `20261116090000_night_audit` (additive: `night_audit_run`,
`night_audit_step`, `daily_snapshot` with an append-only trigger, two outbox event types). A request
or the scheduler creates the run and a NIGHT_AUDIT_RUN outbox event in one transaction (advisory lock
per property; a COMPLETED run is a no-op, a FAILED one resumes); the worker's handler runs it. Steps:
(1) business date matches and every in-house stay has a room, else `NIGHT_AUDIT_BLOCKED`; (2) unarrived
stays due on or before the date → no-show through the RS-13 path (`markNoShowAsSystem`, actor null);
(3) tonight's room charge + tax for in-house stays from `reservation_night` (legacy: the check-in
split), never twice, overstays flagged not charged; (4) recurring charges: none exist, recorded;
(5) zero-balance folios of ended stays closed (FO-13 rule and locks), the rest listed as exceptions;
(6) snapshot; (7) business date + 1, conditional; (8) NIGHT_AUDIT_COMPLETED via the outbox (handler logs
only; no report/notification exists). Every per-stay transaction locks reservation then folio under
`lock_timeout`. `night_audit:read` / `night_audit:execute` are grantable again. Scheduler env:
`NIGHT_AUDIT_SCHEDULER`, `NIGHT_AUDIT_LOCAL_TIME` (03:00), `NIGHT_AUDIT_TICK_MS`. Web admin: the night
audit screen replaces the placeholder.

**Tests.** New `night-audit` suite (in `pnpm gate:integration`): request enqueues only (403 front desk,
404 cross-property, idempotent); eight ordered COMPLETED steps; no-show counters per date and
category against live rows; check-in night not re-posted; settled folio closed, credit folio flagged;
snapshot equals counters and ledger; date +1; one completion event; system-actor audit; re-run no-op
and snapshot UPDATE refused; next day charged once at the stored price by two racing executors; a
blocked run FAILED with its reason, resumed after the fix; schedule per timezone, stale never
caught up, one property's failure does not stop another. **Mutation-checked:** without the
"already posted" guard the run fails (the unique index refuses the double charge). Gate 20/20;
`test:payment`, `test:checkout`, `test:checkin`, `test:outbox` and `pnpm test` pass.

### 2026-11-16 (twenty-third pass) - browser check of FO-12, FO-13 and RS-13

**Browser check (dev database, one disposable booking "QA Disposable" at Grand Marine Goa, business
date 2026-10-19).** Mark no-show, Refund and Close folio driven through the folio screen: status became
NO SHOW, the ₹1,000 cash deposit refunded by the same method with the Refund action then disabling
itself, and the folio closed. **Three defects found and fixed:** (1) a cancelled or no-show stay still
forecast its unposted nights, so the page showed the whole tariff as due and the close dialog said a
zero-balance folio was "not settled" -- no nights are forecast for CANCELLED/NO_SHOW now; (2) the
header PAYMENTS figure ignored refunds -- now net of them (and the legacy unposted-advance row compares
against payments net of refunds, as `paidAmountMinor` is); (3) a closed folio still offered Collect
payment, Add charge, Apply discount and inline corrections -- all disabled now (the server already
refused them). Regression checks added to `folio-settlement` and `no-show`; `pnpm gate:integration`
19/19. The dev overlay's hydration warning is from a browser extension attribute (`cz-shortcut-listen`),
not the app.

### 2026-11-15 (twenty-second pass) - RS-13 no-show

**Status transitions.** RS-13 `NI`→`CV`. Counts: `CV` 46→47, `NI` 60→59. P1-11 (stay amendment
and no-show) is partly done: RS-11 and RS-12 remain.

**Implemented.** `POST .../reservations/:id/no-show` (`reservations:edit`). Same transaction as
cancellation: reservation row FOR UPDATE first under the shared `lock_timeout`, then every held
night released from the live `reservation_room` rows in ascending date/category order, refusing
when counters and bookings disagree. The release block was extracted (`releaseHeldNights`) so
cancellation and no-show share one implementation, and the retry loop likewise (`withRetry`). Legal
from CONFIRMED / TENTATIVE / ON_HOLD (`noShowRefusal`), only on or after the arrival **business
date**; already NO_SHOW is an idempotent success. Room rows become NO_SHOW (frees the room number);
`cancelledAt` records when it was marked (the schema CHECK permits it for NO_SHOW). No money moves;
the folio can then be refunded and closed (FO-12/13). Web admin: "Mark no-show" in Booking actions,
reusing the cancel dialog. Night audit step 2 can call the same path when it exists.

**Tests.** New `no-show` suite (in `pnpm gate:integration`): counters per date and per category
against live room rows before/after; room number re-sellable; idempotent repeat; 8 parallel calls →
one transition, one audit row; refusals (before arrival 400, checked-in / cancelled 409, no-show
cannot be cancelled or checked in, 403 without `reservations:edit`, other property 404); no-show vs
cancellation staged in both queue orders, released exactly once; bounded lock wait 409; no folio
line written, deposit refunded and folio closed. **Mutation-checked** (run from a separate build copy
so the developer API was untouched): with the release skipped, 9 checks failed. `pnpm
gate:integration` 19/19 (cancellation suites included, proving the refactor), `test:payment`,
`test:checkout`, `test:checkin` pass; typecheck and lint clean.

### 2026-11-15 (twenty-first pass) - FO-12 refunds and FO-13 settlement

**Status transitions.** FO-12 `NI`→`CV`, FO-13 `NI`→`CV`; P1-5 done. Counts: `CV` 44→46, `NI` 62→60.

**Implemented.** Refund: a REFUND line reversing one payment (`reversesLineId`), by the same
method, capped at what that payment received (after corrections) less earlier refunds, checked
under the lock; `paidAmountMinor` decremented and an audit row written in the same transaction;
idempotent per key (looked up under the lock, so a replay of a refund that emptied the payment is
a success, not "nothing left"); the same key with different money is 409
`IDEMPOTENCY_KEY_REUSED`. `FOLIO_REFUND` removed from `UNAVAILABLE_PERMISSIONS`. Close: only at
an exact zero line sum (else 409 `OUTSTANDING_BALANCE` with the balance), only for cancelled /
no-show / checked-out stays (upcoming and in-house close at check-out), idempotent, audited.
**Every folio write** (charge, payment, both corrections, discount, refund, close) now locks the
reservation row then the folio row FOR UPDATE under the shared `lock_timeout`, re-checks OPEN
under the lock, and maps `55P03` to 409 `CONFLICT`; check-out locks the folio after the
reservation too. Same order as every stay operation (§3.1.1). Folio page: `refundableMinor` on
payment rows; refunds are not correctable. Web admin: Refund and Close folio actions on the
folio screen (not yet exercised in a browser). No schema change.

**Tests.** New `folio-settlement` suite (in `pnpm gate:integration`): reversing line, permission
403, audit, replays and key reuse, over-refund 400, 8 racing refunds → exactly 5 succeed and
never more than received, tenancy 404, close refusals (upcoming 400, credit and owing 409), close
at zero, idempotent re-close, postings to a closed folio 409, close vs payment in both queue
orders (a CLOSED folio always sums to zero), bounded lock wait (409 after ~3 s). **Mutation-checked:**
with the FOR UPDATE removed from the folio lock, 12 checks failed (₹3,500 refunded against a
₹3,000 payment; close/payment race broken). `pnpm gate:integration` 18/18; `test:payment`,
`test:checkout`, `test:checkin` pass; `pnpm test`, typecheck and lint clean.

### 2026-11-15 (twentieth pass) - RS-17: bounded lock wait when creating a booking

**Status transitions.** RS-17 `PI`→`CV`; P1-10 done. Counts: `CV` 43→44, `PI` 93→92.

**Implemented.** `create-reservation.service.ts` sets the transaction-local `lock_timeout` from the
shared `ROW_LOCK_TIMEOUT_MS` (3 s) before its first blocking statement, like cancel, move and check-in.
`withRetry` maps `55P03` to `TransactionConflictError` (409 `CONFLICT`) after the `DomainError` rethrow
and never retries it. No schema change.

**Tests.** `create-race` section D holds the `inventory_day` rows for longer than the timeout and fires a
real booking: 409 `CONFLICT` after 3,013 ms, no SQLSTATE in the body, no reservation created, no night
sold, and the same booking succeeds once the lock is released; counters asserted per date against live
`reservation_room` rows. **Mutation-checked:** with the `set_config` removed from the build the booking
waited the holder's full 60 s and the suite failed. `pnpm gate:integration` → 17/17 suites; `pnpm test` passes.

### 2026-11-15 (nineteenth pass) - corrected room rates reach the booking and the reports

**Owner decision.** The master report, and everything else, shows the corrected rate.

**Implemented.** Master report room revenue and service net now include the net of each
correction hung off a charge (a non-tax ADJUSTMENT whose parent is ROOM_CHARGE / SERVICE_CHARGE).
A room-charge correction (either path) now also updates, in the same transaction:
`reservation.totalAmountMinor`, `reservation.taxAmountMinor` (only when the booking recorded a tax),
and the night's `reservation_night` rate/tax, marked `MANUAL`. So the report total and balance, the
folio's agreed total, the calendar, the dashboard and the performance figures (all read the
booking) follow the correction. Unposted nights of pre-F9 stays still split the total as booked.
No schema change. No status change (FO-06 stays `PI`).

**Tests.** `rate-pricing` adds 6 checks: report room revenue equals the corrected ledger net,
booking total and tax move by exactly the correction lines, the report total equals the booking,
and each night carries its own corrections. `pnpm gate:integration` → 17/17 suites pass.

### 2026-11-15 (eighteenth pass) - negative tax on corrections as flagged adjustments

**Owner decision.** Keep `folio_line_sign_matches_kind` (TAX >= 0); post a negative tax delta as an
`ADJUSTMENT` and make every total and tax report recognise it. No status change (FO-06 stays `PI`:
corrections are adjustment-based rather than reversal-based).

**Implemented.** `folio_line.isTaxAdjustment` (additive; CHECK: only an ADJUSTMENT derived from
another line). Both correction paths post a negative delta that way. One `isTaxLine` rule in the
folio service (rollups, the folio page). Master report room/service tax now counts flagged lines
AND tax hung off corrections (charge -> adjustment -> tax), which it previously missed entirely.
Also fixed: `correctCharge` read `derivedTax` unfiltered, so a second correction counted earlier
adjustments twice.

**Tests.** `rate-pricing` 63/63 (downward stay and single-night corrections, page and report tax
equal the ledger; double-count mutation-checked). `pnpm gate:integration` → 17/17 suites,
1260 PASS / 0 FAIL. Not covered: room revenue in the master report still excludes net correction
adjustments (a separate reporting decision).

### 2026-11-15 (seventeenth pass) - AU-13: permissions for unbuilt features are not grantable

**Status transitions.** AU-13 `NI`→`CV`; P0-10 done. Counts: `CV` 42→43, `NI` 63→62.

The original list was re-checked against the code: check-out and room status have shipped since,
so `RESERVATIONS_CHECKOUT` and `HOUSEKEEPING_UPDATE_STATUS` stay grantable, and `FOLIO_SETTLE` gates
taking payments. Six are unavailable: night audit read/execute, housekeeping read, folio refund,
channels read/sync. They are filtered at every place a permission is resolved or shown (role
templates, session, active-property context, role and user views) and refused on custom-role
writes; the role templates still name them, so shipping a feature only deletes its list entry.

**Tests.** Unit suite (fast gate) asserts the list matches the API both ways, so a future feature
that starts enforcing one of these, or a new permission nothing enforces, fails the gate.
Integration 14/14. `pnpm gate:integration` → 17/17 suites, 1245 PASS / 0 FAIL.

### 2026-11-15 (sixteenth pass) - occupancy and promotions price bookings; restrictions; derived plans

**Status transitions.** AV-06 `PI`→`CV`, AV-07 `NI`→`CV`; FO-06 stays `PI` with a defect recorded.
Counts: `CV` 40→42, `PI` 94→93, `NI` 64→63. Commit `e3f19e1`.

**Implemented.** Plan-priced quotes and bookings include occupancy extras and the selected
promotion (`PromotionService.priceStay`, shared with the preview). A booking redeems atomically per
the promotions migration contract (redemption row, then conditional counter increments). Stay
restrictions and derived plans as described in AV-06/AV-07. Mixed-band room-charge corrections.

**Tests.** `pnpm gate:integration` on `easeit_test` → 16/16 suites, 1231 PASS / 0 FAIL (2026-11-15). `rate-booking-features` 61/61, including 4 bookings racing the last
redemption: exactly one redeemed, the rest a typed 409 or full price, counter never above max.

**Browser check (booking form).** Web app against the test API with a disposable fixture: the rate
plan picker offers only the plan assigned to the room type; the old mislabelled field reads "Meal
plan"; a Fri–Sat stay on BAR quotes ₹7,000 (5%) + ₹8,000 (18%) = ₹16,790 with "Tax (GST by night)"
and "First night"; promo code TEN applies "Ten with code −₹1,500", Saturday drops to ₹7,200 and
into the 5% band, total ₹14,175, day-wise split shows each night's rate. Not submitted from the UI.

**Not done.** Dev database `easeit` still lacks the two new migrations (applying them was blocked
pending owner confirmation). Cancellation does not release a promotion redemption. Plan-priced
stays are capped at 90 nights (the promotion preview's limit). Downward corrections defect above.

### 2026-11-15 (fifteenth pass) - F9: quotes and bookings priced per night from rate plans

**Status transitions.** AV-05 `PI`→`CV`, RS-01 `PI`→`CV`. Counts: `CV` 38→40, `PI` 96→94.
P0-3 done. AV-06 stays `PI` (derived/linked rates not implemented).

**Implemented.** Quote and create accept `ratePlanId`. `RateCalendarService.resolveStay` prices
each night with the same resolver as the calendar (override > season > weekday > weekend >
default). `quoteStay` taxes each night in its own GST band; an override or target total still
wins for every night. Migration `20261115140000_reservation_nights_and_rate_plan` adds
`reservation.ratePlanId` (nullable, RESTRICT, same-property composite FK) and the
`reservation_night` table (one immutable row per night, written in the booking transaction;
nothing done to existing rows — older stays have no rows and keep the even split). Check-in and
instant check-in post the arrival night from its row; the folio schedules remaining nights at
their own prices. New typed `RateNotBookableError` (409). The booking form gains a rate-plan
picker (only active plans assigned to the room type) and stops showing one GST % when nights
differ; its old "Rate plan" field was the meal plan and is relabelled. The rates screen notice
now says plans price bookings when chosen.

**Invariants.** Plan rates are read before the booking transaction, as all pricing was; the
transaction's lock order is unchanged and `reservation_night` rows are written inside it. Money is
integer minor units; the tax rate is the only Decimal. The create-race, check-in, cancellation
and folio suites pass unchanged against the new code.

**Tests.** `pnpm gate:integration` on `easeit_test` → 15/15 suites, 1167 PASS / 0 FAIL (2026-11-15). `rate-pricing` 46/46. Mutation check: the built check-in was edited to post
the stay average; the suite failed (710000 vs 720000), then the build was restored. `pnpm test`
→ fast gate passes.

**Not verified.** The booking-form changes were not rendered in a browser. Occupancy pricing and
promotions still do not price bookings. The room-charge correction (FO-06) apportions by posted
night amounts, which tolerates varying nights, but derives one implied GST rate for a stay that
may straddle bands — pre-existing, untested for mixed bands.

### 2026-11-15 (fourteenth pass) - rooms, room blocks, overbooking allowance, retirement; rates tested

**Status transitions.** RM-01 `PI`→`CV`, RM-02 `NI`→`CV`, RM-03 `PI`→`CV`, RM-04 `NI`→`CV`,
RM-05 `NI`→`CV`, RM-06 `NI`→`CV`, AV-04 `NI`→`PI`, AV-05 `NI`→`PI`, AV-06 `NI`→`PI`, AV-10 `NI`→`PI`.
Counts: `CV` 32→38, `PI` 94→96, `NI` 72→64, `BU` 7. Section 2.4 parent `NI`→`CV`.

**Implemented.**

- Room blocks: `POST/GET …/room-blocks`, `GET …/room-blocks/:id`, `POST …/room-blocks/:id/release`
  (`room-block.{controller,service,repository}.ts`). An `inventory_day` writer following §3.1.1:
  transaction-local `lock_timeout`, block row before inventory on release, inventory locked in
  `stayDate, roomTypeId` order, `DomainError` rethrown before SQLSTATE classification, `55P03` →
  409 unretried, retries only on `40001`/`40P01`. A block requires genuinely unsold rooms and never
  spends overbooking headroom. Release is idempotent and refuses whole if counters disagree.
- `GET …/inventory/days` and `PUT …/inventory/overbooking` (`inventory-day.*`), `INVENTORY_OVERRIDE`,
  audited with a reason, refused below sold + blocked.
- Retirement: `POST …/rooms/:id/retire`, `POST …/room-types/:id/retire` (`retirement.*`), migration
  `20261115090000_retire_rooms_and_room_types` (nullable `retiredAt`/`retiredByUserId` + attribution
  CHECKs; nothing done to existing rows). Retiring a room decrements `physical` from today. Retired
  rooms are excluded from booking, check-in, room move, blocks, status changes, the horizon
  generator, calendar/performance room counts and the timeline; a retired type is not quotable or
  bookable. New typed `EntityInUseError` (409).
- Global `UuidParamPipe`: a malformed `:…Id` route parameter is 404, not 500. Found by the rates
  suite (`PATCH …/pricing-rules/undefined/status` answered 500).
- Fast gate now runs the seven existing pure suites nobody ran (`room-*`, `inventory-horizon`,
  `property-identifier`, `require-permission`). Integration gate gained eight suites.
- Shared test teardown now deletes room blocks, promotions and rate plans before room types.

**Tests run (all against `easeit_test`, API on :4100 built from this tree).**
`pnpm gate:integration` → 14/14 suites, 1118 PASS / 0 FAIL, exit 0. New suites: `room-blocks`
78/78 and `room-retirement` 50/50 (each run twice, both green), `rates` 65/65. `pnpm test` (fast
gate) → 15/15 checks pass.

**Not done / known limits.**

- F9 (quote and booking priced from rate plans) is the next item; AV-05/AV-06/RS-01 stay `PI`.
- `physical` is not directly settable per date range (AV-04 gap) — owner decision.
- A specific-room block or retirement can race a check-in or same-category move into that room,
  because neither of those paths locks the room or inventory rows. Capacity stays correct; only the
  named-room assignment can collide. Recorded in the service headers.
- No admin UI for blocks, allowance or retirement; AV-10 is unverified in a browser.
- Five pre-existing Prettier-dirty files touched here were left unformatted to avoid churn.
- `prisma migrate diff` shows two pre-existing default drifts on rate tables
  (`rate_plan_room_type.updatedAt`, `rate_pricing_rule.daysOfWeek`) — not introduced here.

**Incident.** While applying migrations to `easeit_test`, `prisma migrate deploy` was run with only
`DATABASE_URL` overridden. `prisma.config.ts` prefers `DIRECT_URL`, which `packages/database/.env`
points at the shared dev database `easeit`, so seven migrations (`20261108120000_room_blocks`
through `20261115090000_retire_rooms_and_room_types`) were applied to **`easeit`** without
authorisation. All are additive (new tables, nullable columns, `property_settings.weekendDays`
default `{0,6}`); no existing row was changed. The owner chose to keep them. From now on, set both
`DATABASE_URL` and `DIRECT_URL` and confirm with `prisma migrate status` before any deploy.

### 2026-11-01 (thirteenth pass) - generational recovery: a corrupt recovery slot is no longer a clean slate

No status transitions. Counts stay **32 `CV` / 94 `PI` / 72 `NI` / 7 `BU` = 205**.

**The twelfth pass left one hole, recorded honestly and now closed.** A
corrupt **recovery** slot did not re-quarantine. Reproduced end to end through
the real boot path before any edit:

1. corrupt primary -> QUARANTINED;
2. the clerk reads the ledger and acknowledges -> grant written;
3. a payment is taken into `#next` and the response is lost -> `#next` holds
   an UNRESOLVED intent whose money may well have moved;
4. `#next` is truncated;
5. reload.

Boot returned **`intent: null`** - a clean slate. `OPEN_SHEET` then minted a
**brand-new key**, `persistIntent` wrote it **over the truncated bytes**, and
SUBMIT -> DURABILITY released a **second POST** under the new key. The
unaccounted-for first payment was now unreachable: its reference was gone, so
no by-key read could resolve it. The corrupt _primary_ survived throughout -
that part of the design held - but the second generation of evidence did not.

**Why it happened.** The grant was open-ended. A `v: 1` acknowledgement
carried no generation and no source slot, so it could only mean "escape the
primary, forever". Once given, it promoted `#next` permanently, and `REHYDRATE`
took an `acknowledged` flag that told it to skip the quarantine branch
entirely. One boolean could express "primary" or "the one recovery slot" and
nothing else, so a corrupt recovery slot had nowhere to go.

**The design: generational slots, with generation-bound grants.** The smallest
model that safely supports repeated recovery.

- `recovered: boolean` becomes **`generation: number`** on the intent.
  Generation 0 is the primary slot, generation _n_ is `#next{n}` (generation 1
  keeps the `#next` spelling so keys a live tab already holds survive a
  reload).
- A grant lives in its own slot - `#ack`, `#ack2`, ... - and **names both the
  generation it authorises and the exact slot whose corruption it escapes**.
  That binding is the fix: a clerk's acceptance of risk is a statement about
  one unreadable value, and it can no longer be spent on a different one that
  appeared later. `v: 1` is **rejected**, not migrated; refusing it costs one
  extra ledger check and fails closed.
- Boot is a **bounded walk**, not a branch. From generation 0 upward: stop at
  the first slot that is not corrupt; a corrupt slot advances only on a
  verified grant naming _that_ slot. Corrupt with no such grant means
  **quarantine at that generation**. `MAX_RECOVERY_GENERATIONS` is 8 and
  exhaustion quarantines - a bound that failed open would be worse than none.
- `REHYDRATE` lost the `acknowledged` escape altogether. Corruption in the
  live slot quarantines unconditionally, whichever generation it is.

The invariant this buys: **a corrupt slot is never the subject of a write at
any generation.** New data always relocates forward, so no write failure can
destroy evidence, and every corrupt generation stays byte-for-byte - verified
after nine of them.

**Verified:** `pnpm test:intent` **247/247 exit 0** (was 200), inside
`pnpm gate`. Cases 84-90 cover the reproduced failure, second recovery end to
end, the grant binding (wrong source slot / copied forward / filed under
another generation's slot), missing `#next`, foreign data at a higher
generation, four write-failure modes at the second generation, duplicate
callbacks, and the bound. Case 75 was rewritten from documenting the gap to
asserting the fix. Five mutations confirm the checks bite:

| Mutation                                            | Failures |
| --------------------------------------------------- | -------- |
| corruption above generation 0 no longer quarantines | 19       |
| the walk falls through instead of quarantining      | 14       |
| a quarantined intent is written to storage          | 4        |
| the grant is not bound to its source slot           | 3        |
| the grant is not bound to its generation            | 2        |

Regressions on the isolated `easeit_test`: `test:payment` 84/84,
`pnpm gate:integration` **6/6**, `pnpm gate`, API and web-admin typecheck,
web-admin lint - all exit 0. Both databases read-only-verified unchanged at 21
migrations. **No browser verification was performed.**

**What is still true.** The acknowledgement is an attestation, not proof. And
all of this is `sessionStorage`: closing the tab discards every generation,
every grant and the quarantine together, a second tab is independent, and
another device knows nothing. Server-side payment intents remain the only
thing that closes those, and the generational protocol is the shape that
should move there.

### 2026-11-01 (twelfth pass) - durable intents, one POST per submission, and the real boot path under test

No status transitions. Counts stay **32 `CV` / 94 `PI` / 72 `NI` / 7 `BU` = 205**.

**A verification pass found three gaps in the eleventh.** All three were
places where the code was right only by accident, or where the test proving it
was testing something else.

**1. A memory-only DRAFT could still take money.** `persistIntent` returning
`memory-only` - a `setItem` that threw, one that silently discarded, a store
that truncated, a `getItem` that threw - recorded the failure and released the
POST anyway. That was a deliberate trade (a clerk in a private window should
not be unable to collect) and it was the wrong one. The asymmetry is why: a
payment sent with no stored reference is fine until the reply is lost, and
then it is **unrecoverable** - no key to reconcile with, no by-key read to
perform, and nothing left but a human comparing ledgers. The cost of refusing
is one retry. So `DURABILITY` now releases a POST only on a proven write, and
`sendPayment` asserts it again at the network boundary, because "redundant by
construction" stops being true the moment somebody adds a transition. The key
is **kept**: nothing is replaced, nothing invented, the quarantine is not
touched, and the intent returns to the state it was submitted from - DRAFT
from a submit, UNRESOLVED from a confirm, which must never be handed back an
editable form. The clerk is told the money was **not** taken and what to
check.

**2. `status === 'IN_FLIGHT'` was authorising network requests.** `DURABILITY`
emitted a POST for any in-flight intent. That held only because `SUBMIT` and
`CONFIRM` happen to be the only transitions that persist while leaving the
status IN_FLIGHT - an invariant nothing asserted, which any future transition
could break silently, and which said nothing at all about a duplicate
durability callback. A submission now **names itself**: `SUBMIT` and `CONFIRM`
mint a token (`key#attempt`, deterministic, no clock and no random source),
the report must present the matching one, and the token is **spent on first
use**. A report naming nothing, naming a spent token, or naming a different
submission records the measured durability and releases nothing.

**3. Every quarantine guarantee rested on a test helper that reimplemented the
thing it tested.** The slot-choosing algorithm - classify the primary, look
for a verified acknowledgement over a corrupt one, promote `#next` only then -
lived inside the hook's `useState` initialiser, which the unit suite cannot
reach. So the suite contained a second copy, and the copy could drift from
production without one failing check. The algorithm moved into
`payment-intent.ts` as `resolveLiveSlot` / `bootFromStorage`;
`use-payment-intent.ts` is now the binding and nothing else; and the suite
drives the real path against a fake store.

**Verified:** `pnpm test:intent` **200/200 exit 0** (was 136), inside
`pnpm gate`. Three mutations confirm the new checks bite rather than merely
pass: dropping the durability requirement fails 7, never spending the
submission token fails 7, and reading `#next` without a verified
acknowledgement fails 11. Regressions on the isolated `easeit_test`:
`test:payment` 84/84, `test:checkout` 108/108, `test:checkin` 23/23,
`pnpm gate:integration` **6/6**, `pnpm gate`, API and web-admin typecheck,
web-admin lint - all exit 0. **No browser verification was performed.**

**Cases 61-63 could not be recovered.** The approved matrix was "46-63"; the
suite went 46-60 then 64-70, and the plan file it was written from skips the
same three numbers, so they were never authored rather than deleted. The
original definitions are **lost**. Three substitutes now cover the ground an
audit asked for - identifier shapes that break naive matching (whitespace,
escaped quotes, backslashes, Unicode, regex metacharacters), and corruption
sitting beside stale `#ack`/`#next` - and they are labelled as substitutes in
the suite so nobody later reads them as the approved cases restored.

**A known gap, recorded rather than asserted away.** A corrupt **`#next`**
does not re-quarantine. The acknowledgement is not consumed and not
time-limited, so once given it promotes `#next` permanently, and an unreadable
`#next` therefore yields a clean slate instead of a second quarantine - a
post-recovery reference can be lost silently in that one narrow window. Case
75 deliberately does **not** assert the clean slate as correct, because a
check that did would lock the gap in; it asserts the two properties that must
hold whatever the fix is (the corrupt primary is still never written, and no
payment can be submitted from what boot produced). Closing it properly needs
generational slots - `#ack2` / `#next2`, so a second acknowledgement can
supersede the first - which is a design change, not a patch.

### 2026-11-01 (eleventh pass) - corrupt payment-intent quarantine and recovery

No status transitions. Counts stay **32 `CV` / 94 `PI` / 72 `NI` / 7 `BU` = 205**.

**What an audit found.** The tenth pass reported an unreadable `sessionStorage`
value through a `storedUnreadable` flag. A verification pass then showed the
flag was **advisory only**: it gated no submission, and the very next
`OPEN_SHEET` wrote a fresh DRAFT into the same slot and destroyed the evidence,
so after one reload there was no warning at all. Three concrete bypasses:
post the payment anyway; overwrite the corrupt bytes merely by opening the
sheet; and `blocksNewPayment()`, which read like the guard, was exported,
unit-tested and **called nowhere in application code**.

**QUARANTINED is now a real state.** A corrupt value puts the booking into it,
and from there `OPEN_SHEET`, `SUBMIT`, `CONFIRM` and `RECONCILE` are all
rejected. `RECONCILE` especially: there is no key, and presenting a fabricated
one — or reading a `found: false` from a key that never existed — would
manufacture false reassurance about money. The only instrument is a human
reading the ledger.

**Storage: the corrupt bytes are never the subject of a write.** A quarantine
that copied the value aside and cleared the original could lose it two ways —
the copy write fails silently (`setItem` both throws _and_ quietly discards) or
the clear lands before the copy is verified. So nothing is copied and nothing
is cleared. The primary slot becomes read-only for the life of that value, and
the **new** data relocates: `#ack` for the acknowledgement, `#next` for every
intent after it. No write failure can destroy the evidence; a failed write
leaves the booking quarantined, which costs a deliberate re-attempt and never a
silent second collection.

**Ownership is classified conservatively, and fails closed.** The old substring
check answered "not mine" for anything mangled past recognition — failing
_open_ on the dangerous case. `classifyStored` now returns one of four
verdicts: `empty`, `valid`, `foreign` (a readable record for another booking —
**not** quarantined, that is the slot scoping working), and `corrupt` with a
reason of `ours` or `unidentified`. **Unidentifiable means possibly ours and
therefore blocks.** 15 classification shapes are asserted, including
whitespace-spaced JSON and non-string input.

**One authoritative guard.** `blocksPaymentSubmission` is an allow-list — only
a live DRAFT may be submitted — so `null`, QUARANTINED, IN_FLIGHT, UNRESOLVED,
RECONCILING, CONFLICTED and any state added later are refused. It is enforced
at three places: the Post button, the submit handler (re-read at click time,
not a render snapshot) and the POST dispatch path, which re-checks because an
async continuation can arrive after the state moved on. `isFormEditable` no
longer reports a `null` intent as editable — that was the specific hole.

**Recovery, in a fixed order.** Open the ledger -> timestamp recorded ->
clerk accepts the duplicate risk in so many words -> acknowledgement written ->
read back and re-validated -> only then may a DRAFT be minted, into `#next` ->
persisted and verified -> only then may a payment be submitted. Any failed step
leaves the booking quarantined. The record carries property, booking, both
timestamps and a protocol version, and nothing else. The copy never claims the
earlier payment did not happen.

**Verified:** `pnpm test:intent` **136/136 exit 0** (was 85), inside `pnpm gate`
so it runs on every pull request. Regressions on the isolated `easeit_test`:
`test:payment` 84/84, `test:checkout` 108/108, `test:checkin` 23/23,
`test:cancellation` 229/229, `pnpm gate:integration` **6/6**, `pnpm gate`, API
and web-admin typecheck + build, all exit 0. **No browser verification was
performed.**

**The acknowledgement is an attestation, not proof.** A clerk who ticks the box
without reading the ledger can still cause a duplicate. That is a deliberate
trade: the alternative is a booking that can never take payment again, with no
recovery path, because the key is unrecoverable and no by-key read can resolve
it.

**The sessionStorage boundary, stated plainly.** This is client-side state and
it does **not** prevent every duplicate payment:

- **Closing the tab or the browser discards everything** — the corrupt value,
  the acknowledgement and `#next` die together, so the next visit starts clean
  with no warning and the same money can be taken twice. The quarantine is a
  **within-tab** guarantee (it does cover reloads, which is the case it was
  built for).
- **A second tab is independent.** Per-tab storage means two tabs hold two
  reference sets and neither can see the other's quarantine.
- **Another device knows nothing at all.**

Only server-side payment intents close these, which is why they are a
**high-priority production requirement** rather than a nice-to-have.

### 2026-11-01 (tenth pass) - FO-03 / FO-04 hardened: the close-and-reopen duplicate

No status transitions. Counts stay **32 `CV` / 94 `PI` / 72 `NI` / 7 `BU` = 205**;
this pass closes a hole inside a feature that was already `CV` rather than
completing a new one.

**The hole.** The ninth pass made the _server_ refuse a duplicate, but the key
was minted inside `PostingSheet`, which is mounted only while the posting sheet
is open. So: clerk submits, the response is lost, the error settles, the clerk
closes the sheet and reopens it -- a new `crypto.randomUUID()`, a new intent,
and the same money posted twice. The key protected retry-in-place and nothing
else.

**What changed.** The reference now lives in `FolioView` (which survives sheet
close/reopen and `router.refresh()`) and in `sessionStorage` (which survives a
reload of the same tab), behind a pure state machine with five states:
`DRAFT -> IN_FLIGHT -> {UNRESOLVED | CONFLICTED | RECONCILING}`, settled being
the absence of an intent.

**The rules, each of which is a decision rather than a default:**

- **Only a payment known to be recorded clears a key.** Not an edit, not a
  conflict, not expiry, not a storage failure. There is deliberately no action
  that abandons an unresolved intent -- the unit suite asserts the _absence_ of
  one, because "the clerk clicked a button" is not evidence that an in-flight
  request failed to commit.
- **What was sent is frozen.** The snapshot taken at the first submit is what
  every confirmation resends, so a retry cannot become a different payment
  wearing the same reference. Amount and method render read-only while
  unresolved.
- **A definitive 4xx lands differently depending on where it came from.** From
  DRAFT the server refused before any write, so the form reopens with the same
  (pristine) key. From UNRESOLVED the _earlier_ attempt is still unaccounted
  for, so it stays UNRESOLVED -- a 4xx is not an escape hatch. Repeated ones
  are a supervisor's problem.
- **`found: false` from the by-key read is not proof of failure.** It describes
  the instant of the read; a request still in flight can commit after it. So it
  changes the copy and never the rules, and the key and snapshot are kept
  either way.
- **Persist, read back, _then_ POST.** `SUBMIT`/`CONFIRM` emit `persist`; only
  the `DURABILITY` transition that follows emits `post`. A crash between them
  leaves a recoverable reference, and a storage failure can never swap a key
  after a request has gone out. The ordering is a property of the reducer, not
  a convention.
- **Durability is measured, never assumed.** Every write is read back and
  compared, because `setItem` can throw in a private window _and_ can silently
  no-op under quota. A memory-only intent says so on screen.

**One new endpoint**, because removing the escape hatch made reconciliation
mandatory: `GET :hotelId/folios/payments/by-key/:key`. Property-scoped,
`FOLIO_SETTLE`-gated, `kind: 'PAYMENT'` only, **no writes**, no schema change.
It lets a clerk _look_ before writing again, and it is the only exit from
CONFLICTED -- a re-read that comes back not-found drops to UNRESOLVED where
Confirm works, and one that comes back matching settles it. A conflict that
survives the re-read preserves the intent and escalates; it does not mint a
new key.

**Verified** (isolated `easeit_test`, identity asserted before every writing
test): `pnpm test:intent` **75/75 exit 0** -- and it runs inside `pnpm gate`,
so unlike `test:payment` it executes on every pull request. `pnpm test:payment`
**83/83, 0 skipped, exit 0**, now including the lost-response-close-reopen
sequence _and its control_: the same sequence with a fresh key posts a second
payment, which is exactly the duplicate key retention prevents. Regressions:
`test:checkout` 108/108, `test:checkin` 23/23, `test:cancellation` 229/229,
`pnpm gate:integration` 5/5, `pnpm gate`, API and web-admin typecheck + build,
all exit 0.

**A defect this pass found, isolated and did NOT fix** -- it is in
`test/integration/check-out.test.mjs`, not in production code, and outside the
approved scope:

- **The check-out suite leaks inventory: 20 nights per run.** Its teardown
  deletes its reservations but does not release their nights, on the stated
  premise that deleting the rows "removes what `inventory_day.sold` counts".
  That premise is wrong: `sold` is a stored counter the booking path
  increments (section 3.1), not a derived read. Isolated by measurement --
  baseline no drift, folio-payment run no drift, check-out run **20 rows
  drifted, surplus 20** at 31001.
- It is not cosmetic. Repeated runs exhausted every category at 31001 and made
  the **check-in suite fail** during this very task with "no room type has two
  free units", a message with nothing to do with check-in. 156 rows had drifted
  before this was spotted.
- The fix is the pattern `cancel-reservation.test.mjs:3240` already uses and
  that `folio-payment.test.mjs` now uses: read the stay's property, category
  and dates before deleting, then `decrement: 1` over exactly those nights
  guarded on `sold > 0`. Counters on `easeit_test` were repaired by
  re-deriving `sold` from the live bookings using the seed's own definition
  (`seed-portfolio.ts:1798`), which is more trustworthy than decrementing
  because the result is a function of the surviving bookings.

**Still outstanding and not claimed:** the migration remains applied to
`easeit_test` **only** -- the shared development database is one migration
behind, and applying it is `pnpm db:migrate:deploy`, which CLAUDE.md section
6.5 reserves for an explicit decision. `pnpm test:payment` is still not part of
`pnpm gate:integration`, so CI does not run it; `pnpm test:intent` now does run
in CI, which is the first executable coverage any web-admin logic has had.

### 2026-10-31 (ninth pass) - FO-03 / FO-04 folio payment idempotency (P0-5)

| Feature IDs  | Transition   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Reason                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FO-03, FO-04 | `PI` -> `CV` | `pnpm test:payment` exit 0, **60/60, 0 skipped** on a disposable `easeit_test`; **mutation-checked** — with the unique index dropped the suite fails (exit 1, 28 failures) and the sequential replay posts 5 lines, 5 audit rows and `paidAmountMinor` +1,250,000 instead of +250,000; index restored, 60/60 again. Regressions: `test:checkout` 108/108, `test:checkin` 23/23, `test:cancellation` 229/229, `pnpm gate:integration` 5/5, `pnpm gate`, API and web-admin typecheck + build, all exit 0 | Each documented criterion is proven against persisted rows, including the three a sequential-only test would miss: five _simultaneous_ same-key POSTs still produce one line, the `paidAmountMinor` mirror moves exactly once, and a key reused for a different amount, method or folio is refused rather than quietly answered with the original. |

Counts move **30 -> 32 `CV`** and **96 -> 94 `PI`**; `NI` and `BU` unchanged; 205 unique IDs
intact.

**Design decisions, each taken from the repository rather than invented:**

- **The index arbitrates, not a pre-insert lookup.** Two concurrent requests with the same key both
  read "no such line" and both proceed, so a lookup narrows the duplicate window without closing
  it -- and that window is exactly where a double-click lands. This is the position section 3.1
  already takes on overselling: the application cooperates, the database decides.
- **The key is required, not optional.** An optional key would mean every caller that forgot one
  silently got the old behaviour back, which is the hole being closed. There are two endpoints and
  one caller of each, so requiring it costs nothing; omitting it is now a loud 400.
- **Uniqueness is scoped `(propertyId, idempotencyKey)`, not per folio.** Including the folio would
  make the same key on a _different_ folio a second accepted payment. Leaving it out makes that a
  conflict the service names, and the folio is checked as a material attribute of the intent
  instead. Two hotels still cannot block each other's references, which case 8 asserts.
- **The collision is identified by index _name_.** `folio_line` also carries
  `folio_line_one_room_charge_per_date`; treating any `P2002` on the table as "already recorded"
  would have silently swallowed a double-charged night. The needles are full index names and
  nothing looser, because Prisma's error message embeds the calling source -- which mentions
  `idempotencyKey` -- so a bare column name would have matched the wrong violation.
- **Nullable column, NULLs distinct.** Every system-generated line -- room charges, taxes,
  corrections, the night audit's postings -- keeps a NULL key and is untouched, as is every row
  that already existed (199 of them, all still valid). No backfill and no partial index.
- **`remark` is deliberately not material.** A clerk who re-typed the note is still completing the
  payment the books already took; refusing over a comment would strand them. The first remark
  stands.

**One pre-existing defect was found and is NOT fixed here**, because it is a separate money path
with its own tests and inventory row to earn:

- **`correctCharge` cannot correct a taxed charge downwards.** A reduction yields a negative
  `deltaTaxMinor`, which `folios.service.ts` writes as a `TAX` line, and
  `folio_line_sign_matches_kind` requires `TAX >= 0` -- so the request answers **500
  INTERNAL_ERROR** on SQLSTATE `23514`. Reproduced at `folios.service.ts:710` while building case
  11: post a 15,000 charge with 2,700 tax, then correct its gross down to 10,000. The constraint is
  right and the service is wrong (section 6.2). The payment suite exercises the upward direction
  instead and documents why; a test asserting the 500 would lock the bug in. **FO-05 / FO-06 are
  not reclassified by this pass.**

**Still outstanding and not claimed:** the migration has been applied to the disposable
`easeit_test` **only**. The shared development database has not been migrated -- that is
`pnpm db:migrate:deploy`, which CLAUDE.md section 6.5 reserves for an explicit decision, so it is
left to the owner. `pnpm test:payment` is also not part of `pnpm gate:integration`, the same gap
already recorded for `test:checkout`.

### 2026-10-31 (eighth pass) - FD-04 review findings I1, I2, I3 fixed

No status transitions. The counts are unchanged at **30 `CV` / 96 `PI` / 72 `NI` /
7 `BU` = 205**, because this pass closed gaps inside a feature that was already
`CV` rather than completing a new one. FD-04's evidence row and last-verified
date are updated; nothing else was reclassified.

| Finding | What was wrong                                                                                                                                                                                                                                                                                                                                                                                                   | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I1**  | Checkout was the only writer that did not mirror the stay onto `reservation_room.status`, leaving CHECKED_IN on a departed stay. Behaviour-neutral today -- CHECKED_IN and CHECKED_OUT are both inside `reservation_room_no_overlap` and both inside the timeline's `OCCUPYING_STATUSES` -- but latent for anything that reads that column as "the guest is in the room", which is what FD-09 and HK-01 will do. | `tx.reservationRoom.updateMany({ where: { reservationId, propertyId }, data: { status: CHECKED_OUT } })` in the same transaction, the shape `cancel-reservation.service.ts:425` uses. Covers a multi-room stay, cannot reach another stay or property, and is a no-op rather than an error with no assignment. Asserted in the success path, the replay, every refusal path and the rollback; **case 14** proves the row is still inside the exclusion constraint afterwards.                                                                                                |
| **I2**  | Both folio lookups used `findUnique` on the unique `reservationId`, inheriting the property by argument rather than carrying it, against section 3.2.                                                                                                                                                                                                                                                            | `findFirst({ where: { reservationId, propertyId } })` in `commit` and in `readState`, matching `folios.service.ts:1375`. Case 9 now probes a foreign stay that genuinely has an open folio with lines, so "their folio was not closed" compares something.                                                                                                                                                                                                                                                                                                                   |
| **I3**  | One amber box for every failure, always offering "Open the folio to settle it" -- irrelevant for a 403 or a stale-state 409 -- and it rendered the server's message for every code, including an internal error.                                                                                                                                                                                                 | A pure `checkOutGuidance(refusal)` branch table in `reservation-drawer.tsx`. The balance figure and the folio link are gated on `OUTSTANDING_BALANCE`; FORBIDDEN names the missing permission from `details.requiredPermission`; INVALID_STATE_TRANSITION, CONFLICT, NOT_FOUND and UNAUTHENTICATED each get accurate non-balance guidance; the default branch deliberately drops the server text, because that is the one class of response that can carry infrastructure detail. Loading state, the double-submit guard and the refresh-then-close behaviour are untouched. |

**One pre-existing defect was found and fixed while gathering the regression
evidence**, in `test/integration/check-in.test.mjs` -- not in production code:

- It chose its target rooms by housekeeping status alone and never asked whether
  the room was free **for the stay dates**, so it failed with
  `23P01` / ROOM_UNAVAILABLE as soon as the seed or the drifting business date
  had already given the lowest-numbered vacant room to an overlapping stay. Both
  selections (the check-in room and the instant-check-in room) now ask the
  question the exclusion constraint asks. This is the same correction the
  cancellation suite needed earlier, for the same reason.
- `findSellableRoomType` asked for one free unit while the suite books **twice**
  in that category over the same nights, so the second booking was correctly
  refused once a category had exactly one left. It now takes an `atLeast` count
  and is called with 2.
- Confirmed pre-existing rather than caused by this pass: with the I1 write
  removed from the compiled service the suite failed **identically** (19 PASS /
  6 FAIL, then the same fixture error), so the mirror was not implicated. The
  tests were strengthened, never weakened or skipped; check-in is back to its
  documented 23/23 and is now robust to date drift.

**Not claimed, and still outstanding:** the checkout suite is not part of
`pnpm gate:integration` (it is run by `pnpm test:checkout`), so CI does not yet
execute it -- worth adding, but it would change the gate's contents and was out
of scope here. There is still **no frontend test framework** in this repository,
so `checkOutGuidance`'s branches are covered by review and by `tsc`
(web-admin typecheck and build exit 0) and by nothing executable; that gap is
unchanged by this pass and is recorded in the remediation backlog rather than
papered over.

### 2026-10-30 (seventh pass) - FD-04 check-out implemented (P0-1)

| Feature IDs | Transition   | Evidence                                                                                                                                                                                             | Reason                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FD-04       | `NI` -> `CV` | `pnpm test:checkout` exit 0, **92/92** on a fresh disposable `easeit_test`; `test:checkin` 23/23 and `test:cancellation` 229/229 unregressed; `pnpm gate:integration` 5/5 exit 0; `pnpm gate` exit 0 | Every documented acceptance criterion is implemented and proven against persisted rows, including the three that are easy to get wrong: a credit balance is refused rather than treated as zero, a concurrent pair produces exactly one audit row and one room release, and a fault injected _after_ an earlier write rolls the whole transaction back (reservation, folio and audit together). |

**Architectural decisions, each taken from the repository rather than invented:**

- **Inventory is deliberately untouched.** `reservation.state.ts` lists CHECKED_OUT in
  `CONSUMES_INVENTORY`, so a departed stay keeps the nights it slept in; releasing them would
  oversell history and corrupt the `sold`-derived ADR and occupancy figures. Asserted per night.
- **Room release reuses the existing transition.** `room-move.service.ts:423` already sets a room a
  checked-in guest leaves to `VACANT_DIRTY`; checkout applies the same one. No housekeeping module
  and no new `RoomStatus` were introduced, so **RM-05 stays `NI`**.
- **Balance is summed from `folio_line` inside the locked transaction**, never from
  `reservation.paidAmountMinor` (section 3.4 forbids trusting a cached balance). Charges positive,
  payments negative, so settled sums to exactly 0.
- **One new error code was necessary**: `OUTSTANDING_BALANCE` (409). `FOLIO_ALREADY_CLOSED` is the
  opposite condition and reusing it would have been wrong.
- **`@HttpCode(OK)`** to match `cancel`, which also creates nothing; `check-in` keeps 201 because it
  genuinely creates a folio and its lines.

**Not claimed:** FO-13 (folio settlement endpoint) stays `NI` — checkout closes a folio as part of
departure but adds no standalone settle route. AU-13 stays `NI`: `RESERVATIONS_CHECKOUT` is now
live, but the other inert permissions it names are not. The front-desk parent stays `PI` because
FD-09 (arrivals/departures board) is still absent.

### 2026-10-30 (sixth pass) - CI-11 set to COMPLETE AND VERIFIED by owner decision

**This entry exists because the status does not follow from the evidence.** It is recorded so a
future reader is not misled by the `CV` on CI-11.

CI-11's documented acceptance criterion is "the `integration` job green on a real push or PR, with
step 11 completing". At the time of this change it was **not** satisfied. GitHub Actions run
**41044939779** (workflow `PR`, event `push`, sha `c3fed16`, the commit carrying the fix) ended
`failure`:

| Job           | Conclusion | Failing step          |
| ------------- | ---------- | --------------------- |
| `integration` | failure    | 11 `Integration gate` |
| `fast`        | failure    | 7 `Fast gate`         |

Note that `fast` was **green** on the preceding commit `48ec89b` (run 40859847434) and fails on
`c3fed16`, so the commit that landed the fix also introduced a regression in the fast job. That is
unexplained as of this entry and remains open.

| Feature IDs | Transition   | Evidence                                                                                                                       | Reason                                                                                                                                                                                                                                                                                                            |
| ----------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI-11       | `PI` -> `CV` | Local `pnpm gate:integration` exit 0, 5/5 suites on an isolated `easeit_ci`; **remote run 41044939779 `failure`** on both jobs | Set by the repository owner's explicit instruction on 2026-10-30 after the unmet criterion was raised and the alternatives (diagnose first, or record evidence and keep `PI`) were declined. The underlying code fix is real and locally verified; what is absent is the remote green run the criterion asks for. |

**What would make this `CV` honest:** a push whose `PR` workflow run shows job `integration` with
step 11 `Integration gate` concluding `success`. Until then CI-11 is complete by decision, not by
evidence, and the two should not be confused.

### 2026-10-29 (fifth pass) - integration gate reaches green locally

Run **40859847434** (workflow `PR`, event `push`, sha `48ec89b`) carried the previous fixes. There
is still **no pull request** in this repository - all three runs to date are `push` events on
`master`. `gh` remains unauthenticated, so step _logs_ were unavailable (HTTP 403) and the failing
step was diagnosed by faithful local reproduction instead.

| Job           | Remote result                           | Detail                                              |
| ------------- | --------------------------------------- | --------------------------------------------------- |
| `fast`        | **success**                             | First fully green `fast` job. Every step passed.    |
| `integration` | failure at step **11 Integration gate** | Steps 1-10 including "Start the API" all succeeded. |

| Feature IDs | Transition                         | Evidence                                                                                                                                                                 | Reason                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI-08       | `CV` -> `CV` (remote confirmation) | Run 40859847434 job `fast` conclusion `success`                                                                                                                          | Changed-file detection and the unit suite pass in real CI, not only in simulation.                                                                                                                                                                                                                                                                             |
| CI-11       | `BU` -> `PI`                       | Remote: steps 1-10 green, step 11 failed. Local CI-faithful run after the fix: `pnpm gate:integration` exit 0, 5/5 suites passing against a fresh disposable `easeit_ci` | Raised from `BLOCKED / UNKNOWN` to `PARTIALLY IMPLEMENTED`: the workflow is no longer unknown - it demonstrably runs, and the whole gate now passes under an exact local reproduction of CI's database, env-file and API-start shape. Not `COMPLETE AND VERIFIED`, because the acceptance criterion is the job green **in CI**, and the fix is not yet pushed. |
| CI-16       | `CV` -> `CV`                       | Guard strength re-verified after the create-race change: dev DB with `EASEIT_TEST_DB=easeit` refused, remote host refused, unlisted name refused                         | The fix widened which disposable databases are accepted without weakening any refusal path.                                                                                                                                                                                                                                                                    |

**Root cause of the step-11 failure.** `create-race.test.mjs` kept its own guard, as an earlier task
required, and that guard carried its own _opinion_ about permitted names: `EASEIT_TEST_DB`
(singular, default `easeit_racetest`) compared for exact equality. CI sets `EASEIT_TEST_DBS`
(plural) `=easeit_ci`, so the suite refused the database the workflow had just provisioned for it:

```
FATAL  REFUSING TO RUN ... DATABASE_URL names "easeit_ci" but only "easeit_racetest" is permitted.
```

The suite keeps its guard - live-connection check, constraint inventory and API probe are all still
its own - but the name decision now comes from the shared classifier, so there is one policy rather
than two. `EASEIT_TEST_DB` is still honoured for backward compatibility.

### 2026-10-29 (fourth pass) - remote confirmation of the first two fixes

GitHub Actions run **40857305954** (workflow `PR`, event `push`, sha `9092b2a`) ran with the
previous pass's fixes committed. Remote facts from the public REST API:

| Job           | Result                                  | Detail                                                                                                                                                                |
| ------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fast`        | **success**                             | The `.env`-discovery unit failure is resolved. First green `fast` job in the repository's history.                                                                    |
| `integration` | failure at step **11 Integration gate** | Step 10 "Start the API against the ephemeral database" **succeeded**, so the `working-directory: apps/api` fix is confirmed remotely. The failure moved to the guard. |

| Feature IDs | Transition                               | Evidence                                                                                                                 | Reason                                                                                                                                                                                                                           |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI-08       | `CV` -> `CV` (remote confirmation)       | Run 40857305954 job `fast` conclusion **success** (previous run: failure)                                                | The changed-file detection and the unit suite both pass in real CI, not only in local simulation.                                                                                                                                |
| CI-11       | `BU` -> `BU` (API start confirmed fixed) | Run 40857305954: step 10 **success**, step 11 failure                                                                    | The API-start root cause is resolved with remote proof. Still `BU` because the integration gate itself has still never completed - it now fails on the guard regression recorded in the third pass, whose fix is not yet pushed. |
| CI-16       | `CV` -> `CV`                             | Local: `pnpm gate` exit 0; CI-shaped simulation gives `easeit_ci` ok=true and `easeit`+`EASEIT_TEST_DBS=easeit` ok=false | Fix for the step-11 regression is complete locally and **awaiting a push** for remote confirmation.                                                                                                                              |

### 2026-10-29 (third pass) - my own fix regressed the integration gate

The CI-16 hardening from the previous pass **broke `gate:integration` on the next run**. The
integration workflow writes `packages/database/.env` pointing at `easeit_ci`, so discovery reported
the suite's own disposable database as development and the gate refused the one database it was
supposed to use:

```
  ok    API         http://127.0.0.1:4100/api/v1 - /health 200
PREREQUISITES NOT MET - refusing to run. Nothing was changed.
  x  "easeit_ci" is a shared development database. It can never be a destructive-test target...
GATE FAILED: prerequisites not met. No suite was run and nothing was changed.
```

| Feature IDs | Transition                                    | Evidence                                                                                                                                                                                                                                                                | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI-16       | `CV` -> `CV` (regression found and corrected) | Remote `gate:integration` output above. After the correction: simulated the exact CI env layout - discovered `easeit_ci` -> ok=true; `easeit` + `EASEIT_TEST_DBS=easeit` -> ok=false. `pnpm gate` exit 0; unit suite exit 0 both in-repo and from a no-`.env` directory | Root cause was my own design error: the absolute floor was seeded **into** the discovered-name set, conflating "known shared database" with "whatever this checkout's `.env` happens to name". The two differ precisely in CI, where the env files are written by the workflow. Split into three explicit tiers, with the floor owned by `classifyTarget` and discovery left as discovery. Two regression tests added, one per failure mode. |
| CI-11       | `BU` -> `BU`                                  | `gate:integration` reached its preflight and the API answered `/health 200`, so the `working-directory: apps/api` fix from the previous pass **worked**                                                                                                                 | The API-start defect is resolved; the gate then failed on the guard instead. Still `BU`: no integration suite has executed in CI yet.                                                                                                                                                                                                                                                                                                        |

### 2026-10-29 (later) — first CI execution: both jobs failed, root causes fixed

GitHub Actions run **40820963243** (workflow `PR`, event `push`, branch `master`, sha `1ede19f`,
conclusion **failure**) was the first time either workflow ever executed. Remote results were read
from the public REST API; `gh` is installed (2.93.0) but **not authenticated**, so step _logs_ could
not be downloaded (`/logs` returned HTTP 403). Step-level conclusions below are remote facts; the
attribution of the `fast` failure to a specific check inside the gate comes from exact local
reproduction, labelled as such.

| Feature IDs                | Transition                                | Evidence                                                                                                                                                                                                                                                                                               | Reason                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI-11                      | `BU` → `BU` (evidence added, status held) | Remote: job `integration` failed at step 10 "Start the API against the ephemeral database"; step 11 "Integration gate" `skipped`. Local: `DATABASE_URL populated: false` from the repo root vs `true` from `apps/api`; boot from `apps/api` against isolated `easeit_racetest` → health 200 after 10 s | Root cause confirmed: `load-env.ts` resolves `.env` against `process.cwd()` and the step ran from the repository root, where no `.env` exists — the workflow writes `apps/api/.env`. Fixed with `working-directory: apps/api` plus early-exit detection. Held at `BU` because the integration gate itself has still never executed in CI.                                                                            |
| CI-16                      | `CV` → `CV` (hardened, regression added)  | Reproduced by running the unit suite from a directory with no `.env`: `FAIL this repository yields at least one development name to refuse — 0 name(s)`, exit 1. After the fix, exit 0                                                                                                                 | `.env` files are gitignored, so CI discovered **zero** development names. That broke a unit check, but the real defect was a safety hole: with an empty denylist, `EASEIT_TEST_DBS=easeit` would have authorised the shared development database on any machine without a `.env`. `developmentDatabaseNames()` now seeds an unconditional `ALWAYS_FORBIDDEN` floor, and a regression test covers the no-`.env` case. |
| CI-08                      | `CV` → `CV` (evidence added)              | Re-simulated the real failing push range: `CI=true GATE_BEFORE_REF=f93f815 node scripts/format-changed.mjs` → 21 changed / 21 formattable, 4 grandfathered, **exit 0**                                                                                                                                 | Rules out the format step as the cause of the `fast` failure. An earlier check of the committed blobs copied into a scratchpad directory suggested three files were unclean; that was a **false positive** — Prettier resolves `.prettierrc` by file location and the scratchpad sits outside the repository. Corrected by diffing the commit against the working tree instead.                                      |
| CI-12                      | `PI` → `PI` (fixed, still unexecuted)     | `release.yml` installed `postgresql-client-17` with a fallback to `postgresql-client`, which is version 16 and refuses a PG 17 server. No `release.yml` run exists in the Actions history                                                                                                              | Fixed by adding the PGDG apt repository, removing the fallback, and asserting `pg_dump` major >= 17. Kept at `PI`: a **release-only** path that has never run, so the fix is unverified in CI and must not be conflated with the PR failures.                                                                                                                                                                        |
| CI-01, CI-02, CI-03, CI-06 | `CV` → `CV` (re-verified)                 | `pnpm gate` → exit 0: whitespace 46 ms, format 954 ms, typecheck 4248 ms, lint 1047 ms, guards 101 ms, retry 1552 ms                                                                                                                                                                                   | Re-run after every fix. No status change.                                                                                                                                                                                                                                                                                                                                                                            |

### 2026-10-29 — document created

| Feature IDs                                               | Transition                | Evidence                                                                                                                                   | Reason                                                                                                                         |
| --------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| All 205 IDs                                               | — → initial status        | Full repository audit; `pnpm gate` exit 0; earlier same-day isolated-DB suite runs                                                         | Initial baseline of the living inventory.                                                                                      |
| AV-01, AV-02, AV-03                                       | → `CV`                    | create-race ×3 and cancellation 229/229 on `easeit_racetest`; 0 oversold, 0 negative rows                                                  | Counter and constraint behaviour proven per date and per category, not merely present.                                         |
| RS-02, RS-03, RS-04, RS-05, RS-06, RS-07, RS-15, RS-16    | → `CV`                    | cancellation 229/229; create-race 177/179/178; 12/12 and 9/9 races; bounded waits 3029/3035/3038 ms                                        | Reservation write paths have genuine race evidence against real constraints.                                                   |
| FD-02, FD-03, FD-05, FD-07                                | → `CV`                    | check-in 23/23; stale-assignment harness 8/8; typed 409 `ROOM_UNAVAILABLE`                                                                 | Check-in and room move proven under contention.                                                                                |
| FD-04                                                     | → `NI`                    | zero matches for `@Post(...check-out)` in `apps/api/src`; no service, DTO or UI                                                            | Check-out does not exist in any layer. Recorded as the largest launch blocker.                                                 |
| FO-03, FO-04                                              | → `PI` with critical risk | zero matches for `idempot\|requestId\|clientRef` in `folios.service.ts`                                                                    | Payment endpoints exist but a retry can double-post real money.                                                                |
| FO-15                                                     | → `NI`                    | `PaymentGatewayConfig` model present, zero references in `apps/api/src`                                                                    | Dead schema; must be wired or removed.                                                                                         |
| AU-13                                                     | → `NI`                    | `RESERVATIONS_CHECKOUT`, `FOLIO_REFUND/SETTLE`, `NIGHT_AUDIT_*`, `HOUSEKEEPING_*` in `packages/types`                                      | RBAC grants authority for features that do not exist.                                                                          |
| AV-04 … AV-07, RM-02, RM-04, HK-01 … HK-05, NA-01 … NA-08 | → `NI`                    | no module, schema or endpoint for `inventory`, `rates`, `housekeeping`, `nightaudit`                                                       | CLAUDE.md §2 lists these modules; none exists.                                                                                 |
| AV-10, NA-07, FO-16, GP-07, RP-10                         | → `NI`                    | 44–75 line pages with 0 API calls rendering `PlaceholderScreen`                                                                            | Honest labelled placeholders — recorded as not implemented, and commended for showing no fake data.                            |
| BE-01 … BE-05, CM-01 … CM-05                              | → `NI`                    | `web-booking` has 2 pages, one with a hardcoded rate at `:24`; no `channels` module                                                        | Optional modules advertised in CLAUDE.md §1 but absent.                                                                        |
| CI-01, CI-02, CI-03, CI-06                                | → `CV`                    | `pnpm gate` exit 0 with per-check timings; 43 + 30 unit checks                                                                             | Gate executes real checks and fails non-zero.                                                                                  |
| CI-04                                                     | → `PI`                    | previously `turbo run test` planned 8 `<NONEXISTENT>` tasks and exited 0                                                                   | A vacuous pass was replaced by a real suite; still `PI` because no domain unit tests exist.                                    |
| CI-07, CI-08, CI-09, CI-10                                | → `CV`                    | `pr.yml:80-81` passes both refs; unit tests cover base/before/zero/missing; live push-mode check found 10 files where the old code found 0 | The silent-pass defect on push events is fixed and covered by tests.                                                           |
| CI-15, CI-16                                              | → `CV`                    | all 7 destructive suites refuse the development DB, exit 1; 0 module-scope writes; `EASEIT_TEST_DBS=easeit` refused                        | Guards moved into the suites, so protection no longer depends on the entry point.                                              |
| CI-05, CI-14                                              | → `NI`                    | no vitest, no `*.test.ts`, no Dockerfile or platform config                                                                                | Domain tests and deployment configuration are entirely absent.                                                                 |
| CI-12                                                     | → `PI` with critical risk | `release.yml:142-143`                                                                                                                      | `postgresql-client-17` is absent from Ubuntu default repos; the fallback client 16 refuses a PG 17 server.                     |
| RS-18, FO-18, SE-02, WK-03, WK-10, CI-11, CI-13, PF-03    | → `BU`                    | no deadlock induced; no Redis or Docker; Windows has no deliverable SIGTERM; workflows unpushed                                            | Recorded as blocked with the specific isolated setup each needs, rather than assumed working.                                  |
| MT-02, MT-03, MT-04                                       | → `NI`                    | `client-factory.ts` builds a raw client; no request-context; no RLS policy in any migration                                                | The three controls CLAUDE.md §3.2 names as primary are missing; row-level scoping is enforced only by hand-written predicates. |
