/**
 * The outbound mail boundary (the `platform` module in CLAUDE.md section 2).
 *
 * Depended on as an interface token rather than a concrete class, because this
 * is exactly the boundary CLAUDE.md section 5 says must be fakeable: an
 * integration test for the sign-in flow has to assert that a code was sent and
 * read what was in it, without an SMTP server anywhere near the test run.
 */

export interface MailMessage {
  to: string;
  subject: string;
  /** Required. Every message has a text part, for clients that refuse HTML. */
  text: string;
  html: string;
  /**
   * RFC 5322 headers that make a security notice behave correctly in a mail
   * client: `Auto-Submitted` stops vacation responders replying to it, and
   * `X-Entity-Ref-ID` stops Gmail collapsing successive codes into one thread.
   */
  headers?: Record<string, string>;
}

export interface MailDeliveryResult {
  /** Transport-assigned id, where there is one. Logged, never shown to a user. */
  messageId: string;
  /**
   * True when the message was written to the API log instead of being sent,
   * because no SMTP transport is configured. Development only — the API
   * refuses to boot in production without one.
   */
  loggedOnly: boolean;
}

export interface Mailer {
  send(message: MailMessage): Promise<MailDeliveryResult>;
  /** False when this transport only logs. Surfaced to the sign-in screen. */
  readonly delivers: boolean;
}

/**
 * DI token. A string-keyed token rather than the interface (interfaces do not
 * exist at runtime) and rather than a concrete class (which would defeat the
 * point of the boundary).
 */
export const MAILER = Symbol('EASEIT_MAILER');
