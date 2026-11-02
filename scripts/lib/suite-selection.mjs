/**
 * Which suites a release gate was asked to run — decided explicitly, and
 * fail-closed on anything ambiguous.
 *
 * ===========================================================================
 * The defect this exists to fix, and why it lives in its own module.
 *
 * `gate-resilience.mjs` matched its selector with `startsWith('--only=')`
 * alone. So `--only parallel-booking` — the shell-habitual spelling, with a
 * space — matched nothing, left the selector unset, and the gate ran its
 * **default set**: both suites, including the one that rewrites shared
 * `inventory_day` counters, which the operator had just tried to exclude. A
 * selector that silently *widens* the selection is worse than one that is
 * missing, because the operator believes they narrowed it.
 *
 * That was fixed in the gate. The fix was then untestable, which is the
 * second half of the problem: the gate is a script with top-level
 * `process.exit`, `spawnSync` and `await`, so importing it to exercise the
 * parser would run the gate. The only available assertions were
 * source-substring checks over the file — and a source check cannot tell a
 * working parser from a comment that quotes one. That failure mode has
 * already bitten this repository three times in a row, in assertions whose
 * needles matched prose sitting a few hundred bytes above the code.
 *
 * So the parsing lives here: argv in, a decision out, nothing else. It is a
 * sibling of `changed-files.mjs`, which exists for exactly the same reason —
 * logic pulled out of a gate script so the unit suite can run it with no git,
 * no filesystem and no services. (A note on placement: neither
 * `changed-files.mjs` nor `isolation-guard.mjs` is a topically honest home
 * for argv parsing, so this is a new file in the directory that already
 * holds that kind of helper, rather than a foreign function bolted onto a
 * module about git ranges or database isolation.)
 *
 * Pure, and deliberately so: no `process.argv`, no `process.env`, no file
 * reads, no spawning, no network. The caller passes the argv slice and the
 * known suite ids, and gets back either a selector or the reasons to refuse.
 * ===========================================================================
 */

/** The accepted spelling, composed once so every refusal says the same thing. */
export function suiteSelectionSyntax(ids) {
  return (
    `Accepted syntax: --only=<id>, where <id> is one of ${ids.join(', ')}. ` +
    'Omit --only entirely to run every suite.'
  );
}

/**
 * Resolve the `--only` selector from an argv slice.
 *
 * Returns `{ ok: true, only }` where `only` is a known suite id, or `null`
 * when no selector was given and every suite should run. Returns
 * `{ ok: false, exitCode: 2, reasons }` for every malformed form — the caller
 * owns the printing and the exit, as with `postConnectionRefusals` in the
 * isolation guard.
 *
 * Exit code 2 rather than 1 throughout: this is a usage error, not a failed
 * check, and a gate that cannot tell which suites it was asked for must not
 * guess. Guessing is what produced the original defect.
 *
 * @param {{ argv: readonly string[], ids: readonly string[] }} input
 *   `argv` is the slice after the script name; `ids` are the known suite ids.
 */
export function resolveSuiteSelection({ argv, ids }) {
  const syntax = suiteSelectionSyntax(ids);
  const refuse = (...lines) => ({ ok: false, exitCode: 2, reasons: [...lines, syntax] });

  /**
   * A bare `--only` is matched as well as `--only=…`.
   *
   * This is the whole of the original fix: without the `=== '--only'` arm,
   * `--only parallel-booking` is invisible here and the caller sees "no
   * selector given", which means "run everything".
   */
  const found = argv.filter((arg) => arg === '--only' || arg.startsWith('--only='));

  if (found.length === 0) return { ok: true, only: null };

  if (found.length > 1) {
    return refuse(
      `--only was given ${String(found.length)} times: ${found.join(' ')}.`,
      'Refusing to choose one of them. Pass exactly one.',
    );
  }

  const arg = found[0];

  if (arg === '--only') {
    // The value, if the operator wrote one, is a separate argv entry we
    // deliberately do NOT adopt: accepting it would make the space a second,
    // undocumented separator.
    return refuse('--only requires a value, and a space is not the separator.');
  }

  const only = arg.slice('--only='.length);

  if (only === '') return refuse('--only was given an empty value.');

  if (!ids.includes(only)) return refuse(`Unknown --only=${only}.`);

  return { ok: true, only };
}
