/**
 * The booking confirmation email (NO-04): pure rendering.
 *
 * Pins the facts a guest acts on (code, dates with times, nights, room,
 * guests, money and the balance line), that every person-supplied value is
 * HTML-escaped, that the subject can never carry a line break, and that the
 * printed date is the stored date whatever the host's time zone.
 *
 * Run: node test/unit/booking-confirmation-email.test.mjs
 */

import {
  displayDate,
  escapeHtml,
  renderBookingConfirmation,
} from '../../apps/api/src/modules/reservations/booking-confirmation.email.ts';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail === '' ? '' : ` -- ${detail}`}`);
  }
}

const base = {
  propertyName: 'Grand Marine Goa',
  propertyAddressLines: ['Plot 14, Dona Paula Road', 'Panaji, Goa 403004'],
  propertyPhone: '+91 832 000 0000',
  propertyEmail: 'frontdesk@grandmarine.example.com',
  guestName: 'Ananya Reddy',
  bookingCode: 'SFBOOKING_31346_A09',
  arrivalDate: '2026-10-19',
  departureDate: '2026-10-22',
  nights: 3,
  checkInTime: '14:00',
  checkOutTime: '11:00',
  roomTypeName: 'Sea View Premium',
  roomCount: 1,
  adults: 2,
  children: 1,
  mealPlan: 'CP',
  totalMinor: 3159600,
  paidMinor: 1000000,
  currency: 'INR',
};

console.log('Dates');
check('2026-10-19 is a Monday', displayDate('2026-10-19') === 'Mon, 19 Oct 2026', displayDate('2026-10-19'));
check('the last day of a month stays put', displayDate('2026-10-31') === 'Sat, 31 Oct 2026', displayDate('2026-10-31'));
const tz = process.env.TZ;
process.env.TZ = 'America/Los_Angeles';
check('independent of the host time zone', displayDate('2026-01-01') === 'Thu, 1 Jan 2026', displayDate('2026-01-01'));
process.env.TZ = tz;
let threw = false;
try {
  displayDate('19/10/2026');
} catch {
  threw = true;
}
check('a malformed date is refused', threw);

console.log('Content');
const mail = renderBookingConfirmation(base);
check('subject names the hotel, the date and the code', mail.subject === 'Booking confirmed: Grand Marine Goa, Mon, 19 Oct 2026 (SFBOOKING_31346_A09)', mail.subject);
for (const fact of [
  'Dear Ananya Reddy,',
  'Booking code: SFBOOKING_31346_A09',
  'Check-in: Mon, 19 Oct 2026, from 14:00',
  'Check-out: Thu, 22 Oct 2026, by 11:00',
  'Nights: 3',
  'Room: 1 x Sea View Premium',
  'Guests: 2 adults, 1 child',
  'Board: Breakfast included',
  'Total: ₹31,596.00',
  'Paid: ₹10,000.00',
  'Balance due: ₹21,596.00',
  'The balance of ₹21,596.00 is payable at the hotel.',
  'frontdesk@grandmarine.example.com',
]) {
  check(`text: ${fact}`, mail.text.includes(fact));
}
check('html carries the same total', mail.html.includes('₹31,596.00'));
const paid = renderBookingConfirmation({ ...base, paidMinor: base.totalMinor, adults: 1, children: 0 });
check('paid in full says so', paid.text.includes('Your stay is paid in full.') && !paid.text.includes('payable at the hotel'));
check('one adult, no children', paid.text.includes('Guests: 1 adult\n'));
check('an unknown board code is shown as-is', renderBookingConfirmation({ ...base, mealPlan: 'XYZ' }).text.includes('Board: XYZ'));

console.log('Escaping and headers');
const hostile = renderBookingConfirmation({
  ...base,
  guestName: '<script>alert("x")</script>',
  propertyName: 'Tom & Jerry\'s <Inn>',
  roomTypeName: '<img src=x onerror=alert(1)>',
});
check('no raw <script> in the HTML', !hostile.html.includes('<script>'));
check('no raw <img in the HTML', !hostile.html.includes('<img'));
check('the guest name is escaped', hostile.html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
check('& and quotes are escaped', hostile.html.includes('Tom &amp; Jerry&#39;s &lt;Inn&gt;'));
check('the text part is not HTML-escaped', hostile.text.includes('Dear <script>alert("x")</script>,'));
check('escapeHtml covers all five', escapeHtml(`&<>"'`) === '&amp;&lt;&gt;&quot;&#39;');
const injected = renderBookingConfirmation({ ...base, propertyName: 'Inn\r\nBcc: victim@example.com' });
check('a line break cannot reach the subject', !/[\r\n]/.test(injected.subject), JSON.stringify(injected.subject));

console.log('');
if (failures === 0) {
  console.log('All booking confirmation email checks passed.');
} else {
  console.error(`${String(failures)} check(s) FAILED.`);
  process.exit(1);
}
