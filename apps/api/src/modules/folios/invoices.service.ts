/**
 * Invoices (FO-14): issue one from a closed folio, and read it back.
 *
 * ===========================================================================
 * **Built from the folio page, not re-derived.** The lines, the tax folded
 * into each, and the CGST/SGST split come from `FoliosService.byBookingCode`
 * — the same computation the billing screen shows — so an invoice cannot
 * disagree with the folio it was raised from.
 *
 * **Only a CLOSED folio.** Closed means settled at zero and refusing every
 * posting, so those lines are final. The read happens before the lock, which
 * is safe precisely because of that: a closed folio's lines cannot change,
 * and the transaction re-checks CLOSED under the lock before numbering.
 *
 * **Locks: reservation, folio, then the sequence row.** The first two are
 * the order every folio write takes (section 3.1.1), so issuing queues behind
 * a close rather than deadlocking with it. Two issuers of the same folio
 * serialise on the folio row and the second finds the invoice the first
 * wrote; the unique `folioId` is the backstop. Different folios serialise only
 * on their year's `invoice_sequence` row, advanced in the same transaction as
 * the insert, so the numbering has no gaps and no repeats.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import {
  invoiceSchema,
  Permission,
  permissionsForRoles,
  type FolioPage,
  type Invoice,
  type InvoiceLine,
  type InvoiceParty,
  type InvoicePayment,
  type Role,
} from '@repo/types';
import { Prisma } from '@repo/database';

import {
  ForbiddenError,
  TenantScopeViolationError,
  TransactionConflictError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { isLockTimeout, ROW_LOCK_TIMEOUT_MS } from '../../common/errors/sql-state.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClockService } from '../platform/clock.service.js';
import { FoliosService } from './folios.service.js';
import { fiscalYearOf, invoiceNumber } from './invoice-document.js';

/** What is stored in `invoice.document`: the invoice without its row id. */
const storedDocumentSchema = invoiceSchema.omit({ id: true });

const LINE_KINDS: ReadonlySet<string> = new Set([
  'ROOM_CHARGE',
  'SERVICE_CHARGE',
  'TAX',
  'ADJUSTMENT',
]);

function toBusinessDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The rate a line was posted at, from its own figures (as corrections do). */
function ratePercent(netMinor: number, taxMinor: number): number {
  if (netMinor === 0 || taxMinor === 0) return 0;
  return Math.round((taxMinor / netMinor) * 10_000) / 100;
}

function addressLines(parts: {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}): string[] {
  const place = [parts.city, [parts.state, parts.postalCode].filter(Boolean).join(' ')]
    .filter((part) => part !== null && part !== undefined && part !== '')
    .join(', ');
  return [parts.line1, parts.line2, place].filter(
    (line): line is string => line !== null && line !== undefined && line !== '',
  );
}

function isInvoicePerFolioCollision(cause: unknown): boolean {
  if (cause === null || typeof cause !== 'object') return false;
  const record = cause as { code?: unknown; message?: unknown; meta?: unknown };
  const adapter = (record.meta as { driverAdapterError?: { cause?: unknown } } | undefined)
    ?.driverAdapterError?.cause as
    { originalCode?: unknown; constraint?: { index?: unknown } } | undefined;
  const unique = record.code === 'P2002' || adapter?.originalCode === '23505';
  if (!unique) return false;
  const named = [adapter?.constraint?.index, record.message].filter(
    (value): value is string => typeof value === 'string',
  );
  return named.some((text) => text.includes('invoice_folioId_key'));
}

interface CallerProperty {
  id: string;
  name: string;
  legalName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  phone: string | null;
  email: string | null;
  settings: { invoicePrefix: string; gstin: string | null } | null;
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly folios: FoliosService,
  ) {}

  /** Issue the folio's invoice, or return the one already issued. */
  async issue(userId: string, hotelId: string, folioId: string): Promise<Invoice> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_SETTLE);

    const folio = await this.prisma.client.folio.findFirst({
      where: { id: folioId, propertyId: property.id },
      select: {
        id: true,
        status: true,
        reservationId: true,
        invoice: { select: { id: true } },
        reservation: {
          select: {
            confirmationCode: true,
            guestFirstName: true,
            guestLastName: true,
            guestEmail: true,
            guestPhone: true,
            company: {
              select: {
                legalName: true,
                tradeName: true,
                gstin: true,
                addressLine1: true,
                city: true,
                state: true,
                postalCode: true,
                email: true,
                phone: true,
              },
            },
          },
        },
      },
    });
    if (folio === null) throw new TenantScopeViolationError('Folio');
    if (folio.invoice !== null) return this.read(property.id, folio.invoice.id);
    if (folio.status !== 'CLOSED') throw this.notClosed();

    // The folio is closed, so its lines are final; see the file note.
    const page = await this.folios.byBookingCode(
      userId,
      hotelId,
      folio.reservation.confirmationCode,
    );
    const body = this.compose(page, property, folio.reservation);

    let invoiceId: string;
    try {
      invoiceId = await this.prisma.client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(ROW_LOCK_TIMEOUT_MS)}, true)`;
        await tx.$executeRaw`SELECT set_config('app.current_property_id', ${property.id}, true)`;
        await tx.$queryRaw`
          SELECT 1 FROM "reservation"
           WHERE "id" = ${folio.reservationId}::uuid AND "propertyId" = ${property.id}::uuid
             FOR UPDATE`;
        const locked = await tx.$queryRaw<{ status: string }[]>`
          SELECT "status"::text AS status FROM "folio"
           WHERE "id" = ${folio.id}::uuid AND "propertyId" = ${property.id}::uuid
             FOR UPDATE`;
        if (locked[0]?.status !== 'CLOSED') throw this.notClosed();

        const existing = await tx.invoice.findFirst({
          where: { folioId: folio.id, propertyId: property.id },
          select: { id: true },
        });
        if (existing !== null) return existing.id;

        // The business date as of the lock, not as of the pre-flight read.
        const today = await tx.property.findFirst({
          where: { id: property.id },
          select: { businessDate: true },
        });
        if (today === null) throw new TenantScopeViolationError('Property');
        const invoiceDate = toBusinessDate(today.businessDate);
        const fiscalYear = fiscalYearOf(invoiceDate);

        const advanced = await tx.$queryRaw<{ lastNumber: number }[]>`
          INSERT INTO "invoice_sequence" ("propertyId", "fiscalYear", "lastNumber")
          VALUES (${property.id}::uuid, ${fiscalYear}, 1)
          ON CONFLICT ("propertyId", "fiscalYear")
            DO UPDATE SET "lastNumber" = "invoice_sequence"."lastNumber" + 1
          RETURNING "lastNumber"`;
        const sequence = advanced[0]?.lastNumber;
        if (sequence === undefined) throw new TransactionConflictError('invoice number');

        const number = invoiceNumber(
          property.settings?.invoicePrefix ?? 'INV_',
          fiscalYear,
          sequence,
        );
        const issuedAt = this.clock.now();
        const document = storedDocumentSchema.parse({
          ...body,
          number,
          fiscalYear,
          invoiceDate,
          issuedAt: issuedAt.toISOString(),
        });

        const created = await tx.invoice.create({
          data: {
            propertyId: property.id,
            folioId: folio.id,
            reservationId: folio.reservationId,
            number,
            fiscalYear,
            sequence,
            invoiceDate: today.businessDate,
            issuedAt,
            issuedById: userId,
            currency: document.currency,
            subtotalMinor: document.totals.subtotalMinor,
            taxMinor: document.totals.taxMinor,
            totalMinor: document.totals.totalMinor,
            paidMinor: document.totals.paidMinor - document.totals.refundedMinor,
            document: document as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        });

        // Same transaction as the invoice (section 3.4). No guest PII.
        await tx.auditLog.create({
          data: {
            propertyId: property.id,
            actorUserId: userId,
            event: 'INVOICE_ISSUED',
            entityType: 'invoice',
            entityId: created.id,
            before: Prisma.JsonNull,
            after: {
              number,
              folioId: folio.id,
              reservationId: folio.reservationId,
              invoiceDate,
              totalMinor: document.totals.totalMinor,
              currency: document.currency,
            },
            reason: null,
          },
        });

        return created.id;
      });
    } catch (cause) {
      if (isLockTimeout(cause)) throw new TransactionConflictError('invoice');
      // A concurrent issuer won the unique index: answer with what it wrote.
      if (!isInvoicePerFolioCollision(cause)) throw cause;
      const winner = await this.prisma.client.invoice.findFirst({
        where: { folioId: folio.id, propertyId: property.id },
        select: { id: true },
      });
      if (winner === null) throw new TransactionConflictError('invoice');
      invoiceId = winner.id;
    }

    return this.read(property.id, invoiceId);
  }

  /** One invoice, as issued. Another property's is not found (section 3.2). */
  async get(userId: string, hotelId: string, invoiceId: string): Promise<Invoice> {
    const property = await this.authorise(userId, hotelId, Permission.FOLIO_READ);
    return this.read(property.id, invoiceId);
  }

  private async read(propertyId: string, invoiceId: string): Promise<Invoice> {
    const row = await this.prisma.client.invoice.findFirst({
      where: { id: invoiceId, propertyId },
      select: { id: true, document: true },
    });
    if (row === null) throw new TenantScopeViolationError('Invoice');
    // Parsed rather than cast: a stored document that no longer matches the
    // contract fails loudly here instead of reaching a guest malformed.
    return { id: row.id, ...storedDocumentSchema.parse(row.document) };
  }

  /** Everything but the number, year, date and time, which the lock decides. */
  private compose(
    page: FolioPage,
    property: CallerProperty,
    stay: {
      guestFirstName: string;
      guestLastName: string;
      guestEmail: string | null;
      guestPhone: string | null;
      company: {
        legalName: string;
        tradeName: string | null;
        gstin: string;
        addressLine1: string | null;
        city: string | null;
        state: string | null;
        postalCode: string | null;
        email: string | null;
        phone: string | null;
      } | null;
    },
  ): Omit<Invoice, 'id' | 'number' | 'fiscalYear' | 'invoiceDate' | 'issuedAt'> {
    if (page.transactions.some((entry) => !entry.isPosted)) {
      // A closed folio has nothing scheduled; if it does, the folio and the
      // booking disagree and an invoice would print a forecast as a bill.
      throw new ValidationFailedError({
        folioId: 'This folio still shows unposted charges or advances, so it cannot be invoiced.',
      });
    }
    if (page.breakdown.balanceDueMinor !== 0) {
      throw new ValidationFailedError({
        folioId: 'An invoice is issued only for a folio settled at zero.',
      });
    }

    const lines: InvoiceLine[] = page.transactions
      .filter((entry) => LINE_KINDS.has(entry.kind))
      .map((entry) => ({
        date: entry.date,
        description: entry.description,
        kind: entry.kind as InvoiceLine['kind'],
        netMinor: entry.netMinor,
        taxMinor: entry.taxMinor,
        grossMinor: entry.grossMinor,
        taxRatePercent: ratePercent(entry.netMinor, entry.taxMinor),
      }));
    const payments: InvoicePayment[] = page.transactions
      .filter((entry) => entry.kind === 'PAYMENT' || entry.kind === 'REFUND')
      .map((entry) => ({
        date: entry.date,
        kind: entry.kind as InvoicePayment['kind'],
        method: entry.paymentMethod,
        // Payments are stored negative, refunds positive; both print positive.
        amountMinor: Math.abs(entry.grossMinor),
      }));

    const b = page.breakdown;
    const gstin = property.settings?.gstin ?? null;
    const seller: InvoiceParty = {
      name: property.name,
      legalName: property.legalName,
      gstin,
      addressLines: addressLines({
        line1: property.addressLine1,
        line2: property.addressLine2,
        city: property.city,
        state: property.state,
        postalCode: property.postalCode,
      }),
      email: property.email,
      phone: property.phone,
    };
    const guestName = `${stay.guestFirstName} ${stay.guestLastName}`.trim();
    const billTo: Invoice['billTo'] =
      stay.company === null
        ? {
            kind: 'GUEST',
            name: guestName,
            legalName: null,
            gstin: null,
            addressLines: [],
            email: stay.guestEmail,
            phone: stay.guestPhone,
          }
        : {
            kind: 'COMPANY',
            name: stay.company.tradeName ?? stay.company.legalName,
            legalName: stay.company.legalName,
            gstin: stay.company.gstin,
            addressLines: addressLines({
              line1: stay.company.addressLine1,
              city: stay.company.city,
              state: stay.company.state,
              postalCode: stay.company.postalCode,
            }),
            email: stay.company.email,
            phone: stay.company.phone,
          };

    return {
      title: gstin === null ? 'Invoice' : 'Tax Invoice',
      currency: b.currency,
      seller,
      billTo,
      stay: {
        bookingCode: page.reservation.bookingCode,
        guestName,
        arrivalDate: page.reservation.arrivalDate,
        departureDate: page.reservation.departureDate,
        nights: page.reservation.nights,
        roomNumber: page.reservation.roomNumber,
        roomTypeName: page.reservation.roomTypeName,
      },
      lines,
      payments,
      totals: {
        subtotalMinor: b.subtotalMinor,
        taxMinor: b.taxMinor,
        cgstMinor: b.cgstMinor,
        sgstMinor: b.sgstMinor,
        totalMinor: b.subtotalMinor + b.taxMinor,
        // Billed to the company account is owed by the bill-to, not paid
        // (GP-07): it is left out of "paid" and is the invoice's balance.
        paidMinor: b.paymentsReceivedMinor - b.billedToCompanyMinor,
        refundedMinor: b.refundsIssuedMinor,
        balanceMinor: b.balanceDueMinor + b.billedToCompanyMinor,
      },
    };
  }

  private notClosed(): ValidationFailedError {
    return new ValidationFailedError({
      folioId:
        'Only a closed folio can be invoiced. Settle it to zero and close it, or check the guest out.',
    });
  }

  private async authorise(
    userId: string,
    codeOrId: string,
    required: Permission,
  ): Promise<CallerProperty> {
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: grantedPropertyWhere({ userId, codeOrId, operableOnly: false }),
      select: {
        role: { select: { key: true } },
        property: {
          select: {
            id: true,
            name: true,
            legalName: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            state: true,
            postalCode: true,
            phone: true,
            email: true,
            settings: { select: { invoicePrefix: true, gstin: true } },
          },
        },
      },
    });
    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');
    const roles = grants.map((grant) => grant.role.key).filter((key): key is Role => key !== null);
    if (!permissionsForRoles(roles).includes(required)) throw new ForbiddenError(required);
    return first.property;
  }
}
