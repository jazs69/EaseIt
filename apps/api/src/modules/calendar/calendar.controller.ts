/**
 * Group reservation calendar endpoint.
 *
 * `SessionAuthGuard` only, and deliberately not `ActivePropertyGuard`: this
 * screen spans the whole portfolio, so there is no single active property for
 * that guard to resolve — it would reject every request. The grant check
 * happens in the query itself, which starts at `UserPropertyRole`, so the
 * result can only ever contain properties the caller holds a role at
 * (CLAUDE.md section 3.2).
 *
 * Note the route is `properties/group-calendar`, a static segment sharing the
 * prefix with `properties/:hotelId/dashboard-summary`. Fastify matches static
 * segments before parametric ones, so `group-calendar` is never mistaken for a
 * hotel id — but the two live in separate controllers precisely so that
 * ordering is not something a reader has to work out.
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
  groupCalendarQuerySchema,
  type GroupCalendarQuery,
  type GroupCalendarResponse,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CalendarService } from './calendar.service.js';

@ApiTags('calendar')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get('group-calendar')
  @ApiOperation({
    summary: 'Portfolio occupancy across a date window',
    description:
      'Daily occupancy, window aggregates and a per-property rollup. ' +
      'Occupancy is read from the inventory counters the oversell constraint ' +
      'guards, so it cannot disagree with what the database enforced. ' +
      'Omitting startDate uses the reference property’s own business date, ' +
      'never the server’s calendar day.',
  })
  @ApiOkResponse({ description: 'The group calendar payload.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  groupCalendar(
    @Req() request: FastifyRequest,
    @Query(new ZodValidationPipe(groupCalendarQuerySchema)) query: GroupCalendarQuery,
  ): Promise<GroupCalendarResponse> {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) {
      // Unreachable while the guard is attached; asserted so removing it fails
      // closed rather than reading a portfolio out of undefined.
      throw new UnauthenticatedError();
    }

    return this.calendar.groupCalendar(user.userId, query);
  }
}
