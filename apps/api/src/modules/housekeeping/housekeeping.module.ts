/**
 * The `housekeeping` module (CLAUDE.md section 2; HK-01): the board, tasks
 * and inspections. Room status itself is still written by one path -- the
 * conditional, audited update -- whether from the status endpoint or from a
 * completed task here.
 */

import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { HousekeepingController } from './housekeeping.controller.js';
import { HousekeepingService } from './housekeeping.service.js';

@Module({
  controllers: [HousekeepingController],
  providers: [HousekeepingService, TokenService, SessionAuthGuard],
})
export class HousekeepingModule {}
