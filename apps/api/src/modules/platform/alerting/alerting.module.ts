/**
 * Operator alerting (OB-06, WK-11), wired.
 *
 * The sinks are chosen once, at boot, from configuration. The monitor is
 * provided to both processes but only the worker starts it, the same split
 * the outbox dispatcher uses: three API replicas must not mean three alert
 * scanners nobody asked for.
 */

import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MAILER, type Mailer } from '../mail/mailer.js';
import { ALERT_SINKS, type AlertSink } from './alert.js';
import { AlertMonitorService } from './alert-monitor.service.js';
import { EmailAlertSink } from './email-alert.sink.js';
import { WebhookAlertSink } from './webhook-alert.sink.js';

const sinksProvider: Provider = {
  provide: ALERT_SINKS,
  inject: [ConfigService, MAILER],
  useFactory: (config: ConfigService, mailer: Mailer): AlertSink[] => {
    const sinks: AlertSink[] = [];
    const webhook = config.get<string>('ALERT_WEBHOOK_URL');
    if (webhook !== undefined) {
      sinks.push(new WebhookAlertSink(webhook, config.get<number>('ALERT_TIMEOUT_MS', 10_000)));
    }
    const emails = config.get<string[]>('ALERT_EMAIL_TO');
    if (emails !== undefined && emails.length > 0) sinks.push(new EmailAlertSink(mailer, emails));
    return sinks;
  },
};

@Module({
  providers: [sinksProvider, AlertMonitorService],
  exports: [AlertMonitorService, ALERT_SINKS],
})
export class AlertingModule {}
