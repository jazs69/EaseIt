/**
 * Omnibar reservation search.
 *
 * ===========================================================================
 * The interesting work here is not finding rows — it is explaining them.
 *
 * A query of `8829` returning "Vikram Malhotra" looks like a bug until the row
 * says it matched an OTA reference. So every hit is re-examined against the
 * query to determine which field matched, and the most *specific* match wins:
 * a booking code or an exact room number identifies one stay, a name fragment
 * is a guess. That ordering is the whole value of the tag.
 *
 * The government ID is masked here and nowhere else. It is the one field the
 * search can match but must never return, so the masking sits next to the
 * matching rather than in a mapper somebody could forget to call.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import {
  type MatchedField,
  type PropertyId,
  type ReservationSearchHit,
  type ReservationSearchQuery,
  type ReservationSearchResponse,
} from '@repo/types';

import { TenantScopeViolationError } from '../../common/errors/domain-error.js';
import {
  ReservationSearchRepository,
  type ReservationSearchRow,
} from './reservation-search.repository.js';

const DAY_MS = 86_400_000;

/**
 * Display rank per match type, lower is more specific.
 *
 * A booking code, an OTA reference and an exact room number each identify one
 * stay. A phone or ID fragment narrows hard. A name fragment is a guess —
 * "Sharma" is half the arrivals board.
 */
const MATCH_SPECIFICITY: Record<MatchedField, number> = {
  MATCHED_BY_BOOKING_CODE: 0,
  MATCHED_BY_OTA_ID: 1,
  MATCHED_BY_ROOM: 2,
  MATCHED_BY_GOVT_ID: 3,
  MATCHED_BY_PHONE: 4,
  MATCHED_BY_EMAIL: 5,
  MATCHED_BY_NAME: 6,
};

/**
 * `XXXX-XXXX-1234` — last four digits, everything else obscured.
 *
 * Grouped in fours regardless of the real format, because the point is to be
 * recognisable to the person holding the card, not to reproduce the layout of
 * an Aadhaar versus a passport. A value of four characters or fewer is masked
 * entirely: showing "1234" of a four-character id reveals all of it.
 */
function maskGovtId(raw: string | null): string | null {
  if (raw === null) return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= 4) return 'XXXX';

  const lastFour = trimmed.slice(-4);
  const hiddenGroups = Math.max(1, Math.ceil((trimmed.length - 4) / 4));
  return `${Array.from({ length: hiddenGroups }, () => 'XXXX').join('-')}-${lastFour}`;
}

@Injectable()
export class ReservationSearchService {
  constructor(private readonly repository: ReservationSearchRepository) {}

  async search(
    userId: string,
    hotelId: string,
    query: ReservationSearchQuery,
  ): Promise<ReservationSearchResponse> {
    const property = await this.repository.findGrantedProperty(userId, hotelId);
    if (property === null) {
      // Not-found rather than forbidden: a 403 would confirm the property
      // exists to somebody with no grant at it (CLAUDE.md section 3.2).
      throw new TenantScopeViolationError('Property');
    }

    // Already trimmed and length-checked by the zod schema at the boundary.
    const cleanQuery = query.q;

    const rows = await this.repository.search(property.id, cleanQuery, query.limit);
    const truncated = rows.length > query.limit;
    const visible = truncated ? rows.slice(0, query.limit) : rows;

    /**
     * Which rows come back is newest-booked-first, as the query orders them.
     * How the page is *presented* is by how specifically each matched.
     *
     * Without this, typing a room number puts a guest whose phone happens to
     * contain those digits above the person actually in that room, purely
     * because they booked more recently. Sorting on the tag is nearly free —
     * it is already computed — and it is a stable sort, so recency still
     * breaks ties within a specificity band.
     *
     * Note the limitation: this reorders the page, it does not re-select it.
     * A highly specific hit sitting outside the first `limit` rows by
     * booking date will not be pulled in. Fixing that properly means ranking
     * in SQL, which needs the trigram index this scale does not justify.
     */
    const hits = visible
      .map((row) => this.toHit(row, cleanQuery))
      .sort(
        (a, b) => MATCH_SPECIFICITY[a.matchedField] - MATCH_SPECIFICITY[b.matchedField],
      );

    return {
      query: cleanQuery,
      propertyId: property.id as PropertyId,
      hits,
      truncated,
    };
  }

  private toHit(row: ReservationSearchRow, query: string): ReservationSearchHit {
    const guestName = `${row.guestFirstName} ${row.guestLastName}`.trim();
    const roomNumber = row.rooms[0]?.room?.number ?? null;
    const roomTypeName = row.rooms[0]?.roomType.name ?? 'Unknown category';

    const nights = Math.max(
      1,
      Math.round((row.departureDate.getTime() - row.arrivalDate.getTime()) / DAY_MS),
    );

    const match = this.classifyMatch(row, query, guestName, roomNumber);

    return {
      id: row.id,
      bookingCode: row.confirmationCode,
      otaBookingId: row.otaBookingId,
      guestName,
      guestPhone: row.guestPhone,
      guestEmail: row.guestEmail,
      // Masked, always. The raw column never leaves this service.
      govtIdMasked: maskGovtId(row.govtIdNumber),
      roomNumber,
      roomTypeName,
      status: row.status,
      source: row.source,
      mealPlan: row.mealPlan,
      arrivalDate: toBusinessDate(row.arrivalDate),
      departureDate: toBusinessDate(row.departureDate),
      nights,
      totalAmountMinor: row.totalAmountMinor,
      // Derived, never stored — there is no third number able to disagree with
      // the two it comes from (CLAUDE.md section 3.4).
      balanceAmountMinor: row.totalAmountMinor - row.paidAmountMinor,
      currency: row.currency,
      matchedField: match.field,
      matchedValue: match.value,
    };
  }

  /**
   * Which field this row matched, most specific first.
   *
   * Re-checked against the returned row rather than asked of the database: the
   * query already did the matching, and a second round trip to ask "and which
   * clause was it?" would double the cost of every keystroke.
   *
   * The fallback is the guest name, because the name branch is the only one
   * that can match on a *token* rather than the whole query — so when nothing
   * else matched, the name did, even though the full query string does not
   * appear in it.
   */
  private classifyMatch(
    row: ReservationSearchRow,
    query: string,
    guestName: string,
    roomNumber: string | null,
  ): { field: MatchedField; value: string } {
    const needle = query.toLowerCase();
    const has = (value: string | null): boolean =>
      value !== null && value.toLowerCase().includes(needle);

    if (has(row.confirmationCode)) {
      return { field: 'MATCHED_BY_BOOKING_CODE', value: row.confirmationCode };
    }
    if (has(row.otaBookingId)) {
      return { field: 'MATCHED_BY_OTA_ID', value: row.otaBookingId ?? '' };
    }
    if (roomNumber !== null && roomNumber.toLowerCase() === needle) {
      return { field: 'MATCHED_BY_ROOM', value: roomNumber };
    }
    if (has(row.guestPhone)) {
      return { field: 'MATCHED_BY_PHONE', value: row.guestPhone ?? '' };
    }
    if (has(row.govtIdNumber)) {
      // The masked form is what the UI shows. The raw value matched, and that
      // fact is all that leaves here — never the digits themselves.
      return {
        field: 'MATCHED_BY_GOVT_ID',
        value: maskGovtId(row.govtIdNumber) ?? 'XXXX',
      };
    }
    // Name before email, deliberately. Addresses are usually derived from
    // names, so a query of "Vikram" matches both — and reporting
    // MATCHED_BY_EMAIL for someone who typed a name reads as a mismatch. Email
    // only wins when the query is not in the name at all, which is the case
    // that actually means "they searched by address".
    if (has(guestName)) {
      return { field: 'MATCHED_BY_NAME', value: guestName };
    }
    if (has(row.guestEmail)) {
      return { field: 'MATCHED_BY_EMAIL', value: row.guestEmail ?? '' };
    }

    // Reached when the name matched on tokens rather than the whole string —
    // "Malhotra Vikram" finds the guest, but that exact string is in no field.
    return { field: 'MATCHED_BY_NAME', value: guestName };
  }
}

/** `@db.Date` comes back as UTC midnight, so the first ten characters are it. */
function toBusinessDate(date: Date): ReservationSearchHit['arrivalDate'] {
  return date.toISOString().slice(0, 10) as ReservationSearchHit['arrivalDate'];
}
