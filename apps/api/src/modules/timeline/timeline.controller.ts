/**
 * Timeline reservation calendar endpoint.
 *
 * The route parameter is `:hotelId`, matching the dashboard controller rather
 * than the spec's `:propertyId`, and that is not cosmetic: Fastify's router
 * refuses two parametric routes that share a prefix but name the parameter
 * differently, so `properties/:propertyId/timeline-calendar` alongside the
 * existing `properties/:hotelId/dashboard-summary` would fail at boot. One
 * name for one position.
 *
 * `SessionAuthGuard` only, for the same reason as the dashboard:
 * `ActivePropertyGuard` resolves a uuid, and this accepts the operator-facing
 * code too. The grant check happens in `findGrantedProperty`, which joins
 * through `UserPropertyRole` and so cannot return a property the caller has no
 * role at (CLAUDE.md section 3.2).
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
  timelineCalendarQuerySchema,
  type TimelineCalendar,
  type TimelineCalendarQuery,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { TimelineService } from './timeline.service.js';

@ApiTags('calendar')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class TimelineController {
  constructor(private readonly timeline: TimelineService) {}

  @Get(':hotelId/timeline-calendar')
  @ApiOperation({
    summary: 'The room x date reservation grid for one property',
    description:
      'Date axis, room axis, every reservation block already positioned on ' +
      'the grid, and the sold/available rollups. Block spans are computed ' +
      'server-side from half-open stay ranges, so the grid cannot disagree ' +
      'with the availability footer beneath it. `hotelId` takes the property ' +
      'code or its uuid, verified against the caller’s own grants.',
  })
  @ApiParam({ name: 'hotelId', description: 'Property code or uuid' })
  @ApiOkResponse({ description: 'The timeline grid.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiNotFoundResponse({ description: 'No such property, or no grant at it.' })
  timelineCalendar(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Query(new ZodValidationPipe(timelineCalendarQuerySchema)) query: TimelineCalendarQuery,
  ): Promise<TimelineCalendar> {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) {
      throw new UnauthenticatedError();
    }
    return this.timeline.timeline(user.userId, hotelId, query);
  }
}
