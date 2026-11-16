'use client';

/**
 * The arrivals / departures board (FD-09).
 *
 * Three lists for the business date. Each row opens the stay's folio, where
 * check-in, check-out, room moves and payments already live, so the board
 * adds no second way to do any of them. Overdue arrivals and overstays sort
 * first and are tinted, because they are the rows that need a decision.
 */

import { cn } from '@repo/ui';
import { BedDouble, LogIn, LogOut, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { FrontDeskBoard, FrontDeskRow, FrontDeskRowFlag } from '@repo/types';

import { formatMoney } from '@/lib/money';
import { fetchFrontDeskBoard } from '@/lib/properties-client';

type Tab = 'arrivals' | 'departures' | 'inHouse';

const FLAG: Record<FrontDeskRowFlag, { label: string; tone: string }> = {
  OVERDUE_ARRIVAL: { label: 'Overdue', tone: 'border-rose-500/30 bg-rose-500/10 text-rose-300' },
  DUE_IN: { label: 'Due in', tone: 'border-sky-500/30 bg-sky-500/10 text-sky-300' },
  ARRIVED: { label: 'Arrived', tone: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  OVERSTAY: { label: 'Overstay', tone: 'border-rose-500/30 bg-rose-500/10 text-rose-300' },
  DUE_OUT: { label: 'Due out', tone: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  DEPARTED: { label: 'Departed', tone: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300' },
  STAYING: { label: 'In house', tone: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300' },
};

function roomLabel(status: string | null): string {
  return status === null ? '' : status.toLowerCase().replace(/_/g, ' ');
}

export function FrontDeskBoardView({ hotelId, initial }: { hotelId: string; initial: FrontDeskBoard }) {
  const [board, setBoard] = useState(initial);
  const [tab, setTab] = useState<Tab>('arrivals');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setRefreshing(true);
    setError(null);
    try {
      setBoard(await fetchFrontDeskBoard(hotelId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The board could not be refreshed.');
    } finally {
      setRefreshing(false);
    }
  }

  const { counts } = board;
  const tabs: { key: Tab; label: string; icon: typeof LogIn; summary: string }[] = [
    {
      key: 'arrivals',
      label: 'Arrivals',
      icon: LogIn,
      summary: `${String(counts.dueIn)} due · ${String(counts.arrived)} arrived${counts.overdueArrivals > 0 ? ` · ${String(counts.overdueArrivals)} overdue` : ''}`,
    },
    {
      key: 'departures',
      label: 'Departures',
      icon: LogOut,
      summary: `${String(counts.dueOut)} due · ${String(counts.departed)} left${counts.overstays > 0 ? ` · ${String(counts.overstays)} overstay` : ''}`,
    },
    { key: 'inHouse', label: 'In house', icon: BedDouble, summary: `${String(counts.inHouse)} stays` },
  ];
  const rows = board[tab];

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-stretch gap-2">
        {tabs.map(({ key, label, icon: Icon, summary }) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setTab(key);
            }}
            aria-pressed={tab === key}
            className={cn(
              'flex min-w-[10rem] flex-col items-start gap-0.5 rounded-xl border px-4 py-2.5 text-left transition',
              tab === key
                ? 'border-sky-500/40 bg-sky-500/10'
                : 'border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05]',
            )}
          >
            <span className="flex items-center gap-1.5 text-sm font-semibold text-zinc-100">
              <Icon className="size-4 text-zinc-400" aria-hidden="true" />
              {label}
            </span>
            <span className="text-[11px] text-zinc-400">{summary}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            void refresh();
          }}
          disabled={refreshing}
          className="ml-auto flex items-center gap-1.5 self-center rounded-lg border border-white/[0.08] px-3 py-2 text-xs text-zinc-300 disabled:opacity-50"
        >
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} aria-hidden="true" />
          Refresh
        </button>
      </div>

      {error !== null ? (
        <p className="rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2 text-xs text-rose-200">
          {error}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-8 text-center text-sm text-zinc-500">
          Nothing on this list for {board.businessDate}.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
          <table className="w-full min-w-[44rem] text-left text-xs">
            <thead className="bg-white/[0.03] text-[11px] tracking-wide text-zinc-500 uppercase">
              <tr>
                <th className="px-3 py-2 font-medium">Guest</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 font-medium">Stay</th>
                <th className="px-3 py-2 font-medium">Room</th>
                <th className="px-3 py-2 font-medium">Pax</th>
                {board.showsBalances ? (
                  <th
                    className="px-3 py-2 text-right font-medium"
                    title="Charges posted so far, less payments. The folio's Due also counts nights not yet posted, so the two agree on the departure day."
                  >
                    Posted balance
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <BoardRow key={`${tab}:${row.reservationId}`} hotelId={hotelId} row={row} tab={tab} showsBalances={board.showsBalances} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BoardRow({
  hotelId,
  row,
  tab,
  showsBalances,
}: {
  hotelId: string;
  row: FrontDeskRow;
  tab: Tab;
  showsBalances: boolean;
}) {
  const flag = FLAG[row.flag];
  const urgent = row.flag === 'OVERDUE_ARRIVAL' || row.flag === 'OVERSTAY';
  const needsRoom = tab === 'arrivals' && row.flag === 'DUE_IN';

  return (
    <tr className={cn('border-t border-white/[0.05]', urgent && 'bg-rose-500/[0.04]')}>
      <td className="px-3 py-2.5">
        <Link
          href={`/folio/${encodeURIComponent(row.bookingCode)}?hotelId=${encodeURIComponent(hotelId)}`}
          className="font-medium text-zinc-100 hover:underline"
        >
          {row.guestName}
        </Link>
        <div className="text-[11px] text-zinc-500">{row.bookingCode}</div>
      </td>
      <td className="px-3 py-2.5">
        <span className={cn('rounded-full border px-2 py-0.5 text-[11px]', flag.tone)}>{flag.label}</span>
      </td>
      <td className="px-3 py-2.5 text-zinc-300">
        {row.arrivalDate} → {row.departureDate}
        <div className="text-[11px] text-zinc-500">
          {row.nights} night{row.nights === 1 ? '' : 's'}
        </div>
      </td>
      <td className="px-3 py-2.5 text-zinc-300">
        {row.roomNumber ?? <span className="text-amber-300">Unassigned</span>}
        <div className="text-[11px] text-zinc-500">
          {row.roomTypeName ?? ''}
          {row.roomStatus !== null ? ` · ${roomLabel(row.roomStatus)}` : ''}
        </div>
        {needsRoom && row.roomNumber !== null && !row.roomReady ? (
          <div className="text-[11px] text-amber-300">Room not ready</div>
        ) : null}
      </td>
      <td className="px-3 py-2.5 text-zinc-300">
        {row.adults}
        {row.children > 0 ? ` + ${String(row.children)}` : ''}
      </td>
      {showsBalances ? (
        <td
          className={cn(
            'px-3 py-2.5 text-right tabular-nums',
            (row.balanceMinor ?? 0) > 0 ? 'text-amber-200' : 'text-zinc-400',
          )}
        >
          {row.balanceMinor === null
            ? '—'
            : row.balanceMinor < 0
              ? `${formatMoney(-row.balanceMinor, row.currency)} credit`
              : formatMoney(row.balanceMinor, row.currency)}
        </td>
      ) : null}
    </tr>
  );
}
