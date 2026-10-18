import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateEnv } from './config/env.js';
import { AccessControlModule } from './modules/access-control/access-control.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CalendarModule } from './modules/calendar/calendar.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { CompaniesModule } from './modules/companies/companies.module.js';
import { PerformanceModule } from './modules/performance/performance.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { FoliosModule } from './modules/folios/folios.module.js';
import { ReservationsModule } from './modules/reservations/reservations.module.js';
import { PropertiesModule } from './modules/properties/properties.module.js';
import { PropertyDashboardModule } from './modules/property-dashboard/property-dashboard.module.js';
import { TimelineModule } from './modules/timeline/timeline.module.js';
import { RbacModule } from './modules/rbac/rbac.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

/**
 * The root of the modular monolith.
 *
 * One module per bounded context (CLAUDE.md section 2). Modules talk through
 * injected services and an in-process event bus, never over HTTP, and never
 * via forwardRef: a circular dependency means the boundary is drawn wrong.
 *
 * Feature modules still to come: inventory, rates, reservations, frontdesk,
 * folios, housekeeping, nightaudit, channels, booking-engine, reporting.
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
    PlatformModule,
    HealthModule,
    AuthModule,
    PropertiesModule,
    CompaniesModule,
    PerformanceModule,
    ReportsModule,
    ReservationsModule,
    FoliosModule,
    CalendarModule,
    PropertyDashboardModule,
    TimelineModule,
    RbacModule,
    AccessControlModule,
  ],
})
export class AppModule {}
