import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: { default: 'EaseIt PMS', template: '%s | EaseIt PMS' },
  description: 'Staff dashboard: reservations, folios, housekeeping and night audit.',
  // Internal tooling must never be indexed.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#09090b',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `dark` is explicit, not prefers-color-scheme: the PMS is dark-only, and
    // the class is what the shared @repo/config preset keys its dark tokens off.
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="min-h-screen bg-[#09090b] text-white antialiased">{children}</body>
    </html>
  );
}
