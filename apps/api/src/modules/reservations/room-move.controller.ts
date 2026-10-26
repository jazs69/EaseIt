/**
 * Room assignment and moves.
 *
 * `SessionAuthGuard` only, with the grant and `rooms:assign` check inside the
 * service: the route is addressed by an explicit hotelId that may differ from
 * the session's active property, so a guard resolving "the active property"
 * would authorise against the wrong one (CLAUDE.md section 3.2).
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
  moveRoomSchema,
  type MoveRoomCommand,
  type MoveRoomOptions,
  type MoveRoomResult,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RoomMoveService } from './room-move.service.js';

@ApiTags('reservations')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class RoomMoveController {
  constructor(private readonly moves: RoomMoveService) {}

  @Get(':hotelId/reservations/:reservationId/room-options')
  @ApiOperation({
    summary: 'Rooms this stay could move into',
    description:
      'Same category first, free before occupied, then by number. Dirty rooms ' +
      'are listed and flagged rather than hidden: at 11am most of the house is ' +
      'dirty, and that is the shift when a move is most likely to be needed. ' +
      'Availability is advisory — the exclusion constraint is what guarantees ' +
      'it under concurrency.',
  })
  @ApiOkResponse({ description: 'The stay, its current room, and the candidates.' })
  @ApiNotFoundResponse({ description: 'No such reservation at a property you can access.' })
  options(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('reservationId') reservationId: string,
  ): Promise<MoveRoomOptions> {
    return this.moves.options(this.userId(request), hotelId, reservationId);
  }

  @Post(':hotelId/reservations/:reservationId/room')
  @ApiOperation({
    summary: 'Assign, move or unassign a room',
    description:
      'One transaction: the assignment changes under the overlap exclusion ' +
      'constraint, an in-house move vacates the room behind the guest as ' +
      'dirty, a cross-category move carries the inventory counter with it ' +
      'under the oversell CHECK, and an audit row records the move. ' +
      '`roomId: null` returns the stay to the unassigned queue.',
  })
  @ApiOkResponse({ description: 'Where the stay moved from and to.' })
  @ApiConflictResponse({ description: 'The room or category was taken for those nights.' })
  @ApiBadRequestResponse({ description: 'An unmovable status, or an unconfirmed category change.' })
  move(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('reservationId') reservationId: string,
    @Body(new ZodValidationPipe(moveRoomSchema)) body: MoveRoomCommand,
  ): Promise<MoveRoomResult> {
    return this.moves.move(this.userId(request), hotelId, reservationId, body);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
