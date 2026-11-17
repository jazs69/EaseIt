/**
 * Payment gateway, payment links and the payments ledger (FO-15, FO-16).
 *
 * `SessionAuthGuard` only, like every `:hotelId` route: the grant and
 * permission checks are per-property and live in the service (section 3.2).
 * The Razorpay webhook is a separate, unauthenticated controller that is
 * verified by signature instead.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  paymentsQuerySchema,
  sendPaymentLinkSchema,
  setPaymentGatewaySchema,
  type PaymentGatewayState,
  type PaymentLink,
  type PaymentLinkList,
  type PaymentsOverview,
  type PaymentsQuery,
  type SendPaymentLinkCommand,
  type SetPaymentGatewayCommand,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PaymentsService } from './payments.service.js';

@ApiTags('payments')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get(':hotelId/payment-gateway')
  @ApiOperation({ summary: 'Whether payment links can be sent from this property, and why not' })
  gateway(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
  ): Promise<PaymentGatewayState> {
    return this.payments.gateway(this.userId(request), hotelId);
  }

  @Put(':hotelId/payment-gateway')
  @ApiOperation({
    summary: 'Switch Razorpay payment links on or off for this property (property:settings)',
  })
  @ApiForbiddenResponse({ description: 'No property:settings here.' })
  setGateway(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(setPaymentGatewaySchema)) body: SetPaymentGatewayCommand,
  ): Promise<PaymentGatewayState> {
    return this.payments.setGateway(this.userId(request), hotelId, body);
  }

  @Get(':hotelId/payments')
  @ApiOperation({
    summary: 'Payments and refunds posted in a window, by method, with recent payment links',
    description: 'Defaults to the week ending on the business date; at most 92 days. folio:read.',
  })
  @ApiOkResponse({ description: 'The ledger.' })
  @ApiNotFoundResponse({ description: 'No such property for this caller.' })
  overview(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Query(new ZodValidationPipe(paymentsQuerySchema)) query: PaymentsQuery,
  ): Promise<PaymentsOverview> {
    return this.payments.overview(this.userId(request), hotelId, query);
  }

  @Get(':hotelId/folios/:folioId/payment-links')
  @ApiOperation({ summary: "A folio's payment links, newest first" })
  async linksForFolio(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('folioId') folioId: string,
  ): Promise<PaymentLinkList> {
    return { items: await this.payments.linksForFolio(this.userId(request), hotelId, folioId) };
  }

  @Post(':hotelId/folios/:folioId/payment-links')
  @ApiOperation({
    summary: 'Send a Razorpay payment link for (part of) the folio balance (folio:settle)',
    description:
      'Idempotent per key. Razorpay texts/emails it to the booker when asked. ' +
      'A link Razorpay refused comes back with status FAILED and the reason.',
  })
  @ApiBadRequestResponse({ description: 'Gateway off, or more than the balance.' })
  sendLink(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('folioId') folioId: string,
    @Body(new ZodValidationPipe(sendPaymentLinkSchema)) body: SendPaymentLinkCommand,
  ): Promise<PaymentLink> {
    return this.payments.sendLink(this.userId(request), hotelId, folioId, body);
  }

  @Post(':hotelId/payment-links/:linkId/refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Check payment: ask Razorpay and post any captured payment to the folio',
    description: 'For when no webhook can reach the API. Safe to repeat.',
  })
  refresh(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('linkId') linkId: string,
  ): Promise<PaymentLink> {
    return this.payments.refreshLink(this.userId(request), hotelId, linkId);
  }

  @Post(':hotelId/payment-links/:linkId/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel an unpaid link at Razorpay' })
  cancel(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('linkId') linkId: string,
  ): Promise<PaymentLink> {
    return this.payments.cancelLink(this.userId(request), hotelId, linkId);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
