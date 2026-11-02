/**
 * The payment intent state machine (FO-03 / FO-04).
 *
 * ===========================================================================
 * The rules that stop a lost response becoming a second payment.
 *
 * `folio_line_propertyId_idempotencyKey_key` makes the server refuse a
 * duplicate, but only if the client presents the same key again. Which key is
 * presented, and when a key may be forgotten, is decided entirely by
 * `payment-intent.ts` — so these are the assertions standing between a front
 * desk and a double-charged guest.
 *
 * Two of them are worth naming, because they are the ones a later edit is
 * most likely to undo:
 *
 *   * **An ambiguous outcome keeps the key.** No response means the server may
 *     have committed. Minting a new reference there is the original bug.
 *   * **Nothing except a settled payment clears a key.** Not an edit, not a
 *     conflict, not expiry, not a storage failure. There is deliberately no
 *     action that abandons an unresolved intent, and cases 14/16 assert the
 *     absence rather than the behaviour.
 *
 * **No services, no database, no browser.** The module under test is pure and
 * Node strips its types on import, so this runs inside `pnpm gate` on every
 * pull request — unlike `test:payment`, which still has to be invoked by hand.
 * The storage half drives the real adapter against a fake store, including its
 * failure modes.
 *
 * Run: pnpm test:intent
 * ===========================================================================
 */

import { pathToFileURL } from 'node:url';

const MODULE = 'D:/EaseIt/apps/web-admin/src/components/folio/payment-intent.ts';

const here = new URL('.', import.meta.url);
const resolve = (absolute, relative) => {
  try {
    return pathToFileURL(absolute).href;
  } catch {
    return new URL(relative, here).href;
  }
};

const intents = await import(
  resolve(MODULE, '../../apps/web-admin/src/components/folio/payment-intent.ts')
);

const {
  classifyOutcome,
  conflictFields,
  reducePaymentIntent,
  isFormEditable,
  blocksNewPayment,
  matchesSnapshot,
  parseStoredIntent,
  intentStorageKey,
  DRAFT_TTL_MS,
  persistIntent,
  forgetIntent,
  readStoredIntent,
  blocksPaymentSubmission,
  classifyStored,
  acknowledgementStorageKey,
  recoveredIntentStorageKey,
  slotFor,
  parseAcknowledgement,
  persistAcknowledgement,
  readAcknowledgement,
  readSlot,
  resolveLiveSlot,
  bootFromStorage,
  NOT_DURABLE_MESSAGE,
  slotForGeneration,
  ackSlotForGeneration,
  MAX_RECOVERY_GENERATIONS,
  mayDispatchPost,
} = intents;

/**
 * Builds a grant the way the reducer does: bound to the generation it
 * authorises and the slot whose corruption it escapes.
 */
const grantFor = (generation, fromSlot, over = {}) =>
  JSON.stringify({
    v: 2,
    hotelId: HOTEL,
    bookingCode: BOOKING,
    generation,
    fromSlot,
    acknowledgedAt: T0,
    ledgerOpenedAt: T0,
    ...over,
  });

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const HOTEL = '31001';
const BOOKING = 'SFBOOKING_31001_A01';
const KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_KEY = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const T0 = '2026-11-01T10:00:00.000Z';

const SNAP = {
  folioId: 'f0000000-0000-4000-8000-000000000001',
  amountMinor: 250_000,
  method: 'CASH',
  remark: null,
};

const open = (key = KEY, now = T0) =>
  reducePaymentIntent(null, { type: 'OPEN_SHEET', hotelId: HOTEL, bookingCode: BOOKING, key, now });

/**
 * Reports durability exactly the way the hook does.
 *
 * The submission token is read **off the intent that was just persisted**,
 * never from the suite's own bookkeeping -- which is the whole point of the
 * token: a report can only authorise the submission that asked for the write.
 * `use-payment-intent.ts` does the same single field read, so this helper
 * copies one line rather than reimplementing an algorithm.
 */
const report = (persisted, durability = 'persisted') => {
  const waiting = persisted === null ? null : persisted.pendingSubmission;
  return reducePaymentIntent(persisted, {
    type: 'DURABILITY',
    durability,
    ...(waiting === null || waiting === undefined ? {} : { submission: waiting }),
  });
};

/** Drives the reducer to IN_FLIGHT the way the hook does: persist, then post. */
function toInFlight(from = 'DRAFT') {
  let intent = open().intent;
  if (from === 'DRAFT') {
    const submitted = reducePaymentIntent(intent, { type: 'SUBMIT', snapshot: SNAP, now: T0 });
    const released = report(submitted.intent);
    return { intent: released.intent, effect: released.effect, submitted };
  }
  // Via an ambiguous first attempt, so `submittedFrom` is UNRESOLVED.
  const inFlight = toInFlight('DRAFT').intent;
  const ambiguous = reducePaymentIntent(inFlight, {
    type: 'OUTCOME',
    outcome: { kind: 'ambiguous', reason: 'unreachable' },
  });
  const confirmed = reducePaymentIntent(ambiguous.intent, { type: 'CONFIRM', now: T0 });
  const released = report(confirmed.intent);
  return { intent: released.intent, effect: released.effect };
}

function fakeStorage(options = {}) {
  const map = new Map();
  return {
    map,
    getItem(key) {
      if (options.throwOnGet) throw new Error('blocked');
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (options.throwOnSet) throw new Error('quota');
      if (options.silentlyDiscard) return;
      map.set(key, options.corruptOnWrite ? value.slice(0, 20) : value);
    },
    removeItem(key) {
      if (options.throwOnRemove) throw new Error('blocked');
      map.delete(key);
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  1 - 3   Minting, submitting, settling                                     */
/* -------------------------------------------------------------------------- */

console.log('\n1-3. Minting, submitting and settling.');
{
  const minted = open();
  check(
    '1: OPEN_SHEET mints a DRAFT and asks to persist it',
    minted.intent?.status === 'DRAFT' &&
      minted.intent.key === KEY &&
      minted.intent.snapshot === null &&
      minted.effect.type === 'persist',
    `${String(minted.intent?.status)} / ${minted.effect.type}`,
  );

  const submitted = reducePaymentIntent(minted.intent, { type: 'SUBMIT', snapshot: SNAP, now: T0 });
  check(
    '2: SUBMIT freezes the snapshot and persists BEFORE posting',
    submitted.intent?.status === 'IN_FLIGHT' &&
      submitted.intent.snapshot?.amountMinor === 250_000 &&
      submitted.intent.attempts === 1 &&
      submitted.effect.type === 'persist',
    `effect=${submitted.effect.type}`,
  );

  const released = report(submitted.intent);
  check(
    '2: and only the DURABILITY transition releases the POST',
    released.effect.type === 'post' &&
      released.effect.key === KEY &&
      released.effect.snapshot.amountMinor === 250_000,
    released.effect.type,
  );

  const settled = reducePaymentIntent(released.intent, {
    type: 'OUTCOME',
    outcome: { kind: 'settled' },
  });
  check(
    '3: a settled payment is the only thing that clears the key',
    settled.intent === null && settled.effect.type === 'forget',
    `${String(settled.intent)} / ${settled.effect.type}`,
  );
}

/* -------------------------------------------------------------------------- */
/*  4 - 11  Outcomes                                                          */
/* -------------------------------------------------------------------------- */

console.log('\n4-11. Every outcome, and where it lands.');
{
  const ambiguous = [
    ['4: unreachable', { kind: 'ambiguous', reason: 'unreachable' }],
    ['5: 5xx', { kind: 'ambiguous', reason: 'server-error' }],
    ['6: 2xx with an unreadable body', { kind: 'ambiguous', reason: 'unreadable-success' }],
    ['7: typed CONFLICT', { kind: 'ambiguous', reason: 'transaction-conflict' }],
    ['11: an unknown throw', { kind: 'ambiguous', reason: 'unknown' }],
  ];

  for (const [label, outcome] of ambiguous) {
    const base = toInFlight('DRAFT').intent;
    const next = reducePaymentIntent(base, { type: 'OUTCOME', outcome });
    check(
      `${label} → UNRESOLVED, key and snapshot kept`,
      next.intent?.status === 'UNRESOLVED' &&
        next.intent.key === KEY &&
        next.intent.snapshot?.amountMinor === 250_000,
      `${String(next.intent?.status)} key=${next.intent?.key === KEY ? 'same' : 'CHANGED'}`,
    );
  }

  const base = toInFlight('DRAFT').intent;
  const conflict = reducePaymentIntent(base, {
    type: 'OUTCOME',
    outcome: { kind: 'conflict', differing: [] },
    differing: ['amountMinor'],
  });
  check(
    '8: IDEMPOTENCY_KEY_REUSED → CONFLICTED, key retained, nothing re-minted',
    conflict.intent?.status === 'CONFLICTED' &&
      conflict.intent.key === KEY &&
      conflict.intent.snapshot !== null &&
      conflict.intent.lastConflictFields?.[0] === 'amountMinor',
    `${String(conflict.intent?.status)} key=${conflict.intent?.key === KEY ? 'same' : 'CHANGED'}`,
  );

  const fromDraft = reducePaymentIntent(toInFlight('DRAFT').intent, {
    type: 'OUTCOME',
    outcome: { kind: 'definitive-failure', code: 'VALIDATION_FAILED', message: 'bad' },
  });
  check(
    '9: a definitive 4xx from DRAFT → DRAFT, same key, form editable',
    fromDraft.intent?.status === 'DRAFT' &&
      fromDraft.intent.key === KEY &&
      isFormEditable(fromDraft.intent),
    String(fromDraft.intent?.status),
  );

  const fromUnresolved = reducePaymentIntent(toInFlight('UNRESOLVED').intent, {
    type: 'OUTCOME',
    outcome: { kind: 'definitive-failure', code: 'FOLIO_ALREADY_CLOSED', message: 'closed' },
  });
  check(
    '10: the SAME 4xx from UNRESOLVED stays UNRESOLVED — no escape hatch',
    fromUnresolved.intent?.status === 'UNRESOLVED' &&
      fromUnresolved.intent.snapshot !== null &&
      fromUnresolved.intent.lastFailure?.code === 'FOLIO_ALREADY_CLOSED',
    String(fromUnresolved.intent?.status),
  );
  check('10: and the form is still frozen after it', !isFormEditable(fromUnresolved.intent));
}

/* -------------------------------------------------------------------------- */
/*  12 - 16  Confirm, and the absence of an escape hatch                      */
/* -------------------------------------------------------------------------- */

console.log('\n12-16. Confirm resends the frozen snapshot; nothing abandons an intent.');
{
  const unresolved = reducePaymentIntent(toInFlight('DRAFT').intent, {
    type: 'OUTCOME',
    outcome: { kind: 'ambiguous', reason: 'unreachable' },
  }).intent;

  const confirmed = reducePaymentIntent(unresolved, { type: 'CONFIRM', now: T0 });
  const released = report(confirmed.intent);
  check(
    '12: CONFIRM posts the frozen snapshot under the original key',
    released.effect.type === 'post' &&
      released.effect.key === KEY &&
      released.effect.snapshot.amountMinor === SNAP.amountMinor &&
      released.effect.snapshot.method === SNAP.method &&
      confirmed.intent?.attempts === 2,
    `attempts=${String(confirmed.intent?.attempts)}`,
  );

  const hijack = reducePaymentIntent(unresolved, {
    type: 'SUBMIT',
    snapshot: { ...SNAP, amountMinor: 999_999 },
    now: T0,
  });
  check(
    '13: SUBMIT with a different snapshot is rejected and changes nothing',
    hijack.rejected === true &&
      hijack.intent?.snapshot?.amountMinor === 250_000 &&
      hijack.intent.status === 'UNRESOLVED',
    `rejected=${String(hijack.rejected)} amount=${String(hijack.intent?.snapshot?.amountMinor)}`,
  );

  check(
    '14: there is no action that abandons an UNRESOLVED intent',
    reducePaymentIntent(unresolved, { type: 'START_NEW_PAYMENT' }).intent === unresolved ||
      reducePaymentIntent(unresolved, { type: 'START_NEW_PAYMENT' }).intent?.key === KEY,
    'an unknown action leaves the intent untouched',
  );

  const conflicted = reducePaymentIntent(toInFlight('DRAFT').intent, {
    type: 'OUTCOME',
    outcome: { kind: 'conflict', differing: ['amountMinor'] },
  }).intent;

  const badConfirm = reducePaymentIntent(conflicted, { type: 'CONFIRM', now: T0 });
  check(
    '15: CONFIRM from CONFLICTED is rejected — it cannot succeed',
    badConfirm.rejected === true && badConfirm.intent?.status === 'CONFLICTED',
    `rejected=${String(badConfirm.rejected)}`,
  );

  check(
    '16: and CONFLICTED cannot be abandoned either',
    reducePaymentIntent(conflicted, { type: 'START_NEW_PAYMENT' }).intent?.key === KEY,
  );

  check(
    '16: a new payment is blocked while either state stands',
    blocksNewPayment(unresolved) && blocksNewPayment(conflicted),
  );
}

/* -------------------------------------------------------------------------- */
/*  17 - 22  Reconciliation                                                   */
/* -------------------------------------------------------------------------- */

console.log('\n17-22. Reconciling by reading, never by writing.');
{
  const unresolved = reducePaymentIntent(toInFlight('DRAFT').intent, {
    type: 'OUTCOME',
    outcome: { kind: 'ambiguous', reason: 'unreachable' },
  }).intent;

  const asked = reducePaymentIntent(unresolved, { type: 'RECONCILE' });
  check(
    '17: RECONCILE asks for a read and nothing else',
    asked.intent?.status === 'RECONCILING' &&
      asked.effect.type === 'read' &&
      asked.effect.key === KEY,
    asked.effect.type,
  );

  const found = reducePaymentIntent(asked.intent, {
    type: 'RECONCILED',
    outcome: { kind: 'found', folioId: SNAP.folioId, amountMinor: 250_000, method: 'CASH' },
  });
  check(
    '17: found + matching settles the intent WITHOUT posting anything',
    found.intent === null && found.effect.type === 'forget',
    `${String(found.intent)} / ${found.effect.type}`,
  );

  const notFound = reducePaymentIntent(asked.intent, {
    type: 'RECONCILED',
    outcome: { kind: 'not-found' },
  });
  check(
    '18: not-found keeps the key and the snapshot — it is not proof of failure',
    notFound.intent?.status === 'UNRESOLVED' &&
      notFound.intent.key === KEY &&
      notFound.intent.snapshot?.amountMinor === 250_000 &&
      notFound.intent.lastReconcile === 'not-found',
    `${String(notFound.intent?.status)} / ${String(notFound.intent?.lastReconcile)}`,
  );

  const differs = reducePaymentIntent(asked.intent, {
    type: 'RECONCILED',
    outcome: { kind: 'found', folioId: SNAP.folioId, amountMinor: 700_000, method: 'CARD' },
  });
  check(
    '19: found but materially different → CONFLICTED, naming the fields',
    differs.intent?.status === 'CONFLICTED' &&
      differs.intent.lastConflictFields?.includes('amountMinor') === true &&
      differs.intent.lastConflictFields.includes('method') === true,
    JSON.stringify(differs.intent?.lastConflictFields),
  );

  const readFailed = reducePaymentIntent(asked.intent, {
    type: 'RECONCILED',
    outcome: { kind: 'failed' },
  });
  check(
    '20: a failed read changes nothing but the message',
    readFailed.intent?.status === 'UNRESOLVED' &&
      readFailed.intent.key === KEY &&
      readFailed.intent.lastReconcile === 'failed',
    String(readFailed.intent?.lastReconcile),
  );

  const conflicted = reducePaymentIntent(toInFlight('DRAFT').intent, {
    type: 'OUTCOME',
    outcome: { kind: 'conflict', differing: ['amountMinor'] },
  }).intent;

  const reread = reducePaymentIntent(conflicted, { type: 'RECONCILE' });
  const cleared = reducePaymentIntent(reread.intent, {
    type: 'RECONCILED',
    outcome: { kind: 'not-found' },
  });
  check(
    '21: CONFLICTED → re-read → not-found drops to UNRESOLVED, where Confirm works',
    cleared.intent?.status === 'UNRESOLVED' &&
      reducePaymentIntent(cleared.intent, { type: 'CONFIRM', now: T0 }).rejected === false,
    String(cleared.intent?.status),
  );

  const resolved = reducePaymentIntent(reread.intent, {
    type: 'RECONCILED',
    outcome: { kind: 'found', folioId: SNAP.folioId, amountMinor: 250_000, method: 'CASH' },
  });
  check(
    '22: CONFLICTED → re-read → found+matching settles it',
    resolved.intent === null && resolved.effect.type === 'forget',
  );

  /**
   * A first payment opens the folio server-side, so the intent recorded no
   * folio id. Treating the folio the server went on to create as a mismatch
   * would push an ordinary first payment into CONFLICTED.
   */
  check(
    '22: a null snapshot folio matches whatever folio the server opened',
    matchesSnapshot(
      { folioId: null, amountMinor: 250_000, method: 'CASH', remark: null },
      { folioId: 'f0000000-0000-4000-8000-000000000009', amountMinor: 250_000, method: 'CASH' },
    ),
  );
}

/* -------------------------------------------------------------------------- */
/*  23 - 28  Rehydration, expiry, durability                                  */
/* -------------------------------------------------------------------------- */

console.log('\n23-28. Rehydration, expiry and durability.');
{
  const rehydrate = (stored, now) =>
    reducePaymentIntent(null, {
      type: 'REHYDRATE',
      stored,
      hotelId: HOTEL,
      bookingCode: BOOKING,
      now,
      draftTtlMs: DRAFT_TTL_MS,
    });

  const draft = open().intent;
  const aged = new Date(Date.parse(T0) + DRAFT_TTL_MS + 1000).toISOString();
  check(
    '23: a DRAFT that was never sent is forgotten past its TTL',
    rehydrate(JSON.stringify(draft), aged).intent === null,
  );
  check('23: and kept inside it', rehydrate(JSON.stringify(draft), T0).intent?.key === KEY);

  const unresolved = reducePaymentIntent(toInFlight('DRAFT').intent, {
    type: 'OUTCOME',
    outcome: { kind: 'ambiguous', reason: 'unreachable' },
  }).intent;
  const weekLater = new Date(Date.parse(T0) + 7 * 24 * 3600 * 1000).toISOString();
  check(
    '24: an UNRESOLVED intent a week old is NEVER forgotten',
    rehydrate(JSON.stringify(unresolved), weekLater).intent?.status === 'UNRESOLVED',
    String(rehydrate(JSON.stringify(unresolved), weekLater).intent?.status),
  );

  const conflicted = reducePaymentIntent(toInFlight('DRAFT').intent, {
    type: 'OUTCOME',
    outcome: { kind: 'conflict', differing: ['method'] },
  }).intent;
  check(
    '25: nor is a CONFLICTED one',
    rehydrate(JSON.stringify(conflicted), weekLater).intent?.status === 'CONFLICTED',
  );

  const inFlight = toInFlight('DRAFT').intent;
  const coerced = rehydrate(JSON.stringify(inFlight), T0);
  check(
    '26: a persisted IN_FLIGHT is coerced to UNRESOLVED — the tab died mid-request',
    coerced.intent?.status === 'UNRESOLVED' && coerced.intent.key === KEY,
    String(coerced.intent?.status),
  );

  // No token: this is the "unrelated persist" shape, which must record the
  // measured durability and release nothing.
  const flipped = reducePaymentIntent(unresolved, {
    type: 'DURABILITY',
    durability: 'memory-only',
  });
  check(
    '27: a storage failure flips durability and touches nothing else',
    flipped.intent?.durability === 'memory-only' &&
      flipped.intent.key === unresolved.key &&
      JSON.stringify(flipped.intent.snapshot) === JSON.stringify(unresolved.snapshot) &&
      flipped.intent.status === 'UNRESOLVED',
    `durability=${String(flipped.intent?.durability)}`,
  );

  check(
    '28: only DRAFT is editable',
    isFormEditable(draft) &&
      !isFormEditable(unresolved) &&
      !isFormEditable(conflicted) &&
      !isFormEditable(inFlight),
  );
}

/* -------------------------------------------------------------------------- */
/*  29  classifyOutcome                                                       */
/* -------------------------------------------------------------------------- */

console.log('\n29. classifyOutcome reproduces the documented table.');
{
  const cases = [
    ['unreachable', { name: 'ApiUnreachableError' }, 'ambiguous', 'unreachable'],
    [
      '2xx with an unreadable body',
      { name: 'ApiRequestError', status: 200, code: 'INTERNAL_ERROR' },
      'ambiguous',
      'unreadable-success',
    ],
    [
      '500 INTERNAL_ERROR',
      { name: 'ApiRequestError', status: 500, code: 'INTERNAL_ERROR' },
      'ambiguous',
      'server-error',
    ],
    [
      '409 IDEMPOTENCY_KEY_REUSED',
      { name: 'ApiRequestError', status: 409, code: 'IDEMPOTENCY_KEY_REUSED' },
      'conflict',
      null,
    ],
    [
      '409 CONFLICT',
      { name: 'ApiRequestError', status: 409, code: 'CONFLICT' },
      'ambiguous',
      'transaction-conflict',
    ],
    [
      '503',
      { name: 'ApiRequestError', status: 503, code: 'SOMETHING' },
      'ambiguous',
      'server-error',
    ],
    [
      '400 VALIDATION_FAILED',
      { name: 'ApiRequestError', status: 400, code: 'VALIDATION_FAILED' },
      'definitive-failure',
      null,
    ],
    [
      '403 FORBIDDEN',
      { name: 'ApiRequestError', status: 403, code: 'FORBIDDEN' },
      'definitive-failure',
      null,
    ],
    [
      '404 NOT_FOUND',
      { name: 'ApiRequestError', status: 404, code: 'NOT_FOUND' },
      'definitive-failure',
      null,
    ],
    [
      '409 FOLIO_ALREADY_CLOSED',
      { name: 'ApiRequestError', status: 409, code: 'FOLIO_ALREADY_CLOSED' },
      'definitive-failure',
      null,
    ],
    ['a string throw', 'boom', 'ambiguous', 'unknown'],
    ['null', null, 'ambiguous', 'unknown'],
    ['an Error with no status', new Error('x'), 'ambiguous', 'unknown'],
  ];

  for (const [label, thrown, kind, reason] of cases) {
    const got = classifyOutcome(thrown);
    check(
      `29: ${label} → ${kind}${reason === null ? '' : `/${reason}`}`,
      got.kind === kind && (reason === null || got.reason === reason),
      `${got.kind}${got.reason === undefined ? '' : `/${got.reason}`}`,
    );
  }

  check(
    '29: conflictFields reads details.differing and ignores anything else',
    JSON.stringify(conflictFields({ details: { differing: ['amountMinor', 7, 'method'] } })) ===
      JSON.stringify(['amountMinor', 'method']) &&
      conflictFields(null).length === 0 &&
      conflictFields({ details: 'nope' }).length === 0,
  );
}

/* -------------------------------------------------------------------------- */
/*  30 - 40  Storage                                                          */
/* -------------------------------------------------------------------------- */

console.log('\n30-40. The storage adapter, including its failure modes.');
{
  const unresolved = reducePaymentIntent(toInFlight('DRAFT').intent, {
    type: 'OUTCOME',
    outcome: { kind: 'ambiguous', reason: 'unreachable' },
  }).intent;

  // 30: persist, throw the in-memory layer away, rehydrate from storage.
  const s30 = fakeStorage();
  check('30: a verified write reports persisted', persistIntent(s30, unresolved) === 'persisted');
  const reloaded = reducePaymentIntent(null, {
    type: 'REHYDRATE',
    stored: readStoredIntent(s30, HOTEL, BOOKING),
    hotelId: HOTEL,
    bookingCode: BOOKING,
    now: T0,
    draftTtlMs: DRAFT_TTL_MS,
  });
  check(
    '30: and rehydrating returns the same key, snapshot and status',
    reloaded.intent?.key === KEY &&
      reloaded.intent.status === 'UNRESOLVED' &&
      reloaded.intent.snapshot?.amountMinor === 250_000,
    `${String(reloaded.intent?.status)} key=${reloaded.intent?.key === KEY ? 'same' : 'CHANGED'}`,
  );

  // 31/32: sheet close/reopen and router.refresh() keep the in-memory intent,
  // so OPEN_SHEET must hand back the existing one rather than mint.
  const reopened = reducePaymentIntent(unresolved, {
    type: 'OPEN_SHEET',
    hotelId: HOTEL,
    bookingCode: BOOKING,
    key: OTHER_KEY,
    now: T0,
  });
  check(
    '31/32: reopening the sheet returns the existing intent and mints nothing',
    reopened.intent?.key === KEY && reopened.effect.type === 'none',
    `key=${reopened.intent?.key === KEY ? 'same' : 'CHANGED'} effect=${reopened.effect.type}`,
  );

  // 33: storage write throws, then the request fails ambiguously.
  const s33 = fakeStorage({ throwOnSet: true });
  const draft33 = open().intent;
  check(
    '33: a throwing setItem reports memory-only, never persisted',
    persistIntent(s33, draft33) === 'memory-only',
  );
  /**
   * A non-durable submit now never reaches the network, so there is no
   * ambiguous reply to receive: the reducer lands it back in DRAFT with the
   * key intact. Driven through `report` so the refusal is the real one.
   */
  const blocked33 = report(
    reducePaymentIntent(draft33, { type: 'SUBMIT', snapshot: SNAP, now: T0 }).intent,
    'memory-only',
  );
  const after33 = { intent: blocked33.intent };
  check(
    '33: a non-durable submit is blocked, and keeps the original key',
    after33.intent?.status === 'DRAFT' &&
      after33.intent.key === KEY &&
      after33.intent.durability === 'memory-only' &&
      // DRAFT means editable, so the frozen snapshot is released -- the form
      // still holds what the clerk typed, and the retry goes out under the
      // same key rather than a new one.
      after33.intent.snapshot === null &&
      after33.intent.lastFailure?.code === 'STORAGE_NOT_DURABLE',
    `key=${after33.intent?.key === KEY ? 'same' : 'CHANGED'} durability=${String(after33.intent?.durability)}`,
  );
  check(
    '33: and no request was released',
    blocked33.effect.type === 'blocked',
    blocked33.effect.type,
  );

  // 34: a silently discarding store.
  check(
    '34: a setItem that silently discards is caught by the read-back',
    persistIntent(fakeStorage({ silentlyDiscard: true }), unresolved) === 'memory-only',
  );
  check(
    '34: so is a store that truncates what it was given',
    persistIntent(fakeStorage({ corruptOnWrite: true }), unresolved) === 'memory-only',
  );
  check(
    '34: and a throwing getItem',
    persistIntent(fakeStorage({ throwOnGet: true }), unresolved) === 'memory-only',
  );
  check(
    '34: a null store is memory-only, not a crash',
    persistIntent(null, unresolved) === 'memory-only',
  );

  // 35: malformed blobs.
  const malformed = [
    ['truncated JSON', '{"key":"aaa'],
    ['not an object', '42'],
    ['missing key', JSON.stringify({ ...unresolved, key: undefined })],
    ['short key', JSON.stringify({ ...unresolved, key: 'too-short' })],
    ['unknown status', JSON.stringify({ ...unresolved, status: 'WAT' })],
    ['empty snapshot', JSON.stringify({ ...unresolved, snapshot: {} })],
    ['null snapshot outside DRAFT', JSON.stringify({ ...unresolved, snapshot: null })],
    ['negative amount', JSON.stringify({ ...unresolved, snapshot: { ...SNAP, amountMinor: -1 } })],
    [
      'non-integer amount',
      JSON.stringify({ ...unresolved, snapshot: { ...SNAP, amountMinor: 1.5 } }),
    ],
    ['bad createdAt', JSON.stringify({ ...unresolved, createdAt: 'never' })],
    ['null', null],
  ];
  for (const [label, blob] of malformed) {
    let threw = false;
    let got = 'unset';
    try {
      got = parseStoredIntent(blob, HOTEL, BOOKING);
    } catch {
      threw = true;
    }
    check(
      `35: ${label} → null, never a throw`,
      !threw && got === null,
      threw ? 'THREW' : String(got),
    );
  }

  // 36/37: identity mismatches.
  check(
    '36: a blob for another booking is rejected',
    parseStoredIntent(JSON.stringify(unresolved), HOTEL, 'SFBOOKING_31001_ZZZ') === null,
  );
  check(
    '37: a blob for another property is rejected',
    parseStoredIntent(JSON.stringify(unresolved), '31002', BOOKING) === null,
  );
  check(
    '36/37: the slot itself is property- and booking-scoped',
    intentStorageKey(HOTEL, BOOKING) === `easeit.payment-intent.${HOTEL}.${BOOKING}` &&
      intentStorageKey('31002', BOOKING) !== intentStorageKey(HOTEL, BOOKING),
    intentStorageKey(HOTEL, BOOKING),
  );

  // 38/39: no new payment before reconciliation.
  for (const [label, held] of [
    ['38: UNRESOLVED', unresolved],
    [
      '39: CONFLICTED',
      reducePaymentIntent(toInFlight('DRAFT').intent, {
        type: 'OUTCOME',
        outcome: { kind: 'conflict', differing: ['method'] },
      }).intent,
    ],
  ]) {
    const attempt = reducePaymentIntent(held, {
      type: 'OPEN_SHEET',
      hotelId: HOTEL,
      bookingCode: BOOKING,
      key: OTHER_KEY,
      now: T0,
    });
    check(
      `${label}: opening the sheet mints no new key`,
      attempt.intent?.key === KEY && attempt.intent.status === held.status,
      `key=${attempt.intent?.key === KEY ? 'same' : 'CHANGED'}`,
    );
  }

  // 40: a settled blob should never exist, and is ignored if it does.
  const s40 = fakeStorage();
  persistIntent(s40, unresolved);
  forgetIntent(s40, HOTEL, BOOKING);
  check('40: forgetting removes the slot', readStoredIntent(s40, HOTEL, BOOKING) === null);
  check(
    '40: and a store that cannot remove does not throw',
    (() => {
      try {
        forgetIntent(fakeStorage({ throwOnRemove: true }), HOTEL, BOOKING);
        return true;
      } catch {
        return false;
      }
    })(),
  );
}

/* -------------------------------------------------------------------------- */
/*  41 - 45  Audit additions                                                  */
/* -------------------------------------------------------------------------- */

console.log('\n41-45. Post-implementation audit: the invariants not yet asserted.');
{
  const unresolved = reducePaymentIntent(toInFlight('DRAFT').intent, {
    type: 'OUTCOME',
    outcome: { kind: 'ambiguous', reason: 'unreachable' },
  }).intent;

  /**
   * 41: two Confirm clicks in the same tick.
   *
   * The UI's `saving` flag is React state and both handlers would read it as
   * false, so the guard that actually matters is the reducer's: the first
   * CONFIRM moves the intent to IN_FLIGHT synchronously, and the second sees a
   * status that CONFIRM does not accept.
   */
  const firstClick = reducePaymentIntent(unresolved, { type: 'CONFIRM', now: T0 });
  const secondClick = reducePaymentIntent(firstClick.intent, { type: 'CONFIRM', now: T0 });
  check(
    '41: a second Confirm in the same tick is rejected — one POST, not two',
    firstClick.rejected === false &&
      secondClick.rejected === true &&
      secondClick.intent?.attempts === firstClick.intent?.attempts,
    `attempts ${String(firstClick.intent?.attempts)} -> ${String(secondClick.intent?.attempts)}`,
  );

  /** 42: the same for Reconcile, which sets no `saving` flag at all. */
  const firstRead = reducePaymentIntent(unresolved, { type: 'RECONCILE' });
  const secondRead = reducePaymentIntent(firstRead.intent, { type: 'RECONCILE' });
  check(
    '42: a second Reconcile is rejected — one read, not two',
    firstRead.effect.type === 'read' &&
      secondRead.rejected === true &&
      secondRead.effect.type === 'none',
    `${firstRead.effect.type} / ${secondRead.effect.type}`,
  );

  /**
   * 43: a stale OUTCOME cannot overwrite a newer state, nor resurrect a
   * settled one.
   */
  const settledLater = reducePaymentIntent(report(firstClick.intent).intent, {
    type: 'OUTCOME',
    outcome: { kind: 'settled' },
  });
  check('43: the newer attempt settled and cleared the key', settledLater.intent === null);
  const stale = reducePaymentIntent(settledLater.intent, {
    type: 'OUTCOME',
    outcome: { kind: 'ambiguous', reason: 'unreachable' },
  });
  check(
    '43: and a stale response afterwards cannot resurrect an intent',
    stale.intent === null && stale.rejected === true,
    `rejected=${String(stale.rejected)}`,
  );

  /**
   * 44: a stale RECONCILED cannot clear or alter a newer intent.
   *
   * The reachable shape of this: a read is in flight, its answer lands and
   * moves the intent to UNRESOLVED, the clerk clicks Confirm, and only *then*
   * a duplicate of the earlier read's answer arrives. By that point the intent
   * is IN_FLIGHT, and a `found + matching` answer would otherwise clear the key
   * out from under a request that is still running.
   *
   * (The first draft of this case tried to Confirm straight out of
   * RECONCILING, which the reducer rejects — so nothing had moved on and the
   * assertion was testing its own premise. From RECONCILING the only exit is
   * the read's own answer, which is why case 42 matters.)
   */
  const answered = reducePaymentIntent(firstRead.intent, {
    type: 'RECONCILED',
    outcome: { kind: 'not-found' },
  });
  const movedOn = reducePaymentIntent(answered.intent, { type: 'CONFIRM', now: T0 });
  check(
    '44: the read answered and the clerk then confirmed',
    answered.intent?.status === 'UNRESOLVED' && movedOn.intent?.status === 'IN_FLIGHT',
    `${String(answered.intent?.status)} -> ${String(movedOn.intent?.status)}`,
  );
  const staleRead = reducePaymentIntent(movedOn.intent, {
    type: 'RECONCILED',
    outcome: { kind: 'found', folioId: SNAP.folioId, amountMinor: 250_000, method: 'CASH' },
  });
  check(
    '44: a reconciliation answer landing after the state moved on is dropped',
    staleRead.rejected === true &&
      staleRead.intent?.key === KEY &&
      staleRead.intent.status === 'IN_FLIGHT' &&
      staleRead.effect.type === 'none',
    `rejected=${String(staleRead.rejected)} key=${staleRead.intent?.key === KEY ? 'same' : 'CHANGED'}`,
  );

  /**
   * 45: a corrupt blob quarantines the booking, never silently dropped.
   *
   * A real hole an audit found: an unreadable blob returned the same "nothing
   * stored" as an empty slot, so the clerk got a clean form with no hint that
   * a reference had existed -- and the next thing they would do is take the
   * payment again.
   *
   * The first fix only *reported* it, via a `storedUnreadable` flag that
   * nothing enforced; a later audit showed the flag blocked no submission and
   * that the very next `OPEN_SHEET` overwrote the evidence. It is now a state,
   * which is what these checks assert. Cases 46-70 cover the recovery.
   */
  const corrupt = `{"key":"${KEY}","hotelId":"${HOTEL}","bookingCode":"${BOOKING}","status":"UNRESOL`;
  const rehydrateRaw = (stored) =>
    reducePaymentIntent(null, {
      type: 'REHYDRATE',
      stored,
      hotelId: HOTEL,
      bookingCode: BOOKING,
      now: T0,
      draftTtlMs: DRAFT_TTL_MS,
    });

  const reported = rehydrateRaw(corrupt);
  check(
    '45: an unreadable blob for THIS booking QUARANTINES it',
    reported.intent?.status === 'QUARANTINED' && reported.intent.key === null,
    `${String(reported.intent?.status)} key=${String(reported.intent?.key)}`,
  );
  check(
    '45: and nothing is written, so the evidence survives a reload',
    reported.effect.type === 'none',
    reported.effect.type,
  );
  check(
    '45: an empty slot is silent -- no false alarm',
    rehydrateRaw(null).intent === null && rehydrateRaw(null).effect.type === 'none',
    `intent=${String(rehydrateRaw(null).intent)}`,
  );
  const foreignCorrupt =
    '{"key":"xxxx","hotelId":"39999","bookingCode":"SFBOOKING_39999_Z","status":"UNRESOL';
  check(
    '45: a corrupt blob legibly naming another booking does not quarantine this one',
    rehydrateRaw(foreignCorrupt).intent === null,
    `intent=${String(rehydrateRaw(foreignCorrupt).intent)}`,
  );
}

/* -------------------------------------------------------------------------- */
/*  46 - 63  Quarantine and recovery                                          */
/* -------------------------------------------------------------------------- */

console.log('\n46-63. Corrupt storage: quarantine, and the recovery that lifts it.');
{
  const PRIMARY = intentStorageKey(HOTEL, BOOKING);
  const ACK = acknowledgementStorageKey(HOTEL, BOOKING);
  const NEXT = recoveredIntentStorageKey(HOTEL, BOOKING);

  /** A truncated blob that legibly names this booking. */
  const CORRUPT_OURS = `{"key":"${KEY}","hotelId":"${HOTEL}","bookingCode":"${BOOKING}","stat`;
  /** Non-empty, unreadable, names nobody — the dangerous one. */
  const CORRUPT_UNKNOWN = '{"key":"aaa';

  const boot = (raw, options = {}) =>
    reducePaymentIntent(null, {
      type: 'REHYDRATE',
      stored: raw,
      hotelId: HOTEL,
      bookingCode: BOOKING,
      now: T0,
      draftTtlMs: DRAFT_TTL_MS,
      ...options,
    });

  /* ------------------------------------------------------------------ 46 */
  const quarantined = boot(CORRUPT_OURS).intent;
  check(
    '46: a corrupt blob naming this booking quarantines it',
    quarantined?.status === 'QUARANTINED' &&
      quarantined.key === null &&
      quarantined.snapshot === null &&
      quarantined.quarantine === 'ours',
    `${String(quarantined?.status)} reason=${String(quarantined?.quarantine)}`,
  );
  check(
    '46: and nothing is written — no persist, no forget',
    boot(CORRUPT_OURS).effect.type === 'none',
    boot(CORRUPT_OURS).effect.type,
  );

  /* ------------------------------------------------------------------ 47 */
  const reopened = reducePaymentIntent(quarantined, {
    type: 'OPEN_SHEET',
    hotelId: HOTEL,
    bookingCode: BOOKING,
    key: OTHER_KEY,
    now: T0,
  });
  check(
    '47: OPEN_SHEET over a quarantine mints nothing and emits NO persist',
    reopened.intent?.status === 'QUARANTINED' &&
      reopened.intent.key === null &&
      reopened.effect.type === 'none',
    `status=${String(reopened.intent?.status)} effect=${reopened.effect.type}`,
  );

  /* ------------------------------------------------------------------ 48 */
  const store48 = fakeStorage();
  store48.map.set(PRIMARY, CORRUPT_OURS);
  // Opening the sheet must not reach storage at all.
  persistIntent(store48, reopened.intent);
  check(
    '48: the original bytes survive an OPEN_SHEET, unchanged',
    store48.map.get(PRIMARY) === CORRUPT_OURS,
    store48.map.get(PRIMARY) === CORRUPT_OURS ? 'byte-identical' : 'MUTATED',
  );
  check(
    '48: and a reload still quarantines',
    boot(store48.map.get(PRIMARY)).intent?.status === 'QUARANTINED',
  );

  /* ------------------------------------------------------------------ 49 */
  const hijack = reducePaymentIntent(quarantined, {
    type: 'SUBMIT',
    snapshot: SNAP,
    now: T0,
  });
  check(
    '49: SUBMIT from QUARANTINED is rejected — no post effect',
    hijack.rejected === true && hijack.effect.type === 'none',
    `rejected=${String(hijack.rejected)} effect=${hijack.effect.type}`,
  );

  /* ------------------------------------------------------------------ 50 */
  const badConfirm = reducePaymentIntent(quarantined, { type: 'CONFIRM', now: T0 });
  const badRead = reducePaymentIntent(quarantined, { type: 'RECONCILE' });
  check(
    '50: CONFIRM and RECONCILE are both rejected — there is no key to use',
    badConfirm.rejected === true &&
      badRead.rejected === true &&
      badRead.effect.type === 'none',
    `confirm=${String(badConfirm.rejected)} read=${badRead.effect.type}`,
  );

  /* ------------------------------------------------------------------ 51 */
  const premature = reducePaymentIntent(quarantined, {
    type: 'ACKNOWLEDGE_UNREADABLE',
    now: T0,
  });
  check(
    '51: acknowledging before opening the ledger is rejected',
    premature.rejected === true && premature.effect.type === 'none',
    `rejected=${String(premature.rejected)}`,
  );

  /* ------------------------------------------------------------------ 52 */
  const opened = reducePaymentIntent(quarantined, { type: 'OPEN_LEDGER', now: T0 });
  check(
    '52: OPEN_LEDGER records the timestamp and grants nothing',
    opened.intent?.ledgerOpenedAt === T0 &&
      opened.intent.status === 'QUARANTINED' &&
      opened.effect.type === 'none',
    `ledgerOpenedAt=${String(opened.intent?.ledgerOpenedAt)}`,
  );

  const asked = reducePaymentIntent(opened.intent, {
    type: 'ACKNOWLEDGE_UNREADABLE',
    now: '2026-11-01T10:05:00.000Z',
  });
  check(
    '52: acknowledging then asks for a verified write, still quarantined',
    asked.effect.type === 'acknowledge' && asked.intent?.status === 'QUARANTINED',
    `effect=${asked.effect.type} status=${String(asked.intent?.status)}`,
  );
  check(
    '52: and the record carries property, booking, timestamps, version, generation and source slot',
    asked.effect.type === 'acknowledge' &&
      asked.effect.record.hotelId === HOTEL &&
      asked.effect.record.bookingCode === BOOKING &&
      asked.effect.record.ledgerOpenedAt === T0 &&
      asked.effect.record.acknowledgedAt === '2026-11-01T10:05:00.000Z' &&
      asked.effect.record.v === 2 &&
      asked.effect.record.generation === 1 &&
      asked.effect.record.fromSlot === slotForGeneration(HOTEL, BOOKING, 0),
    asked.effect.type === 'acknowledge' ? JSON.stringify(asked.effect.record) : 'no record',
  );

  /* ------------------------------------------------------------------ 53 */
  const lifted = reducePaymentIntent(asked.intent, { type: 'ACKNOWLEDGE_VERIFIED' });
  check(
    '53: a verified acknowledgement lifts the quarantine to NOTHING, not a DRAFT',
    lifted.intent === null && lifted.effect.type === 'none',
    `${String(lifted.intent)} / ${lifted.effect.type}`,
  );

  const minted = reducePaymentIntent(lifted.intent, {
    type: 'OPEN_SHEET',
    hotelId: HOTEL,
    bookingCode: BOOKING,
    key: OTHER_KEY,
    now: T0,
    generation: 1,
  });
  check(
    '53: the clerk then opens the sheet and gets a DRAFT in the #next slot',
    minted.intent?.status === 'DRAFT' &&
      minted.intent.key === OTHER_KEY &&
      minted.intent.generation === 1 &&
      slotFor(minted.intent) === NEXT,
    `slot=${minted.intent === null ? 'none' : slotFor(minted.intent)}`,
  );

  const store53 = fakeStorage();
  store53.map.set(PRIMARY, CORRUPT_OURS);
  persistIntent(store53, minted.intent);
  check(
    '53: writing it leaves the corrupt primary untouched',
    store53.map.get(PRIMARY) === CORRUPT_OURS && typeof store53.map.get(NEXT) === 'string',
    `primary ${store53.map.get(PRIMARY) === CORRUPT_OURS ? 'intact' : 'MUTATED'}`,
  );

  /* ------------------------------------------------------------------ 54 */
  for (const [label, options] of [
    ['throws', { throwOnSet: true }],
    ['silently discards', { silentlyDiscard: true }],
    ['truncates', { corruptOnWrite: true }],
  ]) {
    const store = fakeStorage(options);
    store.map.set(PRIMARY, CORRUPT_OURS);
    const written =
      asked.effect.type === 'acknowledge'
        ? persistAcknowledgement(store, asked.effect.record)
        : true;
    check(
      `54: an acknowledgement write that ${label} reports failure`,
      written === false,
      `written=${String(written)}`,
    );
    check(
      `54: so the booking stays quarantined and the primary is intact`,
      bootFromStorage(store, HOTEL, BOOKING, T0, DRAFT_TTL_MS).transition.intent?.status ===
        'QUARANTINED' &&
        store.map.get(PRIMARY) === CORRUPT_OURS,
    );
  }
  check(
    '54: a null store cannot acknowledge either',
    asked.effect.type === 'acknowledge'
      ? persistAcknowledgement(null, asked.effect.record) === false
      : false,
  );

  /* ------------------------------------------------------------------ 55 */
  check(
    '55: reload BEFORE acknowledgement returns to step 1 — ledger not opened',
    boot(CORRUPT_OURS).intent?.ledgerOpenedAt === null,
    String(boot(CORRUPT_OURS).intent?.ledgerOpenedAt),
  );

  /* ------------------------------------------------------------------ 56 */
  const store56 = fakeStorage();
  store56.map.set(PRIMARY, CORRUPT_OURS);
  const ackOk =
    asked.effect.type === 'acknowledge'
      ? persistAcknowledgement(store56, asked.effect.record)
      : false;
  check('56: the acknowledgement persists and verifies', ackOk === true);
  const reload56 = () => bootFromStorage(store56, HOTEL, BOOKING, T0, DRAFT_TTL_MS);
  check(
    '56: reload AFTER acknowledgement does not re-quarantine',
    reload56().transition.intent === null && reload56().slot.generation === 1,
    `generation=${String(reload56().slot.generation)}`,
  );
  persistIntent(store56, minted.intent);
  const afterDraft = reload56().transition;
  check(
    '56: reload AFTER the new DRAFT restores it from #next, still generation 1',
    afterDraft.intent?.key === OTHER_KEY && afterDraft.intent.generation === 1,
    `key=${String(afterDraft.intent?.key)} generation=${String(afterDraft.intent?.generation)}`,
  );
  check(
    '56: and the corrupt primary is still byte-identical after all of it',
    store56.map.get(PRIMARY) === CORRUPT_OURS,
    store56.map.get(PRIMARY) === CORRUPT_OURS ? 'byte-identical' : 'MUTATED',
  );

  /* ------------------------------------------------------------------ 57 */
  check(
    '57: blocksNewPayment covers QUARANTINED as well as the frozen states',
    blocksNewPayment(quarantined) === true,
  );

  /* ------------------------------------------------------------------ 58 */
  check(
    '58: blocksPaymentSubmission allows ONLY a live DRAFT',
    blocksPaymentSubmission(null) === true &&
      blocksPaymentSubmission(quarantined) === true &&
      blocksPaymentSubmission(minted.intent) === false,
    'null and QUARANTINED blocked, DRAFT permitted',
  );
  check(
    '58: and isFormEditable no longer reports a null intent as editable',
    isFormEditable(null) === false && isFormEditable(minted.intent) === true,
  );

  /* ------------------------------------------------------------------ 59 */
  const staleOutcome = reducePaymentIntent(quarantined, {
    type: 'OUTCOME',
    outcome: { kind: 'settled' },
  });
  const staleRead = reducePaymentIntent(quarantined, {
    type: 'RECONCILED',
    outcome: { kind: 'not-found' },
  });
  check(
    '59: a stale OUTCOME cannot settle — or clear — a quarantine',
    staleOutcome.rejected === true && staleOutcome.intent?.status === 'QUARANTINED',
    `rejected=${String(staleOutcome.rejected)}`,
  );
  check(
    '59: nor can a stale RECONCILED',
    staleRead.rejected === true && staleRead.intent?.status === 'QUARANTINED',
  );

  /* ------------------------------------------------------------------ 60 */
  const foreignValid = JSON.stringify({
    ...minted.intent,
    bookingCode: 'SFBOOKING_31001_ZZZ',
  });
  check(
    "60: a VALID record for another booking does not quarantine this one",
    boot(foreignValid).intent === null && boot(foreignValid).effect.type === 'none',
    'treated as an empty slot, not corruption',
  );
  const foreignProperty = JSON.stringify({ ...minted.intent, hotelId: '31002' });
  check(
    '60: nor does one for another property',
    boot(foreignProperty).intent === null,
  );

  /* ------------------------------------------------------------- extra: 64 */
  check(
    '64: an UNIDENTIFIABLE corrupt value fails CLOSED — quarantined, not empty',
    boot(CORRUPT_UNKNOWN).intent?.status === 'QUARANTINED' &&
      boot(CORRUPT_UNKNOWN).intent.quarantine === 'unidentified',
    `reason=${String(boot(CORRUPT_UNKNOWN).intent?.quarantine)}`,
  );
  check(
    '64: and so does a non-string value, which only a caller bug produces',
    boot(42).intent?.status === 'QUARANTINED',
  );

  /* ------------------------------------------------------------- extra: 65 */
  const GEN0 = slotForGeneration(HOTEL, BOOKING, 0);
  const foreignAck = grantFor(1, GEN0, { bookingCode: 'SFBOOKING_31001_ZZZ' });
  check(
    '65: an acknowledgement for another booking is rejected',
    parseAcknowledgement(foreignAck, HOTEL, BOOKING, 1, GEN0) === null,
  );
  check(
    '65: as is one for another property',
    parseAcknowledgement(grantFor(1, GEN0, { hotelId: '31002' }), HOTEL, BOOKING, 1, GEN0) ===
      null,
  );

  /* ------------------------------------------------------------- extra: 66 */
  const malformedAcks = [
    ['truncated JSON', '{"v":2,"hotelId"'],
    // v1 is the OLD protocol: no generation, no source slot, so it could only
    // mean "escape the primary, forever". Refused, because accepting it
    // restores exactly the open-ended grant that was the defect.
    ['version 1 (the old open-ended grant)', JSON.stringify({ v: 1, hotelId: HOTEL, bookingCode: BOOKING, acknowledgedAt: T0, ledgerOpenedAt: T0 })],
    ['future version', grantFor(1, slotForGeneration(HOTEL, BOOKING, 0), { v: 3 })],
    ['missing ledgerOpenedAt', JSON.stringify({ v: 2, hotelId: HOTEL, bookingCode: BOOKING, generation: 1, fromSlot: slotForGeneration(HOTEL, BOOKING, 0), acknowledgedAt: T0 })],
    ['unparseable timestamp', grantFor(1, slotForGeneration(HOTEL, BOOKING, 0), { acknowledgedAt: 'never' })],
    ['a DIFFERENT generation', grantFor(2, slotForGeneration(HOTEL, BOOKING, 0))],
    ['a DIFFERENT source slot', grantFor(1, slotForGeneration(HOTEL, BOOKING, 1))],
    ['not an object', '"yes"'],
    ['empty', ''],
    ['null', null],
  ];
  for (const [label, raw] of malformedAcks) {
    let threw = false;
    let got = 'unset';
    try {
      got = parseAcknowledgement(raw, HOTEL, BOOKING, 1, slotForGeneration(HOTEL, BOOKING, 0));
    } catch {
      threw = true;
    }
    check(`66: a ${label} acknowledgement is rejected, never a throw`, !threw && got === null);
  }

  /* ------------------------------------------------------------- extra: 67 */
  const store67 = fakeStorage({ throwOnSet: true });
  const durability67 = persistIntent(store67, minted.intent);
  const after67 = report(
    reducePaymentIntent(minted.intent, { type: 'SUBMIT', snapshot: SNAP, now: T0 }).intent,
    durability67,
  );
  check(
    '67: a failed #next write reports memory-only',
    durability67 === 'memory-only',
    durability67,
  );
  check(
    '67: and the POST is BLOCKED, not released -- a reference that was not saved is not sent',
    after67.effect.type === 'blocked' && after67.effect.reason === 'not-durable',
    `effect=${after67.effect.type}`,
  );
  check(
    '67: the key survives and nothing is replaced, so the retry is the same payment',
    after67.intent?.key === minted.intent?.key &&
      after67.intent?.status === 'DRAFT' &&
      after67.intent?.durability === 'memory-only' &&
      after67.intent?.pendingSubmission === null,
    `key=${after67.intent?.key === minted.intent?.key ? 'same' : 'CHANGED'} status=${String(after67.intent?.status)}`,
  );
  check(
    '67: and the clerk is told, in words that say the money was not taken',
    after67.effect.type === 'blocked' &&
      after67.effect.message === NOT_DURABLE_MESSAGE &&
      after67.intent?.lastFailure?.code === 'STORAGE_NOT_DURABLE' &&
      /was not sent/.test(NOT_DURABLE_MESSAGE),
    String(after67.intent?.lastFailure?.code),
  );

  /* ------------------------------------------------------------- extra: 68 */
  check(
    '68: a quarantine is never written, even if persistIntent is called on it',
    persistIntent(fakeStorage(), quarantined) === 'memory-only',
  );
  const store68 = fakeStorage();
  store68.map.set(PRIMARY, CORRUPT_OURS);
  persistIntent(store68, quarantined);
  check(
    '68: and the slot it would have written to is untouched',
    store68.map.get(PRIMARY) === CORRUPT_OURS && store68.map.size === 1,
    `${String(store68.map.size)} key(s) in the store`,
  );

  /* ------------------------------------------------------------- extra: 69 */
  const ackTwice = reducePaymentIntent(lifted.intent, {
    type: 'ACKNOWLEDGE_UNREADABLE',
    now: T0,
  });
  check(
    '69: acknowledging twice is rejected — the quarantine is already lifted',
    ackTwice.rejected === true && ackTwice.intent === null,
    `rejected=${String(ackTwice.rejected)}`,
  );
  const verifyTwice = reducePaymentIntent(lifted.intent, { type: 'ACKNOWLEDGE_VERIFIED' });
  check(
    '69: and a duplicate ACKNOWLEDGE_VERIFIED changes nothing',
    verifyTwice.rejected === true && verifyTwice.intent === null,
  );

  /* ------------------------------------------------------------- extra: 70 */
  check(
    '70: the three slots are distinct and all property- and booking-scoped',
    PRIMARY !== ACK &&
      PRIMARY !== NEXT &&
      ACK !== NEXT &&
      ACK.startsWith(PRIMARY) &&
      NEXT.startsWith(PRIMARY) &&
      intentStorageKey('31002', BOOKING) !== PRIMARY,
    `${PRIMARY} | ${ACK} | ${NEXT}`,
  );
}

/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*  61 - 63 (substitutes)  Identifier shapes, and corruption beside stale data */
/* -------------------------------------------------------------------------- */

/**
 * These three numbers were approved but never authored.
 *
 * ===========================================================================
 * The approved matrix was "cases 46-63". The suite went 46-60 and then 64-70,
 * and the plan file it was written from skips 61-63 in exactly the same place,
 * so the gap is in the authoring, not a later deletion. **The original
 * definitions of 61, 62 and 63 cannot be recovered.** What follows is not
 * them; it is three substitutes covering the ground an audit asked for, and
 * they are labelled as substitutes so nobody later reads them as the approved
 * cases restored.
 * ===========================================================================
 */

console.log('\n61-63 (substitutes). Identifier shapes, and corruption beside stale data.');
{
  const PRIMARY = intentStorageKey(HOTEL, BOOKING);

  /**
   * 61: identifiers that break naive string matching.
   *
   * `namesField` strips whitespace and compares an exact substring precisely
   * so that none of these can be mishandled by an escape that collapsed. The
   * assertion is deliberately not "classified as `ours`" but "**blocks**":
   * what matters is that no shape here is mistaken for an empty slot, because
   * that is the failure that takes a second payment. A shape that degrades
   * from `ours` to `unidentified` has failed closed, which is correct.
   */
  const shapes = [
    ['plain', 'SFBOOKING_31001_A01'],
    ['whitespace', 'SF BOOKING 01'],
    ['tab and newline', 'SF\tBOOK\n01'],
    ['escaped quotes', 'SF\\"BOOK'],
    ['backslashes', 'SF\\\\BOOK'],
    ['unicode', 'SFé住室BOOK'],
    ['regex metacharacters', 'SF.*B+O(O)K[1]{2}|X'],
    ['dollar and caret', '^SFBOOK$'],
  ];

  for (const [label, booking] of shapes) {
    const truncated = `{"key":"${KEY}","hotelId":"${HOTEL}","bookingCode":"${booking}","stat`;
    const verdict = classifyStored(truncated, HOTEL, booking);
    check(
      `61: a corrupt value naming a booking with ${label} still BLOCKS`,
      verdict.kind === 'corrupt',
      `${verdict.kind}${verdict.reason ? '/' + verdict.reason : ''}`,
    );
    // And the same shape belonging to somebody else must not lock this one.
    const theirs = `{"key":"${KEY}","hotelId":"39999","bookingCode":"OTHER_${booking}","stat`;
    const foreign = classifyStored(theirs, HOTEL, booking);
    check(
      `61: the same shape for another booking is not quarantined here (${label})`,
      foreign.kind === 'foreign',
      foreign.kind,
    );
  }

  check(
    '61: a value naming a booking whose code is a lone regex metacharacter blocks too',
    classifyStored('{"hotelId":"31001","bookingCode":".*","stat', '31001', '.*').kind === 'corrupt',
  );

  /**
   * 62: a corrupt primary with stale `#ack` and `#next` beside it.
   *
   * The stale pair is the dangerous combination: an acknowledgement from an
   * earlier recovery plus whatever `#next` held when it finished. If either
   * were trusted on its own the booking would unlock on evidence that says
   * nothing about the value now sitting in the primary slot.
   */
  const stale62 = fakeStorage();
  const CORRUPT62 = `{"key":"${KEY}","hotelId":"${HOTEL}","bookingCode":"${BOOKING}","stat`;
  stale62.map.set(PRIMARY, CORRUPT62);
  // A *valid* generation-1 grant naming the primary slot as the thing it
  // escapes -- left over from a recovery that has since been overtaken.
  stale62.map.set(
    ackSlotForGeneration(HOTEL, BOOKING, 1),
    grantFor(1, slotForGeneration(HOTEL, BOOKING, 0)),
  );
  stale62.map.set(recoveredIntentStorageKey(HOTEL, BOOKING), JSON.stringify(open().intent));

  const boot62 = bootFromStorage(stale62, HOTEL, BOOKING, T0, DRAFT_TTL_MS);
  /**
   * A grant naming the primary slot escapes the primary slot -- that and
   * nothing more. It promotes generation 1 because the corruption it names is
   * still the corruption in front of it; if generation 1 were ALSO corrupt it
   * would grant nothing there, which is case 75.
   */
  check(
    '62: a valid generation-1 grant escapes the primary, and says which generation',
    boot62.slot.generation === 1 && boot62.slot.quarantined === false,
    `generation=${String(boot62.slot.generation)} quarantined=${String(boot62.slot.quarantined)}`,
  );
  check(
    '62: and it records which generation it escaped, for the audit trail',
    boot62.slot.escaped.length === 1 &&
      boot62.slot.escaped[0].generation === 0 &&
      boot62.slot.escaped[0].slot === slotForGeneration(HOTEL, BOOKING, 0),
    JSON.stringify(boot62.slot.escaped),
  );
  check(
    '62: the corrupt primary is still classified corrupt, and left byte-identical',
    boot62.slot.primary.kind === 'corrupt' && stale62.map.get(PRIMARY) === CORRUPT62,
    `${boot62.slot.primary.kind} / primary ${stale62.map.get(PRIMARY) === CORRUPT62 ? 'intact' : 'MUTATED'}`,
  );
  check(
    '62: and anything it restores is routed to generation 1, never the primary',
    boot62.transition.intent === null ||
      slotFor(boot62.transition.intent) === slotForGeneration(HOTEL, BOOKING, 1),
    boot62.transition.intent === null ? 'nothing restored' : slotFor(boot62.transition.intent),
  );

  /**
   * 63: unidentifiable corruption still fails closed, and foreign data is
   * still isolated, when BOTH stale slots are present.
   *
   * The pair of properties the recovery path must never trade against each
   * other: block what might be ours, and do not block what demonstrably is
   * not.
   */
  const blind63 = fakeStorage();
  blind63.map.set(PRIMARY, '{"key":"aaa');
  blind63.map.set(recoveredIntentStorageKey(HOTEL, BOOKING), JSON.stringify(open().intent));
  const boot63 = bootFromStorage(blind63, HOTEL, BOOKING, T0, DRAFT_TTL_MS);
  check(
    '63: unidentifiable corruption + a stale #next and NO #ack still quarantines',
    boot63.transition.intent?.status === 'QUARANTINED' &&
      boot63.transition.intent.quarantine === 'unidentified' &&
      boot63.slot.generation === 0 &&
      boot63.slot.quarantined === true,
    `${String(boot63.transition.intent?.status)} generation=${String(boot63.slot.generation)}`,
  );
  check(
    '63: and the stale #next was not read -- the live slot is still the primary',
    boot63.slot.raw === '{"key":"aaa',
    String(boot63.slot.raw),
  );

  const theirs63 = fakeStorage();
  theirs63.map.set(
    PRIMARY,
    JSON.stringify({ ...open().intent, hotelId: '39999', bookingCode: 'SFBOOKING_39999_Z' }),
  );
  theirs63.map.set(recoveredIntentStorageKey(HOTEL, BOOKING), JSON.stringify(open().intent));
  const bootTheirs = bootFromStorage(theirs63, HOTEL, BOOKING, T0, DRAFT_TTL_MS);
  check(
    '63: a readable record for another booking is isolated, not quarantined',
    bootTheirs.slot.primary.kind === 'foreign' &&
      bootTheirs.transition.intent === null &&
      bootTheirs.slot.generation === 0 &&
      bootTheirs.slot.quarantined === false,
    `${bootTheirs.slot.primary.kind} intent=${String(bootTheirs.transition.intent)}`,
  );
}

/* -------------------------------------------------------------------------- */
/*  71 - 78  The REAL boot slot resolution                                    */
/* -------------------------------------------------------------------------- */

/**
 * These drive `bootFromStorage`, which is what the hook calls.
 *
 * ===========================================================================
 * Previously this ground was covered by a `boot()` helper in this file that
 * called the reducer directly with a hand-supplied `acknowledged` flag and a
 * hand-chosen raw string. It therefore tested a **copy** of the slot-choosing
 * algorithm rather than the algorithm, and an audit pointed out the obvious
 * consequence: the copy and the production path could drift apart without a
 * single failing check, while every quarantine guarantee rested on the copy.
 *
 * So the algorithm moved into `payment-intent.ts` as `resolveLiveSlot` /
 * `bootFromStorage`, `use-payment-intent.ts` now does nothing but call it and
 * apply the effect, and these cases drive it against a fake store. Nothing
 * here reimplements the order of the three reads.
 * ===========================================================================
 */

console.log('\n71-78. The real boot slot resolution, driven through bootFromStorage.');
{
  const PRIMARY = intentStorageKey(HOTEL, BOOKING);
  const ACK = acknowledgementStorageKey(HOTEL, BOOKING);
  const NEXT = recoveredIntentStorageKey(HOTEL, BOOKING);

  const CORRUPT = `{"key":"${KEY}","hotelId":"${HOTEL}","bookingCode":"${BOOKING}","stat`;
  const GEN0 = slotForGeneration(HOTEL, BOOKING, 0);
  const GEN1 = slotForGeneration(HOTEL, BOOKING, 1);
  const GEN2 = slotForGeneration(HOTEL, BOOKING, 2);
  const ACK2 = ackSlotForGeneration(HOTEL, BOOKING, 2);
  /** A valid generation-1 grant: escapes the primary slot. */
  const goodAck = grantFor(1, GEN0);

  const bootIn = (entries) => {
    const store = fakeStorage();
    for (const [slot, value] of entries) store.map.set(slot, value);
    return { store, ...bootFromStorage(store, HOTEL, BOOKING, T0, DRAFT_TTL_MS) };
  };

  /* ------------------------------------------------------------------ 71 */
  const b71 = bootIn([[PRIMARY, CORRUPT]]);
  check(
    '71: corrupt primary, no acknowledgement -> QUARANTINED, nothing written',
    b71.transition.intent?.status === 'QUARANTINED' &&
      b71.transition.effect.type === 'none' &&
      b71.slot.generation === 0 &&
      b71.store.map.get(PRIMARY) === CORRUPT,
    `${String(b71.transition.intent?.status)} effect=${b71.transition.effect.type}`,
  );
  check(
    '71: and the live slot it chose was the primary, quarantined there',
    b71.slot.raw === CORRUPT && b71.slot.quarantined === true && b71.slot.slot === PRIMARY,
    `slot=${b71.slot.slot} quarantined=${String(b71.slot.quarantined)}`,
  );

  /* ------------------------------------------------------------------ 72 */
  for (const [label, ack] of [
    ['truncated', '{"v":2,"hotelId"'],
    ['the old v1 open-ended grant', grantFor(1, GEN0, { v: 1 })],
    ['a future version', grantFor(1, GEN0, { v: 3 })],
    ['no ledgerOpenedAt', JSON.stringify({ v: 2, hotelId: HOTEL, bookingCode: BOOKING, generation: 1, fromSlot: GEN0, acknowledgedAt: T0 })],
    // The two bindings that make a grant specific rather than open-ended.
    ['a grant for a DIFFERENT generation', grantFor(2, GEN0)],
    ['a grant naming a DIFFERENT source slot', grantFor(1, GEN1)],
    ['unparseable timestamp', goodAck.replace(T0, 'not-a-date')],
    ['not an object', '"yes"'],
    ['empty', ''],
  ]) {
    const b = bootIn([
      [PRIMARY, CORRUPT],
      [ACK, ack],
      [NEXT, JSON.stringify(open().intent)],
    ]);
    check(
      `72: corrupt primary + a ${label} acknowledgement stays QUARANTINED`,
      b.transition.intent?.status === 'QUARANTINED' &&
        b.slot.generation === 0 &&
        b.slot.quarantined === true &&
        b.slot.raw === CORRUPT,
      `${String(b.transition.intent?.status)} generation=${String(b.slot.generation)}`,
    );
  }

  /* ------------------------------------------------------------------ 73 */
  for (const [label, ack] of [
    [
      'another booking',
      JSON.stringify({
        v: 1,
        hotelId: HOTEL,
        bookingCode: 'SFBOOKING_31001_ZZZ',
        acknowledgedAt: T0,
        ledgerOpenedAt: T0,
      }),
    ],
    [
      'another property',
      JSON.stringify({
        v: 1,
        hotelId: '31002',
        bookingCode: BOOKING,
        acknowledgedAt: T0,
        ledgerOpenedAt: T0,
      }),
    ],
  ]) {
    const b = bootIn([
      [PRIMARY, CORRUPT],
      [ACK, ack],
      [NEXT, JSON.stringify(open().intent)],
    ]);
    check(
      `73: an acknowledgement for ${label} cannot unlock this booking`,
      b.transition.intent?.status === 'QUARANTINED' && b.slot.generation === 0,
      `${String(b.transition.intent?.status)} generation=${String(b.slot.generation)}`,
    );
  }

  /* ------------------------------------------------------------------ 74 */
  const stored74 = JSON.stringify(open().intent);
  const b74 = bootIn([
    [PRIMARY, CORRUPT],
    [ACK, goodAck],
    [NEXT, stored74],
  ]);
  check(
    '74: valid acknowledgement + valid #next restores the DRAFT from #next',
    b74.transition.intent?.status === 'DRAFT' &&
      b74.transition.intent.key === KEY &&
      b74.transition.intent.generation === 1 &&
      b74.slot.generation === 1 &&
      b74.slot.quarantined === false,
    `${String(b74.transition.intent?.status)} generation=${String(b74.transition.intent?.generation)}`,
  );
  check(
    '74: and the corrupt primary is untouched, so the evidence survives recovery',
    b74.store.map.get(PRIMARY) === CORRUPT && slotFor(b74.transition.intent) === GEN1,
    `primary ${b74.store.map.get(PRIMARY) === CORRUPT ? 'intact' : 'MUTATED'}`,
  );

  /* ------------------------------------------------------------------ 75 */
  const b75 = bootIn([
    [PRIMARY, CORRUPT],
    [ACK, goodAck],
    [NEXT, '{"key":"bbb'],
  ]);
  /**
   * A corrupt `#next` quarantines at generation 1. This was the defect.
   *
   * =====================================================================
   * Previously the generation-1 grant was open-ended: it said "escape the
   * primary" with no generation and no source slot, so once given it
   * promoted `#next` permanently. An unreadable `#next` was therefore read
   * as an empty booking -- `OPEN_SHEET` minted a fresh key straight over
   * the top of it and a second payment went out while the first was still
   * unaccounted for.
   *
   * The grant now names generation 1 and the primary slot. Generation 1's
   * own corruption needs its own grant, which does not exist here, so the
   * walk stops and quarantines -- at generation 1, over the `#next` bytes.
   * =====================================================================
   */
  const CORRUPT_NEXT = '{"key":"bbb';
  check(
    '75: valid generation-1 grant + corrupt #next QUARANTINES at generation 1',
    b75.transition.intent?.status === 'QUARANTINED' &&
      b75.transition.intent.generation === 1 &&
      b75.transition.intent.key === null &&
      b75.slot.quarantined === true &&
      b75.slot.slot === GEN1,
    `${String(b75.transition.intent?.status)} generation=${String(b75.transition.intent?.generation)}`,
  );
  check(
    '75: both corrupt generations survive byte-for-byte',
    b75.store.map.get(PRIMARY) === CORRUPT && b75.store.map.get(NEXT) === CORRUPT_NEXT,
    `primary ${b75.store.map.get(PRIMARY) === CORRUPT ? 'intact' : 'MUTATED'} / #next ${b75.store.map.get(NEXT) === CORRUPT_NEXT ? 'intact' : 'MUTATED'}`,
  );
  check(
    '75: no payment can be submitted, and the form is not editable',
    blocksPaymentSubmission(b75.transition.intent) === true &&
      isFormEditable(b75.transition.intent) === false &&
      blocksNewPayment(b75.transition.intent) === true,
    `intent=${String(b75.transition.intent?.status ?? null)}`,
  );
  /** The exact escape the old protocol allowed: mint over the corrupt bytes. */
  const hijack75 = reducePaymentIntent(b75.transition.intent, {
    type: 'OPEN_SHEET',
    hotelId: HOTEL,
    bookingCode: BOOKING,
    key: KEY,
    now: T0,
    generation: b75.slot.generation,
  });
  check(
    '75: OPEN_SHEET cannot mint a replacement key over a corrupt #next',
    hijack75.intent?.status === 'QUARANTINED' &&
      hijack75.intent.key === null &&
      hijack75.effect.type === 'none',
    `status=${String(hijack75.intent?.status)} key=${String(hijack75.intent?.key)}`,
  );
  check(
    '75: and persisting what it returned writes nothing, so #next is still intact',
    persistIntent(b75.store, hijack75.intent) === 'memory-only' &&
      b75.store.map.get(NEXT) === CORRUPT_NEXT,
    `#next ${b75.store.map.get(NEXT) === CORRUPT_NEXT ? 'intact' : 'MUTATED'}`,
  );
  const submit75 = reducePaymentIntent(hijack75.intent, {
    type: 'SUBMIT',
    snapshot: SNAP,
    now: T0,
  });
  const hijackPost75 = report(submit75.intent);
  check(
    '75: and no POST can be released -- SUBMIT is refused, so nothing is in flight',
    submit75.rejected === true &&
      submit75.effect.type === 'none' &&
      hijackPost75.effect.type === 'none',
    `submit=${submit75.effect.type} rejected=${String(submit75.rejected)} durability=${hijackPost75.effect.type}`,
  );

  /* ------------------------------------------------------------------ 76 */
  const foreign76 = JSON.stringify({
    ...open().intent,
    hotelId: '39999',
    bookingCode: 'SFBOOKING_39999_Z',
  });
  const b76 = bootIn([
    [PRIMARY, foreign76],
    [ACK, goodAck],
    [NEXT, JSON.stringify(open().intent)],
  ]);
  check(
    '76: a VALID foreign primary is not corrupt, so a stale #ack promotes nothing',
    b76.slot.primary.kind === 'foreign' &&
      b76.slot.quarantined === false &&
      b76.slot.generation === 0 &&
      b76.slot.escaped.length === 0,
    `${b76.slot.primary.kind} generation=${String(b76.slot.generation)}`,
  );
  check(
    '76: the live slot is the primary, and the stale #next was never read',
    b76.slot.raw === foreign76 && b76.transition.intent === null,
    `intent=${String(b76.transition.intent)}`,
  );

  /* ------------------------------------------------------------------ 77 */
  const b77 = bootIn([
    [ACK, goodAck],
    [NEXT, JSON.stringify(open().intent)],
  ]);
  check(
    '77: an EMPTY primary + stale #ack/#next resolves to the primary, not #next',
    b77.slot.primary.kind === 'empty' &&
      b77.slot.quarantined === false &&
      b77.slot.generation === 0 &&
      b77.slot.raw === null,
    `${b77.slot.primary.kind} raw=${String(b77.slot.raw)}`,
  );
  check(
    '77: so a stale post-recovery DRAFT cannot be resurrected as this booking is',
    b77.transition.intent === null && b77.transition.effect.type === 'none',
    `intent=${String(b77.transition.intent)} effect=${b77.transition.effect.type}`,
  );

  /* ------------------------------------------------------------------ 78 */
  /**
   * Reload at every recovery stage, each one a fresh `bootFromStorage` over
   * the store as the previous stage actually left it.
   */
  const live = fakeStorage();
  live.map.set(PRIMARY, CORRUPT);

  const stage1 = bootFromStorage(live, HOTEL, BOOKING, T0, DRAFT_TTL_MS);
  check(
    '78: reload at stage 1 (corrupt, nothing done) -> QUARANTINED, ledger not opened',
    stage1.transition.intent?.status === 'QUARANTINED' &&
      stage1.transition.intent.ledgerOpenedAt === null,
    `ledgerOpenedAt=${String(stage1.transition.intent?.ledgerOpenedAt)}`,
  );

  const opened = reducePaymentIntent(stage1.transition.intent, {
    type: 'OPEN_LEDGER',
    now: '2026-11-01T10:05:00.000Z',
  });
  const stage2 = bootFromStorage(live, HOTEL, BOOKING, T0, DRAFT_TTL_MS);
  check(
    '78: reload at stage 2 (ledger opened) -> back to step 1, nothing granted',
    opened.intent?.ledgerOpenedAt === '2026-11-01T10:05:00.000Z' &&
      stage2.transition.intent?.status === 'QUARANTINED' &&
      stage2.transition.intent.ledgerOpenedAt === null,
    `reloaded ledgerOpenedAt=${String(stage2.transition.intent?.ledgerOpenedAt)}`,
  );

  const asked78 = reducePaymentIntent(opened.intent, {
    type: 'ACKNOWLEDGE_UNREADABLE',
    now: '2026-11-01T10:06:00.000Z',
  });
  check(
    '78: the acknowledgement is still written AND read back before it counts',
    asked78.effect.type === 'acknowledge' &&
      asked78.intent?.status === 'QUARANTINED' &&
      persistAcknowledgement(live, asked78.effect.record) === true,
    `effect=${asked78.effect.type} still=${String(asked78.intent?.status)}`,
  );

  const stage3 = bootFromStorage(live, HOTEL, BOOKING, T0, DRAFT_TTL_MS);
  check(
    '78: reload at stage 3 (acknowledged, no new DRAFT) -> no quarantine, generation 1 live',
    stage3.transition.intent === null &&
      stage3.slot.generation === 1 &&
      stage3.slot.quarantined === false,
    `intent=${String(stage3.transition.intent)} generation=${String(stage3.slot.generation)}`,
  );

  const newDraft = reducePaymentIntent(null, {
    type: 'OPEN_SHEET',
    hotelId: HOTEL,
    bookingCode: BOOKING,
    key: OTHER_KEY,
    now: T0,
    generation: stage3.slot.generation,
  });
  check(
    '78: the new DRAFT is minted into #next and persists there',
    persistIntent(live, newDraft.intent) === 'persisted' &&
      live.map.get(NEXT) !== undefined &&
      live.map.get(PRIMARY) === CORRUPT,
    `primary ${live.map.get(PRIMARY) === CORRUPT ? 'intact' : 'MUTATED'}`,
  );

  const stage4 = bootFromStorage(live, HOTEL, BOOKING, T0, DRAFT_TTL_MS);
  check(
    '78: reload at stage 4 (new DRAFT) -> restored from #next, still generation 1',
    stage4.transition.intent?.status === 'DRAFT' &&
      stage4.transition.intent.key === OTHER_KEY &&
      stage4.transition.intent.generation === 1,
    `${String(stage4.transition.intent?.status)} key=${String(stage4.transition.intent?.key)}`,
  );
  check(
    '78: and after all four reloads the corrupt primary is byte-identical',
    live.map.get(PRIMARY) === CORRUPT,
    live.map.get(PRIMARY) === CORRUPT ? 'byte-identical' : 'MUTATED',
  );
}

/* -------------------------------------------------------------------------- */
/*  79 - 83  Exactly one POST per submission                                  */
/* -------------------------------------------------------------------------- */

/**
 * `status === 'IN_FLIGHT'` is not enough to authorise a request.
 *
 * ===========================================================================
 * `DURABILITY` used to release a POST for any in-flight intent. That held only
 * because `SUBMIT` and `CONFIRM` happen to be the only transitions that
 * persist while leaving the status IN_FLIGHT -- an invariant nothing asserted,
 * which any future transition could break silently, and which said nothing
 * about a durability callback arriving twice.
 *
 * A submission now names itself, the report must present the matching token,
 * and the token is spent on first use. These cases are the assertion the old
 * design was missing.
 * ===========================================================================
 */

console.log('\n79-83. Exactly one POST per submission, and only a durable one.');
{
  /* ------------------------------------------------------------------ 79 */
  const draft = open().intent;
  const submitted = reducePaymentIntent(draft, { type: 'SUBMIT', snapshot: SNAP, now: T0 });
  check(
    '79: SUBMIT mints a token and emits persist, never post',
    submitted.effect.type === 'persist' &&
      typeof submitted.intent?.pendingSubmission === 'string' &&
      submitted.intent.pendingSubmission.startsWith(KEY),
    `effect=${submitted.effect.type}`,
  );
  const once = report(submitted.intent);
  check(
    '79: a durable report releases exactly one POST, and spends the token',
    once.effect.type === 'post' &&
      once.effect.durability === 'persisted' &&
      once.effect.key === KEY &&
      once.intent?.pendingSubmission === null,
    `effect=${once.effect.type} pending=${String(once.intent?.pendingSubmission)}`,
  );

  /* ------------------------------------------------------------------ 80 */
  const viaConfirm = toInFlight('UNRESOLVED');
  check(
    '80: CONFIRM releases exactly one POST after durability, under the same key',
    viaConfirm.effect.type === 'post' &&
      viaConfirm.effect.key === KEY &&
      viaConfirm.effect.durability === 'persisted' &&
      viaConfirm.intent?.pendingSubmission === null,
    `effect=${viaConfirm.effect.type}`,
  );

  /* ------------------------------------------------------------------ 81 */
  const replay = reducePaymentIntent(once.intent, {
    type: 'DURABILITY',
    durability: 'persisted',
    // The very token the first report used.
    submission: submitted.intent.pendingSubmission,
  });
  check(
    '81: a duplicate durability callback cannot release a second POST',
    replay.effect.type === 'none' && replay.intent?.status === 'IN_FLIGHT',
    `effect=${replay.effect.type} status=${String(replay.intent?.status)}`,
  );
  const thirdTime = report(once.intent);
  check(
    '81: nor can a report that presents no token at all',
    thirdTime.effect.type === 'none',
    thirdTime.effect.type,
  );

  /* ------------------------------------------------------------------ 82 */
  /**
   * An unrelated persist that happens to leave the intent IN_FLIGHT.
   *
   * Constructed directly, because no current transition produces it -- which
   * is exactly the point: this is the shape a future transition would have,
   * and under the old design it would have sent a payment nobody asked for.
   */
  const unrelated = reducePaymentIntent(
    { ...once.intent, pendingSubmission: null },
    { type: 'DURABILITY', durability: 'persisted' },
  );
  check(
    '82: an unrelated IN_FLIGHT persistence releases nothing',
    unrelated.effect.type === 'none' && unrelated.intent?.status === 'IN_FLIGHT',
    `effect=${unrelated.effect.type}`,
  );
  const foreignToken = reducePaymentIntent(submitted.intent, {
    type: 'DURABILITY',
    durability: 'persisted',
    submission: `${OTHER_KEY}#1`,
  });
  check(
    '82: and a report naming a DIFFERENT submission releases nothing',
    foreignToken.effect.type === 'none' && foreignToken.intent?.pendingSubmission !== null,
    `effect=${foreignToken.effect.type}`,
  );

  /* ------------------------------------------------------------------ 83 */
  /**
   * A stale callback arriving after the state moved on.
   *
   * The submission was answered -- settled, in this case -- and the late
   * report still carries the token that was valid when it was issued.
   */
  const settled83 = reducePaymentIntent(once.intent, {
    type: 'OUTCOME',
    outcome: { kind: 'settled' },
  });
  check('83: the submission settled and cleared the intent', settled83.intent === null);
  const lateAfterSettle = reducePaymentIntent(settled83.intent, {
    type: 'DURABILITY',
    durability: 'persisted',
    submission: submitted.intent.pendingSubmission,
  });
  check(
    '83: a stale report after a settled payment releases nothing',
    lateAfterSettle.effect.type === 'none' && lateAfterSettle.rejected === true,
    `effect=${lateAfterSettle.effect.type}`,
  );

  const ambiguous83 = reducePaymentIntent(once.intent, {
    type: 'OUTCOME',
    outcome: { kind: 'ambiguous', reason: 'unreachable' },
  });
  const lateAfterAmbiguous = reducePaymentIntent(ambiguous83.intent, {
    type: 'DURABILITY',
    durability: 'persisted',
    submission: submitted.intent.pendingSubmission,
  });
  check(
    '83: and a stale report after an ambiguous reply releases nothing either',
    lateAfterAmbiguous.effect.type === 'none' &&
      lateAfterAmbiguous.intent?.status === 'UNRESOLVED' &&
      lateAfterAmbiguous.intent.key === KEY,
    `effect=${lateAfterAmbiguous.effect.type} status=${String(lateAfterAmbiguous.intent?.status)}`,
  );

  /* ---- and the non-durable path, from both entry points ---- */
  const blockedFromDraft = report(submitted.intent, 'memory-only');
  check(
    '83: a non-durable SUBMIT lands back in DRAFT, keeps the key, sends nothing',
    blockedFromDraft.effect.type === 'blocked' &&
      blockedFromDraft.intent?.status === 'DRAFT' &&
      blockedFromDraft.intent.key === KEY &&
      blockedFromDraft.intent.pendingSubmission === null,
    `effect=${blockedFromDraft.effect.type} status=${String(blockedFromDraft.intent?.status)}`,
  );
  const unresolved83 = reducePaymentIntent(toInFlight('DRAFT').intent, {
    type: 'OUTCOME',
    outcome: { kind: 'ambiguous', reason: 'unreachable' },
  }).intent;
  const confirm83 = reducePaymentIntent(unresolved83, { type: 'CONFIRM', now: T0 });
  const blockedFromConfirm = report(confirm83.intent, 'memory-only');
  check(
    '83: a non-durable CONFIRM returns to UNRESOLVED, never an editable form',
    blockedFromConfirm.effect.type === 'blocked' &&
      blockedFromConfirm.intent?.status === 'UNRESOLVED' &&
      blockedFromConfirm.intent.snapshot !== null &&
      blockedFromConfirm.intent.key === KEY,
    `status=${String(blockedFromConfirm.intent?.status)}`,
  );
  check(
    '83: a blocked submission cannot be submitted again without a fresh SUBMIT',
    blocksPaymentSubmission(blockedFromConfirm.intent) === true &&
      reducePaymentIntent(blockedFromConfirm.intent, {
        type: 'DURABILITY',
        durability: 'persisted',
        submission: confirm83.intent.pendingSubmission,
      }).effect.type === 'none',
  );
}

/* -------------------------------------------------------------------------- */
/*  84 - 90  Repeated recovery: generational slots and generation-bound grants */
/* -------------------------------------------------------------------------- */

/**
 * The defect these cases exist for, stated once.
 *
 * ===========================================================================
 * A grant used to say only "escape the primary", with no generation and no
 * source slot, so once given it promoted the recovery slot permanently. The
 * sequence that broke it: corrupt primary, acknowledge, take a payment into
 * `#next`, lose the response, then have `#next` itself truncated, then reload.
 * Boot read the unreadable `#next` as an **empty booking**, `OPEN_SHEET`
 * minted a fresh key over the top of the evidence, and a second payment went
 * out under it while the first was still unaccounted for.
 *
 * Every grant now names the generation it authorises and the exact slot whose
 * corruption it escapes, and boot walks generations rather than taking one
 * branch. Corruption at any generation stops the walk there.
 * ===========================================================================
 */

console.log('\n84-90. Repeated recovery, and the generation-bound grant.');
{
  const GEN = (g) => slotForGeneration(HOTEL, BOOKING, g);
  const ACKFOR = (g) => ackSlotForGeneration(HOTEL, BOOKING, g);

  const CORRUPT0 = `{"key":"${KEY}","hotelId":"${HOTEL}","bookingCode":"${BOOKING}","stat`;
  const CORRUPT1 = `{"key":"${OTHER_KEY}","hotelId":"${HOTEL}","bookingCode":"${BOOKING}","sta`;

  const storeWith = (entries) => {
    const store = fakeStorage();
    for (const [slot, value] of entries) store.map.set(slot, value);
    return store;
  };
  const reload = (store) => bootFromStorage(store, HOTEL, BOOKING, T0, DRAFT_TTL_MS);

  /* ------------------------------------------------------------------ 84 */
  /**
   * The reported failure, end to end, through the real boot path.
   */
  const s84 = storeWith([
    [GEN(0), CORRUPT0],
    [ACKFOR(1), grantFor(1, GEN(0))],
    [GEN(1), CORRUPT1],
  ]);
  const b84 = reload(s84);
  check(
    '84: a corrupt #next cannot produce a clean DRAFT -- it quarantines at generation 1',
    b84.transition.intent?.status === 'QUARANTINED' &&
      b84.transition.intent.generation === 1 &&
      b84.transition.effect.type === 'none',
    `${String(b84.transition.intent?.status)} generation=${String(b84.transition.intent?.generation)}`,
  );
  check(
    '84: a corrupt #next cannot generate a replacement key',
    b84.transition.intent?.key === null &&
      reducePaymentIntent(b84.transition.intent, {
        type: 'OPEN_SHEET',
        hotelId: HOTEL,
        bookingCode: BOOKING,
        key: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        now: T0,
        generation: b84.slot.generation,
      }).intent?.key === null,
  );
  const post84 = report(
    reducePaymentIntent(b84.transition.intent, { type: 'SUBMIT', snapshot: SNAP, now: T0 })
      .intent,
  );
  check(
    '84: a corrupt #next cannot release a POST',
    post84.effect.type === 'none',
    post84.effect.type,
  );
  check(
    '84: and the booking is quarantined over the #next bytes, not the primary',
    b84.slot.slot === GEN(1) && b84.slot.quarantined === true && b84.slot.raw === CORRUPT1,
    `slot=${b84.slot.slot}`,
  );
  check(
    '84: the escape trail names generation 0 as the one already acknowledged',
    b84.slot.escaped.length === 1 && b84.slot.escaped[0].slot === GEN(0),
    JSON.stringify(b84.slot.escaped),
  );

  /* ------------------------------------------------------------------ 85 */
  /**
   * Second recovery, driven entirely through the production transitions, and
   * then a reload at each step.
   */
  const s85 = storeWith([
    [GEN(0), CORRUPT0],
    [ACKFOR(1), grantFor(1, GEN(0))],
    [GEN(1), CORRUPT1],
  ]);
  const q85 = reload(s85).transition.intent;
  const opened85 = reducePaymentIntent(q85, { type: 'OPEN_LEDGER', now: T0 });
  const asked85 = reducePaymentIntent(opened85.intent, {
    type: 'ACKNOWLEDGE_UNREADABLE',
    now: '2026-11-01T11:00:00.000Z',
  });
  check(
    '85: the second grant names generation 2 and the #next slot it escapes',
    asked85.effect.type === 'acknowledge' &&
      asked85.effect.record.generation === 2 &&
      asked85.effect.record.fromSlot === GEN(1) &&
      asked85.effect.record.v === 2,
    asked85.effect.type === 'acknowledge' ? JSON.stringify(asked85.effect.record) : 'no record',
  );
  check(
    '85: writing it lands in its OWN slot, leaving the first grant in place',
    asked85.effect.type === 'acknowledge' &&
      persistAcknowledgement(s85, asked85.effect.record) === true &&
      s85.map.get(ACKFOR(2)) !== undefined &&
      s85.map.get(ACKFOR(1)) === grantFor(1, GEN(0)),
    `ack1 ${s85.map.get(ACKFOR(1)) === grantFor(1, GEN(0)) ? 'intact' : 'MUTATED'}`,
  );

  const b85 = reload(s85);
  check(
    '85: and the walk now reaches generation 2, which is empty and clean',
    b85.slot.generation === 2 &&
      b85.slot.quarantined === false &&
      b85.transition.intent === null &&
      b85.slot.escaped.length === 2,
    `generation=${String(b85.slot.generation)} escaped=${JSON.stringify(b85.slot.escaped)}`,
  );

  const draft85 = reducePaymentIntent(null, {
    type: 'OPEN_SHEET',
    hotelId: HOTEL,
    bookingCode: BOOKING,
    key: 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    now: T0,
    generation: b85.slot.generation,
  });
  check(
    '85: the new DRAFT is minted into generation 2',
    slotFor(draft85.intent) === GEN(2) && persistIntent(s85, draft85.intent) === 'persisted',
    slotFor(draft85.intent),
  );
  check(
    '85: REPEATED RECOVERY PRESERVES EARLIER EVIDENCE -- both corrupt generations byte-identical',
    s85.map.get(GEN(0)) === CORRUPT0 && s85.map.get(GEN(1)) === CORRUPT1,
    `gen0 ${s85.map.get(GEN(0)) === CORRUPT0 ? 'intact' : 'MUTATED'} / gen1 ${s85.map.get(GEN(1)) === CORRUPT1 ? 'intact' : 'MUTATED'}`,
  );
  const b85again = reload(s85);
  check(
    '85: and a reload after the second recovery restores it from generation 2',
    b85again.transition.intent?.status === 'DRAFT' &&
      b85again.transition.intent.generation === 2 &&
      b85again.transition.intent.key === 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    `${String(b85again.transition.intent?.status)} generation=${String(b85again.transition.intent?.generation)}`,
  );

  /* ------------------------------------------------------------------ 86 */
  /**
   * The binding, tested on its own: a grant is spent on the generation and
   * the slot it names, and nowhere else.
   */
  for (const [label, entries, stopsAt] of [
    // A generation-2 grant that names the PRIMARY -- the slot it escapes is
    // not the slot the walk is stuck on.
    ['names the wrong source slot', [[ACKFOR(2), grantFor(2, GEN(0))]], 1],
    // A generation-1 grant duplicated into the generation-2 slot.
    ['the first grant copied forward', [[ACKFOR(2), grantFor(1, GEN(0))]], 1],
    /**
     * A generation-2 grant filed under `#ack`, replacing the valid one.
     *
     * The walk stops at generation **0**, not 1: the grant it finds there
     * names generation 2, so it does not authorise escaping the primary.
     * Which is the point -- a grant cannot be relocated into another
     * generation's slot and still work.
     */
    ['filed under the wrong ack slot', [[ACKFOR(1), grantFor(2, GEN(1))]], 0],
  ]) {
    const store = storeWith([
      [GEN(0), CORRUPT0],
      [ACKFOR(1), grantFor(1, GEN(0))],
      [GEN(1), CORRUPT1],
      ...entries,
    ]);
    const b = reload(store);
    check(
      `86: a grant that ${label} escapes nothing`,
      b.transition.intent?.status === 'QUARANTINED' &&
        b.transition.intent.generation === stopsAt &&
        store.map.get(GEN(0)) === CORRUPT0 &&
        store.map.get(GEN(1)) === CORRUPT1,
      `${String(b.transition.intent?.status)} at generation ${String(b.transition.intent?.generation)}, expected ${String(stopsAt)}`,
    );
  }

  /* ------------------------------------------------------------------ 87 */
  const s87 = storeWith([
    [GEN(0), CORRUPT0],
    [ACKFOR(1), grantFor(1, GEN(0))],
  ]);
  const b87 = reload(s87);
  check(
    '87: a MISSING #next after a valid grant is a clean generation 1, not a quarantine',
    b87.slot.generation === 1 &&
      b87.slot.quarantined === false &&
      b87.slot.raw === null &&
      b87.transition.intent === null,
    `generation=${String(b87.slot.generation)} raw=${String(b87.slot.raw)}`,
  );
  check(
    '87: an empty slot is still told apart from corrupt data',
    b87.slot.verdict.kind === 'empty',
    b87.slot.verdict.kind,
  );

  /* ------------------------------------------------------------------ 88 */
  const foreign88 = JSON.stringify({
    ...open().intent,
    hotelId: '39999',
    bookingCode: 'SFBOOKING_39999_Z',
  });
  const s88 = storeWith([
    [GEN(0), CORRUPT0],
    [ACKFOR(1), grantFor(1, GEN(0))],
    [GEN(1), foreign88],
  ]);
  const b88 = reload(s88);
  check(
    '88: VALID FOREIGN data at generation 1 is not mistaken for local corruption',
    b88.slot.generation === 1 &&
      b88.slot.verdict.kind === 'foreign' &&
      b88.slot.quarantined === false &&
      b88.transition.intent === null,
    `${b88.slot.verdict.kind} quarantined=${String(b88.slot.quarantined)}`,
  );
  check(
    '88: and it is left exactly where it is -- not this booking to clean up',
    s88.map.get(GEN(1)) === foreign88,
    s88.map.get(GEN(1)) === foreign88 ? 'intact' : 'MUTATED',
  );

  /* ------------------------------------------------------------------ 89 */
  /**
   * A failed second-generation grant leaves the booking quarantined at
   * generation 1 -- the same fail-closed rule as the first recovery, now at
   * every generation.
   */
  for (const [label, options] of [
    ['throws', { throwOnSet: true }],
    ['silently discards', { silentlyDiscard: true }],
    ['truncates', { corruptOnWrite: true }],
    ['cannot be read back', { throwOnGet: true }],
  ]) {
    const store = fakeStorage(options);
    store.map.set(GEN(0), CORRUPT0);
    store.map.set(ACKFOR(1), grantFor(1, GEN(0)));
    store.map.set(GEN(1), CORRUPT1);
    const q = reload(store).transition.intent;
    const ask = reducePaymentIntent(
      reducePaymentIntent(q, { type: 'OPEN_LEDGER', now: T0 }).intent,
      { type: 'ACKNOWLEDGE_UNREADABLE', now: T0 },
    );
    const written = ask.effect.type === 'acknowledge' && persistAcknowledgement(store, ask.effect.record);
    check(
      `89: a second-generation grant that ${label} reports failure`,
      written === false,
      `written=${String(written)}`,
    );
    /**
     * `throwOnGet` breaks every read, not just the grant's read-back, so a
     * reload through that fake sees an empty store and cannot be asked about
     * the quarantine. The evidence is inspected directly instead -- which is
     * the property that matters for a store that cannot be read: nothing was
     * destroyed, and no grant was recorded.
     */
    check(
      `89: so no grant is recorded and both corrupt generations are intact (${label})`,
      store.map.get(ACKFOR(2)) !== grantFor(2, GEN(1)) &&
        store.map.get(GEN(0)) === CORRUPT0 &&
        store.map.get(GEN(1)) === CORRUPT1,
      `ack2=${String(store.map.get(ACKFOR(2)))?.slice(0, 24)}`,
    );
    if (options.throwOnGet !== true) {
      check(
        `89: and a reload still quarantines at generation 1 (${label})`,
        reload(store).transition.intent?.status === 'QUARANTINED' &&
          reload(store).transition.intent?.generation === 1,
        String(reload(store).transition.intent?.generation),
      );
    }
  }
  check(
    '89: and a null store cannot grant a second generation either',
    persistAcknowledgement(null, {
      v: 2,
      hotelId: HOTEL,
      bookingCode: BOOKING,
      generation: 2,
      fromSlot: GEN(1),
      acknowledgedAt: T0,
      ledgerOpenedAt: T0,
    }) === false,
  );

  /* ------------------------------------------------------------------ 90 */
  /** Duplicate callbacks, and the bound. */
  const s90 = storeWith([
    [GEN(0), CORRUPT0],
    [ACKFOR(1), grantFor(1, GEN(0))],
    [GEN(1), CORRUPT1],
  ]);
  const q90 = reload(s90).transition.intent;
  const ask90 = reducePaymentIntent(
    reducePaymentIntent(q90, { type: 'OPEN_LEDGER', now: T0 }).intent,
    { type: 'ACKNOWLEDGE_UNREADABLE', now: T0 },
  );
  check(
    '90: a duplicate write of the same second-generation grant is idempotent',
    ask90.effect.type === 'acknowledge' &&
      persistAcknowledgement(s90, ask90.effect.record) === true &&
      persistAcknowledgement(s90, ask90.effect.record) === true &&
      s90.map.get(ACKFOR(2)) === JSON.stringify(ask90.effect.record),
  );
  const lifted90 = reducePaymentIntent(ask90.intent, { type: 'ACKNOWLEDGE_VERIFIED' });
  check(
    '90: and acknowledging twice is rejected once the quarantine is lifted',
    lifted90.intent === null &&
      reducePaymentIntent(lifted90.intent, { type: 'ACKNOWLEDGE_UNREADABLE', now: T0 })
        .rejected === true,
  );

  /**
   * The bound fails closed. Every generation corrupt, every grant present:
   * the walk must still refuse to run past `MAX_RECOVERY_GENERATIONS`.
   */
  const sBound = fakeStorage();
  for (let g = 0; g <= MAX_RECOVERY_GENERATIONS; g += 1) {
    sBound.map.set(GEN(g), `{"key":"${KEY}","hotelId":"${HOTEL}","bookingCode":"${BOOKING}","g${String(g)}`);
    if (g >= 1) sBound.map.set(ACKFOR(g), grantFor(g, GEN(g - 1)));
  }
  sBound.map.set(ACKFOR(MAX_RECOVERY_GENERATIONS + 1), grantFor(MAX_RECOVERY_GENERATIONS + 1, GEN(MAX_RECOVERY_GENERATIONS)));
  const bBound = reload(sBound);
  check(
    '90: the generation bound fails CLOSED -- quarantined at the last generation',
    bBound.transition.intent?.status === 'QUARANTINED' &&
      bBound.slot.quarantined === true &&
      bBound.slot.generation === MAX_RECOVERY_GENERATIONS,
    `generation=${String(bBound.slot.generation)} of ${String(MAX_RECOVERY_GENERATIONS)}`,
  );
  check(
    '90: and the reducer refuses to grant a generation past the bound',
    reducePaymentIntent(
      reducePaymentIntent(bBound.transition.intent, { type: 'OPEN_LEDGER', now: T0 }).intent,
      { type: 'ACKNOWLEDGE_UNREADABLE', now: T0 },
    ).rejected === true,
  );
  check(
    '90: nor will the storage layer write one',
    persistAcknowledgement(sBound, {
      v: 2,
      hotelId: HOTEL,
      bookingCode: BOOKING,
      generation: MAX_RECOVERY_GENERATIONS + 1,
      fromSlot: GEN(MAX_RECOVERY_GENERATIONS),
      acknowledgedAt: T0,
      ledgerOpenedAt: T0,
    }) === false,
  );
  check(
    '90: every corrupt generation is still byte-identical after all of that',
    Array.from({ length: MAX_RECOVERY_GENERATIONS + 1 }, (_, g) => g).every(
      (g) => sBound.map.get(GEN(g)) === `{"key":"${KEY}","hotelId":"${HOTEL}","bookingCode":"${BOOKING}","g${String(g)}`,
    ),
    `${String(MAX_RECOVERY_GENERATIONS + 1)} generation(s) checked`,
  );
}

/* -------------------------------------------------------------------------- */
/*  91 - 96  The network boundary: mayDispatchPost                            */
/* -------------------------------------------------------------------------- */

/**
 * A browser found this; no unit test could have.
 *
 * ===========================================================================
 * `folio-view.tsx` asked the **rendered** intent whether a request could go
 * out. On the submit path the render snapshot is a DRAFT, so it passed. On
 * the **confirm** path the rendered intent is always UNRESOLVED -- that is
 * the panel the clerk is looking at when they press the button -- so the
 * check refused every single Confirm.
 *
 * What that produced, measured in a real browser on a single click:
 *
 *     before: UNRESOLVED, attempts 3
 *     click "Confirm this payment"
 *     after:  IN_FLIGHT, attempts 4, pendingSubmission "<key>#4"
 *             postsIssued: 0
 *
 * The reducer accepted it, spent the submission token, persisted IN_FLIGHT --
 * and the request was dropped on the floor with no outcome ever dispatched.
 * Confirm is the only way out of an unresolved payment, and it could not
 * send. The intent stayed stranded IN_FLIGHT until a reload coerced it back.
 *
 * The guard now takes the live intent as an argument and lives in
 * `payment-intent.ts`, where these checks can reach it. That is the whole
 * lesson: the old guard was wrong in production for weeks while this suite
 * was green, because nothing could test it.
 * ===========================================================================
 */

console.log('\n91-96. The network boundary asks the LIVE intent.');
{
  const postEffect = (key, durability = 'persisted') => ({
    type: 'post',
    key,
    snapshot: SNAP,
    durability,
  });

  /* ------------------------------------------------------------------ 91 */
  /**
   * The exact T9 sequence, end to end: UNRESOLVED -> one CONFIRM -> persisted
   * IN_FLIGHT -> exactly one POST carrying the ORIGINAL key and snapshot.
   */
  const store91 = fakeStorage();
  const draft91 = open().intent;
  const sent91 = report(
    reducePaymentIntent(draft91, { type: 'SUBMIT', snapshot: SNAP, now: T0 }).intent,
  );
  const unresolved91 = reducePaymentIntent(sent91.intent, {
    type: 'OUTCOME',
    outcome: { kind: 'ambiguous', reason: 'unreachable' },
  }).intent;
  check(
    '91: the booking is UNRESOLVED, holding the original key and a frozen snapshot',
    unresolved91.status === 'UNRESOLVED' &&
      unresolved91.key === KEY &&
      unresolved91.snapshot !== null,
    `${unresolved91.status} key=${unresolved91.key}`,
  );

  // ONE confirm.
  const confirmed91 = reducePaymentIntent(unresolved91, { type: 'CONFIRM', now: T0 });
  check(
    '91: CONFIRM is accepted and asks to be persisted first',
    confirmed91.effect.type === 'persist' && confirmed91.rejected === false,
    confirmed91.effect.type,
  );
  check(
    '91: and it keeps the SAME key and the SAME frozen snapshot -- no replacement',
    confirmed91.intent.key === KEY &&
      JSON.stringify(confirmed91.intent.snapshot) === JSON.stringify(unresolved91.snapshot),
    `key=${confirmed91.intent.key === KEY ? 'same' : 'CHANGED'}`,
  );
  const durability91 = persistIntent(store91, confirmed91.intent);
  check('91: the write is proven on disk', durability91 === 'persisted', durability91);

  const released91 = report(confirmed91.intent);
  check(
    '91: the durability report releases exactly one POST',
    released91.effect.type === 'post' &&
      released91.effect.key === KEY &&
      released91.effect.durability === 'persisted' &&
      released91.intent.status === 'IN_FLIGHT',
    `${released91.effect.type} key=${released91.effect.key}`,
  );

  /**
   * THE REGRESSION. The live intent is IN_FLIGHT; the *rendered* one would
   * still be UNRESOLVED. The boundary must send.
   */
  check(
    '91: THE FIX -- the boundary sends, asking the LIVE intent',
    mayDispatchPost(released91.effect, released91.intent) === true,
  );
  check(
    '91: and it would NOT have sent against the stale rendered UNRESOLVED intent',
    mayDispatchPost(released91.effect, unresolved91) === false,
    'this is precisely the defect the browser reproduced',
  );
  check(
    '91: the request carries the original key and the frozen snapshot',
    released91.effect.key === KEY &&
      released91.effect.snapshot.amountMinor === SNAP.amountMinor &&
      released91.effect.snapshot.method === SNAP.method,
  );

  /* ------------------------------------------------------------------ 92 */
  /** The submit path must keep working, and for the right reason. */
  const viaSubmit = toInFlight('DRAFT');
  check(
    '92: a submitted payment sends, against its live IN_FLIGHT intent',
    mayDispatchPost(viaSubmit.effect, viaSubmit.intent) === true,
  );
  check(
    '92: but a DRAFT is no longer accepted at the boundary -- tighter than before',
    mayDispatchPost(viaSubmit.effect, open().intent) === false,
    'the old guard admitted DRAFT; nothing legitimate needs it',
  );

  /* ------------------------------------------------------------------ 93 */
  /** Double-click Confirm: the second click releases no effect at all. */
  const first93 = reducePaymentIntent(unresolved91, { type: 'CONFIRM', now: T0 });
  const sent93 = report(first93.intent);
  const second93 = reducePaymentIntent(sent93.intent, { type: 'CONFIRM', now: T0 });
  check(
    '93: a second CONFIRM while in flight is rejected and yields no effect',
    second93.rejected === true && second93.effect.type === 'none',
    `${second93.effect.type} rejected=${String(second93.rejected)}`,
  );
  check(
    '93: so there is nothing for the boundary to send -- zero POSTs',
    mayDispatchPost(second93.effect, second93.intent) === false,
  );
  const replay93 = reducePaymentIntent(sent93.intent, {
    type: 'DURABILITY',
    durability: 'persisted',
    submission: first93.intent.pendingSubmission,
  });
  check(
    '93: and replaying the durability callback with the spent token releases nothing',
    replay93.effect.type === 'none' && mayDispatchPost(replay93.effect, replay93.intent) === false,
    replay93.effect.type,
  );

  /* ------------------------------------------------------------------ 94 */
  /** Stale effects: a live post effect held onto while the state moves on. */
  const stale = sent93.effect;
  check('94: the effect was valid when it was issued', mayDispatchPost(stale, sent93.intent) === true);

  const settled94 = reducePaymentIntent(sent93.intent, {
    type: 'OUTCOME',
    outcome: { kind: 'settled' },
  }).intent;
  check(
    '94: after the payment settles the intent is gone, and the stale effect sends nothing',
    settled94 === null && mayDispatchPost(stale, settled94) === false,
  );

  const unresolved94 = reducePaymentIntent(sent93.intent, {
    type: 'OUTCOME',
    outcome: { kind: 'ambiguous', reason: 'unreachable' },
  }).intent;
  check(
    '94: nor after it lands UNRESOLVED -- no second request for one submission',
    mayDispatchPost(stale, unresolved94) === false,
    unresolved94.status,
  );

  const conflicted94 = reducePaymentIntent(sent93.intent, {
    type: 'OUTCOME',
    outcome: { kind: 'conflict', differing: ['amountMinor'] },
  }).intent;
  check('94: nor from CONFLICTED', mayDispatchPost(stale, conflicted94) === false);

  /* ------------------------------------------------------------------ 95 */
  /** A late effect from an EARLIER submission must not ride a newer intent. */
  check(
    '95: an effect whose key is not the live key is refused',
    mayDispatchPost(postEffect(OTHER_KEY), sent93.intent) === false,
    `live=${sent93.intent.key} effect=${OTHER_KEY}`,
  );
  check(
    '95: a QUARANTINED intent has no key, so nothing can be sent for it',
    mayDispatchPost(postEffect(KEY), {
      ...open().intent,
      status: 'QUARANTINED',
      key: null,
    }) === false,
  );
  for (const status of ['DRAFT', 'UNRESOLVED', 'RECONCILING', 'CONFLICTED', 'QUARANTINED']) {
    check(
      `95: a live ${status} intent never sends`,
      mayDispatchPost(postEffect(KEY), { ...sent93.intent, status }) === false,
    );
  }

  /* ------------------------------------------------------------------ 96 */
  /** Failed persistence: no POST, by two independent checks. */
  const blocked96 = report(
    reducePaymentIntent(open().intent, { type: 'SUBMIT', snapshot: SNAP, now: T0 }).intent,
    'memory-only',
  );
  check(
    '96: a non-durable submission produces `blocked`, never `post`',
    blocked96.effect.type === 'blocked',
    blocked96.effect.type,
  );
  check(
    '96: and the boundary refuses it',
    mayDispatchPost(blocked96.effect, blocked96.intent) === false,
  );
  check(
    '96: a hand-made post effect claiming non-durability is refused too',
    mayDispatchPost(postEffect(KEY, 'memory-only'), sent93.intent) === false,
    'durability is never trusted from the caller',
  );
  check(
    '96: and a non-durable CONFIRM returns to UNRESOLVED, sending nothing',
    (() => {
      const c = reducePaymentIntent(unresolved91, { type: 'CONFIRM', now: T0 });
      const b = report(c.intent, 'memory-only');
      return (
        b.effect.type === 'blocked' &&
        b.intent.status === 'UNRESOLVED' &&
        b.intent.key === KEY &&
        mayDispatchPost(b.effect, b.intent) === false
      );
    })(),
  );
  check(
    '96: every non-post effect is refused outright',
    [{ type: 'none' }, { type: 'forget' }, { type: 'read', key: KEY }].every(
      (e) => mayDispatchPost(e, sent93.intent) === false,
    ),
  );
  check(
    '96: and a null live intent always refuses',
    mayDispatchPost(postEffect(KEY), null) === false,
  );
}

console.log(
  failures === 0
    ? `\nAll payment-intent checks passed (${String(checks)}).`
    : `\n${String(failures)} of ${String(checks)} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
