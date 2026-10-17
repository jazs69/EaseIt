'use client';

import { cn } from '@repo/ui';
import { permissionsByCategory, type Permission, type PermissionDefinition } from '@repo/types';
import { ShieldAlert } from 'lucide-react';

/**
 * The categorised permission grid used by the role editor.
 *
 * Sensitive permissions — anything that moves money or reduces revenue — are
 * badged, so an administrator can see what they are handing out rather than
 * reading twenty similar-looking labels.
 */

export interface PermissionMatrixProps {
  selected: ReadonlySet<Permission>;
  onToggle: (permission: Permission, next: boolean) => void;
  /** Permissions the current operator cannot grant because they lack them. */
  ungrantable?: ReadonlySet<Permission>;
  disabled?: boolean;
}

interface RowProps {
  definition: PermissionDefinition;
  checked: boolean;
  blocked: boolean;
  disabled: boolean;
  onToggle: (permission: Permission, next: boolean) => void;
}

function PermissionRow({ definition, checked, blocked, disabled, onToggle }: RowProps) {
  const inputId = `perm-${definition.key.replace(/[:_]/g, '-')}`;
  const locked = disabled || blocked;

  return (
    <label
      htmlFor={inputId}
      className={cn(
        'flex items-start gap-3 rounded-lg border border-transparent px-3 py-2.5 transition-colors',
        locked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-white/[0.03]',
      )}
    >
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        disabled={locked}
        onChange={(event) => {
          onToggle(definition.key, event.target.checked);
        }}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="mt-0.5 grid size-4 shrink-0 place-items-center rounded border border-white/15 bg-zinc-900/60 transition-colors peer-checked:border-blue-500 peer-checked:bg-blue-500 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500/50 peer-checked:[&>svg]:scale-100"
      >
        <svg
          viewBox="0 0 12 12"
          className="size-3 scale-0 text-white transition-transform"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 6.5 5 9l4.5-5.5" />
        </svg>
      </span>

      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-200">{definition.label}</span>
          {definition.sensitive ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/25 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-amber-300 uppercase">
              <ShieldAlert className="size-2.5" aria-hidden="true" />
              Sensitive
            </span>
          ) : null}
        </span>
        <span className="text-xs leading-relaxed text-zinc-500">{definition.description}</span>
        <code className="mt-0.5 text-[10px] text-zinc-700">{definition.key}</code>
        {blocked ? (
          <span className="text-[10px] text-amber-400/80">
            You cannot grant this — you do not hold it yourself.
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function PermissionMatrix({
  selected,
  onToggle,
  ungrantable,
  disabled = false,
}: PermissionMatrixProps) {
  const groups = permissionsByCategory();

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => {
        const groupKeys = group.permissions.map((definition) => definition.key);
        const allOn = groupKeys.every((key) => selected.has(key));
        const someOn = groupKeys.some((key) => selected.has(key));

        return (
          <section key={group.category} className="flex flex-col gap-2">
            <header className="flex items-center justify-between gap-3 border-b border-white/[0.06] pb-2">
              <h3 className="text-xs font-semibold tracking-[0.16em] text-zinc-400 uppercase">
                {group.label}
              </h3>
              <div className="flex items-center gap-2">
                <span className="tabular text-[10px] text-zinc-600">
                  {groupKeys.filter((key) => selected.has(key)).length}/{groupKeys.length}
                </span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    for (const key of groupKeys) {
                      if (ungrantable?.has(key) === true) continue;
                      onToggle(key, !allOn);
                    }
                  }}
                  className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[10px] text-zinc-400 transition-colors hover:border-blue-500/30 hover:text-white disabled:opacity-50"
                >
                  {allOn ? 'Clear all' : someOn ? 'Select all' : 'Select all'}
                </button>
              </div>
            </header>

            <div className="grid gap-1 sm:grid-cols-2">
              {group.permissions.map((definition) => (
                <PermissionRow
                  key={definition.key}
                  definition={definition}
                  checked={selected.has(definition.key)}
                  blocked={ungrantable?.has(definition.key) === true}
                  disabled={disabled}
                  onToggle={onToggle}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
