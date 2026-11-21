/**
 * The Channex adapter (CM-05). Mapping and HTTP only; see `channel-adapter.ts`
 * for the contract and `channex.mapping.ts` for the wire format.
 *
 * Batches: a push is split into requests of at most `BATCH` values, sent in
 * order. A push is full state for its ranges, so if the third request fails
 * the whole push is retried and the first two are simply re-sent with the
 * same values -- harmless.
 */

import type { ConfigService } from '@nestjs/config';

import type { ClockService } from '../../platform/clock.service.js';
import {
  ChannelProviderError,
  type AvailabilityValue,
  type ChannelAdapter,
  type ChannelBooking,
  type InboundEnvelope,
  type ProviderCall,
  type ProviderConnection,
  type RateValue,
} from '../channel-adapter.js';
import { CircuitBreaker, ProviderHttp, type FetchLike } from '../provider-http.js';
import {
  availabilityBody,
  describeChannexError,
  feedEnvelopes,
  readRevision,
  restrictionsBody,
} from './channex.mapping.js';

const BATCH = 200;

/**
 * Built by a factory in `channels.module.ts` (the fetch argument is for tests,
 * which hand in nothing and point CHANNEX_BASE_URL at a stand-in instead).
 */
export class ChannexAdapter implements ChannelAdapter {
  readonly provider = 'CHANNEX' as const;
  private readonly http: ProviderHttp | null;

  constructor(config: ConfigService, clock: ClockService, fetchImpl: FetchLike = fetch) {
    const key = config.get<string>('CHANNEX_API_KEY');
    const now = (): number => clock.nowMs();
    this.http =
      key === undefined
        ? null
        : new ProviderHttp(
            fetchImpl,
            config.get<string>('CHANNEX_BASE_URL', 'https://app.channex.io').replace(/\/+$/, ''),
            { 'user-api-key': key },
            config.get<number>('CHANNEX_TIMEOUT_MS', 10_000),
            new CircuitBreaker(5, 60_000, now),
            now,
            describeChannexError,
          );
  }

  configured(): boolean {
    return this.http !== null;
  }

  async pushAvailability(
    connection: ProviderConnection,
    values: readonly AvailabilityValue[],
  ): Promise<ProviderCall[]> {
    return this.inBatches(values, (batch) => ({
      operation: 'ARI_AVAILABILITY',
      method: 'POST',
      path: '/api/v1/availability',
      body: availabilityBody(connection.externalPropertyId, batch),
      recordRequest: true,
      recordResponse: true,
    }));
  }

  async pushRates(
    connection: ProviderConnection,
    values: readonly RateValue[],
  ): Promise<ProviderCall[]> {
    return this.inBatches(values, (batch) => ({
      operation: 'ARI_RATES',
      method: 'POST',
      path: '/api/v1/restrictions',
      body: restrictionsBody(connection.externalPropertyId, batch),
      recordRequest: true,
      recordResponse: true,
    }));
  }

  async fetchBookings(
    connection: ProviderConnection,
  ): Promise<{ call: ProviderCall; messages: InboundEnvelope[] }> {
    const { call, body } = await this.client().send({
      operation: 'BOOKINGS_PULL',
      method: 'GET',
      path: `/api/v1/booking_revisions/feed?filter[property_id]=${encodeURIComponent(connection.externalPropertyId)}`,
      // Guest data: stored once, in channel_inbound_message, not here too.
      recordRequest: false,
      recordResponse: false,
    });
    const messages = feedEnvelopes(body);
    return { call: { ...call, responseBody: { revisions: messages.length } }, messages };
  }

  async acknowledge(
    connection: ProviderConnection,
    externalMessageId: string,
  ): Promise<ProviderCall> {
    void connection;
    const { call } = await this.client().send({
      operation: 'BOOKING_ACK',
      method: 'POST',
      path: `/api/v1/booking_revisions/${encodeURIComponent(externalMessageId)}/ack`,
      recordRequest: false,
      recordResponse: true,
    });
    return call;
  }

  readBooking(raw: unknown): ChannelBooking {
    return readRevision(raw);
  }

  private client(): ProviderHttp {
    if (this.http === null) {
      throw new ChannelProviderError(
        'Channex is not configured on this server (CHANNEX_API_KEY).',
        false,
        [],
      );
    }
    return this.http;
  }

  private async inBatches<T>(
    values: readonly T[],
    request: (batch: readonly T[]) => Parameters<ProviderHttp['send']>[0],
  ): Promise<ProviderCall[]> {
    const client = this.client();
    const calls: ProviderCall[] = [];
    for (let start = 0; start < values.length; start += BATCH) {
      try {
        const { call } = await client.send(request(values.slice(start, start + BATCH)));
        calls.push(call);
      } catch (cause) {
        if (cause instanceof ChannelProviderError) {
          throw new ChannelProviderError(cause.message, cause.retryable, [
            ...calls,
            ...cause.calls,
          ]);
        }
        throw cause;
      }
    }
    return calls;
  }
}
