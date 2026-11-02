/**
 * One run id and one queue prefix for a destructive test run.
 *
 * ===========================================================================
 * Extracted so the derivation can be *run* by a test rather than read.
 *
 * `outbox-redis.test.mjs` cannot be imported by a unit suite -- it opens
 * PostgreSQL and Redis at module scope -- so anything decided inline there can
 * only ever be checked by grepping its source. A source check cannot tell a
 * working derivation from a comment describing one, a trap this repository has
 * already fallen into four times. So the decision lives here, the suite calls
 * it, and the unit suite calls the same function with the same inputs.
 *
 * Two values, derived together, because they must agree:
 *
 *   * the **run id**, which scopes PostgreSQL fixtures (`dedupeKey`) and the
 *     container's `easeit.run` label;
 *   * the **queue prefix**, which scopes every BullMQ key and therefore bounds
 *     `obliterate({ force: true })`.
 *
 * Deriving one from the other in one place is what makes "the prefix belongs
 * to this run" true by construction instead of by convention.
 *
 * Pure: `randomUUID` is injected and nothing reads `process.env`. The caller
 * passes what the environment said; this decides what it means.
 * ===========================================================================
 */

import { randomUUID as nodeRandomUUID } from 'node:crypto';

import { expectedTestPrefix, queuePrefixRefusals } from '../../test/support/isolation-guard.mjs';

/**
 * A full UUID with the dashes removed: 32 lowercase hex characters.
 *
 * Stricter than the isolation guard's `/^[0-9a-f]{8,}$/` floor, deliberately.
 * The guard sets the minimum a run id must satisfy to be *usable*; this sets
 * what this caller actually produces, and an 8-character truncation is not it
 * -- at eight hex characters a few dozen concurrent runs make a collision
 * plausible, and a collision means two runs sharing a queue namespace and a
 * container label, which is the one thing the namespace exists to prevent.
 */
const FULL_RUN_ID = /^[0-9a-f]{32}$/;

/** `randomUUID()` without the dashes. Injected so a test is deterministic. */
export function generateRunId(randomUUID = nodeRandomUUID) {
  return randomUUID().replaceAll('-', '');
}

/**
 * Resolve the run id and the prefix, or refuse.
 *
 * ===========================================================================
 * Precedence, and why there is no fallback to `bull`.
 *
 *   * `suppliedRunId` wins when present -- the gate generates one id for the
 *     whole run and hands it down, so a suite that invented its own would
 *     label its container differently from the rows it writes.
 *   * `suppliedPrefix` wins when present, and is then **validated like any
 *     other**: being handed down is not a reason to trust it.
 *   * Absent either, the id is generated and the prefix derived from it with
 *     `expectedTestPrefix`.
 *
 * Both are validated by the guard's `queuePrefixRefusals`, so the rule has one
 * home. A malformed input is a refusal, never a quiet default: silently
 * falling back to `bull` would point `obliterate` at the namespace production
 * and the development worker share, which is the catastrophic case this whole
 * phase exists to remove.
 *
 * `mode: 'owned'` is passed to the validator because the prefix rules are
 * byte-identical in `owned` and `external` -- a unit test asserts that, so the
 * choice here cannot start mattering without something failing.
 * ===========================================================================
 */
export function resolveRunIdentity({
  suppliedRunId,
  suppliedPrefix,
  randomUUID = nodeRandomUUID,
} = {}) {
  const reasons = [];

  /* ---- the run id ---- */
  let runId;
  let runIdSource;

  if (suppliedRunId === undefined || suppliedRunId === null || suppliedRunId === '') {
    runId = generateRunId(randomUUID);
    runIdSource = 'generated';
    if (!FULL_RUN_ID.test(runId)) {
      return {
        ok: false,
        reasons: [
          `generated run id ${JSON.stringify(runId)} is not 32 lowercase hex characters. ` +
            'randomUUID() should always produce one; refusing rather than continuing with ' +
            'an identity that cannot scope anything.',
        ],
      };
    }
  } else if (typeof suppliedRunId !== 'string' || !FULL_RUN_ID.test(suppliedRunId)) {
    return {
      ok: false,
      reasons: [
        `EASEIT_RUN_ID ${JSON.stringify(String(suppliedRunId).slice(0, 80))} is not 32 ` +
          'lowercase hex characters. It scopes the queue prefix, the container label and ' +
          'every fixture row, so it is required rather than repaired.',
      ],
    };
  } else {
    runId = suppliedRunId;
    runIdSource = 'environment';
  }

  /* ---- the prefix ---- */
  const prefixSupplied =
    suppliedPrefix !== undefined && suppliedPrefix !== null && suppliedPrefix !== '';
  const prefix = prefixSupplied ? suppliedPrefix : expectedTestPrefix(runId);
  const prefixSource = prefixSupplied ? 'environment' : 'derived';

  reasons.push(...queuePrefixRefusals({ mode: 'owned', prefix, runId }));

  if (reasons.length > 0) return { ok: false, reasons };

  return { ok: true, runId, prefix, source: { runId: runIdSource, prefix: prefixSource } };
}
