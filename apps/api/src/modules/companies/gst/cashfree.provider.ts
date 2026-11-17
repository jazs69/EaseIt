/**
 * Cashfree Secure ID "Verify GSTIN" v2 (GP-04).
 *
 * Per cashfree.com/docs/api-reference/vrs/v2/gstin/verify-gstin (read
 * 2026-11-17):
 *   `POST {host}/verification/gstin` with JSON `{ "GSTIN": ... }` and headers
 *   `x-client-id`, `x-client-secret`, `x-api-version` (documented example
 *   2022-09-13). Found: `valid: true` with `legal_name_of_business`,
 *   `trade_name_of_business`, `gst_in_status`, `principal_place_split_address`
 *   `{flat_number, building_number, building_name, street, location, district,
 *   city, state, pincode}`. Not found: HTTP 200 with message "GSTIN Doesn't
 *   Exist" and no `valid: true`.
 *
 * Hosts: `sandbox.cashfree.com` (test) and `api.cashfree.com` (live). The
 * optional `x-cf-signature` is not sent: this deployment authorises by IP
 * whitelist, the documented alternative.
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

/** Pure mapping of a response body. Exported for tests. */
export function mapCashfreeGstin(body: unknown): TaxpayerOutcome {
  const record = asRecord(body);
  if (record['valid'] !== true) return { kind: 'not_found' };
  const split = asRecord(record['principal_place_split_address']);
  const city = asText(split['city']) ?? asText(split['district']);
  const address =
    buildAddress({
      line: [
        asText(split['flat_number']),
        asText(split['building_number']),
        asText(split['building_name']),
        asText(split['street']),
        asText(split['location']),
      ],
      city,
      state: asText(split['state']),
      pincode: asText(split['pincode']),
    }) ??
    // No split address: fall back to the one-line form, unparsed.
    (asText(record['principal_place_address']) === null
      ? null
      : {
          addressLine1: asText(record['principal_place_address']),
          city: null,
          state: null,
          pincode: null,
          fullAddress: asText(record['principal_place_address']) ?? '',
        });
  return {
    kind: 'found',
    taxpayer: {
      legalName: asText(record['legal_name_of_business']),
      tradeName: asText(record['trade_name_of_business']),
      status: asText(record['gst_in_status']),
      address,
    },
  };
}

export class CashfreeGstProvider implements GstProvider {
  readonly name = 'cashfree' as const;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  async lookup(gstin: string, signal: AbortSignal): Promise<TaxpayerOutcome> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/verification/gstin`, {
        method: 'POST',
        signal,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-client-id': this.clientId,
          'x-client-secret': this.clientSecret,
          'x-api-version': '2022-09-13',
        },
        body: JSON.stringify({ GSTIN: gstin }),
      });
    } catch (cause) {
      throw networkError('cashfree', cause);
    }
    if (!response.ok) throw await errorForResponse('cashfree', response);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GstProviderError(
        'cashfree returned a body that is not JSON',
        true,
        response.status,
      );
    }
    return mapCashfreeGstin(body);
  }
}
