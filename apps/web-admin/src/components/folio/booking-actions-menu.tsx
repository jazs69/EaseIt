'use client';

/**
 * The folio toolbar's BOOKING ACTIONS menu.
 *
 * ===========================================================================
 * Three of the six do something. The other three say what they are waiting for.
 *
 * `Move room` and `Assign room` are the same write — `reservation_room.roomId`
 * changes — so they open the same sheet and the label differs only by whether
 * the stay currently has a room. They are built because that write is bounded
 * and already guarded: `reservation_room_no_overlap` makes a double-booked
 * room impossible whatever this code believes.
 *
 * `Cancel booking` now works too. It needed inventory release and a status
 * transition, which are bounded, and a *fee policy*, which is not: what a
 * cancellation costs is undecided (see `research/channel-manager/17-…`). So it
 * ships doing the bounded part — release the nights, record the cancellation —
 * and the dialog states plainly that no fee, refund or folio line is produced.
 * A clerk told that is better off than one left guessing, and better off than
 * one waiting for a button that never arrives.
 *
 * The other three are still inert. Modifying a check-in or check-out date is a
 * re-book — re-pricing the stay and re-locking inventory across a changed
 * range. Editing a rate plan needs the `rates` module and its RatePlan
 * aggregate. Each is a transactional change to money or inventory, and wiring
 * one to a handler that closes the menu and does nothing would be worse than
 * leaving it inert — a front desk that finds a button silently did nothing
 * stops trusting the buttons that work.
 * ===========================================================================
 */

import {
  ArrowLeftRight,
  ArrowRightFromLine,
  ArrowRightToLine,
  Ban,
  BookOpen,
  DoorOpen,
  PenLine,
} from 'lucide-react';
import { useState } from 'react';

import { ActionMenu, ActionMenuItem } from '@/components/common/action-menu';
import { CancelBookingDialog } from './cancel-booking-dialog';
import { RoomMoveSheet } from './room-move-sheet';

export interface BookingActionsMenuProps {
  hotelId: string;
  reservationId: string;
  /** Used only to label the menu item: assign when there is no room, else move. */
  hasRoom: boolean;
  /** Called after a successful move so the page can refresh. */
  onMoved: () => void;
  /** Shown in the cancellation dialog's header, so the clerk sees what they are ending. */
  guestName?: string | null;
  confirmationCode?: string | null;
  /** Called after a successful cancellation. Defaults to `onMoved`'s refresh. */
  onCancelled?: () => void;
}

export function BookingActionsMenu({
  hotelId,
  reservationId,
  hasRoom,
  onMoved,
  guestName,
  confirmationCode,
  onCancelled,
}: BookingActionsMenuProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  return (
    <>
      <ActionMenu
        ariaLabel="Booking actions"
        align="start"
        label={
          <>
            <BookOpen className="size-3.5 text-zinc-400" aria-hidden="true" />
            Booking actions
          </>
        }
      >
        {(close) => (
          <>
            <ActionMenuItem
              label="Modify check-in"
              icon={ArrowRightToLine}
              needs="date changes: re-pricing the stay and re-locking inventory"
            />
            <ActionMenuItem
              label="Modify checkout"
              icon={ArrowRightFromLine}
              needs="date changes: truncating or extending nights against inventory"
            />
            <ActionMenuItem
              label="Edit rate plan"
              icon={PenLine}
              needs="the rates module and its RatePlan aggregate"
            />
            <ActionMenuItem
              label="Move room"
              icon={ArrowLeftRight}
              onSelect={() => {
                close();
                setSheetOpen(true);
              }}
            />
            <ActionMenuItem
              label={hasRoom ? 'Reassign room' : 'Assign room'}
              icon={DoorOpen}
              onSelect={() => {
                close();
                setSheetOpen(true);
              }}
            />
            <ActionMenuItem
              label="Cancel booking"
              icon={Ban}
              destructive
              onSelect={() => {
                close();
                setCancelOpen(true);
              }}
            />
          </>
        )}
      </ActionMenu>

      {cancelOpen ? (
        <CancelBookingDialog
          hotelId={hotelId}
          reservationId={reservationId}
          guestName={guestName ?? null}
          confirmationCode={confirmationCode ?? null}
          onClose={() => {
            setCancelOpen(false);
          }}
          onCancelled={() => {
            setCancelOpen(false);
            (onCancelled ?? onMoved)();
          }}
        />
      ) : null}

      {sheetOpen ? (
        <RoomMoveSheet
          hotelId={hotelId}
          reservationId={reservationId}
          onClose={() => {
            setSheetOpen(false);
          }}
          onMoved={() => {
            setSheetOpen(false);
            onMoved();
          }}
        />
      ) : null}
    </>
  );
}
