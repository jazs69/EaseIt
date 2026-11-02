/**
 * The payment intent protocol, as a pure state machine.
 *
 * ===========================================================================
 * **No React, no fetch, no storage, no clock.** The key and the current time
 * arrive as action inputs, so every transition is deterministic and can be
 * asserted without a browser. That is the whole reason this file exists
 * separately from `folio-view.tsx`: the rules below are about money, and in a
 * repository with no frontend test framework the only way to get them
 * executably tested is to make them a function.
 *
 * `test/unit/payment-intent.test.mjs` imports this file directly — Node strips
 * the types — and runs inside `pnpm gate`, so it executes on every pull
 * request. That imposes one constraint: **erasable syntax only.** No `enum`,
 * no `namespace`, no parameter properties, and every type import written as
 * `import type`.
 *
 * WHAT PROBLEM THIS SOLVES
 *
 * `folio_line.idempotencyKey` under `folio_line_propertyId_idempotencyKey_key`
 * already makes the server refuse a duplicate payment. But that only helps if
 * the client *presents the same key again*, and the first implementation
 * minted the key inside the posting sheet, so closing and reopening the sheet
 * after a lost response produced a new key — and a second payment. A folio
 * line is immutable (CLAUDE.md section 3.4), so that duplicate cannot be
 * edited away; worse, check-out refuses a balance that is non-zero *in either
 * direction*, so a duplicate leaves the guest in credit and unable to leave.
 *
 * THE TWO RULES EVERYTHING ELSE FOLLOWS FROM
 *
 *   1. **A key is cleared only when the payment is known to be recorded.**
 *      Not on an edit, not on a conflict, not on expiry, not on a storage
 *      failure. There is deliberately no action that abandons an unresolved
 *      intent, because "the clerk clicked a button" is not evidence that an
 *      in-flight request failed to commit.
 *
 *   2. **What was sent is frozen.** The snapshot taken at the first submit is
 *      what every later confirmation resends. A retry that changed the amount
 *      would be a different payment wearing the same reference, which is the
 *      one thing the server cannot disambiguate for us.
 *
 * The absence of an intent *is* the settled state: there is no `SETTLED`
 * status, because a payment that is recorded needs no reference kept. That
 * also makes "no new payment while one is unresolved" structural rather than
 * enforced — `OPEN_SHEET` mints a key only when there is nothing there.
 *
 * WHAT THIS DOES **NOT** PREVENT
 *
 * This is client-side state, so its reach ends where the browser's does. It
 * does not prevent every duplicate payment, and nobody should read it as
 * though it does:
 *
 *   * **Closing the tab, or the browser, loses an unresolved intent.**
 *     `sessionStorage` dies with the tab. A clerk whose response was lost, who
 *     then closes the tab and comes back, gets a clean form: the key is gone,
 *     a new one is minted, and the same money can be taken twice.
 *   * **A second tab is a second intent.** `sessionStorage` is per-tab, so two
 *     tabs on the same folio hold two references and can post two payments.
 *     (`localStorage` would stop that and introduce a worse failure: two
 *     *deliberate* payments in two tabs colliding on one reference and being
 *     refused, which a front desk cannot interpret.)
 *   * **A corrupt blob loses the key**, because that is what corrupt means.
 *     What survives is the *fact* that a reference existed. That now puts the
 *     booking into QUARANTINED: nothing is written to the corrupt slot, no
 *     payment can be submitted, and the only way out is the clerk reading the
 *     ledger and explicitly accepting the duplicate risk. The acknowledgement
 *     is an attestation, not proof that the earlier attempt failed.
 *
 * All three are closed only by moving the intent server-side — a
 * `PaymentIntent` record the server can list for a folio, so recovery works
 * after a crash, in another tab, on another device, or for the next clerk on
 * shift. That is on the production hardening backlog and deliberately not
 * built here: it needs a model, a migration, endpoints, a reaper for abandoned
 * intents, and its own test suite, and it would be the wrong shape to guess at
 * before payments become multi-step (a gateway, 3-D Secure, a hosted link).
 *
 * What this *does* close is the reachable, frequent case: retry in place,
 * double-click, sheet closed and reopened, and a reload of the same tab.
 * ===========================================================================
 */

import type { PaymentMethod } from '@repo/types';

/** Every state an intent can be in. Settled is represented by `null`. */
export type PaymentIntentStatus =
  /** Typed but never sent. The only editable state. */
  | 'DRAFT'
  /** A request is in flight. The sheet is not dismissible. */
  | 'IN_FLIGHT'
  /** Sent, outcome unknown. Frozen. Confirm or reconcile. */
  | 'UNRESOLVED'
  /** A by-key read is in flight. Frozen, and writes nothing. */
  | 'RECONCILING'
  /** The key is attached to a materially different payment. Frozen. */
  | 'CONFLICTED'
  /**
   * Storage held something for this booking that could not be read.
   *
   * =========================================================================
   * The reference is gone, so nothing here can be reconciled — and that is
   * precisely why this is a state rather than a warning.
   *
   * An earlier attempt may have committed. We cannot ask the server, because
   * asking means presenting a key and we no longer have one; fabricating one,
   * or reading a `found: false` from a key that never existed, would
   * manufacture false reassurance about money. So the only instrument is a
   * human reading the ledger, and the only exit is their explicit, recorded
   * acknowledgement.
   *
   * Nothing is written to the corrupt slot while this state holds, which is
   * what preserves the evidence. `key` is null here and **only** here; the two
   * effects that need one (`post`, `read`) are unreachable from this state.
   * =========================================================================
   */
  | 'QUARANTINED';

/**
 * Exactly what was sent, frozen at the first submit.
 *
 * `folioId` is nullable because the first payment on a booking is addressed by
 * booking code and the server opens the folio — `folio.folioId` is
 * `string | null` for precisely that reason. A null here therefore means "the
 * folio did not exist yet", and reconciliation must not treat the folio the
 * server went on to create as a mismatch.
 */
export type PaymentSnapshot = {
  folioId: string | null;
  /** Positive minor units, as the clerk typed it. Stored negative. */
  amountMinor: number;
  method: PaymentMethod;
  /** Cosmetic: the server treats it as immaterial, and so do we. */
  remark: string | null;
};

export type PaymentIntent = {
  /**
   * The idempotency key. Immutable for the life of the intent.
   *
   * Null **only** in QUARANTINED, where there is no reference to carry. Every
   * effect that needs a key is unreachable from that state, so no caller has
   * to invent one.
   */
  key: string | null;
  status: PaymentIntentStatus;
  /** Page identity, so a stored blob cannot be read on the wrong booking. */
  hotelId: string;
  bookingCode: string;
  /** Immutable once frozen. Null only in DRAFT. */
  snapshot: PaymentSnapshot | null;
  createdAt: string;
  attemptedAt: string | null;
  attempts: number;
  /** Which state the in-flight request was sent from. Decides where a
   *  definitive 4xx may return to, and nothing else. */
  submittedFrom: 'DRAFT' | 'UNRESOLVED' | null;
  /** Measured by reading back what was written — never assumed. */
  durability: 'persisted' | 'memory-only' | 'unknown';
  /** Set when a by-key read found nothing. Changes the copy, not the rules. */
  lastReconcile: 'not-found' | 'failed' | null;
  /** Developer-facing. Never shown to a clerk. */
  lastConflictFields: string[] | null;
  /** The server's last definitive refusal, for the escalation panel. */
  lastFailure: { code: string; message: string } | null;
  /**
   * Which recovery generation this intent belongs to, and therefore which
   * slot it is written to.
   *
   * =========================================================================
   * A counter, not a boolean, because recovery can happen more than once.
   *
   * 0 is the ordinary primary slot. Each acknowledged quarantine advances it
   * by one, and generation `n` lives in its own slot, so **every** corrupt
   * generation is left byte-for-byte where it was. The boolean this replaces
   * could only express "primary" or "the one recovery slot", which is why a
   * corrupt `#next` had nowhere to go: the acknowledgement that escaped the
   * primary promoted `#next` permanently, so an unreadable `#next` read as an
   * empty booking, `OPEN_SHEET` minted a fresh key over the top of it, and a
   * second payment went out while the first was still unaccounted for.
   * =========================================================================
   */
  generation: number;
  /**
   * When the clerk opened the ledger during recovery. Null until they do.
   *
   * Deliberately not persisted: a reload resets it, so the cheap step repeats
   * and the consequential one — the acknowledgement — is never assumed.
   */
  ledgerOpenedAt: string | null;
  /** Why this intent is quarantined, for the panel. Null when it is not. */
  quarantine: QuarantineReason | null;
  /**
   * The one submission whose durability report may release a POST.
   *
   * =========================================================================
   * A token, not a boolean, because `status === 'IN_FLIGHT'` is not specific
   * enough to authorise a network request.
   *
   * `DURABILITY` used to release a POST for *any* in-flight intent. That was
   * safe only by accident -- it held because `SUBMIT` and `CONFIRM` happen to
   * be the only transitions that persist while leaving the status IN_FLIGHT,
   * an invariant nothing asserted and any future transition could break. A
   * duplicate durability callback was equally free to release a second POST.
   *
   * So a submission now names itself. `SUBMIT` and `CONFIRM` mint a token,
   * `DURABILITY` must present the matching one, and the token is spent the
   * moment it is answered. A report that names nothing, names a token that was
   * already spent, or names a different submission records the measured
   * durability and releases nothing.
   * =========================================================================
   */
  pendingSubmission: string | null;
};

/**
 * Why a stored value could not be trusted.
 *
 * `ours` means the blob names this booking and this property but will not
 * parse. `unidentified` means it is non-empty, will not parse, and does not
 * legibly name any booking — which is the more dangerous of the two, because
 * it could be this booking's. Both quarantine; only the copy differs.
 */
export type QuarantineReason = 'ours' | 'unidentified';

/* -------------------------------------------------------------------------- */
/*  Outcomes                                                                  */
/* -------------------------------------------------------------------------- */

export type PaymentOutcome =
  | { kind: 'settled' }
  | {
      kind: 'ambiguous';
      reason:
        'unreachable' | 'server-error' | 'unreadable-success' | 'transaction-conflict' | 'unknown';
    }
  | { kind: 'conflict'; differing: string[] }
  | { kind: 'definitive-failure'; code: string; message: string };

/**
 * What the by-key read said.
 *
 * `found` is an authoritative, property-scoped read of the committed row — and
 * `not-found` is a statement about **this moment only**. It does not prove
 * that an earlier in-flight request can never commit, which is why it changes
 * the copy and never the rules: the key and the snapshot are kept either way.
 */
export type ReconcileOutcome =
  | { kind: 'found'; folioId: string; amountMinor: number; method: string }
  | { kind: 'not-found' }
  | { kind: 'failed' };

/**
 * Maps a caught throwable onto an outcome.
 *
 * ===========================================================================
 * Duck-typed on purpose, so this module imports nothing from the app.
 *
 * `ApiUnreachableError` and `ApiRequestError` both set `this.name`, so the
 * distinction survives without importing either — which is what lets the unit
 * suite exercise this table without a module graph behind it.
 *
 * The ordering matters. `api.ts` builds an `INTERNAL_ERROR` for a response
 * whose *body* failed to parse, carrying the original 2xx status — so the
 * transaction committed and only the reply was unreadable. That has to be
 * caught before any status-range branch, because a 2xx there must never be
 * read as success-with-no-work-to-do.
 * ===========================================================================
 */
export function classifyOutcome(caught: unknown): PaymentOutcome {
  if (caught === null || typeof caught !== 'object') {
    return { kind: 'ambiguous', reason: 'unknown' };
  }

  const error = caught as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    message?: unknown;
  };

  // No response at all: the request may or may not have reached the server.
  if (error.name === 'ApiUnreachableError') {
    return { kind: 'ambiguous', reason: 'unreachable' };
  }

  const status = typeof error.status === 'number' ? error.status : null;
  const code = typeof error.code === 'string' ? error.code : null;
  const message = typeof error.message === 'string' ? error.message : '';

  // Not one of the API errors — a bug, a parse failure, anything. Fail safe.
  if (status === null || code === null) {
    return { kind: 'ambiguous', reason: 'unknown' };
  }

  // A 2xx whose body this client could not read. The payment committed.
  if (code === 'INTERNAL_ERROR' && status >= 200 && status < 300) {
    return { kind: 'ambiguous', reason: 'unreadable-success' };
  }

  // The key belongs to a different payment. Never retryable as-is.
  if (code === 'IDEMPOTENCY_KEY_REUSED') {
    return { kind: 'conflict', differing: [] };
  }

  // Contended row or a lock timeout: "unknown, ask again" — which Confirm is.
  if (code === 'CONFLICT') {
    return { kind: 'ambiguous', reason: 'transaction-conflict' };
  }

  // The server answered failure, but a commit followed by a failed reply is
  // indistinguishable from no commit at all.
  if (status >= 500) {
    return { kind: 'ambiguous', reason: 'server-error' };
  }

  // A response arrived and refused before any write.
  return { kind: 'definitive-failure', code, message };
}

/** Pulls `details.differing` off an ApiRequestError, without importing it. */
export function conflictFields(caught: unknown): string[] {
  if (caught === null || typeof caught !== 'object') return [];
  const details = (caught as { details?: unknown }).details;
  if (details === null || typeof details !== 'object') return [];
  const differing = (details as { differing?: unknown }).differing;
  if (!Array.isArray(differing)) return [];
  return differing.filter((entry): entry is string => typeof entry === 'string');
}

/* -------------------------------------------------------------------------- */
/*  Actions and effects                                                       */
/* -------------------------------------------------------------------------- */

export type PaymentAction =
  | {
      type: 'OPEN_SHEET';
      hotelId: string;
      bookingCode: string;
      key: string;
      now: string;
      /**
       * Which recovery generation to mint into. Defaults to 0, the primary.
       *
       * The caller holds this because only the caller has seen storage: boot
       * walked the generations and knows which one is live.
       */
      generation?: number;
    }
  | { type: 'SUBMIT'; snapshot: PaymentSnapshot; now: string }
  | { type: 'CONFIRM'; now: string }
  | { type: 'RECONCILE' }
  | { type: 'OUTCOME'; outcome: PaymentOutcome; differing?: string[] }
  | { type: 'RECONCILED'; outcome: ReconcileOutcome }
  | {
      type: 'DURABILITY';
      durability: 'persisted' | 'memory-only';
      /**
       * Which submission this report is about.
       *
       * Required to release a POST. The hook reads it off the intent it just
       * wrote, so a report can only ever authorise the submission that asked
       * for the write.
       */
      submission?: string;
    }
  /** Step 1 of recovery: the clerk opened the authoritative ledger. */
  | { type: 'OPEN_LEDGER'; now: string }
  /** Step 2: the clerk accepted the duplicate risk in so many words. */
  | { type: 'ACKNOWLEDGE_UNREADABLE'; now: string }
  /** Step 3: the acknowledgement was written AND read back intact. */
  | { type: 'ACKNOWLEDGE_VERIFIED' }
  | {
      type: 'REHYDRATE';
      stored: unknown;
      hotelId: string;
      bookingCode: string;
      now: string;
      draftTtlMs: number;
      /**
       * The classification of the **primary** slot, when the caller has
       * already made it.
       *
       * `resolveLiveSlot` does, because it also has to walk the generations —
       * a decision that needs storage access the reducer must not have.
       * Omitted, `stored` is classified here, which is what a direct unit
       * check does.
       */
      classification?: StoredClassification;
      /**
       * Which generation `stored` was read from. Defaults to 0.
       *
       * There is deliberately **no** flag for "the quarantine is spent". It
       * used to exist, and it was the defect: it let a caller tell the reducer
       * to ignore corruption, and the one caller that did so passed it for
       * every generation above the primary — so a corrupt `#next` was read as
       * an empty booking. Corruption in the live slot now quarantines
       * unconditionally, whichever generation it is. Escaping it is the
       * **walk's** job, and the walk only advances past a corrupt slot when a
       * verified acknowledgement names that exact slot.
       */
      generation?: number;
    };

export type PaymentEffect =
  /** Nothing to do. Also the answer to every rejected action. */
  | { type: 'none' }
  /** Write the intent, read it back, then report DURABILITY. */
  | { type: 'persist'; intent: PaymentIntent }
  /**
   * Send the payment. Carries the frozen snapshot, never form state.
   *
   * `durability` is always `'persisted'` -- it is in the payload so the
   * network boundary can assert it rather than trust that this effect was only
   * constructed on the durable path.
   */
  | { type: 'post'; key: string; snapshot: PaymentSnapshot; durability: 'persisted' }
  /**
   * The request was NOT sent, and will not be, because the reference could not
   * be stored durably.
   *
   * The key and the intent survive for this session -- nothing is replaced and
   * nothing is invented -- but no request goes out, because a payment whose
   * reference was never written is one a lost response makes untraceable. The
   * clerk is told, in words they can act on.
   */
  | { type: 'blocked'; reason: 'not-durable'; message: string }
  /** Read the committed row for this key. Writes nothing. */
  | { type: 'read'; key: string }
  /** Remove the stored intent. Only ever follows a settled payment. */
  | { type: 'forget' }
  /**
   * Write the acknowledgement record, read it back, and verify it.
   *
   * The hook reports success by dispatching `ACKNOWLEDGE_VERIFIED`. A write
   * that throws, is silently discarded, or reads back differently reports
   * nothing — so the state stays QUARANTINED and no payment can be taken.
   * Failing closed is the whole point of routing this through an effect rather
   * than letting the reducer assume the write worked.
   */
  | { type: 'acknowledge'; record: AcknowledgementRecord };

/**
 * What the clerk's acknowledgement records.
 *
 * Scoped by property and booking so a record cannot be mistaken for another
 * folio's, versioned so a future recovery protocol can refuse an old one, and
 * carrying both timestamps so the order of the two steps is auditable. Nothing
 * else: no guest detail, no amount, no staff identity beyond what the server's
 * own audit log already holds.
 */
export type AcknowledgementRecord = {
  /**
   * Protocol version. **2** since recovery became generational.
   *
   * A `v: 1` record carried no generation and no source slot, so it could only
   * be read as "escape the primary, forever" -- which is precisely the
   * open-ended grant that let a corrupt `#next` be treated as an empty
   * booking. Version 1 is therefore **rejected**, not migrated. The only way a
   * live tab can hold one is if it recovered under the old build and was then
   * reloaded into this one, and the consequence of refusing is a quarantine
   * the clerk acknowledges again -- which fails closed and costs one extra
   * ledger check. Accepting it would fail open.
   */
  v: 2;
  hotelId: string;
  bookingCode: string;
  /**
   * The generation this record authorises. Always >= 1.
   *
   * Recorded explicitly rather than inferred from the slot it sits in, so a
   * record moved or copied between slots authorises nothing.
   */
  generation: number;
  /**
   * The exact slot whose corruption this record escapes.
   *
   * The binding that makes a grant specific. An acknowledgement is a clerk
   * saying "I have read the ledger and accept the risk of a duplicate **for
   * this unreadable value**". That statement cannot carry over to a different
   * unreadable value that appeared later -- which is exactly what the previous
   * protocol let it do.
   */
  fromSlot: string;
  acknowledgedAt: string;
  ledgerOpenedAt: string;
};

export type PaymentTransition = {
  intent: PaymentIntent | null;
  effect: PaymentEffect;
  /** True only when the action was not a legal transition. */
  rejected: boolean;
};

const NOTHING: PaymentEffect = { type: 'none' };

/**
 * What the clerk is told when the reference could not be saved.
 *
 * Actionable and specific: it says the money was **not** taken, which is the
 * one fact they need before deciding what to do next, and it names the cause
 * rather than blaming them. Exported so the sheet and the reducer cannot drift
 * into telling two different stories.
 */
export const NOT_DURABLE_MESSAGE =
  'This payment was not sent. The browser could not save the payment reference, ' +
  'and sending without one risks collecting twice if the reply is lost. ' +
  'Check that private browsing is off and storage is not full, then try again.';

/**
 * Names one submission, so its durability report cannot authorise another.
 *
 * `key` plus the attempt number: the key is immutable for the life of the
 * intent and `attempts` increments on every submit and every confirm, so the
 * pair is unique per submission without needing a clock or a random source --
 * which also keeps the reducer total and the suite deterministic.
 */
function submissionToken(key: string, attempts: number): string {
  return `${key}#${String(attempts)}`;
}

function keep(intent: PaymentIntent | null): PaymentTransition {
  return { intent, effect: NOTHING, rejected: true };
}

/** The only states in which amount and method may be edited. */
export function isFormEditable(intent: PaymentIntent | null): boolean {
  return intent !== null && intent.status === 'DRAFT';
}

/**
 * The one guard every payment submission path consults.
 *
 * ===========================================================================
 * Allow-list, not deny-list, and it rejects `null`.
 *
 * The previous shape enumerated the states that block, which meant a new
 * state defaulted to *permitted* — and `isFormEditable(null)` returning true
 * was exactly that bug: after a corrupt blob the intent was null, the form was
 * editable, and a payment went out under a brand-new key with the evidence
 * already overwritten.
 *
 * So the question is inverted: only a live DRAFT may be submitted. QUARANTINED,
 * IN_FLIGHT, UNRESOLVED, RECONCILING, CONFLICTED and `null` are all refused,
 * and any state added later is refused until somebody decides otherwise.
 * ===========================================================================
 */
export function blocksPaymentSubmission(intent: PaymentIntent | null): boolean {
  return intent === null || intent.status !== 'DRAFT';
}

/**
 * The last gate before the network: may this effect actually be sent?
 *
 * ===========================================================================
 * Asks the **live** intent, not a render snapshot. That distinction was a
 * real, browser-reproduced defect.
 *
 * `folio-view.tsx` used to check the `intent` **prop** here, which is the
 * value from the last render. On the submit path that happens to be a DRAFT,
 * so it passed. On the **confirm** path the rendered intent is always
 * UNRESOLVED -- the panel the clerk is looking at when they press the button
 * -- so the check refused every single time. The reducer had already accepted
 * `CONFIRM`, incremented the attempt, minted and spent the submission token,
 * moved to IN_FLIGHT and persisted; then the request was silently dropped and
 * the intent stranded IN_FLIGHT with no outcome ever dispatched. Confirm, the
 * only way out of an unresolved payment, could not send at all.
 *
 * So the guard now takes the live intent as an argument and lives here, where
 * the unit suite can reach it. A guard that cannot be tested is not a guard,
 * and this one was wrong in production while the suite was green.
 *
 * It is strictly **tighter** than what it replaces, not looser:
 *
 *   * the effect must be a `post` -- the only effect the reducer builds after
 *     the submission token matched and was spent;
 *   * it must carry `durability: 'persisted'`, so a reference that was not
 *     proven on disk still cannot be sent;
 *   * the live intent must exist and be IN_FLIGHT -- DRAFT is no longer
 *     accepted here, because by the time an effect exists the machine has
 *     already moved on, and a stale callback arriving after a settle finds
 *     `null`;
 *   * the live key must be the effect's key, so a late effect from an earlier
 *     submission cannot ride a newer intent.
 * ===========================================================================
 */
export function mayDispatchPost(effect: PaymentEffect, live: PaymentIntent | null): boolean {
  if (effect.type !== 'post') return false;
  // Never send a payment whose reference was not proven on disk.
  if (effect.durability !== 'persisted') return false;
  if (live === null) return false;
  // Only an in-flight submission has an outstanding request to make.
  if (live.status !== 'IN_FLIGHT') return false;
  // The effect must belong to the intent that is actually in flight.
  if (live.key === null || live.key !== effect.key) return false;
  return true;
}

/** True while an intent must be resolved before anything else may be posted. */
export function blocksNewPayment(intent: PaymentIntent | null): boolean {
  return (
    intent !== null &&
    (intent.status === 'UNRESOLVED' ||
      intent.status === 'CONFLICTED' ||
      intent.status === 'RECONCILING' ||
      intent.status === 'IN_FLIGHT' ||
      intent.status === 'QUARANTINED')
  );
}

/** Does a committed line match what this intent actually sent? */
export function matchesSnapshot(
  snapshot: PaymentSnapshot,
  found: { folioId: string; amountMinor: number; method: string },
): boolean {
  /**
   * The folio is compared only when the intent recorded one.
   *
   * A first payment is addressed by booking code and the server opens the
   * folio, so the intent's `folioId` is null and the committed line names a
   * folio that did not exist when it was sent. Treating that as a mismatch
   * would push a perfectly ordinary first payment into CONFLICTED.
   */
  if (snapshot.folioId !== null && snapshot.folioId !== found.folioId) return false;
  if (snapshot.amountMinor !== found.amountMinor) return false;
  return snapshot.method === found.method;
}

/* -------------------------------------------------------------------------- */
/*  The reducer                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Total, synchronous and side-effect free.
 *
 * Every illegal action returns the state unchanged with `rejected: true`
 * rather than throwing: a reducer that throws in a click handler takes the
 * screen with it, and the screen is where the clerk reads what to do next.
 */
export function reducePaymentIntent(
  current: PaymentIntent | null,
  action: PaymentAction,
): PaymentTransition {
  switch (action.type) {
    /* ------------------------------------------------------------------ */
    case 'OPEN_SHEET': {
      /**
       * An existing intent is handed back untouched — no new key, no write.
       *
       * This is where "a new payment cannot begin before the previous one is
       * reconciled" actually lives. It is one branch rather than a guard
       * scattered across the UI, which is why it cannot be forgotten.
       *
       * This is also what stops a corrupt slot being overwritten. A quarantine
       * *is* an intent, so this branch returns it and emits no `persist`,
       * which means `setItem` is never called on the slot holding the
       * unreadable bytes. The guarantee is one branch, not a special case
       * somewhere else that could be forgotten.
       */
      if (current !== null) return { intent: current, effect: NOTHING, rejected: false };

      const minted: PaymentIntent = {
        key: action.key,
        status: 'DRAFT',
        hotelId: action.hotelId,
        bookingCode: action.bookingCode,
        snapshot: null,
        createdAt: action.now,
        attemptedAt: null,
        attempts: 0,
        submittedFrom: null,
        durability: 'unknown',
        lastReconcile: null,
        lastConflictFields: null,
        lastFailure: null,
        generation: action.generation ?? 0,
        ledgerOpenedAt: null,
        quarantine: null,
        pendingSubmission: null,
      };
      return { intent: minted, effect: { type: 'persist', intent: minted }, rejected: false };
    }

    /* ------------------------------------------------------------------ */
    case 'SUBMIT': {
      // Only a draft may be submitted with new values. A frozen intent that
      // receives a SUBMIT is a bug in the caller, and silently accepting it
      // would replace the snapshot — the one thing rule 2 forbids.
      if (current === null || current.status !== 'DRAFT') return keep(current);
      // Unreachable: a DRAFT always carries a key. Checked rather than
      // asserted, because the alternative is a token built from `null`.
      if (current.key === null) return keep(current);

      const attempts = current.attempts + 1;
      const next: PaymentIntent = {
        ...current,
        status: 'IN_FLIGHT',
        snapshot: action.snapshot,
        attemptedAt: action.now,
        attempts,
        submittedFrom: 'DRAFT',
        lastReconcile: null,
        lastFailure: null,
        // Only a DURABILITY report presenting this token may send the request.
        pendingSubmission: submissionToken(current.key, attempts),
      };
      /**
       * `persist` and not `post`.
       *
       * The hook must write the intent, read it back and report DURABILITY
       * *before* the request goes out, so a crash between the two leaves a
       * recoverable reference rather than an untraceable payment. The POST is
       * emitted by the DURABILITY transition below.
       */
      return { intent: next, effect: { type: 'persist', intent: next }, rejected: false };
    }

    /* ------------------------------------------------------------------ */
    case 'CONFIRM': {
      // Confirm resends the frozen snapshot under the original key. Available
      // only from UNRESOLVED: from CONFLICTED it is deterministically refused
      // by the server, so offering it would teach the desk to ignore errors.
      if (current === null || current.status !== 'UNRESOLVED') return keep(current);
      if (current.snapshot === null) return keep(current);
      // Same reasoning as SUBMIT: there is nothing to resend under a null key.
      if (current.key === null) return keep(current);

      const resend = current.attempts + 1;
      const next: PaymentIntent = {
        ...current,
        status: 'IN_FLIGHT',
        attempts: resend,
        submittedFrom: 'UNRESOLVED',
        lastFailure: null,
        pendingSubmission: submissionToken(current.key, resend),
      };
      return { intent: next, effect: { type: 'persist', intent: next }, rejected: false };
    }

    /* ------------------------------------------------------------------ */
    case 'DURABILITY': {
      if (current === null) return keep(current);

      /**
       * The key and the snapshot are copied across untouched.
       *
       * A storage failure must never replace a reference after a request has
       * been sent, so this transition carries the measured durability and
       * nothing else. It is also the gate that releases the POST, which is how
       * the persist-then-send ordering is enforced rather than hoped for.
       */
      const next: PaymentIntent = { ...current, durability: action.durability };

      /**
       * Is this report about the submission that is actually waiting?
       *
       * =================================================================
       * Four ways to answer no, and all of them release nothing.
       *
       * The report names no submission (an ordinary persist — OUTCOME
       * landing in UNRESOLVED, a coerced rehydrate — which has no request
       * to send); the intent is waiting for nothing; or the token names a
       * different submission, which is what a duplicate or stale callback
       * looks like once the first one has been answered.
       *
       * The measured durability is still recorded, because it is true and
       * the panel says so. Only the POST is withheld.
       * =================================================================
       */
      const awaited =
        next.pendingSubmission !== null &&
        action.submission !== undefined &&
        action.submission === next.pendingSubmission;

      if (!awaited) return { intent: next, effect: NOTHING, rejected: false };

      /**
       * The token is spent here, on both branches.
       *
       * Answered is answered: a second report carrying the same token finds
       * `pendingSubmission === null` and cannot release a second request for
       * one submission. This is the line that makes "exactly one POST per
       * submission" a property of the state machine.
       */
      const settled: PaymentIntent = { ...next, pendingSubmission: null };

      /**
       * A POST is released only when the reference is **proven** to be on
       * disk.
       *
       * ===================================================================
       * This used to send on `memory-only`, deliberately, so that a clerk in
       * a private window was never unable to take money. That trade was
       * wrong, and the asymmetry is why: a payment sent with no stored
       * reference is fine until the reply is lost, and then it is
       * unrecoverable — there is no key to reconcile with, no by-key read
       * to perform, and the only remaining instrument is a human comparing
       * ledgers. The cost of refusing is one retry; the cost of sending is a
       * possible silent double collection.
       *
       * A failed `setItem`, a `setItem` that silently discarded, a store
       * that truncated what it was given, and a `getItem` that threw all
       * arrive here as `memory-only`, because `persistIntent` cannot tell
       * them apart and does not need to.
       *
       * The key is **kept**. Nothing is replaced, nothing is invented, and
       * the quarantine is not touched: the intent returns to the state it
       * was submitted from, carrying the same reference, so the retry is the
       * same payment rather than a new one.
       * ===================================================================
       */
      if (
        action.durability !== 'persisted' ||
        settled.status !== 'IN_FLIGHT' ||
        settled.snapshot === null ||
        settled.key === null
      ) {
        // Where a refusal returns to, by the same rule a definitive 4xx
        // follows: a confirm still has an unaccounted-for attempt behind it,
        // so it must not be handed back an editable form.
        const landing: PaymentIntentStatus =
          settled.submittedFrom === 'UNRESOLVED' ? 'UNRESOLVED' : 'DRAFT';
        const blocked: PaymentIntent = {
          ...settled,
          status: landing,
          submittedFrom: null,
          snapshot: landing === 'DRAFT' ? null : settled.snapshot,
          lastFailure: { code: 'STORAGE_NOT_DURABLE', message: NOT_DURABLE_MESSAGE },
        };
        return {
          intent: blocked,
          effect: { type: 'blocked', reason: 'not-durable', message: NOT_DURABLE_MESSAGE },
          rejected: false,
        };
      }

      return {
        intent: settled,
        effect: {
          type: 'post',
          key: settled.key,
          snapshot: settled.snapshot,
          durability: 'persisted',
        },
        rejected: false,
      };
    }

    /* ------------------------------------------------------------------ */
    case 'OPEN_LEDGER': {
      // Step 1. Only meaningful while quarantined, and it records a fact
      // rather than granting anything.
      if (current === null || current.status !== 'QUARANTINED') return keep(current);
      return {
        intent: { ...current, ledgerOpenedAt: current.ledgerOpenedAt ?? action.now },
        effect: NOTHING,
        rejected: false,
      };
    }

    /* ------------------------------------------------------------------ */
    case 'ACKNOWLEDGE_UNREADABLE': {
      /**
       * Step 2. Refused unless the ledger was actually opened first.
       *
       * The order is enforced here rather than in the UI, so no handler can
       * acknowledge on the clerk's behalf. The state does **not** change yet:
       * the acknowledgement is only real once it has been written and read
       * back, which is the next action.
       */
      if (current === null || current.status !== 'QUARANTINED') return keep(current);
      if (current.ledgerOpenedAt === null) return keep(current);

      /**
       * The record names the generation it grants and the slot it escapes.
       *
       * `fromSlot` is the slot this intent is quarantined **over** -- its own
       * generation -- and the grant is for the next one. So a clerk's
       * acceptance of risk is bound to the specific unreadable value they
       * checked the ledger for, and cannot be re-used when a later generation
       * is corrupted in turn.
       */
      if (current.generation + 1 > MAX_RECOVERY_GENERATIONS) return keep(current);

      return {
        intent: current,
        effect: {
          type: 'acknowledge',
          record: {
            v: 2,
            hotelId: current.hotelId,
            bookingCode: current.bookingCode,
            generation: current.generation + 1,
            fromSlot: slotForGeneration(
              current.hotelId,
              current.bookingCode,
              current.generation,
            ),
            acknowledgedAt: action.now,
            ledgerOpenedAt: current.ledgerOpenedAt,
          },
        },
        rejected: false,
      };
    }

    /* ------------------------------------------------------------------ */
    case 'ACKNOWLEDGE_VERIFIED': {
      /**
       * Step 3. The record is on disk and reads back intact.
       *
       * Only now does the quarantine lift, and it lifts to *nothing* — not to
       * a DRAFT. The clerk still has to open the sheet, which mints a key into
       * the `#next` slot and leaves the corrupt primary alone for good.
       *
       * A write that threw, was discarded, or read back differently never
       * produces this action, so the booking simply stays quarantined. That is
       * the fail-closed path, and it is why this is a separate transition
       * rather than something `ACKNOWLEDGE_UNREADABLE` assumed.
       */
      if (current === null || current.status !== 'QUARANTINED') return keep(current);
      return { intent: null, effect: NOTHING, rejected: false };
    }

    /* ------------------------------------------------------------------ */
    case 'RECONCILE': {
      if (current === null) return keep(current);
      if (current.status !== 'UNRESOLVED' && current.status !== 'CONFLICTED') {
        return keep(current);
      }
      /**
       * No key, no read.
       *
       * Unreachable from QUARANTINED because of the status check above, and
       * asserted anyway: a by-key lookup needs a key, and the one thing that
       * must never happen on this path is presenting a fabricated one — or
       * reading a `found: false` from a key that never existed and treating it
       * as evidence that no payment was taken.
       */
      if (current.key === null) return keep(current);
      return {
        intent: { ...current, status: 'RECONCILING' },
        effect: { type: 'read', key: current.key },
        rejected: false,
      };
    }

    /* ------------------------------------------------------------------ */
    case 'OUTCOME': {
      // Only an in-flight request can produce one. A stale response arriving
      // after the state moved on is dropped here rather than overwriting it.
      if (current === null || current.status !== 'IN_FLIGHT') return keep(current);

      const outcome = action.outcome;

      if (outcome.kind === 'settled') {
        // The only transition that clears a key.
        return { intent: null, effect: { type: 'forget' }, rejected: false };
      }

      if (outcome.kind === 'ambiguous') {
        const next: PaymentIntent = {
          ...current,
          status: 'UNRESOLVED',
          submittedFrom: null,
          lastReconcile: null,
          // The request is answered, however ambiguously. Nothing is waiting
          // on a durability report any more.
          pendingSubmission: null,
        };
        return { intent: next, effect: { type: 'persist', intent: next }, rejected: false };
      }

      if (outcome.kind === 'conflict') {
        const next: PaymentIntent = {
          ...current,
          status: 'CONFLICTED',
          submittedFrom: null,
          lastConflictFields: action.differing ?? outcome.differing,
          pendingSubmission: null,
        };
        return { intent: next, effect: { type: 'persist', intent: next }, rejected: false };
      }

      /**
       * A definitive refusal, and where it lands depends on where it came
       * from. This asymmetry is the whole correction.
       *
       * From DRAFT: the server answered and refused before any write, so
       * nothing was committed and the form may reopen — with the **same** key,
       * which is pristine and cheaper to keep than to churn.
       *
       * From UNRESOLVED: this attempt wrote nothing either, but it says
       * nothing whatever about the *earlier* attempt that is still unaccounted
       * for. Returning to DRAFT here would be an escape hatch wearing a 4xx.
       * Repeated definitive failures from UNRESOLVED — a closed folio, a
       * withdrawn permission, an expired session that keeps expiring — are a
       * supervisor's problem, not a reason to abandon the reference.
       */
      const landing: PaymentIntentStatus =
        current.submittedFrom === 'UNRESOLVED' ? 'UNRESOLVED' : 'DRAFT';
      const next: PaymentIntent = {
        ...current,
        status: landing,
        submittedFrom: null,
        snapshot: landing === 'DRAFT' ? null : current.snapshot,
        lastFailure: { code: outcome.code, message: outcome.message },
        pendingSubmission: null,
      };
      return { intent: next, effect: { type: 'persist', intent: next }, rejected: false };
    }

    /* ------------------------------------------------------------------ */
    case 'RECONCILED': {
      // A stale read landing after Confirm moved the intent on must not undo
      // it, and must certainly not clear a newer reference.
      if (current === null || current.status !== 'RECONCILING') return keep(current);
      if (current.snapshot === null) return keep(current);

      const outcome = action.outcome;

      if (outcome.kind === 'found') {
        if (matchesSnapshot(current.snapshot, outcome)) {
          // Established as recorded, by reading rather than by writing.
          return { intent: null, effect: { type: 'forget' }, rejected: false };
        }
        const conflicted: PaymentIntent = {
          ...current,
          status: 'CONFLICTED',
          lastReconcile: null,
          lastConflictFields: differingFrom(current.snapshot, outcome),
        };
        return {
          intent: conflicted,
          effect: { type: 'persist', intent: conflicted },
          rejected: false,
        };
      }

      /**
       * Not found, or the read itself failed.
       *
       * Both return to UNRESOLVED with the key and the snapshot intact.
       * `not-found` is a statement about the instant of the read: it says no
       * committed line is visible *now*, not that the original request can
       * never commit. So it changes what the clerk is told and nothing else.
       */
      const next: PaymentIntent = {
        ...current,
        status: 'UNRESOLVED',
        lastReconcile: outcome.kind === 'not-found' ? 'not-found' : 'failed',
      };
      return { intent: next, effect: { type: 'persist', intent: next }, rejected: false };
    }

    /* ------------------------------------------------------------------ */
    case 'REHYDRATE': {
      const verdict =
        action.classification ??
        classifyStored(action.stored, action.hotelId, action.bookingCode);

      /**
       * An unreadable live slot quarantines the booking. Unconditionally.
       *
       * ===================================================================
       * This is the transition the whole feature turns on.
       *
       * `corrupt` covers both the blob that legibly names this booking and
       * the one that names nobody. The second is the dangerous one and it
       * blocks too: unidentifiable means *possibly ours*, and an early
       * version treating it as an empty slot is exactly how a payment went
       * out under a fresh key with the evidence overwritten.
       *
       * `foreign` deliberately does **not** quarantine. A readable record for
       * another folio sitting in this slot is the key scoping working, not
       * corruption, and locking this booking over it would be gratuitous.
       *
       * There is **no exception for a completed recovery**, and that is the
       * fix. The previous version took an `acknowledged` flag and skipped
       * this branch when it was set -- so once the primary had been escaped,
       * corruption in the recovery slot read as an empty booking. The
       * quarantine is per **generation** now: whichever slot the walk handed
       * in, if it cannot be read, the booking stops here. Escaping it needs a
       * fresh acknowledgement naming this slot.
       * ===================================================================
       */
      if (verdict.kind === 'corrupt') {
        const quarantined: PaymentIntent = {
          key: null,
          status: 'QUARANTINED',
          hotelId: action.hotelId,
          bookingCode: action.bookingCode,
          snapshot: null,
          createdAt: action.now,
          attemptedAt: null,
          attempts: 0,
          submittedFrom: null,
          durability: 'unknown',
          lastReconcile: null,
          lastConflictFields: null,
          lastFailure: null,
          // The generation it is quarantined over -- which is what the
          // acknowledgement will name as its source slot.
          generation: action.generation ?? 0,
          ledgerOpenedAt: null,
          quarantine: verdict.reason,
          pendingSubmission: null,
        };
        // No `persist`: nothing may be written while the evidence stands.
        return { intent: quarantined, effect: NOTHING, rejected: false };
      }

      const stored =
        verdict.kind === 'valid'
          ? verdict.intent
          : parseStoredIntent(action.stored, action.hotelId, action.bookingCode);

      if (stored === null) return { intent: null, effect: NOTHING, rejected: false };

      /**
       * A draft that was never sent is the only thing age may discard.
       *
       * There is nothing to reconcile: no request ever left the browser. Every
       * other state has an outstanding question about money, and a timer is
       * not an answer to it — an UNRESOLVED intent from last week still
       * greets whoever opens that folio, which is correct.
       */
      // Which generation it came from has to survive the round trip, or a
      // post-recovery intent would be written back to a corrupt slot.
      const placed: PaymentIntent = { ...stored, generation: action.generation ?? 0 };

      if (placed.status === 'DRAFT') {
        const age = Date.parse(action.now) - Date.parse(placed.createdAt);
        if (!Number.isFinite(age) || age > action.draftTtlMs) {
          return { intent: null, effect: { type: 'forget' }, rejected: false };
        }
        return { intent: placed, effect: NOTHING, rejected: false };
      }

      /**
       * A persisted IN_FLIGHT means the tab died mid-request.
       *
       * Whether it committed is exactly the open question UNRESOLVED exists
       * for, so it is coerced rather than trusted. This is the one normalising
       * transition on rehydrate, and it fails safe.
       */
      if (placed.status === 'IN_FLIGHT' || placed.status === 'RECONCILING') {
        const coerced: PaymentIntent = {
          ...placed,
          status: 'UNRESOLVED',
          submittedFrom: null,
          // A reload is a new session: whatever was waiting on a durability
          // report in the dead tab is not waiting here, and this persist must
          // not release a POST for a request that may already have been sent.
          pendingSubmission: null,
        };
        return { intent: coerced, effect: { type: 'persist', intent: coerced }, rejected: false };
      }

      return { intent: placed, effect: NOTHING, rejected: false };
    }

    /**
     * An action this build does not recognise keeps the state.
     *
     * TypeScript makes this unreachable, and it is here anyway: the unit suite
     * asserts that *no* action abandons an unresolved intent, and without a
     * default an unknown one returned `undefined` and took the screen with it.
     * A reducer over money should degrade to "nothing happened", never to a
     * crash and never to a cleared reference.
     */
    default:
      return keep(current);
  }
}

/**
 * What is actually in the slot, decided conservatively.
 *
 * ===========================================================================
 * Four answers, not two, because "cannot read it" and "it is not mine" need
 * opposite responses.
 *
 * The first version of this asked one question — does the raw text contain
 * both identifiers? — and answered *no* for anything mangled past
 * recognition. That failed **open**: an unidentifiable blob was treated as an
 * empty slot, so a payment went out under a fresh key while the unreadable
 * record was overwritten. The dangerous case was the one it dismissed.
 *
 * So:
 *
 *   * `empty`        — nothing there. Normal operation.
 *   * `valid`        — parses and names this booking. Normal operation.
 *   * `foreign`      — parses and names a **different** booking or property.
 *                      Not quarantined: a readable record for somebody else's
 *                      folio is the slot scoping working, not corruption, and
 *                      locking this booking over it would be gratuitous.
 *   * `corrupt`      — non-empty and unreadable. Quarantined either way; the
 *                      `reason` only changes what the clerk is told. `ours`
 *                      when the bytes legibly name this booking,
 *                      `unidentified` when they name nothing legible — which
 *                      is treated as *possibly ours* and therefore blocks.
 * ===========================================================================
 */
export type StoredClassification =
  | { kind: 'empty' }
  | { kind: 'valid'; intent: PaymentIntent }
  | { kind: 'foreign' }
  | { kind: 'corrupt'; reason: QuarantineReason };

/**
 * Does the raw text carry this exact `"field":"value"` pair?
 *
 * ===========================================================================
 * Whitespace is stripped and the match is an exact substring — no regex is
 * built from a string, deliberately.
 *
 * Two earlier attempts here were wrong in the same invisible way. In a
 * template literal **and** in an ordinary quoted string, `\s` is an
 * unrecognised escape and collapses to a bare `s`, so the pattern compiled to
 * `"hotelId"s*:s*"31001"` and matched nothing. It typechecked, it linted, and
 * it failed **open**: an unreadable blob would have been classified as
 * somebody else's problem and quietly overwritten.
 *
 * Removing the whitespace first makes the comparison a plain `includes`, which
 * has no escaping semantics to get wrong, needs no pattern escaping of the
 * value, and is strictly more robust than the regex it replaces. The one regex
 * left is a *literal*, where escapes behave.
 * ===========================================================================
 */
function namesField(raw: string, field: string, value: string): boolean {
  const compact = raw.replace(/\s+/g, '');
  return compact.includes('"' + field + '":"' + value + '"');
}

/** Does it name *some* booking, just not this one? */
function namesAnotherBooking(raw: string, hotelId: string, bookingCode: string): boolean {
  const hotel = /"hotelId"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
  const booking = /"bookingCode"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
  if (hotel === undefined || booking === undefined) return false;
  return hotel !== hotelId || booking !== bookingCode;
}

export function classifyStored(
  raw: unknown,
  hotelId: string,
  bookingCode: string,
): StoredClassification {
  if (raw === null || raw === undefined) return { kind: 'empty' };
  if (typeof raw !== 'string') {
    // Only a string can come out of web storage; anything else is a caller
    // bug, and guessing which way to fail is worse than failing closed.
    return { kind: 'corrupt', reason: 'unidentified' };
  }
  if (raw.trim().length === 0) return { kind: 'empty' };

  const intent = parseStoredIntent(raw, hotelId, bookingCode);
  if (intent !== null) return { kind: 'valid', intent };

  /**
   * It did not validate. Did it at least *parse*, and name somebody?
   *
   * A blob that parses cleanly and names another booking is readable data in
   * the wrong slot — reported as foreign so this booking is not locked over
   * it. Anything else is unreadable, and unreadable blocks.
   */
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    parsed = undefined;
  }

  if (parsed !== null && typeof parsed === 'object') {
    const blob = parsed as Record<string, unknown>;
    const hotel = blob['hotelId'];
    const booking = blob['bookingCode'];
    if (typeof hotel === 'string' && typeof booking === 'string') {
      if (hotel !== hotelId || booking !== bookingCode) return { kind: 'foreign' };
      // Names us, but failed validation: ours and unreadable.
      return { kind: 'corrupt', reason: 'ours' };
    }
    // Parses but identifies nobody. Could be ours.
    return { kind: 'corrupt', reason: 'unidentified' };
  }

  // Did not parse at all. Fall back to reading identity out of the raw text.
  if (namesField(raw, 'hotelId', hotelId) && namesField(raw, 'bookingCode', bookingCode)) {
    return { kind: 'corrupt', reason: 'ours' };
  }
  if (namesAnotherBooking(raw, hotelId, bookingCode)) {
    // Legibly somebody else's, even though truncated. Not this booking's
    // problem, and not grounds for locking it.
    return { kind: 'foreign' };
  }
  return { kind: 'corrupt', reason: 'unidentified' };
}

/** Which material fields a committed line disagrees with. Developer-facing. */
function differingFrom(
  snapshot: PaymentSnapshot,
  found: { folioId: string; amountMinor: number; method: string },
): string[] {
  const fields: string[] = [];
  if (snapshot.folioId !== null && snapshot.folioId !== found.folioId) fields.push('folioId');
  if (snapshot.amountMinor !== found.amountMinor) fields.push('amountMinor');
  if (snapshot.method !== found.method) fields.push('method');
  return fields;
}

/* -------------------------------------------------------------------------- */
/*  Reading a stored blob                                                     */
/* -------------------------------------------------------------------------- */

const STATUSES: readonly PaymentIntentStatus[] = [
  'DRAFT',
  'IN_FLIGHT',
  'UNRESOLVED',
  'RECONCILING',
  'CONFLICTED',
];

const KEY_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

function isStatus(value: unknown): value is PaymentIntentStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

function parseSnapshot(value: unknown): PaymentSnapshot | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  const folioId = raw['folioId'];
  const amountMinor = raw['amountMinor'];
  const method = raw['method'];
  const remark = raw['remark'];

  if (folioId !== null && typeof folioId !== 'string') return null;
  if (typeof amountMinor !== 'number' || !Number.isInteger(amountMinor) || amountMinor <= 0) {
    return null;
  }
  if (typeof method !== 'string' || method.length === 0) return null;
  if (remark !== null && typeof remark !== 'string') return null;

  return {
    folioId: folioId as string | null,
    amountMinor,
    method: method as PaymentMethod,
    remark: remark as string | null,
  };
}

/**
 * Validates a stored blob, returning null rather than throwing.
 *
 * ===========================================================================
 * Identity is checked against the page, not just the slot key.
 *
 * The blob carries its own `hotelId` and `bookingCode` and both must match the
 * folio being viewed. The slot key already encodes them, so this is belt and
 * braces — and it is the braces that matter: a mismatched blob is the one way
 * a reference could be presented on the wrong guest's bill, and the cost of
 * ruling it out is two comparisons.
 *
 * Anything malformed is treated as absent. A corrupt blob must not be able to
 * crash the folio page, and it must not be able to resurrect a half-readable
 * reference either — an intent whose key or snapshot cannot be trusted is
 * worse than none, because Confirm would send something nobody chose.
 * ===========================================================================
 */
export function parseStoredIntent(
  raw: unknown,
  hotelId: string,
  bookingCode: string,
): PaymentIntent | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== 'object') return null;

  const blob = value as Record<string, unknown>;

  const key = blob['key'];
  if (typeof key !== 'string' || !KEY_SHAPE.test(key)) return null;
  if (!isStatus(blob['status'])) return null;
  if (blob['hotelId'] !== hotelId || blob['bookingCode'] !== bookingCode) return null;

  const createdAt = blob['createdAt'];
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) return null;

  const status = blob['status'];
  const snapshot = status === 'DRAFT' ? null : parseSnapshot(blob['snapshot']);
  // Every state but DRAFT must carry what it sent; without it Confirm has
  // nothing to resend and reconciliation nothing to compare.
  if (status !== 'DRAFT' && snapshot === null) return null;

  const attemptedAt = blob['attemptedAt'];
  const attempts = blob['attempts'];
  const conflict = blob['lastConflictFields'];
  const failure = blob['lastFailure'];
  const reconcile = blob['lastReconcile'];

  return {
    key,
    status,
    hotelId,
    bookingCode,
    snapshot,
    createdAt,
    attemptedAt: typeof attemptedAt === 'string' ? attemptedAt : null,
    attempts:
      typeof attempts === 'number' && Number.isInteger(attempts) && attempts >= 0 ? attempts : 0,
    submittedFrom: null,
    // Never read from the blob: durability describes *this* browser's storage
    // right now, and the only honest source is a fresh read-back.
    durability: 'unknown',
    lastReconcile: reconcile === 'not-found' || reconcile === 'failed' ? reconcile : null,
    lastConflictFields: Array.isArray(conflict)
      ? conflict.filter((entry): entry is string => typeof entry === 'string')
      : null,
    lastFailure:
      failure !== null && typeof failure === 'object'
        ? readFailure(failure as Record<string, unknown>)
        : null,
    /**
     * Slot placement is decided by the caller, which knows which generation it
     * read from; a stored value cannot be trusted to say where it lives.
     */
    generation: 0,
    // Never restored: a reload must re-walk step 1 of recovery.
    ledgerOpenedAt: null,
    // QUARANTINED is derived on boot and never persisted, so a parsed record
    // is by definition not quarantined.
    quarantine: null,
    /**
     * Never restored from storage, and that is load-bearing.
     *
     * A token read back out of a blob would let a stored intent authorise a
     * POST that no live submission asked for -- and a persisted IN_FLIGHT
     * intent is exactly the shape that would carry one. A submission belongs
     * to the tab that made it.
     */
    pendingSubmission: null,
  };
}

function readFailure(raw: Record<string, unknown>): { code: string; message: string } | null {
  const code = raw['code'];
  const message = raw['message'];
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  return { code, message };
}

/* -------------------------------------------------------------------------- */
/*  The storage adapter                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Kept here rather than in the React hook, for two reasons.
 *
 * It takes its store as an argument, so it is as pure as everything above it —
 * and it is reachable from the unit suite, which matters more: a read-back that
 * silently stopped verifying would be invisible to review and is exactly the
 * thing requirement 6 turns on. `use-payment-intent.ts` is then nothing but the
 * React binding.
 */

/** The two methods this needs, so a test can supply a fake. */
export type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

/**
 * Writes, then reads back and compares.
 *
 * A `setItem` that throws and a `setItem` that silently discards are both
 * failures, and only the read-back distinguishes either from success. The
 * comparison is on the serialised form, so a storage that truncates or
 * re-encodes is caught too.
 */
export function persistIntent(
  storage: StorageLike | null,
  intent: PaymentIntent,
): 'persisted' | 'memory-only' {
  if (storage === null) return 'memory-only';

  /**
   * A quarantine is never written.
   *
   * It is derived on boot from whatever is in the slot, so persisting it would
   * at best be redundant and at worst overwrite the very bytes it exists to
   * protect. Belt and braces: the reducer already emits no `persist` for it.
   */
  if (intent.status === 'QUARANTINED') return 'memory-only';

  /**
   * The slot comes from the intent, so a post-recovery write cannot land on
   * the corrupt primary.
   */
  const slot = slotFor(intent);
  const serialised = JSON.stringify(intent);

  try {
    storage.setItem(slot, serialised);
  } catch {
    return 'memory-only';
  }

  try {
    return storage.getItem(slot) === serialised ? 'persisted' : 'memory-only';
  } catch {
    return 'memory-only';
  }
}

/**
 * Writes the acknowledgement, reads it back, and verifies it.
 *
 * ===========================================================================
 * Fails closed, and says so by returning false.
 *
 * `setItem` can throw in a private window and can silently discard under
 * quota, so neither the absence of an exception nor the absence of an error
 * means the record is there. The only trustworthy signal is reading it back
 * and finding the same bytes — and then parsing those bytes with the same
 * validator the boot path uses, so a store that re-encodes or truncates on the
 * way in is caught too.
 *
 * A false return leaves the booking quarantined. That costs the clerk a
 * deliberate re-attempt; it never costs the evidence and never permits a
 * silent second collection.
 * ===========================================================================
 */
export function persistAcknowledgement(
  storage: StorageLike | null,
  record: AcknowledgementRecord,
): boolean {
  if (storage === null) return false;

  if (!Number.isInteger(record.generation) || record.generation < 1) return false;
  if (record.generation > MAX_RECOVERY_GENERATIONS) return false;

  const slot = ackSlotForGeneration(record.hotelId, record.bookingCode, record.generation);
  const serialised = JSON.stringify(record);

  try {
    storage.setItem(slot, serialised);
  } catch {
    return false;
  }

  let readBack: string | null;
  try {
    readBack = storage.getItem(slot);
  } catch {
    return false;
  }
  if (readBack !== serialised) return false;

  /**
   * And it must still validate as a grant for **this** generation, escaping
   * **this** slot.
   *
   * Re-parsed through the same validator the boot walk uses, with the same
   * arguments the walk will supply, so a store that re-encoded or truncated on
   * the way in is caught -- and so is a record whose generation or source slot
   * does not match what was asked for.
   */
  return (
    parseAcknowledgement(
      readBack,
      record.hotelId,
      record.bookingCode,
      record.generation,
      record.fromSlot,
    ) !== null
  );
}

/** The verified acknowledgement for this booking, or null. */
/**
 * The verified grant for one generation, escaping one specific slot, or null.
 *
 * Both `generation` and `fromSlot` are **required**, because a grant that is
 * not tied to the corruption it escapes is the defect this protocol exists to
 * fix. The caller is the boot walk, which knows exactly which slot it is stuck
 * on and which generation it wants to advance to.
 */
export function readAcknowledgement(
  storage: StorageLike | null,
  hotelId: string,
  bookingCode: string,
  generation: number,
  fromSlot: string,
): AcknowledgementRecord | null {
  if (storage === null) return null;
  try {
    return parseAcknowledgement(
      storage.getItem(ackSlotForGeneration(hotelId, bookingCode, generation)),
      hotelId,
      bookingCode,
      generation,
      fromSlot,
    );
  } catch {
    return null;
  }
}

/** Reads whichever slot is live for this booking. */
export function readSlot(storage: StorageLike | null, slot: string): string | null {
  if (storage === null) return null;
  try {
    return storage.getItem(slot);
  } catch {
    return null;
  }
}

export function forgetIntent(
  storage: StorageLike | null,
  hotelId: string,
  bookingCode: string,
  generation = 0,
): void {
  if (storage === null) return;
  try {
    // Only ever the live generation's slot. No earlier generation is ever
    // removed, so a settled payment after recovery clears the slot it was
    // made in and leaves every piece of evidence behind it intact.
    storage.removeItem(slotForGeneration(hotelId, bookingCode, generation));
  } catch {
    // A storage that cannot forget is not a reason to fail the payment that
    // just succeeded. The stale blob is rejected on rehydrate anyway, because
    // a SETTLED intent is never written.
  }
}

export function readStoredIntent(
  storage: StorageLike | null,
  hotelId: string,
  bookingCode: string,
): string | null {
  if (storage === null) return null;
  try {
    return storage.getItem(intentStorageKey(hotelId, bookingCode));
  } catch {
    return null;
  }
}

/** `window.sessionStorage`, or null wherever it is not reachable. */
export function browserSessionStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage;
  } catch {
    // Accessing the property itself throws when site data is blocked.
    return null;
  }
}

/**
 * The slot a booking's intent lives in. Property-scoped.
 *
 * ===========================================================================
 * Three keys, and the corrupt one is never written to.
 *
 * A quarantine that copied the bad value aside and cleared the original could
 * lose it two ways: the copy write fails silently — `persistIntent` below
 * exists because `setItem` can both throw *and* quietly discard — or the clear
 * lands before the copy is verified. So nothing is copied and nothing is
 * cleared. The corrupt bytes stay exactly where they are, under their own key,
 * and it is the **new** data that relocates: `#ack` for the acknowledgement,
 * `#next` for every intent after it.
 *
 * The consequence is that no write failure can destroy the evidence. The only
 * writes are to `#ack` and `#next`, and a failure there leaves the booking
 * quarantined — which costs a deliberate re-attempt and never a silent second
 * collection.
 * ===========================================================================
 */
export function intentStorageKey(hotelId: string, bookingCode: string): string {
  return `easeit.payment-intent.${hotelId}.${bookingCode}`;
}

/**
 * How many times one booking may be recovered in one tab.
 *
 * ===========================================================================
 * A bound, because the walk below reads its own stopping condition out of
 * storage.
 *
 * Each generation costs a human: a ledger check and a recorded acceptance of
 * risk. Eight is far beyond anything a real shift produces, and corruption
 * repeating eight times is a browser to stop using rather than a workflow to
 * support. Exhausting it quarantines at the last generation, which fails
 * closed -- a bound that failed open would be worse than no bound.
 * ===========================================================================
 */
export const MAX_RECOVERY_GENERATIONS = 8;

/**
 * The slot one generation's intent lives in.
 *
 * ===========================================================================
 * Generation 0 is the primary slot; generation `n` is its own slot.
 *
 * A quarantine that copied the bad value aside and cleared the original could
 * lose it two ways: the copy write fails silently -- `persistIntent` exists
 * because `setItem` can both throw *and* quietly discard -- or the clear lands
 * before the copy is verified. So nothing is ever copied and nothing is ever
 * cleared. Corrupt bytes stay exactly where they are, under their own key, and
 * it is the **new** data that relocates forward.
 *
 * The consequence, now true at every generation rather than only the first: no
 * write failure can destroy evidence, because the only slot ever written is
 * one the walk has already found readable or empty.
 *
 * Generation 1 is spelled `#next` rather than `#next1` so the keys a tab
 * already holds keep their meaning across a reload into this build.
 * ===========================================================================
 */
export function slotForGeneration(
  hotelId: string,
  bookingCode: string,
  generation: number,
): string {
  const base = intentStorageKey(hotelId, bookingCode);
  if (!Number.isInteger(generation) || generation <= 0) return base;
  return generation === 1 ? `${base}#next` : `${base}#next${String(generation)}`;
}

/**
 * Where the grant for one generation is recorded.
 *
 * Indexed by the generation it **authorises**, so each grant has its own slot
 * and acknowledging a later corruption cannot overwrite the record of an
 * earlier one. Generation 1 keeps the original `#ack` spelling.
 */
export function ackSlotForGeneration(
  hotelId: string,
  bookingCode: string,
  generation: number,
): string {
  const base = intentStorageKey(hotelId, bookingCode);
  return generation === 1 ? `${base}#ack` : `${base}#ack${String(generation)}`;
}

/** Where the clerk's first recovery acknowledgement is recorded. */
export function acknowledgementStorageKey(hotelId: string, bookingCode: string): string {
  return ackSlotForGeneration(hotelId, bookingCode, 1);
}

/** Where intents live once the first quarantine has been acknowledged. */
export function recoveredIntentStorageKey(hotelId: string, bookingCode: string): string {
  return slotForGeneration(hotelId, bookingCode, 1);
}

/** The slot this intent belongs in, from the generation it carries. */
export function slotFor(intent: PaymentIntent): string {
  return slotForGeneration(intent.hotelId, intent.bookingCode, intent.generation);
}

/**
 * Reads a grant, rejecting anything that is not demonstrably this booking's,
 * for this generation, escaping this slot.
 *
 * ===========================================================================
 * Five ways to refuse, and each one of them, accepted, would unlock a payment
 * on evidence that does not say what it is being read as saying:
 *
 *   * not version 2 -- including a `v: 1` record, which carried no generation
 *     and no source slot and therefore granted an open-ended escape;
 *   * naming another property or booking;
 *   * naming a different generation than the one being asked for;
 *   * naming a different source slot than the corruption actually being
 *     escaped -- the binding that stops a grant for one unreadable value being
 *     spent on another that appeared later;
 *   * half-written, or carrying a timestamp that will not parse.
 * ===========================================================================
 */
export function parseAcknowledgement(
  raw: unknown,
  hotelId: string,
  bookingCode: string,
  generation: number,
  fromSlot: string,
): AcknowledgementRecord | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;

  const blob = parsed as Record<string, unknown>;
  if (blob['v'] !== 2) return null;
  if (blob['hotelId'] !== hotelId || blob['bookingCode'] !== bookingCode) return null;
  if (blob['generation'] !== generation) return null;
  if (blob['fromSlot'] !== fromSlot) return null;

  const acknowledgedAt = blob['acknowledgedAt'];
  const ledgerOpenedAt = blob['ledgerOpenedAt'];
  if (typeof acknowledgedAt !== 'string' || !Number.isFinite(Date.parse(acknowledgedAt))) {
    return null;
  }
  if (typeof ledgerOpenedAt !== 'string' || !Number.isFinite(Date.parse(ledgerOpenedAt))) {
    return null;
  }

  return { v: 2, hotelId, bookingCode, generation, fromSlot, acknowledgedAt, ledgerOpenedAt };
}

/* -------------------------------------------------------------------------- */
/*  Boot: which slot is live, and what is in it                                */
/* -------------------------------------------------------------------------- */

/** Which generation boot settled on, what is in it, and how it got there. */
export type LiveSlot = {
  /** The raw contents of the live slot. */
  raw: string | null;
  /** The generation the walk stopped at. 0 is the primary slot. */
  generation: number;
  /** The live slot's storage key. */
  slot: string;
  /** What the live slot holds. */
  verdict: StoredClassification;
  /**
   * True when the walk stopped **because** the live slot is unreadable and no
   * grant escapes it. The booking is quarantined at `generation`.
   */
  quarantined: boolean;
  /** True when the walk advanced past at least one acknowledged corruption. */
  recovered: boolean;
  /** Every generation the walk escaped, in order, with its slot. Audit trail. */
  escaped: readonly { generation: number; slot: string }[];
  /** What the **primary** slot holds, whichever generation won. */
  primary: StoredClassification;
};

/**
 * Walks the recovery generations and decides which slot is live.
 *
 * ===========================================================================
 * A loop, not a branch, because recovery can happen more than once.
 *
 * Start at generation 0 and ask one question per generation: can this slot be
 * read?
 *
 *   * **Not corrupt** (empty, valid, or a readable record for somebody else) --
 *     stop. This is the live slot. `foreign` stops here deliberately: a
 *     readable record for another folio is the key scoping working, not
 *     corruption, and locking this booking over it would be gratuitous.
 *   * **Corrupt** -- is there a grant for the *next* generation that names
 *     *this exact slot* as the one it escapes? If so, advance. If not, stop
 *     here and quarantine.
 *
 * The old version was this loop with the trip count fixed at one, and that was
 * the defect. A grant naming no generation and no source slot could only mean
 * "escape the primary, forever", so once the first recovery was done a corrupt
 * `#next` had nowhere to go: it was read as an empty booking, `OPEN_SHEET`
 * minted a fresh key over the top of it, and a second payment went out while
 * the first was still unaccounted for. Binding each grant to one generation
 * and one slot is what makes the loop terminate honestly instead of falling
 * through.
 *
 * The order within a generation is the safety property and it has not changed:
 * classify the slot *first*, and only then look for a grant. Reading the next
 * generation's slot first would let a stale post-recovery intent unlock a
 * booking whose grant had been cleared; treating the existence of a later slot
 * as proof of recovery would do the same.
 *
 * This lives here, not in the hook, so the unit suite can drive the **real**
 * algorithm against a fake store. It used to live in `use-payment-intent.ts`,
 * where the only way to test it was to reimplement it in the suite -- and a
 * test that reimplements its subject passes happily while the two drift apart.
 * ===========================================================================
 */
export function resolveLiveSlot(
  storage: StorageLike | null,
  hotelId: string,
  bookingCode: string,
): LiveSlot {
  const escaped: { generation: number; slot: string }[] = [];
  let primary: StoredClassification | null = null;

  for (let generation = 0; generation <= MAX_RECOVERY_GENERATIONS; generation += 1) {
    const slot = slotForGeneration(hotelId, bookingCode, generation);
    const raw = readSlot(storage, slot);
    const verdict = classifyStored(raw, hotelId, bookingCode);
    if (generation === 0) primary = verdict;

    const settled = {
      raw,
      generation,
      slot,
      verdict,
      recovered: generation > 0,
      escaped,
      primary: primary ?? verdict,
    };

    // Readable, or legibly somebody else's. Either way the walk ends here.
    if (verdict.kind !== 'corrupt') return { ...settled, quarantined: false };

    /**
     * Unreadable. The walk may only continue on a grant that names this
     * generation's successor *and* this slot as the thing it escapes.
     *
     * At the bound, `readAcknowledgement` is not even consulted: there is no
     * generation left to advance to, so the answer is quarantine.
     */
    const next = generation + 1;
    const grant =
      next > MAX_RECOVERY_GENERATIONS
        ? null
        : readAcknowledgement(storage, hotelId, bookingCode, next, slot);

    if (grant === null) return { ...settled, quarantined: true };

    escaped.push({ generation, slot });
  }

  /**
   * Unreachable: the loop returns on every path. Present because a walk over
   * storage-controlled data that fell out of its loop without an answer would
   * be the one shape that could produce an unquarantined corrupt booking.
   */
  const last = slotForGeneration(hotelId, bookingCode, MAX_RECOVERY_GENERATIONS);
  return {
    raw: readSlot(storage, last),
    generation: MAX_RECOVERY_GENERATIONS,
    slot: last,
    verdict: { kind: 'corrupt', reason: 'unidentified' },
    quarantined: true,
    recovered: true,
    escaped,
    primary: primary ?? { kind: 'corrupt', reason: 'unidentified' },
  };
}

/**
 * The whole boot: walk to the live generation, then rehydrate from it.
 *
 * Returns the transition rather than applying it, so it stays free of React
 * and the caller decides what to do with the effect. The hook is then nothing
 * but the binding, and this function is what the suite exercises.
 */
export function bootFromStorage(
  storage: StorageLike | null,
  hotelId: string,
  bookingCode: string,
  now: string,
  draftTtlMs: number,
): { transition: PaymentTransition; slot: LiveSlot } {
  const slot = resolveLiveSlot(storage, hotelId, bookingCode);

  const transition = reducePaymentIntent(null, {
    type: 'REHYDRATE',
    stored: slot.raw,
    hotelId,
    bookingCode,
    now,
    draftTtlMs,
    // The classification the walk already made, for the slot it settled on --
    // so the reducer does not redo it and cannot reach a different answer.
    classification: slot.verdict,
    generation: slot.generation,
  });

  return { transition, slot };
}

/** A draft nobody submitted is forgotten after one long shift. */
export const DRAFT_TTL_MS = 12 * 60 * 60 * 1000;
