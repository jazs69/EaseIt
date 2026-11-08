/**
 * The last check before a destructive Redis call.
 *
 * ===========================================================================
 * Why a *second* gate exists at all.
 *
 * The composed policy runs once, at module load, and that is where it belongs:
 * nothing should connect to a Redis whose mode, boundary, database, prefix and
 * ownership have not been established. But `obliterate({ force: true })`
 * happens later -- after fixtures, after workers have come and gone -- and in
 * between, two things can change:
 *
 *   * an **owned** container can die, and its ephemeral host port can be taken
 *     over by an entirely different process. The URL then addresses something
 *     this run never created, and the module-load evidence is stale;
 *   * nothing about an **external** instance can change from here, but the
 *     prefix and the target are worth re-asserting cheaply, because the
 *     destructive call's blast radius is exactly the prefix.
 *
 * So this re-gathers the evidence rather than trusting the earlier reading,
 * and hands it to the same pure policy. Two rules it holds to:
 *
 *   * **The container id is never replaced.** The caller's captured id is
 *     passed in and compared; if the inspection describes anything else the
 *     answer is a refusal, not an update. Accepting a replacement would make
 *     "this run owns it" unfalsifiable.
 *   * **External mode performs no Docker inspection.** Pretending to verify
 *     ownership of an instance nobody claims to own would be theatre; the
 *     boundary declaration is an assertion and is treated as one.
 *
 * Pure. `verifyOwnership` and `testRefusals` are injected, so the whole
 * decision runs in a unit test with no daemon, no socket and no `process.env`.
 * ===========================================================================
 */

import { redisTestRefusals } from '../../test/support/isolation-guard.mjs';

/**
 * What may safely be said about an exception, and nothing more.
 *
 * ===========================================================================
 * The message is deliberately NOT reproduced.
 *
 * Refusals from this layer are printed to a terminal and, in CI, into a public
 * build log. An exception raised while shelling out to Docker can carry the
 * command line, Docker's own stderr, a Redis URL with credentials in its
 * userinfo, or a `REDISCLI_AUTH=` fragment. None of that is needed to decide
 * the question -- the decision is already made by the fact that it threw --
 * so none of it is quoted.
 *
 * What survives is the error's type and, when present, an errno-shaped `code`
 * (`ENOENT`, `ETIMEDOUT`, `EPERM`), both matched against deliberately narrow
 * patterns. That is enough to tell "Docker is not installed" from "the daemon
 * timed out" without echoing anything the caller supplied. A value that does
 * not match the pattern is dropped rather than truncated, because a truncated
 * secret is still a leaked prefix.
 * ===========================================================================
 */
function describeThrow(error) {
  const rawName = error === null || error === undefined ? undefined : error.name;
  const name =
    typeof rawName === 'string' && /^[A-Za-z]{1,40}$/.test(rawName) ? rawName : 'a non-Error value';

  const rawCode = error === null || error === undefined ? undefined : error.code;
  const code =
    typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(rawCode) ? rawCode : null;

  return code === null ? name : `${name}: ${code}`;
}

/**
 * Decide whether a destructive Redis operation may proceed, right now.
 *
 * Returns `{ ok: true, evidence }` -- `evidence` being the freshly inspected
 * container triple in owned mode, `undefined` in external -- or
 * `{ ok: false, reasons }`. The caller throws; this only decides, exactly as
 * `postConnectionRefusals` and `redisTestRefusals` do.
 *
 * @param {object} input
 * @param {string} input.mode            `'owned'` or `'external'`.
 * @param {string} input.url             The Redis URL the run is using.
 * @param {string} input.prefix          The run-scoped BullMQ prefix.
 * @param {string} input.runId           This run's id.
 * @param {string} [input.boundary]      The external boundary declaration.
 * @param {string} [input.containerId]   The id captured at provisioning.
 * @param {Function} [input.verifyOwnership]
 *   `({ containerId, runId, url }) => { ok, reasons, inspection }`. Required in
 *   owned mode; **must not be called** in external mode.
 * @param {Function} [input.testRefusals] The composed policy; injected for tests.
 */
export function destructiveRefusals({
  mode,
  url,
  prefix,
  runId,
  boundary,
  containerId,
  verifyOwnership,
  testRefusals = redisTestRefusals,
} = {}) {
  let evidence;

  if (mode === 'owned') {
    if (typeof verifyOwnership !== 'function') {
      return {
        ok: false,
        reasons: [
          'owned mode requires a way to re-inspect the container before the destructive ' +
            'call, and none was supplied. Refusing rather than reusing evidence gathered ' +
            'at start-up, which a container that has since died would make a lie.',
        ],
      };
    }

    if (typeof containerId !== 'string' || containerId === '') {
      return {
        ok: false,
        reasons: [
          'owned mode has no captured container id to re-verify. The id is the handle; ' +
            'without it there is nothing to compare an inspection against.',
        ],
      };
    }

    /**
     * Fresh evidence. The whole point is not to trust the earlier reading.
     *
     * =======================================================================
     * A throw is a refusal, not a crash.
     *
     * This function's contract is `{ ok, reasons }`, and every other failure
     * mode honours it -- but the verifier shells out to Docker, so it can
     * raise rather than return: no `docker` binary, a dead daemon, a spawn
     * that itself throws. Letting that propagate broke the contract in the one
     * place it matters most, because a caller written as
     * `if (!destructiveRefusals(…).ok)` would crash instead of refusing, and
     * the crash would read as a harness bug rather than as a refusal.
     *
     * Only the CALL is inside the `try`. The validation below stays outside it
     * deliberately: if a bug in this module's own checks ever threw, it must
     * surface as a bug, not be reclassified as "the verifier misbehaved".
     *
     * This is not a swallowed error (CLAUDE.md section 5). It is translated
     * into the typed refusal this layer speaks, which is the documented
     * alternative to rethrowing -- and the thing it protects is a call that
     * destroys queue state.
     * =======================================================================
     */
    let again;
    try {
      again = verifyOwnership({ containerId, runId, url });
    } catch (error) {
      return {
        ok: false,
        reasons: [
          `the ownership re-check threw (${describeThrow(error)}) instead of returning a ` +
            'verdict, so ownership could not be confirmed.',
          'Refusing to run the destructive operation: an unverifiable container is not a ' +
            'verified one. The exception text is not reproduced here -- it can carry Docker ' +
            'output, a Redis URL or credentials, and refusals are printed into terminals and ' +
            'CI logs.',
        ],
      };
    }

    if (again === null || again === undefined || typeof again !== 'object') {
      return { ok: false, reasons: ['the ownership re-check returned nothing usable.'] };
    }

    if (again.ok !== true) {
      return {
        ok: false,
        reasons: [
          ...(Array.isArray(again.reasons)
            ? again.reasons
            : ['ownership could not be re-verified.']),
          'Refusing to run the destructive operation: ownership was established at start-up ' +
            'but cannot be confirmed now.',
        ],
      };
    }

    const inspection = again.inspection;
    if (inspection === null || inspection === undefined || typeof inspection !== 'object') {
      return {
        ok: false,
        reasons: ['the ownership re-check reported success without returning an inspection.'],
      };
    }

    /**
     * The id must still be the one we captured -- never a replacement.
     *
     * `verifyRedisOwnership` already compares the inspected `.Id` with the id
     * it was asked about, so this is belt and braces. It is here because the
     * failure it guards against is the quiet one: adopting whatever container
     * the inspection happened to describe would turn ownership into a
     * tautology, and a second line of defence against that costs nothing.
     */
    if (inspection.id !== containerId) {
      return {
        ok: false,
        reasons: [
          `the re-inspection describes container ${String(inspection.id).slice(0, 12)}… but ` +
            `${containerId.slice(0, 12)}… was captured at provisioning. A different ` +
            'container is a refusal, not a new target.',
        ],
      };
    }

    evidence = {
      id: inspection.id,
      label: inspection.label,
      mappedPort: inspection.hostPort,
    };
  }

  /**
   * The same composed policy, over the fresh evidence.
   *
   * In external mode `container` is `undefined` and
   * `redisOwnershipRefusals` returns nothing for a non-owned mode, so no
   * Docker evidence is demanded -- which is the honest treatment of an
   * instance whose boundary is an assertion. The target, database, port,
   * boundary and prefix are all still re-checked.
   */
  const reasons = testRefusals({ mode, url, prefix, runId, boundary, container: evidence });

  if (reasons.length > 0) return { ok: false, reasons };

  return { ok: true, evidence };
}
