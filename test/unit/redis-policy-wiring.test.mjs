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
import { destructiveRefusals } from '../../scripts/lib/redis-destructive-guard.mjs';
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
  /**
   * Inside the branch, not merely before some occurrence of the call.
   *
   * The first version compared byte offsets against `verifyRedisOwnership({`
   * -- which, once the shared `inspectOwnership` closure was introduced, sits
   * *above* the branch. The offsets then said the opposite of the truth.
   * Reading the branch body says what was meant.
   */
  const startupOwnedBranch =
    /if \(REDIS_MODE === 'owned'\) \{[\s\S]*?\n\}/.exec(SUITE_CODE)?.[0] ?? '';
  check(
    'ownership evidence is gathered only in owned mode',
    startupOwnedBranch.includes('inspectOwnership({') &&
      startupOwnedBranch.includes('containerId: REDIS_CONTAINER_ID,'),
    'so an external run needs no Docker',
  );
  check(
    'and no inspection happens outside a mode guard',
    (() => {
      const calls = (SUITE_CODE.match(/inspectOwnership\(\{/g) ?? []).length;
      const inBranch = (startupOwnedBranch.match(/inspectOwnership\(\{/g) ?? []).length;
      return calls === 1 && inBranch === 1;
    })(),
    'the only direct call is the start-up one; the gate is handed the closure',
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

  /**
   * Pre-destructive re-verification is implemented, not deferred.
   *
   * The checks that used to assert a `NOT YET IMPLEMENTED` note are gone,
   * because the note is gone: keeping them would assert the absence of the
   * thing just built. The behaviour is covered by the injected-fake cases
   * above and the call-site checks below.
   */
  check(
    'no deferral note remains where the call now lives',
    !SUITE.includes('NOT YET IMPLEMENTED'),
    'the requirement is met, so the reminder is retired',
  );
}

/* -------------------------------------------------------------------------- */
/*  The pre-destructive gate                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `destructiveRefusals` -- the check immediately before `obliterate`.
 *
 * ===========================================================================
 * The start-up policy proved the target was safe THEN. Between then and the
 * destructive call the suite creates fixtures, starts and kills workers, and
 * restarts runtimes. An owned container can die in that window and its
 * ephemeral host port be taken over by another process, which leaves the URL
 * addressing a stranger while the start-up evidence still reads as valid.
 *
 * Every dependency is injected, so these cases run with no daemon, no socket
 * and no `process.env`. The two properties worth stating plainly:
 *
 *   * a **failed** re-verification must prevent `obliterate`, and
 *   * a **different** container is a refusal, never a new target.
 * ===========================================================================
 */
console.log('\nThe pre-destructive gate (pure, injected fakes).');
{
  const freshInspection = (overrides = {}) => ({
    ok: true,
    reasons: [],
    inspection: { id: CID, running: true, label: RUN, hostPort: '49176', ...overrides },
  });

  /** Records every call, so "it was not called" is assertable. */
  function spyVerify(reply = freshInspection()) {
    const calls = [];
    const verify = (args) => {
      calls.push(args);
      return typeof reply === 'function' ? reply(args) : reply;
    };
    verify.calls = calls;
    return verify;
  }

  const ownedInput = (overrides = {}) => ({
    mode: 'owned',
    url: 'redis://127.0.0.1:49176',
    prefix: PREFIX,
    runId: RUN,
    containerId: CID,
    verifyOwnership: spyVerify(),
    ...overrides,
  });

  const externalInput = (overrides = {}) => ({
    mode: 'external',
    url: 'redis://127.0.0.1:6380',
    prefix: PREFIX,
    runId: RUN,
    boundary: 'ci-job-service',
    ...overrides,
  });

  /* ---- the happy paths ---- */
  {
    const verify = spyVerify();
    const verdict = destructiveRefusals(ownedInput({ verifyOwnership: verify }));
    check(
      'successful re-verification permits the destructive call',
      verdict.ok === true,
      verdict.reasons?.join(' | '),
    );
    check(
      'and it is FRESH evidence, not the start-up reading',
      verify.calls.length === 1 &&
        verify.calls[0].containerId === CID &&
        verify.calls[0].runId === RUN &&
        verify.calls[0].url === 'redis://127.0.0.1:49176',
      're-inspected with the captured id',
    );
    check(
      'the returned evidence is the freshly inspected triple',
      verdict.evidence.id === CID &&
        verdict.evidence.label === RUN &&
        verdict.evidence.mappedPort === '49176',
    );
  }

  /* ---- external: no Docker, no pretence ---- */
  {
    const verify = spyVerify();
    const verdict = destructiveRefusals(externalInput({ verifyOwnership: verify }));
    check('external mode permits the destructive call', verdict.ok === true);
    check(
      'external mode requires NO Docker ownership evidence',
      verify.calls.length === 0,
      'nobody claims to own it; verifying would be theatre',
    );
    check('and it reports no container evidence', verdict.evidence === undefined);
    check(
      'external works with no verifier supplied at all',
      destructiveRefusals(externalInput({ verifyOwnership: undefined })).ok === true,
    );
    check(
      'but external still re-checks the target and the prefix',
      !destructiveRefusals(externalInput({ url: 'redis://127.0.0.1:6379' })).ok &&
        !destructiveRefusals(externalInput({ url: 'redis://127.0.0.1:49176' })).ok &&
        !destructiveRefusals(externalInput({ url: 'redis://127.0.0.1:6380/7' })).ok &&
        !destructiveRefusals(externalInput({ prefix: 'bull' })).ok &&
        !destructiveRefusals(externalInput({ boundary: undefined })).ok,
      'the blast radius is the prefix, so it is re-asserted',
    );
  }

  /* ---- a failed re-verification stops obliterate ---- */
  {
    const failed = destructiveRefusals(
      ownedInput({
        verifyOwnership: spyVerify({ ok: false, reasons: ['container is not running'] }),
      }),
    );
    check('a failed re-verification refuses', failed.ok === false);
    check(
      'and says the earlier proof no longer holds',
      failed.reasons.some((reason) => reason.includes('cannot be confirmed now')),
      failed.reasons[0],
    );
    check(
      'the underlying reason is preserved',
      failed.reasons.some((reason) => reason.includes('not running')),
    );
    check(
      'a verifier returning nothing usable refuses',
      destructiveRefusals(ownedInput({ verifyOwnership: () => undefined })).ok === false &&
        destructiveRefusals(ownedInput({ verifyOwnership: () => null })).ok === false,
    );
    check(
      'ok without an inspection refuses',
      destructiveRefusals(ownedInput({ verifyOwnership: () => ({ ok: true }) })).ok === false,
      'success must come with evidence',
    );
    check(
      'owned mode with no verifier at all refuses',
      destructiveRefusals(ownedInput({ verifyOwnership: undefined })).ok === false,
      'rather than reusing start-up evidence',
    );
    check(
      'owned mode with no captured container id refuses',
      destructiveRefusals(ownedInput({ containerId: undefined })).ok === false &&
        destructiveRefusals(ownedInput({ containerId: '' })).ok === false,
    );
  }

  /* ---- a changed container is a refusal, never a new target ---- */
  {
    const swapped = destructiveRefusals(
      ownedInput({ verifyOwnership: spyVerify(freshInspection({ id: 'd'.repeat(64) })) }),
    );
    check('a changed container id is refused', swapped.ok === false);
    check(
      'and is not adopted as a replacement',
      swapped.reasons.some((reason) => reason.includes('not a new target')) &&
        swapped.evidence === undefined,
      'accepting one would make ownership a tautology',
    );

    const relabelled = destructiveRefusals(
      ownedInput({ verifyOwnership: spyVerify(freshInspection({ label: OTHER_RUN })) }),
    );
    check('a changed run label is refused', relabelled.ok === false);

    const remapped = destructiveRefusals(
      ownedInput({ verifyOwnership: spyVerify(freshInspection({ hostPort: '6380' })) }),
    );
    check(
      'a changed mapped port is refused',
      remapped.ok === false,
      'the container died and something else took the port',
    );

    const reprefixed = destructiveRefusals(ownedInput({ prefix: `bull:test:${OTHER_RUN}` }));
    check('a prefix belonging to another run is refused', reprefixed.ok === false);
  }

  /* ---- no fallback to bull, in either mode ---- */
  for (const mode of ['owned', 'external']) {
    const input = mode === 'owned' ? ownedInput : externalInput;
    for (const prefix of ['bull', undefined, '   ', `bull${RUN}`, 'bull:test:']) {
      check(
        `${mode} refuses prefix ${JSON.stringify(prefix)} rather than defaulting`,
        destructiveRefusals(input({ prefix })).ok === false,
      );
    }
  }
  check(
    'and a refusal never hands back a usable prefix or evidence',
    (() => {
      const verdict = destructiveRefusals(ownedInput({ prefix: 'bull' }));
      return verdict.ok === false && verdict.evidence === undefined && verdict.prefix === undefined;
    })(),
  );

  /* ---- it delegates to the composed policy rather than reimplementing ---- */
  {
    let seen = null;
    const verdict = destructiveRefusals(
      ownedInput({
        testRefusals: (input) => {
          seen = input;
          return [];
        },
      }),
    );
    check('the composed policy is what decides', verdict.ok === true && seen !== null);
    check(
      'and it receives the fresh evidence, the prefix and the run id',
      seen.mode === 'owned' &&
        seen.prefix === PREFIX &&
        seen.runId === RUN &&
        seen.container.id === CID &&
        seen.container.mappedPort === '49176',
      'one policy, two moments',
    );
  }

  /* ---- invalid mode ---- */
  for (const mode of [undefined, null, '', 'development', 'OWNED']) {
    check(
      `mode ${JSON.stringify(mode)} refuses at the destructive gate too`,
      destructiveRefusals({ ...externalInput(), mode }).ok === false,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  The suite calls it, immediately before obliterate                         */
/* -------------------------------------------------------------------------- */

console.log('\nThe suite re-verifies before obliterate (source inspection).');
{
  const at = (needle) => SUITE_CODE.indexOf(needle);

  check(
    'the suite defines the pre-destructive gate',
    /function assertStillIsolated\(operation\) \{/.test(SUITE_CODE) &&
      /const verdict = destructiveRefusals\(\{/.test(SUITE_CODE),
  );
  check(
    'it throws on refusal, so obliterate is never reached',
    (() => {
      const start = SUITE_CODE.indexOf('function assertStillIsolated(operation) {');
      const body = SUITE_CODE.slice(start, SUITE_CODE.indexOf('\n}', start));
      return (
        body.includes('if (!verdict.ok) {') &&
        body.includes('throw new Error(') &&
        !body.includes('return false')
      );
    })(),
    'a gate that returns is a log line',
  );
  check(
    'the gate is called before the destroyer Queue is constructed',
    at("assertStillIsolated('") !== -1 &&
      at("assertStillIsolated('") < at('const destroyer = new Queue(') &&
      at("assertStillIsolated('") < at('.obliterate('),
    'the only thing standing between a dead container and obliterate',
  );
  check(
    'nothing awaited separates the gate from the Queue it guards',
    (() => {
      const between = SUITE_CODE.slice(
        at("assertStillIsolated('") + 1,
        at('const destroyer = new Queue('),
      );
      return !between.includes('await ') && between.split('\n').length < 8;
    })(),
    'awaited work in between would widen the window the gate exists to close',
  );
  /**
   * Scoped to the GATE's own call, not the file.
   *
   * The first version searched the whole suite for
   * `containerId: REDIS_CONTAINER_ID,` -- which also appears in the start-up
   * owned branch. Swapping the GATE's argument for a rediscovered
   * `containerEvidence?.id` therefore went unnoticed, which is exactly the
   * "silently accept a different container" failure this phase forbids.
   * Mutation testing found it.
   */
  const gateCall =
    /const verdict = destructiveRefusals\(\{[\s\S]*?\n  \}\);/.exec(SUITE_CODE)?.[0] ?? '';
  check(
    'the gate passes the CAPTURED container id, never a rediscovered one',
    gateCall.includes('containerId: REDIS_CONTAINER_ID,') &&
      !gateCall.includes('containerEvidence'),
    gateCall === '' ? 'gate call not found' : 'inside the gate call, not merely in the file',
  );
  check(
    'and the gate reads the same run id, prefix and url as the start-up policy',
    [
      'mode: REDIS_MODE,',
      'url: REDIS_URL,',
      'prefix: QUEUE_PREFIX,',
      'runId: RUN,',
      'boundary: REDIS_BOUNDARY,',
    ].every((field) => gateCall.includes(field)),
    'one policy, two moments, identical inputs',
  );
  check(
    'the verifier is supplied only in owned mode',
    /verifyOwnership: REDIS_MODE === 'owned' \? inspectOwnership : undefined,/.test(SUITE_CODE),
    'external mode performs no Docker inspection',
  );
  check(
    'both gates inspect through the same closure',
    /const inspectOwnership = \(\{ containerId, runId, url \}\) =>/.test(SUITE_CODE) &&
      (SUITE_CODE.match(/inspectOwnership/g) ?? []).length === 3,
    'declaration, the start-up gate and the pre-destructive gate',
  );
  check(
    'and that closure builds a fresh executor per call',
    /verifyRedisOwnership\(\{ exec: createDockerExec\(\), containerId, runId, url \}\)/.test(
      SUITE_CODE,
    ),
    'so the second inspection is a new docker inspect, not a cached answer',
  );

  /* ---- B: exactly one Redis policy path remains ---- */
  check(
    'the retired standalone redisRefusal gate is gone from the code',
    !SUITE_CODE.includes('redisRefusal'),
    'no two competing policy paths',
  );
  check(
    'and the composed policy is the only Redis gate at module scope',
    (SUITE_CODE.match(/redisTestRefusals\(\{/g) ?? []).length === 1 &&
      (SUITE_CODE.match(/destructiveRefusals\(\{/g) ?? []).length === 1,
    'one at start-up, one before the destructive call',
  );
}

/* -------------------------------------------------------------------------- */
/*  A throwing verifier is a refusal, not a crash                             */
/* -------------------------------------------------------------------------- */

/**
 * The gap a read-only audit found: `verifyOwnership` could raise.
 *
 * ===========================================================================
 * `destructiveRefusals` promises `{ ok, reasons }`, and every other failure
 * mode honoured it -- but the verifier shells out to Docker, so it can throw
 * rather than return: no `docker` binary, a dead daemon, a spawn that itself
 * raises. The exception propagated, which broke the contract in the one place
 * it matters: a caller written as `if (!destructiveRefusals(…).ok)` would
 * crash instead of refusing, and the crash would read as a harness bug rather
 * than as "ownership could not be confirmed".
 *
 * It was never unsafe at the single existing call site -- `assertStillIsolated`
 * throws on refusal anyway, so `obliterate` was unreachable either way. The
 * problem was the contract, and 3A-4 adds a second caller.
 *
 * Two properties are asserted here. The refusal must be **useful** -- it names
 * the error type and an errno-shaped code, so "Docker is not installed" is
 * distinguishable from "the daemon timed out". And it must be **silent about
 * everything else**: a Docker failure can carry the command line, Docker's
 * stderr, a Redis URL with credentials in its userinfo, or a `REDISCLI_AUTH=`
 * fragment, and these refusals are printed into terminals and CI logs.
 * ===========================================================================
 */
console.log('\nA throwing verifier fails closed (pure, injected fakes).');
{
  const inspection = { id: CID, running: true, label: RUN, hostPort: '49176' };
  const ownedWith = (verifyOwnership, overrides = {}) => ({
    mode: 'owned',
    url: 'redis://127.0.0.1:49176',
    prefix: PREFIX,
    runId: RUN,
    containerId: CID,
    verifyOwnership,
    ...overrides,
  });
  const throwing = (thrown) => () => {
    throw thrown;
  };
  const verdictFor = (thrown) => destructiveRefusals(ownedWith(throwing(thrown)));

  /* ---- an ordinary Error ---- */
  {
    const verdict = verdictFor(new Error('boom'));
    check('an ordinary Error becomes a refusal, not a crash', verdict.ok === false);
    check(
      'the refusal says the re-check threw',
      verdict.reasons[0].includes('threw') && verdict.reasons[0].includes('Error'),
      verdict.reasons[0].slice(0, 72),
    );
    check(
      'and explains that an unverifiable container is not a verified one',
      verdict.reasons.some((reason) => reason.includes('unverifiable container')),
    );
    check('two reasons: what happened, and what follows from it', verdict.reasons.length === 2);
  }

  /* ---- the reason is useful: type and errno survive ---- */
  check(
    'an errno-shaped code survives, so ENOENT is distinguishable',
    verdictFor(
      Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }),
    ).reasons[0].includes('Error: ENOENT'),
    'enough to tell "Docker is not installed" from "the daemon timed out"',
  );
  check(
    'the error subclass survives',
    verdictFor(new TypeError('x is not a function')).reasons[0].includes('TypeError'),
  );
  check(
    'a timeout code survives',
    verdictFor(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })).reasons[0].includes(
      'ETIMEDOUT',
    ),
  );

  /* ---- non-Error throws still fail closed ---- */
  for (const [label, thrown] of [
    ['a thrown string', 'plain string'],
    ['a thrown null', null],
    ['a thrown undefined', undefined],
    ['a thrown number', 42],
    ['a thrown bare object', {}],
  ]) {
    const verdict = verdictFor(thrown);
    check(`${label} fails closed`, verdict.ok === false && verdict.reasons.length === 2);
    check(
      `and ${label} is described without inventing a type`,
      verdict.reasons[0].includes('a non-Error value'),
    );
  }

  /* ---- nothing sensitive is reproduced ---- */
  {
    const loaded = Object.assign(
      new Error(
        'docker: Error response from daemon: ' +
          'redis://admin:hunter2@127.0.0.1:6380/0 REDISCLI_AUTH=s3cr3t ' +
          '--requirepass topsecret /home/jayesh/.docker/config.json',
      ),
      { code: 'ENOENT', stack: 'at hunter2 (/home/jayesh/secret.js:1:1)' },
    );
    const verdict = destructiveRefusals(ownedWith(throwing(loaded)));
    const text = verdict.reasons.join(' ');

    check('a sensitive-looking error still refuses', verdict.ok === false);
    for (const secret of [
      'hunter2',
      's3cr3t',
      'topsecret',
      'REDISCLI_AUTH',
      '--requirepass',
      'redis://',
      'admin',
      '127.0.0.1',
      '6380',
      'Error response from daemon',
      '/home/jayesh',
      'config.json',
    ]) {
      check(`the refusal does not reproduce ${JSON.stringify(secret)}`, !text.includes(secret));
    }
    check(
      'not even a truncated fragment of the message',
      !text.includes('hunt') && !text.includes('s3cr') && !text.includes('topsec'),
      'a truncated secret is still a leaked prefix',
    );
    check(
      'but the safe part is still reported',
      text.includes('ENOENT') && text.includes('threw'),
      'useful without being revealing',
    );
    check(
      'the message is never quoted verbatim, however long',
      !text.includes(loaded.message) && !text.includes(loaded.message.slice(0, 20)),
    );
  }

  /* ---- a hostile name/code cannot smuggle text through ---- */
  {
    const verdict = verdictFor({ name: 'redis://u:p@h:6380', code: 'hunter2' });
    const text = verdict.reasons.join(' ');
    check(
      'a name that is not a plain identifier is dropped, not truncated',
      verdict.ok === false &&
        text.includes('a non-Error value') &&
        !text.includes('redis://') &&
        !text.includes('hunter2'),
      'the pattern is an allowlist, so anything odd is discarded',
    );
    check(
      'a lowercase code is not errno-shaped and is dropped',
      !verdictFor({ name: 'Error', code: 'hunter2' }).reasons[0].includes('hunter2'),
    );
    check(
      'an over-long code is dropped',
      !verdictFor({ name: 'Error', code: 'A'.repeat(64) }).reasons[0].includes('AAAA'),
    );
  }

  /* ---- nothing destructive is authorized ---- */
  {
    const verdict = verdictFor(new Error('boom'));
    check('no evidence is returned after a throw', verdict.evidence === undefined);
    check('and the verdict is not ok, so a caller must refuse', verdict.ok !== true);
    check(
      'the composed policy is never consulted after a throw',
      (() => {
        let consulted = 0;
        destructiveRefusals(
          ownedWith(throwing(new Error('boom')), {
            testRefusals: () => {
              consulted += 1;
              return [];
            },
          }),
        );
        return consulted === 0;
      })(),
      'a throw cannot be overridden by an empty policy result',
    );
    check(
      'even a permissive injected policy cannot authorize it',
      destructiveRefusals(ownedWith(throwing(new Error('boom')), { testRefusals: () => [] })).ok ===
        false,
      'the refusal is returned before the policy runs',
    );
  }

  /* ---- external mode cannot reach a throwing verifier at all ---- */
  check(
    'external mode never calls the verifier, so it cannot throw',
    destructiveRefusals({
      mode: 'external',
      url: 'redis://127.0.0.1:6380',
      prefix: PREFIX,
      runId: RUN,
      boundary: 'ci-job-service',
      containerId: CID,
      verifyOwnership: throwing(new Error('must not be called')),
    }).ok === true,
    'the call sits inside the owned branch',
  );

  /* ---- every previously covered path is unchanged ---- */
  {
    const returning = (reply) => () => reply;
    check(
      'successful verification still succeeds',
      destructiveRefusals(ownedWith(returning({ ok: true, reasons: [], inspection }))).ok === true,
    );
    check(
      'failed verification still refuses, preserving its reason',
      (() => {
        const verdict = destructiveRefusals(
          ownedWith(returning({ ok: false, reasons: ['container is not running'] })),
        );
        return verdict.ok === false && verdict.reasons.some((r) => r.includes('not running'));
      })(),
    );
    check(
      'a malformed result still refuses',
      destructiveRefusals(ownedWith(returning(null))).ok === false &&
        destructiveRefusals(ownedWith(returning(undefined))).ok === false,
    );
    check(
      'ok without inspection evidence still refuses',
      destructiveRefusals(ownedWith(returning({ ok: true }))).ok === false,
    );
    check(
      'a container-id mismatch still refuses',
      destructiveRefusals(
        ownedWith(returning({ ok: true, inspection: { ...inspection, id: 'd'.repeat(64) } })),
      ).ok === false,
    );
    check(
      'a missing verifier still refuses',
      destructiveRefusals(ownedWith(undefined)).ok === false,
      'and is distinguishable from one that threw',
    );
    check(
      'the missing-verifier and threw-verifier messages differ',
      !destructiveRefusals(ownedWith(undefined)).reasons[0].includes('threw'),
    );
  }

  /* ---- the module itself quotes nothing ---- */
  {
    const guard = readFileSync(
      new URL('../../scripts/lib/redis-destructive-guard.mjs', import.meta.url),
      'utf8',
    );
    const code = guard.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check(
      'only the verifier call is inside the try',
      /try \{\s*\n\s*again = verifyOwnership\(\{ containerId, runId, url \}\);\s*\n\s*\} catch/.test(
        code,
      ),
      'a bug in this module must surface as a bug, not as "the verifier misbehaved"',
    );
    check(
      'the catch never reads the message, the stack or the output',
      (() => {
        const start = code.indexOf('} catch (error) {');
        const body = code.slice(start, code.indexOf('\n    }', start));
        return (
          !body.includes('error.message') &&
          !body.includes('.stack') &&
          !body.includes('String(error)') &&
          !body.includes('${error}')
        );
      })(),
      'it calls describeThrow, which allowlists name and code',
    );
    check(
      'describeThrow allowlists rather than sanitises',
      /\/\^\[A-Za-z\]\{1,40\}\$\//.test(code) && /\/\^\[A-Z\]\[A-Z0-9_\]\{1,31\}\$\//.test(code),
      'a value that does not match is dropped, not truncated',
    );
    check(
      'the catch is not empty and does not swallow',
      code.includes('} catch (error) {') && /catch \(error\) \{\s*\n\s*return \{/.test(code),
      'CLAUDE.md section 5: translated into the typed refusal this layer speaks',
    );
  }
}

console.log(
  failures === 0
    ? '\nAll redis-policy-wiring checks passed.'
    : `\n${String(failures)} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
