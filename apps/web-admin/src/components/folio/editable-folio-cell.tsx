'use client';

/**
 * One inline-editable money cell.
 *
 * ===========================================================================
 * Enter commits, blur commits, Escape cancels.
 *
 * Blur-to-commit is what the spec asks for, and it is safe here only because
 * of what the commit actually does: the server posts the difference as a new
 * line referencing the original, so an accidental commit is visible in the
 * ledger and correctable, rather than a silent overwrite of a guest's bill.
 * Escape is checked before blur fires, so cancelling does not then save.
 *
 * The optimistic update is the caller's job, not this component's. A cell
 * knows what number it is showing; it does not know what that number does to a
 * folio's subtotal, its CGST split, or the difference between posted and
 * scheduled charges. Handing it that responsibility is how a table starts
 * disagreeing with its own footer.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import { useRef, useState } from 'react';

export interface EditableFolioCellProps {
  /** Signed minor units, as stored: credits negative. */
  valueMinor: number;
  field: 'gross' | 'net';
  direction: 'DEBIT' | 'CREDIT';
  editable: boolean;
  /** Formats signed minor units for display. */
  format: (minor: number) => string;
  /** Tooltip for the display state. */
  title?: string | undefined;
  /** Receives the **magnitude** in minor units; the server applies the sign. */
  onSave: (magnitudeMinor: number) => Promise<void>;
  /** Rendered after the value in display mode. */
  suffix?: React.ReactNode;
}

export function EditableFolioCell({
  valueMinor,
  field,
  direction,
  editable,
  format,
  title,
  onSave,
  suffix,
}: EditableFolioCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Escape sets this so the blur that follows does not re-commit.
  const cancelled = useRef(false);

  async function commit(): Promise<void> {
    if (cancelled.current || saving) return;

    // The input no longer rejects non-numeric text for us, so this does.
    const trimmed = draft.trim();
    const parsed = Number(trimmed);
    if (trimmed === '' || !/^\d*\.?\d*$/.test(trimmed) || !Number.isFinite(parsed)) {
      setError('Enter an amount.');
      return;
    }

    // Rounded once, here at the boundary, into integer minor units. No money
    // arithmetic on a float anywhere downstream (CLAUDE.md section 3.4).
    const magnitudeMinor = Math.round(parsed * 100);
    if (magnitudeMinor === Math.abs(valueMinor)) {
      setEditing(false);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave(magnitudeMinor);
      setEditing(false);
    } catch (caught) {
      // Surfaced on the cell, never swallowed: a correction that silently
      // failed leaves a clerk believing a bill was fixed.
      setError(caught instanceof Error ? caught.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <td className="px-3 py-1 text-right">
        <input
          /**
           * Focus and select from a ref callback, not `autoFocus` + `onFocus`.
           *
           * `autoFocus` fires its focus event before React has attached the
           * handler, so an `onFocus` select never runs and the clerk has to
           * clear the field by hand before typing a correction. The callback
           * runs the moment the node exists, which is the only point at which
           * both are guaranteed.
           */
          ref={(node) => {
            if (node !== null && document.activeElement !== node) {
              node.focus();
              node.setSelectionRange(0, node.value.length);
            }
          }}
          /**
           * A text input in decimal mode, not `type="number"`.
           *
           * Two reasons, both discovered by testing this rather than by
           * reading about it:
           *
           *   * `select()` does nothing on a number input — `selectionStart`
           *     is not even supported there — so the pre-filled figure could
           *     not be replaced by typing. The spec asked for select-on-open
           *     and a number input cannot provide it.
           *   * A focused number input changes its value on a scroll wheel.
           *     On a dense folio table, scrolling the page with the cursor
           *     over an open editor would silently alter a guest's bill.
           *
           * `inputMode="decimal"` still brings up the numeric keypad on a
           * tablet at the desk, which is what the number type was wanted for.
           */
          type="text"
          inputMode="decimal"
          disabled={saving}
          value={draft}
          aria-label={`Corrected ${field} amount`}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void commit();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelled.current = true;
              setEditing(false);
              setError(null);
            }
          }}
          onBlur={() => {
            void commit();
          }}
          className="tabular w-28 rounded border border-blue-500 bg-zinc-900 px-2 py-1 text-right text-xs text-white focus:outline-none disabled:opacity-60"
        />
        {error !== null ? (
          <span className="mt-0.5 block text-[9px] text-rose-300">{error}</span>
        ) : null}
      </td>
    );
  }

  return (
    <td
      className={cn(
        'tabular px-3 py-2 text-right',
        field === 'gross' ? 'font-semibold' : 'font-normal',
        direction === 'CREDIT' ? 'text-emerald-400' : 'text-zinc-100',
      )}
    >
      {editable ? (
        <button
          type="button"
          onClick={() => {
            cancelled.current = false;
            setDraft((Math.abs(valueMinor) / 100).toFixed(2));
            setEditing(true);
          }}
          title={title ?? `Click to correct the ${field} amount`}
          className={cn(
            'tabular cursor-pointer underline decoration-dashed decoration-zinc-500 underline-offset-4 transition-colors',
            'hover:text-blue-300 hover:decoration-blue-400',
          )}
        >
          {format(valueMinor)}
        </button>
      ) : (
        format(valueMinor)
      )}
      {suffix}
    </td>
  );
}
