import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { CalendarController } from './calendar.controller.js';
import { CalendarRepository } from './calendar.repository.js';
import { CalendarService } from './calendar.service.js';

/**
 * The group reservation calendar.
 *
 * Its own module rather than a method on `properties`: that module answers
 * "which hotels may I enter", this one computes occupancy and ADR across them.
 * `ClockService` arrives from the global PlatformModule.
 */
@Module({
  controllers: [CalendarController],
  providers: [CalendarService, CalendarRepository, TokenService, SessionAuthGuard],
  exports: [CalendarService],
})
export class CalendarModule {}
