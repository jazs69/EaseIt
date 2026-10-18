'use client';

/**
 * The operations top bar — the whole property shell's navigation.
 *
 * ===========================================================================
 * Rendered by `(property)/layout.tsx`, so it is present and **does not
 * remount** on every property screen.
 *
 * That is the reason it takes only the session. It used to take the
 * server-fetched property, which forced it to live inside each page: a layout
 * cannot read search params, so it could not resolve which hotel was on
 * screen. Driving the name off `session.grants` instead removes that coupling
 * — the grants already carry every property's id, code and name — and a
 * client component inside the layout *can* read search params. The bar now
 * survives navigation between `/property-dashboard` and `/calendar`, which is
 * what makes the active-state highlight meaningful rather than decorative.
 *
 * Property views use a top bar rather than the group dashboard's left rail,
 * because the front desk works in one property for a whole shift: the rail's
 * job is choosing between hotels, which is done by the time anyone is here.
 *
 * Note the button labels: the reference calls the AI action "flexi AI", which
 * is Stayflexi's product name. Using a competitor's trademark on our own
 * toolbar is not something to ship, so it reads "EaseIt AI".
 *
 * Controls with no backend yet are `disabled` rather than live-but-inert. A
 * search box that accepts typing and does nothing is worse than one that
 * visibly cannot be used, and each carries a `title` saying what it waits on.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import type { PropertyGrant, Session } from '@repo/types';
import {
  BrushCleaning,
  CalendarRange,
  Check,
  ChevronDown,
  CircleQuestionMark,
  Grip,
  LayoutGrid,
  SlidersHorizontal,
  Sparkles,
  Star,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';

import { MoreAppsPopover } from './more-apps-popover';
import { PropertyLogoAvatar } from './property-logo-avatar';
import { OmnibarSearch } from './omnibar-search';

export interface OpsTopBarProps {
  session: Session;
}

/**
 * The icon row beside the brand mark.
 *
 * `scoped` marks a destination belonging to *one* property, which therefore
 * carries the hotelId over so the screen opens on the hotel already in view.
 *
 * Both live entries are property-scoped on purpose. The row previously held a
 * "Group calendar" link and two more pointing at `/group-dashboard` — three
 * portfolio destinations inside a property shell, which is both the thing this
 * refactor removes and, in two of the three cases, the same destination behind
 * different glyphs.
 *
 * Housekeeping and Favourites are `disabled` rather than repointed: there is
 * no property-level housekeeping board yet, and sending them back to a group
 * screen is exactly what a property-level view must not do.
 */
const QUICK_LINKS = [
  {
    href: '/property-dashboard',
    label: 'Property dashboard',
    icon: LayoutGrid,
    scoped: true,
    ready: true,
  },
  {
    href: '/calendar',
    label: 'Reservation calendar',
    icon: CalendarRange,
    scoped: true,
    ready: true,
  },
  {
    href: '/rates-inventory',
    label: 'Rates & Inventory',
    /**
     * Sliders, not a currency glyph.
     *
     * This screen is yield management — rack rates, stop-sells and minimum
     * stay restrictions pushed to the channels. A rupee sign would read as
     * "money" and collide with the folio and payment icons that land later;
     * sliders say "adjust the levers", which is what the screen does. It is
     * also the one glyph in this row with no horizontal-bar sibling, so it
     * stays distinguishable at 18px.
     */
    icon: SlidersHorizontal,
    ariaLabel: 'Rates and Inventory Management',
    scoped: true,
    ready: true,
  },
  {
    href: '/housekeeping',
    label: 'Housekeeping',
    icon: BrushCleaning,
    scoped: true,
    ready: false,
  },
  { href: '/favourites', label: 'Favourites', icon: Star, scoped: true, ready: false },
] as const;

/**
 * Which property the shell is currently showing.
 *
 * ===========================================================================
 * Matched against the caller's **own grants**, which is what makes reading the
 * URL safe here.
 *
 * `hotelId` is a client-supplied query parameter, so it is never authority for
 * anything (CLAUDE.md section 3.2). It is used only to *select* among
 * properties the session already proves access to — an id for a property the
 * user holds no grant at matches nothing and falls through to the session's
 * active property. So the worst a tampered URL achieves is a mislabelled
 * header; the page's own data is fetched and authorised server-side
 * independently.
 *
 * Accepts either a code or a uuid because both appear in `?hotelId=` across
 * the app, and the API resolves either.
 * ===========================================================================
 */
function resolveActiveGrant(session: Session, hotelId: string | null): PropertyGrant | null {
  if (hotelId !== null && hotelId.length > 0) {
    const match = session.grants.find(
      (grant) => grant.propertyCode === hotelId || grant.propertyId === hotelId,
    );
    if (match !== undefined) return match;
  }

  if (session.activePropertyId !== null) {
    const active = session.grants.find(
      (grant) => grant.propertyId === session.activePropertyId,
    );
    if (active !== undefined) return active;
  }

  return session.grants[0] ?? null;
}

export function OpsTopBar({ session }: OpsTopBarProps) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);

  // Stable, because `MoreAppsPopover` lists it as an effect dependency for its
  // Escape listener — an inline arrow would tear that listener down and
  // re-attach it on every render of this bar.
  const closeApps = useCallback(() => {
    setAppsOpen(false);
  }, []);

  const active = resolveActiveGrant(session, searchParams.get('hotelId'));
  const hotelId = active?.propertyCode ?? null;

  /**
   * Switching property is for portfolio operators only.
   *
   * `isPortfolioUser` is the API's own answer to "holds SUPER_ADMIN somewhere",
   * computed server-side from the grant rows — not re-derived here from a role
   * string the client could be wrong about. Property staff see the name as
   * plain text: a front desk clerk with one hotel has nothing to switch to,
   * and a dropdown that only ever shows the current row is an affordance that
   * lies about what it does.
   *
   * The grant count is checked too, so a portfolio operator who happens to
   * hold exactly one property also gets plain text rather than a
   * single-entry menu.
   */
  const canSwitchProperty = session.isPortfolioUser && session.grants.length > 1;

  /**
   * The brand mark points at this property's own dashboard.
   *
   * With no property context at all it falls back to `/group-dashboard` rather
   * than to an invented hotelId — sending someone to a property they may hold
   * no grant at would bounce them through an authorisation failure to reach
   * the same place.
   */
  const brandHref =
    hotelId === null
      ? '/group-dashboard'
      : `/property-dashboard?hotelId=${encodeURIComponent(hotelId)}`;

  return (
    // `shrink-0`, not `sticky`: the shell is a fixed-height flex column that
    // does not scroll, so this row is pinned structurally. Sticky would be
    // inert here and would quietly stop working the day an ancestor gained an
    // `overflow` — structure is the more durable guarantee.
    <header className="z-30 shrink-0 border-b border-white/[0.08] bg-[#0a0a0b]/95 backdrop-blur-xl">
      <div className="flex h-14 items-center gap-2 px-3 sm:gap-3 sm:px-4">
        <Link
          href={brandHref}
          aria-label={active === null ? 'All properties' : `${active.propertyName} dashboard`}
          title={
            active === null
              ? 'All properties'
              : `${active.propertyName} · ${active.propertyCode}`
          }
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-xl',
            'bg-gradient-to-br from-blue-500 via-sky-500 to-indigo-600',
            'font-bold text-white shadow-md select-none',
            'transition-all hover:opacity-90 active:scale-95',
          )}
        >
          E
        </Link>

        <nav aria-label="Property navigation" className="hidden items-center gap-0.5 md:flex">
          {QUICK_LINKS.map((link) => {
            const Icon = link.icon;
            // Section-aware: a sub-route like `/rates-inventory/restrictions`
            // still lights its parent. Matched on a trailing slash rather than
            // a bare `startsWith`, so `/calendar-archive` would not light
            // `/calendar`.
            const isActive =
              pathname === link.href || pathname.startsWith(`${link.href}/`);
            // Most links say the same thing twice; a few need a longer
            // accessible name than the tooltip text.
            const ariaLabel = 'ariaLabel' in link ? link.ariaLabel : link.label;

            if (!link.ready) {
              return (
                <button
                  key={link.label}
                  type="button"
                  disabled
                  aria-label={ariaLabel}
                  title={`${link.label} arrives with its module`}
                  className="grid size-8 cursor-not-allowed place-items-center rounded-lg text-zinc-400 disabled:opacity-40"
                >
                  <Icon className="size-4.5" aria-hidden="true" />
                </button>
              );
            }

            const href =
              link.scoped && hotelId !== null
                ? `${link.href}?hotelId=${encodeURIComponent(hotelId)}`
                : link.href;

            return (
              <Link
                key={link.label}
                href={href}
                title={link.label}
                aria-label={ariaLabel}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'grid size-8 place-items-center rounded-lg transition-colors',
                  isActive
                    ? 'bg-white/10 text-white'
                    : 'text-zinc-400 hover:bg-white/[0.06] hover:text-white',
                )}
              >
                <Icon className="size-4.5" aria-hidden="true" />
              </Link>
            );
          })}
        </nav>

        {/* Global reservation search — live, and the only control in this bar
            that reaches the API. Disabled only when there is no property to
            scope it to. */}
        <OmnibarSearch hotelId={hotelId} />

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            disabled
            title="EaseIt AI arrives with the reporting module"
            className="hidden cursor-not-allowed items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-400 transition hover:bg-blue-500/20 disabled:opacity-70 sm:inline-flex"
          >
            <Sparkles className="size-3.5" aria-hidden="true" />
            EaseIt AI
          </button>

          <button
            type="button"
            disabled
            title="Help centre not wired up yet"
            className="hidden cursor-not-allowed items-center gap-1 px-2 py-1 text-xs text-zinc-400 transition-colors hover:text-white disabled:opacity-70 sm:inline-flex"
          >
            <CircleQuestionMark className="size-3.5" aria-hidden="true" />
            Help?
          </button>

          {/* Property switcher, or plain text for property staff.
              Every entry is a real navigation, not a client-side select:
              switching property re-authorises server-side and reissues the
              session (CLAUDE.md section 3.2), so the choice has to leave the
              browser. The list is the caller's own grants, which is why a
              property they hold no role at cannot appear in it. */}
          {active === null ? null : canSwitchProperty ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setSwitcherOpen((open) => !open);
                }}
                aria-expanded={switcherOpen}
                aria-haspopup="menu"
                title={`${active.propertyName} · switch property`}
                className="flex max-w-[10rem] items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-zinc-200 transition-colors hover:border-white/20"
              >
                <span className="truncate">{active.propertyName}</span>
                <ChevronDown
                  className={cn(
                    'size-3 shrink-0 text-zinc-500 transition-transform',
                    switcherOpen && 'rotate-180',
                  )}
                  aria-hidden="true"
                />
              </button>

              {switcherOpen ? (
                <>
                  {/* Click-away as a transparent sibling rather than a document
                      listener: no global handler to leak, and it cannot swallow
                      keyboard focus. */}
                  <button
                    type="button"
                    aria-label="Close property switcher"
                    onClick={() => {
                      setSwitcherOpen(false);
                    }}
                    className="fixed inset-0 z-10 cursor-default"
                  />
                  <div
                    role="menu"
                    className="absolute right-0 z-20 mt-1.5 max-h-80 w-64 overflow-y-auto rounded-xl border border-white/[0.1] bg-[#0e0e10] p-1.5 shadow-2xl"
                  >
                    {session.grants.map((grant) => {
                      const current = grant.propertyId === active.propertyId;
                      return (
                        <Link
                          key={grant.propertyId}
                          role="menuitem"
                          href={`/property-dashboard?hotelId=${encodeURIComponent(grant.propertyCode)}`}
                          onClick={() => {
                            setSwitcherOpen(false);
                          }}
                          className={cn(
                            'flex items-center gap-2 rounded-lg px-2.5 py-2 transition-colors',
                            current
                              ? 'bg-white/[0.06] text-white'
                              : 'text-zinc-300 hover:bg-white/[0.04] hover:text-white',
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate text-xs">
                            {grant.propertyName}
                          </span>
                          <span className="tabular shrink-0 text-[10px] text-zinc-600">
                            {grant.propertyCode}
                          </span>
                          {current ? (
                            <Check
                              className="size-3 shrink-0 text-blue-400"
                              aria-hidden="true"
                            />
                          ) : null}
                        </Link>
                      );
                    })}

                    <Link
                      role="menuitem"
                      href="/group-dashboard"
                      onClick={() => {
                        setSwitcherOpen(false);
                      }}
                      className="mt-1 block border-t border-white/[0.06] px-2.5 pt-2 pb-1 text-[11px] text-zinc-500 transition-colors hover:text-white"
                    >
                      All properties
                    </Link>
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <span
              title={`${active.propertyName} · ${active.propertyCode}`}
              className="max-w-[10rem] truncate px-2.5 py-1.5 text-xs font-medium text-zinc-200"
            >
              {active.propertyName}
            </span>
          )}

          {/* App launcher. Anchored by a `relative` wrapper so the popover
              hangs off this button rather than the whole bar. */}
          <div className="relative hidden sm:block">
            <button
              type="button"
              onClick={() => {
                setAppsOpen((open) => !open);
              }}
              aria-expanded={appsOpen}
              aria-haspopup="dialog"
              aria-label="More apps"
              title="More apps"
              className={cn(
                'flex size-9 items-center justify-center rounded-lg transition-colors',
                appsOpen
                  ? 'bg-white/[0.06] text-white'
                  : 'text-zinc-400 hover:bg-white/[0.06] hover:text-white',
              )}
            >
              <Grip className="size-4" aria-hidden="true" />
            </button>

            <MoreAppsPopover
              isOpen={appsOpen}
              onClose={closeApps}
              hotelId={hotelId}
              roles={active?.roles ?? []}
            />
          </div>

          {/* The active property's own branding, rightmost. */}
          <PropertyLogoAvatar
            hotelId={hotelId}
            propertyName={active?.propertyName ?? 'Property'}
            propertyCode={active?.propertyCode ?? ''}
            propertyEmail={active?.propertyEmail ?? null}
            logoUrl={active?.propertyLogoUrl ?? null}
            userName={`${session.firstName} ${session.lastName}`.trim()}
            userEmail={session.email}
          />

        </div>
      </div>
    </header>
  );
}
