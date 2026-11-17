'use client';

import { useState, useTransition } from 'react';
import { Button } from '@repo/ui';

import { payForBooking } from '../../actions';

/** Sends the guest to Razorpay for the balance; the payment posts to the folio when captured. */
export function PayButton({
  slug,
  code,
  access,
  existingUrl,
}: {
  slug: string;
  code: string;
  access: string;
  existingUrl: string | null;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const pay = () => {
    if (existingUrl !== null) {
      window.location.assign(existingUrl);
      return;
    }
    setError(null);
    start(async () => {
      const result = await payForBooking(slug, code, access);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const url = result.value.payment?.url;
      if (url) window.location.assign(url);
      else setError('Online payment is not available just now. You can pay at the hotel.');
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <Button className="w-fit" disabled={pending} onClick={pay}>
        {pending ? 'Opening payment…' : 'Pay now'}
      </Button>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
