/**
 * Invoice numbering and rendering (FO-14). Pure functions: no Nest, no
 * database, no clock, so every rule here is unit-tested directly.
 *
 * ===========================================================================
 * The PDF is written by hand rather than through a library.
 *
 * CLAUDE.md section 6.4 asks for a reason before any new runtime dependency.
 * An invoice is text in a fixed layout: the PDF 1.4 subset needed for that —
 * the standard Helvetica and Courier fonts, text operators, a page tree and an
 * xref table — is about two hundred lines and has no moving parts. Amounts
 * are set in Courier, a monospaced font, so right-aligning a column is
 * arithmetic on the character count rather than a font-metrics table.
 *
 * The standard fonts speak WinAnsi, which is Latin-1 in the printable range.
 * Anything outside it is transliterated (dashes, quotes, the rupee sign as
 * "Rs.") or replaced by "?" rather than written as bytes the viewer would
 * misread.
 * ===========================================================================
 */

import { minorUnitExponent, type Invoice } from '@repo/types';

/* -------------------------------------------------------------------------- */
/*  Numbering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The Indian financial year a business date falls in: April to March.
 * `2026-10-19` -> `2026-27`; `2027-03-31` -> `2026-27`; `2027-04-01` -> `2027-28`.
 */
export function fiscalYearOf(businessDate: string): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(businessDate);
  if (match === null) throw new Error(`Not a business date: ${businessDate}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const start = month >= 4 ? year : year - 1;
  return `${String(start)}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * `INV_` + `2627` + `-` + five digits. Sixteen characters with the default
 * prefix, which is the GST rules' ceiling for an invoice number.
 */
export function invoiceNumber(prefix: string, fiscalYear: string, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error(`Bad sequence ${String(sequence)}`);
  const compact = `${fiscalYear.slice(2, 4)}${fiscalYear.slice(5, 7)}`;
  return `${prefix}${compact}-${String(sequence).padStart(5, '0')}`;
}

/* -------------------------------------------------------------------------- */
/*  Amounts                                                                    */
/* -------------------------------------------------------------------------- */

/** `123456` INR -> `1234.56`. Integer arithmetic only (section 3.4). */
export function decimalOf(amountMinor: number, currency: string): string {
  if (!Number.isInteger(amountMinor)) throw new Error('Amounts are integer minor units.');
  const exponent = minorUnitExponent(currency);
  const negative = amountMinor < 0;
  const digits = String(Math.abs(amountMinor)).padStart(exponent + 1, '0');
  const major = digits.slice(0, digits.length - exponent);
  const minor = digits.slice(digits.length - exponent);
  return `${negative ? '-' : ''}${major}${exponent > 0 ? `.${minor}` : ''}`;
}

/** `12345600` INR -> `1,23,456.00` (Indian grouping for INR, thousands otherwise). */
export function groupedOf(amountMinor: number, currency: string): string {
  const plain = decimalOf(amountMinor, currency);
  const negative = plain.startsWith('-');
  const [major = '0', minor] = (negative ? plain.slice(1) : plain).split('.');
  let grouped: string;
  if (currency === 'INR' && major.length > 3) {
    const head = major.slice(0, -3);
    grouped = `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${major.slice(-3)}`;
  } else {
    grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  return `${negative ? '-' : ''}${grouped}${minor === undefined ? '' : `.${minor}`}`;
}

/* -------------------------------------------------------------------------- */
/*  CSV                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One cell. Quoted when it must be; a text cell opening with `= + - @` (or a
 * tab or carriage return) is prefixed with `'` so a spreadsheet shows it
 * rather than evaluating it. Amounts are passed as `number`-like strings
 * through `amount()` and are never prefixed.
 */
export function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function renderInvoiceCsv(invoice: Invoice): string {
  const c = invoice.currency;
  const amount = (minor: number) => decimalOf(minor, c);
  const rows: string[][] = [];
  const text = (...cells: string[]) => rows.push(cells.map(csvCell));
  const mixed = (cells: { t: string; amount?: boolean }[]) =>
    rows.push(cells.map((cell) => (cell.amount === true ? cell.t : csvCell(cell.t))));

  text(invoice.title, invoice.number);
  text('Invoice date', invoice.invoiceDate);
  text('Financial year', invoice.fiscalYear);
  text('Currency', c);
  text('Seller', invoice.seller.legalName ?? invoice.seller.name, invoice.seller.gstin ?? '');
  text('Bill to', invoice.billTo.legalName ?? invoice.billTo.name, invoice.billTo.gstin ?? '');
  text('Booking', invoice.stay.bookingCode, invoice.stay.guestName);
  text('Stay', invoice.stay.arrivalDate, invoice.stay.departureDate, String(invoice.stay.nights));
  rows.push([]);
  text('Date', 'Description', 'Kind', 'Net', 'Tax rate %', 'Tax', 'Gross');
  for (const line of invoice.lines) {
    mixed([
      { t: line.date },
      { t: line.description },
      { t: line.kind },
      { t: amount(line.netMinor), amount: true },
      { t: line.taxRatePercent.toFixed(2), amount: true },
      { t: amount(line.taxMinor), amount: true },
      { t: amount(line.grossMinor), amount: true },
    ]);
  }
  rows.push([]);
  const t = invoice.totals;
  for (const [label, minor] of [
    ['Subtotal', t.subtotalMinor],
    ['CGST', t.cgstMinor],
    ['SGST', t.sgstMinor],
    ['Total tax', t.taxMinor],
    ['Total', t.totalMinor],
    ['Paid', t.paidMinor],
    ['Refunded', t.refundedMinor],
    ['Balance', t.balanceMinor],
  ] as const) {
    mixed([{ t: label }, { t: amount(minor), amount: true }]);
  }
  rows.push([]);
  text('Payment date', 'Kind', 'Method', 'Amount');
  for (const payment of invoice.payments) {
    mixed([
      { t: payment.date },
      { t: payment.kind },
      { t: payment.method ?? '' },
      { t: amount(payment.amountMinor), amount: true },
    ]);
  }
  return `${rows.map((row) => row.join(',')).join('\r\n')}\r\n`;
}

/* -------------------------------------------------------------------------- */
/*  PDF                                                                        */
/* -------------------------------------------------------------------------- */

type Font = 'F1' | 'F2' | 'F3'; // Helvetica, Helvetica-Bold, Courier

interface TextOp {
  x: number;
  y: number;
  size: number;
  font: Font;
  text: string;
}

const PAGE_WIDTH = 595; // A4, points
const PAGE_HEIGHT = 842;
const MARGIN = 40;
const RIGHT = PAGE_WIDTH - MARGIN;

const TRANSLITERATE: Record<string, string> = {
  '–': '-',
  '—': '-',
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '…': '...',
  '₹': 'Rs.',
  '·': '·',
};

/** Latin-1 printable text, safe inside a PDF literal string. */
export function pdfText(value: string): string {
  let out = '';
  for (const char of value) {
    const mapped = TRANSLITERATE[char] ?? char;
    for (const c of mapped) {
      const code = c.charCodeAt(0);
      const safe = (code >= 32 && code <= 126) || (code >= 160 && code <= 255) ? c : code < 32 ? ' ' : '?';
      out += safe === '\\' || safe === '(' || safe === ')' ? `\\${safe}` : safe;
    }
  }
  return out;
}

/** Courier is 600/1000 em wide for every glyph. */
function courierWidth(text: string, size: number): number {
  return text.length * 0.6 * size;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

export function renderInvoicePdf(invoice: Invoice): Buffer {
  const c = invoice.currency;
  const money = (minor: number) => groupedOf(minor, c);
  const pages: TextOp[][] = [];
  let ops: TextOp[] = [];
  let y = 0;

  const put = (x: number, size: number, font: Font, text: string) => {
    ops.push({ x, y, size, font, text });
  };
  const putRight = (right: number, size: number, text: string) => {
    ops.push({ x: right - courierWidth(text, size), y, size, font: 'F3', text });
  };

  // Headers over the amount columns end where the amounts end. Bold Helvetica
  // capitals average about 0.7 em; close enough to line a label up by eye.
  const headRight = (right: number, text: string) => {
    put(right - text.length * 0.7 * 8, 8, 'F2', text);
  };
  const tableHeader = () => {
    put(MARGIN, 8, 'F2', 'DATE');
    put(108, 8, 'F2', 'DESCRIPTION');
    headRight(370, 'NET');
    headRight(420, 'GST %');
    headRight(480, 'GST');
    headRight(RIGHT, 'AMOUNT');
    y -= 14;
  };

  const newPage = (continued: boolean) => {
    if (ops.length > 0) pages.push(ops);
    ops = [];
    y = PAGE_HEIGHT - MARGIN - 10;
    if (continued) {
      put(MARGIN, 10, 'F2', `${invoice.title} ${invoice.number} (continued)`);
      y -= 24;
      tableHeader();
    }
  };

  const ensure = (space: number) => {
    if (y - space < MARGIN + 30) newPage(true);
  };

  /* Header ---------------------------------------------------------------- */
  newPage(false);
  put(MARGIN, 18, 'F2', invoice.title);
  putRight(RIGHT, 10, `No. ${invoice.number}`);
  y -= 14;
  putRight(RIGHT, 10, `Date ${invoice.invoiceDate}`);
  y -= 12;
  putRight(RIGHT, 8, `Amounts in ${c}`);
  y -= 22;

  /* Parties --------------------------------------------------------------- */
  const top = y;
  const party = (x: number, heading: string, p: Invoice['seller']) => {
    y = top;
    put(x, 8, 'F2', heading);
    y -= 13;
    put(x, 10, 'F2', clip(p.legalName ?? p.name, 44));
    y -= 12;
    if (p.legalName !== null && p.legalName !== p.name) {
      put(x, 9, 'F1', clip(p.name, 50));
      y -= 11;
    }
    for (const line of p.addressLines) {
      put(x, 9, 'F1', clip(line, 50));
      y -= 11;
    }
    if (p.gstin !== null) {
      put(x, 9, 'F1', `GSTIN ${p.gstin}`);
      y -= 11;
    }
    for (const contact of [p.phone, p.email]) {
      if (contact !== null && contact !== '') {
        put(x, 9, 'F1', clip(contact, 50));
        y -= 11;
      }
    }
    return y;
  };
  const afterSeller = party(MARGIN, 'FROM', invoice.seller);
  const afterBuyer = party(320, 'BILL TO', invoice.billTo);
  y = Math.min(afterSeller, afterBuyer) - 12;

  const s = invoice.stay;
  put(MARGIN, 9, 'F1', clip(`Booking ${s.bookingCode} - guest ${s.guestName}`, 100));
  y -= 11;
  put(
    MARGIN,
    9,
    'F1',
    clip(
      `Stay ${s.arrivalDate} to ${s.departureDate}, ${String(s.nights)} night${s.nights === 1 ? '' : 's'} - ` +
        `room ${s.roomNumber ?? '-'} (${s.roomTypeName})`,
      100,
    ),
  );
  y -= 22;

  /* Lines ----------------------------------------------------------------- */
  tableHeader();
  for (const line of invoice.lines) {
    ensure(14);
    put(MARGIN, 8, 'F3', line.date);
    put(108, 8, 'F1', clip(line.description, 44));
    putRight(370, 8, money(line.netMinor));
    putRight(420, 8, line.taxRatePercent.toFixed(2));
    putRight(480, 8, money(line.taxMinor));
    putRight(RIGHT, 8, money(line.grossMinor));
    y -= 13;
  }

  /* Totals ---------------------------------------------------------------- */
  const t = invoice.totals;
  const totals: [string, number, boolean][] = [
    ['Subtotal', t.subtotalMinor, false],
    ...(t.taxMinor > 0
      ? ([
          ['CGST', t.cgstMinor, false],
          ['SGST', t.sgstMinor, false],
        ] as [string, number, boolean][])
      : []),
    ['Total', t.totalMinor, true],
    ['Paid', t.paidMinor, false],
    ...(t.refundedMinor > 0 ? ([['Refunded', t.refundedMinor, false]] as [string, number, boolean][]) : []),
    ['Balance', t.balanceMinor, true],
  ];
  ensure(totals.length * 14 + 20);
  y -= 8;
  for (const [label, minor, strong] of totals) {
    put(380, 9, strong ? 'F2' : 'F1', label);
    putRight(RIGHT, 9, money(minor));
    y -= 14;
  }

  /* Payments -------------------------------------------------------------- */
  if (invoice.payments.length > 0) {
    ensure(40);
    y -= 10;
    put(MARGIN, 8, 'F2', 'PAYMENTS');
    y -= 13;
    for (const payment of invoice.payments) {
      ensure(13);
      put(MARGIN, 8, 'F3', payment.date);
      put(108, 8, 'F1', `${payment.kind === 'REFUND' ? 'Refund' : 'Payment'} - ${payment.method ?? 'OTHER'}`);
      putRight(RIGHT, 8, `${payment.kind === 'REFUND' ? '-' : ''}${money(payment.amountMinor)}`);
      y -= 13;
    }
  }
  pages.push(ops);

  /* Footer on every page, then serialise ----------------------------------- */
  const footer = `${invoice.number} - issued ${invoice.issuedAt.slice(0, 16).replace('T', ' ')} UTC`;
  pages.forEach((page, index) => {
    page.push({ x: MARGIN, y: MARGIN - 10, size: 7, font: 'F1', text: footer });
    const label = `Page ${String(index + 1)} of ${String(pages.length)}`;
    page.push({ x: RIGHT - courierWidth(label, 7), y: MARGIN - 10, size: 7, font: 'F3', text: label });
  });

  return serialise(pages, invoice.number);
}

function serialise(pages: TextOp[][], title: string): Buffer {
  // Object numbers: 1 catalog, 2 pages, 3-5 fonts, 6 info, then a page and
  // its content stream per page.
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 7 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(' ')}] /Count ${String(pages.length)} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  objects[6] = `<< /Title (${pdfText(title)}) /Producer (EaseIt) >>`;

  pages.forEach((page, i) => {
    const pageId = 7 + i * 2;
    const contentId = pageId + 1;
    const stream = page
      .map(
        (op) =>
          `BT /${op.font} ${String(op.size)} Tf ${op.x.toFixed(2)} ${op.y.toFixed(2)} Td (${pdfText(op.text)}) Tj ET`,
      )
      .join('\n');
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(PAGE_WIDTH)} ${String(PAGE_HEIGHT)}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${String(contentId)} 0 R >>`;
    objects[contentId] =
      `<< /Length ${String(Buffer.byteLength(stream, 'latin1'))} >>\nstream\n${stream}\nendstream`;
  });

  // Latin-1 throughout, so every character is one byte and the xref offsets
  // are plain string lengths of what has been written so far.
  let out = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${String(id)} 0 obj\n${objects[id] ?? 'null'}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${String(objects.length)}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    out += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${String(objects.length)} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
