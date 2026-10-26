'use client';

/**
 * The folio toolbar's BOOKING ACTIONS menu.
 *
 * ===========================================================================
 * Two of the six do something. The other four say what they are waiting for.
 *
 * `Move room` and `Assign room` are the same write — `reservation_room.roomId`
 * changes — so they open the same sheet and the label differs only by whether
 * the stay currently has a room. They are built because that write is bounded
 * and already guarded: `reservation_room_no_overlap` makes a double-booked
 * room impossible whatever this code believes.
 *
 * The other four are not. Modifying a check-in or check-out date is a re-book
 * — re-pricing the stay and re-locking inventory across a changed range.
 * Editing a rate plan needs the `rates` module and its RatePlan aggregate.
 * Cancelling needs inventory release, a fee policy, a reversing folio line and
 * a status transition. Each is a transactional change to money or inventory,
 * and wiring any of them to a handler that closes the menu and does nothing
 * would be worse than leaving it inert — a front desk that finds "Cancel
 * booking" silently did nothing stops trusting the buttons that work.
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
import { RoomMoveSheet } from './room-move-sheet';

export interface BookingActionsMenuProps {
  hotelId: string;
  reservationId: string;
  /** Used only to label the menu item: assign when there is no room, else move. */
  hasRoom: boolean;
  /** Called after a successful move so the page can refresh. */
  onMoved: () => void;
}

export function BookingActionsMenu({
  hotelId,
  reservationId,
  hasRoom,
  onMoved,
}: BookingActionsMenuProps) {
  const [sheetOpen, setSheetOpen] = useState(false);

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
              needs="cancellation: inventory release, fee policy and a reversing folio line"
            />
          </>
        )}
      </ActionMenu>

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
