/**
 * The application logger (SE-02, OB-05): Nest's console logger, with every
 * message and stack redacted (`redactText`) and the current trace id added.
 *
 * Installed with `app.useLogger(...)` in both entry points (`main.ts`,
 * `worker.ts`), so every `new Logger(...)` in the codebase writes through it.
 * Redaction happens here, at the one place lines are written, rather than at
 * each call site: a call site cannot see personal data that arrives inside an
 * error message it did not write.
 *
 * A logger must never fail its caller. Nest passes `undefined` stacks and
 * non-string messages through these hooks, and an exception here once turned
 * a logged warning into a 500 (found by the payment-links suite). So only
 * strings are redacted, and if redaction itself throws, the line is withheld
 * with a marker rather than written unredacted or thrown.
 */

import { ConsoleLogger, type LogLevel } from '@nestjs/common';

import { currentTrace } from '../observability/trace.js';
import { redactValue, redactText } from './redact.js';

const WITHHELD = '[log line withheld: redaction failed]';

function safeText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return redactText(value);
  } catch {
    return WITHHELD;
  }
}

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
      let clean: unknown;
      try {
        clean = redactValue(message);
      } catch {
        clean = WITHHELD;
      }
      return trace !== null && typeof clean === 'string'
        ? `${clean} [trace ${trace.traceId}]`
        : clean;
    });
    super.printMessages(redacted, context, logLevel, writeStreamType, safeText(errorStack));
  }

  protected override printStackTrace(stack: string): void {
    // Nest calls this with `undefined` when `error()` was given no stack.
    super.printStackTrace(safeText(stack) as string);
  }
}
