/**
 * Persistence for direct billing (GP-07). Reads of the company ledger, and the
 * one write this module owns: a company's payment against its account.
 *
 * Every query names `propertyId` itself, on top of the tenancy extension and
 * row-level security that already bind it (CLAUDE.md section 3.2). No business
 * rules here: the service decides who may, and how much.
 */

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/database';

import { PrismaService } from '../../prisma/prisma.service.js';

const ENTRY_SELECT = {
  id: true,
  companyId: true,
  kind: true,
  amountMinor: true,
  postingDate: true,
  createdAt: true,
  reservationId: true,
  paymentMethod: true,
  reference: true,
  remark: true,
  reservation: {
    select: {
      confirmationCode: true,
      guestFirstName: true,
      guestLastName: true,
      invoices: {
        select: { number: true, invoiceDate: true },
        orderBy: { issuedAt: 'asc' },
        take: 1,
      },
    },
  },
} as const;

export type LedgerRow = Prisma.CompanyLedgerEntryGetPayload<{ select: typeof ENTRY_SELECT }>;

const COMPANY_SELECT = {
  id: true,
  legalName: true,
  tradeName: true,
  gstin: true,
  email: true,
  phone: true,
} as const;

export type CompanyRow = Prisma.CompanyGetPayload<{ select: typeof COMPANY_SELECT }>;

export interface GrantRow {
  role: { key: string | null };
  property: { id: string; currency: string; businessDate: Date };
}

@Injectable()
export class DirectBillingRepository {
  constructor(private readonly prisma: PrismaService) {}

  grantsAt(where: Prisma.UserPropertyRoleWhereInput): Promise<GrantRow[]> {
    return this.prisma.client.userPropertyRole.findMany({
      where,
      select: {
        role: { select: { key: true } },
        property: { select: { id: true, currency: true, businessDate: true } },
      },
    });
  }

  /** Oldest first; one company, or every company with activity. */
  entries(propertyId: string, companyId?: string): Promise<LedgerRow[]> {
    return this.prisma.client.companyLedgerEntry.findMany({
      where: { propertyId, ...(companyId === undefined ? {} : { companyId }) },
      select: ENTRY_SELECT,
      orderBy: [{ postingDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  companies(propertyId: string, ids: readonly string[]): Promise<CompanyRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.prisma.client.company.findMany({
      where: { propertyId, id: { in: [...ids] } },
      select: COMPANY_SELECT,
    });
  }

  company(propertyId: string, companyId: string): Promise<CompanyRow | null> {
    return this.prisma.client.company.findFirst({
      where: { id: companyId, propertyId },
      select: COMPANY_SELECT,
    });
  }

  /** The callback-form transaction every multi-statement write uses. */
  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(work);
  }

  /** The payment entry an idempotency key already names, if any. */
  findByKey(propertyId: string, idempotencyKey: string) {
    return this.prisma.client.companyLedgerEntry.findFirst({
      where: { propertyId, idempotencyKey },
      select: { companyId: true, kind: true, amountMinor: true, paymentMethod: true },
    });
  }
}
