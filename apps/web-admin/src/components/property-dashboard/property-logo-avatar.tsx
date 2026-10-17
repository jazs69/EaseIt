'use client';

/**
 * The active property's logo, or its initials.
 *
 * ===========================================================================
 * `<img>`, not `next/image`, and that is a correctness choice rather than a
 * shortcut.
 *
 * `next/image` refuses any remote host not listed in `images.remotePatterns`,
 * and throws at request time rather than at build time. This app has no such
 * config, and a logo URL is operator-supplied data — it could point at any CDN
 * a hotel happens to use. Optimising a 36px avatar buys almost nothing;
 * crashing the whole top bar because a property set an unlisted host costs the
 * entire shell. A plain `<img>` degrades to a broken image at worst, and the
 * initials take over when it fails.
 *
 * The initials are the normal case, not a fallback for failure: most
 * properties have never uploaded a logo, and showing "GM" for Grand Marine Goa
 * is a finished state rather than a placeholder for one.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import Link from 'next/link';
import { useState } from 'react';

export interface PropertyLogoAvatarProps {
  hotelId: string | null;
  propertyName: string;
  propertyCode: string;
  logoUrl: string | null;
}

/**
 * Up to two initials from a property name.
 *
 * `Grand Marine Goa` -> `GM`, `Shubh Shaleen Springs` -> `SS`.
 *
 * Indexing is guarded rather than asserted: under `noUncheckedIndexedAccess`
 * a `word[0]` on a name of exotic whitespace is `string | undefined`, and a
 * non-null assertion there would render the literal text "undefined" in the
 * badge the first time a property was named with a stray tab.
 */
export function propertyInitials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');

  // A property named entirely in punctuation still needs a badge.
  return letters.length > 0 ? letters : 'P';
}

export function PropertyLogoAvatar({
  hotelId,
  propertyName,
  propertyCode,
  logoUrl,
}: PropertyLogoAvatarProps) {
  // A logo that 404s falls through to the initials rather than leaving a
  // broken-image glyph in the navigation bar.
  const [logoFailed, setLogoFailed] = useState(false);
  const showLogo = logoUrl !== null && logoUrl.length > 0 && !logoFailed;

  const shell = cn(
    'relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full',
    'border border-white/10 bg-zinc-900 shadow-sm select-none',
    'transition-all hover:ring-2 hover:ring-white/20',
    'focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none',
  );

  const content = showLogo ? (
    /* `next/image` throws at request time for any host absent from
       `images.remotePatterns`, and a logo URL is operator-supplied data.
       Optimising a 36px avatar is not worth crashing the top bar of every
       page; the docblock above has the full reasoning. */
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logoUrl}
      alt=""
      width={36}
      height={36}
      onError={() => {
        setLogoFailed(true);
      }}
      className="size-full bg-zinc-900 object-cover"
    />
  ) : (
    <span className="text-xs font-semibold tracking-wider text-white">
      {propertyInitials(propertyName)}
    </span>
  );

  // The image is `alt=""` because the link already carries the accessible
  // name — otherwise a screen reader announces the property twice.
  const label = `${propertyName} · property settings`;

  if (hotelId === null) {
    // No property in context, so there is nowhere to navigate. Still rendered,
    // so the bar does not change shape, but inert rather than a dead link.
    return (
      <span className={cn(shell, 'cursor-default')} title={propertyName} aria-label={propertyName}>
        {content}
      </span>
    );
  }

  return (
    <Link
      href={`/settings/property-config?hotelId=${encodeURIComponent(hotelId)}`}
      title={`${propertyName} (${propertyCode}) · property settings`}
      aria-label={label}
      className={shell}
    >
      {content}
    </Link>
  );
}
