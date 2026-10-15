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

export function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: connectionString() }),
    log: logLevels(),
    errorFormat: process.env['NODE_ENV'] === 'production' ? 'minimal' : 'pretty',
  });
}
