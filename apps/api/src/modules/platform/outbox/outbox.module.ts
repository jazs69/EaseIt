/**
 * The outbox, wired.
 *
 * ===========================================================================
 * One module, two process roles.
 *
 * The **API** imports this for `OutboxService` alone, so a request handler can
 * record a side effect inside its transaction. It never constructs a Redis
 * connection, never starts the dispatcher and never starts the worker -- so
 * Redis being down cannot stop the API from booting or serving, which is what
 * requirement 5 asks for.
 *
 * The **worker** process calls `startProcessing()`, which begins the dispatch
 * loop and the BullMQ consumer. That is why starting is an explicit call
 * rather than `OnModuleInit`: otherwise every API instance would start
 * draining the queue, and three API replicas would mean three dispatchers
 * nobody asked for.
 * ===========================================================================
 */

import { Injectable, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { OutboxSelfTestHandler } from './handlers/self-test.handler.js';
import { OutboxDispatcherService } from './outbox-dispatcher.service.js';
import { OutboxHandlerRegistry } from './outbox-handler.registry.js';
import { OutboxMetricsService } from './outbox-metrics.service.js';
import { OutboxQueue } from './outbox.queue.js';
import { OutboxService } from './outbox.service.js';
import { OutboxWorker } from './outbox.worker.js';

/**
 * Starts and stops the background half.
 *
 * A thin service rather than logic in the entry point, so the lifecycle is
 * owned by Nest and `app.enableShutdownHooks()` -- already called in
 * `main.ts` -- shuts it down in the right order.
 */
@Injectable()
export class OutboxRuntime implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxRuntime.name);
  private backlogTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(
    private readonly registry: OutboxHandlerRegistry,
    private readonly selfTest: OutboxSelfTestHandler,
    private readonly dispatcher: OutboxDispatcherService,
    private readonly worker: OutboxWorker,
    private readonly metrics: OutboxMetricsService,
    private readonly config: ConfigService,
  ) {}

  /** Registers handlers, then starts the dispatcher and the consumer. */
  startProcessing(): void {
    if (this.started) return;
    this.started = true;

    // Phase A registers exactly one handler, and it is fake.
    this.registry.register(this.selfTest);

    this.worker.start();
    this.dispatcher.start();

    const intervalMs = this.config.get<number>('OUTBOX_BACKLOG_LOG_MS', 60_000);
    this.backlogTimer = setInterval(() => {
      void this.metrics.logBacklog().catch((cause: unknown) => {
        this.logger.warn(`Backlog logging failed: ${String(cause)}`);
      });
    }, intervalMs);

    this.logger.log('Outbox processing started.');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.backlogTimer !== null) {
      clearInterval(this.backlogTimer);
      this.backlogTimer = null;
    }
    await Promise.resolve();
  }
}

@Module({
  providers: [
    OutboxService,
    OutboxQueue,
    OutboxHandlerRegistry,
    OutboxMetricsService,
    OutboxDispatcherService,
    OutboxWorker,
    OutboxSelfTestHandler,
    OutboxRuntime,
  ],
  exports: [
    // The API needs the enqueue API and the backlog view. It does not get the
    // dispatcher or the worker, so it cannot accidentally start them.
    OutboxService,
    OutboxMetricsService,
    OutboxRuntime,
    OutboxQueue,
    OutboxSelfTestHandler,
  ],
})
export class OutboxModule {}
