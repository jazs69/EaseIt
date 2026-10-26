/**
 * Prisma client construction.
 *
 * Kept separate from index.ts so that callers which need their own short-lived
 * client — the seed script, integration tests — can build one without
 * importing index.ts and thereby instantiating the long-lived singleton as a
 * module side effect.
 */

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient, Prisma } from '../generated/client/index.js';

/**
 * Prisma 7 requires a driver adapter; the connection string is no longer read
 * from schema.prisma. This is the pooled runtime URL — Migrate uses the
 * unpooled DIRECT_URL from prisma.config.ts instead.
 */
export function connectionString(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env in packages/database ' +
        '(and at the repository root) before running anything that touches the database.',
    );
  }
  return url;
}

function logLevels(): Prisma.LogLevel[] {
  return process.env['NODE_ENV'] === 'production' ? ['warn', 'error'] : ['warn', 'error'];
}

/**
 * Every connection runs with its session time zone pinned to UTC.
 *
 * ===========================================================================
 * Without this, timestamps are silently stored at the wrong instant.
 *
 * The driver serialises a JS `Date` as its UTC wall-clock digits with **no
 * offset** ("2026-06-15 10:00:00"), and Postgres then interprets those digits
 * in the session time zone. On a machine in Asia/Kolkata that turns 10:00Z
 * into 04:30Z -- every stored timestamp is early by the local UTC offset.
 *
 * Reads are shifted back by the same amount, so an ORM-only round trip looks
 * correct and the bug stays invisible. It surfaces the moment SQL does
 * arithmetic:
 *
 *   * `WHERE "leaseExpiresAt" < now()` was true for a lease claimed one second
 *     ago with sixty seconds to run -- measured, not theorised, while building
 *     the outbox dispatcher. Left in place it would have reclaimed every
 *     in-flight row immediately and delivered every side effect repeatedly.
 *   * `WHERE "availableAt" <= now()` makes a deliberately delayed event due
 *     five and a half hours early.
 *   * any report, BI query, backup or `psql` session reads the wrong hour.
 *
 * CLAUDE.md section 3.3 requires timestamps to be stored in UTC, so the
 * previous behaviour was a bug against the blueprint rather than a choice.
 * `-c timezone=UTC` is sent in the startup packet, so it applies to every
 * session on the pool, including the ones Migrate and the seed script use.
 *
 * It does **not** change how calendar values behave: `arrivalDate`,
 * `businessDate` and `stayDate` are `@db.Date` and carry no time zone, and
 * per-property local time continues to come from the property's IANA zone
 * through the date helpers in `packages/types`.
 * ===========================================================================
 */
const SESSION_OPTIONS = '-c timezone=UTC';

export function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionString(), options: SESSION_OPTIONS }),
    log: logLevels(),
    errorFormat: process.env['NODE_ENV'] === 'production' ? 'minimal' : 'pretty',
  });
}
