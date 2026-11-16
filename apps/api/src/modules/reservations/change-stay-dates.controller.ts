/**
 * Changing a stay's dates (RS-11, RS-12).
 *
 * `SessionAuthGuard` only, with the grant and `reservations:edit` check inside
 * the service: the route names its hotel explicitly (CLAUDE.md section 3.2).
 */

import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
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
  changeStayDatesSchema,
  type ChangeStayDatesCommand,
  type ChangeStayDatesPreview,
  type ChangeStayDatesResult,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { ChangeStayDatesService } from './change-stay-dates.service.js';

@ApiTags('reservations')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class ChangeStayDatesController {
  constructor(private readonly dates: ChangeStayDatesService) {}

  @Post(':hotelId/reservations/:reservationId/dates/preview')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Preview a date change',
    description:
      'The nights that would join and leave the stay, at their prices, and the new total. ' +
      'Advisory: nothing is locked or reserved.',
  })
  @ApiOkResponse({ description: 'Current and proposed spans, nights added and removed.' })
  @ApiNotFoundResponse({ description: 'No such reservation at a property you can access.' })
  preview(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('reservationId') reservationId: string,
    @Body(new ZodValidationPipe(changeStayDatesSchema)) body: ChangeStayDatesCommand,
  ): Promise<ChangeStayDatesPreview> {
    return this.dates.preview(this.userId(request), hotelId, reservationId, body);
  }

  @Post(':hotelId/reservations/:reservationId/dates')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change, extend or shorten a stay',
    description:
      'One transaction: removed nights are released and added nights sold under the ' +
      'oversell CHECK, the room keeps its number only if the overlap constraint allows, ' +
      'kept nights keep their price, and an audit row records the change. A checked-in ' +
      'stay can move only its departure, and never before a night already charged.',
  })
  @ApiOkResponse({ description: 'The change as applied.' })
  @ApiConflictResponse({ description: 'A new night is sold out, or the room is taken.' })
  @ApiBadRequestResponse({ description: 'A refused status, date or price mismatch.' })
  change(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('reservationId') reservationId: string,
    @Body(new ZodValidationPipe(changeStayDatesSchema)) body: ChangeStayDatesCommand,
  ): Promise<ChangeStayDatesResult> {
    return this.dates.change(this.userId(request), hotelId, reservationId, body);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
