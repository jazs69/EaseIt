/**
 * Promotions, promo codes and the discount preview (F5).
 *
 * ===========================================================================
 * AUTHORISATION ORDER IS LOAD-BEARING. The grant is resolved first and a
 * caller with no grant gets not-found; only a caller who has already proven a
 * grant can reach a 403. Reversing the two would let a permission refusal
 * confirm that another property exists (section 3.2). Identical shape to
 * every other service in this module.
 *
 * THE PREVIEW REUSES THE WHOLE EXISTING STACK AND ADDS NO SECOND RESOLVER:
 *
 *   * F2 overrides        — `RateCalendarRepository.findOverrides`
 *   * F3 rules + weekend  — `RatePricingRuleRepository`
 *   * base rate           — `resolveRate` (F2/F3), unchanged
 *   * occupancy           — `resolveOccupancyPricing` (F4), unchanged
 *   * eligibility/discount— `promotion.policy.ts` (F5)
 *
 * So a preview can never disagree with the calendar about a base rate, or with
 * F4 about an extra-person charge.
 *
 * THE PREVIEW IS READ-ONLY, AND THAT IS STRUCTURAL RATHER THAN A PROMISE:
 * `preview()` calls only `find*`/`count*` methods, the repository has NO method
 * that writes a redemption counter, `promotion_redemption` has no writer
 * anywhere in F5, and `preview()` does not call `audit()`. Nothing it touches
 * can mutate.
 *
 * WHAT THIS DOES NOT TOUCH. `rate_plan*`, `rate_pricing_rule*` — read only.
 * `inventory_day`, `reservation`, `reservation_room`, `folio_line` — never
 * read or written, so no path enters the lock protocol of section 3.1.1.
 * `create-reservation.service.ts` — not opened; reservation pricing stays on
 * its existing path until F9.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';
import {
  MAX_PROMOTION_PREVIEW_NIGHTS,
  Permission,
  type CreatePromoCodeRequest,
  type CreatePromotionRequest,
  type ListPromotionsQuery,
  type PreviewPromotionRequest,
  type PromoCodeListResponse,
  type PromoCodeStatusAction,
  type PromoCodeView,
  type PromotionListResponse,
  type PromotionPreview,
  type PromotionStatusAction,
  type PromotionView,
  type UpdatePromotionRequest,
} from '@repo/types';

import {
  InvalidStateTransitionError,
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { resolveOccupancyPricing } from './occupancy-pricing.policy.js';
import { OccupancyPricingRepository } from './occupancy-pricing.repository.js';
import {
  amountsAreSafe,
  computeDiscount,
  evaluateEligibility,
  findPromotionConflicts,
  normalizePromoCode,
  selectPromotion,
  type PromotionCandidate,
} from './promotion.policy.js';
import { PromotionRepository, type PromotionRow } from './promotion.repository.js';
import { enumerateInclusive, parseCalendarDate } from './rate-calendar.policy.js';
import { RateCalendarService } from './rate-calendar.service.js';
import { RateCalendarRepository } from './rate-calendar.repository.js';

@Injectable()
export class PromotionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: PromotionRepository,
    /** F4's assignment configuration. Read only. */
    private readonly occupancy: OccupancyPricingRepository,
    /** F2's overrides. Read only. */
    private readonly calendar: RateCalendarRepository,
    /** The one base-rate resolver, derived plans included (AV-06). */
    private readonly rateCalendar: RateCalendarService,
  ) {}

  /* -- Promotions --------------------------------------------------------- */

  async list(
    userId: string,
    codeOrId: string,
    query: ListPromotionsQuery,
  ): Promise<PromotionListResponse> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_READ);

    const rows = await this.repository.findMany(property.id, {
      status: query.status,
      ...(query.search === undefined ? {} : { search: query.search }),
    });

    return {
      items: rows.map((row) => toView(row, property.currency)),
      currency: property.currency,
    };
  }

  async detail(userId: string, codeOrId: string, promotionId: string): Promise<PromotionView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_READ);
    const row = await this.requirePromotion(property.id, promotionId);
    return toView(row, property.currency);
  }

  async create(
    userId: string,
    codeOrId: string,
    request: CreatePromotionRequest,
  ): Promise<PromotionView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);

    await this.requireApplicability(property.id, {
      appliesToAllRatePlans: request.appliesToAllRatePlans,
      ratePlanIds: request.ratePlanIds,
      appliesToAllRoomTypes: request.appliesToAllRoomTypes,
      roomTypeIds: request.roomTypeIds,
    });

    await this.requireNoConflict(property.id, {
      id: null,
      // A new promotion is created active, so it must be checked.
      isActive: true,
      priority: request.priority,
      stayFromDate: request.stayFromDate,
      stayThroughDate: request.stayThroughDate,
      bookFromDate: request.bookFromDate,
      bookThroughDate: request.bookThroughDate,
      appliesToAllRatePlans: request.appliesToAllRatePlans,
      appliesToAllRoomTypes: request.appliesToAllRoomTypes,
      ratePlanIds: request.ratePlanIds,
      roomTypeIds: request.roomTypeIds,
    });

    const row = await this.repository.create(
      property.id,
      {
        name: request.name,
        description: request.description ?? null,
        discountKind: request.discount.kind,
        discountValue: request.discount.value,
        priority: request.priority,
        stayFromDate: request.stayFromDate,
        stayThroughDate: request.stayThroughDate,
        bookFromDate: request.bookFromDate,
        bookThroughDate: request.bookThroughDate,
        minNights: request.minNights,
        maxNights: request.maxNights,
        minEligibleAmountMinor: request.minEligibleAmountMinor,
        appliesToAllRatePlans: request.appliesToAllRatePlans,
        appliesToAllRoomTypes: request.appliesToAllRoomTypes,
        maxRedemptions: request.maxRedemptions,
      },
      request.appliesToAllRatePlans ? [] : request.ratePlanIds,
      request.appliesToAllRoomTypes ? [] : request.roomTypeIds,
      userId,
    );

    await this.audit(
      property.id,
      userId,
      'PROMOTION_CREATED',
      row.id,
      Prisma.DbNull,
      auditShape(row),
    );

    return toView(row, property.currency);
  }

  async update(
    userId: string,
    codeOrId: string,
    promotionId: string,
    request: UpdatePromotionRequest,
  ): Promise<PromotionView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);
    const before = await this.requirePromotion(property.id, promotionId);

    // Validated against the MERGED state, not the patch: changing only the
    // flag, or only the list, can still produce "applies to nothing" or a new
    // overlap. This is the same discipline F3 and F4 apply.
    const merged = {
      isActive: before.isActive,
      priority: request.priority ?? before.priority,
      stayFromDate: request.stayFromDate === undefined ? before.stayFromDate : request.stayFromDate,
      stayThroughDate:
        request.stayThroughDate === undefined ? before.stayThroughDate : request.stayThroughDate,
      bookFromDate: request.bookFromDate === undefined ? before.bookFromDate : request.bookFromDate,
      bookThroughDate:
        request.bookThroughDate === undefined ? before.bookThroughDate : request.bookThroughDate,
      appliesToAllRatePlans: request.appliesToAllRatePlans ?? before.appliesToAllRatePlans,
      appliesToAllRoomTypes: request.appliesToAllRoomTypes ?? before.appliesToAllRoomTypes,
      ratePlanIds: request.ratePlanIds ?? before.ratePlans.map((entry) => entry.id),
      roomTypeIds: request.roomTypeIds ?? before.roomTypes.map((entry) => entry.id),
    };

    const minNights = request.minNights === undefined ? before.minNights : request.minNights;
    const maxNights = request.maxNights === undefined ? before.maxNights : request.maxNights;
    if (minNights !== null && maxNights !== null && maxNights < minNights) {
      throw new ValidationFailedError({
        maxNights: 'The maximum nights cannot be below the minimum.',
      });
    }

    await this.requireApplicability(property.id, merged);
    await this.requireNoConflict(property.id, { id: promotionId, ...merged });

    const after = await this.repository.update(
      property.id,
      promotionId,
      {
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.description === undefined ? {} : { description: request.description }),
        ...(request.discount === undefined
          ? {}
          : { discountKind: request.discount.kind, discountValue: request.discount.value }),
        ...(request.priority === undefined ? {} : { priority: request.priority }),
        ...(request.stayFromDate === undefined ? {} : { stayFromDate: request.stayFromDate }),
        ...(request.stayThroughDate === undefined
          ? {}
          : { stayThroughDate: request.stayThroughDate }),
        ...(request.bookFromDate === undefined ? {} : { bookFromDate: request.bookFromDate }),
        ...(request.bookThroughDate === undefined
          ? {}
          : { bookThroughDate: request.bookThroughDate }),
        ...(request.minNights === undefined ? {} : { minNights: request.minNights }),
        ...(request.maxNights === undefined ? {} : { maxNights: request.maxNights }),
        ...(request.minEligibleAmountMinor === undefined
          ? {}
          : { minEligibleAmountMinor: request.minEligibleAmountMinor }),
        ...(request.appliesToAllRatePlans === undefined
          ? {}
          : { appliesToAllRatePlans: request.appliesToAllRatePlans }),
        ...(request.appliesToAllRoomTypes === undefined
          ? {}
          : { appliesToAllRoomTypes: request.appliesToAllRoomTypes }),
        ...(request.maxRedemptions === undefined ? {} : { maxRedemptions: request.maxRedemptions }),
        updatedByUserId: userId,
      },
      // When a promotion becomes "all", its explicit list is emptied: keeping
      // stale rows would make a later switch back to "specific" silently
      // restore a set the operator never re-chose.
      merged.appliesToAllRatePlans ? [] : merged.ratePlanIds,
      merged.appliesToAllRoomTypes ? [] : merged.roomTypeIds,
    );

    if (after === null) throw new TenantScopeViolationError('Promotion');

    await this.audit(
      property.id,
      userId,
      'PROMOTION_UPDATED',
      promotionId,
      auditShape(before),
      auditShape(after),
    );

    return toView(after, property.currency);
  }

  /**
   * Activate or deactivate.
   *
   * ACTIVATING RE-RUNS THE CONFLICT CHECK: a promotion may have been
   * deactivated precisely because it tied with another, and switching it back
   * on must not resurrect an ambiguity the selector cannot resolve.
   * Deactivating never conflicts with anything, so it is unconditional.
   */
  async setStatus(
    userId: string,
    codeOrId: string,
    promotionId: string,
    request: PromotionStatusAction,
  ): Promise<PromotionView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);
    const before = await this.requirePromotion(property.id, promotionId);

    const next = request.action === 'ACTIVATE';
    if (before.isActive === next) {
      // A no-op is refused rather than silently succeeding, the same
      // convention the rate-plan and pricing-rule status endpoints follow.
      throw new InvalidStateTransitionError(
        'promotion',
        before.isActive ? 'ACTIVE' : 'INACTIVE',
        request.action,
      );
    }

    if (next) {
      await this.requireApplicability(property.id, {
        appliesToAllRatePlans: before.appliesToAllRatePlans,
        ratePlanIds: before.ratePlans.map((entry) => entry.id),
        appliesToAllRoomTypes: before.appliesToAllRoomTypes,
        roomTypeIds: before.roomTypes.map((entry) => entry.id),
      });
      await this.requireNoConflict(property.id, {
        id: promotionId,
        isActive: true,
        priority: before.priority,
        stayFromDate: before.stayFromDate,
        stayThroughDate: before.stayThroughDate,
        bookFromDate: before.bookFromDate,
        bookThroughDate: before.bookThroughDate,
        appliesToAllRatePlans: before.appliesToAllRatePlans,
        appliesToAllRoomTypes: before.appliesToAllRoomTypes,
        ratePlanIds: before.ratePlans.map((entry) => entry.id),
        roomTypeIds: before.roomTypes.map((entry) => entry.id),
      });
    }

    const after = await this.repository.update(
      property.id,
      promotionId,
      { isActive: next, updatedByUserId: userId },
      undefined,
      undefined,
    );

    if (after === null) throw new TenantScopeViolationError('Promotion');

    await this.audit(
      property.id,
      userId,
      next ? 'PROMOTION_ACTIVATED' : 'PROMOTION_DEACTIVATED',
      promotionId,
      auditShape(before),
      auditShape(after),
    );

    return toView(after, property.currency);
  }

  /**
   * Delete a promotion, when safe.
   *
   * Refused when a redemption references it: a redemption is a financial
   * record, and deleting the promotion a stay was discounted under would
   * destroy the explanation of a charge. In F5 the count is always zero
   * because nothing writes redemptions until F9 — the check is here so it is
   * correct when that changes, and the composite foreign key is RESTRICT so
   * the database agrees rather than taking it on trust.
   */
  async remove(userId: string, codeOrId: string, promotionId: string): Promise<void> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);
    const before = await this.requirePromotion(property.id, promotionId);

    const redemptions = await this.repository.countRedemptions(property.id, promotionId);
    if (redemptions > 0) {
      throw new ValidationFailedError({
        promotionId:
          `This promotion has been redeemed ${String(redemptions)} time(s) and cannot be ` +
          'deleted — that would destroy the record of why those stays were discounted. ' +
          'Deactivate it instead.',
      });
    }

    const removed = await this.repository.remove(property.id, promotionId);
    if (!removed) throw new TenantScopeViolationError('Promotion');

    await this.audit(
      property.id,
      userId,
      'PROMOTION_DELETED',
      promotionId,
      auditShape(before),
      Prisma.DbNull,
    );
  }

  /* -- Promo codes -------------------------------------------------------- */

  async listCodes(
    userId: string,
    codeOrId: string,
    promotionId: string,
  ): Promise<PromoCodeListResponse> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_READ);
    const promotion = await this.requirePromotion(property.id, promotionId);
    return { items: promotion.codes.map(toCodeView) };
  }

  async createCode(
    userId: string,
    codeOrId: string,
    promotionId: string,
    request: CreatePromoCodeRequest,
  ): Promise<PromoCodeView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);
    await this.requirePromotion(property.id, promotionId);

    // Normalised once, here, by the same function the CHECK constraint mirrors
    // in SQL. The raw form is stored only for display.
    const normalized = normalizePromoCode(request.code);

    const row = await this.repository.createCode(
      property.id,
      promotionId,
      {
        code: request.code.trim(),
        codeNormalized: normalized,
        expiresOn: request.expiresOn,
        maxRedemptions: request.maxRedemptions,
      },
      userId,
    );

    // The audit payload carries the code's ID and its masked form, never the
    // raw value: the scope forbids logging raw codes, and an audit row is a
    // log somebody will read.
    await this.audit(property.id, userId, 'PROMO_CODE_CREATED', promotionId, Prisma.DbNull, {
      promoCodeId: row.id,
      code: maskCode(row.codeNormalized),
      expiresOn: row.expiresOn,
      maxRedemptions: row.maxRedemptions,
    });

    return toCodeView(row);
  }

  async setCodeStatus(
    userId: string,
    codeOrId: string,
    promotionId: string,
    promoCodeId: string,
    request: PromoCodeStatusAction,
  ): Promise<PromoCodeView> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);
    await this.requirePromotion(property.id, promotionId);

    const before = await this.repository.findCode(property.id, promotionId, promoCodeId);
    if (before === null) throw new TenantScopeViolationError('Promo code');

    const next = request.action === 'ACTIVATE';
    if (before.isActive === next && request.expiresOn === undefined) {
      throw new InvalidStateTransitionError(
        'promo code',
        before.isActive ? 'ACTIVE' : 'INACTIVE',
        request.action,
      );
    }

    const after = await this.repository.updateCode(property.id, promotionId, promoCodeId, {
      isActive: next,
      ...(request.expiresOn === undefined ? {} : { expiresOn: request.expiresOn }),
    });

    if (after === null) throw new TenantScopeViolationError('Promo code');

    await this.audit(
      property.id,
      userId,
      next ? 'PROMO_CODE_ACTIVATED' : 'PROMO_CODE_DEACTIVATED',
      promotionId,
      {
        promoCodeId: before.id,
        code: maskCode(before.codeNormalized),
        isActive: before.isActive,
        expiresOn: before.expiresOn,
      },
      {
        promoCodeId: after.id,
        code: maskCode(after.codeNormalized),
        isActive: after.isActive,
        expiresOn: after.expiresOn,
      },
    );

    return toCodeView(after);
  }

  async removeCode(
    userId: string,
    codeOrId: string,
    promotionId: string,
    promoCodeId: string,
  ): Promise<void> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_MANAGE);
    await this.requirePromotion(property.id, promotionId);

    const before = await this.repository.findCode(property.id, promotionId, promoCodeId);
    if (before === null) throw new TenantScopeViolationError('Promo code');

    const redemptions = await this.repository.countCodeRedemptions(property.id, promoCodeId);
    if (redemptions > 0) {
      throw new ValidationFailedError({
        promoCodeId:
          `This code has been redeemed ${String(redemptions)} time(s) and cannot be deleted. ` +
          'Deactivate it instead.',
      });
    }

    const removed = await this.repository.removeCode(property.id, promotionId, promoCodeId);
    if (!removed) throw new TenantScopeViolationError('Promo code');

    await this.audit(
      property.id,
      userId,
      'PROMO_CODE_DELETED',
      promotionId,
      { promoCodeId: before.id, code: maskCode(before.codeNormalized) },
      Prisma.DbNull,
    );
  }

  /* -- Preview ------------------------------------------------------------ */

  /**
   * Price a stay and report which promotion applies.
   *
   * READ-ONLY, structurally: every call below is a `find*` or a `count*`, the
   * repository exposes no method that moves a redemption counter, and this
   * method does not call `audit()`. Previewing consumes nothing and reserves
   * nothing.
   *
   * `rates:read`, consistent with every other non-mutating endpoint in this
   * module and with F4's preview.
   */
  async preview(
    userId: string,
    codeOrId: string,
    request: PreviewPromotionRequest,
  ): Promise<PromotionPreview> {
    const property = await this.authorise(userId, codeOrId, Permission.RATES_READ);
    return this.priceStay(property.id, request);
  }

  /**
   * The pricing behind the preview, for internal callers that have already
   * authorised (F9: the booking path). `propertyId` is a resolved id, never a
   * client value; every read below is scoped by it. Read-only, like the preview.
   */
  async priceStay(propertyId: string, request: PreviewPromotionRequest): Promise<PromotionPreview> {
    // The assignment also proves the room type is assigned to the plan, and
    // carries F4's configuration and the room's capacity.
    const assignment = await this.occupancy.findAssignment(
      propertyId,
      request.ratePlanId,
      request.roomTypeId,
    );
    if (assignment === null) throw new TenantScopeViolationError('Rate plan assignment');

    // Strict parsing: `businessDateSchema` accepts `2026-02-30` because it
    // matches the shape and `Date.parse` rolls it over. Each date is re-parsed
    // strictly here, the same guard F2's calendar applies.
    const arrival = parseCalendarDate(request.arrivalDate);
    const departure = parseCalendarDate(request.departureDate);
    const booking = parseCalendarDate(request.bookingDate);
    if (arrival === null) {
      throw new ValidationFailedError({ arrivalDate: 'Not a real calendar date.' });
    }
    if (departure === null) {
      throw new ValidationFailedError({ departureDate: 'Not a real calendar date.' });
    }
    if (booking === null) {
      throw new ValidationFailedError({ bookingDate: 'Not a real calendar date.' });
    }

    // Nights are arrival..departure-1 — half-open, the same convention
    // `stayRangeSchema` and the exclusion constraint use for a stay.
    const lastNight = new Date(departure.getTime() - 86_400_000);
    const stayDates = enumerateInclusive(arrival, lastNight);

    if (stayDates.length === 0) {
      throw new ValidationFailedError({
        departureDate: 'Departure must be after arrival — a stay is at least one night.',
      });
    }
    if (stayDates.length > MAX_PROMOTION_PREVIEW_NIGHTS) {
      throw new ValidationFailedError({
        departureDate:
          `That stay is ${String(stayDates.length)} nights. ` +
          `Preview at most ${String(MAX_PROMOTION_PREVIEW_NIGHTS)} at a time.`,
      });
    }

    /**
     * The base rates and occupancy charges, through the EXISTING stack.
     *
     * Four reads in parallel because none depends on another: F2's overrides
     * across the whole window, F3's rules for this category, the property's
     * weekend definition, and every promotion of the property.
     */

    // Base rates through the ONE base resolver (derived plans included, AV-06),
    // so a preview, the calendar and a booking cannot disagree about a night.
    const calendarAssignment = await this.calendar.findAssignment(
      propertyId,
      request.ratePlanId,
      request.roomTypeId,
    );
    if (calendarAssignment === null) throw new TenantScopeViolationError('Rate plan assignment');
    const [baseNights, promotions] = await Promise.all([
      this.rateCalendar.baseNights(propertyId, calendarAssignment, stayDates),
      this.repository.findAllForEvaluation(propertyId),
    ]);

    // Per night: F2/F3 base, then F4 occupancy. Neither is recomputed or
    // reinterpreted here — the same functions the calendar and F4's own
    // preview call.
    const nights = stayDates.map((stayDate, index) => {
      const base = baseNights[index];
      if (base === undefined || base.stayDate !== stayDate) {
        throw new Error('Base rates and stay dates disagree.');
      }

      const occupancy = resolveOccupancyPricing({
        baseRateMinor: base.effectiveRateMinor,
        currency: assignment.currency,
        config: {
          baseOccupancy: assignment.baseOccupancy,
          includedChildren: assignment.includedChildren,
          enabled: assignment.enabled,
          adult: { kind: assignment.adultKind, value: assignment.adultValue },
          child: { kind: assignment.childKind, value: assignment.childValue },
        },
        capacity: { maxGuests: assignment.maxGuests, maxAdults: assignment.maxAdults },
        guests: {
          adults: request.adults,
          children: request.children,
          infants: request.infants,
        },
      });

      return { base, occupancy };
    });

    const occupancyAdjustedTotalMinor = nights.reduce(
      (sum, night) => sum + night.occupancy.effectiveNightlyRateMinor,
      0,
    );

    /* -- F5: eligibility, then at most one selection ------------------- */

    const promoCodeNormalized =
      request.promoCode === null ? null : normalizePromoCode(request.promoCode);

    const context = {
      bookingDate: request.bookingDate,
      ratePlanId: request.ratePlanId,
      roomTypeId: request.roomTypeId,
      stayDates,
      stayEligibleAmountMinor: occupancyAdjustedTotalMinor,
      promoCodeNormalized,
    };

    const evaluated = promotions.map((promotion) => ({
      promotion,
      eligibility: evaluateEligibility(toCandidate(promotion), context),
    }));

    const selection = selectPromotion(
      evaluated.map((entry) => ({
        eligibility: entry.eligibility,
        priority: entry.promotion.priority,
      })),
    );

    const selected =
      selection.selectedPromotionId === null
        ? null
        : (evaluated.find((entry) => entry.promotion.id === selection.selectedPromotionId)
            ?.promotion ?? null);

    /* -- Per-night discount -------------------------------------------- */

    const perNight = nights.map((night) => {
      const occupancyAdjustedMinor = night.occupancy.effectiveNightlyRateMinor;
      const discountMinor =
        selected === null
          ? 0
          : computeDiscount(occupancyAdjustedMinor, selected.discountKind, selected.discountValue);

      return {
        stayDate: night.occupancy.breakdown.length > 0 ? night.base.stayDate : night.base.stayDate,
        baseRateMinor: night.base.effectiveRateMinor,
        baseRateSource: night.base.source,
        baseRateRuleName: night.base.ruleName,
        adultExtraChargeMinor: night.occupancy.adultExtraChargeMinor,
        childExtraChargeMinor: night.occupancy.childExtraChargeMinor,
        occupancyAdjustedMinor,
        discountMinor,
        finalNightlyMinor: occupancyAdjustedMinor - discountMinor,
      };
    });

    const baseTotalMinor = perNight.reduce((sum, night) => sum + night.baseRateMinor, 0);
    const extraGuestTotalMinor = perNight.reduce(
      (sum, night) => sum + night.adultExtraChargeMinor + night.childExtraChargeMinor,
      0,
    );
    const discountTotalMinor = perNight.reduce((sum, night) => sum + night.discountMinor, 0);
    const finalTotalMinor = perNight.reduce((sum, night) => sum + night.finalNightlyMinor, 0);

    // The scope's safe-integer requirement, checked rather than assumed. Every
    // bound upstream keeps the arithmetic exact, so reaching here means a
    // configuration at the extremes — but a silently wrong large number is
    // worse than a refusal.
    if (
      !amountsAreSafe(
        baseTotalMinor,
        extraGuestTotalMinor,
        occupancyAdjustedTotalMinor,
        discountTotalMinor,
        finalTotalMinor,
      )
    ) {
      throw new ValidationFailedError({
        departureDate: 'That stay produces an implausibly large total. Shorten the range.',
      });
    }

    return {
      ratePlanId: request.ratePlanId,
      roomTypeId: request.roomTypeId,
      arrivalDate: request.arrivalDate,
      departureDate: request.departureDate,
      bookingDate: request.bookingDate,
      nights: stayDates.length,
      currency: assignment.currency,
      perNight,
      baseTotalMinor,
      extraGuestTotalMinor,
      occupancyAdjustedTotalMinor,
      discountTotalMinor,
      finalTotalMinor,
      candidates: evaluated.map((entry) => ({
        promotionId: entry.promotion.id,
        promotionName: entry.promotion.name,
        priority: entry.promotion.priority,
        eligible: entry.eligibility.eligible,
        reasons: entry.eligibility.reasons,
      })),
      selectedPromotionId: selection.selectedPromotionId,
      selectedPromotionName: selected === null ? null : selected.name,
      selectedDiscount:
        selected === null ? null : { kind: selected.discountKind, value: selected.discountValue },
      selectedCodeId: selection.selectedCodeId,
      isAmbiguous: selection.isAmbiguous,
      conflictingPromotionIds: selection.conflictingPromotionIds,
      // F4's refusals, carried through unchanged: the same composition applies
      // to every night, so the first night's refusals are the stay's.
      occupancyRefusals: nights[0]?.occupancy.refusals ?? [],
    } as PromotionPreview;
  }

  /* -- Guards ------------------------------------------------------------- */

  private async requirePromotion(propertyId: string, promotionId: string): Promise<PromotionRow> {
    const row = await this.repository.findOne(propertyId, promotionId);
    if (row === null) throw new TenantScopeViolationError('Promotion');
    return row;
  }

  /**
   * A promotion must be able to apply to something, and everything it names
   * must be this property's and selectable.
   *
   * THREE RULES, all cross-table and therefore none expressible as a CHECK:
   *
   *   1. Not both flags false with both lists empty — otherwise the promotion
   *      can never apply, and an empty relation would be silently standing in
   *      for "none" while reading like "unset".
   *   2. Every named rate plan belongs to this property and is NOT archived.
   *      Archived plans cannot be newly selected (scope section 8).
   *   3. Every named room type is ASSIGNED to a rate plan the promotion also
   *      names — a condition over three tables, which is why it lives here.
   */
  private async requireApplicability(
    propertyId: string,
    value: {
      appliesToAllRatePlans: boolean;
      ratePlanIds: readonly string[];
      appliesToAllRoomTypes: boolean;
      roomTypeIds: readonly string[];
    },
  ): Promise<void> {
    if (!value.appliesToAllRatePlans && value.ratePlanIds.length === 0) {
      throw new ValidationFailedError({
        ratePlanIds:
          'Choose at least one rate plan, or set the promotion to apply to all of them. ' +
          'A promotion naming none can never apply.',
      });
    }
    if (!value.appliesToAllRoomTypes && value.roomTypeIds.length === 0) {
      throw new ValidationFailedError({
        roomTypeIds:
          'Choose at least one room type, or set the promotion to apply to all of them. ' +
          'A promotion naming none can never apply.',
      });
    }

    if (!value.appliesToAllRatePlans) {
      const selectable = await this.repository.countSelectableRatePlans(
        propertyId,
        value.ratePlanIds,
      );
      if (selectable !== value.ratePlanIds.length) {
        throw new ValidationFailedError({
          ratePlanIds:
            'One or more of those rate plans is not a selectable plan of this property. ' +
            'An archived plan cannot be chosen.',
        });
      }
    }

    if (!value.appliesToAllRoomTypes) {
      const assigned = value.appliesToAllRatePlans
        ? await this.repository.allAssignedRoomTypeIds(propertyId)
        : await this.repository.assignedRoomTypeIds(propertyId, value.ratePlanIds);

      const assignedSet = new Set(assigned);
      const stray = value.roomTypeIds.filter((id) => !assignedSet.has(id));

      if (stray.length > 0) {
        throw new ValidationFailedError({
          roomTypeIds:
            'One or more of those room types is not assigned to any of the chosen rate ' +
            'plans, so the promotion could never apply to it. Assign it to the plan first.',
        });
      }
    }
  }

  /**
   * Refuse an ambiguous configuration before it is stored.
   *
   * THE REAL ENFORCEMENT of the no-row-order rule. The policy decides what
   * collides — both active, same priority, overlapping stay AND booking
   * windows, and intersecting applicability on BOTH axes — and this turns a
   * collision into a 400 naming the other promotion.
   *
   * A database exclusion constraint cannot express it: applicability lives in
   * two child tables and PostgreSQL exclusion constraints are single-table, so
   * a constraint on the parent row would reject the legitimate case of two
   * same-priority promotions over disjoint room types. Recorded in the
   * migration's section 9, and it is why `selectPromotion` also detects a tie
   * at read time rather than trusting this was the only writer.
   */
  private async requireNoConflict(
    propertyId: string,
    candidate: {
      id: string | null;
      isActive: boolean;
      priority: number;
      stayFromDate: string | null;
      stayThroughDate: string | null;
      bookFromDate: string | null;
      bookThroughDate: string | null;
      appliesToAllRatePlans: boolean;
      appliesToAllRoomTypes: boolean;
      ratePlanIds: readonly string[];
      roomTypeIds: readonly string[];
    },
  ): Promise<void> {
    const existing = await this.repository.findAllForEvaluation(propertyId);

    const conflicts = findPromotionConflicts(
      candidate,
      existing.map((row) => ({
        id: row.id,
        name: row.name,
        isActive: row.isActive,
        priority: row.priority,
        stayFromDate: row.stayFromDate,
        stayThroughDate: row.stayThroughDate,
        bookFromDate: row.bookFromDate,
        bookThroughDate: row.bookThroughDate,
        appliesToAllRatePlans: row.appliesToAllRatePlans,
        appliesToAllRoomTypes: row.appliesToAllRoomTypes,
        ratePlanIds: row.ratePlans.map((entry) => entry.id),
        roomTypeIds: row.roomTypes.map((entry) => entry.id),
      })),
    );

    if (conflicts.length === 0) return;

    const first = conflicts[0];
    throw new ValidationFailedError({
      priority:
        `"${first?.existingPromotionName ?? ''}" is already active at priority ` +
        `${String(candidate.priority)} and overlaps this promotion's dates, rate plans and ` +
        'room types. Two promotions that both qualify at the same priority would give a ' +
        'night two prices with no way to choose, so promotions do not stack. Give one a ' +
        'higher priority, or narrow what they share.',
    });
  }

  /**
   * Audit every mutation: actor, property, entity, before/after (section 3.4).
   *
   * Written after the mutation rather than inside one transaction with it.
   * This is the established pattern across every service in this module; the
   * scope says to record it as a hardening item rather than refactor the audit
   * subsystem here. A crash between the two statements loses the audit row,
   * not the change.
   *
   * RAW PROMO CODES ARE NEVER WRITTEN HERE. Code events carry the code's id
   * and a masked form; an audit row is a log somebody will read.
   */
  private async audit(
    propertyId: string,
    actorUserId: string,
    event: string,
    promotionId: string,
    before: Prisma.InputJsonValue | typeof Prisma.DbNull,
    after: Prisma.InputJsonValue | typeof Prisma.DbNull,
  ): Promise<void> {
    await this.prisma.client.auditLog.create({
      data: {
        propertyId,
        actorUserId,
        event,
        entityType: 'promotion',
        entityId: promotionId,
        before,
        after: after === Prisma.DbNull ? { promotionId, deleted: true } : after,
      },
    });
  }

  /** See the identical helper in `rate-plan.service.ts`. */
  private async authorise(
    userId: string,
    codeOrId: string,
    required: Permission,
  ): Promise<{ id: string; currency: string }> {
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: grantedPropertyWhere({ userId, codeOrId, operableOnly: false }),
      select: {
        role: { select: { key: true } },
        property: { select: { id: true, currency: true } },
      },
    });

    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');

    requirePermissionFromGrants(grants, required);

    return { id: first.property.id, currency: first.property.currency };
  }
}

/* -------------------------------------------------------------------------- */
/*  Mappers                                                                   */
/* -------------------------------------------------------------------------- */

/** The stored row in the shape the pure policy expects. */
function toCandidate(row: PromotionRow): PromotionCandidate {
  return {
    id: row.id,
    name: row.name,
    discountKind: row.discountKind,
    discountValue: row.discountValue,
    priority: row.priority,
    isActive: row.isActive,
    stayFromDate: row.stayFromDate,
    stayThroughDate: row.stayThroughDate,
    bookFromDate: row.bookFromDate,
    bookThroughDate: row.bookThroughDate,
    minNights: row.minNights,
    maxNights: row.maxNights,
    minEligibleAmountMinor: row.minEligibleAmountMinor,
    appliesToAllRatePlans: row.appliesToAllRatePlans,
    appliesToAllRoomTypes: row.appliesToAllRoomTypes,
    ratePlanIds: row.ratePlans.map((entry) => entry.id),
    roomTypeIds: row.roomTypes.map((entry) => entry.id),
    maxRedemptions: row.maxRedemptions,
    redeemedCount: row.redeemedCount,
    codes: row.codes.map((code) => ({
      id: code.id,
      codeNormalized: code.codeNormalized,
      isActive: code.isActive,
      expiresOn: code.expiresOn,
      maxRedemptions: code.maxRedemptions,
      redeemedCount: code.redeemedCount,
    })),
  };
}

function remaining(max: number | null, used: number): number | null {
  return max === null ? null : Math.max(0, max - used);
}

/**
 * Prisma row to wire shape. Explicit, never a spread: a Prisma model is a
 * persistence detail and returning one leaks `propertyId`, `createdByUserId`
 * and every future addition (section 5).
 *
 * `codeNormalized` is NOT published. The display form is enough for an
 * operator, and the normalised form is the matched secret.
 */
function toView(row: PromotionRow, currency: string): PromotionView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    discount: { kind: row.discountKind, value: row.discountValue },
    priority: row.priority,
    isActive: row.isActive,
    stayFromDate: row.stayFromDate,
    stayThroughDate: row.stayThroughDate,
    bookFromDate: row.bookFromDate,
    bookThroughDate: row.bookThroughDate,
    minNights: row.minNights,
    maxNights: row.maxNights,
    minEligibleAmountMinor: row.minEligibleAmountMinor,
    appliesToAllRatePlans: row.appliesToAllRatePlans,
    appliesToAllRoomTypes: row.appliesToAllRoomTypes,
    ratePlans: row.ratePlans,
    roomTypes: row.roomTypes,
    maxRedemptions: row.maxRedemptions,
    redeemedCount: row.redeemedCount,
    remainingRedemptions: remaining(row.maxRedemptions, row.redeemedCount),
    codeCount: row.codes.length,
    // A promotion with any code requires one; with none it applies
    // automatically. See the policy for why deactivating the last code does
    // not silently open the promotion to everybody.
    requiresCode: row.codes.length > 0,
    currency,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  } as PromotionView;
}

function toCodeView(row: {
  id: string;
  code: string;
  isActive: boolean;
  expiresOn: string | null;
  maxRedemptions: number | null;
  redeemedCount: number;
  createdAt: Date;
  updatedAt: Date;
}): PromoCodeView {
  return {
    id: row.id,
    code: row.code,
    isActive: row.isActive,
    expiresOn: row.expiresOn,
    maxRedemptions: row.maxRedemptions,
    redeemedCount: row.redeemedCount,
    remainingRedemptions: remaining(row.maxRedemptions, row.redeemedCount),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  } as PromoCodeView;
}

/**
 * A promo code as it may appear in an audit row: first two characters, then
 * stars.
 *
 * The scope forbids logging raw codes, and an audit row is a log. Two
 * characters is enough for an operator to recognise which code a row is about
 * while leaving it unusable to a reader who should not have it.
 */
function maskCode(normalized: string): string {
  return `${normalized.slice(0, 2)}${'*'.repeat(Math.max(0, normalized.length - 2))}`;
}

/** The audit payload: the fields a change can actually alter. */
function auditShape(row: PromotionRow): Prisma.InputJsonObject {
  return {
    name: row.name,
    description: row.description,
    discountKind: row.discountKind,
    discountValue: row.discountValue,
    priority: row.priority,
    isActive: row.isActive,
    stayFromDate: row.stayFromDate,
    stayThroughDate: row.stayThroughDate,
    bookFromDate: row.bookFromDate,
    bookThroughDate: row.bookThroughDate,
    minNights: row.minNights,
    maxNights: row.maxNights,
    minEligibleAmountMinor: row.minEligibleAmountMinor,
    appliesToAllRatePlans: row.appliesToAllRatePlans,
    appliesToAllRoomTypes: row.appliesToAllRoomTypes,
    ratePlanIds: row.ratePlans.map((entry) => entry.id),
    roomTypeIds: row.roomTypes.map((entry) => entry.id),
    maxRedemptions: row.maxRedemptions,
    // Never the raw codes.
    codeCount: row.codes.length,
  };
}
