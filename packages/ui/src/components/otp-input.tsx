'use client';

/**
 * A fixed-length numeric code field, rendered as separate slots.
 *
 * ===========================================================================
 * There is **one real `<input>`** behind the slots, not one per digit. The
 * slots are presentational `<div>`s; the input is stretched over them,
 * transparent, and holds the whole value.
 *
 * That shape is not a styling trick, it is what makes the field work:
 *
 *   * **Autofill.** `autocomplete="one-time-code"` lets iOS and Android offer
 *     the code straight from the notification, and password managers fill it.
 *     Both need the entire code to go into a single field; a six-input version
 *     receives the first character and drops the rest.
 *   * **Paste.** Pasting into one real input Just Works. The N-input version
 *     needs a paste handler that redistributes characters across siblings, and
 *     that handler is where the bugs live.
 *   * **Keyboard and screen readers.** Backspace, arrow keys, select-all and
 *     undo are the browser's, not a reimplementation. Assistive technology
 *     sees one labelled text field instead of six unlabelled ones.
 *
 * The visible caret is drawn by us, because the real caret would be positioned
 * against invisible text. `caret-transparent` hides the native one.
 * ===========================================================================
 */

import { useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';

import { cn } from '../lib/utils';

export interface OtpInputProps {
  value: string;
  onChange: (next: string) => void;
  /** Fired once, when the final digit completes the code. */
  onComplete?: (value: string) => void;
  length?: number;
  disabled?: boolean;
  /** Renders the error treatment and sets `aria-invalid`. */
  invalid?: boolean;
  autoFocus?: boolean;
  label?: string;
  describedBy?: string;
  className?: string;
}

export function OtpInput({
  value,
  onChange,
  onComplete,
  length = 6,
  disabled = false,
  invalid = false,
  autoFocus = false,
  label = 'Verification code',
  describedBy,
  className,
}: OtpInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const inputId = useId();

  const digits = value.split('');
  // The caret sits on the first empty slot, or on the last one when full.
  const caretIndex = Math.min(value.length, length - 1);

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    // Strip anything that is not a digit rather than rejecting the input
    // wholesale: an autofilled or pasted code often arrives as "123 456" or
    // "123-456", and silently refusing it looks like a broken field.
    const next = event.target.value.replace(/\D/g, '').slice(0, length);
    if (next === value) return;

    onChange(next);

    // Fired from the change handler rather than an effect so it runs exactly
    // once per completion. An effect keyed on `value` re-fires on any
    // unrelated re-render that happens while the code is full.
    if (next.length === length) {
      onComplete?.(next);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // The value is always edited at the end, so keep the caret there. Without
    // this, clicking into the middle of the invisible text would make the next
    // keystroke land in the wrong position.
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
    }
  }

  function focusEnd(): void {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    // setSelectionRange rather than relying on click position, for the reason
    // above.
    input.setSelectionRange(value.length, value.length);
  }

  return (
    <div className={cn('relative', className)}>
      <input
        ref={inputRef}
        id={inputId}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          setFocused(true);
          // Deferred: calling setSelectionRange inside the focus handler is
          // overridden by the browser's own click-to-position afterwards.
          requestAnimationFrame(focusEnd);
        }}
        onBlur={() => {
          setFocused(false);
        }}
        disabled={disabled}
        autoFocus={autoFocus}
        // The three attributes that make mobile and password-manager autofill
        // work. `one-time-code` is the documented token for exactly this.
        autoComplete="one-time-code"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={length}
        aria-label={label}
        aria-invalid={invalid}
        {...(describedBy !== undefined ? { 'aria-describedby': describedBy } : {})}
        // Stretched over the slots and invisible, but still a real focusable
        // input: `opacity-0` keeps it in the accessibility tree, where
        // `display:none` or `visibility:hidden` would remove it.
        className="absolute inset-0 z-10 h-full w-full cursor-pointer bg-transparent text-transparent caret-transparent opacity-0 outline-none disabled:cursor-not-allowed"
      />

      {/* Presentational. The input above owns all interaction. */}
      <div aria-hidden="true" className="flex w-full gap-2">
        {Array.from({ length }, (_, index) => {
          const digit = digits[index];
          const isCaret = focused && index === caretIndex && !disabled;
          const isFilled = digit !== undefined;

          return (
            <div
              key={index}
              onClick={focusEnd}
              className={cn(
                'relative flex aspect-square flex-1 items-center justify-center rounded-xl border text-2xl font-semibold tabular-nums transition-all duration-150',
                'bg-zinc-900/60 text-white',
                isFilled ? 'border-white/20' : 'border-white/10',
                invalid && 'border-rose-500/60 bg-rose-500/[0.06] text-rose-200',
                isCaret && !invalid && 'border-blue-500 ring-1 ring-blue-500/50',
                disabled && 'opacity-50',
              )}
            >
              {digit ?? ''}
              {isCaret && !isFilled ? (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <span className="animate-caret-blink h-[1.1em] w-px bg-white/80" />
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
