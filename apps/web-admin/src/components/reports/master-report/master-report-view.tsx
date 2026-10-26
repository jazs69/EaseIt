'use client';

/**
 * The master report screen.
 *
 * ===========================================================================
 * Query state lives in the URL; only the typing is local.
 *
 * Every control here — window, dimension, page, size, column filters — changes
 * what the *server* returns, so each belongs in the URL: a GM can bookmark
 * "last month's cancellations", the back button steps through their own
 * history, and a refresh lands on the same figures. That is the same rule the
 * generic report viewer follows.
 *
 * The exception is the text being typed into a column filter. Pushing a route
 * on every keystroke would put ten entries in the history for the word
 * "walk-in" and fire ten queries to match. So the inputs are local and the URL
 * is updated once the typing settles, which is also when the request goes.
 *
 * The server payload is **tagged**, not copied into state: a bare
 * `useState(initial)` would capture the first server render forever and ignore
 * every later one, and copying props in an effect is the cascading render
 * `react-hooks/set-state-in-effect` rejects.
 * ===========================================================================
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { CalendarClock, ChevronLeft, ChevronRight, Columns3, Info } from 'lucide-react';
import type { MasterReportDimension, MasterReportResponse } from '@repo/types';

import { masterReportCsvUrl } from '@/lib/properties-client';
import { ColumnsModal } from './columns-modal';
import { FILTERABLE, MasterReportTable } from './master-report-table';
import { ScheduledReportsDrawer } from './scheduled-reports-drawer';
import { DateRangeMenu, DimensionMenu, ExportMenu } from './toolbar-menus';
import { readColumnPreference, useColumnPreference } from './use-column-preference';

const PAGE_SIZES = [10, 25, 50, 100] as const;

/** How long the typing has to settle before a column filter is applied. */
const FILTER_DEBOUNCE_MS = 350;

export interface MasterReportViewProps {
  report: MasterReportResponse;
  hotelId: string;
}

export function MasterReportView({ report: initial, hotelId }: MasterReportViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const report = initial;

  /* ------------------------------------------------------------------ */
  /*  URL state                                                         */
  /* ------------------------------------------------------------------ */

  const pushQuery = useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      // Any change but paging returns to page one. Staying on page 7 of a
      // result set that just became two pages long shows an empty table and
      // reads as "no data" rather than "wrong page".
      if (!('page' in changes)) next.delete('page');

      startTransition(() => {
        router.replace(`?${next.toString()}`, { scroll: false });
      });
    },
    [router, searchParams],
  );

  /* ------------------------------------------------------------------ */
  /*  Column filters                                                    */
  /* ------------------------------------------------------------------ */

  const urlFilters = useMemo(() => {
    const current: Record<string, string> = {};
    for (const key of Object.values(FILTERABLE)) {
      const value = searchParams.get(key);
      if (value !== null && value !== '') current[key] = value;
    }
    return current;
  }, [searchParams]);

  // Tagged against the URL it came from, so a filter cleared elsewhere (or by
  // the back button) is reflected without an effect copying props into state.
  const [draft, setDraft] = useState<{
    from: Record<string, string>;
    value: Record<string, string>;
  } | null>(null);
  const filters = draft !== null && draft.from === urlFilters ? draft.value : urlFilters;

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onFilterChange = useCallback(
    (key: string, value: string) => {
      const next = { ...filters, [key]: value };
      if (value === '') delete next[key];
      setDraft({ from: urlFilters, value: next });

      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        pushQuery({ [key]: value === '' ? null : value });
      }, FILTER_DEBOUNCE_MS);
    },
    [filters, urlFilters, pushQuery],
  );

  // A pending debounce must not fire after the screen is gone.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  /* ------------------------------------------------------------------ */
  /*  Columns and selection                                             */
  /* ------------------------------------------------------------------ */

  const preference = useColumnPreference(hotelId);
  const [picking, setPicking] = useState(false);

  /** What the server actually returned, which is the truth about the table. */
  const activeColumns = useMemo(
    () => report.columns.map((column) => column.key),
    [report.columns],
  );

  /**
   * Applies a column selection: URL first, storage second.
   *
   * The URL carries it because the columns change what the *server* returns —
   * a narrower response and a matching CSV — so a shared link has to show the
   * same table. Storage is the default for the next visit, not the authority.
   *
   * Paging is reset: changing columns re-queries, and page 7 of a result set
   * is not meaningfully the same page with different columns.
   */
  const applyColumns = useCallback(
    (keys: string[]) => {
      preference.save(keys);
      setPicking(false);
      pushQuery({ columns: keys.join(',') });
    },
    [preference, pushQuery],
  );

  /**
   * On a first visit with no columns in the URL, adopt the saved preference.
   *
   * An effect rather than a render-time redirect, because reading
   * `localStorage` during render would differ between the server pass and the
   * client one and trip hydration. It runs once: the guard is the URL itself,
   * which the push then populates.
   */
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current) return;
    adopted.current = true;

    if (searchParams.get('columns') !== null) return;
    const saved = readColumnPreference(hotelId);
    if (saved === null) return;
    // Nothing to do if the preference is what the server already sent.
    if (saved.join(',') === activeColumns.join(',')) return;

    pushQuery({ columns: saved.join(',') });
  }, [hotelId, searchParams, activeColumns, pushQuery]);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const toggleRow = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((current) => {
      const ids = report.rows.map((row) => row.reservationId);
      const everySelected = ids.every((id) => current.has(id));
      const next = new Set(current);
      for (const id of ids) {
        if (everySelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, [report.rows]);

  /* ------------------------------------------------------------------ */
  /*  Render                                                            */
  /* ------------------------------------------------------------------ */

  const [schedulesOpen, setSchedulesOpen] = useState(false);

  const { page, pageCount, total, limit } = report.pagination;
  const firstRow = total === 0 ? 0 : (page - 1) * limit + 1;
  const lastRow = Math.min(page * limit, total);

  // The export carries the same columns and filters the screen shows, so a
  // file never arrives with forty columns the operator deliberately hid.
  const csvUrl = masterReportCsvUrl(hotelId, {
    startDate: report.startDate,
    endDate: report.endDate,
    dateDimension: report.dateDimension,
    columns: activeColumns.join(','),
    ...filters,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.08] px-4 py-4 sm:px-6">
        <div className="flex items-start gap-3">
          <Link
            href={`/reports/property-reports?hotelId=${encodeURIComponent(hotelId)}`}
            aria-label="Back to reports"
            className="mt-0.5 rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Link>
          <div>
            <h1 className="text-lg font-semibold text-white">Master Report</h1>
            <p className="mt-0.5 text-xs text-zinc-500">
              Detailed transaction and booking history
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <DateRangeMenu
            startDate={report.startDate}
            endDate={report.endDate}
            businessDate={report.generatedFor}
            onChange={(range) => {
              pushQuery({ startDate: range.startDate, endDate: range.endDate });
            }}
          />
          <DimensionMenu
            value={report.dateDimension}
            onChange={(dimension: MasterReportDimension) => {
              pushQuery({ dateDimension: dimension });
            }}
          />
          <ExportMenu csvUrl={csvUrl} />
          <button
            type="button"
            onClick={() => {
              setSchedulesOpen(true);
            }}
            className="flex items-center gap-1.5 rounded-lg border border-white/[0.1] px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
          >
            <CalendarClock className="size-3.5" aria-hidden="true" />
            View scheduled reports
          </button>
          <button
            type="button"
            onClick={() => {
              setPicking(true);
            }}
            className="flex items-center gap-1.5 rounded-lg border border-white/[0.1] px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
          >
            <Columns3 className="size-3.5" aria-hidden="true" />
            Columns
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {selected.size > 0 ? (
          <div className="mb-3 flex items-center gap-3 rounded-lg border border-blue-500/25 bg-blue-500/[0.07] px-3 py-2">
            <span className="text-xs text-blue-100">
              {String(selected.size)} selected
            </span>
            <button
              type="button"
              onClick={() => {
                setSelected(new Set());
              }}
              className="text-xs text-blue-300 transition-colors hover:text-blue-200"
            >
              Clear
            </button>
            {/* No bulk action is offered, because none is built. Selection is
                still useful for reading a wide table, and claiming an action
                that does not exist would be worse than offering none. */}
            <span className="ml-auto text-[11px] text-blue-200/60">
              Bulk actions need the operations module.
            </span>
          </div>
        ) : null}

        <MasterReportTable
          report={report}
          hotelId={hotelId}
          filters={filters}
          onFilterChange={onFilterChange}
          selected={selected}
          onToggleRow={toggleRow}
          onToggleAll={toggleAll}
          pending={pending}
        />

        {/* Pagination */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 print:hidden">
          <label className="flex items-center gap-2 text-xs text-zinc-500">
            Rows per page:
            <select
              value={limit}
              onChange={(event) => {
                pushQuery({ limit: event.target.value });
              }}
              className="rounded-md border border-white/[0.1] bg-white/[0.04] px-2 py-1 text-xs text-white outline-none focus:border-blue-500/60"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size} className="bg-zinc-900">
                  {size}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">
              Showing {String(firstRow)}-{String(lastRow)} of {String(total)}
            </span>
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => {
                pushQuery({ page: String(page - 1) });
              }}
              aria-label="Previous page"
              className="rounded-md border border-white/[0.1] p-1 text-zinc-400 transition-colors hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronLeft className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={page >= pageCount}
              onClick={() => {
                pushQuery({ page: String(page + 1) });
              }}
              aria-label="Next page"
              className="rounded-md border border-white/[0.1] p-1 text-zinc-400 transition-colors hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Caveats, under the table rather than in a tooltip: a figure with a
            known approximation in it carries that approximation wherever it
            goes. */}
        {report.notes.length > 0 ? (
          <ul className="mt-4 space-y-1.5">
            {report.notes.map((note) => (
              <li key={note} className="flex items-start gap-2 text-[11px] leading-relaxed text-zinc-500">
                <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* Mounted only while open, so each open stages a fresh copy of the
          applied columns and Cancel discards by construction. */}
      {picking ? (
        <ColumnsModal
          visible={activeColumns}
          onClose={() => {
            setPicking(false);
          }}
          onSave={applyColumns}
        />
      ) : null}

      <ScheduledReportsDrawer
        open={schedulesOpen}
        onClose={() => {
          setSchedulesOpen(false);
        }}
      />
    </div>
  );
}
