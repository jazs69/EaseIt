/**
 * Quote and create endpoints for reservations.
 *
 * `SessionAuthGuard` only, with the grant check inside the service: this route
 * is addressed by an explicit hotelId that may differ from the session's
 * active property, so a guard resolving "the active property" would answer for
 * the wrong one (CLAUDE.md section 3.2).
 */

import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  createReservationSchema,
  reservationQuoteRequestSchema,
  type CreateReservationCommand,
  type CreatedReservation,
  type ReservationQuote,
  type ReservationQuoteRequest,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CreateReservationService } from './create-reservation.service.js';

@ApiTags('reservations')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class CreateReservationController {
  constructor(private readonly reservations: CreateReservationService) {}

  @Post(':hotelId/reservations/quote')
  @ApiOperation({
    summary: 'Price a stay without reserving anything',
    description:
      'Advisory only. Takes no locks and makes no promise: the booking ' +
      're-derives the same figures inside its transaction, so a stale quote ' +
      'can never become a wrong charge.',
  })
  @ApiOkResponse({ description: 'Nightly split, tax band and totals.' })
  quote(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(reservationQuoteRequestSchema))
    body: ReservationQuoteRequest,
  ): Promise<ReservationQuote> {
    return this.reservations.quote(this.userId(request), hotelId, body);
  }

  @Post(':hotelId/reservations')
  @ApiOperation({
    summary: 'Create a reservation',
    description:
      'Runs in one transaction: inventory rows are locked in stay-date order, ' +
      'sold is incremented under the oversell CHECK, and the room assignment ' +
      'is written under the overlap exclusion constraint. Totals are computed ' +
      'server-side and never accepted from the client.',
  })
  @ApiCreatedResponse({ description: 'The booking, with its priced quote.' })
  @ApiConflictResponse({ description: 'The room or room type is no longer available.' })
  create(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(createReservationSchema)) body: CreateReservationCommand,
  ): Promise<CreatedReservation> {
    return this.reservations.create(this.userId(request), hotelId, body);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
