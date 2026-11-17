/**
 * Direct billing reads (GP-07): balances, running balance, aging from the
 * invoice date, and authorisation. A fake repository; the integration suite
 * `guests-and-direct-billing.test.mjs` covers the writes and races against
 * Postgres.
 */

import { describe, expect, it } from 'vitest';

import type { DirectBillingRepository, LedgerRow } from './direct-billing.repository.js';
import { DirectBillingService } from './direct-billing.service.js';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const ACME = '00000000-0000-4000-8000-0000000000a1';
const BETA = '00000000-0000-4000-8000-0000000000b2';

let seq = 0;
function transfer(
  companyId: string,
  amount: number,
  posted: string,
  invoiceDate: string | null,
): LedgerRow {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    companyId,
    kind: 'TRANSFER',
    amountMinor: amount,
    postingDate: day(posted),
    createdAt: day(posted),
    reservationId: '00000000-0000-4000-8000-00000000ffff',
    paymentMethod: null,
    reference: null,
    remark: null,
    reservation: {
      confirmationCode: `BK${String(seq)}`,
      guestFirstName: 'Asha',
      guestLastName: 'K',
      invoices:
        invoiceDate === null
          ? []
          : [{ number: `INV-${String(seq)}`, invoiceDate: day(invoiceDate) }],
    },
  } as LedgerRow;
}

function payment(companyId: string, amount: number, posted: string): LedgerRow {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    companyId,
    kind: 'PAYMENT',
    amountMinor: -amount,
    postingDate: day(posted),
    createdAt: day(posted),
    reservationId: null,
    paymentMethod: 'BANK_TRANSFER',
    reference: 'UTR1',
    remark: null,
    reservation: null,
  } as LedgerRow;
}

const ROWS: LedgerRow[] = [
  transfer(ACME, 10_000, '2026-07-01', '2026-07-02'), // aged from the invoice: 151 days
  transfer(ACME, 5_000, '2026-11-20', null), // no invoice: aged from the transfer, 10 days
  payment(ACME, 4_000, '2026-11-25'),
  transfer(BETA, 2_000, '2026-10-15', '2026-10-15'), // 46 days
];

function service(roles: string[] = ['PROPERTY_ADMIN']): DirectBillingService {
  const repository = {
    grantsAt: () =>
      Promise.resolve([
        ...roles.map((key) => ({
          role: { key },
          property: { id: 'p1', currency: 'INR', businessDate: day('2026-11-30') },
        })),
      ]),
    entries: (_p: string, companyId?: string) =>
      Promise.resolve(
        companyId === undefined ? ROWS : ROWS.filter((row) => row.companyId === companyId),
      ),
    companies: () =>
      Promise.resolve([
        {
          id: ACME,
          legalName: 'Acme Travel',
          tradeName: null,
          gstin: '29AAACR5055K1Z3',
          email: null,
          phone: null,
        },
        {
          id: BETA,
          legalName: 'Beta Ltd',
          tradeName: null,
          gstin: '27AAPFU0939F1ZV',
          email: null,
          phone: null,
        },
      ]),
    company: (_p: string, id: string) =>
      Promise.resolve(
        id === ACME
          ? {
              id: ACME,
              legalName: 'Acme Travel',
              tradeName: null,
              gstin: '29AAACR5055K1Z3',
              email: null,
              phone: null,
            }
          : null,
      ),
  } as unknown as DirectBillingRepository;
  return new DirectBillingService(repository);
}

describe('DirectBillingService (GP-07)', () => {
  it('overview: balances, oldest-first allocation and aging per company, largest first', async () => {
    const overview = await service().overview('u', 'T1');
    expect(overview.asOf).toBe('2026-11-30');
    expect(overview.accounts.map((a) => a.legalName)).toEqual(['Acme Travel', 'Beta Ltd']);
    const acme = overview.accounts[0];
    // 15000 billed, 4000 paid off the July invoice first.
    expect(acme?.balanceMinor).toBe(11_000);
    expect(acme?.aging).toEqual({
      currentMinor: 5_000,
      days31To60Minor: 0,
      days61To90Minor: 0,
      over90Minor: 6_000,
    });
    expect(acme?.oldestOpenDate).toBe('2026-07-02');
    expect(acme?.lastPaymentDate).toBe('2026-11-25');
    expect(overview.totals.balanceMinor).toBe(13_000);
    expect(overview.totals.aging.days31To60Minor).toBe(2_000);
  });

  it('statement: running balance and open items carry the invoice number', async () => {
    const statement = await service().statement('u', 'T1', ACME);
    expect(statement.entries.map((e) => e.runningBalanceMinor)).toEqual([10_000, 15_000, 11_000]);
    expect(statement.entries[0]?.invoiceNumber).toMatch(/^INV-/);
    expect(statement.openItems.map((i) => [i.outstandingMinor, i.ageDays])).toEqual([
      [6_000, 151],
      [5_000, 10],
    ]);
  });

  it('another property’s company, or garbage, is not found', async () => {
    await expect(service().statement('u', 'T1', BETA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service().statement('u', 'T1', 'nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('reading needs financial reports; housekeeping is refused', async () => {
    await expect(service(['HOUSEKEEPING']).overview('u', 'T1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('recording a payment needs direct_billing:manage; front desk is refused', async () => {
    await expect(
      service(['FRONT_DESK']).recordPayment('u', 'T1', ACME, {
        method: 'CASH',
        amountMinor: 100,
        reference: null,
        remark: null,
        idempotencyKey: 'abcdefghijklmnop',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
