'use client';

/**
 * Changing a stay's dates: amend, extend or shorten (RS-11, RS-12).
 *
 * ===========================================================================
 * The preview is the point. Every edit of a date asks the API what the change
 * would do — which nights join and leave, at what price, and the new total —
 * and the confirm button sends that total back as `expectedTotalMinor`, so the
 * figure the clerk read out to the guest is the figure that is committed. If
 * pricing moved in between, the API refuses and the dialog shows the new one.
 *
 * A checked-in guest can only move the departure; the arrival field is locked
 * rather than hidden so the clerk can see why.
 * ===========================================================================
 */

import type { BusinessDate, ChangeStayDatesPreview } from '@repo/types';
import { CalendarRange, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ApiRequestError } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { changeStayDates, previewStayDates } from '@/lib/properties-client';

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ChangeDatesDialogProps {
  hotelId: string;
  reservationId: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  guestName?: string | null;
  confirmationCode?: string | null;
  onClose: () => void;
  onChanged: () => void;
}

/** The most specific message the API gave: a field issue, a reason, or the summary. */
function messageOf(cause: unknown): string {
  if (cause instanceof ApiRequestError) {
    const issues = cause.details?.['issues'];
    if (issues !== null && typeof issues === 'object') {
      const first = Object.values(issues as Record<string, unknown>).find(
        (value) => typeof value === 'string',
      );
      if (typeof first === 'string') return first;
    }
    const reason = cause.details?.['reason'];
    if (typeof reason === 'string') return reason;
    return cause.message;
  }
  return cause instanceof Error ? cause.message : 'The change could not be made.';
}

export function ChangeDatesDialog({
  hotelId,
  reservationId,
  status,
  arrivalDate,
  departureDate,
  guestName,
  confirmationCode,
  onClose,
  onChanged,
}: ChangeDatesDialogProps) {
  const inHouse = status === 'CHECKED_IN';
  const [arrival, setArrival] = useState(arrivalDate);
  const [departure, setDeparture] = useState(departureDate);
  const [override, setOverride] = useState('');
  const [reason, setReason] = useState('');
  // The answer for one set of inputs, kept with the key it answered, so a
  // stale answer is never shown against edited dates.
  const [answer, setAnswer] = useState<{
    key: string;
    preview: ChangeStayDatesPreview | null;
    error: string | null;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unchanged = arrival === arrivalDate && departure === departureDate;
  // Parsed from the digits, not through a float (section 3.4): "4500.5" -> 450050.
  const overrideMatch = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(override.trim());
  const overrideMinor =
    override.trim() === '' || overrideMatch === null
      ? undefined
      : Number(overrideMatch[1]) * 100 + Number((overrideMatch[2] ?? '').padEnd(2, '0'));
  const overrideInvalid = override.trim() !== '' && overrideMatch === null;

  // A native date input accepts a six-digit year while it is being typed;
  // only a complete YYYY-MM-DD pair is worth asking the API about.
  const datesComplete = CALENDAR_DATE.test(arrival) && CALENDAR_DATE.test(departure);
  const canPreview = !unchanged && datesComplete && departure > arrival && !overrideInvalid;
  const key = `${arrival}|${departure}|${String(overrideMinor)}`;
  const current = canPreview && answer?.key === key ? answer : null;
  const preview = current?.preview ?? null;
  const previewError = current?.error ?? null;
  const loading = canPreview && current === null;

  // Re-preview on every edit; a superseded request is aborted.
  useEffect(() => {
    if (!canPreview) return;
    const controller = new AbortController();
    previewStayDates(
      hotelId,
      reservationId,
      {
        arrivalDate: arrival as BusinessDate,
        departureDate: departure as BusinessDate,
        ...(overrideMinor === undefined ? {} : { overrideNightlyRateMinor: overrideMinor }),
        reason: null,
      },
      controller.signal,
    )
      .then((result) => {
        setAnswer({ key, preview: result, error: null });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setAnswer({ key, preview: null, error: messageOf(cause) });
      });
    return () => {
      controller.abort();
    };
  }, [hotelId, reservationId, arrival, departure, overrideMinor, canPreview, key]);

  async function submit() {
    if (preview === null) return;
    setSaving(true);
    setError(null);
    try {
      await changeStayDates(hotelId, reservationId, {
        arrivalDate: arrival as BusinessDate,
        departureDate: departure as BusinessDate,
        ...(overrideMinor === undefined ? {} : { overrideNightlyRateMinor: overrideMinor }),
        expectedTotalMinor: preview.proposed.totalMinor,
        reason: reason.trim() === '' ? null : reason.trim(),
      });
      onChanged();
    } catch (cause) {
      setError(messageOf(cause));
      setSaving(false);
    }
  }

  const money = (minor: number) => formatMoney(minor, preview?.currency ?? 'INR');
  const inputClass =
    'h-9 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-zinc-200 outline-none focus:border-sky-500/50 disabled:opacity-50';

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={() => {
          if (!saving) onClose();
        }}
        className="fixed inset-0 z-[70] cursor-default bg-black/60"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Change dates"
        className="fixed top-1/2 left-1/2 z-[71] flex max-h-[88dvh] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-2xl border border-white/[0.08] bg-[#0f141f] shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
              <CalendarRange className="size-4 text-sky-400" aria-hidden="true" />
              Change dates
            </h2>
            <p className="mt-0.5 truncate text-[11px] text-zinc-500">
              {[guestName, confirmationCode].filter(Boolean).join(' · ') || 'This reservation'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!saving) onClose();
            }}
            aria-label="Close"
            className="rounded-lg p-1 text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] text-zinc-400">Check-in</span>
              <input
                type="date"
                max="9999-12-31"
                value={arrival}
                disabled={inHouse || saving}
                onChange={(event) => {
                  setArrival(event.target.value);
                }}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] text-zinc-400">Check-out</span>
              <input
                type="date"
                max="9999-12-31"
                value={departure}
                disabled={saving}
                onChange={(event) => {
                  setDeparture(event.target.value);
                }}
                className={inputClass}
              />
            </label>
          </div>
          {inHouse ? (
            <p className="text-[11px] text-zinc-500">
              The guest is checked in, so only the check-out date can change.
            </p>
          ) : null}

          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] text-zinc-400">
              Price for added nights, before tax (optional; otherwise the rate plan or rack rate)
            </span>
            <input
              inputMode="decimal"
              value={override}
              disabled={saving}
              onChange={(event) => {
                setOverride(event.target.value);
              }}
              placeholder="e.g. 4500"
              className={inputClass}
            />
          </label>
          {overrideInvalid ? (
            <p className="text-[11px] text-rose-300">
              Enter a price like 4500 or 4500.50.
            </p>
          ) : null}

          {loading ? (
            <p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Pricing the change…
            </p>
          ) : null}
          {previewError !== null ? (
            <p className="rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2 text-[11px] text-rose-200">
              {previewError}
            </p>
          ) : null}

          {preview !== null && !loading ? (
            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-[11px] text-zinc-300">
              <div className="flex justify-between">
                <span>
                  Now: {preview.current.arrivalDate} → {preview.current.departureDate} (
                  {preview.current.nights} nights)
                </span>
                <span>{money(preview.current.totalMinor)}</span>
              </div>
              <div className="mt-1 flex justify-between font-semibold text-zinc-100">
                <span>
                  New: {preview.proposed.arrivalDate} → {preview.proposed.departureDate} (
                  {preview.proposed.nights} nights)
                </span>
                <span>{money(preview.proposed.totalMinor)}</span>
              </div>
              {preview.addedNights.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-0.5 text-emerald-200/90">
                  {preview.addedNights.map((night) => (
                    <li key={night.stayDate} className="flex justify-between">
                      <span>+ {night.stayDate}</span>
                      <span>
                        {money(night.rateMinor)} + {money(night.taxMinor)} tax
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {preview.removedNights.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-0.5 text-amber-200/90">
                  {preview.removedNights.map((night) => (
                    <li key={night.stayDate} className="flex justify-between">
                      <span>− {night.stayDate}</span>
                      <span>{money(night.rateMinor + night.taxMinor)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-2 border-t border-white/[0.06] pt-2 text-zinc-400">
                {preview.deltaMinor >= 0 ? 'Adds ' : 'Reduces the stay by '}
                <strong className="text-zinc-200">{money(Math.abs(preview.deltaMinor))}</strong>.
                Nights kept keep their price. Payments already taken are not changed; any refund
                is made on the folio.
              </p>
            </div>
          ) : null}

          <p className="text-[11px] text-amber-200/90">
            No connected OTA is notified; availability changes in EaseIt only.
          </p>

          <input
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            placeholder="Reason (optional) — recorded on the audit log"
            className={inputClass}
          />

          {error !== null ? (
            <p className="rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2 text-[11px] text-rose-200">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-0.5">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg border border-white/[0.08] px-3 py-2 text-xs text-zinc-300 disabled:opacity-50"
            >
              Keep dates
            </button>
            <button
              type="button"
              disabled={preview === null || loading || saving}
              onClick={() => {
                void submit();
              }}
              className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
              Change dates
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
