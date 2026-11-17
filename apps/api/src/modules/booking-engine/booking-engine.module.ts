/** The public booking engine: BE-01..BE-05, AV-08, AV-09. */

import { Module } from '@nestjs/common';

import { PaymentsModule } from '../payments/payments.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { AvailabilityCache } from './availability.cache.js';
import { BookingEngineController } from './booking-engine.controller.js';
import { BookingEngineRepository } from './booking-engine.repository.js';
import { BookingEngineService } from './booking-engine.service.js';
import { BookingTokens } from './booking-tokens.js';
import { PublicPropertyGuard } from './public-property.guard.js';

@Module({
  imports: [ReservationsModule, PaymentsModule],
  controllers: [BookingEngineController],
  providers: [
    BookingEngineService,
    BookingEngineRepository,
    BookingTokens,
    AvailabilityCache,
    PublicPropertyGuard,
  ],
})
export class BookingEngineModule {}
