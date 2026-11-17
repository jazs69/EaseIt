/** IE-01/IE-02: the CSV reader and writer. */

import { describe, expect, it } from 'vitest';

import { parseCsv, writeCsv } from './csv.js';

const COLS = ['code', 'name', 'maxGuests'];

describe('parseCsv', () => {
  it('reads quoted fields with commas, quotes and newlines; keeps line numbers', () => {
    const text =
      'code,name,maxGuests\r\nDLX,"Deluxe, ""sea"" view",2\r\n\r\nSTE,"Suite\nwith loft",4\r\n';
    const parsed = parseCsv(text, COLS, COLS, 100);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows.map((r) => [r.line, r.cells.get('name')])).toEqual([
      [2, 'Deluxe, "sea" view'],
      [4, 'Suite\nwith loft'],
    ]);
  });

  it('accepts a byte-order mark and headers in any case and order', () => {
    const parsed = parseCsv('﻿MAXGUESTS,Code,name\n3,std,Standard\n', COLS, COLS, 100);
    expect(parsed.ok && parsed.rows[0]?.cells.get('code')).toBe('std');
  });

  it('refuses an unknown or repeated column, a missing one, an unclosed quote, too many fields', () => {
    expect(parseCsv('code,nmae,maxGuests\n', COLS, COLS, 10)).toMatchObject({
      ok: false,
      error: expect.stringContaining('Unknown column "nmae"'),
    });
    expect(parseCsv('code,code\n', COLS, ['code'], 10)).toMatchObject({
      ok: false,
      error: expect.stringContaining('appears twice'),
    });
    expect(parseCsv('code,name\n', COLS, COLS, 10)).toMatchObject({
      ok: false,
      error: expect.stringContaining('Missing column: maxGuests'),
    });
    expect(parseCsv('code,name,maxGuests\nA,"open,2\n', COLS, COLS, 10)).toMatchObject({
      ok: false,
      error: expect.stringContaining('line 2 is never closed'),
    });
    expect(parseCsv('code,name,maxGuests\nA,Deluxe, sea,2\n', COLS, COLS, 10)).toMatchObject({
      ok: false,
      error: expect.stringContaining('Line 2 has 4 fields'),
    });
  });

  it('refuses more rows than the cap, and an empty document', () => {
    expect(parseCsv('code\na\nb\nc\n', COLS, ['code'], 2)).toMatchObject({ ok: false });
    expect(parseCsv(' \n\n', COLS, ['code'], 2)).toMatchObject({
      ok: false,
      error: 'The document is empty.',
    });
  });
});

describe('writeCsv', () => {
  it('quotes and neutralises formulas, and reads back to the same values', () => {
    const csv = writeCsv(COLS, [
      ['=CMD()', 'Deluxe, "sea"', 2],
      ['-5', null, undefined],
    ]);
    expect(csv).toContain('\t=CMD()');
    const parsed = parseCsv(csv, COLS, COLS, 10);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows.map((r) => [...r.cells.values()])).toEqual([
      ['=CMD()', 'Deluxe, "sea"', '2'],
      ['-5', '', ''],
    ]);
  });
});
