/**
 * Applies only the ten-property demo portfolio.
 *
 * ===========================================================================
 * Why this exists separately from `pnpm db:seed`.
 *
 * `seed.ts` is authoritative about the reference portfolio (31001-31010 and
 * 31336) and rebuilds their reservations and inventory from scratch on every
 * run — `prisma.reservation.deleteMany` per property. That is correct for a
 * fixture set nobody has touched, and destructive for a database somebody has
 * been using: it is what would drop the demo bookings the folio and calendar
 * screens are being developed against.
 *
 * `seedDemoPortfolio` touches only the ten codes it owns, so this entry point
 * applies the new portfolio to a database whose existing data must survive.
 * On a fresh database use `pnpm db:seed`, which runs everything including this.
 * ===========================================================================
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { createPrismaClient } from '../src/client-factory.js';
import { seedDemoPortfolio } from './seed-portfolio.js';

// Prisma 7 no longer auto-loads .env, and this script is run directly rather
// than through the Prisma CLI — so nothing else has loaded it yet.
for (const file of ['.env.local', '.env']) {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

const prisma = createPrismaClient();

async function main(): Promise<void> {
  const before = await prisma.reservation.count();
  const counters = await seedDemoPortfolio(prisma);
  const after = await prisma.reservation.count();

  console.log(
    `\nReservations: ${String(before)} before, ${String(after)} after ` +
      `(+${String(after - before)} seeded, none removed).`,
  );
  console.log(`Properties configured: ${String(counters.properties)}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    // Non-zero, so a failed seed fails whatever ran it rather than looking
    // like it worked.
    process.exit(1);
  });
