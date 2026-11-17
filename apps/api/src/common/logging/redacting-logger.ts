/**
 * The application logger (SE-02, OB-05): Nest's console logger, with every
 * message and stack redacted (`redactText`) and the current trace id added.
 *
 * Installed with `app.useLogger(...)` in both entry points (`main.ts`,
 * `worker.ts`), so every `new Logger(...)` in the codebase writes through it.
 * Redaction happens here, at the one place lines are written, rather than at
 * each call site: a call site cannot see personal data that arrives inside an
 * error message it did not write.
 */

import { ConsoleLogger, type LogLevel } from '@nestjs/common';

import { currentTrace } from '../observability/trace.js';
import { redactValue, redactText } from './redact.js';

export class RedactingLogger extends ConsoleLogger {
  protected override printMessages(
    messages: unknown[],
    context?: string,
    logLevel?: LogLevel,
    writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
  ): void {
    const trace = currentTrace();
    const redacted = messages.map((message) => {
      const clean = redactValue(message);
      return trace !== null && typeof clean === 'string'
        ? `${clean} [trace ${trace.traceId}]`
        : clean;
    });
    super.printMessages(
      redacted,
      context,
      logLevel,
      writeStreamType,
      typeof errorStack === 'string' ? redactText(errorStack) : errorStack,
    );
  }

  protected override printStackTrace(stack: string): void {
    super.printStackTrace(redactText(stack));
  }
}
