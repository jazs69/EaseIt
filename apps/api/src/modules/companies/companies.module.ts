import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { CompaniesController } from './companies.controller.js';
import { CompaniesService } from './companies.service.js';
import { GstService } from './gst.service.js';

/** Corporate billing accounts, plus the GSTIN and postal lookups. */
@Module({
  controllers: [CompaniesController],
  providers: [CompaniesService, GstService, TokenService, SessionAuthGuard],
  exports: [CompaniesService],
})
export class CompaniesModule {}
