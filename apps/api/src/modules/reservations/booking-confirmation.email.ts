/**
 * The booking confirmation email (NO-04). Pure: data in, subject/text/html
 * out, so the wording and the escaping are unit-tested with no services.
 *
 * Every value that came from a person — guest and property names, the room
 * type, the address — is HTML-escaped before it reaches the HTML part. A
 * guest named `<script>` is a guest named `<script>`, printed as text.
 *
 * Calendar dates are formatted from their `YYYY-MM-DD` parts in UTC, so the
 * day printed is the day stored whatever the worker's own time zone is
 * (section 3.3: a stay date is a date, not an instant).
 */

import { format, money } from '@repo/types';

export interface BookingConfirmationData {
  propertyName: string;
  propertyAddressLines: string[];
  propertyPhone: string | null;
  propertyEmail: string | null;
  guestName: string;
  bookingCode: string;
  arrivalDate: string;
  departureDate: string;
  nights: number;
  checkInTime: string;
  checkOutTime: string;
  roomTypeName: string;
  roomCount: number;
  adults: number;
  children: number;
  mealPlan: string;
  totalMinor: number;
  paidMinor: number;
  currency: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const MEAL_PLANS: Record<string, string> = {
  EP: 'Room only',
  CP: 'Breakfast included',
  MAP: 'Breakfast and one meal',
  AP: 'All meals',
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `2026-10-19` -> `Mon, 19 Oct 2026`, independent of the host time zone. */
export function displayDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) throw new Error(`Not a calendar date: ${date}`);
  const instant = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(instant);
}

/** Header-safe: no line breaks can reach the Subject line. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function renderBookingConfirmation(data: BookingConfirmationData): RenderedEmail {
  const amount = (minor: number) => format(money(minor, data.currency));
  const balanceMinor = data.totalMinor - data.paidMinor;
  const guests = `${String(data.adults)} adult${data.adults === 1 ? '' : 's'}${
    data.children > 0 ? `, ${String(data.children)} child${data.children === 1 ? '' : 'ren'}` : ''
  }`;
  const rooms = `${String(data.roomCount)} x ${data.roomTypeName}`;
  const board = MEAL_PLANS[data.mealPlan] ?? data.mealPlan;
  const contact = [data.propertyPhone, data.propertyEmail].filter(
    (value): value is string => value !== null && value !== '',
  );

  const rows: [string, string][] = [
    ['Booking code', data.bookingCode],
    ['Check-in', `${displayDate(data.arrivalDate)}, from ${data.checkInTime}`],
    ['Check-out', `${displayDate(data.departureDate)}, by ${data.checkOutTime}`],
    ['Nights', String(data.nights)],
    ['Room', rooms],
    ['Guests', guests],
    ['Board', board],
    ['Total', amount(data.totalMinor)],
    ['Paid', amount(data.paidMinor)],
    ['Balance due', amount(balanceMinor)],
  ];

  const subject = oneLine(`Booking confirmed: ${data.propertyName}, ${displayDate(data.arrivalDate)} (${data.bookingCode})`);

  const text = [
    `Dear ${data.guestName},`,
    '',
    `Your stay at ${data.propertyName} is confirmed.`,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    balanceMinor > 0 ? `The balance of ${amount(balanceMinor)} is payable at the hotel.` : 'Your stay is paid in full.',
    'Please quote your booking code if you contact us.',
    '',
    data.propertyName,
    ...data.propertyAddressLines,
    ...contact,
    '',
  ].join('\n');

  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${e(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2933">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px">
<tr><td style="padding:24px 28px 8px">
<p style="margin:0 0 4px;font-size:13px;color:#52606d">${e(data.propertyName)}</p>
<h1 style="margin:0 0 16px;font-size:20px">Your booking is confirmed</h1>
<p style="margin:0 0 16px;font-size:14px">Dear ${e(data.guestName)}, thank you for booking with us.</p>
</td></tr>
<tr><td style="padding:0 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;border-collapse:collapse">
${rows
  .map(
    ([label, value]) =>
      `<tr><td style="padding:6px 0;color:#52606d;border-bottom:1px solid #e4e7eb">${e(label)}</td>` +
      `<td style="padding:6px 0;text-align:right;border-bottom:1px solid #e4e7eb"><strong>${e(value)}</strong></td></tr>`,
  )
  .join('\n')}
</table>
</td></tr>
<tr><td style="padding:16px 28px 8px;font-size:14px">
<p style="margin:0 0 8px">${e(balanceMinor > 0 ? `The balance of ${amount(balanceMinor)} is payable at the hotel.` : 'Your stay is paid in full.')}</p>
<p style="margin:0">Please quote your booking code if you contact us.</p>
</td></tr>
<tr><td style="padding:16px 28px 24px;font-size:12px;color:#52606d">
${[data.propertyName, ...data.propertyAddressLines, ...contact].map(e).join('<br>')}
</td></tr>
</table>
</body></html>
`;

  return { subject, text, html };
}
