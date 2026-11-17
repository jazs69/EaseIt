/**
 * Runs each handler inside its request's trace (OB-05), so log lines and
 * outbound calls made while handling it carry the trace id. The ids are
 * decided in the `onRequest` hook (main.ts), which cannot bind an
 * AsyncLocalStorage across Fastify's hook chain; an interceptor wraps the
 * handler instead, like the tenant-scope interceptor.
 */

import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';

import { runInTrace, type TraceContext } from './trace.js';

export const TRACE_KEY = 'easeitTrace';

@Injectable()
export class TraceInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const trace = request[TRACE_KEY] as TraceContext | undefined;
    if (trace === undefined) return next.handle();
    return new Observable((subscriber) =>
      runInTrace(trace, () => {
        const subscription = next.handle().subscribe(subscriber);
        return () => {
          subscription.unsubscribe();
        };
      }),
    );
  }
}
