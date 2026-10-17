/**
 * Property operations dashboard endpoint.
 *
 * ===========================================================================
 * Guarded with `SessionAuthGuard` only, and **not** `ActivePropertyGuard` —
 * which is worth justifying, since the spec asked for both.
 *
 * `ActivePropertyGuard` resolves a tenant from a `:propertyId` *uuid* and then
 * verifies the grant. This route is reached as `?hotelId=31336`, an
 * operator-facing code, so the guard would have nothing it could resolve and
 * would reject every request. Pointing it at a code instead would mean
 * teaching the single guard that establishes tenancy for the whole API a
 * second identifier format — a change to the most security-critical guard in
 * the codebase, to serve one screen.
 *
 * So the grant check happens where the resolution happens, in
 * `PropertyDashboardRepository.findGrantedProperty`, which joins through
 * `UserPropertyRole` and therefore cannot return a property the caller has no
 * role at. Same guarantee, same 404-not-403 behaviour, no widening of the
 * shared guard. The invariant in CLAUDE.md section 3.2 is that tenancy is
 * *verified against the caller's grants*, never that one particular class does
 * it.
 * ===========================================================================
 */

import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  dashboardSummaryQuerySchema,
  type DashboardSummaryQuery,
  type PropertyDashboard,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PropertyDashboardService } from './property-dashboard.service.js';

@ApiTags('property-dashboard')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class PropertyDashboardController {
  constructor(private readonly dashboard: PropertyDashboardService) {}

  @Get(':hotelId/dashboard-summary')
  @ApiOperation({
    summary: 'The daily front-desk dashboard for one property',
    description:
      'Headline counts, the reservation feed for the selected count, ' +
      'availability by category for the target date, and operational alerts — ' +
      'in one call, so the numbers cannot disagree with each other. ' +
      '`hotelId` accepts the property code (31336) or its uuid; either way it ' +
      'is verified against the caller’s own grants.',
  })
  @ApiParam({ name: 'hotelId', description: 'Property code or uuid' })
  @ApiOkResponse({ description: 'The dashboard payload.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiNotFoundResponse({ description: 'No such property, or no grant at it.' })
  summary(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Query(new ZodValidationPipe(dashboardSummaryQuerySchema)) query: DashboardSummaryQuery,
  ): Promise<PropertyDashboard> {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) {
      // Unreachable while the guard is attached; asserted so that removing it
      // fails closed rather than reading a dashboard out of undefined.
      throw new UnauthenticatedError();
    }

    return this.dashboard.summary(user.userId, hotelId, query);
  }
}
