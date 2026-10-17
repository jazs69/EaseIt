/**
 * Check-in endpoints.
 *
 * `SessionAuthGuard` only, with the grant and permission check inside the
 * service: the route is addressed by an explicit hotelId that may differ from
 * the session's active property, so a guard resolving "the active property"
 * would authorise against the wrong one (CLAUDE.md section 3.2). The service
 * also owns the permission check, because checking a guest in is a front-desk
 * action that a housekeeping grant must not imply.
 */

import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
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
  checkInRequestSchema,
  type CheckInPreflight,
  type CheckInRequest,
  type CheckInResult,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CheckInService } from './check-in.service.js';

@ApiTags('reservations')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class CheckInController {
  constructor(private readonly checkIns: CheckInService) {}

  @Get(':hotelId/reservations/:reservationId/check-in')
  @ApiOperation({
    summary: 'What the check-in modal needs, committing to nothing',
    description:
      'Returns the stay, the folio balance, the rooms that are actually free, ' +
      'and a list of blockers — so the desk sees what is missing when the ' +
      'modal opens rather than on a failed submit. Takes no locks and changes ' +
      'nothing; the write path re-derives every blocker inside its transaction.',
  })
  @ApiOkResponse({ description: 'Stay summary, free rooms, and outstanding blockers.' })
  @ApiNotFoundResponse({ description: 'No such reservation at a property you can access.' })
  preflight(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('reservationId') reservationId: string,
  ): Promise<CheckInPreflight> {
    return this.checkIns.preflight(this.userId(request), hotelId, reservationId);
  }

  @Post(':hotelId/reservations/:reservationId/check-in')
  @ApiOperation({
    summary: 'Check a guest in',
    description:
      'One transaction: the reservation moves to CHECKED_IN, the assignment ' +
      'and the room status follow it, a folio is opened, the arrival night and ' +
      'its tax are posted as separate lines, any advance is posted negative, ' +
      'and an audit row is written. A dirty room refuses the check-in unless ' +
      'the clerk acknowledges it, and the acknowledgement lands on the audit row.',
  })
  @ApiOkResponse({ description: 'The checked-in stay with its opened folio.' })
  @ApiConflictResponse({ description: 'The reservation is not in a state that can check in.' })
  @ApiBadRequestResponse({ description: 'A blocker is unresolved — see `details.issues`.' })
  checkIn(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('reservationId') reservationId: string,
    @Body(new ZodValidationPipe(checkInRequestSchema)) body: CheckInRequest,
  ): Promise<CheckInResult> {
    return this.checkIns.checkIn(this.userId(request), hotelId, reservationId, body);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
