/**
 * Emails an alert to the operations mailbox through the platform mailer.
 *
 * Production already requires an SMTP transport (sign-in codes are emailed),
 * so an alert address is the cheapest sink to configure and the one the
 * deployment insists on. The mailer's own connection and send timeouts bound
 * the call.
 */

import type { Mailer } from '../mail/mailer.js';
import type { Alert, AlertSink } from './alert.js';
import { renderAlert } from './alert.js';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class EmailAlertSink implements AlertSink {
  readonly name = 'email';

  constructor(
    private readonly mailer: Mailer,
    private readonly recipients: readonly string[],
  ) {}

  async send(alert: Alert): Promise<void> {
    const text = renderAlert(alert);
    for (const to of this.recipients) {
      await this.mailer.send({
        to,
        subject: `[EaseIt alert] ${alert.summary}`,
        text,
        html: `<pre style="font-family:monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
        headers: { 'Auto-Submitted': 'auto-generated', 'X-EaseIt-Alert': alert.kind },
      });
    }
  }
}
