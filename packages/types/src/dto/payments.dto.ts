/**
 * Payments: the gateway switch, payment links and the payments ledger
 * (FO-15, FO-16).
 *
 * ===========================================================================
 * Razorpay Payment Links. A clerk sends a hosted link for (part of) a folio
 * balance; the guest pays on Razorpay's page; the captured payment is posted
 * to the folio as an ordinary PAYMENT line, by the webhook or by "Check
 * payment" (which asks Razorpay directly, for when no webhook can reach the
 * API). Either way the line's idempotency key is the Razorpay payment id, so
 * it is posted exactly once.
 *
 * Amounts are integer minor units (CLAUDE.md section 3.4).
 * ===========================================================================
 */

import { z } from 'zod';

import { businessDateSchema, paymentGatewayStatusSchema } from '../domain.js';
import { storedPaymentMethodSchema } from './create-reservation.dto.js';

const idempotencyKeySchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9_-]{16,64}$/,
    'Must be 16-64 characters of letters, digits, hyphen or underscore.',
  );

/* -------------------------------------------------------------------------- */
/*  Gateway                                                                   */
/* -------------------------------------------------------------------------- */

export const paymentGatewayStateSchema = z.object({
  provider: z.literal('RAZORPAY'),
  /** The API holds Razorpay keys. */
  configured: z.boolean(),
  /** From the key id: `rzp_test_` or `rzp_live_`. Null when not configured. */
  mode: z.enum(['test', 'live']).nullable(),
  /** This property's switch. Null when it has never been set. */
  status: paymentGatewayStatusSchema.nullable(),
  /** Whether a link can be sent from this property right now. */
  canSendLinks: z.boolean(),
  /** Why not, in words, when `canSendLinks` is false. */
  reason: z.string().nullable(),
  /** The webhook is checked against a secret the API holds. */
  webhookConfigured: z.boolean(),
});

export type PaymentGatewayState = z.infer<typeof paymentGatewayStateSchema>;

export const setPaymentGatewaySchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE']),
});

export type SetPaymentGatewayCommand = z.infer<typeof setPaymentGatewaySchema>;

/* -------------------------------------------------------------------------- */
/*  Payment links                                                             */
/* -------------------------------------------------------------------------- */

export const paymentLinkStatusSchema = z.enum([
  'CREATING',
  'ACTIVE',
  'PARTIALLY_PAID',
  'PAID',
  'CANCELLED',
  'EXPIRED',
  'FAILED',
  'NEEDS_ATTENTION',
]);

export type PaymentLinkStatus = z.infer<typeof paymentLinkStatusSchema>;

export const sendPaymentLinkSchema = z.object({
  /** At least 100 paise (Razorpay's minimum), at most the folio balance. */
  amountMinor: z.number().int().min(100),
  /** Razorpay texts and/or emails the link to the booker, when we have one. */
  notifySms: z.boolean().default(true),
  notifyEmail: z.boolean().default(true),
  idempotencyKey: idempotencyKeySchema,
});

export type SendPaymentLinkCommand = z.infer<typeof sendPaymentLinkSchema>;

export const paymentLinkSchema = z.object({
  id: z.uuid(),
  folioId: z.uuid(),
  reservationId: z.uuid(),
  bookingCode: z.string(),
  provider: z.literal('RAZORPAY'),
  providerLinkId: z.string().nullable(),
  shortUrl: z.string().nullable(),
  amountMinor: z.number().int(),
  amountPaidMinor: z.number().int(),
  currency: z.string().length(3),
  status: paymentLinkStatusSchema,
  lastError: z.string().nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }),
});

export type PaymentLink = z.infer<typeof paymentLinkSchema>;

export const paymentLinkListSchema = z.object({ items: z.array(paymentLinkSchema) });
export type PaymentLinkList = z.infer<typeof paymentLinkListSchema>;

/* -------------------------------------------------------------------------- */
/*  Payments ledger (FO-16)                                                   */
/* -------------------------------------------------------------------------- */

export const paymentsQuerySchema = z
  .object({
    /** Omitted: the business date minus 6 (a week ending today). */
    from: businessDateSchema.optional(),
    /** Omitted: the business date. */
    to: businessDateSchema.optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: '"from" must not be after "to".',
    path: ['to'],
  });

export type PaymentsQuery = z.infer<typeof paymentsQuerySchema>;

export const paymentEntrySchema = z.object({
  lineId: z.uuid(),
  /** The business date it was posted to. */
  date: businessDateSchema,
  kind: z.enum(['PAYMENT', 'REFUND']),
  reservationId: z.uuid(),
  bookingCode: z.string(),
  method: storedPaymentMethodSchema.nullable(),
  /** Positive for money received, negative for money returned. */
  amountMinor: z.number().int(),
  cardLast4: z.string().nullable(),
  remark: z.string().nullable(),
  /** Captured through the payment gateway (a Razorpay payment id). */
  viaGateway: z.boolean(),
});

export type PaymentEntry = z.infer<typeof paymentEntrySchema>;

export const paymentsOverviewSchema = z.object({
  from: businessDateSchema,
  to: businessDateSchema,
  currency: z.string().length(3),
  entries: z.array(paymentEntrySchema),
  totals: z.object({
    receivedMinor: z.number().int(),
    refundedMinor: z.number().int(),
    netMinor: z.number().int(),
    /** Net per method, money billed to a company account excluded. */
    byMethod: z.record(z.string(), z.number().int()),
  }),
  links: z.array(paymentLinkSchema),
  gateway: paymentGatewayStateSchema,
});

export type PaymentsOverview = z.infer<typeof paymentsOverviewSchema>;
