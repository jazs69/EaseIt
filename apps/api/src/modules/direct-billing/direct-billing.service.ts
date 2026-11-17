/**
 * Direct billing: the city ledger (GP-07).
 *
 * ===========================================================================
 * What a company owes, how old it is, and the company's payments against it.
 *
 * A TRANSFER is posted from the folio (`FoliosService.billToCompany`), in the
 * same transaction as the guest folio's CITY_LEDGER line. This module reads
 * the ledger and records the other side: the company's PAYMENT.
 *
 * - A balance is the sum of a company's entries, never stored (section 3.4).
 * - Aging allocates payments to the oldest debt first and ages the rest from
 *   the stay's invoice date, else its transfer date, as of the business date
 *   (`ageReceivables`, unit-tested in `@repo/types`).
 * - A payment never exceeds the balance: no unapplied credit, which would
 *   need a refund and allocation policy that does not exist yet.
 *
 * Authorisation: no grant at the property is not found (section 3.2). Reading
 * needs `financial_reports:read`, and recording a payment needs
 * `direct_billing:manage`; either missing is a 403 naming it.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import {
  ageReceivables,
  Permission,
  type AgingBuckets,
  type AgingTransfer,
  type BusinessDate,
  type CompanyAccountSummary,
  type CompanyLedgerEntry,
  type CompanyStatement,
  type DirectBillingOverview,
  type RecordCompanyPaymentCommand,
} from '@repo/types';
import type { Prisma } from '@repo/database';

import {
  IdempotencyKeyReusedError,
  TenantScopeViolationError,
  TransactionConflictError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { isLockTimeout, ROW_LOCK_TIMEOUT_MS } from '../../common/errors/sql-state.js';
import { isCompanyLedgerKeyCollision } from '../../common/errors/unique-violation.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import {
  DirectBillingRepository,
  type CompanyRow,
  type LedgerRow,
} from './direct-billing.repository.js';

interface Scope {
  propertyId: string;
  currency: string;
  asOf: BusinessDate;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function iso(date: Date): BusinessDate {
  return date.toISOString().slice(0, 10) as BusinessDate;
}

/** A company's position from its entries, oldest first. */
function position(rows: readonly LedgerRow[], asOf: BusinessDate) {
  const transfers: AgingTransfer[] = [];
  let balanceMinor = 0;
  let paidMinor = 0;
  let lastPaymentDate: BusinessDate | null = null;
  for (const row of rows) {
    balanceMinor += row.amountMinor;
    if (row.kind === 'TRANSFER') {
      const invoice = row.reservation?.invoices[0];
      transfers.push({
        id: row.id,
        amountMinor: row.amountMinor,
        ageDate: iso(invoice?.invoiceDate ?? row.postingDate),
        postingDate: iso(row.postingDate),
      });
    } else {
      paidMinor += -row.amountMinor;
      lastPaymentDate = iso(row.postingDate);
    }
  }
  return { balanceMinor, lastPaymentDate, ...ageReceivables(transfers, paidMinor, asOf) };
}

function addAging(a: AgingBuckets, b: AgingBuckets): AgingBuckets {
  return {
    currentMinor: a.currentMinor + b.currentMinor,
    days31To60Minor: a.days31To60Minor + b.days31To60Minor,
    days61To90Minor: a.days61To90Minor + b.days61To90Minor,
    over90Minor: a.over90Minor + b.over90Minor,
  };
}

const NO_AGING: AgingBuckets = {
  currentMinor: 0,
  days31To60Minor: 0,
  days61To90Minor: 0,
  over90Minor: 0,
};

@Injectable()
export class DirectBillingService {
  constructor(private readonly repository: DirectBillingRepository) {}

  async overview(userId: string, hotelId: string): Promise<DirectBillingOverview> {
    const scope = await this.authorise(userId, hotelId, Permission.FINANCIAL_REPORTS_READ);
    const rows = await this.repository.entries(scope.propertyId);

    const byCompany = new Map<string, LedgerRow[]>();
    for (const row of rows) {
      const list = byCompany.get(row.companyId) ?? [];
      list.push(row);
      byCompany.set(row.companyId, list);
    }
    const companies = new Map(
      (await this.repository.companies(scope.propertyId, [...byCompany.keys()])).map((company) => [
        company.id,
        company,
      ]),
    );

    let totalBalance = 0;
    let totalAging = NO_AGING;
    const accounts: CompanyAccountSummary[] = [];
    for (const [companyId, entries] of byCompany) {
      const company = companies.get(companyId);
      if (company === undefined) continue;
      const account = position(entries, scope.asOf);
      totalBalance += account.balanceMinor;
      totalAging = addAging(totalAging, account.aging);
      accounts.push({
        companyId,
        legalName: company.legalName,
        tradeName: company.tradeName,
        gstin: company.gstin,
        balanceMinor: account.balanceMinor,
        aging: account.aging,
        oldestOpenDate: account.openItems[0]?.ageDate ?? null,
        lastPaymentDate: account.lastPaymentDate,
      });
    }
    accounts.sort(
      (a, b) => b.balanceMinor - a.balanceMinor || a.legalName.localeCompare(b.legalName),
    );

    return {
      asOf: scope.asOf,
      currency: scope.currency,
      accounts,
      totals: { balanceMinor: totalBalance, aging: totalAging },
    };
  }

  async statement(userId: string, hotelId: string, companyId: string): Promise<CompanyStatement> {
    const scope = await this.authorise(userId, hotelId, Permission.FINANCIAL_REPORTS_READ);
    const company = await this.findCompany(scope, companyId);
    return this.buildStatement(scope, company);
  }

  /**
   * A company's payment against its account.
   *
   * One transaction: the company row FOR NO KEY UPDATE under the shared
   * bounded wait, so two payments for one company serialise and the second
   * sees the first. A transfer only inserts with a reference to the company
   * (FOR KEY SHARE), which NO KEY UPDATE does not block, so the two never
   * deadlock. Under the lock, a replayed key is the original success, a reused
   * one a typed conflict, and an amount above the balance is refused.
   */
  async recordPayment(
    userId: string,
    hotelId: string,
    companyId: string,
    command: RecordCompanyPaymentCommand,
  ): Promise<CompanyStatement> {
    const scope = await this.authorise(userId, hotelId, Permission.DIRECT_BILLING_MANAGE);
    const company = await this.findCompany(scope, companyId);

    try {
      await this.repository.transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(ROW_LOCK_TIMEOUT_MS)}, true)`;
        await tx.$executeRaw`SELECT set_config('app.current_property_id', ${scope.propertyId}, true)`;
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id"::text AS id FROM "company"
           WHERE "id" = ${company.id}::uuid AND "propertyId" = ${scope.propertyId}::uuid
             FOR NO KEY UPDATE`;
        if (locked.length === 0) throw new TenantScopeViolationError('Company');

        const replay = await tx.companyLedgerEntry.findFirst({
          where: { propertyId: scope.propertyId, idempotencyKey: command.idempotencyKey },
          select: { companyId: true, kind: true, amountMinor: true, paymentMethod: true },
        });
        if (replay !== null) {
          this.assertSameIntent(replay, company.id, command);
          return;
        }

        const balanceMinor =
          (
            await tx.companyLedgerEntry.aggregate({
              where: { propertyId: scope.propertyId, companyId: company.id },
              _sum: { amountMinor: true },
            })
          )._sum.amountMinor ?? 0;
        if (command.amountMinor > balanceMinor) {
          throw new ValidationFailedError({
            amountMinor:
              balanceMinor <= 0
                ? 'This company owes nothing.'
                : `This company owes ${String(balanceMinor)}; a payment cannot exceed it.`,
          });
        }

        await tx.companyLedgerEntry.create({
          data: {
            propertyId: scope.propertyId,
            companyId: company.id,
            kind: 'PAYMENT',
            amountMinor: -command.amountMinor,
            currency: scope.currency,
            postingDate: new Date(`${scope.asOf}T00:00:00.000Z`),
            paymentMethod: command.method,
            reference: command.reference,
            remark: command.remark,
            postedById: userId,
            idempotencyKey: command.idempotencyKey,
          },
        });

        // Same transaction (section 3.4). Amounts and method only; the
        // reference and remark are free text and stay out of the audit row.
        await tx.auditLog.create({
          data: {
            propertyId: scope.propertyId,
            actorUserId: userId,
            event: 'COMPANY_LEDGER_PAYMENT_RECORDED',
            entityType: 'company',
            entityId: company.id,
            before: { balanceMinor },
            after: {
              balanceMinor: balanceMinor - command.amountMinor,
              amountMinor: command.amountMinor,
              method: command.method,
              businessDate: scope.asOf,
            } satisfies Prisma.InputJsonValue,
            reason: null,
          },
        });
      });
    } catch (cause) {
      if (isLockTimeout(cause)) throw new TransactionConflictError('company account');
      if (!isCompanyLedgerKeyCollision(cause)) throw cause;
      // The same key raced in on another company's lock; read what it holds.
      const existing = await this.repository.findByKey(scope.propertyId, command.idempotencyKey);
      if (existing === null) throw new TransactionConflictError('company payment');
      this.assertSameIntent(existing, company.id, command);
    }

    return this.buildStatement(scope, company);
  }

  /* -------------------------------------------------------------------- */

  private assertSameIntent(
    existing: {
      companyId: string;
      kind: string;
      amountMinor: number;
      paymentMethod: string | null;
    },
    companyId: string,
    command: RecordCompanyPaymentCommand,
  ): void {
    const differing: string[] = [];
    if (existing.kind !== 'PAYMENT') differing.push('kind');
    if (existing.companyId !== companyId) differing.push('companyId');
    if (existing.amountMinor !== -command.amountMinor) differing.push('amountMinor');
    if (existing.paymentMethod !== command.method) differing.push('method');
    if (differing.length > 0) throw new IdempotencyKeyReusedError(differing);
  }

  private async buildStatement(scope: Scope, company: CompanyRow): Promise<CompanyStatement> {
    const rows = await this.repository.entries(scope.propertyId, company.id);
    const account = position(rows, scope.asOf);

    let running = 0;
    const entries: CompanyLedgerEntry[] = rows.map((row) => {
      running += row.amountMinor;
      const invoice = row.reservation?.invoices[0];
      const guestName =
        row.reservation === null
          ? null
          : `${row.reservation.guestFirstName} ${row.reservation.guestLastName}`.trim();
      return {
        id: row.id,
        kind: row.kind,
        postingDate: iso(row.postingDate),
        amountMinor: row.amountMinor,
        runningBalanceMinor: running,
        reservationId: row.reservationId,
        bookingCode: row.reservation?.confirmationCode ?? null,
        guestName,
        invoiceNumber: invoice?.number ?? null,
        invoiceDate: invoice === undefined ? null : iso(invoice.invoiceDate),
        // A PAYMENT never carries CITY_LEDGER (CHECK constraint); narrowed here.
        method:
          row.paymentMethod === null || row.paymentMethod === 'CITY_LEDGER'
            ? null
            : row.paymentMethod,
        reference: row.reference,
        remark: row.remark,
      };
    });

    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    return {
      asOf: scope.asOf,
      currency: scope.currency,
      company: {
        id: company.id,
        legalName: company.legalName,
        tradeName: company.tradeName,
        gstin: company.gstin,
        email: company.email,
        phone: company.phone,
      },
      balanceMinor: account.balanceMinor,
      aging: account.aging,
      entries,
      openItems: account.openItems.map((item) => ({
        entryId: item.id,
        bookingCode: byId.get(item.id)?.bookingCode ?? null,
        invoiceNumber: byId.get(item.id)?.invoiceNumber ?? null,
        ageDate: item.ageDate,
        ageDays: item.ageDays,
        outstandingMinor: item.outstandingMinor,
      })),
    };
  }

  /** A company of THIS property; anything else (or not a uuid) is not found. */
  private async findCompany(scope: Scope, companyId: string): Promise<CompanyRow> {
    const company = UUID.test(companyId)
      ? await this.repository.company(scope.propertyId, companyId)
      : null;
    if (company === null) throw new TenantScopeViolationError('Company');
    return company;
  }

  private async authorise(userId: string, hotelId: string, required: Permission): Promise<Scope> {
    const grants = await this.repository.grantsAt(
      grantedPropertyWhere({ userId, codeOrId: hotelId, operableOnly: false }),
    );
    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');
    requirePermissionFromGrants(grants, required);
    return {
      propertyId: first.property.id,
      currency: first.property.currency,
      asOf: iso(first.property.businessDate),
    };
  }
}
