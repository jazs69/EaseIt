/**
 * GP-04: the live GST providers, their resilience wrapper, the service's
 * provenance tags and the environment rules. No network: every provider is
 * driven by a fake `fetch` that answers with the bodies the providers'
 * documentation shows (developer.sandbox.co.in, cashfree.com/docs; read
 * 2026-11-17). The real hosts are exercised by `pnpm gst:smoke` with
 * credentials, which this suite cannot have.
 */

import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { validateEnv } from '../../../config/env.js';
import type { ClockService } from '../../platform/clock.service.js';
import { GstService } from '../gst.service.js';
import { CashfreeGstProvider, mapCashfreeGstin } from './cashfree.provider.js';
import { GstProviderError, type FetchLike, type GstProvider } from './provider.js';
import { ResilientGstLookup } from './resilient-lookup.js';
import { mapSandboxSearch, SandboxGstProvider } from './sandbox.provider.js';

const GSTIN = '29AAACR5055K1Z3';

const SANDBOX_FOUND = {
  code: 200,
  timestamp: 1,
  transaction_id: 't',
  data: {
    status_cd: '1',
    data: {
      gstin: GSTIN,
      lgnm: 'VICKY PRIVATE LIMITED',
      tradeNam: 'Vicky Pvt Ltd',
      sts: 'Active',
      pradr: {
        addr: {
          flno: '2nd Floor',
          bno: '12',
          bnm: 'Tower A',
          st: 'MG Road',
          loc: 'Ashok Nagar',
          dst: 'Bengaluru Urban',
          stcd: 'Karnataka',
          pncd: '560048',
        },
        ntr: 'Supplier of Services',
      },
    },
  },
};
const SANDBOX_NOT_FOUND = {
  code: 200,
  data: { status_cd: '0', error: { error_cd: 'FO8000', message: 'No records found' } },
};
const CASHFREE_FOUND = {
  reference_id: 1,
  GSTIN,
  legal_name_of_business: 'UJJIVAN SMALL FINANCE BANK LIMITED',
  trade_name_of_business: 'UJJIVAN SMALL FINANCE BANK',
  gst_in_status: 'Active',
  principal_place_address: 'Grape Garden, Koramangala, Bengaluru, Karnataka, 560095',
  principal_place_split_address: {
    building_name: 'Grape Garden',
    street: '3rd A Cross',
    location: 'Koramangala',
    building_number: '27',
    district: 'Bengaluru Urban',
    state: 'Karnataka',
    city: 'Bengaluru',
    flat_number: '',
    pincode: '560095',
  },
  valid: true,
  message: 'GSTIN Exists',
};
const CASHFREE_NOT_FOUND = { reference_id: 20, GSTIN, message: "GSTIN Doesn't Exist" };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: (url: string, call: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(answer(url, calls.length));
  };
  return { fn, calls };
}

const header = (call: Call | undefined, name: string) =>
  (call?.init.headers as Record<string, string> | undefined)?.[name];

/* ------------------------------------------------------------------------ */

describe('response mapping, from the documented bodies', () => {
  it('Sandbox: the taxpayer at data.data, address assembled', () => {
    const outcome = mapSandboxSearch(SANDBOX_FOUND);
    expect(outcome.kind).toBe('found');
    if (outcome.kind !== 'found') return;
    expect(outcome.taxpayer).toMatchObject({
      legalName: 'VICKY PRIVATE LIMITED',
      tradeName: 'Vicky Pvt Ltd',
      status: 'Active',
      address: { city: 'Bengaluru Urban', state: 'Karnataka', pincode: '560048' },
    });
    expect(outcome.taxpayer.address?.addressLine1).toBe(
      '2nd Floor, 12, Tower A, MG Road, Ashok Nagar',
    );
  });

  it('Sandbox: status_cd "0" with FO8000 is not found, not an error', () => {
    expect(mapSandboxSearch(SANDBOX_NOT_FOUND)).toEqual({ kind: 'not_found' });
  });

  it('Cashfree: the split address, empty parts dropped', () => {
    const outcome = mapCashfreeGstin(CASHFREE_FOUND);
    expect(outcome.kind).toBe('found');
    if (outcome.kind !== 'found') return;
    expect(outcome.taxpayer).toMatchObject({
      legalName: 'UJJIVAN SMALL FINANCE BANK LIMITED',
      status: 'Active',
      address: {
        addressLine1: '27, Grape Garden, 3rd A Cross, Koramangala',
        city: 'Bengaluru',
        pincode: '560095',
      },
    });
  });

  it('Cashfree: "GSTIN Doesn\'t Exist" (no valid:true) is not found', () => {
    expect(mapCashfreeGstin(CASHFREE_NOT_FOUND)).toEqual({ kind: 'not_found' });
  });
});

describe('SandboxGstProvider', () => {
  const signal = new AbortController().signal;

  it('authenticates with key and secret, then searches by POST with the raw token', async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.endsWith('/authenticate')
        ? json(200, { code: 200, data: { access_token: 'jwt-1' } })
        : json(200, SANDBOX_FOUND),
    );
    const provider = new SandboxGstProvider(
      fn,
      'https://test-api.sandbox.co.in',
      'key_test',
      'secret_test',
      () => 0,
    );
    const outcome = await provider.lookup(GSTIN, signal);
    expect(outcome.kind).toBe('found');
    expect(calls[0]?.url).toBe('https://test-api.sandbox.co.in/authenticate');
    expect(calls[0]?.init.method).toBe('POST');
    expect(header(calls[0], 'x-api-key')).toBe('key_test');
    expect(header(calls[0], 'x-api-secret')).toBe('secret_test');
    expect(calls[1]?.url).toBe('https://test-api.sandbox.co.in/gst/compliance/public/gstin/search');
    expect(calls[1]?.init.method).toBe('POST');
    expect(header(calls[1], 'authorization')).toBe('jwt-1'); // not "Bearer jwt-1"
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ gstin: GSTIN });
  });

  it('reuses the token, and refreshes it once on a 401', async () => {
    let tokens = 0;
    let searches = 0;
    const { fn, calls } = fakeFetch((url) => {
      if (url.endsWith('/authenticate')) {
        tokens += 1;
        return json(200, { data: { access_token: `jwt-${String(tokens)}` } });
      }
      searches += 1;
      return searches === 2
        ? json(401, { code: 401, message: 'expired' })
        : json(200, SANDBOX_FOUND);
    });
    const provider = new SandboxGstProvider(fn, 'https://x', 'k', 's', () => 0);
    await provider.lookup(GSTIN, signal);
    await provider.lookup(GSTIN, signal);
    expect(tokens).toBe(2);
    expect(header(calls.at(-1), 'authorization')).toBe('jwt-2');
  });

  it("the provider's own message reaches the error, e.g. a live key on the test host", async () => {
    const { fn } = fakeFetch((url) =>
      url.endsWith('/authenticate')
        ? json(200, { data: { access_token: 'jwt' } })
        : json(403, { code: 403, message: 'Use test API key for test environment' }),
    );
    const provider = new SandboxGstProvider(fn, 'https://x', 'k', 's', () => 0);
    await expect(provider.lookup(GSTIN, signal)).rejects.toMatchObject({
      retryable: false,
      status: 403,
      message: 'sandbox returned HTTP 403: Use test API key for test environment',
    });
  });

  it('bad credentials are a permanent, non-retryable error', async () => {
    const { fn } = fakeFetch(() => json(401, { code: 401, message: 'Invalid API key' }));
    const provider = new SandboxGstProvider(fn, 'https://x', 'k', 's', () => 0);
    await expect(provider.lookup(GSTIN, signal)).rejects.toMatchObject({
      retryable: false,
      status: 401,
    });
  });
});

describe('CashfreeGstProvider', () => {
  it('POSTs {GSTIN} with client id, secret and api version', async () => {
    const { fn, calls } = fakeFetch(() => json(200, CASHFREE_FOUND));
    const provider = new CashfreeGstProvider(fn, 'https://sandbox.cashfree.com', 'cid', 'csecret');
    expect((await provider.lookup(GSTIN, new AbortController().signal)).kind).toBe('found');
    expect(calls[0]?.url).toBe('https://sandbox.cashfree.com/verification/gstin');
    expect(header(calls[0], 'x-client-id')).toBe('cid');
    expect(header(calls[0], 'x-client-secret')).toBe('csecret');
    expect(header(calls[0], 'x-api-version')).toBe('2022-09-13');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ GSTIN });
  });

  it('a 5xx is retryable; a 422 (no balance) is not', async () => {
    const five = new CashfreeGstProvider(fakeFetch(() => json(503, {})).fn, 'https://x', 'a', 'b');
    await expect(five.lookup(GSTIN, new AbortController().signal)).rejects.toMatchObject({
      retryable: true,
    });
    const four = new CashfreeGstProvider(fakeFetch(() => json(422, {})).fn, 'https://x', 'a', 'b');
    await expect(four.lookup(GSTIN, new AbortController().signal)).rejects.toMatchObject({
      retryable: false,
    });
  });
});

/* ------------------------------------------------------------------------ */

describe('ResilientGstLookup', () => {
  function harness(behaviour: (call: number) => Promise<unknown>) {
    let now = 0;
    let calls = 0;
    const provider: GstProvider = {
      name: 'sandbox',
      lookup: async () => {
        calls += 1;
        return (await behaviour(calls)) as never;
      },
    };
    const lookup = new ResilientGstLookup(provider, {
      timeoutMs: 1_000,
      maxAttempts: 2,
      failureThreshold: 3,
      openMs: 60_000,
      cacheTtlMs: 3_600_000,
      cacheSize: 2,
      now: () => now,
      sleep: () => Promise.resolve(),
    });
    return {
      lookup,
      calls: () => calls,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }
  const found = {
    kind: 'found',
    taxpayer: { legalName: 'X', tradeName: null, status: 'Active', address: null },
  };

  it('retries a retryable failure once, then succeeds', async () => {
    const h = harness((call) =>
      call === 1 ? Promise.reject(new GstProviderError('503', true, 503)) : Promise.resolve(found),
    );
    expect((await h.lookup.lookup(GSTIN)).kind).toBe('found');
    expect(h.calls()).toBe(2);
  });

  it('does not retry a permanent failure', async () => {
    const h = harness(() => Promise.reject(new GstProviderError('401', false, 401)));
    expect(await h.lookup.lookup(GSTIN)).toMatchObject({ kind: 'unavailable', reason: 'failed' });
    expect(h.calls()).toBe(1);
  });

  it('opens after 3 failed lookups, skips calls while open, probes after openMs', async () => {
    const h = harness(() => Promise.reject(new GstProviderError('timeout', true)));
    for (const n of ['A', 'B', 'C']) await h.lookup.lookup(`${n}${GSTIN.slice(1)}`);
    expect(h.calls()).toBe(6); // 3 lookups x 2 attempts
    expect(h.lookup.isOpen()).toBe(true);
    expect(await h.lookup.lookup(GSTIN)).toMatchObject({
      kind: 'unavailable',
      reason: 'circuit_open',
    });
    expect(h.calls()).toBe(6);
    h.advance(60_001);
    await h.lookup.lookup(GSTIN);
    expect(h.calls()).toBe(8); // the half-open probe went out
  });

  it('caches definite answers, including not found, which never trips the breaker', async () => {
    const h = harness(() => Promise.resolve({ kind: 'not_found' }));
    for (let i = 0; i < 5; i += 1) expect((await h.lookup.lookup(GSTIN)).kind).toBe('not_found');
    expect(h.calls()).toBe(1);
    expect(h.lookup.isOpen()).toBe(false);
    h.advance(3_600_001);
    await h.lookup.lookup(GSTIN);
    expect(h.calls()).toBe(2);
  });

  it('the cache is bounded', async () => {
    const h = harness(() => Promise.resolve(found));
    await h.lookup.lookup('A');
    await h.lookup.lookup('B');
    await h.lookup.lookup('C'); // evicts A
    await h.lookup.lookup('A');
    expect(h.calls()).toBe(4);
  });
});

/* ------------------------------------------------------------------------ */

describe('GstService provenance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const clock = { now: () => new Date('2026-11-17T00:00:00Z') } as ClockService;
  const service = (env: Record<string, unknown>) =>
    new GstService(
      new ConfigService({ GST_TIMEOUT_MS: 1_000, GST_API_KEY: 'k', GST_API_SECRET: 's', ...env }),
      clock,
    );

  it('a live-host answer is VERIFIED, unmarked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(200, CASHFREE_FOUND))),
    );
    const result = await service({ GST_PROVIDER: 'cashfree', GST_ENVIRONMENT: 'live' }).lookup(
      GSTIN,
    );
    expect(result).toMatchObject({
      provider: 'cashfree',
      verification: 'VERIFIED',
      companyName: 'UJJIVAN SMALL FINANCE BANK LIMITED',
    });
  });

  it('a test-host answer is MOCK and visibly marked, never VERIFIED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(200, CASHFREE_FOUND))),
    );
    const result = await service({ GST_PROVIDER: 'cashfree', GST_ENVIRONMENT: 'test' }).lookup(
      GSTIN,
    );
    expect(result.verification).toBe('MOCK');
    expect(result.companyName).toBe('UJJIVAN SMALL FINANCE BANK LIMITED (PROVIDER TEST DATA)');
  });

  it('not found and an outage both fall back to UNVERIFIED with a reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(200, CASHFREE_NOT_FOUND))),
    );
    const missing = await service({ GST_PROVIDER: 'cashfree', GST_ENVIRONMENT: 'live' }).lookup(
      GSTIN,
    );
    expect(missing).toMatchObject({ verification: 'UNVERIFIED', companyName: null });
    expect(missing.reason).toMatch(/no taxpayer/);

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const down = await service({ GST_PROVIDER: 'cashfree', GST_ENVIRONMENT: 'live' }).lookup(GSTIN);
    expect(down).toMatchObject({ verification: 'UNVERIFIED', success: true });
    expect(down.reason).toMatch(/unavailable/);
  });

  it('a malformed GSTIN never reaches the provider', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const result = await service({ GST_PROVIDER: 'sandbox', GST_ENVIRONMENT: 'live' }).lookup(
      '29AAACR5055K1Z4',
    );
    expect(result.isValid).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('environment rules', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_SECRET: 'x'.repeat(64),
  };
  const issues = (env: Record<string, unknown>): string => {
    try {
      validateEnv({ ...base, ...env });
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  it('production refuses the mock provider and a provider test host', () => {
    expect(issues({ GST_PROVIDER: 'mock' })).toContain('GST_PROVIDER');
    expect(
      issues({
        GST_PROVIDER: 'sandbox',
        GST_API_KEY: 'k',
        GST_API_SECRET: 's',
        GST_ENVIRONMENT: 'test',
      }),
    ).toContain('GST_ENVIRONMENT');
  });

  it('production refuses the base-URL override', () => {
    expect(
      issues({
        GST_PROVIDER: 'sandbox',
        GST_API_KEY: 'k',
        GST_API_SECRET: 's',
        GST_ENVIRONMENT: 'live',
        GST_BASE_URL: 'http://127.0.0.1:9',
      }),
    ).toContain('GST_BASE_URL');
  });

  it('a live provider needs both key and secret, everywhere', () => {
    const message = issues({ NODE_ENV: 'development', GST_PROVIDER: 'cashfree', GST_API_KEY: 'k' });
    expect(message).toContain('GST_API_SECRET');
  });
});
