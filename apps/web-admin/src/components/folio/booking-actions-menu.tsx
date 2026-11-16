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
 * `Modify check-in` and `Modify checkout` open the date-change dialog
 * (RS-11, RS-12), which previews the nights added and removed and their price
 * before committing. They are shown only for a stay whose dates can change
 * (confirmed, or in house for the checkout). Editing a rate plan is still
 * inert: it needs the `rates` module's RatePlan aggregate, and wiring it to a
 * handler that does nothing would be worse than leaving it inert — a front
 * desk that finds a button silently did nothing stops trusting the buttons
 * that work.
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
  UserX,
} from 'lucide-react';
import { useState } from 'react';

import { ActionMenu, ActionMenuItem } from '@/components/common/action-menu';
import { CancelBookingDialog } from './cancel-booking-dialog';
import { ChangeDatesDialog } from './change-dates-dialog';
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
  /** The stay as it is, for the date-change dialog. Without it those items stay inert. */
  stay?: { status: string; arrivalDate: string; departureDate: string } | null;
}

export function BookingActionsMenu({
  hotelId,
  reservationId,
  hasRoom,
  onMoved,
  guestName,
  confirmationCode,
  onCancelled,
  stay,
}: BookingActionsMenuProps) {
  const [datesOpen, setDatesOpen] = useState(false);
  const datesStay =
    stay != null && (stay.status === 'CONFIRMED' || stay.status === 'CHECKED_IN') ? stay : null;
  const openDates = (close: () => void) => () => {
    close();
    setDatesOpen(true);
  };
  const [sheetOpen, setSheetOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState<'cancel' | 'no-show' | null>(null);

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
            {datesStay !== null && datesStay.status !== 'CHECKED_IN' ? (
              <ActionMenuItem
                label="Modify check-in"
                icon={ArrowRightToLine}
                onSelect={openDates(close)}
              />
            ) : null}
            {datesStay !== null ? (
              <ActionMenuItem
                label="Modify checkout"
                icon={ArrowRightFromLine}
                onSelect={openDates(close)}
              />
            ) : null}
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
              label="Mark no-show"
              icon={UserX}
              destructive
              onSelect={() => {
                close();
                setCancelOpen('no-show');
              }}
            />
            <ActionMenuItem
              label="Cancel booking"
              icon={Ban}
              destructive
              onSelect={() => {
                close();
                setCancelOpen('cancel');
              }}
            />
          </>
        )}
      </ActionMenu>

      {cancelOpen !== null ? (
        <CancelBookingDialog
          mode={cancelOpen}
          hotelId={hotelId}
          reservationId={reservationId}
          guestName={guestName ?? null}
          confirmationCode={confirmationCode ?? null}
          onClose={() => {
            setCancelOpen(null);
          }}
          onCancelled={() => {
            setCancelOpen(null);
            (onCancelled ?? onMoved)();
          }}
        />
      ) : null}

      {datesOpen && datesStay !== null ? (
        <ChangeDatesDialog
          hotelId={hotelId}
          reservationId={reservationId}
          status={datesStay.status}
          arrivalDate={datesStay.arrivalDate}
          departureDate={datesStay.departureDate}
          guestName={guestName ?? null}
          confirmationCode={confirmationCode ?? null}
          onClose={() => {
            setDatesOpen(false);
          }}
          onChanged={() => {
            setDatesOpen(false);
            onMoved();
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
