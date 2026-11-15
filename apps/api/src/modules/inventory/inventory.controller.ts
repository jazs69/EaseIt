/**
 * Reading and extending one property's inventory calendar.
 *
 * `SessionAuthGuard` only, and deliberately not `ActivePropertyGuard`: these
 * routes are addressed by `:hotelId`, the operator-facing property **code**
 * (e.g. `31001`), while that guard resolves a uuid. The grant is therefore
 * resolved in the service through the shared `grantedPropertyWhere` predicate,
 * which is how every other `:hotelId` route in this API authorises — see
 * `property-dashboard`, `timeline` and `reservation-search`.
 *
 * Permissions, per the approved pilot policy:
 *   GET  -> RESERVATIONS_READ   (knowing how far you can sell is a read)
 *   POST -> PROPERTY_SETTINGS   (the calendar's extent is configuration)
 */

import {
  Body,
  Controller,
  Get,
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
import {
  extendInventoryHorizonRequestSchema,
  type ExtendInventoryHorizonRequest,
  type ExtendInventoryHorizonResponse,
  type InventoryHorizon,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { InventoryHorizonService } from './inventory-horizon.service.js';

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryHorizonService) {}

  @Get(':hotelId/inventory/horizon')
  @ApiOperation({
    summary: 'How far ahead this property can sell',
    description:
      'Reports two different horizons on purpose. `lastConfiguredDate` is the ' +
      'furthest inventory row that exists anywhere; `fullyConfiguredThrough` ' +
      'is the last date through which every room type has every date. They ' +
      'differ when there is a gap, and the second is the one that governs ' +
      'what can actually be booked — a stay spanning a hole is refused even ' +
      'when the maximum is far in the future.',
  })
  @ApiOkResponse({ description: 'The configured range, the selling horizon and any gaps.' })
  @ApiNotFoundResponse({ description: 'No such property, or no grant at it.' })
  @ApiForbiddenResponse({ description: 'A grant without reservations:read.' })
  horizon(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
  ): Promise<InventoryHorizon> {
    return this.inventory.horizon(this.userId(request), hotelId);
  }

  @Post(':hotelId/inventory/horizon')
  /**
   * 200, not Nest's default 201 for a POST.
   *
   * Nothing addressable is created: the call fills in missing rows for a
   * property that already exists, and a repeat creates nothing at all. There
   * is no new resource to point a `Location` at. The same reasoning is why
   * `properties/select-context`, `reservations/…/cancel` and
   * `reservations/…/check-out` all declare `HttpStatus.OK` — a POST that acts
   * on existing state rather than creating one.
   */
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Extend the availability calendar',
    description:
      'Creates the missing inventory rows from today through `throughDate`, ' +
      'inclusive, for every room type. Idempotent: a repeated request creates ' +
      'nothing and reports `rowsCreated: 0`, though it will still fill a gap ' +
      'an earlier run left behind, because the range is re-walked from today ' +
      'rather than resumed from a stored maximum. Existing rows are never ' +
      'updated or deleted, so live `sold`, `blocked` and overbooking figures ' +
      'are untouched.',
  })
  @ApiOkResponse({ description: 'Rows created and skipped, and the resulting horizon.' })
  @ApiNotFoundResponse({ description: 'No such property, or no grant at it.' })
  @ApiForbiddenResponse({ description: 'A grant without property:settings.' })
  @ApiConflictResponse({ description: 'Not used by this route; listed for symmetry.' })
  extend(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(extendInventoryHorizonRequestSchema))
    body: ExtendInventoryHorizonRequest,
  ): Promise<ExtendInventoryHorizonResponse> {
    return this.inventory.extend(this.userId(request), hotelId, body.throughDate);
  }

  /**
   * Unreachable while `SessionAuthGuard` is attached. Asserted so that
   * detaching the guard fails closed rather than reading a property out of
   * `undefined`.
   */
  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
