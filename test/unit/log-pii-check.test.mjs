/**
 * SE-02: the log-PII scanner (scripts/check-log-pii.mjs) catches what it
 * should and passes what it should. A check that never fires proves nothing,
 * so it is driven with synthetic sources.
 */

import { scan } from '../../scripts/check-log-pii.mjs';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const names = (source) => scan(source, 'x.ts').findings.flatMap((f) => f.names);

console.log('log PII scanner');

check(
  'a property access on a guest field is caught',
  names('this.logger.log(`Booked for ${stay.guestEmail}`);').includes('guestEmail'),
);
check(
  'a bare identifier is caught, across a multi-line call',
  names('this.logger.warn(\n  "Rejected",\n  { phone },\n);').includes('phone'),
);
check(
  'an object key is caught',
  names('logger.error("x", { firstName: a, lastName: b });').join() === 'firstName,lastName',
);
check('console is covered', names('console.log(user.password);').includes('password'));
check('Logger statics are covered', names('Logger.warn(`otp ${otp}`);').includes('otp'));
check(
  'string literals are not flagged',
  names('this.logger.error("Password reset email could not be sent");').length === 0,
);
check(
  'ids and booking codes are fine',
  names('this.logger.log(`Link ${link.id} for ${booking.confirmationCode}`);').length === 0,
);
check('a non-log call is ignored', names('await mailer.send({ to: guest.email });').length === 0);
check(
  'a reviewed exception with a reason is accepted',
  names(
    '// pii-log-ok: counts only, never the address\nthis.logger.log(`emails: ${email.length}`);',
  ).length === 0,
);
check(
  'a waiver without a reason is not',
  names('// pii-log-ok:\nthis.logger.log(`to ${email}`);').includes('email'),
);
const counted = scan(
  'a.logger.log("1"); b.logger.warn("2"); console.error("3"); x.y("4");',
  'c.ts',
);
check('every log call is counted, nothing else', counted.calls === 3, String(counted.calls));

if (failures > 0) {
  console.error(`\n${String(failures)} log PII scanner check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll log PII scanner checks passed.');
