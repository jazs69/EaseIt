/**
 * Occupancy and extra-person pricing endpoints (F4).
 *
 * ===========================================================================
 * `SessionAuthGuard` only, deliberately not `ActivePropertyGuard` -- these
 * routes are addressed by `:hotelId`, the operator-facing property code, while
 * that guard resolves a uuid. The grant is resolved in the service through
 * `grantedPropertyWhere`, as every other `:hotelId` route in this API does.
 *
 * Permissions:
 *   GET     occupancy-pricing          -> RATES_READ
 *   PATCH   occupancy-pricing          -> RATES_MANAGE
 *   POST    occupancy-pricing/preview  -> RATES_READ
 *
 * The preview is `RATES_READ` on purpose. It mutates nothing, creates no
 * reservation, and computes only over data the caller can already read -- and
 * front desk holds `rates:read`, so requiring manage would deny a reception
 * clerk the ability to see what a third adult costs. Every other non-mutating
 * endpoint in this module is `rates:read`, which is the convention the scope
 * asked to be consistent with.
 *
 * `RATES_READ` and `RATES_MANAGE` both predate F1; F4 adds no permission.
 * ===========================================================================
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
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
  previewOccupancyPricingRequestSchema,
  updateOccupancyPricingRequestSchema,
  type OccupancyPricingConfig,
  type OccupancyPricingPreview,
  type PreviewOccupancyPricingRequest,
  type UpdateOccupancyPricingRequest,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { OccupancyPricingService } from './occupancy-pricing.service.js';

@ApiTags('rates')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class OccupancyPricingController {
  constructor(private readonly occupancy: OccupancyPricingService) {}

  @Get(':hotelId/rate-plans/:ratePlanId/room-types/:roomTypeId/occupancy-pricing')
  @ApiOperation({
    summary: 'The occupancy and extra-person configuration for one assignment',
    description:
      'Returns the base occupancy, how many of those guests may be children, ' +
      'the extra-adult and extra-child charges, and the ROOM TYPE’s own ' +
      '`maxGuests`/`maxAdults` so a form can bound its inputs without a ' +
      'second request. `includedAdults` is derived server-side, so the ' +
      'allocation arithmetic exists in exactly one place. The room type must ' +
      'be assigned to the plan.',
  })
  @ApiOkResponse({ description: 'The configuration.' })
  @ApiNotFoundResponse({
    description: 'No such property, plan or assignment, or no grant.',
  })
  @ApiForbiddenResponse({ description: 'A grant without rates:read.' })
  read(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Param('roomTypeId') roomTypeId: string,
  ): Promise<OccupancyPricingConfig> {
    return this.occupancy.read(this.userId(request), hotelId, ratePlanId, roomTypeId);
  }

  @Patch(':hotelId/rate-plans/:ratePlanId/room-types/:roomTypeId/occupancy-pricing')
  @ApiOperation({
    summary: 'Configure occupancy and extra-person pricing',
    description:
      'A patch: omitted fields are untouched. Validated against the MERGED ' +
      'state, not the request — lowering `baseOccupancy` alone can invalidate ' +
      'an `includedChildren` set months ago, and that is refused with a field ' +
      'name rather than reaching the database CHECK as an opaque violation. ' +
      '`baseOccupancy` is additionally checked against the room type’s ' +
      '`maxGuests`, which no CHECK constraint can express because it lives on ' +
      'another table. The default rate is NOT settable here — it is changed ' +
      'through the rate-plan room-type endpoint, so there is one place a price ' +
      'change is recorded.',
  })
  @ApiOkResponse({ description: 'The updated configuration.' })
  @ApiBadRequestResponse({
    description:
      'Included children exceed base occupancy, base occupancy exceeds room ' +
      'capacity, or a charge is negative or out of range.',
  })
  @ApiNotFoundResponse({
    description: 'No such property, plan or assignment, or no grant.',
  })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'The plan is archived or paused.' })
  update(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Param('roomTypeId') roomTypeId: string,
    @Body(new ZodValidationPipe(updateOccupancyPricingRequestSchema))
    body: UpdateOccupancyPricingRequest,
  ): Promise<OccupancyPricingConfig> {
    return this.occupancy.update(this.userId(request), hotelId, ratePlanId, roomTypeId, body);
  }

  /**
   * `@HttpCode(OK)`, because this creates nothing. A POST would otherwise
   * answer 201 and claim a resource was created — and the one thing this
   * endpoint must never be mistaken for is a booking.
   *
   * A POST rather than a GET because it carries a composite body (date plus
   * three guest counts), and because guest composition does not belong in a
   * query string that ends up in a proxy log.
   */
  @Post(':hotelId/rate-plans/:ratePlanId/occupancy-pricing/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Price one night for one guest composition (configuration preview)',
    description:
      'OPERATOR-FACING CONFIGURATION ONLY — it creates nothing, reserves ' +
      'nothing and touches no reservation. Reservation pricing stays on its ' +
      'existing path until F9. The base rate comes from the SAME F2/F3 ' +
      'resolver the calendar uses, and its source is carried through ' +
      'unchanged, so a preview can say "₹4,500 because the Christmas season ' +
      'applies". Occupancy charges are then applied on top and reported ' +
      'separately, line by line. An unusable composition — four adults in a ' +
      'three-guest room — comes back as `refusals` with the figures still ' +
      'shaped, rather than as an error that clears the form.',
  })
  @ApiOkResponse({ description: 'The full calculation breakdown, plus any refusals.' })
  @ApiBadRequestResponse({ description: 'Not a real calendar date, or a malformed body.' })
  @ApiNotFoundResponse({
    description: 'No such property, plan or assignment, or no grant.',
  })
  @ApiForbiddenResponse({ description: 'A grant without rates:read.' })
  preview(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Body(new ZodValidationPipe(previewOccupancyPricingRequestSchema))
    body: PreviewOccupancyPricingRequest,
  ): Promise<OccupancyPricingPreview> {
    return this.occupancy.preview(this.userId(request), hotelId, ratePlanId, body);
  }

  /** Unreachable while `SessionAuthGuard` is attached; asserted so that
   *  detaching it fails closed rather than reading a property of `undefined`. */
  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
