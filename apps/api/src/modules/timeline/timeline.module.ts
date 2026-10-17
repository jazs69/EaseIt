import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { TimelineController } from './timeline.controller.js';
import { TimelineRepository } from './timeline.repository.js';
import { TimelineService } from './timeline.service.js';

/**
 * The room x date reservation grid — the PMS calendar.
 *
 * Separate from `calendar` (which is portfolio occupancy) and from
 * `property-dashboard` (which is the daily list): this one owns grid geometry.
 * Keeping it apart stops block-placement arithmetic leaking into services that
 * have no business with it.
 */
@Module({
  controllers: [TimelineController],
  providers: [TimelineService, TimelineRepository, TokenService, SessionAuthGuard],
  exports: [TimelineService],
})
export class TimelineModule {}
