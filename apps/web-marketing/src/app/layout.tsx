import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

const SITE_URL = process.env['NEXT_PUBLIC_MARKETING_URL'] ?? 'http://localhost:3000';

export const metadata: Metadata = {
  title: {
    default: 'EaseIt — The autonomous operating system for modern hotels',
    template: '%s | EaseIt',
  },
  description:
    'One platform for property management, two-way OTA distribution and an AI guest concierge. Zero overbooking, deterministic night audit, commission-free direct bookings.',
  metadataBase: new URL(SITE_URL),
  keywords: [
    'hotel PMS',
    'channel manager',
    'direct booking engine',
    'hospitality software',
    'night audit',
    'multi-property hotel management',
  ],
  openGraph: {
    type: 'website',
    siteName: 'EaseIt',
    title: 'EaseIt — The autonomous operating system for modern hotels',
    description: 'PMS, channel manager and AI guest concierge in one tenant-isolated platform.',
    url: SITE_URL,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'EaseIt — The autonomous operating system for modern hotels',
    description: 'PMS, channel manager and AI guest concierge in one tenant-isolated platform.',
  },
};

export const viewport: Viewport = {
  // The marketing site commits to a single dark look, so the browser chrome
  // is told to match rather than following the OS preference.
  themeColor: '#09090b',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `dark` is set explicitly rather than left to prefers-color-scheme: this
    // page is dark-only, and the class is what the shared @repo/config preset
    // keys its dark tokens off.
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="min-h-screen bg-[#09090b] text-white antialiased">{children}</body>
    </html>
  );
}
