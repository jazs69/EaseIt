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
 *     What survives is the *fact* that a reference existed, reported as
 *     `storedUnreadable` so the clerk is told to check the ledger first.
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
  | 'CONFLICTED';

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
  /** The idempotency key. Immutable for the life of the intent. */
  key: string;
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
};

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
  | { type: 'OPEN_SHEET'; hotelId: string; bookingCode: string; key: string; now: string }
  | { type: 'SUBMIT'; snapshot: PaymentSnapshot; now: string }
  | { type: 'CONFIRM'; now: string }
  | { type: 'RECONCILE' }
  | { type: 'OUTCOME'; outcome: PaymentOutcome; differing?: string[] }
  | { type: 'RECONCILED'; outcome: ReconcileOutcome }
  | { type: 'DURABILITY'; durability: 'persisted' | 'memory-only' }
  | {
      type: 'REHYDRATE';
      stored: unknown;
      hotelId: string;
      bookingCode: string;
      now: string;
      draftTtlMs: number;
    };

export type PaymentEffect =
  /** Nothing to do. Also the answer to every rejected action. */
  | { type: 'none' }
  /** Write the intent, read it back, then report DURABILITY. */
  | { type: 'persist'; intent: PaymentIntent }
  /** Send the payment. Carries the frozen snapshot, never form state. */
  | { type: 'post'; key: string; snapshot: PaymentSnapshot }
  /** Read the committed row for this key. Writes nothing. */
  | { type: 'read'; key: string }
  /** Remove the stored intent. Only ever follows a settled payment. */
  | { type: 'forget' };

export type PaymentTransition = {
  intent: PaymentIntent | null;
  effect: PaymentEffect;
  /** True only when the action was not a legal transition. */
  rejected: boolean;
  /**
   * Something was stored for this booking and could not be read.
   *
   * =========================================================================
   * A corrupt blob is NOT the same as an empty slot, and treating it as one
   * was a real hole: the clerk got a clean form with no hint that a reference
   * had existed, and the next thing they would do is take the payment again.
   * The key is unrecoverable either way -- that is what corrupt means -- but
   * the *fact* that a reference existed is recoverable, and it is exactly the
   * fact that should stop someone posting a second payment blind.
   *
   * So this is reported, the slot is deliberately NOT cleared, and the UI
   * tells the clerk to check the ledger first. The warning persists across
   * reloads because the question it raises is still open.
   * =========================================================================
   */
  storedUnreadable?: boolean;
};

const NOTHING: PaymentEffect = { type: 'none' };

function keep(intent: PaymentIntent | null): PaymentTransition {
  return { intent, effect: NOTHING, rejected: true };
}

/** The only states in which amount and method may be edited. */
export function isFormEditable(intent: PaymentIntent | null): boolean {
  return intent === null || intent.status === 'DRAFT';
}

/** True while an intent must be resolved before anything else may be posted. */
export function blocksNewPayment(intent: PaymentIntent | null): boolean {
  return (
    intent !== null &&
    (intent.status === 'UNRESOLVED' ||
      intent.status === 'CONFLICTED' ||
      intent.status === 'RECONCILING' ||
      intent.status === 'IN_FLIGHT')
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
       * An existing intent is handed back untouched — no new key.
       *
       * This is where "a new payment cannot begin before the previous one is
       * reconciled" actually lives. It is one branch rather than a guard
       * scattered across the UI, which is why it cannot be forgotten.
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
      };
      return { intent: minted, effect: { type: 'persist', intent: minted }, rejected: false };
    }

    /* ------------------------------------------------------------------ */
    case 'SUBMIT': {
      // Only a draft may be submitted with new values. A frozen intent that
      // receives a SUBMIT is a bug in the caller, and silently accepting it
      // would replace the snapshot — the one thing rule 2 forbids.
      if (current === null || current.status !== 'DRAFT') return keep(current);

      const next: PaymentIntent = {
        ...current,
        status: 'IN_FLIGHT',
        snapshot: action.snapshot,
        attemptedAt: action.now,
        attempts: current.attempts + 1,
        submittedFrom: 'DRAFT',
        lastReconcile: null,
        lastFailure: null,
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

      const next: PaymentIntent = {
        ...current,
        status: 'IN_FLIGHT',
        attempts: current.attempts + 1,
        submittedFrom: 'UNRESOLVED',
        lastFailure: null,
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

      if (next.status === 'IN_FLIGHT' && next.snapshot !== null) {
        return {
          intent: next,
          effect: { type: 'post', key: next.key, snapshot: next.snapshot },
          rejected: false,
        };
      }
      return { intent: next, effect: NOTHING, rejected: false };
    }

    /* ------------------------------------------------------------------ */
    case 'RECONCILE': {
      if (current === null) return keep(current);
      if (current.status !== 'UNRESOLVED' && current.status !== 'CONFLICTED') {
        return keep(current);
      }
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
        };
        return { intent: next, effect: { type: 'persist', intent: next }, rejected: false };
      }

      if (outcome.kind === 'conflict') {
        const next: PaymentIntent = {
          ...current,
          status: 'CONFLICTED',
          submittedFrom: null,
          lastConflictFields: action.differing ?? outcome.differing,
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
      const stored = parseStoredIntent(action.stored, action.hotelId, action.bookingCode);
      if (stored === null) {
        /**
         * Was the slot empty, or unreadable?
         *
         * `parseStoredIntent` rejects a blob belonging to another booking or
         * property too, and that is not a corruption worth alarming anybody
         * about -- it is the scoping working. So only a non-empty blob whose
         * own identity matches this page, yet which still failed to parse,
         * counts as unreadable.
         */
        const unreadable =
          typeof action.stored === 'string' &&
          action.stored.length > 0 &&
          belongsToThisBooking(action.stored, action.hotelId, action.bookingCode);

        return unreadable
          ? { intent: null, effect: NOTHING, rejected: false, storedUnreadable: true }
          : { intent: null, effect: NOTHING, rejected: false };
      }

      /**
       * A draft that was never sent is the only thing age may discard.
       *
       * There is nothing to reconcile: no request ever left the browser. Every
       * other state has an outstanding question about money, and a timer is
       * not an answer to it — an UNRESOLVED intent from last week still
       * greets whoever opens that folio, which is correct.
       */
      if (stored.status === 'DRAFT') {
        const age = Date.parse(action.now) - Date.parse(stored.createdAt);
        if (!Number.isFinite(age) || age > action.draftTtlMs) {
          return { intent: null, effect: { type: 'forget' }, rejected: false };
        }
        return { intent: stored, effect: NOTHING, rejected: false };
      }

      /**
       * A persisted IN_FLIGHT means the tab died mid-request.
       *
       * Whether it committed is exactly the open question UNRESOLVED exists
       * for, so it is coerced rather than trusted. This is the one normalising
       * transition on rehydrate, and it fails safe.
       */
      if (stored.status === 'IN_FLIGHT' || stored.status === 'RECONCILING') {
        const coerced: PaymentIntent = { ...stored, status: 'UNRESOLVED', submittedFrom: null };
        return { intent: coerced, effect: { type: 'persist', intent: coerced }, rejected: false };
      }

      return { intent: stored, effect: NOTHING, rejected: false };
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
 * Does a raw blob at least claim to be this booking's?
 *
 * Used only to decide whether an unparseable blob deserves a warning. Kept
 * deliberately permissive -- a string match on the two identifiers -- because
 * the alternative is parsing something that has already failed to parse.
 */
function belongsToThisBooking(raw: string, hotelId: string, bookingCode: string): boolean {
  return raw.includes(hotelId) && raw.includes(bookingCode);
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

  const slot = intentStorageKey(intent.hotelId, intent.bookingCode);
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

export function forgetIntent(
  storage: StorageLike | null,
  hotelId: string,
  bookingCode: string,
): void {
  if (storage === null) return;
  try {
    storage.removeItem(intentStorageKey(hotelId, bookingCode));
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

/** The slot a booking's intent lives in. Property-scoped. */
export function intentStorageKey(hotelId: string, bookingCode: string): string {
  return `easeit.payment-intent.${hotelId}.${bookingCode}`;
}

/** A draft nobody submitted is forgotten after one long shift. */
export const DRAFT_TTL_MS = 12 * 60 * 60 * 1000;
