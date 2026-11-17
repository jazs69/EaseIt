/**
 * Which unique index a violation hit, read from where this Prisma build puts
 * it. Moved verbatim out of `folios.service.ts` so a module that needs the
 * same detection (the company ledger, GP-07) does not import the folio
 * service and, through it, a database client.
 */

/**
 * A unique violation that names one of `needles` as the index it hit.
 *
 * ===========================================================================
 * The name is read from where this stack actually puts it, which was measured
 * rather than assumed.
 *
 * Prisma 7 with the `pg` driver adapter reports the index at
 * `meta.driverAdapterError.cause.constraint.index`, and leaves `meta.target`
 * undefined — so a detector written against `target` alone compiles, passes
 * typecheck, and silently never matches. That is exactly what happened here:
 * every collision answered 500 until the shape was probed. Hence all three
 * known shapes, most structured first:
 *
 *   1. the driver adapter's `constraint.index` (this build),
 *   2. `meta.target`, a name or a column list (query-engine builds),
 *   3. the message text, which carries the index name verbatim.
 *
 * The needles are **full index names and nothing looser**. A bare column name
 * would also be matched against the message, and Prisma's message embeds the
 * calling source — which mentions `idempotencyKey` — so a genuine
 * double-charged-night violation could have matched it and been swallowed as a
 * replay. A full index name appears in no other error, which is what makes
 * reading the message a legitimate last resort rather than a shortcut. It is
 * still the *last* resort: a message is the one part of an error nobody
 * promises to keep stable.
 *
 * If a future Prisma reports only a column list, this fails **closed** — a
 * loud 500 and a failing test, never a silently widened predicate.
 *
 * `P2002` is the client's code and `23505` the SQLSTATE; both are accepted,
 * because the query builder surfaces the former while a raw query surfaces the
 * latter and these paths are reachable through either — the same reasoning as
 * `outbox.service.ts`.
 *
 * The payment suite pins this shape against a real violation, so a Prisma
 * upgrade that moves it fails a test rather than quietly turning every replay
 * back into a 500.
 * ===========================================================================
 */
export function uniqueViolationMentions(cause: unknown, needles: readonly string[]): boolean {
  if (cause === null || typeof cause !== 'object') return false;

  const record = cause as { code?: unknown; meta?: unknown; message?: unknown };
  const adapterCause = (record.meta as { driverAdapterError?: { cause?: unknown } } | undefined)
    ?.driverAdapterError?.cause as
    { originalCode?: unknown; constraint?: { index?: unknown } } | undefined;

  const isUnique =
    record.code === 'P2002' || record.code === '23505' || adapterCause?.originalCode === '23505';
  if (!isUnique) return false;

  const candidates: string[] = [];

  const index = adapterCause?.constraint?.index;
  if (typeof index === 'string') candidates.push(index);

  const target = (record.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) candidates.push(target.map((part) => String(part)).join(','));
  else if (typeof target === 'string') candidates.push(target);

  if (typeof record.message === 'string') candidates.push(record.message);

  return candidates.some((text) => needles.some((needle) => text.includes(needle)));
}

/** The company ledger's payment idempotency index (GP-07), and only that one. */
export function isCompanyLedgerKeyCollision(cause: unknown): boolean {
  return uniqueViolationMentions(cause, ['company_ledger_entry_propertyId_idempotencyKey_key']);
}
