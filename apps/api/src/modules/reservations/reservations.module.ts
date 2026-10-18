import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { CheckInController } from './check-in.controller.js';
import { CheckInService } from './check-in.service.js';
import { CreateReservationController } from './create-reservation.controller.js';
import { CreateReservationService } from './create-reservation.service.js';
import { ReservationDetailController } from './reservation-detail.controller.js';
import { ReservationDetailService } from './reservation-detail.service.js';
import { ReservationSearchController } from './reservation-search.controller.js';
import { ReservationSearchRepository } from './reservation-search.repository.js';
import { ReservationSearchService } from './reservation-search.service.js';

/**
 * The `reservations` bounded context.
 *
 * Only search lives here today. The booking lifecycle — create, modify, move,
 * cancel — belongs here too and is not built yet; when it is, it brings the
 * state machine and the transactional write paths with it (CLAUDE.md sections
 * 2 and 3.1).
 *
 * `TokenService` and `SessionAuthGuard` are provided locally, as every module
 * with a guarded controller must: Nest resolves a controller-level guard's
 * dependencies from the module that declares the controller, so omitting
 * `TokenService` here fails at boot with "Nest can't resolve dependencies of
 * the SessionAuthGuard" rather than at request time. `PrismaService` and
 * `ClockService` arrive from the global modules.
 */
@Module({
  controllers: [
    ReservationSearchController,
    CreateReservationController,
    CheckInController,
    // Registered last: its `:reservationId` route would otherwise shadow the
    // literal sibling paths above it, and `/reservations/quote` would be read
    // as a reservation whose id is "quote".
    ReservationDetailController,
  ],
  providers: [
    CheckInService,
    CreateReservationService,
    ReservationDetailService,
    ReservationSearchService,
    ReservationSearchRepository,
    TokenService,
    SessionAuthGuard,
  ],
  exports: [
    ReservationSearchService,
    CreateReservationService,
    CheckInService,
    ReservationDetailService,
  ],
})
export class ReservationsModule {}
