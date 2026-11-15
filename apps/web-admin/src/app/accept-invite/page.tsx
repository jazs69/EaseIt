import type { Metadata } from 'next';

import { AccountLinkForm } from '@/components/login/account-link-form';

export const metadata: Metadata = {
  title: 'Accept invitation',
  description: 'Set your first EaseIt password from an invitation.',
  robots: { index: false, follow: false },
};

/** Signed-out page (AU-08 / AU-14); public in `lib/auth-routing.ts`. */
export default function Page() {
  return <AccountLinkForm mode="accept" />;
}
