/**
 * Pushes one connection's pending ARI changes (CM-03), from the worker.
 *
 * ===========================================================================
 * WHAT IS SENT. For each mapped room type, over the merged ranges the change
 * rows name (clamped to business date .. + CHANNEL_ARI_WINDOW_DAYS):
 *
 *   - availability = physical - sold - blocked, never below zero. The
 *     overbooking allowance is NOT offered to the channels: it is a revenue
 *     manager's lever for absorbing a sale the OTA made before a push landed
 *     (`createForChannel` may sell into it), not stock. A retired type, or a
 *     night with no inventory row, is 0.
 *   - per mapped rate plan: the plan's nightly base rate through the SAME
 *     resolver the desk quotes from (`RateCalendarService.baseNights`,
 *     derived plans included), MinLOS/CTA/CTD from the plan's restrictions,
 *     and stop-sell when the plan is inactive, archived, no longer assigned,
 *     or in another currency. Occupancy extras and promotions are the desk's
 *     and the booking engine's; the channel is sent the base-occupancy rate.
 *
 * FULL STATE, READ AT SEND TIME. The rows only say *where* to look; the
 * values are read now. So a push repeated after a timeout sends the same
 * thing again (safe at-least-once), and a push that runs late sends what is
 * true, not what was true when the change happened.
 *
 * ORDERED PER CONNECTION. The scheduler enqueues a push only when none is
 * PENDING or IN_FLIGHT for the connection, so two pushes of one hotel never
 * race each other to the provider and an older state can never land last.
 *
 * ACKNOWLEDGED, OR KEPT. The change rows read are deleted only after every
 * request was acknowledged. A failure leaves them, the outbox retries with
 * backoff, and after a dead letter the scheduler starts again: retried until
 * acknowledged, with an alert each time the budget runs out.
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service.js';
import { ClockService } from '../platform/clock.service.js';
import { OutboxPermanentError } from '../platform/outbox/outbox-handler.registry.js';
import { RateCalendarRepository } from '../rates/rate-calendar.repository.js';
import { RateCalendarService } from '../rates/rate-calendar.service.js';
import { RateRestrictionRepository } from '../rates/rate-restriction.repository.js';
import {
  ChannelProviderError,
  type AvailabilityValue,
  type ChannelProviderCode,
  type ProviderCall,
  type RateValue,
} from './channel-adapter.js';
import { ChannelAdapters, ChannelSyncLog } from './channel-adapters.js';
import { addDays, compress, datesOf, mergeChanges, type DateRange } from './ari-ranges.js';

/** How many change rows one push reads; the rest wait for the next. */
const CHANGE_BATCH = 5_000;

const iso = (date: Date): string => date.toISOString().slice(0, 10);
const utc = (date: string): Date => new Date(`${date}T00:00:00.000Z`);

export type PushOutcome =
  | { kind: 'NO_CONNECTION' }
  | { kind: 'PAUSED' }
  | { kind: 'NOTHING_PENDING' }
  | { kind: 'PUSHED'; changes: number; availability: number; rates: number; calls: number };

@Injectable()
export class AriPushService {
  private readonly logger = new Logger(AriPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: ChannelAdapters,
    private readonly log: ChannelSyncLog,
    private readonly rates: RateCalendarService,
    private readonly assignments: RateCalendarRepository,
    private readonly restrictions: RateRestrictionRepository,
    private readonly config: ConfigService,
    private readonly clock: ClockService,
  ) {}

  async push(propertyId: string, connectionId: string): Promise<PushOutcome> {
    const connection = await this.prisma.client.channelConnection.findFirst({
      where: { id: connectionId, propertyId },
      select: {
        id: true,
        provider: true,
        status: true,
        externalPropertyId: true,
        property: { select: { businessDate: true } },
        roomTypeMappings: {
          select: {
            roomTypeId: true,
            externalRoomTypeId: true,
            roomType: { select: { retiredAt: true, currency: true } },
            ratePlans: { select: { ratePlanId: true, externalRatePlanId: true } },
          },
        },
      },
    });
    // Deleted since it was enqueued: nothing to push, and not a failure.
    if (connection === null) return { kind: 'NO_CONNECTION' };
    if (connection.status !== 'ACTIVE') return { kind: 'PAUSED' };

    const adapter = this.adapters.get(connection.provider as ChannelProviderCode);
    if (!adapter.configured()) {
      await this.noteError(connectionId, 'The provider is not configured on this server.');
      throw new OutboxPermanentError(`${connection.provider} is not configured on this server.`);
    }

    const changes = await this.prisma.client.channelAriChange.findMany({
      where: { propertyId, connectionId },
      orderBy: { id: 'asc' },
      take: CHANGE_BATCH,
      select: { id: true, roomTypeId: true, fromDate: true, toDate: true },
    });
    if (changes.length === 0) return { kind: 'NOTHING_PENDING' };

    const businessDate = iso(connection.property.businessDate);
    const windowDays = this.config.get<number>('CHANNEL_ARI_WINDOW_DAYS', 365);
    const window: DateRange = { from: businessDate, to: addDays(businessDate, windowDays - 1) };
    const merged = mergeChanges(
      changes.map((change) => ({
        roomTypeId: change.roomTypeId,
        fromDate: change.fromDate === null ? null : iso(change.fromDate),
        toDate: change.toDate === null ? null : iso(change.toDate),
      })),
      connection.roomTypeMappings.map((mapping) => mapping.roomTypeId),
      window,
    );

    const availability: AvailabilityValue[] = [];
    const rateValues: RateValue[] = [];
    for (const mapping of connection.roomTypeMappings) {
      const ranges = merged.get(mapping.roomTypeId);
      if (ranges === undefined || ranges.length === 0) continue;
      const retired = mapping.roomType.retiredAt !== null;
      for (const range of ranges) {
        availability.push(
          ...(await this.availabilityFor(
            propertyId,
            mapping.roomTypeId,
            mapping.externalRoomTypeId,
            range,
            retired,
          )),
        );
        for (const plan of mapping.ratePlans) {
          rateValues.push(
            ...(await this.ratesFor(
              propertyId,
              mapping.roomTypeId,
              mapping.roomType.currency,
              plan.ratePlanId,
              plan.externalRatePlanId,
              range,
            )),
          );
        }
      }
    }

    const target = { connectionId, externalPropertyId: connection.externalPropertyId };
    const calls: ProviderCall[] = [];
    try {
      if (availability.length > 0)
        calls.push(...(await adapter.pushAvailability(target, availability)));
      if (rateValues.length > 0) calls.push(...(await adapter.pushRates(target, rateValues)));
    } catch (cause) {
      if (!(cause instanceof ChannelProviderError)) throw cause;
      await this.log.record(propertyId, connectionId, [...calls, ...cause.calls]);
      await this.noteError(connectionId, cause.message);
      // Change rows stay: the next attempt reads the then-current state.
      if (!cause.retryable) throw new OutboxPermanentError(`ARI push refused: ${cause.message}`);
      throw new Error(`ARI push failed: ${cause.message}`);
    }

    await this.log.record(propertyId, connectionId, calls);
    // Exactly the rows read. Rows committed while this push ran survive for
    // the next one, so no change is ever consumed without being sent.
    await this.prisma.client.channelAriChange.deleteMany({
      where: { propertyId, connectionId, id: { in: changes.map((change) => change.id) } },
    });
    await this.prisma.client.channelConnection.updateMany({
      where: { id: connectionId, propertyId },
      data: { lastAriSyncAt: this.clock.now(), lastAriError: null },
    });

    this.logger.log(
      `ARI pushed for connection ${connectionId}: ${String(changes.length)} change(s), ` +
        `${String(availability.length)} availability and ${String(rateValues.length)} rate value(s) ` +
        `in ${String(calls.length)} call(s).`,
    );
    return {
      kind: 'PUSHED',
      changes: changes.length,
      availability: availability.length,
      rates: rateValues.length,
      calls: calls.length,
    };
  }

  private async availabilityFor(
    propertyId: string,
    roomTypeId: string,
    externalRoomTypeId: string,
    range: DateRange,
    retired: boolean,
  ): Promise<AvailabilityValue[]> {
    const rows = await this.prisma.client.inventoryDay.findMany({
      where: { propertyId, roomTypeId, stayDate: { gte: utc(range.from), lte: utc(range.to) } },
      select: { stayDate: true, physical: true, sold: true, blocked: true },
    });
    const left = new Map(
      rows.map((row) => [iso(row.stayDate), Math.max(0, row.physical - row.sold - row.blocked)]),
    );
    const days = datesOf(range).map((date) => ({
      date,
      value: retired ? 0 : (left.get(date) ?? 0),
    }));
    return compress(days, String).map((run) => ({
      externalRoomTypeId,
      dateFrom: run.from,
      dateTo: run.to,
      availability: run.value,
    }));
  }

  private async ratesFor(
    propertyId: string,
    roomTypeId: string,
    roomTypeCurrency: string,
    ratePlanId: string,
    externalRatePlanId: string,
    range: DateRange,
  ): Promise<RateValue[]> {
    const dates = datesOf(range);
    const assignment = await this.assignments.findAssignment(propertyId, ratePlanId, roomTypeId);
    const stop = (): RateValue[] => [
      {
        externalRatePlanId,
        dateFrom: range.from,
        dateTo: range.to,
        rateMinor: null,
        currency: roomTypeCurrency,
        minStayArrival: null,
        closedToArrival: false,
        closedToDeparture: false,
        stopSell: true,
      },
    ];
    if (
      assignment === null ||
      !assignment.isActive ||
      assignment.archivedAt !== null ||
      assignment.currency !== roomTypeCurrency
    ) {
      return stop();
    }

    let nights;
    try {
      nights = await this.rates.baseNights(propertyId, assignment, dates);
    } catch (cause) {
      // A derived plan whose parent no longer prices this type: unsellable,
      // stated as stop-sell rather than as a price we cannot stand behind.
      this.logger.warn(
        `Rate plan ${ratePlanId} cannot be priced for room type ${roomTypeId}; pushing stop-sell. ` +
          `${cause instanceof Error ? cause.message : ''}`,
      );
      return stop();
    }
    const restricted = new Map(
      (
        await this.restrictions.findRange(
          propertyId,
          ratePlanId,
          roomTypeId,
          range.from,
          addDays(range.to, 1),
        )
      ).map((row) => [row.stayDate, row]),
    );

    const days = nights.map((night) => {
      const rule = restricted.get(night.stayDate);
      return {
        date: night.stayDate,
        value: {
          rateMinor: night.effectiveRateMinor,
          minStayArrival: rule?.minLos ?? null,
          closedToArrival: rule?.closedToArrival ?? false,
          closedToDeparture: rule?.closedToDeparture ?? false,
        },
      };
    });
    return compress(days, (value) => JSON.stringify(value)).map((run) => ({
      externalRatePlanId,
      dateFrom: run.from,
      dateTo: run.to,
      rateMinor: run.value.rateMinor,
      currency: roomTypeCurrency,
      minStayArrival: run.value.minStayArrival,
      closedToArrival: run.value.closedToArrival,
      closedToDeparture: run.value.closedToDeparture,
      stopSell: false,
    }));
  }

  private async noteError(connectionId: string, message: string): Promise<void> {
    await this.prisma.client.channelConnection.updateMany({
      where: { id: connectionId },
      data: { lastAriError: message.slice(0, 500) },
    });
  }
}
