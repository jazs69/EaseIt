import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PropertyContextService } from './common/context/property-context.service.js';
import { validateEnv } from './config/env.js';
import { HealthModule } from './modules/health/health.module.js';
import { RbacModule } from './modules/rbac/rbac.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

/**
 * The root of the modular monolith.
 *
 * One module per bounded context (CLAUDE.md section 2). Modules talk through
 * injected services and an in-process event bus, never over HTTP, and never
 * via forwardRef: a circular dependency means the boundary is drawn wrong.
 *
 * Feature modules still to come: auth, properties, inventory, rates,
 * reservations, frontdesk, folios, housekeeping, nightaudit, channels,
 * booking-engine, reporting.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      envFilePath: ['.env.local', '.env'],
    }),
    PrismaModule,
    HealthModule,
    RbacModule,
  ],
  providers: [PropertyContextService],
  exports: [PropertyContextService],
})
export class AppModule {}
