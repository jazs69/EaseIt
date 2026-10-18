'use client';

/**
 * The account popover, anchored under the property avatar.
 *
 * ===========================================================================
 * Identity on the left, the two things you can do with it on the right.
 *
 * The header block identifies the **property** — its badge, name, hotel id and
 * contact address — because that is what a clerk needs to confirm before
 * acting: which hotel am I working in. The signed-in staff member is named
 * beneath it, separately, because on a shared front-desk terminal those two
 * are rarely the same person and conflating them is how somebody posts a
 * charge at the wrong hotel.
 *
 * Dismissal matches `MoreAppsPopover` exactly — Escape via a listener torn
 * down with the popover, click-away as a transparent sibling rather than a
 * document handler. Two popovers in the same bar behaving differently is its
 * own small bug.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import { Building2, Loader2, LogOut } from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';

import { useSignOut } from '@/hooks/use-sign-out';
import { PropertyBadge } from './property-logo-avatar';

export interface AccountPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  hotelId: string | null;
  propertyName: string;
  propertyCode: string;
  propertyEmail: string | null;
  logoUrl: string | null;
  /** The signed-in staff member, who is not the property. */
  userName: string;
  userEmail: string;
}

export function AccountPopover({
  isOpen,
  onClose,
  hotelId,
  propertyName,
  propertyCode,
  propertyEmail,
  logoUrl,
  userName,
  userEmail,
}: AccountPopoverProps) {
  const { signingOut, signOutNow } = useSignOut();

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      // Not while the request is in flight: closing mid-sign-out would hide
      // the only indication that anything is happening.
      if (event.key === 'Escape' && !signingOut) onClose();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, onClose, signingOut]);

  if (!isOpen) return null;

  return (
    <>
      <button
        type="button"
        aria-label="Close account menu"
        onClick={() => {
          if (!signingOut) onClose();
        }}
        className="fixed inset-0 z-40 cursor-default"
      />

      <div
        role="dialog"
        aria-label="Account"
        className={cn(
          'absolute right-0 z-50 mt-2 w-[19rem] rounded-2xl p-4',
          'border border-white/10 bg-[#0f141f]/95 shadow-2xl backdrop-blur-xl',
        )}
      >
        {/* Property identity */}
        <div className="flex items-start gap-3">
          <PropertyBadge
            propertyName={propertyName}
            logoUrl={logoUrl}
            size="lg"
            className="rounded-xl border-0 bg-blue-500/15 text-blue-300"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white" title={propertyName}>
              {propertyName}
            </p>
            {propertyCode === '' ? null : (
              <p className="tabular mt-0.5 text-[11px] text-zinc-500">
                Hotel ID: {propertyCode}
              </p>
            )}
            {propertyEmail === null || propertyEmail === '' ? null : (
              // `title` carries the full address, because a hotel's contact
              // mailbox is routinely longer than this column.
              <p className="mt-0.5 truncate text-[11px] text-zinc-500" title={propertyEmail}>
                {propertyEmail}
              </p>
            )}
          </div>
        </div>

        {/* Who is actually signed in. Distinct from the hotel above it. */}
        <div className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
          <p className="text-[9px] font-semibold tracking-wider text-zinc-600 uppercase">
            Signed in as
          </p>
          <p className="mt-0.5 truncate text-[11px] text-zinc-300" title={userEmail}>
            {userName === '' ? userEmail : `${userName} · ${userEmail}`}
          </p>
        </div>

        <div className="my-3 border-t border-white/[0.08]" />

        {/* All hotels */}
        <Link
          href="/group-dashboard"
          onClick={onClose}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs text-zinc-200 transition-colors hover:bg-white/[0.06]"
        >
          <Building2 className="size-4 shrink-0 text-zinc-400" aria-hidden="true" />
          All hotels
        </Link>

        {/* Sign out */}
        <button
          type="button"
          disabled={signingOut}
          onClick={() => {
            void signOutNow();
          }}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs text-zinc-400 transition-colors hover:bg-rose-500/10 hover:text-rose-300 disabled:cursor-wait disabled:opacity-60"
        >
          {signingOut ? (
            <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
          ) : (
            <LogOut className="size-4 shrink-0" aria-hidden="true" />
          )}
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>

        {hotelId === null ? null : (
          <Link
            href={`/settings/property-config?hotelId=${encodeURIComponent(hotelId)}`}
            onClick={onClose}
            className="mt-1 block px-2.5 text-[10px] text-zinc-600 transition-colors hover:text-zinc-400"
          >
            Property settings
          </Link>
        )}
      </div>
    </>
  );
}
