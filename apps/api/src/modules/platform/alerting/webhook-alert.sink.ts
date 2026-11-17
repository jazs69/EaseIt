/**
 * Posts an alert as JSON to an incoming webhook.
 *
 * The body carries `text` -- what Slack, Mattermost, Teams workflows and most
 * chat webhooks render as-is -- plus the structured `alert` for receivers that
 * route on `kind`. Any 2xx is acceptance; anything else, a network error or
 * the timeout is a failure, and the monitor tries again on its next pass.
 *
 * Bounded by an explicit timeout (CLAUDE.md section 5: every external call).
 * No retry loop in here: retrying is the monitor's job, at its own interval,
 * which is also what stops a dead receiver being hammered.
 */

import type { Alert, AlertSink } from './alert.js';
import { renderAlert } from './alert.js';

export class WebhookAlertSink implements AlertSink {
  readonly name = 'webhook';

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
  ) {}

  async send(alert: Alert): Promise<void> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: renderAlert(alert), alert }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // Drain the body so the connection is released; its content is not read
    // into any log, since a receiver's error page is not ours to repeat.
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) {
      throw new Error(`webhook answered HTTP ${String(response.status)}`);
    }
  }
}
