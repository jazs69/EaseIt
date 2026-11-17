# Personal data in logs: review (SE-02)

Reviewed 2026-11-17. Scope: everything the API and worker write to their logs (`apps/api/src`,
both entry points). The two web apps are not in scope; they log nothing about guests server-side.

CLAUDE.md §5: _"never log guest PII, card data, or full channel payloads containing either."_

## How it is enforced

Three layers, each covering what the one before cannot see.

1. **Mechanical check, in the fast gate: `pnpm check:log-pii`** (`scripts/check-log-pii.mjs`).
   - It parses every log call with the TypeScript compiler: `*.logger.<level>(…)`,
     `Logger.<level>(…)` and `console.<level>(…)`, 103 calls today.
   - It fails if an argument names a personal-data field (the list is below), as an identifier, a
     property access, an object key or a value inside a template string.
   - A reviewed exception needs `// pii-log-ok: <reason>` on the call. There are none today.
   - Its own unit test (`test/unit/log-pii-check.test.mjs`) proves that it catches each of those
     forms. That test found two bugs in the first version:
     - the syntax walk stopped at the first child of every node;
     - an empty waiver was accepted.

     Both were fixed before this review was recorded.
2. **Runtime redaction, on every line written** (`common/logging/redact.ts`, installed as the
   application logger in `main.ts` and `worker.ts`). It is the backstop for personal data that
   arrives inside someone else's text. It replaces:
   - email addresses with `[email]`;
   - Indian mobile numbers with `[phone]`;
   - Luhn-valid card numbers with `[card]`;
   - Aadhaar-like 4-4-4 numbers with `[id-number]`;
   - the reprinted call arguments of a Prisma "Invalid … invocation" error, which are removed and
     only the first line and stack frames kept.

   UUIDs, booking codes, GSTINs, amounts and timestamps pass through unchanged. Unit tests are in
   `redact.test.ts`.

3. **This review**: a read of all 103 calls for what neither layer can judge.

Fields the check rejects: `guestFirstName`, `guestLastName`, `guestName`, `guestEmail`, `guestPhone`,
`firstName`, `lastName`, `fullName`, `email`, `phone`, `contact`, `mobile`, `govtIdNumber`, `govtIdType`,
`dateOfBirth`, `addressLine1`, `addressLine2`, `postalCode`, `nationality`, `specialRequest`,
`password`, `passwordHash`, `otp`, `otpCode`, `cardNumber`, `cvv`, `vpa`.

## Findings

| #   | Where                                                                                    | What could leak                                                                                                                                    | Resolution                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `account.service.ts` (password reset, invitation), `auth.service.ts` (2FA code)          | The mail relay's error text, which often names the recipient (`550 … <someone@…>: Recipient address rejected`)                                     | Redacted at write time (layer 2). The call sites log ids, never the address.                                                                                                                            |
| 2   | `DomainExceptionFilter`, `auth.repository.ts`, `prisma.service.ts`, worker failure paths | A Prisma validation error's message reprints the failing call, guest names and contacts included                                                   | Layer 2 cuts the reprinted arguments and keeps the first line and the stack frames.                                                                                                                     |
| 3   | `log.mailer.ts`                                                                          | Logs the whole message, recipient and body, by design. It is the development transport that lets a developer without SMTP read their sign-in code. | Reviewed exception. Production refuses to boot without `SMTP_HOST`, so this transport cannot run there. In development, layer 2 masks the address; the six-digit code is not a pattern and still shows. |
| 4   | Alerts (OB-06) and the error digest (OB-05)                                              | Leave the system for an inbox or chat tool                                                                                                         | They carry identifiers, counts, event types and the outbox's already-scrubbed `lastError`. The error digest carries the redacted first line of the message only, never a stack or payload.              |
| 5   | Every other call (the remaining ~95)                                                     | —                                                                                                                                                  | Ids (user, reservation, folio, link, block, outbox row), booking codes, statuses, counts, durations and Prisma error codes. No personal data.                                                           |

## What is still not guaranteed

- **A guest's name in free text.** Redaction recognises shapes (an address, a phone number, a
  card), not names. A name could still reach a log through a message the platform did not write
  that is not a Prisma invocation error. The mechanical check keeps our own code from logging
  name fields; third-party error text is the residual risk.
- **Retention.** Logs go to stdout; how long they are kept is decided by the host (Docker's log
  driver). Retention and erasure are SE-05, which is not built.
- **New code.** The check runs in `pnpm gate` on every change, so a new log call that names a
  personal-data field fails the gate. A new field name that holds personal data must be added to
  the list in `scripts/check-log-pii.mjs`.
