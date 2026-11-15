import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createTenantClient, onTenantScopeBypass, prisma } from '@repo/database';

/**
 * The application's database client.
 *
 * `client` is the tenant-scoped client (MT-03/MT-04): every query on a
 * property-scoped model is narrowed to the request's property and runs with
 * the row-level-security settings for it. A tenant-scoped query with no
 * property bound throws. Cross-property work names itself through
 * `withoutTenantScope(reason, ...)`, logged here.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  readonly client = createTenantClient(prisma);

  constructor() {
    onTenantScopeBypass((reason) => {
      this.logger.debug(`Cross-property access: ${reason}`);
    });
  }

  async onModuleInit(): Promise<void> {
    await prisma.$connect();
    this.logger.log('Connected to PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await prisma.$disconnect();
    this.logger.log('Disconnected from PostgreSQL');
  }

  async ping(): Promise<boolean> {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error('Database ping failed', error instanceof Error ? error.stack : error);
      return false;
    }
  }
}
