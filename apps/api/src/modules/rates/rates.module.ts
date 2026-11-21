import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { OccupancyPricingController } from './occupancy-pricing.controller.js';
import { PromotionController } from './promotion.controller.js';
import { PromotionRepository } from './promotion.repository.js';
import { PromotionService } from './promotion.service.js';
import { OccupancyPricingRepository } from './occupancy-pricing.repository.js';
import { OccupancyPricingService } from './occupancy-pricing.service.js';
import { RateCalendarRepository } from './rate-calendar.repository.js';
import { RateCalendarService } from './rate-calendar.service.js';
import { RatePlanController } from './rate-plan.controller.js';
import { RateDerivationController } from './rate-derivation.controller.js';
import { RateDerivationService } from './rate-derivation.service.js';
import { RateRestrictionController } from './rate-restriction.controller.js';
import { RateRestrictionRepository } from './rate-restriction.repository.js';
import { RateRestrictionService } from './rate-restriction.service.js';
import { RatePricingRuleController } from './rate-pricing-rule.controller.js';
import { RatePricingRuleRepository } from './rate-pricing-rule.repository.js';
import { RatePricingRuleService } from './rate-pricing-rule.service.js';
import { RatePlanRepository } from './rate-plan.repository.js';
import { RatePlanService } from './rate-plan.service.js';

/**
 * Rate plans and, eventually, pricing.
 *
 * CLAUDE.md section 2 gives the `rates` module ownership of "rate plans, rate
 * calendar, derived/linked rates, promotions". This increment (F1) implements
 * only the first of those four: the plan itself — its identity, its single
 * nightly rate, its status, and the room types it applies to.
 *
 * WHAT IT DOES NOT TOUCH, AND WHY THAT MATTERS FOR THE LOCK PROTOCOL.
 *
 * Nothing here reads or writes `inventory_day`, `reservation`,
 * `reservation_room` or `folio_line`. So no path in this module enters the
 * locking protocol of section 3.1.1, and none of the five existing
 * `inventory_day` writers acquires a new reason to contend. That is why these
 * services set no `lock_timeout` and carry no retry wrapper: there is no row
 * any of those writers hold that a rate-plan write wants. Should a later scope
 * make pricing part of the booking transaction (F9), that analysis has to be
 * redone — the plan tables would then be read inside a transaction that
 * already holds inventory rows.
 *
 * It also does not depend on `InventoryModule`, and nothing in inventory
 * depends on this. Room-type ownership is verified with a scoped `count`
 * through this module's own repository rather than by injecting
 * `RoomTypeService`, which keeps the dependency at the narrowest thing that
 * works (section 5) and avoids a module edge that would exist only for a
 * validation query.
 *
 * `ClockService` arrives from the global `PlatformModule`, as it does in
 * `inventory`, `calendar` and `performance`: an archival instant must come
 * from the injected clock, never `new Date()` (section 5).
 */
@Module({
  controllers: [
    RatePlanController,
    RatePricingRuleController,
    OccupancyPricingController,
    PromotionController,
    RateRestrictionController,
    RateDerivationController,
  ],
  providers: [
    RateDerivationService,
    RateRestrictionService,
    RateRestrictionRepository,
    RatePlanService,
    RatePlanRepository,
    RateCalendarService,
    RateCalendarRepository,
    RatePricingRuleService,
    RatePricingRuleRepository,
    OccupancyPricingService,
    OccupancyPricingRepository,
    PromotionService,
    PromotionRepository,
    TokenService,
    SessionAuthGuard,
  ],
  // `RateCalendarService` is exported for F9, which will need the effective
  // nightly rate at quote time. The pure rule itself lives in
  // `rate-calendar.policy.ts` and can be imported without the service at all.
  // `OccupancyPricingService` is exported for F9, which will need a nightly
  // total for a real guest composition at quote time. The pure formula lives in
  // `occupancy-pricing.policy.ts` and can be imported without the service at
  // all, which is the form F9 should prefer.
  exports: [
    RatePlanService,
    RateCalendarService,
    RatePricingRuleService,
    OccupancyPricingService,
    // F9: the booking path prices occupancy and promotions through priceStay.
    PromotionService,
    // CM-03: the ARI push reads assignments and restrictions through these,
    // so a channel is sent exactly what the desk would quote.
    RateCalendarRepository,
    RateRestrictionRepository,
  ],
})
export class RatesModule {}
