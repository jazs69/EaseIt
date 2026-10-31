/**
 * The checkout endpoint.
 *
 * One route, mirroring the shape of `cancel-reservation.controller.ts`: the
 * service owns every decision, the controller only resolves the caller and
 * validates the body. Errors become HTTP statuses through
 * `DomainExceptionFilter`, so nothing here builds an error response
 * (CLAUDE.md section 5).
 */

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { checkOutSchema, type CheckOutCommand, type CheckOutResult } from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CheckOutService } from './check-out.service.js';

@ApiTags('reservations')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class CheckOutController {
  constructor(private readonly checkOuts: CheckOutService) {}

  @Post(':hotelId/reservations/:reservationId/check-out')
  /**
   * 200, not Nest's default 201.
   *
   * Checkout creates no resource: it transitions a reservation, closes an
   * existing folio and updates an existing room. `cancel` forces 200 for the
   * same reason, while `check-in` is left at 201 because it genuinely does
   * create a folio and its lines. A 201 here would also make the idempotent
   * replay claim it had created something.
   */
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check a guest out',
    description:
      'One transaction: the reservation moves to CHECKED_IN → CHECKED_OUT, the ' +
      'folio closes, the room goes back as VACANT_DIRTY, and an audit row is ' +
      'written. The balance is summed from the folio lines inside that ' +
      'transaction and must be exactly zero — an amount due, or a credit, ' +
      'refuses the checkout and changes nothing. Inventory is deliberately ' +
      'untouched: a departed stay still holds the nights it slept in. A stay ' +
      'that is already checked out answers 200 and writes nothing.',
  })
  @ApiOkResponse({ description: 'The departed stay, its closed folio and the released room.' })
  @ApiConflictResponse({
    description:
      'The stay is not in house (`INVALID_STATE_TRANSITION`), the folio has a ' +
      'balance (`OUTSTANDING_BALANCE`), or the row was contended ' +
      '(`CONFLICT`).',
  })
  @ApiForbiddenResponse({ description: 'The caller lacks `reservations:checkout`.' })
  @ApiNotFoundResponse({ description: 'No such reservation at a property you can access.' })
  checkOut(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('reservationId') reservationId: string,
    @Body(new ZodValidationPipe(checkOutSchema)) body: CheckOutCommand,
  ): Promise<CheckOutResult> {
    return this.checkOuts.checkOut(this.userId(request), hotelId, reservationId, body);
  }

  /** The session guard has already run; this only narrows the type. */
  private userId(request: FastifyRequest): string {
    const user = (request as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
