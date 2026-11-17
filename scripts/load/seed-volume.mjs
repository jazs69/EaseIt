/**
 * PF-02 / PF-03: a representative year of operations, for load testing and
 * query profiling. DISPOSABLE DATABASES ONLY.
 *
 * ===========================================================================
 * For every operable property whose code is a portfolio code (`31xxx`), and
 * every room in it, it lays down back-to-back stays from the business date
 * minus 365 days to the business date plus 90:
 *
 * - stays of 1-4 nights with 0-3 empty nights between them (about two-thirds
 *   occupancy), about 8% cancelled (no room held), sources spread across the
 *   channels;
 * - past stays CHECKED_OUT with a closed folio: a room charge and its 12% tax
 *   per night, and one card or UPI payment settling it to zero;
 * - stays spanning the business date CHECKED_IN with an open folio (nights
 *   so far posted, unpaid); future stays CONFIRMED;
 * - `reservation_night` rows for every stay;
 * - `inventory_day` rows for every type and date in the window, with `sold`
 *   recomputed from the stays (so the oversell CHECK and every report agree);
 * - a `daily_snapshot` per property per closed day, from those counters and
 *   lines, as the night audit would have written it.
 *
 * It first CLEARS the booking-side tables (reservations, folios, lines,
 * invoices, links, blocks, work orders, snapshots) of the whole database, so
 * generated stays cannot collide with leftovers. That is why it refuses any
 * database not on the disposable allowlist, asked of the server itself.
 *
 * Deterministic (seeded random): the same database gets the same data, so
 * two load runs are comparable.
 *
 *   DATABASE_URL=<owner url of easeit_racetest> node scripts/load/seed-volume.mjs
 * ===========================================================================
 */

import { randomUUID } from 'node:crypto';

import { WHOLLY_DISPOSABLE } from '../../test/support/isolation-guard.mjs';

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const DAYS_BACK = 365;
const DAYS_AHEAD = 90;
const BATCH = 2000;
const TAX_PERCENT = 12;
const SOURCES = [
  'DIRECT_WEB',
  'FRONT_DESK',
  'PHONE',
  'WALK_IN',
  'BOOKING_COM',
  'BOOKING_COM',
  'MAKEMYTRIP',
  'AGODA',
  'EXPEDIA',
  'CORPORATE',
];
const FIRST = [
  'Asha',
  'Rahul',
  'Meera',
  'Vikram',
  'Priya',
  'Arjun',
  'Kavya',
  'Rohan',
  'Neha',
  'Sanjay',
];
const LAST = ['Kapoor', 'Iyer', 'Sharma', 'Nair', 'Reddy', 'Gupta', 'Menon', 'Das', 'Joshi', 'Rao'];

/** mulberry32: small, fast, deterministic. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const at = (isoDate) => new Date(`${isoDate}T00:00:00.000Z`);

async function insertMany(model, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await prisma[model].createMany({ data: rows.slice(i, i + BATCH) });
  }
}

async function main() {
  const db = (await prisma.$queryRaw`SELECT current_database() AS db`)[0]?.db;
  if (!WHOLLY_DISPOSABLE.includes(db)) {
    throw new Error(
      `REFUSING: "${String(db)}" is not a wholly disposable database (${WHOLLY_DISPOSABLE.join(', ')}).`,
    );
  }
  console.log(`seed-volume on ${db}`);

  console.log('clearing booking-side tables …');
  await prisma.$executeRawUnsafe(`
    TRUNCATE "payment_link", "company_ledger_entry", "invoice", "invoice_sequence", "folio_line", "folio",
             "reservation_night", "reservation_guest", "reservation_room", "reservation_note",
             "work_order", "room_block", "daily_snapshot", "night_audit_step", "night_audit_run",
             "reservation" CASCADE`);
  await prisma.$executeRawUnsafe(`UPDATE "inventory_day" SET "sold" = 0, "blocked" = 0`);

  const properties = await prisma.$queryRaw`
    SELECT p."id"::text AS id, p."code"::text AS code, p."currency"::text AS currency,
           p."businessDate"::text AS "businessDate"
      FROM "property" p
     WHERE p."code" ~ '^31[0-9]{3}$' AND p."status"::text IN ('ACTIVE')
     ORDER BY p."code"`;
  const random = rng(26);
  const totals = { properties: properties.length, reservations: 0, nights: 0, lines: 0 };

  for (const property of properties) {
    const rooms = await prisma.$queryRaw`
      SELECT r."id"::text AS id, r."roomTypeId"::text AS "roomTypeId", t."baseRateMinor" AS rate
        FROM "room" r JOIN "room_type" t ON t."id" = r."roomTypeId"
       WHERE r."propertyId" = ${property.id}::uuid AND r."retiredAt" IS NULL AND t."retiredAt" IS NULL`;
    if (rooms.length === 0) continue;
    const bd = Date.parse(`${property.businessDate}T00:00:00Z`);
    const start = bd - DAYS_BACK * DAY;
    const end = bd + DAYS_AHEAD * DAY;

    const reservations = [];
    const resRooms = [];
    const guests = [];
    const nightsRows = [];
    const folios = [];
    const lines = [];
    let seq = 0;

    for (const room of rooms) {
      const rate = Math.max(150000, Number(room.rate) || 350000);
      let cursor = start + Math.floor(random() * 3) * DAY;
      while (cursor < end) {
        const nights = 1 + Math.floor(random() * 4);
        const arrival = cursor;
        const departure = arrival + nights * DAY;
        cursor = departure + Math.floor(random() * 4) * DAY;
        if (departure > end) break;

        seq += 1;
        const id = randomUUID();
        const cancelled = random() < 0.08;
        const status = cancelled
          ? 'CANCELLED'
          : departure <= bd
            ? 'CHECKED_OUT'
            : arrival <= bd
              ? 'CHECKED_IN'
              : 'CONFIRMED';
        const nightRate = rate + Math.floor(random() * 5) * 25000;
        const tax = Math.round((nightRate * TAX_PERCENT) / 100);
        const total = nights * (nightRate + tax);
        const first = FIRST[Math.floor(random() * FIRST.length)];
        const last = LAST[Math.floor(random() * LAST.length)];
        const lead = Math.floor(random() * 60);
        const createdAt = new Date(arrival - lead * DAY);
        const paid = status === 'CHECKED_OUT' ? total : 0;

        reservations.push({
          id,
          propertyId: property.id,
          confirmationCode: `LT-${property.code}-${String(seq).padStart(6, '0')}`,
          arrivalDate: at(iso(arrival)),
          departureDate: at(iso(departure)),
          guestFirstName: first,
          guestLastName: last,
          guestEmail: `guest${String(seq)}@load.invalid`,
          totalAmountMinor: total,
          taxAmountMinor: nights * tax,
          paidAmountMinor: paid,
          currency: property.currency,
          status,
          source: SOURCES[Math.floor(random() * SOURCES.length)],
          adults: 1 + Math.floor(random() * 2),
          createdAt,
          updatedAt: createdAt,
          ...(cancelled ? { cancelledAt: createdAt } : {}),
          ...(status === 'CHECKED_IN' || status === 'CHECKED_OUT'
            ? { checkedInAt: new Date(arrival + 14 * 3600_000) }
            : {}),
          ...(status === 'CHECKED_OUT'
            ? { checkedOutAt: new Date(departure + 10 * 3600_000) }
            : {}),
        });
        resRooms.push({
          id: randomUUID(),
          propertyId: property.id,
          reservationId: id,
          roomTypeId: room.roomTypeId,
          roomId: cancelled ? null : room.id,
          arrivalDate: at(iso(arrival)),
          departureDate: at(iso(departure)),
          status,
          updatedAt: createdAt,
        });
        guests.push({
          id: randomUUID(),
          propertyId: property.id,
          reservationId: id,
          ordinal: 1,
          firstName: first,
          lastName: last,
          updatedAt: createdAt,
        });
        for (let n = 0; n < nights; n += 1) {
          nightsRows.push({
            id: randomUUID(),
            propertyId: property.id,
            reservationId: id,
            stayDate: at(iso(arrival + n * DAY)),
            rateMinor: nightRate,
            taxMinor: tax,
            taxRatePercent: TAX_PERCENT,
            currency: property.currency,
            rateSource: 'MANUAL',
          });
        }

        if (status === 'CHECKED_OUT' || status === 'CHECKED_IN') {
          const folioId = randomUUID();
          folios.push({
            id: folioId,
            propertyId: property.id,
            reservationId: id,
            currency: property.currency,
            status: status === 'CHECKED_OUT' ? 'CLOSED' : 'OPEN',
            ...(status === 'CHECKED_OUT' ? { closedAt: new Date(departure + 10 * 3600_000) } : {}),
          });
          for (let n = 0; n < nights; n += 1) {
            const night = arrival + n * DAY;
            if (night >= bd) break;
            const chargeId = randomUUID();
            lines.push({
              id: chargeId,
              propertyId: property.id,
              folioId,
              kind: 'ROOM_CHARGE',
              description: `Room night ${iso(night)}`,
              amountMinor: nightRate,
              currency: property.currency,
              chargeDate: at(iso(night)),
            });
            lines.push({
              id: randomUUID(),
              propertyId: property.id,
              folioId,
              kind: 'TAX',
              description: `GST ${iso(night)}`,
              amountMinor: tax,
              currency: property.currency,
              chargeDate: at(iso(night)),
              derivedFromLineId: chargeId,
            });
          }
          if (status === 'CHECKED_OUT') {
            lines.push({
              id: randomUUID(),
              propertyId: property.id,
              folioId,
              kind: 'PAYMENT',
              description: 'Payment at check-out',
              amountMinor: -total,
              currency: property.currency,
              chargeDate: at(iso(departure - DAY)),
              paymentMethod: random() < 0.5 ? 'CARD' : 'UPI',
              idempotencyKey: `load-${id}`,
            });
          }
        }
      }
    }

    await insertMany('reservation', reservations);
    await insertMany('reservationRoom', resRooms);
    await insertMany('reservationGuest', guests);
    await insertMany('reservationNight', nightsRows);
    await insertMany('folio', folios);
    // Charges before the tax lines that reference them.
    await insertMany(
      'folioLine',
      lines.filter((l) => l.kind === 'ROOM_CHARGE'),
    );
    await insertMany(
      'folioLine',
      lines.filter((l) => l.kind !== 'ROOM_CHARGE'),
    );

    // Inventory rows for every type and date in the window, then `sold` from the stays.
    await prisma.$executeRaw`
      INSERT INTO "inventory_day" ("id", "propertyId", "roomTypeId", "stayDate", "physical", "updatedAt")
      SELECT gen_random_uuid(), ${property.id}::uuid, t."id", d::date,
             (SELECT count(*) FROM "room" r WHERE r."roomTypeId" = t."id" AND r."retiredAt" IS NULL)::int, now()
        FROM "room_type" t
       CROSS JOIN generate_series(${at(iso(start))}::date, ${at(iso(end))}::date, interval '1 day') d
       WHERE t."propertyId" = ${property.id}::uuid AND t."retiredAt" IS NULL
      ON CONFLICT DO NOTHING`;
    // Leftover rows can carry an old room count: the oversell CHECK refused
    // one (7 physical, 8 rooms sold). Physical stock is today's rooms of the type.
    await prisma.$executeRaw`
      UPDATE "inventory_day" i
         SET "physical" = (SELECT count(*) FROM "room" r WHERE r."roomTypeId" = i."roomTypeId" AND r."retiredAt" IS NULL)::int
       WHERE i."propertyId" = ${property.id}::uuid`;
    await prisma.$executeRaw`
      UPDATE "inventory_day" i SET "sold" = s.sold
        FROM (
          SELECT rr."roomTypeId", d::date AS day, count(*)::int AS sold
            FROM "reservation_room" rr
            JOIN "reservation" r ON r."id" = rr."reservationId"
           CROSS JOIN generate_series(rr."arrivalDate", rr."departureDate" - interval '1 day', interval '1 day') d
           WHERE rr."propertyId" = ${property.id}::uuid AND r."status"::text IN ('CONFIRMED','CHECKED_IN','CHECKED_OUT')
           GROUP BY rr."roomTypeId", d::date
        ) s
       WHERE i."propertyId" = ${property.id}::uuid AND i."roomTypeId" = s."roomTypeId" AND i."stayDate" = s.day`;

    // A snapshot per closed day, as night-audit step 6 would have written it.
    await prisma.$executeRaw`
      INSERT INTO "daily_snapshot" ("id","propertyId","businessDate","runId","roomsPhysical","roomsBlocked","roomsAvailable",
                                    "roomsSold","occupancyBp","currency","roomRevenueMinor","adrMinor","revparMinor",
                                    "serviceRevenueMinor","taxMinor","paymentsMinor","refundsMinor")
      SELECT gen_random_uuid(), ${property.id}::uuid, inv.day, gen_random_uuid(), inv.physical, 0, inv.physical, inv.sold,
             CASE WHEN inv.physical = 0 THEN 0 ELSE round(inv.sold * 10000.0 / inv.physical)::int END,
             ${property.currency}, COALESCE(m.room, 0),
             CASE WHEN inv.sold = 0 THEN 0 ELSE round(COALESCE(m.room, 0)::numeric / inv.sold)::int END,
             CASE WHEN inv.physical = 0 THEN 0 ELSE round(COALESCE(m.room, 0)::numeric / inv.physical)::int END,
             0, COALESCE(m.tax, 0), COALESCE(m.payments, 0), 0
        FROM (SELECT "stayDate" AS day, sum("physical")::int AS physical, sum("sold")::int AS sold
                FROM "inventory_day" WHERE "propertyId" = ${property.id}::uuid
                 AND "stayDate" >= ${at(iso(start))}::date AND "stayDate" < ${at(property.businessDate)}::date
               GROUP BY "stayDate") inv
        LEFT JOIN (SELECT "chargeDate" AS day,
                          sum(CASE WHEN "kind" = 'ROOM_CHARGE' THEN "amountMinor" ELSE 0 END)::int AS room,
                          sum(CASE WHEN "kind" = 'TAX' THEN "amountMinor" ELSE 0 END)::int AS tax,
                          sum(CASE WHEN "kind" = 'PAYMENT' THEN -"amountMinor" ELSE 0 END)::int AS payments
                     FROM "folio_line" WHERE "propertyId" = ${property.id}::uuid GROUP BY "chargeDate") m
          ON m.day = inv.day`;

    totals.reservations += reservations.length;
    totals.nights += nightsRows.length;
    totals.lines += lines.length;
    console.log(
      `  ${property.code}: ${String(rooms.length)} rooms, ${String(reservations.length)} stays, ${String(lines.length)} folio lines`,
    );
  }

  await prisma.$executeRawUnsafe('ANALYZE');
  console.log(`done: ${JSON.stringify(totals)}`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
