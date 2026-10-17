import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PropertyContextService } from '../../common/context/property-context.service.js';
import { ClockService } from './clock.service.js';
import { LogMailer } from './mail/log.mailer.js';
import { MAILER, type Mailer } from './mail/mailer.js';
import { SmtpMailer } from './mail/smtp.mailer.js';
import { RateLimiterService } from './rate-limiter.service.js';

/**
 * Cross-cutting infrastructure, per the `platform` module in CLAUDE.md
 * section 2: request context, the clock, outbound mail and request throttling
 * today; the audit log, outbox and job queues as they land.
 *
 * Global because these are needed by guards and repositories in every feature
 * module, and threading an import through all of them would be noise. Same
 * justification as PrismaModule: infrastructure providers with no domain
 * behaviour.
 */

/**
 * Picks the mail transport from configuration, once, at boot.
 *
 * Deciding here rather than inside a single mailer that branches per send
 * keeps the choice visible in the startup log and keeps SMTP wiring out of
 * the code path that runs when there is no SMTP. `validateEnv` has already
 * refused to boot a production process without `SMTP_HOST`, so the logging
 * branch is reachable in development and test only.
 */
const mailerProvider: Provider = {
  provide: MAILER,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Mailer =>
    config.get<string>('SMTP_HOST') === undefined ? new LogMailer() : new SmtpMailer(config),
};

@Global()
@Module({
  providers: [
    PropertyContextService,
    ClockService,
    RateLimiterService,
    mailerProvider,
  ],
  exports: [PropertyContextService, ClockService, RateLimiterService, MAILER],
})
export class PlatformModule {}
