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
import { useState } from 'react';

import { AccountPopover } from './account-popover';

export interface PropertyLogoAvatarProps {
  hotelId: string | null;
  propertyName: string;
  propertyCode: string;
  /** The hotel's own contact address, shown under its name in the popover. */
  propertyEmail: string | null;
  logoUrl: string | null;
  /** The signed-in staff member, named separately from the property. */
  userName: string;
  userEmail: string;
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

/**
 * The badge itself: a logo, or the initials.
 *
 * Extracted so the navbar trigger and the account popover's header render the
 * same mark at two sizes rather than each drawing its own. The popover header
 * is a rounded rectangle and the trigger a circle, which is a `className`
 * override rather than a second component.
 */
export function PropertyBadge({
  propertyName,
  logoUrl,
  size = 'md',
  className,
}: {
  propertyName: string;
  logoUrl: string | null;
  size?: 'md' | 'lg';
  className?: string | undefined;
}) {
  // A logo that 404s falls through to the initials rather than leaving a
  // broken-image glyph in the navigation bar.
  const [logoFailed, setLogoFailed] = useState(false);
  const showLogo = logoUrl !== null && logoUrl.length > 0 && !logoFailed;
  const pixels = size === 'lg' ? 48 : 36;

  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full',
        'border border-white/10 bg-zinc-900 select-none',
        size === 'lg' ? 'size-12' : 'size-9',
        className,
      )}
    >
      {showLogo ? (
        /* `next/image` throws at request time for any host absent from
           `images.remotePatterns`, and a logo URL is operator-supplied data.
           Optimising a small avatar is not worth crashing the top bar of every
           page; the docblock above has the full reasoning. */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt=""
          width={pixels}
          height={pixels}
          onError={() => {
            setLogoFailed(true);
          }}
          className="size-full bg-zinc-900 object-cover"
        />
      ) : (
        <span
          className={cn(
            'font-semibold tracking-wider',
            size === 'lg' ? 'text-base' : 'text-xs text-white',
          )}
        >
          {propertyInitials(propertyName)}
        </span>
      )}
    </span>
  );
}

/**
 * The navbar trigger: the property badge, opening the account popover.
 *
 * It used to be a `Link` straight to property settings. A single-destination
 * avatar is a reasonable thing, but it left the two actions an operator most
 * needs from a top bar — move between hotels, and sign out — reachable only
 * from the group sidebar, which a property screen does not show. Settings is
 * still one click away, inside the popover.
 */
export function PropertyLogoAvatar({
  hotelId,
  propertyName,
  propertyCode,
  propertyEmail,
  logoUrl,
  userName,
  userEmail,
}: PropertyLogoAvatarProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          setOpen((current) => !current);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${propertyName} · account menu`}
        title={propertyCode === '' ? propertyName : `${propertyName} (${propertyCode})`}
        className={cn(
          'flex rounded-full transition-all',
          'hover:ring-2 hover:ring-white/20',
          'focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none',
          open && 'ring-2 ring-white/25',
        )}
      >
        {/* `alt=""` on the image inside: the button already carries the
            accessible name, and announcing the property twice is noise. */}
        <PropertyBadge propertyName={propertyName} logoUrl={logoUrl} />
      </button>

      <AccountPopover
        isOpen={open}
        onClose={() => {
          setOpen(false);
        }}
        hotelId={hotelId}
        propertyName={propertyName}
        propertyCode={propertyCode}
        propertyEmail={propertyEmail}
        logoUrl={logoUrl}
        userName={userName}
        userEmail={userEmail}
      />
    </div>
  );
}
