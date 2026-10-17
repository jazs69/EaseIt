/**
 * The session cookie: the only place the access token is ever put.
 *
 * ===========================================================================
 * Why this is written by hand rather than with @fastify/cookie.
 *
 * The plugin was tried first. It augments Fastify's `FastifyInstance` and
 * `FastifyReply` via `declare module 'fastify'`, and under pnpm's isolated
 * layout that augmentation binds to whichever copy of `fastify` the plugin
 * itself resolves — which is not the copy `@nestjs/platform-fastify` types its
 * `register` and `FastifyReply` against (the adapter pins `fastify` exactly).
 * The result is `reply.setCookie` not existing on the reply type Nest hands
 * the controller. The only ways through were a cast at every call site or
 * `shamefully-hoist`, and both trade a real type guarantee for a dependency
 * that saves about forty lines.
 *
 * So: forty lines. What the plugin does that this does not is signed cookies
 * and value encoding, and neither is needed here — the value is already a
 * signed JWT (the signature is the integrity guarantee; a second MAC over the
 * same bytes adds key material to rotate and nothing else), and a JWT is
 * composed entirely of base64url characters and dots, every one of which is a
 * legal `cookie-octet`. `serializeSessionCookie` asserts that rather than
 * assuming it.
 *
 * Each attribute below is load-bearing:
 *
 *   httpOnly   The token is unreachable from JavaScript, so an XSS in the
 *              admin app cannot exfiltrate a session. This is the entire
 *              reason the token is not also returned in the login response
 *              body (see `authenticatedResponseSchema`).
 *   secure     On in production. An auth cookie over cleartext is readable by
 *              anything on the path. `validateEnv` refuses to boot a
 *              production process with this disabled.
 *   sameSite   `lax`, which is both safe and sufficient here. Same-site is
 *              decided by registrable domain and ignores the port, so
 *              localhost:3001 -> localhost:4000 in development and
 *              pms.yourdomain.com -> api.yourdomain.com in production are both
 *              same-site; the cookie rides along without needing `none`, which
 *              would have to be paired with cross-site CSRF defences.
 *   path       `/`, so Next middleware on the admin origin sees it too.
 *   domain     Unset in development (host-only `localhost`). Set to the
 *              registrable domain in production so the API's subdomain and the
 *              admin app's subdomain share one cookie.
 *
 * Max-Age is derived from the same integer as the token's `exp`, so the
 * browser forgets the cookie exactly when the token stops verifying. Two
 * independently configured lifetimes is how you end up with a cookie that is
 * present but useless, and a UI that cannot tell signed-out from broken.
 * ===========================================================================
 */

import type { ConfigService } from '@nestjs/config';

export const DEFAULT_SESSION_COOKIE_NAME = 'easeit_session';

export interface SessionCookieAttributes {
  secure: boolean;
  domain: string | undefined;
  /** Omitted for a deletion, where `Expires` in the past does the work. */
  maxAgeSeconds: number | undefined;
}

/**
 * The value this cookie carries is always a compact JWS: three base64url
 * segments separated by dots.
 *
 * Asserting that exact shape is both stricter and more honest than checking
 * RFC 6265's `cookie-octet` set. Every base64url character is already
 * cookie-safe, so a value that passes this cannot contain the `;` that would
 * let the remainder be read as further cookie attributes — and a value that
 * fails it was never a token this service produced, which is a bug worth
 * failing loudly on rather than serialising.
 *
 * Written out rather than as `!#-+…` code-point ranges on
 * purpose: the escaped form of the cookie-octet set puts a `]` inside the
 * character class, which silently closes it early and leaves a pattern that
 * matches almost nothing. This version has no such trap — the only `-` is
 * last in its class, where it is a literal.
 */
const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function sessionCookieName(config: ConfigService): string {
  return config.get<string>('AUTH_COOKIE_NAME', DEFAULT_SESSION_COOKIE_NAME);
}

function secureFlag(config: ConfigService): boolean {
  const configured = config.get<boolean>('AUTH_COOKIE_SECURE');
  return configured ?? config.get<string>('NODE_ENV', 'development') === 'production';
}

/** Attributes for setting the cookie. `maxAgeSeconds` matches the token's TTL. */
export function sessionCookieAttributes(
  config: ConfigService,
  maxAgeSeconds: number,
): SessionCookieAttributes {
  return {
    secure: secureFlag(config),
    domain: config.get<string>('AUTH_COOKIE_DOMAIN'),
    maxAgeSeconds,
  };
}

/**
 * Attributes for clearing it.
 *
 * A browser only overwrites a cookie when name, path *and* domain all match,
 * so sign-out has to repeat the same attributes the cookie was set with.
 * Getting this subtly wrong is how you get a "signed out" screen that is still
 * carrying a live session cookie on the next request.
 */
export function clearSessionCookieAttributes(config: ConfigService): SessionCookieAttributes {
  return {
    secure: secureFlag(config),
    domain: config.get<string>('AUTH_COOKIE_DOMAIN'),
    maxAgeSeconds: undefined,
  };
}

/** Builds a `Set-Cookie` value. */
export function serializeSessionCookie(
  name: string,
  value: string,
  attributes: SessionCookieAttributes,
): string {
  if (!COMPACT_JWS_PATTERN.test(value)) {
    // Never emit a header we cannot vouch for. The message deliberately does
    // not quote the value: it is a credential.
    throw new Error(
      'Refusing to set a session cookie: the value is not a compact JWS. ' +
        'Only a signed session token belongs in this cookie.',
    );
  }

  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];

  if (attributes.domain !== undefined) {
    parts.push(`Domain=${attributes.domain}`);
  }
  if (attributes.secure) {
    parts.push('Secure');
  }
  if (attributes.maxAgeSeconds !== undefined) {
    // Max-Age alone is enough for every browser in use, but Expires is sent
    // too so the cookie is not treated as a session cookie by anything older.
    parts.push(`Max-Age=${String(attributes.maxAgeSeconds)}`);
    parts.push(`Expires=${new Date(Date.now() + attributes.maxAgeSeconds * 1_000).toUTCString()}`);
  }

  return parts.join('; ');
}

/** Builds the `Set-Cookie` value that deletes the cookie. */
export function serializeClearedSessionCookie(
  name: string,
  attributes: SessionCookieAttributes,
): string {
  const parts = [
    `${name}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];

  if (attributes.domain !== undefined) {
    parts.push(`Domain=${attributes.domain}`);
  }
  if (attributes.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

/**
 * Reads one cookie out of a `Cookie` request header.
 *
 * Only the first occurrence of a name is honoured. That matters: a request can
 * legally carry two cookies of the same name (one host-only, one set for a
 * parent domain), and a "last one wins" reader lets an attacker who controls a
 * sibling subdomain shadow the real session cookie. Browsers send the
 * more-specific one first, so first-wins is the safe reading.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined || header.length === 0) return null;

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;

    if (pair.slice(0, separator).trim() !== name) continue;

    const raw = pair.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // Malformed percent-encoding. The value is not one we wrote.
      return null;
    }
  }

  return null;
}
