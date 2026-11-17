/**
 * GP-04: one real GSTIN lookup through the compiled `GstService`, against the
 * provider and host the environment names. Run it before a deploy to prove
 * the credentials and the mapping against the real provider:
 *
 *   GST_PROVIDER=sandbox GST_API_KEY=key_test_... GST_API_SECRET=secret_test_... \
 *   GST_ENVIRONMENT=test pnpm gst:smoke -- 29AAACR5055K1Z3
 *
 * Prints the mapped result and its provenance tag. Never prints the key or
 * secret. Exits 1 when the provider could not be reached or refused the
 * credentials (the result comes back UNVERIFIED with "unavailable"), so a
 * wrong key fails loudly here instead of quietly at the front desk.
 *
 * Each run is one metered lookup (two at most, if the first attempt fails in
 * a retryable way). Requires `pnpm --filter @repo/api build` first.
 */

await import(new URL('../apps/api/node_modules/reflect-metadata/Reflect.js', import.meta.url));

const gstin = process.argv.slice(2).find((arg) => arg !== '--');
if (gstin === undefined) {
  console.error('Usage: pnpm gst:smoke -- <GSTIN>');
  process.exit(2);
}
for (const key of ['GST_PROVIDER', 'GST_API_KEY', 'GST_API_SECRET', 'GST_ENVIRONMENT']) {
  if (!process.env[key]) {
    console.error(`${key} is required (GST_PROVIDER=sandbox|cashfree, GST_ENVIRONMENT=test|live).`);
    process.exit(2);
  }
}
if (process.env.GST_PROVIDER === 'mock') {
  console.error('GST_PROVIDER=mock never calls a provider; nothing to smoke-test.');
  process.exit(2);
}

const load = async (relative) => {
  const loaded = await import(new URL(`../apps/api/dist/${relative}`, import.meta.url));
  return Object.keys(loaded).some((key) => key !== 'default') ? loaded : (loaded.default ?? loaded);
};
const { GstService } = await load('modules/companies/gst.service.js');
const { ClockService } = await load('modules/platform/clock.service.js');
const { ConfigService } = await import(
  new URL('../apps/api/node_modules/@nestjs/config/dist/index.js', import.meta.url)
);

const config = new ConfigService({
  GST_PROVIDER: process.env.GST_PROVIDER,
  GST_API_KEY: process.env.GST_API_KEY,
  GST_API_SECRET: process.env.GST_API_SECRET,
  GST_ENVIRONMENT: process.env.GST_ENVIRONMENT,
  GST_TIMEOUT_MS: Number(process.env.GST_TIMEOUT_MS ?? 8000),
  ...(process.env.GST_BASE_URL ? { GST_BASE_URL: process.env.GST_BASE_URL } : {}),
});
const service = new GstService(config, new ClockService());
const result = await service.lookup(gstin);

console.log(JSON.stringify(result, null, 2));
const reached =
  result.isValid &&
  !(result.verification === 'UNVERIFIED' && /unavailable|paused/.test(result.reason ?? ''));
console.log(
  reached
    ? `\nOK: ${result.provider} answered (${result.verification}).`
    : `\nFAILED: ${result.isValid ? 'the provider could not be reached or refused the credentials' : 'the GSTIN is malformed'}.`,
);
// exitCode, not process.exit(): exiting while fetch's keep-alive socket is
// still closing trips a libuv assertion on Windows (exit 127 after a success).
process.exitCode = reached ? 0 : 1;
