'use client';

/**
 * The audit log viewer (AD-03).
 *
 * Filters by actor, entity type, entity id, event and property-local dates;
 * each row expands to show the values before and after, field by field. The
 * server does the filtering and the paging -- this screen never decides what
 * a caller may see.
 */

import { cn } from '@repo/ui';
import { ChevronDown, ChevronRight, Loader2, RotateCcw, Search } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { AuditLogEntry, AuditLogFacets, AuditLogPage } from '@repo/types';

import { fetchAuditLog, type AuditLogFilters } from '@/lib/properties-client';

const EMPTY: AuditLogFilters = {
  actor: '',
  entityType: '',
  entityId: '',
  event: '',
  from: '',
  to: '',
};

const FIELD =
  'rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-zinc-200 focus:border-white/20 focus:outline-none';

function humanise(key: string): string {
  return key.toLowerCase().replace(/[_.:-]+/g, ' ');
}

function formatAt(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function render(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Field-by-field rows for two snapshots; a non-object snapshot is shown whole. */
function diffRows(
  before: unknown,
  after: unknown,
): { key: string; before: unknown; after: unknown; changed: boolean }[] {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isRecord(before) && !isRecord(after)) {
    return [{ key: 'value', before, after, changed: render(before) !== render(after) }];
  }
  const left = isRecord(before) ? before : {};
  const right = isRecord(after) ? after : {};
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.map((key) => ({
    key,
    before: key in left ? left[key] : undefined,
    after: key in right ? right[key] : undefined,
    changed: render(left[key]) !== render(right[key]),
  }));
}

export function AuditLogViewer({
  hotelId,
  initial,
  facets,
}: {
  hotelId: string;
  initial: AuditLogPage;
  facets: AuditLogFacets;
}) {
  const [draft, setDraft] = useState<AuditLogFilters>(EMPTY);
  const [applied, setApplied] = useState<AuditLogFilters>(EMPTY);
  const [items, setItems] = useState<AuditLogEntry[]>(initial.items);
  const [nextCursor, setNextCursor] = useState<string | null>(initial.nextCursor);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'search' | 'more' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timeZone = initial.timeZone;

  async function search(filters: AuditLogFilters): Promise<void> {
    setBusy('search');
    setError(null);
    try {
      const page = await fetchAuditLog(hotelId, filters);
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setApplied(filters);
      setOpen(new Set());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The audit log could not be loaded.');
    } finally {
      setBusy(null);
    }
  }

  async function loadMore(): Promise<void> {
    if (nextCursor === null) return;
    setBusy('more');
    setError(null);
    try {
      const page = await fetchAuditLog(hotelId, applied, { cursor: nextCursor });
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'More entries could not be loaded.');
    } finally {
      setBusy(null);
    }
  }

  function toggle(id: string): void {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const set = (key: keyof AuditLogFilters) => (value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="flex flex-col gap-4">
      <form
        className="grid grid-cols-1 gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          void search(draft);
        }}
      >
        <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
          Who
          <select
            className={FIELD}
            value={draft.actor}
            onChange={(e) => set('actor')(e.target.value)}
          >
            <option value="">Anyone</option>
            <option value="system">System (night audit and jobs)</option>
            {facets.actors.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
          What changed
          <select
            className={FIELD}
            value={draft.entityType}
            onChange={(e) => set('entityType')(e.target.value)}
          >
            <option value="">Anything</option>
            {facets.entityTypes.map((type) => (
              <option key={type} value={type}>
                {humanise(type)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
          Event
          <select
            className={FIELD}
            value={draft.event}
            onChange={(e) => set('event')(e.target.value)}
          >
            <option value="">Any event</option>
            {facets.events.map((event) => (
              <option key={event} value={event}>
                {humanise(event)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
          Record id
          <input
            className={FIELD}
            value={draft.entityId}
            placeholder="e.g. a reservation id"
            onChange={(e) => set('entityId')(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
          From (hotel date)
          <input
            type="date"
            className={FIELD}
            value={draft.from}
            onChange={(e) => set('from')(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
          To (hotel date)
          <input
            type="date"
            className={FIELD}
            value={draft.to}
            onChange={(e) => set('to')(e.target.value)}
          />
        </label>
        <div className="flex items-end gap-2 sm:col-span-2">
          <button
            type="submit"
            disabled={busy !== null}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-emerald-950 disabled:opacity-50"
          >
            {busy === 'search' ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Search className="size-3.5" aria-hidden="true" />
            )}
            Apply filters
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              setDraft(EMPTY);
              void search(EMPTY);
            }}
            className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-zinc-300 disabled:opacity-50"
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            Clear
          </button>
        </div>
      </form>

      {error !== null ? (
        <p
          role="alert"
          className="rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2 text-xs text-rose-200"
        >
          {error}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="bg-white/[0.03] text-[11px] tracking-wide text-zinc-500 uppercase">
            <tr>
              <th className="w-6 px-3 py-2" />
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Who</th>
              <th className="px-3 py-2">Event</th>
              <th className="px-3 py-2">Record</th>
              <th className="px-3 py-2">Reason</th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => {
              const expanded = open.has(entry.id);
              return (
                <Fragment key={entry.id}>
                  <tr
                    className="cursor-pointer border-t border-white/[0.06] text-zinc-300 hover:bg-white/[0.02]"
                    onClick={() => toggle(entry.id)}
                  >
                    <td className="px-3 py-2 text-zinc-500">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={expanded ? 'Hide changes' : 'Show changes'}
                      >
                        {expanded ? (
                          <ChevronDown className="size-3.5" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="size-3.5" aria-hidden="true" />
                        )}
                      </button>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                      {formatAt(entry.at, timeZone)}
                    </td>
                    <td className="px-3 py-2">
                      {entry.actor?.name ?? <span className="text-zinc-500">System</span>}
                    </td>
                    <td className="px-3 py-2 font-medium text-zinc-100">{humanise(entry.event)}</td>
                    <td className="px-3 py-2">
                      <span className="text-zinc-400">{humanise(entry.entityType)}</span>{' '}
                      <span className="font-mono text-[11px] text-zinc-500">
                        {entry.entityId.slice(0, 8)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-zinc-400">{entry.reason ?? '—'}</td>
                  </tr>
                  {expanded ? (
                    <tr className="border-t border-white/[0.04] bg-white/[0.015]">
                      <td />
                      <td colSpan={5} className="px-3 py-3">
                        <p className="mb-2 font-mono text-[11px] text-zinc-500">
                          {entry.entityType} {entry.entityId}
                        </p>
                        <table className="w-full text-[11px]">
                          <thead className="text-zinc-500">
                            <tr>
                              <th className="w-1/4 py-1 pr-3 font-medium">Field</th>
                              <th className="w-[37.5%] py-1 pr-3 font-medium">Before</th>
                              <th className="w-[37.5%] py-1 font-medium">After</th>
                            </tr>
                          </thead>
                          <tbody>
                            {diffRows(entry.before, entry.after).map((row) => (
                              <tr
                                key={row.key}
                                className={cn(
                                  'align-top',
                                  row.changed ? 'text-zinc-100' : 'text-zinc-500',
                                )}
                              >
                                <td className="py-1 pr-3 font-mono">{row.key}</td>
                                <td
                                  className={cn(
                                    'py-1 pr-3 font-mono break-all',
                                    row.changed && 'text-rose-300',
                                  )}
                                >
                                  {render(row.before)}
                                </td>
                                <td
                                  className={cn(
                                    'py-1 font-mono break-all',
                                    row.changed && 'text-emerald-300',
                                  )}
                                >
                                  {render(row.after)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-zinc-500">No entries match.</p>
        ) : null}
      </div>

      {nextCursor !== null ? (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            void loadMore();
          }}
          className="flex items-center justify-center gap-1.5 self-center rounded-lg border border-white/[0.08] px-4 py-1.5 text-xs text-zinc-300 disabled:opacity-50"
        >
          {busy === 'more' ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : null}
          Load older entries
        </button>
      ) : items.length > 0 ? (
        <p className="text-center text-[11px] text-zinc-600">End of the log.</p>
      ) : null}
    </div>
  );
}
