'use client';

/**
 * A dropdown menu that is not clipped by whatever contains it.
 *
 * ===========================================================================
 * Portalled, because every toolbar in this app scrolls.
 *
 * The reservation drawer is `overflow-y-auto`; the folio's pill toolbar is
 * `overflow-x-auto`. A scroll container clips its absolutely-positioned
 * descendants no matter what z-index they carry, so a menu nested inside
 * either gets cut off and no amount of `z-50` fixes it. The panel is therefore
 * rendered into `document.body` and positioned from the trigger's measured
 * rect.
 *
 * NO DROPDOWN OR ANIMATION LIBRARY
 * `@radix-ui/react-dropdown-menu` and `framer-motion` are both absent from
 * this workspace, and a menu is not a reason to add either (CLAUDE.md section
 * 6.4). What they would bring is the entrance curve and the dismissal
 * handling; the curve is `--animate-menu-in` in the Tailwind preset, and the
 * handling is below — and it has to be custom anyway, because of the Escape
 * problem described on the keydown listener.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import { ChevronDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ActionMenuProps {
  /** Rendered inside the trigger, before the chevron. */
  label: ReactNode;
  /** Names the menu for assistive technology. */
  ariaLabel: string;
  /** `start` grows rightwards from the trigger, `end` leftwards. */
  align?: 'start' | 'end';
  triggerClassName?: string;
  /** Receives a `close` it can call after acting. */
  children: (close: () => void) => ReactNode;
}

export function ActionMenu({
  label,
  ariaLabel,
  align = 'start',
  triggerClassName,
  children,
}: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left?: number; right?: number } | null>(
    null,
  );

  /**
   * Measure before the browser paints.
   *
   * `useLayoutEffect`, not `useEffect`: with an effect the panel renders once
   * at the top-left of the window and then jumps, which is visible and reads
   * as a bug. Measuring in the layout phase means the first painted frame is
   * already in place, and the entrance animation runs from there rather than
   * from the corner of the screen.
   */
  useLayoutEffect(() => {
    if (!open) return;

    const measure = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      setAnchor({
        top: rect.bottom + 6,
        ...(align === 'start'
          ? { left: rect.left }
          : { right: window.innerWidth - rect.right }),
      });
    };

    measure();

    // A portalled panel is not carried along by the page scrolling or the
    // window resizing, so it follows them.
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, align]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;

      /**
       * Swallow it, or Escape closes whatever is behind this too.
       *
       * A drawer or dialog containing the trigger also listens for Escape on
       * `document`, so one keypress reaches both and the operator loses the
       * whole panel when they meant to dismiss a menu. `stopPropagation` would
       * not help — both listeners are on the same node, and it does not stop
       * siblings. Listening in the **capture** phase runs before every
       * bubble-phase listener on `document` and stops the event dead there.
       */
      event.stopImmediatePropagation();
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const close = (): void => {
    setOpen(false);
  };

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
          'transition-all outline-none select-none hover:bg-zinc-800',
          'focus-visible:ring-2 focus-visible:ring-blue-500',
          triggerClassName,
        )}
      >
        {label}
        <ChevronDown
          className={cn('size-3 transition-transform duration-150', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>

      {!open || anchor === null
        ? null
        : createPortal(
            <>
              {/* Click-away as a sibling rather than a document listener: no
                  global handler to leak, and it cannot swallow focus. */}
              <button
                type="button"
                aria-label={`Close ${ariaLabel}`}
                onClick={close}
                className="fixed inset-0 z-[60] cursor-default"
              />

              <div
                role="menu"
                aria-label={ariaLabel}
                style={{
                  top: anchor.top,
                  ...(anchor.left === undefined ? {} : { left: anchor.left }),
                  ...(anchor.right === undefined ? {} : { right: anchor.right }),
                }}
                className={cn(
                  'fixed z-[61] min-w-[13.5rem] rounded-xl p-1.5',
                  'border border-white/10 bg-[#0f141f]/95 shadow-2xl backdrop-blur-md',
                  'animate-menu-in focus:outline-none',
                  align === 'start' ? 'origin-top-left' : 'origin-top-right',
                )}
              >
                {children(close)}
              </div>
            </>,
            document.body,
          )}
    </>
  );
}

export interface ActionMenuItemProps {
  label: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  /** Rose tint: this one ends a booking or forfeits money. */
  destructive?: boolean;
  /** Which unbuilt module this waits on. Omit for a live action. */
  needs?: string;
  onSelect?: () => void;
}

export function ActionMenuItem({
  label,
  icon: Icon,
  destructive = false,
  needs,
  onSelect,
}: ActionMenuItemProps) {
  const inert = needs !== undefined;

  return (
    <button
      type="button"
      role="menuitem"
      disabled={inert}
      onClick={onSelect}
      title={inert ? `Not built yet — needs ${needs} (CLAUDE.md section 2)` : label}
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-lg px-3 py-2',
        'text-left text-xs font-medium transition-colors duration-150 outline-none select-none',
        inert
          ? cn('cursor-not-allowed', destructive ? 'text-rose-400/50' : 'text-zinc-500')
          : destructive
            ? 'cursor-pointer text-zinc-300 hover:bg-rose-500/10 hover:text-rose-400'
            : 'cursor-pointer text-zinc-300 hover:bg-white/[0.06] hover:text-white',
      )}
    >
      <Icon
        className={cn(
          'size-4 shrink-0 transition-colors',
          inert
            ? destructive
              ? 'text-rose-400/40'
              : 'text-zinc-600'
            : destructive
              ? 'text-zinc-400 group-hover:text-rose-400'
              : 'text-zinc-400 group-hover:text-blue-400',
        )}
        aria-hidden={true}
      />
      <span>{label}</span>
    </button>
  );
}
