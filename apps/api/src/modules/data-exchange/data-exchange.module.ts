/** IE-01 bulk import and IE-02 export. */

import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { DataExchangeAuthorizer } from './data-exchange.authorizer.js';
import { DataExchangeController } from './data-exchange.controller.js';
import { DataExchangeRepository } from './data-exchange.repository.js';
import { ExportService } from './export.service.js';
import { ImportService } from './import.service.js';

@Module({
  controllers: [DataExchangeController],
  providers: [
    DataExchangeRepository,
    DataExchangeAuthorizer,
    ImportService,
    ExportService,
    TokenService,
    SessionAuthGuard,
  ],
})
export class DataExchangeModule {}
