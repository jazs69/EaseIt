import type { Metadata } from 'next';

import { AccountLinkForm } from '@/components/login/account-link-form';

export const metadata: Metadata = {
  title: 'Forgot password',
  description: 'Request a link to reset your EaseIt password.',
  robots: { index: false, follow: false },
};

/** Signed-out page (AU-08 / AU-14); public in `lib/auth-routing.ts`. */
export default function Page() {
  return <AccountLinkForm mode="forgot" />;
}
