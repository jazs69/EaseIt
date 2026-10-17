/**
 * GSTIN taxpayer lookup, behind a provider strategy.
 *
 * ===========================================================================
 * Three providers, and the difference between them is never hidden.
 *
 *   * **mock** — synthetic data, so the booking form works without paid API
 *     credits. Every name it returns is suffixed so it cannot be mistaken for
 *     a real one, and the response is tagged `MOCK`. The environment schema
 *     refuses this provider in production.
 *   * **sandbox** / **cashfree** — a real registry lookup. Tagged `VERIFIED`.
 *
 * The tag is the whole point of this file. A fabricated legal name is not a
 * harmless placeholder: it is the name a tax invoice is issued in, and one
 * that reached a real invoice would be filed with the authorities, claimed
 * against, and found by an auditor rather than by us. So the provenance
 * travels with the answer, the UI renders a different badge for each, and the
 * `company` row records it permanently — because the moment the request ends,
 * mock data and verified data are otherwise indistinguishable.
 *
 * Offline validation runs first and short-circuits: a GSTIN that fails its own
 * check digit is never worth a network call, and the structure check is what
 * stops a malformed string being sent to a paid endpoint.
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GstinLookup } from '@repo/types';

import { inspectGstin } from './gstin.js';

type Provider = 'mock' | 'sandbox' | 'cashfree';

/** The half of a lookup that comes from a provider rather than from the number. */
type TaxpayerResult = Pick<
  GstinLookup,
  'provider' | 'verification' | 'companyName' | 'tradeName' | 'status' | 'address'
>;

/** Enough states to make mock data look plausible per region. */
const MOCK_CITIES: Record<string, { city: string; line: string; pincode: string }> = {
  '23': { city: 'Ujjain', line: 'Plot 14, Commercial Center', pincode: '456001' },
  '27': { city: 'Pune', line: '402 Trade Tower, Baner Road', pincode: '411045' },
  '30': { city: 'Panaji', line: '7 Miramar Circle', pincode: '403001' },
  '29': { city: 'Bengaluru', line: '21 MG Road', pincode: '560001' },
  '07': { city: 'New Delhi', line: 'Unit 9, Connaught Circus', pincode: '110001' },
  '19': { city: 'Kolkata', line: '88 Park Street', pincode: '700016' },
  '33': { city: 'Chennai', line: '5 Anna Salai', pincode: '600002' },
};

@Injectable()
export class GstService {
  private readonly logger = new Logger(GstService.name);
  private readonly provider: Provider;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.provider = config.get<Provider>('GST_PROVIDER', 'mock');
    this.apiKey = config.get<string>('GST_API_KEY');
    this.timeoutMs = config.get<number>('GST_TIMEOUT_MS', 4_000);

    if (this.provider === 'mock') {
      // Said once, loudly, at boot. A developer who forgets which provider is
      // configured should not have to read a response to find out.
      this.logger.warn(
        'GST_PROVIDER=mock — GSTIN lookups return SYNTHETIC company names. ' +
          'They are tagged MOCK and must never reach a tax invoice.',
      );
    }
  }

  async lookup(rawGstin: string): Promise<GstinLookup> {
    const inspection = inspectGstin(rawGstin);

    // Structure and checksum first, always. A number that fails its own check
    // digit is a typo, and sending it to a metered endpoint spends money to be
    // told so.
    if (!inspection.isValid) {
      return {
        success: false,
        gstin: inspection.gstin,
        isValid: false,
        reason: inspection.reason,
        stateCode: inspection.stateCode,
        stateName: inspection.stateName,
        pan: inspection.pan,
        provider: 'none',
        verification: 'UNVERIFIED',
        companyName: null,
        tradeName: null,
        status: null,
        address: null,
      };
    }

    const base = {
      success: true,
      gstin: inspection.gstin,
      isValid: true,
      reason: null,
      stateCode: inspection.stateCode,
      stateName: inspection.stateName,
      pan: inspection.pan,
    } as const;

    if (this.provider === 'mock') {
      return { ...base, ...this.mockTaxpayer(inspection.gstin, inspection.stateName) };
    }

    try {
      return { ...base, ...(await this.liveTaxpayer(inspection.gstin)) };
    } catch (error) {
      // A provider outage must not block a booking. The number is still known
      // to be well-formed, so the operator types the name — which is exactly
      // the UNVERIFIED path that existed before any provider did.
      this.logger.warn(
        `GSTIN lookup via ${this.provider} failed for ${inspection.gstin}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return {
        ...base,
        provider: this.provider,
        verification: 'UNVERIFIED',
        companyName: null,
        tradeName: null,
        status: null,
        address: null,
        reason: 'The verification service is unavailable. Enter the legal name manually.',
      };
    }
  }

  /* -------------------------------------------------------------------- */

  /**
   * Synthetic taxpayer data for local development.
   *
   * The name carries an explicit `(MOCK DATA)` suffix. That is deliberate and
   * should not be tidied away: it is the last line of defence if the
   * `verification` tag is ever dropped somewhere downstream, and it makes a
   * screenshot of fabricated data self-evidently fabricated.
   *
   * Derived from the GSTIN's own state digits so the address is at least
   * regionally coherent with the number, which is what makes the form worth
   * testing against.
   */
  private mockTaxpayer(gstin: string, stateName: string | null): TaxpayerResult {
    const stateCode = gstin.slice(0, 2);
    const place = MOCK_CITIES[stateCode] ?? {
      city: 'Unknown City',
      line: '1 Industrial Estate',
      pincode: '000000',
    };

    // Stable per GSTIN rather than random: the same number looked up twice
    // gives the same answer, so a developer is not chasing a changing name.
    const seed = gstin.charCodeAt(2) + gstin.charCodeAt(7);
    const names = ['Sample Enterprises', 'Meridian Traders', 'Umbrella Logistics', 'Northwind Supplies'];
    const stem = names[seed % names.length] ?? 'Sample Enterprises';

    return {
      provider: 'mock',
      verification: 'MOCK',
      companyName: `${stem} Private Limited (MOCK DATA)`,
      tradeName: `${stem} (MOCK DATA)`,
      status: 'Active',
      address: {
        addressLine1: place.line,
        city: place.city,
        state: stateName,
        pincode: place.pincode,
        fullAddress: `${place.line}, ${place.city}, ${stateName ?? ''} - ${place.pincode}`,
      },
    };
  }

  /**
   * A real registry lookup.
   *
   * Written against the GSTN field names both providers surface — `lgnm` for
   * legal name, `tradeNam` for trading name, `pradr.addr` for the principal
   * place of business, `sts` for status. Those are the registry's own keys,
   * not a provider's invention, which is why one mapping serves both.
   *
   * Not exercised in this deployment: there are no credentials, so the
   * environment schema will have refused any provider but `mock`. The shape is
   * here so switching one on is a configuration change.
   */
  private async liveTaxpayer(gstin: string): Promise<TaxpayerResult> {
    const endpoint =
      this.provider === 'sandbox'
        ? `https://api.sandbox.co.in/gst/compliance/public/gstin/search?gstin=${encodeURIComponent(gstin)}`
        : `https://api.cashfree.com/verification/gstin?GSTIN=${encodeURIComponent(gstin)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          // Both providers take a key header; the exact name differs.
          ...(this.provider === 'sandbox'
            ? { 'x-api-key': this.apiKey ?? '' }
            : { 'x-client-id': this.apiKey ?? '' }),
        },
      });

      if (!response.ok) {
        throw new Error(`provider returned ${String(response.status)}`);
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const data = (payload['data'] ?? payload) as Record<string, unknown>;
      const principal = (data['pradr'] ?? {}) as Record<string, unknown>;
      const addr = (principal['addr'] ?? {}) as Record<string, unknown>;

      const asText = (value: unknown): string | null =>
        typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

      const line = [asText(addr['bno']), asText(addr['st']), asText(addr['loc'])]
        .filter((part): part is string => part !== null)
        .join(', ');
      const city = asText(addr['dst']);
      const state = asText(addr['stcd']);
      const pincode = asText(addr['pncd']);

      return {
        provider: this.provider,
        verification: 'VERIFIED',
        companyName: asText(data['lgnm']),
        tradeName: asText(data['tradeNam']),
        status: asText(data['sts']),
        address: {
          addressLine1: line === '' ? null : line,
          city,
          state,
          pincode,
          fullAddress: [line, city, state, pincode]
            .filter((part): part is string => part !== null && part !== '')
            .join(', '),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
