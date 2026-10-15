import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Book your stay', template: '%s | Book direct' },
  description: 'Book direct for the best available rate.',
  metadataBase: new URL(process.env['NEXT_PUBLIC_BOOKING_URL'] ?? 'http://localhost:3002'),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
