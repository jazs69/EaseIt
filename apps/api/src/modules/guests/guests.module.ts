/**
 * Reusable guest profiles (GP-02): search, create, edit, and link a booking's
 * guest rows by hand. Suggestions share an email or phone; nothing merges.
 */

import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { GuestsController } from './guests.controller.js';
import { GuestsRepository } from './guests.repository.js';
import { GuestsService } from './guests.service.js';

@Module({
  controllers: [GuestsController],
  providers: [GuestsService, GuestsRepository, TokenService, SessionAuthGuard],
})
export class GuestsModule {}
