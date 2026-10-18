import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { FoliosController } from './folios.controller.js';
import { FoliosService } from './folios.service.js';

/**
 * The `folios` bounded context: the guest ledger.
 *
 * Reads and postings only. Settlement and check-out close a folio and belong
 * to `frontdesk`, and the night audit's per-date room-charge posting belongs
 * to `nightaudit` — both will call this module's service rather than writing
 * `folio_line` themselves, so the sign conventions and the double-posting
 * guard have one owner.
 *
 * `TokenService` and `SessionAuthGuard` are provided locally, as every module
 * with a guarded controller must: Nest resolves a controller-level guard's
 * dependencies from the module declaring the controller.
 */
@Module({
  controllers: [FoliosController],
  providers: [FoliosService, TokenService, SessionAuthGuard],
  exports: [FoliosService],
})
export class FoliosModule {}
