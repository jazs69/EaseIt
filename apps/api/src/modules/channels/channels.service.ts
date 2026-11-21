/**
 * The Channels screen's API (CM-01, CM-02): connect a provider, map room types
 * and rate plans, switch a connection on or off, ask for a push, read the
 * call log, and act on inbound bookings that need a person.
 *
 * ===========================================================================
 * Nothing here calls a provider. Activating, re-mapping and "sync now" write
 * a change row in their own transaction; the worker's scheduler pushes it.
 * A request never waits on an OTA (section 5: a failing OTA degrades the sync
 * layer, never the front desk).
 *
 * Grant first, then permission: a caller with no grant at the property gets
 * not-found, and only one who holds a grant can see a 403 (section 3.2).
 * Every connection, mapping and message is read with `propertyId` in the same
 * predicate as its id, so another hotel's row is not found, never forbidden.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';
import {
  CHANNEL_PROVIDER_LABELS,
  Permission,
  channelAttentionCodeSchema,
  type ChannelConnection,
  type ChannelInboundList,
  type ChannelInboundMessage,
  type ChannelMappingsCommand,
  type ChannelOverview,
  type ChannelProvider,
  type ChannelSyncAttemptList,
  type ChannelSyncCommand,
  type ChannelSyncResult,
  type CreateChannelConnectionCommand,
  type ListInboundQuery,
  type ListSyncAttemptsQuery,
  type ResolveInboundCommand,
} from '@repo/types';

import {
  InvalidStateTransitionError,
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClockService } from '../platform/clock.service.js';
import { ChannelAdapters } from './channel-adapters.js';
import type { ChannelProviderCode } from './channel-adapter.js';

const PROVIDERS: readonly ChannelProvider[] = ['CHANNEX'];
const iso = (date: Date): string => date.toISOString().slice(0, 10);

interface Caller {
  propertyId: string;
  businessDate: string;
}

type Tx = Prisma.TransactionClient;

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: ChannelAdapters,
    private readonly clock: ClockService,
  ) {}

  /* ------------------------------------------------------------- reads -- */

  async overview(userId: string, hotelId: string): Promise<ChannelOverview> {
    const caller = await this.authorise(userId, hotelId, Permission.CHANNELS_READ);
    const [connections, roomTypes] = await Promise.all([
      this.prisma.client.channelConnection.findMany({
        where: { propertyId: caller.propertyId },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      }),
      this.prisma.client.roomType.findMany({
        where: { propertyId: caller.propertyId },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          code: true,
          name: true,
          retiredAt: true,
          ratePlans: {
            orderBy: { ratePlan: { sortOrder: 'asc' } },
            select: {
              ratePlan: {
                select: { id: true, code: true, name: true, isActive: true, archivedAt: true },
              },
            },
          },
        },
      }),
    ]);
    return {
      businessDate: caller.businessDate as ChannelOverview['businessDate'],
      providers: PROVIDERS.map((provider) => ({
        provider,
        label: CHANNEL_PROVIDER_LABELS[provider],
        configured: this.adapters.configured(provider),
      })),
      connections: await Promise.all(connections.map((c) => this.view(caller.propertyId, c.id))),
      roomTypes: roomTypes.map((type) => ({
        roomTypeId: type.id,
        code: type.code,
        name: type.name,
        retired: type.retiredAt !== null,
        ratePlans: type.ratePlans
          .filter((link) => link.ratePlan.archivedAt === null)
          .map((link) => ({
            ratePlanId: link.ratePlan.id,
            code: link.ratePlan.code,
            name: link.ratePlan.name,
            active: link.ratePlan.isActive,
          })),
      })),
    };
  }

  async attempts(
    userId: string,
    hotelId: string,
    connectionId: string,
    query: ListSyncAttemptsQuery,
  ): Promise<ChannelSyncAttemptList> {
    const caller = await this.authorise(userId, hotelId, Permission.CHANNELS_READ);
    await this.connection(caller.propertyId, connectionId);
    const rows = await this.prisma.client.channelSyncAttempt.findMany({
      where: { propertyId: caller.propertyId, connectionId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: this.uuid(query.cursor) }, skip: 1 }),
      select: {
        id: true,
        operation: true,
        method: true,
        path: true,
        ok: true,
        responseStatus: true,
        error: true,
        durationMs: true,
        requestBody: true,
        responseBody: true,
        createdAt: true,
      },
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async inbound(
    userId: string,
    hotelId: string,
    connectionId: string,
    query: ListInboundQuery,
  ): Promise<ChannelInboundList> {
    const caller = await this.authorise(userId, hotelId, Permission.CHANNELS_READ);
    const connection = await this.connection(caller.propertyId, connectionId);
    const before = query.cursor === undefined ? undefined : this.sequence(query.cursor);
    const rows = await this.prisma.client.channelInboundMessage.findMany({
      where: {
        propertyId: caller.propertyId,
        connectionId,
        ...(query.status === 'attention' ? { status: 'NEEDS_ATTENTION' } : {}),
        ...(before === undefined ? {} : { sequence: { lt: before } }),
      },
      orderBy: { sequence: 'desc' },
      take: query.limit + 1,
      select: {
        id: true,
        sequence: true,
        externalMessageId: true,
        externalBookingId: true,
        revisionKind: true,
        status: true,
        attentionCode: true,
        outcome: true,
        attempts: true,
        receivedAt: true,
        appliedAt: true,
        resolvedAt: true,
        rawPayload: true,
      },
    });
    const page = rows.slice(0, query.limit);
    const bookingIds = [
      ...new Set(
        page.map((row) => row.externalBookingId).filter((id): id is string => id !== null),
      ),
    ];
    const links = await this.prisma.client.channelReservation.findMany({
      where: { propertyId: caller.propertyId, connectionId, externalBookingId: { in: bookingIds } },
      orderBy: { roomIndex: 'asc' },
      select: {
        externalBookingId: true,
        roomIndex: true,
        reservationId: true,
        reservation: { select: { confirmationCode: true } },
      },
    });
    const adapter = this.adapters.get(connection.provider as ChannelProviderCode);

    const items: ChannelInboundMessage[] = page.map((row) => {
      let summary: ChannelInboundMessage['summary'] = null;
      try {
        const booking = adapter.readBooking(row.rawPayload);
        const first = booking.rooms[0];
        summary = {
          otaName: booking.otaName,
          otaReservationCode: booking.otaReservationCode,
          guestName: `${booking.booker.firstName} ${booking.booker.lastName}`.trim(),
          arrivalDate: first?.arrivalDate ?? '',
          departureDate: first?.departureDate ?? '',
          rooms: booking.rooms.length,
        };
      } catch {
        // Unreadable: the row's own status says so; the summary stays empty.
        summary = null;
      }
      const code = channelAttentionCodeSchema.safeParse(row.attentionCode);
      return {
        id: row.id,
        sequence: row.sequence.toString(),
        externalMessageId: row.externalMessageId,
        externalBookingId: row.externalBookingId,
        revisionKind: row.revisionKind,
        status: row.status,
        attentionCode: code.success ? code.data : null,
        outcome: row.outcome,
        attempts: row.attempts,
        receivedAt: row.receivedAt.toISOString(),
        appliedAt: row.appliedAt?.toISOString() ?? null,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        summary,
        reservations: links
          .filter((link) => link.externalBookingId === row.externalBookingId)
          .map((link) => ({
            reservationId: link.reservationId,
            confirmationCode: link.reservation.confirmationCode,
            roomIndex: link.roomIndex,
          })),
      };
    });
    return {
      items,
      nextCursor: rows.length > query.limit ? (page.at(-1)?.sequence.toString() ?? null) : null,
    };
  }

  /* ------------------------------------------------------------ writes -- */

  async create(
    userId: string,
    hotelId: string,
    command: CreateChannelConnectionCommand,
  ): Promise<ChannelConnection> {
    const caller = await this.authorise(userId, hotelId, Permission.CHANNELS_MANAGE);
    const existing = await this.prisma.client.channelConnection.findFirst({
      where: { propertyId: caller.propertyId, provider: command.provider },
      select: { id: true },
    });
    if (existing !== null) {
      throw new ValidationFailedError({
        provider: 'This property is already connected to that provider.',
      });
    }
    const id = await this.prisma.client.$transaction(async (tx) => {
      const row = await tx.channelConnection.create({
        data: {
          propertyId: caller.propertyId,
          provider: command.provider,
          externalPropertyId: command.externalPropertyId,
          status: 'PAUSED',
          createdByUserId: userId,
        },
        select: { id: true },
      });
      await this.audit(tx, caller.propertyId, userId, row.id, 'CHANNEL_CONNECTION_CREATED', null, {
        provider: command.provider,
        externalPropertyId: command.externalPropertyId,
      });
      return row.id;
    });
    return this.view(caller.propertyId, id);
  }

  async setMappings(
    userId: string,
    hotelId: string,
    connectionId: string,
    command: ChannelMappingsCommand,
  ): Promise<ChannelConnection> {
    const caller = await this.authorise(userId, hotelId, Permission.CHANNELS_MANAGE);
    const connection = await this.connection(caller.propertyId, connectionId);
    await this.validateMappings(caller.propertyId, command);

    await this.prisma.client.$transaction(async (tx) => {
      const before = await this.mappingsOf(tx, caller.propertyId, connectionId);
      // Replace-all: one save, one audit row, one full push.
      await tx.channelRoomTypeMapping.deleteMany({
        where: { propertyId: caller.propertyId, connectionId },
      });
      for (const type of command.roomTypes) {
        const mapping = await tx.channelRoomTypeMapping.create({
          data: {
            propertyId: caller.propertyId,
            connectionId,
            roomTypeId: type.roomTypeId,
            externalRoomTypeId: type.externalRoomTypeId,
          },
          select: { id: true },
        });
        if (type.ratePlans.length > 0) {
          await tx.channelRatePlanMapping.createMany({
            data: type.ratePlans.map((plan) => ({
              propertyId: caller.propertyId,
              connectionId,
              roomTypeMappingId: mapping.id,
              roomTypeId: type.roomTypeId,
              ratePlanId: plan.ratePlanId,
              externalRatePlanId: plan.externalRatePlanId,
            })),
          });
        }
      }
      if (connection.status === 'ACTIVE')
        await this.markWholeWindow(tx, caller.propertyId, connectionId);
      await this.audit(
        tx,
        caller.propertyId,
        userId,
        connectionId,
        'CHANNEL_MAPPINGS_SET',
        { roomTypes: before } as unknown as Prisma.InputJsonValue,
        command as unknown as Prisma.InputJsonValue,
      );
    });
    return this.view(caller.propertyId, connectionId);
  }

  async activate(
    userId: string,
    hotelId: string,
    connectionId: string,
  ): Promise<ChannelConnection> {
    const caller = await this.authorise(userId, hotelId, Permission.CHANNELS_MANAGE);
    const connection = await this.connection(caller.propertyId, connectionId);
    if (!this.adapters.configured(connection.provider as ChannelProviderCode)) {
      throw new ValidationFailedError({
        provider: 'This server holds no credentials for that provider, so nothing could be sent.',
      });
    }
    const mapped = await this.prisma.client.channelRoomTypeMapping.count({
      where: { propertyId: caller.propertyId, connectionId },
    });
    if (mapped === 0) {
      throw new ValidationFailedError({
        mappings: 'Map at least one room type before switching the connection on.',
      });
    }
    await this.prisma.client.$transaction(async (tx) => {
      const changed = await tx.channelConnection.updateMany({
        where: { id: connectionId, propertyId: caller.propertyId, status: 'PAUSED' },
        data: { status: 'ACTIVE', lastPulledAt: null },
      });
      if (changed.count === 0) return; // already active: idempotent
      // Everything, once: the channels may hold anything from before.
      await this.markWholeWindow(tx, caller.propertyId, connectionId);
      await this.audit(
        tx,
        caller.propertyId,
        userId,
        connectionId,
        'CHANNEL_CONNECTION_ACTIVATED',
        { status: 'PAUSED' },
        { status: 'ACTIVE' },
      );
    });
    return this.view(caller.propertyId, connectionId);
  }

  async pause(userId: string, hotelId: string, connectionId: string): Promise<ChannelConnection> {
    const caller = await this.authorise(userId, hotelId, Permission.CHANNELS_MANAGE);
    await this.connection(caller.propertyId, connectionId);
    await this.prisma.client.$transaction(async (tx) => {
      const changed = await tx.channelConnection.updateMany({
        where: { id: connectionId, propertyId: caller.propertyId, status: 'ACTIVE' },
        data: { status: 'PAUSED' },
      });
      if (changed.count === 0) return;
      // Activation pushes the whole window again, so pending rows mean nothing now.
      await tx.channelAriChange.deleteMany({
        where: { propertyId: caller.propertyId, connectionId },
      });
      await this.audit(
        tx,
        caller.propertyId,
        userId,
        connectionId,
        'CHANNEL_CONNECTION_PAUSED',
        { status: 'ACTIVE' },
        { status: 'PAUSED' },
      );
    });
    return this.view(caller.propertyId, connectionId);
  }

  async sync(
    userId: string,
    hotelId: string,
    connectionId: string,
    command: ChannelSyncCommand,
  ): Promise<ChannelSyncResult> {
    const caller = await this.authorise(userId, hotelId, Permission.CHANNELS_SYNC);
    const connection = await this.connection(caller.propertyId, connectionId);
    if (connection.status !== 'ACTIVE') {
      throw new InvalidStateTransitionError('channel connection', connection.status, 'SYNCING');
    }
    await this.prisma.client.$transaction(async (tx) => {
      if (command.full) await this.markWholeWindow(tx, caller.propertyId, connectionId);
      // Fetch bookings on the next tick too.
      await tx.channelConnection.updateMany({
        where: { id: connectionId, propertyId: caller.propertyId },
        data: { lastPulledAt: null },
      });
      await this.audit(
        tx,
        caller.propertyId,
        userId,
        connectionId,
        'CHANNEL_SYNC_REQUESTED',
        null,
        { full: command.full },
      );
    });
    const pending = await this.prisma.client.channelAriChange.count({
      where: { propertyId: caller.propertyId, connectionId },
    });
    return { queued: true, pendingAriChanges: pending };
  }

  /** Puts a message back for the worker, with any later revision it was holding up. */
  async retryInbound(
    userId: string,
    hotelId: string,
    connectionId: string,
    messageId: string,
  ): Promise<ChannelInboundMessage> {
    const caller = await this.authorise(userId, hotelId, Permission.CHANNELS_MANAGE);
    await this.connection(caller.propertyId, connectionId);
    await this.prisma.client.$transaction(async (tx) => {
      const message = await this.attentionMessage(tx, caller.propertyId, connectionId, messageId);
      await tx.channelInboundMessage.updateMany({
        where: { id: messageId, propertyId: caller.propertyId, status: 'NEEDS_ATTENTION' },
        data: { status: 'RECEIVED', attentionCode: null, outcome: null },
      });
      await this.releaseLater(tx, caller.propertyId, connectionId, message);
      await this.audit(
        tx,
        caller.propertyId,
        userId,
        messageId,
        'CHANNEL_INBOUND_RETRIED',
        { status: 'NEEDS_ATTENTION', attentionCode: message.attentionCode },
        { status: 'RECEIVED' },
      );
    });
    return this.message(caller.propertyId, connectionId, messageId, userId, hotelId);
  }

  /** Records that a person dealt with it (by hand, at the desk). */
  async resolveInbound(
    userId: string,
    hotelId: string,
    connectionId: string,
    messageId: string,
    command: ResolveInboundCommand,
  ): Promise<ChannelInboundMessage> {
    const caller = await this.authorise(userId, hotelId, Permission.CHANNELS_MANAGE);
    await this.connection(caller.propertyId, connectionId);
    await this.prisma.client.$transaction(async (tx) => {
      const message = await this.attentionMessage(tx, caller.propertyId, connectionId, messageId);
      const note = command.note === null ? '' : ` Note: ${command.note}`;
      await tx.channelInboundMessage.updateMany({
        where: { id: messageId, propertyId: caller.propertyId, status: 'NEEDS_ATTENTION' },
        data: {
          status: 'RESOLVED',
          resolvedAt: this.clock.now(),
          resolvedByUserId: userId,
          outcome: `${message.outcome ?? ''} Resolved by hand.${note}`.trim().slice(0, 500),
        },
      });
      await this.releaseLater(tx, caller.propertyId, connectionId, message);
      await this.audit(
        tx,
        caller.propertyId,
        userId,
        messageId,
        'CHANNEL_INBOUND_RESOLVED',
        { status: 'NEEDS_ATTENTION', attentionCode: message.attentionCode },
        { status: 'RESOLVED', note: command.note },
      );
    });
    return this.message(caller.propertyId, connectionId, messageId, userId, hotelId);
  }

  /* ----------------------------------------------------------- helpers -- */

  private async message(
    propertyId: string,
    connectionId: string,
    messageId: string,
    userId: string,
    hotelId: string,
  ): Promise<ChannelInboundMessage> {
    const list = await this.inbound(userId, hotelId, connectionId, { status: 'all', limit: 100 });
    const found = list.items.find((item) => item.id === messageId);
    if (found !== undefined) return found;
    // Older than the first page: read it on its own.
    const row = await this.prisma.client.channelInboundMessage.findFirst({
      where: { id: messageId, propertyId, connectionId },
      select: { sequence: true },
    });
    if (row === null) throw new TenantScopeViolationError('Inbound message');
    const page = await this.inbound(userId, hotelId, connectionId, {
      status: 'all',
      limit: 1,
      cursor: (row.sequence + 1n).toString(),
    });
    const item = page.items[0];
    if (item === undefined) throw new TenantScopeViolationError('Inbound message');
    return item;
  }

  private async attentionMessage(
    tx: Tx,
    propertyId: string,
    connectionId: string,
    messageId: string,
  ): Promise<{
    id: string;
    sequence: bigint;
    externalBookingId: string | null;
    attentionCode: string | null;
    outcome: string | null;
  }> {
    const uuid = this.uuid(messageId);
    // Locked, so a retry and a resolve of the same message cannot both act.
    const rows = await tx.$queryRaw<
      {
        id: string;
        sequence: bigint;
        externalBookingId: string | null;
        attentionCode: string | null;
        outcome: string | null;
        status: string;
      }[]
    >`
      SELECT "id", "sequence", "externalBookingId", "attentionCode", "outcome", "status"::text AS status
        FROM "channel_inbound_message"
       WHERE "id" = ${uuid}::uuid AND "propertyId" = ${propertyId}::uuid AND "connectionId" = ${connectionId}::uuid
       FOR UPDATE`;
    const message = rows[0];
    if (message === undefined) throw new TenantScopeViolationError('Inbound message');
    if (message.status !== 'NEEDS_ATTENTION') {
      throw new InvalidStateTransitionError('inbound message', message.status, 'RECEIVED');
    }
    return message;
  }

  /** Later revisions of the same booking that were only waiting on this one. */
  private async releaseLater(
    tx: Tx,
    propertyId: string,
    connectionId: string,
    message: { sequence: bigint; externalBookingId: string | null },
  ): Promise<void> {
    if (message.externalBookingId === null) return;
    await tx.channelInboundMessage.updateMany({
      where: {
        propertyId,
        connectionId,
        externalBookingId: message.externalBookingId,
        sequence: { gt: message.sequence },
        status: 'NEEDS_ATTENTION',
        attentionCode: 'EARLIER_REVISION',
      },
      data: { status: 'RECEIVED', attentionCode: null, outcome: null },
    });
  }

  private async markWholeWindow(tx: Tx, propertyId: string, connectionId: string): Promise<void> {
    await tx.channelAriChange.create({ data: { propertyId, connectionId }, select: { id: true } });
  }

  private async validateMappings(
    propertyId: string,
    command: ChannelMappingsCommand,
  ): Promise<void> {
    const issues: Record<string, string> = {};
    const seenTypes = new Set<string>();
    const seenExternalTypes = new Set<string>();
    const seenExternalPlans = new Set<string>();
    const types = await this.prisma.client.roomType.findMany({
      where: { propertyId, id: { in: command.roomTypes.map((type) => type.roomTypeId) } },
      select: {
        id: true,
        retiredAt: true,
        currency: true,
        ratePlans: {
          select: { ratePlanId: true, ratePlan: { select: { archivedAt: true, currency: true } } },
        },
      },
    });
    const byId = new Map(types.map((type) => [type.id, type]));
    command.roomTypes.forEach((entry, index) => {
      const at = `roomTypes.${String(index)}`;
      const type = byId.get(entry.roomTypeId);
      if (type === undefined) {
        issues[`${at}.roomTypeId`] = 'No such room type at this property.';
        return;
      }
      if (type.retiredAt !== null) issues[`${at}.roomTypeId`] = 'That room type has been retired.';
      if (seenTypes.has(entry.roomTypeId))
        issues[`${at}.roomTypeId`] = 'Each room type can be mapped once.';
      seenTypes.add(entry.roomTypeId);
      if (seenExternalTypes.has(entry.externalRoomTypeId)) {
        issues[`${at}.externalRoomTypeId`] = 'Each provider room type can be mapped once.';
      }
      seenExternalTypes.add(entry.externalRoomTypeId);
      const assigned = new Map(type.ratePlans.map((link) => [link.ratePlanId, link.ratePlan]));
      const seenPlans = new Set<string>();
      entry.ratePlans.forEach((plan, planIndex) => {
        const planAt = `${at}.ratePlans.${String(planIndex)}`;
        const link = assigned.get(plan.ratePlanId);
        if (link === undefined)
          issues[`${planAt}.ratePlanId`] = 'That rate plan does not price this room type.';
        else if (link.archivedAt !== null)
          issues[`${planAt}.ratePlanId`] = 'That rate plan is archived.';
        else if (link.currency !== type.currency)
          issues[`${planAt}.ratePlanId`] = 'That rate plan sells in another currency.';
        if (seenPlans.has(plan.ratePlanId))
          issues[`${planAt}.ratePlanId`] = 'Each rate plan can be mapped once per room type.';
        seenPlans.add(plan.ratePlanId);
        if (seenExternalPlans.has(plan.externalRatePlanId)) {
          issues[`${planAt}.externalRatePlanId`] = 'Each provider rate plan can be mapped once.';
        }
        seenExternalPlans.add(plan.externalRatePlanId);
      });
    });
    if (Object.keys(issues).length > 0) throw new ValidationFailedError(issues);
  }

  private async mappingsOf(
    tx: Tx | PrismaService['client'],
    propertyId: string,
    connectionId: string,
  ): Promise<ChannelConnection['mappings']> {
    const rows = await tx.channelRoomTypeMapping.findMany({
      where: { propertyId, connectionId },
      orderBy: { createdAt: 'asc' },
      select: {
        roomTypeId: true,
        externalRoomTypeId: true,
        ratePlans: {
          orderBy: { createdAt: 'asc' },
          select: { ratePlanId: true, externalRatePlanId: true },
        },
      },
    });
    return rows;
  }

  private async view(propertyId: string, connectionId: string): Promise<ChannelConnection> {
    const row = await this.prisma.client.channelConnection.findFirst({
      where: { id: connectionId, propertyId },
      select: {
        id: true,
        provider: true,
        externalPropertyId: true,
        status: true,
        lastAriSyncAt: true,
        lastAriError: true,
        lastPulledAt: true,
        lastPullError: true,
        createdAt: true,
      },
    });
    if (row === null) throw new TenantScopeViolationError('Channel connection');
    const [pending, attention, mappings] = await Promise.all([
      this.prisma.client.channelAriChange.count({ where: { propertyId, connectionId } }),
      this.prisma.client.channelInboundMessage.count({
        where: { propertyId, connectionId, status: 'NEEDS_ATTENTION' },
      }),
      this.mappingsOf(this.prisma.client, propertyId, connectionId),
    ]);
    return {
      id: row.id,
      provider: row.provider,
      externalPropertyId: row.externalPropertyId,
      status: row.status,
      providerConfigured: this.adapters.configured(row.provider as ChannelProviderCode),
      lastAriSyncAt: row.lastAriSyncAt?.toISOString() ?? null,
      lastAriError: row.lastAriError,
      lastPulledAt: row.lastPulledAt?.toISOString() ?? null,
      lastPullError: row.lastPullError,
      pendingAriChanges: pending,
      inboundNeedingAttention: attention,
      mappings,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async connection(
    propertyId: string,
    connectionId: string,
  ): Promise<{ id: string; provider: string; status: string }> {
    const row = await this.prisma.client.channelConnection.findFirst({
      where: { id: this.uuid(connectionId), propertyId },
      select: { id: true, provider: true, status: true },
    });
    if (row === null) throw new TenantScopeViolationError('Channel connection');
    return row;
  }

  private async audit(
    tx: Tx,
    propertyId: string,
    userId: string,
    entityId: string,
    event: string,
    before: Prisma.InputJsonValue | null,
    after: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        propertyId,
        actorUserId: userId,
        event,
        entityType: 'channel_connection',
        entityId,
        before: before === null ? Prisma.JsonNull : before,
        after,
        reason: null,
      },
    });
  }

  /** A malformed id is not-found, never a 500 from the uuid cast. */
  private uuid(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw new TenantScopeViolationError('Channel record');
    }
    return value;
  }

  private sequence(value: string): bigint {
    if (!/^\d{1,19}$/.test(value))
      throw new ValidationFailedError({ cursor: 'Not a valid cursor.' });
    return BigInt(value);
  }

  private async authorise(userId: string, hotelId: string, required: Permission): Promise<Caller> {
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: grantedPropertyWhere({ userId, codeOrId: hotelId, operableOnly: false }),
      select: {
        role: { select: { key: true } },
        property: { select: { id: true, businessDate: true } },
      },
    });
    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');
    requirePermissionFromGrants(grants, required);
    return { propertyId: first.property.id, businessDate: iso(first.property.businessDate) };
  }
}
