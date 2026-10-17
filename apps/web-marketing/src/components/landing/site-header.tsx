'use client';

import { cn } from '@repo/ui';
import { ArrowUpRight, Hexagon, Menu, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { CtaButton } from './primitives';

export interface NavLink {
  label: string;
  href: string;
}

const NAV_LINKS: readonly NavLink[] = [
  { label: 'Products', href: '#products' },
  { label: 'AI Agents', href: '#agents' },
  { label: 'Features', href: '#features' },
  { label: 'Pricing', href: '#pricing' },
  { label: 'Docs', href: '#docs' },
];

/** The staff PMS lives on its own subdomain, so this is a hard link, not a route. */
/** The staff PMS lives on its own subdomain/port */
const PMS_URL = (process.env.NEXT_PUBLIC_ADMIN_URL || 'http://localhost:3001').replace(/\/$/, '');

function BrandMark() {
  return (
    <Link href="/" className="flex items-center gap-2.5" aria-label="EaseIt home">
      <span className="relative grid size-8 place-items-center rounded-lg bg-gradient-to-br from-sky-400 via-blue-500 to-indigo-600">
        <Hexagon className="size-4 text-white" strokeWidth={2.5} aria-hidden="true" />
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-white">EaseIt</span>
      <span className="hidden rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[10px] font-medium text-zinc-400 sm:inline">
        Hotel OS
      </span>
    </Link>
  );
}

export function SiteHeader() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.08] bg-black/60 backdrop-blur-xl">
      <nav
        className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-6 px-4 sm:px-6 lg:px-8"
        aria-label="Primary"
      >
        <BrandMark />

        {/* Centre links collapse below lg; the mobile panel below takes over. */}
        <ul className="hidden items-center gap-1 lg:flex">
          {NAV_LINKS.map((link) => (
            <li key={link.label}>
              <a
                href={link.href}
                className="rounded-full px-3 py-2 text-sm text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-white"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="hidden items-center gap-2 md:flex">
          <a
            href={`${PMS_URL}/login`}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm text-zinc-300 transition-colors hover:text-white"
          >
            PMS Login
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </a>
          <CtaButton href="#get-started" className="px-4 py-2">
            Get Started
          </CtaButton>
        </div>

        <button
          type="button"
          onClick={() => setMobileOpen((open) => !open)}
          className="grid size-9 place-items-center rounded-lg border border-white/[0.08] bg-white/[0.02] text-zinc-300 md:hidden"
          aria-expanded={mobileOpen}
          aria-controls="mobile-nav"
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
        >
          {mobileOpen ? (
            <X className="size-4" aria-hidden="true" />
          ) : (
            <Menu className="size-4" aria-hidden="true" />
          )}
        </button>
      </nav>

      <div
        id="mobile-nav"
        className={cn(
          'overflow-hidden border-t border-white/[0.08] bg-black/80 backdrop-blur-xl md:hidden',
          mobileOpen ? 'max-h-96' : 'max-h-0 border-t-0',
          'transition-[max-height] duration-300 ease-out',
        )}
      >
        <ul className="flex flex-col gap-1 px-4 py-4">
          {NAV_LINKS.map((link) => (
            <li key={link.label}>
              <a
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className="block rounded-lg px-3 py-2.5 text-sm text-zinc-300 hover:bg-white/[0.04] hover:text-white"
              >
                {link.label}
              </a>
            </li>
          ))}
          <li className="mt-2 flex flex-col gap-2 border-t border-white/[0.08] pt-4">
            <a
              href={`${PMS_URL}/login`}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2.5 text-sm text-zinc-300 hover:text-white"
            >
              PMS Login
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </a>
            <CtaButton href="#get-started">Get Started</CtaButton>
          </li>
        </ul>
      </div>
    </header>
  );
}
