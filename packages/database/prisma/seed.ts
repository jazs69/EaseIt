/**
 * Seeds the dev portfolio: the role/permission catalog, ten properties, and
 * one staff user per role at each property.
 *
 * The catalog is derived from @repo/types rather than re-typed here, so the
 * database and the application's RBAC definitions cannot drift. If a role
 * gains a permission in `packages/types/src/rbac.ts`, re-running this seed is
 * all that is needed to reflect it.
 *
 * Idempotent: every write is an upsert keyed on a natural key, so running it
 * repeatedly converges rather than duplicating.
 */

import {
  ALL_PERMISSIONS,
  ALL_ROLES,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  isPortfolioRole,
  type Permission as PermissionKey,
  type Role as RoleKeyType,
} from '@repo/types';
import { hash } from 'bcryptjs';

import { PermissionCategory, RoleKey } from '../generated/client/index.js';
import { createPrismaClient } from '../src/client-factory.js';

// A short-lived client of its own rather than the long-lived singleton.
const prisma = createPrismaClient();

const DEV_PASSWORD = 'EaseIt-Dev-2026!';

/* -------------------------------------------------------------------------- */
/*  Catalog metadata                                                          */
/* -------------------------------------------------------------------------- */

const ROLE_DESCRIPTIONS: Record<RoleKeyType, string> = {
  SUPER_ADMIN: 'Portfolio operator. The only role permitted to cross property boundaries.',
  PROPERTY_ADMIN: 'General manager of one property. Full control within that property.',
  FRONT_DESK: 'Reception: reservations, check-in/out, folio posting and payments.',
  HOUSEKEEPING: 'Room status and task execution. No access to financial data.',
  REVENUE_MANAGER: 'Rates, restrictions, channel mappings and ARI distribution.',
  NIGHT_AUDITOR: 'Runs and reviews the night audit; closes the business date.',
};

/** Maps a `resource:action` key onto the coarse UI grouping. */
const CATEGORY_BY_RESOURCE: Record<string, PermissionCategory> = {
  property: PermissionCategory.PROPERTY,
  user: PermissionCategory.USER_MANAGEMENT,
  role: PermissionCategory.USER_MANAGEMENT,
  reservation: PermissionCategory.RESERVATION,
  room: PermissionCategory.INVENTORY,
  room_type: PermissionCategory.INVENTORY,
  inventory: PermissionCategory.INVENTORY,
  rate: PermissionCategory.RATE,
  restriction: PermissionCategory.RATE,
  promotion: PermissionCategory.RATE,
  folio: PermissionCategory.FOLIO,
  invoice: PermissionCategory.FOLIO,
  payment: PermissionCategory.PAYMENT,
  cashier_shift: PermissionCategory.PAYMENT,
  housekeeping: PermissionCategory.HOUSEKEEPING,
  night_audit: PermissionCategory.NIGHT_AUDIT,
  business_date: PermissionCategory.NIGHT_AUDIT,
  channel: PermissionCategory.CHANNEL,
  booking_engine: PermissionCategory.BOOKING_ENGINE,
  report: PermissionCategory.REPORTING,
  audit_log: PermissionCategory.REPORTING,
};

function categoryFor(key: PermissionKey): PermissionCategory {
  const resource = key.split(':')[0] ?? '';
  const category = CATEGORY_BY_RESOURCE[resource];
  if (!category) {
    throw new Error(
      `No PermissionCategory mapped for resource "${resource}" (permission "${key}"). ` +
        `Add it to CATEGORY_BY_RESOURCE in prisma/seed.ts.`,
    );
  }
  return category;
}

/** "reservation:check_in" -> "Check in reservation" */
function labelFor(key: PermissionKey): string {
  const [resource = '', action = ''] = key.split(':');
  const verb = action.replace(/_/g, ' ');
  const noun = resource.replace(/_/g, ' ');
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${noun}`;
}

/* -------------------------------------------------------------------------- */
/*  Portfolio                                                                 */
/* -------------------------------------------------------------------------- */

interface PropertySeed {
  slug: string;
  name: string;
  city: string;
  state: string;
  timezone: string;
  currency: string;
  locale: string;
}

const PROPERTIES: PropertySeed[] = [
  {
    slug: 'grand-marine-goa',
    name: 'Grand Marine Goa',
    city: 'Panaji',
    state: 'Goa',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  {
    slug: 'lakeview-udaipur',
    name: 'Lakeview Udaipur',
    city: 'Udaipur',
    state: 'Rajasthan',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  {
    slug: 'hillcrest-manali',
    name: 'Hillcrest Manali',
    city: 'Manali',
    state: 'Himachal Pradesh',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  {
    slug: 'palm-court-kochi',
    name: 'Palm Court Kochi',
    city: 'Kochi',
    state: 'Kerala',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  {
    slug: 'city-central-mumbai',
    name: 'City Central Mumbai',
    city: 'Mumbai',
    state: 'Maharashtra',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  {
    slug: 'heritage-jaipur',
    name: 'Heritage Jaipur',
    city: 'Jaipur',
    state: 'Rajasthan',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  {
    slug: 'backwater-alleppey',
    name: 'Backwater Alleppey',
    city: 'Alappuzha',
    state: 'Kerala',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  {
    slug: 'summit-shimla',
    name: 'Summit Shimla',
    city: 'Shimla',
    state: 'Himachal Pradesh',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  {
    slug: 'tech-park-bengaluru',
    name: 'Tech Park Bengaluru',
    city: 'Bengaluru',
    state: 'Karnataka',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  // A second timezone and currency on purpose: it keeps the night-audit
  // scheduler and the Money helpers honest in local development.
  {
    slug: 'marina-bay-colombo',
    name: 'Marina Bay Colombo',
    city: 'Colombo',
    state: 'Western',
    timezone: 'Asia/Colombo',
    currency: 'LKR',
    locale: 'en-LK',
  },
];

/** Today's calendar date in a property's own timezone (en-CA formats YYYY-MM-DD). */
function businessDateFor(timeZone: string): Date {
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(`${local}T00:00:00.000Z`);
}

/* -------------------------------------------------------------------------- */
/*  Seed steps                                                                */
/* -------------------------------------------------------------------------- */

async function seedPermissions(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const key of ALL_PERMISSIONS) {
    const record = await prisma.permission.upsert({
      where: { key },
      update: { label: labelFor(key), category: categoryFor(key) },
      create: {
        key,
        label: labelFor(key),
        description: `Allows the holder to ${labelFor(key).toLowerCase()}.`,
        category: categoryFor(key),
      },
      select: { id: true },
    });
    ids.set(key, record.id);
  }

  console.log(`  permissions: ${ids.size}`);
  return ids;
}

async function seedRoles(permissionIds: Map<string, string>): Promise<Map<RoleKeyType, string>> {
  const ids = new Map<RoleKeyType, string>();

  for (const roleKey of ALL_ROLES) {
    const role = await prisma.role.upsert({
      where: { key: roleKey as RoleKey },
      update: {
        label: ROLE_LABELS[roleKey],
        description: ROLE_DESCRIPTIONS[roleKey],
        isPortfolioScoped: isPortfolioRole(roleKey),
      },
      create: {
        key: roleKey as RoleKey,
        label: ROLE_LABELS[roleKey],
        description: ROLE_DESCRIPTIONS[roleKey],
        isSystem: true,
        isPortfolioScoped: isPortfolioRole(roleKey),
      },
      select: { id: true },
    });
    ids.set(roleKey, role.id);

    // Replace the grant set wholesale rather than diffing: the mapping in
    // @repo/types is authoritative, so a removed permission must disappear.
    const granted = ROLE_PERMISSIONS[roleKey];
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: granted.map((permission) => ({
        roleId: role.id,
        permissionId: permissionIds.get(permission) ?? '',
      })),
      skipDuplicates: true,
    });

    console.log(`  role ${roleKey}: ${granted.length} permissions`);
  }

  return ids;
}

async function seedProperties(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const seed of PROPERTIES) {
    const property = await prisma.property.upsert({
      where: { slug: seed.slug },
      update: {
        name: seed.name,
        timezone: seed.timezone,
        locale: seed.locale,
        city: seed.city,
        state: seed.state,
      },
      create: {
        slug: seed.slug,
        name: seed.name,
        legalName: `${seed.name} Hospitality Pvt Ltd`,
        timezone: seed.timezone,
        currency: seed.currency,
        locale: seed.locale,
        businessDate: businessDateFor(seed.timezone),
        city: seed.city,
        state: seed.state,
        countryCode: seed.currency === 'LKR' ? 'LK' : 'IN',
        email: `frontdesk@${seed.slug}.example.com`,
      },
      select: { id: true },
    });
    ids.set(seed.slug, property.id);
  }

  console.log(`  properties: ${ids.size}`);
  return ids;
}

async function seedUsers(
  roleIds: Map<RoleKeyType, string>,
  propertyIds: Map<string, string>,
): Promise<void> {
  const passwordHash = await hash(DEV_PASSWORD, 12);
  let userCount = 0;
  let grantCount = 0;

  /** Grants `roleKey` at `propertyId` (null for a portfolio-wide grant). */
  async function grant(
    userId: string,
    roleKey: RoleKeyType,
    propertyId: string | null,
  ): Promise<void> {
    const roleId = roleIds.get(roleKey);
    if (!roleId) throw new Error(`Role ${roleKey} was not seeded.`);

    const existing = await prisma.userRole.findFirst({
      where: { userId, roleId, propertyId },
      select: { id: true },
    });
    if (!existing) {
      await prisma.userRole.create({ data: { userId, roleId, propertyId } });
      grantCount += 1;
    }
  }

  // Portfolio operator — the only user with a null-property grant.
  const superAdmin = await prisma.user.upsert({
    where: { email: 'owner@easeit.example.com' },
    update: { isActive: true },
    create: {
      email: 'owner@easeit.example.com',
      passwordHash,
      firstName: 'Portfolio',
      lastName: 'Owner',
      propertyId: null,
    },
    select: { id: true },
  });
  userCount += 1;
  await grant(superAdmin.id, 'SUPER_ADMIN', null);

  // One staff member per property-scoped role, at every property.
  const propertyScopedRoles = ALL_ROLES.filter((role) => !isPortfolioRole(role));

  for (const seed of PROPERTIES) {
    const propertyId = propertyIds.get(seed.slug);
    if (!propertyId) throw new Error(`Property ${seed.slug} was not seeded.`);

    for (const roleKey of propertyScopedRoles) {
      const localPart = `${roleKey.toLowerCase().replace(/_/g, '.')}@${seed.slug}.example.com`;
      const user = await prisma.user.upsert({
        where: { email: localPart },
        update: { isActive: true, propertyId },
        create: {
          email: localPart,
          passwordHash,
          firstName: ROLE_LABELS[roleKey].split(' ')[0] ?? 'Staff',
          lastName: seed.name.split(' ')[0] ?? 'Member',
          propertyId,
        },
        select: { id: true },
      });
      userCount += 1;
      await grant(user.id, roleKey, propertyId);
    }
  }

  // A deliberate cross-property case: one revenue manager covering two hotels,
  // so tenant-isolation tests have a realistic multi-grant subject.
  const goaId = propertyIds.get('grand-marine-goa');
  const udaipurId = propertyIds.get('lakeview-udaipur');
  if (goaId && udaipurId) {
    const shared = await prisma.user.upsert({
      where: { email: 'revenue.west@easeit.example.com' },
      update: { isActive: true, propertyId: goaId },
      create: {
        email: 'revenue.west@easeit.example.com',
        passwordHash,
        firstName: 'West',
        lastName: 'Revenue',
        propertyId: goaId,
      },
      select: { id: true },
    });
    userCount += 1;
    await grant(shared.id, 'REVENUE_MANAGER', goaId);
    await grant(shared.id, 'REVENUE_MANAGER', udaipurId);
  }

  console.log(`  users: ${userCount}, role grants: ${grantCount}`);
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                               */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log('Seeding EaseIt dev portfolio...');

  const permissionIds = await seedPermissions();
  const roleIds = await seedRoles(permissionIds);
  const propertyIds = await seedProperties();
  await seedUsers(roleIds, propertyIds);

  console.log(`\nDone. All dev accounts share the password: ${DEV_PASSWORD}`);
  console.log('Portfolio owner: owner@easeit.example.com');
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
