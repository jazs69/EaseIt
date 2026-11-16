/**
 * Provision a real installation: reference data, one property, its first
 * administrator. The production counterpart of `seed.ts`, with no demo data.
 *
 * ===========================================================================
 * Nothing in the application creates a property or the first user — the dev
 * portfolio comes from the seed — so a fresh production database needs this
 * once per hotel. After it, rooms, rates, taxes and staff are configured in
 * the admin screens.
 *
 *   1. Always: the permission catalog, system roles and amenity catalog
 *      (`reference-data.ts`, shared with the seed). Safe to re-run after every
 *      release; it is what keeps role grants in step with `@repo/types`.
 *   2. With PROPERTY_CODE: the property, its settings row and the default GST
 *      slab table (INR only). An existing property with that code is left
 *      exactly as it is — this never edits a live hotel.
 *   3. With ADMIN_EMAIL: the user, a grant of ADMIN_ROLE at the property, and
 *      — if they have never signed in — a 72-hour invitation link to choose
 *      their own password. No password is ever passed on a command line or
 *      printed; only the link is, once.
 *
 *   DATABASE_URL           the OWNER connection (required)
 *   PROPERTY_CODE          e.g. 31001; with PROPERTY_NAME and PROPERTY_SLUG
 *   PROPERTY_NAME          display name
 *   PROPERTY_SLUG          lower-case, digits and hyphens (booking engine URL)
 *   PROPERTY_TIMEZONE      IANA zone, default Asia/Kolkata
 *   PROPERTY_CURRENCY      ISO-4217, default INR
 *   PROPERTY_BUSINESS_DATE YYYY-MM-DD, default today in PROPERTY_TIMEZONE
 *   ADMIN_EMAIL            first administrator
 *   ADMIN_FIRST_NAME / ADMIN_LAST_NAME
 *   ADMIN_ROLE             SUPER_ADMIN (default: the portfolio owner) or PROPERTY_ADMIN
 *   WEB_ADMIN_URL          where the invitation link points, e.g. https://admin.example.com
 *
 *   pnpm db:provision     (from the repository root, with the variables set)
 * ===========================================================================
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { hash } from 'bcryptjs';

import { RoleKey } from '../generated/client/index.js';
// The compiled package, which is what the ops image ships (src is not in it).
import { createPrismaClient } from '../dist/index.js';
import { seedAmenities, seedPermissions, seedSystemRoles, TAX_SLABS } from './reference-data.js';

for (const file of ['.env.local', '.env']) {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) process.loadEnvFile(path);
}

const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function fail(message: string): never {
  console.error(`provision: ${message}`);
  process.exit(1);
}

function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
}

/** Validate everything before the first write, so a typo changes nothing. */
function readPlan() {
  const code = env('PROPERTY_CODE');
  const property =
    code === undefined
      ? null
      : (() => {
          const name = env('PROPERTY_NAME') ?? fail('PROPERTY_NAME is required with PROPERTY_CODE.');
          const slug = env('PROPERTY_SLUG') ?? fail('PROPERTY_SLUG is required with PROPERTY_CODE.');
          if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) fail('PROPERTY_SLUG must be lower-case letters, digits and single hyphens.');
          if (!/^[A-Za-z0-9_-]{1,32}$/.test(code)) fail('PROPERTY_CODE must be 1-32 letters, digits, "_" or "-".');
          const timezone = env('PROPERTY_TIMEZONE') ?? 'Asia/Kolkata';
          try {
            new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
          } catch {
            fail(`PROPERTY_TIMEZONE "${timezone}" is not an IANA time zone.`);
          }
          const currency = (env('PROPERTY_CURRENCY') ?? 'INR').toUpperCase();
          if (!/^[A-Z]{3}$/.test(currency)) fail('PROPERTY_CURRENCY must be a three-letter ISO code.');
          const businessDate = env('PROPERTY_BUSINESS_DATE') ?? todayIn(timezone);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) fail('PROPERTY_BUSINESS_DATE must be YYYY-MM-DD.');
          return { code, name, slug, timezone, currency, businessDate };
        })();

  const email = env('ADMIN_EMAIL')?.toLowerCase();
  const admin =
    email === undefined
      ? null
      : (() => {
          if (property === null) fail('ADMIN_EMAIL needs PROPERTY_CODE: a grant is always at a property.');
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('ADMIN_EMAIL is not an email address.');
          const role = env('ADMIN_ROLE') ?? 'SUPER_ADMIN';
          if (role !== 'SUPER_ADMIN' && role !== 'PROPERTY_ADMIN') fail('ADMIN_ROLE must be SUPER_ADMIN or PROPERTY_ADMIN.');
          const webAdminUrl = (env('WEB_ADMIN_URL') ?? fail('WEB_ADMIN_URL is required to build the invitation link.')).replace(/\/+$/, '');
          if (!/^https?:\/\//.test(webAdminUrl)) fail('WEB_ADMIN_URL must start with http:// or https://.');
          return {
            email,
            firstName: env('ADMIN_FIRST_NAME') ?? 'Hotel',
            lastName: env('ADMIN_LAST_NAME') ?? 'Administrator',
            role: role as 'SUPER_ADMIN' | 'PROPERTY_ADMIN',
            webAdminUrl,
          };
        })();

  return { property, admin };
}

async function main(): Promise<void> {
  if (env('DATABASE_URL') === undefined) fail('DATABASE_URL (the owner connection) is required.');
  const plan = readPlan();
  const prisma = createPrismaClient();

  try {
    console.log('Reference data');
    const permissionIds = await seedPermissions(prisma);
    await seedSystemRoles(prisma, permissionIds);
    const amenities = await seedAmenities(prisma);
    console.log(`  amenities: ${String(amenities.size)}`);

    if (plan.property === null) {
      console.log('\nNo PROPERTY_CODE given: reference data only.');
      return;
    }

    const p = plan.property;
    console.log(`\nProperty ${p.code}`);
    let propertyId: string;
    const existing = await prisma.property.findUnique({ where: { code: p.code }, select: { id: true, slug: true } });
    if (existing !== null) {
      if (existing.slug !== p.slug) fail(`property ${p.code} exists with slug "${existing.slug}", not "${p.slug}". Nothing was changed.`);
      propertyId = existing.id;
      console.log('  exists; left unchanged');
    } else {
      const slugTaken = await prisma.property.findUnique({ where: { slug: p.slug }, select: { code: true } });
      if (slugTaken !== null) fail(`slug "${p.slug}" already belongs to property ${slugTaken.code}. Nothing was changed.`);
      propertyId = await prisma.$transaction(async (tx) => {
        const created = await tx.property.create({
          data: {
            code: p.code,
            slug: p.slug,
            name: p.name,
            timezone: p.timezone,
            currency: p.currency,
            businessDate: new Date(`${p.businessDate}T00:00:00.000Z`),
          },
          select: { id: true },
        });
        await tx.$executeRaw`SELECT set_config('app.current_property_id', ${created.id}, true)`;
        await tx.propertySettings.create({ data: { propertyId: created.id } });
        // The Indian GST bands, only for an INR property; anywhere else the
        // operator sets their own in Settings > Taxes before the first sale.
        if (p.currency === 'INR') {
          await tx.propertyTaxSlab.createMany({ data: TAX_SLABS.map((slab) => ({ propertyId: created.id, ...slab })) });
        }
        return created.id;
      });
      console.log(`  created (${p.timezone}, ${p.currency}, business date ${p.businessDate})`);
      console.log(p.currency === 'INR' ? `  GST slabs: ${String(TAX_SLABS.length)}` : '  no tax slabs: set them in Settings > Taxes');
    }

    if (plan.admin === null) return;
    const a = plan.admin;
    console.log(`\nAdministrator ${a.email}`);
    const role = await prisma.role.findFirst({ where: { key: a.role as RoleKey, propertyId: null }, select: { id: true } });
    if (role === null) fail(`system role ${a.role} is missing after the reference step.`);

    const user = await prisma.$transaction(async (tx) => {
      const found = await tx.user.findUnique({ where: { email: a.email }, select: { id: true, lastLoginAt: true } });
      // A random, unusable password: the person chooses theirs through the link.
      const row =
        found ??
        (await tx.user.create({
          data: {
            email: a.email,
            firstName: a.firstName,
            lastName: a.lastName,
            passwordHash: await hash(randomBytes(32).toString('base64url'), 12),
          },
          select: { id: true, lastLoginAt: true },
        }));
      await tx.$executeRaw`SELECT set_config('app.current_property_id', ${propertyId}, true)`;
      await tx.userPropertyRole.upsert({
        where: { user_property_role_unique: { userId: row.id, propertyId, roleId: role.id } },
        create: { userId: row.id, propertyId, roleId: role.id },
        update: {},
      });
      return { ...row, created: found === null };
    });
    console.log(`  ${user.created ? 'created' : 'exists'}; granted ${a.role} at ${p.code}`);

    if (user.lastLoginAt !== null) {
      console.log('  has signed in before: no invitation issued (use "Forgot password" if needed)');
      return;
    }
    // Same shape as AccountService.issue: only the SHA-256 is stored, earlier
    // pending invitations are revoked, single use, 72 hours.
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.authToken.updateMany({
        where: { userId: user.id, purpose: 'INVITATION', consumedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.authToken.create({
        data: {
          userId: user.id,
          purpose: 'INVITATION',
          tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
          expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
          createdById: null,
        },
      });
    });
    console.log('\n  Invitation link (valid 72 hours, single use; give it to the administrator only):');
    console.log(`  ${a.webAdminUrl}/accept-invite#token=${token}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('provision failed:', error);
  process.exitCode = 1;
});
