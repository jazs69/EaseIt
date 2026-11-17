/**
 * Payments (FO-15, FO-16): the per-property gateway switch, Razorpay payment
 * links, the signed webhook, and the payments ledger. Posting a captured
 * payment is a folio write and goes through `FoliosService`.
 */

import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { FoliosModule } from '../folios/folios.module.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { RazorpayWebhookController } from './razorpay-webhook.controller.js';

@Module({
  imports: [FoliosModule],
  controllers: [PaymentsController, RazorpayWebhookController],
  providers: [PaymentsService, TokenService, SessionAuthGuard],
  exports: [PaymentsService],
})
export class PaymentsModule {}
