/**
 * Property configuration: tax slabs, settings, amenities, policies, fees.
 *
 * ===========================================================================
 * Tax policy is data, and this is its shape.
 *
 * The platform used to carry one `property.taxRatePercent`, which forced every
 * room in a hotel onto a single rate and made a rate change a code change.
 * Indian GST on room tariff is banded — the rate depends on what the room
 * costs per night — and the bands move when the GST Council says so. A banded
 * table, configured per property, is the only shape that survives that.
 *
 * `cgstRatePercent` and `sgstRatePercent` are carried alongside the total
 * rather than derived by halving it. Halving is right for an intra-state
 * supply and wrong for an inter-state one, which is IGST and is not split at
 * all. An invoice prints the components separately and the total beside them,
 * so the three numbers must come from one place and agree.
 *
 * Rates are plain numbers here and `Decimal(5,2)` in the database: they are
 * *rates*, which section 3.4 permits. Every amount — the band bounds, prices,
 * fees — is an integer in minor units like everything else.
 * ===========================================================================
 */

import { z } from 'zod';

/** A percentage, as a percentage: 18 means 18%, not 0.18. */
const ratePercentSchema = z.number().min(0).max(100);

/**
 * One tariff band and the rate inside it.
 *
 * The band is half-open — `[minTariffMinor, maxTariffMinor)` — so adjacent
 * slabs can share a boundary without both claiming the tariff that sits on it.
 * `maxTariffMinor: null` is the open-ended top band.
 */
export const taxSlabSchema = z
  .object({
    id: z.uuid().optional(),
    slabName: z.string().min(1).max(80),
    minTariffMinor: z.number().int().nonnegative(),
    maxTariffMinor: z.number().int().positive().nullable(),
    taxRatePercent: ratePercentSchema,
    cgstRatePercent: ratePercentSchema,
    sgstRatePercent: ratePercentSchema,
  })
  .refine(
    (slab) => slab.maxTariffMinor === null || slab.maxTariffMinor > slab.minTariffMinor,
    {
      // An upper bound at or below the lower one describes an empty band that
      // matches nothing, so a tariff landing in it would resolve to no slab.
      message: 'A slab ceiling must be above its floor.',
      path: ['maxTariffMinor'],
    },
  )
  .refine(
    (slab) =>
      Math.round((slab.cgstRatePercent + slab.sgstRatePercent) * 100) ===
      Math.round(slab.taxRatePercent * 100),
    {
      // Mirrors `property_tax_slab_components_sum_to_rate`. Rejected here as
      // well as there, because a 500 from a CHECK tells an operator nothing
      // about which field to fix.
      message: 'CGST and SGST must add up to the total rate.',
      path: ['taxRatePercent'],
    },
  );

export type TaxSlab = z.infer<typeof taxSlabSchema>;

/** The tax split for one charge, for an invoice to print. */
export const taxComponentsSchema = z.object({
  slabName: z.string(),
  taxRatePercent: z.number(),
  cgstRatePercent: z.number(),
  sgstRatePercent: z.number(),
});

export type TaxComponents = z.infer<typeof taxComponentsSchema>;

export const propertySettingsSchema = z.object({
  /** Wall-clock times in the property's own timezone, `HH:MM`. */
  standardCheckInTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  standardCheckOutTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  turnaroundGraceMins: z.number().int().min(0).max(1440),
  bookingPrefix: z.string().min(1).max(24),
  folioPrefix: z.string().min(1).max(24),
  invoicePrefix: z.string().min(1).max(24),
  autoHoldReleaseHours: z.number().int().min(1).max(168),
  nightAuditHour: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

export type PropertySettings = z.infer<typeof propertySettingsSchema>;

/** Every field optional: a settings form saves the tab the operator edited. */
export const updatePropertySettingsSchema = propertySettingsSchema.partial();

export type UpdatePropertySettings = z.infer<typeof updatePropertySettingsSchema>;

export const amenityLinkSchema = z.object({
  amenityId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  groupName: z.string(),
  iconName: z.string().nullable(),
  scope: z.enum(['FREE', 'PAID']),
  priceMinor: z.number().int().nonnegative(),
  pricingUnit: z.string().nullable(),
});

export type AmenityLink = z.infer<typeof amenityLinkSchema>;

export const propertyPolicySchema = z.object({
  id: z.uuid(),
  type: z.enum([
    'CANCELLATION',
    'AMENDMENT',
    'CHECK_IN_CHECK_OUT',
    'HOUSE_RULES',
    'TERMS_AND_CONDITIONS',
    'CUSTOM',
  ]),
  title: z.string(),
  content: z.string(),
  isMandatory: z.boolean(),
  freeCancellationHours: z.number().int().nullable(),
  retentionChargePercent: z.number().nullable(),
});

export type PropertyPolicy = z.infer<typeof propertyPolicySchema>;

export const feeAndSurchargeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(['PERCENTAGE', 'FIXED_PER_NIGHT', 'FIXED_PER_STAY', 'FIXED_PER_GUEST']),
  amountMinor: z.number().int().nonnegative(),
  ratePercent: z.number().nullable(),
  isTaxable: z.boolean(),
  applyToGroup: z.boolean(),
});

export type FeeAndSurcharge = z.infer<typeof feeAndSurchargeSchema>;

export const propertyMediaSchema = z.object({
  id: z.uuid(),
  category: z.enum([
    'EXTERIOR',
    'INTERIOR',
    'RECEPTION',
    'ROOM_BEDROOM',
    'ROOM_WASHROOM',
    'AMENITY_BANQUET',
    'AMENITY_POOL',
    'AMENITY_GARDEN',
    'PARKING',
    'RESTAURANT',
    'OTHERS',
  ]),
  url: z.string(),
  caption: z.string().nullable(),
  sortOrder: z.number().int(),
  isFeatured: z.boolean(),
  roomTypeId: z.uuid().nullable(),
});

export type PropertyMedia = z.infer<typeof propertyMediaSchema>;

/**
 * Everything the settings screen needs, in one response.
 *
 * One request rather than five, because the five tabs are one form: an
 * operator who opens Taxes and switches to Policies should not wait again,
 * and five endpoints means five chances to disagree about which property is
 * being configured.
 */
export const propertySetupSchema = z.object({
  propertyId: z.string(),
  name: z.string(),
  code: z.string(),
  timezone: z.string(),
  currency: z.string().length(3),
  businessDate: z.string(),
  settings: propertySettingsSchema,
  taxSlabs: z.array(taxSlabSchema),
  amenities: z.array(amenityLinkSchema),
  policies: z.array(propertyPolicySchema),
  fees: z.array(feeAndSurchargeSchema),
  media: z.array(propertyMediaSchema),
});

export type PropertySetup = z.infer<typeof propertySetupSchema>;

/* -------------------------------------------------------------------------- */
/*  Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The whole slab table, replaced in one request.
 *
 * Not a per-slab create/update/delete, deliberately. A slab table is only
 * valid as a set — no gaps, no overlaps, a floor at 0 and exactly one
 * open-ended band — so a sequence of single-row edits would have to pass
 * through states that are individually plausible and collectively wrong, and a
 * quote landing in the middle of one would be priced against a broken table.
 * Replacing the set means it is validated and swapped inside one transaction.
 */
export const replaceTaxSlabsSchema = z.object({
  slabs: z.array(taxSlabSchema).min(1).max(12),
  /** Shown in the audit row, since this changes what guests are charged. */
  reason: z.string().min(1).max(500).nullable().default(null),
});

export type ReplaceTaxSlabs = z.infer<typeof replaceTaxSlabsSchema>;

/**
 * A photograph to record against the property.
 *
 * Takes a URL rather than file bytes: this records *where* an image lives, and
 * nothing in this repository stores uploads yet. Accepting a multipart body
 * would mean inventing an object store, a bucket policy and a cleanup path in
 * the same change (CLAUDE.md section 6.4).
 */
export const createPropertyMediaSchema = z.object({
  category: propertyMediaSchema.shape.category,
  url: z.url().max(2048),
  caption: z.string().max(240).nullable().default(null),
  sortOrder: z.number().int().min(0).max(999).default(0),
  isFeatured: z.boolean().default(false),
  /** Set where the photograph is of one room category, not the property. */
  roomTypeId: z.uuid().nullable().default(null),
});

export type CreatePropertyMedia = z.infer<typeof createPropertyMediaSchema>;

/**
 * Which amenities a property offers, and at what price.
 *
 * The amenity catalogue itself is portfolio-wide reference data and is not
 * editable here — "Wi-Fi" means the same thing at all ten hotels. What this
 * sets is the link: offered or not, free or paid, and the price.
 */
export const replaceAmenitiesSchema = z.object({
  amenities: z
    .array(
      z
        .object({
          amenityId: z.uuid(),
          scope: z.enum(['FREE', 'PAID']),
          priceMinor: z.number().int().nonnegative(),
          pricingUnit: z.string().max(40).nullable().default(null),
        })
        .refine(
          (link) =>
            (link.scope === 'PAID' && link.priceMinor > 0) ||
            (link.scope === 'FREE' && link.priceMinor === 0),
          {
            // Mirrors `property_amenity_link_price_matches_scope`. A paid
            // amenity with no price is a charge nobody can collect; a free one
            // with a price is a contradiction the booking engine must guess at.
            message: 'A paid amenity needs a price, and a free one must have none.',
            path: ['priceMinor'],
          },
        ),
    )
    .max(200),
  reason: z.string().min(1).max(500).nullable().default(null),
});

export type ReplaceAmenities = z.infer<typeof replaceAmenitiesSchema>;

/** The published policies, replaced as a set. */
export const replacePoliciesSchema = z.object({
  policies: z
    .array(
      z.object({
        type: propertyPolicySchema.shape.type,
        title: z.string().min(1).max(120),
        content: z.string().min(1).max(8000),
        isMandatory: z.boolean().default(true),
        freeCancellationHours: z.number().int().min(0).max(8760).nullable().default(null),
        retentionChargePercent: ratePercentSchema.nullable().default(null),
      }),
    )
    .max(40),
  reason: z.string().min(1).max(500).nullable().default(null),
});

export type ReplacePolicies = z.infer<typeof replacePoliciesSchema>;

/** The fees and surcharges, replaced as a set. */
export const replaceFeesSchema = z.object({
  fees: z
    .array(
      z
        .object({
          name: z.string().min(1).max(80),
          type: feeAndSurchargeSchema.shape.type,
          amountMinor: z.number().int().nonnegative().default(0),
          ratePercent: ratePercentSchema.nullable().default(null),
          isTaxable: z.boolean().default(true),
          applyToGroup: z.boolean().default(false),
        })
        .refine(
          (fee) =>
            fee.type === 'PERCENTAGE'
              ? fee.ratePercent !== null && fee.amountMinor === 0
              : fee.ratePercent === null,
          {
            // Mirrors `fee_and_surcharge_amount_matches_type`. Allowing both a
            // rate and a fixed amount leaves two sources of truth for one
            // charge, and nothing decides which one bills.
            message:
              'A percentage fee carries a rate and no fixed amount; a fixed fee the reverse.',
            path: ['ratePercent'],
          },
        ),
    )
    .max(40),
  reason: z.string().min(1).max(500).nullable().default(null),
});

export type ReplaceFees = z.infer<typeof replaceFeesSchema>;
