import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'EaseIt — Hotel PMS, Channel Manager and Booking Engine',
    template: '%s | EaseIt',
  },
  description:
    'One platform for property management, OTA distribution and commission-free direct bookings.',
  metadataBase: new URL(process.env['NEXT_PUBLIC_MARKETING_URL'] ?? 'http://localhost:3000'),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
