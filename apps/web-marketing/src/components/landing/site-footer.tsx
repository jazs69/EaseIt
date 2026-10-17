import { Hexagon } from 'lucide-react';

export interface FooterColumn {
  heading: string;
  links: readonly { label: string; href: string }[];
}

const COLUMNS: readonly FooterColumn[] = [
  {
    heading: 'Product',
    links: [
      { label: 'Property Management', href: '#products' },
      { label: 'Channel Manager', href: '#products' },
      { label: 'Booking Engine', href: '#products' },
      { label: 'Guest Portal', href: '#products' },
      { label: 'Pricing', href: '#pricing' },
    ],
  },
  {
    heading: 'Platform',
    links: [
      { label: 'AI Agents', href: '#agents' },
      { label: 'Night Audit', href: '#agents' },
      { label: 'Reporting & RevPAR', href: '#features' },
      { label: 'API Reference', href: '#docs' },
      { label: 'Changelog', href: '#docs' },
    ],
  },
  {
    heading: 'Solutions',
    links: [
      { label: 'Boutique Hotels', href: '#products' },
      { label: 'Resorts', href: '#products' },
      { label: 'Serviced Apartments', href: '#products' },
      { label: 'Hotel Groups', href: '#products' },
      { label: 'Migration from Legacy PMS', href: '#docs' },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { label: 'Privacy Policy', href: '#legal' },
      { label: 'Terms of Service', href: '#legal' },
      { label: 'Data Processing', href: '#legal' },
      { label: 'Security', href: '#legal' },
      { label: 'Sub-processors', href: '#legal' },
    ],
  },
];

/**
 * Text links rather than icons: lucide v1 removed every brand glyph for
 * trademark reasons, and substituting a generic icon for a brand mark reads
 * as a mistake. A wordmark pill is honest and fits the dev-footer look.
 */
const SOCIALS: readonly { label: string; href: string }[] = [
  { label: 'GitHub', href: '#github' },
  { label: 'X', href: '#x' },
  { label: 'LinkedIn', href: '#linkedin' },
];

function StatusBadge() {
  return (
    <a
      href="#status"
      className="inline-flex w-fit items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/[0.06] px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:border-emerald-400/40"
    >
      <span className="relative flex size-2" aria-hidden="true">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
      </span>
      All Systems Operational
    </a>
  );
}

export function SiteFooter() {
  return (
    <footer className="relative border-t border-white/[0.08] bg-black/40 px-4 pt-16 pb-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="grid gap-12 lg:grid-cols-[1.2fr_2.8fr]">
          {/* Brand block */}
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-2.5">
              <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-sky-400 via-blue-500 to-indigo-600">
                <Hexagon className="size-4 text-white" strokeWidth={2.5} aria-hidden="true" />
              </span>
              <span className="text-[15px] font-semibold tracking-tight text-white">EaseIt</span>
            </div>
            <p className="max-w-xs text-sm leading-relaxed text-zinc-500">
              The autonomous hotel operating system. PMS, channel manager and direct booking engine
              in one tenant-isolated platform.
            </p>
            <StatusBadge />
          </div>

          {/* Link columns */}
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
            {COLUMNS.map((column) => (
              <div key={column.heading} className="flex flex-col gap-3">
                <h3 className="text-xs font-semibold tracking-[0.14em] text-zinc-300 uppercase">
                  {column.heading}
                </h3>
                <ul className="flex flex-col gap-2.5">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        className="text-sm text-zinc-500 transition-colors hover:text-white"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-14 flex flex-col-reverse items-start justify-between gap-6 border-t border-white/[0.08] pt-6 sm:flex-row sm:items-center">
          <p className="text-xs text-zinc-600">
            © {String(new Date().getFullYear())} EaseIt Hospitality Systems. All rights reserved.
          </p>

          <ul className="flex items-center gap-2">
            {SOCIALS.map((social) => (
              <li key={social.label}>
                <a
                  href={social.href}
                  className="inline-flex items-center rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:border-white/20 hover:text-white"
                >
                  {social.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </footer>
  );
}
