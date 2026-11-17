/**
 * Operator alerting (OB-06, WK-11): a dead letter reaches a person, and does
 * not vanish when the sink is down.
 *
 * ===========================================================================
 * Runs the compiled `AlertMonitorService`, `WebhookAlertSink`,
 * `EmailAlertSink`, `OutboxWorker` and dispatcher from `apps/api/dist` against
 * a real PostgreSQL, with only `PrismaService`, `ConfigService`, the clock and
 * the mailer stubbed. The "external" webhook is a real HTTP server on a
 * loopback port, so the sink's request, status handling and timeout are the
 * production code paths.
 *
 * What it asserts, in order:
 *   1. A job that fails permanently through the REAL worker is left DEAD and
 *      unalerted, and one monitor pass POSTs it to the webhook and stamps it.
 *   2. A stamped dead letter is not alerted again.
 *   3. A sink that answers 500 leaves the row unalerted; the next pass, with
 *      the sink back, delivers it. Nothing is lost to an outage.
 *   4. A sink that never answers is cut off by the timeout; the pass returns
 *      and the row stays unalerted.
 *   5. With two sinks, one working one is enough, and the email says the
 *      same thing as the webhook.
 *   6. An alert carries no payload value (a guest-data stand-in).
 *   7. Many dead letters are batched, and every one is eventually stamped.
 *   8. A lease left expired past the grace period alerts once, does not
 *      repeat inside the cooldown, repeats after it, and re-arms once the
 *      incident clears.
 *   9. Production refuses to boot without a sink; an empty webhook value
 *      from compose counts as unset; addresses are validated.
 *
 * Requires an isolated database (the shared isolation guard refuses anything
 * else). Every outbox row it writes carries this run's dedupe prefix and is
 * removed in teardown. The monitor scans the whole table by design, so any
 * unalerted dead letter another suite left in this disposable database is
 * alerted (and stamped) too; that is noted, never asserted on.
 * ===========================================================================
 */

await import(new URL('../../apps/api/node_modules/reflect-metadata/Reflect.js', import.meta.url));
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set.\nThis suite writes and deletes outbox rows; set it to a disposable test database.',
  );
  process.exit(1);
}

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const { assertIsolatedDatabase } = await import('../support/isolation-guard.mjs');

const DIST = '../../apps/api/dist';
async function load(relative) {
  const loaded = await import(new URL(`${DIST}/${relative}`, import.meta.url));
  return Object.keys(loaded).some((key) => key !== 'default') ? loaded : (loaded.default ?? loaded);
}

const { AlertMonitorService } = await load('modules/platform/alerting/alert-monitor.service.js');
const { WebhookAlertSink } = await load('modules/platform/alerting/webhook-alert.sink.js');
const { EmailAlertSink } = await load('modules/platform/alerting/email-alert.sink.js');
const { OutboxDispatcherService } = await load(
  'modules/platform/outbox/outbox-dispatcher.service.js',
);
const { OutboxWorker } = await load('modules/platform/outbox/outbox.worker.js');
const { OutboxHandlerRegistry } = await load('modules/platform/outbox/outbox-handler.registry.js');
const { OutboxMetricsService } = await load('modules/platform/outbox/outbox-metrics.service.js');
const { OutboxSelfTestHandler } = await load(
  'modules/platform/outbox/handlers/self-test.handler.js',
);
const { validateEnv } = await load('config/env.js');

const prisma = createPrismaClient();
const prismaStub = { client: prisma, ping: async () => true };
const RUN = randomUUID().slice(0, 8);
const KEY = (suffix) => `alerting:${RUN}:${suffix}`;

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const section = (title) => console.log(`\n${title}`);

function configStub(overrides = {}) {
  return { get: (key, fallback) => (key in overrides ? overrides[key] : fallback) };
}

/** A clock the cooldown reads; SQL staleness still uses the database's now(). */
const clock = {
  at: Date.now(),
  now() {
    return new Date(this.at);
  },
};

/* -- the "external" receiver ------------------------------------------------ */

const receiver = {
  mode: 'ok',
  received: [],
  server: null,
  url: '',
};

async function startReceiver() {
  receiver.server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (receiver.mode === 'hang') return; // never answer
      if (receiver.mode === 'fail') {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('receiver is down');
        return;
      }
      receiver.received.push({
        raw,
        body: JSON.parse(raw),
        contentType: request.headers['content-type'],
      });
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
  });
  await new Promise((resolve) => receiver.server.listen(0, '127.0.0.1', resolve));
  receiver.url = `http://127.0.0.1:${String(receiver.server.address().port)}/hook`;
}

function receivedMentioning(id) {
  return receiver.received.filter((entry) => entry.raw.includes(id));
}

/* -- rows -------------------------------------------------------------------- */

async function insertDead(
  propertyId,
  suffix,
  { payload = { nonce: suffix }, lastError = 'Error: synthetic failure' } = {},
) {
  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "outbox_event"
      ("id", "propertyId", "eventType", "payloadVersion", "payload", "dedupeKey", "dedupeMode",
       "status", "attempts", "maxAttempts", "availableAt", "completedAt", "lastError", "lastErrorAt",
       "createdAt", "updatedAt")
    VALUES
      (${id}::uuid, ${propertyId}::uuid, 'OUTBOX_SELF_TEST', 1, ${JSON.stringify(payload)}::jsonb, ${KEY(suffix)},
       'COALESCE', 'DEAD', 5, 5, now(), now(), ${lastError}, now(), now(), now())`;
  return id;
}

async function insertStaleLease(propertyId, suffix, expiredSecondsAgo) {
  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "outbox_event"
      ("id", "propertyId", "eventType", "payloadVersion", "payload", "dedupeKey", "dedupeMode",
       "status", "attempts", "maxAttempts", "availableAt", "claimedAt", "leaseExpiresAt", "claimedBy",
       "createdAt", "updatedAt")
    VALUES
      (${id}::uuid, ${propertyId}::uuid, 'OUTBOX_SELF_TEST', 1, ${JSON.stringify({ nonce: suffix })}::jsonb, ${KEY(suffix)},
       'COALESCE', 'IN_FLIGHT', 0, 5, now(), now() - interval '1 hour',
       now() - make_interval(secs => ${expiredSecondsAgo}), 'a-worker-that-died', now(), now())`;
  return id;
}

const alertedAt = async (id) =>
  (await prisma.outboxEvent.findUnique({ where: { id }, select: { alertedAt: true } }))
    ?.alertedAt ?? null;

/* -- suite ------------------------------------------------------------------- */

async function main() {
  await assertIsolatedDatabase({ prisma, suite: 'the alerting suite' });

  const property = await prisma.property.findFirst({
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  });
  if (property === null) throw new Error('No property found. Run pnpm db:seed first.');
  console.log(`Property: ${property.code}. Run: ${RUN}.`);

  const foreign = await prisma.outboxEvent.count({
    where: {
      status: 'DEAD',
      alertedAt: null,
      NOT: { dedupeKey: { startsWith: `alerting:${RUN}:` } },
    },
  });
  if (foreign > 0)
    console.log(
      `Note: ${String(foreign)} unalerted dead letter(s) from other runs will be alerted too.`,
    );

  await startReceiver();
  const webhook = new WebhookAlertSink(receiver.url, 1_000);
  const monitorConfig = configStub({
    ALERT_STALE_LEASE_GRACE_MS: 120_000,
    ALERT_REPEAT_MS: 600_000,
  });
  const monitor = new AlertMonitorService(prismaStub, monitorConfig, clock, [webhook]);

  /* -- 1. a real dead letter ----------------------------------------------- */
  section('1. A job that fails permanently in the real worker is alerted, then stamped');

  const registry = new OutboxHandlerRegistry();
  registry.register(new OutboxSelfTestHandler());
  const metrics = new OutboxMetricsService(prismaStub);
  const published = [];
  const queue = { publish: async (row) => published.push(row), ping: async () => true };
  const dispatcher = new OutboxDispatcherService(
    prismaStub,
    queue,
    metrics,
    configStub({ OUTBOX_BATCH_SIZE: 100, OUTBOX_LEASE_MS: 60_000 }),
  );
  const worker = new OutboxWorker(
    prismaStub,
    registry,
    metrics,
    configStub({ OUTBOX_BACKOFF_BASE_MS: 50, OUTBOX_BACKOFF_MAX_MS: 1_000 }),
  );

  // An invalid payload is a permanent failure on attempt 1 (outbox suite, check 11).
  const realId = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "outbox_event"
      ("id", "propertyId", "eventType", "payloadVersion", "payload", "dedupeKey",
       "dedupeMode", "status", "attempts", "maxAttempts", "availableAt", "createdAt", "updatedAt")
    VALUES (${realId}::uuid, ${property.id}::uuid, 'OUTBOX_SELF_TEST', 1, ${JSON.stringify({ nonce: '' })}::jsonb,
            ${KEY('real')}, 'COALESCE', 'PENDING', 0, 5, now() - interval '1 second', now(), now())`;
  await dispatcher.publishDue();
  const claimed = await prisma.outboxEvent.findUnique({ where: { id: realId } });
  await worker.process({
    id: `${realId}:0:0`,
    data: {
      outboxEventId: realId,
      propertyId: property.id,
      eventType: 'OUTBOX_SELF_TEST',
      payloadVersion: 1,
      attempt: 1,
      claimToken: claimed?.claimedBy,
    },
  });
  const dead = await prisma.outboxEvent.findUnique({
    where: { id: realId },
    select: { status: true, alertedAt: true, lastError: true },
  });
  check(
    'the worker left it DEAD with alertedAt NULL',
    dead?.status === 'DEAD' && dead.alertedAt === null,
    `status=${String(dead?.status)}`,
  );

  const first = await monitor.runPass();
  const hits = receivedMentioning(realId);
  check(
    'one monitor pass POSTed it to the webhook',
    hits.length === 1,
    `${String(hits.length)} request(s)`,
  );
  const hit = hits[0];
  check('as JSON', hit?.contentType === 'application/json', String(hit?.contentType));
  check(
    'with kind OUTBOX_DEAD_LETTER and a readable text',
    hit?.body.alert?.kind === 'OUTBOX_DEAD_LETTER' &&
      typeof hit.body.text === 'string' &&
      hit.body.text.startsWith('[EaseIt]'),
  );
  check(
    'naming the event type, the property code and the recorded reason',
    hit?.raw.includes('OUTBOX_SELF_TEST') &&
      hit.raw.includes(property.code) &&
      hit.raw.includes('nonce'),
  );
  check('and the row is stamped alertedAt', (await alertedAt(realId)) !== null);
  check('the pass reports it', first.deadLettersAlerted >= 1, JSON.stringify(first));

  /* -- 2. no repeat --------------------------------------------------------- */
  section('2. A stamped dead letter is not alerted again');
  const before2 = receiver.received.length;
  await monitor.runPass();
  check(
    'no second POST mentions it',
    receivedMentioning(realId).length === 1,
    `${String(receiver.received.length - before2)} new request(s)`,
  );

  /* -- 3. sink outage ------------------------------------------------------- */
  section('3. A failing sink loses nothing: the next pass delivers');
  const outageId = await insertDead(property.id, 'outage');
  receiver.mode = 'fail';
  const failed = await monitor.runPass();
  check(
    'while the receiver answers 500, the row stays unalerted',
    (await alertedAt(outageId)) === null && failed.deadLettersAlerted === 0,
    JSON.stringify(failed),
  );
  await monitor.runPass();
  check('and stays unalerted on a second failing pass', (await alertedAt(outageId)) === null);
  receiver.mode = 'ok';
  await monitor.runPass();
  check('once it recovers, the next pass delivers it', receivedMentioning(outageId).length === 1);
  check('and stamps it', (await alertedAt(outageId)) !== null);

  /* -- 4. timeout ------------------------------------------------------------- */
  section('4. A receiver that never answers is cut off by the timeout');
  const hangId = await insertDead(property.id, 'hang');
  receiver.mode = 'hang';
  const startedAt = Date.now();
  await monitor.runPass();
  const elapsed = Date.now() - startedAt;
  check(
    'the pass returns within the 1 s sink timeout (plus slack)',
    elapsed < 4_000,
    `${String(elapsed)} ms`,
  );
  check('and the row stays unalerted', (await alertedAt(hangId)) === null);
  receiver.mode = 'ok';
  await monitor.runPass();
  check(
    'then is delivered once the receiver answers',
    (await alertedAt(hangId)) !== null && receivedMentioning(hangId).length === 1,
  );

  /* -- 5. two sinks ---------------------------------------------------------- */
  section('5. One working sink of two is enough; the email says the same');
  const mails = [];
  const mailer = {
    delivers: true,
    send: async (message) => (mails.push(message), { messageId: 'm', loggedOnly: false }),
  };
  const both = new AlertMonitorService(prismaStub, monitorConfig, clock, [
    webhook,
    new EmailAlertSink(mailer, ['ops@alerts.invalid', 'gm@alerts.invalid']),
  ]);
  const twoId = await insertDead(property.id, 'two-sinks');
  receiver.mode = 'fail';
  await both.runPass();
  receiver.mode = 'ok';
  check(
    'with the webhook failing, the email delivered and the row is stamped',
    (await alertedAt(twoId)) !== null,
  );
  const toOps = mails.filter((mail) => mail.text.includes(twoId));
  check(
    'one email per recipient',
    toOps.length === 2 && new Set(toOps.map((m) => m.to)).size === 2,
    toOps.map((m) => m.to).join(', '),
  );
  check(
    'subject names it; auto-generated header set',
    toOps[0]?.subject.startsWith('[EaseIt alert]') &&
      toOps[0]?.headers?.['Auto-Submitted'] === 'auto-generated',
    String(toOps[0]?.subject),
  );

  /* -- 6. no payload values --------------------------------------------------- */
  section('6. An alert carries identifiers, never payload values');
  const MARKER = `GUEST-NAME-${RUN}`;
  const piiId = await insertDead(property.id, 'pii', {
    payload: { nonce: 'x', guestName: MARKER },
  });
  await monitor.runPass();
  const piiHits = receivedMentioning(piiId);
  check('it was alerted', piiHits.length === 1);
  check(
    'and no payload value appears in what was sent',
    piiHits.every((entry) => !entry.raw.includes(MARKER)),
  );

  /* -- 7. batching ------------------------------------------------------------ */
  section('7. A burst of dead letters is batched, and every one is stamped');
  const burst = [];
  for (let i = 0; i < 25; i += 1) burst.push(await insertDead(property.id, `burst-${String(i)}`));
  const beforeBurst = receiver.received.length;
  const pass1 = await monitor.runPass();
  check(
    'one pass alerts at most 20',
    pass1.deadLettersAlerted <= 20 && pass1.deadLettersAlerted > 0,
    JSON.stringify(pass1),
  );
  let passes = 1;
  while (passes < 10) {
    const left = await prisma.outboxEvent.count({ where: { id: { in: burst }, alertedAt: null } });
    if (left === 0) break;
    await monitor.runPass();
    passes += 1;
  }
  const unstamped = await prisma.outboxEvent.count({
    where: { id: { in: burst }, alertedAt: null },
  });
  check(
    'all 25 are stamped',
    unstamped === 0,
    `${String(passes)} pass(es), ${String(receiver.received.length - beforeBurst)} alert(s)`,
  );
  const listed = burst.filter((id) => receivedMentioning(id).length === 1);
  check('each appears in exactly one alert', listed.length === 25, `${String(listed.length)}/25`);

  /* -- 8. stale leases -------------------------------------------------------- */
  section('8. A lease stuck past the grace period alerts, with a cooldown');
  const fresh = await insertStaleLease(property.id, 'stale-fresh', 30);
  const quiet = await monitor.runPass();
  check('expired 30 s ago (inside the 120 s grace): no alert', quiet.staleLeaseAlerted === false);
  await prisma.outboxEvent.delete({ where: { id: fresh } });

  const staleId = await insertStaleLease(property.id, 'stale', 600);
  const stale1 = await monitor.runPass();
  const staleAlerts = () =>
    receiver.received.filter((entry) => entry.body.alert?.kind === 'OUTBOX_STALE_LEASE').length;
  check(
    'expired 10 min ago: alerted',
    stale1.staleLeaseAlerted === true && staleAlerts() === 1,
    `${String(staleAlerts())}`,
  );
  clock.at += 60_000;
  await monitor.runPass();
  check('one minute later, still stuck: not repeated', staleAlerts() === 1);
  clock.at += 600_000;
  await monitor.runPass();
  check('past the 10 min cooldown: repeated', staleAlerts() === 2);
  await prisma.outboxEvent.delete({ where: { id: staleId } });
  await monitor.runPass();
  check('the incident clears with no alert', staleAlerts() === 2);
  const again = await insertStaleLease(property.id, 'stale-again', 600);
  await monitor.runPass();
  check('a new incident alerts at once (the cooldown re-armed)', staleAlerts() === 3);
  await prisma.outboxEvent.delete({ where: { id: again } });

  /* -- 9. configuration ------------------------------------------------------- */
  section('9. Configuration: production needs a sink');
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/x',
    JWT_SECRET: 'x'.repeat(40),
    SMTP_HOST: 'smtp.alerts.invalid',
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    GST_PROVIDER: 'sandbox',
    GST_API_KEY: 'k',
    AUTH_COOKIE_DOMAIN: '.alerts.invalid',
    WEB_ADMIN_URL: 'https://admin.alerts.invalid',
  };
  const attempt = (overrides) => {
    try {
      return { ok: true, env: validateEnv({ ...base, ...overrides }) };
    } catch (error) {
      return { ok: false, message: String(error?.message ?? error) };
    }
  };
  const none = attempt({});
  check(
    'no sink: refused, naming ALERT_EMAIL_TO',
    !none.ok && none.message.includes('ALERT_EMAIL_TO'),
    none.ok ? 'booted' : '',
  );
  const emptyHook = attempt({ ALERT_WEBHOOK_URL: '', ALERT_EMAIL_TO: '' });
  check(
    'empty strings from compose count as unset: still refused',
    !emptyHook.ok && emptyHook.message.includes('ALERT_EMAIL_TO'),
  );
  const email = attempt({ ALERT_EMAIL_TO: 'ops@alerts.invalid, gm@alerts.invalid' });
  check(
    'an address list boots and is parsed',
    email.ok &&
      JSON.stringify(email.env.ALERT_EMAIL_TO) ===
        JSON.stringify(['ops@alerts.invalid', 'gm@alerts.invalid']),
    email.ok ? JSON.stringify(email.env.ALERT_EMAIL_TO) : email.message.slice(0, 200),
  );
  const hookOnly = attempt({ ALERT_WEBHOOK_URL: 'https://hooks.alerts.invalid/x' });
  check('a webhook alone boots', hookOnly.ok, hookOnly.ok ? '' : hookOnly.message.slice(0, 200));
  const badEmail = attempt({ ALERT_EMAIL_TO: 'not-an-address' });
  check('a malformed address is refused', !badEmail.ok);
  const badHook = attempt({
    ALERT_WEBHOOK_URL: 'ftp://hooks.alerts.invalid/x',
    ALERT_EMAIL_TO: 'ops@alerts.invalid',
  });
  check('a non-HTTP webhook is refused', !badHook.ok);
}

async function teardown() {
  const { count } = await prisma.outboxEvent.deleteMany({
    where: { dedupeKey: { startsWith: `alerting:${RUN}:` } },
  });
  console.log(`\nTeardown: removed ${String(count)} outbox row(s) written by this run.`);
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error('\nSuite error:', error?.stack ?? error);
} finally {
  await teardown().catch((error) => console.error('Teardown failed:', error.message));
  receiver.server?.closeAllConnections?.();
  receiver.server?.close();
  await prisma.$disconnect();
}

console.log(
  failures === 0 ? '\nAll alerting checks passed.' : `\n${String(failures)} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
