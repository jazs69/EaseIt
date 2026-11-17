/**
 * Reusable guest profiles (GP-02).
 *
 * ===========================================================================
 * One profile per guest per property, linked by hand.
 *
 * A booking still records its guests on `reservation_guest`, as it always has.
 * A profile is a separate record a clerk links those rows to. A profile holds
 * contact details, preferences and notes, and its stay history is every
 * linked row.
 *
 * Per property, like `Company`: a profile shared across the portfolio would be
 * a cross-tenant record (CLAUDE.md section 3.2).
 *
 * Duplicates are **suggested, never merged**. A stay or profile with the same
 * normalised email or phone is offered for linking. Nothing links itself:
 * a family shares a phone, and a travel agent's email is on a hundred
 * bookings, so an automatic merge would join strangers' histories.
 * ===========================================================================
 */

import { z } from 'zod';

import { businessDateSchema, reservationStatusSchema } from '../domain.js';

/** Lower-cased and trimmed; null when empty. */
export function normaliseEmail(email: string | null | undefined): string | null {
  const value = (email ?? '').trim().toLowerCase();
  return value === '' ? null : value;
}

/**
 * Digits only, and the last ten of them: a +91 prefix, spaces and dashes do
 * not stop a match. Null when fewer than seven digits remain, which is not a
 * phone number anyone can be matched on.
 */
export function normalisePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value === null || value === '' ? null : value));

export const guestProfileFieldsSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100).default(''),
  email: z
    .union([z.email(), z.literal('')])
    .nullable()
    .default(null)
    .transform((value) => (value === '' ? null : value)),
  phone: optionalText(30).default(null),
  /** ISO 3166-1 alpha-2. */
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase())
    .nullable()
    .default(null),
  /** Room, pillow, diet: what the next stay should get right. */
  preferences: optionalText(2000).default(null),
  /** Internal; never shown to the guest. */
  notes: optionalText(2000).default(null),
});

export const createGuestProfileSchema = guestProfileFieldsSchema;
export type CreateGuestProfileCommand = z.infer<typeof createGuestProfileSchema>;

/** A partial update; at least one field. */
export const updateGuestProfileSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().max(100),
    email: z
      .union([z.email(), z.literal('')])
      .nullable()
      .transform((value) => (value === '' ? null : value)),
    phone: optionalText(30),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/)
      .transform((value) => value.toUpperCase())
      .nullable(),
    preferences: optionalText(2000),
    notes: optionalText(2000),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

export type UpdateGuestProfileCommand = z.infer<typeof updateGuestProfileSchema>;

export const listGuestProfilesQuerySchema = z.object({
  /** Name, email or phone; blank lists everyone. */
  q: z.string().trim().max(100).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListGuestProfilesQuery = z.infer<typeof listGuestProfilesQuerySchema>;

/** Link one stay's guest row to a profile. */
export const linkGuestStaySchema = z.object({ reservationGuestId: z.uuid() });
export type LinkGuestStayCommand = z.infer<typeof linkGuestStaySchema>;

/* -------------------------------------------------------------------------- */
/*  Responses                                                                 */
/* -------------------------------------------------------------------------- */

export const matchedOnSchema = z.array(z.enum(['email', 'phone']));

export const guestProfileSummarySchema = z.object({
  id: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  stayCount: z.number().int().nonnegative(),
  lastArrivalDate: businessDateSchema.nullable(),
});

export type GuestProfileSummary = z.infer<typeof guestProfileSummarySchema>;

export const guestProfilePageSchema = z.object({
  items: z.array(guestProfileSummarySchema),
  nextCursor: z.uuid().nullable(),
});

export type GuestProfilePage = z.infer<typeof guestProfilePageSchema>;

export const guestStaySchema = z.object({
  reservationGuestId: z.uuid(),
  reservationId: z.uuid(),
  bookingCode: z.string(),
  /** 1 is the booker. */
  ordinal: z.number().int().positive(),
  guestName: z.string(),
  arrivalDate: businessDateSchema,
  departureDate: businessDateSchema,
  status: reservationStatusSchema,
  totalAmountMinor: z.number().int(),
  currency: z.string().length(3),
});

export type GuestStay = z.infer<typeof guestStaySchema>;

export const guestProfileDetailSchema = z.object({
  id: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  countryCode: z.string().nullable(),
  preferences: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Linked stays, newest arrival first. */
  stays: z.array(guestStaySchema),
  /** Unlinked guest rows with the same email or phone, offered for linking. */
  suggestedStays: z.array(guestStaySchema.extend({ matchedOn: matchedOnSchema })),
  /** Other profiles sharing an email or phone. Shown, never merged. */
  possibleDuplicates: z.array(
    z.object({
      id: z.uuid(),
      firstName: z.string(),
      lastName: z.string(),
      matchedOn: matchedOnSchema,
    }),
  ),
});

export type GuestProfileDetail = z.infer<typeof guestProfileDetailSchema>;
