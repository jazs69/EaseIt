'use client';

/**
 * The night-audit console (NA-07).
 *
 * ===========================================================================
 * Enqueue and watch -- never run. Pressing the button asks the API to create
 * tonight's run and put it on the queue; the worker executes it step by step
 * (CLAUDE.md section 3.3). This screen then polls the overview while a run is
 * pending or running, so each of the eight steps turns green as it commits.
 *
 * A run that stays PENDING means no worker is draining the queue, and the
 * screen says so rather than spinning forever with no explanation.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import { CheckCircle2, CircleDashed, Loader2, Moon, Play, TriangleAlert, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { NightAuditOverview, NightAuditRunView, NightAuditStepView } from '@repo/types';

import { fetchNightAuditOverview, startNightAudit } from '@/lib/properties-client';

const POLL_MS = 3_000;
/** How long a PENDING run may wait before the screen says no worker is draining. */
const WORKER_HINT_AFTER_MS = 20_000;

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatInstant(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function money(minor: unknown): string {
  return typeof minor === 'number'
    ? (minor / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR' })
    : '—';
}

/** One line of what a step did, from its recorded outcome. */
function summarise(step: NightAuditStepView): string | null {
  const o = step.outcome;
  if (o === null) return null;
  if (typeof o['error'] === 'string') return o['error'];
  switch (step.step) {
    case 1:
      return `${String(o['inHouse'] ?? 0)} in house`;
    case 2:
      return `${String(o['rolled'] ?? 0)} no-show(s), ${String(o['nightsReleased'] ?? 0)} night(s) released`;
    case 3: {
      const overstays = Array.isArray(o['overstays']) ? o['overstays'].length : 0;
      return (
        `${String(o['posted'] ?? 0)} night(s) posted (${money(o['postedRoomMinor'])} + ${money(o['postedTaxMinor'])} tax), ` +
        `${String(o['alreadyPosted'] ?? 0)} already posted` +
        (overstays > 0 ? `, ${String(overstays)} overstay(s) not charged` : '')
      );
    }
    case 4:
      return typeof o['note'] === 'string' ? o['note'] : null;
    case 5: {
      const exceptions = Array.isArray(o['exceptions']) ? o['exceptions'].length : 0;
      return `${String(o['closed'] ?? 0)} folio(s) closed, ${String(exceptions)} not settled`;
    }
    case 6:
      return (
        `${String(o['roomsSold'] ?? 0)}/${String(o['roomsAvailable'] ?? 0)} rooms sold, ` +
        `revenue ${money(o['roomRevenueMinor'])}, ADR ${money(o['adrMinor'])}`
      );
    case 7:
      return typeof o['to'] === 'string' ? `Business date → ${formatDate(o['to'])}` : null;
    case 8:
      return 'Completion event queued';
    default:
      return null;
  }
}

/** Folios step 5 could not close, so a person can follow up in the morning. */
function exceptionsOf(step: NightAuditStepView): { bookingCode: string; balanceMinor: number }[] {
  const list = step.outcome?.['exceptions'];
  return Array.isArray(list)
    ? list.filter(
        (entry): entry is { bookingCode: string; balanceMinor: number } =>
          typeof entry === 'object' && entry !== null && 'bookingCode' in entry,
      )
    : [];
}

function StepRow({ step }: { step: NightAuditStepView }) {
  const Icon =
    step.status === 'COMPLETED' ? CheckCircle2 : step.status === 'FAILED' ? XCircle : CircleDashed;
  const summary = summarise(step);
  const exceptions = step.step === 5 ? exceptionsOf(step) : [];
  return (
    <li className="flex items-start gap-3 py-2">
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          step.status === 'COMPLETED' && 'text-emerald-400',
          step.status === 'FAILED' && 'text-rose-400',
          step.status === 'NOT_STARTED' && 'text-zinc-600',
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-zinc-200">
          {step.step}. {step.label}
          <span className="sr-only"> — {step.status}</span>
        </p>
        {summary === null ? null : (
          <p className={cn('mt-0.5 text-[11px]', step.status === 'FAILED' ? 'text-rose-300' : 'text-zinc-500')}>
            {summary}
          </p>
        )}
        {exceptions.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-amber-300">
            {exceptions.map((entry) => (
              <li key={entry.bookingCode}>
                {entry.bookingCode}: {entry.balanceMinor > 0 ? 'owes' : 'in credit'} {money(Math.abs(entry.balanceMinor))}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

function RunCard({ run, waitingTooLong }: { run: NightAuditRunView; waitingTooLong: boolean }) {
  const tone =
    run.status === 'COMPLETED'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
      : run.status === 'FAILED'
        ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
        : 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  return (
    <section className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-100">Business date {formatDate(run.businessDate)}</h2>
        <span className={cn('rounded-md border px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase', tone)}>
          {run.status}
        </span>
      </header>
      <p className="mt-1 text-[11px] text-zinc-500">
        Requested {formatInstant(run.createdAt)} · finished {formatInstant(run.completedAt)}
      </p>
      {run.lastError !== null && run.status === 'FAILED' ? (
        <p role="alert" className="mt-2 rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2 text-[11px] text-rose-200">
          {run.lastError} Fix the cause, then run the audit again — it resumes from this step.
        </p>
      ) : null}
      {waitingTooLong ? (
        <p className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-[11px] text-amber-200">
          Queued but not started. The audit runs in the worker process (<code>pnpm worker:dev</code>), which needs
          Redis; nothing is draining the queue right now.
        </p>
      ) : null}
      <ol className="mt-2 divide-y divide-white/[0.04]">
        {run.steps.map((step) => (
          <StepRow key={step.step} step={step} />
        ))}
      </ol>
    </section>
  );
}

export function NightAuditScreen({
  hotelId,
  initial,
}: {
  hotelId: string;
  initial: NightAuditOverview;
}) {
  const [overview, setOverview] = useState(initial);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const active = overview.runs.some((run) => run.status === 'PENDING' || run.status === 'RUNNING');
  const todays = overview.runs.find((run) => run.businessDate === overview.businessDate) ?? null;

  const refresh = useCallback(async () => {
    try {
      setOverview(await fetchNightAuditOverview(hotelId));
      setNow(Date.now());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The audit status could not be loaded.');
    }
  }, [hotelId]);

  // Poll only while something is in flight.
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [active, refresh]);

  async function start(): Promise<void> {
    setStarting(true);
    setError(null);
    try {
      await startNightAudit(hotelId);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The audit could not be queued.');
    } finally {
      setStarting(false);
    }
  }

  const canStart = todays === null || todays.status === 'FAILED';

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
        <div className="flex items-center gap-3">
          <Moon className="size-5 text-indigo-300" aria-hidden="true" />
          <div>
            <p className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">Open business date</p>
            <p className="text-base font-semibold text-zinc-100">{formatDate(overview.businessDate)}</p>
            <p className="text-[11px] text-zinc-500">Timezone {overview.timezone}</p>
          </div>
        </div>
        <button
          type="button"
          disabled={!canStart || starting}
          onClick={() => {
            void start();
          }}
          title={canStart ? undefined : 'This business date already has a run'}
          className="flex items-center gap-1.5 rounded-lg bg-indigo-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {starting ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Play className="size-3.5" aria-hidden="true" />}
          {todays?.status === 'FAILED' ? 'Resume night audit' : 'Run night audit'}
        </button>
      </section>

      <p className="flex items-start gap-2 text-[11px] text-zinc-500">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-400" aria-hidden="true" />
        The audit closes {formatDate(overview.businessDate)}: unarrived guests become no-shows, tonight&apos;s room
        charges post, settled folios close, the day&apos;s figures are frozen and the business date moves forward.
        It cannot be undone.
      </p>

      {error !== null ? (
        <p role="alert" className="rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2 text-[11px] text-rose-200">
          {error}
        </p>
      ) : null}

      {overview.runs.length === 0 ? (
        <p className="text-xs text-zinc-500">No night audit has run at this property yet.</p>
      ) : (
        overview.runs.map((run) => (
          <RunCard
            key={run.id}
            run={run}
            waitingTooLong={run.status === 'PENDING' && now - Date.parse(run.createdAt) > WORKER_HINT_AFTER_MS}
          />
        ))
      )}
    </div>
  );
}
