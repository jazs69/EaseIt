/**
 * Unit tests for the run-owned Redis container lifecycle. No Docker daemon.
 *
 * ===========================================================================
 * Every Docker call goes through an injected executor, so this suite drives
 * the whole state machine against a fake and asserts, among other things, the
 * exact argv it would have issued. That matters more than usual here: the
 * thing being tested is a cleanup path, and a cleanup that removes the wrong
 * container is the failure the design exists to prevent. "It refused" has to
 * be checked alongside "and it issued no removal".
 *
 * The fake records every call, so the negative cases can assert absence --
 * no `docker ps`, no `prune`, no `rm` after a refusal, and no Docker command
 * at all when provisioning never returned an id.
 * ===========================================================================
 */

import { readFileSync } from 'node:fs';

import {
  DEFAULT_IMAGE,
  PURPOSE_LABEL,
  REDIS_CONTAINER_PORT,
  RUN_LABEL,
  getMappedRedisPort,
  inspectRedisContainer,
  provisionRedisContainer,
  redact,
  redisUrlForPort,
  releaseRedisContainer,
  verifyRedisOwnership,
  waitForRedisReady,
} from '../../scripts/lib/redis-container.mjs';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

/** A 32-character hex run id, as the eventual caller will generate. */
const RUN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_RUN = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const CID = 'c'.repeat(64);
const PORT = '49176';
const TARGET_URL = redisUrlForPort(PORT);

/** Four newline-separated fields, exactly as the real template emits them. */
const inspectOut = ({
  id = CID,
  running = 'true',
  label = RUN,
  ports = `0.0.0.0,${PORT} ::,${PORT} `,
} = {}) => `${id}\n${running}\n${label}\n${ports}`;

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const nonZero = (stderr, status = 1) => ({ status, stdout: '', stderr });
const noDocker = () => ({
  status: null,
  stdout: '',
  stderr: '',
  error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }),
});

/**
 * A fake executor. `responses` maps the first argv token to a reply, or to a
 * queue of replies when a call is made repeatedly.
 */
function fakeExec(responses = {}) {
  const calls = [];
  const exec = ({ args, timeoutMs }) => {
    calls.push({ args, timeoutMs, verb: args[0] });
    const reply = responses[args[0]];
    if (reply === undefined) return nonZero(`fake: no reply configured for "${args[0]}"`);
    if (Array.isArray(reply)) return reply.length > 1 ? reply.shift() : reply[0];
    if (typeof reply === 'function') return reply({ args, calls });
    return reply;
  };
  exec.calls = calls;
  exec.verbs = () => calls.map((call) => call.verb);
  return exec;
}

const noSleep = async () => {};

/* ========================================================================== */
console.log('Redis container lifecycle (fake executor, no daemon)\n');

/* -------------------------------------------------------------------------- */
/*  1. Provisioning                                                           */
/* -------------------------------------------------------------------------- */

console.log('Provisioning.');
{
  const exec = fakeExec({ run: ok(`${CID}\n`) });
  const result = provisionRedisContainer({ exec, runId: RUN });

  check(
    'a successful run returns the captured id',
    result.ok === true && result.containerId === CID,
  );
  check('exactly one Docker call is made', exec.calls.length === 1 && exec.verbs()[0] === 'run');

  const args = exec.calls[0].args;
  check('it detaches', args.includes('--detach'));
  check(
    'it lets Docker allocate the host port',
    args.includes('--publish-all') && !args.some((arg) => /^-p$|^--publish$/.test(arg)),
    'a fixed port is a shared resource two runs would fight over',
  );
  check('it labels the run', args.includes(`${RUN_LABEL}=${RUN}`));
  check(
    'it labels the purpose',
    args.some((arg) => arg.startsWith(`${PURPOSE_LABEL}=`)),
  );
  check('it uses the default image last', args.at(-1) === DEFAULT_IMAGE);
  check(
    'it asks for automatic removal on exit',
    args.includes('--rm'),
    'does not help a hard kill, but stops a crashed container lingering',
  );
  check(
    'no argument goes through a shell',
    args.every((arg) => typeof arg === 'string'),
    'argv array, so Windows needs no quoting',
  );

  /* ---- run id is the caller's, and is validated, not generated ---- */
  for (const runId of [undefined, null, '', 'short', 'A1B2C3D4E5F60718293A4B5C6D7E8F90', 42]) {
    const bad = provisionRedisContainer({ exec: fakeExec({ run: ok(`${CID}\n`) }), runId });
    check(
      `a run id of ${JSON.stringify(runId)} is refused`,
      bad.ok === false && bad.reasons[0].includes('not usable as a container label'),
    );
  }
  check(
    'a refused run id issues no Docker call',
    (() => {
      const e = fakeExec({ run: ok(`${CID}\n`) });
      provisionRedisContainer({ exec: e, runId: 'nope' });
      return e.calls.length === 0;
    })(),
    'nothing is created, so nothing leaks',
  );
  check('a missing executor is refused', provisionRedisContainer({ runId: RUN }).ok === false);

  /* ---- Docker unavailable ---- */
  const absent = provisionRedisContainer({ exec: fakeExec({ run: noDocker() }), runId: RUN });
  check(
    'Docker being absent is reported as unavailability',
    absent.ok === false && absent.reasons[0].includes('Docker is not available'),
  );
  check(
    'and the message offers the supported alternative',
    absent.reasons[0].includes('REDIS_URL') && absent.reasons[0].includes('boundary'),
  );
  const daemonDown = provisionRedisContainer({
    exec: fakeExec({
      run: nonZero('Cannot connect to the Docker daemon at unix:///var/run/docker.sock.'),
    }),
    runId: RUN,
  });
  check(
    'a stopped daemon is unavailability, not a run failure',
    daemonDown.ok === false && daemonDown.reasons[0].includes('Docker is not available'),
  );

  /* ---- image / startup failure ---- */
  const pullFailed = provisionRedisContainer({
    exec: fakeExec({
      run: nonZero("Unable to find image 'redis:7-alpine' locally\nerror pulling image", 125),
    }),
    runId: RUN,
  });
  check(
    'an image or startup failure is reported with the exit code',
    pullFailed.ok === false &&
      pullFailed.reasons[0].includes('docker run failed (exit 125)') &&
      pullFailed.reasons[0].includes('Unable to find image'),
  );

  /* ---- invalid container id ---- */
  for (const [label, stdout] of [
    ['an empty stdout', '\n'],
    ['a 12-character short id', `${'c'.repeat(12)}\n`],
    ['a non-hex id', `${'z'.repeat(64)}\n`],
    ['a warning instead of an id', 'WARNING: something\n'],
  ]) {
    const bad = provisionRedisContainer({ exec: fakeExec({ run: ok(stdout) }), runId: RUN });
    check(
      `${label} is refused as an unusable handle`,
      bad.ok === false && bad.reasons[0].includes('64-character container id'),
    );
    check(
      `and ${label} warns that a container may be unaddressable`,
      bad.reasons[0].includes('cannot now be addressed'),
      'that is a leak and is reported as one',
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  2. One inspection, four facts                                             */
/* -------------------------------------------------------------------------- */

console.log('\nInspection.');
{
  const exec = fakeExec({ inspect: ok(inspectOut()) });
  const result = inspectRedisContainer({ exec, containerId: CID });

  check(
    'all four facts come from one call',
    result.ok === true && exec.calls.length === 1 && exec.verbs()[0] === 'inspect',
  );
  check(
    'the inspection carries id, running state, label and host port',
    result.inspection.id === CID &&
      result.inspection.running === true &&
      result.inspection.label === RUN &&
      result.inspection.hostPort === PORT,
  );
  check(
    'the template asks for the run label and the Redis port only',
    (() => {
      const [format] = exec.calls[0].args.filter((arg) => arg.includes('{{'));
      return format.includes(RUN_LABEL) && format.includes(REDIS_CONTAINER_PORT);
    })(),
  );

  /* ---- IPv4 / IPv6 ---- */
  check(
    'agreeing IPv4 and IPv6 bindings resolve to one port',
    inspectRedisContainer({
      exec: fakeExec({ inspect: ok(inspectOut({ ports: `0.0.0.0,${PORT} ::,${PORT} ` })) }),
      containerId: CID,
    }).inspection.hostPort === PORT,
  );
  check(
    'an IPv6-only binding is accepted',
    inspectRedisContainer({
      exec: fakeExec({ inspect: ok(inspectOut({ ports: `::,${PORT} ` })) }),
      containerId: CID,
    }).inspection.hostPort === PORT,
  );
  check(
    'disagreeing families are REFUSED, not reconciled',
    (() => {
      const r = inspectRedisContainer({
        exec: fakeExec({ inspect: ok(inspectOut({ ports: '0.0.0.0,49176 ::,49999 ' })) }),
        containerId: CID,
      });
      return r.ok === false && r.reasons[0].includes('more than');
    })(),
    'which one the suite reaches would depend on resolution order',
  );

  /* ---- malformed and missing port output ---- */
  for (const [label, ports] of [
    ['a binding with no comma', '0.0.0.0:49176 '],
    ['a non-numeric port', '0.0.0.0,abcd '],
    ['an out-of-range port', '0.0.0.0,99999 '],
    ['a bare colon form', ':::49176 '],
  ]) {
    const r = inspectRedisContainer({
      exec: fakeExec({ inspect: ok(inspectOut({ ports })) }),
      containerId: CID,
    });
    check(`${label} fails closed`, r.ok === false, r.reasons?.[0]?.slice(0, 70));
  }
  const noMapping = inspectRedisContainer({
    exec: fakeExec({ inspect: ok(inspectOut({ ports: '' })) }),
    containerId: CID,
  });
  check(
    'a missing port mapping is refused',
    noMapping.ok === false && noMapping.reasons[0].includes('publishes no host port'),
  );

  /* ---- unexpected shapes ---- */
  check(
    'too few fields fails closed',
    inspectRedisContainer({ exec: fakeExec({ inspect: ok(`${CID}\ntrue\n`) }), containerId: CID })
      .ok === false,
  );
  check(
    'an unreadable running state fails closed rather than assuming up',
    (() => {
      const r = inspectRedisContainer({
        exec: fakeExec({ inspect: ok(inspectOut({ running: 'maybe' })) }),
        containerId: CID,
      });
      return r.ok === false && r.reasons[0].includes('unreadable running state');
    })(),
  );

  /* ---- the wrong container answered ---- */
  const wrongId = inspectRedisContainer({
    exec: fakeExec({ inspect: ok(inspectOut({ id: 'd'.repeat(64) })) }),
    containerId: CID,
  });
  check(
    'an inspection about a different id is refused',
    wrongId.ok === false && wrongId.reasons[0].includes('does not describe the container'),
    'Docker resolves prefixes, so a near-miss must not pass',
  );

  /* ---- a short id is never sent ---- */
  const shortAsk = inspectRedisContainer({
    exec: fakeExec({ inspect: ok(inspectOut()) }),
    containerId: 'c'.repeat(12),
  });
  check(
    'a short container id is refused before any call',
    shortAsk.ok === false && shortAsk.reasons[0].includes('64-character hex'),
  );

  /* ---- missing container ---- */
  const gone = inspectRedisContainer({
    exec: fakeExec({ inspect: nonZero('Error: No such object: ' + CID) }),
    containerId: CID,
  });
  check('a vanished container is flagged as missing', gone.ok === false && gone.missing === true);

  /* ---- the thin port accessor uses the same single inspection ---- */
  const portExec = fakeExec({ inspect: ok(inspectOut()) });
  const mapped = getMappedRedisPort({ exec: portExec, containerId: CID });
  check(
    'getMappedRedisPort reads the port from that one inspection',
    mapped.ok === true && mapped.port === PORT && portExec.verbs().join(',') === 'inspect',
    'not a second `docker port` call at a second moment',
  );
}

/* -------------------------------------------------------------------------- */
/*  3. Readiness                                                              */
/* -------------------------------------------------------------------------- */

console.log('\nReadiness.');
{
  const exec = fakeExec({ exec: ok('PONG\n') });
  const ready = await waitForRedisReady({ exec, containerId: CID, sleep: noSleep });
  check('a PONG on the first try succeeds', ready.ok === true && ready.attempts === 1);
  check(
    'the ping runs INSIDE the container',
    (() => {
      const args = exec.calls[0].args;
      return (
        args[0] === 'exec' &&
        args.includes(CID) &&
        args.includes('redis-cli') &&
        args.includes('ping')
      );
    })(),
    'a reply from docker exec came from that container by construction',
  );

  const slow = fakeExec({ exec: [nonZero('not ready'), nonZero('not ready'), ok('PONG')] });
  const eventually = await waitForRedisReady({ exec: slow, containerId: CID, sleep: noSleep });
  check('it retries until ready', eventually.ok === true && eventually.attempts === 3);

  const never = fakeExec({ exec: nonZero('connection refused') });
  const timedOut = await waitForRedisReady({
    exec: never,
    containerId: CID,
    attempts: 4,
    delayMs: 10,
    sleep: noSleep,
  });
  check(
    'it gives up after the bounded number of attempts',
    timedOut.ok === false && never.calls.length === 4,
    timedOut.reasons[0]?.slice(0, 60),
  );
  check('and the timeout message names the budget', timedOut.reasons[0].includes('4 attempt(s)'));
  check(
    'a non-PONG reply with exit 0 is not treated as ready',
    (
      await waitForRedisReady({
        exec: fakeExec({ exec: ok('LOADING Redis is loading\n') }),
        containerId: CID,
        attempts: 1,
        sleep: noSleep,
      })
    ).ok === false,
    'exit status alone is not readiness',
  );

  /* ---- authentication ---- */
  const authFail = await waitForRedisReady({
    exec: fakeExec({ exec: nonZero('NOAUTH Authentication required.') }),
    containerId: CID,
    attempts: 3,
    sleep: noSleep,
  });
  check(
    'an auth failure fails fast rather than burning the retry budget',
    authFail.ok === false && authFail.reasons[0].includes('refused the credentials'),
    'a bare TCP connect cannot detect this at all',
  );
  const authed = fakeExec({ exec: ok('PONG') });
  await waitForRedisReady({ exec: authed, containerId: CID, password: 'hunter2', sleep: noSleep });
  check(
    'a password travels as an env flag, not as -a',
    authed.calls[0].args.includes('REDISCLI_AUTH=hunter2') && !authed.calls[0].args.includes('-a'),
  );
  check(
    'and no reason text ever carries it',
    (
      await waitForRedisReady({
        exec: fakeExec({ exec: nonZero('bad password hunter2 via -a hunter2') }),
        containerId: CID,
        attempts: 1,
        password: 'hunter2',
        sleep: noSleep,
      })
    ).reasons
      .join(' ')
      .includes('hunter2') === false,
    'refusals are printed, often into CI logs',
  );

  check(
    'a non-positive attempt budget is refused',
    (await waitForRedisReady({ exec, containerId: CID, attempts: 0, sleep: noSleep })).ok === false,
  );
  check(
    'Docker vanishing mid-wait is reported as unavailability',
    (
      await waitForRedisReady({
        exec: fakeExec({ exec: noDocker() }),
        containerId: CID,
        sleep: noSleep,
      })
    ).reasons[0].includes('Docker is not available'),
  );
}

/* -------------------------------------------------------------------------- */
/*  4. Ownership                                                              */
/* -------------------------------------------------------------------------- */

console.log('\nOwnership.');
{
  const good = verifyRedisOwnership({
    exec: fakeExec({ inspect: ok(inspectOut()) }),
    containerId: CID,
    runId: RUN,
    url: TARGET_URL,
  });
  check(
    'a consistent container, label and port is owned',
    good.ok === true,
    good.reasons.join(' | '),
  );

  const cases = {
    'the label belongs to another run': {
      out: inspectOut({ label: OTHER_RUN }),
      url: TARGET_URL,
      expect: 'does not match this run',
    },
    'the label is missing entirely': {
      out: inspectOut({ label: '' }),
      url: TARGET_URL,
      expect: 'does not match',
    },
    'the container is stopped': {
      out: inspectOut({ running: 'false' }),
      url: TARGET_URL,
      expect: 'not running',
    },
    'the TARGET_URL names a different port': {
      out: inspectOut(),
      url: redisUrlForPort('6380'),
      expect: 'not the port in the',
    },
    'the TARGET_URL is malformed': { out: inspectOut(), url: 'not-a-url', expect: 'malformed' },
  };

  for (const [label, { out, url, expect }] of Object.entries(cases)) {
    const result = verifyRedisOwnership({
      exec: fakeExec({ inspect: ok(out) }),
      containerId: CID,
      runId: RUN,
      url,
    });
    check(`ownership refused when ${label}`, result.ok === false);
    check(
      `and says why when ${label}`,
      result.reasons.some((reason) => reason.includes(expect)),
      result.reasons[0]?.slice(0, 70),
    );
  }

  check(
    'an invalid run id is refused before any inspection',
    (() => {
      const e = fakeExec({ inspect: ok(inspectOut()) });
      const r = verifyRedisOwnership({ exec: e, containerId: CID, runId: '', url: TARGET_URL });
      return r.ok === false && e.calls.length === 0;
    })(),
  );
  check(
    'a vanished container is not ownership',
    verifyRedisOwnership({
      exec: fakeExec({ inspect: nonZero('No such object') }),
      containerId: CID,
      runId: RUN,
      url: TARGET_URL,
    }).ok === false,
  );
  check(
    'verification can be repeated, which is how the pre-destructive re-check works',
    (() => {
      const e = fakeExec({ inspect: ok(inspectOut()) });
      const first = verifyRedisOwnership({
        exec: e,
        containerId: CID,
        runId: RUN,
        url: TARGET_URL,
      });
      const second = verifyRedisOwnership({
        exec: e,
        containerId: CID,
        runId: RUN,
        url: TARGET_URL,
      });
      return first.ok && second.ok && e.calls.length === 2;
    })(),
  );
  check(
    'ownership does not re-decide the database or the prefix',
    verifyRedisOwnership({
      exec: fakeExec({ inspect: ok(inspectOut()) }),
      containerId: CID,
      runId: RUN,
      url: `${TARGET_URL}/7`,
    }).ok === true,
    'that is the composed policy’s job; this one answers ownership only',
  );
}

/* -------------------------------------------------------------------------- */
/*  5. Release                                                                */
/* -------------------------------------------------------------------------- */

console.log('\nRelease.');
{
  const exec = fakeExec({ inspect: ok(inspectOut()), rm: ok('') });
  const released = releaseRedisContainer({ exec, containerId: CID, runId: RUN });

  check('an owned container is removed', released.ok === true && released.removed === true);
  check(
    'removal is keyed on the exact captured id',
    (() => {
      const call = exec.calls.find((entry) => entry.verb === 'rm');
      return call.args.includes(CID) && call.args.includes('--force');
    })(),
  );
  check(
    'and the label is re-read first, not trusted from provisioning time',
    exec.verbs().join(',') === 'inspect,rm',
  );

  /* ---- a foreign container is never removed ---- */
  const foreignExec = fakeExec({ inspect: ok(inspectOut({ label: OTHER_RUN })), rm: ok('') });
  const foreign = releaseRedisContainer({ exec: foreignExec, containerId: CID, runId: RUN });
  check('a foreign container is refused', foreign.ok === false && foreign.foreign === true);
  check(
    'and no removal is attempted',
    !foreignExec.verbs().includes('rm'),
    'the whole point: a cleanup that guesses is worse than none',
  );
  check('the refusal names the label it found', foreign.reasons[0].includes(OTHER_RUN));

  const unlabelled = fakeExec({ inspect: ok(inspectOut({ label: '' })), rm: ok('') });
  releaseRedisContainer({ exec: unlabelled, containerId: CID, runId: RUN });
  check('an unlabelled container is not removed either', !unlabelled.verbs().includes('rm'));

  /* ---- nothing was ever created ---- */
  for (const containerId of [undefined, null, '']) {
    const idle = fakeExec({ inspect: ok(inspectOut()), rm: ok('') });
    const result = releaseRedisContainer({ exec: idle, containerId, runId: RUN });
    check(
      `no container id (${JSON.stringify(containerId)}) means no Docker call at all`,
      result.ok === true && result.removed === false && idle.calls.length === 0,
      'a removal with an empty argument is the accident this prevents',
    );
    check(`and it is reported as skipped`, result.skipped === 'no-container');
  }

  /* ---- already gone ---- */
  const vanished = releaseRedisContainer({
    exec: fakeExec({ inspect: nonZero('Error: No such object: ' + CID) }),
    containerId: CID,
    runId: RUN,
  });
  check(
    'an already-removed container is success, not failure',
    vanished.ok === true && vanished.removed === false && vanished.skipped === 'already-gone',
    '--rm may have won the race',
  );
  const racedAway = releaseRedisContainer({
    exec: fakeExec({ inspect: ok(inspectOut()), rm: nonZero('No such container: ' + CID) }),
    containerId: CID,
    runId: RUN,
  });
  check(
    'losing the race between inspect and rm is also success',
    racedAway.ok === true && racedAway.skipped === 'already-gone',
  );

  /* ---- removal failure is loud ---- */
  const stuck = releaseRedisContainer({
    exec: fakeExec({ inspect: ok(inspectOut()), rm: nonZero('device or resource busy', 1) }),
    containerId: CID,
    runId: RUN,
  });
  check('a failed removal is non-ok', stuck.ok === false && stuck.removed === false);
  check(
    'and reports the leak with the full id a human needs',
    stuck.reasons[0].includes('LEAKED') && stuck.reasons[0].includes(CID),
    'a silent failed cleanup is worse than a loud one',
  );

  /* ---- other refusals ---- */
  check(
    'an invalid run id refuses rather than removing',
    (() => {
      const e = fakeExec({ inspect: ok(inspectOut()), rm: ok('') });
      const r = releaseRedisContainer({ exec: e, containerId: CID, runId: 'bad' });
      return r.ok === false && !e.verbs().includes('rm');
    })(),
  );
  check(
    'a missing executor refuses rather than silently doing nothing',
    releaseRedisContainer({ containerId: CID, runId: RUN }).ok === false,
  );
  check(
    'an unexplained inspect failure refuses to remove',
    (() => {
      const e = fakeExec({ inspect: nonZero('permission denied'), rm: ok('') });
      const r = releaseRedisContainer({ exec: e, containerId: CID, runId: RUN });
      return r.ok === false && !e.verbs().includes('rm');
    })(),
    'without confirming it is ours',
  );
}

/* -------------------------------------------------------------------------- */
/*  6. What the module must never do                                          */
/* -------------------------------------------------------------------------- */

console.log('\nProhibited operations (source inspection).');
{
  const source = readFileSync(
    new URL('../../scripts/lib/redis-container.mjs', import.meta.url),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  for (const forbidden of [
    'FLUSHDB',
    'FLUSHALL',
    'flushdb',
    'flushall',
    'prune',
    'system',
    'volume',
    "'ps'",
    '--filter',
    '--all',
    'killall',
  ]) {
    check(`the module never issues ${forbidden}`, !code.includes(forbidden));
  }
  /**
   * The exact set of Docker verbs the module can issue.
   *
   * Stronger than grepping for forbidden words, and immune to the prose
   * collision that the first version of this check walked into: the module's
   * own refusal text advises a human to "check `docker ps` by hand", which is
   * good advice and was indistinguishable from an executed command. This
   * reads the argv arrays instead, so only code counts.
   */
  const verbs = [...code.matchAll(/args:\s*\[\s*\n?\s*'([a-z-]+)'/g)].map((match) => match[1]);
  check(
    'the module can issue only run, inspect, exec and rm',
    verbs.length > 0 && [...new Set(verbs)].sort().join(',') === 'exec,inspect,rm,run',
    [...new Set(verbs)].sort().join(',') || 'none found',
  );
  check(
    'so it never enumerates containers',
    !verbs.includes('ps') && !verbs.includes('container') && !verbs.includes('system'),
    'nothing is removed on the strength of a name or a port',
  );
  check(
    'it reads no ambient configuration',
    !code.includes('process.env'),
    'everything is an argument, including the executor and the clock',
  );
  check(
    'the only spawn is inside the injected-executor factory',
    (code.match(/spawnSync\(/g) ?? []).length === 1 &&
      code.indexOf('spawnSync(') > code.indexOf('export function createDockerExec'),
  );
  check(
    'the run-id pattern is not re-declared here',
    !/\[0-9a-f\]\{8/.test(code),
    'it reuses expectedTestPrefix, the guard’s single definition',
  );
  check(
    'ownership is delegated to the Phase 2 pure policy',
    code.includes('redisOwnershipRefusals({') && code.includes('describeRedisTarget('),
    'the rules live in one place',
  );

  /* ---- redaction ---- */
  check(
    'redact scrubs every credential shape it is given',
    (() => {
      const scrubbed = redact(
        'redis://user:hunter2@127.0.0.1:6380 REDISCLI_AUTH=hunter2 -a hunter2 --requirepass hunter2',
      );
      return !scrubbed.includes('hunter2') && scrubbed.includes('***');
    })(),
  );
  check('redact tolerates a non-string', redact(undefined) === '' && redact(7) === '');
}

console.log(
  failures === 0
    ? '\nAll redis-container checks passed.'
    : `\n${String(failures)} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
