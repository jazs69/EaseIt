'use client';

/**
 * Payments (FO-16): the money taken and returned at this property in a
 * window, by method; recent Razorpay payment links; and the gateway switch
 * (FO-15).
 *
 * Every figure is the server's, summed from folio lines. Money billed to a
 * company account is listed but not counted as received. The gateway toggle
 * is offered only with `property:settings`, which the server enforces anyway.
 */

import { cn } from '@repo/ui';
import { Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import {
  STORED_PAYMENT_METHOD_LABELS,
  type PaymentLink,
  type PaymentsOverview,
  type StoredPaymentMethod,
} from '@repo/types';

import { ApiRequestError, ApiUnreachableError } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import {
  fetchPaymentsOverview,
  refreshPaymentLink,
  setPaymentGateway,
} from '@/lib/properties-client';

const FIELD =
  'rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-zinc-200 focus:border-white/20 focus:outline-none';

function messageOf(cause: unknown): string {
  if (cause instanceof ApiRequestError) {
    if (cause.status === 403) return 'Your role cannot do this here.';
    const issues = (cause.details as { issues?: Record<string, string> } | undefined)?.issues;
    const first = issues === undefined ? undefined : Object.values(issues)[0];
    return first ?? cause.message;
  }
  if (cause instanceof ApiUnreachableError) return 'The server could not be reached.';
  return 'Something went wrong.';
}

const LINK_STATUS: Record<PaymentLink['status'], string> = {
  CREATING: 'Creating',
  ACTIVE: 'Awaiting payment',
  PARTIALLY_PAID: 'Partly paid',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  FAILED: 'Not sent',
  NEEDS_ATTENTION: 'Needs attention',
};

function methodLabel(method: string): string {
  return method in STORED_PAYMENT_METHOD_LABELS
    ? STORED_PAYMENT_METHOD_LABELS[method as StoredPaymentMethod]
    : method;
}

export function PaymentsScreen({
  hotelId,
  initial,
  canConfigure,
}: {
  hotelId: string;
  initial: PaymentsOverview;
  canConfigure: boolean;
}) {
  const [data, setData] = useState(initial);
  const [from, setFrom] = useState<string>(initial.from);
  const [to, setTo] = useState<string>(initial.to);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const money = (minor: number) => formatMoney(minor, data.currency);
  const gateway = data.gateway;

  async function run(label: string, work: () => Promise<void>): Promise<void> {
    setBusy(label);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  const reload = (window: { from?: string; to?: string }) =>
    run('load', async () => {
      const next = await fetchPaymentsOverview(hotelId, window);
      setData(next);
      setFrom(next.from);
      setTo(next.to);
    });

  return (
    <div className="flex flex-col gap-5">
      {/* ---- Gateway --------------------------------------------------- */}
      <section
        aria-label="Payment gateway"
        className={cn(
          'flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-xs',
          gateway.canSendLinks
            ? 'border-emerald-400/20 bg-emerald-500/[0.06] text-emerald-200'
            : 'border-white/[0.08] bg-white/[0.03] text-zinc-300',
        )}
      >
        <span className="font-semibold">
          Razorpay {gateway.mode === null ? '' : `(${gateway.mode} mode)`}
        </span>
        <span>
          {gateway.canSendLinks
            ? 'Payment links can be sent from folios at this property.'
            : gateway.reason}
        </span>
        {gateway.configured && !gateway.webhookConfigured ? (
          <span className="text-amber-300">
            No webhook secret: payments post only when someone presses &ldquo;Check payment&rdquo;.
          </span>
        ) : null}
        {canConfigure && gateway.configured ? (
          <button
            type="button"
            disabled={busy === 'gateway'}
            onClick={() =>
              void run('gateway', async () => {
                const next = await setPaymentGateway(
                  hotelId,
                  gateway.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                );
                setData({ ...data, gateway: next });
              })
            }
            className="ml-auto rounded-lg border border-white/15 px-3 py-1.5 text-zinc-100 hover:border-white/30 disabled:opacity-60"
          >
            {gateway.status === 'ACTIVE' ? 'Switch off' : 'Switch on for this property'}
          </button>
        ) : null}
      </section>

      {error === null ? null : (
        <p
          role="alert"
          className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
        >
          {error}
        </p>
      )}

      {/* ---- Window and totals ------------------------------------------- */}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void reload({ from, to });
        }}
      >
        <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={FIELD}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
          To
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={FIELD}
            required
          />
        </label>
        <button
          type="submit"
          disabled={busy === 'load'}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-60"
        >
          {busy === 'load' ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : null}
          Show
        </button>
      </form>

      <section aria-label="Totals" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['Received', data.totals.receivedMinor],
          ['Refunded', data.totals.refundedMinor],
          ['Net', data.totals.netMinor],
        ].map(([label, value]) => (
          <div
            key={String(label)}
            className="flex flex-col gap-1 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3"
          >
            <span className="text-[11px] tracking-wide text-zinc-500 uppercase">{label}</span>
            <span className="tabular text-lg font-semibold text-white">{money(Number(value))}</span>
          </div>
        ))}
        <div className="flex flex-col gap-1 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-xs">
          <span className="text-[11px] tracking-wide text-zinc-500 uppercase">By method (net)</span>
          {Object.keys(data.totals.byMethod).length === 0 ? (
            <span className="text-zinc-500">—</span>
          ) : (
            Object.entries(data.totals.byMethod).map(([method, value]) => (
              <span key={method} className="tabular flex justify-between gap-3 text-zinc-300">
                <span>{methodLabel(method)}</span>
                <span>{money(value)}</span>
              </span>
            ))
          )}
        </div>
      </section>

      {/* ---- Entries ------------------------------------------------------ */}
      <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
        <table className="w-full min-w-[48rem] text-left text-xs">
          <thead className="bg-white/[0.03] text-[11px] tracking-wide text-zinc-500 uppercase">
            <tr>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Booking</th>
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 font-medium">Method</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="px-3 py-2 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">
            {data.entries.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                  No payments or refunds in this window.
                </td>
              </tr>
            ) : (
              data.entries.map((entry) => (
                <tr key={entry.lineId} className="tabular text-zinc-300">
                  <td className="px-3 py-2">{entry.date}</td>
                  <td className="px-3 py-2 font-mono text-zinc-200">{entry.bookingCode}</td>
                  <td className="px-3 py-2">{entry.kind === 'PAYMENT' ? 'Payment' : 'Refund'}</td>
                  <td className="px-3 py-2">
                    {entry.method === null ? '—' : methodLabel(entry.method)}
                    {entry.viaGateway ? (
                      <span className="ml-1.5 text-[10px] text-sky-300">online</span>
                    ) : null}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right',
                      entry.amountMinor < 0 ? 'text-rose-300' : 'text-white',
                    )}
                  >
                    {money(entry.amountMinor)}
                  </td>
                  <td className="px-3 py-2 text-zinc-500">
                    {[entry.cardLast4 === null ? null : `•••• ${entry.cardLast4}`, entry.remark]
                      .filter((part) => part !== null && part !== '')
                      .join(' · ')}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ---- Links -------------------------------------------------------- */}
      <section aria-label="Payment links" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-white">Recent payment links</h2>
        {data.links.length === 0 ? (
          <p className="text-xs text-zinc-500">
            None yet. Send one from a folio (&ldquo;Payment link&rdquo;).
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-white/[0.05] rounded-xl border border-white/[0.08]">
            {data.links.map((link) => (
              <li
                key={link.id}
                className="tabular flex flex-wrap items-center gap-3 px-3 py-2 text-xs"
              >
                <span className="font-mono text-zinc-200">{link.bookingCode}</span>
                <span className="text-white">{formatMoney(link.amountMinor, link.currency)}</span>
                <span
                  className={
                    link.status === 'PAID'
                      ? 'text-emerald-300'
                      : link.status === 'NEEDS_ATTENTION' || link.status === 'FAILED'
                        ? 'text-rose-300'
                        : 'text-zinc-400'
                  }
                >
                  {LINK_STATUS[link.status]}
                </span>
                <span className="text-zinc-500">{link.createdAt.slice(0, 10)}</span>
                {link.lastError === null ? null : (
                  <span className="w-full text-rose-300">{link.lastError}</span>
                )}
                {link.providerLinkId === null ? null : (
                  <button
                    type="button"
                    title="Check payment: ask Razorpay and post what was paid"
                    disabled={busy === link.id}
                    onClick={() =>
                      void run(link.id, async () => {
                        await refreshPaymentLink(hotelId, link.id);
                        const next = await fetchPaymentsOverview(hotelId, {
                          from: data.from,
                          to: data.to,
                        });
                        setData(next);
                      })
                    }
                    className="ml-auto inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] text-zinc-300 hover:border-white/25 disabled:opacity-60"
                  >
                    <RefreshCw
                      className={`size-3 ${busy === link.id ? 'animate-spin' : ''}`}
                      aria-hidden="true"
                    />
                    Check payment
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
