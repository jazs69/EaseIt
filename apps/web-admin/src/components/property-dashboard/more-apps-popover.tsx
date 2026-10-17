'use client';

/**
 * The "More apps" launcher behind the nine-dot grid.
 *
 * ===========================================================================
 * Three states per tile, and they are deliberately distinguishable.
 *
 *   * **Open** — the module exists for this property and the caller may use
 *     it. A real link, carrying the hotelId over.
 *   * **Locked** — a paid add-on this portfolio has not bought (Shops, Stock).
 *     Amber padlock. Nothing to grant; the answer is a commercial one.
 *   * **Restricted** — the module exists but this person's roles do not reach
 *     it. No padlock, because a padlock here would read as "buy this" when the
 *     real answer is "ask your manager".
 *
 * Collapsing the last two into one grey tile is the easy mistake: a clerk who
 * cannot open Night Audit needs to know whether to raise a purchase order or a
 * permissions request, and a single disabled state answers neither.
 *
 * On the permission check: it reads the **active grant's** roles, not
 * `session.permissions`. That field is resolved for `activePropertyId`, which
 * in this shell is frequently a different property from the one in the URL —
 * a portfolio operator browsing hotel 31336 may have no active property at
 * all. Roles are carried per grant, so they answer the question that is
 * actually being asked: what may this person do *here*.
 *
 * And this is an affordance, not a control. Hiding a tile stops nobody typing
 * the URL; every one of these routes authorises server-side on its own
 * (CLAUDE.md section 3.2). The UI's job is to not offer what will be refused.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import {
  Permission,
  permissionsForRoles,
  type Role,
} from '@repo/types';
import {
  Activity,
  Boxes,
  CreditCard,
  FileText,
  Lock,
  Moon,
  Settings,
  ShoppingBag,
  Wallet,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef } from 'react';

interface AppItem {
  id: string;
  name: string;
  icon: LucideIcon;
  /** Omitted for an add-on that cannot be opened at all. */
  href?: string;
  /** A paid module this portfolio does not have. */
  isLocked?: boolean;
  /** Required to open it; absent means any grant at the property will do. */
  requiredPermission?: Permission;
}

const APPS: readonly AppItem[] = [
  { id: 'reports', name: 'Reports', icon: FileText, href: '/reports/property-reports' },
  { id: 'shops', name: 'Shops', icon: ShoppingBag, isLocked: true },
  { id: 'direct-billing', name: 'Direct billing', icon: Wallet, href: '/direct-billing' },
  { id: 'payments', name: 'Payment', icon: CreditCard, href: '/payments' },
  { id: 'revenue', name: 'Revenue', icon: Activity, href: '/revenue' },
  { id: 'stock', name: 'Stock', icon: Boxes, isLocked: true },
  {
    id: 'night-audit',
    name: 'Night Audit',
    icon: Moon,
    href: '/night-audit',
    // The real permission string from the catalogue, not a hand-typed copy —
    // renaming it there is then a compile error here rather than a tile that
    // silently stops gating.
    requiredPermission: Permission.NIGHT_AUDIT_READ,
  },
  {
    id: 'property-config',
    name: 'Property Config',
    icon: Settings,
    href: '/settings/property-config',
  },
];

export interface MoreAppsPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * The property to carry over, resolved by the top bar.
   *
   * A prop rather than a second `useSearchParams()` read: the bar has already
   * matched the URL against the caller's grants, so this is the *authorised*
   * property rather than whatever the address bar claims. Null means no
   * property context, and every scoped tile goes quiet rather than linking to
   * a guessed default — sending someone to a hotel they hold no grant at just
   * bounces them through an authorisation failure.
   */
  hotelId: string | null;
  /** Roles held at that property, for the permission-gated tiles. */
  roles: readonly Role[];
}

export function MoreAppsPopover({ isOpen, onClose, hotelId, roles }: MoreAppsPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes. Subscribing to a browser event is what effects are for, and
  // the listener is torn down with the popover rather than leaking.
  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const granted = permissionsForRoles(roles);

  return (
    <>
      {/* Click-away as a transparent sibling rather than a document listener:
          no global handler to leak, and it cannot swallow keyboard focus. */}
      <button
        type="button"
        aria-label="Close app launcher"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-label="More apps"
        className={cn(
          'absolute right-0 z-50 mt-2 w-80 rounded-2xl p-5',
          'border border-white/10 bg-[#0f141f]/95 shadow-2xl backdrop-blur-xl',
        )}
      >
        <h2 className="mb-4 text-xs font-semibold tracking-wider text-zinc-400 uppercase">
          More apps
        </h2>

        <div className="grid grid-cols-3 gap-x-4 gap-y-5">
          {APPS.map((app) => {
            const Icon = app.icon;

            const restricted =
              app.requiredPermission !== undefined &&
              !granted.includes(app.requiredPermission);
            // A property-scoped destination with no property is as unusable as
            // one that is locked, and silently linking nowhere is worse.
            const unavailable = app.href === undefined || hotelId === null;
            const disabled = app.isLocked === true || restricted || unavailable;

            const tile = (
              <>
                <span className="relative">
                  <span
                    className={cn(
                      'flex size-12 items-center justify-center rounded-xl border transition',
                      disabled
                        ? 'border-white/[0.06] bg-zinc-800/40 text-zinc-500'
                        : 'border-white/[0.08] bg-zinc-800/60 text-zinc-200 group-hover:border-blue-500/40 group-hover:text-blue-400',
                    )}
                  >
                    <Icon className="size-5" aria-hidden="true" />
                  </span>

                  {app.isLocked === true ? (
                    <span
                      aria-hidden="true"
                      className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/20 text-amber-400"
                    >
                      <Lock className="size-2.5" />
                    </span>
                  ) : null}
                </span>

                <span
                  className={cn(
                    'mt-2 text-center text-xs',
                    disabled ? 'text-zinc-500' : 'font-medium text-zinc-300',
                  )}
                >
                  {app.name}
                </span>
              </>
            );

            // Why it cannot be opened, said plainly on hover. The three
            // reasons get three different sentences.
            const reason = app.isLocked === true
              ? `${app.name} is an add-on module. Talk to your account manager to enable it.`
              : restricted
                ? `${app.name} needs night audit access. Ask a property admin to grant it.`
                : unavailable
                  ? `${app.name} needs a property in context.`
                  : app.name;

            if (disabled) {
              return (
                <button
                  key={app.id}
                  type="button"
                  disabled
                  title={reason}
                  aria-label={reason}
                  className="group flex cursor-not-allowed flex-col items-center opacity-60"
                >
                  {tile}
                </button>
              );
            }

            return (
              <Link
                key={app.id}
                href={`${app.href ?? ''}?hotelId=${encodeURIComponent(hotelId ?? '')}`}
                title={app.name}
                onClick={onClose}
                className="group flex flex-col items-center"
              >
                {tile}
              </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}
