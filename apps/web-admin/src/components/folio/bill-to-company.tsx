'use client';

/**
 * "Bill to company" on the folio (GP-07): move the balance onto the stay's
 * company account, so the folio settles and the company is invoiced and owes it.
 *
 * Shown only for a stay attached to a company. The server re-checks every
 * condition under the folio lock (company, open folio, amount within the
 * balance, `direct_billing:manage`). The idempotency key is minted once per
 * opened panel, so a retry after a lost response cannot bill twice.
 */

import { Building2, Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { FolioPage } from '@repo/types';

import { ApiRequestError, ApiUnreachableError } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { billFolioToCompany } from '@/lib/properties-client';

function messageOf(cause: unknown): string {
  if (cause instanceof ApiRequestError) {
    if (cause.status === 403)
      return 'Your role cannot bill to a company (needs direct_billing:manage).';
    const issues = (cause.details as { issues?: Record<string, string> } | undefined)?.issues;
    const first = issues === undefined ? undefined : Object.values(issues)[0];
    return first ?? cause.message;
  }
  if (cause instanceof ApiUnreachableError) {
    return 'The server could not be reached. Try again: the same request cannot bill twice.';
  }
  return 'Something went wrong. Try again: the same request cannot bill twice.';
}

const pill =
  'flex shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.08] px-2.5 py-1.5 text-[11px] font-semibold tracking-wider uppercase transition-colors';

export function BillToCompany({
  hotelId,
  folio,
  onBilled,
}: {
  hotelId: string;
  folio: FolioPage;
  onBilled: (page: FolioPage) => void;
}) {
  const company = folio.reservation.company;
  const balance = folio.totals.balanceDueMinor;
  const currency = folio.totals.currency;
  const open = folio.folioId !== null && folio.folioStatus === 'OPEN';
  const [panel, setPanel] = useState<{ key: string; amount: string; remark: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (company === null) return null;

  const usable = open && balance > 0;
  const reason = !open ? 'The folio is not open' : 'Nothing is owed on this folio';

  async function submit(): Promise<void> {
    if (panel === null || folio.folioId === null) return;
    const amountMinor = Math.round(Number(panel.amount) * 100);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      setError('Enter an amount above zero.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const page = await billFolioToCompany(hotelId, folio.folioId, {
        amountMinor,
        remark: panel.remark.trim() === '' ? null : panel.remark.trim(),
        idempotencyKey: panel.key,
      });
      setPanel(null);
      onBilled(page);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        disabled={!usable}
        title={usable ? `Bill the balance to ${company.name}` : reason}
        onClick={() => {
          setError(null);
          setPanel({ key: crypto.randomUUID(), amount: (balance / 100).toFixed(2), remark: '' });
        }}
        className={
          usable
            ? `${pill} text-zinc-200 hover:border-white/25 hover:bg-white/[0.04]`
            : `${pill} cursor-not-allowed text-zinc-500 opacity-60`
        }
      >
        <Building2 className="size-3.5" aria-hidden="true" />
        Bill to company
      </button>
      {panel === null ? null : (
        <div
          role="dialog"
          aria-label="Bill to company"
          className="absolute top-full right-0 z-30 mt-2 flex w-80 flex-col gap-3 rounded-xl border border-white/10 bg-zinc-950 p-4 text-xs text-zinc-300 shadow-xl"
        >
          <p>
            Moves the amount onto <span className="font-medium text-white">{company.name}</span>
            &apos;s account. The folio is settled by it; the company owes it and is invoiced.
            Balance due: {formatMoney(balance, currency)}.
          </p>
          <label className="flex flex-col gap-1">
            Amount ({currency})
            <input
              inputMode="decimal"
              value={panel.amount}
              onChange={(event) => setPanel({ ...panel, amount: event.target.value })}
              className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-white focus:border-white/25 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            Remark (optional)
            <input
              value={panel.remark}
              maxLength={200}
              onChange={(event) => setPanel({ ...panel, remark: event.target.value })}
              className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-white focus:border-white/25 focus:outline-none"
            />
          </label>
          {error === null ? null : (
            <p role="alert" className="text-rose-300">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPanel(null)}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-zinc-300 hover:border-white/25"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-500 disabled:opacity-60"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
              Bill to company
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
