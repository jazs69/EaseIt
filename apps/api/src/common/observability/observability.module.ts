/**
 * Metrics, trace propagation and error reporting (OB-05). Global, so any
 * service can record an external call or reach the error reporter without a
 * module import; the alert sinks come from the alerting module (OB-06).
 */

import { Global, Module } from '@nestjs/common';

import { AlertingModule } from '../../modules/platform/alerting/alerting.module.js';
import { ErrorReporter } from './error-reporter.service.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';

@Global()
@Module({
  imports: [AlertingModule],
  controllers: [MetricsController],
  providers: [MetricsService, ErrorReporter],
  exports: [MetricsService, ErrorReporter],
})
export class ObservabilityModule {}
