'use client';

/**
 * The group-level navigation rail.
 *
 * Collapse state is persisted per browser in `localStorage` — it is a
 * per-viewer convenience, not shared state, so it has no business on the
 * server. It is read through `useSyncExternalStore` (see below) rather than
 * copied into component state, and every access is wrapped because storage
 * throws in private mode and with site data blocked; a rail that cannot
 * remember its width must still render.
 *
 * Collapsed, the rail keeps icons and drops labels. The labels stay in the DOM
 * as `sr-only` text rather than being removed, so the collapsed rail is still
 * navigable by screen reader — an icon-only button with no accessible name is
 * the usual regression here.
 */

import { cn } from '@repo/ui';
import {
  CalendarDays,
  ChartColumn,
  ChevronLeft,
  Hexagon,
  LayoutGrid,
  LogOut,
  Settings,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useSyncExternalStore, type ComponentType } from 'react';

import { signOut } from '@/lib/auth-client';
import { useOptionalSession } from '@/components/session-provider';

const COLLAPSE_KEY = 'easeit.pms.sidebar.collapsed';

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
}

const GROUP_NAV: readonly NavItem[] = [
  { href: '/group-dashboard', label: 'Group dashboard', icon: LayoutGrid },
  { href: '/group-performance', label: 'Group performance dashboard', icon: ChartColumn },
  { href: '/group-calendar', label: 'Group reservation calendar', icon: CalendarDays },
];

const SETTINGS_NAV: readonly NavItem[] = [
  { href: '/settings/access-control', label: 'Access control', icon: Settings },
];

/* -------------------------------------------------------------------------- */
/*  Collapse preference, as an external store                                 */
/* -------------------------------------------------------------------------- */

/**
 * `localStorage` really is an external system, so it is read through
 * `useSyncExternalStore` rather than copied into state by a mount effect.
 *
 * The effect-then-setState version is the cascading render the react-hooks rule
 * rejects, and it also paints the rail expanded for one frame before snapping
 * closed. `getServerSnapshot` returning false is what keeps SSR and hydration
 * in agreement: the server has no storage, so it renders expanded, and React
 * reconciles to the stored value immediately after hydrating.
 *
 * The snapshot is a boolean — a primitive — so unlike an object snapshot it
 * needs no identity cache to avoid an infinite render loop.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

function subscribeToCollapse(listener: Listener): () => void {
  listeners.add(listener);
  const onStorage = (): void => {
    for (const notify of listeners) notify();
  };
  // Keeps two tabs of the admin app in step.
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

function getCollapseSnapshot(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === 'true';
  } catch {
    // Private mode, or site data blocked. The rail still renders.
    return false;
  }
}

function getCollapseServerSnapshot(): boolean {
  return false;
}

function writeCollapsed(next: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, String(next));
  } catch {
    // Non-fatal: the rail just forgets its width next time.
  }
  for (const notify of listeners) notify();
}

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const session = useOptionalSession();

  const collapsed = useSyncExternalStore(
    subscribeToCollapse,
    getCollapseSnapshot,
    getCollapseServerSnapshot,
  );
  const [signingOut, setSigningOut] = useState(false);

  function toggle(): void {
    writeCollapsed(!collapsed);
  }

  async function handleSignOut(): Promise<void> {
    setSigningOut(true);
    try {
      await signOut();
    } catch {
      // Intentionally ignored: the API clears the cookie, and if it is
      // unreachable, stranding the operator on a dashboard they asked to leave
      // is the worse outcome. A stale cookie is rejected on its next use.
    }
    router.replace('/login');
    router.refresh();
  }

  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        'sticky top-0 flex h-screen shrink-0 flex-col border-r border-white/[0.08] bg-[#0a0a0b]',
        // The only animated property is width, so the transition cannot cause
        // a layout thrash on the main column beside it.
        'transition-[width] duration-200 ease-out',
        collapsed ? 'w-[4.5rem]' : 'w-64',
      )}
    >
      {/* Brand */}
      <div className="flex h-16 shrink-0 items-center gap-2.5 border-b border-white/[0.06] px-4">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-sky-400 via-blue-500 to-indigo-600">
          <Hexagon className="size-4 text-white" strokeWidth={2.5} aria-hidden="true" />
        </span>
        <span
          className={cn(
            'truncate text-[15px] font-semibold tracking-tight text-white transition-opacity duration-150',
            collapsed && 'pointer-events-none opacity-0',
          )}
        >
          EaseIt
        </span>

        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!collapsed}
          className={cn(
            'ml-auto grid size-7 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200',
            collapsed && 'absolute left-1/2 top-[3.25rem] -translate-x-1/2',
          )}
        >
          <ChevronLeft
            className={cn('size-4 transition-transform duration-200', collapsed && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      </div>

      {/* Navigation */}
      <nav aria-label="Group navigation" className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="flex flex-col gap-1">
          {GROUP_NAV.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} collapsed={collapsed} />
          ))}
        </ul>

        <div className="my-4 border-t border-white/[0.06]" />

        <ul className="flex flex-col gap-1">
          {SETTINGS_NAV.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} collapsed={collapsed} />
          ))}
        </ul>
      </nav>

      {/* Pinned footer */}
      <div className="shrink-0 border-t border-white/[0.06] p-3">
        {session !== null && !collapsed ? (
          <p className="mb-2 truncate px-2 text-[11px] text-zinc-600">
            {session.firstName} {session.lastName}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => {
            void handleSignOut();
          }}
          disabled={signingOut}
          title={collapsed ? 'Logout' : undefined}
          className={cn(
            'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-zinc-400 transition-colors hover:bg-rose-500/[0.08] hover:text-rose-300 disabled:opacity-50',
            collapsed && 'justify-center px-0',
          )}
        >
          <LogOut className="size-4 shrink-0" aria-hidden="true" />
          <span className={cn('truncate', collapsed && 'sr-only')}>
            {signingOut ? 'Logging out…' : 'Logout'}
          </span>
        </button>
      </div>
    </aside>
  );
}

function NavLink({
  item,
  pathname,
  collapsed,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
}) {
  // Prefix match so a nested route keeps its parent highlighted, but anchored
  // on a segment boundary: a plain `startsWith` would light up
  // `/group-dashboard` for `/group-dashboard-archive`.
  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
  const Icon = item.icon;

  return (
    <li>
      <Link
        href={item.href}
        aria-current={active ? 'page' : undefined}
        title={collapsed ? item.label : undefined}
        className={cn(
          'flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors',
          active
            ? 'bg-white/[0.07] font-medium text-white'
            : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200',
          collapsed && 'justify-center px-0',
        )}
      >
        <Icon
          className={cn('size-4 shrink-0', active ? 'text-blue-400' : undefined)}
          aria-hidden="true"
        />
        <span className={cn('truncate', collapsed && 'sr-only')}>{item.label}</span>
      </Link>
    </li>
  );
}
