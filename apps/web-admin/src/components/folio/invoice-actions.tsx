'use client';

/**
 * The folio's invoice (FO-14): issue it once the folio is closed, then
 * download it as PDF or CSV.
 *
 * Issuing is offered only for a closed folio, because that is the only state
 * the server accepts: a closed folio is settled at zero and can no longer
 * change. Downloads go through `fetch` with the session cookie and are saved
 * from an object URL, so the file never sits behind a public link.
 */

import { cn } from '@repo/ui';
import { FileDown, FileText, Loader2, Receipt } from 'lucide-react';
import { useState } from 'react';
import type { InvoiceRef } from '@repo/types';

import { ApiRequestError, ApiUnreachableError } from '@/lib/api';
import { downloadInvoice, issueInvoice } from '@/lib/properties-client';

function messageOf(cause: unknown): string {
  if (cause instanceof ApiRequestError) {
    if (cause.status === 403) return 'Your role cannot do this (needs folio:settle to issue, folio:read to download).';
    const issues = (cause.details as { issues?: Record<string, string> } | undefined)?.issues;
    const first = issues === undefined ? undefined : Object.values(issues)[0];
    return first ?? cause.message;
  }
  if (cause instanceof ApiUnreachableError) return 'The server could not be reached. Nothing was changed.';
  return 'Something went wrong. Nothing was changed.';
}

function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Not revoked at once: with "ask where to save" on, Chrome is still holding
  // the download behind its Save dialog and needs the URL until it finishes.
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

const pill =
  'flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold tracking-wider uppercase transition-colors';

export function InvoiceActions({
  hotelId,
  folioId,
  folioClosed,
  invoice,
  onIssued,
}: {
  hotelId: string;
  folioId: string | null;
  folioClosed: boolean;
  invoice: InvoiceRef | null;
  onIssued: () => void;
}) {
  const [busy, setBusy] = useState<'issue' | 'pdf' | 'csv' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function issue(): Promise<void> {
    if (folioId === null) return;
    setBusy('issue');
    setError(null);
    try {
      await issueInvoice(hotelId, folioId);
      onIssued();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  async function download(format: 'pdf' | 'csv'): Promise<void> {
    if (invoice === null) return;
    setBusy(format);
    setError(null);
    try {
      const blob = await downloadInvoice(hotelId, invoice.id, format);
      save(blob, `${invoice.number.replace(/[^A-Za-z0-9_-]/g, '_')}.${format}`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  const spinner = <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />;

  return (
    <>
      {invoice === null ? (
        <button
          type="button"
          disabled={!folioClosed || folioId === null || busy !== null}
          onClick={() => {
            void issue();
          }}
          title={folioClosed ? 'Issue the numbered invoice for this settled folio' : 'An invoice is issued once the folio is closed'}
          className={cn(
            pill,
            folioClosed && folioId !== null
              ? 'border-sky-500/30 text-sky-200 hover:bg-sky-500/10'
              : 'cursor-not-allowed border-white/[0.08] text-zinc-500 opacity-60',
          )}
        >
          {busy === 'issue' ? spinner : <Receipt className="size-3.5" aria-hidden="true" />}
          Issue invoice
        </button>
      ) : (
        <>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              void download('pdf');
            }}
            title={`Download invoice ${invoice.number} as PDF`}
            className={cn(pill, 'border-sky-500/30 text-sky-200 hover:bg-sky-500/10')}
          >
            {busy === 'pdf' ? spinner : <FileDown className="size-3.5" aria-hidden="true" />}
            {invoice.number}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              void download('csv');
            }}
            title={`Download invoice ${invoice.number} as CSV`}
            className={cn(pill, 'border-white/[0.08] text-zinc-200 hover:border-white/25 hover:bg-white/[0.04]')}
          >
            {busy === 'csv' ? spinner : <FileText className="size-3.5" aria-hidden="true" />}
            CSV
          </button>
        </>
      )}
      {error !== null ? (
        <span role="alert" className="flex shrink-0 items-center px-1 text-[11px] text-rose-300">
          {error}
        </span>
      ) : null}
    </>
  );
}
