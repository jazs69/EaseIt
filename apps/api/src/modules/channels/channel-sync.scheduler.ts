/**
 * Decides when each connection is pushed, pulled and applied (CM-03, CM-04).
 * Run by the worker only.
 *
 * ===========================================================================
 * One tick, under a transaction-scoped advisory lock so two worker processes
 * never schedule at once, looks at every ACTIVE connection (and every one
 * with stored messages waiting) and enqueues, through the outbox:
 *
 *   CHANNEL_ARI_PUSH       when change rows exist and the oldest has settled
 *                          for CHANNEL_ARI_DEBOUNCE_MS -- a burst of edits is
 *                          one push;
 *   CHANNEL_BOOKINGS_PULL  every CHANNEL_PULL_INTERVAL_MS;
 *   CHANNEL_INBOUND_APPLY  when stored messages are waiting.
 *
 * Each only when no job of that kind is PENDING or IN_FLIGHT for the
 * connection. That single rule is the per-connection ordering CM-03 needs:
 * two pushes of one hotel can never be in flight together, so an older state
 * can never reach the provider after a newer one. After a DEAD job the kind
 * waits CHANNEL_DEAD_COOLDOWN before starting again -- so work is retried
 * until acknowledged, and the dead-letter alert repeats at that pace rather
 * than on every tick.
 *
 * Off unless CHANNEL_SYNC_SCHEDULER is true, or in production by default,
 * like the night-audit scheduler: a developer's worker must not call a
 * provider by surprise.
 * ===========================================================================
 */

import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withoutTenantScope } from '@repo/database';
import type { OutboxEventType } from '@repo/types';

import { PrismaService } from '../../prisma/prisma.service.js';
import { OutboxService, type OutboxWriter } from '../platform/outbox/outbox.service.js';

/** How long a dead-lettered kind waits before the scheduler starts it again. */
const DEAD_COOLDOWN_SECONDS = 900;
/** Retry budget per job; the outbox's backoff spreads these over ~20 minutes. */
const JOB_ATTEMPTS = 8;

export const dedupeKeyFor = (kind: OutboxEventType, connectionId: string): string =>
  `${kind === 'CHANNEL_ARI_PUSH' ? 'channel-ari' : kind === 'CHANNEL_BOOKINGS_PULL' ? 'channel-pull' : 'channel-apply'}:${connectionId}`;

export interface ChannelTickResult {
  enqueued: { connectionId: string; kind: OutboxEventType }[];
}

@Injectable()
export class ChannelSyncScheduler implements OnModuleDestroy {
  private readonly logger = new Logger(ChannelSyncScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly config: ConfigService,
  ) {}

  get enabled(): boolean {
    const explicit = this.config.get<boolean | undefined>('CHANNEL_SYNC_SCHEDULER');
    return explicit ?? this.config.get<string>('NODE_ENV') === 'production';
  }

  start(): void {
    if (this.timer !== null) return;
    if (!this.enabled) {
      this.logger.log('Channel sync scheduler is off (CHANNEL_SYNC_SCHEDULER).');
      return;
    }
    const every = this.config.get<number>('CHANNEL_SYNC_TICK_MS', 5_000);
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.tick()
        .catch((cause: unknown) => {
          this.logger.error(
            `Channel sync tick failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        })
        .finally(() => {
          this.running = false;
        });
    }, every);
    this.logger.log(`Channel sync scheduler on; checking every ${String(every)} ms.`);
  }

  /** One pass. Public so a test can drive it; `connectionIds` narrows it to a suite's own. */
  tick(connectionIds?: readonly string[]): Promise<ChannelTickResult> {
    // Reads every property's connections: the same system-process exception
    // the outbox dispatcher and the night-audit schedule use (section 3.2).
    return withoutTenantScope('channel sync scheduling', () => this.schedule(connectionIds));
  }

  private async schedule(connectionIds?: readonly string[]): Promise<ChannelTickResult> {
    const debounceMs = this.config.get<number>('CHANNEL_ARI_DEBOUNCE_MS', 2_000);
    const pullMs = this.config.get<number>('CHANNEL_PULL_INTERVAL_MS', 60_000);
    const result: ChannelTickResult = { enqueued: [] };

    await this.prisma.client.$transaction(async (tx) => {
      const [lock] = await tx.$queryRaw<{ ok: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext('easeit:channel-sync-scheduler')) AS ok`;
      if (lock?.ok !== true) return; // another worker is scheduling right now

      const only = connectionIds === undefined ? undefined : [...connectionIds];
      // Times are compared in SQL against the database clock, like the outbox.
      const due = await tx.$queryRaw<
        {
          id: string;
          property_id: string;
          active: boolean;
          ari_due: boolean;
          pull_due: boolean;
          apply_due: boolean;
        }[]
      >`
        SELECT c."id", c."propertyId" AS property_id, c."status" = 'ACTIVE' AS active,
               EXISTS (SELECT 1 FROM "channel_ari_change" a
                        WHERE a."connectionId" = c."id"
                          AND a."createdAt" <= now() - make_interval(secs => ${debounceMs / 1_000})) AS ari_due,
               (c."lastPulledAt" IS NULL
                 OR c."lastPulledAt" <= now() - make_interval(secs => ${pullMs / 1_000})) AS pull_due,
               EXISTS (SELECT 1 FROM "channel_inbound_message" m
                        WHERE m."connectionId" = c."id" AND m."status" = 'RECEIVED') AS apply_due
          FROM "channel_connection" c
         WHERE (c."status" = 'ACTIVE'
                OR EXISTS (SELECT 1 FROM "channel_inbound_message" m
                            WHERE m."connectionId" = c."id" AND m."status" = 'RECEIVED'))
           AND (${only === undefined} OR c."id" = ANY(${only ?? []}::uuid[]))
      `;

      for (const row of due) {
        const wanted: OutboxEventType[] = [];
        if (row.active && row.ari_due) wanted.push('CHANNEL_ARI_PUSH');
        if (row.active && row.pull_due) wanted.push('CHANNEL_BOOKINGS_PULL');
        if (row.apply_due) wanted.push('CHANNEL_INBOUND_APPLY');
        for (const kind of wanted) {
          const key = dedupeKeyFor(kind, row.id);
          const busy = await tx.$queryRaw<{ busy: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM "outbox_event"
               WHERE "propertyId" = ${row.property_id}::uuid
                 AND "dedupeKey" = ${key}
                 AND ("status" IN ('PENDING', 'IN_FLIGHT')
                      OR ("status" = 'DEAD'
                          AND "completedAt" > now() - make_interval(secs => ${DEAD_COOLDOWN_SECONDS})))
            ) AS busy`;
          if (busy[0]?.busy === true) continue;
          await this.outbox.enqueue(tx as unknown as OutboxWriter, {
            propertyId: row.property_id,
            eventType: kind,
            payload: { connectionId: row.id },
            dedupeKey: key,
            dedupeMode: 'COALESCE',
            maxAttempts: JOB_ATTEMPTS,
          });
          result.enqueued.push({ connectionId: row.id, kind });
        }
      }
    });
    return result;
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
