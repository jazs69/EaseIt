/**
 * The one interface every channel provider is reached through (CM-05).
 *
 * ===========================================================================
 * An adapter is MAPPING ONLY. It turns the domain's values into the
 * provider's wire format and back, makes the HTTP call with a timeout behind a
 * circuit breaker, and classifies the answer as acknowledged, retryable or
 * permanent. It decides nothing: what is pushed, which bookings are accepted,
 * what availability means, when to retry -- all of that lives in
 * `ari-push.service.ts`, `inbound.service.ts` and the outbox. A provider swap
 * is a new file implementing this interface, not a rewrite.
 *
 * Every call an adapter makes is returned as a `ProviderCall`, success or
 * failure, so the caller can write it to `channel_sync_attempt` for dispute
 * resolution (CLAUDE.md section 5). An adapter never writes to the database.
 * ===========================================================================
 */

import type { BookingSource } from '@repo/types';

export type ChannelProviderCode = 'CHANNEX';

/** DI token for the list of adapters. */
export const CHANNEL_ADAPTERS = Symbol('CHANNEL_ADAPTERS');

/** What an adapter needs to know about a connection. No secrets: those are its own config. */
export interface ProviderConnection {
  connectionId: string;
  externalPropertyId: string;
}

export type SyncOperation = 'ARI_AVAILABILITY' | 'ARI_RATES' | 'BOOKINGS_PULL' | 'BOOKING_ACK';

/** One HTTP exchange with a provider, as recorded in `channel_sync_attempt`. */
export interface ProviderCall {
  operation: SyncOperation;
  method: string;
  /** Path and query, never the host or a credential. */
  path: string;
  /** What was sent. Null when the body would carry personal data. */
  requestBody: unknown;
  responseStatus: number | null;
  /** What came back. Null when it would carry personal data (a booking pull). */
  responseBody: unknown;
  ok: boolean;
  error: string | null;
  durationMs: number;
}

/** Stock left for one provider room type over an inclusive date range. */
export interface AvailabilityValue {
  externalRoomTypeId: string;
  dateFrom: string;
  /** Inclusive. */
  dateTo: string;
  availability: number;
}

/** Price and restrictions for one provider rate plan over an inclusive date range. */
export interface RateValue {
  externalRatePlanId: string;
  dateFrom: string;
  /** Inclusive. */
  dateTo: string;
  /** The nightly rate before tax, in minor units. Null exactly when `stopSell`. */
  rateMinor: number | null;
  currency: string;
  /** Minimum nights for a stay arriving on the date; null = no minimum. */
  minStayArrival: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  stopSell: boolean;
}

/** One message as fetched, before anything has tried to read it as a booking. */
export interface InboundEnvelope {
  /** The provider's id for this message; the idempotency key of storage. */
  externalMessageId: string;
  /** The provider's booking id, when the envelope names it. */
  externalBookingId: string | null;
  /** The message as received, with card data removed. Stored verbatim. */
  raw: unknown;
}

export type RevisionKind = 'NEW' | 'MODIFIED' | 'CANCELLED';

/** One room of a provider booking, in the domain's terms. */
export interface ChannelBookingRoom {
  externalRoomTypeId: string;
  externalRatePlanId: string | null;
  arrivalDate: string;
  departureDate: string;
  /** One entry per night, arrival first: the pre-tax nightly amount sold. */
  nights: { stayDate: string; amountMinor: number }[];
  adults: number;
  children: number;
  infants: number;
}

/** A provider booking revision, read. Plain data: no decision is made here. */
export interface ChannelBooking {
  externalBookingId: string;
  kind: RevisionKind;
  /** The OTA that sold it, as this system's booking source. */
  source: BookingSource;
  otaName: string | null;
  otaReservationCode: string | null;
  currency: string;
  /** What the OTA keeps, when the provider says. */
  otaCommissionMinor: number;
  /** Whether the guest paid the OTA rather than the hotel. */
  collectedByOta: boolean;
  /** The booking's total as the provider states it, in minor units. */
  totalMinor: number | null;
  booker: {
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    countryCode: string | null;
  };
  rooms: ChannelBookingRoom[];
  notes: string | null;
}

/**
 * A provider call failed. `retryable` says whether trying again can help
 * (a timeout, a 5xx, a 429, an open breaker) or not (a refused key, a
 * validation error). `calls` are every exchange made before giving up.
 */
export class ChannelProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly calls: readonly ProviderCall[],
  ) {
    super(message);
    this.name = 'ChannelProviderError';
  }
}

/** A stored message could not be read as a booking. The raw payload is kept. */
export class ChannelPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelPayloadError';
  }
}

export interface ChannelAdapter {
  readonly provider: ChannelProviderCode;

  /** Whether this server holds the provider's credentials. */
  configured(): boolean;

  /** Sends availability. Resolves with every call made once all are acknowledged. */
  pushAvailability(
    connection: ProviderConnection,
    values: readonly AvailabilityValue[],
  ): Promise<ProviderCall[]>;

  /** Sends rates and restrictions. Resolves once all are acknowledged. */
  pushRates(connection: ProviderConnection, values: readonly RateValue[]): Promise<ProviderCall[]>;

  /** Fetches messages not yet acknowledged. */
  fetchBookings(
    connection: ProviderConnection,
  ): Promise<{ call: ProviderCall; messages: InboundEnvelope[] }>;

  /** Tells the provider a message is safely stored, so it is not sent again. */
  acknowledge(connection: ProviderConnection, externalMessageId: string): Promise<ProviderCall>;

  /** Reads a stored raw message. Pure; throws `ChannelPayloadError`. */
  readBooking(raw: unknown): ChannelBooking;
}
