/**
 * Operator alerts (OB-06, WK-11): the shape of one, and the sink boundary.
 *
 * ===========================================================================
 * An alert is for a human who is not watching the log.
 *
 * CLAUDE.md section 5: "A job that fails permanently must alert, not vanish."
 * Before this, a dead letter was an `error` log line and nothing else. A sink
 * is something outside this process that a person actually reads -- an
 * incoming webhook (Slack, Teams, PagerDuty's generic events, any HTTP
 * receiver) or an email to the operations mailbox.
 *
 * Depended on as an interface token, like the mailer, because a sink is
 * exactly the boundary a test must fake (section 5: channel adapters, payment
 * gateways, clock, mailer -- and now alert sinks).
 *
 * WHAT AN ALERT MAY CARRY. Identifiers, counts, event types, property codes
 * and the outbox's own `lastError`, which is already scrubbed and truncated at
 * write time. Never a payload, a guest name, an email address or card data:
 * an alert leaves the system, often into a chat tool with its own retention.
 * ===========================================================================
 */

export type AlertKind = 'OUTBOX_DEAD_LETTER' | 'OUTBOX_STALE_LEASE' | 'API_ERRORS';

export interface Alert {
  kind: AlertKind;
  /** One line a person can act on. */
  summary: string;
  /** Supporting lines, each self-contained. */
  details: readonly string[];
  /** ISO-8601 instant the alert was raised. */
  raisedAt: string;
}

export interface AlertSink {
  /** For logs only: `webhook`, `email`. */
  readonly name: string;
  /** Resolves once the receiver accepted it; throws otherwise. Bounded by a timeout. */
  send(alert: Alert): Promise<void>;
}

/** DI token for the configured sinks. Empty in development when none is set. */
export const ALERT_SINKS = Symbol('EASEIT_ALERT_SINKS');

/** The plain-text form shared by every sink, so a webhook and an email say the same thing. */
export function renderAlert(alert: Alert): string {
  return [
    `[EaseIt] ${alert.summary}`,
    ...alert.details.map((line) => `- ${line}`),
    `Raised ${alert.raisedAt}`,
  ].join('\n');
}
