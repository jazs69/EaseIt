import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { AuthController } from './auth.controller.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';

/**
 * The `auth` module from CLAUDE.md section 2: login, sessions, and the guard
 * every other module's authorisation hangs off.
 *
 * `TokenService` and `SessionAuthGuard` are exported rather than kept private
 * because every feature module needs the guard, and a guard cannot be resolved
 * from a module that does not provide or import it — which is precisely the DI
 * failure that `ActivePropertyGuard` hit before `PlatformModule` existed. The
 * clock, the mailer and the rate limiter arrive from the global
 * `PlatformModule`, so they are not re-provided here.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthRepository, TokenService, SessionAuthGuard],
  exports: [AuthService, TokenService, SessionAuthGuard],
})
export class AuthModule {}
