/**
 * Cancelling a reservation.
 *
 * `SessionAuthGuard` only, with the grant and the `reservations:edit` check
 * inside the service, for the same reason as the room-move route: the hotelId
 * is explicit in the path and may differ from the session's active property,
 * so a guard resolving "the active property" would authorise against the wrong
 * one (CLAUDE.md section 3.2).
 */

import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  cancelReservationSchema,
  type CancelReservationCommand,
  type CancelReservationResult,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CancelReservationService } from './cancel-reservation.service.js';

@ApiTags('reservations')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class CancelReservationController {
  constructor(private readonly cancellations: CancelReservationService) {}

  @Post(':hotelId/reservations/:reservationId/cancel')
  // 200, not Nest's default 201: this creates no resource, it transitions one.
  // Matches the convention the auth and properties controllers already use for
  // action POSTs.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a reservation and release its inventory',
    description:
      'One transaction: the reservation row is locked, the status and ' +
      '`cancelledAt` are set, every night the stay held is returned to ' +
      '`inventory_day`, the room rows become CANCELLED so the overlap ' +
      'exclusion constraint frees the room number, and an audit row records ' +
      'the actor and reason. **No money moves**: no fee is calculated, no ' +
      'refund is issued and no folio line is written — a retention charge, ' +
      'where one is due, is posted through the folio charge endpoint. ' +
      'Repeating the call is safe: an already-cancelled booking returns its ' +
      'existing cancellation and releases nothing further. This does not ' +
      'notify any channel or OTA.',
  })
  @ApiOkResponse({ description: 'The cancellation, and how many nights it released.' })
  @ApiConflictResponse({
    description: 'A checked-in, checked-out or no-show booking cannot be cancelled.',
  })
  @ApiBadRequestResponse({
    description: "Inventory counters disagree with the booking, so nothing was released.",
  })
  @ApiNotFoundResponse({ description: 'No such reservation at a property you can access.' })
  cancel(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('reservationId') reservationId: string,
    @Body(new ZodValidationPipe(cancelReservationSchema)) body: CancelReservationCommand,
  ): Promise<CancelReservationResult> {
    return this.cancellations.cancel(this.userId(request), hotelId, reservationId, body);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
