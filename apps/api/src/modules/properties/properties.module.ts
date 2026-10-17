import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { PropertiesController } from './properties.controller.js';
import { PropertiesRepository } from './properties.repository.js';
import { PropertiesService } from './properties.service.js';

/**
 * The `properties` module from CLAUDE.md section 2.
 *
 * Owns the group dashboard: which properties a staff member may enter, and
 * which one they are currently in. `TokenService` is provided here because
 * selecting a property re-signs the session cookie, and `SessionAuthGuard`
 * because a guard cannot be resolved from a module that neither provides nor
 * imports it. Both are stateless, so re-providing them keeps the dependency
 * one-directional rather than importing AuthModule to borrow them.
 */
@Module({
  controllers: [PropertiesController],
  providers: [PropertiesService, PropertiesRepository, TokenService, SessionAuthGuard],
  exports: [PropertiesService],
})
export class PropertiesModule {}
