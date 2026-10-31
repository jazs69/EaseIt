'use client';

/**
 * The payment intent, persisted and wired to React.
 *
 * ===========================================================================
 * Two layers, and the intent says which ones it actually has.
 *
 *   1. **Component state in `FolioView`**, which does not unmount when the
 *      posting sheet closes and survives `router.refresh()` — the folio page
 *      is deliberately built so a server re-render replaces data without
 *      remounting (`folio-view.tsx` tags local state with the prop it came
 *      from for exactly that reason).
 *   2. **`sessionStorage`**, which survives a reload of the same tab.
 *
 * `sessionStorage` and not `localStorage`: a payment reference should die with
 * the tab. Sharing one across tabs would stop two tabs duplicating a payment,
 * but would then make two *deliberate* payments in two tabs collide on one
 * reference and be refused — trading a rare duplicate for a regular refusal a
 * clerk cannot interpret. The wrong trade for a front desk.
 *
 * Keyed by booking code, not folio id, because `folio.folioId` is
 * `string | null` until the first payment opens the folio — a folio-keyed slot
 * would miss precisely the first payment.
 *
 * **Durability is measured, never assumed.** `setItem` can throw in a private
 * window and can silently no-op under quota pressure, so every write is read
 * back and compared. The verdict reaches the reducer as `DURABILITY`, the UI
 * says so where the consequence is real, and a failed write never replaces the
 * key or blocks the payment. Degradation is the loss of one layer, stated
 * plainly.
 *
 * **Persist before POST.** `SUBMIT` and `CONFIRM` return a `persist` effect;
 * only the `DURABILITY` transition that follows it emits `post`. So a crash
 * between the two leaves a recoverable reference rather than an untraceable
 * payment, and a storage failure can never swap a key after a request has gone
 * out. The ordering is in the reducer, not in a comment.
 *
 * Mirrors the wrapping discipline of `reports/master-report/use-column-preference.ts`,
 * which is this repository's established pattern for browser storage.
 * ===========================================================================
 */

import { useCallback, useRef, useState } from 'react';

import {
  browserSessionStorage,
  DRAFT_TTL_MS,
  forgetIntent,
  persistIntent,
  readStoredIntent,
  reducePaymentIntent,
  type PaymentAction,
  type PaymentEffect,
  type PaymentIntent,
  type StorageLike,
} from './payment-intent';

export type PaymentIntentApi = {
  intent: PaymentIntent | null;
  /** Runs the action, applies its storage effect, and returns the effect. */
  dispatch: (action: PaymentAction) => PaymentEffect;
  /**
   * A reference was stored for this booking and could not be read.
   *
   * Sticky for the life of the page: the key is gone, so nothing the clerk
   * does here can answer the question it raises, and quietly dropping the
   * warning would put them back where they started.
   */
  storedUnreadable: boolean;
};

/**
 * Holds the intent for one booking.
 *
 * Lives in `FolioView` rather than the posting sheet, which is the whole
 * point: the sheet unmounts when it closes and the reference must not.
 *
 * The initialiser rehydrates from storage, so a reload of the same tab comes
 * back to the same reference. `REHYDRATE` is the only place age is considered,
 * and it may retire a draft that was never sent — nothing else.
 */
export function usePaymentIntent(
  hotelId: string,
  bookingCode: string,
  storage: StorageLike | null = browserSessionStorage(),
): PaymentIntentApi {
  /**
   * A ref is the authority; state exists only to re-render.
   *
   * =========================================================================
   * The caller needs the effect **synchronously**: it has to know, in the same
   * click handler, whether to POST and with which frozen snapshot. A
   * `useState` updater cannot provide that — it runs later, React may invoke
   * it twice, and reducing inside it would make storage writes and the POST
   * decision depend on render timing. That is precisely the class of race this
   * whole feature exists to eliminate, so it is not somewhere to introduce
   * one.
   *
   * So the ref holds the current intent and every dispatch reduces against it
   * immediately. Only this component dispatches for a given booking, so there
   * is no second writer: a stale response that arrives after the state moved
   * on is rejected by the reducer's own guards (`OUTCOME` requires IN_FLIGHT,
   * `RECONCILED` requires RECONCILING), not by hoping it does not happen.
   * =========================================================================
   */
  /**
   * Rehydration runs once, in a lazy `useState` initialiser.
   *
   * Not in a ref read during render: `react-hooks/refs` rejects that, and
   * rightly — a ref read while rendering is how you get output that depends on
   * whether React decided to re-render. The seed is computed once here and
   * handed to the ref as its initial value, so `held.current` is only ever
   * touched inside `dispatch`.
   */
  const [boot] = useState<{ intent: PaymentIntent | null; unreadable: boolean }>(() => {
    const first = reducePaymentIntent(null, {
      type: 'REHYDRATE',
      stored: readStoredIntent(storage, hotelId, bookingCode),
      hotelId,
      bookingCode,
      now: new Date().toISOString(),
      draftTtlMs: DRAFT_TTL_MS,
    });
    if (first.effect.type === 'forget') forgetIntent(storage, hotelId, bookingCode);
    if (first.effect.type === 'persist') persistIntent(storage, first.effect.intent);
    return { intent: first.intent, unreadable: first.storedUnreadable === true };
  });

  const held = useRef<PaymentIntent | null>(boot.intent);
  const [view, setView] = useState<PaymentIntent | null>(boot.intent);

  const dispatch = useCallback(
    (action: PaymentAction): PaymentEffect => {
      const first = reducePaymentIntent(held.current, action);

      let intent = first.intent;
      let effect = first.effect;

      if (first.effect.type === 'persist') {
        /**
         * Persist, read back, then let the reducer decide what follows.
         *
         * The measured durability goes back in as its own action rather than
         * being written onto the intent here, so the reducer stays the only
         * thing that knows a POST may now be released — which is what makes
         * "persist before send" a property of the state machine instead of a
         * convention this file has to remember.
         */
        const durability = persistIntent(storage, first.effect.intent);
        const released = reducePaymentIntent(intent, { type: 'DURABILITY', durability });
        intent = released.intent;
        if (released.effect.type !== 'none') effect = released.effect;
      } else if (first.effect.type === 'forget') {
        forgetIntent(storage, hotelId, bookingCode);
      }

      held.current = intent;
      setView(intent);
      return effect;
    },
    [storage, hotelId, bookingCode],
  );

  return { intent: view, dispatch, storedUnreadable: boot.unreadable };
}
