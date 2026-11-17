/**
 * Direct billing endpoints (GP-07).
 *
 * `SessionAuthGuard` only, like every `:hotelId` route: the grant and
 * permission checks are per-property and live in the service (section 3.2).
 * The transfer itself is a folio write: `POST …/folios/:folioId/bill-to-company`.
 */

import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  recordCompanyPaymentSchema,
  type CompanyStatement,
  type DirectBillingOverview,
  type RecordCompanyPaymentCommand,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { DirectBillingService } from './direct-billing.service.js';

@ApiTags('direct-billing')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class DirectBillingController {
  constructor(private readonly billing: DirectBillingService) {}

  @Get(':hotelId/direct-billing')
  @ApiOperation({
    summary: 'Company accounts with balances and aging',
    description:
      'Every company with city-ledger activity: balance (the sum of its ' +
      'entries) and aging 0-30/31-60/61-90/90+ days as of the business date. ' +
      'Requires financial_reports:read.',
  })
  @ApiOkResponse({ description: 'The accounts.' })
  @ApiForbiddenResponse({ description: 'No financial reporting permission here.' })
  @ApiNotFoundResponse({ description: 'No such property for this caller.' })
  overview(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
  ): Promise<DirectBillingOverview> {
    return this.billing.overview(this.userId(request), hotelId);
  }

  @Get(':hotelId/direct-billing/companies/:companyId')
  @ApiOperation({ summary: "A company's statement: entries, running balance, open items" })
  @ApiOkResponse({ description: 'The statement.' })
  @ApiNotFoundResponse({ description: 'No such company at this property.' })
  statement(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('companyId') companyId: string,
  ): Promise<CompanyStatement> {
    return this.billing.statement(this.userId(request), hotelId, companyId);
  }

  @Post(':hotelId/direct-billing/companies/:companyId/payments')
  @ApiOperation({
    summary: "Record a company's payment against its account",
    description: 'Never more than the balance. Idempotent per key. Requires direct_billing:manage.',
  })
  @ApiOkResponse({ description: 'The updated statement.' })
  @ApiBadRequestResponse({ description: 'More than the company owes.' })
  @ApiConflictResponse({ description: 'The key was used for a different payment, or contention.' })
  recordPayment(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('companyId') companyId: string,
    @Body(new ZodValidationPipe(recordCompanyPaymentSchema)) body: RecordCompanyPaymentCommand,
  ): Promise<CompanyStatement> {
    return this.billing.recordPayment(this.userId(request), hotelId, companyId, body);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
