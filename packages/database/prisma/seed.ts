/**
 * Seeds the dev portfolio: the permission catalog, the system role templates,
 * ten properties, staff accounts and their per-property role grants.
 *
 * The catalog is derived from @repo/types rather than re-typed here, so the
 * database and the application's RBAC definitions cannot drift. Add a
 * permission to `PERMISSION_DEFINITIONS` or change `DEFAULT_ROLE_PERMISSIONS`
 * and re-running this seed is all that is needed to reflect it.
 *
 * Idempotent: every write is keyed on a natural key, so running it repeatedly
 * converges rather than duplicating.
 */

import {
  ALL_ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  isPortfolioRole,
  PERMISSION_DEFINITIONS,
  Permission,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  type Role as RoleKeyType,
} from '@repo/types';
import { hash } from 'bcryptjs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  BookingSource,
  MealPlan,
  PaymentGatewayProvider,
  PaymentGatewayStatus,
  PermissionCategory,
  PropertyStatus,
  ReservationStatus,
  RoleKey,
  RoomStatus,
  type PropertyStatus as PropertyStatusEnum,
} from '../generated/client/index.js';
import { createPrismaClient } from '../src/client-factory.js';

/**
 * Load .env before anything reads DATABASE_URL.
 *
 * Prisma 7 stopped auto-loading .env. The Prisma CLI picks it up from
 * prisma.config.ts, but this script is also run directly (`tsx prisma/seed.ts`
 * via `pnpm db:seed`), and in that path nothing has loaded it yet — so
 * `createPrismaClient()` below would throw "DATABASE_URL is not set" on a
 * perfectly well-configured machine. Node's built-in loader, rather than a
 * dotenv dependency, mirroring prisma.config.ts.
 */
for (const file of ['.env.local', '.env']) {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

// A short-lived client of its own rather than the long-lived singleton.
const prisma = createPrismaClient();

const DEV_PASSWORD = 'EaseIt-Dev-2026!';

/**
 * The Shubh Shaleen Springs general manager.
 *
 * Its own password rather than the shared `DEV_PASSWORD`, because this is the
 * account a human signs in with to look at a furnished property. A real
 * mailbox, so the emailed second factor actually arrives.
 */
const SHUBH_GM_EMAIL = 'shubhshaleensprings@gmail.com';
const SHUBH_GM_PASSWORD = 'Password123!';

/* -------------------------------------------------------------------------- */
/*  Portfolio fixtures                                                        */
/* -------------------------------------------------------------------------- */

interface PropertySeed {
  slug: string;
  /** Operator-facing short code, unique portfolio-wide. */
  code: string;
  name: string;
  /** Operating region this property reports under. */
  division: string;
  /** Street line, which is what the group dashboard shows. */
  addressLine1: string;
  postalCode: string;
  city: string;
  state: string;
  timezone: string;
  currency: string;
  locale: string;
  /**
   * Omitted means ACTIVE. Two properties deliberately are not, so the group
   * dashboard's status filter has something real to filter and the default
   * ACTIVE view can be seen to be excluding them.
   */
  status?: PropertyStatusEnum;
}

const PROPERTIES: readonly PropertySeed[] = [
  {
    slug: 'grand-marine-goa',
    code: '31001',
    division: 'Goa Coastal Division',
    addressLine1: 'Plot 14, Dona Paula Road, Near Marina Jetty',
    postalCode: '403004',
    name: 'Grand Marine Goa',
    city: 'Panaji',
    state: 'Goa',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  {
    slug: 'lakeview-udaipur',
    code: '31002',
    division: 'Rajasthan Lakes Division',
    addressLine1: 'Lake Pichola East Bank, Gangaur Ghat Marg',
    postalCode: '313001',
    status: PropertyStatus.ONBOARDING,
    name: 'Lakeview Udaipur',
    city: 'Udaipur',
    state: 'Rajasthan',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  {
    slug: 'hillcrest-manali',
    code: '31004',
    division: 'Himachal Hills Division',
    addressLine1: 'Log Huts Area, Old Manali Road',
    postalCode: '175131',
    name: 'Hillcrest Manali',
    city: 'Manali',
    state: 'Himachal Pradesh',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  {
    slug: 'palm-court-kochi',
    code: '31007',
    division: 'Kerala Backwaters Division',
    addressLine1: '41/418 Marine Drive, Ernakulam South',
    postalCode: '682031',
    name: 'Palm Court Kochi',
    city: 'Kochi',
    state: 'Kerala',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  {
    slug: 'city-central-mumbai',
    code: '31008',
    division: 'West Metro Division',
    addressLine1: 'Plot 9, Bandra Kurla Complex, Bandra East',
    postalCode: '400051',
    name: 'City Central Mumbai',
    city: 'Mumbai',
    state: 'Maharashtra',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  {
    slug: 'heritage-jaipur',
    code: '31003',
    division: 'Rajasthan Heritage Division',
    addressLine1: 'C-72 Civil Lines, Opposite Jai Club',
    postalCode: '302006',
    name: 'Heritage Jaipur',
    city: 'Jaipur',
    state: 'Rajasthan',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  {
    slug: 'backwater-alleppey',
    code: '31006',
    division: 'Kerala Backwaters Division',
    addressLine1: 'Punnamada Finishing Point, Thathampally',
    postalCode: '688013',
    name: 'Backwater Alleppey',
    city: 'Alappuzha',
    state: 'Kerala',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  {
    slug: 'summit-shimla',
    code: '31005',
    division: 'Himachal Hills Division',
    addressLine1: 'The Ridge, Mall Road Upper Bazaar',
    postalCode: '171001',
    name: 'Summit Shimla',
    city: 'Shimla',
    state: 'Himachal Pradesh',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  {
    slug: 'tech-park-bengaluru',
    code: '31009',
    division: 'South Metro Division',
    addressLine1: 'Outer Ring Road, Bellandur, Near Ecospace',
    postalCode: '560103',
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
    slug: 'shubh-shaleen-springs',
    code: '31336',
    name: 'Shubh Shaleen Springs',
    division: 'Bhopal Division',
    addressLine1: 'Infront of Ishan Business Park, Hoshangabad Rd',
    postalCode: '462026',
    city: 'Bhopal',
    state: 'Madhya Pradesh',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
  },
  {
    slug: 'marina-bay-colombo',
    code: '31010',
    division: 'International Division',
    addressLine1: '27 Marine Drive, Kollupitiya',
    postalCode: '00300',
    status: PropertyStatus.INACTIVE,
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
/*  Permissions                                                               */
/* -------------------------------------------------------------------------- */

async function seedPermissions(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const definition of PERMISSION_DEFINITIONS) {
    const record = await prisma.permission.upsert({
      where: { key: definition.key },
      update: {
        label: definition.label,
        description: definition.description,
        category: definition.category as PermissionCategory,
        sensitive: definition.sensitive,
      },
      create: {
        key: definition.key,
        label: definition.label,
        description: definition.description,
        category: definition.category as PermissionCategory,
        sensitive: definition.sensitive,
      },
      select: { id: true },
    });
    ids.set(definition.key, record.id);
  }

  console.log(`  permissions: ${String(ids.size)}`);
  return ids;
}

/* -------------------------------------------------------------------------- */
/*  Roles                                                                     */
/* -------------------------------------------------------------------------- */

/** Replaces a role's grant set wholesale — @repo/types is authoritative. */
async function setRolePermissions(
  roleId: string,
  permissions: readonly string[],
  permissionIds: Map<string, string>,
): Promise<void> {
  await prisma.rolePermission.deleteMany({ where: { roleId } });
  await prisma.rolePermission.createMany({
    data: permissions.flatMap((key) => {
      const permissionId = permissionIds.get(key);
      return permissionId === undefined ? [] : [{ roleId, permissionId }];
    }),
    skipDuplicates: true,
  });
}

/**
 * System templates: `propertyId` null, `key` set, `isCustom` false — the shape
 * the `role_template_or_custom` CHECK constraint enforces.
 *
 * Upserted via findFirst/create rather than `upsert`, because the uniqueness
 * of a system role is enforced by a *partial* index on `key WHERE propertyId
 * IS NULL`, which Prisma has no compound-unique input for.
 */
async function seedSystemRoles(
  permissionIds: Map<string, string>,
): Promise<Map<RoleKeyType, string>> {
  const ids = new Map<RoleKeyType, string>();

  for (const roleKey of ALL_ROLES) {
    const existing = await prisma.role.findFirst({
      where: { key: roleKey as RoleKey, propertyId: null },
      select: { id: true },
    });

    const roleId =
      existing?.id ??
      (
        await prisma.role.create({
          data: {
            key: roleKey as RoleKey,
            name: ROLE_LABELS[roleKey],
            description: ROLE_DESCRIPTIONS[roleKey],
            isCustom: false,
            propertyId: null,
          },
          select: { id: true },
        })
      ).id;

    if (existing !== null) {
      await prisma.role.update({
        where: { id: roleId },
        data: {
          name: ROLE_LABELS[roleKey],
          description: ROLE_DESCRIPTIONS[roleKey],
        },
      });
    }

    const granted = DEFAULT_ROLE_PERMISSIONS[roleKey];
    await setRolePermissions(roleId, granted, permissionIds);
    ids.set(roleKey, roleId);

    console.log(`  role ${roleKey}: ${String(granted.length)} permissions`);
  }

  return ids;
}

/**
 * One custom role, to prove the property-owned path works end to end: a small
 * hotel where the same person covers reception and the night audit.
 */
async function seedCustomRole(
  propertyId: string,
  permissionIds: Map<string, string>,
): Promise<string> {
  const name = 'Front Desk & Night Auditor';

  const existing = await prisma.role.findFirst({
    where: { propertyId, name },
    select: { id: true },
  });

  const roleId =
    existing?.id ??
    (
      await prisma.role.create({
        data: {
          name,
          description: 'Combined reception and night-audit duties for a single-cover shift.',
          isCustom: true,
          key: null,
          propertyId,
        },
        select: { id: true },
      })
    ).id;

  // Union of the two templates, minus the refund permission: a combined role
  // should not quietly accumulate more authority than either part had.
  const combined = new Set<string>([
    ...DEFAULT_ROLE_PERMISSIONS.FRONT_DESK,
    ...DEFAULT_ROLE_PERMISSIONS.NIGHT_AUDITOR,
  ]);
  combined.delete(Permission.FOLIO_REFUND);

  await setRolePermissions(roleId, [...combined], permissionIds);
  console.log(`  custom role "${name}": ${String(combined.size)} permissions`);

  return roleId;
}

/* -------------------------------------------------------------------------- */
/*  Properties                                                                */
/* -------------------------------------------------------------------------- */

async function seedProperties(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  // Park every existing code before reassigning any.
  //
  // `code` is unique, and the order the seed assigns codes in is not the order
  // the migration's backfill used — so upserting the first property with code
  // 31001 collides with whichever property the backfill had already given
  // 31001 to. Moving them all out of the way first makes this loop
  // order-independent, which it has to be: the seed must converge no matter
  // what the codes currently are.
  //
  // Keyed on the row id, so the temporary values cannot collide either. If the
  // seed is interrupted here, properties are left holding `pending-<uuid>`
  // codes and the next run repairs them.
  const existing = await prisma.property.findMany({ select: { id: true, code: true } });
  for (const row of existing) {
    if (!row.code.startsWith('pending-')) {
      await prisma.property.update({
        where: { id: row.id },
        data: { code: `pending-${row.id}` },
        select: { id: true },
      });
    }
  }

  for (const seed of PROPERTIES) {
    const property = await prisma.property.upsert({
      where: { slug: seed.slug },
      update: {
        // `code` is in the update set so re-seeding a database migrated from
        // the old boolean column replaces the generated 31001-style backfill
        // with the intended code. `businessDate` is deliberately NOT: it is
        // owned by the night audit and re-seeding must not roll it back
        // (CLAUDE.md section 3.3).
        code: seed.code,
        name: seed.name,
        division: seed.division,
        status: seed.status ?? PropertyStatus.ACTIVE,
        timezone: seed.timezone,
        locale: seed.locale,
        addressLine1: seed.addressLine1,
        postalCode: seed.postalCode,
        city: seed.city,
        state: seed.state,
        // Also on update, not just create. A seed that only sets a field on
        // insert stops converging the moment the row exists — re-running it
        // would leave an older database permanently out of step with the
        // fixtures it is supposed to define.
        logoUrl: seed.code === '31336' ? '/property-logos/31336.svg' : null,
        // A flat 5% GST, as configured for this portfolio. Note that 5% is the
        // restaurant-service rate rather than the statutory room-tariff
        // treatment (12% below ₹7,500 a night, 18% at or above) — leaving this
        // null falls back to those slabs.
        taxRatePercent: 5,
      },
      create: {
        slug: seed.slug,
        code: seed.code,
        name: seed.name,
        legalName: `${seed.name} Hospitality Pvt Ltd`,
        division: seed.division,
        status: seed.status ?? PropertyStatus.ACTIVE,
        timezone: seed.timezone,
        currency: seed.currency,
        locale: seed.locale,
        businessDate: businessDateFor(seed.timezone),
        addressLine1: seed.addressLine1,
        postalCode: seed.postalCode,
        city: seed.city,
        state: seed.state,
        countryCode: seed.currency === 'LKR' ? 'LK' : 'IN',
        email: `frontdesk@${seed.slug}.example.com`,
        // Most properties keep a null logo on purpose: the shell falls back to
        // rendered initials, and that is the common case for a real portfolio.
        // One property carries a logo so the image path is actually exercised
        // in development rather than being code nobody has ever seen run.
        //
        // The path is served from the admin app's `public/`. Real logos would
        // be uploaded assets on a CDN; this is a dev fixture, which is why it
        // is a site-relative path rather than an absolute URL.
        logoUrl: seed.code === '31336' ? '/property-logos/31336.svg' : null,
        taxRatePercent: 5,
      },
      select: { id: true },
    });
    ids.set(seed.slug, property.id);
  }

  const byStatus = PROPERTIES.reduce<Record<string, number>>((acc, seed) => {
    const key = seed.status ?? PropertyStatus.ACTIVE;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `  properties: ${String(ids.size)} (` +
      Object.entries(byStatus)
        .map(([status, count]) => `${status} ${String(count)}`)
        .join(', ') +
      ')',
  );
  return ids;
}

/* -------------------------------------------------------------------------- */
/*  Staff and grants                                                          */
/* -------------------------------------------------------------------------- */

interface GrantCounters {
  users: number;
  grants: number;
}

async function upsertUser(
  email: string,
  firstName: string,
  lastName: string,
  passwordHash: string,
): Promise<string> {
  const user = await prisma.user.upsert({
    where: { email },
    update: { isActive: true, firstName, lastName },
    create: { email, passwordHash, firstName, lastName },
    select: { id: true },
  });
  return user.id;
}

async function grant(
  userId: string,
  propertyId: string,
  roleId: string,
  counters: GrantCounters,
): Promise<void> {
  const existing = await prisma.userPropertyRole.findUnique({
    where: { user_property_role_unique: { userId, propertyId, roleId } },
    select: { id: true },
  });
  if (existing === null) {
    await prisma.userPropertyRole.create({ data: { userId, propertyId, roleId } });
    counters.grants += 1;
  }
}

async function seedStaff(
  roleIds: Map<RoleKeyType, string>,
  propertyIds: Map<string, string>,
  customRoleId: string,
): Promise<void> {
  const passwordHash = await hash(DEV_PASSWORD, 12);
  const counters: GrantCounters = { users: 0, grants: 0 };

  const roleIdFor = (role: RoleKeyType): string => {
    const id = roleIds.get(role);
    if (id === undefined) throw new Error(`Role ${role} was not seeded.`);
    return id;
  };

  // Portfolio operator. `UserPropertyRole.propertyId` is non-nullable by
  // design, so the super admin is granted explicitly at every property: the
  // grants are then visible and revocable in the staff directory rather than
  // being implied by a magic null row. ActivePropertyGuard *additionally*
  // honours the portfolio role, so onboarding property #11 cannot lock them
  // out before the grant is created.
  const superAdminId = await upsertUser(
    'owner@easeit.example.com',
    'Portfolio',
    'Owner',
    passwordHash,
  );
  counters.users += 1;
  for (const propertyId of propertyIds.values()) {
    await grant(superAdminId, propertyId, roleIdFor('SUPER_ADMIN'), counters);
  }

  // One staff member per property-scoped role, at every property.
  const propertyScopedRoles = ALL_ROLES.filter((role) => !isPortfolioRole(role));

  for (const seed of PROPERTIES) {
    const propertyId = propertyIds.get(seed.slug);
    if (propertyId === undefined) throw new Error(`Property ${seed.slug} missing.`);

    for (const roleKey of propertyScopedRoles) {
      const localPart = `${roleKey.toLowerCase().replace(/_/g, '.')}@${seed.slug}.example.com`;
      const userId = await upsertUser(
        localPart,
        ROLE_LABELS[roleKey].split(' ')[0] ?? 'Staff',
        seed.name.split(' ')[0] ?? 'Member',
        passwordHash,
      );
      counters.users += 1;
      await grant(userId, propertyId, roleIdFor(roleKey), counters);
    }
  }

  // Multi-role at one property: this clerk holds both Front Desk and Night
  // Auditor, so their effective permissions are the union of the two.
  const goaId = propertyIds.get('grand-marine-goa');
  if (goaId !== undefined) {
    const dualId = await upsertUser(
      'dual.role@grand-marine-goa.example.com',
      'Asha',
      'Nair',
      passwordHash,
    );
    counters.users += 1;
    await grant(dualId, goaId, roleIdFor('FRONT_DESK'), counters);
    await grant(dualId, goaId, roleIdFor('NIGHT_AUDITOR'), counters);

    // And one holding the property's custom combined role.
    const customId = await upsertUser(
      'single.cover@grand-marine-goa.example.com',
      'Ravi',
      'Menon',
      passwordHash,
    );
    counters.users += 1;
    await grant(customId, goaId, customRoleId, counters);
  }

  // Different roles at different properties: one revenue manager covering two
  // hotels, which is what the tenant-isolation tests use as a subject.
  const udaipurId = propertyIds.get('lakeview-udaipur');
  if (goaId !== undefined && udaipurId !== undefined) {
    const sharedId = await upsertUser(
      'revenue.west@easeit.example.com',
      'West',
      'Revenue',
      passwordHash,
    );
    counters.users += 1;
    await grant(sharedId, goaId, roleIdFor('REVENUE_MANAGER'), counters);
    await grant(sharedId, udaipurId, roleIdFor('REVENUE_MANAGER'), counters);
  }

  // ---------------------------------------------------------------------
  // Optional: a real mailbox, for testing two-factor delivery end to end.
  //
  // Every other seeded account uses a reserved `*.example.com` address, which
  // is correct for fixtures — those domains can never receive mail, so a seed
  // can never accidentally email a real person. The consequence is that none
  // of them can be used to check that an emailed code actually *arrives*.
  //
  // Set SEED_ADMIN_EMAIL in packages/database/.env (gitignored) to an address
  // you control and this creates a Property Admin at Grand Marine Goa for it.
  // Read from the environment rather than written into this file so a personal
  // address is never committed.
  // ---------------------------------------------------------------------
  const realAdminEmail = process.env['SEED_ADMIN_EMAIL']?.trim().toLowerCase();
  if (realAdminEmail !== undefined && realAdminEmail.length > 0) {
    const goaId = propertyIds.get('grand-marine-goa');
    if (goaId === undefined) throw new Error('grand-marine-goa was not seeded.');

    const localPart = realAdminEmail.split('@')[0] ?? 'Admin';
    const adminId = await upsertUser(
      realAdminEmail,
      // Capitalised local part, so the email greeting reads as a name rather
      // than as an address.
      localPart.charAt(0).toUpperCase() + localPart.slice(1),
      'Admin',
      passwordHash,
    );
    counters.users += 1;
    await grant(adminId, goaId, roleIdFor('PROPERTY_ADMIN'), counters);
    console.log(`  real-mailbox admin: ${realAdminEmail} (Property Admin, Grand Marine Goa)`);
  }

  console.log(`  users: ${String(counters.users)}, grants: ${String(counters.grants)}`);
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                               */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*  Operational fixtures: rooms, inventory, bookings, gateways                */
/* -------------------------------------------------------------------------- */

/**
 * Furnishes every property with enough data that each screen shows something
 * real.
 *
 * Shubh Shaleen Springs keeps its hand-written plan — the room numbers and
 * guest names there are load-bearing, matching the reference operations
 * screen. Every other property gets a generated plan, so the group dashboard,
 * the group calendar and the per-property dashboard all have non-zero figures
 * for more than one hotel. Before this, nine of eleven properties rendered
 * "Not set up" and the portfolio occupancy came from a single hotel.
 *
 * Every plan covers all eight dashboard tabs and all four room statuses, so
 * the UI can be checked rather than guessed at.
 */

/**
 * Inventory runs from 1 January of *last* year through 60 days ahead.
 *
 * The performance dashboard needs a real denominator for every period it
 * offers: year-to-date needs this January onward, and "compare with last year"
 * needs the whole previous year. Capacity is the only record of what a hotel
 * *could* have sold on a past date, so without those rows occupancy and RevPAR
 * for any historical window are undefined rather than zero.
 *
 * Roughly 700 days × 60 room types, so the rows are built in memory and
 * written with one `createMany` per property.
 */
const INVENTORY_DAYS_FORWARD = 60;

/** Months of completed stays generated behind today, for the trajectory. */
const HISTORY_MONTHS = 22;

interface RoomTypeSeed {
  code: string;
  name: string;
  description: string;
  maxGuests: number;
  /** Major units, as an operator quotes them. Converted once on write. */
  baseRateRupees: number;
  numbers: readonly string[];
  sortOrder: number;
}

interface ReservationSeed {
  /** Suffix; the property code is prefixed, keeping codes unique per hotel. */
  ref: string;
  guestFirst: string;
  guestLast: string;
  phone: string;
  email: string | null;
  roomTypeCode: string;
  /** Days relative to the property's own business date. */
  arrivalOffset: number;
  departureOffset: number;
  status: ReservationStatus;
  mealPlan: MealPlan;
  adults: number;
  children: number;
  totalRupees: number;
  paidRupees: number;
  magicLink: boolean;
  /** Days before today the booking was made. 0 populates "new bookings". */
  bookedDaysAgo: number;
  /**
   * Sales channel. Defaults to `DIRECT_WEB` where a fixture does not care.
   *
   * Every fixture used to be `DIRECT_WEB`, which made the booking-source
   * report a single bar at 100% — technically correct and useless for
   * reviewing the widget.
   */
  source?: BookingSource;
  /** Channel reference, for an OTA booking. Unique per property. */
  otaBookingId?: string;
  /**
   * Government photo ID.
   *
   * Only a few fixtures carry one, which is realistic — it is recorded at
   * check-in, not at booking. Syntactically valid but fictional:
   * `ABCDE1234F` is the PAN *format* and belongs to nobody.
   */
  govtIdNumber?: string;
  /**
   * Force this stay to stay unassigned.
   *
   * Cancellations, no-shows and holds usually never get a room number, and the
   * feed needs rows that render the "Unassigned" state.
   */
  unassigned?: boolean;
}

interface PropertyPlan {
  roomTypes: readonly RoomTypeSeed[];
  reservations: readonly ReservationSeed[];
  gateway: PaymentGatewayStatus;
  /** Days overdue for the gateway alert; negative means still in future. */
  gatewayDueOffset: number;
}

/** `count` room numbers, e.g. seq('E', 1101, 5) -> 1101E… */
function seq(suffix: string, start: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${String(start + i)}${suffix}`);
}

function prefixSeq(prefix: string, start: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(start + i)}`);
}

function plainSeq(start: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => String(start + i));
}

/* -------------------------------------------------------------------------- */
/*  Shubh Shaleen Springs — the hand-written plan                             */
/* -------------------------------------------------------------------------- */

const SHUBH_SLUG = 'shubh-shaleen-springs';

/**
 * Ten categories totalling exactly 100 rooms.
 *
 * 1103E, 1302E, 106Q and 202D are load-bearing: the four in-house fixtures are
 * pinned to those numbers, so changing these lists fails the seed loudly
 * rather than silently reassigning a guest.
 */
const SHUBH_ROOM_TYPES: readonly RoomTypeSeed[] = [
  { code: 'DLX', name: 'Deluxe Room', description: 'Garden view, king bed, 28 sqm.', maxGuests: 3, baseRateRupees: 3500, numbers: seq('D', 201, 20), sortOrder: 1 },
  { code: 'DLXA', name: 'DELUXE A', description: 'Upper-floor deluxe with balcony.', maxGuests: 3, baseRateRupees: 4200, numbers: seq('D', 301, 12), sortOrder: 2 },
  { code: 'EXEA', name: 'EXECUTIVE-A', description: 'Executive tower, work desk, lounge access.', maxGuests: 2, baseRateRupees: 5500, numbers: [...seq('E', 1101, 5), ...seq('E', 1201, 5), ...seq('E', 1301, 5)], sortOrder: 3 },
  { code: 'EXEB', name: 'EXECUTIVE-B', description: 'Executive tower, courtyard facing.', maxGuests: 2, baseRateRupees: 5200, numbers: seq('E', 1401, 10), sortOrder: 4 },
  { code: 'QUADA', name: 'QUAD-A', description: 'Four beds, family or group use.', maxGuests: 4, baseRateRupees: 6000, numbers: seq('Q', 101, 8), sortOrder: 5 },
  { code: 'QUADF', name: 'QUAD FAKE', description: 'Legacy category retained for historical bookings.', maxGuests: 4, baseRateRupees: 2500, numbers: seq('Q', 201, 5), sortOrder: 6 },
  { code: 'DORMA', name: 'DORMITORY-A', description: 'Shared dormitory, per-bed rate.', maxGuests: 1, baseRateRupees: 1200, numbers: prefixSeq('D', 101, 15), sortOrder: 7 },
  { code: 'DORMB', name: 'DORMITORY-B', description: 'Shared dormitory, per-bed rate, annexe.', maxGuests: 1, baseRateRupees: 1100, numbers: prefixSeq('DB', 201, 5), sortOrder: 8 },
  { code: 'SUITE', name: 'Premium Suite', description: 'Two rooms, private terrace.', maxGuests: 4, baseRateRupees: 9500, numbers: seq('S', 501, 6), sortOrder: 9 },
  { code: 'FAM', name: 'Family Room', description: 'Interconnecting twin and king.', maxGuests: 5, baseRateRupees: 7000, numbers: seq('F', 601, 4), sortOrder: 10 },
];

/** Rooms pinned by number, so the reference screen can be reproduced exactly. */
const SHUBH_PINNED: Record<string, string> = {
  '000418': '1103E',
  '000452': '1302E',
  '000467': '106Q',
  '000471': '202D',
};

const SHUBH_RESERVATIONS: readonly ReservationSeed[] = [
  // The four in-house stays from the reference operations screen.
  { ref: '000418', guestFirst: 'Mohan', guestLast: 'Krishna', phone: '+91 98930 41821', email: 'mohan.krishna@example.com', roomTypeCode: 'EXEA', arrivalOffset: -9, departureOffset: 0, status: ReservationStatus.CHECKED_IN, mealPlan: MealPlan.EP, adults: 1, children: 0, totalRupees: 18000, paidRupees: 11440.99, magicLink: false, bookedDaysAgo: 24, source: BookingSource.BOOKING_COM },
  { ref: '000452', guestFirst: 'Ankul', guestLast: 'Yazaki', phone: '+91 90391 55210', email: 'ankul.yazaki@example.com', roomTypeCode: 'EXEA', arrivalOffset: -4, departureOffset: 1, status: ReservationStatus.CHECKED_IN, mealPlan: MealPlan.CP, adults: 1, children: 0, totalRupees: 12500, paidRupees: 12500, magicLink: true, bookedDaysAgo: 12, source: BookingSource.MAKEMYTRIP },
  { ref: '000467', guestFirst: 'Shivlok', guestLast: 'Yazaki', phone: '+91 87705 29340', email: 'shivlok.yazaki@example.com', roomTypeCode: 'QUADA', arrivalOffset: -2, departureOffset: 3, status: ReservationStatus.CHECKED_IN, mealPlan: MealPlan.EP, adults: 1, children: 2, totalRupees: 21000, paidRupees: 10000, magicLink: false, bookedDaysAgo: 8, source: BookingSource.AGODA },
  { ref: '000471', guestFirst: 'Payal', guestLast: 'Sharma', phone: '+91 99817 60043', email: 'payal.sharma@example.com', roomTypeCode: 'DLX', arrivalOffset: -1, departureOffset: 0, status: ReservationStatus.CHECKED_IN, mealPlan: MealPlan.CP, adults: 2, children: 1, totalRupees: 9800, paidRupees: 4900, magicLink: true, bookedDaysAgo: 3, source: BookingSource.WALK_IN },

  // More in-house depth, so the board is not four rows.
  { ref: '000479', guestFirst: 'Farhan', guestLast: 'Shaikh', phone: '+91 98201 33764', email: 'farhan.shaikh@example.com', roomTypeCode: 'SUITE', arrivalOffset: -6, departureOffset: 4, status: ReservationStatus.CHECKED_IN, mealPlan: MealPlan.AP, adults: 2, children: 2, totalRupees: 95000, paidRupees: 50000, magicLink: false, bookedDaysAgo: 31, source: BookingSource.EXPEDIA },
  { ref: '000481', guestFirst: 'Geeta', guestLast: 'Iyer', phone: '+91 94480 20917', email: 'geeta.iyer@example.com', roomTypeCode: 'DORMA', arrivalOffset: -3, departureOffset: 0, status: ReservationStatus.CHECKED_IN, mealPlan: MealPlan.EP, adults: 1, children: 0, totalRupees: 3600, paidRupees: 3600, magicLink: false, bookedDaysAgo: 6, source: BookingSource.WALK_IN },

  // Checked in *today*, at an odd minute. Without one of these the hourly Day
  // view shows every block starting at midnight or at the desk time, and the
  // minute-level placement is impossible to eyeball.
  { ref: '000505', guestFirst: 'Vishal', guestLast: 'Vishwakarma', phone: '+91 93025 71140', email: 'vishal.vishwakarma@example.com', roomTypeCode: 'EXEB', arrivalOffset: 0, departureOffset: 3, status: ReservationStatus.CHECKED_IN, mealPlan: MealPlan.CP, adults: 2, children: 0, totalRupees: 15600, paidRupees: 5200, magicLink: false, bookedDaysAgo: 2, source: BookingSource.CLEARTRIP },

  // Arrivals today.
  { ref: '000488', guestFirst: 'Rohit', guestLast: 'Menon', phone: '+91 98450 77311', email: 'rohit.menon@example.com', roomTypeCode: 'EXEA', arrivalOffset: 0, departureOffset: 2, status: ReservationStatus.CONFIRMED, mealPlan: MealPlan.MAP, adults: 2, children: 0, totalRupees: 11000, paidRupees: 0, magicLink: false, bookedDaysAgo: 0, source: BookingSource.MAKEMYTRIP },
  { ref: '000489', guestFirst: 'Sneha', guestLast: 'Kulkarni', phone: '+91 90042 88150', email: 'sneha.kulkarni@example.com', roomTypeCode: 'DLXA', arrivalOffset: 0, departureOffset: 4, status: ReservationStatus.CONFIRMED, mealPlan: MealPlan.CP, adults: 2, children: 1, totalRupees: 16800, paidRupees: 8400, magicLink: true, bookedDaysAgo: 0, source: BookingSource.BOOKING_COM },

  // Advance bookings.
  { ref: '000493', guestFirst: 'Arjun', guestLast: 'Bhatia', phone: '+91 99712 04488', email: 'arjun.bhatia@example.com', roomTypeCode: 'FAM', arrivalOffset: 3, departureOffset: 7, status: ReservationStatus.CONFIRMED, mealPlan: MealPlan.MAP, adults: 2, children: 3, totalRupees: 28000, paidRupees: 7000, magicLink: false, bookedDaysAgo: 2, source: BookingSource.AGODA },
  { ref: '000496', guestFirst: 'Leela', guestLast: 'Pillai', phone: '+91 90876 51129', email: 'leela.pillai@example.com', roomTypeCode: 'EXEB', arrivalOffset: 9, departureOffset: 12, status: ReservationStatus.CONFIRMED, mealPlan: MealPlan.CP, adults: 1, children: 0, totalRupees: 15600, paidRupees: 15600, magicLink: true, bookedDaysAgo: 1, source: BookingSource.DIRECT_WEB },
  { ref: '000501', guestFirst: 'Vikram', guestLast: 'Chauhan', phone: '+91 98110 76234', email: 'vikram.chauhan@example.com', roomTypeCode: 'QUADF', arrivalOffset: 21, departureOffset: 25, status: ReservationStatus.CONFIRMED, mealPlan: MealPlan.EP, adults: 4, children: 0, totalRupees: 10000, paidRupees: 2500, magicLink: false, bookedDaysAgo: 4, source: BookingSource.PHONE },

  // Four channel-specific stays, all live today, so the booking-source widget
  // has a real distribution in the Today window rather than one bar. One
  // night each for the first two, so the whole amount lands on today and the
  // figures are checkable by eye against the bars.
  { ref: '000512', guestFirst: 'Harish', guestLast: 'Salunke', phone: '+91 98220 44190', email: 'harish.salunke@example.com', roomTypeCode: 'EXEA', arrivalOffset: 0, departureOffset: 1, status: ReservationStatus.CHECKED_IN, mealPlan: MealPlan.EP, adults: 2, children: 0, totalRupees: 5400, paidRupees: 5400, magicLink: false, bookedDaysAgo: 0, source: BookingSource.WALK_IN },
  { ref: '000513', guestFirst: 'Pooja', guestLast: 'Deshmukh', phone: '+91 97640 51238', email: 'pooja.deshmukh@example.com', roomTypeCode: 'DORMA', arrivalOffset: 0, departureOffset: 1, status: ReservationStatus.CONFIRMED, mealPlan: MealPlan.EP, adults: 1, children: 0, totalRupees: 1500, paidRupees: 1500, magicLink: false, bookedDaysAgo: 1, source: BookingSource.MAKEMYTRIP },
  { ref: '000514', guestFirst: 'Sandeep', guestLast: 'Rathore', phone: '+91 99300 76215', email: 'sandeep.rathore@example.com', roomTypeCode: 'DLXA', arrivalOffset: -1, departureOffset: 2, status: ReservationStatus.CHECKED_IN, mealPlan: MealPlan.CP, adults: 2, children: 1, totalRupees: 7200, paidRupees: 3600, magicLink: false, bookedDaysAgo: 9, source: BookingSource.AGODA },
  { ref: '000515', guestFirst: 'Anita', guestLast: 'Chandran', phone: '+91 94470 30852', email: 'anita.chandran@example.com', roomTypeCode: 'DLX', arrivalOffset: -2, departureOffset: 1, status: ReservationStatus.CHECKED_IN, mealPlan: MealPlan.CP, adults: 2, children: 0, totalRupees: 9600, paidRupees: 9600, magicLink: true, bookedDaysAgo: 14, source: BookingSource.BOOKING_COM },

  // ---------------------------------------------------------------------
  // The omnibar search fixture. Every identifier the search matches on is
  // populated here, so all seven paths have something to find: name
  // "Vikram"/"Malhotra", phone fragment "5432", PAN fragment "1234F", OTA ref
  // fragment "8829", the booking code, the email, and a room number once the
  // allocator assigns one.
  // ---------------------------------------------------------------------
  { ref: '000520', guestFirst: 'Vikram', guestLast: 'Malhotra', phone: '9876543210', email: 'vikram.malhotra@example.com', roomTypeCode: 'EXEA', arrivalOffset: 0, departureOffset: 2, status: ReservationStatus.CHECKED_IN, mealPlan: MealPlan.CP, adults: 2, children: 0, totalRupees: 14600, paidRupees: 7300, magicLink: false, bookedDaysAgo: 6, source: BookingSource.MAKEMYTRIP, otaBookingId: 'MMT-8829103', govtIdNumber: 'ABCDE1234F' },

  // Departed, held, cancelled, no-show.
  { ref: '000402', guestFirst: 'Tanvi', guestLast: 'Joshi', phone: '+91 97690 31204', email: 'tanvi.joshi@example.com', roomTypeCode: 'DLX', arrivalOffset: -12, departureOffset: -8, status: ReservationStatus.CHECKED_OUT, mealPlan: MealPlan.CP, adults: 2, children: 0, totalRupees: 14000, paidRupees: 14000, magicLink: false, bookedDaysAgo: 28, source: BookingSource.MAKEMYTRIP },
  { ref: '000490', guestFirst: 'Nisha', guestLast: 'Rao', phone: '+91 97400 21885', email: 'nisha.rao@example.com', roomTypeCode: 'SUITE', arrivalOffset: 4, departureOffset: 6, status: ReservationStatus.ON_HOLD, mealPlan: MealPlan.AP, adults: 2, children: 2, totalRupees: 19000, paidRupees: 0, magicLink: true, bookedDaysAgo: 0, unassigned: true, source: BookingSource.CORPORATE },
  { ref: '000474', guestFirst: 'Imran', guestLast: 'Qureshi', phone: '+91 88260 93014', email: null, roomTypeCode: 'DLXA', arrivalOffset: 1, departureOffset: 3, status: ReservationStatus.CANCELLED, mealPlan: MealPlan.EP, adults: 1, children: 0, totalRupees: 8400, paidRupees: 0, magicLink: false, bookedDaysAgo: 5, unassigned: true, source: BookingSource.EXPEDIA },
  { ref: '000461', guestFirst: 'Deepak', guestLast: 'Verma', phone: '+91 95550 18742', email: 'deepak.verma@example.com', roomTypeCode: 'DORMA', arrivalOffset: -3, departureOffset: -1, status: ReservationStatus.NO_SHOW, mealPlan: MealPlan.EP, adults: 1, children: 0, totalRupees: 2400, paidRupees: 0, magicLink: false, bookedDaysAgo: 10, unassigned: true, source: BookingSource.CLEARTRIP },
];

/**
 * A function, not a module-level const.
 *
 * It reads `GUESTS` and `HISTORY_MONTHS`, which are declared further down the
 * file. A top-level const would evaluate at import time and hit the temporal
 * dead zone — "Cannot access 'GUESTS' before initialization" — which is a real
 * failure that only appears when the module is actually loaded. Building the
 * plan on demand removes the ordering hazard rather than papering over it by
 * shuffling declarations, which the next edit would undo.
 */
function shubhPlan(): PropertyPlan {
  return {
  roomTypes: SHUBH_ROOM_TYPES,
  reservations: [
    ...SHUBH_RESERVATIONS,
    // Index 10 keeps its history distinct from the generated properties'.
    ...historicalStays(10, 1.2, SHUBH_ROOM_TYPES.map((type) => type.code)),
  ],
  gateway: PaymentGatewayStatus.PENDING_KYC,
  gatewayDueOffset: -5,
  };
}

/* -------------------------------------------------------------------------- */
/*  Generated plans for the rest of the portfolio                             */
/* -------------------------------------------------------------------------- */

/** Guest names drawn in rotation, so no two properties read identically. */
const GUESTS: readonly { first: string; last: string; phone: string }[] = [
  { first: 'Aarav', last: 'Nair', phone: '+91 98111 20034' },
  { first: 'Diya', last: 'Kapoor', phone: '+91 98222 41567' },
  { first: 'Kabir', last: 'Reddy', phone: '+91 98333 60289' },
  { first: 'Meera', last: 'Bose', phone: '+91 98444 83310' },
  { first: 'Rohan', last: 'Gupta', phone: '+91 98555 17742' },
  { first: 'Ishita', last: 'Malhotra', phone: '+91 98666 39081' },
  { first: 'Yash', last: 'Patel', phone: '+91 98777 52203' },
  { first: 'Ananya', last: 'Sen', phone: '+91 98888 74916' },
  { first: 'Zoya', last: 'Khan', phone: '+91 98999 08355' },
  { first: 'Nikhil', last: 'Rawat', phone: '+91 99000 26748' },
  { first: 'Pooja', last: 'Desai', phone: '+91 99111 93620' },
  { first: 'Siddharth', last: 'Jain', phone: '+91 99222 45187' },
];

/**
 * Five categories, 26 rooms, priced off a per-property multiplier so a resort
 * and a city hotel do not report identical ADRs.
 */
function genericRoomTypes(multiplier: number): RoomTypeSeed[] {
  const rate = (base: number): number => Math.round((base * multiplier) / 50) * 50;

  return [
    { code: 'STD', name: 'Standard Room', description: 'Twin or queen, 22 sqm.', maxGuests: 2, baseRateRupees: rate(2200), numbers: plainSeq(101, 8), sortOrder: 1 },
    { code: 'DLX', name: 'Deluxe Room', description: 'King bed, 28 sqm, balcony.', maxGuests: 3, baseRateRupees: rate(3400), numbers: plainSeq(201, 6), sortOrder: 2 },
    { code: 'SUP', name: 'Superior Room', description: 'Corner room with a view.', maxGuests: 3, baseRateRupees: rate(4100), numbers: plainSeq(301, 5), sortOrder: 3 },
    { code: 'FAM', name: 'Family Room', description: 'Interconnecting twin and king.', maxGuests: 5, baseRateRupees: rate(5900), numbers: plainSeq(401, 4), sortOrder: 4 },
    { code: 'SUI', name: 'Suite', description: 'Separate living area and terrace.', maxGuests: 4, baseRateRupees: rate(7600), numbers: plainSeq(501, 3), sortOrder: 5 },
  ];
}

/**
 * Eleven stays per property, covering every dashboard tab and every stay
 * phase: departed, in-house (one departing today), arriving today, three
 * advance bookings, a hold, a cancellation and a no-show.
 */
function genericReservations(propertyIndex: number, multiplier: number): ReservationSeed[] {
  const guest = (offset: number): { first: string; last: string; phone: string } => {
    const picked = GUESTS[(propertyIndex * 5 + offset) % GUESTS.length];
    // GUESTS is non-empty and the modulus bounds the index, so this is
    // unreachable — asserted rather than non-null-asserted, because a silent
    // undefined here would seed a guest called "undefined undefined".
    if (picked === undefined) throw new Error('Guest fixture list is empty.');
    return picked;
  };

  const money = (base: number): number => Math.round((base * multiplier) / 100) * 100;

  const rows: (Omit<ReservationSeed, 'guestFirst' | 'guestLast' | 'phone' | 'email'> & {
    guestIndex: number;
  })[] = [
    { ref: 'A01', guestIndex: 0, roomTypeCode: 'DLX', arrivalOffset: -11, departureOffset: -7, status: ReservationStatus.CHECKED_OUT, mealPlan: MealPlan.CP, adults: 2, children: 0, totalRupees: money(13600), paidRupees: money(13600), magicLink: false, bookedDaysAgo: 26 },
    { ref: 'A02', guestIndex: 1, roomTypeCode: 'STD', arrivalOffset: -5, departureOffset: 0, status: ReservationStatus.CHECKED_IN, mealPlan: MealPlan.EP, adults: 2, children: 0, totalRupees: money(11000), paidRupees: money(6000), magicLink: false, bookedDaysAgo: 14 },
    { ref: 'A03', guestIndex: 2, roomTypeCode: 'SUP', arrivalOffset: -3, departureOffset: 2, status: ReservationStatus.CHECKED_IN, mealPlan: MealPlan.MAP, adults: 2, children: 1, totalRupees: money(20500), paidRupees: money(10000), magicLink: true, bookedDaysAgo: 9 },
    { ref: 'A04', guestIndex: 3, roomTypeCode: 'SUI', arrivalOffset: -1, departureOffset: 4, status: ReservationStatus.CHECKED_IN, mealPlan: MealPlan.AP, adults: 2, children: 2, totalRupees: money(38000), paidRupees: money(20000), magicLink: false, bookedDaysAgo: 5 },
    { ref: 'A05', guestIndex: 4, roomTypeCode: 'STD', arrivalOffset: 0, departureOffset: 3, status: ReservationStatus.CONFIRMED, mealPlan: MealPlan.CP, adults: 1, children: 0, totalRupees: money(6600), paidRupees: 0, magicLink: false, bookedDaysAgo: 0 },
    { ref: 'A06', guestIndex: 5, roomTypeCode: 'FAM', arrivalOffset: 2, departureOffset: 5, status: ReservationStatus.CONFIRMED, mealPlan: MealPlan.MAP, adults: 2, children: 2, totalRupees: money(17700), paidRupees: money(5000), magicLink: true, bookedDaysAgo: 0 },
    { ref: 'A07', guestIndex: 6, roomTypeCode: 'DLX', arrivalOffset: 8, departureOffset: 11, status: ReservationStatus.CONFIRMED, mealPlan: MealPlan.EP, adults: 2, children: 0, totalRupees: money(10200), paidRupees: money(10200), magicLink: false, bookedDaysAgo: 3 },
    { ref: 'A08', guestIndex: 7, roomTypeCode: 'SUP', arrivalOffset: 18, departureOffset: 22, status: ReservationStatus.CONFIRMED, mealPlan: MealPlan.CP, adults: 2, children: 1, totalRupees: money(16400), paidRupees: money(4000), magicLink: false, bookedDaysAgo: 7 },
    { ref: 'A09', guestIndex: 8, roomTypeCode: 'SUI', arrivalOffset: 6, departureOffset: 9, status: ReservationStatus.ON_HOLD, mealPlan: MealPlan.AP, adults: 2, children: 0, totalRupees: money(22800), paidRupees: 0, magicLink: true, bookedDaysAgo: 1, unassigned: true },
    { ref: 'A10', guestIndex: 9, roomTypeCode: 'FAM', arrivalOffset: 4, departureOffset: 6, status: ReservationStatus.CANCELLED, mealPlan: MealPlan.EP, adults: 3, children: 1, totalRupees: money(11800), paidRupees: 0, magicLink: false, bookedDaysAgo: 11, unassigned: true },
    { ref: 'A12', guestIndex: 11, roomTypeCode: 'DLX', arrivalOffset: 0, departureOffset: 3, status: ReservationStatus.CHECKED_IN, mealPlan: MealPlan.CP, adults: 2, children: 0, totalRupees: money(10200), paidRupees: money(3400), magicLink: false, bookedDaysAgo: 2 },
    { ref: 'A11', guestIndex: 10, roomTypeCode: 'STD', arrivalOffset: -2, departureOffset: 0, status: ReservationStatus.NO_SHOW, mealPlan: MealPlan.EP, adults: 1, children: 0, totalRupees: money(4400), paidRupees: 0, magicLink: false, bookedDaysAgo: 8, unassigned: true },
  ];

  return rows.map((row, index) => {
    const picked = guest(row.guestIndex);
    return {
      ...row,
      guestFirst: picked.first,
      guestLast: picked.last,
      phone: picked.phone,
      email: `${picked.first.toLowerCase()}.${picked.last.toLowerCase()}@example.com`,
      // Channel varies by property *and* row, so the ten generated hotels do
      // not all show an identical source mix. Without this every current-window
      // booking outside Shubh was DIRECT_WEB, which put the booking-source
      // widget at ~79% "DIRECT WEBSITE" in the Today and MTD views while the
      // year-to-date view looked fine — a seeding artefact that reads exactly
      // like a bucket-mapping bug.
      //
      // `HISTORY_CHANNELS` is declared further down the file; referencing it
      // from a function body is safe because the call happens after module
      // evaluation, which is the same reason `shubhPlan` is a function.
      source:
        HISTORY_CHANNELS[(propertyIndex * 7 + index * 5) % HISTORY_CHANNELS.length] ??
        BookingSource.DIRECT_WEB,
    };
  });
}

/** Gateway state varies so the alert panel can be seen in each condition. */
const GATEWAY_BY_INDEX: readonly { status: PaymentGatewayStatus; dueOffset: number }[] = [
  { status: PaymentGatewayStatus.ACTIVE, dueOffset: -40 },
  { status: PaymentGatewayStatus.PENDING_KYC, dueOffset: -12 },
  { status: PaymentGatewayStatus.ACTIVE, dueOffset: -60 },
  { status: PaymentGatewayStatus.PENDING_KYC, dueOffset: 6 },
  { status: PaymentGatewayStatus.INACTIVE, dueOffset: -90 },
];

function genericPlan(propertyIndex: number): PropertyPlan {
  // Spread 0.8x - 1.5x so rates and ADRs differ visibly between hotels.
  const multiplier = 0.8 + ((propertyIndex * 7) % 8) * 0.1;
  const gateway = GATEWAY_BY_INDEX[propertyIndex % GATEWAY_BY_INDEX.length] ?? {
    status: PaymentGatewayStatus.ACTIVE,
    dueOffset: -30,
  };

  const roomTypes = genericRoomTypes(multiplier);

  return {
    roomTypes,
    reservations: [
      ...genericReservations(propertyIndex, multiplier),
      ...historicalStays(
        propertyIndex,
        multiplier,
        roomTypes.map((type) => type.code),
      ),
    ],
    gateway: gateway.status,
    gatewayDueOffset: gateway.dueOffset,
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function addCalendarDays(date: Date, days: number): Date {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

/**
 * Rupees to paise.
 *
 * Money is an integer count of the currency's minor unit everywhere (CLAUDE.md
 * section 3.4), so the conversion happens once, here, where a human-quoted
 * rate enters the database. `Math.round` keeps a fractional rupee like
 * 11440.99 from arriving as a float artefact.
 */
function toMinorUnits(majorUnits: number): number {
  return Math.round(majorUnits * 100);
}

/**
 * Plausible arrival/departure instants for a fixture.
 *
 * Only set where the status implies them: a CONFIRMED booking that has not
 * arrived has neither, and a CHECKED_IN guest has an arrival but no departure.
 * Writing them unconditionally would claim the front desk had processed
 * movements that never happened.
 *
 * The minutes are derived from the booking code so they are stable across
 * re-seeds — a random time would make the Day view shuffle on every run and
 * make it impossible to tell a layout change from new data.
 */
function checkInOutInstants(
  seed: ReservationSeed,
  today: Date,
): { checkedInAt?: Date; checkedOutAt?: Date } {
  const spread = [...seed.ref].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);

  const arrivalDay = addCalendarDays(today, seed.arrivalOffset);
  const departureDay = addCalendarDays(today, seed.departureOffset);

  // Arrivals land between 12:05 and 19:55, departures between 06:10 and 10:50 —
  // the shape of a real day rather than one spike at the desk time.
  const arrivalMinutes = 12 * 60 + (spread % 8) * 60 + (spread % 12) * 5;
  const departureMinutes = 6 * 60 + (spread % 5) * 60 + (spread % 10) * 5;

  const checkedInAt = new Date(arrivalDay.getTime() + arrivalMinutes * 60_000);
  const checkedOutAt = new Date(departureDay.getTime() + departureMinutes * 60_000);

  switch (seed.status) {
    case ReservationStatus.CHECKED_IN:
      return { checkedInAt };
    case ReservationStatus.CHECKED_OUT:
      return { checkedInAt, checkedOutAt };
    default:
      // CONFIRMED, ON_HOLD, CANCELLED and NO_SHOW never arrived.
      return {};
  }
}


/**
 * Completed stays stretching back two years.
 *
 * The performance dashboard plots twelve months and compares against last
 * year. Without history the chart is eleven empty months and one spike, and
 * every year-on-year figure is null — which is honest but impossible to review.
 *
 * Volume rises gently toward the present and peaks in the Indian high season
 * (October to February), so the monthly trajectory has a shape rather than
 * noise. Every one is CHECKED_OUT: these are the past.
 */
/**
 * Channel mix for generated history, as a weighted draw.
 *
 * Twenty slots rather than a uniform rotation over the eight buckets: a real
 * Indian hotel is not one-eighth walk-in and one-eighth Expedia. MakeMyTrip and
 * Booking.com dominate, Agoda is solid, the direct website is a meaningful
 * slice, and Cleartrip is thin. `PHONE` and `CORPORATE` are in the draw so the
 * `OTHERS` bucket is populated by things that genuinely belong there — which is
 * also what proves the storage-to-bucket mapping is being applied rather than
 * the report reading the stored value straight through.
 */
const HISTORY_CHANNELS: readonly BookingSource[] = [
  BookingSource.MAKEMYTRIP,
  BookingSource.MAKEMYTRIP,
  BookingSource.MAKEMYTRIP,
  BookingSource.MAKEMYTRIP,
  BookingSource.MAKEMYTRIP,
  BookingSource.BOOKING_COM,
  BookingSource.BOOKING_COM,
  BookingSource.BOOKING_COM,
  BookingSource.BOOKING_COM,
  BookingSource.AGODA,
  BookingSource.AGODA,
  BookingSource.AGODA,
  BookingSource.DIRECT_WEB,
  BookingSource.DIRECT_WEB,
  BookingSource.WALK_IN,
  BookingSource.WALK_IN,
  BookingSource.EXPEDIA,
  BookingSource.CLEARTRIP,
  BookingSource.PHONE,
  BookingSource.CORPORATE,
];

function historicalStays(
  propertyIndex: number,
  multiplier: number,
  roomTypeCodes: readonly string[],
): ReservationSeed[] {
  const rows: ReservationSeed[] = [];

  for (let monthsAgo = 1; monthsAgo <= HISTORY_MONTHS; monthsAgo += 1) {
    // Deterministic from the property and the month, so re-seeding produces
    // identical history. A random count would make every chart redraw.
    const seedValue = propertyIndex * 31 + monthsAgo * 17;
    const monthIndex = (12 + ((new Date().getUTCMonth() - monthsAgo) % 12)) % 12;
    const highSeason = monthIndex >= 9 || monthIndex <= 1;
    const count = (highSeason ? 4 : 2) + (seedValue % 2);

    for (let n = 0; n < count; n += 1) {
      const guest = GUESTS[(seedValue + n * 5) % GUESTS.length];
      if (guest === undefined) throw new Error('Guest fixture list is empty.');

      const code = roomTypeCodes[(seedValue + n) % roomTypeCodes.length];
      if (code === undefined) throw new Error('Room type list is empty.');

      // Spread through the month, 2 to 4 nights each.
      const dayInMonth = 2 + ((seedValue + n * 7) % 24);
      const nights = 2 + ((seedValue + n) % 3);
      const arrivalOffset = -(monthsAgo * 30) + dayInMonth - 15;

      const nightly = 2600 + ((seedValue + n * 11) % 9) * 400;

      rows.push({
        ref: `H${String(monthsAgo).padStart(2, '0')}${String(n)}`,
        guestFirst: guest.first,
        guestLast: guest.last,
        phone: guest.phone,
        email: `${guest.first.toLowerCase()}.${guest.last.toLowerCase()}@example.com`,
        roomTypeCode: code,
        arrivalOffset,
        departureOffset: arrivalOffset + nights,
        status: ReservationStatus.CHECKED_OUT,
        mealPlan: [MealPlan.EP, MealPlan.CP, MealPlan.MAP, MealPlan.AP][(seedValue + n) % 4] ?? MealPlan.EP,
        adults: 1 + ((seedValue + n) % 2),
        children: (seedValue + n) % 3 === 0 ? 1 : 0,
        totalRupees: Math.round((nightly * nights * multiplier) / 100) * 100,
        paidRupees: Math.round((nightly * nights * multiplier) / 100) * 100,
        magicLink: false,
        bookedDaysAgo: Math.abs(arrivalOffset) + 20,
        // Deterministic, like every other field here, so re-seeding reproduces
        // the same distribution and the chart does not redraw differently.
        source:
          HISTORY_CHANNELS[(seedValue + n * 3) % HISTORY_CHANNELS.length] ??
          BookingSource.DIRECT_WEB,
      });
    }
  }

  return rows;
}

/**
 * Recomputes `inventory_day.sold` from the committed bookings.
 *
 * ===========================================================================
 * One statement, run once, after every property is seeded.
 *
 * The real booking path increments this counter inside the same transaction as
 * the reservation, and the oversell CHECK is what makes that safe under
 * concurrency. A seed has no concurrency and ~900 stays across two years, so
 * incrementing per night was thousands of round trips.
 *
 * Deriving is also strictly more trustworthy than incrementing: this is the
 * same aggregate used to audit consistency, so the counters and the bookings
 * cannot disagree by construction. The CHECK still rejects the result if any
 * row would oversell — which is the point of it living in the database.
 *
 * Raw SQL because a correlated aggregate UPDATE is one of the cases Prisma
 * cannot express (CLAUDE.md section 2). Nothing is interpolated: the whole
 * statement is static, so there is no injection surface.
 * ===========================================================================
 */
async function deriveSoldFromReservations(): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "inventory_day" AS i
    SET "sold" = COALESCE(e.n, 0)
    FROM (
      SELECT
        i2."id",
        (
          SELECT count(*)
          FROM "reservation_room" rr
          JOIN "reservation" res ON res."id" = rr."reservationId"
          WHERE rr."propertyId" = i2."propertyId"
            AND rr."roomTypeId" = i2."roomTypeId"
            AND res."status" IN ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT')
            AND rr."arrivalDate" <= i2."stayDate"
            AND rr."departureDate" > i2."stayDate"
        ) AS n
      FROM "inventory_day" i2
    ) AS e
    WHERE i."id" = e."id" AND i."sold" <> COALESCE(e.n, 0)
  `;
}

/**
 * Assigns a physical room to each stay without ever double-booking one.
 *
 * ===========================================================================
 * This exists because the database will not let the seed cheat. The
 * `reservation_room_no_overlap` exclusion constraint rejects two overlapping
 * stays in the same room, so a fixture generator that hands out room numbers
 * carelessly fails the whole seed — correctly.
 *
 * Greedy first-fit over the rooms of the requested type, tracking the half-open
 * ranges already taken per room. The overlap test is `startA < endB &&
 * startB < endA`: strict on both sides, so a stay arriving the morning another
 * departs is *not* a conflict, matching the `'[)'` range in the constraint.
 *
 * Returns null when every room of that type is busy, which the caller leaves
 * unassigned rather than forcing — the same thing a front desk would do.
 * ===========================================================================
 */
function allocateRoom(
  taken: Map<string, { from: number; to: number }[]>,
  candidateRoomIds: readonly string[],
  arrivalOffset: number,
  departureOffset: number,
): string | null {
  for (const roomId of candidateRoomIds) {
    const ranges = taken.get(roomId) ?? [];
    const conflicts = ranges.some(
      (range) => arrivalOffset < range.to && range.from < departureOffset,
    );
    if (conflicts) continue;

    ranges.push({ from: arrivalOffset, to: departureOffset });
    taken.set(roomId, ranges);
    return roomId;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Furnishing one property                                                   */
/* -------------------------------------------------------------------------- */

interface FurnishResult {
  roomTypes: number;
  rooms: number;
  inventoryDays: number;
  reservations: number;
  unassigned: number;
}

async function furnishProperty(
  propertyId: string,
  propertyCode: string,
  plan: PropertyPlan,
  pinnedRooms: Record<string, string>,
): Promise<FurnishResult> {
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: propertyId },
    select: { timezone: true, currency: true },
  });

  // The property's own calendar date, from its timezone — never the seeding
  // machine's local date (CLAUDE.md section 3.3), so a run from a laptop in
  // another zone produces the same rows.
  const today = businessDateFor(property.timezone);

  // 1 January of last year, so year-on-year comparisons have a denominator.
  const inventoryStart = new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1));
  const inventoryEnd = addCalendarDays(today, INVENTORY_DAYS_FORWARD);

  /* -- Reservations are rebuilt, so clear them first --------------------- */

  // `sold` is reset and re-derived below. Incrementing on top of whatever was
  // there would double-count on a second run; leaving stale counts would leave
  // inventory disagreeing with the bookings that justify it.
  await prisma.reservation.deleteMany({ where: { propertyId } });

  /* -- Room types and rooms ---------------------------------------------- */

  const roomTypeIds = new Map<string, string>();
  const roomIdsByType = new Map<string, string[]>();
  const roomIdByNumber = new Map<string, string>();
  const outOfOrder = new Set<string>();
  let roomCount = 0;

  for (const seed of plan.roomTypes) {
    const roomType = await prisma.roomType.upsert({
      where: { room_type_unique_code_per_property: { propertyId, code: seed.code } },
      update: {
        name: seed.name,
        description: seed.description,
        maxGuests: seed.maxGuests,
        baseRateMinor: toMinorUnits(seed.baseRateRupees),
        currency: property.currency,
        sortOrder: seed.sortOrder,
      },
      create: {
        propertyId,
        code: seed.code,
        name: seed.name,
        description: seed.description,
        maxGuests: seed.maxGuests,
        maxAdults: seed.maxGuests,
        baseRateMinor: toMinorUnits(seed.baseRateRupees),
        currency: property.currency,
        sortOrder: seed.sortOrder,
      },
      select: { id: true },
    });
    roomTypeIds.set(seed.code, roomType.id);

    const ids: string[] = [];
    for (const [index, number] of seed.numbers.entries()) {
      // A spread of housekeeping states, so the status pills are all
      // reachable. The last room of the largest category is out of order,
      // which also exercises its exclusion from sellable stock.
      const isLast = index === seed.numbers.length - 1;
      const status =
        isLast && seed.numbers.length >= 8
          ? RoomStatus.OUT_OF_ORDER
          : index % 7 === 3
            ? RoomStatus.VACANT_DIRTY
            : index % 11 === 5
              ? RoomStatus.INSPECTED
              : index % 13 === 9
                ? RoomStatus.OUT_OF_SERVICE
                : RoomStatus.VACANT_CLEAN;

      const room = await prisma.room.upsert({
        where: { room_unique_number_per_property: { propertyId, number } },
        update: { roomTypeId: roomType.id, status },
        create: {
          propertyId,
          roomTypeId: roomType.id,
          number,
          floor: /^\d/.test(number) ? (number.match(/^\d+/)?.[0]?.slice(0, -2) ?? '1') || '1' : null,
          status,
        },
        select: { id: true },
      });

      roomIdByNumber.set(number, room.id);
      if (status === RoomStatus.OUT_OF_ORDER) {
        outOfOrder.add(room.id);
      } else {
        // Out-of-order rooms are not sellable stock, so they are excluded from
        // the allocation pool and from `physical` below.
        ids.push(room.id);
      }
      roomCount += 1;
    }
    roomIdsByType.set(seed.code, ids);
  }

  // Prune anything dropped from the plan. The seed is authoritative for the
  // physical layout, and an earlier fixture set once left orphan rooms that
  // silently broke the dashboard's room totals.
  const keptCodes = plan.roomTypes.map((type) => type.code);
  const keptNumbers = plan.roomTypes.flatMap((type) => [...type.numbers]);
  await prisma.room.deleteMany({ where: { propertyId, number: { notIn: keptNumbers } } });
  await prisma.roomType.deleteMany({ where: { propertyId, code: { notIn: keptCodes } } });

  /* -- Inventory ---------------------------------------------------------- */

  // Rebuilt wholesale rather than upserted row by row: ~375 rows per property
  // is far quicker as one delete plus one createMany, and the seed owns these
  // rows completely so there is nothing to preserve.
  await prisma.inventoryDay.deleteMany({ where: { propertyId } });

  const inventoryRows: {
    propertyId: string;
    roomTypeId: string;
    stayDate: Date;
    physical: number;
    sold: number;
    blocked: number;
    overbookingAllowance: number;
  }[] = [];

  for (const seed of plan.roomTypes) {
    const roomTypeId = roomTypeIds.get(seed.code);
    if (roomTypeId === undefined) throw new Error(`Room type ${seed.code} was not seeded.`);
    // Sellable stock excludes out-of-order rooms, keeping `physical` in step
    // with the room table rather than with the plan's raw count.
    const physical = (roomIdsByType.get(seed.code) ?? []).length;

    for (
      let cursor = inventoryStart.getTime();
      cursor <= inventoryEnd.getTime();
      cursor += 86_400_000
    ) {
      inventoryRows.push({
        propertyId,
        roomTypeId,
        stayDate: new Date(cursor),
        physical,
        // Left at zero and derived from the bookings once every property is
        // seeded — see `deriveSoldFromReservations`.
        sold: 0,
        blocked: 0,
        overbookingAllowance: 0,
      });
    }
  }

  await prisma.inventoryDay.createMany({ data: inventoryRows });

  /* -- Reservations ------------------------------------------------------- */

  const taken = new Map<string, { from: number; to: number }[]>();
  const occupied = new Map<string, RoomStatus>();
  let created = 0;
  let unassignedCount = 0;
  let outOfWindow = 0;

  // Only seed stays that sit entirely inside the inventory window.
  //
  // A booking outside it has no `inventory_day` rows to be counted against, so
  // `sold` can never reflect it and the counters disagree with the bookings
  // forever. The first version of the history generator reached back to
  // 2024-12-13 while inventory began 2025-01-01, and the audit found exactly
  // 122 room-nights with no row to live in.
  //
  // Clamping here makes the invariant structural: every seeded booking is
  // backed by capacity, by construction rather than by the two ranges
  // happening to line up.
  const inWindow = plan.reservations.filter((seed) => {
    const arrival = addCalendarDays(today, seed.arrivalOffset).getTime();
    const departure = addCalendarDays(today, seed.departureOffset).getTime();
    const fits =
      arrival >= inventoryStart.getTime() && departure <= inventoryEnd.getTime() + 86_400_000;
    if (!fits) outOfWindow += 1;
    return fits;
  });

  for (const seed of inWindow) {
    const roomTypeId = roomTypeIds.get(seed.roomTypeCode);
    if (roomTypeId === undefined) {
      throw new Error(`Reservation ${seed.ref} references unseeded type ${seed.roomTypeCode}.`);
    }

    // A pinned number wins, so the reference screen stays reproducible; the
    // pin is still registered with the allocator so nothing else takes it.
    const pinnedNumber = pinnedRooms[seed.ref];
    let roomId: string | null = null;

    if (seed.unassigned === true) {
      roomId = null;
    } else if (pinnedNumber !== undefined) {
      const pinnedId = roomIdByNumber.get(pinnedNumber);
      if (pinnedId === undefined) {
        throw new Error(`Reservation ${seed.ref} pins unseeded room ${pinnedNumber}.`);
      }
      roomId = allocateRoom(taken, [pinnedId], seed.arrivalOffset, seed.departureOffset);
      if (roomId === null) {
        // Loud: a pinned room that is already busy means the fixtures
        // contradict each other, which is worth failing on.
        throw new Error(
          `Reservation ${seed.ref} cannot take pinned room ${pinnedNumber}: already occupied.`,
        );
      }
    } else {
      roomId = allocateRoom(
        taken,
        roomIdsByType.get(seed.roomTypeCode) ?? [],
        seed.arrivalOffset,
        seed.departureOffset,
      );
    }

    if (roomId === null) unassignedCount += 1;

    const arrival = addCalendarDays(today, seed.arrivalOffset);
    const departure = addCalendarDays(today, seed.departureOffset);

    // -------------------------------------------------------------------
    // The reservation, its room assignment and the inventory it consumes
    // are written in ONE transaction, exactly as the real booking path does
    // (CLAUDE.md section 3.1). Seeding them separately would leave a window
    // where a room is occupied but still counted available — the state the
    // oversell CHECK exists to make impossible. The constraints are live, so
    // a mistake here fails the seed rather than producing wrong data.
    // -------------------------------------------------------------------
    await prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.create({
        data: {
          propertyId,
          confirmationCode: `SFBOOKING_${propertyCode}_${seed.ref}`,
          status: seed.status,
          source: seed.source ?? BookingSource.DIRECT_WEB,
          ...(seed.otaBookingId === undefined ? {} : { otaBookingId: seed.otaBookingId }),
          ...(seed.govtIdNumber === undefined ? {} : { govtIdNumber: seed.govtIdNumber }),
          arrivalDate: arrival,
          departureDate: departure,
          adults: seed.adults,
          children: seed.children,
          guestFirstName: seed.guestFirst,
          guestLastName: seed.guestLast,
          guestEmail: seed.email,
          guestPhone: seed.phone,
          mealPlan: seed.mealPlan,
          totalAmountMinor: toMinorUnits(seed.totalRupees),
          paidAmountMinor: toMinorUnits(seed.paidRupees),
          currency: property.currency,
          isMagicLinkActive: seed.magicLink,
          createdAt: addCalendarDays(today, -seed.bookedDaysAgo),
          // Real arrival and departure instants, so the hourly Day view of the
          // reservation calendar has something to position blocks against.
          // Spread across the afternoon and morning rather than all landing on
          // the property's standard desk time, which would make every block in
          // that view start at exactly the same minute and hide whether the
          // minute-level placement works at all.
          ...checkInOutInstants(seed, today),
        },
        select: { id: true },
      });

      await tx.reservationRoom.create({
        data: {
          propertyId,
          reservationId: reservation.id,
          roomTypeId,
          roomId,
          arrivalDate: arrival,
          departureDate: departure,
          status: seed.status,
        },
        select: { id: true },
      });

      // `sold` is NOT incremented here.
      //
      // The real booking path must increment it inside this transaction, and
      // the oversell CHECK is what makes that safe under concurrency. A seed
      // has no concurrency, and with ~900 stays across two years the
      // per-night increments were thousands of round trips. So the counters
      // are instead *derived* from the committed bookings once, in one
      // statement, after every property is seeded.
      //
      // That is strictly more trustworthy than incrementing: the derivation is
      // the same query used to audit consistency, so by construction the two
      // cannot disagree. The CHECK still rejects the result if it would
      // oversell.
    });

    created += 1;

    // In-house guests make their room occupied. A couple are left dirty, so
    // the housekeeping states on the board are not uniform.
    if (seed.status === ReservationStatus.CHECKED_IN && roomId !== null) {
      occupied.set(
        roomId,
        created % 3 === 0 ? RoomStatus.OCCUPIED_DIRTY : RoomStatus.OCCUPIED_CLEAN,
      );
    }
  }

  // Applied after every reservation, so a room freed since the last run does
  // not stay marked occupied.
  for (const [roomId, status] of occupied) {
    await prisma.room.update({ where: { id: roomId }, data: { status }, select: { id: true } });
  }

  /* -- Payment gateway ---------------------------------------------------- */

  await prisma.paymentGatewayConfig.upsert({
    where: {
      gateway_unique_provider_per_property: {
        propertyId,
        provider: PaymentGatewayProvider.RAZORPAY,
      },
    },
    update: {
      status: plan.gateway,
      onboardingDueDate: addCalendarDays(today, plan.gatewayDueOffset),
      ...(plan.gateway === PaymentGatewayStatus.ACTIVE
        ? { activatedAt: addCalendarDays(today, plan.gatewayDueOffset) }
        : { activatedAt: null }),
    },
    create: {
      propertyId,
      provider: PaymentGatewayProvider.RAZORPAY,
      status: plan.gateway,
      merchantId: `acc_${propertyCode}${String(Math.abs(plan.gatewayDueOffset)).padStart(3, '0')}`,
      onboardingDueDate: addCalendarDays(today, plan.gatewayDueOffset),
      ...(plan.gateway === PaymentGatewayStatus.ACTIVE
        ? { activatedAt: addCalendarDays(today, plan.gatewayDueOffset) }
        : {}),
    },
    select: { id: true },
  });

  if (outOfWindow > 0) {
    console.log(
      `    (${String(outOfWindow)} stay(s) skipped: outside the seeded inventory window)`,
    );
  }

  return {
    roomTypes: plan.roomTypes.length,
    rooms: roomCount,
    inventoryDays: inventoryRows.length,
    reservations: created,
    unassigned: unassignedCount,
  };
}

/* -------------------------------------------------------------------------- */
/*  Orchestration                                                             */
/* -------------------------------------------------------------------------- */

async function seedOperations(
  propertyIds: Map<string, string>,
  roleIds: Map<RoleKeyType, string>,
): Promise<void> {
  /* -- The Shubh general manager ----------------------------------------- */

  const shubhId = propertyIds.get(SHUBH_SLUG);
  if (shubhId === undefined) throw new Error(`Expected ${SHUBH_SLUG} to be seeded.`);

  // The reference screen shows a 12:00 PM arrival and a 10:00 AM departure,
  // which are this property's own desk times rather than the portfolio
  // default.
  await prisma.property.update({
    where: { id: shubhId },
    data: { checkInTime: '12:00', checkOutTime: '10:00' },
    select: { id: true },
  });

  const gmPasswordHash = await hash(SHUBH_GM_PASSWORD, 12);
  const gm = await prisma.user.upsert({
    where: { email: SHUBH_GM_EMAIL },
    update: {
      passwordHash: gmPasswordHash,
      firstName: 'General',
      lastName: 'Manager',
      isActive: true,
      isTwoFactorEnabled: true,
    },
    create: {
      email: SHUBH_GM_EMAIL,
      passwordHash: gmPasswordHash,
      firstName: 'General',
      lastName: 'Manager',
      isTwoFactorEnabled: true,
    },
    select: { id: true },
  });

  const propertyAdminRoleId = roleIds.get('PROPERTY_ADMIN');
  if (propertyAdminRoleId === undefined) throw new Error('PROPERTY_ADMIN was not seeded.');

  const counters: GrantCounters = { users: 0, grants: 0 };
  await grant(gm.id, shubhId, propertyAdminRoleId, counters);

  /* -- Furnish every property -------------------------------------------- */

  const properties = await prisma.property.findMany({
    select: { id: true, code: true, slug: true, name: true },
    orderBy: { code: 'asc' },
  });

  const totals = { roomTypes: 0, rooms: 0, inventoryDays: 0, reservations: 0, unassigned: 0 };

  for (const [index, property] of properties.entries()) {
    const isShubh = property.slug === SHUBH_SLUG;
    const plan = isShubh ? shubhPlan() : genericPlan(index);
    const pins = isShubh ? SHUBH_PINNED : {};

    const result = await furnishProperty(property.id, property.code, plan, pins);

    totals.roomTypes += result.roomTypes;
    totals.rooms += result.rooms;
    totals.inventoryDays += result.inventoryDays;
    totals.reservations += result.reservations;
    totals.unassigned += result.unassigned;

    console.log(
      `  ${property.code} ${property.name.padEnd(23)} ` +
        `${String(result.roomTypes).padStart(2)} types, ` +
        `${String(result.rooms).padStart(3)} rooms, ` +
        `${String(result.reservations).padStart(2)} bookings` +
        (result.unassigned > 0 ? ` (${String(result.unassigned)} unassigned)` : ''),
    );
  }

  // Derived once, from the committed bookings, rather than incremented per
  // night during seeding. See `deriveSoldFromReservations`.
  await deriveSoldFromReservations();

  console.log(
    `  totals: ${String(totals.roomTypes)} room types, ${String(totals.rooms)} rooms, ` +
      `${String(totals.inventoryDays)} inventory days, ` +
      `${String(totals.reservations)} reservations`,
  );
  console.log('  inventory sold counters derived from bookings in one statement');
  console.log(`  general manager: ${SHUBH_GM_EMAIL} (Property Admin, 2FA enabled)`);
}

async function main(): Promise<void> {
  console.log('Seeding EaseIt dev portfolio...');

  const permissionIds = await seedPermissions();
  const roleIds = await seedSystemRoles(permissionIds);
  const propertyIds = await seedProperties();

  const goaId = propertyIds.get('grand-marine-goa');
  if (goaId === undefined) throw new Error('Expected grand-marine-goa to be seeded.');
  const customRoleId = await seedCustomRole(goaId, permissionIds);

  await seedStaff(roleIds, propertyIds, customRoleId);
  await seedOperations(propertyIds, roleIds);

  console.log(`\nDone. Most dev accounts share the password: ${DEV_PASSWORD}`);
  console.log('Portfolio owner:    owner@easeit.example.com');
  console.log('Multi-role clerk:   dual.role@grand-marine-goa.example.com');
  console.log(`Furnished property: ${SHUBH_GM_EMAIL} / ${SHUBH_GM_PASSWORD}`);
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
