/**
 * The BullMQ key prefix for the outbox queue — one resolver, no dependencies.
 *
 * ===========================================================================
 * Why this is its own file, and why it imports nothing.
 *
 * `Queue` and `Worker` must receive the **same** prefix. In bullmq 6.4.2 both
 * extend the same base and both resolve `opts.prefix ?? 'bull'` in the Redis
 * backend (`bullmq/dist/cjs/classes/redis-queue-backend.js:73`), composing
 * every key as `` `${prefix}:${queueName}:${type}` ``
 * (`bullmq/dist/cjs/classes/queue-keys.js:35-40`). So a `Queue` and a `Worker`
 * given *different* prefixes do not error — they simply never see each other's
 * jobs. The failure mode of getting this wrong is a silent hang, not a crash,
 * which is why the value has exactly one definition.
 *
 * It has no runtime imports at all — the config source is structurally typed
 * rather than imported from `@nestjs/config` — so the unit suite can import it
 * directly and run it. `outbox.queue.ts` cannot be imported that way: it
 * carries `@Injectable()`, and decorators are not type syntax, so Node's type
 * stripping cannot erase them. A rule this quiet deserves a test that executes
 * it rather than reads it.
 *
 * NOT A NAMESPACE FOR TESTS, YET. This file only resolves what it is given.
 * Nothing here generates a per-run prefix; that is a later, separate change.
 * ===========================================================================
 */

/** BullMQ's own default, restated here so "absent" is explicit rather than implied. */
export const OUTBOX_PREFIX_DEFAULT = 'bull';

/** The environment variable that overrides it. */
export const OUTBOX_PREFIX_KEY = 'OUTBOX_QUEUE_PREFIX';

/**
 * Just enough of `ConfigService` to read one key.
 *
 * `unknown` rather than a string return, because `ConfigService.get` is
 * generic and this module refuses to assume what came back — CLAUDE.md §5
 * bans `any` and asks for narrowing instead.
 */
export interface OutboxPrefixConfig {
  get(key: string): unknown;
}

/**
 * Resolve the prefix, or throw.
 *
 * ===========================================================================
 * Absent means production. A present-but-malformed value is an error.
 *
 * `undefined` returns `'bull'`, which is byte-for-byte what BullMQ does with
 * no `prefix` option at all — so an existing deployment that sets nothing
 * keeps every key it already has, and a running worker keeps draining the
 * queue it is already attached to.
 *
 * A blank or whitespace-padded value throws instead of being normalised. That
 * is the same judgement `redisConnectionFrom` makes about an empty
 * `REDIS_URL`: silently repairing a misconfigured namespace would move the
 * whole queue somewhere the operator did not intend, and " bull" versus
 * "bull" is precisely the invisible difference this file exists to prevent.
 * ===========================================================================
 */
export function outboxPrefixFrom(config: OutboxPrefixConfig): string {
  const configured = config.get(OUTBOX_PREFIX_KEY);

  if (configured === undefined || configured === null) return OUTBOX_PREFIX_DEFAULT;

  if (typeof configured !== 'string') {
    throw new Error(
      `${OUTBOX_PREFIX_KEY} must be a string, received ${typeof configured}. ` +
        'The BullMQ key prefix namespaces every outbox key; it is not inferred.',
    );
  }

  if (configured.trim() === '') {
    throw new Error(
      `${OUTBOX_PREFIX_KEY} is set but blank. Unset it to use the default ` +
        `"${OUTBOX_PREFIX_DEFAULT}", or give it a value.`,
    );
  }

  if (configured !== configured.trim()) {
    throw new Error(
      `${OUTBOX_PREFIX_KEY} has leading or trailing whitespace: ${JSON.stringify(configured)}. ` +
        'Whitespace is part of the Redis key, so this would silently namespace the ' +
        'queue somewhere other than intended.',
    );
  }

  return configured;
}
