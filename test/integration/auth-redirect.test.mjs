/**
 * The redirect-loop regression, over real HTTP.
 *
 * ===========================================================================
 * What this proves that the unit suite cannot.
 *
 * `test/unit/auth-routing.test.mjs` asserts the *decision*. This asserts the
 * *deployment*: that Next actually runs the middleware, that the login page's
 * validated redirect behaves, and that following the redirects the way a
 * browser follows them terminates. The bug being guarded was only ever
 * visible end to end — each individual 307 was defensible; the cycle was not.
 *
 * The failure it exists to prevent:
 *
 *     /folio/...        -> 307 /login
 *     /login            -> 307 /group-dashboard
 *     /group-dashboard  -> 307 /login
 *
 * with no hop clearing the cookie, so a browser gave up with
 * ERR_TOO_MANY_REDIRECTS and the sign-in form was unreachable for exactly the
 * operators whose session had expired or been revoked.
 *
 * ---------------------------------------------------------------------------
 * WRITES NOTHING. Opt-in, and read-only by construction.
 *
 * Every case below uses a cookie the API cannot possibly accept — absent,
 * malformed, or a well-formed token naming no session row — so each request
 * is answered with a 401 after a read. No row is created, updated or deleted
 * in any database, which is why this is safe to run against `easeit_test`.
 *
 * The three cases that WOULD need writes -- a genuinely valid cookie, a
 * deliberately expired one, and a session revoked mid-test -- all require
 * signing in, which creates a two-factor challenge row and a session row.
 * They are deliberately NOT here. Adding them means gating them behind an
 * explicit flag and an isolated database, the way the folio suites do.
 *
 * Run it with both services up:
 *
 *   EASEIT_WEB_URL=http://127.0.0.1:3011 node test/integration/auth-redirect.test.mjs
 *
 * It is not in `pnpm gate`, because the gate must not require a running
 * Next.js server.
 * ===========================================================================
 */

const WEB = process.env.EASEIT_WEB_URL ?? 'http://127.0.0.1:3011';
const COOKIE_NAME = process.env.EASEIT_AUTH_COOKIE_NAME ?? 'easeit_session';

/** A syntactically valid compact JWS that names no session anywhere. */
const ORPHAN_JWS =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
  '.eyJzdWIiOiJuby1zdWNoLXNlc3Npb24iLCJleHAiOjQxMDI0NDQ4MDB9' +
  '.c2lnbmF0dXJlLXRoYXQtd2lsbC1uZXZlci12ZXJpZnk';

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** One hop, never followed automatically. */
async function hop(path, cookie) {
  const response = await fetch(`${WEB}${path}`, {
    redirect: 'manual',
    headers: cookie === undefined ? {} : { cookie: `${COOKIE_NAME}=${cookie}` },
  });
  return { status: response.status, location: response.headers.get('location') };
}

/**
 * Follows redirects with a hard cap, and reports whether it terminated.
 *
 * The cap **is** the regression assertion: under the old rule this walk ran
 * until it hit the limit, which is what a browser reports as
 * ERR_TOO_MANY_REDIRECTS.
 */
async function walk(start, cookie, cap = 6) {
  let path = start;
  const trail = [path];
  for (let count = 0; count < cap; count += 1) {
    const { status, location } = await hop(path, cookie);
    if (status < 300 || status >= 400 || location === null) {
      return { terminated: true, status, hops: count, trail };
    }
    path = location.startsWith('http')
      ? new URL(location).pathname + new URL(location).search
      : location;
    trail.push(path);
  }
  return { terminated: false, status: null, hops: cap, trail };
}

console.log('════ auth redirect loop (read-only) ════');
console.log(`  web : ${WEB}`);

try {
  const probe = await fetch(`${WEB}/login`, { redirect: 'manual' });
  console.log(`  preflight /login -> ${String(probe.status)}\n`);
} catch (error) {
  console.error(
    `\nGATE: ${WEB} is not reachable (${error instanceof Error ? error.message : 'unknown'}).` +
      '\nStart web-admin first; this suite drives a real server on purpose.',
  );
  process.exit(1);
}

/* ---------------------------------------------------------- 1. no cookie -- */
{
  const direct = await hop('/login');
  check('1: /login with no cookie renders', direct.status === 200, String(direct.status));

  const protectedRoute = await hop('/folio/SFBOOKING_31001_A03?hotelId=31001');
  check(
    '1: a protected route with no cookie redirects to the login page',
    protectedRoute.status === 307 && (protectedRoute.location ?? '').includes('/login'),
    `${String(protectedRoute.status)} -> ${String(protectedRoute.location)}`,
  );
  check(
    '1: and preserves where they were going, encoded',
    (protectedRoute.location ?? '').includes(
      'next=%2Ffolio%2FSFBOOKING_31001_A03%3FhotelId%3D31001',
    ),
    String(protectedRoute.location),
  );
}

/* ------------------------------------------- 2. the regression, every cause */
{
  for (const [label, cookie] of [
    ['a malformed cookie', 'not-a-jwt'],
    ['an empty cookie', ''],
    ['a well-formed token naming no session', ORPHAN_JWS],
    ['a token with a bad signature', `${ORPHAN_JWS}tampered`],
  ]) {
    const atLogin = await hop('/login', cookie);
    check(
      `2: /login with ${label} RENDERS — it is never redirected away from`,
      atLogin.status === 200,
      `${String(atLogin.status)}${atLogin.location ? ' -> ' + atLogin.location : ''}`,
    );
  }
}

/* ------------------------------------------------------- 3. termination --- */
{
  for (const [label, start, cookie] of [
    ['no cookie, protected route', '/group-dashboard', undefined],
    ['malformed cookie, protected route', '/group-dashboard', 'not-a-jwt'],
    ['orphan token, protected route', '/group-dashboard', ORPHAN_JWS],
    ['orphan token, login page', '/login', ORPHAN_JWS],
    ['orphan token, deep folio route', '/folio/SFBOOKING_31001_A03?hotelId=31001', ORPHAN_JWS],
    ['no cookie, root', '/', undefined],
  ]) {
    const result = await walk(start, cookie);
    check(
      `3: ${label} terminates`,
      result.terminated,
      `${String(result.hops)} hop(s), final ${String(result.status)}: ${result.trail.join(' -> ')}`,
    );
  }
}

/* ------------------------------------------------- 4. no open redirect ---- */
{
  for (const hostile of ['//evil.com', '/%2fevil.com', 'https://evil.com', '/\\evil.com']) {
    const result = await hop(`/login?next=${encodeURIComponent(hostile)}`);
    check(
      `4: /login?next=${hostile} still renders and redirects nowhere`,
      result.status === 200 && result.location === null,
      `${String(result.status)} -> ${String(result.location)}`,
    );
  }
}

/* -------------------------------------------------------------------------- */

console.log(
  failures === 0
    ? `\nAll auth redirect checks passed (${String(checks)}). Nothing was written.`
    : `\n${String(failures)} of ${String(checks)} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
