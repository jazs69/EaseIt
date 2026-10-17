import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsRepository } from './reports.repository.js';
import { ReportsService } from './reports.service.js';

/**
 * Property reporting.
 *
 * `TokenService` and `SessionAuthGuard` are provided locally, as every module
 * with a guarded controller must: Nest resolves a controller-level guard's
 * dependencies from the module declaring the controller, so omitting it fails
 * at boot with "can't resolve dependencies of the SessionAuthGuard" rather
 * than at request time.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService, ReportsRepository, TokenService, SessionAuthGuard],
  exports: [ReportsService],
})
export class ReportsModule {}
