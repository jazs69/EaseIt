/**
 * Channel manager (CM-01 .. CM-05), against a Channex stand-in.
 *
 * ===========================================================================
 * The staff side runs through the real API: permissions, tenancy, connect,
 * mapping validation, activate/pause, sync, inbound retry/resolve.
 *
 * The worker side -- scheduler, ARI push, booking pull, apply -- is the
 * compiled code constructed here, the way night-audit.test.mjs drives its
 * runner, on a client logged in as the API's own non-superuser role
 * (easeit_app) behind the tenancy extension, inside the event's property
 * scope exactly as the worker runs a handler. So RLS and the triggers are
 * exercised as in production, and the provider is a local HTTP stand-in that
 * records every request and can be told to fail.
 *
 * Asserted (CLAUDE.md 3.1, 3.1.1 rule 6, 3.2, 5):
 *   - triggers record ARI changes in the writer's transaction, per date and
 *     category, under RLS; nothing while paused; an allowance-only change is
 *     not a change;
 *   - one push in flight per connection (scheduler), debounce honoured;
 *   - the push sends physical - sold - blocked (never the allowance), the
 *     plan's nightly rate, restrictions, stop-sell for an inactive plan;
 *     change rows deleted only on acknowledgement, rows written mid-push kept;
 *     5xx retryable, 422 permanent; every call logged with request/response;
 *   - pull stores raw (no card data) before acknowledging; a re-sent revision
 *     is stored once;
 *   - apply: NEW books at the OTA's nightly price through the booking
 *     transaction; 6 concurrent applies of one revision make one reservation;
 *     unmapped / unreadable / modification / earlier revision go to a person;
 *     CANCELLED releases each night once; a guest in house is not cancelled;
 *   - the last room raced by 6 desk bookings and an OTA booking: exactly one
 *     wins, sold == live reservation_room rows per date and per category;
 *   - another property's connection is not found, never forbidden.
 *
 * API requirements: CHANNEX_API_KEY=suite-channex-key and
 * CHANNEX_BASE_URL=http://127.0.0.1:4994 (the stand-in). Without them the
 * suite asserts that activation is refused and activates through the
 * database instead, noting it.
 * ===========================================================================
 */

await import(new URL('../../apps/api/node_modules/reflect-metadata/Reflect.js', import.meta.url));
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

import {
  createHarness,
  requireEnvironment,
  runSuite,
  shiftDays,
  utcMidnight,
} from '../support/room-fixture.mjs';

const SUITE = 'channel manager';
requireEnvironment(SUITE);

const databaseModule = await import('../../packages/database/dist/index.js');
const db = databaseModule.default ?? databaseModule;
const { createPrismaClient, createTenantClient, runInPropertyScope } = db;
const owner = createPrismaClient();

const DIST = '../../apps/api/dist/modules';
async function load(relative) {
  const loaded = await import(new URL(`${DIST}/${relative}`, import.meta.url));
  return Object.keys(loaded).some((key) => key !== 'default') ? loaded : (loaded.default ?? loaded);
}
const { AriPushService } = await load('channels/ari-push.service.js');
const { InboundService } = await load('channels/inbound.service.js');
const { ChannelSyncScheduler } = await load('channels/channel-sync.scheduler.js');
const { ChannelAdapters, ChannelSyncLog } = await load('channels/channel-adapters.js');
const { ChannexAdapter } = await load('channels/channex/channex.adapter.js');
const { CreateReservationService } = await load('reservations/create-reservation.service.js');
const { CancelReservationService } = await load('reservations/cancel-reservation.service.js');
const { PropertyTaxService } = await load('properties/property-tax.service.js');
const { RateCalendarService } = await load('rates/rate-calendar.service.js');
const { RateCalendarRepository } = await load('rates/rate-calendar.repository.js');
const { RatePricingRuleRepository } = await load('rates/rate-pricing-rule.repository.js');
const { RateRestrictionRepository } = await load('rates/rate-restriction.repository.js');
const { OutboxService } = await load('platform/outbox/outbox.service.js');
const { OutboxPermanentError } = await load('platform/outbox/outbox-handler.registry.js');
const { ClockService } = await load('platform/clock.service.js');

/* ------------------------------------------------------------------ */
/*  The API's own login, behind the tenancy extension (as the worker)  */
/* ------------------------------------------------------------------ */

function appUrl() {
  if (process.env.APP_DATABASE_URL) return process.env.APP_DATABASE_URL;
  const env = readFileSync(new URL('../../apps/api/.env', import.meta.url), 'utf8');
  const raw = /^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m.exec(env)?.[1];
  if (!raw) throw new Error('No DATABASE_URL in apps/api/.env to derive the app login from.');
  const url = new URL(raw);
  url.pathname = new URL(process.env.DATABASE_URL).pathname;
  return url.toString();
}
const ownerUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = appUrl();
const rawApp = createPrismaClient();
process.env.DATABASE_URL = ownerUrl;
const app = createTenantClient(rawApp);
const prismaStub = { client: app, ping: async () => true };

/* ------------------------------------------------------------------ */
/*  The Channex stand-in                                               */
/* ------------------------------------------------------------------ */

const PORT = Number(process.env.CHANNEX_STANDIN_PORT ?? 4994);
const standin = {
  requests: [],
  feed: [],
  acked: new Set(),
  failNext: [], // statuses to answer with, one per request, before succeeding
  onAvailability: null,
};
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', async () => {
    const parsed = body === '' ? null : JSON.parse(body);
    standin.requests.push({
      method: req.method,
      url: req.url,
      key: req.headers['user-api-key'],
      body: parsed,
    });
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const forced = standin.failNext.shift();
    if (forced !== undefined)
      return send(forced, { errors: { code: 'forced', title: `forced ${String(forced)}` } });
    if (req.url === '/api/v1/availability') {
      if (standin.onAvailability !== null) await standin.onAvailability();
      return send(200, { data: [{ id: 'task-a', type: 'task' }], meta: { message: 'Success' } });
    }
    if (req.url === '/api/v1/restrictions')
      return send(200, { data: [{ id: 'task-r', type: 'task' }], meta: { message: 'Success' } });
    if (req.url?.startsWith('/api/v1/booking_revisions/feed')) {
      return send(200, {
        data: standin.feed.filter((item) => !standin.acked.has(item.id)),
        meta: {},
      });
    }
    const ack = /^\/api\/v1\/booking_revisions\/([^/]+)\/ack$/.exec(req.url ?? '');
    if (ack !== null) {
      standin.acked.add(decodeURIComponent(ack[1]));
      return send(200, { meta: { message: 'Success' } });
    }
    return send(404, { errors: { code: 'not_found', title: 'Not found' } });
  });
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

/* ------------------------------------------------------------------ */
/*  The worker side, constructed                                       */
/* ------------------------------------------------------------------ */

const clock = new ClockService();
const configValues = {
  CHANNEX_API_KEY: 'suite-channex-key',
  CHANNEX_BASE_URL: `http://127.0.0.1:${String(PORT)}`,
  CHANNEX_TIMEOUT_MS: 3_000,
  CHANNEL_ARI_DEBOUNCE_MS: 0,
  CHANNEL_PULL_INTERVAL_MS: 5_000,
  CHANNEL_ARI_WINDOW_DAYS: 30,
};
const config = { get: (key, fallback) => (key in configValues ? configValues[key] : fallback) };
const adapters = new ChannelAdapters([new ChannexAdapter(config, clock)]);
const syncLog = new ChannelSyncLog(prismaStub);
const rateCalendar = new RateCalendarService(
  prismaStub,
  new RateCalendarRepository(prismaStub),
  new RatePricingRuleRepository(prismaStub),
  new RateRestrictionRepository(prismaStub),
);
const outbox = new OutboxService(prismaStub);
const bookings = new CreateReservationService(
  prismaStub,
  new PropertyTaxService(prismaStub),
  rateCalendar,
  null,
  outbox,
);
const cancels = new CancelReservationService(prismaStub);
const ari = new AriPushService(
  prismaStub,
  adapters,
  syncLog,
  rateCalendar,
  new RateCalendarRepository(prismaStub),
  new RateRestrictionRepository(prismaStub),
  config,
  clock,
);
const inbound = new InboundService(prismaStub, adapters, syncLog, bookings, cancels, clock);
const scheduler = new ChannelSyncScheduler(prismaStub, outbox, config);

/** What the worker does: run inside the event's property scope. */
const asWorker = (propertyId, work) => runInPropertyScope(propertyId, work);

const h = createHarness({
  suiteName: SUITE,
  prefix: 'ZZCHN',
  slugPrefix: 'zz-chn-',
  emailDomain: 'chn.invalid',
  prisma: owner,
});
const other = createHarness({
  suiteName: `${SUITE} (other)`,
  prefix: 'ZZCHX',
  slugPrefix: 'zz-chx-',
  emailDomain: 'chx.invalid',
  prisma: owner,
});

const show = (res) =>
  `HTTP ${String(res.status)} ${res.payload?.code ?? ''} ${JSON.stringify(res.payload?.details ?? '').slice(0, 200)}`;
const iso = (date) => date.toISOString().slice(0, 10);

function revision(id, attributes) {
  return {
    id,
    type: 'booking_revision',
    attributes: {
      currency: 'INR',
      ota_name: 'BookingCom',
      payment_collect: 'property',
      customer: {
        name: 'Meera',
        surname: 'Iyer',
        mail: 'meera@example.invalid',
        phone: '+91 90000 00000',
        country: 'IN',
      },
      guarantee: { card_number: '4111111111111111', cvv: '123', expiration_date: '12/30' },
      ...attributes,
    },
  };
}
const room = (externalRoomTypeId, externalRatePlanId, arrival, nights, amount) => ({
  room_type_id: externalRoomTypeId,
  rate_plan_id: externalRatePlanId,
  checkin_date: arrival,
  checkout_date: shiftDays(arrival, nights),
  days: Object.fromEntries(
    Array.from({ length: nights }, (_, i) => [shiftDays(arrival, i), amount]),
  ),
  occupancy: { adults: 2, children: 0, infants: 0 },
});

async function body() {
  console.log('\n════ channel manager (CM-01 .. CM-05) ════\n');
  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}`);
  const [who] = await rawApp.$queryRaw`SELECT current_user AS who, current_database() AS db`;
  h.check(
    'the worker-side client is the API login on the test database',
    who.who !== 'postgres' && who.db === serverDb,
    `${who.who} @ ${who.db}`,
  );
  await h.sweepLeftovers();
  await other.sweepLeftovers();

  const fx = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', revenue: 'REVENUE_MANAGER', clerk: 'FRONT_DESK' },
    rooms: [
      { label: 'A1', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'A2', category: 'A', status: 'VACANT_CLEAN' },
      { label: 'B1', category: 'B', status: 'VACANT_CLEAN' },
    ],
  });
  const fy = await other.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN' },
    rooms: [{ label: 'A1', category: 'A', status: 'VACANT_CLEAN' }],
  });
  await h.assertApiSharesDatabase(fx, fx.users.admin.cookie, liveDb);

  const D = fx.today;
  // Category A: 4 rooms a night; category B: exactly 1 (the race target).
  for (const f of [fx, fy]) {
    await owner.inventoryDay.createMany({
      data: Array.from({ length: 40 }, (_, i) => [
        {
          propertyId: f.propertyId,
          roomTypeId: f.categoryA,
          stayDate: utcMidnight(shiftDays(D, i)),
          physical: 4,
        },
        {
          propertyId: f.propertyId,
          roomTypeId: f.categoryB,
          stayDate: utcMidnight(shiftDays(D, i)),
          physical: 1,
        },
      ]).flat(),
    });
  }
  // Two plans on A (one inactive), one on B.
  const plan = async (code, isActive, assignments) => {
    const row = await owner.ratePlan.create({
      data: {
        propertyId: fx.propertyId,
        code: `${fx.runId}${code}`,
        name: `ZZ ${code} ${fx.runId}`,
        currency: 'INR',
        isActive,
        createdByUserId: fx.users.admin.id,
      },
      select: { id: true },
    });
    await owner.ratePlanRoomType.createMany({
      data: assignments.map(([roomTypeId, defaultRateMinor]) => ({
        propertyId: fx.propertyId,
        ratePlanId: row.id,
        roomTypeId,
        defaultRateMinor,
      })),
    });
    return row.id;
  };
  const bar = await plan('BAR', true, [
    [fx.categoryA, 450000],
    [fx.categoryB, 300000],
  ]);
  const old = await plan('OLD', false, [[fx.categoryA, 999900]]);
  const base = `/properties/${fx.propertyCode}/channels`;
  const admin = fx.users.admin.cookie;

  /* -------------------------------------------------------------- 1 */
  console.log('\n1. Permissions and tenancy on the staff API.');
  const clerkRead = await h.call('GET', base, fx.users.clerk.cookie);
  h.check(
    'front desk is refused channels:read with 403',
    clerkRead.status === 403 && clerkRead.payload?.details?.requiredPermission === 'channels:read',
    show(clerkRead),
  );
  const revenueRead = await h.call('GET', base, fx.users.revenue.cookie);
  h.check(
    'the revenue manager reads the overview (channels:read is grantable now)',
    revenueRead.status === 200,
    show(revenueRead),
  );
  const strangerRead = await h.call('GET', base, fy.users.admin.cookie);
  h.check(
    "another property's admin gets 404 for this property, never 403",
    strangerRead.status === 404,
    show(strangerRead),
  );
  const overview = await h.call('GET', base, admin);
  const configured =
    overview.payload?.providers?.find((p) => p.provider === 'CHANNEX')?.configured === true;
  h.check(
    'the overview lists the provider and both room types with their plans',
    overview.status === 200 &&
      overview.payload.roomTypes.length === 2 &&
      overview.payload.roomTypes.find((t) => t.roomTypeId === fx.categoryA)?.ratePlans.length === 2,
    show(overview),
  );
  if (!configured)
    h.note(
      'the API has no CHANNEX_API_KEY: activation refusal is asserted, then activation goes through the database',
    );

  /* -------------------------------------------------------------- 2 */
  console.log('\n2. Connect, map, activate.');
  const clerkCreate = await h.call('POST', base, fx.users.clerk.cookie, {
    provider: 'CHANNEX',
    externalPropertyId: 'cx-prop',
  });
  h.check('connecting needs channels:manage', clerkCreate.status === 403, show(clerkCreate));
  const created = await h.call('POST', base, fx.users.revenue.cookie, {
    provider: 'CHANNEX',
    externalPropertyId: 'cx-prop',
  });
  h.check(
    'the revenue manager connects; it starts PAUSED',
    created.status === 201 && created.payload.status === 'PAUSED',
    show(created),
  );
  const conn = created.payload.id;
  h.note(`connection ${conn}`);
  const dup = await h.call('POST', base, admin, {
    provider: 'CHANNEX',
    externalPropertyId: 'other',
  });
  h.check('a second connection to the same provider is refused', dup.status === 400, show(dup));

  const badMap = await h.call('PUT', `${base}/${conn}/mappings`, admin, {
    roomTypes: [
      {
        roomTypeId: fx.categoryB,
        externalRoomTypeId: 'cx-rt-b',
        ratePlans: [{ ratePlanId: old, externalRatePlanId: 'cx-rp-old' }],
      },
    ],
  });
  h.check(
    'a rate plan that does not price the room type is refused',
    badMap.status === 400 && JSON.stringify(badMap.payload?.details).includes('does not price'),
    show(badMap),
  );
  const foreignMap = await h.call('PUT', `${base}/${conn}/mappings`, admin, {
    roomTypes: [{ roomTypeId: fy.categoryA, externalRoomTypeId: 'cx-rt-x', ratePlans: [] }],
  });
  h.check(
    "another property's room type cannot be mapped",
    foreignMap.status === 400,
    show(foreignMap),
  );
  const dupExternal = await h.call('PUT', `${base}/${conn}/mappings`, admin, {
    roomTypes: [
      { roomTypeId: fx.categoryA, externalRoomTypeId: 'same', ratePlans: [] },
      { roomTypeId: fx.categoryB, externalRoomTypeId: 'same', ratePlans: [] },
    ],
  });
  h.check(
    'one provider room type cannot be mapped twice',
    dupExternal.status === 400,
    show(dupExternal),
  );

  const early = await h.call('POST', `${base}/${conn}/activate`, admin, {});
  h.check('switching on with no mapping is refused', early.status === 400, show(early));

  const mapped = await h.call('PUT', `${base}/${conn}/mappings`, admin, {
    roomTypes: [
      {
        roomTypeId: fx.categoryA,
        externalRoomTypeId: 'cx-rt-a',
        ratePlans: [
          { ratePlanId: bar, externalRatePlanId: 'cx-rp-a-bar' },
          { ratePlanId: old, externalRatePlanId: 'cx-rp-a-old' },
        ],
      },
      {
        roomTypeId: fx.categoryB,
        externalRoomTypeId: 'cx-rt-b',
        ratePlans: [{ ratePlanId: bar, externalRatePlanId: 'cx-rp-b-bar' }],
      },
    ],
  });
  h.check(
    'a valid mapping is saved',
    mapped.status === 200 && mapped.payload.mappings.length === 2,
    show(mapped),
  );
  const mapAudit = await owner.auditLog.count({
    where: { propertyId: fx.propertyId, event: 'CHANNEL_MAPPINGS_SET', entityId: conn },
  });
  h.check('the mapping change wrote an audit row', mapAudit === 1, String(mapAudit));

  // Nothing is recorded while paused.
  const pausedDay = await owner.ratePlanDay.create({
    data: {
      propertyId: fx.propertyId,
      ratePlanId: bar,
      roomTypeId: fx.categoryA,
      stayDate: utcMidnight(shiftDays(D, 20)),
      amountMinor: 460000,
      updatedByUserId: fx.users.admin.id,
    },
  });
  h.check(
    'a paused connection records no ARI change',
    (await owner.channelAriChange.count({ where: { connectionId: conn } })) === 0,
  );
  await owner.ratePlanDay.delete({ where: { id: pausedDay.id } });

  const activated = await h.call('POST', `${base}/${conn}/activate`, admin, {});
  if (configured) {
    h.check(
      'switching on succeeds once mapped',
      activated.status === 200 && activated.payload.status === 'ACTIVE',
      show(activated),
    );
  } else {
    h.check(
      'switching on is refused while the server has no credentials',
      activated.status === 400,
      show(activated),
    );
    await owner.channelConnection.update({ where: { id: conn }, data: { status: 'ACTIVE' } });
    await owner.channelAriChange.create({
      data: { propertyId: fx.propertyId, connectionId: conn },
    });
  }
  const whole = await owner.channelAriChange.findMany({ where: { connectionId: conn } });
  h.check(
    'activation records one whole-window change',
    whole.length === 1 && whole[0].roomTypeId === null && whole[0].fromDate === null,
    JSON.stringify(whole.map((w) => [w.roomTypeId, w.fromDate])),
  );

  /* -------------------------------------------------------------- 3 */
  console.log("\n3. Change capture in the writer's transaction.");
  await owner.channelAriChange.deleteMany({ where: { connectionId: conn } });
  const deskStay = await h.call('POST', `/properties/${fx.propertyCode}/reservations`, admin, {
    roomTypeId: fx.categoryA,
    roomId: null,
    arrivalDate: shiftDays(D, 3),
    departureDate: shiftDays(D, 6),
    adults: 1,
    mealPlan: 'EP',
    source: 'PHONE',
    guests: [{ firstName: 'Desk', lastName: 'Guest' }],
    isInstantCheckIn: false,
  });
  h.check('a desk booking through the API succeeds', deskStay.status === 201, show(deskStay));
  const captured = await owner.channelAriChange.findMany({ where: { connectionId: conn } });
  h.check(
    'the booking (as easeit_app, under RLS) recorded its nights for category A',
    captured.length === 1 &&
      captured[0].roomTypeId === fx.categoryA &&
      iso(captured[0].fromDate) === shiftDays(D, 3) &&
      iso(captured[0].toDate) === shiftDays(D, 5),
    JSON.stringify(
      captured.map((c) => [
        c.roomTypeId === fx.categoryA ? 'A' : c.roomTypeId,
        c.fromDate && iso(c.fromDate),
        c.toDate && iso(c.toDate),
      ]),
    ),
  );
  await owner.channelAriChange.deleteMany({ where: { connectionId: conn } });
  await owner.inventoryDay.updateMany({
    where: {
      propertyId: fx.propertyId,
      roomTypeId: fx.categoryA,
      stayDate: utcMidnight(shiftDays(D, 9)),
    },
    data: { overbookingAllowance: 2 },
  });
  h.check(
    'an overbooking-allowance change alone is not pushed',
    (await owner.channelAriChange.count({ where: { connectionId: conn } })) === 0,
  );
  await owner.inventoryDay.updateMany({
    where: {
      propertyId: fx.propertyId,
      roomTypeId: fx.categoryA,
      stayDate: utcMidnight(shiftDays(D, 9)),
    },
    data: { overbookingAllowance: 0 },
  });
  await owner.ratePlanDay.create({
    data: {
      propertyId: fx.propertyId,
      ratePlanId: bar,
      roomTypeId: fx.categoryA,
      stayDate: utcMidnight(shiftDays(D, 4)),
      amountMinor: 520000,
      updatedByUserId: fx.users.admin.id,
    },
  });
  await owner.rateRestrictionDay.create({
    data: {
      propertyId: fx.propertyId,
      ratePlanId: bar,
      roomTypeId: fx.categoryA,
      stayDate: utcMidnight(shiftDays(D, 5)),
      minLos: 2,
      closedToArrival: true,
      updatedByUserId: fx.users.admin.id,
    },
  });
  const rateRows = await owner.channelAriChange.findMany({
    where: { connectionId: conn },
    orderBy: { id: 'asc' },
  });
  h.check(
    'a rate override and a restriction each recorded their date',
    rateRows.length === 2 &&
      iso(rateRows[0].fromDate) === shiftDays(D, 4) &&
      iso(rateRows[1].fromDate) === shiftDays(D, 5),
    String(rateRows.length),
  );

  /* -------------------------------------------------------------- 4 */
  console.log('\n4. Scheduling: one push per connection, debounced.');
  await owner.outboxEvent.deleteMany({ where: { propertyId: fx.propertyId } });
  const first = await scheduler.tick([conn]);
  h.check(
    'the scheduler enqueues a push and a pull',
    first.enqueued.some((e) => e.kind === 'CHANNEL_ARI_PUSH') &&
      first.enqueued.some((e) => e.kind === 'CHANNEL_BOOKINGS_PULL'),
    JSON.stringify(first.enqueued),
  );
  const second = await scheduler.tick([conn]);
  h.check(
    'a second tick enqueues nothing while those are pending',
    second.enqueued.length === 0,
    JSON.stringify(second.enqueued),
  );
  await owner.outboxEvent.updateMany({
    where: { propertyId: fx.propertyId, eventType: 'CHANNEL_ARI_PUSH' },
    data: {
      status: 'IN_FLIGHT',
      claimedBy: 'suite',
      claimedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  h.check('nor while one is in flight', (await scheduler.tick([conn])).enqueued.length === 0);
  await owner.outboxEvent.deleteMany({ where: { propertyId: fx.propertyId } });
  configValues.CHANNEL_ARI_DEBOUNCE_MS = 600_000;
  const debounced = await scheduler.tick([conn]);
  h.check(
    'fresh changes wait out the debounce',
    !debounced.enqueued.some((e) => e.kind === 'CHANNEL_ARI_PUSH'),
    JSON.stringify(debounced.enqueued),
  );
  configValues.CHANNEL_ARI_DEBOUNCE_MS = 0;
  await owner.outboxEvent.deleteMany({ where: { propertyId: fx.propertyId } });

  /* -------------------------------------------------------------- 5 */
  console.log('\n5. The push: what is sent, and when change rows go.');
  await owner.channelAriChange.create({ data: { propertyId: fx.propertyId, connectionId: conn } }); // whole window
  await owner.inventoryDay.updateMany({
    where: {
      propertyId: fx.propertyId,
      roomTypeId: fx.categoryA,
      stayDate: utcMidnight(shiftDays(D, 10)),
    },
    data: { overbookingAllowance: 3 },
  });
  standin.requests.length = 0;
  const pushed = await asWorker(fx.propertyId, () => ari.push(fx.propertyId, conn));
  h.check(
    'the push reports what it sent',
    pushed.kind === 'PUSHED' && pushed.calls >= 2,
    JSON.stringify(pushed),
  );
  const availReq = standin.requests.find((r) => r.url === '/api/v1/availability');
  const restReq = standin.requests.find((r) => r.url === '/api/v1/restrictions');
  h.check('requests carry the API key header', availReq?.key === 'suite-channex-key');
  const availOn = (externalRoomTypeId, date) =>
    availReq?.body.values.find(
      (v) => v.room_type_id === externalRoomTypeId && v.date_from <= date && v.date_to >= date,
    )?.availability;
  h.check(
    'availability = physical - sold - blocked, never the allowance',
    availOn('cx-rt-a', shiftDays(D, 0)) === 4 &&
      availOn('cx-rt-a', shiftDays(D, 3)) === 3 &&
      availOn('cx-rt-a', shiftDays(D, 10)) === 4 &&
      availOn('cx-rt-b', shiftDays(D, 0)) === 1,
    `A today ${availOn('cx-rt-a', shiftDays(D, 0))}, A booked ${availOn('cx-rt-a', shiftDays(D, 3))}, A with allowance 3 ${availOn('cx-rt-a', shiftDays(D, 10))}, B ${availOn('cx-rt-b', shiftDays(D, 0))}`,
  );
  h.check(
    'the push stops at the end of the window',
    availOn('cx-rt-a', shiftDays(D, 29)) === 4 &&
      availReq.body.values.every((v) => v.date_to <= shiftDays(D, 29)),
  );
  h.check(
    'consecutive equal nights are compressed into ranges',
    availReq.body.values.length < 20,
    String(availReq?.body.values.length),
  );
  const rateOn = (externalRatePlanId, date) =>
    restReq?.body.values.find(
      (v) => v.rate_plan_id === externalRatePlanId && v.date_from <= date && v.date_to >= date,
    );
  h.check(
    "the plan's nightly rate, the date override and the restriction are sent",
    rateOn('cx-rp-a-bar', shiftDays(D, 0))?.rate === '4500.00' &&
      rateOn('cx-rp-a-bar', shiftDays(D, 4))?.rate === '5200.00' &&
      rateOn('cx-rp-a-bar', shiftDays(D, 5))?.closed_to_arrival === true &&
      rateOn('cx-rp-a-bar', shiftDays(D, 5))?.min_stay_arrival === 2 &&
      rateOn('cx-rp-b-bar', shiftDays(D, 0))?.rate === '3000.00',
    JSON.stringify([
      rateOn('cx-rp-a-bar', shiftDays(D, 4)),
      rateOn('cx-rp-a-bar', shiftDays(D, 5)),
    ]),
  );
  h.check(
    'an inactive plan is pushed as stop-sell with no price',
    rateOn('cx-rp-a-old', shiftDays(D, 0))?.stop_sell === true &&
      !('rate' in (rateOn('cx-rp-a-old', shiftDays(D, 0)) ?? { rate: 1 })),
  );
  h.check(
    'acknowledged: every change row read is deleted',
    (await owner.channelAriChange.count({ where: { connectionId: conn } })) === 0,
  );
  const logged = await owner.channelSyncAttempt.findMany({
    where: { connectionId: conn, operation: { in: ['ARI_AVAILABILITY', 'ARI_RATES'] } },
  });
  h.check(
    'every call is logged with its request and response',
    logged.length === pushed.calls &&
      logged.every((l) => l.ok && l.requestBody !== null && l.responseBody !== null),
    String(logged.length),
  );
  const synced = await owner.channelConnection.findUnique({
    where: { id: conn },
    select: { lastAriSyncAt: true, lastAriError: true },
  });
  h.check(
    'the connection records the sync',
    synced.lastAriSyncAt !== null && synced.lastAriError === null,
  );

  // A change committed while the push is on the wire survives it.
  await owner.channelAriChange.create({
    data: {
      propertyId: fx.propertyId,
      connectionId: conn,
      roomTypeId: fx.categoryA,
      fromDate: utcMidnight(shiftDays(D, 1)),
      toDate: utcMidnight(shiftDays(D, 1)),
    },
  });
  standin.onAvailability = async () => {
    standin.onAvailability = null;
    await owner.channelAriChange.create({
      data: {
        propertyId: fx.propertyId,
        connectionId: conn,
        roomTypeId: fx.categoryB,
        fromDate: utcMidnight(shiftDays(D, 2)),
        toDate: utcMidnight(shiftDays(D, 2)),
      },
    });
  };
  await asWorker(fx.propertyId, () => ari.push(fx.propertyId, conn));
  const survivors = await owner.channelAriChange.findMany({ where: { connectionId: conn } });
  h.check(
    'a change written during a push waits for the next push',
    survivors.length === 1 && survivors[0].roomTypeId === fx.categoryB,
    String(survivors.length),
  );

  standin.failNext.push(503);
  let transient = null;
  try {
    await asWorker(fx.propertyId, () => ari.push(fx.propertyId, conn));
  } catch (error) {
    transient = error;
  }
  h.check(
    'a 5xx fails the push as retryable',
    transient !== null && !(transient instanceof OutboxPermanentError),
    String(transient?.message),
  );
  h.check(
    'and keeps the change rows',
    (await owner.channelAriChange.count({ where: { connectionId: conn } })) === 1,
  );
  const failedLog = await owner.channelSyncAttempt.findFirst({
    where: { connectionId: conn, ok: false },
    orderBy: { createdAt: 'desc' },
  });
  h.check(
    'the failed call is logged with its status',
    failedLog?.responseStatus === 503 && failedLog.error?.includes('503'),
    String(failedLog?.error),
  );
  standin.failNext.push(422);
  let permanent = null;
  try {
    await asWorker(fx.propertyId, () => ari.push(fx.propertyId, conn));
  } catch (error) {
    permanent = error;
  }
  h.check(
    'a 422 is permanent (dead-letters and alerts)',
    permanent instanceof OutboxPermanentError,
    String(permanent?.message),
  );
  h.check(
    'the error is shown on the connection',
    (await owner.channelConnection.findUnique({ where: { id: conn } })).lastAriError?.includes(
      '422',
    ),
  );
  await asWorker(fx.propertyId, () => ari.push(fx.propertyId, conn));
  h.check(
    'the next push delivers and clears it',
    (await owner.channelAriChange.count({ where: { connectionId: conn } })) === 0,
  );

  const cross = await asWorker(fy.propertyId, () => ari.push(fy.propertyId, conn));
  h.check(
    "another property's scope cannot push this connection",
    cross.kind === 'NO_CONNECTION',
    cross.kind,
  );

  /* -------------------------------------------------------------- 6 */
  console.log('\n6. Pull: stored raw first, acknowledged after.');
  const stayArrival = shiftDays(D, 12);
  standin.feed.push(
    revision('rev-new-1', {
      booking_id: 'bk-1',
      status: 'new',
      ota_reservation_code: 'BDC-1',
      amount: '9000.00',
      ota_commission: '1350.00',
      rooms: [room('cx-rt-a', 'cx-rp-a-bar', stayArrival, 2, '4100.00')],
    }),
  );
  const pulled = await asWorker(fx.propertyId, () => inbound.pull(fx.propertyId, conn));
  h.check(
    'one revision fetched, stored and acknowledged',
    pulled.fetched === 1 && pulled.stored === 1 && pulled.acknowledged === 1,
    JSON.stringify(pulled),
  );
  const storedMsg = await owner.channelInboundMessage.findFirst({
    where: { connectionId: conn, externalMessageId: 'rev-new-1' },
  });
  h.check(
    'stored raw, RECEIVED, with no card data',
    storedMsg?.status === 'RECEIVED' &&
      !JSON.stringify(storedMsg.rawPayload).includes('4111') &&
      JSON.stringify(storedMsg.rawPayload).includes('BDC-1'),
  );
  const pullLog = await owner.channelSyncAttempt.findFirst({
    where: { connectionId: conn, operation: 'BOOKINGS_PULL' },
  });
  h.check(
    'the pull is logged as a count, not a guest payload',
    pullLog?.responseBody?.revisions === 1 && !JSON.stringify(pullLog).includes('Meera'),
  );
  standin.acked.delete('rev-new-1'); // the acknowledgement was "lost": Channex resends
  const again = await asWorker(fx.propertyId, () => inbound.pull(fx.propertyId, conn));
  h.check(
    'a re-sent revision is stored once and acknowledged again',
    again.fetched === 1 && again.stored === 0 && again.acknowledged === 1,
    JSON.stringify(again),
  );

  /* -------------------------------------------------------------- 7 */
  console.log('\n7. Apply: a NEW booking, once, at the OTA price.');
  const soldBefore = await owner.inventoryDay.findMany({
    where: {
      propertyId: fx.propertyId,
      roomTypeId: fx.categoryA,
      stayDate: { in: [utcMidnight(stayArrival), utcMidnight(shiftDays(stayArrival, 1))] },
    },
    orderBy: { stayDate: 'asc' },
  });
  // Six workers apply the same stored revision at once (a reclaimed lease, a
  // second worker): the per-booking advisory lock and the unique link row
  // must leave exactly one reservation.
  const racers = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      asWorker(fx.propertyId, () => inbound.apply(fx.propertyId, conn)),
    ),
  );
  const appliedRuns = racers.filter((r) => r.status === 'fulfilled');
  h.check(
    'six concurrent applies all finish',
    appliedRuns.length === 6,
    racers
      .filter((r) => r.status === 'rejected')
      .map((r) => String(r.reason?.message))
      .join('; '),
  );
  h.check(
    'the revision is applied',
    (
      await owner.channelInboundMessage.findFirst({
        where: { connectionId: conn, externalMessageId: 'rev-new-1' },
      })
    )?.status === 'APPLIED',
  );
  const link = await owner.channelReservation.findFirst({
    where: { connectionId: conn, externalBookingId: 'bk-1' },
    include: { reservation: { include: { pricedNights: { orderBy: { stayDate: 'asc' } } } } },
  });
  const otaStay = link?.reservation;
  h.check(
    'a CONFIRMED reservation from Booking.com with its reference',
    otaStay?.status === 'CONFIRMED' &&
      otaStay.source === 'BOOKING_COM' &&
      otaStay.otaBookingId === 'BDC-1' &&
      otaStay.otaCommissionMinor === 135000 &&
      otaStay.guestLastName === 'Iyer',
    `${otaStay?.status} ${otaStay?.source} ${otaStay?.otaBookingId}`,
  );
  h.check(
    'each night at the OTA price, taxed per night, integers',
    otaStay?.pricedNights.length === 2 &&
      otaStay.pricedNights.every(
        (n) => n.rateMinor === 410000 && n.rateSource === 'MANUAL' && Number.isInteger(n.taxMinor),
      ) &&
      otaStay.totalAmountMinor ===
        otaStay.pricedNights.reduce((s, n) => s + n.rateMinor + n.taxMinor, 0),
    JSON.stringify(otaStay?.pricedNights.map((n) => [n.rateMinor, n.taxMinor])),
  );
  const soldAfter = await owner.inventoryDay.findMany({
    where: {
      propertyId: fx.propertyId,
      roomTypeId: fx.categoryA,
      stayDate: { in: [utcMidnight(stayArrival), utcMidnight(shiftDays(stayArrival, 1))] },
    },
    orderBy: { stayDate: 'asc' },
  });
  h.check(
    'both nights sold once',
    soldAfter.every((row, i) => row.sold === soldBefore[i].sold + 1),
  );
  h.check(
    'an audit row with no staff actor',
    (await owner.auditLog.count({
      where: {
        propertyId: fx.propertyId,
        event: 'CHANNEL_BOOKING_RECEIVED',
        actorUserId: null,
        entityId: otaStay?.id,
      },
    })) === 1,
  );
  h.check(
    'the booking itself changed ARI, so a push is owed',
    (await owner.channelAriChange.count({
      where: { connectionId: conn, roomTypeId: fx.categoryA },
    })) >= 1,
  );

  const links = await owner.channelReservation.count({
    where: { connectionId: conn, externalBookingId: 'bk-1' },
  });
  const stays = await owner.reservation.count({
    where: { propertyId: fx.propertyId, otaBookingId: 'BDC-1' },
  });
  h.check(
    'one reservation and one link for the six racing applies',
    links === 1 && stays === 1,
    `links ${links}, stays ${stays}`,
  );
  await owner.channelInboundMessage.updateMany({
    where: { connectionId: conn, externalMessageId: 'rev-new-1' },
    data: { status: 'RECEIVED', outcome: null, appliedAt: null },
  });
  await asWorker(fx.propertyId, () => inbound.apply(fx.propertyId, conn));
  const soldReplayNew = await owner.inventoryDay.findMany({
    where: {
      propertyId: fx.propertyId,
      roomTypeId: fx.categoryA,
      stayDate: { in: [utcMidnight(stayArrival), utcMidnight(shiftDays(stayArrival, 1))] },
    },
    orderBy: { stayDate: 'asc' },
  });
  h.check(
    'replaying an applied NEW books nothing more',
    (await owner.reservation.count({
      where: { propertyId: fx.propertyId, otaBookingId: 'BDC-1' },
    })) === 1 && soldReplayNew.every((row, i) => row.sold === soldAfter[i].sold),
  );

  /* -------------------------------------------------------------- 8 */
  console.log('\n8. What goes to a person.');
  standin.feed.push(
    revision('rev-unmapped', {
      booking_id: 'bk-2',
      status: 'new',
      rooms: [room('cx-rt-nope', 'cx-rp-a-bar', stayArrival, 1, '4100.00')],
    }),
  );
  standin.feed.push(
    revision('rev-unmapped-cancel', { booking_id: 'bk-2', status: 'cancelled', rooms: [] }),
  );
  standin.feed.push({
    id: 'rev-garbage',
    type: 'booking_revision',
    attributes: { status: 'new', currency: 'INR' },
  });
  standin.feed.push(
    revision('rev-mod-same', {
      booking_id: 'bk-1',
      status: 'modified',
      ota_reservation_code: 'BDC-1',
      customer: { name: 'Meera', surname: 'Iyer', phone: '+91 1' },
      rooms: [room('cx-rt-a', 'cx-rp-a-bar', stayArrival, 2, '4100.00')],
    }),
  );
  standin.feed.push(
    revision('rev-mod-dates', {
      booking_id: 'bk-1',
      status: 'modified',
      ota_reservation_code: 'BDC-1',
      rooms: [room('cx-rt-a', 'cx-rp-a-bar', stayArrival, 3, '4100.00')],
    }),
  );
  await asWorker(fx.propertyId, () => inbound.pull(fx.propertyId, conn));
  const second2 = await asWorker(fx.propertyId, () => inbound.apply(fx.propertyId, conn));
  const byId = async (id) =>
    owner.channelInboundMessage.findFirst({ where: { connectionId: conn, externalMessageId: id } });
  h.check(
    'an unmapped room type needs attention',
    (await byId('rev-unmapped'))?.attentionCode === 'UNMAPPED_ROOM_TYPE',
  );
  h.check(
    'its later cancellation waits behind it',
    (await byId('rev-unmapped-cancel'))?.attentionCode === 'EARLIER_REVISION',
  );
  const garbage = await byId('rev-garbage');
  h.check(
    'an unreadable message needs attention, raw payload kept',
    garbage?.attentionCode === 'UNREADABLE' && garbage.rawPayload?.id === 'rev-garbage',
  );
  h.check(
    'a modification that changes nothing is applied',
    (await byId('rev-mod-same'))?.status === 'APPLIED',
  );
  const modDates = await byId('rev-mod-dates');
  h.check(
    'a real modification goes to a person, naming the reservation',
    modDates?.attentionCode === 'MODIFICATION' &&
      modDates.outcome?.includes(otaStay.confirmationCode),
  );
  h.check(
    'the apply run counted them',
    second2.needsAttention === 4 && second2.applied === 1,
    JSON.stringify(second2),
  );

  const unmappedMsg = await byId('rev-unmapped');
  const listed = await h.call('GET', `${base}/${conn}/inbound`, fx.users.revenue.cookie);
  h.check(
    'the screen lists what needs attention, with a summary',
    listed.status === 200 &&
      listed.payload.items.length === 4 &&
      listed.payload.items.find((i) => i.id === unmappedMsg.id)?.summary?.guestName ===
        'Meera Iyer',
    show(listed),
  );
  const clerkResolve = await h.call(
    'POST',
    `${base}/${conn}/inbound/${unmappedMsg.id}/resolve`,
    fx.users.clerk.cookie,
    { note: null },
  );
  h.check('resolving needs channels:manage', clerkResolve.status === 403, show(clerkResolve));
  const strangerResolve = await h.call(
    'POST',
    `/properties/${fy.propertyCode}/channels/${conn}/inbound/${unmappedMsg.id}/resolve`,
    fy.users.admin.cookie,
    { note: null },
  );
  h.check(
    "another property's admin cannot reach this message (404)",
    strangerResolve.status === 404,
    show(strangerResolve),
  );
  const resolved = await h.call(
    'POST',
    `${base}/${conn}/inbound/${unmappedMsg.id}/resolve`,
    admin,
    { note: 'Booked by hand as walk-in' },
  );
  h.check(
    'the admin resolves it',
    resolved.status === 200 && resolved.payload.status === 'RESOLVED',
    show(resolved),
  );
  h.check(
    'the revision waiting behind it is released',
    (await byId('rev-unmapped-cancel'))?.status === 'RECEIVED',
  );
  const twice = await h.call('POST', `${base}/${conn}/inbound/${unmappedMsg.id}/resolve`, admin, {
    note: null,
  });
  h.check('a resolved message cannot be resolved again (409)', twice.status === 409, show(twice));
  await asWorker(fx.propertyId, () => inbound.apply(fx.propertyId, conn));
  h.check(
    'a cancellation of a booking handled by hand goes back to a person',
    (await byId('rev-unmapped-cancel'))?.attentionCode === 'REFUSED',
  );

  /* -------------------------------------------------------------- 9 */
  console.log('\n9. Cancellation from the OTA.');
  const soldPreCancel = await owner.inventoryDay.findMany({
    where: {
      propertyId: fx.propertyId,
      roomTypeId: fx.categoryA,
      stayDate: { in: [utcMidnight(stayArrival), utcMidnight(shiftDays(stayArrival, 1))] },
    },
    orderBy: { stayDate: 'asc' },
  });
  // The pending modification would hold it back; a person resolves it first.
  await h.call('POST', `${base}/${conn}/inbound/${modDates.id}/resolve`, admin, {
    note: 'Kept original dates with guest',
  });
  standin.feed.push(
    revision('rev-cancel-1', {
      booking_id: 'bk-1',
      status: 'cancelled',
      ota_reservation_code: 'BDC-1',
      rooms: [],
    }),
  );
  await asWorker(fx.propertyId, () => inbound.pull(fx.propertyId, conn));
  await asWorker(fx.propertyId, () => inbound.apply(fx.propertyId, conn));
  h.check(
    'the cancellation is applied',
    (await byId('rev-cancel-1'))?.status === 'APPLIED',
    (await byId('rev-cancel-1'))?.outcome ?? '',
  );
  const cancelledStay = await owner.reservation.findUnique({ where: { id: otaStay.id } });
  const soldPostCancel = await owner.inventoryDay.findMany({
    where: {
      propertyId: fx.propertyId,
      roomTypeId: fx.categoryA,
      stayDate: { in: [utcMidnight(stayArrival), utcMidnight(shiftDays(stayArrival, 1))] },
    },
    orderBy: { stayDate: 'asc' },
  });
  h.check(
    'the reservation is CANCELLED and each night released once',
    cancelledStay.status === 'CANCELLED' &&
      soldPostCancel.every((row, i) => row.sold === soldPreCancel[i].sold - 1),
  );
  await owner.channelInboundMessage.updateMany({
    where: { connectionId: conn, externalMessageId: 'rev-cancel-1' },
    data: { status: 'RECEIVED' },
  });
  await asWorker(fx.propertyId, () => inbound.apply(fx.propertyId, conn));
  const soldReplay = await owner.inventoryDay.findMany({
    where: {
      propertyId: fx.propertyId,
      roomTypeId: fx.categoryA,
      stayDate: { in: [utcMidnight(stayArrival), utcMidnight(shiftDays(stayArrival, 1))] },
    },
    orderBy: { stayDate: 'asc' },
  });
  h.check(
    'replaying the cancellation releases nothing more',
    soldReplay.every((row, i) => row.sold === soldPostCancel[i].sold),
  );

  // A guest already in house is not cancelled by the OTA.
  standin.feed.push(
    revision('rev-new-3', {
      booking_id: 'bk-3',
      status: 'new',
      ota_reservation_code: 'BDC-3',
      rooms: [room('cx-rt-a', 'cx-rp-a-bar', D, 1, '4000.00')],
    }),
  );
  await asWorker(fx.propertyId, () => inbound.pull(fx.propertyId, conn));
  await asWorker(fx.propertyId, () => inbound.apply(fx.propertyId, conn));
  const inHouse = await owner.channelReservation.findFirst({
    where: { connectionId: conn, externalBookingId: 'bk-3' },
  });
  const checkedIn = await h.call(
    'POST',
    `/properties/${fx.propertyCode}/reservations/${inHouse?.reservationId}/check-in`,
    admin,
    {
      roomId: fx.rooms.A2.id,
      primaryGuestIdType: 'PASSPORT',
      primaryGuestIdNumber: 'P1234567',
      acknowledgeRoomNotClean: true,
    },
  );
  h.check(
    'the OTA guest checks in at the desk',
    checkedIn.status === 200 || checkedIn.status === 201,
    show(checkedIn),
  );
  standin.feed.push(
    revision('rev-cancel-3', { booking_id: 'bk-3', status: 'cancelled', rooms: [] }),
  );
  await asWorker(fx.propertyId, () => inbound.pull(fx.propertyId, conn));
  await asWorker(fx.propertyId, () => inbound.apply(fx.propertyId, conn));
  h.check(
    'a cancellation of a guest in house goes to a person',
    (await byId('rev-cancel-3'))?.attentionCode === 'GUEST_IN_HOUSE',
  );
  h.check(
    'and the stay is untouched',
    (await owner.reservation.findUnique({ where: { id: inHouse.reservationId } })).status ===
      'CHECKED_IN',
  );

  /* -------------------------------------------------------------- 10 */
  console.log('\n10. The last room: 6 desk bookings and an OTA booking race (3.1).');
  const night = shiftDays(D, 15);
  const nightRow = {
    propertyId: fx.propertyId,
    roomTypeId: fx.categoryB,
    stayDate: utcMidnight(night),
  };
  standin.feed.push(
    revision('rev-race', {
      booking_id: 'bk-race',
      status: 'new',
      ota_reservation_code: 'BDC-RACE',
      rooms: [room('cx-rt-b', 'cx-rp-b-bar', night, 1, '3000.00')],
    }),
  );
  await asWorker(fx.propertyId, () => inbound.pull(fx.propertyId, conn));
  const desk = () =>
    h.call('POST', `/properties/${fx.propertyCode}/reservations`, admin, {
      roomTypeId: fx.categoryB,
      roomId: null,
      arrivalDate: night,
      departureDate: shiftDays(night, 1),
      adults: 1,
      mealPlan: 'EP',
      source: 'PHONE',
      guests: [{ firstName: 'Race', lastName: 'Desk' }],
      isInstantCheckIn: false,
    });
  const raced = await Promise.all([
    ...Array.from({ length: 6 }, desk),
    asWorker(fx.propertyId, () => inbound.apply(fx.propertyId, conn))
      .then((o) => ({ status: 'apply', o }))
      .catch((error) => ({ status: 'apply', deferred: String(error?.message ?? error) })),
  ]);
  const deferred = raced.find((r) => r.status === 'apply' && r.deferred !== undefined);
  if (deferred !== undefined) {
    // A lock timeout leaves the revision RECEIVED for the outbox to retry.
    h.note(`the OTA apply was deferred (${deferred.deferred}); retrying as the outbox would`);
    await asWorker(fx.propertyId, () => inbound.apply(fx.propertyId, conn));
  }
  const deskWins = raced.filter((r) => r.status === 201).length;
  const otaWon = (await byId('rev-race'))?.status === 'APPLIED';
  const raceRow = await owner.inventoryDay.findFirst({ where: nightRow });
  const liveRooms = await owner.reservationRoom.count({
    where: {
      propertyId: fx.propertyId,
      roomTypeId: fx.categoryB,
      status: { in: ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] },
      arrivalDate: { lte: utcMidnight(night) },
      departureDate: { gt: utcMidnight(night) },
    },
  });
  h.check(
    'exactly one of the seven got the room',
    deskWins + (otaWon ? 1 : 0) === 1,
    `desk ${deskWins}, ota ${String(otaWon)}`,
  );
  h.check(
    'sold equals the live room rows for that date and category',
    raceRow.sold === 1 && liveRooms === 1,
    `sold ${raceRow.sold}, rows ${liveRooms}`,
  );
  if (!otaWon)
    h.check(
      'the OTA booking that lost is handed to a person',
      (await byId('rev-race'))?.attentionCode === 'NO_AVAILABILITY',
    );
  h.check(
    'the losers were refused with 409, never a 500',
    raced.filter((r) => r.status !== 201 && r.status !== 'apply').every((r) => r.status === 409),
  );

  // With an overbooking allowance the OTA's late sale is absorbed; the
  // allowance is still never pushed as stock.
  const night2 = shiftDays(D, 16);
  const filler = await h.call('POST', `/properties/${fx.propertyCode}/reservations`, admin, {
    roomTypeId: fx.categoryB,
    roomId: null,
    arrivalDate: night2,
    departureDate: shiftDays(night2, 1),
    adults: 1,
    mealPlan: 'EP',
    source: 'PHONE',
    guests: [{ firstName: 'Fill', lastName: 'Last' }],
    isInstantCheckIn: false,
  });
  await owner.inventoryDay.updateMany({
    where: { propertyId: fx.propertyId, roomTypeId: fx.categoryB, stayDate: utcMidnight(night2) },
    data: { overbookingAllowance: 1 },
  });
  standin.feed.push(
    revision('rev-allow', {
      booking_id: 'bk-allow',
      status: 'new',
      ota_reservation_code: 'BDC-ALLOW',
      rooms: [room('cx-rt-b', 'cx-rp-b-bar', night2, 1, '3000.00')],
    }),
  );
  await asWorker(fx.propertyId, () => inbound.pull(fx.propertyId, conn));
  await asWorker(fx.propertyId, () => inbound.apply(fx.propertyId, conn));
  const allowRow = await owner.inventoryDay.findFirst({
    where: { propertyId: fx.propertyId, roomTypeId: fx.categoryB, stayDate: utcMidnight(night2) },
  });
  h.check(
    'a late OTA sale is absorbed by the overbooking allowance',
    filler.status === 201 && (await byId('rev-allow'))?.status === 'APPLIED' && allowRow.sold === 2,
    `sold ${allowRow.sold}`,
  );
  standin.requests.length = 0;
  await owner.channelAriChange.create({
    data: {
      propertyId: fx.propertyId,
      connectionId: conn,
      roomTypeId: fx.categoryB,
      fromDate: utcMidnight(night2),
      toDate: utcMidnight(night2),
    },
  });
  await asWorker(fx.propertyId, () => ari.push(fx.propertyId, conn));
  const pushedB = standin.requests
    .find((r) => r.url === '/api/v1/availability')
    ?.body.values.find(
      (v) => v.room_type_id === 'cx-rt-b' && v.date_from <= night2 && v.date_to >= night2,
    );
  h.check(
    'and that night is pushed as 0, not as negative or as allowance',
    pushedB?.availability === 0,
    JSON.stringify(pushedB),
  );

  /* -------------------------------------------------------------- 11 */
  console.log('\n11. Sync now, pause, and the call log.');
  const clerkSync = await h.call('POST', `${base}/${conn}/sync`, fx.users.clerk.cookie, {
    full: true,
  });
  h.check('sync needs channels:sync', clerkSync.status === 403, show(clerkSync));
  await owner.channelAriChange.deleteMany({ where: { connectionId: conn } });
  const sync = await h.call('POST', `${base}/${conn}/sync`, fx.users.revenue.cookie, {
    full: true,
  });
  h.check(
    'a full resync queues the whole window',
    sync.status === 200 && sync.payload.pendingAriChanges === 1,
    show(sync),
  );
  const attempts = await h.call('GET', `${base}/${conn}/attempts?limit=5`, fx.users.revenue.cookie);
  h.check(
    'the call log pages, newest first',
    attempts.status === 200 &&
      attempts.payload.items.length === 5 &&
      attempts.payload.nextCursor !== null,
    show(attempts),
  );
  const page2 = await h.call(
    'GET',
    `${base}/${conn}/attempts?limit=5&cursor=${attempts.payload.nextCursor}`,
    fx.users.revenue.cookie,
  );
  h.check(
    'and the next page continues without repeats',
    page2.status === 200 &&
      page2.payload.items.every((i) => !attempts.payload.items.some((j) => j.id === i.id)),
    show(page2),
  );
  const strangerLog = await h.call(
    'GET',
    `/properties/${fy.propertyCode}/channels/${conn}/attempts`,
    fy.users.admin.cookie,
  );
  h.check(
    "another property's admin gets 404 for this connection's log",
    strangerLog.status === 404,
    show(strangerLog),
  );
  const paused = await h.call('POST', `${base}/${conn}/pause`, admin, {});
  h.check(
    'pausing stops distribution and drops pending changes',
    paused.status === 200 &&
      paused.payload.status === 'PAUSED' &&
      paused.payload.pendingAriChanges === 0,
    show(paused),
  );
  const pausedPush = await asWorker(fx.propertyId, () => ari.push(fx.propertyId, conn));
  h.check('a push for a paused connection does nothing', pausedPush.kind === 'PAUSED');
  const pausedSync = await h.call('POST', `${base}/${conn}/sync`, admin, { full: false });
  h.check(
    'sync on a paused connection is refused (409)',
    pausedSync.status === 409,
    show(pausedSync),
  );
}

await runSuite({
  harness: h,
  prisma: owner,
  label: SUITE,
  body: async () => {
    try {
      await body();
    } finally {
      await other
        .teardown()
        .catch((error) => console.error(`other teardown: ${String(error?.message ?? error)}`));
      await rawApp.$disconnect();
      await new Promise((resolve) => server.close(resolve));
    }
  },
});
