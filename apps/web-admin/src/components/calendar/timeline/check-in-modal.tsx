'use client';

/**
 * The front-desk check-in sheet.
 *
 * ===========================================================================
 * It opens knowing what is wrong.
 *
 * The pre-flight call tells it which requirements are unmet before the clerk
 * types anything — no room, no ID on file, a dirty room — so the blockers are
 * visible at the top of the form rather than discovered on a failed submit
 * with a guest standing at the desk.
 *
 * The blockers are advisory in exactly the way a price quote is: the server
 * re-derives every one of them inside its transaction. A room that was clean
 * when this opened and dirty by the time the button was pressed is refused
 * there, and the refusal is shown here — never silently let through.
 * ===========================================================================
 */

import { AlertTriangle, BedDouble, Check, KeyRound, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CHECK_IN_BLOCKER_MESSAGES,
  GOVT_ID_TYPE_LABELS,
  OVERRIDABLE_BLOCKERS,
  PAYMENT_METHOD_LABELS,
  govtIdTypeSchema,
  paymentMethodSchema,
  type CheckInBlocker,
  type CheckInPreflight,
  type CheckInRequest,
  type CheckInResult,
  type GovtIdType,
  type PaymentMethod,
} from '@repo/types';

import { cn } from '@repo/ui';

import { checkInReservation, fetchCheckInPreflight } from '@/lib/properties-client';

export interface CheckInModalProps {
  hotelId: string;
  reservationId: string;
  onClose: () => void;
}

const money = (minor: number, currency: string): string =>
  `${currency} ${(minor / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** Housekeeping states, spelled for a human. */
const ROOM_STATE_LABEL: Record<string, string> = {
  VACANT_CLEAN: 'Clean',
  INSPECTED: 'Inspected',
  VACANT_DIRTY: 'Dirty',
  OCCUPIED_CLEAN: 'Occupied',
  OCCUPIED_DIRTY: 'Occupied',
  OUT_OF_SERVICE: 'Out of service',
  OUT_OF_ORDER: 'Out of order',
};

export function CheckInModal({ hotelId, reservationId, onClose }: CheckInModalProps) {
  const router = useRouter();

  const [preflight, setPreflight] = useState<CheckInPreflight | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [roomId, setRoomId] = useState<string | null>(null);
  const [idType, setIdType] = useState<GovtIdType>('AADHAAR');
  const [idNumber, setIdNumber] = useState('');
  const [keyCards, setKeyCards] = useState(2);
  const [registrationSigned, setRegistrationSigned] = useState(false);
  const [acknowledgeDirty, setAcknowledgeDirty] = useState(false);

  const [collectPayment, setCollectPayment] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentRemark, setPaymentRemark] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CheckInResult | null>(null);

  /**
   * Load the pre-flight once.
   *
   * The room selection is seeded from the response here rather than derived
   * during render, because the clerk may then change it — a derived value
   * would snap back to the server's answer on the next render and fight them.
   */
  useEffect(() => {
    const controller = new AbortController();

    fetchCheckInPreflight(hotelId, reservationId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setPreflight(result);
        setRoomId(
          result.assignedRoomId ??
            result.availableRooms.find((room) => room.isClean)?.id ??
            result.availableRooms[0]?.id ??
            null,
        );
        if (result.govtIdType !== null) setIdType(result.govtIdType);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(
          caught instanceof Error ? caught.message : 'This check-in could not be loaded.',
        );
      });

    return () => {
      controller.abort();
    };
  }, [hotelId, reservationId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [submitting, onClose]);

  const selectedRoom =
    preflight === null
      ? null
      : (preflight.availableRooms.find((room) => room.id === roomId) ?? null);

  /**
   * The blocker list, re-derived for the room the clerk actually picked.
   *
   * The server answered for the room that was assigned when the modal opened.
   * Choosing a different one changes which blockers apply, so the ones that
   * depend on the room are recomputed and the rest kept — rather than making a
   * second round trip on every keystroke of the dropdown.
   */
  const roomBlockers: CheckInBlocker[] =
    preflight === null
      ? []
      : selectedRoom === null
        ? ['NO_ROOM_ASSIGNED']
        : selectedRoom.isClean
          ? []
          : ['ROOM_NOT_CLEAN'];

  const hasId =
    idNumber.trim().length > 0 || (preflight?.hasGovtId ?? false);

  const blockers: CheckInBlocker[] =
    preflight === null
      ? []
      : [
          ...preflight.blockers.filter(
            (blocker) =>
              blocker !== 'NO_ROOM_ASSIGNED' &&
              blocker !== 'ROOM_NOT_CLEAN' &&
              blocker !== 'ROOM_OCCUPIED' &&
              blocker !== 'ROOM_OUT_OF_ORDER' &&
              blocker !== 'MISSING_GOVT_ID',
          ),
          ...roomBlockers,
          ...(hasId ? [] : (['MISSING_GOVT_ID'] as CheckInBlocker[])),
        ];

  const overridable = blockers.filter((blocker) => OVERRIDABLE_BLOCKERS.includes(blocker));
  const hard = blockers.filter((blocker) => !OVERRIDABLE_BLOCKERS.includes(blocker));

  const paymentMinor =
    paymentAmount.trim() === '' ? 0 : Math.round(Number(paymentAmount) * 100);
  const paymentValid =
    !collectPayment || (Number.isFinite(paymentMinor) && paymentMinor > 0);

  const canSubmit =
    preflight !== null &&
    !submitting &&
    done === null &&
    hard.length === 0 &&
    (overridable.length === 0 || acknowledgeDirty) &&
    paymentValid;

  async function submit(): Promise<void> {
    if (!canSubmit || preflight === null) return;
    setSubmitting(true);
    setError(null);

    try {
      const body: CheckInRequest = {
        roomId: roomId as CheckInRequest['roomId'],
        primaryGuestIdType: idNumber.trim() === '' ? null : idType,
        primaryGuestIdNumber: idNumber.trim() === '' ? null : idNumber.trim(),
        keyCardsIssued: keyCards,
        registrationCardSigned: registrationSigned,
        acknowledgeRoomNotClean: acknowledgeDirty,
        initialPayment: collectPayment
          ? {
              method: paymentMethod,
              amountMinor: paymentMinor,
              remark: paymentRemark.trim() === '' ? null : paymentRemark.trim(),
            }
          : null,
      };

      const result = await checkInReservation(hotelId, reservationId, body);
      setDone(result);
      // Re-fetches the server component, so the block turns from amber to
      // emerald on the grid behind this sheet.
      router.refresh();
    } catch (caught) {
      // Surfaced, never swallowed: a check-in that silently failed leaves a
      // guest holding keys to a room the system still believes is sellable.
      setError(
        caught instanceof Error ? caught.message : 'The check-in could not be completed.',
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
        aria-label="Check in"
        className="fixed top-1/2 left-1/2 z-50 flex max-h-[92dvh] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0f141f] shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
              <KeyRound className="size-4 text-emerald-400" aria-hidden="true" />
              Check in
            </h2>
            {preflight === null ? (
              <p className="mt-0.5 text-[11px] text-zinc-500">Loading the stay…</p>
            ) : (
              <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                {preflight.guestName} · {preflight.bookingCode} · {preflight.nights}{' '}
                {preflight.nights === 1 ? 'night' : 'nights'} from {preflight.arrivalDate}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              if (!submitting) onClose();
            }}
            aria-label="Close"
            className="rounded-lg p-1 text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        {loadError !== null ? (
          <div className="px-5 py-6 text-xs text-rose-300">{loadError}</div>
        ) : preflight === null ? (
          <div className="flex items-center gap-2 px-5 py-10 text-xs text-zinc-500">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Checking the room, the folio and the paperwork…
          </div>
        ) : done !== null ? (
          /* ---------------------------------------------------- receipt --- */
          <div className="flex flex-col gap-4 px-5 py-6">
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300">
                <Check className="size-5" aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm font-semibold text-zinc-100">
                  {done.guestName} is checked in
                  {done.roomNumber === null ? '' : ` to room ${done.roomNumber}`}
                </p>
                <p className="text-[11px] text-zinc-500">
                  {done.keyCardsIssued} key{done.keyCardsIssued === 1 ? '' : 's'} issued ·{' '}
                  {done.bookingCode}
                </p>
              </div>
            </div>

            {/* The folio as the server returned it. Its balance is the sum of
                these lines, not a number stored anywhere. */}
            <div className="overflow-hidden rounded-xl border border-white/[0.06]">
              <table className="w-full text-[11px]">
                <tbody>
                  {done.folio.lines.map((line) => (
                    <tr key={line.id} className="border-b border-white/[0.04] last:border-0">
                      <td className="px-3 py-2 text-zinc-400">{line.description}</td>
                      <td
                        className={cn(
                          'tabular px-3 py-2 text-right font-medium',
                          line.amountMinor < 0 ? 'text-emerald-300' : 'text-zinc-200',
                        )}
                      >
                        {money(line.amountMinor, done.folio.currency)}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-white/[0.02]">
                    <td className="px-3 py-2 font-semibold text-zinc-300">Folio balance</td>
                    <td className="tabular px-3 py-2 text-right font-bold text-zinc-100">
                      {money(done.folio.balanceMinor, done.folio.currency)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="self-end rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-400"
            >
              Done
            </button>
          </div>
        ) : (
          /* ------------------------------------------------------- form --- */
          <>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
              {hard.length > 0 ? (
                <ul className="flex flex-col gap-1.5 rounded-xl border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2.5">
                  {hard.map((blocker) => (
                    <li
                      key={blocker}
                      className="flex items-start gap-2 text-[11px] text-rose-200"
                    >
                      <AlertTriangle
                        className="mt-px size-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      {CHECK_IN_BLOCKER_MESSAGES[blocker]}
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* ----------------------------------------------- room ---- */}
              <section className="flex flex-col gap-1.5">
                <label
                  htmlFor="checkin-room"
                  className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase"
                >
                  Room
                </label>
                <div className="flex items-center gap-2">
                  <BedDouble className="size-4 shrink-0 text-zinc-500" aria-hidden="true" />
                  <select
                    id="checkin-room"
                    value={roomId ?? ''}
                    onChange={(event) => {
                      setRoomId(event.target.value === '' ? null : event.target.value);
                      // A fresh choice is a fresh decision: an acknowledgement
                      // of the previous room's state must not carry over.
                      setAcknowledgeDirty(false);
                    }}
                    className="h-10 min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-zinc-200 outline-none focus:border-blue-500/50"
                  >
                    <option value="" className="bg-zinc-900">
                      No room selected
                    </option>
                    {preflight.availableRooms.map((room) => (
                      <option key={room.id} value={room.id} className="bg-zinc-900">
                        {room.number} ·{' '}
                        {ROOM_STATE_LABEL[room.housekeepingStatus] ?? room.housekeepingStatus}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="text-[10px] text-zinc-600">
                  {preflight.roomTypeName} · dirty rooms are listed, because at 11am most
                  of the house is.
                </p>
              </section>

              {/* ------------------------------------------------- id ---- */}
              <section className="flex flex-col gap-1.5">
                <span className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                  Government photo ID
                </span>
                {preflight.hasGovtId ? (
                  <p className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs text-zinc-400">
                    On file: {preflight.govtIdType ?? 'ID'} {preflight.govtIdMasked ?? ''}
                  </p>
                ) : null}
                <div className="grid grid-cols-[9rem_1fr] gap-2">
                  <select
                    aria-label="ID type"
                    value={idType}
                    onChange={(event) => {
                      setIdType(event.target.value as GovtIdType);
                    }}
                    className="h-10 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 text-xs text-zinc-200 outline-none focus:border-blue-500/50"
                  >
                    {govtIdTypeSchema.options.map((type) => (
                      <option key={type} value={type} className="bg-zinc-900">
                        {GOVT_ID_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="ID number"
                    value={idNumber}
                    onChange={(event) => {
                      setIdNumber(event.target.value);
                    }}
                    placeholder={
                      preflight.hasGovtId ? 'Replace the ID on file' : 'ID number'
                    }
                    className="h-10 min-w-0 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500/50"
                  />
                </div>
              </section>

              {/* --------------------------------------------- keys ------ */}
              <section className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="checkin-keys"
                    className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase"
                  >
                    Key cards
                  </label>
                  <input
                    id="checkin-keys"
                    type="number"
                    min={0}
                    max={10}
                    value={keyCards}
                    onChange={(event) => {
                      setKeyCards(Math.max(0, Math.min(10, Number(event.target.value))));
                    }}
                    className="tabular h-10 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-zinc-200 outline-none focus:border-blue-500/50"
                  />
                </div>
                <div className="flex flex-col justify-end">
                  <label className="flex cursor-pointer items-center gap-2 pb-2.5 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={registrationSigned}
                      onChange={(event) => {
                        setRegistrationSigned(event.target.checked);
                      }}
                      className="size-3.5 rounded border-white/20 bg-white/[0.04] accent-emerald-500"
                    />
                    Registration card signed
                  </label>
                </div>
              </section>

              {/* ------------------------------------------- balance ----- */}
              <section className="flex items-baseline justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
                <span className="text-[11px] text-zinc-500">Outstanding on this stay</span>
                <span className="tabular text-sm font-semibold text-zinc-100">
                  {money(preflight.balanceAmountMinor, preflight.currency)}
                </span>
              </section>

              {/* ------------------------------------------- payment ----- */}
              <section className="flex flex-col gap-2">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={collectPayment}
                    onChange={(event) => {
                      setCollectPayment(event.target.checked);
                    }}
                    className="size-3.5 rounded border-white/20 bg-white/[0.04] accent-emerald-500"
                  />
                  Take a payment now
                </label>

                {collectPayment ? (
                  <div className="flex flex-col gap-2">
                    <div className="grid grid-cols-[9rem_1fr] gap-2">
                      <select
                        aria-label="Payment method"
                        value={paymentMethod}
                        onChange={(event) => {
                          setPaymentMethod(event.target.value as PaymentMethod);
                        }}
                        className="h-10 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 text-xs text-zinc-200 outline-none focus:border-blue-500/50"
                      >
                        {paymentMethodSchema.options.map((method) => (
                          <option key={method} value={method} className="bg-zinc-900">
                            {PAYMENT_METHOD_LABELS[method]}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label="Amount"
                        inputMode="decimal"
                        value={paymentAmount}
                        onChange={(event) => {
                          setPaymentAmount(event.target.value);
                        }}
                        placeholder={`Amount in ${preflight.currency}`}
                        className="tabular h-10 min-w-0 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500/50"
                      />
                    </div>
                    <input
                      aria-label="Payment remark"
                      value={paymentRemark}
                      onChange={(event) => {
                        setPaymentRemark(event.target.value);
                      }}
                      placeholder="Reference or remark (optional)"
                      className="h-9 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500/50"
                    />
                  </div>
                ) : null}
              </section>

              {/* ------------------------------------- acknowledgement --- */}
              {overridable.length > 0 ? (
                <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={acknowledgeDirty}
                    onChange={(event) => {
                      setAcknowledgeDirty(event.target.checked);
                    }}
                    className="mt-0.5 size-3.5 rounded border-amber-400/40 bg-white/[0.04] accent-amber-500"
                  />
                  <span className="text-[11px] text-amber-100">
                    {overridable.map((blocker) => CHECK_IN_BLOCKER_MESSAGES[blocker]).join(' ')}{' '}
                    <span className="text-amber-200/70">
                      This override is recorded against your name on the audit log.
                    </span>
                  </span>
                </label>
              ) : null}

              {error !== null ? (
                <p className="rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2 text-[11px] text-rose-200">
                  {error}
                </p>
              ) : null}
            </div>

            <footer className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-5 py-3.5">
              <p className="text-[10px] text-zinc-600">
                Opens a folio and posts night one with its tax.
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={submitting}
                  className="rounded-lg border border-white/[0.08] px-3 py-2 text-xs text-zinc-300 transition hover:bg-white/[0.04] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void submit();
                  }}
                  disabled={!canSubmit}
                  className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {submitting ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <KeyRound className="size-3.5" aria-hidden="true" />
                  )}
                  Check in
                </button>
              </div>
            </footer>
          </>
        )}
      </div>
    </>
  );
}
