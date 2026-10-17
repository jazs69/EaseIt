'use client';

/**
 * The group dashboard: every property the operator may enter, and the toolbar
 * that narrows it.
 *
 * ===========================================================================
 * Filtering is **client-side over a server-rendered list**, and that is a
 * deliberate choice rather than laziness.
 *
 * The portfolio is ten properties (CLAUDE.md section 1), so the whole set
 * arrives in one payload and every keystroke can filter it instantly with no
 * network round trip, no debounce, no loading skeleton and no race between a
 * stale response and a newer one. The API supports `?status=` and `?search=`
 * as well — the server render uses `status` for the initial set, and other
 * consumers can use both — but driving live search through it would be
 * strictly worse UX here for no gain.
 *
 * This is also why there is no SWR or React Query. Neither would be earning
 * its keep: there is one request, it has no polling or revalidation
 * requirement, and it is already resolved before the component mounts
 * (CLAUDE.md section 6.4).
 *
 * It stops being the right trade at a few hundred properties, at which point
 * the server filter is already built and the change is to call it per
 * keystroke instead.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import {
  PROPERTY_STATUS_LABELS,
  PropertyStatus,
  ROLE_LABELS,
  type GroupProperty,
  type PropertyStatusFilter,
} from '@repo/types';
import { CircleAlert, Funnel, Grid3x3, List, Loader2, MapPin, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { ApiRequestError, ApiUnreachableError } from '@/lib/api';
import { selectPropertyContext } from '@/lib/properties-client';
import { PropertyBadge, StatusPill } from './property-bits';

type ViewMode = 'list' | 'grid';

const STATUS_OPTIONS: readonly { value: PropertyStatusFilter; label: string }[] = [
  { value: 'ACTIVE', label: PROPERTY_STATUS_LABELS.ACTIVE },
  { value: 'ONBOARDING', label: PROPERTY_STATUS_LABELS.ONBOARDING },
  { value: 'INACTIVE', label: PROPERTY_STATUS_LABELS.INACTIVE },
  { value: 'ALL', label: 'All statuses' },
];

export interface GroupDashboardViewProps {
  /** Server-rendered, unfiltered by status so the client can switch freely. */
  properties: readonly GroupProperty[];
  /** The status the server rendered with, used as the initial filter. */
  initialStatus: PropertyStatusFilter;
}

export function GroupDashboardView({ properties, initialStatus }: GroupDashboardViewProps) {
  const router = useRouter();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<PropertyStatusFilter>(initialStatus);
  const [view, setView] = useState<ViewMode>('list');
  const [entering, setEntering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return properties.filter((property) => {
      if (status !== 'ALL' && property.status !== status) return false;
      if (needle.length === 0) return true;

      // Same fields the API searches, so switching to the server filter later
      // cannot change what matches.
      return [property.name, property.code, property.city, property.division]
        .filter((field): field is string => field !== null)
        .some((field) => field.toLowerCase().includes(needle));
    });
  }, [properties, search, status]);

  /**
   * Enter a property.
   *
   * The server is asked to set the active property *before* navigating, and
   * the navigation only happens if it agreed. Routing first and letting the
   * next page discover it has no context would flash a broken screen — and the
   * server is the only thing that can say whether this operator may enter.
   */
  async function enter(property: GroupProperty): Promise<void> {
    if (entering !== null) return;

    if (property.status === PropertyStatus.INACTIVE) {
      setError(`${property.name} is retired and cannot be opened.`);
      return;
    }

    setEntering(property.id);
    setError(null);

    try {
      await selectPropertyContext(property.id);
      // Deliberately leaves `entering` set: the spinner holds until the route
      // transition paints rather than flashing back to idle.
      //
      // `hotelId` carries the operator-facing **code** (31336), not the uuid:
      // it is what staff recognise in a URL they may paste to a colleague, and
      // the API accepts either. Neither is trusted — both are resolved through
      // the caller's own grants (CLAUDE.md section 3.2) — so using the
      // friendlier one costs nothing.
      router.push(`/property-dashboard?hotelId=${encodeURIComponent(property.code)}`);
    } catch (caught) {
      setEntering(null);
      setError(describeFailure(caught, property.name));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <p className="text-sm text-zinc-500">
          Select a property to open its front desk, folios and reservation calendar.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-zinc-500"
              aria-hidden="true"
            />
            <input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
              placeholder="Search properties..."
              aria-label="Search properties by name, code, city or division"
              className="w-56 rounded-lg border border-white/10 bg-zinc-900/60 py-2 pr-3 pl-9 text-xs text-white placeholder:text-zinc-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            />
          </div>

          {/* Status filter */}
          <div className="relative">
            <Funnel
              className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-zinc-500"
              aria-hidden="true"
            />
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as PropertyStatusFilter);
              }}
              aria-label="Filter by status"
              className="appearance-none rounded-lg border border-white/10 bg-zinc-900/60 py-2 pr-8 pl-9 text-xs font-medium text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="bg-zinc-900">
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {/* View switcher */}
          <div
            role="group"
            aria-label="View mode"
            className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-zinc-900/60 p-0.5"
          >
            <ViewButton
              active={view === 'list'}
              label="List view"
              onClick={() => {
                setView('list');
              }}
            >
              <List className="size-3.5" aria-hidden="true" />
            </ViewButton>
            <ViewButton
              active={view === 'grid'}
              label="Grid view"
              onClick={() => {
                setView('grid');
              }}
            >
              <Grid3x3 className="size-3.5" aria-hidden="true" />
            </ViewButton>
          </div>
        </div>
      </div>

      {error !== null ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-3.5 py-3"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-rose-400" aria-hidden="true" />
          <p className="text-xs leading-relaxed text-rose-200">{error}</p>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState />
      ) : view === 'list' ? (
        <ListView properties={visible} entering={entering} onEnter={enter} />
      ) : (
        <GridView properties={visible} entering={entering} onEnter={enter} />
      )}

      {/* Announced to screen readers when the filtered count changes, which a
          silently re-rendered table otherwise never communicates. */}
      <p aria-live="polite" className="sr-only">
        {visible.length} of {properties.length} properties shown
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  List view                                                                 */
/* -------------------------------------------------------------------------- */

interface ViewProps {
  properties: readonly GroupProperty[];
  entering: string | null;
  onEnter: (property: GroupProperty) => Promise<void>;
}

function ListView({ properties, entering, onEnter }: ViewProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08]">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">
            Properties you can open, with their division, location and status
          </caption>
          <thead>
            <tr className="border-b border-white/[0.08] bg-white/[0.02]">
              <Th>Listing</Th>
              <Th>Listing date / division</Th>
              <Th>Location</Th>
              <Th>Status</Th>
              <th scope="col" className="w-10 px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {properties.map((property) => {
              const busy = entering === property.id;
              const retired = property.status === PropertyStatus.INACTIVE;

              return (
                <tr
                  key={property.id}
                  className={cn(
                    'border-b border-white/[0.05] transition-colors last:border-b-0',
                    retired ? 'opacity-55' : 'hover:bg-white/[0.03]',
                    busy && 'bg-blue-500/[0.06]',
                  )}
                >
                  <td className="px-4 py-3">
                    {/* The button carries the click, not the <tr>. A row click
                        handler is not reachable by keyboard and is announced as
                        nothing; a real button in the primary cell is both
                        focusable and named. */}
                    <button
                      type="button"
                      onClick={() => {
                        void onEnter(property);
                      }}
                      disabled={busy || retired}
                      aria-label={`Open ${property.name}`}
                      className="group flex items-center gap-3 text-left disabled:cursor-not-allowed"
                    >
                      <PropertyBadge name={property.name} logoUrl={property.logoUrl} />
                      <span className="flex min-w-0 flex-col">
                        <span
                          className={cn(
                            'truncate text-sm font-semibold text-white',
                            !retired && 'group-hover:text-blue-300',
                          )}
                        >
                          {property.name}
                        </span>
                        <span className="tabular text-[11px] text-zinc-500">
                          #{property.code}
                          {property.userRole === null
                            ? property.customRoleNames.length > 0
                              ? ` · ${property.customRoleNames[0] ?? ''}`
                              : ''
                            : ` · ${ROLE_LABELS[property.userRole]}`}
                        </span>
                      </span>
                    </button>
                  </td>

                  <td className="px-4 py-3">
                    <span className="text-xs text-zinc-300">{property.division ?? '—'}</span>
                  </td>

                  <td className="max-w-[18rem] px-4 py-3">
                    {/* `title` gives the full address on hover, since the cell
                        truncates. */}
                    <span
                      title={property.address ?? undefined}
                      className="flex items-start gap-1.5 text-xs text-zinc-500"
                    >
                      <MapPin className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                      <span className="truncate">{property.address ?? '—'}</span>
                    </span>
                  </td>

                  <td className="px-4 py-3">
                    <StatusPill status={property.status} />
                  </td>

                  <td className="px-4 py-3 text-right">
                    {busy ? (
                      <Loader2 className="inline size-4 animate-spin text-blue-400" aria-hidden="true" />
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="px-4 py-3 text-[10px] font-semibold tracking-[0.14em] text-zinc-500 uppercase"
    >
      {children}
    </th>
  );
}

/* -------------------------------------------------------------------------- */
/*  Grid view                                                                 */
/* -------------------------------------------------------------------------- */

function GridView({ properties, entering, onEnter }: ViewProps) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {properties.map((property) => {
        const busy = entering === property.id;
        const retired = property.status === PropertyStatus.INACTIVE;

        return (
          <li key={property.id}>
            <button
              type="button"
              onClick={() => {
                void onEnter(property);
              }}
              disabled={busy || retired}
              aria-label={`Open ${property.name}`}
              className={cn(
                'group flex h-full w-full flex-col gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 text-left transition-colors',
                retired ? 'cursor-not-allowed opacity-55' : 'hover:border-blue-500/30',
                busy && 'border-blue-500/40 bg-blue-500/[0.06]',
              )}
            >
              <div className="flex items-start gap-3">
                <PropertyBadge name={property.name} logoUrl={property.logoUrl} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cn(
                      'truncate text-sm font-semibold text-white',
                      !retired && 'group-hover:text-blue-300',
                    )}
                  >
                    {property.name}
                  </span>
                  <span className="tabular text-[11px] text-zinc-500">#{property.code}</span>
                </span>
                {busy ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-blue-400" aria-hidden="true" />
                ) : null}
              </div>

              <p className="text-[11px] text-zinc-400">{property.division ?? '—'}</p>

              <p
                title={property.address ?? undefined}
                className="line-clamp-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-zinc-500"
              >
                <MapPin className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                <span>{property.address ?? '—'}</span>
              </p>

              <div className="mt-auto flex items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
                <StatusPill status={property.status} />
                <span className="tabular text-[10px] text-zinc-600">
                  {property.currency} · {property.businessDate}
                </span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/*  Chrome                                                                    */
/* -------------------------------------------------------------------------- */

function ViewButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      className={cn(
        'grid size-7 place-items-center rounded-md transition-colors',
        active ? 'bg-white/[0.1] text-white' : 'text-zinc-500 hover:text-zinc-300',
      )}
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-white/[0.1] px-6 py-16 text-center">
      <Search className="size-5 text-zinc-600" aria-hidden="true" />
      <p className="text-sm font-medium text-zinc-300">No properties found matching your filter.</p>
      <p className="max-w-sm text-xs leading-relaxed text-zinc-600">
        Try a different search term, or widen the status filter to include onboarding and retired
        properties.
      </p>
    </div>
  );
}

function describeFailure(caught: unknown, propertyName: string): string {
  if (caught instanceof ApiUnreachableError) return caught.message;

  if (caught instanceof ApiRequestError) {
    // The API answers not-found for "no such property" and "you hold no role
    // there" alike, so the copy must not claim to know which.
    if (caught.status === 404) {
      return `${propertyName} could not be opened. Your access may have changed — reload to refresh your properties.`;
    }
    return caught.message;
  }

  return `${propertyName} could not be opened. Please try again.`;
}
