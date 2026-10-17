/**
 * Shared visual atoms for the landing page.
 *
 * These exist so the dark-glass treatment is defined once: a 1px frosted
 * border plus a near-transparent white fill. Repeating those class strings
 * across eight sections is how a design drifts.
 */

import { cn } from '@repo/ui';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/* -------------------------------------------------------------------------- */
/*  Glass surfaces                                                            */
/* -------------------------------------------------------------------------- */

export interface GlassPanelProps {
  children: ReactNode;
  className?: string;
  /** Lift the border to blue on hover. For interactive cards only. */
  interactive?: boolean;
}

export function GlassPanel({ children, className, interactive = false }: GlassPanelProps) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-white/[0.08] bg-white/[0.02] backdrop-blur-md',
        interactive &&
          'transition-colors duration-300 hover:border-blue-500/30 hover:bg-white/[0.04]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Pills                                                                     */
/* -------------------------------------------------------------------------- */

export interface PillProps {
  children: ReactNode;
  className?: string;
  icon?: LucideIcon;
}

export function Pill({ children, className, icon: Icon }: PillProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03]',
        'px-3 py-1 text-xs font-medium text-zinc-300 backdrop-blur-md',
        className,
      )}
    >
      {Icon ? <Icon className="size-3.5 shrink-0" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/** A metric pill: emphasised value, muted label. */
export interface StatPillProps {
  value: string;
  label: string;
  icon?: LucideIcon;
}

export function StatPill({ value, label, icon: Icon }: StatPillProps) {
  return (
    <div className="inline-flex items-center gap-2.5 rounded-full border border-white/[0.08] bg-white/[0.02] px-4 py-2 backdrop-blur-md">
      {Icon ? <Icon className="size-4 shrink-0 text-blue-400" aria-hidden="true" /> : null}
      <span className="tabular text-sm font-semibold text-white">{value}</span>
      <span className="text-sm text-zinc-500">{label}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Typography                                                                */
/* -------------------------------------------------------------------------- */

export interface GradientTextProps {
  children: ReactNode;
  className?: string;
}

/** Electric-blue gradient accent. Used on one or two words, never a sentence. */
export function GradientText({ children, className }: GradientTextProps) {
  return (
    <span
      className={cn(
        'bg-gradient-to-r from-sky-300 via-blue-400 to-indigo-400 bg-clip-text text-transparent',
        className,
      )}
    >
      {children}
    </span>
  );
}

export interface SectionHeadingProps {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  className?: string;
  align?: 'left' | 'center';
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  className,
  align = 'center',
}: SectionHeadingProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-4',
        align === 'center' ? 'items-center text-center' : 'items-start text-left',
        className,
      )}
    >
      {eyebrow ? (
        <span className="text-xs font-semibold tracking-[0.2em] text-blue-400 uppercase">
          {eyebrow}
        </span>
      ) : null}
      <h2 className="max-w-3xl text-3xl font-semibold tracking-tight text-balance text-white sm:text-4xl">
        {title}
      </h2>
      {description ? (
        <p
          className={cn(
            'max-w-2xl text-base leading-relaxed text-zinc-400',
            align === 'center' && 'mx-auto',
          )}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Ambient background                                                        */
/* -------------------------------------------------------------------------- */

export interface AmbientGlowProps {
  /** CSS position of the glow centre, e.g. "50% 30%". */
  at?: string;
  /** Tailwind colour channels as `r g b`. Defaults to blue-500. */
  rgb?: string;
  opacity?: number;
  className?: string;
}

/**
 * A soft radial wash behind a section. Decorative only, so it is
 * `aria-hidden` and never intercepts pointer events.
 */
export function AmbientGlow({
  at = '50% 30%',
  rgb = '59 130 246',
  opacity = 0.18,
  className,
}: AmbientGlowProps) {
  return (
    <div
      aria-hidden="true"
      className={cn('pointer-events-none absolute inset-0 -z-10', className)}
      style={{
        backgroundImage: `radial-gradient(circle at ${at}, rgb(${rgb} / ${String(opacity)}), transparent 70%)`,
      }}
    />
  );
}

/** A 1px hairline that fades out at both ends. Used between sections. */
export function HairlineDivider({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'h-px w-full bg-gradient-to-r from-transparent via-white/[0.08] to-transparent',
        className,
      )}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Buttons                                                                   */
/* -------------------------------------------------------------------------- */

export interface CtaButtonProps {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
  icon?: LucideIcon;
  /** Place the icon after the label. Defaults to before. */
  iconTrailing?: boolean;
  className?: string;
}

/**
 * Anchor-based so it works in a server component with no client JS.
 * The primary variant carries a soft glow ring rather than a drop shadow —
 * shadows read as muddy grey on a pitch-black ground.
 */
export function CtaButton({
  href,
  children,
  variant = 'primary',
  icon: Icon,
  iconTrailing = false,
  className,
}: CtaButtonProps) {
  const base =
    'group inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-all duration-300';

  const variants: Record<'primary' | 'secondary', string> = {
    primary:
      'bg-white text-zinc-950 ring-2 ring-blue-500/0 hover:ring-blue-500/40 hover:shadow-[0_0_32px_-4px_rgba(59,130,246,0.55)]',
    secondary:
      'border border-white/[0.12] bg-white/[0.03] text-white backdrop-blur-md hover:border-white/25 hover:bg-white/[0.07]',
  };

  const iconNode = Icon ? <Icon className="size-4 shrink-0" aria-hidden="true" /> : null;

  return (
    <a href={href} className={cn(base, variants[variant], className)}>
      {!iconTrailing && iconNode}
      {children}
      {iconTrailing && iconNode}
    </a>
  );
}
