'use client';

/**
 * Holds the genuinely local state on this screen: which block the reservation
 * drawer is showing, which booking sheet is open, and whether the unassigned
 * slide-over is up.
 *
 * Everything else — window, timeframe, filters, grouping — lives in the URL,
 * because each changes what the server returns. These two do not: they are
 * transient interactions with data already on screen, and putting them in the
 * URL would add a history entry every time a clerk glanced at a booking or
 * pressed Alt+W by accident.
 */

import { useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import type { TimelineBlock, TimelineCalendar } from '@repo/types';

import { BookingModals } from './booking-modals';
import { CheckInModal } from './check-in-modal';
import type { BookingModal } from './create-menu';
import { ReservationDrawer } from './reservation-drawer';
import {
  CreateReservationModal,
  type CreateReservationSeed,
} from '../create-reservation-modal';
import { TimelineGrid } from './timeline-grid';
import { TimelineToolbar } from './timeline-toolbar';
import { UnassignedDrawer } from './unassigned-drawer';

export interface TimelineContainerProps {
  calendar: TimelineCalendar;
  hotelId: string;
}

export function TimelineContainer({ calendar, hotelId }: TimelineContainerProps) {
  const searchParams = useSearchParams();
  const [selectedBlock, setSelectedBlock] = useState<TimelineBlock | null>(null);
  const [activeModal, setActiveModal] = useState<BookingModal | null>(null);
  const [unassignedOpen, setUnassignedOpen] = useState(false);
  const [createSeed, setCreateSeed] = useState<CreateReservationSeed | null>(null);
  /** Which stay the check-in sheet is open for, if any. */
  const [checkingIn, setCheckingIn] = useState<string | null>(null);

  /**
   * Opens the booking form from a clicked cell.
   *
   * The room type's name is resolved here from `categories` rather than being
   * carried on the room row: one list of category names, so the modal's
   * heading cannot disagree with the grid's grouping.
   */
  const openCreateAt = useCallback(
    (cell: {
      roomId: string;
      roomNumber: string;
      roomTypeId: string;
      arrivalDate: string;
    }) => {
      setCreateSeed({
        roomId: cell.roomId,
        roomNumber: cell.roomNumber,
        roomTypeId: cell.roomTypeId,
        roomTypeName:
          calendar.categories.find((category) => category.id === cell.roomTypeId)?.name ??
          'Room',
        arrivalDate: cell.arrivalDate,
      });
    },
    [calendar.categories],
  );

  const closeCreate = useCallback(() => {
    setCreateSeed(null);
  }, []);

  /**
   * `?focus=<reservationId>` opens that booking's drawer on arrival.
   *
   * ===========================================================================
   * **Derived during render, not written by an effect.**
   *
   * How the omnibar hands a reservation over: it navigates here with the window
   * set to the stay's arrival date and the id in `focus`, and this finds the
   * matching block. The id is the reservation id, which is exactly what
   * `TimelineBlock.id` carries, so no second lookup is needed.
   *
   * The obvious implementation — an effect that calls `setSelectedBlock` when
   * `focus` appears — is the cascading render `react-hooks/set-state-in-effect`
   * rejects: the component renders once with no drawer, the effect fires, and
   * it renders again. Computing it instead means the first paint already has
   * the drawer open, which is the point of arriving with a focus.
   *
   * Dismissal is the part that needs state. Without `dismissedFocusId` the
   * drawer would reopen the instant it was closed, because `focus` is still in
   * the URL and the derivation would find the block again. Recording *which*
   * id was dismissed rather than a bare boolean matters: searching for a second
   * booking navigates here with a new focus, and that one must still open.
   *
   * The parameter is deliberately left in the URL — a refresh should reopen the
   * same drawer, and rewriting it here would fight the back button.
   * ===========================================================================
   */
  const focusId = searchParams.get('focus');
  const [dismissedFocusId, setDismissedFocusId] = useState<string | null>(null);

  // Searched across both axes because a booking is in `rooms` once assigned and
  // in `unassigned` until then — and a search hit is at least as likely to be
  // the unassigned one, since that is the booking somebody is chasing.
  const focusedBlock = useMemo((): TimelineBlock | null => {
    if (focusId === null || focusId === dismissedFocusId) return null;
    return (
      calendar.rooms.flatMap((room) => room.blocks).find((block) => block.id === focusId) ??
      calendar.unassigned.find((block) => block.id === focusId) ??
      null
    );
  }, [focusId, dismissedFocusId, calendar]);

  // A block the clerk clicked wins over one the URL asked for.
  const drawerBlock = selectedBlock ?? focusedBlock;

  const closeDrawer = useCallback(() => {
    setSelectedBlock(null);
    // Remembering the id is what stops the derivation reopening it.
    if (focusId !== null) setDismissedFocusId(focusId);
  }, [focusId]);

  // Stable across renders, because `CreateMenu` lists it as an effect
  // dependency for the global Alt listener — an inline arrow would tear down
  // and re-attach that listener on every parent render.
  const openModal = useCallback((modal: BookingModal) => {
    setActiveModal(modal);
  }, []);

  const closeModal = useCallback(() => {
    setActiveModal(null);
  }, []);

  const closeUnassigned = useCallback(() => {
    setUnassignedOpen(false);
  }, []);

  /**
   * Hands a stay to the check-in sheet and closes the drawer behind it.
   *
   * Two stacked panels over the same booking would leave the clerk with the
   * drawer's stale "Confirmed" badge visible beside a sheet that has just
   * checked the guest in.
   */
  const openCheckIn = useCallback(
    (reservationId: string) => {
      setCheckingIn(reservationId);
      setSelectedBlock(null);
      // The drawer may have been opened by `?focus=` rather than a click, and
      // the derivation would keep reopening it behind the sheet; dismissing
      // the id is what actually closes it.
      if (focusId !== null) setDismissedFocusId(focusId);
    },
    [focusId],
  );

  const closeCheckIn = useCallback(() => {
    setCheckingIn(null);
  }, []);

  // Which room a block sits in, for the drawer. Derived rather than copied
  // onto the block: duplicating the room number would be a second value to
  // keep in step with the assignment.
  const roomNumberFor = (blockId: string): string | null => {
    for (const room of calendar.rooms) {
      if (room.blocks.some((block) => block.id === blockId)) return room.roomNumber;
    }
    return null;
  };

  return (
    <>
      <TimelineToolbar
        calendar={calendar}
        hotelId={hotelId}
        onOpenModal={openModal}
        onOpenUnassigned={() => {
          setUnassignedOpen(true);
        }}
      />

      <TimelineGrid
        calendar={calendar}
        onSelectBlock={setSelectedBlock}
        onCreateAt={openCreateAt}
      />

      <UnassignedDrawer
        open={unassignedOpen}
        blocks={calendar.unassigned}
        categories={calendar.categories}
        onClose={closeUnassigned}
        onSelectBlock={setSelectedBlock}
      />

      <ReservationDrawer
        block={drawerBlock}
        roomNumber={drawerBlock === null ? null : roomNumberFor(drawerBlock.id)}
        onClose={closeDrawer}
        onCheckIn={openCheckIn}
      />

      {/* Keyed on the reservation, so checking a second guest in mounts a
          fresh sheet rather than an effect copying the new id over the old. */}
      {checkingIn === null ? null : (
        <CheckInModal
          key={checkingIn}
          hotelId={hotelId}
          reservationId={checkingIn}
          onClose={closeCheckIn}
        />
      )}

      <BookingModals modal={activeModal} calendar={calendar} onClose={closeModal} />

      {/* Mounted only when there is a cell to create from, and keyed on that
          cell: clicking a different room or date remounts the form with fresh
          state instead of an effect copying the new seed over the old one. */}
      {createSeed === null ? null : (
        <CreateReservationModal
          key={`${createSeed.roomTypeId}:${createSeed.arrivalDate}:${String(createSeed.roomId)}`}
          seed={createSeed}
          calendar={calendar}
          hotelId={hotelId}
          onClose={closeCreate}
        />
      )}
    </>
  );
}
