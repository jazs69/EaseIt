'use client';

/**
 * Confirming a cancellation.
 *
 * ===========================================================================
 * The notice about money is the point of this dialog, not decoration.
 *
 * Cancelling here releases the nights and records the cancellation. It does
 * **not** calculate a fee, issue a refund, or write anything to the folio —
 * because what a cancellation costs is a commercial rule this product has not
 * decided yet. A clerk who assumes the system handled the money and tells the
 * guest so is a worse outcome than one who knows they have to post the
 * retention charge themselves. So the dialog says it plainly, before the
 * button, and the wording avoids "refund" and "charge" as verbs the system
 * performs.
 *
 * A typed confirmation is deliberate too. Releasing inventory is reversible
 * only by re-booking — and only if nobody else took the room in between — so
 * it gets more friction than a single click, matching how destructive the
 * action actually is rather than how destructive it looks.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import { Ban, Loader2, X } from 'lucide-react';
import { useState } from 'react';

import { cancelReservation } from '@/lib/properties-client';

export interface CancelBookingDialogProps {
  hotelId: string;
  reservationId: string;
  /** For the header line, so the clerk can see what they are cancelling. */
  guestName?: string | null;
  confirmationCode?: string | null;
  onClose: () => void;
  /** Called after a successful cancellation so the page can refresh. */
  onCancelled: (summary: { nightsReleased: number; alreadyCancelled: boolean }) => void;
}

const CONFIRM_WORD = 'CANCEL';

export function CancelBookingDialog({
  hotelId,
  reservationId,
  guestName,
  confirmationCode,
  onClose,
  onCancelled,
}: CancelBookingDialogProps) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = typed.trim().toUpperCase() === CONFIRM_WORD;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const result = await cancelReservation(hotelId, reservationId, {
        reason: reason.trim() === '' ? null : reason.trim(),
      });
      onCancelled({
        nightsReleased: result.nightsReleased,
        alreadyCancelled: result.alreadyCancelled,
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The cancellation failed. Nothing was changed.',
      );
      setSaving(false);
    }
  }

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
        aria-label="Cancel booking"
        className="fixed top-1/2 left-1/2 z-[71] flex max-h-[88dvh] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-white/[0.08] bg-[#0f141f] shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
              <Ban className="size-4 text-rose-400" aria-hidden="true" />
              Cancel booking
            </h2>
            <p className="mt-0.5 truncate text-[11px] text-zinc-500">
              {[guestName, confirmationCode].filter(Boolean).join(' · ') ||
                'This reservation'}
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
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
            <p className="text-[11px] font-semibold text-zinc-200">This will:</p>
            <ul className="mt-1.5 flex flex-col gap-1 text-[11px] text-zinc-400">
              <li>· mark the booking cancelled and record who cancelled it</li>
              <li>· return every night it held to availability <strong>in EaseIt</strong></li>
              <li>· free the room number for those dates</li>
            </ul>
          </div>

          {/* What it does NOT do. Amber, not red: both are things the clerk
              must act on, not errors. */}
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2.5">
            <p className="text-[11px] font-semibold text-amber-200">
              No money is moved by this action.
            </p>
            <p className="mt-1 text-[11px] text-amber-100/90">
              No cancellation fee is calculated, no refund is issued, and the folio is left
              exactly as it is. If this property&apos;s policy retains an amount, post it on
              the folio as a charge after cancelling.
            </p>
            {/* Stated because the product is also a channel manager: a reader
                could otherwise take "availability" to mean the OTAs too. */}
            <p className="mt-2 text-[11px] font-semibold text-amber-200">
              No connected OTA is notified.
            </p>
            <p className="mt-1 text-[11px] text-amber-100/90">
              The inventory is released in EaseIt only. Channel availability is not
              synchronised by this action, so any OTA still holding these dates must be
              updated wherever that is managed today.
            </p>
          </div>

          <input
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            placeholder="Reason (optional) — recorded on the audit log"
            className="h-9 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-rose-500/50"
          />

          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] text-zinc-400">
              Type <span className="font-semibold text-zinc-200">{CONFIRM_WORD}</span> to
              confirm
            </span>
            <input
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
              }}
              autoComplete="off"
              spellCheck={false}
              className={cn(
                'h-9 rounded-lg border bg-white/[0.03] px-3 text-xs tracking-widest text-zinc-200 uppercase outline-none',
                confirmed ? 'border-rose-500/50' : 'border-white/[0.08]',
              )}
            />
          </label>

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
              Keep booking
            </button>
            <button
              type="button"
              disabled={!confirmed || saving}
              onClick={() => {
                void submit();
              }}
              className="flex items-center gap-1.5 rounded-lg bg-rose-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
              Cancel booking
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
