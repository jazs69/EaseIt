/**
 * Route-gating decisions, as pure functions.
 *
 * ===========================================================================
 * Why this is a separate module rather than logic inside `middleware.ts`.
 *
 * `middleware.ts` imports `next/server`, and that subpath declares
 * `exports["./server"] = null` and resolves to an extensionless file, so plain
 * Node cannot import it — which means the middleware's decisions could not be
 * unit-tested at all. Every other pure module in this feature area
 * (`components/folio/payment-intent.ts`) is testable precisely because it
 * imports nothing, and the unit suite runs under bare Node by stripping types
 * on import.
 *
 * So the decisions live here, dependency-free, and `middleware.ts` becomes a
 * thin adapter that translates a `NextRequest` into the inputs below and an
 * `AuthRoute` back into a `NextResponse`. That is the whole reason this file
 * exists: an open-redirect guard that cannot be tested is not a guard.
 * ===========================================================================
 */

/** The name of the cookie the API sets. Must match `AUTH_COOKIE_NAME`. */
export const SESSION_COOKIE_NAME = process.env.NEXT_PUBLIC_AUTH_COOKIE_NAME ?? 'easeit_session';

/** Where an unauthenticated visitor is sent, and the only public route. */
export const LOGIN_PATH = '/login';

/** Where a signed-in operator lands when no safe `next` was preserved. */
export const DEFAULT_SIGNED_IN_PATH = '/group-dashboard';

/** Everything a signed-out visitor may reach. */
const PUBLIC_PATHS = [LOGIN_PATH];

export type AuthRoute =
  /** Serve the request as-is. */
  | { kind: 'allow' }
  /** Send the visitor somewhere else; `to` is always a same-origin path. */
  | { kind: 'redirect'; to: string };

/** Is this one of the paths a signed-out visitor may reach? */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * The gate, as a total function of the request.
 *
 * ===========================================================================
 * `/login` is a **sink**: it is never redirected away from.
 *
 * It used to bounce a visitor to the dashboard whenever a session cookie was
 * merely *present*, and that was a reproducible lockout. A cookie that exists
 * but the API rejects — expired, revoked, malformed, or naming a session row
 * that is gone — produced a closed cycle:
 *
 *     /folio/...        -> 307 /login            (the page's own 401 handling)
 *     /login            -> 307 /group-dashboard  (cookie present)
 *     /group-dashboard  -> 307 /login            (API says 401)
 *
 * and no hop ever cleared the cookie, so it never terminated. The browser
 * gave up with ERR_TOO_MANY_REDIRECTS and the sign-in form became unreachable
 * — for a clerk whose session was revoked, the only way back in was clearing
 * site data by hand.
 *
 * The fix is structural rather than clever: this layer cannot tell a valid
 * cookie from an invalid one (see `middleware.ts` on why it must not try), so
 * it no longer makes a decision that depends on knowing. The convenience
 * redirect for an already-signed-in operator moved to the login page, which
 * *can* ask the API and only redirects on a confirmed session. With no
 * redirect out of `/login`, no cycle can form from any cause.
 * ===========================================================================
 */
export function decideAuthRoute(input: {
  pathname: string;
  /** The query string including its leading `?`, or an empty string. */
  search: string;
  /** Whether the session cookie is present. Presence only — never validity. */
  hasSession: boolean;
}): AuthRoute {
  if (isPublicPath(input.pathname)) return { kind: 'allow' };
  if (input.hasSession) return { kind: 'allow' };

  /**
   * Preserved so the operator lands where they were trying to go.
   *
   * Only the path and query are kept. Taking a full URL from the request
   * would let a crafted link turn this into an open redirect — and the value
   * is re-validated by `safeNext` before anything navigates to it, because a
   * parameter that has been round-tripped through a URL bar is attacker
   * input no matter who wrote it first.
   */
  if (input.pathname === '/') return { kind: 'redirect', to: LOGIN_PATH };

  const next = encodeURIComponent(`${input.pathname}${input.search}`);
  return { kind: 'redirect', to: `${LOGIN_PATH}?next=${next}` };
}

/**
 * The post-sign-in destination, or null when the candidate cannot be trusted.
 *
 * ===========================================================================
 * An allow-list of one shape: a single leading `/`, then a path.
 *
 * This is the open-redirect guard, so it is written to reject rather than to
 * sanitise — a value that is not obviously safe is discarded for the default,
 * which costs the operator one navigation and costs an attacker everything.
 *
 * The cases that matter, each of which a naive `startsWith('/')` lets through:
 *
 *   `//evil.com`        protocol-relative. The browser reads this as
 *                       `https://evil.com`, and it starts with `/`.
 *   `/\evil.com`        browsers normalise the backslash to `/`, so this is
 *                       the same attack wearing a different character.
 *   `/%2fevil.com`      percent-encoded, decoded by whatever consumes it.
 *   `/%5cevil.com`      the encoded backslash, same reasoning.
 *   `https://evil.com`  an absolute URL with a scheme.
 *   `javascript:...`    a scheme with no `//` at all; `new URL` accepts it.
 *
 * So: decode first (because the consumer will), then insist the result is a
 * path that begins with exactly one `/`, contains no backslash anywhere, and
 * carries no scheme or authority. Anything that fails to decode is already
 * not something this application produced.
 * ===========================================================================
 */
export function safeNext(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0) return null;

  /**
   * Decoded before inspection, and repeatedly until it stops changing.
   *
   * A single decode is not enough: `%252f` decodes to `%2f`, which whatever
   * consumes the value may decode again. Bounded, because a decoder loop over
   * attacker input with no bound is its own problem.
   */
  let candidate = raw;
  for (let pass = 0; pass < 3; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      // Malformed percent-encoding. Never something this app wrote.
      return null;
    }
    if (decoded === candidate) break;
    candidate = decoded;
  }

  // A backslash anywhere: browsers treat it as `/` in the authority position,
  // and it has no legitimate place in a path this application generates.
  if (candidate.includes('\\')) return null;

  // Control characters, including the tab/newline/CR that URL parsers strip
  // before resolving — which is how `/\tevil.com` becomes an authority.
  // eslint-disable-next-line no-control-regex -- stripping these is the point.
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return null;

  // Exactly one leading slash, and no second one: `//evil.com` is an
  // authority, not a path.
  if (!candidate.startsWith('/')) return null;
  if (candidate.startsWith('//')) return null;

  /**
   * No scheme and no authority, confirmed by parsing rather than by pattern.
   *
   * Resolved against a throwaway origin: a genuine relative path keeps that
   * origin, while anything carrying its own scheme or authority replaces it
   * and is refused. `javascript:` has no `//` and would pass every string
   * check above, and this is what catches it.
   */
  const base = 'http://relative.invalid';
  let parsed: URL;
  try {
    parsed = new URL(candidate, base);
  } catch {
    return null;
  }
  if (parsed.origin !== base) return null;

  // Never bounce back to the sign-in screen: it would look like a failed
  // login to the operator, and it is not a destination.
  if (isPublicPath(parsed.pathname)) return null;

  // Rebuilt from the parsed parts rather than returned verbatim, so what
  // navigates is exactly what was validated.
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** The destination after a successful sign-in. Never null. */
export function signedInDestination(raw: unknown): string {
  return safeNext(raw) ?? DEFAULT_SIGNED_IN_PATH;
}
