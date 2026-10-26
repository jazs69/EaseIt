'use client';

/**
 * The master report's four toolbar controls.
 *
 * Built on the shared `ActionMenu`, which portals its panel and closes on a
 * capture-phase Escape — the same primitive the booking-actions and modify
 * menus use, so a third popover implementation with its own outside-click and
 * focus quirks does not appear on this screen.
 */

import { useState } from 'react';
import {
  CalendarClock,
  CalendarDays,
  Check,
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  FileType2,
  Printer,
  Share2,
} from 'lucide-react';
import type { MasterReportDimension } from '@repo/types';
import {
  MASTER_REPORT_DIMENSION_LABELS,
  MASTER_REPORT_DIMENSION_ORDER,
} from '@repo/types';

import { ActionMenu } from '@/components/common/action-menu';

/* -------------------------------------------------------------------------- */
/*  Date range                                                                */
/* -------------------------------------------------------------------------- */

export type DateRangePreset =
  | 'today'
  | 'yesterday'
  | 'this-week'
  | 'this-month'
  | 'last-30'
  | 'custom';

const PRESET_LABELS: Record<DateRangePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  'this-week': 'This week',
  'this-month': 'This month',
  'last-30': 'Last 30 days',
  custom: 'Custom range',
};

const DAY_MS = 86_400_000;

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function fromIso(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/**
 * Resolves a preset against the **property's business date**, not the browser's.
 *
 * A clerk in one timezone looking at a hotel in another must get the hotel's
 * "today": the figures are reconciled against the property's own open
 * accounting day, which only the night audit advances (CLAUDE.md section 3.3).
 * Taking `new Date()` here would put the two a day apart twice a day.
 */
export function resolvePreset(
  preset: DateRangePreset,
  businessDate: string,
): { startDate: string; endDate: string } | null {
  const today = fromIso(businessDate);

  switch (preset) {
    case 'today':
      return { startDate: businessDate, endDate: businessDate };
    case 'yesterday': {
      const day = toIso(new Date(today.getTime() - DAY_MS));
      return { startDate: day, endDate: day };
    }
    case 'this-week': {
      // Monday-first, which is how an Indian hotel week is read.
      const weekday = (today.getUTCDay() + 6) % 7;
      const monday = new Date(today.getTime() - weekday * DAY_MS);
      return { startDate: toIso(monday), endDate: businessDate };
    }
    case 'this-month': {
      const first = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
      );
      return { startDate: toIso(first), endDate: businessDate };
    }
    case 'last-30':
      return { startDate: toIso(new Date(today.getTime() - 29 * DAY_MS)), endDate: businessDate };
    case 'custom':
    default:
      // The caller opens the two date inputs instead.
      return null;
  }
}

/** `2026-10-19` -> `19 Oct 2026`. */
export function formatRangeLabel(startDate: string, endDate: string): string {
  const show = (iso: string): string =>
    fromIso(iso).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  return `${show(startDate)} - ${show(endDate)}`;
}

export function DateRangeMenu({
  startDate,
  endDate,
  businessDate,
  onChange,
}: {
  startDate: string;
  endDate: string;
  businessDate: string;
  onChange: (range: { startDate: string; endDate: string }) => void;
}) {
  const [custom, setCustom] = useState<{ start: string; end: string } | null>(null);

  return (
    <ActionMenu
      ariaLabel="Date range"
      align="end"
      label={
        <span className="flex items-center gap-1.5">
          <CalendarDays className="size-3.5" aria-hidden="true" />
          {formatRangeLabel(startDate, endDate)}
        </span>
      }
    >
      {(close) => (
        <div className="w-60 p-1">
          {(Object.keys(PRESET_LABELS) as DateRangePreset[]).map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => {
                const range = resolvePreset(preset, businessDate);
                if (range === null) {
                  setCustom({ start: startDate, end: endDate });
                  return;
                }
                setCustom(null);
                onChange(range);
                close();
              }}
              className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              {PRESET_LABELS[preset]}
              {preset === 'custom' ? (
                <ChevronDown className="size-3 -rotate-90" aria-hidden="true" />
              ) : null}
            </button>
          ))}

          {custom === null ? null : (
            <div className="mt-1 space-y-2 border-t border-white/[0.08] p-2">
              <label className="block text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                From
                <input
                  type="date"
                  value={custom.start}
                  onChange={(event) => {
                    setCustom({ ...custom, start: event.target.value });
                  }}
                  className="mt-1 w-full rounded-md border border-white/[0.1] bg-white/[0.04] px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500/60"
                />
              </label>
              <label className="block text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                To
                <input
                  type="date"
                  value={custom.end}
                  onChange={(event) => {
                    setCustom({ ...custom, end: event.target.value });
                  }}
                  className="mt-1 w-full rounded-md border border-white/[0.1] bg-white/[0.04] px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500/60"
                />
              </label>
              <button
                type="button"
                // Guarded rather than left to the server: an inverted range is
                // a 400 that would clear the table for what is really a typo
                // halfway through picking two dates.
                disabled={custom.end < custom.start}
                onClick={() => {
                  onChange({ startDate: custom.start, endDate: custom.end });
                  setCustom(null);
                  close();
                }}
                className="w-full rounded-md bg-blue-500 px-2 py-1.5 text-[11px] font-bold tracking-wider text-white uppercase transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Apply
              </button>
            </div>
          )}
        </div>
      )}
    </ActionMenu>
  );
}

/* -------------------------------------------------------------------------- */
/*  Date dimension                                                            */
/* -------------------------------------------------------------------------- */

export function DimensionMenu({
  value,
  onChange,
}: {
  value: MasterReportDimension;
  onChange: (next: MasterReportDimension) => void;
}) {
  return (
    <ActionMenu
      ariaLabel="Date dimension"
      align="end"
      label={
        <span className="flex items-center gap-1.5">
          <CalendarClock className="size-3.5" aria-hidden="true" />
          {MASTER_REPORT_DIMENSION_LABELS[value]}
        </span>
      }
    >
      {(close) => (
        <div className="w-56 p-1">
          <p className="px-2.5 pt-1 pb-1.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
            Filter by date
          </p>
          {MASTER_REPORT_DIMENSION_ORDER.map((dimension) => (
            <button
              key={dimension}
              type="button"
              onClick={() => {
                onChange(dimension);
                close();
              }}
              className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              {MASTER_REPORT_DIMENSION_LABELS[dimension]}
              {dimension === value ? (
                <Check className="size-3.5 text-blue-400" aria-hidden="true" />
              ) : null}
            </button>
          ))}
          <p className="border-t border-white/[0.08] px-2.5 py-2 text-[10px] leading-relaxed text-zinc-500">
            Decides which date column the range filters. Checkout is settled
            revenue; stay dates match anything overlapping the window.
          </p>
        </div>
      )}
    </ActionMenu>
  );
}

/* -------------------------------------------------------------------------- */
/*  Export                                                                    */
/* -------------------------------------------------------------------------- */

export function ExportMenu({ csvUrl }: { csvUrl: string }) {
  return (
    <ActionMenu
      ariaLabel="Export"
      align="end"
      label={
        <span className="flex items-center gap-1.5">
          <Download className="size-3.5" aria-hidden="true" />
          Export
        </span>
      }
    >
      {(close) => (
        <div className="w-72 p-1">
          <p className="px-2.5 pt-1 pb-1.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
            Download as
          </p>

          {/*
            CSV is the one that works, so it leads.

            It carries exactly the visible columns and the active filters, in
            major-unit money, with the formula-injection guard the report CSV
            writer applies to every cell.
          */}
          <a
            href={csvUrl}
            onClick={close}
            className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <FileText className="size-3.5" aria-hidden="true" />
            CSV (.csv)
          </a>

          <button
            type="button"
            onClick={() => {
              close();
              // Deferred past the menu's own close so the popover is not
              // captured in the printed page.
              setTimeout(() => {
                window.print();
              }, 50);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <Printer className="size-3.5" aria-hidden="true" />
            Print
          </button>

          <div className="mt-1 border-t border-white/[0.08] pt-1">
            {/*
              Three formats the brief asked for, each needing something this
              repository has not taken on. Shown rather than omitted: an
              operator looking for "Excel" should find out why it is not here,
              not conclude the menu is broken.

              Excel and PDF each need a new runtime dependency — a spreadsheet
              writer and a PDF engine — which is a call for the repository to
              make under CLAUDE.md section 6.4, not something to add behind an
              export menu. Tally needs an actual integration: a ledger
              mapping, an XML schema and credentials, none of which exist.
            */}
            <Unavailable
              icon={FileSpreadsheet}
              label="Excel (.xlsx)"
              reason="Needs a spreadsheet library. CSV opens in Excel with the same figures."
            />
            <Unavailable
              icon={FileType2}
              label="PDF (.pdf)"
              reason="Needs a PDF engine. Print produces a PDF through the browser."
            />
            <Unavailable
              icon={Share2}
              label="Sync to Tally"
              reason="Needs a Tally integration: ledger mapping, XML schema and credentials."
            />
          </div>
        </div>
      )}
    </ActionMenu>
  );
}

/** A format that is named, explained, and not offered. */
function Unavailable({
  icon: Icon,
  label,
  reason,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  reason: string;
}) {
  return (
    <span
      title={reason}
      aria-disabled="true"
      className="flex cursor-not-allowed items-start gap-2 px-2.5 py-1.5 text-xs text-zinc-600"
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden={true} />
      <span>
        {label}
        <span className="mt-0.5 block text-[10px] leading-snug text-zinc-700">{reason}</span>
      </span>
    </span>
  );
}
