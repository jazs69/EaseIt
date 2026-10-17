'use client';

/**
 * Create reservation.
 *
 * ===========================================================================
 * The price on screen is **the server's price**, not this form's arithmetic.
 *
 * It would be easy to compute ex-tax, GST and total here — the rules are four
 * lines — and the form would feel faster. It would also be the second
 * implementation of those rules, and the two would drift: a slab boundary
 * changes on the server, the browser keeps charging 12%, and the number the
 * guest agreed to stops matching the number the hotel books. So every change
 * to dates, rate or tax exemption asks `/reservations/quote`, debounced, and
 * the form renders whatever comes back.
 *
 * The submit sends no totals at all. The server recomputes them inside the
 * booking transaction, which is what makes a stale quote harmless: it can
 * become a refusal, never a wrong charge.
 *
 * What this form does own is **validity** — a guest name, a departure after
 * the arrival, a payment not exceeding the total. Those are checked here for
 * speed and again on the server for truth.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import {
  BOOKING_SEGMENTS,
  PAYMENT_METHOD_LABELS,
  SUB_SEGMENTS_BY_SEGMENT,
  SUB_SEGMENT_LABELS,
  mealPlanSchema,
  paymentMethodSchema,
  type BookingSegment,
  type BookingSource,
  type CreatedReservation,
  type CreateReservationCommand,
  type ReservationQuoteRequest,
  type MealPlan,
  type PaymentMethod,
  type CompanySummary,
  type ReservationGuestInput,
  type ReservationQuote,
  type TimelineCalendar,
} from '@repo/types';
import {
  CalendarDays,
  CreditCard,
  Loader2,
  Lock,
  Plus,
  User,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { formatMoney } from '@/lib/money';
import { shiftIsoDate } from '@/lib/calendar-format';
import {
  createReservation,
  listCompanies,
  quoteReservation,
} from '@/lib/properties-client';
import { CompanySection } from './company-section';
import { GuestCard, emptyGuest } from './guest-card';

const QUOTE_DEBOUNCE_MS = 250;

/** What a calendar cell hands over when it is clicked. */
export interface CreateReservationSeed {
  roomId: string | null;
  roomNumber: string | null;
  roomTypeId: string;
  roomTypeName: string;
  arrivalDate: string;
}

export interface CreateReservationModalProps {
  /**
   * The clicked cell. Non-null: the container mounts this component only when
   * there is something to create, and remounts it with a `key` when the cell
   * changes — so the form's state is initialised from the seed rather than
   * copied into it by an effect. That is what removes the cascading render
   * `react-hooks/set-state-in-effect` rejects, and it means the first paint is
   * already pre-filled instead of filling in a frame later.
   */
  seed: CreateReservationSeed;
  calendar: TimelineCalendar;
  hotelId: string;
  onClose: () => void;
}

/* -------------------------------------------------------------------------- */
/*  Small shared pieces                                                       */
/* -------------------------------------------------------------------------- */

function Card({
  icon: Icon,
  tone,
  title,
  children,
}: {
  icon: typeof CalendarDays;
  tone: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-[#0f141f]/70 p-4">
      <h3 className="mb-3 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
        <span className={cn('grid size-6 place-items-center rounded-lg', tone)}>
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Field({
  label,
  required,
  children,
  hint,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] font-medium tracking-wide text-zinc-500 uppercase">
        {label}
        {required === true ? <span className="ml-0.5 text-rose-400">*</span> : null}
      </span>
      {children}
      {hint !== undefined ? <span className="text-[10px] text-zinc-600">{hint}</span> : null}
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border border-white/10 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-white placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none';

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex flex-col">
        <span className="text-xs text-zinc-200">{label}</span>
        {hint !== undefined ? <span className="text-[10px] text-zinc-600">{hint}</span> : null}
      </span>
      {/* A 24px track with a 20px thumb and a 2px transparent border, so the
          thumb is inset by the border on both sides and travels exactly
          `w-11 - w-5 - 2*border` = 20px. The previous version positioned the
          thumb absolutely and nudged it with fractional translates, which left
          it a hair proud of the track at one end. An inline-flex track with a
          transform does the containment arithmetically instead of by eye. */}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => {
          onChange(!checked);
        }}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full',
          'border-2 border-transparent transition-colors duration-200 ease-in-out',
          'focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none',
          checked ? 'bg-blue-600' : 'bg-zinc-800',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            // No `transform` class. In Tailwind v4 `translate-x-*` sets the
            // standalone `translate` property, while the legacy `transform`
            // utility emits a competing `transform: none` — with both present
            // the thumb only sometimes travelled, which is worse than never.
            // The brief's class list is the v3 recipe, where `transform` was
            // required to opt in to transforms at all.
            'pointer-events-none inline-block size-5 rounded-full bg-white',
            'shadow-lg ring-0 transition duration-200 ease-in-out',
            checked ? 'translate-x-5' : 'translate-x-0',
          )}
        />
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Modal                                                                     */
/* -------------------------------------------------------------------------- */

export function CreateReservationModal({
  seed,
  calendar,
  hotelId,
  onClose,
}: CreateReservationModalProps) {
  const router = useRouter();

  const [arrivalDate, setArrivalDate] = useState(seed.arrivalDate);
  const [departureDate, setDepartureDate] = useState(() => shiftIsoDate(seed.arrivalDate, 1));
  const [roomTypeId, setRoomTypeId] = useState(seed.roomTypeId);
  const [roomId, setRoomId] = useState<string | null>(seed.roomId);

  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [infants, setInfants] = useState(0);

  const [mealPlan, setMealPlan] = useState<MealPlan>('EP');
  const [segment, setSegment] = useState<BookingSegment>('DIRECT');
  const [source, setSource] = useState<BookingSource>('WALK_IN');

  const [guests, setGuests] = useState<ReservationGuestInput[]>(() => [emptyGuest()]);
  const [companies, setCompanies] = useState<readonly CompanySummary[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(null);

  const [isTaxExempt, setTaxExempt] = useState(false);
  const [overrideOn, setOverrideOn] = useState(false);
  const [overrideRate, setOverrideRate] = useState('');
  const [targetTotal, setTargetTotal] = useState('');
  /**
   * Which direction the last Apply came from.
   *
   * The two inputs are two views of one price, so exactly one can be the
   * source at a time — holding both would let the form display a per-night
   * rate and a total that do not agree with each other.
   */
  const [priceMode, setPriceMode] = useState<'nightly' | 'total'>('nightly');
  /**
   * Which rate field has focus, or null.
   *
   * Drives the contextual Apply buttons. They exist only while their own input
   * is being edited, so the card is not permanently carrying two buttons for an
   * override that most bookings never touch.
   */
  const [editingField, setEditingField] = useState<'nightly' | 'total' | null>(null);
  const [appliedRate, setAppliedRate] = useState<number | undefined>(undefined);
  const [appliedTotal, setAppliedTotal] = useState<number | undefined>(undefined);
  const [showSplit, setShowSplit] = useState(false);

  const [collectPayment, setCollectPayment] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentRemark, setPaymentRemark] = useState('');

  const [instantCheckIn, setInstantCheckIn] = useState(false);

  // The last price the server returned. `quote` below is the one that applies
  // to the window currently on screen — a stay of zero nights has no price,
  // and deriving that is what keeps the effect free of state writes.
  const [serverQuote, setServerQuote] = useState<ReservationQuote | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CreatedReservation | null>(null);

  const quoteSequence = useRef(0);

  // Escape closes, unless a submit is in flight — losing a half-written
  // booking to a stray keypress is worse than the extra click.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [submitting, onClose]);

  const nights = useMemo(() => {
    if (arrivalDate === '' || departureDate === '') return 0;
    const from = new Date(`${arrivalDate}T00:00:00Z`).getTime();
    const to = new Date(`${departureDate}T00:00:00Z`).getTime();
    return Math.round((to - from) / 86_400_000);
  }, [arrivalDate, departureDate]);

  const quote = nights > 0 ? serverQuote : null;

  // The property's saved corporate accounts. Fetched once per mount; the form
  // is remounted per clicked cell, so there is no stale list to invalidate.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const rows = await listCompanies(hotelId);
        if (!controller.signal.aborted) setCompanies(rows);
      } catch {
        // A missing company list is not a reason to block a booking; the
        // section simply offers "no company" and the Add flow still works.
      }
    })();
    return () => {
      controller.abort();
    };
  }, [hotelId]);

  /** Guests are kept at exactly the adult count, never silently dropped. */
  function patchGuest(index: number, patch: Partial<ReservationGuestInput>): void {
    setGuests((current) =>
      current.map((guest, position) =>
        position === index ? { ...guest, ...patch } : guest,
      ),
    );
  }

  // Only an *applied* figure prices the stay. Typing in the box changes
  // nothing until Apply, which is the point of the explicit trigger: a rate
  // half-typed is not a rate, and re-quoting on every keystroke would charge
  // ₹5 on the way to ₹5,020.
  const overrideMinor = overrideOn && priceMode === 'nightly' ? appliedRate : undefined;
  const targetMinor = overrideOn && priceMode === 'total' ? appliedTotal : undefined;

  function applyNightly(): void {
    const major = Number(overrideRate);
    if (!Number.isFinite(major) || major < 0) return;
    setPriceMode('nightly');
    setAppliedRate(Math.round(major * 100));
    setAppliedTotal(undefined);
  }

  function applyTotal(): void {
    const major = Number(targetTotal);
    if (!Number.isFinite(major) || major < 0) return;
    setPriceMode('total');
    setAppliedTotal(Math.round(major * 100));
    setAppliedRate(undefined);
  }

  /**
   * The field that is *not* the price source displays what the server computed.
   *
   * Apply a per-night rate and the gross box should show the resulting total;
   * apply a total and the per-night box should show the rate it reversed into.
   * Derived at render rather than copied into state by an effect — the effect
   * version is the cascading render `react-hooks/set-state-in-effect` rejects,
   * and it would also fight the user by overwriting a box they are typing in.
   *
   * The source is whichever field is focused, falling back to whichever was
   * last applied. So typing in either box always shows your own text, and the
   * other box always shows the server's figure.
   */
  const priceSource = editingField ?? priceMode;
  const nightlyDisplay =
    priceSource === 'nightly' || quote === null
      ? overrideRate
      : String(quote.nightlyRateMinor / 100);
  const totalDisplay =
    priceSource === 'total' || quote === null
      ? targetTotal
      : String(quote.totalMinor / 100);

  /** Re-quote whenever anything priced changes. */
  useEffect(() => {
    // No synchronous setState here. A window with no nights simply does not
    // ask for a price; the render derives "no quote applies" from `nights`
    // instead, which is a value, not a state transition.
    if (roomTypeId === '' || nights <= 0) return;

    const controller = new AbortController();
    const sequence = quoteSequence.current + 1;
    quoteSequence.current = sequence;

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const next = await quoteReservation(
            hotelId,
            {
              // Branded ids and dates. These strings came *from* the server —
              // category ids and column dates off the calendar payload — so
              // the brand is being restored, not invented, and every one is
              // re-validated by the endpoint's own schema on arrival.
              roomTypeId: roomTypeId as ReservationQuoteRequest['roomTypeId'],
              arrivalDate: arrivalDate as ReservationQuoteRequest['arrivalDate'],
              departureDate: departureDate as ReservationQuoteRequest['departureDate'],
              isTaxExempt,
              ...(overrideMinor === undefined ? {} : { overrideNightlyRateMinor: overrideMinor }),
              ...(targetMinor === undefined ? {} : { targetTotalMinor: targetMinor }),
            },
            controller.signal,
          );
          // Only the newest quote may write state; an aborted request can
          // already have settled.
          if (quoteSequence.current !== sequence) return;
          setServerQuote(next);
        } catch (caught) {
          if (quoteSequence.current !== sequence) return;
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          setServerQuote(null);
        }
      })();
    }, QUOTE_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [hotelId, roomTypeId, arrivalDate, departureDate, isTaxExempt, overrideMinor, targetMinor, nights]);

  const roomsForType = calendar.rooms.filter((room) => room.roomTypeId === roomTypeId);
  const nameMissing = (guests[0]?.firstName ?? '').trim().length === 0;
  const paymentMinor = collectPayment ? Math.round(Number(paymentAmount) * 100) : 0;
  const paymentTooBig =
    collectPayment && quote !== null && paymentMinor > quote.totalMinor;

  const canSubmit =
    !nameMissing &&
    nights > 0 &&
    quote !== null &&
    !submitting &&
    !(collectPayment && (!Number.isFinite(paymentMinor) || paymentMinor <= 0)) &&
    !paymentTooBig;

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const result = await createReservation(hotelId, {
        // Same boundary cast as the quote above: restored brands on values the
        // server issued, re-validated server-side.
        roomTypeId: roomTypeId as CreateReservationCommand['roomTypeId'],
        roomId: roomId as CreateReservationCommand['roomId'],
        arrivalDate: arrivalDate as CreateReservationCommand['arrivalDate'],
        departureDate: departureDate as CreateReservationCommand['departureDate'],
        adults,
        children,
        infants,
        mealPlan,
        source,
        // Blank trailing cards are dropped rather than submitted: a clerk who
        // adds a guest row and then does not fill it meant the first thing,
        // and an empty name would be rejected by the schema anyway.
        guests: guests
          .filter((guest, index) => index === 0 || guest.firstName.trim().length > 0)
          .map((guest) => ({
            ...guest,
            firstName: guest.firstName.trim(),
            lastName: guest.lastName.trim(),
          })),
        companyId,
        isTaxExempt,
        ...(overrideMinor === undefined ? {} : { overrideNightlyRateMinor: overrideMinor }),
        ...(targetMinor === undefined ? {} : { targetTotalMinor: targetMinor }),
        isInstantCheckIn: instantCheckIn,
        payment: collectPayment
          ? {
              method: paymentMethod,
              amountMinor: paymentMinor,
              remark: paymentRemark.trim() === '' ? null : paymentRemark.trim(),
            }
          : null,
        notes: null,
      });

      setDone(result);
      // Re-fetches the server component so the new block appears on the grid.
      router.refresh();
    } catch (caught) {
      // Surfaced, never swallowed. A booking that silently failed is how a
      // room gets sold twice by two clerks who both think they succeeded.
      setError(
        caught instanceof Error ? caught.message : 'The booking could not be created.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={() => {
          if (!submitting) onClose();
        }}
        className="fixed inset-0 z-50 cursor-default bg-black/60"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-reservation-title"
        className="fixed inset-x-0 top-0 z-50 mx-auto flex max-h-screen w-full max-w-5xl flex-col rounded-b-2xl border border-white/[0.1] bg-[#0a0d14] shadow-2xl"
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-3 border-b border-white/[0.08] px-5 py-3">
          <div>
            <h2 id="create-reservation-title" className="text-base font-bold text-white">
              Create reservation
            </h2>
            <p className="tabular text-xs text-zinc-500">
              {seed.roomNumber === null ? seed.roomTypeName : `#${seed.roomNumber}`}
              {nights > 0 ? ` · ${String(nights)} night${nights === 1 ? '' : 's'}` : ''}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled
              title="Blocking a room is maintenance inventory, which the inventory module owns"
              className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-white/[0.08] px-2.5 py-1 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase opacity-60"
            >
              <Lock className="size-3" aria-hidden="true" />
              Block room?
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              aria-label="Close"
              className="grid size-7 place-items-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        {done !== null ? (
          <div className="flex flex-col items-center gap-3 px-5 py-10 text-center">
            <p className="text-sm font-semibold text-emerald-300">
              {done.bookingCode} created
            </p>
            <p className="text-xs text-zinc-400">
              {done.guestName} · {done.roomTypeName}
              {done.roomNumber === null ? ' · unassigned' : ` · Room ${done.roomNumber}`} ·{' '}
              {done.status.replace('_', '-')}
            </p>
            <p className="tabular text-xs text-zinc-500">
              {formatMoney(done.quote.totalMinor, done.currency)} total ·{' '}
              {formatMoney(done.balanceAmountMinor, done.currency)} balance
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 rounded-lg bg-white px-4 py-2 text-xs font-semibold text-black transition hover:bg-zinc-200"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {/* Two independently scrolling columns above `lg`, one below it.
                The body itself does not scroll on a wide screen: each column
                owns its own overflow, which is what keeps the price panel
                anchored while guest cards push the left side down.

                Structure rather than `position: sticky`. Sticky resolves
                against the nearest scrolling ancestor, so it only works while
                the body is the thing that scrolls — the moment the columns
                scroll separately there is nothing for it to stick to, and the
                price panel is held in place by the grid instead.

                Below `lg` the columns stack, so two scroll regions would mean
                the price card scrolling inside a short box underneath the
                guest form. There the body scrolls as one, as it did before. */}
            <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-5 lg:grid-cols-12 lg:overflow-hidden">
              {/* ---- Left column: stay and guests, scrolls ---- */}
              <div className="flex flex-col gap-4 lg:col-span-7 lg:min-h-0 lg:overflow-y-auto lg:pr-2">
                <Card icon={CalendarDays} tone="bg-blue-500/15 text-blue-400" title="Stay details">
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="Check-in">
                      <input
                        type="date"
                        value={arrivalDate}
                        onChange={(event) => {
                          setArrivalDate(event.target.value);
                          // Keep the stay at least one night rather than
                          // letting the dates cross over.
                          if (event.target.value >= departureDate) {
                            setDepartureDate(shiftIsoDate(event.target.value, 1));
                          }
                        }}
                        className={cn(inputClass, 'tabular')}
                      />
                    </Field>
                    <Field label="Check-out">
                      <input
                        type="date"
                        value={departureDate}
                        min={shiftIsoDate(arrivalDate === '' ? '2026-01-01' : arrivalDate, 1)}
                        onChange={(event) => {
                          setDepartureDate(event.target.value);
                        }}
                        className={cn(inputClass, 'tabular')}
                      />
                    </Field>
                    <Field label="Nights">
                      <input
                        type="number"
                        min={1}
                        value={nights}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          if (Number.isFinite(next) && next >= 1 && arrivalDate !== '') {
                            setDepartureDate(shiftIsoDate(arrivalDate, next));
                          }
                        }}
                        className={cn(inputClass, 'tabular')}
                      />
                    </Field>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-3">
                    <Field label="Adults">
                      <select
                        value={adults}
                        onChange={(event) => {
                          setAdults(Number(event.target.value));
                        }}
                        className={inputClass}
                      >
                        {[1, 2, 3, 4, 5, 6].map((n) => (
                          <option key={n} value={n} className="bg-zinc-900">
                            {n}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Children (3-12)">
                      <select
                        value={children}
                        onChange={(event) => {
                          setChildren(Number(event.target.value));
                        }}
                        className={inputClass}
                      >
                        {[0, 1, 2, 3, 4].map((n) => (
                          <option key={n} value={n} className="bg-zinc-900">
                            {n}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Infants (0-2)">
                      <select
                        value={infants}
                        onChange={(event) => {
                          setInfants(Number(event.target.value));
                        }}
                        className={inputClass}
                      >
                        {[0, 1, 2, 3].map((n) => (
                          <option key={n} value={n} className="bg-zinc-900">
                            {n}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <Field label="Room type">
                      <select
                        value={roomTypeId}
                        onChange={(event) => {
                          setRoomTypeId(event.target.value);
                          // The old room belongs to the old type.
                          setRoomId(null);
                        }}
                        className={inputClass}
                      >
                        {calendar.categories.map((category) => (
                          <option key={category.id} value={category.id} className="bg-zinc-900">
                            {category.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Room">
                      <span className="flex items-center gap-1.5">
                        <select
                          value={roomId ?? ''}
                          onChange={(event) => {
                            setRoomId(event.target.value === '' ? null : event.target.value);
                          }}
                          className={inputClass}
                        >
                          <option value="" className="bg-zinc-900">
                            Unassigned
                          </option>
                          {roomsForType.map((room) => (
                            <option key={room.id} value={room.id} className="bg-zinc-900">
                              {room.roomNumber}
                            </option>
                          ))}
                        </select>
                        {roomId !== null && roomId === seed.roomId ? (
                          <span className="shrink-0 rounded border border-amber-400/30 bg-amber-500/[0.14] px-1.5 py-0.5 text-[9px] font-semibold text-amber-300">
                            Pre selected
                          </span>
                        ) : null}
                      </span>
                    </Field>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-3">
                    <Field label="Rate plan">
                      <select
                        value={mealPlan}
                        onChange={(event) => {
                          setMealPlan(event.target.value as MealPlan);
                        }}
                        className={inputClass}
                      >
                        {mealPlanSchema.options.map((plan) => (
                          <option key={plan} value={plan} className="bg-zinc-900">
                            {plan}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Segment">
                      <select
                        value={segment}
                        onChange={(event) => {
                          const next = event.target.value as BookingSegment;
                          setSegment(next);
                          // Keep the source inside the new segment.
                          const first = SUB_SEGMENTS_BY_SEGMENT[next][0];
                          if (first !== undefined) setSource(first as BookingSource);
                        }}
                        className={inputClass}
                      >
                        {BOOKING_SEGMENTS.map((value) => (
                          <option key={value} value={value} className="bg-zinc-900">
                            {value.replace('_', ' ')}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Sub-segment">
                      <select
                        value={source}
                        onChange={(event) => {
                          setSource(event.target.value as BookingSource);
                        }}
                        className={inputClass}
                      >
                        {SUB_SEGMENTS_BY_SEGMENT[segment].map((value) => (
                          <option key={value} value={value} className="bg-zinc-900">
                            {SUB_SEGMENT_LABELS[value] ?? value}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                </Card>

                <section className="rounded-2xl border border-white/[0.08] bg-[#0f141f]/70 p-4">
                  <h3 className="mb-3 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
                    <span className="grid size-6 place-items-center rounded-lg bg-violet-500/15 text-violet-400">
                      <User className="size-3.5" aria-hidden="true" />
                    </span>
                    Guest details
                  </h3>

                  <div className="flex flex-col gap-2.5">
                    {guests.map((guest, index) => (
                      <GuestCard
                        key={index}
                        index={index}
                        guest={guest}
                        hotelId={hotelId}
                        onChange={(patch) => {
                          patchGuest(index, patch);
                        }}
                        onRemove={
                          index === 0
                            ? null
                            : () => {
                                setGuests((current) =>
                                  current.filter((_, position) => position !== index),
                                );
                              }
                        }
                      />
                    ))}
                  </div>

                  {/* One button at a time, naming the guest it will add, so a
                      clerk booking three adults is walked through them rather
                      than shown three empty forms at once. Capped at the adult
                      count: infants and children are not separate registrants. */}
                  {guests.length < adults ? (
                    <button
                      type="button"
                      onClick={() => {
                        setGuests((current) => [...current, emptyGuest()]);
                      }}
                      className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-white/15 px-3 py-1.5 text-[11px] font-medium text-zinc-300 transition-colors hover:border-blue-500/40 hover:text-white"
                    >
                      <Plus className="size-3" aria-hidden="true" />
                      Add guest {guests.length + 1}
                    </button>
                  ) : null}

                  {guests.length > adults ? (
                    <p className="mt-2 text-[10px] text-amber-200/70">
                      {guests.length} guests entered for {adults} adult
                      {adults === 1 ? '' : 's'}. Raise the adult count or remove a guest.
                    </p>
                  ) : null}
                </section>

                <CompanySection
                  hotelId={hotelId}
                  companies={companies}
                  selectedId={companyId}
                  onSelect={setCompanyId}
                  onCompanyAdded={(company) => {
                    setCompanies((current) => [...current, company]);
                  }}
                />
              </div>

              {/* ---- Right column: price and payment, anchored ----
                  `overflow-y-auto` rather than the brief's non-scrolling
                  `h-fit`: with Collect payment expanded this card can exceed a
                  laptop viewport, and a fixed-height column would simply clip
                  the amount and remark fields with no way to reach them. It
                  scrolls only when it must, and never moves when the left
                  column does — which is what "stays in place" has to mean. */}
              <div className="flex flex-col gap-4 lg:col-span-5 lg:min-h-0 lg:overflow-y-auto">
                <Card icon={CreditCard} tone="bg-white/10 text-white" title="Price details">
                  <Toggle
                    checked={isTaxExempt}
                    onChange={setTaxExempt}
                    label="Tax exempt"
                    hint="Diplomatic or exempted bookings"
                  />

                  <div className="mt-2 border-t border-white/[0.06] pt-2">
                    <Toggle
                      checked={overrideOn}
                      onChange={(next) => {
                        setOverrideOn(next);
                        if (next && quote !== null) {
                          setOverrideRate(String(quote.nightlyRateMinor / 100));
                          setTargetTotal(String(quote.totalMinor / 100));
                          setAppliedRate(quote.nightlyRateMinor);
                          setAppliedTotal(undefined);
                          setPriceMode('nightly');
                        }
                      }}
                      label="Override rate"
                      hint="Negotiated nightly tariff or walk-out total"
                    />
                  </div>

                  {/* ---- Rate row -------------------------------------
                      Three equal columns, every box exactly h-10, so the boxes
                      share one baseline however long a label is. Labels
                      truncate with a title tooltip rather than wrapping: a
                      wrapped label is what pushed one box a line below its
                      neighbours.

                      The Apply buttons live in a SECOND row on the same
                      3-column track, not inside the cells. Inside, a cell with
                      a button is taller than the two without one, and
                      `items-end` would then lift the boxes out of alignment
                      exactly while a field is being edited — the moment
                      alignment matters most. */}
                  {overrideOn ? (
                    <>
                      <div className="mt-2 grid grid-cols-3 items-end gap-3">
                        <div className="flex min-w-0 flex-col gap-1.5">
                          <label
                            htmlFor="rate-per-night"
                            title="Per night (pre tax)"
                            className="truncate text-[10px] font-semibold tracking-wider text-zinc-400 uppercase"
                          >
                            Per night (pre tax)
                          </label>
                          <input
                            id="rate-per-night"
                            type="number"
                            min={0}
                            value={nightlyDisplay}
                            onFocus={() => {
                              setEditingField('nightly');
                            }}
                            onBlur={() => {
                              setEditingField((current) =>
                                current === 'nightly' ? null : current,
                              );
                            }}
                            onChange={(event) => {
                              setOverrideRate(event.target.value);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                applyNightly();
                                setEditingField(null);
                                event.currentTarget.blur();
                              }
                              if (event.key === 'Escape') {
                                setEditingField(null);
                                event.currentTarget.blur();
                              }
                            }}
                            className="tabular h-10 w-full rounded-lg border border-white/10 bg-zinc-900/80 px-3 text-sm text-white focus:border-blue-500 focus:outline-none"
                          />
                        </div>

                        <div className="flex min-w-0 flex-col gap-1.5">
                          <span
                            title={
                              quote === null
                                ? 'Tax'
                                : `Tax (${String(quote.taxRatePercent)}% GST)`
                            }
                            className="truncate text-[10px] font-semibold tracking-wider text-zinc-400 uppercase"
                          >
                            {quote === null
                              ? 'Tax'
                              : `Tax (${String(quote.taxRatePercent)}% GST)`}
                          </span>
                          {/* Derived, so it is shown rather than entered. */}
                          <output className="tabular flex h-10 w-full items-center rounded-lg border border-white/[0.08] bg-zinc-900/40 px-3 text-sm text-zinc-300 select-none">
                            {quote === null
                              ? '\u2014'
                              : formatMoney(
                                  Math.round(quote.taxMinor / quote.nights),
                                  quote.currency,
                                )}
                          </output>
                        </div>

                        <div className="flex min-w-0 flex-col gap-1.5">
                          <label
                            htmlFor="rate-gross-total"
                            title="Gross total (incl. tax)"
                            className="truncate text-[10px] font-semibold tracking-wider text-zinc-400 uppercase"
                          >
                            Gross total (incl. tax)
                          </label>
                          <input
                            id="rate-gross-total"
                            type="number"
                            min={0}
                            value={totalDisplay}
                            onFocus={() => {
                              setEditingField('total');
                            }}
                            onBlur={() => {
                              setEditingField((current) =>
                                current === 'total' ? null : current,
                              );
                            }}
                            onChange={(event) => {
                              setTargetTotal(event.target.value);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                applyTotal();
                                setEditingField(null);
                                event.currentTarget.blur();
                              }
                              if (event.key === 'Escape') {
                                setEditingField(null);
                                event.currentTarget.blur();
                              }
                            }}
                            className="tabular h-10 w-full rounded-lg border border-white/10 bg-zinc-900/80 px-3 text-sm text-white focus:border-blue-500 focus:outline-none"
                          />
                        </div>
                      </div>

                      {/* Apply row, on the same track. Rendered only while a
                          field has focus, so it takes no height at rest. */}
                      {editingField === null ? null : (
                        <div className="mt-1.5 grid grid-cols-3 gap-3">
                          <div>
                            {editingField === 'nightly' ? (
                              <button
                                type="button"
                                // `onMouseDown`, not `onClick`: the input's
                                // blur fires first on a click and would
                                // unmount this button before it landed.
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  applyNightly();
                                  setEditingField(null);
                                }}
                                className="w-full rounded-lg border border-blue-400/40 bg-blue-500/[0.14] px-2 py-1 text-[10px] font-semibold tracking-wide text-blue-200 uppercase transition-colors hover:bg-blue-500/[0.22]"
                              >
                                Apply per night
                              </button>
                            ) : null}
                          </div>
                          <div />
                          <div>
                            {editingField === 'total' ? (
                              <button
                                type="button"
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  applyTotal();
                                  setEditingField(null);
                                }}
                                className="w-full rounded-lg border border-blue-400/40 bg-blue-500/[0.14] px-2 py-1 text-[10px] font-semibold tracking-wide text-blue-200 uppercase transition-colors hover:bg-blue-500/[0.22]"
                              >
                                Apply total
                              </button>
                            ) : null}
                          </div>
                        </div>
                      )}
                    </>
                  ) : null}

                  {/* A reverse solve cannot always land on the number typed:
                      tax rounds per night, so some totals are unreachable by
                      any integer rate. Saying so beats charging something
                      else. */}
                  {quote?.targetAdjustment != null ? (
                    <p className="mt-2 rounded-lg border border-amber-400/25 bg-amber-500/[0.07] px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-200/90">
                      No nightly rate produces exactly{' '}
                      {formatMoney(quote.targetAdjustment.requestedTotalMinor, quote.currency)}.
                      The closest is{' '}
                      {formatMoney(quote.targetAdjustment.achievedTotalMinor, quote.currency)}.
                    </p>
                  ) : null}

                  <dl className="mt-3 flex flex-col gap-1.5 border-t border-white/[0.06] pt-3">
                    {[
                      ['Per night (pre tax)', quote?.nightlyRateMinor],
                      ['Ex. tax', quote?.exTaxMinor],
                      [
                        quote === null
                          ? 'Tax'
                          : `Tax (${String(quote.taxRatePercent)}% GST)`,
                        quote?.taxMinor,
                      ],
                    ].map(([label, value]) => (
                      <div key={String(label)} className="flex items-baseline justify-between gap-2">
                        <dt className="text-[11px] text-zinc-500">{label}</dt>
                        <dd className="tabular text-xs text-zinc-200">
                          {typeof value === 'number' && quote !== null
                            ? formatMoney(value, quote.currency)
                            : '—'}
                        </dd>
                      </div>
                    ))}
                    <div className="flex items-baseline justify-between gap-2 border-t border-white/[0.06] pt-1.5">
                      <dt className="text-[11px] font-semibold text-zinc-300">
                        Total (including tax)
                      </dt>
                      <dd className="tabular text-sm font-bold text-white">
                        {quote === null ? '—' : formatMoney(quote.totalMinor, quote.currency)}
                      </dd>
                    </div>
                  </dl>

                  {quote !== null && quote.nightly.length > 1 ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setShowSplit((open) => !open);
                        }}
                        className="mt-2 text-[10px] font-semibold tracking-wider text-blue-400 uppercase transition-colors hover:text-blue-300"
                      >
                        {showSplit ? 'Hide day-wise split' : 'View day-wise split'}
                      </button>
                      {showSplit ? (
                        <ul className="mt-2 flex flex-col gap-1">
                          {quote.nightly.map((line) => (
                            <li
                              key={line.stayDate}
                              className="tabular flex items-baseline justify-between text-[10px] text-zinc-500"
                            >
                              <span>{line.stayDate}</span>
                              <span>
                                {formatMoney(line.nightlyRateMinor, quote.currency)} +{' '}
                                {formatMoney(line.taxMinor, quote.currency)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  ) : null}

                  <div className="mt-3 border-t border-white/[0.06] pt-3">
                    <Toggle
                      checked={collectPayment}
                      onChange={setCollectPayment}
                      label="Collect payment"
                      hint="Process payment immediately"
                    />
                    {collectPayment ? (
                      <div className="mt-2 grid grid-cols-2 gap-3">
                        <Field label="Method">
                          <select
                            value={paymentMethod}
                            onChange={(event) => {
                              setPaymentMethod(event.target.value as PaymentMethod);
                            }}
                            className={inputClass}
                          >
                            {paymentMethodSchema.options.map((method) => (
                              <option key={method} value={method} className="bg-zinc-900">
                                {PAYMENT_METHOD_LABELS[method]}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Amount">
                          <input
                            type="number"
                            min={0}
                            value={paymentAmount}
                            onChange={(event) => {
                              setPaymentAmount(event.target.value);
                            }}
                            className={cn(inputClass, 'tabular')}
                          />
                        </Field>
                        <div className="col-span-2">
                          <Field label="Remark">
                            <input
                              value={paymentRemark}
                              onChange={(event) => {
                                setPaymentRemark(event.target.value);
                              }}
                              placeholder="Cheque #882194 drawn on HDFC"
                              className={inputClass}
                            />
                          </Field>
                        </div>
                        {paymentTooBig ? (
                          <p className="col-span-2 text-[10px] text-rose-300">
                            Payment cannot exceed the total owed.
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </Card>
              </div>
            </div>

            {/* Sticky footer */}
            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.08] bg-[#0a0d14] px-5 py-3">
              <div className="flex flex-col">
                <span className="text-[10px] tracking-wider text-zinc-500 uppercase">Total</span>
                <span className="tabular text-xl font-bold text-white">
                  {quote === null ? '—' : formatMoney(quote.totalMinor, quote.currency)}
                </span>
              </div>

              {error !== null ? (
                <p className="max-w-sm text-[11px] text-rose-300">{error}</p>
              ) : null}

              <div className="flex items-center gap-3">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={instantCheckIn}
                    onChange={(event) => {
                      setInstantCheckIn(event.target.checked);
                    }}
                    className="size-3.5 accent-blue-500"
                  />
                  Check-in now
                </label>

                <button
                  type="button"
                  onClick={() => {
                    void submit();
                  }}
                  disabled={!canSubmit}
                  title={nameMissing ? 'A guest name is required' : undefined}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-xs font-semibold text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {submitting ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : null}
                  Create reservation
                </button>
              </div>
            </footer>
          </>
        )}
      </div>
    </>
  );
}
