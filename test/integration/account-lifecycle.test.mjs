/**
 * Password reset, invitations and deactivation (AU-08, AU-14, AU-15).
 *
 * ===========================================================================
 * Acceptance:
 *   AU-08  a single-use expiring token; replay and expiry both refused.
 *   AU-14  invite, accept, first-login password set.
 *   AU-15  deactivating blocks login and revokes sessions.
 *
 * The emailed links are read from the API's capture mailer (MAIL_CAPTURE_DIR,
 * a test-only transport refused in production): only a hash of each token is
 * stored, so the email is the one place the token exists. Nothing is sent.
 *
 * The API must run with MAIL_CAPTURE_DIR set to the same directory, and
 * fresh: the reset endpoints are rate limited per caller, in memory.
 * ===========================================================================
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createHarness, requireEnvironment, runSuite } from '../support/room-fixture.mjs';

const SUITE = 'account lifecycle';
requireEnvironment(SUITE);

const MAIL_DIR = process.env.MAIL_CAPTURE_DIR;
if (!MAIL_DIR) {
  console.error('MAIL_CAPTURE_DIR is required: the API under test must capture mail to the same directory.');
  process.exit(1);
}

const databaseModule = await import('../../packages/database/dist/index.js');
const { createPrismaClient } = databaseModule.default ?? databaseModule;
const prisma = createPrismaClient();

const h = createHarness({ suiteName: SUITE, prefix: 'ZZACL', slugPrefix: 'zz-acl-', emailDomain: 'acl.invalid', prisma });
const other = createHarness({ suiteName: `${SUITE} (B)`, prefix: 'ZZACB', slugPrefix: 'zz-acb-', emailDomain: 'acb.invalid', prisma });

const PASSWORD = 'Correct-Horse-42';
const show = (res) => `HTTP ${String(res.status)} ${res.payload?.code ?? ''} ${JSON.stringify(res.payload?.details ?? '')}`;
const invitedEmails = [];

/** Every captured message to `to`, oldest first. */
function mailTo(to) {
  let files = [];
  try {
    files = readdirSync(MAIL_DIR).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  return files.map((f) => JSON.parse(readFileSync(join(MAIL_DIR, f), 'utf8'))).filter((m) => m.to === to);
}
const tokenIn = (message) => /#token=([A-Za-z0-9_-]{43})/.exec(message?.text ?? '')?.[1] ?? null;
const latestToken = (to) => tokenIn(mailTo(to).at(-1));

async function body() {
  console.log('\n════ account lifecycle (AU-08, AU-14, AU-15) ════\n');
  const liveDb = await h.guardDatabase();
  const serverDb = await h.assertLiveDatabaseIsTest();
  h.note(`guard ${SUITE}: ${liveDb}; server reports current_database() = ${serverDb}; mail -> ${MAIL_DIR}`);
  await h.sweepLeftovers();
  await other.sweepLeftovers();

  const A = await h.buildFixture({
    roles: { admin: 'PROPERTY_ADMIN', clerk: 'FRONT_DESK', keeper: 'HOUSEKEEPING', leaving: 'REVENUE_MANAGER', shared: 'FRONT_DESK' },
    rooms: [],
  });
  const B = await other.buildFixture({ roles: { admin: 'PROPERTY_ADMIN' }, rooms: [] });
  await h.assertApiSharesDatabase(A, A.users.admin.cookie, liveDb);
  // `shared` also works at B, so a property admin of A may not deactivate them.
  const frontDesk = await prisma.role.findFirst({ where: { key: 'FRONT_DESK', propertyId: null }, select: { id: true } });
  await prisma.userPropertyRole.create({ data: { propertyId: B.propertyId, userId: A.users.shared.id, roleId: frontDesk.id } });

  const login = (email, password) => h.call('POST', '/auth/login', null, { email, password });
  const session = (cookie) => h.call('GET', '/auth/session', cookie);
  const forgot = (email) => h.call('POST', '/auth/password/forgot', null, { email });
  const reset = (token, newPassword = PASSWORD) => h.call('POST', '/auth/password/reset', null, { token, newPassword });
  const accept = (token, newPassword = PASSWORD) => h.call('POST', '/auth/invitations/accept', null, { token, newPassword });
  const base = `/properties/${A.propertyId}`;
  const admin = A.users.admin.cookie;

  /* ------------------------------------------------------------------ 1 */
  console.log('1. Forgot password: one answer for everyone, a link only for a real account.');
  const clerk = A.users.clerk;
  const asked = await forgot(clerk.email);
  const unknown = await forgot(`nobody-${Date.now()}@acl.invalid`);
  h.check('a real address: 202 { accepted: true }', asked.status === 202 && asked.payload?.accepted === true, show(asked));
  h.check('an unknown address: the identical answer', unknown.status === 202 && JSON.stringify(unknown.payload) === JSON.stringify(asked.payload), show(unknown));
  const clerkMail = mailTo(clerk.email);
  h.check('exactly one email, carrying a link with the token in the fragment', clerkMail.length === 1 && /\/reset-password#token=/.test(clerkMail[0].text));
  const stored = await prisma.authToken.findMany({ where: { userId: clerk.id }, select: { tokenHash: true } });
  const token1 = tokenIn(clerkMail[0]);
  h.check('only a hash is stored, never the token', stored.length === 1 && token1 !== null && stored[0].tokenHash !== token1 && /^[0-9a-f]{64}$/.test(stored[0].tokenHash));

  /* ------------------------------------------------------------------ 2 */
  console.log('\n2. Reset: single use, sessions revoked, the new password works.');
  const weak = await reset(token1, 'short');
  h.check('a password that fails the policy: 400, and the link is not spent', weak.status === 400 && weak.payload?.code === 'VALIDATION_FAILED', show(weak));
  h.check("before the reset the clerk's session works", (await session(clerk.cookie)).status === 200);
  // The guard tolerates a token issued in the same second as a revocation
  // (session-auth.guard.ts documents why), so step past that second first.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const done = await reset(token1);
  h.check('reset: 200, naming the address to sign in with', done.status === 200 && done.payload?.email === clerk.email, show(done));
  const replay = await reset(token1, 'Another-Pass-43');
  h.check('the same link again: 400 AUTH_TOKEN_INVALID', replay.status === 400 && replay.payload?.code === 'AUTH_TOKEN_INVALID', show(replay));
  h.check('the session issued before the reset is revoked', (await session(clerk.cookie)).status === 401);
  const signIn = await login(clerk.email, PASSWORD);
  h.check('the new password signs in (the second factor follows)', signIn.status === 200 && ['two_factor_required', 'authenticated'].includes(signIn.payload?.status), show(signIn));
  const replayed = await login(clerk.email, 'Another-Pass-43');
  h.check('the replayed request changed nothing', replayed.status === 401, show(replayed));

  await forgot(clerk.email);
  const raceToken = latestToken(clerk.email);
  const race = await Promise.all(Array.from({ length: 5 }, (_, i) => reset(raceToken, `Race-Winner-${String(i)}x`)));
  h.check('five simultaneous submissions of one link: exactly one succeeds', race.filter((r) => r.status === 200).length === 1 && race.filter((r) => r.payload?.code === 'AUTH_TOKEN_INVALID').length === 4, race.map((r) => r.status).join(','));

  /* ------------------------------------------------------------------ 3 */
  console.log('\n3. Expired and superseded links are refused.');
  const keeper = A.users.keeper;
  await forgot(keeper.email);
  const expiring = latestToken(keeper.email);
  await prisma.authToken.updateMany({ where: { userId: keeper.id, consumedAt: null, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await reset(expiring);
  h.check('an expired link: 400 AUTH_TOKEN_INVALID', expired.status === 400 && expired.payload?.code === 'AUTH_TOKEN_INVALID', show(expired));
  await forgot(keeper.email);
  const older = latestToken(keeper.email);
  await forgot(keeper.email);
  const newer = latestToken(keeper.email);
  const superseded = await reset(older);
  h.check('an older link, superseded by a newer one: 400', superseded.status === 400 && superseded.payload?.code === 'AUTH_TOKEN_INVALID', show(superseded));
  h.check('the newest link works', (await reset(newer)).status === 200);

  /* ------------------------------------------------------------------ 4 */
  console.log('\n4. Invitations.');
  const roles = await h.call('GET', `${base}/roles`, admin);
  const deskRole = (roles.payload ?? []).find((r) => r.key === 'FRONT_DESK');
  const newcomer = `newcomer-${Date.now()}@acl.invalid`;
  invitedEmails.push(newcomer);
  const deny = await h.call('POST', `${base}/users/invite`, A.users.clerk.cookie, { email: newcomer, firstName: 'New', lastName: 'Comer', roleIds: [deskRole?.id] });
  h.check('front desk (no users:manage) cannot invite', deny.status === 403 || deny.status === 401, show(deny));
  const cross = await h.call('POST', `${base}/users/invite`, B.users.admin.cookie, { email: newcomer, firstName: 'New', lastName: 'Comer', roleIds: [deskRole?.id] });
  h.check("another property's admin inviting into this one: 404", cross.status === 404, show(cross));
  const invite = await h.call('POST', `${base}/users/invite`, admin, { email: newcomer, firstName: 'New', lastName: 'Comer', roleIds: [deskRole?.id] });
  h.check('the admin invites: SENT, with the role granted here', (invite.status === 200 || invite.status === 201) && invite.payload?.invitation === 'SENT' && invite.payload?.member?.email === newcomer, show(invite));
  const firstInvite = latestToken(newcomer);
  h.check('the invitation email carries an accept link', firstInvite !== null && /\/accept-invite#token=/.test(mailTo(newcomer).at(-1)?.text ?? ''));
  const notYet = await login(newcomer, PASSWORD);
  h.check('before accepting, no password signs in', notYet.status === 401, show(notYet));
  const again = await h.call('POST', `${base}/users/invite`, admin, { email: newcomer, firstName: 'New', lastName: 'Comer', roleIds: [deskRole?.id] });
  h.check('inviting a still-pending person again re-sends (SENT)', again.payload?.invitation === 'SENT', show(again));
  h.check('and the earlier link no longer works', (await accept(firstInvite)).payload?.code === 'AUTH_TOKEN_INVALID');
  const acceptedToken = latestToken(newcomer);
  const accepted = await accept(acceptedToken);
  h.check('accepting the current link: 200', accepted.status === 200 && accepted.payload?.email === newcomer, show(accepted));
  h.check('the first password signs in', [200].includes((await login(newcomer, PASSWORD)).status));
  h.check('the link cannot be used twice', (await accept(acceptedToken)).payload?.code === 'AUTH_TOKEN_INVALID');
  h.check('an invitation link is not a reset link', (await reset(acceptedToken)).payload?.code === 'AUTH_TOKEN_INVALID');
  const mailsBefore = mailTo(clerk.email).length;
  const existing = await h.call('POST', `${base}/users/invite`, admin, { email: clerk.email, firstName: 'C', lastName: 'L', roleIds: [deskRole?.id] });
  h.check('inviting someone who already has an account: NOT_NEEDED, no email', existing.payload?.invitation === 'NOT_NEEDED' && mailTo(clerk.email).length === mailsBefore, show(existing));

  /* ------------------------------------------------------------------ 5 */
  console.log('\n5. Deactivation.');
  const leaving = A.users.leaving;
  await forgot(leaving.email);
  const pendingLink = latestToken(leaving.email);
  h.check("setup: the person's session works", (await session(leaving.cookie)).status === 200);
  const self = await h.call('POST', `${base}/users/${A.users.admin.id}/deactivate`, admin, { reason: null });
  h.check('deactivating oneself: 409 DEACTIVATION_REFUSED', self.status === 409 && self.payload?.code === 'DEACTIVATION_REFUSED', show(self));
  const shared = await h.call('POST', `${base}/users/${A.users.shared.id}/deactivate`, admin, { reason: null });
  h.check('someone who also works at another property: 409, untouched', shared.status === 409 && shared.payload?.code === 'DEACTIVATION_REFUSED' && (await prisma.user.findUnique({ where: { id: A.users.shared.id }, select: { isActive: true } })).isActive, show(shared));
  const outsider = await h.call('POST', `${base}/users/${B.users.admin.id}/deactivate`, admin, { reason: null });
  h.check("someone with no role here: 404, not 403", outsider.status === 404, show(outsider));
  const byDesk = await h.call('POST', `${base}/users/${leaving.id}/deactivate`, A.users.clerk.cookie, { reason: null });
  h.check('front desk cannot deactivate', byDesk.status === 403 || byDesk.status === 401, show(byDesk));
  const off = await h.call('POST', `${base}/users/${leaving.id}/deactivate`, admin, { reason: 'Left the company' });
  h.check('the admin deactivates: 200, inactive', (off.status === 200 || off.status === 201) && off.payload?.isActive === false, show(off));
  const deadSession = await session(leaving.cookie);
  h.check('their existing session stops working', deadSession.status === 401 || deadSession.status === 403, show(deadSession));
  const blocked = await login(leaving.email, 'anything-At-All-1');
  h.check('they cannot sign in', blocked.status === 401 || blocked.status === 403, show(blocked));
  h.check('their unused reset link was revoked', (await reset(pendingLink)).payload?.code === 'AUTH_TOKEN_INVALID');
  const mailCount = mailTo(leaving.email).length;
  await forgot(leaving.email);
  h.check('forgot-password sends them nothing', mailTo(leaving.email).length === mailCount);
  const audit = await prisma.auditLog.findFirst({ where: { propertyId: A.propertyId, event: 'USER_DEACTIVATED', entityId: leaving.id }, select: { actorUserId: true, reason: true } });
  h.check('audited with the actor and reason', audit?.actorUserId === A.users.admin.id && audit?.reason === 'Left the company');
  const on = await h.call('POST', `${base}/users/${leaving.id}/reactivate`, admin, { reason: null });
  h.check('reactivated: 200, active', (on.status === 200 || on.status === 201) && on.payload?.isActive === true, show(on));
  h.check('a session revoked at deactivation stays revoked', (await session(leaving.cookie)).status === 401);
}

await runSuite({
  harness: h,
  prisma,
  label: 'account lifecycle integration',
  body: async () => {
    try {
      await body();
    } finally {
      // Invited accounts are not harness users; remove them (tokens cascade).
      await prisma.user.deleteMany({ where: { email: { in: invitedEmails } } });
      await other.teardown();
    }
  },
});
