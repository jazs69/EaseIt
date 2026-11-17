/**
 * Layer B — integration, on a disposable database only.
 *
 * ===========================================================================
 * The preflight is not optional, and it runs first for a reason.
 *
 * The suites below create reservations, cancel them, move rooms and decrement
 * inventory counters. Three of them (`cancel-reservation`, `check-in`,
 * `parallel-booking`) read `DATABASE_URL` and assert nothing about where it
 * points, so with an unset environment they would mutate the shared
 * development database. `scripts/require-services.mjs` refuses unless the
 * environment names a database from an explicit allowlist and the live
 * connection agrees — so a missing or wrong environment is a hard failure
 * here, never a quiet fallback.
 *
 * `parallel-booking` is deliberately NOT in this layer. It mutates shared
 * inventory fixtures rather than suite-owned ones, which is safe on a
 * disposable database but makes it a poor fit for a routine gate; it lives in
 * `gate:resilience`, which is explicitly pre-release.
 * ===========================================================================
 *
 * Required environment:
 *   DATABASE_URL     a disposable database (default allowlist below)
 *   EASEIT_API_URL   an API running against THAT SAME database
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  classifyTarget,
  DEFAULT_ALLOWLIST,
  developmentDatabaseNames,
} from '../test/support/isolation-guard.mjs';

/**
 * One allowlist, shared with the isolation guard.
 *
 * This used to default to `easeit_racetest,easeit_recovery,easeit_ci` --
 * missing `easeit_test`, which the guard allows -- so the gate refused a
 * database the suites accept and the way through was to remember
 * `EASEIT_TEST_DBS`. Two lists disagreeing about which database is safe is a
 * trap. `EASEIT_TEST_DBS` still *adds* names for a disposable database this
 * repository has not heard of; it can never add a shared one, because
 * `classifyTarget` refuses any name it finds in a developer's `.env`.
 */
const ALLOWED_DATABASES = process.env.EASEIT_TEST_DBS ?? DEFAULT_ALLOWLIST.join(',');

/**
 * Both targets are resolved HERE and exported, so the children get exactly
 * what was validated.
 *
 * ===========================================================================
 * The bug this closes would have turned every CI run red.
 *
 * The comment further down says the suites inherit `DATABASE_URL` and
 * `EASEIT_API_URL` from this process. That was never true of either: the API
 * default was applied here and nowhere else, and the database was only ever
 * read by each suite separately, out of `packages/database/.env`. CI writes
 * that file and sets neither variable, so once the payment suite stopped
 * reading `.env` -- which it must, because that file names the **shared
 * development database** -- it would have failed on every pull request while
 * its five neighbours passed.
 *
 * So the resolution happens once, is validated against the allowlist before a
 * single suite runs, and is written back into `process.env` so `spawnSync`
 * hands it down. The suites keep their own post-connection identity check:
 * this decides what to ask for, `assertIsolatedDatabase` decides whether the
 * live connection is really that.
 * ===========================================================================
 */
function fromEnvFile(key) {
  for (const relative of ['../packages/database/.env', '../.env', '../apps/api/.env']) {
    try {
      const text = readFileSync(new URL(relative, import.meta.url), 'utf8');
      const match = new RegExp(`^${key}\\s*=\\s*"?([^"\\r\\n]+)"?`, 'm').exec(text);
      if (match?.[1]) return match[1];
    } catch {
      // A missing file here is ordinary, not an error.
    }
  }
  return null;
}

const DATABASE_URL = process.env.DATABASE_URL ?? fromEnvFile('DATABASE_URL') ?? '';
const verdict = classifyTarget({
  url: DATABASE_URL,
  allowExtra: process.env.EASEIT_TEST_DBS ?? '',
  /**
   * The same discovery the suites do, so the gate reaches the same verdict.
   *
   * An empty set here skipped the "that is this checkout's working database"
   * tier, which left the gate fractionally looser than every suite it starts
   * -- it would begin a run the first suite then refused. Discovery is safe in
   * CI: the workflow writes `packages/database/.env` pointing at `easeit_ci`,
   * and that tier deliberately ignores built-in test names, which is the
   * precedence rule recorded in `classifyTarget`.
   */
  developmentNames: developmentDatabaseNames(),
});

if (!verdict.ok) {
  console.error('\nGATE FAILED: the database target is not usable.\n');
  for (const reason of verdict.reasons) console.error(`  ${reason}`);
  console.error(
    '\nSet DATABASE_URL to a disposable test database, for example:\n' +
      '  DATABASE_URL="postgresql://USER:PASSWORD@127.0.0.1:5432/easeit_test?schema=public"\n',
  );
  process.exit(1);
}

process.env.DATABASE_URL = DATABASE_URL;

const API = process.env.EASEIT_API_URL ?? 'http://127.0.0.1:4100/api/v1';
process.env.EASEIT_API_URL = API;

const suites = [
  {
    name: 'outbox (PostgreSQL only)',
    script: 'test/integration/outbox.test.mjs',
    why: 'enqueue, dedupe, claim, lease, retry, dead letter, constraints',
  },
  {
    name: 'outbox claim race',
    script: 'test/concurrency/outbox-claim.test.mjs',
    why: 'N dispatchers racing one batch; concurrent reapers',
  },
  {
    name: 'check-in',
    script: 'test/integration/check-in.test.mjs',
    why: 'check-in state machine and room assignment',
  },
  {
    name: 'folio payment idempotency',
    script: 'test/integration/folio-payment.test.mjs',
    why: 'one payment per key, concurrent same-key POSTs, by-key reconciliation read',
  },
  {
    name: 'cancellation + concurrency',
    script: 'test/integration/cancel-reservation.test.mjs',
    why: 'release-once, lock timeouts, cancel vs check-in, cancel vs move, stale assignment',
  },
  {
    name: 'creation races',
    script: 'test/integration/create-race.test.mjs',
    why: 'create vs cancel, create vs cross-category move, three-way',
  },
  {
    name: 'inventory horizon',
    script: 'test/integration/inventory-horizon.test.mjs',
    why: 'per-date capacity, overbooking allowance, room blocks reduce sellable count',
  },
  {
    name: 'room type CRUD',
    script: 'test/integration/room-type-crud.test.mjs',
    why: 'create/edit/retire a category; retiring one with live stays is refused',
  },
  {
    name: 'room CRUD',
    script: 'test/integration/room-crud.test.mjs',
    why: 'add/edit/retire a room; retiring an occupied room is refused',
  },
  {
    name: 'room status',
    script: 'test/integration/room-status.test.mjs',
    why: 'housekeeping status transitions and out-of-order handling',
  },
  {
    name: 'inventory tenancy',
    script: 'test/integration/inventory-tenancy.test.mjs',
    why: 'another property’s room types, rooms and blocks are not-found, never 403',
  },
  {
    name: 'room blocks + overbooking',
    script: 'test/integration/room-blocks.test.mjs',
    why: 'block/release counters per date and category, parallel blocks, allowance per range',
  },
  {
    name: 'room retirement',
    script: 'test/integration/room-retirement.test.mjs',
    why: 'retire refusals, physical decrement, retire vs last booking race',
  },
  {
    name: 'rates',
    script: 'test/integration/rates.test.mjs',
    why: 'plans, calendar precedence, occupancy and promotion arithmetic, tenancy',
  },
  {
    name: 'rate pricing (F9)',
    script: 'test/integration/rate-pricing.test.mjs',
    why: 'quotes and bookings priced per night from a plan; check-in posts the arrival night',
  },
  {
    name: 'occupancy, promotions, restrictions, derived plans',
    script: 'test/integration/rate-booking-features.test.mjs',
    why: 'extras and discounts price bookings; last-redemption race; MinLOS/CTA/CTD; linked plans',
  },
  {
    name: 'refunds and settlement (FO-12, FO-13)',
    script: 'test/integration/folio-settlement.test.mjs',
    why: 'reversing refunds capped per payment, idempotent keys, zero-balance close, close vs posting races',
  },
  {
    name: 'no-show (RS-13)',
    script: 'test/integration/no-show.test.mjs',
    why: 'release once per date and category, idempotent and parallel, refusals, no-show vs cancel race',
  },
  {
    name: 'stay dates (RS-11, RS-12)',
    script: 'test/integration/stay-dates.test.mjs',
    why: 'extend/shorten/move release and sell per date and category, kept nights keep their price, total = sum of nights, charged nights protected, last-room race, change vs cancel race, tenancy',
  },
  {
    name: 'front-desk board (FD-09)',
    script: 'test/integration/front-desk-board.test.mjs',
    why: 'due in / arrived / overdue arrivals, due out / departed today / overstays, in house; room readiness; balances only with folio:read; housekeeping 403; tenancy',
  },
  {
    name: 'booking confirmation email (NO-04)',
    script: 'test/integration/booking-confirmation.test.mjs',
    why: 'one outbox row per confirmed booking in its own transaction (none without email, for instant check-in or a failed booking), id-only payload, sent once by the worker handler, cancelled stay skipped, tenancy, retry after a relay failure',
  },
  {
    name: 'invoices (FO-14)',
    script: 'test/integration/invoices.test.mjs',
    why: 'closed folio only, agrees with the folio page, gapless per-year numbering, re-issue and 8-way race give one invoice, PDF/CSV, immutable by trigger, permissions, tenancy, company bill-to, hotel GSTIN',
  },
  {
    name: 'night audit (NA-01 .. NA-06)',
    script: 'test/integration/night-audit.test.mjs',
    why: 'enqueue-only requests, 8 ordered steps, no-show roll, nightly charge once, settle, snapshot, date roll, idempotent re-run, racing executors, resume, per-timezone schedule',
  },
  {
    name: 'tenant isolation (MT-02 .. MT-05, MT-08)',
    script: 'test/integration/tenant-isolation.test.mjs',
    why: 'every tenant table has forced RLS; the app login sees nothing unscoped and only its property scoped; the extension scopes, stamps and refuses; cross-property API calls are 404',
  },
  {
    name: 'account lifecycle (AU-08, AU-14, AU-15)',
    script: 'test/integration/account-lifecycle.test.mjs',
    why: 'single-use expiring reset and invitation links, sessions revoked on reset, invite/accept, deactivation blocks sign-in and sessions; needs MAIL_CAPTURE_DIR shared with the API',
  },
  {
    name: 'housekeeping (HK-01 .. HK-05)',
    script: 'test/integration/housekeeping.test.mjs',
    why: 'board, one active task per room and type under a race, assignment and completion tracking, inspection gating, housekeeping blind to folios, tenancy',
  },
  {
    name: 'unavailable permissions (AU-13)',
    script: 'test/integration/unavailable-permissions.test.mjs',
    why: 'custom roles cannot grant unbuilt features; no role or session reports them',
  },
  {
    name: 'alerting (OB-06, WK-11)',
    script: 'test/integration/alerting.test.mjs',
    why: 'a dead letter reaches a webhook/email and is stamped once; a sink outage or timeout loses nothing; stuck leases alert with a cooldown; production needs a sink',
  },
  {
    name: 'audit log viewer (AD-03)',
    script: 'test/integration/audit-log.test.mjs',
    why: 'audit_log:read required; another property 404; actor/entity/event filters; hotel-local dates; paging exact at microsecond precision',
  },
  {
    name: 'snapshot reports (RP-05, RP-08, RP-09, RP-10, GR-02)',
    script: 'test/integration/snapshot-reports.test.mjs',
    why: 'closed days read from daily_snapshot, never the live counters: revenue, flash, sales, dashboard, group view; tax report reconciles to folio tax lines; 403 housekeeping, 404 another property',
  },
  {
    name: 'guests and direct billing (GP-02, GP-07)',
    script: 'test/integration/guests-and-direct-billing.test.mjs',
    why: 'profiles suggest by email/phone and never merge; links refused across profiles and properties; bill-to-company 8-way race gives one transfer mirrored by one folio line; company payments capped, 8-way race gives one; invoice balance is the billed amount; append-only ledger; 403/404',
  },
  {
    name: 'payment links (FO-15, FO-16)',
    script: 'test/integration/payment-links.test.mjs',
    why: 'Razorpay stand-in: per-property switch, one link per key, signed webhook only, a captured payment posted once under repeated webhooks and 6 racing checks, captured-after-close flagged not posted, cancel, ledger, 403/404, cross-property webhook refused; API needs the RAZORPAY_* test values',
  },
];

console.log('════ release gate (integration) ════');
console.log(`  allowlist : ${ALLOWED_DATABASES}`);
console.log(`  api       : ${API}\n`);

/* ------------------------------------------------------------- preflight -- */

const preflight = spawnSync(
  process.execPath,
  ['scripts/require-services.mjs', `--db=${ALLOWED_DATABASES}`, `--api=${API}`],
  { stdio: 'inherit' },
);

if (preflight.error || preflight.status !== 0) {
  console.error('\nGATE FAILED: prerequisites not met. No suite was run and nothing was changed.');
  process.exit(1);
}

/* ---------------------------------------------------------------- suites -- */

const results = [];
let failed = null;

for (const suite of suites) {
  console.log(`\n──── ${suite.name} ────`);
  console.log(`     ${suite.why}`);
  const started = Date.now();

  // The suites inherit DATABASE_URL and EASEIT_API_URL from this process, so
  // they run against exactly what the preflight just verified.
  const run = spawnSync(process.execPath, [suite.script], { stdio: 'inherit' });
  const ms = Date.now() - started;

  if (run.error) {
    results.push({ name: suite.name, status: `could not run (${run.error.code})`, ms });
    failed = { ...suite, detail: String(run.error.message) };
    break;
  }

  const ok = run.status === 0 && run.signal === null;
  results.push({
    name: suite.name,
    status: ok ? 'pass' : `FAIL (exit ${String(run.status ?? run.signal)})`,
    ms,
  });

  if (!ok) {
    failed = { ...suite, detail: `exit ${String(run.status ?? run.signal)}` };
    break;
  }
}

console.log('\n════ integration summary ════');
for (const result of results) {
  console.log(
    `  ${result.status === 'pass' ? 'PASS' : 'FAIL'}  ${result.name} ${String(result.ms)}ms`,
  );
}

if (failed !== null) {
  console.error(`\nGATE FAILED at "${failed.name}" — ${failed.detail}.`);
  console.error("Fixtures are cleaned up by each suite's own teardown, including on failure;");
  console.error('check its output for a CLEANUP line before re-running.');
  process.exit(1);
}

console.log(`\nIntegration gate passed (${String(results.length)} suite(s)).`);
console.log('Not covered here: Redis/BullMQ recovery, backup/restore, shared-fixture stress.');
console.log('  pnpm gate:resilience');
