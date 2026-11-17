/**
 * Payments: the gateway switch, Razorpay payment links, and the payments
 * ledger (FO-15, FO-16).
 *
 * ===========================================================================
 * How money arrives.
 *
 * 1. A clerk sends a link for (part of) an open folio's balance. A
 *    `payment_link` row is written first (CREATING), and its id is Razorpay's
 *    `reference_id`, so a retried creation cannot open a second link. Razorpay
 *    is then called outside any transaction (section 3.1). The clerk's
 *    idempotency key makes a double click one link.
 * 2. The guest pays on Razorpay's page.
 * 3. Razorpay's webhook (signature verified) or a clerk's "Check payment"
 *    asks Razorpay for the link and posts each CAPTURED payment to the folio
 *    through `FoliosService.postGatewayPayment`. The line's key is the
 *    Razorpay payment id, so the webhook and the check, racing or repeated,
 *    post it once. The webhook path needs no session: the property comes from
 *    the link's `notes`, which arrive inside the signed body, and everything
 *    after runs inside that one property's scope.
 *
 * Money taken against a folio that has since closed is not lost. The link is
 * marked NEEDS_ATTENTION with the Razorpay payment id, for a person to post or
 * refund.
 *
 * Who may: reading needs `folio:read`, sending/checking/cancelling a link
 * needs `folio:settle`, and switching the gateway on for a property needs
 * `property:settings`. No grant at the property is not found (section 3.2).
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  addDays,
  normalisePhone,
  Permission,
  permissionsForRoles,
  type BusinessDate,
  type PaymentGatewayState,
  type PaymentLink,
  type PaymentLinkStatus,
  type PaymentsOverview,
  type PaymentsQuery,
  type Role,
  type SendPaymentLinkCommand,
  type SetPaymentGatewayCommand,
} from '@repo/types';
import { Prisma, runInPropertyScope } from '@repo/database';

import {
  FolioAlreadyClosedError,
  ForbiddenError,
  TenantScopeViolationError,
  UnauthenticatedError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FoliosService } from '../folios/folios.service.js';
import { ClockService } from '../platform/clock.service.js';
import {
  folioMethodFor,
  RazorpayClient,
  RazorpayError,
  verifyRazorpaySignature,
  type FetchLike,
} from './razorpay.client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_WINDOW_DAYS = 92;
const PAYMENT_KEY_PREFIX = 'razorpay_';

const LINK_SELECT = {
  id: true,
  folioId: true,
  reservationId: true,
  providerLinkId: true,
  shortUrl: true,
  amountMinor: true,
  amountPaidMinor: true,
  currency: true,
  status: true,
  lastError: true,
  expiresAt: true,
  createdAt: true,
  reservation: { select: { confirmationCode: true } },
} as const;

type LinkRow = Prisma.PaymentLinkGetPayload<{ select: typeof LINK_SELECT }>;

interface CallerProperty {
  id: string;
  name: string;
  businessDate: Date;
  currency: string;
}

function iso(date: Date): BusinessDate {
  return date.toISOString().slice(0, 10) as BusinessDate;
}

function toLink(row: LinkRow): PaymentLink {
  return {
    id: row.id,
    folioId: row.folioId,
    reservationId: row.reservationId,
    bookingCode: row.reservation.confirmationCode,
    provider: 'RAZORPAY',
    providerLinkId: row.providerLinkId,
    shortUrl: row.shortUrl,
    amountMinor: row.amountMinor,
    amountPaidMinor: row.amountPaidMinor,
    currency: row.currency,
    status: row.status,
    lastError: row.lastError,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Razorpay's link status -> ours. */
function statusFor(remote: string): PaymentLinkStatus {
  switch (remote) {
    case 'paid':
      return 'PAID';
    case 'partially_paid':
      return 'PARTIALLY_PAID';
    case 'cancelled':
      return 'CANCELLED';
    case 'expired':
      return 'EXPIRED';
    default:
      return 'ACTIVE';
  }
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly client: RazorpayClient | null;
  private readonly mode: 'test' | 'live' | null;
  private readonly webhookSecret: string | undefined;
  private readonly expiryDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly folios: FoliosService,
    private readonly clock: ClockService,
    config: ConfigService,
  ) {
    const keyId = config.get<string>('RAZORPAY_KEY_ID');
    const keySecret = config.get<string>('RAZORPAY_KEY_SECRET');
    this.webhookSecret = config.get<string>('RAZORPAY_WEBHOOK_SECRET');
    this.expiryDays = config.get<number>('PAYMENT_LINK_EXPIRY_DAYS', 7);
    if (keyId !== undefined && keySecret !== undefined) {
      const fetchImpl: FetchLike = (input, init) => fetch(input, init);
      this.client = new RazorpayClient(
        fetchImpl,
        config.get<string>('RAZORPAY_BASE_URL') ?? 'https://api.razorpay.com',
        keyId,
        keySecret,
        config.get<number>('RAZORPAY_TIMEOUT_MS', 8_000),
      );
      this.mode = keyId.startsWith('rzp_live_') ? 'live' : 'test';
    } else {
      this.client = null;
      this.mode = null;
    }
  }

  /* -------------------------------------------------------------------- */
  /*  Gateway switch                                                      */
  /* -------------------------------------------------------------------- */

  async gateway(userId: string, hotelId: string): Promise<PaymentGatewayState> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_READ);
    return this.gatewayState(property.id);
  }

  async setGateway(
    userId: string,
    hotelId: string,
    command: SetPaymentGatewayCommand,
  ): Promise<PaymentGatewayState> {
    const property = await this.authorise(userId, hotelId, Permission.PROPERTY_SETTINGS);
    await this.prisma.client.$transaction(async (tx) => {
      const before = await tx.paymentGatewayConfig.findFirst({
        where: { propertyId: property.id, provider: 'RAZORPAY' },
        select: { status: true },
      });
      await tx.paymentGatewayConfig.upsert({
        where: {
          gateway_unique_provider_per_property: { propertyId: property.id, provider: 'RAZORPAY' },
        },
        create: {
          propertyId: property.id,
          provider: 'RAZORPAY',
          status: command.status,
          activatedAt: command.status === 'ACTIVE' ? this.clock.now() : null,
        },
        update: {
          status: command.status,
          ...(command.status === 'ACTIVE' ? { activatedAt: this.clock.now() } : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          propertyId: property.id,
          actorUserId: userId,
          event: 'PAYMENT_GATEWAY_STATUS_CHANGED',
          entityType: 'property',
          entityId: property.id,
          before:
            before === null ? Prisma.JsonNull : { provider: 'RAZORPAY', status: before.status },
          after: { provider: 'RAZORPAY', status: command.status },
          reason: null,
        },
      });
    });
    return this.gatewayState(property.id);
  }

  /* -------------------------------------------------------------------- */
  /*  Links                                                                */
  /* -------------------------------------------------------------------- */

  async linksForFolio(userId: string, hotelId: string, folioId: string): Promise<PaymentLink[]> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_READ);
    if (!UUID.test(folioId)) throw new TenantScopeViolationError('Folio');
    const rows = await this.prisma.client.paymentLink.findMany({
      where: { propertyId: property.id, folioId },
      select: LINK_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toLink);
  }

  async sendLink(
    userId: string,
    hotelId: string,
    folioId: string,
    command: SendPaymentLinkCommand,
  ): Promise<PaymentLink> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_SETTLE);
    const state = await this.gatewayState(property.id);
    const client = this.client;
    if (!state.canSendLinks || client === null) {
      throw new ValidationFailedError({
        gateway: state.reason ?? 'Payment links are not available.',
      });
    }

    const replay = await this.findByKey(property.id, command.idempotencyKey);
    if (replay !== null) return this.assertSameLink(replay, folioId, command.amountMinor);

    if (!UUID.test(folioId)) throw new TenantScopeViolationError('Folio');
    const folio = await this.prisma.client.folio.findFirst({
      where: { id: folioId, propertyId: property.id },
      select: {
        id: true,
        status: true,
        currency: true,
        reservationId: true,
        reservation: {
          select: {
            confirmationCode: true,
            guestFirstName: true,
            guestLastName: true,
            guestEmail: true,
            guestPhone: true,
          },
        },
      },
    });
    if (folio === null) throw new TenantScopeViolationError('Folio');
    if (folio.status !== 'OPEN') throw new FolioAlreadyClosedError(folio.id);
    // The cap is the balance the folio SHOWS: posted lines plus the nights
    // scheduled but not yet charged. A guest paying ahead for their stay is
    // the ordinary case; capping at posted lines alone refused every folio
    // with a deposit ("nothing is owed" beside a visible balance due).
    const balance = (
      await this.folios.byBookingCode(userId, hotelId, folio.reservation.confirmationCode)
    ).totals.balanceDueMinor;
    if (command.amountMinor > balance) {
      throw new ValidationFailedError({
        amountMinor:
          balance <= 0
            ? 'Nothing is owed on this folio.'
            : `At most ${String(balance)} is owed on this folio.`,
      });
    }

    const expiresAt = new Date(this.clock.now().getTime() + this.expiryDays * 86_400_000);
    let link: LinkRow;
    try {
      link = await this.prisma.client.$transaction(async (tx) => {
        const created = await tx.paymentLink.create({
          data: {
            propertyId: property.id,
            folioId: folio.id,
            reservationId: folio.reservationId,
            provider: 'RAZORPAY',
            amountMinor: command.amountMinor,
            currency: folio.currency,
            status: 'CREATING',
            expiresAt,
            idempotencyKey: command.idempotencyKey,
            createdById: userId,
          },
          select: LINK_SELECT,
        });
        await this.audit(tx, property.id, userId, created.id, 'PAYMENT_LINK_CREATED', {
          folioId: folio.id,
          amountMinor: command.amountMinor,
        });
        return created;
      });
    } catch (cause) {
      // The same click raced in: return what it created.
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
        const raced = await this.findByKey(property.id, command.idempotencyKey);
        if (raced !== null) return this.assertSameLink(raced, folioId, command.amountMinor);
      }
      throw cause;
    }

    // The provider call, outside any transaction (section 3.1).
    const booker = folio.reservation;
    try {
      const remote = await client.createLink({
        referenceId: link.id,
        amountMinor: command.amountMinor,
        currency: folio.currency,
        description: `${property.name} - booking ${booker.confirmationCode}`,
        expireBySeconds: Math.floor(expiresAt.getTime() / 1_000),
        customer: {
          name: `${booker.guestFirstName} ${booker.guestLastName}`.trim(),
          email: booker.guestEmail,
          contact: normalisePhone(booker.guestPhone),
        },
        notifySms: command.notifySms,
        notifyEmail: command.notifyEmail,
        notes: { property_id: property.id, link_id: link.id, booking: booker.confirmationCode },
      });
      link = await this.prisma.client.paymentLink.update({
        where: { id: link.id },
        data: { status: 'ACTIVE', providerLinkId: remote.id, shortUrl: remote.shortUrl },
        select: LINK_SELECT,
      });
    } catch (cause) {
      const message =
        cause instanceof RazorpayError ? cause.message : 'Razorpay could not be reached.';
      this.logger.warn(`Payment link ${link.id} not created: ${message}`);
      link = await this.prisma.client.paymentLink.update({
        where: { id: link.id },
        data: { status: 'FAILED', lastError: message.slice(0, 300) },
        select: LINK_SELECT,
      });
    }
    return toLink(link);
  }

  /** "Check payment": ask Razorpay and post what was captured. */
  async refreshLink(userId: string, hotelId: string, linkId: string): Promise<PaymentLink> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_SETTLE);
    const link = await this.findLink(property.id, linkId);
    if (link.providerLinkId === null) {
      throw new ValidationFailedError({
        linkId: 'Razorpay never confirmed this link, so there is nothing to check. Send a new one.',
      });
    }
    await this.settle(property.id, link, link.providerLinkId);
    return toLink(await this.findLink(property.id, linkId));
  }

  async cancelLink(userId: string, hotelId: string, linkId: string): Promise<PaymentLink> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_SETTLE);
    const link = await this.findLink(property.id, linkId);
    const client = this.requireClient();
    if (link.status !== 'ACTIVE' || link.providerLinkId === null) {
      throw new ValidationFailedError({ linkId: 'Only an unpaid, active link can be cancelled.' });
    }
    try {
      await client.cancelLink(link.providerLinkId);
    } catch (cause) {
      // Most likely paid or expired meanwhile: read the truth and report it.
      await this.settle(property.id, link, link.providerLinkId);
      throw new ValidationFailedError({
        linkId: cause instanceof RazorpayError ? cause.message : 'Razorpay could not cancel it.',
      });
    }
    await this.prisma.client.$transaction(async (tx) => {
      await tx.paymentLink.update({ where: { id: link.id }, data: { status: 'CANCELLED' } });
      await this.audit(tx, property.id, userId, link.id, 'PAYMENT_LINK_CANCELLED', {
        providerLinkId: link.providerLinkId,
      });
    });
    return toLink(await this.findLink(property.id, linkId));
  }

  /* -------------------------------------------------------------------- */
  /*  Webhook                                                              */
  /* -------------------------------------------------------------------- */

  /**
   * Razorpay's webhook. Verified against the raw body before anything is
   * read; an unverified call is a 401 and touches nothing. The property and
   * our link id come from the link's `notes`, inside the signed body, so the
   * lookup runs in that one property's scope (no cross-tenant read).
   */
  async handleWebhook(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<{ received: true; handled: boolean }> {
    if (this.webhookSecret === undefined || rawBody === undefined) throw new UnauthenticatedError();
    if (!(await verifyRazorpaySignature(rawBody, signature, this.webhookSecret))) {
      throw new UnauthenticatedError();
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      return { received: true, handled: false };
    }
    const event = typeof body['event'] === 'string' ? body['event'] : '';
    if (!event.startsWith('payment_link.')) return { received: true, handled: false };

    const payload = (body['payload'] ?? {}) as Record<string, unknown>;
    const entity = ((payload['payment_link'] ?? {}) as Record<string, unknown>)['entity'] as
      Record<string, unknown> | undefined;
    const notes = (entity?.['notes'] ?? {}) as Record<string, unknown>;
    const propertyId = notes['property_id'];
    const linkId = notes['link_id'];
    const providerLinkId = entity?.['id'];
    if (
      typeof propertyId !== 'string' ||
      !UUID.test(propertyId) ||
      typeof linkId !== 'string' ||
      !UUID.test(linkId) ||
      typeof providerLinkId !== 'string'
    ) {
      // A link this platform did not create. Acknowledged so Razorpay stops.
      this.logger.warn(`Razorpay ${event} for a link without our notes; ignored.`);
      return { received: true, handled: false };
    }

    return runInPropertyScope(propertyId, async () => {
      const link = await this.prisma.client.paymentLink.findFirst({
        where: { id: linkId, propertyId },
        select: LINK_SELECT,
      });
      if (link === null) {
        this.logger.warn(`Razorpay ${event} for unknown link ${linkId}; ignored.`);
        return { received: true as const, handled: false };
      }
      // A failure here (Razorpay unreachable) answers 5xx and Razorpay retries.
      await this.settle(propertyId, link, providerLinkId);
      return { received: true as const, handled: true };
    });
  }

  /* -------------------------------------------------------------------- */
  /*  Ledger (FO-16)                                                       */
  /* -------------------------------------------------------------------- */

  async overview(userId: string, hotelId: string, query: PaymentsQuery): Promise<PaymentsOverview> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_READ);
    const businessDate = iso(property.businessDate);
    const to = query.to ?? businessDate;
    const from = query.from ?? addDays(to, -6);
    if (to < from) throw new ValidationFailedError({ from: `"from" ${from} is after "to" ${to}.` });
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
    if (days > MAX_WINDOW_DAYS) {
      throw new ValidationFailedError({
        to: `The window is limited to ${String(MAX_WINDOW_DAYS)} days; ${String(days)} requested.`,
      });
    }

    const [lines, links, gateway] = await Promise.all([
      this.prisma.client.folioLine.findMany({
        where: {
          propertyId: property.id,
          kind: { in: ['PAYMENT', 'REFUND'] },
          chargeDate: {
            gte: new Date(`${from}T00:00:00.000Z`),
            lte: new Date(`${to}T00:00:00.000Z`),
          },
        },
        select: {
          id: true,
          chargeDate: true,
          kind: true,
          amountMinor: true,
          paymentMethod: true,
          cardLast4: true,
          remark: true,
          idempotencyKey: true,
          folio: {
            select: { reservationId: true, reservation: { select: { confirmationCode: true } } },
          },
        },
        orderBy: [{ chargeDate: 'desc' }, { createdAt: 'desc' }],
      }),
      this.prisma.client.paymentLink.findMany({
        where: { propertyId: property.id },
        select: LINK_SELECT,
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.gatewayState(property.id),
    ]);

    let receivedMinor = 0;
    let refundedMinor = 0;
    const byMethod: Record<string, number> = {};
    const entries = lines.map((line) => {
      // A payment is stored negative and a refund positive; flipped so money
      // in reads positive.
      const amountMinor = -line.amountMinor;
      // Billed to a company account is not money received (GP-07).
      if (line.paymentMethod !== 'CITY_LEDGER') {
        if (line.kind === 'PAYMENT') receivedMinor += amountMinor;
        else refundedMinor += -amountMinor;
        const key = line.paymentMethod ?? 'OTHER';
        byMethod[key] = (byMethod[key] ?? 0) + amountMinor;
      }
      return {
        lineId: line.id,
        date: iso(line.chargeDate),
        kind: line.kind as 'PAYMENT' | 'REFUND',
        reservationId: line.folio.reservationId,
        bookingCode: line.folio.reservation.confirmationCode,
        method: line.paymentMethod,
        amountMinor,
        // `CHAR(4)` comes back space-padded.
        cardLast4: line.cardLast4?.trim() ?? null,
        remark: line.remark,
        viaGateway: line.idempotencyKey?.startsWith(PAYMENT_KEY_PREFIX) === true,
      };
    });

    return {
      from,
      to,
      currency: property.currency,
      entries,
      totals: { receivedMinor, refundedMinor, netMinor: receivedMinor - refundedMinor, byMethod },
      links: links.map(toLink),
      gateway,
    };
  }

  /* -------------------------------------------------------------------- */

  /**
   * Reads the link at Razorpay and posts each captured payment not yet on
   * the folio. Safe to repeat and to race: the folio line's key is the
   * Razorpay payment id.
   */
  private async settle(propertyId: string, link: LinkRow, providerLinkId: string): Promise<void> {
    const client = this.requireClient();
    const remote = await client.fetchLink(providerLinkId);
    let attention: string | null = null;

    for (const payment of remote.payments) {
      if (payment.status !== 'captured' || payment.paymentId === '' || payment.amount <= 0)
        continue;
      const key = `${PAYMENT_KEY_PREFIX}${payment.paymentId}`;
      const posted = await this.prisma.client.folioLine.findFirst({
        where: { propertyId, idempotencyKey: key },
        select: { id: true },
      });
      if (posted !== null) continue;

      let card: { last4: string | null; issuer: string | null } = { last4: null, issuer: null };
      if (payment.method === 'card') {
        try {
          card = await client.fetchCard(payment.paymentId);
        } catch {
          // The payment posts without the last four digits rather than not at all.
        }
      }
      const outcome = await this.folios.postGatewayPayment(
        propertyId,
        { id: link.folioId, reservationId: link.reservationId },
        {
          key,
          amountMinor: payment.amount,
          method: folioMethodFor(payment.method),
          cardLast4: card.last4,
          issuer: card.issuer,
          remark: `Razorpay ${payment.paymentId} (link ${providerLinkId})`,
        },
      );
      if (outcome === 'folio_not_open') {
        attention = `Razorpay payment ${payment.paymentId} was captured after the folio closed. Post it by hand, or refund it in Razorpay.`;
        this.logger.error(`Payment link ${link.id}: ${attention}`);
      }
    }

    const status: PaymentLinkStatus =
      attention !== null ? 'NEEDS_ATTENTION' : statusFor(remote.status);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.paymentLink.update({
        where: { id: link.id },
        data: {
          status,
          amountPaidMinor: remote.amountPaid,
          providerLinkId,
          ...(remote.shortUrl === null ? {} : { shortUrl: remote.shortUrl }),
          lastError: attention,
        },
      });
      if (status !== link.status) {
        await this.audit(tx, propertyId, null, link.id, 'PAYMENT_LINK_STATUS_CHANGED', {
          from: link.status,
          to: status,
          amountPaidMinor: remote.amountPaid,
        });
      }
    });
  }

  private async gatewayState(propertyId: string): Promise<PaymentGatewayState> {
    const row = await this.prisma.client.paymentGatewayConfig.findFirst({
      where: { propertyId, provider: 'RAZORPAY' },
      select: { status: true },
    });
    const status = row?.status ?? null;
    let reason: string | null = null;
    if (this.client === null) {
      reason = 'Razorpay is not configured on the server (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET).';
    } else if (status !== 'ACTIVE') {
      reason =
        status === 'PENDING_KYC'
          ? 'Razorpay onboarding is not finished for this property. An administrator switches it on once it is.'
          : 'Online payments are switched off for this property. An administrator can switch them on.';
    }
    return {
      provider: 'RAZORPAY',
      configured: this.client !== null,
      mode: this.mode,
      status,
      canSendLinks: reason === null,
      reason,
      webhookConfigured: this.webhookSecret !== undefined,
    };
  }

  private requireClient(): RazorpayClient {
    if (this.client === null) {
      throw new ValidationFailedError({ gateway: 'Razorpay is not configured on the server.' });
    }
    return this.client;
  }

  private findByKey(propertyId: string, idempotencyKey: string): Promise<LinkRow | null> {
    return this.prisma.client.paymentLink.findFirst({
      where: { propertyId, idempotencyKey },
      select: LINK_SELECT,
    });
  }

  private assertSameLink(row: LinkRow, folioId: string, amountMinor: number): PaymentLink {
    if (row.folioId !== folioId || row.amountMinor !== amountMinor) {
      throw new ValidationFailedError({
        idempotencyKey: 'This request key was already used for a different payment link.',
      });
    }
    return toLink(row);
  }

  private async findLink(propertyId: string, linkId: string): Promise<LinkRow> {
    const link = UUID.test(linkId)
      ? await this.prisma.client.paymentLink.findFirst({
          where: { id: linkId, propertyId },
          select: LINK_SELECT,
        })
      : null;
    if (link === null) throw new TenantScopeViolationError('Payment link');
    return link;
  }

  private async audit(
    tx: Prisma.TransactionClient,
    propertyId: string,
    userId: string | null,
    linkId: string,
    event: string,
    after: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        propertyId,
        actorUserId: userId,
        event,
        entityType: 'payment_link',
        entityId: linkId,
        before: Prisma.JsonNull,
        after,
        reason: null,
      },
    });
  }

  private async authorise(
    userId: string,
    hotelId: string,
    required: Permission,
  ): Promise<CallerProperty> {
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: grantedPropertyWhere({ userId, codeOrId: hotelId, operableOnly: false }),
      select: {
        role: { select: { key: true } },
        property: { select: { id: true, name: true, businessDate: true, currency: true } },
      },
    });
    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');
    const roles = grants.map((grant) => grant.role.key).filter((key): key is Role => key !== null);
    if (!permissionsForRoles(roles).includes(required)) throw new ForbiddenError(required);
    return first.property;
  }
}
