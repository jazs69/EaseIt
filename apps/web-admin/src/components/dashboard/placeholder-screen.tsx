import type { ComponentType } from 'react';
import { Construction } from 'lucide-react';

/**
 * A named screen that does not exist yet.
 *
 * Exists so that a sidebar link never leads to a 404, and so the reason it is
 * empty is stated on the screen rather than discovered by reading the backlog.
 * Deliberately shows no fake data: a chart of invented occupancy is worse than
 * an empty page, because somebody will eventually quote it.
 */

export interface PlaceholderScreenProps {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  title: string;
  summary: string;
  /** What has to be built first, and why it blocks this. */
  blockedBy: string;
}

export function PlaceholderScreen({
  icon: Icon,
  title,
  summary,
  blockedBy,
}: PlaceholderScreenProps) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-10 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-white">
          <Icon className="size-5 text-zinc-500" aria-hidden="true" />
          {title}
        </h1>
        <p className="text-sm text-zinc-500">{summary}</p>
      </header>

      <div className="flex items-start gap-3 rounded-xl border border-amber-400/20 bg-amber-500/[0.05] px-4 py-3.5">
        <Construction className="mt-0.5 size-4 shrink-0 text-amber-400" aria-hidden="true" />
        <div className="flex flex-col gap-1 text-xs leading-relaxed">
          <span className="font-medium text-amber-200">Not built yet.</span>
          <span className="text-amber-200/70">{blockedBy}</span>
        </div>
      </div>
    </main>
  );
}
