import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { PropertyDashboardController } from './property-dashboard.controller.js';
import { PropertyDashboardRepository } from './property-dashboard.repository.js';
import { PropertyDashboardService } from './property-dashboard.service.js';

/**
 * The daily front-desk dashboard.
 *
 * Sits beside `properties` rather than inside it: that module answers
 * portfolio-level questions (which hotels may I enter, which am I in), this
 * one answers operational questions about a single day at one hotel. Keeping
 * them separate stops a group-level service growing reservation logic.
 */
@Module({
  controllers: [PropertyDashboardController],
  providers: [
    PropertyDashboardService,
    PropertyDashboardRepository,
    TokenService,
    SessionAuthGuard,
  ],
  exports: [PropertyDashboardService],
})
export class PropertyDashboardModule {}
