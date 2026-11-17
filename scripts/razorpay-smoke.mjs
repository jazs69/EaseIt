/**
 * FO-15: one real round trip to Razorpay with the configured keys, through
 * the compiled `RazorpayClient`: create a ₹1.00 payment link, read it back,
 * cancel it. Proves the keys, Basic auth and the request and response shapes
 * against the real API. Nothing is charged: an unpaid link costs nothing, and
 * it is cancelled at once.
 *
 *   pnpm --filter @repo/api build
 *   pnpm razorpay:smoke            # test keys (rzp_test_...) only
 *   pnpm razorpay:smoke -- --live  # also allow live keys
 *
 * Keys come from apps/api/.env (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET); a
 * variable set in the shell wins. Prints ids and statuses, never the keys.
 * Razorpay allows 30 payment links per test-mode business; each run uses one.
 */

import { randomUUID } from 'node:crypto';

try {
  process.loadEnvFile(new URL('../apps/api/.env', import.meta.url));
} catch {
  // No apps/api/.env: the shell must supply the keys, checked below.
}

const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;
if (!keyId || !keySecret) {
  console.error(
    'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required (apps/api/.env or the shell).',
  );
  process.exit(2);
}
const live = keyId.startsWith('rzp_live_');
if (live && !process.argv.includes('--live')) {
  console.error(
    'These are LIVE keys. Re-run with -- --live if you mean it (no money moves either way).',
  );
  process.exit(2);
}

const loaded = await import(
  new URL('../apps/api/dist/modules/payments/razorpay.client.js', import.meta.url)
);
const { RazorpayClient } = Object.keys(loaded).some((k) => k !== 'default')
  ? loaded
  : (loaded.default ?? loaded);
const client = new RazorpayClient(
  (input, init) => fetch(input, init),
  process.env.RAZORPAY_BASE_URL ?? 'https://api.razorpay.com',
  keyId,
  keySecret,
  15_000,
);

let failed = false;
try {
  const created = await client.createLink({
    referenceId: randomUUID(),
    amountMinor: 100,
    currency: 'INR',
    description: 'EaseIt razorpay:smoke (cancelled immediately)',
    expireBySeconds: Math.floor(Date.now() / 1000) + 60 * 60,
    customer: { name: 'EaseIt smoke test', email: null, contact: null },
    notifySms: false,
    notifyEmail: false,
    notes: { purpose: 'smoke' },
  });
  console.log(`created  ${created.id}  status=${created.status}  ${created.shortUrl ?? ''}`);
  const fetched = await client.fetchLink(created.id);
  console.log(
    `fetched  ${fetched.id}  status=${fetched.status}  paid=${String(fetched.amountPaid)}`,
  );
  const cancelled = await client.cancelLink(created.id);
  console.log(`cancel   ${cancelled.id}  status=${cancelled.status}`);
  if (fetched.id !== created.id || cancelled.status !== 'cancelled') failed = true;
} catch (error) {
  failed = true;
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
}

console.log(
  failed
    ? `\nFAILED (${live ? 'live' : 'test'} mode).`
    : `\nOK: Razorpay ${live ? 'live' : 'test'} mode answered create, fetch and cancel.`,
);
process.exitCode = failed ? 1 : 0;
