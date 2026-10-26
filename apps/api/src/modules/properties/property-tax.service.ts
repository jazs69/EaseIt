/**
 * The tax table a property prices with.
 *
 * ===========================================================================
 * One place decides where a rate comes from.
 *
 * Three sources exist, and the whole point of this service is that the
 * precedence between them is written down once rather than re-derived at every
 * call site:
 *
 *   1. **The property's `PropertyTaxSlab` rows.** Configured policy. Wins.
 *   2. **The legacy `property.taxRatePercent` column**, if any slab row is
 *      missing but a flat rate is set. Synthesised into a single open-ended
 *      slab so everything downstream only ever sees a slab table.
 *   3. **`STATUTORY_ROOM_TARIFF_SLABS`**, when neither exists.
 *
 * Slabs beat the flat column deliberately, and that is a behaviour change
 * worth stating: a property that carried a flat rate and now also has slabs
 * will price from the slabs. That is the migration — a single rate per hotel
 * is the thing being replaced, and leaving it able to override would mean the
 * engine never actually took effect anywhere.
 *
 * **Nothing is cached.** Ten properties and three slabs each is one indexed
 * read per quote, and a cache here would need invalidating from the settings
 * screen, from the seed, and from a migration. A stale tax rate is a wrong
 * invoice; the read is cheaper than being sure the cache is right.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import type { TaxComponents, TaxSlab } from '@repo/types';

import { PrismaService } from '../../prisma/prisma.service.js';
import {
  componentsFor,
  STATUTORY_ROOM_TARIFF_SLABS,
  taxPercentFor,
  type TaxSlabGapError,
} from './tax-engine.js';

/** A Prisma-shaped client, so a transaction can be passed in. */
interface SlabReader {
  propertyTaxSlab: {
    findMany: (args: {
      where: { propertyId: string };
      orderBy: { minTariffMinor: 'asc' };
      select: Record<string, true>;
    }) => Promise<
      {
        slabName: string;
        minTariffMinor: number;
        maxTariffMinor: number | null;
        taxRatePercent: unknown;
        cgstRatePercent: unknown;
        sgstRatePercent: unknown;
      }[]
    >;
  };
}

@Injectable()
export class PropertyTaxService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The slab table for a property, ordered by floor.
   *
   * Takes an optional client so a pricing read inside a reservation
   * transaction uses that transaction rather than a second connection — a
   * second connection is how a read-check-write ends up straddling two
   * snapshots (section 3.1).
   */
  async slabsFor(
    propertyId: string,
    legacyFlatRatePercent?: number | null,
    client?: SlabReader,
  ): Promise<TaxSlab[]> {
    const rows = await (client ?? this.prisma.client).propertyTaxSlab.findMany({
      where: { propertyId },
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

    if (rows.length > 0) {
      return rows.map((row) => ({
        slabName: row.slabName,
        minTariffMinor: row.minTariffMinor,
        maxTariffMinor: row.maxTariffMinor,
        // Decimal to number at the boundary. These are rates, not money, so
        // float is the right representation (section 3.4) — and a rate with
        // two decimal places is exact in binary floating point at this
        // magnitude, so no precision is lost on the way through.
        taxRatePercent: Number(row.taxRatePercent),
        cgstRatePercent: Number(row.cgstRatePercent),
        sgstRatePercent: Number(row.sgstRatePercent),
      }));
    }

    return fallbackTable(legacyFlatRatePercent);
  }

  /** The rate for one nightly tariff under a property's table. */
  percentFor(nightlyRateMinor: number, slabs: readonly TaxSlab[]): number {
    return taxPercentFor(nightlyRateMinor, slabs);
  }

  /** The CGST/SGST split for one nightly tariff, for an invoice. */
  componentsFor(nightlyRateMinor: number, slabs: readonly TaxSlab[]): TaxComponents {
    return componentsFor(nightlyRateMinor, slabs);
  }
}

/**
 * The table to use when a property has no slab rows.
 *
 * A flat rate becomes one open-ended slab rather than a special case carried
 * through every function below it: downstream code should only ever have to
 * understand a slab table, not "a slab table, unless".
 */
export function fallbackTable(legacyFlatRatePercent?: number | null): TaxSlab[] {
  if (legacyFlatRatePercent === undefined || legacyFlatRatePercent === null) {
    return [...STATUTORY_ROOM_TARIFF_SLABS];
  }

  // The split is assumed even here, because a flat column never recorded one.
  // That assumption is exactly why slabs exist, and why this is a fallback.
  const half = Math.round((legacyFlatRatePercent / 2) * 100) / 100;

  return [
    {
      slabName: `Property flat rate (${String(legacyFlatRatePercent)}%)`,
      minTariffMinor: 0,
      maxTariffMinor: null,
      taxRatePercent: legacyFlatRatePercent,
      cgstRatePercent: half,
      sgstRatePercent: legacyFlatRatePercent - half,
    },
  ];
}

export type { TaxSlabGapError };
