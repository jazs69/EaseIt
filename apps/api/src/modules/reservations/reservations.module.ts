import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { CancelReservationController } from './cancel-reservation.controller.js';
import { CancelReservationService } from './cancel-reservation.service.js';
import { CheckInController } from './check-in.controller.js';
import { CheckInService } from './check-in.service.js';
import { CheckOutController } from './check-out.controller.js';
import { CheckOutService } from './check-out.service.js';
import { CreateReservationController } from './create-reservation.controller.js';
import { CreateReservationService } from './create-reservation.service.js';
import { ReservationDetailController } from './reservation-detail.controller.js';
import { RoomMoveController } from './room-move.controller.js';
import { RoomMoveService } from './room-move.service.js';
import { ReservationDetailService } from './reservation-detail.service.js';
import { ReservationSearchController } from './reservation-search.controller.js';
import { ReservationSearchRepository } from './reservation-search.repository.js';
import { ReservationSearchService } from './reservation-search.service.js';
import { PropertiesModule } from '../properties/properties.module.js';

/**
 * The `reservations` bounded context.
 *
 * Search, creation, check-in, room moves and cancellation live here. Modifying
 * dates is the remaining lifecycle gap. `reservation.state.ts` holds the
 * transition rules the cancellation path needs; check-in keeps its own blocker
 * list until a third caller justifies unifying them (CLAUDE.md sections 2 and
 * 3.1).
 *
 * `TokenService` and `SessionAuthGuard` are provided locally, as every module
 * with a guarded controller must: Nest resolves a controller-level guard's
 * dependencies from the module that declares the controller, so omitting
 * `TokenService` here fails at boot with "Nest can't resolve dependencies of
 * the SessionAuthGuard" rather than at request time. `PrismaService` and
 * `ClockService` arrive from the global modules.
 */
@Module({
  // Tax slabs are resolved through `PropertyTaxService` (section 2 puts tax
  // rules in the properties module), so that module is imported rather than
  // its service re-provided here.
  imports: [PropertiesModule],
  controllers: [
    ReservationSearchController,
    CreateReservationController,
    CheckInController,
    RoomMoveController,
    // Before the detail controller for the same reason it is: `/cancel` is a
    // literal segment under `:reservationId`, and the detail route would
    // otherwise swallow it.
    CancelReservationController,
    // `/check-out` is a literal segment under `:reservationId` as well, so it
    // is registered above the detail controller for the same reason.
    CheckOutController,
    // Registered last: its `:reservationId` route would otherwise shadow the
    // literal sibling paths above it, and `/reservations/quote` would be read
    // as a reservation whose id is "quote".
    ReservationDetailController,
  ],
  providers: [
    CancelReservationService,
    CheckInService,
    CheckOutService,
    CreateReservationService,
    ReservationDetailService,
    RoomMoveService,
    ReservationSearchService,
    ReservationSearchRepository,
    TokenService,
    SessionAuthGuard,
  ],
  exports: [
    CancelReservationService,
    ReservationSearchService,
    CreateReservationService,
    CheckInService,
    CheckOutService,
    ReservationDetailService,
    RoomMoveService,
  ],
})
export class ReservationsModule {}
