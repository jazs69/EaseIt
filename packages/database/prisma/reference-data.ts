/**
 * Reference data every EaseIt database needs, demo or production: the
 * permission catalog, the system role templates, the default GST slab table
 * and the core amenity list.
 *
 * Shared by `seed.ts` (the dev portfolio) and `provision.ts` (a real
 * installation), so the two cannot drift. Every write is keyed on a natural
 * key and converges when re-run.
 */

import {
  ALL_ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_DEFINITIONS,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  type Role as RoleKeyType,
} from '@repo/types';

import { PermissionCategory, RoleKey } from '../generated/client/index.js';
import type { createPrismaClient } from '../src/client-factory.js';

type PrismaClient = ReturnType<typeof createPrismaClient>;

/* -------------------------------------------------------------------------- */
/*  Permissions                                                               */
/* -------------------------------------------------------------------------- */

export async function seedPermissions(prisma: PrismaClient): Promise<Map<string, string>> {
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
export async function setRolePermissions(
  prisma: PrismaClient,
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
export async function seedSystemRoles(
  prisma: PrismaClient,
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
    await setRolePermissions(prisma, roleId, granted, permissionIds);
    ids.set(roleKey, roleId);

    console.log(`  role ${roleKey}: ${String(granted.length)} permissions`);
  }

  return ids;
}

/* -------------------------------------------------------------------------- */
/*  Tax slabs and amenities                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The GST slabs for room tariff.
 *
 * ===========================================================================
 * Real Indian bands, in integer minor units, as data rather than a constant.
 *
 * Replaces the single `property.taxRatePercent` the platform carried, which
 * forced every room in a hotel onto one rate. Room tariff is banded: the rate
 * depends on what the room costs per night. Seeded per property because the
 * bands are policy the operator confirms, not something the code should assert
 * on their behalf.
 *
 * The rates are the ones in force since 22 September 2025: exempt up to
 * ₹1,000 a night, 5% **without** input tax credit from ₹1,001 to ₹7,500, and
 * 18% with ITC above that. The middle band was 12% with ITC before that date,
 * and seeding 12% today under-collects nothing but over-charges the guest by
 * seven points — so the figure matters more than most seed data.
 *
 * The band is decided on the per-night transaction value. Note that published
 * guidance is not unanimous on whether the ₹7,500 test applies to the declared
 * tariff or the value actually billed; a property that discounts a ₹8,000 room
 * to ₹7,000 should confirm its own treatment before relying on this.
 *
 * The components are stored, not halved at read time: halving is right for an
 * intra-state supply and wrong for inter-state (IGST, not split at all), and
 * the `property_tax_slab_components_sum_to_rate` CHECK keeps the three numbers
 * an invoice prints from contradicting each other.
 * ===========================================================================
 */
export const TAX_SLABS: readonly {
  slabName: string;
  minTariffMinor: number;
  maxTariffMinor: number | null;
  taxRatePercent: string;
  cgstRatePercent: string;
  sgstRatePercent: string;
}[] = [
  {
    slabName: 'Budget tariff (nil-rated)',
    minTariffMinor: 0,
    maxTariffMinor: 100_000,
    taxRatePercent: '0.00',
    cgstRatePercent: '0.00',
    sgstRatePercent: '0.00',
  },
  {
    slabName: 'Standard tariff',
    minTariffMinor: 100_000,
    maxTariffMinor: 750_000,
    taxRatePercent: '5.00',
    cgstRatePercent: '2.50',
    sgstRatePercent: '2.50',
  },
  {
    slabName: 'Premium tariff',
    minTariffMinor: 750_000,
    maxTariffMinor: null,
    taxRatePercent: '18.00',
    cgstRatePercent: '9.00',
    sgstRatePercent: '9.00',
  },
];

/** Amenities every property in the portfolio offers. */
export const CORE_AMENITIES: readonly {
  slug: string;
  name: string;
  groupName: string;
  iconName: string;
}[] = [
  { slug: '24hr-power-backup', name: '24-hour power backup', groupName: 'Essentials', iconName: 'Zap' },
  { slug: '24hr-front-desk', name: '24-hour front desk', groupName: 'Services', iconName: 'ConciergeBell' },
  { slug: '24hr-security', name: '24-hour security', groupName: 'Safety & Security', iconName: 'ShieldCheck' },
  { slug: 'free-wifi', name: 'Free Wi-Fi', groupName: 'Essentials', iconName: 'Wifi' },
  { slug: 'air-conditioning', name: 'Air conditioning', groupName: 'Essentials', iconName: 'Snowflake' },
  { slug: 'parking', name: 'On-site parking', groupName: 'Essentials', iconName: 'CircleParking' },
  { slug: 'cctv', name: 'CCTV in common areas', groupName: 'Safety & Security', iconName: 'Cctv' },
  { slug: 'first-aid', name: 'First-aid kit', groupName: 'Safety & Security', iconName: 'BriefcaseMedical' },
  { slug: 'laundry', name: 'Laundry service', groupName: 'Services', iconName: 'Shirt' },
  { slug: 'airport-transfer', name: 'Airport transfer', groupName: 'Services', iconName: 'Car' },
];

/** The portfolio-wide amenity catalog (no propertyId, section 3.2). */
export async function seedAmenities(prisma: PrismaClient): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const amenity of CORE_AMENITIES) {
    const row = await prisma.amenity.upsert({
      where: { slug: amenity.slug },
      create: amenity,
      update: { name: amenity.name, groupName: amenity.groupName, iconName: amenity.iconName },
      select: { id: true },
    });
    ids.set(amenity.slug, row.id);
  }
  return ids;
}
