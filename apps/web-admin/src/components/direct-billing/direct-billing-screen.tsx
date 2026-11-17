'use client';

/**
 * Direct billing (GP-07): company accounts on the city ledger, aged, with each
 * company's statement and a form to record its payments.
 *
 * A balance appears here when a folio is billed to a company ("Bill to
 * company" on the folio). Every figure comes from the server, which sums the
 * ledger and ages it as of the business date; this screen only renders, and
 * mints one idempotency key per payment the clerk intends.
 */

import { cn } from '@repo/ui';
import { Loader2, X } from 'lucide-react';
import { Fragment, useState } from 'react';
import {
  PAYMENT_METHOD_LABELS,
  paymentMethodSchema,
  type AgingBuckets,
  type CompanyStatement,
  type DirectBillingOverview,
  type PaymentMethod,
} from '@repo/types';

import { ApiRequestError, ApiUnreachableError } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import {
  fetchCompanyStatement,
  fetchDirectBilling,
  recordCompanyPayment,
} from '@/lib/properties-client';

const FIELD =
  'rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-zinc-200 focus:border-white/20 focus:outline-none';

function messageOf(cause: unknown): string {
  if (cause instanceof ApiRequestError) {
    if (cause.status === 403)
      return 'Your role cannot record company payments (needs direct_billing:manage).';
    const issues = (cause.details as { issues?: Record<string, string> } | undefined)?.issues;
    const first = issues === undefined ? undefined : Object.values(issues)[0];
    return first ?? cause.message;
  }
  if (cause instanceof ApiUnreachableError) {
    return 'The server could not be reached. Try again: the same payment cannot be recorded twice.';
  }
  return 'Something went wrong. Nothing was recorded.';
}

const BUCKETS: { key: keyof AgingBuckets; label: string }[] = [
  { key: 'currentMinor', label: '0–30 days' },
  { key: 'days31To60Minor', label: '31–60' },
  { key: 'days61To90Minor', label: '61–90' },
  { key: 'over90Minor', label: '90+' },
];

export function DirectBillingScreen({
  hotelId,
  initial,
  canManage,
}: {
  hotelId: string;
  initial: DirectBillingOverview;
  canManage: boolean;
}) {
  const [overview, setOverview] = useState(initial);
  const [statement, setStatement] = useState<CompanyStatement | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const money = (minor: number) => formatMoney(minor, overview.currency);

  async function open(companyId: string): Promise<void> {
    setLoading(companyId);
    setError(null);
    try {
      setStatement(await fetchCompanyStatement(hotelId, companyId));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(null);
    }
  }

  async function paid(next: CompanyStatement): Promise<void> {
    setStatement(next);
    try {
      setOverview(await fetchDirectBilling(hotelId));
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Aging" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <div className="flex flex-col gap-1 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
          <span className="text-[11px] tracking-wide text-zinc-500 uppercase">
            Owed by companies
          </span>
          <span className="tabular text-lg font-semibold text-white">
            {money(overview.totals.balanceMinor)}
          </span>
        </div>
        {BUCKETS.map((bucket) => (
          <div
            key={bucket.key}
            className="flex flex-col gap-1 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3"
          >
            <span className="text-[11px] tracking-wide text-zinc-500 uppercase">
              {bucket.label}
            </span>
            <span
              className={cn(
                'tabular text-lg font-semibold',
                bucket.key === 'over90Minor' && overview.totals.aging.over90Minor > 0
                  ? 'text-rose-300'
                  : 'text-white',
              )}
            >
              {money(overview.totals.aging[bucket.key])}
            </span>
          </div>
        ))}
      </section>

      {error === null ? null : (
        <p
          role="alert"
          className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
        >
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
        <table className="w-full min-w-[52rem] text-left text-xs">
          <thead className="bg-white/[0.03] text-[11px] tracking-wide text-zinc-500 uppercase">
            <tr>
              <th className="px-3 py-2 font-medium">Company</th>
              <th className="px-3 py-2 font-medium">GSTIN</th>
              <th className="px-3 py-2 text-right font-medium">Balance</th>
              {BUCKETS.map((bucket) => (
                <th key={bucket.key} className="px-3 py-2 text-right font-medium">
                  {bucket.label}
                </th>
              ))}
              <th className="px-3 py-2 font-medium">Last payment</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">
            {overview.accounts.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-zinc-500">
                  No company accounts yet. A balance appears here when a folio is billed to the
                  stay&apos;s company (&ldquo;Bill to company&rdquo; on the folio).
                </td>
              </tr>
            ) : (
              overview.accounts.map((account) => (
                <tr
                  key={account.companyId}
                  className={cn(
                    'tabular cursor-pointer text-zinc-300 hover:bg-white/[0.03]',
                    statement?.company.id === account.companyId && 'bg-white/[0.04]',
                  )}
                  onClick={() => void open(account.companyId)}
                >
                  <td className="px-3 py-2 text-zinc-100">
                    {loading === account.companyId ? (
                      <Loader2 className="mr-1.5 inline size-3 animate-spin" aria-hidden="true" />
                    ) : null}
                    {account.tradeName ?? account.legalName}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px]">{account.gstin}</td>
                  <td className="px-3 py-2 text-right text-white">{money(account.balanceMinor)}</td>
                  {BUCKETS.map((bucket) => (
                    <td key={bucket.key} className="px-3 py-2 text-right">
                      {account.aging[bucket.key] === 0 ? '—' : money(account.aging[bucket.key])}
                    </td>
                  ))}
                  <td className="px-3 py-2">{account.lastPaymentDate ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {statement === null ? null : (
        <Statement
          key={statement.company.id}
          hotelId={hotelId}
          statement={statement}
          canManage={canManage}
          onClose={() => setStatement(null)}
          onPaid={(next) => void paid(next)}
        />
      )}

      <p className="text-[11px] leading-relaxed text-zinc-500">
        Aging is as of the business date ({overview.asOf}). Payments clear the oldest debt first;
        what remains ages from the stay&apos;s invoice date, or from the day it was billed if no
        invoice has been issued yet. No credit limits are applied.
      </p>
    </div>
  );
}

function Statement({
  hotelId,
  statement,
  canManage,
  onClose,
  onPaid,
}: {
  hotelId: string;
  statement: CompanyStatement;
  canManage: boolean;
  onClose: () => void;
  onPaid: (next: CompanyStatement) => void;
}) {
  const money = (minor: number) => formatMoney(minor, statement.currency);
  const [form, setForm] = useState<{
    key: string;
    method: PaymentMethod;
    amount: string;
    reference: string;
  }>(() => ({ key: crypto.randomUUID(), method: 'BANK_TRANSFER', amount: '', reference: '' }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const amountMinor = form.amount.trim() === '' ? 0 : Math.round(Number(form.amount) * 100);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      setError('Enter an amount above zero.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await recordCompanyPayment(hotelId, statement.company.id, {
        method: form.method,
        amountMinor,
        reference: form.reference.trim() === '' ? null : form.reference.trim(),
        remark: null,
        idempotencyKey: form.key,
      });
      // A new intent gets a new key; the one just used stays with its payment.
      setForm({ key: crypto.randomUUID(), method: form.method, amount: '', reference: '' });
      onPaid(next);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label="Company statement"
      className="flex flex-col gap-4 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4"
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-white">
            {statement.company.tradeName ?? statement.company.legalName}
          </h2>
          <p className="text-xs text-zinc-500">
            {statement.company.legalName} · GSTIN {statement.company.gstin}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="tabular text-sm text-zinc-300">
            Balance{' '}
            <span className="font-semibold text-white">{money(statement.balanceMinor)}</span>
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close statement"
            className="rounded-lg p-1 text-zinc-400 hover:bg-white/[0.06] hover:text-white"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      {statement.openItems.length === 0 ? null : (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-[11px] tracking-wide text-zinc-500 uppercase">Open items</h3>
          <ul className="flex flex-wrap gap-2">
            {statement.openItems.map((item) => (
              <li
                key={item.entryId}
                className="tabular rounded-lg border border-white/[0.08] px-2.5 py-1.5 text-xs text-zinc-300"
              >
                {item.invoiceNumber ?? item.bookingCode ?? 'Stay'} · {money(item.outstandingMinor)}{' '}
                ·{' '}
                <span className={item.ageDays > 90 ? 'text-rose-300' : 'text-zinc-400'}>
                  {item.ageDays} days
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-white/[0.06]">
        <table className="w-full min-w-[44rem] text-left text-xs">
          <thead className="bg-white/[0.03] text-[11px] tracking-wide text-zinc-500 uppercase">
            <tr>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Entry</th>
              <th className="px-3 py-2 font-medium">Detail</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="px-3 py-2 text-right font-medium">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">
            {statement.entries.map((entry) => (
              <Fragment key={entry.id}>
                <tr className="tabular text-zinc-300">
                  <td className="px-3 py-2">{entry.postingDate}</td>
                  <td className="px-3 py-2">
                    {entry.kind === 'TRANSFER' ? 'Stay billed' : 'Payment received'}
                  </td>
                  <td className="px-3 py-2 text-zinc-400">
                    {entry.kind === 'TRANSFER'
                      ? [entry.bookingCode, entry.guestName, entry.invoiceNumber]
                          .filter((part) => part !== null && part !== '')
                          .join(' · ')
                      : [
                          entry.method === null ? null : PAYMENT_METHOD_LABELS[entry.method],
                          entry.reference,
                        ]
                          .filter((part) => part !== null && part !== '')
                          .join(' · ')}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right',
                      entry.amountMinor < 0 ? 'text-emerald-300' : 'text-zinc-100',
                    )}
                  >
                    {money(entry.amountMinor)}
                  </td>
                  <td className="px-3 py-2 text-right text-white">
                    {money(entry.runningBalanceMinor)}
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && statement.balanceMinor > 0 ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
            Method
            <select
              value={form.method}
              onChange={(event) =>
                setForm({ ...form, method: paymentMethodSchema.parse(event.target.value) })
              }
              className={FIELD}
            >
              {paymentMethodSchema.options.map((method) => (
                <option key={method} value={method}>
                  {PAYMENT_METHOD_LABELS[method]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
            Amount ({statement.currency})
            <input
              inputMode="decimal"
              value={form.amount}
              onChange={(event) => setForm({ ...form, amount: event.target.value })}
              placeholder={(statement.balanceMinor / 100).toFixed(2)}
              className={FIELD}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
            Reference (UTR, cheque no.)
            <input
              value={form.reference}
              maxLength={100}
              onChange={(event) => setForm({ ...form, reference: event.target.value })}
              className={FIELD}
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
            Record payment
          </button>
          {error === null ? null : (
            <p role="alert" className="w-full text-xs text-rose-300">
              {error}
            </p>
          )}
        </form>
      ) : null}
    </section>
  );
}
