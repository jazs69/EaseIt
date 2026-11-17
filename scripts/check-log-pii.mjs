/**
 * SE-02: no guest personal data in log calls (CLAUDE.md section 5: "never log
 * guest PII, card data, or full channel payloads containing either").
 *
 * ===========================================================================
 * Parses every TypeScript file under apps/api/src (tests excluded) with the
 * TypeScript compiler, finds every log call (`*.logger.<level>(…)`,
 * `Logger.<level>(…)`, `console.<level>(…)`), and fails if any argument
 * references a field that holds personal data: an identifier, a property
 * access (`stay.guestEmail`), a shorthand property or an object key.
 *
 * Names, not values. A string literal is never flagged ("Password reset
 * email could not be sent" is fine); `${user.email}` is. That is the
 * mechanical half of the review. The other half is the runtime redaction in
 * `common/logging/redacting-logger.ts`, for what a name check cannot see (an
 * error message that happens to contain an address), and the written review
 * in docs/release/PII-LOGGING-REVIEW.md.
 *
 * A reviewed exception is marked on the call's line, or the line above, with
 *   // pii-log-ok: <why this is not personal data>
 * and the reason is required.
 *
 *   node scripts/check-log-pii.mjs          # exit 1 on any finding
 * ===========================================================================
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const ts = require('typescript');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(ROOT, 'apps', 'api', 'src');

/** Field names that hold personal data or secrets about a person. */
export const PII_NAMES = new Set([
  'guestFirstName',
  'guestLastName',
  'guestName',
  'guestEmail',
  'guestPhone',
  'firstName',
  'lastName',
  'fullName',
  'email',
  'phone',
  'contact',
  'mobile',
  'govtIdNumber',
  'govtIdType',
  'dateOfBirth',
  'addressLine1',
  'addressLine2',
  'postalCode',
  'nationality',
  'specialRequest',
  'password',
  'passwordHash',
  'otp',
  'otpCode',
  'cardNumber',
  'cvv',
  'vpa',
]);

const LEVELS = new Set(['log', 'warn', 'error', 'debug', 'verbose', 'fatal', 'info']);

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts'))
      yield path;
  }
}

function isLogCall(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  if (!LEVELS.has(node.expression.name.text)) return false;
  const target = node.expression.expression.getText();
  return /(^|\.)logger$/i.test(target) || target === 'Logger' || target === 'console';
}

/** Every name an argument mentions: identifiers, property names, object keys. */
function namesIn(node, out = []) {
  if (ts.isIdentifier(node)) out.push(node.text);
  else if (ts.isPrivateIdentifier?.(node)) out.push(node.text);
  if (ts.isPropertyAccessExpression(node)) out.push(node.name.text);
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) out.push(node.name.text);
  if (ts.isShorthandPropertyAssignment(node)) out.push(node.name.text);
  // forEachChild STOPS at the first truthy return: the callback must return
  // nothing, or the walk ends at the first child (found by the unit test).
  ts.forEachChild(node, (child) => {
    namesIn(child, out);
  });
  return out;
}

export function scan(source, fileName) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const lines = source.split('\n');
  const findings = [];
  let calls = 0;
  const visit = (node) => {
    if (isLogCall(node)) {
      calls += 1;
      const hits = [
        ...new Set(node.arguments.flatMap((arg) => namesIn(arg)).filter((n) => PII_NAMES.has(n))),
      ];
      if (hits.length > 0) {
        const start = sf.getLineAndCharacterOfPosition(node.getStart()).line;
        const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
        const window = lines.slice(Math.max(0, start - 1), end + 1).join('\n');
        // The reason must be on the waiver's own line; `\s` would run onto the next.
        const waiver = /pii-log-ok:[ \t]*(\S[^\n]*)/.exec(window);
        if (waiver === null)
          findings.push({ line: start + 1, names: hits, text: lines[start].trim() });
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child);
    });
  };
  visit(sf);
  return { calls, findings };
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  let calls = 0;
  let failures = 0;
  for (const path of files(SOURCE)) {
    const result = scan(readFileSync(path, 'utf8'), path);
    calls += result.calls;
    for (const finding of result.findings) {
      failures += 1;
      console.error(
        `  FAIL  ${relative(ROOT, path)}:${String(finding.line)}  logs ${finding.names.join(', ')}`,
      );
      console.error(`        ${finding.text}`);
    }
  }
  if (failures > 0) {
    console.error(
      `\n${String(failures)} log call(s) reference personal data. Log an id instead, or mark a reviewed ` +
        'exception with `// pii-log-ok: <reason>`.',
    );
    process.exit(1);
  }
  console.log(`No personal data in ${String(calls)} log call(s) under apps/api/src.`);
}
