'use client';

/**
 * The `UA (n)` badge and the `+ Create` dropdown, with global Alt shortcuts.
 *
 * ===========================================================================
 * The keydown listener has three guards that are easy to leave out and painful
 * to debug later:
 *
 *   1. **It ignores typing.** Without checking the event target, Alt+E inside
 *      the search box or a date field would fire the Enquiry modal instead of
 *      reaching the input. Anything inside an input, textarea, select or
 *      contenteditable is left alone.
 *   2. **It requires Alt and rejects the other modifiers.** `Alt+Ctrl+W` and
 *      `Alt+Shift+W` are distinct chords that belong to the OS or the browser,
 *      and swallowing them makes the app feel broken.
 *   3. **It matches on `event.code`, not `event.key`.** With Alt held, many
 *      layouts report `key` as an accented character — on macOS Alt+E is a
 *      dead-key for an acute accent and `key` is "´", never "e". `code` is the
 *      physical key and is layout-independent.
 * ===========================================================================
 */

import { ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

export type BookingModal = 'walkin' | 'enquiry' | 'group';

interface MenuItem {
  id: BookingModal;
  label: string;
  /** Physical key, matched against `event.code`. */
  code: string;
  shortcut: string;
}

const ITEMS: readonly MenuItem[] = [
  { id: 'walkin', label: 'Walk-in', code: 'KeyW', shortcut: 'Alt+W' },
  { id: 'enquiry', label: 'Enquiry', code: 'KeyE', shortcut: 'Alt+E' },
  { id: 'group', label: 'Group Booking', code: 'KeyG', shortcut: 'Alt+G' },
];

/** True when the key event came from somewhere the user is typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

export interface CreateMenuProps {
  onOpenModal: (modal: BookingModal) => void;
}

export function CreateMenu({ onOpenModal }: CreateMenuProps) {
  const [open, setOpen] = useState(false);

  // Subscribing to a browser event is exactly what effects are for; the
  // listener calls a handler rather than setting state in the body.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isTypingTarget(event.target)) return;

      const match = ITEMS.find((item) => item.code === event.code);
      if (match === undefined) return;

      // Claimed, so the browser does not also run its own Alt handling.
      event.preventDefault();
      setOpen(false);
      onOpenModal(match.id);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onOpenModal]);

  return (
    <div className="flex items-center gap-2">
      {/* The unassigned count used to live here. It is now `UnassignedButton`
          in the toolbar, because it became a drawer trigger rather than a
          badge, and a control that opens something does not belong inside the
          create menu's subtree. */}
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setOpen((value) => !value);
          }}
          aria-expanded={open}
          aria-haspopup="menu"
          className="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1.5 text-xs font-medium text-black transition hover:bg-zinc-200"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          Create
          {open ? (
            <ChevronUp className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden="true" />
          )}
        </button>

        {open ? (
          <>
            <button
              type="button"
              aria-label="Close create menu"
              onClick={() => {
                setOpen(false);
              }}
              className="fixed inset-0 z-30 cursor-default"
            />
            <div
              role="menu"
              className="absolute right-0 z-40 mt-1.5 w-56 rounded-xl border border-white/[0.1] bg-[#0e0e10] p-1.5 shadow-2xl"
            >
              {ITEMS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onOpenModal(item.id);
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/[0.06]"
                >
                  <span className="text-xs font-semibold text-zinc-100">{item.label}</span>
                  <kbd className="rounded border border-white/[0.12] bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
                    {item.shortcut}
                  </kbd>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
