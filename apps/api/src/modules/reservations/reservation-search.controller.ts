/**
 * Omnibar reservation search endpoint.
 *
 * `SessionAuthGuard` only, matching the other `:hotelId` routes
 * (`dashboard-summary`, `timeline-calendar`). `ActivePropertyGuard` is not used
 * here for the same reason it is not used there: it resolves *the session's*
 * active property, and this route is addressed by an explicit hotelId that may
 * differ from it — the clerk searching is on the property in the URL. The grant
 * check therefore lives in the query, which starts at `UserPropertyRole` and so
 * cannot return a property the caller holds no role at
 * (CLAUDE.md section 3.2).
 */

import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  reservationSearchQuerySchema,
  type ReservationSearchQuery,
  type ReservationSearchResponse,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { ReservationSearchService } from './reservation-search.service.js';

@ApiTags('reservations')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class ReservationSearchController {
  constructor(private readonly search: ReservationSearchService) {}

  @Get(':hotelId/reservations/search')
  @ApiOperation({
    summary: 'Find reservations by name, phone, booking code, OTA ref, ID or room',
    description:
      'One query string matched against seven identifiers, scoped to the ' +
      'property. Each hit reports which field matched, most specific first, ' +
      'so a result that came back on an OTA reference does not look like a ' +
      'name mismatch. Government ID numbers are matchable but never returned ' +
      'in full: the response carries a masked form only.',
  })
  @ApiOkResponse({ description: 'Matching reservations, newest booking first.' })
  @ApiNotFoundResponse({ description: 'No such property for this caller.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  searchReservations(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Query(new ZodValidationPipe(reservationSearchQuerySchema))
    query: ReservationSearchQuery,
  ): Promise<ReservationSearchResponse> {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) {
      throw new UnauthenticatedError();
    }
    return this.search.search(user.userId, hotelId, query);
  }
}
