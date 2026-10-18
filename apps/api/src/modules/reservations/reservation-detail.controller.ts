/**
 * Reservation detail and its internal note log.
 *
 * `SessionAuthGuard` only, with the grant and permission check inside the
 * service: the route is addressed by an explicit hotelId that may differ from
 * the session's active property, so a guard resolving "the active property"
 * would authorise against the wrong one (CLAUDE.md section 3.2).
 */

import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  addReservationNoteSchema,
  type AddReservationNoteCommand,
  type ReservationDetail,
  type ReservationNoteView,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { ReservationDetailService } from './reservation-detail.service.js';

@ApiTags('reservations')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class ReservationDetailController {
  constructor(private readonly reservations: ReservationDetailService) {}

  @Get(':hotelId/reservations/:reservationId')
  @ApiOperation({
    summary: 'Everything the reservation drawer shows',
    description:
      'The stay, its guests, the company, the agreed figures, the posted ' +
      'folio when one exists, and the internal note log. Guest ID numbers are ' +
      'returned masked. `canCheckIn` and `canCheckOut` are decided here rather ' +
      'than inferred from the status in the browser.',
  })
  @ApiOkResponse({ description: 'The reservation, fully expanded.' })
  @ApiNotFoundResponse({ description: 'No such reservation at a property you can access.' })
  detail(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('reservationId') reservationId: string,
  ): Promise<ReservationDetail> {
    return this.reservations.detail(this.userId(request), hotelId, reservationId);
  }

  @Post(':hotelId/reservations/:reservationId/notes')
  @ApiOperation({
    summary: 'Append an internal note',
    description:
      'Append-only: notes are never edited or deleted. The author name is ' +
      'snapshotted onto the row so a renamed or departed account does not ' +
      'blank the byline on an older note.',
  })
  @ApiCreatedResponse({ description: 'The note, with its author and timestamp.' })
  @ApiBadRequestResponse({ description: 'An empty note.' })
  addNote(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('reservationId') reservationId: string,
    @Body(new ZodValidationPipe(addReservationNoteSchema)) body: AddReservationNoteCommand,
  ): Promise<ReservationNoteView> {
    return this.reservations.addNote(this.userId(request), hotelId, reservationId, body);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
