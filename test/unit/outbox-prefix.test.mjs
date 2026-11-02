/**
 * Unit tests for the outbox BullMQ key prefix. No services, no connections.
 *
 * ===========================================================================
 * Why this exists, and what it is defending.
 *
 * `Queue` and `Worker` must receive the SAME prefix. In the installed
 * bullmq 6.4.2 a mismatch raises nothing: both extend the same base, both
 * resolve `opts.prefix ?? 'bull'` in the Redis backend
 * (`bullmq/dist/cjs/classes/redis-queue-backend.js:73`), and keys are composed
 * as `` `${prefix}:${queueName}:${type}` ``
 * (`bullmq/dist/cjs/classes/queue-keys.js:35-40`). Two different prefixes
 * therefore produce two disjoint queues that share a name, and the symptom is
 * a worker that drains nothing -- no error, no log, just silence.
 *
 * So there are two kinds of check here:
 *
 *   1. BEHAVIOURAL, over `outbox.prefix.ts`. That module imports nothing at
 *      runtime, so Node's type stripping can load it and these cases actually
 *      execute the resolver.
 *   2. STRUCTURAL, over `outbox.queue.ts` and `outbox.worker.ts`. Those carry
 *      `@Injectable()`, and decorators are not type syntax, so type stripping
 *      cannot erase them and they cannot be imported here. Constructing a real
 *      `Queue` would also need Redis. What is asserted instead is the property
 *      that makes a mismatch impossible: both call sites destructure ONE
 *      object from ONE function.
 *
 * The needles for (2) are chosen so they cannot be satisfied by a comment.
 * Several assertions in this repository have previously passed against prose
 * sitting a few hundred bytes above the code they meant to check.
 * ===========================================================================
 */

import { readFileSync } from 'node:fs';

import {
  OUTBOX_PREFIX_DEFAULT,
  OUTBOX_PREFIX_KEY,
  outboxPrefixFrom,
} from '../../apps/api/src/modules/platform/outbox/outbox.prefix.ts';

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A `ConfigService` stand-in: one key, no env, no I/O. */
const configOf = (value) => ({
  get(key) {
    return key === OUTBOX_PREFIX_KEY ? value : undefined;
  },
});

const threw = (value) => {
  try {
    outboxPrefixFrom(configOf(value));
    return null;
  } catch (error) {
    return error.message;
  }
};

/* ========================================================================== */
console.log('Outbox prefix resolution (pure)\n');

/* -------------------------------------------------------------------------- */
/*  Absent means production                                                   */
/* -------------------------------------------------------------------------- */

check(`the default is "bull"`, OUTBOX_PREFIX_DEFAULT === 'bull', OUTBOX_PREFIX_DEFAULT);
check(
  'an unset prefix resolves to bull',
  outboxPrefixFrom(configOf(undefined)) === 'bull',
  'byte-for-byte what BullMQ does with no prefix option at all',
);
check('a null prefix resolves to bull', outboxPrefixFrom(configOf(null)) === 'bull');
check(
  'a config that knows nothing at all resolves to bull',
  outboxPrefixFrom({ get: () => undefined }) === 'bull',
  'an existing deployment sets nothing and keeps every key it has',
);
check(
  'and the resolver reads only its own key',
  outboxPrefixFrom({
    get(key) {
      if (key !== OUTBOX_PREFIX_KEY) throw new Error(`read unrelated key ${key}`);
      return undefined;
    },
  }) === 'bull',
);

/* -------------------------------------------------------------------------- */
/*  A configured value is honoured verbatim                                   */
/* -------------------------------------------------------------------------- */

check(
  'a configured prefix is returned as given',
  outboxPrefixFrom(configOf('bull-x')) === 'bull-x',
);
check(
  'a colon-separated namespace is allowed',
  outboxPrefixFrom(configOf('bull:test:a1b2c3d4')) === 'bull:test:a1b2c3d4',
  'BullMQ joins with ":" anyway; the prefix is opaque to it',
);
check(
  'an explicit "bull" is accepted and is indistinguishable from unset',
  outboxPrefixFrom(configOf('bull')) === outboxPrefixFrom(configOf(undefined)),
  'which is what makes the default a no-op in production',
);

/* -------------------------------------------------------------------------- */
/*  Malformed values throw rather than being repaired                         */
/* -------------------------------------------------------------------------- */

/**
 * Normalising these would be the wrong kindness.
 *
 * Silently turning `" bull"` into `"bull"` -- or `""` into the default --
 * would move the entire queue to a namespace the operator did not type, and
 * an invisible namespace difference is the exact failure this file guards.
 */
check('a blank prefix throws', threw('')?.includes('set but blank') === true, threw(''));
check('a whitespace-only prefix throws', threw('   ')?.includes('set but blank') === true);
check(
  'a leading space throws rather than being trimmed',
  threw(' bull')?.includes('leading or trailing whitespace') === true,
  threw(' bull'),
);
check(
  'a trailing space throws rather than being trimmed',
  threw('bull ')?.includes('leading or trailing whitespace') === true,
);
check(
  'a trailing newline throws',
  threw('bull\n')?.includes('leading or trailing whitespace') === true,
  'the shape a careless .env line produces',
);
check('a non-string throws', threw(6380)?.includes('must be a string') === true, threw(6380));
check('an object throws', threw({ prefix: 'bull' })?.includes('must be a string') === true);
check(
  'and no throwing case ever falls back to the default',
  ['', '   ', ' bull', 'bull ', 6380].every((value) => threw(value) !== null),
  'fail closed, not fall back',
);

/* -------------------------------------------------------------------------- */
/*  Purity                                                                    */
/* -------------------------------------------------------------------------- */

check(
  'the resolver is pure: same input, same answer',
  outboxPrefixFrom(configOf('bull:test:x')) === outboxPrefixFrom(configOf('bull:test:x')),
);
check(
  'and it does not consult process.env',
  (() => {
    const saved = process.env[OUTBOX_PREFIX_KEY];
    process.env[OUTBOX_PREFIX_KEY] = 'from-the-environment';
    try {
      return outboxPrefixFrom(configOf(undefined)) === 'bull';
    } finally {
      if (saved === undefined) delete process.env[OUTBOX_PREFIX_KEY];
      else process.env[OUTBOX_PREFIX_KEY] = saved;
    }
  })(),
  'the config object is the only input',
);

/* -------------------------------------------------------------------------- */
/*  Queue and Worker receive the same prefix (structural)                     */
/* -------------------------------------------------------------------------- */

console.log('\nQueue and Worker share one prefix (source inspection).');
{
  const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
  const base = '../../apps/api/src/modules/platform/outbox/';
  const queue = read(`${base}outbox.queue.ts`);
  const worker = read(`${base}outbox.worker.ts`);
  const env = read('../../apps/api/src/config/env.ts');

  /* ---- one function returns both values ---- */
  check(
    'redisConnectionFrom returns the url AND the prefix',
    /export function redisConnectionFrom\(config: ConfigService\): \{ url: string; prefix: string \}/.test(
      queue,
    ),
    'so they cannot be resolved independently',
  );
  check(
    'and it builds the prefix with the shared resolver',
    queue.includes('prefix: outboxPrefixFrom(config)') &&
      queue.includes("from './outbox.prefix.js'"),
  );

  /* ---- both call sites destructure that one object ---- */
  for (const [name, source] of [
    ['the queue', queue],
    ['the worker', worker],
  ]) {
    check(
      `${name} destructures { url, prefix } from redisConnectionFrom`,
      /const \{ url, prefix \} = redisConnectionFrom\(this\.config\);/.test(source),
      'one call, one pair of values',
    );
    check(
      `${name} never resolves a prefix of its own`,
      !source.includes('outboxPrefixFrom(') || name === 'the queue',
      'only redisConnectionFrom may call the resolver',
    );
  }

  /* ---- and both pass it to BullMQ ---- */
  check(
    'new Queue receives the prefix',
    /new Queue<OutboxJobData>\(OUTBOX_QUEUE_NAME, \{\s*\n\s*connection: \{ url \},\s*\n\s*prefix,/.test(
      queue,
    ),
  );
  check(
    'new Worker receives the prefix',
    /\{ connection: \{ url \}, prefix, concurrency: this\.concurrency \}/.test(worker),
  );
  check(
    'neither constructs its client without one',
    !/new Queue<OutboxJobData>\(OUTBOX_QUEUE_NAME, \{\s*\n\s*connection: \{ url \},\s*\n\s*defaultJobOptions/.test(
      queue,
    ) && !/\{ connection: \{ url \}, concurrency/.test(worker),
    'the pre-change shapes must be gone, not merely supplemented',
  );

  /* ---- the env default is what preserves production ---- */
  check(
    'env.ts defaults OUTBOX_QUEUE_PREFIX to bull',
    /OUTBOX_QUEUE_PREFIX: z\.string\(\)\.min\(1\)\.default\('bull'\)/.test(env),
    'absent ⇒ today behaviour, exactly',
  );

  /* ---- the trap worth naming ---- */
  check(
    'nothing relies on BULLMQ_TEST_PREFIX',
    !queue.includes('BULLMQ_TEST_PREFIX') && !worker.includes('BULLMQ_TEST_PREFIX'),
    'bullmq reads it only in removeAllQueueData (utils/index.js:134), not in Queue or Worker',
  );
}

console.log(
  failures === 0 ? '\nAll outbox-prefix checks passed.' : `\n${String(failures)} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
