/**
 * SMTP transport.
 *
 * Outbound mail is an external call, so it obeys CLAUDE.md section 5's rules
 * for one: explicit connection and send timeouts, bounded pooling, and a
 * failure that is reported rather than swallowed. A dead mail host must fail
 * the sign-in it belongs to and nothing else — it never takes the API down and
 * it never blocks the front desk's other work.
 *
 * Retries deliberately live *above* this class, in `AuthService`: only the
 * caller knows whether resending is safe, and blind retries here would mail an
 * operator the same code three times.
 */

import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

import type { MailDeliveryResult, Mailer, MailMessage } from './mailer.js';

/** Long enough for a slow relay, short enough that a hung host is not a hang. */
const CONNECTION_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

@Injectable()
export class SmtpMailer implements Mailer, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmtpMailer.name);
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly replyTo: string | undefined;

  readonly delivers = true;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('SMTP_HOST');
    if (host === undefined) {
      // Unreachable: the module factory only constructs this when SMTP_HOST is
      // present. Asserted anyway so a future wiring mistake fails at boot
      // rather than at the first sign-in.
      throw new Error('SmtpMailer was constructed without SMTP_HOST.');
    }

    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');

    this.from = this.config.get<string>('SMTP_FROM', 'EaseIt Security <no-reply@easeit.local>');
    this.replyTo = this.config.get<string>('SMTP_REPLY_TO');

    this.transporter = createTransport({
      host,
      port: this.config.get<number>('SMTP_PORT', 587),
      secure: this.config.get<boolean>('SMTP_SECURE', false),
      ...(user !== undefined && pass !== undefined ? { auth: { user, pass } } : {}),
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: CONNECTION_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      // One warm connection is ample at ~50 staff. Pooling matters only so a
      // shift change does not open fifty TCP sessions in a minute.
      pool: true,
      maxConnections: 2,
      maxMessages: 50,
    });
  }

  /**
   * Verifies the transport at boot rather than on the first sign-in, so bad
   * mail credentials show up in the startup log instead of as a mysterious
   * login failure at 3am. A failure here is logged, not thrown: the rest of
   * the API is perfectly usable without mail, and refusing to start would
   * take the front desk offline over a misconfigured relay.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.transporter.verify();
      this.logger.log(`SMTP transport ready (${this.config.get<string>('SMTP_HOST') ?? '?'})`);
    } catch (error) {
      this.logger.error(
        'SMTP transport failed verification. Two-factor codes will not be ' +
          'delivered until this is fixed.',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  onModuleDestroy(): void {
    this.transporter.close();
  }

  async send(message: MailMessage): Promise<MailDeliveryResult> {
    const info = await this.transporter.sendMail({
      from: this.from,
      ...(this.replyTo !== undefined ? { replyTo: this.replyTo } : {}),
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      ...(message.headers !== undefined ? { headers: message.headers } : {}),
    });

    // The recipient is not logged: an address is guest/staff PII and the
    // message id is enough to trace a delivery with the relay
    // (CLAUDE.md section 5).
    this.logger.log(`Mail accepted by relay (${info.messageId})`);

    return { messageId: info.messageId, loggedOnly: false };
  }
}
