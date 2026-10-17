import { Apple, Check, Play, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Right-hand showcase column of the login modal.
 *
 * Mirrors the reference layout — a grid of small captioned preview tiles with
 * a "trusted by" row underneath — but shows PMS surfaces rather than generic
 * component previews, so the panel actually says what the product does.
 *
 * Entirely decorative: no inputs, no links into the app. Hidden below `lg`,
 * where the modal collapses to the form alone.
 */

interface PreviewTileProps {
  caption: string;
  children: ReactNode;
}

function PreviewTile({ caption, children }: PreviewTileProps) {
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <div className="h-28 overflow-hidden rounded-lg border border-white/[0.07] bg-[#0d0d0f] p-3">
        {children}
      </div>
      <figcaption className="truncate text-[11px] text-zinc-500">{caption}</figcaption>
    </figure>
  );
}

/* -------------------------------------------------------------------------- */
/*  Mini visuals                                                              */
/* -------------------------------------------------------------------------- */

/** Four rows of stay bars at varying offsets — the room x date grid in miniature. */
function CalendarPreview() {
  const bars: readonly { left: string; width: string; tone: string }[] = [
    { left: '0%', width: '45%', tone: 'bg-emerald-500/40' },
    { left: '55%', width: '35%', tone: 'bg-blue-500/40' },
    { left: '10%', width: '60%', tone: 'bg-blue-500/40' },
    { left: '0%', width: '25%', tone: 'bg-amber-500/40' },
    { left: '35%', width: '50%', tone: 'bg-emerald-500/40' },
    { left: '20%', width: '40%', tone: 'bg-blue-500/40' },
  ];
  return (
    <div className="flex h-full flex-col justify-between gap-1.5">
      {bars.map((bar, index) => (
        <div key={index} className="relative h-2.5 flex-1 rounded-sm bg-white/[0.03]">
          <span
            className={`absolute inset-y-0 rounded-sm ${bar.tone}`}
            style={{ left: bar.left, width: bar.width }}
          />
        </div>
      ))}
    </div>
  );
}

/** Audit steps ticking off, with a progress sliver each. */
function NightAuditPreview() {
  const steps: readonly string[] = ['No-shows', 'Room charges', 'Folios', 'Snapshot'];
  return (
    <ul className="flex h-full flex-col justify-center gap-2">
      {steps.map((step) => (
        <li key={step} className="flex items-center gap-2">
          <Check className="size-2.5 shrink-0 text-emerald-400" aria-hidden="true" />
          <span className="flex-1 truncate text-[9px] text-zinc-500">{step}</span>
          <span className="h-1 w-6 shrink-0 rounded-full bg-emerald-500/40" aria-hidden="true" />
        </li>
      ))}
    </ul>
  );
}

/** OTA push acknowledgements with round-trip times. */
function ChannelPreview() {
  const channels: readonly { name: string; ms: string }[] = [
    { name: 'Booking.com', ms: '220ms' },
    { name: 'Expedia', ms: '310ms' },
    { name: 'Agoda', ms: '265ms' },
  ];
  return (
    <ul className="flex h-full flex-col justify-center gap-1.5">
      {channels.map((channel) => (
        <li
          key={channel.name}
          className="flex items-center gap-1.5 rounded border border-white/[0.05] bg-white/[0.02] px-1.5 py-1"
        >
          <RefreshCw className="size-2.5 shrink-0 text-blue-400" aria-hidden="true" />
          <span className="flex-1 truncate text-[9px] text-zinc-400">{channel.name}</span>
          <span className="tabular text-[9px] text-emerald-300">{channel.ms}</span>
        </li>
      ))}
    </ul>
  );
}

/** A handset silhouette standing in for the magic-link guest portal. */
function GuestPortalPreview() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="h-20 w-12 rounded-md border border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent p-1.5">
        <div className="mx-auto mb-1.5 h-0.5 w-4 rounded-full bg-white/20" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <div className="h-1 w-full rounded-full bg-blue-500/50" />
          <div className="h-1 w-3/4 rounded-full bg-white/10" />
          <div className="h-1 w-5/6 rounded-full bg-white/10" />
          <div className="mt-1.5 h-3 w-full rounded-sm bg-white/[0.08]" />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Panel                                                                     */
/* -------------------------------------------------------------------------- */

const PROPERTIES: readonly string[] = ['Grand Marine', 'Lakeview', 'City Central', 'Marina Bay'];

export function ShowcasePanel() {
  return (
    <aside
      aria-hidden="true"
      className="relative hidden min-w-0 flex-col justify-between gap-6 overflow-hidden border-l border-white/[0.06] bg-white/[0.012] p-6 lg:flex"
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-5">
        <PreviewTile caption="Reservation calendar">
          <CalendarPreview />
        </PreviewTile>
        <PreviewTile caption="Autonomous night audit">
          <NightAuditPreview />
        </PreviewTile>
        <PreviewTile caption="Two-way channel sync">
          <ChannelPreview />
        </PreviewTile>
        <PreviewTile caption="Magic-link guest portal">
          <GuestPortalPreview />
        </PreviewTile>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          <span className="text-[11px] text-zinc-500">Powering properties at</span>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {PROPERTIES.map((property) => (
              <span key={property} className="text-xs font-semibold text-zinc-400">
                {property}
              </span>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-white/[0.06] pt-4">
          <span className="text-[10px] text-zinc-600">Staff app</span>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[10px] text-zinc-400">
            <Apple className="size-3" aria-hidden="true" />
            App Store
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[10px] text-zinc-400">
            <Play className="size-3" aria-hidden="true" />
            Google Play
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] text-emerald-400">
            <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
            Operational
          </span>
        </div>
      </div>
    </aside>
  );
}
