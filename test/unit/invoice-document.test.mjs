/**
 * Invoice numbering and rendering (FO-14).
 *
 * ===========================================================================
 * Pure: `invoice-document.ts` has no Nest, database or clock, and Node strips
 * its types on import, so this runs in `pnpm test` with nothing else up.
 *
 * What it pins:
 *   * the Indian financial year boundary (31 March / 1 April),
 *   * the number format and its 16-character fit with the default prefix,
 *   * integer-only amount formatting, Indian grouping, negative values,
 *   * CSV quoting and the formula-injection guard on text (never on amounts),
 *   * a PDF that is structurally sound: header, every object at the offset
 *     the xref claims, startxref pointing at the xref, one page per 60-odd
 *     lines, and no byte outside Latin-1 in the text.
 *
 * Run: node test/unit/invoice-document.test.mjs
 * ===========================================================================
 */

import {
  csvCell,
  decimalOf,
  fiscalYearOf,
  groupedOf,
  invoiceNumber,
  pdfText,
  renderInvoiceCsv,
  renderInvoicePdf,
} from '../../apps/api/src/modules/folios/invoice-document.ts';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail === '' ? '' : ` -- ${detail}`}`);
  }
}
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/* ------------------------------------------------------------- numbering */
console.log('Numbering');
check('2026-10-19 is FY 2026-27', fiscalYearOf('2026-10-19') === '2026-27');
check('31 March is still the old year', fiscalYearOf('2027-03-31') === '2026-27');
check('1 April starts the new year', fiscalYearOf('2027-04-01') === '2027-28');
check('January belongs to the year that began the April before', fiscalYearOf('2027-01-15') === '2026-27');
check('the century rolls (2099-00)', fiscalYearOf('2099-06-01') === '2099-00');
check('a malformed date is refused', throws(() => fiscalYearOf('19/10/2026')));
const n1 = invoiceNumber('INV_', '2026-27', 1);
check('INV_ + 2627 + -00001', n1 === 'INV_2627-00001', n1);
check('fits the GST 16-character ceiling with the default prefix', n1.length <= 16, String(n1.length));
check('six digits are not truncated', invoiceNumber('INV_', '2026-27', 123456) === 'INV_2627-123456');
check('sequence 0 is refused', throws(() => invoiceNumber('INV_', '2026-27', 0)));
check('a fractional sequence is refused', throws(() => invoiceNumber('INV_', '2026-27', 1.5)));

/* --------------------------------------------------------------- amounts */
console.log('Amounts');
check('123456 INR -> 1234.56', decimalOf(123456, 'INR') === '1234.56');
check('5 paise -> 0.05', decimalOf(5, 'INR') === '0.05');
check('negative keeps its sign', decimalOf(-250, 'INR') === '-2.50');
check('zero', decimalOf(0, 'INR') === '0.00');
check('a float is refused', throws(() => decimalOf(1.5, 'INR')));
check('Indian grouping: 1,23,45,678.90', groupedOf(1234567890, 'INR') === '1,23,45,678.90', groupedOf(1234567890, 'INR'));
check('Indian grouping below a thousand', groupedOf(99900, 'INR') === '999.00');
check('Indian grouping, negative', groupedOf(-12345600, 'INR') === '-1,23,456.00', groupedOf(-12345600, 'INR'));
check('thousands grouping elsewhere', groupedOf(123456789, 'USD') === '1,234,567.89', groupedOf(123456789, 'USD'));

/* ------------------------------------------------------------------- CSV */
console.log('CSV');
check('plain text passes', csvCell('Room charge') === 'Room charge');
check('a comma is quoted', csvCell('Goa, India') === '"Goa, India"');
check('a quote is doubled', csvCell('the "suite"') === '"the ""suite"""');
check('=formula is neutralised', csvCell('=HYPERLINK("x")') === '"\'=HYPERLINK(""x"")"');
check('+, -, @ are neutralised', ['+1', '-1', '@x'].every((v) => csvCell(v).startsWith("'")));

const invoice = {
  id: '00000000-0000-4000-8000-000000000001',
  number: 'INV_2627-00007',
  fiscalYear: '2026-27',
  title: 'Tax Invoice',
  invoiceDate: '2026-10-21',
  issuedAt: '2026-10-21T09:30:00.000Z',
  currency: 'INR',
  seller: {
    name: 'Grand (Marine) Goa',
    legalName: 'Grand Marine Hospitality Pvt Ltd',
    gstin: '30AABCU9603R1ZM',
    addressLines: ['Plot 14, Dona Paula Road', 'Panaji, Goa 403004'],
    email: null,
    phone: '+91 832 000 0000',
  },
  billTo: {
    kind: 'GUEST',
    name: 'Ánanya Reddy — VIP',
    legalName: null,
    gstin: null,
    addressLines: [],
    email: null,
    phone: null,
  },
  stay: {
    bookingCode: 'SF_1',
    guestName: 'Ánanya Reddy — VIP',
    arrivalDate: '2026-10-18',
    departureDate: '2026-10-21',
    nights: 3,
    roomNumber: '101',
    roomTypeName: 'Deluxe',
  },
  lines: Array.from({ length: 90 }, (_, i) => ({
    date: '2026-10-18',
    description: i === 0 ? '=cmd|calc, "room" ₹ \\ (night)' : `Line ${String(i)}`,
    kind: 'SERVICE_CHARGE',
    netMinor: 10000,
    taxMinor: 1800,
    grossMinor: 11800,
    taxRatePercent: 18,
  })),
  payments: [
    { date: '2026-10-21', kind: 'PAYMENT', method: 'CASH', amountMinor: 1100000 },
    { date: '2026-10-21', kind: 'REFUND', method: 'CASH', amountMinor: 38000 },
  ],
  totals: {
    subtotalMinor: 900000,
    taxMinor: 162000,
    cgstMinor: 81000,
    sgstMinor: 81000,
    totalMinor: 1062000,
    paidMinor: 1100000,
    refundedMinor: 38000,
    balanceMinor: 0,
  },
};

const csv = renderInvoiceCsv(invoice);
const csvLines = csv.split('\r\n');
check('starts with a UTF-8 BOM, for Excel', csv.startsWith('\uFEFF'));
check('first row names the document', csvLines[0] === '\uFEFFTax Invoice,INV_2627-00007', csvLines[0]);
check('a line with formula text is guarded and quoted', csv.includes('"\'=cmd|calc, ""room"" ₹ \\ (night)"'));
check('amounts are plain decimals, unguarded', csv.includes(',100.00,18.00,18.00,118.00'));
check('the total row', csvLines.includes('Total,10620.00'));
check('a refund row', csv.includes('2026-10-21,REFUND,CASH,380.00'));
check('ends with CRLF', csv.endsWith('\r\n'));

/* ------------------------------------------------------------------- PDF */
console.log('PDF');
check('PDF text escapes parentheses and backslashes', pdfText('a(b)c\\') === 'a\\(b\\)c\\\\');
check('the rupee sign is transliterated', pdfText('₹ 10') === 'Rs. 10');
check('an em dash becomes a hyphen', pdfText('a — b') === 'a - b');
check('Latin-1 survives', pdfText('Ánanya') === 'Ánanya');
check('anything else is "?"', pdfText('漢') === '?');

const pdf = renderInvoicePdf(invoice);
const raw = pdf.toString('latin1');
check('starts with %PDF-1.4', raw.startsWith('%PDF-1.4\n'));
check('ends with %%EOF', raw.trimEnd().endsWith('%%EOF'));

const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(raw)?.[1]);
check('startxref points at the xref table', raw.slice(startxref, startxref + 5) === 'xref\n', String(startxref));
const xrefBody = raw.slice(startxref).split('\n');
const count = Number(xrefBody[1]?.split(' ')[1]);
let offsetsOk = true;
for (let id = 1; id < count; id += 1) {
  const offset = Number(xrefBody[2 + id]?.slice(0, 10));
  if (!raw.slice(offset).startsWith(`${String(id)} 0 obj\n`)) {
    offsetsOk = false;
    console.error(`    object ${String(id)} is not at ${String(offset)}`);
  }
}
check(`every one of ${String(count - 1)} objects sits at its xref offset`, offsetsOk);

let lengthsOk = true;
for (const match of raw.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
  const start = match.index + match[0].length;
  if (raw.slice(start + Number(match[1]), start + Number(match[1]) + 10) !== '\nendstream') lengthsOk = false;
}
check('every stream /Length is exact', lengthsOk);

const pageCount = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(raw)?.[1]);
check('90 lines paginate across more than one page', pageCount >= 2, String(pageCount));
check('the page tree lists exactly that many page objects', (raw.match(/\/Type \/Page \/Parent/g) ?? []).length === pageCount);
check('the number is on the page', raw.includes('(No. INV_2627-00007)'));
check('continuation pages repeat the number', raw.includes('(Tax Invoice INV_2627-00007 \\(continued\\))'));
check('the seller GSTIN is printed', raw.includes('(GSTIN 30AABCU9603R1ZM)'));
check('amounts use Indian grouping', raw.includes('(10,620.00)'));
check('every page is labelled n of N', Array.from({ length: pageCount }, (_, i) => raw.includes(`(Page ${String(i + 1)} of ${String(pageCount)})`)).every(Boolean));
check('no byte outside Latin-1 escaped the encoder', [...pdf].every((byte) => byte <= 255));

/* ------------------------------------------------------------------------ */
console.log('');
if (failures === 0) {
  console.log('All invoice document checks passed.');
} else {
  console.error(`${String(failures)} check(s) FAILED.`);
  process.exit(1);
}
