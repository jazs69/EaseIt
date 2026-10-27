'use client';

/**
 * The reservation drawer's MODIFY menu.
 *
 * ===========================================================================
 * Rendered in a portal, which is the only way it is not clipped.
 *
 * The drawer panel is `overflow-y-auto` — it has to be, the cards are taller
 * than the viewport. A scroll container clips its absolutely-positioned
 * descendants no matter what z-index they carry, so a menu nested inside the
 * drawer gets its lower half cut off and no amount of `z-50` fixes it. The
 * panel is therefore portalled to `document.body` and positioned from the
 * trigger's measured rect.
 *
 * NO DROPDOWN LIBRARY, AND NO ANIMATION LIBRARY
 * `@radix-ui/react-dropdown-menu` and `framer-motion` are both absent from
 * this workspace, and a menu is not a reason to add either (CLAUDE.md section
 * 6.4). What they would bring is the entrance curve and roving focus; the
 * curve is six lines of CSS in the Tailwind preset, and the keyboard handling
 * is implemented below against the same convention `MoreAppsPopover` and
 * `AccountPopover` already use — Escape listener torn down with the panel, a
 * transparent click-away sibling, no global handler to leak.
 *
 * EVERY ITEM IS DISABLED, DELIBERATELY
 * All ten of these need write paths the `reservations` module does not have:
 * holding, cancelling, no-show, room locking, unassignment, date changes,
 * splitting and moving are each a transactional state change with inventory
 * and folio consequences (sections 3.1 and 3.4). Wiring them to handlers that
 * close the menu and do nothing would be worse than leaving them inert: a
 * front desk that discovers "Cancel booking" silently did nothing has lost
 * trust in every other button on the screen, including the ones that work.
 *
 * So each carries the reason in its tooltip and the menu says so at the foot.
 * The shape is complete; the engine behind it is not, and the UI admits it.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import {
  Ban,
  BedDouble,
  CalendarCheck,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  EyeOff,
  Lock,
  Move,
  Pause,
  Split,
  SquarePen,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { CancelBookingDialog } from '@/components/folio/cancel-booking-dialog';

interface ModifyAction {
  label: string;
  icon: LucideIcon;
  /** Rose hover tint: this one ends a booking or forfeits money. */
  destructive?: boolean;
  /**
   * Which unbuilt module the action waits on. `null` means it is built, and
   * the item is live rather than inert.
   */
  needs: string | null;
}

/**
 * The ten actions, in the order the reference puts them.
 *
 * Ordered by how far each one goes rather than alphabetically: the three that
 * change a booking's *state* come first, then the two that change how it is
 * held, then the five that change its dates, content or room. A clerk reaching
 * for "Cancel booking" in a hurry should not have to read past "Split room".
 */
const ACTIONS: readonly ModifyAction[] = [
  { label: 'Hold booking', icon: Pause, needs: 'the reservation state machine (ON_HOLD)' },
  /**
   * Built. Releases inventory and records the cancellation; it does **not**
   * calculate a fee - the dialog says so, and the retention charge is posted
   * on the folio by hand until that rule is decided.
   */
  { label: 'Cancel booking', icon: Ban, destructive: true, needs: null },
  {
    label: 'Set to no show',
    icon: EyeOff,
    destructive: true,
    needs: 'no-show: inventory release and the retention charge',
  },
  { label: 'Lock booking', icon: Lock, needs: 'room-assignment locking' },
  { label: 'Unassign booking', icon: BedDouble, needs: 'the unassign path' },
  { label: 'Modify checkin', icon: CalendarClock, needs: 'date changes: re-pricing and re-locking inventory' },
  { label: 'Modify checkout', icon: CalendarCheck, needs: 'date changes: re-pricing and re-locking inventory' },
  { label: 'Edit reservation', icon: SquarePen, needs: 'the reservation edit path' },
  { label: 'Split room', icon: Split, needs: 'stay-segment splitting' },
  { label: 'Move room', icon: Move, needs: 'the room-move path' },
];

export interface ModifyMenuProps {
  /** Named in the menu's accessible label, so it is clear what is being modified. */
  guestName: string;
  hotelId: string;
  reservationId: string;
  bookingCode?: string | null;
  /** Called after a successful cancellation so the timeline can refetch. */
  onCancelled?: () => void;
}

export function ModifyMenu({
  guestName,
  hotelId,
  reservationId,
  bookingCode,
  onCancelled,
}: ModifyMenuProps) {
  const [open, setOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  /**
   * Measure the trigger before the browser paints the panel.
   *
   * `useLayoutEffect`, not `useEffect`: with an effect the panel renders once
   * at the top-left of the window and then jumps, which is visible and looks
   * like a bug. Measuring in the layout phase means the first painted frame is
   * already in the right place — and the entrance animation then runs from
   * there rather than from the corner of the screen.
   */
  useLayoutEffect(() => {
    if (!open) return;

    const measure = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      setAnchor({
        // 6px below the trigger, matching the reference's sideOffset.
        top: rect.bottom + 6,
        // Anchored to the trigger's right edge, so the panel grows leftwards
        // and never runs off the side of a drawer pinned to the window edge.
        right: window.innerWidth - rect.right,
      });
    };

    measure();

    // The drawer scrolls and the window resizes; a portalled panel is not
    // carried along by either, so it follows or it closes.
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;

      /**
       * Swallow it, or Escape closes the drawer behind this as well.
       *
       * The drawer also listens for Escape on `document`, so one keypress
       * reaches both handlers and the operator loses the whole panel when
       * they meant to dismiss a menu. `stopPropagation` would not help —
       * both listeners are on the same node, and it does not stop siblings.
       *
       * So this listens in the **capture** phase, which runs before every
       * bubble-phase listener on `document`, and stops the event dead there.
       * The drawer's handler never sees it, and no shared state or prop had
       * to be threaded between the two components to arrange that.
       */
      event.stopImmediatePropagation();
      event.preventDefault();

      setOpen(false);
      // Focus goes back where it came from, or a keyboard user is dropped at
      // the top of the document.
      triggerRef.current?.focus();
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setOpen((current) => !current);
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          'flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-3',
          'bg-zinc-900/60 text-[11px] font-semibold tracking-wider text-zinc-200 uppercase',
          'transition-all hover:bg-zinc-800',
          'focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none',
        )}
      >
        <SquarePen className="size-3.5 text-zinc-400" aria-hidden="true" />
        Modify
        {open ? (
          <ChevronUp className="size-3" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-3" aria-hidden="true" />
        )}
      </button>

      {!open || anchor === null
        ? null
        : createPortal(
            <>
              {/* Click-away as a sibling rather than a document listener: no
                  global handler to leak, and it cannot swallow focus. */}
              <button
                type="button"
                aria-label="Close modify menu"
                onClick={() => {
                  setOpen(false);
                }}
                className="fixed inset-0 z-[60] cursor-default"
              />

              <div
                ref={panelRef}
                role="menu"
                aria-label={`Modify the reservation for ${guestName}`}
                style={{ top: anchor.top, right: anchor.right }}
                className={cn(
                  'fixed z-[61] min-w-[13rem] rounded-xl p-1.5',
                  'border border-white/10 bg-[#0f141f]/95 shadow-2xl backdrop-blur-md',
                  'origin-top-right animate-menu-in focus:outline-none',
                )}
              >
                {ACTIONS.map((action) => {
                  const Icon = action.icon;
                  const live = action.needs === null;
                  return (
                    <button
                      key={action.label}
                      type="button"
                      role="menuitem"
                      disabled={!live}
                      title={
                        live
                          ? 'Releases the nights and records the cancellation. No fee is calculated.'
                          : `Not built yet — needs ${String(action.needs)} (CLAUDE.md section 2)`
                      }
                      onClick={
                        live
                          ? () => {
                              setOpen(false);
                              setCancelOpen(true);
                            }
                          : undefined
                      }
                      className={cn(
                        'group flex w-full items-center gap-2.5 rounded-lg px-3 py-2',
                        'text-left text-xs font-medium transition-colors duration-150 outline-none select-none',
                        live
                          ? action.destructive === true
                            ? 'cursor-pointer text-rose-300 hover:bg-rose-500/10'
                            : 'cursor-pointer text-zinc-200 hover:bg-white/[0.06]'
                          : cn(
                              'cursor-not-allowed',
                              action.destructive === true ? 'text-rose-400/50' : 'text-zinc-500',
                            ),
                      )}
                    >
                      <Icon
                        className={cn(
                          'size-4 shrink-0',
                          live
                            ? action.destructive === true
                              ? 'text-rose-400'
                              : 'text-zinc-300'
                            : action.destructive === true
                              ? 'text-rose-400/40'
                              : 'text-zinc-600',
                        )}
                        aria-hidden="true"
                      />
                      <span>{action.label}</span>
                    </button>
                  );
                })}

                <p className="mt-1 border-t border-white/[0.06] px-3 pt-2 pb-1 text-[10px] leading-snug text-zinc-600">
                  Only cancellation is wired. The rest are transactional changes
                  to inventory or the folio and ship with the reservations
                  module.
                </p>
              </div>
            </>,
            document.body,
          )}

      {cancelOpen ? (
        <CancelBookingDialog
          hotelId={hotelId}
          reservationId={reservationId}
          guestName={guestName}
          confirmationCode={bookingCode ?? null}
          onClose={() => {
            setCancelOpen(false);
          }}
          onCancelled={() => {
            setCancelOpen(false);
            onCancelled?.();
          }}
        />
      ) : null}
    </>
  );
}
