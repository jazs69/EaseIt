/**
 * The Redis destructive-run policy, in the shapes the resilience suite uses.
 *
 * ===========================================================================
 * Phase 2's `gate-guards` suite tests these policies as policies. This one
 * tests them as *this caller configures them*, plus the wiring that decides
 * when each applies -- which is a different question and the one that was
 * never asked before: `outbox-redis.test.mjs` previously called
 * `redisRefusal`, the **development** policy. That checked scheme, loopback,
 * not-6379 and an approved port. It never knew which run it was, never looked
 * at the queue namespace, and had no notion of who owned the instance -- on a
 * suite whose job includes `obliterate({ force: true })`, the wrong question
 * answered well.
 *
 * Two kinds of check again:
 *
 *   1. BEHAVIOURAL, over `redisTestRefusals` and `verifyRedisOwnership`, with
 *      a fake Docker executor. No daemon, no socket, no `process.env`.
 *   2. STRUCTURAL, over the suite's source, read with its comments stripped --
 *      because prose has broken these assertions five times in this work, in
 *      both directions.
 * ===========================================================================
 */

import { readFileSync } from 'node:fs';

import { verifyRedisOwnership } from '../../scripts/lib/redis-container.mjs';
import { REDIS_BOUNDARIES, redisModeFrom, redisTestRefusals } from '../support/isolation-guard.mjs';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const SUITE = readFileSync(
  new URL('../integration/outbox-redis.test.mjs', import.meta.url),
  'utf8',
);
/** Comments stripped: see the note in `run-identity.test.mjs`. */
const SUITE_CODE = SUITE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const RUN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_RUN = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const CID = 'c'.repeat(64);
const PREFIX = `bull:test:${RUN}`;

/** External: a per-job service container on the approved port. */
const external = (overrides = {}) => ({
  mode: 'external',
  url: 'redis://127.0.0.1:6380',
  prefix: PREFIX,
  runId: RUN,
  boundary: 'ci-job-service',
  ...overrides,
});

/** Owned: an ephemeral port, with the triple from one inspection. */
const owned = (overrides = {}) => ({
  mode: 'owned',
  url: 'redis://127.0.0.1:49176',
  prefix: PREFIX,
  runId: RUN,
  container: { id: CID, label: RUN, mappedPort: '49176' },
  ...overrides,
});

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
const inspectOut = ({ id = CID, running = 'true', label = RUN, port = '49176' } = {}) =>
  `${id}\n${running}\n${label}\n0.0.0.0,${port} ::,${port} `;

function fakeExec(reply) {
  const calls = [];
  const exec = ({ args }) => {
    calls.push(args);
    return typeof reply === 'function' ? reply(args) : reply;
  };
  exec.calls = calls;
  return exec;
}

const reasonsOf = (input) => redisTestRefusals(input);
const accepted = (input) => reasonsOf(input).length === 0;

/* ========================================================================== */
console.log('Redis destructive-run policy, as the suite configures it (pure)\n');

/* -------------------------------------------------------------------------- */
/*  Valid configurations                                                      */
/* -------------------------------------------------------------------------- */

console.log('Accepted configurations.');
check(
  'a complete external configuration is accepted',
  accepted(external()),
  'CI service container',
);
check('a complete owned configuration is accepted', accepted(owned()), 'run-created container');
for (const boundary of REDIS_BOUNDARIES) {
  check(`external accepts the ${boundary} boundary`, accepted(external({ boundary })));
}
check(
  'owned accepts an ephemeral port the allowlist would refuse',
  accepted(
    owned({
      url: 'redis://127.0.0.1:49176',
      container: { id: CID, label: RUN, mappedPort: '49176' },
    }),
  ) && !accepted(external({ url: 'redis://127.0.0.1:49176' })),
  'docker -P allocates; the triple pays for the waiver',
);
check(
  'a further-namespaced prefix is accepted in both modes',
  accepted(external({ prefix: `${PREFIX}:outbox` })) &&
    accepted(owned({ prefix: `${PREFIX}:outbox` })),
);

/* -------------------------------------------------------------------------- */
/*  Mode                                                                      */
/* -------------------------------------------------------------------------- */

console.log('\nMode fails closed.');
for (const mode of [undefined, null, '', 'owned ', 'OWNED', 'external ', 'test', 'production']) {
  const reasons = reasonsOf({ ...owned(), mode });
  check(
    `mode ${JSON.stringify(mode)} is refused`,
    reasons.length === 1 && reasons[0].includes('is not one of'),
  );
}
check(
  'development is refused as a destructive mode',
  reasonsOf({ ...owned(), mode: 'development' })[0]?.includes('not a destructive-run mode') ===
    true,
  'that is what the retired redisRefusal implemented',
);
check(
  'and no mode is inferred from the address',
  reasonsOf({ ...owned(), mode: undefined }).length === 1,
  'loopback and a port describe a convention, not an owner',
);

/* ---- how the suite chooses it ---- */
check('no container id selects external', redisModeFrom({}) === 'external');
check('a container id selects owned', redisModeFrom({ containerId: CID }) === 'owned');
check('a blank container id selects external', redisModeFrom({ containerId: '  ' }) === 'external');
check(
  'selection never yields development',
  [{}, { containerId: CID }].every((input) => redisModeFrom(input) !== 'development'),
);

/* -------------------------------------------------------------------------- */
/*  External: the boundary declaration                                        */
/* -------------------------------------------------------------------------- */

console.log('\nExternal requires a declared boundary.');
{
  const missing = reasonsOf(external({ boundary: undefined }));
  check('a missing boundary is refused', missing.length === 1);
  check(
    'and the refusal says loopback and the port are not ownership',
    missing[0].includes('do not establish ownership'),
    'the honest statement of what external can and cannot prove',
  );
  check(
    'an unrecognised boundary is refused',
    reasonsOf(external({ boundary: 'ci-job-sevice' })).length === 1,
    'a typo in a closed set',
  );
  check(
    'owned needs no boundary',
    accepted(owned({ boundary: undefined })),
    'its evidence is the container triple',
  );
}

/* -------------------------------------------------------------------------- */
/*  External: the address is the only evidence, so it is held strictly        */
/* -------------------------------------------------------------------------- */

console.log('\nExternal target validation.');
for (const [label, url, needle] of [
  ['an unapproved port', 'redis://127.0.0.1:49176', 'not an approved test port'],
  ['the development port 6379', 'redis://127.0.0.1:6379', '6379'],
  ['a non-loopback host', 'redis://redis.example.com:6380', 'not local'],
  ['database 7', 'redis://127.0.0.1:6380/7', 'database'],
  ['database 1', 'redis://127.0.0.1:6380/1', 'database'],
  ['a malformed URL', 'not-a-url', 'malformed'],
  ['a missing URL', undefined, 'malformed'],
  ['the wrong scheme', 'http://127.0.0.1:6380', 'malformed'],
]) {
  const reasons = reasonsOf(external({ url }));
  check(
    `external refuses ${label}`,
    reasons.some((reason) => reason.includes(needle)),
    reasons[0]?.slice(0, 64),
  );
}
check(
  'database 0 and a bare path are accepted',
  accepted(external({ url: 'redis://127.0.0.1:6380/0' })) &&
    accepted(external({ url: 'redis://127.0.0.1:6380/' })),
);
check(
  '6379 is refused in OWNED mode too',
  reasonsOf(
    owned({
      url: 'redis://127.0.0.1:6379',
      container: { id: CID, label: RUN, mappedPort: '6379' },
    }),
  ).some((reason) => reason.includes('6379')),
  'ownership never licenses the development instance',
);
check(
  'a database is refused in owned mode too',
  reasonsOf(owned({ url: 'redis://127.0.0.1:49176/7' })).some((reason) =>
    reason.includes('database'),
  ),
);

/* -------------------------------------------------------------------------- */
/*  Owned: the container evidence                                             */
/* -------------------------------------------------------------------------- */

console.log('\nOwned requires consistent container evidence.');
for (const [label, container] of [
  ['evidence missing entirely', undefined],
  ['evidence is null', null],
  ['the id is missing', { label: RUN, mappedPort: '49176' }],
  [
    'the id is a 12-character short form',
    { id: CID.slice(0, 12), label: RUN, mappedPort: '49176' },
  ],
  ['the label is missing', { id: CID, mappedPort: '49176' }],
  ['the label belongs to another run', { id: CID, label: OTHER_RUN, mappedPort: '49176' }],
  ['the mapped port is missing', { id: CID, label: RUN }],
  ['the mapped port is not the URL port', { id: CID, label: RUN, mappedPort: '6380' }],
]) {
  check(
    `owned refuses when ${label}`,
    reasonsOf(owned({ container })).length > 0,
    reasonsOf(owned({ container }))[0]?.slice(0, 60),
  );
}
check(
  'a container id alone is not ownership',
  reasonsOf(owned({ container: { id: CID } })).length > 0,
  'classification is not verification',
);
check(
  'an invalid run id cannot vacuously match an equally invalid label',
  reasonsOf(owned({ runId: '', container: { id: CID, label: '', mappedPort: '49176' } })).length >
    0,
);

/* ---- the evidence gatherer, with a fake daemon ---- */
console.log('\nOwned evidence comes from one inspection.');
{
  const exec = fakeExec(ok(inspectOut()));
  const result = verifyRedisOwnership({
    exec,
    containerId: CID,
    runId: RUN,
    url: 'redis://127.0.0.1:49176',
  });
  check('a consistent container verifies', result.ok === true, result.reasons.join(' | '));
  check('from exactly one docker call', exec.calls.length === 1 && exec.calls[0][0] === 'inspect');
  check(
    'and its inspection feeds the composed policy',
    accepted(
      owned({
        container: {
          id: result.inspection.id,
          label: result.inspection.label,
          mappedPort: result.inspection.hostPort,
        },
      }),
    ),
    'one inspection, both gates',
  );

  for (const [label, out, url] of [
    ['the container is stopped', inspectOut({ running: 'false' }), 'redis://127.0.0.1:49176'],
    [
      'the inspection answers about another id',
      inspectOut({ id: 'd'.repeat(64) }),
      'redis://127.0.0.1:49176',
    ],
    ['the label is another run', inspectOut({ label: OTHER_RUN }), 'redis://127.0.0.1:49176'],
    ['the URL port is not the mapped port', inspectOut(), 'redis://127.0.0.1:6380'],
  ]) {
    const bad = verifyRedisOwnership({
      exec: fakeExec(ok(out)),
      containerId: CID,
      runId: RUN,
      url,
    });
    check(`evidence refused when ${label}`, bad.ok === false, bad.reasons[0]?.slice(0, 60));
  }
}

/* -------------------------------------------------------------------------- */
/*  Prefix                                                                    */
/* -------------------------------------------------------------------------- */

console.log('\nPrefix must belong to this run.');
for (const [label, prefix] of [
  ['the production default', 'bull'],
  ['a substring-only match', `bull${RUN}`],
  ['another run’s prefix', `bull:test:${OTHER_RUN}`],
  ['a partial segment', `${PREFIX}x`],
  ['no run id at all', 'bull:test'],
  ['a trailing colon', 'bull:test:'],
  ['missing', undefined],
  ['blank', '   '],
]) {
  for (const mode of ['external', 'owned']) {
    const input = mode === 'external' ? external({ prefix }) : owned({ prefix });
    check(
      `${mode} refuses ${label}`,
      reasonsOf(input).length > 0,
      mode === 'owned' ? reasonsOf(input)[0]?.slice(0, 56) : '',
    );
  }
}
check(
  'the production default gets its own message, not a generic one',
  reasonsOf(owned({ prefix: 'bull' })).some((reason) => reason.includes('production default')),
);

/* -------------------------------------------------------------------------- */
/*  Several failures are reported together                                    */
/* -------------------------------------------------------------------------- */

check(
  'every failing rule is reported, not just the first',
  reasonsOf({ mode: 'external', url: 'redis://127.0.0.1:49176/7', prefix: 'bull', runId: RUN })
    .length >= 4,
  'port, database, boundary and prefix',
);

/* -------------------------------------------------------------------------- */
/*  The suite's wiring, and the ordering that makes it a guard                 */
/* -------------------------------------------------------------------------- */

console.log('\nThe suite evaluates the policy before any Redis I/O (source inspection).');
{
  const at = (needle) => SUITE_CODE.indexOf(needle);

  check(
    'the development-only redisRefusal path is gone',
    !SUITE_CODE.includes('redisRefusal'),
    'it never knew the run, the namespace or the owner',
  );
  check(
    'the suite imports and calls the composed policy',
    SUITE_CODE.includes('redisTestRefusals,') &&
      /const policyProblems = redisTestRefusals\(\{/.test(SUITE_CODE),
  );
  /**
   * Scoped to the policy call, not the whole file.
   *
   * The first version of this check searched the file for
   * `prefix: QUEUE_PREFIX,` -- which also appears on the destroyer `Queue`.
   * Swapping the POLICY's prefix for `'bull'` therefore went unnoticed: the
   * destroyer's occurrence satisfied the regex. Mutation testing found it.
   */
  const policyCall =
    /const policyProblems = redisTestRefusals\(\{[\s\S]*?\n\}\);/.exec(SUITE_CODE)?.[0] ?? '';
  check(
    'the policy call passes the run-specific prefix and run id',
    policyCall.includes('prefix: QUEUE_PREFIX,') && policyCall.includes('runId: RUN,'),
    policyCall === '' ? 'call not found' : 'inside the call, not merely somewhere in the file',
  );
  check(
    'and never a literal prefix',
    !/prefix:\s*'/.test(policyCall) && !/prefix:\s*'bull'/.test(SUITE_CODE),
    'no fallback to bull anywhere',
  );
  check(
    'the policy call names the mode, boundary and container explicitly',
    ['mode: REDIS_MODE,', 'boundary: REDIS_BOUNDARY,', 'container: containerEvidence,'].every(
      (field) => policyCall.includes(field),
    ),
  );
  check(
    'mode comes from redisModeFrom, not from the URL',
    /const REDIS_MODE = redisModeFrom\(\{ containerId: REDIS_CONTAINER_ID \}\);/.test(SUITE_CODE),
  );
  check(
    'the boundary comes from the environment and is passed in',
    /const REDIS_BOUNDARY = process\.env\.EASEIT_REDIS_BOUNDARY;/.test(SUITE_CODE) &&
      /boundary: REDIS_BOUNDARY,/.test(SUITE_CODE),
  );
  check(
    'ownership evidence is gathered only in owned mode',
    /if \(REDIS_MODE === 'owned'\) \{/.test(SUITE_CODE) &&
      at("if (REDIS_MODE === 'owned') {") < at('verifyRedisOwnership({'),
    'so an external run needs no Docker',
  );
  check(
    'and that evidence is what the policy receives',
    /container: containerEvidence,/.test(SUITE_CODE) &&
      /mappedPort: owned\.inspection\.hostPort,/.test(SUITE_CODE),
  );
  /**
   * An ownership failure must stop the run, not merely be computed.
   *
   * Nothing asserted this until a mutation neutered the branch and the suite
   * stayed green: the evidence was gathered, the refusal was ignored, and the
   * composed policy then received whatever `owned.inspection` happened to be.
   */
  const ownedBranch = /if \(REDIS_MODE === 'owned'\) \{[\s\S]*?\n\}/.exec(SUITE_CODE)?.[0] ?? '';
  check(
    'an ownership failure refuses before the evidence is used',
    /if \(!owned\.ok\) refuseToRun\(owned\.reasons\);/.test(ownedBranch) &&
      ownedBranch.indexOf('refuseToRun(owned.reasons)') <
        ownedBranch.indexOf('containerEvidence = {'),
    ownedBranch === '' ? 'branch not found' : 'refusal precedes the assignment',
  );
  /**
   * Bounded to the function's own body.
   *
   * The first version used a lazy `[\s\S]*?` between the signature and
   * `process.exit(1)`. With the exit deleted, the match simply ran on to the
   * *next* `process.exit(1)` in the file -- the reachability refusal further
   * down -- and the check passed on a `refuseToRun` that only logged. Slicing
   * to the first closing brace removes the ambiguity.
   */
  const refuseBody = (() => {
    const start = SUITE_CODE.indexOf('function refuseToRun(reasons) {');
    if (start === -1) return '';
    const end = SUITE_CODE.indexOf('\n}', start);
    return end === -1 ? '' : SUITE_CODE.slice(start, end);
  })();
  check(
    'and refuseToRun actually exits',
    refuseBody !== '' && refuseBody.includes('process.exit(1);'),
    'a refusal that returns is a log line',
  );
  check(
    'every policy refusal path goes through it',
    (SUITE_CODE.match(/refuseToRun\(/g) ?? []).length === 3,
    'the declaration, the ownership refusal and the policy refusal',
  );
  check(
    'any refusal exits without running anything',
    /if \(policyProblems\.length > 0\) \{/.test(SUITE_CODE) &&
      /function refuseToRun\(reasons\) \{/.test(SUITE_CODE) &&
      /process\.exit\(1\)/.test(SUITE_CODE),
  );

  /* ---- the ordering claim, by byte offset ---- */
  const policyAt = at('const policyProblems = redisTestRefusals({');
  const later = {
    'the reachability socket': at('await redisReachable('),
    'the Prisma client': at('createPrismaClient()'),
    'the BullMQ Queue': at('new Queue('),
    obliterate: at('.obliterate('),
  };
  check(
    'the policy is evaluated before every one of them',
    policyAt !== -1 && Object.values(later).every((index) => index !== -1 && policyAt < index),
    Object.entries(later)
      .filter(([, index]) => index === -1 || policyAt > index)
      .map(([name]) => name)
      .join(', ') || 'socket, Prisma, Queue, obliterate',
  );
  check(
    'and so is the ownership check that feeds it',
    at('verifyRedisOwnership({') < at('await redisReachable('),
  );
  check(
    'no Redis client or socket precedes it',
    at('createConnection(') > policyAt && at('new Queue(') > policyAt,
    'the only socket in this file is the reachability probe',
  );

  /* ---- pre-destructive re-verification: recorded, NOT implemented ---- */
  const beforeObliterate = SUITE.slice(0, SUITE.indexOf('.obliterate('));
  check(
    'pre-destructive re-verification is recorded as an open requirement',
    SUITE.includes('NOT YET IMPLEMENTED -- pre-destructive ownership re-verification'),
    'recorded rather than claimed',
  );
  check(
    'and it is honestly reported as absent',
    (
      SUITE_CODE.slice(0, SUITE_CODE.indexOf('.obliterate(')).match(/verifyRedisOwnership\(\{/g) ??
      []
    ).length === 1,
    'exactly one call, at module load; none immediately before obliterate',
  );
  check(
    'the note sits where the call would go',
    beforeObliterate.lastIndexOf('NOT YET IMPLEMENTED') >
      beforeObliterate.lastIndexOf('async function'),
  );
}

console.log(
  failures === 0
    ? '\nAll redis-policy-wiring checks passed.'
    : `\n${String(failures)} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
