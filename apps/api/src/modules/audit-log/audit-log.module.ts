/**
 * The audit log viewer (AD-03). Each service writes its own audit rows inside
 * its own transaction (AD-02); this module only reads them back.
 */

import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { AuditLogController } from './audit-log.controller.js';
import { AuditLogRepository } from './audit-log.repository.js';
import { AuditLogService } from './audit-log.service.js';

@Module({
  controllers: [AuditLogController],
  providers: [AuditLogService, AuditLogRepository, TokenService, SessionAuthGuard],
})
export class AuditLogModule {}
