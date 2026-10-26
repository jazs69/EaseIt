'use client';

/**
 * Assign, move or unassign a room.
 *
 * ===========================================================================
 * One sheet for all three, because they are one write.
 *
 * The list is ordered the way a clerk scans it: the booked category first,
 * free rooms before occupied ones, then by number. Dirty rooms appear and are
 * flagged rather than hidden — at 11am most of the house is dirty, and that is
 * exactly the shift when a move is needed.
 *
 * A different category needs an explicit tick, because that move is a re-sale:
 * the inventory counter for the booked category comes down and the new one
 * goes up, under the oversell CHECK. An upgrade is routine; doing it by
 * misreading a dropdown is not.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import { ArrowLeftRight, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { MoveRoomOptions } from '@repo/types';

import { fetchRoomMoveOptions, moveReservationRoom } from '@/lib/properties-client';

export interface RoomMoveSheetProps {
  hotelId: string;
  reservationId: string;
  onClose: () => void;
  onMoved: () => void;
}

export function RoomMoveSheet({
  hotelId,
  reservationId,
  onClose,
  onMoved,
}: RoomMoveSheetProps) {
  const [options, setOptions] = useState<MoveRoomOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [acknowledge, setAcknowledge] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetchRoomMoveOptions(hotelId, reservationId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setOptions(result);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(
          caught instanceof Error ? caught.message : 'The room list could not be loaded.',
        );
      });

    return () => {
      controller.abort();
    };
  }, [hotelId, reservationId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [saving, onClose]);

  const chosen = options?.candidates.find((room) => room.id === selected) ?? null;
  const needsAcknowledgement = chosen?.isCategoryChange === true;
  const canSubmit =
    options !== null && !saving && (selected !== null || options.currentRoomId !== null) &&
    (!needsAcknowledgement || acknowledge);

  async function submit(unassign: boolean): Promise<void> {
    if (options === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      await moveReservationRoom(hotelId, reservationId, {
        roomId: unassign ? null : (selected as MoveRoomOptions['currentRoomId']),
        acknowledgeCategoryChange: acknowledge,
        reason: reason.trim() === '' ? null : reason.trim(),
      });
      onMoved();
    } catch (caught) {
      // Surfaced, never swallowed: a move that silently failed leaves a guest
      // holding a key to a room the system has given to somebody else.
      setError(caught instanceof Error ? caught.message : 'The move could not be saved.');
    } finally {
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
        aria-label="Move room"
        className="fixed top-1/2 left-1/2 z-[71] flex max-h-[88dvh] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-white/[0.08] bg-[#0f141f] shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
              <ArrowLeftRight className="size-4 text-blue-400" aria-hidden="true" />
              Move room
            </h2>
            {options === null ? (
              <p className="mt-0.5 text-[11px] text-zinc-500">Loading the room list…</p>
            ) : (
              <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                {options.guestName} · {options.bookedRoomTypeName} ·{' '}
                {options.currentRoomNumber === null
                  ? 'unassigned'
                  : `currently ${options.currentRoomNumber}`}
              </p>
            )}
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

        {loadError !== null ? (
          <p className="px-5 py-6 text-xs text-rose-300">{loadError}</p>
        ) : options === null ? (
          <div className="flex items-center gap-2 px-5 py-10 text-xs text-zinc-500">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Checking which rooms are free for these nights…
          </div>
        ) : (
          <>
            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 py-3">
              {options.candidates.map((room) => {
                const isCurrent = room.id === options.currentRoomId;
                const disabled = !room.isFree || isCurrent;

                return (
                  <button
                    key={room.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setSelected(room.id);
                      // A fresh choice is a fresh decision: an acknowledgement
                      // of a previous room's category must not carry over.
                      setAcknowledge(false);
                    }}
                    title={
                      isCurrent
                        ? 'The stay is already in this room'
                        : room.isFree
                          ? undefined
                          : 'Taken for one of these nights'
                    }
                    className={cn(
                      'flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                      selected === room.id
                        ? 'border-blue-500/60 bg-blue-500/[0.08]'
                        : 'border-white/[0.06] bg-white/[0.02]',
                      disabled
                        ? 'cursor-not-allowed opacity-40'
                        : 'cursor-pointer hover:border-white/20',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="tabular text-xs font-semibold text-zinc-100">
                        {room.number}
                      </span>
                      <span className="truncate text-[10px] text-zinc-500">
                        {room.roomTypeName}
                      </span>
                      {isCurrent ? (
                        <span className="rounded bg-white/[0.08] px-1.5 py-px text-[9px] font-semibold text-zinc-300">
                          Current
                        </span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {room.isCategoryChange ? (
                        <span className="rounded bg-amber-500/15 px-1.5 py-px text-[9px] font-semibold text-amber-300">
                          Other category
                        </span>
                      ) : null}
                      <span
                        className={cn(
                          'rounded px-1.5 py-px text-[9px] font-semibold',
                          room.isClean
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : 'bg-pink-500/15 text-pink-300',
                        )}
                      >
                        {room.isClean ? 'Clean' : 'Dirty'}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-col gap-2.5 border-t border-white/[0.06] px-5 py-3.5">
              {needsAcknowledgement ? (
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2">
                  <input
                    type="checkbox"
                    checked={acknowledge}
                    onChange={(event) => {
                      setAcknowledge(event.target.checked);
                    }}
                    className="mt-0.5 size-3.5 rounded border-amber-400/40 bg-white/[0.04] accent-amber-500"
                  />
                  <span className="text-[11px] text-amber-100">
                    {chosen?.roomTypeName} is a different category from{' '}
                    {options.bookedRoomTypeName}. Confirm to move the inventory with it.
                  </span>
                </label>
              ) : null}

              <input
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
                placeholder="Reason (optional) — recorded on the audit log"
                className="h-9 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500/50"
              />

              {error !== null ? (
                <p className="rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2 text-[11px] text-rose-200">
                  {error}
                </p>
              ) : null}

              <div className="flex items-center justify-between gap-2">
                {/* Unassigning is a real action, not a cancel: a room goes out
                    of order and the booking waits for reallocation. */}
                <button
                  type="button"
                  disabled={saving || options.currentRoomId === null}
                  onClick={() => {
                    void submit(true);
                  }}
                  title={
                    options.currentRoomId === null
                      ? 'Already unassigned'
                      : 'Return this stay to the unassigned queue'
                  }
                  className="rounded-lg border border-white/[0.08] px-3 py-2 text-[11px] text-zinc-300 transition hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Unassign
                </button>

                <div className="flex items-center gap-2">
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
                    disabled={!canSubmit || selected === null}
                    onClick={() => {
                      void submit(false);
                    }}
                    className="flex items-center gap-1.5 rounded-lg bg-blue-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {saving ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : null}
                    Move
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
