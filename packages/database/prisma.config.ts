/**
 * Prisma CLI configuration.
 *
 * Prisma 7 moved connection strings out of schema.prisma: Migrate and
 * Introspect read them from here, while the application's runtime connection
 * comes from the `pg` driver adapter in src/index.ts. The two are deliberately
 * separate — Migrate needs a direct, unpooled connection because a
 * transaction pooler breaks the advisory locks it uses to serialise
 * migrations.
 *
 * Prisma 7 also stopped auto-loading .env, so we load it explicitly with
 * Node's built-in loader rather than taking a dotenv dependency. Note we read
 * `process.env` directly instead of Prisma's `env()` helper: `env()` throws on
 * a missing variable, which would make the DIRECT_URL -> DATABASE_URL fallback
 * below unreachable.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'prisma/config';

for (const file of ['.env.local', '.env']) {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

const migrationUrl = process.env['DIRECT_URL'] ?? process.env['DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',

  datasource: {
    // Unpooled. Point this at the database directly, not at pgBouncer.
    // Empty at generate time is fine — only migrate/introspect dial out.
    url: migrationUrl ?? '',
  },

  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
