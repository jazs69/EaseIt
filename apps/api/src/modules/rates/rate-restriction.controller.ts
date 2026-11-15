/**
 * Stay restrictions over HTTP (AV-07). Validation by schema; logic in the service.
 */

import { Body, Controller, Get, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  rateRestrictionQuerySchema,
  setRateRestrictionsRequestSchema,
  type RateRestrictionQuery,
  type RateRestrictionsResponse,
  type SetRateRestrictionsRequest,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RateRestrictionService } from './rate-restriction.service.js';

@ApiTags('rates')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class RateRestrictionController {
  constructor(private readonly restrictions: RateRestrictionService) {}

  @Get(':hotelId/rate-plans/:ratePlanId/restrictions')
  @ApiOperation({ summary: 'Restricted nights for one plan and room type' })
  @ApiOkResponse({ description: 'Only nights that carry a restriction.' })
  @ApiNotFoundResponse({ description: 'No such property, plan or assignment, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:read.' })
  read(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Query(new ZodValidationPipe(rateRestrictionQuerySchema)) query: RateRestrictionQuery,
  ): Promise<RateRestrictionsResponse> {
    return this.restrictions.read(this.userId(request), hotelId, ratePlanId, query);
  }

  @Put(':hotelId/rate-plans/:ratePlanId/restrictions')
  @ApiOperation({
    summary: 'Set MinLOS / closed to arrival / closed to departure on a date range',
    description:
      'Absolute: every night in the inclusive range ends up exactly as described. ' +
      'minLos null with both flags false clears the range. Enforced at quote and ' +
      'booking for stays priced from this plan.',
  })
  @ApiOkResponse({ description: 'The range as stored.' })
  @ApiNotFoundResponse({ description: 'No such property, plan or assignment, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  set(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Body(new ZodValidationPipe(setRateRestrictionsRequestSchema)) body: SetRateRestrictionsRequest,
  ): Promise<RateRestrictionsResponse> {
    return this.restrictions.set(this.userId(request), hotelId, ratePlanId, body);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
