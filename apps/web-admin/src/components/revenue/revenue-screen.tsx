'use client';

/**
 * The revenue screen (RP-10): a property's closed days, read from the night
 * audit's snapshots.
 *
 * Every figure here is a closed day as the night audit froze it, the same rows
 * the flash report and the dashboard read. Days not yet closed are counted, not
 * shown, and closed days without a snapshot are named, so a gap is never read
 * as a quiet night. The server picks the default window and does every sum;
 * this screen only renders.
 */

import { cn } from '@repo/ui';
import { Loader2, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import type { ClosedDay, RevenueOverview } from '@repo/types';

import { ApiRequestError } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { fetchRevenue } from '@/lib/properties-client';

const FIELD =
  'rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-zinc-200 focus:border-white/20 focus:outline-none';

function percent(bp: number): string {
  return `${(bp / 100).toFixed(1)}%`;
}

function shortDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  }).format(new Date(`${iso}T00:00:00Z`));
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
      <span className="text-[11px] tracking-wide text-zinc-500 uppercase">{label}</span>
      <span className="tabular text-lg font-semibold text-white">{value}</span>
      {hint === undefined ? null : <span className="text-[11px] text-zinc-500">{hint}</span>}
    </div>
  );
}

export function RevenueScreen({ hotelId, initial }: { hotelId: string; initial: RevenueOverview }) {
  const [data, setData] = useState(initial);
  const [from, setFrom] = useState<string>(initial.from);
  const [to, setTo] = useState<string>(initial.to);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(window: { from?: string; to?: string }) {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchRevenue(hotelId, window);
      setData(next);
      setFrom(next.from);
      setTo(next.to);
    } catch (cause) {
      setError(
        cause instanceof ApiRequestError ? cause.message : 'The figures could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  }

  const money = (minor: number | null) =>
    minor === null ? '—' : formatMoney(minor, data.currency);
  const t = data.totals;

  return (
    <div className="flex flex-col gap-5">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void load({ from, to });
        }}
      >
        <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
          From
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className={FIELD}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
          To
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className={FIELD}
            required
          />
        </label>
        <button
          type="submit"
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-60"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          Show
        </button>
        <button
          type="button"
          disabled={loading}
          onClick={() => void load({})}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:border-white/25 disabled:opacity-60"
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          This month
        </button>
      </form>

      {error === null ? null : (
        <p
          role="alert"
          className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
        >
          {error}
        </p>
      )}

      <section aria-label="Totals" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi
          label="Room revenue"
          value={money(t.roomRevenueMinor)}
          hint={`${String(t.days)} closed day(s)`}
        />
        <Kpi
          label="Occupancy"
          value={percent(t.occupancyBp)}
          hint={`${String(t.roomsSold)} of ${String(t.roomsAvailable)} rooms`}
        />
        <Kpi label="ADR" value={money(t.adrMinor)} />
        <Kpi label="RevPAR" value={money(t.revparMinor)} />
        <Kpi label="Service revenue" value={money(t.serviceRevenueMinor)} />
        <Kpi label="Tax" value={money(t.taxMinor)} />
      </section>

      {data.missingDates.length === 0 && data.openDays === 0 ? null : (
        <div className="flex flex-col gap-1 rounded-lg border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200">
          {data.openDays === 0 ? null : (
            <p>
              {data.openDays} day(s) in this window are on or after the business date (
              {data.businessDate}) and are not closed yet, so they are not shown.
            </p>
          )}
          {data.missingDates.length === 0 ? null : (
            <p>
              {data.missingDates.length} closed day(s) have no night-audit snapshot and are not
              counted
              {data.missingDates.length <= 10 ? `: ${data.missingDates.join(', ')}` : ''}. These are
              days from before the night audit existed, or days whose audit did not run.
            </p>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
        <table className="w-full min-w-[56rem] text-left text-xs">
          <thead className="bg-white/[0.03] text-[11px] tracking-wide text-zinc-500 uppercase">
            <tr>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 text-right font-medium">Sold / available</th>
              <th className="px-3 py-2 text-right font-medium">Occupancy</th>
              <th className="px-3 py-2 text-right font-medium">ADR</th>
              <th className="px-3 py-2 text-right font-medium">RevPAR</th>
              <th className="px-3 py-2 text-right font-medium">Room revenue</th>
              <th className="px-3 py-2 text-right font-medium">Service</th>
              <th className="px-3 py-2 text-right font-medium">Tax</th>
              <th className="px-3 py-2 text-right font-medium">Payments</th>
              <th className="px-3 py-2 text-right font-medium">Refunds</th>
            </tr>
          </thead>
          <tbody className={cn('divide-y divide-white/[0.05]', loading && 'opacity-60')}>
            {data.days.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-zinc-500">
                  No closed days in this window. Figures appear here once the night audit has closed
                  a day.
                </td>
              </tr>
            ) : (
              data.days.map((day: ClosedDay) => (
                <tr key={day.businessDate} className="tabular text-zinc-300">
                  <td className="px-3 py-2 text-zinc-200">{shortDate(day.businessDate)}</td>
                  <td className="px-3 py-2 text-right">
                    {day.roomsSold} / {day.roomsAvailable}
                  </td>
                  <td className="px-3 py-2 text-right">{percent(day.occupancyBp)}</td>
                  <td className="px-3 py-2 text-right">{money(day.adrMinor)}</td>
                  <td className="px-3 py-2 text-right">{money(day.revparMinor)}</td>
                  <td className="px-3 py-2 text-right text-white">{money(day.roomRevenueMinor)}</td>
                  <td className="px-3 py-2 text-right">{money(day.serviceRevenueMinor)}</td>
                  <td className="px-3 py-2 text-right">{money(day.taxMinor)}</td>
                  <td className="px-3 py-2 text-right">{money(day.paymentsMinor)}</td>
                  <td className="px-3 py-2 text-right">{money(day.refundsMinor)}</td>
                </tr>
              ))
            )}
          </tbody>
          {data.days.length === 0 ? null : (
            <tfoot className="border-t border-white/10 bg-white/[0.03] font-medium text-zinc-200">
              <tr className="tabular">
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right">
                  {t.roomsSold} / {t.roomsAvailable}
                </td>
                <td className="px-3 py-2 text-right">{percent(t.occupancyBp)}</td>
                <td className="px-3 py-2 text-right">{money(t.adrMinor)}</td>
                <td className="px-3 py-2 text-right">{money(t.revparMinor)}</td>
                <td className="px-3 py-2 text-right text-white">{money(t.roomRevenueMinor)}</td>
                <td className="px-3 py-2 text-right">{money(t.serviceRevenueMinor)}</td>
                <td className="px-3 py-2 text-right">{money(t.taxMinor)}</td>
                <td className="px-3 py-2 text-right">{money(t.paymentsMinor)}</td>
                <td className="px-3 py-2 text-right">{money(t.refundsMinor)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <p className="text-[11px] leading-relaxed text-zinc-500">
        Room and service revenue are the charges posted to folios on each date, corrections
        included; tax is every folio tax line on the date. Occupancy is rooms sold over sellable
        rooms (physical minus blocked). ADR divides room revenue by rooms sold, RevPAR by rooms
        available, and the totals are recomputed from the summed days rather than averaged. For
        dates still open, and future dates, see the Sales report.
      </p>
    </div>
  );
}
