'use client';

/**
 * "Payment link" on the folio (FO-15): send a Razorpay link for the balance,
 * see this folio's links, check one for payment, or cancel it.
 *
 * The server decides everything: whether the gateway is on here, the amount
 * limit, posting a captured payment to the folio. "Check payment" asks
 * Razorpay directly, for when no webhook can reach the API (local testing),
 * and refreshes the folio when money was posted. One idempotency key per
 * opened panel, so a retried click is one link.
 */

import { Check, Copy, Link2, Loader2, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import type { FolioPage, PaymentLink, PaymentLinkStatus } from '@repo/types';

import { ApiRequestError, ApiUnreachableError } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import {
  cancelPaymentLink,
  fetchFolioPaymentLinks,
  refreshPaymentLink,
  sendPaymentLink,
} from '@/lib/properties-client';

function messageOf(cause: unknown): string {
  if (cause instanceof ApiRequestError) {
    if (cause.status === 403) return 'Your role cannot send payment links (needs folio:settle).';
    const issues = (cause.details as { issues?: Record<string, string> } | undefined)?.issues;
    const first = issues === undefined ? undefined : Object.values(issues)[0];
    return first ?? cause.message;
  }
  if (cause instanceof ApiUnreachableError) return 'The server could not be reached. Try again.';
  // This panel's own input checks throw a plain Error with a sentence for the clerk.
  if (cause instanceof Error && cause.name === 'Error') return cause.message;
  return 'Something went wrong. Try again.';
}

const STATUS_LABEL: Record<PaymentLinkStatus, string> = {
  CREATING: 'Creating',
  ACTIVE: 'Awaiting payment',
  PARTIALLY_PAID: 'Partly paid',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  FAILED: 'Not sent',
  NEEDS_ATTENTION: 'Needs attention',
};

const pill =
  'flex shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.08] px-2.5 py-1.5 text-[11px] font-semibold tracking-wider uppercase transition-colors';

export function PaymentLinks({
  hotelId,
  folio,
  onPosted,
}: {
  hotelId: string;
  folio: FolioPage;
  onPosted: () => void;
}) {
  const open = folio.folioId !== null && folio.folioStatus === 'OPEN';
  const balance = folio.totals.balanceDueMinor;
  const currency = folio.totals.currency;
  const [panel, setPanel] = useState<{
    key: string;
    amount: string;
    sms: boolean;
    email: boolean;
  } | null>(null);
  const [links, setLinks] = useState<PaymentLink[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Only used once `open` (which requires a folio) let the panel open.
  const folioId = folio.folioId ?? '';

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

  const openPanel = () =>
    void run('open', async () => {
      setPanel({
        key: crypto.randomUUID(),
        amount: balance > 0 ? (balance / 100).toFixed(2) : '',
        sms: true,
        email: true,
      });
      setLinks(await fetchFolioPaymentLinks(hotelId, folioId));
    });

  const send = () =>
    void run('send', async () => {
      if (panel === null) return;
      const amountMinor = panel.amount.trim() === '' ? 0 : Math.round(Number(panel.amount) * 100);
      if (!Number.isFinite(amountMinor) || amountMinor < 100) {
        throw new Error('Enter at least 1.00.');
      }
      const link = await sendPaymentLink(hotelId, folioId, {
        amountMinor,
        notifySms: panel.sms,
        notifyEmail: panel.email,
        idempotencyKey: panel.key,
      });
      // The key is spent on this link; another send is another intent.
      setPanel({ ...panel, key: crypto.randomUUID() });
      setLinks([link, ...(links ?? []).filter((item) => item.id !== link.id)]);
      if (link.status === 'FAILED') setError(link.lastError ?? 'Razorpay did not create the link.');
    });

  const refresh = (link: PaymentLink) =>
    void run(link.id, async () => {
      const next = await refreshPaymentLink(hotelId, link.id);
      setLinks((links ?? []).map((item) => (item.id === next.id ? next : item)));
      if (next.amountPaidMinor !== link.amountPaidMinor || next.status !== link.status) onPosted();
    });

  const cancel = (link: PaymentLink) =>
    void run(link.id, async () => {
      const next = await cancelPaymentLink(hotelId, link.id);
      setLinks((links ?? []).map((item) => (item.id === next.id ? next : item)));
    });

  return (
    <div className="relative">
      <button
        type="button"
        title={
          open
            ? 'Send a Razorpay payment link'
            : folio.folioId === null
              ? 'No folio yet: one opens at check-in'
              : 'The folio is not open'
        }
        disabled={!open}
        onClick={openPanel}
        className={
          open
            ? `${pill} text-zinc-200 hover:border-white/25 hover:bg-white/[0.04]`
            : `${pill} cursor-not-allowed text-zinc-500 opacity-60`
        }
      >
        {busy === 'open' ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Link2 className="size-3.5" aria-hidden="true" />
        )}
        Payment link
      </button>
      {panel === null ? null : (
        // A centred dialog over the page, not a dropdown: the folio's action
        // row scrolls horizontally, and a scrolling row clips anything that
        // pops out of it, which made this panel invisible.
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-24">
          <button
            type="button"
            aria-label="Close"
            onClick={() => {
              setPanel(null);
            }}
            className="absolute inset-0 cursor-default bg-black/60"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Payment links"
            className="relative flex w-full max-w-[26rem] flex-col gap-3 rounded-xl border border-white/10 bg-zinc-950 p-4 text-xs text-zinc-300 shadow-xl"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-white">Razorpay payment link</span>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setPanel(null)}
                className="rounded p-1 text-zinc-400 hover:bg-white/[0.06] hover:text-white"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
            <p className="text-zinc-400">
              The guest pays on Razorpay&apos;s page; the payment is posted to this folio. Balance
              due: {formatMoney(balance, currency)}.
            </p>
            <div className="flex items-end gap-2">
              <label className="flex flex-1 flex-col gap-1">
                Amount ({currency})
                <input
                  inputMode="decimal"
                  value={panel.amount}
                  onChange={(event) => setPanel({ ...panel, amount: event.target.value })}
                  className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-white focus:border-white/25 focus:outline-none"
                />
              </label>
              <button
                type="button"
                disabled={busy === 'send'}
                onClick={send}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-500 disabled:opacity-60"
              >
                {busy === 'send' ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : null}
                Send link
              </button>
            </div>
            <div className="flex gap-4 text-zinc-400">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={panel.sms}
                  onChange={(event) => setPanel({ ...panel, sms: event.target.checked })}
                />
                Text it to the guest
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={panel.email}
                  onChange={(event) => setPanel({ ...panel, email: event.target.checked })}
                />
                Email it
              </label>
            </div>
            {error === null ? null : (
              <p role="alert" className="text-rose-300">
                {error}
              </p>
            )}
            {links === null || links.length === 0 ? null : (
              <ul className="flex max-h-64 flex-col divide-y divide-white/[0.06] overflow-y-auto rounded-lg border border-white/[0.08]">
                {links.map((link) => (
                  <li key={link.id} className="flex flex-col gap-1 px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <span className="tabular text-white">
                        {formatMoney(link.amountMinor, link.currency)}
                      </span>
                      <span
                        className={
                          link.status === 'PAID'
                            ? 'text-emerald-300'
                            : link.status === 'NEEDS_ATTENTION' || link.status === 'FAILED'
                              ? 'text-rose-300'
                              : 'text-zinc-400'
                        }
                      >
                        {STATUS_LABEL[link.status]}
                        {link.amountPaidMinor > 0 && link.status !== 'PAID'
                          ? ` · ${formatMoney(link.amountPaidMinor, link.currency)} paid`
                          : ''}
                      </span>
                      <span className="ml-auto flex gap-1">
                        {link.shortUrl === null ? null : (
                          <button
                            type="button"
                            title="Copy the link"
                            onClick={() => {
                              void navigator.clipboard
                                .writeText(link.shortUrl ?? '')
                                .then(() => setCopied(link.id));
                            }}
                            className="rounded p-1 text-zinc-400 hover:bg-white/[0.06] hover:text-white"
                          >
                            {copied === link.id ? (
                              <Check className="size-3.5" aria-hidden="true" />
                            ) : (
                              <Copy className="size-3.5" aria-hidden="true" />
                            )}
                          </button>
                        )}
                        {link.providerLinkId === null ? null : (
                          <button
                            type="button"
                            title="Check payment: ask Razorpay and post what was paid"
                            disabled={busy === link.id}
                            onClick={() => refresh(link)}
                            className="rounded p-1 text-zinc-400 hover:bg-white/[0.06] hover:text-white disabled:opacity-60"
                          >
                            <RefreshCw
                              className={`size-3.5 ${busy === link.id ? 'animate-spin' : ''}`}
                              aria-hidden="true"
                            />
                          </button>
                        )}
                        {link.status === 'ACTIVE' ? (
                          <button
                            type="button"
                            title="Cancel this link"
                            disabled={busy === link.id}
                            onClick={() => cancel(link)}
                            className="rounded p-1 text-zinc-400 hover:bg-white/[0.06] hover:text-rose-300 disabled:opacity-60"
                          >
                            <X className="size-3.5" aria-hidden="true" />
                          </button>
                        ) : null}
                      </span>
                    </div>
                    {link.shortUrl === null ? null : (
                      <span className="truncate font-mono text-[11px] text-zinc-500">
                        {link.shortUrl}
                      </span>
                    )}
                    {link.lastError === null ? null : (
                      <span className="text-rose-300">{link.lastError}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
