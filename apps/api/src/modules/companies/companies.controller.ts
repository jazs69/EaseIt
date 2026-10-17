/**
 * Corporate accounts and booking-form lookups.
 *
 * The lookups are per-property routes even though a GSTIN check is pure
 * arithmetic: they are only ever called while booking at a property, and
 * keeping them on the same guarded prefix means no new unauthenticated
 * surface was added for a convenience feature.
 */

import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createCompanySchema,
  type CompanySummary,
  type CreateCompanyCommand,
  type GstinLookup,
  type PostalLookup,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CompaniesService } from './companies.service.js';

@ApiTags('companies')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Get(':hotelId/companies')
  @ApiOperation({ summary: 'Corporate accounts saved at this property' })
  @ApiOkResponse({ description: 'Companies, alphabetical.' })
  list(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
  ): Promise<CompanySummary[]> {
    return this.companies.list(this.userId(request), hotelId);
  }

  @Post(':hotelId/companies')
  @ApiOperation({
    summary: 'Save a corporate account',
    description:
      'The GSTIN is validated by its own check digit before anything is ' +
      'stored, and is unique per property rather than globally.',
  })
  create(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(createCompanySchema)) body: CreateCompanyCommand,
  ): Promise<CompanySummary> {
    return this.companies.create(this.userId(request), hotelId, body);
  }

  @Get(':hotelId/gst/lookup')
  @ApiOperation({
    summary: 'Look up a GSTIN taxpayer',
    description:
      'Validates structure and the mod-36 check digit first, then asks the ' +
      'configured provider. The response carries which provider answered and ' +
      'whether the name is VERIFIED, MOCK or UNVERIFIED — mock data is ' +
      'synthetic and tagged so it can never pass for a registry result.',
  })
  lookupGstin(@Query('gstin') gstin: string): Promise<GstinLookup> {
    return this.companies.lookupGstin(gstin ?? '');
  }

  @Get(':hotelId/lookups/postal-code')
  @ApiOperation({
    summary: 'City and state for an Indian PIN code',
    description:
      'Proxied so the call has a timeout and a sanitised response. A failure ' +
      'returns found:false rather than an error — the remedy is always to ' +
      'type the address, and a booking must not be blocked by a slow lookup.',
  })
  lookupPostalCode(@Query('postalCode') postalCode: string): Promise<PostalLookup> {
    return this.companies.lookupPostalCode(postalCode ?? '');
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
