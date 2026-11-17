/**
 * CSV in and out for IE-01/IE-02. Hand-rolled, like `report-csv.ts`: the
 * correctness is in the quoting rules, and a library would need telling them.
 *
 * ===========================================================================
 * PARSING (RFC 4180, as spreadsheets actually write it):
 *   * fields split on commas; a field in double quotes may contain commas,
 *     newlines and doubled quotes;
 *   * CRLF or LF line ends; a UTF-8 byte-order mark is dropped (Excel adds one);
 *   * every cell is trimmed, which also removes the tab our own export puts in
 *     front of a formula-looking value, so an export imports back unchanged;
 *   * blank lines are skipped, but keep their line numbers, so an error names
 *     the line the operator sees in their editor;
 *   * the header row names the columns, case-insensitively, in any order; an
 *     unknown column is refused rather than ignored, because a typo in a
 *     header ("maxguest") would otherwise silently drop a whole column.
 *
 * WRITING: quote on comma, quote, newline or edge whitespace; neutralise a
 * leading `=`, `+`, `-`, `@` (CSV injection) with a tab — the same rules as
 * the report export.
 * ===========================================================================
 */

export type CsvRow = { line: number; cells: Map<string, string> };

export type CsvParse =
  { ok: true; header: string[]; rows: CsvRow[] } | { ok: false; error: string };

/** Split a document into records of raw fields, with each record's first line. */
function records(text: string): { line: number; fields: string[] }[] {
  const out: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const endRecord = (): void => {
    fields.push(field);
    out.push({ line: recordLine, fields });
    fields = [];
    field = '';
  };

  for (; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (c === '\n') line += 1;
        field += c;
      }
      continue;
    }
    if (c === '"' && field.trim() === '') {
      field = '';
      quoted = true;
    } else if (c === ',') {
      fields.push(field);
      field = '';
    } else if (c === '\r') {
      // CR of a CRLF is dropped; a bare CR is treated as a line end.
      if (text[i + 1] !== '\n') {
        endRecord();
        line += 1;
        recordLine = line;
      }
    } else if (c === '\n') {
      endRecord();
      line += 1;
      recordLine = line;
    } else {
      field += c;
    }
  }
  if (quoted) {
    out.push({ line: -recordLine, fields: [] });
    return out;
  }
  if (field !== '' || fields.length > 0) endRecord();
  return out;
}

/**
 * Parse with a header, checking the columns against `allowed`. `required`
 * columns must be present in the header (a cell may still be empty).
 */
export function parseCsv(
  text: string,
  allowed: readonly string[],
  required: readonly string[],
  maxRows: number,
): CsvParse {
  const all = records(text);
  const broken = all.find((r) => r.line < 0);
  if (broken)
    return {
      ok: false,
      error: `A quoted field starting on line ${String(-broken.line)} is never closed.`,
    };

  const nonBlank = all.filter((r) => r.fields.some((f) => f.trim() !== ''));
  const head = nonBlank[0];
  if (head === undefined) return { ok: false, error: 'The document is empty.' };

  const header = head.fields.map((f) => f.trim());
  const canonical = new Map(allowed.map((name) => [name.toLowerCase(), name]));
  const columns: string[] = [];
  for (const name of header) {
    const known = canonical.get(name.toLowerCase());
    if (known === undefined) {
      return { ok: false, error: `Unknown column "${name}". Expected: ${allowed.join(', ')}.` };
    }
    if (columns.includes(known)) return { ok: false, error: `Column "${known}" appears twice.` };
    columns.push(known);
  }
  const missing = required.filter((name) => !columns.includes(name));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`,
    };
  }

  const body = nonBlank.slice(1);
  if (body.length > maxRows) {
    return {
      ok: false,
      error: `At most ${String(maxRows)} rows per document; this one has ${String(body.length)}.`,
    };
  }

  const rows: CsvRow[] = [];
  for (const record of body) {
    if (record.fields.length > columns.length) {
      return {
        ok: false,
        error: `Line ${String(record.line)} has ${String(record.fields.length)} fields but the header has ${String(columns.length)}. Quote values that contain commas.`,
      };
    }
    const cells = new Map<string, string>();
    columns.forEach((name, index) => cells.set(name, (record.fields[index] ?? '').trim()));
    rows.push({ line: record.line, cells });
  }
  return { ok: true, header: columns, rows };
}

/* --------------------------------------------------------------- write -- */

const NEEDS_QUOTING = /[",\n\r]|^\s|\s$/;
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function escapeCell(value: string): string {
  const guarded = FORMULA_PREFIX.test(value) ? `\t${value}` : value;
  return NEEDS_QUOTING.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** Header plus rows; `null`/`undefined` become empty cells. CRLF, as Excel expects. */
export function writeCsv(
  columns: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  const line = (cells: readonly (string | number | null | undefined)[]): string =>
    cells
      .map((cell) => (cell === null || cell === undefined ? '' : escapeCell(String(cell))))
      .join(',');
  return [line(columns), ...rows.map(line)].join('\r\n') + '\r\n';
}
