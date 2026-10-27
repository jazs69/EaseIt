'use client';

/**
 * Reservation detail drawer, opened by clicking a block.
 *
 * ===========================================================================
 * Four cards: the booking, its guests, its money, its notes.
 *
 * The block the grid hands over is only enough for the header — it carries no
 * guest list, no company, no folio lines and no notes, because a room x date
 * grid has no use for them. So the drawer opens on the block (instant, no
 * spinner for the name and dates the clerk just clicked) and fetches the rest
 * underneath it.
 *
 * **Actions that are not built are visibly disabled, never faked.** Each
 * carries the module it waits on, the same convention this drawer has always
 * used. A button that silently does nothing is worse than an absent one: it
 * teaches a front desk that the screen lies, and then the working buttons are
 * not trusted either.
 *
 * Closes on Escape and on a backdrop click, and moves focus to the panel when
 * it opens — a drawer that traps nothing and announces nothing is a dead end
 * for anyone not using a mouse.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import {
  MEAL_PLAN_LABELS,
  RESERVATION_SUB_STATUS_LABELS,
  type ReservationDetail,
  type ReservationNoteView,
  type TimelineBlock,
} from '@repo/types';
import {
  BedDouble,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  Copy,
  FileText,
  Footprints,
  KeyRound,
  Loader2,
  Mail,
  NotebookPen,
  Phone,
  Printer,
  StickyNote,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { formatMoney } from '@/lib/money';
import { addReservationNote, fetchReservationDetail } from '@/lib/properties-client';
import { ModifyMenu } from './modify-menu';

/** `2026-10-16` -> `Oct 16, 2026`. Parsed as UTC, never through local time. */
function formatDate(isoDate: string): string {
  const [year = '', month = '01', day = '01'] = isoDate.split('-');
  const monthName =
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
      Number(month) - 1
    ] ?? month;
  return `${monthName} ${day}, ${year}`;
}

/** `12:00` -> `12:00 PM`. */
function formatClock(wallClock: string): string {
  const [hourText = '0', minute = '00'] = wallClock.split(':');
  const hour24 = Number(hourText);
  const meridiem = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${String(hour12)}:${minute} ${meridiem}`;
}

/** An instant -> `Oct 16, 2026 · 2:04 PM`, in the viewer's own zone. */
function formatInstant(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} · ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

const STATUS_TONE: Record<string, string> = {
  CHECKED_IN: 'border-emerald-400/30 bg-emerald-500/[0.14] text-emerald-300',
  CONFIRMED: 'border-amber-400/30 bg-amber-500/[0.14] text-amber-300',
  CHECKED_OUT: 'border-zinc-400/25 bg-zinc-500/[0.14] text-zinc-300',
  CANCELLED: 'border-rose-400/30 bg-rose-500/[0.14] text-rose-300',
  NO_SHOW: 'border-rose-400/30 bg-rose-500/[0.14] text-rose-300',
};

export interface ReservationDrawerProps {
  block: TimelineBlock | null;
  roomNumber: string | null;
  hotelId: string;
  onClose: () => void;
  /** Opens the check-in sheet for this stay. */
  onCheckIn: (reservationId: string) => void;
}

export function ReservationDrawer({
  block,
  roomNumber,
  hotelId,
  onClose,
  onCheckIn,
}: ReservationDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  const blockId = block?.id ?? null;

  /**
   * The fetched detail, tagged with the reservation it belongs to.
   *
   * ===========================================================================
   * Tagged rather than cleared, because clearing needs an effect.
   *
   * The obvious shape is `detail` plus a `setDetail(null)` at the top of the
   * fetch effect, so opening a second booking does not briefly show the first
   * one's guests. That is the cascading render `react-hooks/set-state-in-effect`
   * rejects, and it is also a real flash: the component renders once with the
   * wrong detail before the reset lands.
   *
   * Storing which id the payload is for removes both. A payload for another
   * reservation is simply not used during render, so there is nothing to
   * clear and nothing renders stale for even one frame.
   * ===========================================================================
   */
  const [loaded, setLoaded] = useState<{
    id: string;
    detail: ReservationDetail | null;
    error: string | null;
  } | null>(null);

  const forThisBlock = loaded !== null && loaded.id === blockId ? loaded : null;
  const detail = forThisBlock?.detail ?? null;
  const loadError = forThisBlock?.error ?? null;

  /**
   * Fetch the expanded detail for whichever stay is open.
   *
   * Keyed on the id rather than the block object: re-rendering the grid builds
   * new block objects for the same stays, and depending on the object would
   * refetch on every parent render.
   */
  useEffect(() => {
    if (blockId === null) return;

    const controller = new AbortController();

    fetchReservationDetail(hotelId, blockId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setLoaded({ id: blockId, detail: result, error: null });
        }
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        // Surfaced, not swallowed. The header still renders from the block, so
        // a failed detail fetch degrades the panel rather than blanking it.
        setLoaded({
          id: blockId,
          detail: null,
          error:
            caught instanceof Error ? caught.message : 'The full detail could not be loaded.',
        });
      });

    return () => {
      controller.abort();
    };
  }, [hotelId, blockId]);

  useEffect(() => {
    if (block === null) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [block, onClose]);

  if (block === null) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close reservation details"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Reservation for ${block.guestName}`}
        tabIndex={-1}
        className="relative flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto border-l border-white/[0.1] bg-[#0b0b0d] p-4 shadow-2xl focus:outline-none"
      >
        <header className="flex items-center justify-between gap-3">
          <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-white">
            {detail?.isWalkIn === true ? (
              <Footprints className="size-4 shrink-0 text-zinc-500" aria-hidden="true" />
            ) : null}
            <span className="truncate">Reservation details</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-8 shrink-0 place-items-center rounded-lg text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        {loadError !== null ? (
          <p className="rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2 text-[11px] text-rose-200">
            {loadError}
          </p>
        ) : null}

        <BookingCard
          block={block}
          roomNumber={roomNumber}
          detail={detail}
          hotelId={hotelId}
          onCheckIn={onCheckIn}
          onClose={onClose}
        />
        <GuestsCard detail={detail} />
        <PaymentCard block={block} detail={detail} />
        <NotesCard
          detail={detail}
          hotelId={hotelId}
          reservationId={block.id}
          onAdded={(note) => {
            // Prepended locally rather than refetching: the server returned
            // the saved row, so the list is already correct.
            setLoaded((current) =>
              current === null || current.detail === null
                ? current
                : {
                    ...current,
                    detail: { ...current.detail, notes: [note, ...current.detail.notes] },
                  },
            );
          }}
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  1. The booking                                                             */
/* -------------------------------------------------------------------------- */

function BookingCard({
  block,
  roomNumber,
  detail,
  hotelId,
  onCheckIn,
  onClose,
}: {
  block: TimelineBlock;
  roomNumber: string | null;
  detail: ReservationDetail | null;
  hotelId: string;
  onCheckIn: (reservationId: string) => void;
  /** Closes the drawer once the stay it describes no longer exists as drawn. */
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  /**
   * The grid behind this drawer is a server render.
   *
   * `calendar/page.tsx` is a server component that fetches the timeline and
   * passes it to `TimelineContainer` as a prop, so client state cannot move a
   * block: only a new server render can. `router.refresh()` is what triggers
   * one, and it is the same mechanism `check-in-modal.tsx` uses to turn a
   * block from amber to emerald. Closing the drawer alone would leave the
   * cancelled stay drawn on the grid, with its room still looking occupied.
   */
  const router = useRouter();

  const status = detail?.status ?? block.status;
  const subStatus = detail?.subStatus ?? block.subStatus;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h3 className="truncate text-base font-semibold text-white">{block.guestName}</h3>
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                'rounded border px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase',
                STATUS_TONE[status] ?? 'border-white/[0.1] bg-white/[0.04] text-zinc-200',
              )}
            >
              {status.replace(/_/g, ' ')}
            </span>
            {subStatus !== null ? (
              <span className="rounded border border-rose-400/30 bg-rose-500/[0.14] px-2 py-0.5 text-[10px] font-bold tracking-wider text-rose-300 uppercase">
                {RESERVATION_SUB_STATUS_LABELS[subStatus]}
              </span>
            ) : null}
          </div>
        </div>

        <ModifyMenu
          guestName={block.guestName}
          hotelId={hotelId}
          reservationId={block.id}
          bookingCode={block.bookingCode}
          onCancelled={() => {
            // Order matters only for the eye: refresh first so the grid is
            // already correct underneath by the time the drawer gets out of
            // the way. `reservation_room.status` is now CANCELLED, which is
            // outside the timeline's OCCUPYING_STATUSES filter, so the block
            // disappears on the new render.
            router.refresh();
            onClose();
          }}
        />
      </div>

      {/* Meta ribbon */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-1.5 text-[10px] text-zinc-500">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(block.bookingCode).then(() => {
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
              }, 1200);
            });
          }}
          title="Copy booking code"
          className="flex items-center gap-1 font-mono text-zinc-400 transition-colors hover:text-white"
        >
          {copied ? (
            <Check className="size-3 text-emerald-400" aria-hidden="true" />
          ) : (
            <Copy className="size-3" aria-hidden="true" />
          )}
          {block.bookingCode}
        </button>
        <span aria-hidden="true">·</span>
        <span>OTA ID: {detail?.otaBookingId ?? 'NA'}</span>
        {detail?.isMagicLinkActive === true ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="text-violet-300">Magic link active</span>
          </>
        ) : null}
      </div>

      {/* Stay */}
      <div className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
        <CalendarDays className="mt-0.5 size-4 shrink-0 text-zinc-500" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-xs font-medium text-zinc-100">
            {formatDate(block.startDate)} — {formatDate(block.endDate)}
          </p>
          <p className="mt-0.5 text-[10px] text-zinc-500">
            {block.nights} {block.nights === 1 ? 'night' : 'nights'} ·{' '}
            {formatClock(block.checkInTime)} / {formatClock(block.checkOutTime)}
            {detail === null
              ? null
              : ` · ${String(detail.stay.adults)} adults, ${String(detail.stay.children)} children, ${String(detail.stay.infants)} infants`}
          </p>
        </div>
      </div>

      {/* Room */}
      <div className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
        <BedDouble className="mt-0.5 size-4 shrink-0 text-zinc-500" aria-hidden="true" />
        <div className="min-w-0">
          <p className="truncate text-xs font-medium tracking-wide text-zinc-100 uppercase">
            {detail?.room.roomTypeName ?? 'Loading category…'}
          </p>
          <p className="mt-0.5 text-[10px] text-zinc-500">
            {roomNumber === null ? 'No room assigned' : `Room ${roomNumber}`} · Board:{' '}
            {block.mealPlan} — {MEAL_PLAN_LABELS[block.mealPlan]}
          </p>
        </div>
      </div>

      {detail?.company != null ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
          <Building2 className="mt-0.5 size-4 shrink-0 text-zinc-500" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-zinc-100">
              {detail.company.legalName}
            </p>
            {detail.company.gstin !== null ? (
              <p className="mt-0.5 font-mono text-[10px] text-zinc-500">
                GSTIN {detail.company.gstin}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
        <span className="truncate">
          Source: {(detail?.source ?? 'UNKNOWN').replace(/_/g, ' ').toLowerCase()}
        </span>
        <span className="shrink-0">
          {detail === null ? '' : `Booked ${formatInstant(detail.bookedAt)}`}
        </span>
      </div>

      {/* Action bar */}
      <div className="flex flex-wrap gap-1.5 border-t border-white/[0.06] pt-3">
        {/* The full billing page, not a scroll to the card below: the folio
            has its own transactions, tax breakdown and posting actions, none
            of which fit in a 28rem drawer. Routed by booking code because that
            is what a clerk reads aloud, and scoped by hotel because the code
            is only unique within one. */}
        <ActionButton
          icon={FileText}
          label="View folio"
          enabled
          href={`/folio/${encodeURIComponent(block.bookingCode)}?hotelId=${encodeURIComponent(hotelId)}`}
        />
        <ActionButton
          icon={Mail}
          label="Email"
          enabled={false}
          why="Needs the platform module's mail outbox (CLAUDE.md section 2)"
        />
        <ActionButton
          icon={Printer}
          label="Reg card"
          enabled={false}
          why="Needs the frontdesk module's registration card (CLAUDE.md section 2)"
        />
        {detail?.canCheckOut === true ? (
          <ActionButton
            icon={KeyRound}
            label="Check out"
            enabled={false}
            why="Needs the frontdesk module's check-out path (CLAUDE.md section 2)"
          />
        ) : (
          <button
            type="button"
            disabled={detail?.canCheckIn !== true}
            title={
              detail === null
                ? 'Loading…'
                : detail.canCheckIn
                  ? 'Open the check-in sheet'
                  : `Cannot check in a ${detail.status.replace(/_/g, ' ').toLowerCase()} reservation arriving ${formatDate(detail.stay.arrivalDate)}`
            }
            onClick={() => {
              onCheckIn(block.id);
            }}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-[11px] font-semibold text-emerald-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <KeyRound className="size-3.5" aria-hidden="true" />
            Check in
          </button>
        )}
      </div>
    </section>
  );
}

function ActionButton({
  icon: Icon,
  label,
  enabled,
  why,
  onClick,
  href,
}: {
  icon: typeof FileText;
  label: string;
  enabled: boolean;
  why?: string | undefined;
  onClick?: () => void;
  /** Renders a link instead of a button, for an action that navigates. */
  href?: string | undefined;
}) {
  const shell = cn(
    'flex items-center gap-1.5 rounded-lg border border-white/[0.08] px-2.5 py-1.5 text-[11px] transition-colors',
    enabled
      ? 'text-zinc-200 hover:border-white/25 hover:bg-white/[0.04]'
      : 'cursor-not-allowed text-zinc-500 opacity-60',
  );

  // A `Link`, not `router.push` in a click handler: navigation belongs to an
  // anchor, so middle-click and "open in new tab" work, and the browser shows
  // the destination on hover. A clerk opening a folio beside the calendar is
  // the normal case, not an edge one.
  if (enabled && href !== undefined) {
    return (
      <Link href={href} title={label} className={shell}>
        <Icon className="size-3.5" aria-hidden="true" />
        {label}
      </Link>
    );
  }

  return (
    <button
      type="button"
      disabled={!enabled}
      title={enabled ? label : why}
      onClick={onClick}
      className={shell}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  2. Guests                                                                  */
/* -------------------------------------------------------------------------- */

function GuestsCard({ detail }: { detail: ReservationDetail | null }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
          <Users className="size-3.5" aria-hidden="true" />
          Guests
          {detail === null ? null : (
            <span className="text-zinc-600">({detail.guests.length})</span>
          )}
        </h3>
        <button
          type="button"
          disabled
          title="Needs the reservations module's guest-management path (CLAUDE.md section 2)"
          className="cursor-not-allowed rounded-lg border border-white/[0.08] px-2 py-1 text-[10px] font-bold tracking-wider text-zinc-500 uppercase opacity-60"
        >
          Manage guests
        </button>
      </div>

      {detail === null ? (
        <Skeleton rows={2} />
      ) : (
        detail.guests.map((guest) => (
          <div
            key={guest.id}
            className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white/[0.06] text-xs font-semibold text-zinc-300 lowercase">
              {guest.name.trim().charAt(0) || '?'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-xs font-medium text-zinc-100">
                  {guest.name}
                </span>
                {guest.ordinal === 1 ? (
                  <span className="rounded bg-blue-500/15 px-1.5 py-px text-[9px] font-semibold text-blue-300">
                    Primary
                  </span>
                ) : null}
                {guest.govtIdMasked !== null ? (
                  <span
                    title={`${guest.govtIdType ?? 'ID'} on file`}
                    className="rounded bg-emerald-500/15 px-1.5 py-px text-[9px] font-semibold text-emerald-300"
                  >
                    ID verified
                  </span>
                ) : (
                  <span className="rounded bg-amber-500/15 px-1.5 py-px text-[9px] font-semibold text-amber-300">
                    No ID
                  </span>
                )}
              </div>
              {guest.email !== null && guest.email !== '' ? (
                <a
                  href={`mailto:${guest.email}`}
                  className="mt-1 flex items-center gap-1.5 truncate text-[10px] text-blue-400 hover:text-blue-300"
                >
                  <Mail className="size-3 shrink-0" aria-hidden="true" />
                  {guest.email}
                </a>
              ) : null}
              {guest.phone !== null && guest.phone !== '' ? (
                <a
                  href={`tel:${guest.phone.replace(/\s/g, '')}`}
                  className="mt-0.5 flex items-center gap-1.5 text-[10px] text-blue-400 hover:text-blue-300"
                >
                  <Phone className="size-3 shrink-0" aria-hidden="true" />
                  {guest.phone}
                </a>
              ) : null}
              {/* Masked, because the server never sends the number itself. */}
              {guest.govtIdMasked !== null ? (
                <p className="mt-0.5 font-mono text-[10px] text-zinc-600">
                  {guest.govtIdType ?? 'ID'} {guest.govtIdMasked}
                </p>
              ) : null}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  3. Payment                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The money card.
 *
 * Two blocks, because there are genuinely two numbers. `stay` is what the
 * booking agreed; `folio` is what has been posted to the ledger. Before
 * check-in there is no folio; after it the folio holds only the nights posted
 * so far, so a single "balance" would have to silently pick one of them.
 *
 * The rows reconcile: room charges + tax = total, and total − paid = balance.
 * A breakdown whose rows do not add up is worse than none, because somebody
 * will reconcile an invoice against it.
 */
function PaymentCard({
  block,
  detail,
}: {
  block: TimelineBlock;
  detail: ReservationDetail | null;
}) {
  const stay = detail?.money.stay ?? null;
  const folio = detail?.money.folio ?? null;

  const currency = stay?.currency ?? block.currency;
  const balance = stay?.balanceMinor ?? block.balanceAmountMinor;
  const settled = balance <= 0;
  const paid = stay?.paidMinor ?? block.paidAmountMinor;

  return (
    <section
      id="drawer-payment"
      className="flex flex-col gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3.5"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
          Payment
        </h3>
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 text-[10px] font-semibold',
            settled
              ? 'border-emerald-400/30 bg-emerald-500/[0.12] text-emerald-300'
              : paid > 0
                ? 'border-amber-400/30 bg-amber-500/[0.12] text-amber-300'
                : 'border-rose-400/30 bg-rose-500/[0.12] text-rose-300',
          )}
        >
          {settled ? 'Fully paid' : paid > 0 ? 'Partially paid' : 'Payment due'}
        </span>
      </div>

      {stay === null ? (
        <Skeleton rows={4} />
      ) : (
        <>
          <Row label="Room charges" value={formatMoney(stay.netMinor, currency)} />
          <Row
            label={stay.taxIsInclusive ? 'Tax (included)' : 'Tax'}
            value={formatMoney(stay.taxMinor, currency)}
          />
          <Row label="Total amount" value={formatMoney(stay.totalMinor, currency)} bold />
          <Row
            label="Paid"
            value={formatMoney(stay.paidMinor, currency)}
            tone={stay.paidMinor > 0 ? 'text-emerald-400' : undefined}
          />
          <div className="my-0.5 border-t border-white/[0.08]" />
          <Row
            label="Balance due"
            value={formatMoney(stay.balanceMinor, currency)}
            tone={settled ? 'text-emerald-400' : 'text-rose-400'}
            bold
          />
        </>
      )}

      {/* The posted ledger, when one exists. Its balance is the sum of the
          lines above it, never a stored column (CLAUDE.md section 3.4). */}
      {folio !== null ? (
        <div className="mt-1.5 flex flex-col gap-1 rounded-lg border border-white/[0.06] bg-black/20 p-2.5">
          <p className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
            Folio — posted so far
          </p>
          {folio.lines.map((line) => (
            <div key={line.id} className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[10px] text-zinc-500">{line.description}</span>
              <span
                className={cn(
                  'tabular shrink-0 text-[10px]',
                  line.amountMinor < 0 ? 'text-emerald-400' : 'text-zinc-300',
                )}
              >
                {formatMoney(line.amountMinor, folio.currency)}
              </span>
            </div>
          ))}
          <div className="mt-0.5 flex items-baseline justify-between gap-2 border-t border-white/[0.06] pt-1">
            <span className="text-[10px] font-semibold text-zinc-400">Folio balance</span>
            <span className="tabular text-[10px] font-bold text-zinc-100">
              {formatMoney(folio.balanceMinor, folio.currency)}
            </span>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        disabled
        title="Needs the folios module's settlement path (CLAUDE.md section 2)"
        className="mt-1 flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-lg border border-white/[0.08] py-2 text-[11px] font-bold tracking-wider text-zinc-500 uppercase opacity-60"
      >
        Settle dues
        <ChevronDown className="size-3" aria-hidden="true" />
      </button>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  4. Notes                                                                   */
/* -------------------------------------------------------------------------- */

function NotesCard({
  detail,
  hotelId,
  reservationId,
  onAdded,
}: {
  detail: ReservationDetail | null;
  hotelId: string;
  reservationId: string;
  onAdded: (note: ReservationNoteView) => void;
}) {
  const [composing, setComposing] = useState(false);
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (body.trim().length === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const note = await addReservationNote(hotelId, reservationId, { body: body.trim() });
      onAdded(note);
      setBody('');
      setComposing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The note could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
          <StickyNote className="size-3.5" aria-hidden="true" />
          Notes
        </h3>
        <button
          type="button"
          onClick={() => {
            setComposing((open) => !open);
          }}
          className="rounded-lg border border-white/[0.08] px-2 py-1 text-[10px] font-bold tracking-wider text-zinc-300 uppercase transition-colors hover:border-white/25"
        >
          Add note
        </button>
      </div>

      {composing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
            }}
            rows={3}
            maxLength={2000}
            placeholder="Visible to staff only. Notes cannot be edited once saved."
            className="w-full resize-none rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500/50"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setComposing(false);
                setBody('');
              }}
              className="rounded-lg border border-white/[0.08] px-2.5 py-1.5 text-[11px] text-zinc-300"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={body.trim().length === 0 || saving}
              onClick={() => {
                void save();
              }}
              className="flex items-center gap-1.5 rounded-lg bg-blue-500 px-2.5 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? (
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              ) : (
                <NotebookPen className="size-3" aria-hidden="true" />
              )}
              Save
            </button>
          </div>
          {error !== null ? (
            <p className="text-[10px] text-rose-300">{error}</p>
          ) : null}
        </div>
      ) : null}

      {/* The note captured when the booking was taken. It has no author and no
          timestamp, so it is labelled as what it is rather than dressed up as
          a log entry. */}
      {detail?.bookingNote != null && detail.bookingNote.trim() !== '' ? (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
          <p className="text-[9px] font-semibold tracking-wider text-zinc-600 uppercase">
            From the booking
          </p>
          <p className="mt-1 text-[11px] whitespace-pre-wrap text-zinc-300">
            {detail.bookingNote}
          </p>
        </div>
      ) : null}

      {detail === null ? (
        <Skeleton rows={1} />
      ) : detail.notes.length === 0 && (detail.bookingNote ?? '').trim() === '' ? (
        <div className="flex items-center gap-2 py-2 text-[11px] text-zinc-600">
          <StickyNote className="size-4" aria-hidden="true" />
          No internal notes
        </div>
      ) : (
        detail.notes.map((note) => (
          <div
            key={note.id}
            className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5"
          >
            <p className="text-[11px] whitespace-pre-wrap text-zinc-300">{note.body}</p>
            <p className="mt-1.5 text-[9px] text-zinc-600">
              {note.authorName} · {formatInstant(note.createdAt)}
            </p>
          </div>
        ))
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Shared                                                                     */
/* -------------------------------------------------------------------------- */

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-1.5" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="h-7 animate-pulse rounded bg-white/[0.04]" />
      ))}
    </div>
  );
}

function Row({
  label,
  value,
  tone,
  bold = false,
}: {
  label: string;
  value: string;
  tone?: string | undefined;
  bold?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] text-zinc-500">{label}</span>
      <span
        className={cn(
          'tabular truncate text-right text-xs',
          bold ? 'font-semibold' : 'font-normal',
          tone ?? 'text-zinc-200',
        )}
      >
        {value}
      </span>
    </div>
  );
}
