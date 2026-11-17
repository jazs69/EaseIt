/**
 * The revenue screen's endpoint (RP-10).
 *
 * `SessionAuthGuard` only, like the reports: the grant and permission checks
 * are per-property and live in the service (CLAUDE.md section 3.2).
 */

import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { revenueQuerySchema, type RevenueOverview, type RevenueQuery } from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RevenueService } from './revenue.service.js';

@ApiTags('reports')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class RevenueController {
  constructor(private readonly revenue: RevenueService) {}

  @Get(':hotelId/revenue')
  @ApiOperation({
    summary: 'Closed-day revenue, occupancy, ADR and RevPAR for a window',
    description:
      'Read from the night audit snapshots only. Days not yet closed are ' +
      'counted, not shown; closed days with no snapshot are listed. Defaults ' +
      'to the month of the last closed day. Requires financial_reports:read.',
  })
  @ApiOkResponse({ description: 'The closed days, their totals and the gaps.' })
  @ApiForbiddenResponse({ description: 'No financial reporting permission here.' })
  @ApiNotFoundResponse({ description: 'No such property for this caller.' })
  overview(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Query(new ZodValidationPipe(revenueQuerySchema)) query: RevenueQuery,
  ): Promise<RevenueOverview> {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return this.revenue.overview(user.userId, hotelId, query);
  }
}
