/**
 * The arrivals / departures board (FD-09).
 *
 * `SessionAuthGuard` binds the route's property; the grant and
 * `reservations:read` check is in the service, which also decides whether
 * balances are shown (CLAUDE.md section 3.2).
 */

import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FrontDeskBoard } from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { FrontDeskBoardService } from './front-desk-board.service.js';

@ApiTags('frontdesk')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class FrontDeskBoardController {
  constructor(private readonly boards: FrontDeskBoardService) {}

  @Get(':hotelId/front-desk/board')
  @ApiOperation({
    summary: 'Arrivals, departures and in-house for the business date',
    description:
      'Includes overdue arrivals (confirmed, arrival passed, not checked in) and overstays ' +
      '(checked in, departure passed). Balances are the posted folio balance and are null ' +
      'for a caller without folio:read.',
  })
  @ApiOkResponse({ description: 'The board.' })
  @ApiForbiddenResponse({ description: 'No reservations:read at this property.' })
  @ApiNotFoundResponse({ description: 'No such property among your grants.' })
  board(@Req() request: FastifyRequest, @Param('hotelId') hotelId: string): Promise<FrontDeskBoard> {
    return this.boards.board(this.userId(request), hotelId);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
