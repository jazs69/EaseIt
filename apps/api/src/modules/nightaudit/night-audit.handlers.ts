/**
 * The night audit's outbox handlers (NA-01, NA-04 step 8).
 *
 * NIGHT_AUDIT_RUN executes a run in the worker. A typed refusal (the run is
 * blocked on something a person must fix) is permanent: retrying cannot
 * change it, so the outbox does not spend its retry budget on it, and the
 * run resumes when the trigger is pressed again. Anything else is retried by
 * the outbox with its usual bounded backoff, and the run resumes where it
 * stopped.
 *
 * NIGHT_AUDIT_COMPLETED is where reports and notifications attach. None are
 * built yet, so it records that it was delivered and does nothing else.
 */

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  nightAuditCompletedPayloadSchema,
  nightAuditRunPayloadSchema,
  type OutboxEventType,
} from '@repo/types';

import { DomainError } from '../../common/errors/domain-error.js';
import {
  OutboxHandlerRegistry,
  OutboxPermanentError,
  type OutboxHandler,
  type OutboxHandlerContext,
} from '../platform/outbox/outbox-handler.registry.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NightAuditRunner } from './night-audit.runner.js';

@Injectable()
export class NightAuditRunHandler implements OutboxHandler {
  readonly eventType: OutboxEventType = 'NIGHT_AUDIT_RUN';

  constructor(
    private readonly runner: NightAuditRunner,
    private readonly prisma: PrismaService,
  ) {}

  async handle(context: OutboxHandlerContext): Promise<void> {
    const parsed = nightAuditRunPayloadSchema.safeParse(context.payload);
    if (!parsed.success) throw new OutboxPermanentError('Malformed NIGHT_AUDIT_RUN payload.');

    // The event's tenant must be the run's: a payload naming another
    // property's run is not executed.
    const run = await this.prisma.client.nightAuditRun.findFirst({
      where: { id: parsed.data.runId, propertyId: context.propertyId },
      select: { id: true },
    });
    if (run === null) throw new OutboxPermanentError('No such run for this property.');

    try {
      await this.runner.execute(run.id);
    } catch (error) {
      if (error instanceof DomainError) throw new OutboxPermanentError(error.message);
      throw error;
    }
  }
}

@Injectable()
export class NightAuditCompletedHandler implements OutboxHandler {
  readonly eventType: OutboxEventType = 'NIGHT_AUDIT_COMPLETED';
  private readonly logger = new Logger(NightAuditCompletedHandler.name);

  handle(context: OutboxHandlerContext): Promise<void> {
    const parsed = nightAuditCompletedPayloadSchema.safeParse(context.payload);
    if (!parsed.success) throw new OutboxPermanentError('Malformed NIGHT_AUDIT_COMPLETED payload.');
    this.logger.log(
      `Night audit ${parsed.data.businessDate} completed for property ${context.propertyId}; ` +
        'no report or notification is configured yet.',
    );
    return Promise.resolve();
  }
}

/** Registers both handlers once per process, before the worker starts draining. */
@Injectable()
export class NightAuditHandlerRegistrar implements OnModuleInit {
  constructor(
    private readonly registry: OutboxHandlerRegistry,
    private readonly run: NightAuditRunHandler,
    private readonly completed: NightAuditCompletedHandler,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.run);
    this.registry.register(this.completed);
  }
}
