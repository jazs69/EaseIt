/**
 * `fetch` for third-party calls (OB-05): adds a child `traceparent` when the
 * call is made inside a traced request, and records the call's outcome and
 * duration as `easeit_external_calls_total` / `..._duration_seconds`.
 *
 * Only the provider name and the outcome class are recorded: never a URL
 * (which may carry an id), a body or a header.
 */

import { outboundTraceparent } from './trace.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ExternalCallRecorder {
  recordExternal(provider: string, outcome: string, seconds: number): void;
}

export function tracedFetch(
  provider: string,
  recorder: ExternalCallRecorder | null,
  base: FetchLike = (input, init) => fetch(input, init),
): FetchLike {
  return async (input, init) => {
    const traceparent = outboundTraceparent();
    const headers =
      traceparent === null
        ? init.headers
        : { ...(init.headers as Record<string, string>), traceparent };
    const started = performance.now();
    try {
      const response = await base(input, {
        ...init,
        ...(headers === undefined ? {} : { headers }),
      });
      const outcome = response.ok ? 'ok' : response.status >= 500 ? 'http_5xx' : 'http_4xx';
      recorder?.recordExternal(provider, outcome, (performance.now() - started) / 1_000);
      return response;
    } catch (error) {
      recorder?.recordExternal(provider, 'error', (performance.now() - started) / 1_000);
      throw error;
    }
  };
}
