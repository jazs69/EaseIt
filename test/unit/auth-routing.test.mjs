/**
 * Route gating and the open-redirect guard.
 *
 * ===========================================================================
 * What this suite is for.
 *
 * Two things, and the second is the one that matters:
 *
 *   1. `/login` is a **sink**. A reproducible lockout came from middleware
 *      redirecting away from it whenever a session cookie merely *existed*.
 *      A cookie that exists but the API rejects — expired, revoked,
 *      malformed, or naming a row that is gone — produced a closed cycle:
 *
 *          /folio/...        -> 307 /login
 *          /login            -> 307 /group-dashboard
 *          /group-dashboard  -> 307 /login
 *
 *      and no hop cleared the cookie, so it never terminated. Chrome gave up
 *      with ERR_TOO_MANY_REDIRECTS and the sign-in form was unreachable. The
 *      checks below assert the cycle cannot form, for every cause, by
 *      asserting the one property that makes all of them impossible: nothing
 *      redirects out of `/login`.
 *
 *   2. `safeNext` is an **open-redirect guard**, so it is tested adversarially
 *      rather than happily. Every case in the corpus below is a real bypass of
 *      a naive `startsWith('/')` check.
 *
 * Runs under bare Node, like `payment-intent.test.mjs`: `lib/auth-routing.ts`
 * imports nothing, which is exactly why the decisions were moved out of
 * `middleware.ts` (that file imports `next/server`, which plain Node cannot
 * load — so its logic could not be tested at all).
 * ===========================================================================
 */

/**
 * Resolved as a `file://` URL relative to this file, not as a filesystem
 * path: Node's ESM loader rejects a bare Windows path (`d:` is read as a URL
 * scheme), and a URL relative to `import.meta.url` is correct on every
 * platform without hard-coding a drive letter.
 */
const routing = await import(
  new URL('../../apps/web-admin/src/lib/auth-routing.ts', import.meta.url).href
);

const {
  decideAuthRoute,
  safeNext,
  signedInDestination,
  isPublicPath,
  LOGIN_PATH,
  DEFAULT_SIGNED_IN_PATH,
  SESSION_COOKIE_NAME,
} = routing;

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

const route = (pathname, hasSession, search = '') =>
  decideAuthRoute({ pathname, search, hasSession });

/* -------------------------------------------------------------------------- */
/*  1 - 4  The sink: /login is never redirected away from                     */
/* -------------------------------------------------------------------------- */

console.log('\n1-4. /login is a sink, whatever the cookie says.');
{
  check(
    '1: /login with NO cookie is served',
    route('/login', false).kind === 'allow',
    route('/login', false).kind,
  );
  check(
    '1: /login WITH a cookie is also served — this is the regression',
    route('/login', true).kind === 'allow',
    JSON.stringify(route('/login', true)),
  );

  /**
   * 2: the cycle, enumerated. Middleware cannot distinguish these — every one
   * of them is "a cookie is present" as far as this layer can see — so the
   * single assertion above covers all of them. Spelled out anyway, because
   * the bug report named them individually and a reader should be able to
   * find their case here.
   */
  for (const cause of ['expired', 'revoked', 'malformed', 'nonexistent session']) {
    check(
      `2: a ${cause} cookie still reaches the login form`,
      route('/login', true).kind === 'allow',
    );
  }

  check(
    '3: a nested public path is public too',
    route('/login/help', true).kind === 'allow' && isPublicPath('/login/help'),
  );
  check(
    '3: but a path that merely starts with the same letters is NOT public',
    isPublicPath('/loginsomething') === false,
    `isPublicPath('/loginsomething')=${String(isPublicPath('/loginsomething'))}`,
  );
  check(
    '3: and that path is protected as normal',
    route('/loginsomething', false).kind === 'redirect',
  );

  /**
   * 4: the termination property, stated directly.
   *
   * Follow the decisions the way a browser follows redirects and assert the
   * walk stops. Under the old rule this loop ran until the cap; the cap is
   * the regression assertion.
   */
  const walk = (start, hasSession, cap = 5) => {
    let path = start;
    const seen = [path];
    for (let hop = 0; hop < cap; hop += 1) {
      const decision = route(path.split('?')[0], hasSession, '');
      if (decision.kind === 'allow') return { hops: hop, seen, terminated: true };
      path = decision.to;
      seen.push(path);
    }
    return { hops: cap, seen, terminated: false };
  };

  for (const [label, start, hasSession] of [
    ['a protected page with no cookie', '/group-dashboard', false],
    ['a protected page with a stale cookie', '/group-dashboard', true],
    ['the login page with a stale cookie', '/login', true],
    ['the root with no cookie', '/', false],
    ['a deep folio route with a stale cookie', '/folio/SFBOOKING_31001_A03', true],
  ]) {
    const result = walk(start, hasSession);
    check(
      `4: ${label} terminates`,
      result.terminated && result.hops <= 1,
      `${String(result.hops)} hop(s): ${result.seen.join(' -> ')}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  5 - 7  Protected routes, and the next parameter                           */
/* -------------------------------------------------------------------------- */

console.log('\n5-7. Protected routes still protected, and `next` preserved.');
{
  check(
    '5: a protected route with a cookie is served',
    route('/group-dashboard', true).kind === 'allow',
  );
  check(
    '5: a protected route with no cookie redirects to the login page',
    route('/group-dashboard', false).to === `${LOGIN_PATH}?next=%2Fgroup-dashboard`,
    route('/group-dashboard', false).to,
  );

  check(
    '6: the query string is preserved in `next`, encoded',
    route('/folio/SFBOOKING_31001_A03', false, '?hotelId=31001').to ===
      `${LOGIN_PATH}?next=%2Ffolio%2FSFBOOKING_31001_A03%3FhotelId%3D31001`,
    route('/folio/SFBOOKING_31001_A03', false, '?hotelId=31001').to,
  );
  check(
    '6: and it round-trips back to the original path',
    safeNext(
      decodeURIComponent(
        route('/folio/X', false, '?hotelId=31001').to.replace(`${LOGIN_PATH}?next=`, ''),
      ),
    ) === '/folio/X?hotelId=31001',
  );

  check(
    '7: the root carries no `next` — there is nothing to return to',
    route('/', false).to === LOGIN_PATH,
    route('/', false).to,
  );
  check(
    '7: the cookie name matches what the API sets by default',
    SESSION_COOKIE_NAME === 'easeit_session',
    SESSION_COOKIE_NAME,
  );
}

/* -------------------------------------------------------------------------- */
/*  8 - 11  safeNext: the open-redirect guard                                 */
/* -------------------------------------------------------------------------- */

console.log('\n8-11. safeNext rejects everything that is not plainly a local path.');
{
  /* ------------------------------------------------------------------- 8 */
  for (const [label, value, expected] of [
    ['a simple path', '/group-dashboard', '/group-dashboard'],
    ['a path with a query', '/folio/A03?hotelId=31001', '/folio/A03?hotelId=31001'],
    ['a path with a hash', '/reports#occupancy', '/reports#occupancy'],
    ['a deep path', '/a/b/c/d', '/a/b/c/d'],
    // Decoded for inspection, then re-encoded by `URL` — so what comes back is
    // a canonical, navigable path rather than the caller's spelling of it.
    ['an encoded space', '/folio/A%20B', '/folio/A%20B'],
  ]) {
    check(`8: ${label} is accepted`, safeNext(value) === expected, String(safeNext(value)));
  }

  /**
   * A documented consequence of decoding before inspecting: a path carrying a
   * literal **encoded slash** is normalised into a real one.
   *
   * This is the safe direction. Validation happens on the most-decoded form,
   * which is the most dangerous reading available, so anything accepted here
   * is safe under every lesser decoding too. No route in this application
   * encodes a slash inside a segment (booking codes are `SFBOOKING_...`), so
   * nothing real is reshaped — but it is asserted rather than left to be
   * discovered.
   */
  check(
    '8: an encoded slash is normalised, and the result is still same-origin',
    safeNext('/folio/A%2FB') === '/folio/A/B',
    String(safeNext('/folio/A%2FB')),
  );

  /* ------------------------------------------------------------------- 9 */
  /**
   * The corpus. Every one of these starts with `/` or is otherwise plausible,
   * and every one is a redirect off-origin if taken at face value.
   */
  const hostile = [
    ['protocol-relative', '//evil.com'],
    ['protocol-relative with a path', '//evil.com/pwn'],
    ['backslash authority', '/\\evil.com'],
    ['double backslash', '\\\\evil.com'],
    ['backslash anywhere', '/folio/\\evil.com'],
    ['encoded forward slash authority', '/%2fevil.com'],
    ['encoded backslash authority', '/%5cevil.com'],
    ['double-encoded slash', '/%252fevil.com'],
    ['absolute https', 'https://evil.com'],
    ['absolute http', 'http://evil.com/x'],
    ['scheme with no authority', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,<script>1</script>'],
    ['a relative path with no leading slash', 'group-dashboard'],
    ['empty', ''],
    ['a bare hash', '#frag'],
    ['whitespace-prefixed authority', '/\tevil.com'],
    ['newline-prefixed authority', '/\nevil.com'],
    ['carriage return', '/\revil.com'],
    ['a null byte', '/folio\u0000/x'],
    ['malformed percent-encoding', '/%zz'],
    ['an unterminated escape', '/%'],
  ];

  for (const [label, value] of hostile) {
    const got = safeNext(value);
    check(
      `9: ${label} is REJECTED`,
      got === null,
      `safeNext(${JSON.stringify(value)})=${String(got)}`,
    );
  }

  /* ------------------------------------------------------------------ 10 */
  for (const [label, value] of [
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', { toString: () => '/evil' }],
    ['an array', ['/a']],
    ['a boolean', true],
  ]) {
    check(`10: ${label} is rejected without throwing`, safeNext(value) === null);
  }

  /* ------------------------------------------------------------------ 11 */
  check(
    '11: the login page itself is never a destination — it would look like a failed sign-in',
    safeNext('/login') === null && safeNext('/login?next=%2Fx') === null,
  );
  check(
    '11: signedInDestination falls back for every hostile value',
    hostile.every(([, value]) => signedInDestination(value) === DEFAULT_SIGNED_IN_PATH),
  );
  check(
    '11: and passes a safe one through',
    signedInDestination('/folio/A03?hotelId=31001') === '/folio/A03?hotelId=31001',
    signedInDestination('/folio/A03?hotelId=31001'),
  );
  check(
    '11: signedInDestination never returns null or an off-origin value',
    [...hostile.map(([, v]) => v), '/ok', null, undefined].every((v) => {
      const out = signedInDestination(v);
      return typeof out === 'string' && out.startsWith('/') && !out.startsWith('//');
    }),
  );
}

/* -------------------------------------------------------------------------- */

console.log(
  failures === 0
    ? `\nAll auth-routing checks passed (${String(checks)}).`
    : `\n${String(failures)} of ${String(checks)} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
