/**
 * Development mail transport: writes the message to the API log instead of
 * sending it.
 *
 * ===========================================================================
 * This exists so a developer with no SMTP credentials can still run the whole
 * two-factor sign-in flow: the code appears in the terminal running
 * `pnpm dev --filter=api`, and they paste it into the browser.
 *
 * Two things keep that from being a security hole:
 *
 *   1. The code goes to the **server's** log. It is never put in an HTTP
 *      response, so no browser and no network observer can read it. The
 *      sign-in screen is told only that the fallback is active, so it can say
 *      "check the API console" instead of "check your inbox".
 *   2. `validateEnv` refuses to boot in production without `SMTP_HOST`, so
 *      this transport cannot be the one running there.
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';

import type { MailDeliveryResult, Mailer, MailMessage } from './mailer.js';

@Injectable()
export class LogMailer implements Mailer {
  private readonly logger = new Logger('Mailer');

  readonly delivers = false;

  send(message: MailMessage): Promise<MailDeliveryResult> {
    const messageId = `log-${globalThis.crypto.randomUUID()}`;

    this.logger.warn(
      [
        '',
        '  ┌──────────────────────────────────────────────────────────────────',
        '  │ NO SMTP TRANSPORT CONFIGURED — message logged, not sent.',
        `  │ To:      ${message.to}`,
        `  │ Subject: ${message.subject}`,
        '  ├──────────────────────────────────────────────────────────────────',
        ...message.text
          .trim()
          .split('\n')
          .map((line) => `  │ ${line}`),
        '  └──────────────────────────────────────────────────────────────────',
        '  Set SMTP_HOST (and SMTP_USER / SMTP_PASS) to deliver for real.',
        '',
      ].join('\n'),
    );

    return Promise.resolve({ messageId, loggedOnly: true });
  }
}
