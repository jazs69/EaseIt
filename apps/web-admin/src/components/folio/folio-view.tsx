'use client';

/**
 * The folio and billing screen.
 *
 * ===========================================================================
 * The ledger is the page; everything else is a projection of it.
 *
 * The header KPIs, the transaction table and the bottom summary are three
 * views of one `folio_line` list, all summed server-side (CLAUDE.md section
 * 3.4). Nothing here recomputes a total from another total, so no two figures
 * on screen can disagree.
 *
 * WHAT IS WIRED, AND WHAT SAYS IT IS NOT
 * Collect payment, Add charge and Apply discount are real: they post to the
 * ledger and the whole page comes back recomputed. Every other pill — booking
 * actions, registration card, payment link, email, rollback, print — needs a
 * module that is not built, and each says which one rather than pretending.
 * The tab row is the same: Summary, Itemized, Taxes and Payments are
 * projections of data that exists; Guest management, Deposits, Notes,
 * Audit log and Documents are not, and are marked.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import {
  ArrowLeft,
  Check,
  Copy,
  CreditCard,
  FileText,
  IdCard,
  Link2,
  Loader2,
  Mail,
  Percent,
  Plus,
  Printer,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  PAYMENT_METHOD_LABELS,
  paymentMethodSchema,
  type FolioPage,
  type FolioTransaction,
  type PaymentMethod,
} from '@repo/types';

import { BookingActionsMenu } from './booking-actions-menu';
import { useFolioSummaryRows, type FolioSummaryRow } from './use-folio-summary-rows';
import { EditableFolioCell } from './editable-folio-cell';

import {
  correctFolioCharge,
  correctRoomCharges,
  postFolioCharge,
  postFolioDiscount,
  postFolioPayment,
  postFolioPaymentByBooking,
} from '@/lib/properties-client';

/** `₹1,234.50` from integer minor units. Never a float (section 3.4). */
function money(minor: number, currency: string): string {
  const sign = minor < 0 ? '-' : '';
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  return `${sign}${symbol}${(Math.abs(minor) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** `2026-10-18` -> `Oct 18 2026`. Parsed as UTC, never through local time. */
function formatDate(iso: string): string {
  const [year = '', month = '01', day = '01'] = iso.split('-');
  const name =
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
      Number(month) - 1
    ] ?? month;
  return `${name} ${day} ${year}`;
}

function formatClock(wallClock: string): string {
  const [hourText = '0', minute = '00'] = wallClock.split(':');
  const hour24 = Number(hourText);
  const meridiem = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${String(hour12)}:${minute} ${meridiem}`;
}

function formatInstant(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}, ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

const TABS = [
  { id: 'summary', label: 'Summary', ready: true },
  { id: 'itemized', label: 'Itemized', ready: true },
  { id: 'taxes', label: 'Taxes', ready: true },
  { id: 'payments', label: 'Payments', ready: true },
  { id: 'guests', label: 'Guest management', ready: false, needs: 'the guest-management path' },
  { id: 'deposits', label: 'Deposits', ready: false, needs: 'a deposit instrument in the schema' },
  { id: 'notes', label: 'Notes', ready: false, needs: 'folio-scoped notes' },
  { id: 'audit', label: 'Audit log', ready: false, needs: 'the audit-log reader' },
  { id: 'documents', label: 'Documents', ready: false, needs: 'document storage' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export interface FolioViewProps {
  folio: FolioPage;
  hotelId: string;
}

export function FolioView({ folio: initial, hotelId }: FolioViewProps) {
  /**
   * The page, tagged with the server payload it was derived from.
   *
   * ===========================================================================
   * A plain `useState(initial)` captures the first server render forever.
   *
   * Each posting replaces this wholesale with the server's recomputed page, so
   * the KPIs, the table and the summary move together or not at all. But a
   * bare `useState(initial)` then *ignores* every later server render: after a
   * `router.refresh()` — which is how a room move updates this screen — the
   * fresh props arrive and the stale state keeps winning. The room moved in
   * the database and the page went on showing the old room.
   *
   * Tagging the local copy with the prop it came from fixes it without an
   * effect to copy props into state, which is the cascading render
   * `react-hooks/set-state-in-effect` rejects: when the server sends a new
   * payload, `from` no longer matches and the fresh one is used.
   * ===========================================================================
   */
  const [local, setLocal] = useState<{ from: FolioPage; value: FolioPage } | null>(null);
  const folio = local !== null && local.from === initial ? local.value : initial;

  const setFolio = (page: FolioPage): void => {
    setLocal({ from: initial, value: page });
  };
  const [tab, setTab] = useState<TabId>('summary');
  const [sheet, setSheet] = useState<'payment' | 'charge' | 'discount' | null>(null);
  const router = useRouter();

  const { reservation, totals, breakdown } = folio;
  const currency = totals.currency;
  const settled = totals.balanceDueMinor <= 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ---- Header ribbon ------------------------------------------- */}
      <header className="flex flex-col gap-4 border-b border-white/[0.08] bg-[#0b0b0d] px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <Link
              href={`/calendar?hotelId=${encodeURIComponent(hotelId)}`}
              aria-label="Back to the reservation calendar"
              className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-white/[0.08] text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
            </Link>

            <div className="min-w-0">
              <h1 className="truncate text-lg font-bold tracking-tight text-white uppercase">
                {reservation.guestName}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <CopyChip label={`#${reservation.bookingCode}`} value={reservation.bookingCode} />
                <StatusPill status={reservation.status} />
                {reservation.isWalkIn ? (
                  <span className="rounded border border-white/[0.1] bg-black/40 px-2 py-0.5 text-[10px] font-bold tracking-wider text-zinc-300 uppercase">
                    Walk-in
                  </span>
                ) : (
                  <span className="rounded border border-slate-400/20 bg-slate-500/[0.14] px-2 py-0.5 text-[10px] font-bold tracking-wider text-slate-300 uppercase">
                    {reservation.source.replace(/_/g, ' ')}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Financial KPI */}
          <div className="flex items-center gap-5">
            <Kpi label="Total" value={money(totals.grossTotalMinor, currency)} />
            <Kpi
              label="Due"
              value={money(totals.balanceDueMinor, currency)}
              tone={settled ? 'text-emerald-400' : 'text-rose-400'}
            />
            <Kpi
              label="Payments"
              value={money(totals.paidMinor, currency)}
              tone={totals.paidMinor > 0 ? 'text-emerald-400' : undefined}
            />
            {reservation.canCheckOut ? (
              <button
                type="button"
                disabled
                title="Needs the frontdesk module's check-out path (CLAUDE.md section 2)"
                className="cursor-not-allowed rounded-lg border border-white/[0.08] px-3 py-2 text-xs font-semibold text-zinc-500 opacity-60"
              >
                Check out →
              </button>
            ) : null}
          </div>
        </div>

        {/* Stay metadata */}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-white/[0.06] pt-3 sm:grid-cols-4 lg:grid-cols-7">
          <Meta label="Booked" value={formatInstant(reservation.bookedAt)} />
          <Meta
            label="Stay"
            value={`${formatDate(reservation.arrivalDate)} ${formatClock(reservation.checkInTime)} → ${formatDate(reservation.departureDate)} ${formatClock(reservation.checkOutTime)}`}
          />
          <Meta
            label="Rooms"
            value={`${String(reservation.roomCount)} ${reservation.roomCount === 1 ? 'room' : 'rooms'}`}
          />
          <Meta label="Nights" value={String(reservation.nights)} />
          <Meta
            label="Occupancy"
            value={`${String(reservation.adults)} adults, ${String(reservation.children)} children`}
          />
          {/* "Board", not "rate plan": the rates module is not built, so
              naming a RatePlan here would name something that does not exist. */}
          <Meta label="Board" value={reservation.mealPlan} />
          <Meta
            label="Room type"
            value={
              reservation.roomNumber === null
                ? reservation.roomTypeName
                : `${reservation.roomTypeName} · ${reservation.roomNumber}`
            }
          />
        </dl>

        {/* ---- Quick actions ------------------------------------------ */}
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
          <BookingActionsMenu
            hotelId={hotelId}
            reservationId={reservation.id}
            hasRoom={reservation.roomNumber !== null}
            guestName={reservation.guestName}
            confirmationCode={reservation.bookingCode}
            onMoved={() => {
              // The move changed the room on the stay, which the whole page is
              // drawn from, so it is refetched rather than patched.
              router.refresh();
            }}
            onCancelled={() => {
              // The status, the room and the stay dates on this page all come
              // from the reservation, so the same refetch covers it.
              router.refresh();
            }}
          />
          <ActionPill icon={IdCard} label="Registration card" needs="the frontdesk module's registration card" />
          <ActionPill icon={Link2} label="Send payment link" needs="the payments module's hosted link" />
          <ActionPill
            icon={Plus}
            label="Add charge"
            onClick={() => {
              setSheet('charge');
            }}
            disabled={folio.folioId === null}
            disabledReason="No folio yet — one opens at check-in"
          />
          <ActionPill
            icon={Percent}
            label="Apply discount"
            onClick={() => {
              setSheet('discount');
            }}
            disabled={folio.folioId === null}
            disabledReason="No folio yet — one opens at check-in"
          />
          <ActionPill icon={Mail} label="Email folio" needs="the platform module's mail outbox" />
          <ActionPill icon={RotateCcw} label="Rollback" needs="reversing entries in the folios module" />
          <ActionPill icon={Printer} label="Print" needs="invoice rendering" />
          {/* Always live, even with no folio: taking money is a deliberate act
              by a named clerk, and the server opens the container for it. The
              charge and discount pills still need a folio, because posting a
              charge to a stay nobody has arrived at is a different claim. */}
          <button
            type="button"
            title="Collect payment"
            onClick={() => {
              setSheet('payment');
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-[11px] font-bold tracking-wider text-emerald-950 uppercase transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <CreditCard className="size-3.5" aria-hidden="true" />
            Collect payment
          </button>
        </div>
      </header>

      {/* ---- Tabs ------------------------------------------------------ */}
      <nav className="flex gap-1 overflow-x-auto border-b border-white/[0.08] px-4" aria-label="Folio views">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            disabled={!entry.ready}
            onClick={() => {
              if (entry.ready) setTab(entry.id);
            }}
            title={entry.ready ? undefined : `Not built yet — needs ${entry.needs}`}
            aria-current={tab === entry.id ? 'page' : undefined}
            className={cn(
              'shrink-0 border-b-2 px-3 py-2.5 text-xs font-medium transition-colors',
              tab === entry.id
                ? 'border-blue-500 text-white'
                : entry.ready
                  ? 'border-transparent text-zinc-400 hover:text-zinc-200'
                  : 'cursor-not-allowed border-transparent text-zinc-600 opacity-60',
            )}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {/* ---- Table ----------------------------------------------------- */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <TransactionTable
          transactions={folio.transactions}
          tab={tab}
          currency={currency}
          hotelId={hotelId}
          folioId={folio.folioId}
          roomNumber={reservation.roomNumber}
          onCorrected={setFolio}
          onOpenItemized={() => {
            setTab('itemized');
          }}
        />
      </div>

      {/* ---- Folio summary --------------------------------------------- */}
      <footer className="grid shrink-0 gap-4 border-t border-white/[0.08] bg-[#0e0e11] px-4 py-3.5 lg:grid-cols-3">
        <section>
          <h2 className="mb-1.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
            Charges
          </h2>
          <SummaryRow label="Subtotal (ex. tax)" value={money(breakdown.subtotalMinor, currency)} />
          {/* The ledger-only figure, shown when part of the stay is still
              scheduled — that is the number an invoice may be raised from. */}
          {totals.hasUnpostedCharges ? (
            <SummaryRow
              label="Of which posted"
              value={money(breakdown.postedSubtotalMinor, currency)}
              hint="Charges in the ledger. The rest is scheduled and posts at check-in or by the night audit."
            />
          ) : null}
          {breakdown.taxIsSplit ? (
            <>
              <SummaryRow label="CGST" value={money(breakdown.cgstMinor, currency)} />
              <SummaryRow label="SGST" value={money(breakdown.sgstMinor, currency)} />
            </>
          ) : (
            <SummaryRow label="GST" value={money(breakdown.taxMinor, currency)} />
          )}
        </section>

        <section>
          <h2 className="mb-1.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
            Payments &amp; deposits
          </h2>
          <SummaryRow
            label="Payments received"
            value={money(breakdown.paymentsReceivedMinor, currency)}
          />
          <SummaryRow label="Refunds issued" value={money(breakdown.refundsIssuedMinor, currency)} />
          {/* Always zero: there is no deposit instrument in the schema. Shown
              rather than hidden, so nobody assumes it is tracked elsewhere. */}
          <SummaryRow
            label="Deposits held"
            value={money(breakdown.depositsHeldMinor, currency)}
            hint="Deposits are not tracked yet"
          />
        </section>

        <section className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5 lg:justify-end">
          <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
            {settled ? null : (
              <TriangleAlert className="size-3.5 text-rose-400" aria-hidden="true" />
            )}
            Balance due
          </span>
          <span
            className={cn(
              'tabular text-xl font-bold',
              settled ? 'text-emerald-400' : 'text-rose-400',
            )}
          >
            {money(totals.balanceDueMinor, currency)}
          </span>
        </section>
      </footer>

      {sheet === null ? null : (
        <PostingSheet
          kind={sheet}
          hotelId={hotelId}
          folioId={folio.folioId}
          bookingCode={reservation.bookingCode}
          currency={currency}
          balanceDueMinor={totals.balanceDueMinor}
          onClose={() => {
            setSheet(null);
          }}
          onPosted={(page) => {
            setFolio(page);
            setSheet(null);
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Table                                                                      */
/* -------------------------------------------------------------------------- */

function TransactionTable({
  transactions,
  tab,
  currency,
  hotelId,
  folioId,
  roomNumber,
  onCorrected,
  onOpenItemized,
}: {
  transactions: readonly FolioTransaction[];
  tab: TabId;
  currency: string;
  hotelId: string;
  folioId: string | null;
  roomNumber: string | null;
  onCorrected: (page: FolioPage) => void;
  onOpenItemized: () => void;
}) {
  /**
   * The tabs are projections of one ledger, not separate fetches.
   *
   * Summary rolls the nightly tariff into a single "Booking Price" and answers
   * "what is this stay costing?"; Itemized is the night-by-night ledger. Taxes
   * and Payments narrow to the rows that carry each.
   */
  const summaryRows = useFolioSummaryRows(transactions, roomNumber);

  const rows: readonly FolioSummaryRow[] = (
    tab === 'summary'
      ? summaryRows
      : transactions.map((entry) => ({
          ...entry,
          rolledUpCount: 1,
          postedGrossMinor: entry.isPosted ? entry.grossMinor : 0,
        }))
  ).filter((entry) => {
    if (tab === 'taxes') return entry.taxMinor !== 0;
    if (tab === 'payments') return entry.kind === 'PAYMENT' || entry.kind === 'REFUND';
    return true;
  });

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.06]">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] bg-white/[0.02] px-3 py-2">
        <h2 className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
          {tab === 'summary' ? 'Summary details' : 'Transactions'}
        </h2>
        {tab === 'summary' ? (
          <button
            type="button"
            onClick={onOpenItemized}
            className="text-[10px] font-medium text-blue-400 transition-colors hover:text-blue-300"
          >
            Open transactions
          </button>
        ) : null}
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-white/[0.06] bg-white/[0.02] text-[10px] tracking-wider text-zinc-500 uppercase">
            <th scope="col" className="px-3 py-2 text-left font-semibold">
              Date
            </th>
            <th scope="col" className="px-3 py-2 text-left font-semibold">
              Room
            </th>
            <th scope="col" className="px-3 py-2 text-left font-semibold">
              Description
            </th>
            <th scope="col" className="px-3 py-2 text-left font-semibold">
              Type
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              Net
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              Tax
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              Gross
            </th>
          </tr>
        </thead>
        <tbody>
          {/* The headers stay even with nothing to show. A table that
              collapses into an empty panel reads as a broken screen; one
              explicit row says which of the two situations this is. */}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-[11px] text-zinc-500">
                {transactions.length === 0
                  ? 'No charges on this stay yet.'
                  : 'No rows in this view.'}
              </td>
            </tr>
          ) : null}

          {rows.map((entry) => (
            <tr
              key={entry.id}
              className={cn(
                'border-b border-white/[0.04] last:border-0',
                // Dimmed, because a scheduled charge is a forecast and a
                // posted one is a fact.
                !entry.isPosted && 'bg-white/[0.015]',
              )}
            >
              <td className="tabular px-3 py-2 whitespace-nowrap text-zinc-400">
                {formatDate(entry.date)}
              </td>
              <td className="tabular px-3 py-2 text-zinc-400">{entry.room ?? '—'}</td>
              <td className="px-3 py-2 text-zinc-200">
                {entry.description}
                {entry.rolledUpCount > 1 ? (
                  <span
                    title={
                      entry.postedGrossMinor === entry.grossMinor
                        ? `${String(entry.rolledUpCount)} nights, all posted`
                        : `${String(entry.rolledUpCount)} nights · ${money(entry.postedGrossMinor, currency)} posted, the rest scheduled`
                    }
                    className="ml-2 rounded bg-white/[0.07] px-1.5 py-px text-[9px] font-semibold tracking-wider text-zinc-400 uppercase"
                  >
                    {entry.rolledUpCount} nights
                  </span>
                ) : null}
                {entry.isPosted ? null : (
                  <span
                    title="Agreed but not yet charged. A night posts at check-in or by the night audit; an invoice may only be raised from posted lines."
                    className="ml-2 rounded bg-amber-500/15 px-1.5 py-px text-[9px] font-semibold tracking-wider text-amber-300 uppercase"
                  >
                    Scheduled
                  </span>
                )}
              </td>
              <td className="px-3 py-2">
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wider uppercase',
                    entry.direction === 'CREDIT'
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'bg-white/[0.06] text-zinc-400',
                  )}
                >
                  {entry.direction}
                </span>
              </td>
              <EditableFolioCell
                valueMinor={entry.netMinor}
                field="net"
                direction={entry.direction}
                // Net is only a separate instruction where there is tax to
                // compute forward from it. On a credit, or a tax-free charge,
                // net and gross are the same number and two editable cells
                // for one value is a way to disagree with yourself.
                editable={entry.isCorrectable && folioId !== null && entry.taxMinor !== 0}
                format={(minor) => money(minor, currency)}
                title="Click to correct the pre-tax amount"
                onSave={async (magnitudeMinor) => {
                  if (folioId === null) return;
                  onCorrected(
                    // The consolidated row stands for several ledger lines, so
                    // it corrects them in one transaction rather than N calls
                    // that could fail half way.
                    entry.rolledUpCount > 1
                      ? await correctRoomCharges(hotelId, folioId, {
                          netAmountMinor: magnitudeMinor,
                          reason: null,
                        })
                      : await correctFolioCharge(hotelId, folioId, entry.id, {
                          netAmountMinor: magnitudeMinor,
                          reason: null,
                        }),
                  );
                }}
              />
              <td className="tabular px-3 py-2 text-right text-zinc-400">
                {entry.taxMinor === 0 ? '—' : money(entry.taxMinor, currency)}
              </td>
              <EditableFolioCell
                valueMinor={entry.grossMinor}
                field="gross"
                direction={entry.direction}
                editable={entry.isCorrectable && folioId !== null}
                format={(minor) => money(minor, currency)}
                title={
                  entry.correctionCount === 0
                    ? 'Click to correct the gross amount'
                    : `Click to correct. Posted at ${money(entry.originalGrossMinor, currency)}, corrected ${String(entry.correctionCount)} time${entry.correctionCount === 1 ? '' : 's'}.`
                }
                onSave={async (magnitudeMinor) => {
                  if (folioId === null) return;
                  onCorrected(
                    entry.rolledUpCount > 1
                      ? await correctRoomCharges(hotelId, folioId, {
                          grossAmountMinor: magnitudeMinor,
                          reason: null,
                        })
                      : await correctFolioCharge(hotelId, folioId, entry.id, {
                          grossAmountMinor: magnitudeMinor,
                          reason: null,
                        }),
                  );
                }}
                suffix={
                  entry.correctionCount > 0 ? (
                    <span
                      title={`Originally posted at ${money(entry.originalGrossMinor, currency)}`}
                      className="ml-1.5 text-[9px] font-normal text-amber-400/80"
                    >
                      corrected
                    </span>
                  ) : null
                }
              />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Posting sheet                                                              */
/* -------------------------------------------------------------------------- */

function PostingSheet({
  kind,
  hotelId,
  folioId,
  bookingCode,
  currency,
  balanceDueMinor,
  onClose,
  onPosted,
}: {
  kind: 'payment' | 'charge' | 'discount';
  hotelId: string;
  /** Null until a folio exists; a payment opens one server-side. */
  folioId: string | null;
  bookingCode: string;
  currency: string;
  balanceDueMinor: number;
  onClose: () => void;
  onPosted: (page: FolioPage) => void;
}) {
  const [amount, setAmount] = useState(
    kind === 'payment' && balanceDueMinor > 0 ? String(balanceDueMinor / 100) : '',
  );
  const [description, setDescription] = useState('');
  const [tax, setTax] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [remark, setRemark] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Rounded once, at the boundary, into integer minor units — never carried
  // as a float into the request (section 3.4).
  const amountMinor = amount.trim() === '' ? 0 : Math.round(Number(amount) * 100);
  const taxMinor = tax.trim() === '' ? 0 : Math.round(Number(tax) * 100);

  const valid =
    Number.isFinite(amountMinor) &&
    amountMinor > 0 &&
    (kind === 'payment' || description.trim().length > 0);

  async function submit(): Promise<void> {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const payment = {
        method,
        amountMinor,
        remark: remark.trim() === '' ? null : remark.trim(),
      };

      const page =
        kind === 'payment'
          ? // By booking code when there is no folio, so the server opens one;
            // by folio id otherwise, which is one fewer lookup.
            folioId === null
            ? await postFolioPaymentByBooking(hotelId, bookingCode, payment)
            : await postFolioPayment(hotelId, folioId, payment)
          : kind === 'charge'
            ? await postFolioCharge(hotelId, folioId as string, {
                description: description.trim(),
                netAmountMinor: amountMinor,
                taxAmountMinor: Number.isFinite(taxMinor) ? taxMinor : 0,
                chargeDate: null,
              })
            : await postFolioDiscount(hotelId, folioId as string, {
                reason: description.trim(),
                amountMinor,
              });
      onPosted(page);
    } catch (caught) {
      // Surfaced, never swallowed: a posting that silently failed leaves a
      // clerk believing money was taken.
      setError(caught instanceof Error ? caught.message : 'The posting could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  const title =
    kind === 'payment' ? 'Collect payment' : kind === 'charge' ? 'Add charge' : 'Apply discount';

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={() => {
          if (!saving) onClose();
        }}
        className="fixed inset-0 z-50 cursor-default bg-black/60"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed top-1/2 left-1/2 z-50 flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-2xl border border-white/[0.08] bg-[#0f141f] p-5 shadow-2xl"
      >
        <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>

        {kind === 'payment' ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
              Method
            </span>
            <select
              value={method}
              onChange={(event) => {
                setMethod(event.target.value as PaymentMethod);
              }}
              className="h-10 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 text-xs text-zinc-200 outline-none focus:border-blue-500/50"
            >
              {paymentMethodSchema.options.map((option) => (
                <option key={option} value={option} className="bg-zinc-900">
                  {PAYMENT_METHOD_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
              {kind === 'charge' ? 'Description' : 'Reason'}
            </span>
            <input
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
              placeholder={kind === 'charge' ? 'Laundry, minibar, spa…' : 'Goodwill, rate match…'}
              className="h-10 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500/50"
            />
          </label>
        )}

        <div className={cn('grid gap-3', kind === 'charge' && 'grid-cols-2')}>
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
              {kind === 'charge' ? 'Net amount' : 'Amount'}
            </span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
              placeholder={currency}
              className="tabular h-10 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500/50"
            />
          </label>

          {kind === 'charge' ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                Tax
              </span>
              <input
                inputMode="decimal"
                value={tax}
                onChange={(event) => {
                  setTax(event.target.value);
                }}
                placeholder="0.00"
                title="Supplied explicitly: an outlet item may be zero-rated or sit in a different slab from the room tariff."
                className="tabular h-10 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500/50"
              />
            </label>
          ) : null}
        </div>

        {kind === 'payment' ? (
          <input
            value={remark}
            onChange={(event) => {
              setRemark(event.target.value);
            }}
            placeholder="Reference or remark (optional)"
            className="h-9 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500/50"
          />
        ) : null}

        {error !== null ? (
          <p className="rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2 text-[11px] text-rose-200">
            {error}
          </p>
        ) : null}

        <div className="mt-1 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-white/[0.08] px-3 py-2 text-xs text-zinc-300 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || saving}
            onClick={() => {
              void submit();
            }}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-emerald-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
            Post
          </button>
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Small pieces                                                               */
/* -------------------------------------------------------------------------- */

function CopyChip({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => {
            setCopied(false);
          }, 1200);
        });
      }}
      title={`Copy ${value}`}
      className="flex items-center gap-1 rounded border border-white/[0.08] bg-black/30 px-2 py-0.5 font-mono text-[10px] text-zinc-400 transition-colors hover:text-white"
    >
      {copied ? (
        <Check className="size-2.5 text-emerald-400" aria-hidden="true" />
      ) : (
        <Copy className="size-2.5" aria-hidden="true" />
      )}
      {label}
    </button>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'CHECKED_IN'
      ? 'border-emerald-400/30 bg-emerald-500/[0.14] text-emerald-300'
      : status === 'CONFIRMED'
        ? 'border-amber-400/30 bg-amber-500/[0.14] text-amber-300'
        : 'border-white/[0.1] bg-white/[0.04] text-zinc-300';

  return (
    <span
      className={cn('rounded border px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase', tone)}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string | undefined;
}) {
  return (
    <div className="text-right">
      <p className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">{label}</p>
      <p className={cn('tabular text-sm font-bold', tone ?? 'text-zinc-100')}>{value}</p>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[9px] font-semibold tracking-wider text-zinc-600 uppercase">{label}</dt>
      <dd className="mt-0.5 truncate text-[11px] text-zinc-300" title={value}>
        {value}
      </dd>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] text-zinc-500" title={hint}>
        {label}
      </span>
      <span className="tabular text-xs text-zinc-200">{value}</span>
    </div>
  );
}

function ActionPill({
  icon: Icon,
  label,
  needs,
  onClick,
  disabled = false,
  disabledReason,
}: {
  icon: typeof FileText;
  label: string;
  needs?: string;
  onClick?: () => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const inert = needs !== undefined || disabled;
  return (
    <button
      type="button"
      disabled={inert}
      onClick={onClick}
      title={
        needs !== undefined
          ? `Not built yet — needs ${needs} (CLAUDE.md section 2)`
          : (disabledReason ?? label)
      }
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.08] px-2.5 py-1.5',
        'text-[11px] font-semibold tracking-wider uppercase transition-colors',
        inert
          ? 'cursor-not-allowed text-zinc-500 opacity-60'
          : 'text-zinc-200 hover:border-white/25 hover:bg-white/[0.04]',
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}
