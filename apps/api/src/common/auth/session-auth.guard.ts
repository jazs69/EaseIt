/**
 * Identity resolution. This is the real one.
 *
 * It replaces the `DevAuthGuard` that read an unverified `x-user-email`
 * header, and it closes the first unbuilt item in CLAUDE.md section 2.
 * Everything downstream — `ActivePropertyGuard`, `PermissionsGuard` — was
 * already written against this contract and did not change.
 *
 * Two places a token is accepted, in this order:
 *
 *   1. The **session cookie**, which is how the browser authenticates. It is
 *      httpOnly, so the admin app never sees the token it is sending.
 *   2. An **`Authorization: Bearer` header**, which is how Swagger and `curl`
 *      authenticate. This is not a weaker path: the same signature over the
 *      same claims is verified either way. What a bearer header lacks is
 *      XSS-resistance, which matters for a browser session and not for a
 *      terminal.
 *
 * Note what this guard does *not* do: it never reads a role, a permission or a
 * property from the token. It establishes only *who*. Authority is resolved
 * per request from the database, so revoking a grant takes effect on the next
 * request rather than at token expiry.
 */

import { Injectable, Logger, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service.js';
import { AccountDisabledError, UnauthenticatedError } from '../errors/domain-error.js';
import type { AuthenticatedRequest } from './authenticated-user.js';
import { readCookie, sessionCookieName } from './session-cookie.js';
import { TokenService } from './token.service.js';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  private readonly logger = new Logger(SessionAuthGuard.name);
  private readonly cookieName: string;

  constructor(
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.cookieName = sessionCookieName(config);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const token = this.extractToken(request);
    if (token === null) {
      throw new UnauthenticatedError();
    }

    const claims = this.tokens.verify(token);
    if (claims === null) {
      // Expired, forged, or signed with a rotated secret — all the same 401.
      // Logged without the token, which is itself a credential.
      this.logger.warn(`Rejected an unverifiable session token [${request.id}]`);
      throw new UnauthenticatedError();
    }

    // The token proves the claims are ours; it does not prove the account is
    // still there. A deactivated staff member holding a token issued an hour
    // ago must stop working now, not in seven hours.
    const user = await this.prisma.client.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, email: true, isActive: true },
    });

    if (user === null) {
      throw new UnauthenticatedError();
    }
    if (!user.isActive) {
      throw new AccountDisabledError();
    }

    request.user = {
      userId: user.id,
      // The database's copy, not the token's: if the address changed since the
      // token was issued, the current one is the correct one to log against.
      email: user.email,
      authMethods: claims.amr,
      activePropertyId: claims.pid,
    };

    return true;
  }

  private extractToken(request: AuthenticatedRequest): string | null {
    const cookieHeader = request.headers['cookie'];
    const fromCookie = readCookie(
      Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader,
      this.cookieName,
    );
    if (fromCookie !== null && fromCookie.length > 0) {
      return fromCookie;
    }

    const header = request.headers['authorization'];
    const authorization = Array.isArray(header) ? header[0] : header;
    if (authorization === undefined) return null;

    // Case-insensitive scheme, exactly one space, non-empty credential.
    const match = /^Bearer[ ]+(\S+)$/i.exec(authorization.trim());
    return match?.[1] ?? null;
  }
}
