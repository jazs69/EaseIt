/**
 * The guard every destructive suite calls before it writes anything.
 *
 * ===========================================================================
 * Why each suite, and not just the release gate.
 *
 * `scripts/require-services.mjs` already refuses a shared database — but only
 * for suites invoked *through* `pnpm gate:integration`. Seven npm scripts
 * invoke the suites directly:
 *
 *     pnpm test:cancellation   pnpm test:checkin   pnpm test:concurrency
 *     pnpm test:outbox         pnpm test:outbox:redis
 *     pnpm test:outbox:concurrency                 pnpm test:races
 *
 * Run that way the preflight never executes. `pnpm test:concurrency` would
 * mutate shared inventory fixtures on the development database with no
 * refusal at all. Protection that depends on choosing the right entry point is
 * not protection, so it moves into the suites themselves.
 *
 * THE RULE ENV CANNOT OVERRIDE
 * `EASEIT_TEST_DBS` may *extend* the allowlist, which is how CI names
 * `easeit_ci`. It may not authorise the development database: the names found
 * in `packages/database/.env` and the repository root `.env` are read at
 * startup and **always refused**, whatever the allowlist says. So
 * `EASEIT_TEST_DBS=easeit pnpm test:concurrency` fails, and a stray
 * `DATABASE_URL` pointing at development fails, regardless of how the suite
 * was started.
 *
 * Checked three ways, because the cheap check is the one that lies: the URL
 * says what we *meant* to reach, `current_database()` says what we actually
 * reached, and the constraint inventory says the guards the assertions depend
 * on are really there.
 *
 * Nothing here prints a connection string: they carry passwords. Only host,
 * port and database name are ever shown.
 * ===========================================================================
 */

import { readFileSync } from 'node:fs';

/** Databases that may be used, before any environment extension. */
/**
 * The disposable databases any destructive suite may be pointed at.
 *
 * ===========================================================================
 * Exported, because it was being duplicated and the copies disagreed.
 *
 * `gate-integration.mjs` carried its own default of
 * `easeit_racetest,easeit_recovery,easeit_ci` -- missing `easeit_test`, the
 * one a developer actually uses -- so the gate refused a database this guard
 * allows, and the only way through was to remember `EASEIT_TEST_DBS`. Two
 * allowlists that disagree about which database is safe is the kind of trap
 * that eventually gets "fixed" by widening the wrong one.
 *
 * One list, exported, consumed by the gate and the payment runner. It names
 * only disposable databases; a shared one can never be added, and
 * `classifyTarget` refuses any name discovered in a developer's `.env`
 * regardless of what an environment variable claims.
 * ===========================================================================
 */
export const DEFAULT_ALLOWLIST = ['easeit_racetest', 'easeit_recovery', 'easeit_ci', 'easeit_test'];

/**
 * The databases a suite may target when it damages more than its own fixtures.
 *
 * ===========================================================================
 * A **narrowing** of `DEFAULT_ALLOWLIST`, for a different question.
 *
 * Most destructive suites create their own rows and remove them again, so any
 * disposable database will do -- including `easeit_test`, which is long-lived
 * and seeded and which the whole Layer B suite set depends on.
 *
 * Two suites are not like that:
 *
 *   * `test/concurrency/parallel-booking.test.mjs` rewrites `inventory_day`
 *     counters and says so at the end of its own run: "inventory counters for
 *     the test date were rewritten; run `pnpm db:seed` to restore them". The
 *     damage outlives teardown and the only repair is a reseed.
 *   * `test/integration/outbox-redis.test.mjs` calls
 *     `obliterate({ force: true })`, which destroys every `bull:outbox:*` key
 *     because `OutboxQueue` sets no prefix.
 *
 * Pointing either at `easeit_test` leaves a developer needing `pnpm db:seed`
 * to get their working database back -- a destructive operation of its own.
 * So those two need a database that is disposable *as a whole*, not merely
 * one that tolerates fixtures.
 *
 * `EASEIT_TEST_DBS` deliberately cannot extend this list. It extends the
 * ordinary allowlist in `classifyTarget`, where a name can be added for a
 * disposable database this repository has not heard of; "is this database
 * wholly expendable?" is not a question an environment variable should be
 * able to answer yes to. There is no override.
 * ===========================================================================
 */
export const WHOLLY_DISPOSABLE = ['easeit_racetest', 'easeit_recovery', 'easeit_ci'];

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** The guards every concurrency and inventory assertion leans on. */
const REQUIRED_CONSTRAINTS = [
  'inventory_day_not_oversold',
  'reservation_room_no_overlap',
  'inventory_day_counters_non_negative',
  'reservation_cancelled_at_matches_status',
];

/* -------------------------------------------------------------------------- */
/*  Redis endpoint policy                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The only Redis port a destructive suite may touch.
 *
 * ===========================================================================
 * Why this is an allowlist rather than a blocklist, and what it does not buy.
 *
 * `OutboxQueue` sets no BullMQ `prefix`, so every process pointed at one Redis
 * shares `bull:outbox:*`, and `outbox-redis.test.mjs` calls
 * `obliterate({ force: true })`. There is no Redis equivalent of
 * `current_database()` and no prefix to scope a verification to, so unlike the
 * PostgreSQL guard there is nothing left to check once the connection is open.
 * The URL is the entire defence, which is the argument for the strict form: a
 * blocklist of 6379 accepts 6381 from a typo and obliterates whatever is
 * there.
 *
 * The strict list costs nothing today -- `release.yml` maps the container to
 * 6380, `TESTING.md` documents 6380, and `require-services.mjs` defaults to
 * 6380.
 *
 * And it must be said plainly: **a port allowlist is not instance isolation.**
 * It cannot tell a dedicated test Redis on 6380 from a production one that
 * happens to listen there. The real fix is a per-run BullMQ prefix in
 * `OutboxQueue`, which would make the blast radius structural instead of
 * configural. That is application code and not this file's to change.
 * ===========================================================================
 */
export const APPROVED_REDIS_PORTS = [6380];

/** Never acceptable, and given its own branch because the reason is specific. */
const SHARED_REDIS_PORT = '6379';

/**
 * scheme / host / port only -- never the credentials. Pure.
 *
 * `describeTarget` above cannot be reused: its regex requires a `/database`
 * segment after the port, and a Redis URL has none. So
 * `redis://127.0.0.1:6380` parsed as `null` there and `checkRedis` reported
 * "unrecognised shape" for its own default value -- which is why
 * `gate:resilience` could not have cleared its own preflight as written.
 */
export function describeRedisTarget(url) {
  if (typeof url !== 'string' || url.trim().length === 0) return null;

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') return null;

  // Brackets are URL syntax, not part of the address.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host.length === 0) return null;

  // An absent port is not a default to fill in here. The point of this check
  // is that the target was named deliberately.
  if (!/^\d+$/.test(parsed.port)) return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;

  /**
   * The database number, which this function used to discard entirely.
   *
   * =========================================================================
   * Discarding it was a real hole: `redis://127.0.0.1:6380/7` passed every
   * check, ioredis then selected db 7, and `obliterate` destroyed that db's
   * `bull:outbox:*` -- a one-character typo relocating the whole keyspace,
   * silently.
   *
   * Two fields rather than one, because "absent" and "unparseable" are
   * different facts and the policy needs to tell them apart:
   *
   *   * `dbSpecifier` -- the raw path with one leading slash removed. `''`
   *     for both `…:6380` and `…:6380/`, since a bare trailing slash names
   *     no database. `'7'`, `'00'`, `'foo'`, `'/'` (from `//`) and `'0/1'`
   *     all survive verbatim so a refusal can quote what was actually typed.
   *   * `db` -- the parsed number, or `null` when absent OR unparseable.
   *     Informational only. Note `'00'` parses to `0`, which is exactly why
   *     the policy reads `dbSpecifier` and not this.
   *
   * Both are ADDITIVE. `scheme`, `host` and `port` are unchanged, and no
   * existing caller's destructuring is affected.
   * =========================================================================
   */
  const dbSpecifier = parsed.pathname.replace(/^\//, '');
  const db = /^\d+$/.test(dbSpecifier) ? Number(dbSpecifier) : null;

  return { scheme: parsed.protocol.slice(0, -1), host, port: String(port), dbSpecifier, db };
}

/**
 * The one Redis endpoint policy. Pure: no network, no `process.env`.
 *
 * Returns a refusal reason, or `null` when the URL may be used -- the caller
 * owns the printing and the exit, exactly as with `postConnectionRefusals`.
 * Two callers: the gate's preflight, and `outbox-redis.test.mjs`, which is
 * reachable without the gate and so cannot rely on it.
 */
export function redisRefusal({ url }) {
  const target = describeRedisTarget(url);

  if (target === null) {
    return (
      'The Redis URL is missing, malformed, or not a Redis URL. Expected ' +
      'redis:// or rediss:// with an explicit host and port, for example ' +
      `redis://127.0.0.1:${String(APPROVED_REDIS_PORTS[0])}.`
    );
  }

  if (!LOCAL_HOSTS.has(target.host)) {
    return (
      `Redis host "${target.host}" is not local. This layer calls \`obliterate\` ` +
      'on the outbox queue, which destroys every job on the instance; it will ' +
      'only do that to loopback.'
    );
  }

  if (target.port === SHARED_REDIS_PORT) {
    return (
      `Redis is on the default port ${SHARED_REDIS_PORT}, which is the shared ` +
      'development instance. `obliterate` would destroy real queue state there. ' +
      'Use a dedicated instance, e.g.: docker run -d --name easeit-redis-test ' +
      `-p ${String(APPROVED_REDIS_PORTS[0])}:6379 redis:7-alpine`
    );
  }

  if (!APPROVED_REDIS_PORTS.includes(Number(target.port))) {
    return (
      `Redis port ${target.port} is not an approved test port ` +
      `(${APPROVED_REDIS_PORTS.map(String).join(', ')}). A port allowlist is the ` +
      'only check available before `obliterate`, so it is deliberately strict.'
    );
  }

  /**
   * Last, so the more specific messages above still win.
   *
   * `redis://127.0.0.1:6379/7` should say "that is the development instance",
   * not "that is the wrong database" -- the port is the bigger problem.
   */
  return redisDbRefusal(target);
}

/* -------------------------------------------------------------------------- */
/*  Redis database number                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Only an absent database, or an explicit `0`.
 *
 * ===========================================================================
 * A database number is not an isolation boundary, so it is not offered as one.
 *
 * `FLUSHALL`, `CONFIG`, `maxmemory` eviction, connection limits and memory
 * pressure are all instance-wide; selecting db 7 buys nothing a destructive
 * suite can rely on. Permitting a non-zero database would *read* as isolation
 * while providing none, so the policy removes the ambiguity instead: either
 * the URL names no database, or it names the default one.
 *
 * Reads `dbSpecifier`, never `db`. `'00'` parses to the number 0 and would
 * pass a numeric check, while being a string nobody meant to type.
 * ===========================================================================
 */
export function redisDbRefusal(target) {
  if (target === null || target === undefined) {
    return 'The Redis URL could not be parsed, so its database could not be checked.';
  }

  const specifier = target.dbSpecifier;

  if (specifier === '' || specifier === '0') return null;

  return (
    `The Redis URL selects database ${JSON.stringify(specifier)}. Only the default ` +
    'database is permitted: leave the path off, or write "/0". A database number is ' +
    'not an isolation boundary -- FLUSHALL, CONFIG and eviction are instance-wide -- ' +
    'so it must not be used as one, and an unnoticed one would silently move every ' +
    '`bull:outbox:*` key that `obliterate` then destroys.'
  );
}

/* -------------------------------------------------------------------------- */
/*  Redis modes: how a destructive run says what it is talking to             */
/* -------------------------------------------------------------------------- */

/**
 * The three modes, and why `development` is not one a destructive run may use.
 *
 * ===========================================================================
 * The mode is always an argument. It is never inferred from the URL, because
 * inferring trust from an address is the exact mistake being corrected:
 * loopback and port 6380 describe a convention, not an owner.
 *
 *   * `development` -- the non-destructive policy `redisRefusal` already
 *     implements. Unchanged, and deliberately NOT reachable through
 *     `redisTestRefusals`: a context that calls `obliterate` has no business
 *     claiming to be development.
 *   * `external` -- a Redis this run did not create, which the environment
 *     vouches for. The only evidence available is the address, so the address
 *     rules stay strict AND the caller must declare a boundary.
 *   * `owned` -- a container this run created. The port allowlist is waived,
 *     because `docker run -P` takes an ephemeral host port and a fixed list
 *     would refuse every container; in exchange the ownership triple is
 *     required. That trade is only sound with both halves present.
 * ===========================================================================
 */
export const REDIS_MODES = ['development', 'external', 'owned'];

/**
 * What may establish an `external` boundary.
 *
 * ===========================================================================
 * These are ASSERTIONS BY THE CALLER, not verified proof of isolation.
 *
 * Nothing here can confirm them. There is no Redis equivalent of
 * `SELECT current_database()`, no prefix to scope a verification to, and this
 * module performs no I/O at all. What the policy does is refuse to proceed
 * when no claim is made -- turning a silent assumption into an auditable
 * statement that a reviewer can disagree with.
 *
 *   * `ci-job-service` -- a per-job service container whose lifetime is the
 *     job, as `.github/workflows/release.yml` provisions. The job boundary is
 *     doing the work; the guard is only recording that someone said so.
 *   * `operator-declared` -- a human asserted it. Named uncomfortably on
 *     purpose: it carries no evidence whatsoever.
 *
 * `owned` does not use these. Its evidence is the container triple, which is
 * at least checkable against the URL.
 * ===========================================================================
 */
export const REDIS_BOUNDARIES = ['ci-job-service', 'operator-declared'];

/** A run id: lowercase hex, long enough that two runs will not collide. */
const RUN_ID_PATTERN = /^[0-9a-f]{8,}$/;

/** A full Docker container id, not the 12-character short form. */
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Which mode an invocation is in, from whether a container id was supplied.
 *
 * ===========================================================================
 * This is a CLASSIFICATION, not a verification.
 *
 * A container id proves only that someone passed a string. It does not prove
 * the container exists, that this run created it, or that the URL addresses
 * it. `redisOwnershipRefusals` still demands all three fields and still
 * compares the mapped port against the URL -- selecting `owned` is what makes
 * those checks apply, not a substitute for them.
 *
 * It never returns `development`: there is no destructive context in which
 * that is the right answer.
 * ===========================================================================
 */
export function redisModeFrom({ containerId } = {}) {
  return typeof containerId === 'string' && containerId.trim() !== '' ? 'owned' : 'external';
}

/** The canonical test prefix, defined once so the gate and the suite agree. */
export function expectedTestPrefix(runId) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `Cannot build a test queue prefix from run id ${JSON.stringify(runId)}: ` +
        'expected at least 8 lowercase hex characters. A prefix derived from a ' +
        'malformed run id would not be run-scoped, which is the whole point of it.',
    );
  }
  return `bull:test:${runId}`;
}

/* -------------------------------------------------------------------------- */
/*  The boundary declaration                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `external` must say what makes the instance its own. Returns reasons.
 *
 * An unrecognised value is refused in every mode, because a typo in a closed
 * set is a configuration error wherever it appears -- silently ignoring
 * `boundary: 'ci-job-sevice'` in `owned` mode would let the same typo reach
 * `external` later unnoticed.
 */
export function redisBoundaryRefusals({ mode, boundary } = {}) {
  const reasons = [];
  const supplied = boundary !== undefined && boundary !== null;

  if (supplied && !REDIS_BOUNDARIES.includes(boundary)) {
    reasons.push(
      `boundary ${JSON.stringify(boundary)} is not recognised. ` +
        `Permitted: ${REDIS_BOUNDARIES.join(', ')}.`,
    );
    return reasons;
  }

  if (mode === 'external' && !supplied) {
    reasons.push(
      'external mode requires an explicit boundary declaration. Loopback and port ' +
        `${String(APPROVED_REDIS_PORTS[0])} do not establish ownership of a Redis instance -- ` +
        'they describe a convention. State what does: ' +
        `${REDIS_BOUNDARIES.join(' or ')}. The declaration is an assertion, not proof; ` +
        'this layer cannot verify it and only refuses to proceed without one.',
    );
  }

  return reasons;
}

/* -------------------------------------------------------------------------- */
/*  Ownership of a run-created container                                      */
/* -------------------------------------------------------------------------- */

/**
 * The only evidence in this file that says "this run created this server".
 *
 * ===========================================================================
 * Three fields, and all three must describe ONE inspected container.
 *
 *   * `id` -- a full 64-hex container id. The handle, and the only thing a
 *     removal may ever be keyed on; a name or a port must never be.
 *   * `label` -- the `easeit.run` label read back from that id. It must equal
 *     this run's id, and must itself be a well-formed run id, so an empty or
 *     malformed run id cannot make the comparison vacuous.
 *   * `mappedPort` -- the published `6379/tcp` host port of that id. It must
 *     equal the port in the URL, which is the step that ties the address the
 *     suite will connect to back to the container.
 *
 * The chain only holds if the caller read all three from the same
 * `docker inspect`. This module performs no I/O -- it cannot check that, and
 * says so rather than implying otherwise.
 *
 * Residual hole, stated plainly: a container can die and its host port be
 * reused between the inspection and the destructive call. Re-verifying
 * immediately before that call narrows the window; nothing closes it here.
 * ===========================================================================
 */
export function redisOwnershipRefusals({ mode, target, container, runId } = {}) {
  if (mode !== 'owned') return [];

  const reasons = [];

  if (container === null || container === undefined || typeof container !== 'object') {
    reasons.push(
      'owned mode requires container evidence { id, label, mappedPort }, read back from ' +
        'docker inspect. Without it there is nothing establishing that this run owns the ' +
        'instance, and owned mode waives the port allowlist on the strength of exactly that.',
    );
    return reasons;
  }

  const { id, label, mappedPort } = container;

  if (typeof id !== 'string' || !CONTAINER_ID_PATTERN.test(id)) {
    reasons.push(
      `container.id ${JSON.stringify(id)} is not a full 64-character hex container id. ` +
        'The id is the handle a removal is keyed on; a short id, a name or a port is not.',
    );
  }

  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    reasons.push(
      `runId ${JSON.stringify(runId)} is not a valid run id (at least 8 lowercase hex ` +
        'characters), so the container label cannot be matched against it.',
    );
  } else if (typeof label !== 'string' || label !== runId) {
    reasons.push(
      `container.label ${JSON.stringify(label)} does not match this run ` +
        `${JSON.stringify(runId)}. The label is what says the container was created by ` +
        'THIS run rather than found lying around.',
    );
  }

  if (target === null || target === undefined) {
    reasons.push(
      'the Redis URL could not be parsed, so the container mapped port could not be ' +
        'compared against it.',
    );
  } else if (mappedPort === undefined || mappedPort === null || String(mappedPort) === '') {
    reasons.push(
      'container.mappedPort is missing. Without it nothing ties the URL the suite will ' +
        'connect to back to the container that was inspected.',
    );
  } else if (String(mappedPort) !== String(target.port)) {
    reasons.push(
      `container.mappedPort ${JSON.stringify(String(mappedPort))} is not the port in the ` +
        `Redis URL (${target.port}). The URL addresses a different endpoint than the ` +
        'container that was inspected.',
    );
  }

  return reasons;
}

/* -------------------------------------------------------------------------- */
/*  The queue prefix must be scoped to the run                                */
/* -------------------------------------------------------------------------- */

/**
 * A test run's BullMQ prefix must carry its run id, and must not be `bull`.
 *
 * ===========================================================================
 * The run id is validated FIRST, and that ordering is load-bearing.
 *
 * Segment matching against an empty or malformed run id is vacuous --
 * `''` is a segment of nothing useful, and a one-character id matches far too
 * much. Checking the id before using it is what stops the whole policy
 * quietly passing.
 *
 * Matching is by `:`-delimited SEGMENT, not substring. `bulla1b2c3d4` contains
 * the run id and is a typo'd concatenation landing in a namespace nobody
 * intended; `bull:test:a1b2c3d4` carries it as a segment and is run-scoped.
 * `bull:test:a1b2c3d4:outbox` and `custom:test:a1b2c3d4` are equally fine --
 * further namespacing is the operator's business, run scoping is not.
 *
 * Formatting is NOT re-checked here. Blank and whitespace-padded prefixes are
 * refused at application boot by `outbox.prefix.ts` and the env schema, which
 * is one rule in one home; a padded value would fail segment matching anyway.
 * ===========================================================================
 */
export function queuePrefixRefusals({ mode, prefix, runId } = {}) {
  if (mode !== 'external' && mode !== 'owned') return [];

  const reasons = [];

  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    reasons.push(
      `runId ${JSON.stringify(runId)} is not a valid run id (at least 8 lowercase hex ` +
        'characters). Without one, "the prefix is scoped to this run" is unverifiable.',
    );
    // Everything below compares against the run id, so stop here rather than
    // reporting vacuous results.
    return reasons;
  }

  if (typeof prefix !== 'string' || prefix.trim() === '') {
    reasons.push(
      `OUTBOX_QUEUE_PREFIX ${JSON.stringify(prefix)} is missing or blank. A destructive run ` +
        `must namespace its queue: ${expectedTestPrefix(runId)}.`,
    );
    return reasons;
  }

  if (prefix === 'bull') {
    reasons.push(
      'OUTBOX_QUEUE_PREFIX is "bull", the production default -- the namespace the ' +
        'development worker and production share. `obliterate` against it destroys real ' +
        `queue state. Use a run-scoped prefix: ${expectedTestPrefix(runId)}.`,
    );
    return reasons;
  }

  if (!prefix.split(':').includes(runId)) {
    reasons.push(
      `OUTBOX_QUEUE_PREFIX ${JSON.stringify(prefix)} does not contain the run id ` +
        `${JSON.stringify(runId)} as a ":"-delimited segment, so it is not scoped to this ` +
        `run. A substring is not enough. Expected something like ${expectedTestPrefix(runId)}.`,
    );
  }

  return reasons;
}

/* -------------------------------------------------------------------------- */
/*  The composed destructive-run policy                                       */
/* -------------------------------------------------------------------------- */

/**
 * Everything a destructive Redis run must satisfy, in one call.
 *
 * ===========================================================================
 * Returns reasons, empty when there are none -- the caller owns the throwing
 * and the formatting, exactly as with `postConnectionRefusals`. Composed from
 * the pure pieces above so each policy is testable on its own and this
 * function only decides the order.
 *
 * It fails closed on the mode. An absent, unknown or `development` mode is a
 * refusal rather than a default, because the one thing worse than the wrong
 * policy here is a guessed one.
 *
 * NO CALLER YET. Phase 2 adds the policy; wiring the gate and the suite to it
 * is a later change. Until then, setting `OUTBOX_QUEUE_PREFIX` or
 * `EASEIT_RUN_ID` changes nothing -- and must not be set, because the
 * integration suite's own destroyer `Queue` does not yet share the prefix.
 * ===========================================================================
 */
export function redisTestRefusals({ mode, url, prefix, runId, boundary, container } = {}) {
  if (!REDIS_MODES.includes(mode)) {
    return [
      `mode ${JSON.stringify(mode)} is not one of ${REDIS_MODES.join(', ')}. ` +
        'A destructive Redis run states its mode; it is never inferred from the URL, ' +
        'because an address describes a convention and not an owner.',
    ];
  }

  if (mode === 'development') {
    return [
      'development is not a destructive-run mode. It describes the ordinary, ' +
        'non-destructive policy in `redisRefusal`. A context that calls ' +
        '`obliterate({ force: true })` must be external or owned.',
    ];
  }

  const target = describeRedisTarget(url);

  if (target === null) {
    // Nothing below is meaningful without a parsed target, and reporting
    // "database not permitted" for an unparseable URL would mislead.
    return [
      'The Redis URL is missing, malformed, or not a Redis URL. Expected redis:// or ' +
        'rediss:// with an explicit host and port, for example ' +
        `redis://127.0.0.1:${String(APPROVED_REDIS_PORTS[0])}.`,
    ];
  }

  const reasons = [];

  /* ---- address rules that hold in both modes ---- */
  if (!LOCAL_HOSTS.has(target.host)) {
    reasons.push(
      `Redis host "${target.host}" is not local. This layer calls \`obliterate\` on the ` +
        'outbox queue, which destroys every job on the instance; it will only do that ' +
        'to loopback.',
    );
  }

  if (target.port === SHARED_REDIS_PORT) {
    reasons.push(
      `Redis is on the default port ${SHARED_REDIS_PORT}, which is the shared development ` +
        'instance. `obliterate` would destroy real queue state there.',
    );
  } else if (mode === 'external' && !APPROVED_REDIS_PORTS.includes(Number(target.port))) {
    /**
     * Enforced for `external` and waived for `owned`.
     *
     * `owned` takes an ephemeral host port from `docker run -P`, so a fixed
     * list would refuse every container this run creates. The waiver is paid
     * for by the ownership triple below, which is stronger evidence than a
     * port ever was.
     */
    reasons.push(
      `Redis port ${target.port} is not an approved test port ` +
        `(${APPROVED_REDIS_PORTS.map(String).join(', ')}). In external mode the address is ` +
        'the only evidence available, so it is held strictly; owned mode waives this and ' +
        'requires container evidence instead.',
    );
  }

  const dbProblem = redisDbRefusal(target);
  if (dbProblem !== null) reasons.push(dbProblem);

  /* ---- mode-specific evidence ---- */
  reasons.push(...redisBoundaryRefusals({ mode, boundary }));
  reasons.push(...redisOwnershipRefusals({ mode, target, container, runId }));
  reasons.push(...queuePrefixRefusals({ mode, prefix, runId }));

  return reasons;
}

/** host / port / dbname only — never the credentials. */
export function describeTarget(url) {
  /**
   * The host alternation handles bracketed IPv6 (`[::1]`) as well as a
   * hostname or IPv4 literal. Without it `postgresql://u:p@[::1]:5432/db`
   * failed to parse and the caller saw "unrecognised shape" -- which is
   * fail-closed and therefore safe, but it would have refused a legitimate
   * loopback target. Caught by the unit test for local-host acceptance.
   */
  const parsed = /^(\w+):\/\/(?:[^:@/]+(?::[^@/]*)?@)?(\[[^\]]+\]|[^/:]+):(\d+)\/([^?\s]*)/.exec(
    url ?? '',
  );
  if (parsed === null) return null;
  const [, scheme, host, port, name] = parsed;
  // Brackets are URL syntax, not part of the address.
  return { scheme, host: host.replace(/^\[|\]$/g, ''), port, name };
}

/**
 * Shared database names that are refused even when no `.env` file exists.
 *
 * ===========================================================================
 * Discovery from `.env` is necessary but not sufficient, and CI proved it.
 *
 * `.env` files are gitignored, so a fresh checkout has none — and on GitHub
 * Actions run 40820963243 the `fast` job therefore discovered **zero**
 * development names. That broke a unit test, which is how it was found, but
 * the real problem was worse than a red check: with an empty discovered set,
 * `EASEIT_TEST_DBS=easeit` would have *authorised* the shared development
 * database, because the denylist that is supposed to override the allowlist
 * was empty.
 *
 * So the known shared names are seeded unconditionally. Discovery still runs
 * and still adds whatever a developer's own files name, but the floor no
 * longer depends on a file that version control deliberately does not carry.
 * ===========================================================================
 */
const ALWAYS_FORBIDDEN = new Set(['easeit']);

/**
 * Database names this repository's env files point at.
 *
 * Discovery only — the unconditional floor lives in `classifyTarget`, because
 * the two signals mean different things and conflating them caused a CI
 * failure. See the precedence note there.
 */
export function developmentDatabaseNames({
  readFile = (path) => readFileSync(path, 'utf8'),
  files = ['packages/database/.env', '.env', 'apps/api/.env'],
} = {}) {
  const names = new Set();
  for (const file of files) {
    let text;
    try {
      text = readFile(file);
    } catch {
      continue; // A missing env file is ordinary, not an error.
    }
    for (const match of text.matchAll(/^(?:DATABASE_URL|DIRECT_URL)\s*=\s*"?([^"\r\n]+)"?/gm)) {
      const target = describeTarget(match[1]);
      if (target !== null && target.name.length > 0) names.add(target.name);
    }
  }
  return names;
}

/**
 * The whole decision, as a pure function, so every rejection path is testable
 * without a database. Returns `{ ok, target, reasons }`.
 */
export function classifyTarget({ url, allowExtra = '', developmentNames = new Set() }) {
  const reasons = [];

  const target = describeTarget(url);
  if (target === null) {
    return {
      ok: false,
      target: null,
      reasons: ['DATABASE_URL is missing or has an unrecognised shape.'],
    };
  }

  const extra = allowExtra
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const builtInTestNames = new Set(DEFAULT_ALLOWLIST);
  const allowed = new Set([...DEFAULT_ALLOWLIST, ...extra]);

  /**
   * Three tiers, in this order, and the order is the whole design.
   *
   * =======================================================================
   * Two different signals were conflated once, and CI caught it.
   *
   * The first version seeded the discovered-name set with a hard-coded floor
   * and refused anything in it. That broke GitHub Actions, because the
   * integration workflow *writes* `packages/database/.env` pointing at
   * `easeit_ci` -- so discovery dutifully reported the suite's own disposable
   * database as "development" and the gate refused the one database it was
   * supposed to use:
   *
   *     x  "easeit_ci" is a shared development database.
   *
   * The two signals are not the same thing:
   *
   *   1. `ALWAYS_FORBIDDEN` -- names known to be shared and never disposable.
   *      Absolute. No environment variable, allowlist entry or env file can
   *      authorise one. This is the rule that stops
   *      `EASEIT_TEST_DBS=easeit`.
   *   2. `developmentNames` -- whatever this checkout's env files happen to
   *      point at. A useful hint locally, where it catches a non-standard
   *      personal database name. Meaningless in CI, where the env files are
   *      written by the workflow and name a throwaway database. So it refuses
   *      only names that are NOT built-in test databases, and
   *      `EASEIT_TEST_DBS` cannot override it either -- only the built-in
   *      list can.
   *   3. The allowlist -- `DEFAULT_ALLOWLIST` plus `EASEIT_TEST_DBS`.
   * =======================================================================
   */
  if (ALWAYS_FORBIDDEN.has(target.name)) {
    reasons.push(
      `"${target.name}" is a known shared database. It can never be a ` +
        'destructive-test target, and no environment variable can authorise it.',
    );
  } else if (developmentNames.has(target.name) && !builtInTestNames.has(target.name)) {
    reasons.push(
      `"${target.name}" is what this checkout's .env files point at, and it is not one ` +
        `of the built-in disposable test databases (${[...builtInTestNames].sort().join(', ')}). ` +
        'Refusing it as your working database; EASEIT_TEST_DBS cannot override this.',
    );
  } else if (!allowed.has(target.name)) {
    reasons.push(
      `"${target.name}" is not a permitted isolated database. Permitted: ` +
        `${[...allowed].sort().join(', ')}. Set EASEIT_TEST_DBS to extend that list ` +
        '(it can never include a known shared database).',
    );
  }

  if (!LOCAL_HOSTS.has(target.host)) {
    reasons.push(`host "${target.host}" is not local; refusing to mutate it.`);
  }

  return { ok: reasons.length === 0, target, reasons };
}

/**
 * `classifyTarget`, then narrowed to the wholly disposable list.
 *
 * ===========================================================================
 * The composed decision, in one pure place, because it had no test.
 *
 * `gate-resilience.mjs` used to do this in two steps of top-level script
 * code: call `classifyTarget`, then check `WHOLLY_DISPOSABLE.includes(...)`
 * itself. Both steps were right, but a top-level statement in a script that
 * spawns suites cannot be imported, so the most important guarantee of that
 * gate -- *`easeit_test` is refused even when `EASEIT_TEST_DBS` names it* --
 * was asserted only by reading the source for a substring. A refactor that
 * dropped the second step would have kept that assertion passing if the
 * substring survived in a comment.
 *
 * So the composition lives here, next to the list it applies, and the gate
 * calls it. Nothing is duplicated: the ordinary tiers are still
 * `classifyTarget`'s and the strict list is still the single exported
 * `WHOLLY_DISPOSABLE`. `assertIsolatedDatabase` and `postConnectionRefusals`
 * are untouched -- this is the *pre*-connection twin of
 * `postConnectionRefusals`' `disposableOnly` tier, and both read the same
 * array.
 *
 * Pure: no file reads, no `process.env`, no network. `developmentNames` is a
 * parameter for the reason given on `postConnectionRefusals` -- this function
 * does not get to decide what "development" means, its caller discovers that
 * and hands it over.
 * ===========================================================================
 */
export function classifyDisposableTarget({ url, allowExtra = '', developmentNames = new Set() }) {
  const verdict = classifyTarget({ url, allowExtra, developmentNames });
  if (!verdict.ok) return verdict;

  /**
   * `allowExtra` is deliberately not consulted again.
   *
   * It has already done its one legitimate job inside `classifyTarget`:
   * naming a disposable database this repository has not heard of. "Is this
   * database wholly expendable?" is not a question an environment variable
   * gets to answer yes to, so `EASEIT_TEST_DBS` cannot reach this tier.
   */
  if (!WHOLLY_DISPOSABLE.includes(verdict.target.name)) {
    return {
      ok: false,
      target: verdict.target,
      reasons: [
        `"${verdict.target.name}" is not wholly disposable. This layer rewrites shared ` +
          'inventory counters and calls `obliterate` on the outbox queue, and the only ' +
          'repair is `pnpm db:seed`.',
        `Permitted here: ${[...WHOLLY_DISPOSABLE].sort().join(', ')}. ` +
          'EASEIT_TEST_DBS cannot extend this list.',
      ],
    };
  }

  return verdict;
}

/**
 * The refusal thrown when the API under test reached a different database.
 *
 * ===========================================================================
 * Extracted so there is exactly one copy of this sentence.
 *
 * `create-race.test.mjs` composes this message, and the unit suite needs to
 * assert on it. The unit suite cannot import that file -- importing it runs
 * the whole integration suite -- so the first attempt kept its own copy of the
 * template and asserted against that. Those assertions passed by construction
 * and would have kept passing if the real message regressed, which is worse
 * than no test: it reads as coverage.
 *
 * A pure function in the module both sides already import fixes that without
 * adding a file or a layer. The integration guard calls it; the unit suite
 * calls the same function and compares against output recorded from a real
 * failing run.
 * ===========================================================================
 */
export function apiMismatchMessage({ api, propertyId, status, isolatedDb }) {
  return (
    `REFUSING TO RUN. The API at ${api} cannot see this suite's property ` +
    `${propertyId} (HTTP ${String(status)}). It is pointed at a different ` +
    `database. Start an API whose DATABASE_URL names "${isolatedDb}".`
  );
}

function refuse(suite, lines) {
  const message =
    `REFUSING TO RUN — ${suite}\n` +
    'This suite creates, mutates and deletes fixtures, so it must not touch a\n' +
    'shared database. Nothing has been changed.\n' +
    lines.map((line) => `  x  ${line}`).join('\n') +
    '\nSee TESTING.md for how to provision an isolated database.';
  return new Error(message);
}

/**
 * Everything that can only be decided once the server has answered.
 *
 * ===========================================================================
 * Pure, and it takes the discovered names as an argument.
 *
 * These three rules used to be inline in `assertIsolatedDatabase`, and the
 * only way to exercise them was a `developmentNamesOverride` option on that
 * function -- a test-only seam on the guard that stops destructive suites
 * touching real data. An option whose whole purpose is to change what the
 * guard considers dangerous is one a production caller can pass too, and the
 * fact that none does today is not a property anything enforces.
 *
 * So the policy moved here instead. The set is a parameter because this
 * function does not get to decide what "development" means -- its caller
 * discovers that from disk and hands it over. Tests call it with whatever set
 * the case needs; `assertIsolatedDatabase` calls it with the real one and has
 * no way to be told otherwise.
 *
 * Returns the reasons to refuse, empty when there are none, so the caller
 * owns the throwing and the message formatting.
 * ===========================================================================
 */
export function postConnectionRefusals({
  urlName,
  liveName,
  developmentNames,
  disposableOnly = false,
}) {
  const reasons = [];

  // What the URL claimed, versus what the server says it actually is. A proxy
  // or a `search_path` trick cannot land us somewhere else after the URL
  // check passed.
  if (liveName !== urlName) {
    reasons.push(
      `DATABASE_URL names "${urlName}" but the live connection is to ` +
        `"${liveName}". The URL and the server disagree.`,
    );
    // No point asking anything else about a name we have just refused.
    return reasons;
  }

  /**
   * The built-in exemption, which has to match the pre-connection rule.
   *
   * `classifyTarget` refuses a discovered name only when it is **not** one of
   * the built-in disposable databases. This check lacked that exemption once,
   * and in CI -- where the workflow writes `packages/database/.env` pointing
   * at `easeit_ci`, so discovery reports the throwaway database as
   * "development" -- every suite would have refused here after passing every
   * other check. The two checks now ask the question the same way.
   */
  if (developmentNames.has(liveName) && !DEFAULT_ALLOWLIST.includes(liveName)) {
    reasons.push(
      `the live connection is to the development database "${liveName}", and it is not ` +
        `one of the built-in disposable test databases ` +
        `(${[...DEFAULT_ALLOWLIST].sort().join(', ')}).`,
    );
  }

  /**
   * The strict tier, against the live identity.
   *
   * Not reachable through `assertIsolatedDatabase` while the equality check
   * above returns early -- it is there so the strict policy does not silently
   * depend on that staying as strict as it is. Reachable directly, which is
   * why it is now covered rather than merely asserted to exist.
   *
   * `EASEIT_TEST_DBS` is not consulted, exactly as in the pre-connection tier.
   */
  if (disposableOnly && !WHOLLY_DISPOSABLE.includes(liveName)) {
    reasons.push(
      `the live connection is to "${liveName}", which is not wholly disposable. ` +
        'This suite damages more than its own fixtures and the only repair is ' +
        '`pnpm db:seed`.',
      `Permitted here: ${[...WHOLLY_DISPOSABLE].sort().join(', ')}. ` +
        'EASEIT_TEST_DBS cannot extend this list.',
    );
  }

  return reasons;
}

/**
 * Call this BEFORE creating, mutating or deleting any fixture.
 *
 * Throws on any doubt. Returns the confirmed target so a suite can log it.
 */
export async function assertIsolatedDatabase({
  prisma,
  suite,
  requireConstraints = true,
  /**
   * For suites whose damage outlives their own teardown.
   *
   * Applied **after** `classifyTarget` has passed, never instead of it: every
   * ordinary rule -- the shared-database floor, development-database
   * detection, the allowlist, the local-host restriction -- still has to hold
   * first. This only removes `easeit_test` from what is left, because that
   * database is long-lived and a reseed is the only way back from these two
   * suites. See `WHOLLY_DISPOSABLE`.
   */
  disposableOnly = false,
  env = process.env,
}) {
  /**
   * Discovered here, and only here.
   *
   * There is deliberately no option to supply this set. It decides what the
   * guard treats as dangerous, so a caller able to replace it could disarm
   * the guard entirely -- and "no production caller passes it" is a habit,
   * not a guarantee. The policy that consumes it is `postConnectionRefusals`,
   * which is pure and takes the set as an argument, so the cases can be
   * tested without putting a seam on this function.
   */
  const developmentNames = developmentDatabaseNames();
  const verdict = classifyTarget({
    url: env.DATABASE_URL,
    allowExtra: env.EASEIT_TEST_DBS ?? '',
    developmentNames,
  });

  if (!verdict.ok) throw refuse(suite, verdict.reasons);

  /**
   * The extra tier, and it is deliberately not reachable from the environment.
   *
   * `EASEIT_TEST_DBS` is not consulted here. A name it added has already been
   * accepted as *a* disposable database by `classifyTarget`; whether it is
   * expendable enough to have its inventory counters rewritten is a different
   * claim, and not one an environment variable gets to make.
   */
  if (disposableOnly && !WHOLLY_DISPOSABLE.includes(verdict.target.name)) {
    throw refuse(suite, [
      `"${verdict.target.name}" is disposable enough for suites that clean up after ` +
        'themselves, but not for this one: it damages more than its own fixtures and ' +
        'the only repair is `pnpm db:seed`.',
      `Permitted here: ${[...WHOLLY_DISPOSABLE].sort().join(', ')}. ` +
        'EASEIT_TEST_DBS cannot extend this list.',
    ]);
  }

  // What the URL claims, versus what the server says it actually is.
  const [live] = await prisma.$queryRaw`SELECT current_database() AS name, version() AS version`;

  /**
   * The post-connection policy, in one place.
   *
   * The rules themselves live in `postConnectionRefusals`, which is pure and
   * takes the discovered names as an argument. This function owns getting
   * that set honestly and turning a refusal into the thrown error; it has no
   * way to be handed a different set.
   */
  const liveRefusals = postConnectionRefusals({
    urlName: verdict.target.name,
    liveName: live.name,
    developmentNames,
    disposableOnly,
  });
  if (liveRefusals.length > 0) throw refuse(suite, liveRefusals);

  if (requireConstraints) {
    const rows = await prisma.$queryRaw`
      SELECT conname FROM pg_constraint
      WHERE conname IN ('inventory_day_not_oversold', 'reservation_room_no_overlap',
                        'inventory_day_counters_non_negative',
                        'reservation_cancelled_at_matches_status')`;
    const present = new Set(rows.map((row) => row.conname));
    const missing = REQUIRED_CONSTRAINTS.filter((name) => !present.has(name));
    if (missing.length > 0) {
      throw refuse(suite, [
        `missing constraint(s): ${missing.join(', ')}. Run \`prisma migrate deploy\`; ` +
          'these suites assert behaviour those constraints provide, so a green run ' +
          'without them would prove nothing.',
      ]);
    }
  }

  console.log(
    `  guard  ${suite}: ${verdict.target.host}:${verdict.target.port}/${live.name} ` +
      `(${live.version.split(',')[0]})`,
  );
  return { ...verdict.target, liveName: live.name };
}

/**
 * For suites that drive the API: prove the API reached the same database.
 *
 * Without it a suite could assert against the isolated database while the
 * endpoints quietly wrote to development — every assertion passing for the
 * wrong reason. The probe is a row this suite can see; an API on another
 * database cannot.
 */
export async function assertApiSharesDatabase({ suite, api, probe }) {
  const result = await probe();
  if (!result.ok) {
    throw refuse(suite, [
      `the API at ${api} does not share this database (${result.detail}). ` +
        'Start an API whose DATABASE_URL is the same isolated database.',
    ]);
  }
  console.log(`  guard  ${suite}: API ${api} confirmed on the same database`);
}
