import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { prisma } from '@repo/database';

/**
 * Wraps the @repo/database singleton in a Nest provider so the connection
 * lifecycle is tied to the application lifecycle.
 *
 * Connecting happens in `onModuleInit`, not in the constructor: startup work
 * in a constructor is invisible to Nest, so a failure there surfaces as an
 * unrelated error much later (CLAUDE.md section 5).
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /** The Prisma client. Repositories depend on this, never on a global import. */
  readonly client = prisma;

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
    this.logger.log('Connected to PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
    this.logger.log('Disconnected from PostgreSQL');
  }

  /** Cheap liveness probe for the health endpoint. */
  async ping(): Promise<boolean> {
    try {
      await this.client.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error('Database ping failed', error instanceof Error ? error.stack : error);
      return false;
    }
  }
}
