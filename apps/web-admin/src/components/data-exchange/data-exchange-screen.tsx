'use client';

/**
 * Import & export (IE-01, IE-02).
 *
 * Import: choose up to three CSV files, Check (a dry run that writes
 * nothing), read every row's outcome, then Import — which sends the dry run's
 * digest, so exactly the checked files are written, all or nothing. Choosing
 * a different file clears the check.
 *
 * Export: one dataset at a time, as a CSV download. The configuration
 * exports are in the import's own columns, so they double as templates.
 */

import { cn } from '@repo/ui';
import { Download, FileUp, Loader2, ShieldCheck, Upload } from 'lucide-react';
import { useState } from 'react';
import type { ExportDataset, ImportDocument, ImportResult } from '@repo/types';

import { ApiRequestError, ApiUnreachableError } from '@/lib/api';
import { downloadExport, runImport } from '@/lib/properties-client';

const FIELD =
  'rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-zinc-200 focus:border-white/20 focus:outline-none';
const BUTTON =
  'inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40';

function messageOf(cause: unknown): string {
  if (cause instanceof ApiRequestError) {
    if (cause.status === 403) return 'Your role cannot do this here.';
    const details = cause.details as { issues?: Record<string, string> } | undefined;
    if (details?.issues !== undefined) {
      return Object.entries(details.issues)
        .map(([where, what]) => `${where}: ${what}`)
        .join(' · ');
    }
    return cause.message;
  }
  if (cause instanceof ApiUnreachableError)
    return 'The server could not be reached. Nothing was changed.';
  return 'Something went wrong. Nothing was changed.';
}

const DOCUMENTS: {
  key: ImportDocument;
  label: string;
  columns: string;
  dataset: ExportDataset;
  needs: 'rooms' | 'rates';
}[] = [
  {
    key: 'roomTypes',
    label: 'Room types',
    columns: 'code, name, maxGuests, maxAdults, baseRate, sortOrder, description',
    dataset: 'room-types',
    needs: 'rooms',
  },
  {
    key: 'rooms',
    label: 'Rooms',
    columns: 'number, roomTypeCode, floor, notes',
    dataset: 'rooms',
    needs: 'rooms',
  },
  {
    key: 'rates',
    label: 'Rates',
    columns:
      'ratePlanCode, roomTypeCode, fromDate, toDate, amount (empty dates = the default rate)',
    dataset: 'rates',
    needs: 'rates',
  },
];

const DATASETS: {
  key: ExportDataset;
  label: string;
  window: 'none' | 'optional' | 'required';
  personal: boolean;
}[] = [
  { key: 'room-types', label: 'Room types', window: 'none', personal: false },
  { key: 'rooms', label: 'Rooms', window: 'none', personal: false },
  { key: 'rates', label: 'Rates (default: the coming year)', window: 'optional', personal: false },
  {
    key: 'reservations',
    label: 'Reservations (by arrival date)',
    window: 'required',
    personal: true,
  },
  {
    key: 'folio-lines',
    label: 'Folio lines (by charge date)',
    window: 'required',
    personal: false,
  },
  { key: 'guests', label: 'Guest profiles', window: 'none', personal: true },
];

const OUTCOME_TONE: Record<string, string> = {
  CREATE: 'text-emerald-300',
  UPDATE: 'text-sky-300',
  UNCHANGED: 'text-zinc-400',
  ERROR: 'text-rose-300',
};

function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function DataExchangeScreen({
  hotelId,
  canRooms,
  canRates,
  canExport,
}: {
  hotelId: string;
  canRooms: boolean;
  canRates: boolean;
  canExport: boolean;
}) {
  const [docs, setDocs] = useState<Partial<Record<ImportDocument, { name: string; text: string }>>>(
    {},
  );
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<'check' | 'commit' | 'export' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<ImportResult | null>(null);

  const [dataset, setDataset] = useState<ExportDataset>('room-types');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const allowed = DOCUMENTS.filter((d) => (d.needs === 'rooms' ? canRooms : canRates));
  const payload = () =>
    Object.fromEntries(Object.entries(docs).map(([key, value]) => [key, value.text]));
  const hasDocs = Object.keys(docs).length > 0;

  async function choose(key: ImportDocument, file: File | undefined) {
    setResult(null);
    setCommitted(null);
    setError(null);
    if (file === undefined) {
      setDocs(({ [key]: _gone, ...rest }) => rest);
      return;
    }
    const text = await file.text();
    setDocs((current) => ({ ...current, [key]: { name: file.name, text } }));
  }

  async function check() {
    setBusy('check');
    setError(null);
    setCommitted(null);
    try {
      setResult(await runImport(hotelId, { mode: 'DRY_RUN', ...payload() }));
    } catch (cause) {
      setResult(null);
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (result === null) return;
    setBusy('commit');
    setError(null);
    try {
      const done = await runImport(hotelId, {
        mode: 'COMMIT',
        digest: result.digest,
        ...payload(),
      });
      setCommitted(done);
      setResult(null);
      setDocs({});
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  async function download(which: ExportDataset, withWindow: boolean) {
    setBusy('export');
    setError(null);
    try {
      const range =
        withWindow && fromDate !== '' && toDate !== '' ? { fromDate, toDate } : undefined;
      const blob = await downloadExport(hotelId, which, range);
      save(blob, `${hotelId}-${which}${range ? `-${range.fromDate}-to-${range.toDate}` : ''}.csv`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  const chosen = DATASETS.find((d) => d.key === dataset);
  const windowMissing = chosen?.window === 'required' && (fromDate === '' || toDate === '');

  return (
    <div className="flex flex-col gap-6">
      {error !== null && (
        <p
          role="alert"
          className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
        >
          {error}
        </p>
      )}

      {allowed.length > 0 && (
        <section className="flex flex-col gap-4 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
          <div className="flex items-center gap-2">
            <FileUp className="size-4 text-zinc-400" aria-hidden />
            <h2 className="text-sm font-semibold text-zinc-100">Import from CSV</h2>
          </div>
          <p className="text-xs text-zinc-400">
            Amounts in rupees as you would write them (3500 or 3500.00). Rows are matched by code or
            room number: new ones are created, existing ones updated. Rooms cannot change category
            here, and retired ones are refused.
          </p>

          <div className="grid gap-3 md:grid-cols-3">
            {allowed.map((doc) => (
              <label
                key={doc.key}
                className="flex flex-col gap-1.5 rounded-xl border border-white/[0.06] p-3"
              >
                <span className="text-xs font-medium text-zinc-200">{doc.label}</span>
                <span className="text-[11px] text-zinc-500">{doc.columns}</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="text-[11px] text-zinc-300 file:mr-2 file:rounded-md file:border-0 file:bg-white/10 file:px-2 file:py-1 file:text-zinc-200"
                  onChange={(event) => void choose(doc.key, event.target.files?.[0])}
                />
                {docs[doc.key] !== undefined && (
                  <span className="truncate text-[11px] text-zinc-400">{docs[doc.key]?.name}</span>
                )}
                {canExport && (
                  <button
                    type="button"
                    className="self-start text-[11px] text-sky-300 hover:underline"
                    onClick={() => void download(doc.dataset, false)}
                  >
                    Download current {doc.label.toLowerCase()} as a template
                  </button>
                )}
              </label>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={!hasDocs || busy !== null}
              onClick={() => void check()}
            >
              {busy === 'check' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="size-3.5" />
              )}
              Check (writes nothing)
            </button>
            <button
              type="button"
              className={cn(BUTTON, 'border-emerald-500/30 text-emerald-200')}
              disabled={result === null || !result.valid || busy !== null}
              onClick={() => void commit()}
            >
              {busy === 'commit' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5" />
              )}
              Import checked files
            </button>
            {result !== null && !result.valid && (
              <span className="text-xs text-rose-300">
                Fix the rows marked ERROR and check again. Nothing has been written.
              </span>
            )}
          </div>

          {committed !== null && (
            <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
              Imported. {summary(committed)}
            </p>
          )}
          {(result ?? committed)?.notes.map((note) => (
            <p key={note} className="text-xs text-amber-200">
              {note}
            </p>
          ))}

          {result !== null && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-zinc-300">Check result: {summary(result)}</p>
              {result.rows.length > 0 && (
                <div className="max-h-96 overflow-auto rounded-xl border border-white/[0.06]">
                  <table className="w-full text-left text-[11px]">
                    <thead className="sticky top-0 bg-[#0f141f] text-zinc-500">
                      <tr>
                        <th className="px-3 py-1.5 font-medium">File</th>
                        <th className="px-3 py-1.5 font-medium">Line</th>
                        <th className="px-3 py-1.5 font-medium">Row</th>
                        <th className="px-3 py-1.5 font-medium">Outcome</th>
                        <th className="px-3 py-1.5 font-medium">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row) => (
                        <tr
                          key={`${row.document}-${String(row.line)}-${row.key}`}
                          className="border-t border-white/[0.04]"
                        >
                          <td className="px-3 py-1.5 text-zinc-400">
                            {DOCUMENTS.find((d) => d.key === row.document)?.label}
                          </td>
                          <td className="px-3 py-1.5 text-zinc-400">{row.line}</td>
                          <td className="px-3 py-1.5 text-zinc-200">{row.key}</td>
                          <td className={cn('px-3 py-1.5 font-medium', OUTCOME_TONE[row.outcome])}>
                            {row.outcome}
                          </td>
                          <td className="px-3 py-1.5 text-zinc-300">{row.messages.join(' ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {canExport && (
        <section className="flex flex-col gap-4 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
          <div className="flex items-center gap-2">
            <Download className="size-4 text-zinc-400" aria-hidden />
            <h2 className="text-sm font-semibold text-zinc-100">Export as CSV</h2>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
              Data
              <select
                className={FIELD}
                value={dataset}
                onChange={(event) => setDataset(event.target.value as ExportDataset)}
              >
                {DATASETS.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            {chosen?.window !== 'none' && (
              <>
                <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                  From
                  <input
                    type="date"
                    className={FIELD}
                    value={fromDate}
                    onChange={(event) => setFromDate(event.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                  To
                  <input
                    type="date"
                    className={FIELD}
                    value={toDate}
                    onChange={(event) => setToDate(event.target.value)}
                  />
                </label>
              </>
            )}
            <button
              type="button"
              className={BUTTON}
              disabled={busy !== null || windowMissing}
              onClick={() => void download(dataset, true)}
            >
              {busy === 'export' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              Download
            </button>
          </div>
          <p className="text-[11px] text-zinc-500">
            {chosen?.personal === true
              ? 'This file contains guest personal data. Store and share it accordingly. '
              : ''}
            Every export is recorded in the audit log. Ranges may span up to 370 days.
          </p>
        </section>
      )}
    </div>
  );
}

function summary(result: ImportResult): string {
  const part = (label: string, c: ImportResult['counts']['rooms']) =>
    `${label}: ${String(c.create)} new, ${String(c.update)} changed, ${String(c.unchanged)} unchanged${c.error > 0 ? `, ${String(c.error)} with errors` : ''}`;
  return [
    part('room types', result.counts.roomTypes),
    part('rooms', result.counts.rooms),
    part('rates', result.counts.rates),
  ].join(' · ');
}
