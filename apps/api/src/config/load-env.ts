/**
 * Loads `.env` before anything else in the process can read it.
 *
 * ===========================================================================
 * This has to be its own module, imported first by main.ts, and the reason is
 * import ordering.
 *
 * `ConfigModule.forRoot({ envFilePath })` loads env files — but it does so
 * when the Nest container is *built*, and the import graph is evaluated before
 * that. `main.ts` imports `AppModule`, which imports `PrismaModule`, which
 * imports `@repo/database`, which constructs its Prisma client at module
 * scope. By the time ConfigModule runs, that client has already been built, or
 * has already thrown "DATABASE_URL is not set" on a machine where the variable
 * is only in a file.
 *
 * Prisma 7 is what makes this explicit: it removed the implicit `.env`
 * loading earlier versions did, so every entry point into this codebase now
 * loads its own — this file for the API, the same block at the top of
 * prisma/seed.ts, and prisma.config.ts for the CLI.
 *
 * Node's built-in loader rather than a dotenv dependency, and note it does
 * **not** overwrite variables already present in the environment: a real
 * `DATABASE_URL` injected by the platform always beats a file left on disk,
 * which is the behaviour production needs.
 * ===========================================================================
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// `.env.local` first so a developer's personal overrides win over the shared
// `.env`, matching ConfigModule's own precedence in app.module.ts.
for (const file of ['.env.local', '.env']) {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}
