/**
 * Test mail transport: writes each message to a JSON file instead of sending it.
 *
 * ===========================================================================
 * The account-lifecycle suites have to follow the link a reset or invitation
 * email carries, and the token in it exists nowhere else -- only its hash is
 * stored. So a test API runs with MAIL_CAPTURE_DIR set, and each message
 * lands as `<dir>/<timestamp>-<id>.json` for the suite to read.
 *
 * Refused in production by `validateEnv`, so it can only ever be a
 * development or test transport. It never opens a network connection.
 * ===========================================================================
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MailDeliveryResult, Mailer, MailMessage } from './mailer.js';

export class CaptureMailer implements Mailer {
  readonly delivers = false;

  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }

  send(message: MailMessage): Promise<MailDeliveryResult> {
    const messageId = `capture-${globalThis.crypto.randomUUID()}`;
    const file = join(this.directory, `${String(Date.now())}-${messageId}.json`);
    writeFileSync(file, JSON.stringify({ messageId, to: message.to, subject: message.subject, text: message.text }));
    return Promise.resolve({ messageId, loggedOnly: true });
  }
}
