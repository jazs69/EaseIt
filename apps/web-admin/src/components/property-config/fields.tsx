'use client';

/**
 * The form primitives the five configuration tabs share.
 *
 * Local to this screen rather than pushed into `packages/ui`: that package
 * holds primitives both web apps use, and nothing in the booking engine edits
 * a GST slab. They move there if a second consumer appears, not before
 * (CLAUDE.md section 2).
 */

import type { ReactNode } from 'react';
import { cn } from '@repo/ui';

/** A labelled field with optional help text and an error. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5" htmlFor={htmlFor}>
      <span className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
        {label}
      </span>
      {children}
      {error !== undefined && error !== '' ? (
        <span className="text-[11px] text-rose-400">{error}</span>
      ) : hint === undefined ? null : (
        <span className="text-[11px] leading-relaxed text-zinc-500">{hint}</span>
      )}
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm ' +
  'text-white outline-none transition-colors placeholder:text-zinc-600 ' +
  'focus:border-blue-500/60 focus:bg-white/[0.05] disabled:cursor-not-allowed ' +
  'disabled:opacity-50';

export function TextInput({
  value,
  onChange,
  disabled,
  placeholder,
  id,
  inputMode,
  invalid,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  inputMode?: 'text' | 'decimal' | 'numeric';
  invalid?: boolean;
}) {
  return (
    <input
      {...(id === undefined ? {} : { id })}
      /**
       * Always `text`, even for numbers.
       *
       * `<input type="number">` ignores `select()`, reports a null
       * `selectionStart`, and changes its value on a stray scroll wheel over a
       * focused field — which on this screen would silently re-rate a tax
       * slab. `inputMode` still brings up the numeric keypad on a phone.
       */
      type="text"
      {...(inputMode === undefined ? {} : { inputMode })}
      value={value}
      disabled={disabled === true}
      {...(placeholder === undefined ? {} : { placeholder })}
      aria-invalid={invalid === true ? true : undefined}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      className={cn(inputClass, invalid === true && 'border-rose-500/60')}
    />
  );
}

export function TextArea({
  value,
  onChange,
  disabled,
  rows = 4,
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  rows?: number;
  id?: string;
}) {
  return (
    <textarea
      {...(id === undefined ? {} : { id })}
      rows={rows}
      value={value}
      disabled={disabled === true}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      className={cn(inputClass, 'resize-y leading-relaxed')}
    />
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
  id,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <select
      {...(id === undefined ? {} : { id })}
      value={value}
      disabled={disabled === true}
      onChange={(event) => {
        onChange(event.target.value as T);
      }}
      className={cn(inputClass, 'appearance-none')}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} className="bg-zinc-900">
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled === true}
      onClick={() => {
        onChange(!checked);
      }}
      className="flex items-center gap-2.5 text-left disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors',
          checked ? 'bg-blue-500' : 'bg-white/[0.12]',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-4 rounded-full bg-white transition-all',
            checked ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </span>
      <span className="text-sm text-zinc-300">{label}</span>
    </button>
  );
}

/** A section of a tab: a heading, an explanation, and its fields. */
export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-white/[0.08] bg-white/[0.02]">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          {description === undefined ? null : (
            <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-zinc-500">
              {description}
            </p>
          )}
        </div>
        {action}
      </header>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

/**
 * States plainly that something is recorded but not yet acted on.
 *
 * Preferred over hiding the control. A fee a property charges is worth
 * configuring before a charge path reads it — but an operator who sets one and
 * is not told nothing bills it would reasonably assume it does.
 */
export function NotWiredNotice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs leading-relaxed text-amber-200/90">
      {children}
    </p>
  );
}

export function SaveBar({
  dirty,
  saving,
  saved,
  onSave,
  onReset,
}: {
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      {saved && !dirty ? (
        <span className="mr-auto text-xs text-emerald-400">Saved.</span>
      ) : dirty ? (
        <span className="mr-auto text-xs text-amber-300/90">Unsaved changes.</span>
      ) : null}
      <button
        type="button"
        onClick={onReset}
        disabled={!dirty || saving}
        className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Discard
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={!dirty || saving}
        className="rounded-lg bg-blue-500 px-4 py-1.5 text-xs font-bold tracking-wider text-white uppercase transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
