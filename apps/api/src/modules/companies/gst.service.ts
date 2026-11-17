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
 *   * **sandbox** / **cashfree** — a real registry lookup through
 *     `gst/sandbox.provider.ts` or `gst/cashfree.provider.ts`. Tagged
 *     `VERIFIED` only against the provider's LIVE host (`GST_ENVIRONMENT=live`).
 *     Against its test host the answers are the provider's canned test data,
 *     so they are tagged `MOCK` and suffixed like mock data: a test-host
 *     name on a tax invoice is as fabricated as ours. Production refuses
 *     `GST_ENVIRONMENT=test` (env schema).
 *
 * Every live call goes through `ResilientGstLookup`: a per-attempt timeout,
 * at most two attempts for a retryable failure, a circuit breaker, and a
 * small cache so the form's lookup and the save's re-check cost one call.
 * A provider that is down or refusing degrades to UNVERIFIED (the operator
 * types the name); it never blocks a booking.
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

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GstinLookup } from '@repo/types';

import { MetricsService } from '../../common/observability/metrics.service.js';
import { tracedFetch } from '../../common/observability/traced-fetch.js';
import { ClockService } from '../platform/clock.service.js';
import { CashfreeGstProvider } from './gst/cashfree.provider.js';
import type { FetchLike, GstProvider, Taxpayer } from './gst/provider.js';
import { ResilientGstLookup } from './gst/resilient-lookup.js';
import { SandboxGstProvider } from './gst/sandbox.provider.js';
import { inspectGstin } from './gstin.js';

type Provider = 'mock' | 'sandbox' | 'cashfree';
type GstEnvironment = 'test' | 'live';

/** Documented hosts. `GST_BASE_URL` overrides them outside production only. */
const HOSTS: Record<'sandbox' | 'cashfree', Record<GstEnvironment, string>> = {
  sandbox: { test: 'https://test-api.sandbox.co.in', live: 'https://api.sandbox.co.in' },
  cashfree: { test: 'https://sandbox.cashfree.com', live: 'https://api.cashfree.com' },
};

const TEST_DATA_SUFFIX = ' (PROVIDER TEST DATA)';

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
  private readonly environment: GstEnvironment;
  private readonly live: ResilientGstLookup | null;

  constructor(
    config: ConfigService,
    clock: ClockService,
    @Optional() private readonly metrics: MetricsService | null = null,
  ) {
    this.provider = config.get<Provider>('GST_PROVIDER', 'mock');
    this.environment = config.get<GstEnvironment>('GST_ENVIRONMENT', 'test');
    this.live =
      this.provider === 'mock'
        ? null
        : new ResilientGstLookup(this.buildProvider(config, clock), {
            timeoutMs: config.get<number>('GST_TIMEOUT_MS', 4_000),
            maxAttempts: 2,
            failureThreshold: 5,
            openMs: 60_000,
            cacheTtlMs: 60 * 60 * 1_000,
            cacheSize: 500,
            now: () => clock.now().getTime(),
            sleep: (ms) =>
              new Promise((resolve) => {
                setTimeout(resolve, ms);
              }),
          });

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

    const live = this.live;
    if (live === null) throw new Error('unreachable: a live provider is configured');
    const outcome = await live.lookup(inspection.gstin);
    const provider = this.provider;
    const unverified = {
      ...base,
      provider,
      verification: 'UNVERIFIED' as const,
      companyName: null,
      tradeName: null,
      status: null,
      address: null,
    };

    if (outcome.kind === 'unavailable') {
      // A provider outage must not block a booking. The number is still known
      // to be well-formed, so the operator types the name — which is exactly
      // the UNVERIFIED path that existed before any provider did. The GSTIN
      // is a business identifier, not guest PII; the provider's body is never
      // logged.
      this.logger.warn(
        `GSTIN lookup via ${provider} unavailable for ${inspection.gstin}: ${outcome.detail}`,
      );
      return {
        ...unverified,
        reason:
          outcome.reason === 'circuit_open'
            ? 'The verification service is failing and has been paused for a minute. Enter the legal name manually.'
            : 'The verification service is unavailable. Enter the legal name manually.',
      };
    }

    if (outcome.kind === 'not_found') {
      return {
        ...unverified,
        reason:
          'The GST registry has no taxpayer under this number. Check it with the guest; ' +
          'it is well-formed, so you can still enter the legal name yourself.',
      };
    }

    return { ...base, ...this.fromTaxpayer(outcome.taxpayer) };
  }

  /** Taxpayer -> response fields, tagged by which host answered. */
  private fromTaxpayer(taxpayer: Taxpayer): TaxpayerResult {
    const isTest = this.environment === 'test';
    const mark = (value: string | null) =>
      value === null || !isTest ? value : `${value}${TEST_DATA_SUFFIX}`;
    return {
      provider: this.provider,
      verification: isTest ? 'MOCK' : 'VERIFIED',
      companyName: mark(taxpayer.legalName),
      tradeName: mark(taxpayer.tradeName),
      status: taxpayer.status,
      address: taxpayer.address,
    };
  }

  private buildProvider(config: ConfigService, clock: ClockService): GstProvider {
    const key = config.get<string>('GST_API_KEY') ?? '';
    const secret = config.get<string>('GST_API_SECRET') ?? '';
    const name = this.provider === 'cashfree' ? 'cashfree' : 'sandbox';
    const baseUrl = config.get<string>('GST_BASE_URL') ?? HOSTS[name][this.environment];
    // Child traceparent and call metrics on every provider request (OB-05).
    const fetchImpl: FetchLike = tracedFetch(`gst_${name}`, this.metrics);
    this.logger.log(`GST lookups via ${name} (${this.environment}) at ${new URL(baseUrl).host}.`);
    return name === 'cashfree'
      ? new CashfreeGstProvider(fetchImpl, baseUrl, key, secret)
      : new SandboxGstProvider(fetchImpl, baseUrl, key, secret, () => clock.now().getTime());
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
    const names = [
      'Sample Enterprises',
      'Meridian Traders',
      'Umbrella Logistics',
      'Northwind Supplies',
    ];
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
}
