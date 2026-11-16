/**
 * Invoices (FO-14).
 *
 * ===========================================================================
 * Acceptance (P1-6): a numbered, immutable, tax-itemised invoice, retrievable
 * as PDF and CSV. What that means here, each asserted below:
 *
 *   * Only a CLOSED folio is invoiced; an open one is refused and nothing is
 *     written (no invoice, no number consumed).
 *   * The invoice agrees with the folio page it came from: same lines, same
 *     tax, same CGST/SGST split, balance zero.
 *   * Numbering is per property and financial year, gapless: re-issuing
 *     returns the same invoice, eight racing issuers of one folio produce one
 *     invoice, and four folios issued at once take four consecutive numbers.
 *   * Immutable as a database fact: an UPDATE of the invoice, a new line on
 *     the invoiced folio and reopening that folio are each refused by trigger.
 *   * folio:settle issues, folio:read reads; housekeeping and revenue cannot
 *     read; another property gets not-found (section 3.2).
 *
 * Suite-owned fixtures only (ZZINV / ZZINX), torn down by the harness.
 * ===========================================================================
 */

import { randomUUID } from 'node:crypto';

import {
  createHarness,
  requireEnvironment,
  runSuite,
  shiftDays,
  utcMidnight,
} from '../support/room-fixture.mjs';

const SUITE = 'invoices';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({ suiteName: SUITE, prefix: 'ZZINV', slugPrefix: 'zz-inv-', emailDomain: 'inv.invalid', prisma });
const other = createHarness({
  suiteName: `${SUITE} (other property)`,
  prefix: 'ZZINX',
  slugPrefix: 'zz-inx-',
  emailDomain: 'inx.invalid',
  prisma,
});

const HOTEL_GSTIN = '27AAPFU0939F1ZV';
const COMPANY_GSTIN = '29AAACR5055K1Z3';

const ok = (res) => res.status === 200 || res.status === 201;
const show = (res) => `HTTP ${String(res.status)} ${res.payload?.code ?? ''} ${JSON.stringify(res.payload?.details ?? '')}`;

/** Raw fetch for the binary and text downloads, which the harness parses as JSON. */
async function download(path, cookie) {
  const response = await fetch(`${h.API}${path}`, { headers: cookie === null ? {} : { cookie } });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '',
    disposition: response.headers.get('content-disposition') ?? '',
    bytes,
  };
}

/** An owner-side statement run with the tenant setting, as the API's would be. */
async function asTenant(propertyId, work) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_property_id', ${propertyId}, true)`;
    return work(tx);
  });
}

async function refusedBy(promise, constraint) {
  try {
    await promise;
    return { refused: false, detail: 'it succeeded' };
  } catch (error) {
    const text = String(error?.message ?? error);
    return { refused: text.includes(constraint), detail: text.slice(0, 160) };
  }
}

async function body() {
  console.log('\n════ invoices (FO-14) ════\n');
  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);
  await h.sweepLeftovers();
  await other.sweepLeftovers();

  const fixture = await h.buildFixture({
    roles: {
      admin: 'PROPERTY_ADMIN',
      clerk: 'FRONT_DESK',
      pos: 'POS_STAFF',
      revenue: 'REVENUE_MANAGER',
      keeper: 'HOUSEKEEPING',
    },
    rooms: Array.from({ length: 9 }, (_, i) => ({ label: `A${String(i + 1)}`, category: 'A', status: 'VACANT_CLEAN' })),
  });
  await h.assertApiSharesDatabase(fixture, fixture.users.admin.cookie, liveDb);
  const theirs = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [] });

  const today = fixture.today;
  await prisma.inventoryDay.createMany({
    data: Array.from({ length: 4 }, (_, i) => ({
      propertyId: fixture.propertyId,
      roomTypeId: fixture.categoryA,
      stayDate: utcMidnight(shiftDays(today, i)),
      physical: 20,
    })),
  });

  const base = `/properties/${fixture.propertyCode}`;
  const { admin, clerk, pos, revenue, keeper } = Object.fromEntries(
    Object.entries(fixture.users).map(([label, user]) => [label, user.cookie]),
  );
  const R = fixture.rooms;

  async function booking(last, roomId) {
    const res = await h.call('POST', `${base}/reservations`, clerk, {
      roomTypeId: fixture.categoryA,
      roomId,
      arrivalDate: today,
      departureDate: shiftDays(today, 1),
      adults: 1,
      mealPlan: 'EP',
      source: 'WALK_IN',
      guests: [{ firstName: 'Invoice', lastName: last, govtIdType: 'PASSPORT', govtIdNumber: 'P7654321' }],
      isInstantCheckIn: false,
    });
    if (res.status !== 201) throw new Error(`booking ${last} failed: ${show(res)}`);
    return res.payload;
  }
  async function checkIn(stay, roomId) {
    const res = await h.call('POST', `${base}/reservations/${stay.id}/check-in`, clerk, {
      roomId,
      primaryGuestIdType: 'PASSPORT',
      primaryGuestIdNumber: 'P7654321',
      acknowledgeRoomNotClean: true,
    });
    if (!ok(res)) throw new Error(`check-in failed: ${show(res)}`);
  }
  const folioOf = async (stay) =>
    (await prisma.folio.findFirst({ where: { reservationId: stay.id }, select: { id: true } })).id;
  const balanceOf = async (folioId) =>
    (await prisma.folioLine.aggregate({ where: { folioId }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0;
  const pay = (stay, amountMinor) =>
    h.call('POST', `${base}/folios/by-booking/${stay.bookingCode}/payment`, clerk, {
      method: 'CASH',
      amountMinor,
      remark: null,
      idempotencyKey: randomUUID(),
    });

  /** Checked in, an extra charge, settled to zero, checked out: a CLOSED folio. */
  async function closedStay(last, roomId, { overpayAndRefund = false } = {}) {
    const stay = await booking(last, roomId);
    await checkIn(stay, roomId);
    const folioId = await folioOf(stay);
    const charge = await h.call('POST', `${base}/folios/${folioId}/charge`, clerk, {
      description: 'Restaurant - dinner',
      netAmountMinor: 240000,
      taxAmountMinor: 12000,
      chargeDate: null,
    });
    if (!ok(charge)) throw new Error(`charge failed: ${show(charge)}`);
    const owed = await balanceOf(folioId);
    const paid = await pay(stay, owed + (overpayAndRefund ? 50000 : 0));
    if (!ok(paid)) throw new Error(`payment failed: ${show(paid)}`);
    if (overpayAndRefund) {
      const paymentLine = await prisma.folioLine.findFirst({
        where: { folioId, kind: 'PAYMENT' },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      });
      const refund = await h.call('POST', `${base}/folios/${folioId}/payments/${paymentLine.id}/refund`, admin, {
        amountMinor: 50000,
        reason: 'Overpaid',
        idempotencyKey: randomUUID(),
      });
      if (!ok(refund)) throw new Error(`refund failed: ${show(refund)}`);
    }
    const out = await h.call('POST', `${base}/reservations/${stay.id}/check-out`, clerk, { reason: null });
    if (!ok(out)) throw new Error(`check-out failed: ${show(out)}`);
    return { stay, folioId };
  }
  const issue = (cookie, folioId) => h.call('POST', `${base}/folios/${folioId}/invoice`, cookie);
  const invoiceCount = () => prisma.invoice.count({ where: { propertyId: fixture.propertyId } });
  const sequenceRow = () =>
    prisma.invoiceSequence.findFirst({ where: { propertyId: fixture.propertyId }, select: { lastNumber: true } });
  const audits = (event) => prisma.auditLog.count({ where: { propertyId: fixture.propertyId, event } });

  /* ------------------------------------------------------------------ 1 */
  console.log("1. The hotel's GSTIN is a checked setting.");
  const badGstin = await h.call('PATCH', `${base}/settings`, admin, { gstin: '27AAPFU0939F1ZX' });
  h.check('a GSTIN with a wrong check character: 400 on gstin', badGstin.status === 400 && JSON.stringify(badGstin.payload).includes('gstin'), show(badGstin));
  const goodGstin = await h.call('PATCH', `${base}/settings`, admin, { gstin: HOTEL_GSTIN.toLowerCase() });
  h.check('a valid GSTIN is saved, upper-cased', ok(goodGstin) && goodGstin.payload?.settings?.gstin === HOTEL_GSTIN, `${show(goodGstin)} ${String(goodGstin.payload?.settings?.gstin)}`);

  /* ------------------------------------------------------------------ 2 */
  console.log('2. An open folio is not invoiced.');
  const inHouse = await booking('InHouse', R.A9.id);
  await checkIn(inHouse, R.A9.id);
  const openFolio = await folioOf(inHouse);
  // Paid to zero, so the only thing wrong with it is that it is still open:
  // a refusal here is the closed-folio rule, not the balance rule.
  const settleOpen = await pay(inHouse, await balanceOf(openFolio));
  h.check('the in-house folio is paid to zero but still open', ok(settleOpen) && (await balanceOf(openFolio)) === 0, show(settleOpen));
  const early = await issue(clerk, openFolio);
  h.check(
    'issuing an open folio at zero: 400, refused because it is not closed',
    early.status === 400 && String(early.payload?.details?.issues?.folioId ?? '').includes('Only a closed folio'),
    show(early),
  );
  h.check('no invoice and no number consumed', (await invoiceCount()) === 0 && (await sequenceRow()) === null);
  h.check('no SQL in the refusal', !/SELECT|FOR UPDATE|invoice_sequence/.test(JSON.stringify(early.payload)));

  /* ------------------------------------------------------------------ 3 */
  console.log('3. A closed folio is invoiced, and the invoice agrees with it.');
  const first = await closedStay('First', R.A1.id, { overpayAndRefund: true });
  const issued = await issue(clerk, first.folioId);
  const inv = issued.payload;
  const fy = (() => {
    const [y, m] = today.split('-').map(Number);
    const start = m >= 4 ? y : y - 1;
    return `${String(start)}-${String((start + 1) % 100).padStart(2, '0')}`;
  })();
  const expectedNumber = (n) => `INV_${fy.slice(2, 4)}${fy.slice(5, 7)}-${String(n).padStart(5, '0')}`;
  h.check('the front desk issues it: 200', ok(issued), show(issued));
  h.check(`numbered ${expectedNumber(1)}`, inv?.number === expectedNumber(1), String(inv?.number));
  h.check('dated the business date, in its financial year', inv?.invoiceDate === today && inv?.fiscalYear === fy, `${String(inv?.invoiceDate)} ${String(inv?.fiscalYear)}`);
  h.check('a Tax Invoice naming the hotel GSTIN', inv?.title === 'Tax Invoice' && inv?.seller?.gstin === HOTEL_GSTIN);
  h.check('billed to the guest', inv?.billTo?.kind === 'GUEST' && inv?.billTo?.name === 'Invoice First');

  const page = (await h.call('GET', `${base}/folios/by-booking/${first.stay.bookingCode}`, clerk)).payload;
  const b = page.breakdown;
  const t = inv?.totals ?? {};
  h.check('subtotal, tax, CGST and SGST equal the folio page', t.subtotalMinor === b.subtotalMinor && t.taxMinor === b.taxMinor && t.cgstMinor === b.cgstMinor && t.sgstMinor === b.sgstMinor, JSON.stringify({ t, b }));
  h.check('total = subtotal + tax, CGST + SGST = tax', t.totalMinor === t.subtotalMinor + t.taxMinor && t.cgstMinor + t.sgstMinor === t.taxMinor);
  h.check('the lines sum to the total', inv.lines.reduce((s, l) => s + l.grossMinor, 0) === t.totalMinor);
  h.check('tax-itemised: the room night and the restaurant charge each carry their tax', inv.lines.length === 2 && inv.lines.every((l) => l.taxMinor > 0 && l.grossMinor === l.netMinor + l.taxMinor), JSON.stringify(inv.lines));
  h.check('the restaurant line is at its own 5%', inv.lines.some((l) => l.netMinor === 240000 && l.taxMinor === 12000 && l.taxRatePercent === 5));
  h.check('paid, refunded, balance zero', t.paidMinor === b.paymentsReceivedMinor && t.refundedMinor === 50000 && t.balanceMinor === 0, JSON.stringify(t));
  h.check('the payment and the refund are listed', inv.payments.length === 2 && inv.payments.some((p) => p.kind === 'REFUND' && p.amountMinor === 50000));
  h.check('the folio page now names the invoice', page.invoice?.id === inv.id && page.invoice?.number === inv.number, JSON.stringify(page.invoice));
  h.check('one INVOICE_ISSUED audit row', (await audits('INVOICE_ISSUED')) === 1);

  /* ------------------------------------------------------------------ 4 */
  console.log('4. Issuing again returns the same invoice.');
  const again = await issue(admin, first.folioId);
  h.check('same id and number', ok(again) && again.payload?.id === inv.id && again.payload?.number === inv.number, show(again));
  h.check('no second invoice, no number consumed, no second audit row', (await invoiceCount()) === 1 && (await sequenceRow())?.lastNumber === 1 && (await audits('INVOICE_ISSUED')) === 1);

  /* ------------------------------------------------------------------ 5 */
  console.log('5. Eight racing issuers of one folio make one invoice.');
  const racing = await closedStay('Racing', R.A2.id);
  const race = await Promise.all(Array.from({ length: 8 }, () => issue(clerk, racing.folioId)));
  const ids = new Set(race.map((r) => r.payload?.id));
  h.check('all eight answer 200', race.every(ok), race.map((r) => r.status).join(','));
  h.check('all eight name the same invoice', ids.size === 1, [...ids].join(','));
  h.check(`it is ${expectedNumber(2)}`, race[0].payload?.number === expectedNumber(2), String(race[0].payload?.number));
  h.check('one row for the folio, sequence at 2', (await prisma.invoice.count({ where: { folioId: racing.folioId } })) === 1 && (await sequenceRow())?.lastNumber === 2);

  /* ------------------------------------------------------------------ 6 */
  console.log('6. Four folios issued at once take four consecutive numbers.');
  const batch = [];
  for (const [i, room] of [R.A3, R.A4, R.A5, R.A6].entries()) batch.push(await closedStay(`Batch${String(i)}`, room.id));
  const together = await Promise.all(batch.map((stay) => issue(clerk, stay.folioId)));
  const numbers = together.map((r) => r.payload?.number).sort();
  h.check('all four answer 200', together.every(ok), together.map(show).join(' / '));
  h.check(`numbers ${expectedNumber(3)}..${expectedNumber(6)}, no gap, no repeat`, JSON.stringify(numbers) === JSON.stringify([3, 4, 5, 6].map(expectedNumber)), numbers.join(','));
  const rows = await prisma.invoice.findMany({ where: { propertyId: fixture.propertyId }, select: { sequence: true } });
  h.check('the stored sequences are exactly 1..6', JSON.stringify(rows.map((r) => r.sequence).sort((a, c) => a - c)) === '[1,2,3,4,5,6]');

  /* ------------------------------------------------------------------ 7 */
  console.log('7. Read back as JSON, PDF and CSV.');
  const read = await h.call('GET', `${base}/invoices/${inv.id}`, pos);
  h.check('folio:read (POS) reads it: 200, unchanged', ok(read) && JSON.stringify(read.payload) === JSON.stringify(inv), show(read));
  const pdf = await download(`${base}/invoices/${inv.id}/pdf`, clerk);
  h.check('PDF: 200 application/pdf', pdf.status === 200 && pdf.type.startsWith('application/pdf'), `${String(pdf.status)} ${pdf.type}`);
  h.check('PDF: a PDF document', pdf.bytes.subarray(0, 8).toString('latin1') === '%PDF-1.4' && pdf.bytes.toString('latin1').trimEnd().endsWith('%%EOF'));
  h.check('PDF: carries the number and the hotel GSTIN', pdf.bytes.toString('latin1').includes(`(No. ${inv.number})`) && pdf.bytes.toString('latin1').includes(`(GSTIN ${HOTEL_GSTIN})`));
  h.check('PDF: downloads as <number>.pdf', pdf.disposition === `attachment; filename="${inv.number}.pdf"`, pdf.disposition);
  const csv = await download(`${base}/invoices/${inv.id}/csv`, clerk);
  const csvText = csv.bytes.toString('utf8');
  h.check('CSV: 200 text/csv', csv.status === 200 && csv.type.startsWith('text/csv'), `${String(csv.status)} ${csv.type}`);
  h.check('CSV: names the document and its total', csvText.startsWith(`﻿Tax Invoice,${inv.number}\r\n`) && csvText.includes(`Total,${(t.totalMinor / 100).toFixed(2)}`));
  if (process.env.INVOICE_PDF_OUT) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.INVOICE_PDF_OUT, pdf.bytes);
    h.note(`sample PDF written to ${process.env.INVOICE_PDF_OUT}`);
  }

  /* ------------------------------------------------------------------ 8 */
  console.log('8. Immutable, by trigger.');
  const edit = await refusedBy(
    asTenant(fixture.propertyId, (tx) => tx.$executeRaw`UPDATE "invoice" SET "totalMinor" = 1, "subtotalMinor" = 1, "taxMinor" = 0 WHERE "id" = ${inv.id}::uuid`),
    'is immutable',
  );
  h.check('UPDATE of an issued invoice is refused', edit.refused, edit.detail);
  const late = await refusedBy(
    asTenant(fixture.propertyId, (tx) =>
      tx.folioLine.create({
        data: {
          propertyId: fixture.propertyId,
          folioId: first.folioId,
          kind: 'SERVICE_CHARGE',
          description: 'Late minibar',
          amountMinor: 1000,
          currency: 'INR',
          chargeDate: utcMidnight(today),
        },
      }),
    ),
    'has been invoiced',
  );
  h.check('a line added to an invoiced folio is refused', late.refused, late.detail);
  const reopen = await refusedBy(
    asTenant(fixture.propertyId, (tx) => tx.$executeRaw`UPDATE "folio" SET "status" = 'OPEN' WHERE "id" = ${first.folioId}::uuid`),
    'has been invoiced and stays closed',
  );
  h.check('reopening an invoiced folio is refused', reopen.refused, reopen.detail);
  const unchanged = await prisma.invoice.findFirst({ where: { id: inv.id }, select: { totalMinor: true } });
  h.check('the stored invoice is unchanged', unchanged.totalMinor === t.totalMinor);

  /* ------------------------------------------------------------------ 9 */
  console.log('9. Permissions and tenancy.');
  const posIssue = await issue(pos, batch[0].folioId);
  h.check('folio:read without folio:settle cannot issue: 403', posIssue.status === 403, show(posIssue));
  for (const [label, cookie] of [['revenue', revenue], ['housekeeping', keeper]]) {
    const r = await h.call('GET', `${base}/invoices/${inv.id}`, cookie);
    const p = await download(`${base}/invoices/${inv.id}/pdf`, cookie);
    h.check(`${label} (no folio:read): 403 on JSON and PDF`, r.status === 403 && p.status === 403, `${show(r)} / ${String(p.status)}`);
  }
  const anon = await download(`${base}/invoices/${inv.id}/pdf`, null);
  h.check('no session: 401', anon.status === 401, String(anon.status));
  const theirBase = `/properties/${theirs.propertyCode}`;
  const theirAdmin = theirs.users.admin.cookie;
  const crossRead = await h.call('GET', `${theirBase}/invoices/${inv.id}`, theirAdmin);
  const crossPdf = await download(`${theirBase}/invoices/${inv.id}/pdf`, theirAdmin);
  const crossIssue = await h.call('POST', `${theirBase}/folios/${first.folioId}/invoice`, theirAdmin);
  h.check('another property reading this invoice: 404, not 403', crossRead.status === 404 && crossPdf.status === 404, `${show(crossRead)} / ${String(crossPdf.status)}`);
  h.check('another property issuing for this folio: 404', crossIssue.status === 404, show(crossIssue));
  const ourRouteTheirAdmin = await h.call('GET', `${base}/invoices/${inv.id}`, theirAdmin);
  h.check('their admin on our route: 404', ourRouteTheirAdmin.status === 404, show(ourRouteTheirAdmin));

  /* ----------------------------------------------------------------- 10 */
  console.log('10. A corporate stay is billed to the company.');
  const corporate = await closedStay('Corporate', R.A7.id);
  const company = await prisma.company.create({
    data: {
      propertyId: fixture.propertyId,
      legalName: 'Acme Travel Private Limited',
      tradeName: 'Acme Travel',
      gstin: COMPANY_GSTIN,
      addressLine1: '5 MG Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
    },
    select: { id: true },
  });
  await prisma.reservation.update({ where: { id: corporate.stay.id }, data: { companyId: company.id } });
  const billed = await issue(clerk, corporate.folioId);
  const to = billed.payload?.billTo;
  h.check('bill-to is the company, with its GSTIN and address', ok(billed) && to?.kind === 'COMPANY' && to?.gstin === COMPANY_GSTIN && to?.legalName === 'Acme Travel Private Limited' && to?.addressLines?.includes('Bengaluru, Karnataka 560001'), JSON.stringify(to));
  h.check(`and it is ${expectedNumber(7)}`, billed.payload?.number === expectedNumber(7), String(billed.payload?.number));
  h.check('the guest is still named on the stay', billed.payload?.stay?.guestName === 'Invoice Corporate');

  /* ----------------------------------------------------------------- 11 */
  console.log('11. Without a hotel GSTIN it is an Invoice, not a Tax Invoice.');
  const cleared = await h.call('PATCH', `${base}/settings`, admin, { gstin: null });
  h.check('the GSTIN can be cleared', ok(cleared) && cleared.payload?.settings?.gstin === null, show(cleared));
  const plain = await closedStay('Plain', R.A8.id);
  const plainInvoice = await issue(clerk, plain.folioId);
  h.check('titled "Invoice", seller GSTIN null', ok(plainInvoice) && plainInvoice.payload?.title === 'Invoice' && plainInvoice.payload?.seller?.gstin === null, show(plainInvoice));
  const firstAgain = await h.call('GET', `${base}/invoices/${inv.id}`, clerk);
  h.check('an invoice already issued keeps the GSTIN it was issued with', firstAgain.payload?.seller?.gstin === HOTEL_GSTIN);
}

await runSuite({
  harness: h,
  prisma,
  label: SUITE,
  body: async () => {
    try {
      await body();
    } finally {
      await other.teardown();
    }
  },
});
