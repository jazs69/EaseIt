/** SE-02: what the runtime redaction removes, and what it must leave alone. */

import { describe, expect, it } from 'vitest';

import { redactText, redactValue } from './redact.js';

describe('redactText removes personal data', () => {
  it('email addresses, including inside a mail relay error', () => {
    expect(redactText('550 5.1.1 <asha.k@example.com>: Recipient address rejected')).toBe(
      '550 5.1.1 <[email]>: Recipient address rejected',
    );
  });

  it('Indian mobile numbers, with or without +91 and separators', () => {
    expect(redactText('call +91 98765 43210 or 9876543210 or 98765-43210')).toBe(
      'call [phone] or [phone] or [phone]',
    );
  });

  it('card numbers that pass Luhn, grouped or not', () => {
    expect(redactText('card 4100 2800 0000 1007 / 4100280000001007')).toBe('card [card] / [card]');
  });

  it('Aadhaar-like 4-4-4 numbers', () => {
    expect(redactText('id 1234 5678 9012')).toBe('id [id-number]');
  });

  it("a Prisma invocation error's reprinted arguments, keeping the stack frames", () => {
    const stack = [
      'PrismaClientValidationError: ',
      'Invalid `prisma.reservation.create()` invocation:',
      '{ data: { guestFirstName: "Asha", guestLastName: "Kapoor" } }',
      'Argument `adults` is missing.',
      '    at Object.create (/app/node_modules/x.js:1:1)',
    ].join('\n');
    const out = redactText(`Invalid \`prisma.reservation.create()\` invocation:\n${stack}`);
    expect(out).not.toContain('Asha');
    expect(out).not.toContain('Kapoor');
    expect(out).toContain('[prisma call arguments removed]');
    expect(out).toContain('    at Object.create');
  });
});

describe('redactText leaves identifiers alone', () => {
  it('uuids, booking codes, epoch millis, amounts, timestamps, GSTINs', () => {
    const line =
      'Payment link 6f1c4b8e-2d3a-4c5b-9e7f-0a1b2c3d4e5f SFBOOKING_31352_A02 at 1794915997959 ' +
      'amount 118000 on 2026-11-17T13:58:29.879Z for 29AAACR5055K1Z3 room 101';
    expect(redactText(line)).toBe(line);
  });

  it('a 16-digit number that fails Luhn is not a card', () => {
    expect(redactText('ref 1234567890123456')).toBe('ref 1234567890123456');
  });
});

describe('redactValue', () => {
  it('reaches into errors and plain objects', () => {
    const error = new Error('could not mail a@b.co');
    const out = redactValue({ cause: error, to: ['x@y.in'] }) as { cause: Error; to: string[] };
    expect(out.cause.message).toBe('could not mail [email]');
    expect(out.to).toEqual(['[email]']);
  });
});
