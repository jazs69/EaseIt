/**
 * The `nightaudit` module (CLAUDE.md section 2; NA-01).
 *
 * The API uses the controller and service (enqueue and read). The worker uses
 * the runner, through the NIGHT_AUDIT_RUN outbox handler, and the scheduler.
 * Both processes register the handlers; only the worker drains them.
 */

import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { OutboxModule } from '../platform/outbox/outbox.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { NightAuditController } from './night-audit.controller.js';
import {
  NightAuditCompletedHandler,
  NightAuditHandlerRegistrar,
  NightAuditRunHandler,
} from './night-audit.handlers.js';
import { NightAuditRunner } from './night-audit.runner.js';
import { NightAuditScheduler } from './night-audit.scheduler.js';
import { NightAuditService } from './night-audit.service.js';

@Module({
  imports: [OutboxModule, ReservationsModule],
  controllers: [NightAuditController],
  providers: [
    NightAuditService,
    NightAuditRunner,
    NightAuditRunHandler,
    NightAuditCompletedHandler,
    NightAuditHandlerRegistrar,
    NightAuditScheduler,
    TokenService,
    SessionAuthGuard,
  ],
  exports: [NightAuditScheduler, NightAuditRunner, NightAuditService],
})
export class NightAuditModule {}
