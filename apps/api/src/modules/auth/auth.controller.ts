/**
 * Sign-in endpoints.
 *
 * The controller's whole job here is transport: validate with the shared zod
 * schemas, pull the request's origin out of Fastify, and attach or clear the
 * session cookie. Every decision — whether a password is right, whether a code
 * is still live, whether a resend is allowed — belongs to `AuthService`
 * (CLAUDE.md section 5).
 *
 * Note which routes are unguarded and why: `login`, `verify-otp` and
 * `resend-otp` are reachable without a session because they are how a session
 * is obtained. They are not therefore unprotected — each is rate-limited by
 * `AuthService`, and `verify-otp` additionally has a per-challenge attempt
 * budget enforced in the database.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  loginRequestSchema,
  resendOtpRequestSchema,
  verifyOtpRequestSchema,
  type AuthenticatedResponse,
  type LoginRequest,
  type LoginResult,
  type ResendOtpRequest,
  type Session,
  type TwoFactorChallenge,
  type VerifyOtpRequest,
} from '@repo/types';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import {
  clearSessionCookieAttributes,
  readCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  sessionCookieAttributes,
  sessionCookieName,
} from '../../common/auth/session-cookie.js';
import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { TokenService } from '../../common/auth/token.service.js';
import { AuthService, type RequestOrigin } from './auth.service.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  private readonly cookieName: string;

  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly config: ConfigService,
  ) {
    this.cookieName = sessionCookieName(config);
  }

  /* -- Step 1 ------------------------------------------------------------- */

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check a password and email a one-time code',
    description:
      'Answers `two_factor_required` with a challenge, and sets no cookie: a ' +
      'correct password alone does not sign anybody in. The one exception is ' +
      'an account with `isTwoFactorEnabled` false, which answers ' +
      '`authenticated` and does set the session cookie.',
  })
  @ApiOkResponse({ description: 'A two-factor challenge to be completed.' })
  @ApiUnauthorizedResponse({ description: 'Email or password not recognised.' })
  @ApiTooManyRequestsResponse({ description: 'Too many attempts.' })
  async login(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
  ): Promise<LoginResult> {
    const outcome = await this.auth.login(body, originOf(request));

    // A cookie is set here only for an account with the second factor
    // disabled, where the password alone finished the job. For every normal
    // account `token` is absent and this response carries a challenge and
    // nothing else — which is the property that makes a stolen password
    // useless on its own.
    if (outcome.token !== undefined) {
      reply.header(
        'set-cookie',
        serializeSessionCookie(
          this.cookieName,
          outcome.token,
          sessionCookieAttributes(
            this.config,
            outcome.result.status === 'authenticated' ? outcome.result.expiresIn : 0,
          ),
        ),
      );
    }

    return outcome.result;
  }

  /* -- Step 2 ------------------------------------------------------------- */

  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a verification code for a session',
    description:
      'On success the session token is set as an httpOnly cookie. It is not ' +
      'in the response body, so page JavaScript can never read it.',
  })
  @ApiOkResponse({ description: 'The signed-in session. Cookie set.' })
  @ApiUnauthorizedResponse({ description: 'Wrong or expired code.' })
  async verifyOtp(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body(new ZodValidationPipe(verifyOtpRequestSchema)) body: VerifyOtpRequest,
  ): Promise<AuthenticatedResponse> {
    const verified = await this.auth.verifyOtp(body, originOf(request));

    // The one place a token is written. Max-Age comes from the same integer as
    // the token's `exp`, so the cookie cannot outlive what it carries.
    reply.header(
      'set-cookie',
      serializeSessionCookie(
        this.cookieName,
        verified.token,
        sessionCookieAttributes(this.config, verified.expiresIn),
      ),
    );

    return { expiresIn: verified.expiresIn, session: verified.session };
  }

  @Post('resend-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a replacement code for an open challenge' })
  @ApiOkResponse({ description: 'The challenge, with its cooldown reset.' })
  @ApiTooManyRequestsResponse({ description: 'Still inside the cooldown, or capped.' })
  resendOtp(
    @Req() request: FastifyRequest,
    @Body(new ZodValidationPipe(resendOtpRequestSchema)) body: ResendOtpRequest,
  ): Promise<TwoFactorChallenge> {
    return this.auth.resendOtp(body.challengeId, originOf(request));
  }

  /* -- Session ------------------------------------------------------------ */

  @Get('session')
  @UseGuards(SessionAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'The current session, rebuilt from the database',
    description:
      'Roles and permissions are re-resolved on every call, so revoking a ' +
      'grant takes effect on the next request rather than at token expiry.',
  })
  @ApiOkResponse({ description: 'The caller’s session.' })
  @ApiUnauthorizedResponse({ description: 'Missing, expired or invalid session.' })
  async session(@Req() request: FastifyRequest): Promise<Session> {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) {
      // Unreachable while SessionAuthGuard is attached; asserted so that
      // removing the guard fails closed rather than returning someone's
      // session shaped out of undefined.
      throw new UnauthenticatedError();
    }

    return this.auth.sessionFromAuthenticatedUser(user.userId, user.activePropertyId);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'End the session',
    description:
      'Clears the cookie and revokes every session token the account holds, ' +
      'so a copy of the token cannot be replayed for the rest of its life. ' +
      'Unguarded on purpose: signing out must work even when the token has ' +
      'already expired, and it reveals nothing — a caller with no valid ' +
      'session simply gets their cookie discarded.',
  })
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    /**
     * Revoke first, then clear.
     *
     * ===========================================================================
     * This route stays unguarded, and still revokes.
     *
     * A guard here would make sign-out fail for the one caller who most needs
     * it to succeed: somebody whose token has just expired, or was already
     * revoked, and who is left with a stale cookie the browser keeps sending.
     * They would get a 401 from the act of signing out.
     *
     * So the token is read rather than required. When it verifies, the account
     * is stamped and every session it holds dies. When it does not, there is
     * nothing to revoke and the cookie is cleared anyway — which is the whole
     * of what an unauthenticated caller can achieve here.
     *
     * A failure to revoke must not block the clear: leaving the browser
     * holding a live cookie because a write failed is strictly worse than
     * clearing it and logging the problem.
     * ===========================================================================
     */
    const token = readCookie(request.headers.cookie, this.cookieName);
    const claims = token === null ? null : this.tokens.verify(token);

    if (claims !== null) {
      try {
        await this.auth.revokeSessions(claims.sub);
      } catch (error) {
        this.logger.error(
          `Sign-out could not revoke sessions for a user; the cookie was still cleared [${request.id}]`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    // Name, path and domain must match what set the cookie or the browser
    // keeps it (see session-cookie.ts).
    reply.header(
      'set-cookie',
      serializeClearedSessionCookie(
        this.cookieName,
        clearSessionCookieAttributes(this.config),
      ),
    );
  }
}

/**
 * Where the request came from, for the "requested from" block in the code
 * email and for rate-limit keys.
 *
 * `request.ip` is Fastify's, which honours `trustProxy` as configured in
 * main.ts — so behind a load balancer this is the client address rather than
 * the balancer's. The User-Agent is truncated: it is attacker-controlled free
 * text that ends up in a database column and an email body.
 */
function originOf(request: FastifyRequest): RequestOrigin {
  const header = request.headers['user-agent'];
  const userAgent = Array.isArray(header) ? header[0] : header;

  return {
    ipAddress: request.ip.length > 0 ? request.ip : null,
    userAgent: userAgent === undefined ? null : userAgent.slice(0, 256),
    requestId: String(request.id),
  };
}
