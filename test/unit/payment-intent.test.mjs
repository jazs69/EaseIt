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
} = intents;

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

/** Drives the reducer to IN_FLIGHT the way the hook does: persist, then post. */
function toInFlight(from = 'DRAFT') {
  let intent = open().intent;
  if (from === 'DRAFT') {
    const submitted = reducePaymentIntent(intent, { type: 'SUBMIT', snapshot: SNAP, now: T0 });
    const released = reducePaymentIntent(submitted.intent, {
      type: 'DURABILITY',
      durability: 'persisted',
    });
    return { intent: released.intent, effect: released.effect, submitted };
  }
  // Via an ambiguous first attempt, so `submittedFrom` is UNRESOLVED.
  const inFlight = toInFlight('DRAFT').intent;
  const ambiguous = reducePaymentIntent(inFlight, {
    type: 'OUTCOME',
    outcome: { kind: 'ambiguous', reason: 'unreachable' },
  });
  const confirmed = reducePaymentIntent(ambiguous.intent, { type: 'CONFIRM', now: T0 });
  const released = reducePaymentIntent(confirmed.intent, {
    type: 'DURABILITY',
    durability: 'persisted',
  });
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

  const released = reducePaymentIntent(submitted.intent, {
    type: 'DURABILITY',
    durability: 'persisted',
  });
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
  const released = reducePaymentIntent(confirmed.intent, {
    type: 'DURABILITY',
    durability: 'persisted',
  });
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
  const after33 = reducePaymentIntent(
    reducePaymentIntent(
      reducePaymentIntent(draft33, { type: 'SUBMIT', snapshot: SNAP, now: T0 }).intent,
      { type: 'DURABILITY', durability: 'memory-only' },
    ).intent,
    { type: 'OUTCOME', outcome: { kind: 'ambiguous', reason: 'unreachable' } },
  );
  check(
    '33: and the ambiguous failure after it still keeps the original key',
    after33.intent?.status === 'UNRESOLVED' &&
      after33.intent.key === KEY &&
      after33.intent.durability === 'memory-only' &&
      after33.intent.snapshot?.amountMinor === 250_000,
    `key=${after33.intent?.key === KEY ? 'same' : 'CHANGED'} durability=${String(after33.intent?.durability)}`,
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
  const settledLater = reducePaymentIntent(
    reducePaymentIntent(firstClick.intent, { type: 'DURABILITY', durability: 'persisted' }).intent,
    { type: 'OUTCOME', outcome: { kind: 'settled' } },
  );
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
   * 45: a corrupt blob is reported, never silently dropped.
   *
   * A real hole this audit found: an unreadable blob returned the same
   * "nothing stored" as an empty slot, so the clerk got a clean form with no
   * hint that a reference had existed -- and the next thing they would do is
   * take the payment again.
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
    '45: an unreadable blob for THIS booking sets storedUnreadable',
    reported.intent === null && reported.storedUnreadable === true,
    `storedUnreadable=${String(reported.storedUnreadable)}`,
  );
  check(
    '45: and it is NOT forgotten, so the warning survives a reload',
    reported.effect.type === 'none',
    reported.effect.type,
  );
  check(
    '45: an empty slot is silent -- no false alarm',
    rehydrateRaw(null).intent === null && rehydrateRaw(null).storedUnreadable === undefined,
    `storedUnreadable=${String(rehydrateRaw(null).storedUnreadable)}`,
  );
  const foreignCorrupt =
    '{"key":"xxxx","hotelId":"39999","bookingCode":"SFBOOKING_39999_Z","status":"UNRESOL';
  check(
    '45: a corrupt blob for another booking raises nothing -- that is scoping, not corruption',
    rehydrateRaw(foreignCorrupt).storedUnreadable === undefined,
    `storedUnreadable=${String(rehydrateRaw(foreignCorrupt).storedUnreadable)}`,
  );
}

/* -------------------------------------------------------------------------- */

console.log(
  failures === 0
    ? `\nAll payment-intent checks passed (${String(checks)}).`
    : `\n${String(failures)} of ${String(checks)} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
