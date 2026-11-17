/**
 * Reusable guest profiles (GP-02) and direct billing, the city ledger (GP-07).
 *
 * ===========================================================================
 * Through the running API, on suite-owned fixtures:
 *
 * Guest profiles: create, suggestions by normalised email and phone, link
 * (idempotent), refusal to steal a row linked elsewhere, unlink, search, edit,
 * an audit row without guest PII, 403 without the permission, 404 across
 * properties, and the database trigger refusing a cross-property link.
 *
 * Direct billing: bill-to-company refused without the permission or a
 * company; an 8-way race of full-balance transfers gives exactly one, with one
 * folio line and one ledger entry that agree; replay and key reuse; a
 * transfer cannot be refunded or corrected; checkout and an invoice whose
 * balance is the amount billed; company payments capped at the balance, an
 * 8-way race of full payments gives exactly one; aging; append-only ledger
 * and the CHECK constraints; 403 and 404.
 * ===========================================================================
 */

import { randomUUID } from 'node:crypto';

import { WHOLLY_DISPOSABLE } from '../support/isolation-guard.mjs';
import {
  createHarness,
  requireEnvironment,
  runSuite,
  shiftDays,
  utcMidnight,
} from '../support/room-fixture.mjs';

const SUITE = 'guests and direct billing';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZGDA',
  slugPrefix: 'zz-gda-',
  emailDomain: 'gda.invalid',
  prisma,
});
const other = createHarness({
  suiteName: `${SUITE} (B)`,
  prefix: 'ZZGDB',
  slugPrefix: 'zz-gdb-',
  emailDomain: 'gdb.invalid',
  prisma,
});

const ok = (res) => res.status === 200 || res.status === 201;
const show = (res) =>
  `HTTP ${String(res.status)} ${res.payload?.code ?? ''} ${JSON.stringify(res.payload?.details ?? '')}`;
const COMPANY_GSTIN = '29AAACR5055K1Z3';
const OTHER_GSTIN = '27AAPFU0939F1ZV';

async function body() {
  console.log('\n════ guests and direct billing (GP-02, GP-07) ════\n');
  const liveDb = await h.guardDatabase();
  const serverDb = (await prisma.$queryRaw`SELECT current_database() AS db`)[0]?.db;
  if (serverDb !== 'easeit_test' && !WHOLLY_DISPOSABLE.includes(serverDb)) {
    throw new Error(
      `REFUSING TO RUN: the server reports current_database() = "${String(serverDb)}". Nothing was created.`,
    );
  }
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);
  await h.sweepLeftovers();
  await other.sweepLeftovers();

  const A = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', clerk: 'FRONT_DESK', housekeeper: 'HOUSEKEEPING' },
    rooms: [
      { label: 'R1', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'R2', category: 'A', status: 'VACANT_CLEAN' },
    ],
  });
  const B = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [] });
  await h.assertApiSharesDatabase(A, A.users.admin.cookie, liveDb);
  await h.assertRoutesAreLoaded([
    `/properties/${A.propertyCode}/guests`,
    `/properties/${A.propertyCode}/direct-billing`,
  ]);

  const admin = A.users.admin.cookie;
  const clerk = A.users.clerk.cookie;
  const hk = A.users.housekeeper.cookie;
  const foreign = B.users.admin.cookie;
  const base = `/properties/${A.propertyCode}`;
  const D = A.today;

  await prisma.inventoryDay.createMany({
    data: Array.from({ length: 6 }, (_, i) => shiftDays(D, i)).map((night) => ({
      propertyId: A.propertyId,
      roomTypeId: A.categoryA,
      stayDate: utcMidnight(night),
      physical: 6,
    })),
  });
  const company = await prisma.company.create({
    data: {
      propertyId: A.propertyId,
      legalName: 'Acme Travel Private Limited',
      tradeName: 'Acme Travel',
      gstin: COMPANY_GSTIN,
    },
    select: { id: true },
  });
  const foreignCompany = await prisma.company.create({
    data: { propertyId: B.propertyId, legalName: 'Other Co', gstin: OTHER_GSTIN },
    select: { id: true },
  });

  const book = async (last, guest, companyId = null) => {
    const res = await h.call('POST', `${base}/reservations`, admin, {
      roomTypeId: A.categoryA,
      roomId: null,
      arrivalDate: D,
      departureDate: shiftDays(D, 1),
      adults: 1,
      mealPlan: 'EP',
      source: 'WALK_IN',
      companyId,
      guests: [
        {
          firstName: 'Asha',
          lastName: last,
          govtIdType: 'PASSPORT',
          govtIdNumber: 'P1234567',
          ...guest,
        },
      ],
      isInstantCheckIn: false,
    });
    if (res.status !== 201) throw new Error(`booking failed: ${show(res)}`);
    return res.payload;
  };
  const checkIn = async (stay, roomId) => {
    const res = await h.call('POST', `${base}/reservations/${stay.id}/check-in`, admin, {
      roomId,
      primaryGuestIdType: 'PASSPORT',
      primaryGuestIdNumber: 'P1234567',
      acknowledgeRoomNotClean: true,
    });
    if (!ok(res)) throw new Error(`check-in failed: ${show(res)}`);
  };
  const folioOf = async (stay) =>
    (await prisma.folio.findFirst({ where: { reservationId: stay.id }, select: { id: true } })).id;
  const balanceOf = async (folioId) =>
    (await prisma.folioLine.aggregate({ where: { folioId }, _sum: { amountMinor: true } }))._sum
      .amountMinor ?? 0;
  const bookerRow = async (stay) =>
    (
      await prisma.reservationGuest.findFirst({
        where: { reservationId: stay.id, ordinal: 1 },
        select: { id: true },
      })
    ).id;

  /* ============================================================== GP-02 */
  console.log('\n1. Guest profiles: create, suggest, link, refuse, unlink, search.');
  const s1 = await book('Kapoor', { email: '  Asha.K@Example.COM ', phone: '+91 98765-43210' });
  const s1Guest = await bookerRow(s1);

  const created = await h.call('POST', `${base}/guests`, clerk, {
    firstName: 'Asha',
    lastName: 'Kapoor',
    email: 'asha.k@example.com',
  });
  h.check('front desk creates a profile', ok(created), show(created));
  const p1 = created.payload;
  const suggestion = p1?.suggestedStays?.find((stay) => stay.reservationGuestId === s1Guest);
  h.check(
    'the booking guest with the same email (any case, spaces) is suggested',
    suggestion?.matchedOn?.includes('email') === true,
    JSON.stringify(p1?.suggestedStays),
  );
  h.check('nothing is linked automatically', (p1?.stays ?? []).length === 0);

  const linked = await h.call('POST', `${base}/guests/${p1.id}/stays`, clerk, {
    reservationGuestId: s1Guest,
  });
  h.check(
    'linking adds the stay to the history',
    ok(linked) &&
      linked.payload.stays.length === 1 &&
      linked.payload.stays[0].bookingCode === s1.bookingCode,
    show(linked),
  );
  h.check(
    'a linked row is no longer suggested',
    ok(linked) && linked.payload.suggestedStays.length === 0,
  );
  const relinked = await h.call('POST', `${base}/guests/${p1.id}/stays`, clerk, {
    reservationGuestId: s1Guest,
  });
  h.check(
    'linking again is idempotent',
    ok(relinked) && relinked.payload.stays.length === 1,
    show(relinked),
  );

  const second = await h.call('POST', `${base}/guests`, clerk, {
    firstName: 'A.',
    lastName: 'Kapoor',
    phone: '098765 43210',
  });
  h.check(
    'a second profile with the same phone is shown as a possible duplicate, not merged',
    ok(second) &&
      second.payload.possibleDuplicates.some(
        (dup) => dup.id === p1.id && dup.matchedOn.includes('phone'),
      ),
    JSON.stringify(second.payload?.possibleDuplicates),
  );
  const steal = await h.call('POST', `${base}/guests/${second.payload.id}/stays`, clerk, {
    reservationGuestId: s1Guest,
  });
  h.check(
    'a row linked to another profile is refused, not moved',
    steal.status === 400,
    show(steal),
  );

  const search = await h.call('GET', `${base}/guests?q=kapoor`, clerk);
  h.check(
    'search by name finds both',
    ok(search) && search.payload.items.length === 2,
    show(search),
  );
  const byPhone = await h.call('GET', `${base}/guests?q=43210`, clerk);
  h.check(
    'search by phone digits finds the phone profile',
    ok(byPhone) && byPhone.payload.items.some((item) => item.id === second.payload.id),
    show(byPhone),
  );
  const p1Summary = search.payload?.items?.find((item) => item.id === p1.id);
  h.check('the list shows the stay count', p1Summary?.stayCount === 1, JSON.stringify(p1Summary));

  const edited = await h.call('PATCH', `${base}/guests/${p1.id}`, clerk, {
    preferences: 'High floor, feather-free pillow',
  });
  h.check(
    'preferences are saved',
    ok(edited) && edited.payload.preferences === 'High floor, feather-free pillow',
    show(edited),
  );
  const audit = await prisma.auditLog.findFirst({
    where: {
      propertyId: A.propertyId,
      entityType: 'guest_profile',
      entityId: p1.id,
      event: 'GUEST_PROFILE_UPDATED',
    },
    select: { after: true },
  });
  h.check(
    'the edit is audited by field name, without the values',
    audit !== null &&
      JSON.stringify(audit.after).includes('preferences') &&
      !JSON.stringify(audit.after).includes('feather'),
    JSON.stringify(audit?.after),
  );
  const createdAudit = await prisma.auditLog.findFirst({
    where: { propertyId: A.propertyId, entityId: p1.id, event: 'GUEST_PROFILE_CREATED' },
    select: { after: true },
  });
  h.check(
    'the creation audit carries no email',
    createdAudit !== null && !JSON.stringify(createdAudit.after).includes('example.com'),
    JSON.stringify(createdAudit?.after),
  );

  const unlinked = await h.call('DELETE', `${base}/guests/${p1.id}/stays/${s1Guest}`, clerk);
  h.check(
    'unlinking empties the history and the row is suggested again',
    ok(unlinked) &&
      unlinked.payload.stays.length === 0 &&
      unlinked.payload.suggestedStays.length === 1,
    show(unlinked),
  );
  const unlinkAgain = await h.call('DELETE', `${base}/guests/${p1.id}/stays/${s1Guest}`, clerk);
  h.check(
    'unlinking a row that is not linked here is 404',
    unlinkAgain.status === 404,
    show(unlinkAgain),
  );

  console.log('\n2. Guest profiles: permissions and tenancy.');
  const hkList = await h.call('GET', `${base}/guests`, hk);
  h.check('housekeeping is refused with a 403', hkList.status === 403, show(hkList));
  const foreignRead = await h.call('GET', `${base}/guests/${p1.id}`, foreign);
  h.check(
    'another property’s admin gets 404 at this property',
    foreignRead.status === 404,
    show(foreignRead),
  );
  const foreignById = await h.call('GET', `/properties/${B.propertyCode}/guests/${p1.id}`, foreign);
  h.check(
    'this profile through another property is 404',
    foreignById.status === 404,
    show(foreignById),
  );
  const foreignProfile = await h.call('POST', `/properties/${B.propertyCode}/guests`, foreign, {
    firstName: 'Other',
  });
  const crossLink = await h.call(
    'POST',
    `/properties/${B.propertyCode}/guests/${foreignProfile.payload.id}/stays`,
    foreign,
    { reservationGuestId: s1Guest },
  );
  h.check('linking another property’s guest row is 404', crossLink.status === 404, show(crossLink));
  let triggerRefused = false;
  try {
    await prisma.reservationGuest.update({
      where: { id: s1Guest },
      data: { guestProfileId: foreignProfile.payload.id },
    });
  } catch (error) {
    triggerRefused = String(error?.message ?? error).includes(
      'reservation_guest_profile_same_property',
    );
  }
  h.check('the database refuses a cross-property link even from the owner login', triggerRefused);

  /* ============================================================== GP-07 */
  console.log('\n3. Bill to company: refusals, then an 8-way race.');
  await checkIn(s1, A.rooms.R1.id);
  const s1Folio = await folioOf(s1);
  const noCompany = await h.call('POST', `${base}/folios/${s1Folio}/bill-to-company`, admin, {
    amountMinor: 100,
    remark: null,
    idempotencyKey: randomUUID(),
  });
  h.check(
    'a stay with no company cannot be billed to one',
    noCompany.status === 400,
    show(noCompany),
  );

  const s2 = await book('Corporate', {}, company.id);
  await checkIn(s2, A.rooms.R2.id);
  const folioId = await folioOf(s2);
  const owed = await balanceOf(folioId);
  h.check('the corporate stay owes something', owed > 0, String(owed));

  const byClerk = await h.call('POST', `${base}/folios/${folioId}/bill-to-company`, clerk, {
    amountMinor: owed,
    remark: null,
    idempotencyKey: randomUUID(),
  });
  h.check('front desk lacks direct_billing:manage: 403', byClerk.status === 403, show(byClerk));
  const tooMuch = await h.call('POST', `${base}/folios/${folioId}/bill-to-company`, admin, {
    amountMinor: owed + 1,
    remark: null,
    idempotencyKey: randomUUID(),
  });
  h.check('more than the balance is refused', tooMuch.status === 400, show(tooMuch));

  const keys = Array.from({ length: 8 }, () => randomUUID());
  const race = await Promise.all(
    keys.map((key) =>
      h.call('POST', `${base}/folios/${folioId}/bill-to-company`, admin, {
        amountMinor: owed,
        remark: null,
        idempotencyKey: key,
      }),
    ),
  );
  const winners = race.filter(ok);
  h.check(
    'exactly one of 8 concurrent full transfers succeeds',
    winners.length === 1,
    race.map((res) => res.status).join(','),
  );
  h.check(
    'the losers are clean 400s or 409s, never 500',
    race.filter((res) => !ok(res)).every((res) => res.status === 400 || res.status === 409),
    race.map((res) => res.status).join(','),
  );
  const clLines = await prisma.folioLine.findMany({
    where: { folioId, paymentMethod: 'CITY_LEDGER' },
    select: { id: true, amountMinor: true },
  });
  const transfers = await prisma.companyLedgerEntry.findMany({
    where: { propertyId: A.propertyId, kind: 'TRANSFER' },
    select: { amountMinor: true, folioLineId: true, companyId: true },
  });
  h.check(
    'one CITY_LEDGER line and one TRANSFER, mirror images of each other',
    clLines.length === 1 &&
      transfers.length === 1 &&
      clLines[0].amountMinor === -owed &&
      transfers[0].amountMinor === owed &&
      transfers[0].folioLineId === clLines[0].id &&
      transfers[0].companyId === company.id,
    JSON.stringify({ clLines, transfers }),
  );
  h.check('the folio now balances to zero', (await balanceOf(folioId)) === 0);
  h.check(
    'the folio page reports it as billed to the company',
    winners[0]?.payload?.breakdown?.billedToCompanyMinor === owed,
    JSON.stringify(winners[0]?.payload?.breakdown),
  );

  const winningKey = keys[race.indexOf(winners[0])];
  const replay = await h.call('POST', `${base}/folios/${folioId}/bill-to-company`, admin, {
    amountMinor: owed,
    remark: null,
    idempotencyKey: winningKey,
  });
  h.check('a replay of the winning key is the original success', ok(replay), show(replay));
  const reuse = await h.call('POST', `${base}/folios/${folioId}/bill-to-company`, admin, {
    amountMinor: 1,
    remark: null,
    idempotencyKey: winningKey,
  });
  h.check('the same key for a different amount is a 409', reuse.status === 409, show(reuse));
  h.check(
    'still one transfer',
    (await prisma.companyLedgerEntry.count({
      where: { propertyId: A.propertyId, kind: 'TRANSFER' },
    })) === 1,
  );

  const refund = await h.call(
    'POST',
    `${base}/folios/${folioId}/payments/${clLines[0].id}/refund`,
    admin,
    { amountMinor: 100, reason: 'test', idempotencyKey: randomUUID() },
  );
  h.check(
    'a transfer cannot be refunded',
    refund.status === 400 && JSON.stringify(refund.payload).includes('company'),
    show(refund),
  );
  const correct = await h.call(
    'POST',
    `${base}/folios/${folioId}/lines/${clLines[0].id}/correct`,
    admin,
    { grossAmountMinor: 100, reason: 'test' },
  );
  h.check(
    'a transfer cannot be corrected',
    correct.status === 400 && JSON.stringify(correct.payload).includes('company'),
    show(correct),
  );

  console.log('\n4. Check-out and the invoice to the company.');
  const out = await h.call('POST', `${base}/reservations/${s2.id}/check-out`, admin, {
    reason: null,
  });
  h.check('the billed stay checks out', ok(out), show(out));
  const invoice = await h.call('POST', `${base}/folios/${folioId}/invoice`, admin);
  const totals = invoice.payload?.totals;
  h.check(
    'the invoice goes to the company and shows the billed amount as its balance, not as paid',
    ok(invoice) &&
      invoice.payload?.billTo?.kind === 'COMPANY' &&
      totals?.balanceMinor === owed &&
      totals?.paidMinor === 0,
    `${show(invoice)} ${JSON.stringify(totals)}`,
  );

  console.log('\n5. The company account: aging, payments capped, an 8-way race.');
  const overview = await h.call('GET', `${base}/direct-billing`, admin);
  const account = overview.payload?.accounts?.find((row) => row.companyId === company.id);
  h.check(
    'the account shows the balance, all current',
    ok(overview) && account?.balanceMinor === owed && account?.aging?.currentMinor === owed,
    JSON.stringify(account),
  );

  const pay = (cookie, amountMinor, key = randomUUID(), method = 'BANK_TRANSFER') =>
    h.call('POST', `${base}/direct-billing/companies/${company.id}/payments`, cookie, {
      method,
      amountMinor,
      reference: 'UTR123',
      remark: null,
      idempotencyKey: key,
    });
  const clerkPay = await pay(clerk, 100);
  h.check(
    'front desk cannot record a company payment: 403',
    clerkPay.status === 403,
    show(clerkPay),
  );
  const over = await pay(admin, owed + 1);
  h.check('a payment above the balance is refused', over.status === 400, show(over));
  const cityLedgerPay = await h.call(
    'POST',
    `${base}/direct-billing/companies/${company.id}/payments`,
    admin,
    {
      method: 'CITY_LEDGER',
      amountMinor: 1,
      reference: null,
      remark: null,
      idempotencyKey: randomUUID(),
    },
  );
  h.check(
    'CITY_LEDGER is not a way for a company to pay: 400',
    cityLedgerPay.status === 400,
    show(cityLedgerPay),
  );

  const part = Math.floor(owed / 3);
  const partKey = randomUUID();
  const first = await pay(admin, part, partKey);
  h.check(
    'a part payment reduces the balance',
    ok(first) && first.payload.balanceMinor === owed - part,
    show(first),
  );
  const partReplay = await pay(admin, part, partKey);
  h.check(
    'a replayed payment is the original success',
    ok(partReplay) && partReplay.payload.balanceMinor === owed - part,
    show(partReplay),
  );
  const partReuse = await pay(admin, part + 1, partKey);
  h.check(
    'the same key for a different amount is a 409',
    partReuse.status === 409,
    show(partReuse),
  );

  const rest = owed - part;
  const payRace = await Promise.all(Array.from({ length: 8 }, () => pay(admin, rest)));
  h.check(
    'exactly one of 8 concurrent full payments succeeds',
    payRace.filter(ok).length === 1,
    payRace.map((res) => res.status).join(','),
  );
  const sum = (
    await prisma.companyLedgerEntry.aggregate({
      where: { propertyId: A.propertyId, companyId: company.id },
      _sum: { amountMinor: true },
    })
  )._sum.amountMinor;
  h.check('the account sums to exactly zero', sum === 0, String(sum));
  const statement = await h.call('GET', `${base}/direct-billing/companies/${company.id}`, admin);
  h.check(
    'the statement: one transfer, two payments, running balance to zero, nothing open',
    ok(statement) &&
      statement.payload.entries.length === 3 &&
      statement.payload.entries.at(-1).runningBalanceMinor === 0 &&
      statement.payload.openItems.length === 0,
    show(statement),
  );

  console.log('\n6. The ledger is append-only and shaped by its CHECKs.');
  let appendOnly = false;
  try {
    await prisma.companyLedgerEntry.updateMany({
      where: { companyId: company.id },
      data: { remark: 'edited' },
    });
  } catch (error) {
    appendOnly = String(error?.message ?? error).includes('append-only');
  }
  h.check('an UPDATE of a ledger entry is refused', appendOnly);
  let shapeRefused = false;
  try {
    await prisma.$executeRaw`
      INSERT INTO "company_ledger_entry" ("id","propertyId","companyId","kind","amountMinor","currency","postingDate","paymentMethod","idempotencyKey")
      VALUES (${randomUUID()}::uuid, ${A.propertyId}::uuid, ${company.id}::uuid, 'PAYMENT', 500, 'INR', ${utcMidnight(D)}::date, 'CASH', ${randomUUID()})`;
  } catch (error) {
    shapeRefused = String(error?.message ?? error).includes(
      'company_ledger_entry_shape_matches_kind',
    );
  }
  h.check('a positive PAYMENT is refused by the CHECK', shapeRefused);
  let crossCompany = false;
  try {
    await prisma.$executeRaw`
      INSERT INTO "company_ledger_entry" ("id","propertyId","companyId","kind","amountMinor","currency","postingDate","paymentMethod","idempotencyKey")
      VALUES (${randomUUID()}::uuid, ${A.propertyId}::uuid, ${foreignCompany.id}::uuid, 'PAYMENT', -500, 'INR', ${utcMidnight(D)}::date, 'CASH', ${randomUUID()})`;
  } catch (error) {
    crossCompany = String(error?.message ?? error).includes('company_ledger_entry_same_property');
  }
  h.check('an entry against another property’s company is refused', crossCompany);
  let orphanRefused = false;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.folioLine.create({
        data: {
          propertyId: A.propertyId,
          folioId: s1Folio,
          kind: 'PAYMENT',
          description: 'orphan',
          amountMinor: -1,
          currency: 'INR',
          chargeDate: utcMidnight(D),
          paymentMethod: 'CITY_LEDGER',
        },
      });
    });
  } catch (error) {
    orphanRefused = String(error?.message ?? error).includes('folio_line_city_ledger_has_entry');
  }
  h.check('a CITY_LEDGER folio line with no ledger entry is refused at commit', orphanRefused);

  console.log('\n7. Direct billing: permissions and tenancy.');
  const hkOverview = await h.call('GET', `${base}/direct-billing`, hk);
  h.check(
    'housekeeping is refused the ledger with a 403',
    hkOverview.status === 403,
    show(hkOverview),
  );
  const foreignOverview = await h.call('GET', `${base}/direct-billing`, foreign);
  h.check(
    'another property’s admin gets 404',
    foreignOverview.status === 404,
    show(foreignOverview),
  );
  const foreignStatement = await h.call(
    'GET',
    `/properties/${B.propertyCode}/direct-billing/companies/${company.id}`,
    foreign,
  );
  h.check(
    'this company through another property is 404',
    foreignStatement.status === 404,
    show(foreignStatement),
  );
  const foreignPay = await h.call(
    'POST',
    `/properties/${B.propertyCode}/direct-billing/companies/${company.id}/payments`,
    foreign,
    { method: 'CASH', amountMinor: 1, reference: null, remark: null, idempotencyKey: randomUUID() },
  );
  h.check(
    'paying this company through another property is 404',
    foreignPay.status === 404,
    show(foreignPay),
  );
}

await runSuite({
  harness: h,
  prisma,
  label: SUITE,
  body: async () => {
    try {
      await body();
    } finally {
      // The ledger references the company with NO ACTION; the property
      // cascade removes both in one statement.
      await other.teardown();
    }
  },
});
