/**
 * Sandbox.co.in (Quicko) "Search GSTIN" (GP-04).
 *
 * Per developer.sandbox.co.in (read 2026-11-17):
 *   1. `POST {host}/authenticate` with `x-api-key` and `x-api-secret` returns
 *      `data.access_token`, valid 24 hours, sent WITHOUT "Bearer".
 *   2. `POST {host}/gst/compliance/public/gstin/search` with body
 *      `{ "gstin": ... }` and headers `authorization` (the token),
 *      `x-api-key`, `x-api-version`.
 *   3. Found: the taxpayer is at `data.data` (`lgnm`, `tradeNam`, `sts`,
 *      `pradr.addr.{bno,bnm,flno,st,loc,dst,stcd,pncd}`), `data.status_cd`
 *      "1". Not found: HTTP 200 with `data.status_cd` "0" and
 *      `data.error.error_cd` (e.g. FO8000 "No records found").
 *
 * Hosts: `test-api.sandbox.co.in` (test) and `api.sandbox.co.in` (live).
 * The token is cached in memory and refreshed once on a 401/403.
 */

import {
  asRecord,
  asText,
  buildAddress,
  errorForResponse,
  GstProviderError,
  networkError,
  type FetchLike,
  type GstProvider,
  type TaxpayerOutcome,
} from './provider.js';

const TOKEN_LIFETIME_MS = 23 * 60 * 60 * 1_000; // documented 24 h, renewed early

/** Pure mapping of a search response body. Exported for tests. */
export function mapSandboxSearch(body: unknown): TaxpayerOutcome {
  const outer = asRecord(asRecord(body)['data']);
  const statusCd = asText(outer['status_cd']);
  const record = asRecord(outer['data']);
  if (statusCd === '0' || outer['error'] !== undefined || Object.keys(record).length === 0) {
    return { kind: 'not_found' };
  }
  const addr = asRecord(asRecord(record['pradr'])['addr']);
  return {
    kind: 'found',
    taxpayer: {
      legalName: asText(record['lgnm']),
      tradeName: asText(record['tradeNam']),
      status: asText(record['sts']),
      address: buildAddress({
        line: [
          asText(addr['flno']),
          asText(addr['bno']),
          asText(addr['bnm']),
          asText(addr['st']),
          asText(addr['loc']),
        ],
        city: asText(addr['dst']),
        state: asText(addr['stcd']),
        pincode: asText(addr['pncd']),
      }),
    },
  };
}

export class SandboxGstProvider implements GstProvider {
  readonly name = 'sandbox' as const;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly now: () => number,
  ) {}

  async lookup(gstin: string, signal: AbortSignal): Promise<TaxpayerOutcome> {
    let response = await this.search(gstin, await this.accessToken(signal, false), signal);
    if (response.status === 401 || response.status === 403) {
      // An expired or revoked token: one fresh token, one more try.
      response = await this.search(gstin, await this.accessToken(signal, true), signal);
    }
    if (!response.ok) throw await errorForResponse('sandbox', response);
    return mapSandboxSearch(await this.json(response));
  }

  private async search(gstin: string, token: string, signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}/gst/compliance/public/gstin/search`, {
        method: 'POST',
        signal,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: token,
          'x-api-key': this.apiKey,
          'x-api-version': '1.0.0',
        },
        body: JSON.stringify({ gstin }),
      });
    } catch (cause) {
      throw networkError('sandbox', cause);
    }
  }

  private async accessToken(signal: AbortSignal, forceRefresh: boolean): Promise<string> {
    if (!forceRefresh && this.token !== null && this.token.expiresAt > this.now()) {
      return this.token.value;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/authenticate`, {
        method: 'POST',
        signal,
        headers: {
          accept: 'application/json',
          'x-api-key': this.apiKey,
          'x-api-secret': this.apiSecret,
          'x-api-version': '1.0',
        },
      });
    } catch (cause) {
      throw networkError('sandbox', cause);
    }
    if (!response.ok) {
      this.token = null;
      throw await errorForResponse('sandbox authenticate', response);
    }
    const value = asText(asRecord(asRecord(await this.json(response))['data'])['access_token']);
    if (value === null) {
      throw new GstProviderError('sandbox authenticate returned no access token', false);
    }
    this.token = { value, expiresAt: this.now() + TOKEN_LIFETIME_MS };
    return value;
  }

  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new GstProviderError('sandbox returned a body that is not JSON', true, response.status);
    }
  }
}
