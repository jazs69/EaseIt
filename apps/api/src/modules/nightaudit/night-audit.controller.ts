/**
 * Night audit over HTTP: enqueue and read only (section 3.3).
 *
 * `SessionAuthGuard` with the grant and permission checks inside the service,
 * because the hotelId in the path may differ from the session's active
 * property (section 3.2). Another property's run is 404, never 403.
 */

import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  startNightAuditSchema,
  type NightAuditOverview,
  type NightAuditRunView,
  type StartNightAuditCommand,
  type StartNightAuditResult,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { NightAuditService } from './night-audit.service.js';

@ApiTags('night-audit')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class NightAuditController {
  constructor(private readonly audits: NightAuditService) {}

  @Get(':hotelId/night-audit')
  @ApiOperation({ summary: 'The business date and recent runs with their steps' })
  @ApiOkResponse({ description: 'Overview.' })
  @ApiForbiddenResponse({ description: 'Requires night_audit:read.' })
  overview(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
  ): Promise<NightAuditOverview> {
    return this.audits.overview(this.userId(request), hotelId);
  }

  @Post(':hotelId/night-audit/runs')
  @ApiOperation({
    summary: "Enqueue tonight's audit",
    description:
      "Creates the run for the property's current business date and enqueues it for the " +
      'worker; never runs it in the request. Idempotent: an existing run is returned, a ' +
      'FAILED one is re-enqueued and resumes from its first unfinished step.',
  })
  @ApiOkResponse({ description: 'The run, and whether this call created, resumed or found it.' })
  @ApiForbiddenResponse({ description: 'Requires night_audit:execute.' })
  start(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(startNightAuditSchema)) _body: StartNightAuditCommand,
  ): Promise<StartNightAuditResult> {
    return this.audits.start(this.userId(request), hotelId);
  }

  @Get(':hotelId/night-audit/runs/:runId')
  @ApiOperation({ summary: 'One run and its eight steps' })
  @ApiOkResponse({ description: 'The run.' })
  @ApiNotFoundResponse({ description: 'No such run at a property you can access.' })
  run(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('runId') runId: string,
  ): Promise<NightAuditRunView> {
    return this.audits.run(this.userId(request), hotelId, runId);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
