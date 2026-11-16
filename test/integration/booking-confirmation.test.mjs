/**
 * Booking confirmation email through the outbox (NO-04).
 *
 * ===========================================================================
 * Acceptance: "Confirmation is sent through the outbox, exactly once per
 * booking." Two halves, each asserted:
 *
 *   * **Enqueue.** A CONFIRMED booking with an email writes exactly one
 *     RESERVATION_CONFIRMATION_EMAIL row in its own transaction, carrying only
 *     the reservation id, under a UNIQUE_FOREVER key; a second enqueue of the
 *     same key is suppressed. No email, an instant check-in, or a booking that
 *     fails writes none.
 *   * **Delivery.** The compiled handler — the code the worker runs — is
 *     called directly inside the event's property scope with the capture
 *     mailer, the way `night-audit.test.mjs` drives its handlers, so no Redis
 *     is needed. It sends once (a replay finds the audit marker and does not
 *     send again), skips a stay cancelled before delivery, refuses another
 *     property's event and a malformed payload as permanent, and a relay
 *     failure is a retryable throw that records nothing.
 *
 * The BullMQ leg (dispatcher -> queue -> worker) is the outbox's own and is
 * covered by `test:outbox:redis`; it is not re-run here.
 *
 * Suite-owned fixtures only (ZZBCE / ZZBCX), torn down by the harness.
 * ===========================================================================
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHarness, requireEnvironment, runSuite, shiftDays, utcMidnight } from '../support/room-fixture.mjs';

const SUITE = 'booking confirmation';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient, runInPropertyScope } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const DIST = '../../apps/api/dist/modules';
async function load(relative) {
  const loaded = await import(new URL(`${DIST}/${relative}`, import.meta.url));
  return Object.keys(loaded).some((key) => key !== 'default') ? loaded : (loaded.default ?? loaded);
}
const { BookingConfirmationHandler, CONFIRMATION_SENT_EVENT } = await load('reservations/booking-confirmation.handler.js');
const { CaptureMailer } = await load('platform/mail/capture.mailer.js');
const { OutboxService } = await load('platform/outbox/outbox.service.js');
const { OutboxPermanentError } = await load('platform/outbox/outbox-handler.registry.js');

const h = createHarness({ suiteName: SUITE, prefix: 'ZZBCE', slugPrefix: 'zz-bce-', emailDomain: 'bce.invalid', prisma });
const other = createHarness({ suiteName: `${SUITE} (other property)`, prefix: 'ZZBCX', slugPrefix: 'zz-bcx-', emailDomain: 'bcx.invalid', prisma });

const ok = (res) => res.status === 200 || res.status === 201;
const show = (res) => `HTTP ${String(res.status)} ${res.payload?.code ?? ''} ${JSON.stringify(res.payload?.details ?? '')}`;

const prismaStub = { client: prisma, ping: async () => true };
const captureDir = mkdtempSync(join(tmpdir(), 'easeit-confirmation-'));
const capture = new CaptureMailer(captureDir);
const handler = new BookingConfirmationHandler(prismaStub, capture);
const captured = () =>
  readdirSync(captureDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(captureDir, name), 'utf8')));

/** What the worker does: run the handler inside the event's property scope. */
function deliver(propertyId, payload, mailer = null) {
  const target = mailer === null ? handler : new BookingConfirmationHandler(prismaStub, mailer);
  return runInPropertyScope(propertyId, () =>
    target.deliver({ outboxEventId: '00000000-0000-4000-8000-000000000000', propertyId, payload, attempt: 1 }),
  );
}
async function outcomeOf(promise) {
  try {
    return { value: await promise, error: null };
  } catch (error) {
    return { value: null, error };
  }
}

async function body() {
  console.log('\n════ booking confirmation email (NO-04) ════\n');
  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);
  await h.sweepLeftovers();
  await other.sweepLeftovers();

  const fixture = await h.buildFixture({
    roles: { clerk: 'FRONT_DESK' },
    rooms: [
      { label: 'A1', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'A2', category: 'A', status: 'VACANT_CLEAN' },
    ],
  });
  await h.assertApiSharesDatabase(fixture, fixture.users.clerk.cookie, liveDb);
  const theirs = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [] });
  await prisma.inventoryDay.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({
      propertyId: fixture.propertyId,
      roomTypeId: fixture.categoryA,
      stayDate: utcMidnight(shiftDays(fixture.today, i)),
      physical: 10,
    })),
  });
  // Category B has no inventory rows at all, so a booking in it fails.

  const base = `/properties/${fixture.propertyCode}`;
  const clerk = fixture.users.clerk.cookie;
  let cursor = 2;
  async function book(last, { email = `${last.toLowerCase()}@guest.invalid`, instant = false, roomId = null, category = fixture.categoryA } = {}) {
    const arrival = instant ? fixture.today : shiftDays(fixture.today, cursor);
    if (!instant) cursor += 2;
    return h.call('POST', `${base}/reservations`, clerk, {
      roomTypeId: category,
      roomId,
      arrivalDate: arrival,
      departureDate: shiftDays(arrival, 2),
      adults: 2,
      children: 1,
      mealPlan: 'CP',
      source: 'WALK_IN',
      guests: [{ firstName: 'Confirm', lastName: last, email, phone: null, govtIdType: 'PASSPORT', govtIdNumber: 'P1112223' }],
      isInstantCheckIn: instant,
      payment: { method: 'CASH', amountMinor: 100000, remark: null },
    });
  }
  const events = (reservationId) =>
    prisma.outboxEvent.findMany({
      where: { propertyId: fixture.propertyId, eventType: 'RESERVATION_CONFIRMATION_EMAIL', ...(reservationId ? { payload: { equals: { reservationId } } } : {}) },
      select: { payload: true, dedupeKey: true, dedupeMode: true, status: true },
    });
  const sentMarkers = (reservationId) =>
    prisma.auditLog.count({ where: { propertyId: fixture.propertyId, entityId: reservationId, event: CONFIRMATION_SENT_EVENT } });

  /* ------------------------------------------------------------------ 1 */
  console.log('1. A confirmed booking with an email promises one confirmation.');
  const first = await book('Alpha');
  h.check('booking created: 201', first.status === 201, show(first));
  const stay = first.payload;
  const rows = await events(stay.id);
  h.check('exactly one RESERVATION_CONFIRMATION_EMAIL row', rows.length === 1, JSON.stringify(rows));
  h.check('payload is the reservation id and nothing else', JSON.stringify(rows[0]?.payload) === JSON.stringify({ reservationId: stay.id }));
  h.check('no email address in the queue', !JSON.stringify(rows).includes('@guest.invalid'));
  h.check('keyed per reservation, UNIQUE_FOREVER, PENDING', rows[0]?.dedupeKey === `reservation-confirmation:${stay.id}` && rows[0]?.dedupeMode === 'UNIQUE_FOREVER' && rows[0]?.status === 'PENDING', JSON.stringify(rows[0]));
  const outbox = new OutboxService(prismaStub);
  const replay = await runInPropertyScope(fixture.propertyId, () =>
    outbox.enqueueStandalone({
      propertyId: fixture.propertyId,
      eventType: 'RESERVATION_CONFIRMATION_EMAIL',
      payload: { reservationId: stay.id },
      dedupeKey: `reservation-confirmation:${stay.id}`,
      dedupeMode: 'UNIQUE_FOREVER',
    }),
  );
  h.check(
    'a second enqueue of the same key is suppressed',
    replay.outcome === 'suppressed' && (await events(stay.id)).length === 1,
    JSON.stringify(replay),
  );

  /* ------------------------------------------------------------------ 2 */
  console.log('2. Nothing is promised when there is nothing to confirm.');
  const noEmail = await book('NoEmail', { email: '' });
  h.check('a booking with no email: created, no row', noEmail.status === 201 && (await events(noEmail.payload.id)).length === 0, show(noEmail));
  const nullEmail = await book('NullEmail', { email: null });
  h.check('a booking with a null email: created, no row', nullEmail.status === 201 && (await events(nullEmail.payload.id)).length === 0, show(nullEmail));
  const instant = await book('Instant', { instant: true, roomId: fixture.rooms.A1.id });
  h.check('an instant check-in with an email: created, no row', instant.status === 201 && (await events(instant.payload.id)).length === 0, show(instant));
  const before = (await events()).length;
  const failed = await book('Failed', { category: fixture.categoryB });
  h.check('a booking that fails is refused', failed.status >= 400 && failed.status < 500, show(failed));
  h.check('and leaves no outbox row behind', (await events()).length === before);

  /* ------------------------------------------------------------------ 3 */
  console.log('3. The worker handler sends it once.');
  const sent = await deliver(fixture.propertyId, { reservationId: stay.id });
  const mails = captured();
  h.check('first delivery: SENT', sent === 'SENT', String(sent));
  h.check('one message captured, to the guest', mails.length === 1 && mails[0].to === 'alpha@guest.invalid', JSON.stringify(mails.map((m) => m.to)));
  h.check('subject names the booking code', mails[0]?.subject?.includes(stay.bookingCode) && mails[0]?.subject?.startsWith('Booking confirmed: '), mails[0]?.subject);
  const text = mails[0]?.text ?? '';
  h.check('body: the guest, the dates, the room and the guests', text.includes('Dear Confirm Alpha,') && text.includes('Nights: 2') && text.includes('Guests: 2 adults, 1 child') && text.includes('Board: Breakfast included'), text);
  h.check('body: paid 1,000 and the balance due', text.includes('Paid: ₹1,000.00') && text.includes('Balance due:'), text);
  h.check('one RESERVATION_CONFIRMATION_SENT audit row, no address in it', (await sentMarkers(stay.id)) === 1 && !JSON.stringify(await prisma.auditLog.findFirst({ where: { entityId: stay.id, event: CONFIRMATION_SENT_EVENT }, select: { after: true } })).includes('@'));
  const again = await deliver(fixture.propertyId, { reservationId: stay.id });
  h.check('a replayed delivery: ALREADY_SENT, nothing sent', again === 'ALREADY_SENT' && captured().length === 1 && (await sentMarkers(stay.id)) === 1, String(again));

  /* ------------------------------------------------------------------ 4 */
  console.log('4. A stay cancelled before delivery is not confirmed.');
  const late = await book('Cancelled');
  const cancel = await h.call('POST', `${base}/reservations/${late.payload.id}/cancel`, clerk, { reason: 'Changed plans' });
  h.check('cancelled', ok(cancel), show(cancel));
  const skipped = await deliver(fixture.propertyId, { reservationId: late.payload.id });
  h.check('delivery: NOT_CONFIRMABLE, no mail, no marker', skipped === 'NOT_CONFIRMABLE' && captured().length === 1 && (await sentMarkers(late.payload.id)) === 0, String(skipped));

  /* ------------------------------------------------------------------ 5 */
  console.log('5. Refusals and retries.');
  const cross = await outcomeOf(deliver(theirs.propertyId, { reservationId: (await book('Cross')).payload.id }));
  h.check("another property's event naming this stay: permanent, nothing sent", cross.error instanceof OutboxPermanentError && captured().length === 1, String(cross.error?.message ?? cross.value));
  const malformed = await outcomeOf(deliver(fixture.propertyId, { reservation: 'nope' }));
  h.check('a malformed payload: permanent', malformed.error instanceof OutboxPermanentError, String(malformed.error?.message ?? malformed.value));
  const flaky = await book('Flaky');
  const relayDown = { delivers: true, send: () => Promise.reject(new Error('relay unavailable')) };
  const failedSend = await outcomeOf(deliver(fixture.propertyId, { reservationId: flaky.payload.id }, relayDown));
  h.check('a relay failure throws a retryable error', failedSend.error !== null && !(failedSend.error instanceof OutboxPermanentError), String(failedSend.error?.message));
  h.check('and records no marker, so the retry will send', (await sentMarkers(flaky.payload.id)) === 0);
  const retried = await deliver(fixture.propertyId, { reservationId: flaky.payload.id });
  h.check('the retry sends: SENT, one more message', retried === 'SENT' && captured().length === 2, String(retried));
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
      rmSync(captureDir, { recursive: true, force: true });
    }
  },
});
