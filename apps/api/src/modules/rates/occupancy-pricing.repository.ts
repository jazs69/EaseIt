/**
 * Persistence for occupancy pricing configuration. No business rules here;
 * the formula lives in `occupancy-pricing.policy.ts` (CLAUDE.md section 5).
 *
 * ===========================================================================
 * Every statement carries `propertyId` explicitly. There is no Prisma tenancy
 * extension and no row-level security in this repository -- section 3.2
 * describes both and neither is implemented -- so the predicate IS the tenancy
 * control, not a convenience on top of one.
 *
 * `select` is always explicit, and it reaches the ROOM TYPE's `maxGuests` and
 * `maxAdults` through the assignment's own relation. That is deliberate: the
 * capacity limits are properties of the room type and are read from it, never
 * copied onto the assignment. A denormalised copy would be a second source of
 * truth for a room's capacity, which is precisely the ambiguity F2 removed
 * from `defaultRateMinor`.
 *
 * ONE READ ANSWERS EVERYTHING the configuration endpoints need: the assignment
 * exists, it belongs to this property, the plan is editable, the current
 * configuration, and the room type's limits. Separate reads could disagree by
 * having been taken at different moments.
 *
 * NOTHING HERE WRITES OR READS `rate_plan_day`, `rate_pricing_rule`,
 * `inventory_day`, `reservation` or `folio_line`. F4 adds columns to an
 * existing table and touches nothing else, so no path enters the lock protocol
 * of section 3.1.1.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';

import { PrismaService } from '../../prisma/prisma.service.js';

const OCCUPANCY_SELECT = {
  ratePlanId: true,
  roomTypeId: true,
  defaultRateMinor: true,
  baseOccupancy: true,
  includedChildren: true,
  occupancyPricingEnabled: true,
  extraAdultChargeKind: true,
  extraAdultChargeValue: true,
  extraChildChargeKind: true,
  extraChildChargeValue: true,
  updatedAt: true,
  ratePlan: { select: { code: true, currency: true, isActive: true, archivedAt: true } },
  // The capacity limits, read from where they live.
  roomType: { select: { code: true, name: true, maxGuests: true, maxAdults: true } },
} satisfies Prisma.RatePlanRoomTypeSelect;

export interface OccupancyAssignmentRow {
  ratePlanId: string;
  ratePlanCode: string;
  roomTypeId: string;
  roomTypeCode: string;
  roomTypeName: string;
  currency: string;
  defaultRateMinor: number;
  baseOccupancy: number;
  includedChildren: number;
  enabled: boolean;
  adultKind: 'FIXED' | 'PERCENT';
  adultValue: number;
  childKind: 'FIXED' | 'PERCENT';
  childValue: number;
  maxGuests: number;
  maxAdults: number | null;
  isActive: boolean;
  archivedAt: Date | null;
  updatedAt: Date;
}

export interface OccupancyWriteInput {
  baseOccupancy?: number;
  includedChildren?: number;
  occupancyPricingEnabled?: boolean;
  extraAdultChargeKind?: 'FIXED' | 'PERCENT';
  extraAdultChargeValue?: number;
  extraChildChargeKind?: 'FIXED' | 'PERCENT';
  extraChildChargeValue?: number;
}

@Injectable()
export class OccupancyPricingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The assignment with its occupancy configuration and the room's limits.
   *
   * Scoped by `propertyId` in the SAME predicate as both ids, so another
   * property's assignment is *not found* rather than forbidden (section 3.2).
   * Not `findUnique` on the composite key followed by a property comparison: a
   * lookup that can find another property's row and then reject it has already
   * confirmed that row exists.
   */
  async findAssignment(
    propertyId: string,
    ratePlanId: string,
    roomTypeId: string,
  ): Promise<OccupancyAssignmentRow | null> {
    const row = await this.prisma.client.ratePlanRoomType.findFirst({
      where: { propertyId, ratePlanId, roomTypeId },
      select: OCCUPANCY_SELECT,
    });

    if (row === null) return null;

    return {
      ratePlanId: row.ratePlanId,
      ratePlanCode: row.ratePlan.code,
      roomTypeId: row.roomTypeId,
      roomTypeCode: row.roomType.code,
      roomTypeName: row.roomType.name,
      currency: row.ratePlan.currency,
      defaultRateMinor: row.defaultRateMinor,
      baseOccupancy: row.baseOccupancy,
      includedChildren: row.includedChildren,
      enabled: row.occupancyPricingEnabled,
      adultKind: row.extraAdultChargeKind,
      adultValue: row.extraAdultChargeValue,
      childKind: row.extraChildChargeKind,
      childValue: row.extraChildChargeValue,
      maxGuests: row.roomType.maxGuests,
      maxAdults: row.roomType.maxAdults,
      isActive: row.ratePlan.isActive,
      archivedAt: row.ratePlan.archivedAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Write the configuration, returning null when the row is not this
   * property's.
   *
   * `updateMany` with all three predicates rather than `update` on the
   * composite key: a zero-count result is indistinguishable from "no such
   * row", which is what a caller without a grant must be told.
   *
   * It writes `rate_plan_room_type` only. `defaultRateMinor` is deliberately
   * NOT in `OccupancyWriteInput` -- the rate itself is changed through F2's
   * own endpoint, and offering a second way to set it here would be a second
   * place for the audit trail to record a price change.
   */
  async update(
    propertyId: string,
    ratePlanId: string,
    roomTypeId: string,
    input: OccupancyWriteInput,
  ): Promise<OccupancyAssignmentRow | null> {
    const updated = await this.prisma.client.ratePlanRoomType.updateMany({
      where: { propertyId, ratePlanId, roomTypeId },
      data: input,
    });

    if (updated.count === 0) return null;

    return this.findAssignment(propertyId, ratePlanId, roomTypeId);
  }
}
