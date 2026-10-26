/**
 * Folio reads and postings.
 *
 * `SessionAuthGuard` only, with the grant and permission checks inside the
 * service: the route is addressed by an explicit hotelId that may differ from
 * the session's active property, so a guard resolving "the active property"
 * would authorise against the wrong one (CLAUDE.md section 3.2).
 *
 * Each posting returns the whole recomputed page rather than the line it
 * created. The balance, the breakdown and every total are derived from the
 * ledger, so a client that patched one line into local state would have to
 * re-derive all of them and would eventually re-derive one of them
 * differently.
 */

import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  correctFolioChargeSchema,
  correctRoomChargesSchema,
  postFolioChargeSchema,
  postFolioDiscountSchema,
  postFolioPaymentSchema,
  type CorrectFolioChargeCommand,
  type CorrectRoomChargesCommand,
  type FolioPage,
  type PostFolioChargeCommand,
  type PostFolioDiscountCommand,
  type PostFolioPaymentCommand,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { FoliosService } from './folios.service.js';

@ApiTags('folios')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class FoliosController {
  constructor(private readonly folios: FoliosService) {}

  @Get(':hotelId/folios/by-booking/:bookingCode')
  @ApiOperation({
    summary: 'The billing page for one booking',
    description:
      'Addressed by the booking code a clerk reads aloud, scoped to the ' +
      "caller's own grant — the same code at another hotel is a different " +
      'booking and is not reachable. Returns the stay, the posted ' +
      'transactions, and every total summed from the ledger. A confirmed stay ' +
      'with no folio yet returns its details and an empty ledger rather than ' +
      'a 404.',
  })
  @ApiOkResponse({ description: 'Stay, transactions, totals and breakdown.' })
  @ApiNotFoundResponse({ description: 'No such booking at a property you can access.' })
  byBooking(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('bookingCode') bookingCode: string,
  ): Promise<FolioPage> {
    return this.folios.byBookingCode(this.userId(request), hotelId, bookingCode);
  }

  @Post(':hotelId/folios/by-booking/:bookingCode/payment')
  @ApiOperation({
    summary: 'Record a payment, opening the folio if there is not one yet',
    description:
      'For a booking that has never been checked in and therefore has no ' +
      'folio. The container is created, the payment posted and an audit row ' +
      'written — all from a deliberate act by a named clerk, which is what ' +
      'separates this from a read quietly backfilling the books. No charges ' +
      'are invented: nights are charged when they are consumed.',
  })
  @ApiOkResponse({ description: 'The recomputed folio page.' })
  @ApiNotFoundResponse({ description: 'No such booking at a property you can access.' })
  paymentByBooking(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('bookingCode') bookingCode: string,
    @Body(new ZodValidationPipe(postFolioPaymentSchema)) body: PostFolioPaymentCommand,
  ): Promise<FolioPage> {
    return this.folios.postPaymentByBooking(this.userId(request), hotelId, bookingCode, body);
  }

  @Post(':hotelId/folios/:folioId/charge')
  @ApiOperation({
    summary: 'Post an outlet or incidental charge',
    description:
      'Food, laundry, minibar. Tax is supplied explicitly rather than derived ' +
      "from the property's room-tax rate: an outlet item may be zero-rated or " +
      'sit in a different slab.',
  })
  @ApiOkResponse({ description: 'The recomputed folio page.' })
  @ApiConflictResponse({ description: 'The folio is closed.' })
  @ApiForbiddenResponse({ description: 'Requires folio:charge.' })
  charge(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('folioId') folioId: string,
    @Body(new ZodValidationPipe(postFolioChargeSchema)) body: PostFolioChargeCommand,
  ): Promise<FolioPage> {
    return this.folios.postCharge(this.userId(request), hotelId, folioId, body);
  }

  @Post(':hotelId/folios/:folioId/payment')
  @ApiOperation({
    summary: 'Record a payment',
    description:
      'Stored as a negative line so the balance stays one plain sum, and ' +
      "posted to the property's business date rather than `now()` — a payment " +
      'taken at 00:30 belongs to the open accounting day.',
  })
  @ApiOkResponse({ description: 'The recomputed folio page.' })
  @ApiConflictResponse({ description: 'The folio is closed.' })
  @ApiBadRequestResponse({ description: 'A non-positive amount.' })
  payment(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('folioId') folioId: string,
    @Body(new ZodValidationPipe(postFolioPaymentSchema)) body: PostFolioPaymentCommand,
  ): Promise<FolioPage> {
    return this.folios.postPayment(this.userId(request), hotelId, folioId, body);
  }

  @Post(':hotelId/folios/:folioId/lines/:lineId/correct')
  @ApiOperation({
    summary: 'Correct a posted charge to a new gross',
    description:
      'Posts the difference as an ADJUSTMENT referencing the original, with ' +
      'its own tax line — the original line is never updated, because a folio ' +
      'line is immutable (CLAUDE.md section 3.4). The table folds the ' +
      'correction into the charge so a clerk sees the corrected gross, while ' +
      'the ledger keeps both the original posting and every correction to it.',
  })
  @ApiOkResponse({ description: 'The recomputed folio page.' })
  @ApiBadRequestResponse({ description: 'Not a correctable charge.' })
  @ApiConflictResponse({ description: 'The folio is closed.' })
  correct(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('folioId') folioId: string,
    @Param('lineId') lineId: string,
    @Body(new ZodValidationPipe(correctFolioChargeSchema)) body: CorrectFolioChargeCommand,
  ): Promise<FolioPage> {
    return this.folios.correctCharge(this.userId(request), hotelId, folioId, lineId, body);
  }

  @Post(':hotelId/folios/:folioId/room-charges/correct')
  @ApiOperation({
    summary: "Correct the whole stay's room charges together",
    description:
      'What editing the consolidated "Booking Price" row on the Summary tab ' +
      'does. The difference is distributed across the posted nights in ' +
      'proportion to what each was charged, in one transaction, as appended ' +
      'adjustments — the original lines are never updated. Refused when any ' +
      'night is still scheduled, because those figures come from the ' +
      "reservation's agreed total rather than the ledger.",
  })
  @ApiOkResponse({ description: 'The recomputed folio page.' })
  @ApiBadRequestResponse({ description: 'No posted room charges, or some nights unposted.' })
  @ApiConflictResponse({ description: 'The folio is closed.' })
  correctRoomCharges(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('folioId') folioId: string,
    @Body(new ZodValidationPipe(correctRoomChargesSchema)) body: CorrectRoomChargesCommand,
  ): Promise<FolioPage> {
    return this.folios.correctRoomCharges(this.userId(request), hotelId, folioId, body);
  }

  @Post(':hotelId/folios/:folioId/discount')
  @ApiOperation({
    summary: 'Apply a discount',
    description:
      'Posted as a negative ADJUSTMENT, not as a payment: a discount reduces ' +
      'what is charged rather than adding to what was taken, and conflating ' +
      "the two would overstate the desk's cash and break the night audit's " +
      'reconciliation.',
  })
  @ApiOkResponse({ description: 'The recomputed folio page.' })
  @ApiConflictResponse({ description: 'The folio is closed.' })
  @ApiForbiddenResponse({ description: 'Requires folio:discount.' })
  discount(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('folioId') folioId: string,
    @Body(new ZodValidationPipe(postFolioDiscountSchema)) body: PostFolioDiscountCommand,
  ): Promise<FolioPage> {
    return this.folios.postDiscount(this.userId(request), hotelId, folioId, body);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
