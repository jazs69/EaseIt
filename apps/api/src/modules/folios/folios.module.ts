import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { FoliosController } from './folios.controller.js';
import { FoliosService } from './folios.service.js';
import { PropertiesModule } from '../properties/properties.module.js';

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
  // Tax slabs are resolved through `PropertyTaxService` (section 2 puts tax
  // rules in the properties module), so that module is imported rather than
  // its service re-provided here.
  imports: [PropertiesModule],
  controllers: [FoliosController],
  providers: [FoliosService, TokenService, SessionAuthGuard],
  exports: [FoliosService],
})
export class FoliosModule {}
