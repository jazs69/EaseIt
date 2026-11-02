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
  bootFromStorage,
  browserSessionStorage,
  DRAFT_TTL_MS,
  forgetIntent,
  persistAcknowledgement,
  persistIntent,
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
   * The live intent, read synchronously from the ref.
   *
   * =========================================================================
   * `intent` above is React state: it is the value from the last render, and
   * inside a click handler that has just dispatched, it is **stale**. Code
   * deciding whether to put a payment on the wire must not use it.
   *
   * That was a real defect. The network boundary checked the rendered prop,
   * which on the confirm path is always UNRESOLVED, so every Confirm was
   * accepted by the reducer -- attempt incremented, token spent, state moved
   * to IN_FLIGHT and persisted -- and then silently dropped before the
   * request. This exists so that boundary can ask the authority instead.
   *
   * Read it in handlers and effects, never during render (`react-hooks/refs`,
   * and rightly: output that depends on a ref depends on when React chose to
   * re-render).
   * =========================================================================
   */
  peek: () => PaymentIntent | null;
  /**
   * Which recovery generation is live, so the caller can mint into it.
   *
   * 0 is the ordinary primary slot; each acknowledged quarantine advances it.
   * A counter rather than the boolean it replaces, because recovery can
   * happen more than once and each generation needs its own slot -- otherwise
   * a corrupt recovery slot has nowhere to go and gets overwritten.
   */
  generation: number;
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
  /**
   * Boot decides which slot is live before anything else happens — and it
   * decides it in `payment-intent.ts`, not here.
   *
   * =========================================================================
   * `bootFromStorage` is the whole algorithm: classify the primary slot, look
   * for a verified acknowledgement over a corrupt one, promote `#next` only
   * then, and rehydrate from whichever slot won. The order is the safety
   * property and it is documented where it lives.
   *
   * It is not inlined here because this file is not reachable from the unit
   * suite — it is a React hook, and the suite runs under plain Node. While
   * the algorithm lived in this initialiser the only way to test it was to
   * write a second copy of it in the suite, and a test that reimplements its
   * subject passes happily while the two drift apart. An audit found exactly
   * that: every quarantine guarantee rested on a helper that merely resembled
   * the production path.
   *
   * So this is now the binding and nothing else: call it, apply the effect.
   * =========================================================================
   */
  const [boot] = useState<{ intent: PaymentIntent | null; generation: number }>(() => {
    const { transition, slot } = bootFromStorage(
      storage,
      hotelId,
      bookingCode,
      new Date().toISOString(),
      DRAFT_TTL_MS,
    );

    if (transition.effect.type === 'forget') {
      forgetIntent(storage, hotelId, bookingCode, slot.generation);
    }
    if (transition.effect.type === 'persist') persistIntent(storage, transition.effect.intent);

    return { intent: transition.intent, generation: slot.generation };
  });

  /**
   * The ref is for `dispatch`, the state is for render.
   *
   * `dispatch` has to read it synchronously to route a write to the right
   * generation's slot; render cannot touch a ref at all (`react-hooks/refs`,
   * and rightly — output that depends on a ref depends on when React
   * re-rendered). One writer keeps them from diverging: both are set together,
   * from the verified grant's own `generation`, and only when a grant
   * verifies.
   */
  const liveGeneration = useRef<number>(boot.generation);
  const [generationView, setGenerationView] = useState<number>(boot.generation);
  const held = useRef<PaymentIntent | null>(boot.intent);
  const [view, setView] = useState<PaymentIntent | null>(boot.intent);

  const dispatch = useCallback(
    (action: PaymentAction): PaymentEffect => {
      const first = reducePaymentIntent(held.current, action);

      let intent = first.intent;
      let effect = first.effect;

      /**
       * The acknowledgement is applied here, and only a verified write
       * advances the state.
       *
       * `ACKNOWLEDGE_UNREADABLE` deliberately leaves the intent quarantined
       * and asks for this side effect instead. If the write cannot be proven,
       * no `ACKNOWLEDGE_VERIFIED` follows and the booking stays locked — which
       * is the fail-closed behaviour the whole recovery path depends on.
       */
      if (first.effect.type === 'acknowledge') {
        const written = persistAcknowledgement(storage, first.effect.record);
        if (!written) {
          held.current = first.intent;
          setView(first.intent);
          return { type: 'none' };
        }
        /**
         * The new generation comes off the record that was just verified, not
         * from an increment here. One source of truth: the grant says which
         * generation it authorises, and that is the generation writes go to.
         */
        liveGeneration.current = first.effect.record.generation;
        setGenerationView(first.effect.record.generation);
        const lifted = reducePaymentIntent(first.intent, { type: 'ACKNOWLEDGE_VERIFIED' });
        held.current = lifted.intent;
        setView(lifted.intent);
        return lifted.effect;
      }

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
        /**
         * The report names the submission it is about.
         *
         * Read off the intent that was just written, so a durability report
         * can only ever authorise the submission that asked for the write.
         * An ordinary persist — an OUTCOME landing in UNRESOLVED, a coerced
         * rehydrate — carries no token, and the reducer releases nothing for
         * it even though the status may briefly look sendable.
         */
        const waiting = first.effect.intent.pendingSubmission;
        const released = reducePaymentIntent(intent, {
          type: 'DURABILITY',
          durability,
          ...(waiting === null ? {} : { submission: waiting }),
        });
        intent = released.intent;
        if (released.effect.type !== 'none') effect = released.effect;
      } else if (first.effect.type === 'forget') {
        forgetIntent(storage, hotelId, bookingCode, liveGeneration.current);
      }

      held.current = intent;
      setView(intent);
      return effect;
    },
    [storage, hotelId, bookingCode],
  );

  /**
   * Stable across renders, so a handler closing over it always reaches the
   * current ref rather than a snapshot of it.
   */
  const peek = useCallback(() => held.current, []);

  return { intent: view, dispatch, peek, generation: generationView };
}
