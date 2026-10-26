'use client';

/**
 * The property configuration screen.
 *
 * Five tabs over one record, so one state container and one request. The tabs
 * are views of the same `PropertySetup`, not five screens: an operator who
 * changes a GST band and then opens Policies should not wait again, and five
 * independent fetches would be five chances to disagree about which property
 * is being configured.
 *
 * Every save returns the whole recomputed configuration and replaces the
 * state, which is why each tab holds its edits in a draft tagged against the
 * payload it came from: a save elsewhere invalidates the tag and the fresh
 * server value wins, with no effect copying props into state.
 */

import { useState } from 'react';
import {
  Building2,
  Clock,
  FileText,
  Percent,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { PropertySetup } from '@repo/types';
import { cn } from '@repo/ui';

import { AmenitiesTab } from './amenities-tab';
import { GeneralTab } from './general-tab';
import { PoliciesTab } from './policies-tab';
import { TaxesTab } from './taxes-tab';
import { TimingsTab } from './timings-tab';
import { usePropertySettings } from './use-property-settings';

const TABS = [
  { id: 'general', label: 'General & media', icon: Building2 },
  { id: 'timings', label: 'Timings & operations', icon: Clock },
  { id: 'taxes', label: 'Taxes & surcharges', icon: Percent },
  { id: 'amenities', label: 'Amenities', icon: Sparkles },
  { id: 'policies', label: 'Policies & terms', icon: FileText },
] as const;

type TabId = (typeof TABS)[number]['id'];

export interface PropertyConfigViewProps {
  setup: PropertySetup;
  hotelId: string;
}

export function PropertyConfigView({ setup: initial, hotelId }: PropertyConfigViewProps) {
  const state = usePropertySettings(hotelId, initial);
  const [tab, setTab] = useState<TabId>('general');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-white/[0.08] px-4 pt-6 pb-0 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-white">Property configuration</h1>
            <p className="mt-1 text-xs text-zinc-500">
              {state.setup.name} · {state.setup.code} · {state.setup.timezone} ·{' '}
              {state.setup.currency}
            </p>
          </div>
          <p className="text-xs text-zinc-500">
            Business date{' '}
            <span className="font-semibold text-zinc-300">{state.setup.businessDate}</span>
          </p>
        </div>

        <nav
          className="mt-5 flex gap-1 overflow-x-auto"
          aria-label="Configuration sections"
        >
          {TABS.map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => {
                  setTab(entry.id);
                }}
                aria-current={tab === entry.id ? 'page' : undefined}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-medium transition-colors',
                  tab === entry.id
                    ? 'border-blue-500 text-white'
                    : 'border-transparent text-zinc-400 hover:text-zinc-200',
                )}
              >
                <Icon className="size-3.5" aria-hidden="true" />
                {entry.label}
              </button>
            );
          })}
        </nav>
      </header>

      {state.error === null ? null : (
        <div
          role="alert"
          className="mx-4 mt-4 flex items-start gap-2.5 rounded-lg border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2.5 sm:mx-6"
        >
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0 text-rose-400"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-rose-100">
            {state.error}
          </p>
          <button
            type="button"
            onClick={state.dismissError}
            className="shrink-0 rounded p-0.5 text-rose-300/70 transition-colors hover:text-rose-200"
          >
            <X className="size-3.5" aria-hidden="true" />
            <span className="sr-only">Dismiss</span>
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {tab === 'general' ? <GeneralTab state={state} hotelId={hotelId} /> : null}
        {tab === 'timings' ? <TimingsTab state={state} /> : null}
        {tab === 'taxes' ? <TaxesTab state={state} /> : null}
        {tab === 'amenities' ? <AmenitiesTab state={state} /> : null}
        {tab === 'policies' ? <PoliciesTab state={state} /> : null}
      </div>
    </div>
  );
}
