/**
 * Direct billing: the city ledger (GP-07). The transfer onto a company account
 * is a folio write and lives in the folios module; this module reads the
 * ledger and records company payments.
 */

import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { DirectBillingController } from './direct-billing.controller.js';
import { DirectBillingRepository } from './direct-billing.repository.js';
import { DirectBillingService } from './direct-billing.service.js';

@Module({
  controllers: [DirectBillingController],
  providers: [DirectBillingService, DirectBillingRepository, TokenService, SessionAuthGuard],
})
export class DirectBillingModule {}
