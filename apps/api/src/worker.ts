/**
 * The worker process.
 *
 * ===========================================================================
 * Same codebase, same modules, different role.
 *
 * CLAUDE.md section 4 specifies `pnpm worker:dev` as a separate command, and
 * section 3.3 requires the night audit to run as a job rather than on a
 * request. Both want a process that is not the API. This is it.
 *
 * It boots the Nest application *context* rather than an HTTP server: there is
 * nothing to listen on, and binding a port would invite a load balancer to
 * send it traffic. Dependency injection, configuration validation and the
 * shutdown hooks all work exactly as they do in the API.
 *
 * Redis is required here and only here. If it is unreachable the worker exits
 * non-zero so a supervisor restarts it -- the opposite of the API, which must
 * keep serving when Redis is down (requirement 5).
 * ===========================================================================
 */

import 'reflect-metadata';
// Must precede every other import, for the same reason `main.ts` does it: the
// module graph below reaches @repo/database, which builds its Prisma client at
// module scope and needs DATABASE_URL already present.
import './config/load-env.js';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { OutboxQueue } from './modules/platform/outbox/outbox.queue.js';
import { OutboxRuntime } from './modules/platform/outbox/outbox.module.js';
import { PrismaService } from './prisma/prisma.service.js';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');

  // No HTTP server: `createApplicationContext` gives DI and lifecycle without
  // a listener.
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });

  // Ordered shutdown, so in-flight jobs finish or release their leases.
  app.enableShutdownHooks();

  /**
   * Dependencies are checked before any work starts.
   *
   * A worker that cannot reach PostgreSQL cannot record an outcome, and one
   * that cannot reach Redis cannot receive a job. Either way it has nothing
   * useful to do, so it exits rather than looping and logging. Requirement 5:
   * explicit failure criteria for unavailable dependencies.
   */
  const prisma = app.get(PrismaService);
  if (!(await prisma.ping())) {
    logger.error('PostgreSQL is unreachable; the worker cannot start.');
    await app.close();
    process.exit(1);
  }

  const queue = app.get(OutboxQueue);
  if (!(await queue.ping())) {
    logger.error(
      'Redis is unreachable; the worker cannot start. ' +
        'Check REDIS_URL and that a Redis server is running.',
    );
    await app.close();
    process.exit(1);
  }

  app.get(OutboxRuntime).startProcessing();

  logger.log('EaseIt worker running. Dependencies: PostgreSQL ok, Redis ok.');

  // Keep the process alive; the dispatcher's interval does the work.
  await new Promise<void>((resolve) => {
    const stop = (signal: string): void => {
      logger.log(`Received ${signal}; shutting down.`);
      void app.close().then(resolve);
    };
    process.once('SIGINT', () => {
      stop('SIGINT');
    });
    process.once('SIGTERM', () => {
      stop('SIGTERM');
    });
  });
}

bootstrap().catch((cause: unknown) => {
  // Plain console: a failure this early may precede the logger.
  console.error('Failed to start the EaseIt worker:', cause);
  process.exit(1);
});
