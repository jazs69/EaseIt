/**
 * Report -> CSV.
 *
 * ===========================================================================
 * Hand-rolled, because the correctness here is in the escaping, not the
 * iteration — and a CSV library would still need to be told the same things.
 *
 * Three rules, each one a real way spreadsheets mangle hotel data:
 *
 *   * **Quote anything containing a comma, quote, newline or edge whitespace**,
 *     doubling any embedded quote. A guest called `Smith, Jr.` otherwise
 *     becomes two columns and shifts every figure on the row one to the left.
 *   * **Money is written in major units with two decimals**, not paise. A
 *     finance team opening this in Excel is going to sum the column; handing
 *     them 1253897 for ₹12,538.97 produces a total a hundred times too large.
 *     This is the one place minor units are divided, and the result goes
 *     straight to text without ever being read back (CLAUDE.md section 3.4).
 *   * **A leading `=`, `+`, `-` or `@` is prefixed with a tab.** Excel treats
 *     those as formulas, so a booking code like `=SUM(A1)` would execute on
 *     open. That is CSV injection, and a report is exactly the file somebody
 *     opens without thinking about where it came from.
 * ===========================================================================
 */

import type { ReportColumn, ReportResponse, ReportRow } from '@repo/types';

const NEEDS_QUOTING = /[",\n\r]|^\s|\s$/;
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function escapeCell(value: string): string {
  const guarded = FORMULA_PREFIX.test(value) ? `\t${value}` : value;
  return NEEDS_QUOTING.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

function formatCell(
  value: string | number | null | undefined,
  kind: ReportColumn['kind'],
): string {
  if (value === null || value === undefined) return '';

  if (kind === 'money' && typeof value === 'number') {
    // Major units, fixed to 2. Divided once, rendered, never read back.
    return (value / 100).toFixed(2);
  }

  return String(value);
}

function rowToLine(row: ReportRow, columns: readonly ReportColumn[]): string {
  return columns
    .map((column) => escapeCell(formatCell(row[column.key], column.kind)))
    .join(',');
}

/**
 * The whole report as one CSV document.
 *
 * A string rather than a stream: the window is capped at 370 days and the
 * largest report here is one row per booking, so the biggest realistic
 * document is a few hundred kilobytes. Streaming would add backpressure
 * handling for no benefit at that size — and the window cap is what keeps
 * that true, so the two belong together.
 */
export function toCsv(report: ReportResponse): string {
  const lines: string[] = [];

  // A short preamble, because a CSV that leaves its property and window
  // implicit is a file nobody can identify three weeks later.
  lines.push(escapeCell(`${report.title} - ${report.propertyName} (${report.propertyCode})`));
  lines.push(
    escapeCell(
      `${report.startDate} to ${report.endDate} · amounts in ${report.currency}`,
    ),
  );
  lines.push('');

  lines.push(report.columns.map((column) => escapeCell(column.label)).join(','));
  for (const row of report.rows) {
    lines.push(rowToLine(row, report.columns));
  }

  if (report.totals !== null) {
    lines.push(rowToLine(report.totals, report.columns));
  }

  if (report.notes.length > 0) {
    lines.push('');
    // Caveats travel with the file. A number with a known approximation in it
    // should carry that approximation wherever it goes, including into a
    // spreadsheet somebody mails onward.
    for (const note of report.notes) {
      lines.push(escapeCell(`Note: ${note}`));
    }
  }

  return lines.join('\r\n');
}
