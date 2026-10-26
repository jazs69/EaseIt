/**
 * Reads and writes a property's configuration.
 *
 * ===========================================================================
 * Every write here changes the inputs to money arithmetic, so every write
 * leaves an audit row in the same transaction.
 *
 * This is not an ordinary CRUD surface. A tax slab decides what a guest is
 * charged; a check-out time decides which night a room is sellable; a booking
 * prefix appears on documents a guest keeps. CLAUDE.md section 3.4 requires
 * every mutation of money, rates or restrictions to write an `audit_log` row
 * (actor, property, entity, before/after, reason) in the same transaction as
 * the change — so that is what each method below does, rather than writing the
 * row afterwards where a crash would lose it.
 *
 * The `before` snapshot is read inside the transaction, not before it. Read
 * outside and a concurrent edit lands between the read and the write, leaving
 * an audit trail that records a change from a value that was never there.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';
import {
  Permission,
  permissionsForRoles,
  isRole,
  type AmenityLink,
  type CreatePropertyMedia,
  type FeeAndSurcharge,
  type PropertyMedia,
  type PropertyPolicy,
  type PropertySetup,
  type Role,
  type TaxSlab,
  type UpdatePropertySettings,
} from '@repo/types';

import {
  ForbiddenError,
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { validateSlabTable } from './tax-engine.js';

/** What the settings columns default to for a property with no row yet. */
const SETTINGS_DEFAULTS = {
  turnaroundGraceMins: 60,
  bookingPrefix: 'SFBOOKING_',
  folioPrefix: 'FOL_',
  invoicePrefix: 'INV_',
  autoHoldReleaseHours: 4,
  nightAuditHour: '02:00',
} as const;

@Injectable()
export class PropertySetupService {
  constructor(private readonly prisma: PrismaService) {}

  /* -------------------------------------------------------------------- */
  /*  Read                                                                */
  /* -------------------------------------------------------------------- */

  /**
   * Everything the settings screen shows, in one response.
   *
   * One round trip for five tabs. An operator who opens Taxes and moves to
   * Policies should not wait again, and five endpoints would be five chances
   * to disagree about which property is being configured.
   */
  async setup(userId: string, codeOrId: string): Promise<PropertySetup> {
    const property = await this.authorise(userId, codeOrId);

    const [settings, slabs, amenityLinks, policies, fees, media] = await Promise.all([
      this.prisma.client.propertySettings.findUnique({
        where: { propertyId: property.id },
        select: {
          standardCheckInTime: true,
          standardCheckOutTime: true,
          turnaroundGraceMins: true,
          bookingPrefix: true,
          folioPrefix: true,
          invoicePrefix: true,
          autoHoldReleaseHours: true,
          nightAuditHour: true,
        },
      }),
      this.prisma.client.propertyTaxSlab.findMany({
        where: { propertyId: property.id },
        orderBy: { minTariffMinor: 'asc' },
        select: {
          id: true,
          slabName: true,
          minTariffMinor: true,
          maxTariffMinor: true,
          taxRatePercent: true,
          cgstRatePercent: true,
          sgstRatePercent: true,
        },
      }),
      this.prisma.client.propertyAmenityLink.findMany({
        where: { propertyId: property.id },
        orderBy: [{ amenity: { groupName: 'asc' } }, { amenity: { name: 'asc' } }],
        select: {
          amenityId: true,
          scope: true,
          priceMinor: true,
          pricingUnit: true,
          amenity: {
            select: { slug: true, name: true, groupName: true, iconName: true },
          },
        },
      }),
      this.prisma.client.propertyPolicy.findMany({
        where: { propertyId: property.id },
        orderBy: { type: 'asc' },
        select: {
          id: true,
          type: true,
          title: true,
          content: true,
          isMandatory: true,
          freeCancellationHours: true,
          retentionChargePercent: true,
        },
      }),
      this.prisma.client.feeAndSurcharge.findMany({
        where: { propertyId: property.id },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          type: true,
          amountMinor: true,
          ratePercent: true,
          isTaxable: true,
          applyToGroup: true,
        },
      }),
      this.prisma.client.propertyMedia.findMany({
        where: { propertyId: property.id },
        orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
        select: {
          id: true,
          category: true,
          url: true,
          caption: true,
          sortOrder: true,
          isFeatured: true,
          roomTypeId: true,
        },
      }),
    ]);

    return {
      propertyId: property.id,
      name: property.name,
      code: property.code,
      timezone: property.timezone,
      currency: property.currency,
      businessDate: property.businessDate.toISOString().slice(0, 10),

      /**
       * Defaults where no row exists yet, rather than a null settings object.
       *
       * The screen's job is to show what the property is operating on, and a
       * property with no settings row is operating on the column defaults —
       * which are these. Returning null would make every field on five tabs
       * optional for one transitional case.
       */
      settings: {
        standardCheckInTime: settings?.standardCheckInTime ?? property.checkInTime,
        standardCheckOutTime: settings?.standardCheckOutTime ?? property.checkOutTime,
        turnaroundGraceMins:
          settings?.turnaroundGraceMins ?? SETTINGS_DEFAULTS.turnaroundGraceMins,
        bookingPrefix: settings?.bookingPrefix ?? SETTINGS_DEFAULTS.bookingPrefix,
        folioPrefix: settings?.folioPrefix ?? SETTINGS_DEFAULTS.folioPrefix,
        invoicePrefix: settings?.invoicePrefix ?? SETTINGS_DEFAULTS.invoicePrefix,
        autoHoldReleaseHours:
          settings?.autoHoldReleaseHours ?? SETTINGS_DEFAULTS.autoHoldReleaseHours,
        nightAuditHour: settings?.nightAuditHour ?? SETTINGS_DEFAULTS.nightAuditHour,
      },

      taxSlabs: slabs.map(
        (slab): TaxSlab => ({
          id: slab.id,
          slabName: slab.slabName,
          minTariffMinor: slab.minTariffMinor,
          maxTariffMinor: slab.maxTariffMinor,
          // Decimal to number at the boundary. Rates, not money (section 3.4).
          taxRatePercent: Number(slab.taxRatePercent),
          cgstRatePercent: Number(slab.cgstRatePercent),
          sgstRatePercent: Number(slab.sgstRatePercent),
        }),
      ),

      amenities: amenityLinks.map(
        (link): AmenityLink => ({
          amenityId: link.amenityId,
          slug: link.amenity.slug,
          name: link.amenity.name,
          groupName: link.amenity.groupName,
          iconName: link.amenity.iconName,
          scope: link.scope,
          priceMinor: link.priceMinor,
          pricingUnit: link.pricingUnit,
        }),
      ),

      policies: policies.map(
        (policy): PropertyPolicy => ({
          id: policy.id,
          type: policy.type,
          title: policy.title,
          content: policy.content,
          isMandatory: policy.isMandatory,
          freeCancellationHours: policy.freeCancellationHours,
          retentionChargePercent:
            policy.retentionChargePercent === null
              ? null
              : Number(policy.retentionChargePercent),
        }),
      ),

      fees: fees.map((fee) => ({
        id: fee.id,
        name: fee.name,
        type: fee.type,
        amountMinor: fee.amountMinor,
        ratePercent: fee.ratePercent === null ? null : Number(fee.ratePercent),
        isTaxable: fee.isTaxable,
        applyToGroup: fee.applyToGroup,
      })),

      media: media.map((row): PropertyMedia => ({ ...row })),
    };
  }

  /* -------------------------------------------------------------------- */
  /*  Writes                                                              */
  /* -------------------------------------------------------------------- */

  /**
   * Updates the operational settings, auditing what changed.
   *
   * Upserts, because a property may have no settings row yet and the screen
   * should not require one to exist before it can be edited. The `create`
   * branch fills unsupplied fields from the property and the column defaults —
   * the same values `setup()` reports — so saving one tab cannot silently
   * reset the others to something the operator never saw.
   */
  async updateSettings(
    userId: string,
    codeOrId: string,
    patch: UpdatePropertySettings,
    reason: string | null = null,
  ): Promise<PropertySetup> {
    const property = await this.authorise(userId, codeOrId);

    if (Object.keys(patch).length === 0) {
      // An empty patch is not an error, but it must not write an audit row
      // claiming a change. Returning the current state is the honest answer.
      return this.setup(userId, codeOrId);
    }

    /**
     * The patch with its absent fields removed.
     *
     * `exactOptionalPropertyTypes` makes `{ a: undefined }` and `{}` different
     * types, and Prisma's update input accepts only the second — writing the
     * first would set every untouched column to undefined. Spreading field by
     * field keeps the write exactly as wide as the request was.
     */
    const changes = {
      ...(patch.standardCheckInTime !== undefined
        ? { standardCheckInTime: patch.standardCheckInTime }
        : {}),
      ...(patch.standardCheckOutTime !== undefined
        ? { standardCheckOutTime: patch.standardCheckOutTime }
        : {}),
      ...(patch.turnaroundGraceMins !== undefined
        ? { turnaroundGraceMins: patch.turnaroundGraceMins }
        : {}),
      ...(patch.bookingPrefix !== undefined ? { bookingPrefix: patch.bookingPrefix } : {}),
      ...(patch.folioPrefix !== undefined ? { folioPrefix: patch.folioPrefix } : {}),
      ...(patch.invoicePrefix !== undefined ? { invoicePrefix: patch.invoicePrefix } : {}),
      ...(patch.autoHoldReleaseHours !== undefined
        ? { autoHoldReleaseHours: patch.autoHoldReleaseHours }
        : {}),
      ...(patch.nightAuditHour !== undefined ? { nightAuditHour: patch.nightAuditHour } : {}),
    };

    await this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_property_id', ${property.id}, true)`;

      const before = await tx.propertySettings.findUnique({
        where: { propertyId: property.id },
        select: {
          standardCheckInTime: true,
          standardCheckOutTime: true,
          turnaroundGraceMins: true,
          bookingPrefix: true,
          folioPrefix: true,
          invoicePrefix: true,
          autoHoldReleaseHours: true,
          nightAuditHour: true,
        },
      });

      const row = await tx.propertySettings.upsert({
        where: { propertyId: property.id },
        create: {
          propertyId: property.id,
          standardCheckInTime: patch.standardCheckInTime ?? property.checkInTime,
          standardCheckOutTime: patch.standardCheckOutTime ?? property.checkOutTime,
          ...SETTINGS_DEFAULTS,
          ...changes,
        },
        update: changes,
        select: {
          id: true,
          standardCheckInTime: true,
          standardCheckOutTime: true,
          turnaroundGraceMins: true,
          bookingPrefix: true,
          folioPrefix: true,
          invoicePrefix: true,
          autoHoldReleaseHours: true,
          nightAuditHour: true,
        },
      });

      const { id, ...after } = row;

      await tx.auditLog.create({
        data: {
          propertyId: property.id,
          actorUserId: userId,
          event: 'PROPERTY_SETTINGS_UPDATED',
          entityType: 'property_settings',
          entityId: id,
          // Only the fields the request actually touched, so the trail reads
          // as what was changed rather than the whole row every time.
          // `Prisma.JsonNull` writes a JSON null — a bare null would be read
          // as "leave the column alone" rather than "there was nothing here".
          before:
            before === null
              ? Prisma.JsonNull
              : pick(before, Object.keys(changes)),
          after: pick(after, Object.keys(changes)),
          reason,
        },
      });
    });

    return this.setup(userId, codeOrId);
  }

  /**
   * Replaces the whole GST slab table.
   *
   * ===========================================================================
   * Validated as a set, swapped in one transaction.
   *
   * A slab table is only meaningful whole: a floor at 0, no gaps, no overlaps,
   * one open-ended top band. `validateSlabTable` checks exactly the properties
   * no single-row CHECK constraint can see, and it runs before anything is
   * deleted — so a rejected table leaves the live one untouched rather than
   * half-replaced.
   *
   * Delete-then-insert rather than a diff. The rows carry no meaning beyond
   * the band they describe, nothing references them by id, and a diff would
   * have to pass through intermediate states that are individually plausible
   * and collectively invalid. One transaction means no quote ever sees one.
   * ===========================================================================
   */
  async replaceTaxSlabs(
    userId: string,
    codeOrId: string,
    slabs: readonly TaxSlab[],
    reason: string | null = null,
  ): Promise<PropertySetup> {
    const property = await this.authorise(userId, codeOrId);

    const problems = validateSlabTable(slabs);
    if (problems.length > 0) {
      throw new ValidationFailedError(
        Object.fromEntries(problems.map((problem, index) => [`slabs.${String(index)}`, problem])),
      );
    }

    await this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_property_id', ${property.id}, true)`;

      const before = await tx.propertyTaxSlab.findMany({
        where: { propertyId: property.id },
        orderBy: { minTariffMinor: 'asc' },
        select: {
          slabName: true,
          minTariffMinor: true,
          maxTariffMinor: true,
          taxRatePercent: true,
          cgstRatePercent: true,
          sgstRatePercent: true,
        },
      });

      await tx.propertyTaxSlab.deleteMany({ where: { propertyId: property.id } });
      await tx.propertyTaxSlab.createMany({
        data: slabs.map((slab) => ({
          propertyId: property.id,
          slabName: slab.slabName,
          minTariffMinor: slab.minTariffMinor,
          maxTariffMinor: slab.maxTariffMinor,
          taxRatePercent: slab.taxRatePercent,
          cgstRatePercent: slab.cgstRatePercent,
          sgstRatePercent: slab.sgstRatePercent,
        })),
      });

      await tx.auditLog.create({
        data: {
          propertyId: property.id,
          actorUserId: userId,
          event: 'PROPERTY_TAX_SLABS_REPLACED',
          entityType: 'property_tax_slab',
          // The property, because the change is to the table rather than to
          // any one row — and the rows that were there no longer exist.
          entityId: property.id,
          before: before.map((slab) => ({
            ...slab,
            taxRatePercent: Number(slab.taxRatePercent),
            cgstRatePercent: Number(slab.cgstRatePercent),
            sgstRatePercent: Number(slab.sgstRatePercent),
          })),
          after: slabs.map((slab) => ({ ...slab })),
          reason,
        },
      });
    });

    return this.setup(userId, codeOrId);
  }

  /**
   * Replaces which amenities the property offers, and at what price.
   *
   * The amenity catalogue is portfolio-wide and untouched — only the links
   * are. Each amenity is verified to exist before anything is written, so a
   * stale id from an old browser tab is a 400 naming the field rather than a
   * foreign-key 500.
   */
  async replaceAmenities(
    userId: string,
    codeOrId: string,
    links: readonly {
      amenityId: string;
      scope: 'FREE' | 'PAID';
      priceMinor: number;
      pricingUnit: string | null;
    }[],
    reason: string | null = null,
  ): Promise<PropertySetup> {
    const property = await this.authorise(userId, codeOrId);

    const ids = [...new Set(links.map((link) => link.amenityId))];
    if (ids.length !== links.length) {
      throw new ValidationFailedError({
        amenities: 'The same amenity appears more than once.',
      });
    }

    const known = await this.prisma.client.amenity.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    if (known.length !== ids.length) {
      throw new ValidationFailedError({ amenities: 'An amenity in the list does not exist.' });
    }

    await this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_property_id', ${property.id}, true)`;

      const before = await tx.propertyAmenityLink.findMany({
        where: { propertyId: property.id },
        orderBy: { amenityId: 'asc' },
        select: { amenityId: true, scope: true, priceMinor: true, pricingUnit: true },
      });

      await tx.propertyAmenityLink.deleteMany({ where: { propertyId: property.id } });
      if (links.length > 0) {
        await tx.propertyAmenityLink.createMany({
          data: links.map((link) => ({ propertyId: property.id, ...link })),
        });
      }

      await tx.auditLog.create({
        data: {
          propertyId: property.id,
          actorUserId: userId,
          event: 'PROPERTY_AMENITIES_REPLACED',
          entityType: 'property_amenity_link',
          entityId: property.id,
          before: before.map((link) => ({ ...link })),
          after: links.map((link) => ({ ...link })),
          reason,
        },
      });
    });

    return this.setup(userId, codeOrId);
  }

  /**
   * Replaces the published policies.
   *
   * Replaced as a set rather than edited row by row: a policy carries no
   * natural key, so matching an edit to an existing row would mean matching on
   * the title — and renaming a policy would then create a second one beside
   * the original rather than changing it.
   */
  async replacePolicies(
    userId: string,
    codeOrId: string,
    policies: readonly {
      type: PropertyPolicy['type'];
      title: string;
      content: string;
      isMandatory: boolean;
      freeCancellationHours: number | null;
      retentionChargePercent: number | null;
    }[],
    reason: string | null = null,
  ): Promise<PropertySetup> {
    const property = await this.authorise(userId, codeOrId);

    await this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_property_id', ${property.id}, true)`;

      const before = await tx.propertyPolicy.findMany({
        where: { propertyId: property.id },
        orderBy: { type: 'asc' },
        select: {
          type: true,
          title: true,
          content: true,
          isMandatory: true,
          freeCancellationHours: true,
          retentionChargePercent: true,
        },
      });

      await tx.propertyPolicy.deleteMany({ where: { propertyId: property.id } });
      if (policies.length > 0) {
        await tx.propertyPolicy.createMany({
          data: policies.map((policy) => ({ propertyId: property.id, ...policy })),
        });
      }

      await tx.auditLog.create({
        data: {
          propertyId: property.id,
          actorUserId: userId,
          event: 'PROPERTY_POLICIES_REPLACED',
          entityType: 'property_policy',
          entityId: property.id,
          before: before.map((policy) => ({
            ...policy,
            retentionChargePercent:
              policy.retentionChargePercent === null
                ? null
                : Number(policy.retentionChargePercent),
          })),
          after: policies.map((policy) => ({ ...policy })),
          reason,
        },
      });
    });

    return this.setup(userId, codeOrId);
  }

  /**
   * Replaces the fees and surcharges.
   *
   * Nothing bills these yet — no charge path reads `fee_and_surcharge`, and
   * the screen says so. Configuring them is still worth having: the operator
   * records what the property charges, and the module that posts them later
   * finds the policy already set rather than asking for it again.
   */
  async replaceFees(
    userId: string,
    codeOrId: string,
    fees: readonly {
      name: string;
      type: FeeAndSurcharge['type'];
      amountMinor: number;
      ratePercent: number | null;
      isTaxable: boolean;
      applyToGroup: boolean;
    }[],
    reason: string | null = null,
  ): Promise<PropertySetup> {
    const property = await this.authorise(userId, codeOrId);

    await this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_property_id', ${property.id}, true)`;

      const before = await tx.feeAndSurcharge.findMany({
        where: { propertyId: property.id },
        orderBy: { name: 'asc' },
        select: {
          name: true,
          type: true,
          amountMinor: true,
          ratePercent: true,
          isTaxable: true,
          applyToGroup: true,
        },
      });

      await tx.feeAndSurcharge.deleteMany({ where: { propertyId: property.id } });
      if (fees.length > 0) {
        await tx.feeAndSurcharge.createMany({
          data: fees.map((fee) => ({ propertyId: property.id, ...fee })),
        });
      }

      await tx.auditLog.create({
        data: {
          propertyId: property.id,
          actorUserId: userId,
          event: 'PROPERTY_FEES_REPLACED',
          entityType: 'fee_and_surcharge',
          entityId: property.id,
          before: before.map((fee) => ({
            ...fee,
            ratePercent: fee.ratePercent === null ? null : Number(fee.ratePercent),
          })),
          after: fees.map((fee) => ({ ...fee })),
          reason,
        },
      });
    });

    return this.setup(userId, codeOrId);
  }

  /**
   * Records a photograph against the property.
   *
   * Takes a URL, not file bytes — see `createPropertyMediaSchema`. The room
   * type, where one is given, is verified to belong to this property before
   * the insert: `property_media_same_property_as_room_type` would reject it
   * anyway, but a 400 naming the field beats a 500 from a composite foreign
   * key (section 3.2).
   */
  async addMedia(
    userId: string,
    codeOrId: string,
    media: CreatePropertyMedia,
  ): Promise<PropertyMedia> {
    const property = await this.authorise(userId, codeOrId);

    if (media.roomTypeId !== null) {
      const roomType = await this.prisma.client.roomType.findFirst({
        where: { id: media.roomTypeId, propertyId: property.id },
        select: { id: true },
      });
      if (roomType === null) {
        throw new ValidationFailedError({
          roomTypeId: 'No such room category at this property.',
        });
      }
    }

    return this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_property_id', ${property.id}, true)`;

      const row = await tx.propertyMedia.create({
        data: { propertyId: property.id, ...media },
        select: {
          id: true,
          category: true,
          url: true,
          caption: true,
          sortOrder: true,
          isFeatured: true,
          roomTypeId: true,
        },
      });

      await tx.auditLog.create({
        data: {
          propertyId: property.id,
          actorUserId: userId,
          event: 'PROPERTY_MEDIA_ADDED',
          entityType: 'property_media',
          entityId: row.id,
          before: Prisma.JsonNull,
          after: { category: row.category, url: row.url, roomTypeId: row.roomTypeId },
          reason: null,
        },
      });

      return row;
    });
  }

  /* -------------------------------------------------------------------- */
  /*  Authorisation                                                       */
  /* -------------------------------------------------------------------- */

  /**
   * Resolves the property from the caller's own grants.
   *
   * The traversal starts at `UserPropertyRole`, so a property the caller holds
   * no role at is never selected rather than selected and filtered. A missing
   * grant is `TenantScopeViolationError`, which maps to 404 — a 403 would
   * confirm the property exists (section 3.2).
   *
   * Reading the configuration takes the same permission as writing it: these
   * are the inputs to every money calculation, not a public profile, and the
   * screen that reads them is the screen that edits them.
   */
  private async authorise(
    userId: string,
    codeOrId: string,
  ): Promise<{
    id: string;
    code: string;
    name: string;
    timezone: string;
    currency: string;
    businessDate: Date;
    checkInTime: string;
    checkOutTime: string;
  }> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      codeOrId,
    );

    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: { userId, property: isUuid ? { id: codeOrId } : { code: codeOrId } },
      select: {
        role: { select: { key: true } },
        property: {
          select: {
            id: true,
            code: true,
            name: true,
            timezone: true,
            currency: true,
            businessDate: true,
            checkInTime: true,
            checkOutTime: true,
          },
        },
      },
    });

    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');

    const roles = grants
      .map((grant) => grant.role.key)
      .filter((key): key is Role => key !== null && isRole(key));

    if (!permissionsForRoles(roles).includes(Permission.PROPERTY_SETTINGS)) {
      throw new ForbiddenError(Permission.PROPERTY_SETTINGS);
    }

    return first.property;
  }
}

/**
 * The named keys of an object, for an audit diff that shows only what moved.
 *
 * Typed to `InputJsonObject` rather than `Record<string, unknown>`: the audit
 * columns are `Json`, and `unknown` would let a Date or a Decimal through to
 * be serialised however the driver felt like. Every settings field is a string
 * or a number, which is exactly what JSON can carry losslessly.
 */
function pick(
  source: Record<string, string | number>,
  keys: readonly string[],
): Prisma.InputJsonObject {
  return Object.fromEntries(
    keys.filter((key) => key in source).map((key) => [key, source[key] ?? null]),
  );
}
