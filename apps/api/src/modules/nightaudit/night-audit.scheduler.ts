/**
 * The per-property night-audit schedule (NA-03), run by the worker.
 *
 * ===========================================================================
 * One tick looks at every operable property and asks `auditDue` -- in that
 * property's own IANA timezone -- whether its business date is due. Due
 * properties get a run enqueued through the same path as the manual trigger,
 * which is idempotent, so a tick that fires twice enqueues once.
 *
 * Properties are independent: each is judged and enqueued in its own
 * try/catch, so one property's failure is logged and the tick carries on to
 * the next. The audit itself runs later, per property, as its own outbox job.
 *
 * Off unless NIGHT_AUDIT_SCHEDULER is true, or in production by default --
 * see `env.ts` for why a development worker must not start it by surprise.
 * ===========================================================================
 */

import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OPERABLE_PROPERTY_STATUSES, type BusinessDate } from '@repo/types';

import { PrismaService } from '../../prisma/prisma.service.js';
import { ClockService } from '../platform/clock.service.js';
import { auditDue } from './night-audit.schedule.js';
import { NightAuditService } from './night-audit.service.js';

export interface SchedulerTickResult {
  enqueued: string[];
  failed: { propertyId: string; error: string }[];
}

@Injectable()
export class NightAuditScheduler implements OnModuleDestroy {
  private readonly logger = new Logger(NightAuditScheduler.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly audits: NightAuditService,
    private readonly config: ConfigService,
  ) {}

  /** True when this process should run the schedule. */
  get enabled(): boolean {
    const explicit = this.config.get<boolean | undefined>('NIGHT_AUDIT_SCHEDULER');
    return explicit ?? this.config.get<string>('NODE_ENV') === 'production';
  }

  start(): void {
    if (this.timer !== null || !this.enabled) {
      if (!this.enabled) this.logger.log('Night-audit scheduler is off (NIGHT_AUDIT_SCHEDULER).');
      return;
    }
    const every = this.config.get<number>('NIGHT_AUDIT_TICK_MS', 60_000);
    this.timer = setInterval(() => {
      void this.tick().catch((cause: unknown) => {
        this.logger.error(`Night-audit tick failed: ${String(cause)}`);
      });
    }, every);
    this.logger.log(`Night-audit scheduler on; checking every ${String(every)} ms.`);
  }

  /** One pass over every property. Public so it can be driven by a test. */
  async tick(propertyIds?: readonly string[]): Promise<SchedulerTickResult> {
    const now = this.clock.now();
    const auditTime = this.config.get<string>('NIGHT_AUDIT_LOCAL_TIME', '03:00');
    const properties = await this.prisma.client.property.findMany({
      where: {
        status: { in: [...OPERABLE_PROPERTY_STATUSES] },
        ...(propertyIds === undefined ? {} : { id: { in: [...propertyIds] } }),
      },
      select: { id: true, timezone: true, businessDate: true },
    });

    const result: SchedulerTickResult = { enqueued: [], failed: [] };
    for (const property of properties) {
      try {
        const verdict = auditDue({
          businessDate: property.businessDate.toISOString().slice(0, 10) as BusinessDate,
          timeZone: property.timezone,
          now,
          auditTime,
        });
        if (!verdict.due) continue;
        const started = await this.audits.enqueueForProperty(property.id, null);
        if (started.outcome !== 'EXISTING') result.enqueued.push(property.id);
      } catch (cause) {
        // One property's failure does not stop the others (NA-03).
        result.failed.push({ propertyId: property.id, error: String(cause) });
        this.logger.error(`Night-audit schedule failed for property ${property.id}: ${String(cause)}`);
      }
    }
    return result;
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
