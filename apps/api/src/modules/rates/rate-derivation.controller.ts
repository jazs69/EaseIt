/**
 * Derived (linked) rate plans over HTTP (AV-06).
 */

import { Body, Controller, Delete, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
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
  setRatePlanDerivationRequestSchema,
  type RatePlanDerivationView,
  type SetRatePlanDerivationRequest,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RateDerivationService } from './rate-derivation.service.js';

@ApiTags('rates')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class RateDerivationController {
  constructor(private readonly derivations: RateDerivationService) {}

  @Get(':hotelId/rate-plans/:ratePlanId/derivation')
  @ApiOperation({ summary: 'Whether this plan is priced from a parent plan' })
  @ApiOkResponse({ description: 'The derivation, or null.' })
  @ApiNotFoundResponse({ description: 'No such property or plan, or no grant.' })
  read(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
  ): Promise<RatePlanDerivationView> {
    return this.derivations.read(this.userId(request), hotelId, ratePlanId);
  }

  @Put(':hotelId/rate-plans/:ratePlanId/derivation')
  @ApiOperation({
    summary: 'Price this plan from a parent plan',
    description:
      'Each night becomes the parent’s rate for that night, adjusted by a signed ' +
      'percentage (basis points) or fixed amount, never below zero. One level only.',
  })
  @ApiOkResponse({ description: 'The derivation as stored.' })
  @ApiNotFoundResponse({ description: 'No such plan or parent, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'Archived, multi-level, or currency mismatch.' })
  set(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Body(new ZodValidationPipe(setRatePlanDerivationRequestSchema))
    body: SetRatePlanDerivationRequest,
  ): Promise<RatePlanDerivationView> {
    return this.derivations.set(this.userId(request), hotelId, ratePlanId, body);
  }

  @Delete(':hotelId/rate-plans/:ratePlanId/derivation')
  @ApiOperation({ summary: 'Unlink: price this plan from its own calendar again' })
  @ApiOkResponse({ description: 'The plan, now underived.' })
  clear(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
  ): Promise<RatePlanDerivationView> {
    return this.derivations.clear(this.userId(request), hotelId, ratePlanId);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
