/**
 * Group performance analytics endpoint.
 *
 * `SessionAuthGuard` only, for the same reason as the other portfolio-level
 * routes: this screen spans every property the caller can see, so there is no
 * single active property for `ActivePropertyGuard` to resolve and it would
 * reject every request. The grant check lives in the query, which starts at
 * `UserPropertyRole` and therefore cannot return a property the caller holds no
 * role at (CLAUDE.md section 3.2).
 *
 * Route is `properties/group-performance`, a static segment beside
 * `properties/:hotelId/...`. Fastify matches static before parametric, so it is
 * never mistaken for a hotel id.
 */

import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  groupPerformanceQuerySchema,
  type GroupPerformance,
  type GroupPerformanceQuery,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PerformanceService } from './performance.service.js';

@ApiTags('performance')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class PerformanceController {
  constructor(private readonly performance: PerformanceService) {}

  @Get('group-performance')
  @ApiOperation({
    summary: 'Revenue, occupancy, ADR and RevPAR across the portfolio',
    description:
      'Occupancy denominators come from the inventory counters the oversell ' +
      'constraint guards, so the figures cannot disagree with what the ' +
      'database enforced. ADR divides by room-nights sold and RevPAR by ' +
      'room-nights available; the identity RevPAR = ADR x occupancy is ' +
      'checked rather than assumed. Omitting targetDate uses the reference ' +
      'property own business date, never the server calendar day.',
  })
  @ApiOkResponse({ description: 'The performance payload.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  groupPerformance(
    @Req() request: FastifyRequest,
    @Query(new ZodValidationPipe(groupPerformanceQuerySchema)) query: GroupPerformanceQuery,
  ): Promise<GroupPerformance> {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) {
      throw new UnauthenticatedError();
    }
    return this.performance.groupPerformance(user.userId, query);
  }
}
