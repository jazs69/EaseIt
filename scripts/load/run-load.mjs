/**
 * PF-02: a load profile at 50 concurrent staff, against the running API.
 * DISPOSABLE DATABASES ONLY (it books and cancels).
 *
 * ===========================================================================
 * The model: CLAUDE.md sizes this platform at ~50 concurrent staff across 10
 * properties. Each virtual user is one staff member at one property, signed in
 * as a load user created here (front desk, with every fifth an administrator
 * who also runs reports). Each loops: pick an action by weight, perform it,
 * pause 1-4 s ("think time"). The weights follow a front-desk shift: the
 * dashboard, the room calendar and the folio dominate; reports are rare;
 * about one action in twenty is a booking, cancelled straight after.
 *
 * Phases:
 *   steady  50 users with think time, for STEADY_SECONDS (default 300) after
 *           a 30 s ramp: the profile PF-02 asks for.
 *   stress  the same 50 users with NO think time, for STRESS_SECONDS (default
 *           60): what the API sustains flat out, and where latency goes.
 *
 * Latency is measured per action from request start to full body read.
 * Statuses the action expects (a 409 for a sold-out night) are not errors;
 * any other non-2xx, or a network failure, is. Results are written as JSON to
 * LOAD_OUT (default load-results.json) and summarised on stdout.
 *
 *   DATABASE_URL=<owner url of the disposable db>  EASEIT_API_URL=http://127.0.0.1:4100/api/v1 \
 *   node scripts/load/run-load.mjs
 * ===========================================================================
 */

import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';

import { WHOLLY_DISPOSABLE } from '../../test/support/isolation-guard.mjs';

const API = process.env.EASEIT_API_URL;
const USERS = Number(process.env.LOAD_USERS ?? 50);
const RAMP_SECONDS = Number(process.env.RAMP_SECONDS ?? 30);
const STEADY_SECONDS = Number(process.env.STEADY_SECONDS ?? 300);
const STRESS_SECONDS = Number(process.env.STRESS_SECONDS ?? 60);
const OUT = process.env.LOAD_OUT ?? 'load-results.json';
if (!API) throw new Error('EASEIT_API_URL is required.');

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const db = (await prisma.$queryRaw`SELECT current_database() AS db`)[0]?.db;
if (!WHOLLY_DISPOSABLE.includes(db)) {
  throw new Error(`REFUSING: "${String(db)}" is not a wholly disposable database.`);
}

/* ------------------------------------------------------------ fixtures -- */

const secret = /^JWT_SECRET\s*=\s*"?([^"\r\n]+)"?/m.exec(
  readFileSync(new URL('../../apps/api/.env', import.meta.url), 'utf8'),
)?.[1];
if (!secret) throw new Error('JWT_SECRET not found in apps/api/.env');
function cookieFor(user) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const input = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, email: user.email, pid: null, amr: ['pwd', 'otp'], iat: now, exp: now + 7200 })}`;
  return `easeit_session=${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

const properties = await prisma.$queryRaw`
  SELECT p."id"::text AS id, p."code"::text AS code, p."businessDate"::text AS "businessDate",
         (SELECT count(*)::int FROM "room" r WHERE r."propertyId" = p."id" AND r."retiredAt" IS NULL) AS rooms
    FROM "property" p
   WHERE p."code" ~ '^31[0-9]{3}$' AND p."status"::text = 'ACTIVE'
     AND EXISTS (SELECT 1 FROM "reservation" r WHERE r."propertyId" = p."id")
   ORDER BY p."code"`;
if (properties.length === 0)
  throw new Error('No loaded properties: run scripts/load/seed-volume.mjs first.');

const roles = Object.fromEntries(
  (
    await prisma.$queryRaw`SELECT "key"::text AS key, "id"::text AS id FROM "role" WHERE "propertyId" IS NULL AND "key" IS NOT NULL`
  ).map((r) => [r.key, r.id]),
);

/** Spread users over properties in proportion to rooms, at least one each. */
const totalRooms = properties.reduce((s, p) => s + p.rooms, 0);
const vus = [];
for (const property of properties) {
  const share = Math.max(1, Math.round((USERS * property.rooms) / totalRooms));
  for (let i = 0; i < share && vus.length < USERS; i += 1) vus.push({ property });
}
while (vus.length < USERS) vus.push({ property: properties[vus.length % properties.length] });

for (let i = 0; i < vus.length; i += 1) {
  const email = `load-staff-${String(i + 1).padStart(2, '0')}@load.invalid`;
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash: 'load-test-no-login',
      firstName: 'Load',
      lastName: `Staff ${String(i + 1)}`,
    },
    update: {},
    select: { id: true, email: true },
  });
  const role = i % 5 === 0 ? 'PROPERTY_ADMIN' : 'FRONT_DESK';
  await prisma.userPropertyRole.deleteMany({ where: { userId: user.id } });
  await prisma.userPropertyRole.create({
    data: { userId: user.id, propertyId: vus[i].property.id, roleId: roles[role] },
  });
  vus[i].role = role;
  vus[i].cookie = cookieFor(user);
}

/** Sample ids per property, so reads hit real rows. */
const samples = new Map();
for (const property of properties) {
  const recent = await prisma.$queryRaw`
    SELECT "id"::text AS id, "confirmationCode" AS code, "guestLastName" AS last
      FROM "reservation" WHERE "propertyId" = ${property.id}::uuid
       AND "arrivalDate" BETWEEN ${new Date(Date.parse(property.businessDate) - 30 * 86_400_000)}::date
                              AND ${new Date(Date.parse(property.businessDate) + 30 * 86_400_000)}::date
     ORDER BY random() LIMIT 200`;
  const types =
    await prisma.$queryRaw`SELECT "id"::text AS id FROM "room_type" WHERE "propertyId" = ${property.id}::uuid AND "retiredAt" IS NULL`;
  samples.set(property.id, { recent, types });
}
await prisma.$disconnect();

/* ------------------------------------------------------------- actions -- */

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const addDays = (iso, n) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const ACTIONS = [
  { name: 'dashboard', weight: 20, run: (vu) => get(vu, `/dashboard-summary`) },
  {
    name: 'calendar (week)',
    weight: 16,
    run: (vu) => get(vu, `/timeline-calendar?timeframe=week`),
  },
  {
    name: 'folio',
    weight: 14,
    run: (vu) => get(vu, `/folios/by-booking/${pick(sample(vu).recent).code}`),
  },
  {
    name: 'reservation detail',
    weight: 10,
    run: (vu) => get(vu, `/reservations/${pick(sample(vu).recent).id}`),
  },
  {
    name: 'reservation search',
    weight: 8,
    run: (vu) =>
      get(vu, `/reservations/search?q=${encodeURIComponent(pick(sample(vu).recent).last)}`),
  },
  { name: 'front-desk board', weight: 6, run: (vu) => get(vu, `/front-desk/board`) },
  { name: 'housekeeping board', weight: 6, run: (vu) => get(vu, `/housekeeping/board`) },
  {
    name: 'availability (inventory days)',
    weight: 4,
    run: (vu) =>
      get(
        vu,
        `/inventory/days?roomTypeId=${pick(sample(vu).types).id}&fromDate=${vu.property.businessDate}&toDate=${addDays(vu.property.businessDate, 30)}`,
      ),
  },
  { name: 'payments ledger', weight: 3, run: (vu) => get(vu, `/payments`) },
  { name: 'work orders', weight: 2, run: (vu) => get(vu, `/work-orders`) },
  {
    name: 'report: sales 30d',
    weight: 2,
    admin: true,
    run: (vu) =>
      get(
        vu,
        `/reports/sales?startDate=${addDays(vu.property.businessDate, -30)}&endDate=${addDays(vu.property.businessDate, -1)}`,
      ),
  },
  { name: 'report: flash', weight: 1, admin: true, run: (vu) => get(vu, `/reports/flash-manager`) },
  {
    name: 'report: master page',
    weight: 2,
    admin: true,
    run: (vu) =>
      get(
        vu,
        `/reports/master-report?startDate=${addDays(vu.property.businessDate, -30)}&endDate=${vu.property.businessDate}&limit=50`,
      ),
  },
  { name: 'audit log', weight: 1, admin: true, run: (vu) => get(vu, `/audit-log`) },
  { name: 'book + cancel', weight: 5, run: (vu) => bookAndCancel(vu) },
];
const sample = (vu) => samples.get(vu.property.id);

const stats = new Map();
let phase = 'warmup';
function record(name, ms, ok) {
  if (phase === 'warmup') return;
  const key = `${phase}|${name}`;
  const entry = stats.get(key) ?? { phase, name, latencies: [], errors: 0 };
  entry.latencies.push(ms);
  if (!ok) entry.errors += 1;
  stats.set(key, entry);
}

async function timed(name, request, expected = []) {
  const started = performance.now();
  let ok = false;
  let status = 0;
  let body = null;
  try {
    const response = await request();
    status = response.status;
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    ok = (status >= 200 && status < 300) || expected.includes(status);
  } catch {
    ok = false;
  }
  record(name, performance.now() - started, ok);
  return { status, body, ok };
}

function get(vu, path, expected = []) {
  const name = path.split('?')[0].replace(/\/[0-9a-f-]{36}|\/(?:LT-|SFBOOKING_)[\w-]+/g, '/:id');
  return timed(
    `GET ${name}`,
    () => fetch(`${API}/properties/${vu.property.code}${path}`, { headers: { cookie: vu.cookie } }),
    expected,
  );
}

async function bookAndCancel(vu) {
  const arrival = addDays(vu.property.businessDate, 1 + Math.floor(Math.random() * 80));
  const booked = await timed(
    'POST reservations (book)',
    () =>
      fetch(`${API}/properties/${vu.property.code}/reservations`, {
        method: 'POST',
        headers: { cookie: vu.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          roomTypeId: pick(sample(vu).types).id,
          roomId: null,
          arrivalDate: arrival,
          departureDate: addDays(arrival, 1 + Math.floor(Math.random() * 3)),
          adults: 2,
          mealPlan: 'EP',
          source: 'PHONE',
          guests: [{ firstName: 'Load', lastName: `Test ${randomUUID().slice(0, 6)}` }],
          isInstantCheckIn: false,
        }),
      }),
    [409],
  );
  if (booked.status === 201 && booked.body?.id) {
    await timed('POST reservations/:id/cancel', () =>
      fetch(`${API}/properties/${vu.property.code}/reservations/${booked.body.id}/cancel`, {
        method: 'POST',
        headers: { cookie: vu.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'load test' }),
      }),
    );
  }
}

/* ---------------------------------------------------------------- run -- */

function chooseAction(vu) {
  const allowed = ACTIONS.filter((a) => !a.admin || vu.role === 'PROPERTY_ADMIN');
  const total = allowed.reduce((s, a) => s + a.weight, 0);
  let roll = Math.random() * total;
  for (const action of allowed) {
    roll -= action.weight;
    if (roll <= 0) return action;
  }
  return allowed[0];
}

let stopAt = 0;
let thinking = true;
async function loop(vu, startDelay) {
  await new Promise((r) => setTimeout(r, startDelay));
  while (Date.now() < stopAt) {
    await chooseAction(vu).run(vu);
    if (thinking) await new Promise((r) => setTimeout(r, 1000 + Math.random() * 3000));
  }
}

function summarise() {
  const rows = [];
  for (const entry of stats.values()) {
    const sorted = [...entry.latencies].sort((a, b) => a - b);
    const q = (p) =>
      sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
    rows.push({
      phase: entry.phase,
      action: entry.name,
      count: sorted.length,
      errors: entry.errors,
      p50: Math.round(q(50)),
      p95: Math.round(q(95)),
      p99: Math.round(q(99)),
      max: Math.round(sorted.at(-1) ?? 0),
    });
  }
  return rows.sort((a, b) => a.phase.localeCompare(b.phase) || b.count - a.count);
}

function overall(rows, which) {
  const all = [...stats.values()]
    .filter((e) => e.phase === which)
    .flatMap((e) => e.latencies)
    .sort((a, b) => a - b);
  const q = (p) => all[Math.min(all.length - 1, Math.floor((p / 100) * all.length))] ?? 0;
  const errors = rows.filter((r) => r.phase === which).reduce((s, r) => s + r.errors, 0);
  return {
    requests: all.length,
    errors,
    p50: Math.round(q(50)),
    p95: Math.round(q(95)),
    p99: Math.round(q(99)),
  };
}

console.log(
  `load: ${String(vus.length)} users over ${String(properties.length)} properties on ${db}`,
);
const started = new Date();

// Warm-up and ramp: users join over RAMP_SECONDS; nothing recorded.
phase = 'warmup';
stopAt = Date.now() + RAMP_SECONDS * 1000 + STEADY_SECONDS * 1000;
const steadyAt = Date.now() + RAMP_SECONDS * 1000;
const steady = vus.map((vu, i) => loop(vu, (i / vus.length) * RAMP_SECONDS * 1000));
setTimeout(() => {
  phase = 'steady';
}, RAMP_SECONDS * 1000);
await Promise.all(steady);
const steadySeconds = (Date.now() - steadyAt) / 1000;

phase = 'stress';
thinking = false;
const stressStart = Date.now();
stopAt = Date.now() + STRESS_SECONDS * 1000;
await Promise.all(vus.map((vu) => loop(vu, 0)));
const stressSeconds = (Date.now() - stressStart) / 1000;

const rows = summarise();
const result = {
  startedAt: started.toISOString(),
  database: db,
  api: API,
  host: {
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? '?',
    memoryGb: Math.round(os.totalmem() / 1e9),
    platform: `${os.platform()} ${os.release()}`,
  },
  users: vus.length,
  properties: properties.map((p) => ({
    code: p.code,
    rooms: p.rooms,
    users: vus.filter((v) => v.property.id === p.id).length,
  })),
  steady: { seconds: Math.round(steadySeconds), ...overall(rows, 'steady') },
  stress: { seconds: Math.round(stressSeconds), ...overall(rows, 'stress') },
  actions: rows,
};
result.steady.throughput = Number((result.steady.requests / steadySeconds).toFixed(1));
result.stress.throughput = Number((result.stress.requests / stressSeconds).toFixed(1));
writeFileSync(OUT, JSON.stringify(result, null, 2));

console.log(
  `\nsteady (${String(result.steady.seconds)} s, think time 1-4 s): ${String(result.steady.requests)} requests, ${String(result.steady.throughput)}/s, p50 ${String(result.steady.p50)} ms, p95 ${String(result.steady.p95)} ms, p99 ${String(result.steady.p99)} ms, errors ${String(result.steady.errors)}`,
);
console.log(
  `stress (${String(result.stress.seconds)} s, no think time): ${String(result.stress.requests)} requests, ${String(result.stress.throughput)}/s, p50 ${String(result.stress.p50)} ms, p95 ${String(result.stress.p95)} ms, p99 ${String(result.stress.p99)} ms, errors ${String(result.stress.errors)}`,
);
for (const row of rows.filter((r) => r.phase === 'steady')) {
  console.log(
    `  ${row.action.padEnd(48)} n=${String(row.count).padStart(5)}  p50=${String(row.p50).padStart(5)}  p95=${String(row.p95).padStart(5)}  p99=${String(row.p99).padStart(5)}  err=${String(row.errors)}`,
  );
}
console.log(`\nwritten: ${OUT}`);
process.exitCode = result.steady.errors > 0 ? 1 : 0;
