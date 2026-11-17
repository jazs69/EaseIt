/**
 * Metrics and trace propagation through the running API (OB-05).
 *
 * The API under test is started with METRICS_TOKEN=suite-metrics-token-0123456789
 * (as CI does). Asserted: every response carries `traceparent` and
 * `x-request-id`; an incoming trace is continued, a malformed one replaced;
 * `/metrics` refuses without the token and, with it, serves Prometheus text
 * in which request counts are labelled by route TEMPLATE, never by the ids
 * in the URL. Unit tests cover the registry, the error digest and redaction.
 */

const SUITE = 'observability';
const API = process.env.EASEIT_API_URL;
const TOKEN = process.env.METRICS_TOKEN ?? 'suite-metrics-token-0123456789';
if (!API) {
  console.error(`${SUITE}: EASEIT_API_URL is required.`);
  process.exit(1);
}

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n════ observability (OB-05) ════\n');

console.log('1. Trace context on every response.');
const plain = await fetch(`${API}/health`);
const tp = plain.headers.get('traceparent') ?? '';
check('a traceparent comes back', /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(tp), tp);
check('and an x-request-id', (plain.headers.get('x-request-id') ?? '').length > 0);

const incoming = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const continued = await fetch(`${API}/health`, { headers: { traceparent: incoming } });
const back = continued.headers.get('traceparent') ?? '';
check(
  'an incoming trace is continued with a new span',
  back.startsWith('00-4bf92f3577b34da6a3ce929d0e0e4736-') && !back.includes('00f067aa0ba902b7'),
  back,
);
const forged = await fetch(`${API}/health`, { headers: { traceparent: 'not-a-trace' } });
check(
  'a malformed one is replaced, not echoed',
  /^00-[0-9a-f]{32}-/.test(forged.headers.get('traceparent') ?? '') &&
    !(forged.headers.get('traceparent') ?? '').includes('not-a-trace'),
);

console.log('\n2. /metrics.');
const refused = await fetch(`${API}/metrics`);
check('refused without the token', refused.status === 401, String(refused.status));
const wrong = await fetch(`${API}/metrics`, {
  headers: { authorization: 'Bearer wrong-token-of-another-length' },
});
check('refused with a wrong token', wrong.status === 401, String(wrong.status));

// A request with an id in its path, to see how it is labelled.
await fetch(`${API}/properties/ZZOBSERVEID42/work-orders`);
const scrape = await fetch(`${API}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
const text = await scrape.text();
check(
  'served with the token, as Prometheus text',
  scrape.status === 200 && (scrape.headers.get('content-type') ?? '').startsWith('text/plain'),
  String(scrape.status),
);
check(
  'request counts and latency are present',
  text.includes('# TYPE easeit_http_requests_total counter') &&
    text.includes('easeit_http_request_duration_seconds_bucket'),
);
check(
  'labelled by route template, never by the id in the URL',
  text.includes('route="/api/v1/properties/:hotelId/work-orders"') &&
    !text.includes('ZZOBSERVEID42'),
);
check(
  'outbox and process gauges render',
  text.includes('easeit_outbox_rows{state="pending"}') &&
    text.includes('easeit_process_resident_memory_bytes'),
);
check('no personal-data-looking label values', !/@|\+91/.test(text));

// exitCode, not process.exit(): exiting while fetch's keep-alive sockets are
// still closing aborts Node on Windows (seen in gate-integration).
if (failures > 0) {
  console.error(`\n${String(failures)} ${SUITE} check(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${SUITE} checks passed.`);
}
