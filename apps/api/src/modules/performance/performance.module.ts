import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { PerformanceController } from './performance.controller.js';
import { PerformanceRepository } from './performance.repository.js';
import { PerformanceService } from './performance.service.js';

/**
 * Portfolio financial analytics.
 *
 * Separate from `calendar` (portfolio occupancy over a short window) because
 * this one owns the hospitality measures — ADR, RevPAR and their year-on-year
 * comparisons — and those definitions must live in exactly one place.
 * `ClockService` arrives from the global PlatformModule.
 */
@Module({
  controllers: [PerformanceController],
  providers: [PerformanceService, PerformanceRepository, TokenService, SessionAuthGuard],
  exports: [PerformanceService],
})
export class PerformanceModule {}
