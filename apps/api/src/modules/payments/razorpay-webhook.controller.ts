/**
 * Razorpay's webhook endpoint (FO-15): `POST /api/v1/webhooks/razorpay`.
 *
 * No session guard: Razorpay is not a user. It is authenticated by the
 * `X-Razorpay-Signature` HMAC of the raw body instead, checked before the body
 * is read; anything unverified is a 401 and changes nothing. Configure this URL
 * and its secret (`RAZORPAY_WEBHOOK_SECRET`) in the Razorpay dashboard for the
 * `payment_link.*` events.
 *
 * Razorpay treats any non-2xx as a failure and retries for 24 hours, and
 * delivers at least once, so the handler is idempotent (see PaymentsService).
 */

import { Controller, HttpCode, Post, Req, type RawBodyRequest } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { PaymentsService } from './payments.service.js';

@ApiExcludeController()
@Controller('webhooks')
export class RazorpayWebhookController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('razorpay')
  @HttpCode(200)
  receive(
    @Req() request: RawBodyRequest<FastifyRequest>,
  ): Promise<{ received: true; handled: boolean }> {
    const header = request.headers['x-razorpay-signature'];
    return this.payments.handleWebhook(
      request.rawBody,
      typeof header === 'string' ? header : undefined,
    );
  }
}
