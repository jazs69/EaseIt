/**
 * Unit tests for run identity, the queue prefix, and the wiring that carries
 * it to every BullMQ client in the Redis resilience suite.
 *
 * ===========================================================================
 * Two kinds of check, and the second kind is the reason this file exists.
 *
 *   1. BEHAVIOURAL, over `scripts/lib/run-identity.mjs` -- the derivation the
 *      suite actually calls, executed here with the same inputs. It is a
 *      separate module precisely so this is possible:
 *      `outbox-redis.test.mjs` opens PostgreSQL and Redis at module scope, so
 *      importing it to test its decisions is not an option.
 *
 *   2. STRUCTURAL, over the suite's source -- that the derived prefix reaches
 *      the shared `configStub` and the standalone destroyer `Queue`, and that
 *      no `Queue` is left to default to `bull`. These cannot be behavioural
 *      without a live Redis, and the property they defend is structural
 *      anyway: in bullmq@6.4.2 a `Queue` and a `Worker` on different prefixes
 *      do not error, they silently never see each other.
 *
 * The needles for (2) are chosen so a comment cannot satisfy them. Four
 * assertions in this repository have previously passed against prose sitting a
 * few hundred bytes above the code they meant to check, so each one here is
 * mutation-tested.
 * ===========================================================================
 */

import { readFileSync } from 'node:fs';

import { generateRunId, resolveRunIdentity } from '../../scripts/lib/run-identity.mjs';
import { expectedTestPrefix, queuePrefixRefusals } from '../support/isolation-guard.mjs';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const SUITE = read('../integration/outbox-redis.test.mjs');

/**
 * The suite with its comments removed. Every structural assertion reads this.
 *
 * ===========================================================================
 * Because prose keeps breaking these checks, in both directions.
 *
 * The count assertions below went from 9 to 10 the moment a docblock in the
 * suite mentioned `` `buildRuntime(` `` while explaining the count -- the
 * comment inflated the very number it described. The mirror-image failure has
 * happened repeatedly in this repository too: an *absence* check failing
 * because a comment quoted the construct it was asserting gone.
 *
 * Counting code only fixes both, permanently, rather than requiring every
 * future comment to avoid naming the thing it documents. Line comments are
 * stripped only when they START a line, so a `redis://` inside a string is
 * untouched.
 * ===========================================================================
 */
const SUITE_CODE = SUITE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** A deterministic UUID source, so a generated id is assertable. */
const fixedUuid = () => '11111111-2222-3333-4444-555555555555';
const FIXED_ID = '11111111222233334444555555555555';
const RUN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/* ========================================================================== */
console.log('Run identity and queue prefix (pure)\n');

/**
 * The comment stripper itself, because every structural check below leans on
 * it. If it silently returned an empty string, absence assertions would all
 * pass and presence assertions would all fail loudly -- but a stripper that
 * over-reached subtly would be much quieter.
 */
check(
  'the comment-stripped view keeps the code and drops the prose',
  SUITE_CODE.length > 0 &&
    SUITE_CODE.length < SUITE.length &&
    SUITE_CODE.includes('function configStub(') &&
    !SUITE_CODE.includes('An earlier note here said'),
  `${String(SUITE.length)} → ${String(SUITE_CODE.length)} characters`,
);

/* -------------------------------------------------------------------------- */
/*  Generation: one full 32-hex id                                            */
/* -------------------------------------------------------------------------- */

check(
  'generateRunId strips the dashes from a UUID',
  generateRunId(fixedUuid) === FIXED_ID,
  generateRunId(fixedUuid),
);
check('and yields exactly 32 hex characters', /^[0-9a-f]{32}$/.test(generateRunId(fixedUuid)));
check(
  'the real randomUUID also yields 32 hex characters',
  /^[0-9a-f]{32}$/.test(generateRunId()),
  'no injected source needed for the shape to hold',
);
check(
  'two generations differ',
  generateRunId() !== generateRunId(),
  'collision at 8 characters is what this replaces',
);

/* -------------------------------------------------------------------------- */
/*  Resolution                                                                */
/* -------------------------------------------------------------------------- */

{
  const generated = resolveRunIdentity({ randomUUID: fixedUuid });
  check(
    'with nothing supplied, an id is generated and the prefix derived',
    generated.ok === true &&
      generated.runId === FIXED_ID &&
      generated.prefix === `bull:test:${FIXED_ID}`,
    generated.prefix,
  );
  check(
    'and the derivation is the guard’s own expectedTestPrefix',
    generated.prefix === expectedTestPrefix(FIXED_ID),
    'not a second copy of the convention',
  );
  check(
    'the sources are reported',
    generated.source.runId === 'generated' && generated.source.prefix === 'derived',
  );

  const supplied = resolveRunIdentity({ suppliedRunId: RUN, randomUUID: fixedUuid });
  check(
    'a supplied run id wins over generation',
    supplied.ok === true && supplied.runId === RUN && supplied.source.runId === 'environment',
    'one id for the whole run, handed down by the gate',
  );
  check('and the prefix follows it', supplied.prefix === `bull:test:${RUN}`);

  const both = resolveRunIdentity({
    suppliedRunId: RUN,
    suppliedPrefix: `bull:test:${RUN}:outbox`,
    randomUUID: fixedUuid,
  });
  check(
    'a supplied prefix is honoured when it is run-scoped',
    both.ok === true && both.prefix === `bull:test:${RUN}:outbox`,
    'further namespacing is the operator’s business',
  );
  check('and reported as coming from the environment', both.source.prefix === 'environment');
}

/* -------------------------------------------------------------------------- */
/*  Failing closed                                                            */
/* -------------------------------------------------------------------------- */

console.log('\nFailing closed.');
{
  /** A truncated id is the specific mistake 3A-1 called out. */
  for (const suppliedRunId of [
    'a1b2c3d4',
    'a1b2c3d4e5f6071829',
    `${RUN}f`,
    RUN.toUpperCase(),
    `${RUN.slice(0, 31)}z`,
    ' ' + RUN,
    42,
    {},
  ]) {
    const result = resolveRunIdentity({ suppliedRunId, randomUUID: fixedUuid });
    check(
      `a supplied run id of ${JSON.stringify(String(suppliedRunId)).slice(0, 36)} is refused`,
      result.ok === false && result.reasons[0].includes('32'),
    );
    check(
      `and ${JSON.stringify(String(suppliedRunId)).slice(0, 24)} never yields a prefix`,
      result.prefix === undefined,
      'no quiet repair',
    );
  }

  /** The whole point: never `bull`. */
  const bull = resolveRunIdentity({ suppliedRunId: RUN, suppliedPrefix: 'bull' });
  check(
    'a supplied prefix of "bull" is refused',
    bull.ok === false && bull.reasons[0].includes('production default'),
    'the namespace production and the dev worker share',
  );
  check('and it does not fall back to a derived prefix', bull.prefix === undefined);

  const mismatched = resolveRunIdentity({
    suppliedRunId: RUN,
    suppliedPrefix: `bull:test:${FIXED_ID}`,
  });
  check(
    'a prefix scoped to a DIFFERENT run is refused',
    mismatched.ok === false && mismatched.reasons[0].includes('does not contain the run id'),
    'the mismatch case',
  );

  for (const suppliedPrefix of [`bull${RUN}`, 'bull:test', 'bull:test:', `bull:test:${RUN}x`]) {
    check(
      `a prefix of ${JSON.stringify(suppliedPrefix).slice(0, 30)} is refused`,
      resolveRunIdentity({ suppliedRunId: RUN, suppliedPrefix }).ok === false,
      'substring is not segment',
    );
  }

  check(
    'a blank supplied prefix falls through to derivation rather than refusing',
    resolveRunIdentity({ suppliedRunId: RUN, suppliedPrefix: '' }).prefix === `bull:test:${RUN}`,
    'unset and empty mean the same thing from an env var',
  );

  /**
   * The validator is the guard's, and the mode passed to it is immaterial.
   *
   * `resolveRunIdentity` validates with `mode: 'owned'`. If the prefix rules
   * ever diverged between the two destructive modes, that choice would start
   * mattering silently -- so it is asserted rather than assumed.
   */
  for (const prefix of ['bull', `bull:test:${RUN}`, `bull${RUN}`, 'bull:test:']) {
    const owned = queuePrefixRefusals({ mode: 'owned', prefix, runId: RUN });
    const external = queuePrefixRefusals({ mode: 'external', prefix, runId: RUN });
    check(
      `the prefix rules agree across modes for ${JSON.stringify(prefix).slice(0, 28)}`,
      JSON.stringify(owned) === JSON.stringify(external),
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  The suite's wiring                                                        */
/* -------------------------------------------------------------------------- */

console.log('\nThe Redis suite carries one prefix everywhere (source inspection).');
{
  /* ---- it calls the extracted derivation, and does not re-derive ---- */
  check(
    'the suite resolves its identity through the shared helper',
    SUITE_CODE.includes("from '../../scripts/lib/run-identity.mjs'") &&
      /const identity = resolveRunIdentity\(\{/.test(SUITE_CODE),
    'so what the unit suite runs is what the suite runs',
  );
  check(
    'it passes the environment in rather than letting the helper read it',
    /suppliedRunId: process\.env\.EASEIT_RUN_ID,/.test(SUITE_CODE) &&
      /suppliedPrefix: process\.env\.OUTBOX_QUEUE_PREFIX,/.test(SUITE_CODE),
  );
  check(
    'it refuses and exits when resolution fails',
    /if \(!identity\.ok\) \{/.test(SUITE_CODE) && /process\.exit\(1\)/.test(SUITE_CODE),
    'no run on a namespace it could not establish',
  );
  check(
    'the run id and the prefix both come from that one result',
    /const RUN = identity\.runId;/.test(SUITE_CODE) &&
      /const QUEUE_PREFIX = identity\.prefix;/.test(SUITE_CODE),
  );
  check(
    'the old 8-character truncated id is gone',
    !/randomUUID\(\)\.slice\(0, 8\)/.test(SUITE_CODE) && !SUITE_CODE.includes("from 'node:crypto'"),
    'and its now-unused import with it',
  );
  check(
    'the suite never re-derives a prefix of its own',
    !SUITE_CODE.includes('expectedTestPrefix(') && !/`bull:test:\$\{/.test(SUITE_CODE),
    'one derivation, in one place',
  );

  /* ---- the single config stub, and therefore every runtime ---- */
  const stub = /function configStub\([^)]*\) \{[\s\S]*?\n\}/.exec(SUITE_CODE)?.[0] ?? '';
  check(
    'configStub serves OUTBOX_QUEUE_PREFIX from the run constant',
    /if \(key === 'OUTBOX_QUEUE_PREFIX'\) return QUEUE_PREFIX;/.test(stub),
    'the one lever that reaches every runtime',
  );
  check(
    'and it is the only place the key is served',
    (SUITE_CODE.match(/key === 'OUTBOX_QUEUE_PREFIX'/g) ?? []).length === 1,
  );
  check(
    'an override cannot shadow it',
    stub.indexOf("key === 'OUTBOX_QUEUE_PREFIX'") < stub.indexOf('key in overrides'),
    'the prefix is not a per-runtime knob',
  );

  /**
   * Nine runtimes, one stub.
   *
   * Counted from the source, not quoted from a design note. An earlier report
   * of mine said "ten", which came from `grep -c` counting the lines that
   * mention `buildRuntime(` -- including its own declaration. Nine call sites,
   * each constructing one `OutboxQueue` and one `OutboxWorker`, is eighteen
   * BullMQ clients plus the destroyer: nineteen.
   *
   * The literal is kept so that adding a runtime trips this check and whoever
   * adds it confirms the prefix still reaches it. The equality against
   * `runtimes.push(` is the stronger half: every runtime built must also be
   * registered for shutdown, and a runtime that is built but never registered
   * would leak a worker holding the run's namespace open.
   */
  const buildCalls = (SUITE_CODE.match(/buildRuntime\(/g) ?? []).length - 1; // minus the declaration
  const registered = (SUITE_CODE.match(/runtimes\.push\(/g) ?? []).length;
  check(
    'the suite builds nine runtimes',
    buildCalls === 9,
    `${String(buildCalls)} call site(s) → ${String(buildCalls * 2)} BullMQ clients + the destroyer`,
  );
  check(
    'and every runtime built is registered for shutdown',
    buildCalls === registered,
    `${String(buildCalls)} built, ${String(registered)} registered`,
  );
  check(
    'and every one of them is built from configStub',
    (() => {
      const body = /function buildRuntime\([^)]*\) \{[\s\S]*?\n\}/.exec(SUITE_CODE)?.[0] ?? '';
      return (
        body.includes('configStub(') &&
        body.includes('new OutboxQueue(config)') &&
        body.includes('new OutboxWorker(') &&
        (SUITE_CODE.match(/configStub\(/g) ?? []).length === 2 // declaration + the single use
      );
    })(),
    'one construction path, so no runtime can differ',
  );

  /* ---- the destroyer ---- */
  check(
    'the destroyer Queue receives the same constant',
    /const destroyer = new Queue\(OUTBOX_QUEUE_NAME, \{\s*\n\s*connection: \{ url: REDIS_URL \},\s*\n\s*prefix: QUEUE_PREFIX,\s*\n\s*\}\);/.test(
      SUITE_CODE,
    ),
    'without it obliterate would destroy bull:outbox:*',
  );
  check(
    'and obliterate runs on that prefixed queue',
    SUITE_CODE.indexOf('prefix: QUEUE_PREFIX,') < SUITE_CODE.indexOf('.obliterate('),
  );

  /* ---- nothing is left on the default ---- */
  const constructions = [...SUITE_CODE.matchAll(/new (?:Queue|Worker)\s*\(/g)];
  check(
    'every BullMQ client construction in the suite is prefixed',
    constructions.length === 1,
    `${String(constructions.length)} direct construction(s); the rest go through OutboxQueue/OutboxWorker`,
  );
  check(
    'no construction is left to default to bull',
    !/new Queue\(OUTBOX_QUEUE_NAME, \{ connection: \{ url: REDIS_URL \} \}\)/.test(SUITE_CODE),
    'the pre-change shape must be gone, not merely supplemented',
  );
  check(
    'the suite never mentions a bare bull prefix as a value',
    !/prefix:\s*'bull'/.test(SUITE_CODE) && !/OUTBOX_QUEUE_PREFIX'\] = 'bull'/.test(SUITE_CODE),
  );

  /* ---- ordering: the namespace is settled before any I/O ---- */
  const at = (needle) => SUITE_CODE.indexOf(needle);
  check(
    'identity is resolved before the readiness socket, Prisma and any Queue',
    at('const identity = resolveRunIdentity({') < at('await redisReachable(') &&
      at('const identity = resolveRunIdentity({') < at('createPrismaClient()') &&
      at('const identity = resolveRunIdentity({') < at('new Queue('),
    'a namespace decided after a connection would guard nothing',
  );

  /* ---- the run id still scopes the PostgreSQL fixtures ---- */
  check(
    'the dedupeKey scope uses the same run id',
    /const KEY = \(suffix\) => `redis-e2e:\$\{RUN\}:\$\{suffix\}`;/.test(SUITE_CODE) &&
      SUITE_CODE.includes('dedupeKey: { startsWith: `redis-e2e:${RUN}:` }'),
    'one identity for Redis keys and database rows alike',
  );
}

console.log(
  failures === 0 ? '\nAll run-identity checks passed.' : `\n${String(failures)} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
