'use client';

/**
 * Shared presentational pieces for the group dashboard: the property badge and
 * the status pill. Both are used by the list and the grid, which is the only
 * reason they are not inline.
 */

import { cn } from '@repo/ui';
import { PROPERTY_STATUS_LABELS, type PropertyStatus } from '@repo/types';

/* -------------------------------------------------------------------------- */
/*  Status pill                                                               */
/* -------------------------------------------------------------------------- */

const STATUS_STYLE: Record<PropertyStatus, { dot: string; text: string; ring: string }> = {
  ACTIVE: { dot: 'bg-emerald-400', text: 'text-emerald-300', ring: 'border-emerald-400/25 bg-emerald-500/[0.08]' },
  ONBOARDING: { dot: 'bg-amber-400', text: 'text-amber-300', ring: 'border-amber-400/25 bg-amber-500/[0.08]' },
  INACTIVE: { dot: 'bg-zinc-500', text: 'text-zinc-400', ring: 'border-white/[0.08] bg-white/[0.03]' },
};

export function StatusPill({ status }: { status: PropertyStatus }) {
  const style = STATUS_STYLE[status];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        style.ring,
        style.text,
      )}
    >
      {/* Decorative: the label beside it already carries the meaning, so the
          dot must not be announced twice. */}
      <span className={cn('size-1.5 rounded-full', style.dot)} aria-hidden="true" />
      {PROPERTY_STATUS_LABELS[status]}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Property badge                                                            */
/* -------------------------------------------------------------------------- */

/** Deterministic tint per property, so a hotel keeps the same colour. */
const TINTS = [
  'from-sky-500/30 to-blue-600/30 text-sky-200',
  'from-violet-500/30 to-indigo-600/30 text-violet-200',
  'from-emerald-500/30 to-teal-600/30 text-emerald-200',
  'from-amber-500/30 to-orange-600/30 text-amber-200',
  'from-rose-500/30 to-pink-600/30 text-rose-200',
  'from-cyan-500/30 to-sky-600/30 text-cyan-200',
] as const;

function tintFor(key: string): string {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  }
  return TINTS[Math.abs(hash) % TINTS.length] ?? TINTS[0];
}

/** Two initials from a property name: "Grand Marine Goa" -> "GM". */
function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase();
  return `${(words[0] ?? '')[0] ?? ''}${(words[1] ?? '')[0] ?? ''}`.toUpperCase();
}

export interface PropertyBadgeProps {
  name: string;
  logoUrl: string | null;
  className?: string;
}

/**
 * The property's logo, or its initials.
 *
 * Initials are the *default*, not an error path: most properties in a real
 * portfolio never get a logo uploaded, so a broken-image icon would be the
 * normal appearance. A plain `<img>` rather than `next/image` because the URL
 * is operator-supplied and arbitrary — configuring remote patterns for every
 * host a hotel might use is not workable, and these are 40px avatars where the
 * optimiser earns nothing.
 */
export function PropertyBadge({ name, logoUrl, className }: PropertyBadgeProps) {
  const tint = tintFor(name);

  if (logoUrl !== null && logoUrl.length > 0) {
    /*
     * A plain <img>, not next/image: the URL is operator-supplied and may be on
     * any host, and `next/image` requires every such host to be declared in
     * `remotePatterns` up front — not knowable for a field hotels fill in
     * themselves. At 40px there is nothing for the optimiser to win either.
     */
    return (
      // eslint-disable-next-line @next/next/no-img-element -- see the note above
      <img
        src={logoUrl}
        alt=""
        className={cn(
          'size-10 shrink-0 rounded-lg border border-white/[0.08] object-cover',
          className,
        )}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-10 shrink-0 place-items-center rounded-lg border border-white/[0.08] bg-gradient-to-br text-xs font-semibold',
        tint,
        className,
      )}
    >
      {initialsFor(name)}
    </span>
  );
}
