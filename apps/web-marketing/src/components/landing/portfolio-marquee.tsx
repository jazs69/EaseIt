import { MapPin } from 'lucide-react';

export interface PortfolioProperty {
  name: string;
  city: string;
  rooms: number;
  /** Tailwind gradient classes standing in for a hero photo. */
  tint: string;
}

/**
 * The ten seeded properties from packages/database/prisma/seed.ts, so the
 * marketing site and the dev portfolio tell the same story.
 */
const PROPERTIES: readonly PortfolioProperty[] = [
  { name: 'Grand Marine', city: 'Goa', rooms: 86, tint: 'from-sky-500/30 to-blue-600/10' },
  { name: 'Lakeview', city: 'Udaipur', rooms: 54, tint: 'from-indigo-500/30 to-violet-600/10' },
  { name: 'Hillcrest', city: 'Manali', rooms: 42, tint: 'from-emerald-500/25 to-teal-600/10' },
  { name: 'Palm Court', city: 'Kochi', rooms: 61, tint: 'from-amber-500/25 to-orange-600/10' },
  { name: 'City Central', city: 'Mumbai', rooms: 148, tint: 'from-blue-500/30 to-cyan-600/10' },
  { name: 'Heritage', city: 'Jaipur', rooms: 72, tint: 'from-rose-500/25 to-pink-600/10' },
  { name: 'Backwater', city: 'Alleppey', rooms: 28, tint: 'from-teal-500/25 to-emerald-600/10' },
  { name: 'Summit', city: 'Shimla', rooms: 39, tint: 'from-slate-400/25 to-zinc-500/10' },
  { name: 'Tech Park', city: 'Bengaluru', rooms: 112, tint: 'from-violet-500/30 to-purple-600/10' },
  { name: 'Marina Bay', city: 'Colombo', rooms: 95, tint: 'from-cyan-500/30 to-sky-600/10' },
];

function PropertyCard({ property }: { property: PortfolioProperty }) {
  return (
    <div className="group w-56 shrink-0 overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02] backdrop-blur-md transition-colors hover:border-blue-500/30">
      <div className={`h-20 bg-gradient-to-br ${property.tint} relative`} aria-hidden="true">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.08),transparent_60%)]" />
      </div>
      <div className="flex flex-col gap-1 p-3.5">
        <div className="text-sm font-semibold text-white">{property.name}</div>
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
            <MapPin className="size-3 shrink-0" aria-hidden="true" />
            {property.city}
          </span>
          <span className="tabular text-[11px] text-zinc-500">{property.rooms} keys</span>
        </div>
      </div>
    </div>
  );
}

export function PortfolioMarquee() {
  return (
    <section id="products" className="relative px-4 py-16 sm:px-6 lg:px-8">
      <p className="mb-8 text-center text-sm text-zinc-500">
        Powering modern independent properties &amp; boutique stays
      </p>

      {/* The track renders the list twice and shifts by -50%, which makes the
          loop seamless. The duplicate is hidden from assistive tech. */}
      <div className="marquee-track relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
        <div className="animate-marquee flex w-max gap-4">
          <ul className="flex gap-4">
            {PROPERTIES.map((property) => (
              <li key={property.name}>
                <PropertyCard property={property} />
              </li>
            ))}
          </ul>
          <ul className="flex gap-4" aria-hidden="true">
            {PROPERTIES.map((property) => (
              <li key={`dup-${property.name}`}>
                <PropertyCard property={property} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
