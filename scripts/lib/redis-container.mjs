/**
 * The lifecycle of one run-owned, disposable Redis container.
 *
 * ===========================================================================
 * Why this exists: a port is not an owner.
 *
 * `test/integration/outbox-redis.test.mjs` calls `obliterate({ force: true })`.
 * Until now the only evidence anything had about the target was its address --
 * loopback and port 6380 -- which describes a convention, not ownership. The
 * isolation guard's Phase 2 policy can state the rules but cannot gather the
 * facts, because it is pure by contract and a unit test asserts it performs no
 * I/O. This module gathers them, and hands them straight to those same pure
 * functions rather than re-deciding anything.
 *
 * What it establishes, in one sentence: **this process created this container,
 * and the URL the suite is about to connect to is that container's published
 * port.** That chain is the only thing in the design that *proves* isolation;
 * `external` mode can only ever record an assertion.
 *
 * DESIGN RULES, each of which has a test:
 *
 *   * The container **ID** is the handle. Captured from `docker run`'s stdout
 *     and used for every subsequent call. A name or a port is never a handle,
 *     and nothing here enumerates containers -- no `docker ps`, no filters, no
 *     `prune`, no bulk removal. A cleanup that guesses is worse than none.
 *   * **One inspection** yields the id, the running state, the run label and
 *     the published port together. Reading them from separate calls would let
 *     three facts describe three different moments.
 *   * The inspected `.Id` must **equal** the captured id. Docker resolves a
 *     prefix, so asking about `abc` can answer about `abc123…`; comparing the
 *     full ids is what stops a near-miss passing.
 *   * **Fail closed.** Unparseable output, a disagreeing port pair, a missing
 *     mapping, a foreign label -- all refuse. Refusing costs a test run;
 *     guessing costs somebody's queue.
 *   * **No `process.env`, no ambient configuration.** Everything is an
 *     argument, including the executor and the clock, so the whole state
 *     machine is testable without a Docker daemon.
 *
 * It does NOT generate run ids. The caller owns run identity; this module
 * validates the shape it is given and refuses a malformed one, because a
 * label derived from a bad run id would not identify the run.
 * ===========================================================================
 */

import { spawnSync } from 'node:child_process';

import {
  describeRedisTarget,
  expectedTestPrefix,
  redisOwnershipRefusals,
} from '../../test/support/isolation-guard.mjs';

/** The container port Redis listens on. The host side is always allocated. */
export const REDIS_CONTAINER_PORT = '6379/tcp';

/** Labels. `run` is the ownership claim; `purpose` is only for human triage. */
export const RUN_LABEL = 'easeit.run';
export const PURPOSE_LABEL = 'easeit.purpose';
export const DEFAULT_PURPOSE = 'resilience-test';
export const DEFAULT_IMAGE = 'redis:7-alpine';

/** A full container id. Docker's 12-character short form is not accepted. */
const CONTAINER_ID = /^[0-9a-f]{64}$/;

/** `0.0.0.0`, `::`, `[::1]`, a hostname -- whatever Docker reports. */
const PORT_BINDING = /^(.*),(\d{1,5})$/;

/* -------------------------------------------------------------------------- */
/*  The injected executor                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The one place a real process is spawned. Everything else takes `exec`.
 *
 * Contract, so a fake is three lines:
 *
 *     exec({ args, timeoutMs }) -> { status, stdout, stderr, error? }
 *
 * `error` present means the spawn itself failed -- no Docker binary, for
 * instance -- which is a different fact from a non-zero exit and is reported
 * differently. `args` never goes through a shell: it is an argv array, so
 * nothing here needs quoting and Windows needs no special case.
 */
export function createDockerExec() {
  return ({ args, timeoutMs = 30_000 }) => {
    const result = spawnSync('docker', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      ...(result.error ? { error: result.error } : {}),
    };
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Strip anything that could be a secret before text reaches a reason.
 *
 * Redis passwords reach `redis-cli` through argv or an env flag, and Docker
 * echoes the command back in some error paths. A refusal is printed to a
 * terminal and often into CI logs, so it is scrubbed rather than trusted.
 */
export function redact(text, secrets = []) {
  if (typeof text !== 'string') return '';

  let scrubbed = text
    .replace(/(REDISCLI_AUTH=)[^\s'"]+/g, '$1***')
    .replace(/(-a\s+)\S+/g, '$1***')
    .replace(/(--requirepass\s+)\S+/g, '$1***')
    .replace(/(rediss?:\/\/)[^@/\s]*@/g, '$1***@');

  /**
   * Known literals, last and unconditionally.
   *
   * The shape-based rules above only catch a secret where it appears in a
   * form we anticipated. A unit test caught the gap: `redis-cli` echoed a
   * password in prose ("bad password hunter2 via …") and it sailed through.
   * When the caller knows the value, nothing it can be embedded in matters --
   * so it is replaced literally, by `split`/`join` rather than a RegExp, so a
   * password containing regex metacharacters needs no escaping.
   */
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret !== '') {
      scrubbed = scrubbed.split(secret).join('***');
    }
  }

  return scrubbed;
}

/** One line, trimmed and scrubbed, for a reason string. */
function detail(result, secrets = []) {
  const text = redact(`${result.stderr ?? ''}\n${result.stdout ?? ''}`, secrets).trim();
  const first = text.split('\n').find((line) => line.trim() !== '') ?? '';
  return first.trim().slice(0, 200);
}

/**
 * Tell "Docker is not there" apart from "Docker said no".
 *
 * They need different messages: the first is an environment the operator can
 * fix or opt out of, the second is a real failure worth quoting.
 */
function dockerUnavailable(result) {
  if (result.error !== undefined && result.error !== null) return true;
  const text = `${result.stderr ?? ''}`.toLowerCase();
  return (
    text.includes('cannot connect to the docker daemon') ||
    text.includes('is the docker daemon running') ||
    text.includes('error during connect')
  );
}

function unavailableReason(action, result) {
  return (
    `Docker is not available, so ${action} is impossible: ${detail(result) || 'no output'}. ` +
    'Start the daemon, or supply REDIS_URL and an explicit boundary declaration to use ' +
    'an instance this run does not own.'
  );
}

/**
 * The run id is validated through the guard's own definition.
 *
 * `expectedTestPrefix` throws on anything that is not a well-formed run id,
 * and it is the single place that pattern lives. Calling it here rather than
 * re-declaring the regex is deliberate: two copies of "what a run id looks
 * like" is exactly the drift this codebase keeps paying for.
 */
function runIdProblem(runId) {
  try {
    expectedTestPrefix(runId);
    return null;
  } catch (error) {
    return `runId is not usable as a container label: ${error.message}`;
  }
}

const fail = (...reasons) => ({ ok: false, reasons });

/* -------------------------------------------------------------------------- */
/*  1. Provision                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Create the container and capture its id. Nothing else.
 *
 * `-P` so Docker allocates the host port: a fixed port is a shared resource
 * two concurrent runs would fight over, and the ownership chain makes a fixed
 * port unnecessary. `--rm` so a container that exits on its own does not
 * linger; it does **not** help on a hard kill, where the container is still
 * running and the caller must report the leak.
 *
 * The id is captured immediately and returned even though nothing is verified
 * yet, because from this instant there is something to clean up -- a caller
 * that loses the id has leaked a container.
 */
export function provisionRedisContainer({
  exec,
  runId,
  image = DEFAULT_IMAGE,
  purpose = DEFAULT_PURPOSE,
  timeoutMs = 60_000,
} = {}) {
  if (typeof exec !== 'function') return fail('no Docker executor was supplied.');

  const badRunId = runIdProblem(runId);
  if (badRunId !== null) return fail(badRunId);

  const result = exec({
    args: [
      'run',
      '--detach',
      '--rm',
      '--publish-all',
      '--label',
      `${RUN_LABEL}=${runId}`,
      '--label',
      `${PURPOSE_LABEL}=${purpose}`,
      image,
    ],
    timeoutMs,
  });

  if (dockerUnavailable(result))
    return fail(unavailableReason('creating a Redis container', result));

  if (result.status !== 0) {
    return fail(
      `docker run failed (exit ${String(result.status)}): ${detail(result) || 'no output'}. ` +
        `The image ${image} may be unavailable, or the daemon refused the request.`,
    );
  }

  const containerId = (result.stdout ?? '').trim();

  if (!CONTAINER_ID.test(containerId)) {
    /**
     * Fail closed on an id we cannot use as a handle.
     *
     * A short id, an empty line or a warning printed to stdout would all leave
     * us unable to address or remove whatever was created. That is a leak, and
     * it is reported as one rather than silently ignored.
     */
    return fail(
      'docker run did not return a usable 64-character container id ' +
        `(got ${JSON.stringify(containerId.slice(0, 80))}). A container may have been ` +
        'created and cannot now be addressed; check `docker ps` by hand.',
    );
  }

  return { ok: true, containerId };
}

/* -------------------------------------------------------------------------- */
/*  2 + 4. One inspection, four facts                                         */
/* -------------------------------------------------------------------------- */

/**
 * The single `docker inspect` the whole ownership chain rests on.
 *
 * ===========================================================================
 * One call, because three facts read at three moments describe three
 * containers. The template emits four newline-separated fields:
 *
 *     .Id
 *     .State.Running
 *     the easeit.run label
 *     every host binding of 6379/tcp, as "hostIp,hostPort" pairs
 *
 * The port comes from here rather than from `docker port` for the same
 * reason: one source of truth. Docker publishes a port twice when the host
 * has IPv4 and IPv6 -- `0.0.0.0,49176` and `::,49176` -- so every binding is
 * read and they must **agree**. A disagreement means the two families lead to
 * different places, which is not a situation to guess about.
 * ===========================================================================
 */
export function inspectRedisContainer({ exec, containerId, timeoutMs = 15_000 } = {}) {
  if (typeof exec !== 'function') return fail('no Docker executor was supplied.');

  if (typeof containerId !== 'string' || !CONTAINER_ID.test(containerId)) {
    return fail(
      `containerId ${JSON.stringify(String(containerId).slice(0, 80))} is not a full ` +
        '64-character hex container id. Docker resolves prefixes, so a short id could ' +
        'answer about a different container.',
    );
  }

  const template =
    '{{.Id}}\n' +
    '{{.State.Running}}\n' +
    `{{index .Config.Labels "${RUN_LABEL}"}}\n` +
    `{{range (index .NetworkSettings.Ports "${REDIS_CONTAINER_PORT}")}}` +
    '{{.HostIp}},{{.HostPort}} {{end}}';

  const result = exec({ args: ['inspect', '--format', template, containerId], timeoutMs });

  if (dockerUnavailable(result)) {
    return fail(unavailableReason('inspecting the Redis container', result));
  }

  if (result.status !== 0) {
    const text = `${result.stderr ?? ''}`.toLowerCase();
    const gone = text.includes('no such object') || text.includes('no such container');
    return {
      ok: false,
      missing: gone,
      reasons: [
        gone
          ? `container ${containerId.slice(0, 12)}… no longer exists.`
          : `docker inspect failed (exit ${String(result.status)}): ${detail(result) || 'no output'}.`,
      ],
    };
  }

  const lines = (result.stdout ?? '').split('\n');
  if (lines.length < 4) {
    return fail(
      'docker inspect returned an unexpected shape; refusing to infer ownership from it. ' +
        `Got ${String(lines.length)} field(s), expected 4.`,
    );
  }

  const [rawId, rawRunning, rawLabel, rawPorts] = lines;
  const id = rawId.trim();
  const label = rawLabel.trim();

  /**
   * The inspected id must be the id we captured, exactly.
   *
   * Docker accepts a prefix, so an inspection can legitimately answer about a
   * longer id than the one asked for. Comparing in full is what makes "the
   * same container" a fact rather than an assumption.
   */
  if (id !== containerId) {
    return fail(
      `docker inspect answered about container ${id.slice(0, 12)}… but ` +
        `${containerId.slice(0, 12)}… was asked about. Refusing: the evidence does not ` +
        'describe the container this run created.',
    );
  }

  const runningText = rawRunning.trim();
  if (runningText !== 'true' && runningText !== 'false') {
    return fail(
      `docker inspect reported an unreadable running state ${JSON.stringify(runningText)}; ` +
        'refusing rather than assuming it is up.',
    );
  }
  const running = runningText === 'true';

  /* ---- the published port, from every binding, which must agree ---- */
  const bindings = rawPorts
    .trim()
    .split(/\s+/)
    .filter((entry) => entry !== '');

  if (bindings.length === 0) {
    return fail(
      `container ${containerId.slice(0, 12)}… publishes no host port for ` +
        `${REDIS_CONTAINER_PORT}, so nothing can connect to it.`,
    );
  }

  const ports = new Set();
  for (const binding of bindings) {
    const match = PORT_BINDING.exec(binding);
    if (match === null) {
      return fail(
        `docker inspect reported an unparseable port binding ${JSON.stringify(binding)}; ` +
          'refusing to guess which host port the suite would reach.',
      );
    }
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return fail(`docker inspect reported an out-of-range host port ${JSON.stringify(match[2])}.`);
    }
    ports.add(String(port));
  }

  if (ports.size !== 1) {
    /**
     * IPv4 and IPv6 bindings must lead to the same place.
     *
     * Normally they do -- `0.0.0.0,49176` and `::,49176`. When they do not,
     * the URL the suite uses depends on which family resolves first, and
     * `obliterate` would run against whichever that turned out to be.
     */
    return fail(
      `container ${containerId.slice(0, 12)}… publishes ${REDIS_CONTAINER_PORT} on more than ` +
        `one host port (${[...ports].sort().join(', ')}). Which one the suite reaches would ` +
        'depend on address-family resolution; refusing.',
    );
  }

  const [hostPort] = [...ports];

  return { ok: true, inspection: { id, running, label, hostPort, bindings } };
}

/**
 * The published host port, from the single inspection above.
 *
 * A thin accessor rather than a second source: `docker port` would be another
 * call at another moment, and the whole point of the inspection is that the
 * four facts arrive together.
 */
export function getMappedRedisPort({ exec, containerId, timeoutMs } = {}) {
  const inspected = inspectRedisContainer({ exec, containerId, timeoutMs });
  if (!inspected.ok) return inspected;
  return { ok: true, port: inspected.inspection.hostPort };
}

/** The URL for a container, built from its own published port. */
export function redisUrlForPort(port) {
  return `redis://127.0.0.1:${String(port)}`;
}

/* -------------------------------------------------------------------------- */
/*  3. Readiness                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `redis-cli PING`, run INSIDE the container.
 *
 * ===========================================================================
 * Inside, not over the published port, and that is the point: a reply from
 * `docker exec <id> redis-cli` came from *that* container by construction,
 * whereas a socket to a host port could be answered by anything that happens
 * to be listening there.
 *
 * A bare TCP connect -- which is what the suite does today -- cannot detect an
 * authentication failure at all: the handshake succeeds and the problem only
 * surfaces later as a BullMQ hang. `PING` answers `PONG` only once the server
 * will actually serve, and `NOAUTH`/`WRONGPASS` are failures rather than
 * silence.
 *
 * `sleep` is injected so a timeout test takes microseconds instead of six
 * seconds, and so nothing here reads a real clock.
 * ===========================================================================
 */
export async function waitForRedisReady({
  exec,
  containerId,
  attempts = 30,
  delayMs = 200,
  timeoutMs = 5_000,
  password,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof exec !== 'function') return fail('no Docker executor was supplied.');

  if (typeof containerId !== 'string' || !CONTAINER_ID.test(containerId)) {
    return fail('containerId is not a full 64-character hex container id.');
  }

  if (!Number.isInteger(attempts) || attempts < 1) {
    return fail(`attempts must be a positive integer, received ${JSON.stringify(attempts)}.`);
  }

  // The password travels as an env var rather than `-a`, which keeps it off
  // the visible command line of the process inside the container. It is still
  // in this argv, which the CLI gives no way around -- so `redact` scrubs it
  // from every message, and a provisioned container sets no password at all.
  const authArgs =
    typeof password === 'string' && password !== '' ? ['--env', `REDISCLI_AUTH=${password}`] : [];
  const secrets = typeof password === 'string' && password !== '' ? [password] : [];

  let last = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = exec({
      args: ['exec', ...authArgs, containerId, 'redis-cli', 'ping'],
      timeoutMs,
    });

    if (dockerUnavailable(result)) {
      return fail(unavailableReason('checking whether Redis is ready', result));
    }

    if (result.status === 0 && (result.stdout ?? '').trim().toUpperCase() === 'PONG') {
      return { ok: true, attempts: attempt };
    }

    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.toUpperCase();
    if (text.includes('NOAUTH') || text.includes('WRONGPASS')) {
      return fail(
        'Redis refused the credentials supplied for the readiness check ' +
          `(${detail(result, secrets)}). This would otherwise surface later as a BullMQ hang.`,
      );
    }

    last = result;
    if (attempt < attempts) await sleep(delayMs);
  }

  return fail(
    `Redis in container ${containerId.slice(0, 12)}… did not answer PING within ` +
      `${String(attempts)} attempt(s) over ~${String(attempts * delayMs)}ms` +
      `${last === null ? '' : `: ${detail(last, secrets) || 'no output'}`}.`,
  );
}

/* -------------------------------------------------------------------------- */
/*  5. Ownership                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Does this run own the server the given URL addresses?
 *
 * ===========================================================================
 * The question is answered from ONE inspection and then handed to the Phase 2
 * pure policy, which decides. Nothing is re-decided here -- that is what keeps
 * the rule in one place:
 *
 *   * the inspected id equals the captured id       (this module)
 *   * the container is running                      (this module)
 *   * id shape, label === runId, mappedPort === URL port
 *                                                   (`redisOwnershipRefusals`)
 *
 * Intended to be called twice: once after provisioning, and **again
 * immediately before the destructive operation**. The second call is what
 * catches a container that died and had its host port taken over in between.
 * It narrows that window to the gap between the inspection and `obliterate`;
 * it does not close it, and nothing available here could.
 *
 * Ownership only. The database, the port allowlist, the boundary declaration
 * and the queue prefix are the composed policy's business
 * (`redisTestRefusals`), and this does not duplicate them.
 * ===========================================================================
 */
export function verifyRedisOwnership({ exec, containerId, runId, url, timeoutMs } = {}) {
  const badRunId = runIdProblem(runId);
  if (badRunId !== null) return fail(badRunId);

  const inspected = inspectRedisContainer({ exec, containerId, timeoutMs });
  if (!inspected.ok)
    return {
      ok: false,
      reasons: inspected.reasons,
      ...(inspected.missing ? { missing: true } : {}),
    };

  const { inspection } = inspected;
  const reasons = [];

  if (!inspection.running) {
    reasons.push(
      `container ${containerId.slice(0, 12)}… is not running, so the URL cannot be ` +
        'addressing it. Refusing before any destructive operation.',
    );
  }

  const target = describeRedisTarget(url);
  if (target === null) {
    reasons.push(
      'the Redis URL is missing or malformed, so it cannot be compared with the ' +
        "container's published port.",
    );
  }

  reasons.push(
    ...redisOwnershipRefusals({
      mode: 'owned',
      target,
      runId,
      container: { id: inspection.id, label: inspection.label, mappedPort: inspection.hostPort },
    }),
  );

  return { ok: reasons.length === 0, reasons, inspection };
}

/* -------------------------------------------------------------------------- */
/*  6. Release                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Remove exactly one container, and only while it is still ours.
 *
 * ===========================================================================
 * Keyed on the captured id, and gated on the label read back now rather than
 * the one read at provisioning time. The label is re-checked because the
 * alternative -- trusting an earlier reading -- is how a cleanup ends up
 * removing something it did not create.
 *
 * Four outcomes, all explicit:
 *
 *   * no container id        -> nothing was created; **no Docker call at all**
 *   * already gone           -> success, removed: false (`--rm` may have won)
 *   * label is not ours      -> refuse, do NOT remove, report the id
 *   * removal fails          -> refuse, report it as a leak with the id
 *
 * A silent failed cleanup is worse than a loud one, so a failure is non-ok and
 * carries the id a human needs.
 * ===========================================================================
 */
export function releaseRedisContainer({ exec, containerId, runId, timeoutMs = 30_000 } = {}) {
  /**
   * Provisioning never returned an id, so there is nothing to clean up.
   *
   * Returned before `exec` is even examined: issuing a Docker command here
   * would be a command with no target, and the obvious way to write that
   * accidentally is a removal with an empty argument.
   */
  if (containerId === undefined || containerId === null || containerId === '') {
    return { ok: true, removed: false, skipped: 'no-container', reasons: [] };
  }

  if (typeof exec !== 'function') {
    return { ok: false, removed: false, reasons: ['no Docker executor was supplied.'] };
  }

  const badRunId = runIdProblem(runId);
  if (badRunId !== null) {
    return {
      ok: false,
      removed: false,
      reasons: [
        `${badRunId} Refusing to remove ${String(containerId).slice(0, 12)}… without a valid run id to match its label against.`,
      ],
    };
  }

  const inspected = inspectRedisContainer({ exec, containerId, timeoutMs });

  if (!inspected.ok) {
    if (inspected.missing === true) {
      return { ok: true, removed: false, skipped: 'already-gone', reasons: [] };
    }
    return {
      ok: false,
      removed: false,
      reasons: [
        ...inspected.reasons,
        `Refusing to remove ${String(containerId).slice(0, 12)}… without confirming it is ours.`,
      ],
    };
  }

  if (inspected.inspection.label !== runId) {
    return {
      ok: false,
      removed: false,
      foreign: true,
      reasons: [
        `container ${containerId.slice(0, 12)}… carries ${RUN_LABEL}=` +
          `${JSON.stringify(inspected.inspection.label)}, not this run ` +
          `${JSON.stringify(runId)}. It was not created here and will not be removed.`,
      ],
    };
  }

  const result = exec({ args: ['rm', '--force', containerId], timeoutMs });

  if (dockerUnavailable(result)) {
    return {
      ok: false,
      removed: false,
      reasons: [unavailableReason('removing the container', result)],
    };
  }

  if (result.status !== 0) {
    const text = `${result.stderr ?? ''}`.toLowerCase();
    if (text.includes('no such container') || text.includes('no such object')) {
      return { ok: true, removed: false, skipped: 'already-gone', reasons: [] };
    }
    return {
      ok: false,
      removed: false,
      reasons: [
        `docker rm failed for ${containerId.slice(0, 12)}… (exit ${String(result.status)}): ` +
          `${detail(result) || 'no output'}. The container is LEAKED; remove it by hand: ` +
          `docker rm -f ${containerId}`,
      ],
    };
  }

  return { ok: true, removed: true, reasons: [] };
}
