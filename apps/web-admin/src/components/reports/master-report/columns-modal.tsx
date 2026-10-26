'use client';

/**
 * The column picker.
 *
 * ===========================================================================
 * Sixty columns in five sections, twenty of which cannot be filled.
 *
 * The unavailable ones are shown, disabled, with the reason on hover and in
 * the row itself. That is the decision worth defending: a picker that silently
 * omits "OTA commission" leaves an operator hunting for it; one that offers it
 * and renders a dash on every row teaches them the software is broken. Saying
 * "needs the channel-manager module" is the only version that is true.
 *
 * Edits are **staged**. Nothing reaches the table or storage until Save, so
 * Cancel genuinely discards — a picker that applied each checkbox live would
 * fire a request per click and make Cancel a lie.
 * ===========================================================================
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Lock, Search, X } from 'lucide-react';
import {
  MASTER_REPORT_CATEGORY_LABELS,
  MASTER_REPORT_CATEGORY_ORDER,
  MASTER_REPORT_COLUMN_DEFS,
  MASTER_REPORT_DEFAULT_COLUMNS,
  type MasterReportCategory,
  type MasterReportColumnDef,
} from '@repo/types';
import { cn } from '@repo/ui';

/** The booking id is the row's handle; a table without it cannot be acted on. */
const LOCKED = 'bookingId';

export interface ColumnsModalProps {
  /** Currently applied column keys. */
  visible: readonly string[];
  onClose: () => void;
  onSave: (keys: string[]) => void;
}

/**
 * Mounted only while open, which is what makes the staging work.
 *
 * The first attempt kept the component mounted and re-staged from `visible`
 * whenever an `open` prop flipped — which meant reading a ref during render to
 * detect the edge, and React forbids that for good reason: the render would
 * see a different value depending on when it ran. Copying `visible` into state
 * with an effect is the other wrong answer, the cascading render
 * `react-hooks/set-state-in-effect` rejects.
 *
 * Letting the parent mount it instead makes `useState(new Set(visible))`
 * exactly right: every open is a fresh component, so Cancel discards by
 * construction and the search box starts empty without anyone resetting it.
 */
export function ColumnsModal({ visible, onClose, onSave }: ColumnsModalProps) {
  const [staged, setStaged] = useState<Set<string>>(() => new Set(visible));
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Capture phase, propagation stopped: one Escape closes this and not
        // also whatever popover sits behind it.
        event.stopImmediatePropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    searchRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  const needle = search.trim().toLowerCase();

  const sections = useMemo(() => {
    return MASTER_REPORT_CATEGORY_ORDER.map((category) => ({
      category,
      columns: MASTER_REPORT_COLUMN_DEFS.filter(
        (column) =>
          column.category === category &&
          (needle === '' || column.label.toLowerCase().includes(needle)),
      ),
    })).filter((section) => section.columns.length > 0);
  }, [needle]);

  const toggle = (column: MasterReportColumnDef) => {
    if (!column.available || column.key === LOCKED) return;
    setStaged((current) => {
      const next = new Set(current);
      if (next.has(column.key)) next.delete(column.key);
      else next.add(column.key);
      return next;
    });
  };

  /** Select-all acts on the selectable columns of that section only. */
  const toggleSection = (category: MasterReportCategory) => {
    const selectable = MASTER_REPORT_COLUMN_DEFS.filter(
      (column) => column.category === category && column.available,
    );
    const allOn = selectable.every((column) => staged.has(column.key));
    setStaged((current) => {
      const next = new Set(current);
      for (const column of selectable) {
        if (allOn && column.key !== LOCKED) next.delete(column.key);
        else next.add(column.key);
      }
      return next;
    });
  };

  const everySelectable = MASTER_REPORT_COLUMN_DEFS.filter((column) => column.available);
  const allSelected = everySelectable.every((column) => staged.has(column.key));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close column picker"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="columns-modal-title"
        className="relative flex max-h-[85vh] w-full max-w-4xl flex-col rounded-xl border border-white/[0.1] bg-zinc-950 shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/[0.08] px-5 py-4">
          <div className="min-w-0">
            <h2 id="columns-modal-title" className="text-sm font-semibold text-white">
              Columns
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              {String(staged.size)} of {String(everySelectable.length)} available columns
              selected.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="relative flex items-center">
              <Search
                className="pointer-events-none absolute left-2.5 size-3.5 text-zinc-600"
                aria-hidden="true"
              />
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
                placeholder="Search columns…"
                aria-label="Search columns"
                className="w-52 rounded-lg border border-white/[0.1] bg-white/[0.04] py-1.5 pr-2 pl-8 text-xs text-white outline-none transition-colors placeholder:text-zinc-600 focus:border-blue-500/60"
              />
            </span>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
            >
              <X className="size-4" aria-hidden="true" />
              <span className="sr-only">Close</span>
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {sections.length === 0 ? (
            <p className="py-8 text-center text-xs text-zinc-500">
              No column matches “{search}”.
            </p>
          ) : (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {sections.map((section) => {
                const selectable = section.columns.filter((column) => column.available);
                const sectionAllOn =
                  selectable.length > 0 &&
                  selectable.every((column) => staged.has(column.key));

                return (
                  <section key={section.category}>
                    <div className="mb-2 flex items-center justify-between gap-2 border-b border-white/[0.06] pb-1.5">
                      <h3 className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
                        {MASTER_REPORT_CATEGORY_LABELS[section.category]}
                      </h3>
                      <button
                        type="button"
                        disabled={selectable.length === 0}
                        onClick={() => {
                          toggleSection(section.category);
                        }}
                        className="text-[10px] font-medium text-blue-400 transition-colors hover:text-blue-300 disabled:cursor-not-allowed disabled:text-zinc-600"
                      >
                        {sectionAllOn ? 'Clear all' : 'Select all'}
                      </button>
                    </div>

                    <ul className="space-y-0.5">
                      {section.columns.map((column) => {
                        const checked = staged.has(column.key);
                        const locked = column.key === LOCKED;
                        const disabled = !column.available || locked;

                        return (
                          <li key={column.key}>
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={checked}
                              disabled={disabled}
                              title={column.blockedBy ?? (locked ? 'Identifies the row' : undefined)}
                              onClick={() => {
                                toggle(column);
                              }}
                              className={cn(
                                'flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors',
                                disabled
                                  ? 'cursor-not-allowed'
                                  : 'text-zinc-300 hover:bg-white/[0.05] hover:text-white',
                                !column.available && 'text-zinc-600',
                                locked && 'text-zinc-500',
                              )}
                            >
                              <span
                                className={cn(
                                  'mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded border',
                                  !column.available
                                    ? 'border-white/[0.08] bg-white/[0.02]'
                                    : checked
                                      ? 'border-blue-500 bg-blue-500'
                                      : 'border-white/20',
                                )}
                              >
                                {checked && column.available ? (
                                  <Check className="size-2.5 text-white" aria-hidden="true" />
                                ) : null}
                              </span>

                              <span className="min-w-0">
                                <span className="flex items-center gap-1">
                                  {column.label}
                                  {locked ? (
                                    <Lock className="size-2.5 text-zinc-600" aria-hidden="true" />
                                  ) : null}
                                </span>
                                {column.blockedBy === null ? null : (
                                  <span className="mt-0.5 block text-[10px] leading-snug text-zinc-700">
                                    {column.blockedBy}
                                  </span>
                                )}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.08] px-5 py-3">
          <button
            type="button"
            onClick={() => {
              setStaged(
                new Set(
                  allSelected
                    ? [LOCKED]
                    : everySelectable.map((column) => column.key),
                ),
              );
            }}
            className="text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200"
          >
            {allSelected ? 'Clear all' : 'Select all'}
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setStaged(new Set(MASTER_REPORT_DEFAULT_COLUMNS));
              }}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200"
            >
              Reset to default
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-white/[0.1] px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={staged.size === 0}
              onClick={() => {
                // Catalogue order, not click order, so two people with the
                // same columns selected see them in the same sequence.
                onSave(
                  MASTER_REPORT_COLUMN_DEFS.filter((column) => staged.has(column.key)).map(
                    (column) => column.key,
                  ),
                );
              }}
              className="rounded-lg bg-blue-500 px-4 py-1.5 text-xs font-bold tracking-wider text-white uppercase transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
