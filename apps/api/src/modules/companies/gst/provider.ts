/**
 * The boundary every GST registry provider implements (GP-04).
 *
 * ===========================================================================
 * A provider adapter is mapping only (CLAUDE.md section 5, channel adapters
 * by analogy): it turns one GSTIN into the provider's request and the
 * provider's response into a `Taxpayer`, or says the registry has no such
 * taxpayer. Timeouts, retries, the circuit breaker, caching and the
 * provenance tag all live in `GstService`, so they cannot drift between
 * providers.
 *
 * "Not found" is an answer, not a failure: both providers return HTTP 200
 * for it, and it must not trip the breaker or be retried.
 * ===========================================================================
 */

export interface TaxpayerAddress {
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  fullAddress: string;
}

export interface Taxpayer {
  legalName: string | null;
  tradeName: string | null;
  /** Registry status as the provider reports it, e.g. `Active`, `Cancelled`. */
  status: string | null;
  address: TaxpayerAddress | null;
}

export type TaxpayerOutcome = { kind: 'found'; taxpayer: Taxpayer } | { kind: 'not_found' };

export interface GstProvider {
  readonly name: 'sandbox' | 'cashfree';
  lookup(gstin: string, signal: AbortSignal): Promise<TaxpayerOutcome>;
}

/**
 * A provider call that failed. `retryable` is true only for what a second
 * attempt can plausibly fix: network errors, timeouts, 429 and 5xx. A 4xx
 * (bad credentials, no credit, refused input) is permanent for this request.
 */
export class GstProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'GstProviderError';
  }
}

/** The fetch this module calls: injectable so tests never touch the network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Classifies a non-2xx response. Carries the provider's own short `message`
 * when it sent one (e.g. Sandbox's "Use test API key for test environment"),
 * because that is what tells an operator what to fix. Only that field, cut
 * to 160 characters, and never the request: no key or secret can reach it.
 */
export async function errorForResponse(
  provider: string,
  response: Response,
): Promise<GstProviderError> {
  let message: string | null = null;
  try {
    const record = asRecord(await response.json());
    message = asText(record['message']) ?? asText(asRecord(record['error'])['message']);
  } catch {
    // Not JSON: the status alone is all there is.
  }
  const status = response.status;
  return new GstProviderError(
    `${provider} returned HTTP ${String(status)}${message === null ? '' : `: ${message.slice(0, 160)}`}`,
    status === 429 || status >= 500,
    status,
  );
}

/** A thrown fetch (network, DNS, abort) is retryable; the caller's deadline still bounds it. */
export function networkError(provider: string, cause: unknown): GstProviderError {
  const detail = cause instanceof Error ? cause.name : 'unknown';
  return new GstProviderError(`${provider} request failed (${detail})`, true);
}

export function buildAddress(parts: {
  line: (string | null)[];
  city: string | null;
  state: string | null;
  pincode: string | null;
}): TaxpayerAddress | null {
  const line = parts.line.filter((part): part is string => part !== null).join(', ');
  const fullAddress = [line, parts.city, parts.state, parts.pincode]
    .filter((part): part is string => part !== null && part !== '')
    .join(', ');
  if (fullAddress === '') return null;
  return {
    addressLine1: line === '' ? null : line,
    city: parts.city,
    state: parts.state,
    pincode: parts.pincode,
    fullAddress,
  };
}
