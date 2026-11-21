/**
 * Channel manager contracts (CM-01 .. CM-05).
 *
 * A property connects to a channel provider (today: Channex, an aggregator
 * that reaches Booking.com, Expedia, Agoda, Airbnb and MakeMyTrip), maps its
 * room types and rate plans to the provider's, and from then on:
 *
 *   - every ARI change is pushed (availability, rates, restrictions), and
 *   - provider bookings are pulled, stored raw, and turned into reservations.
 *
 * Provider credentials are server configuration and never cross this API.
 */

import { z } from 'zod';

import { businessDateSchema } from '../domain.js';

export const channelProviderSchema = z.enum(['CHANNEX']);
export type ChannelProvider = z.infer<typeof channelProviderSchema>;

export const CHANNEL_PROVIDER_LABELS: Record<ChannelProvider, string> = {
  CHANNEX: 'Channex (Booking.com, Expedia, Agoda, Airbnb, MakeMyTrip)',
};

export const channelConnectionStatusSchema = z.enum(['ACTIVE', 'PAUSED']);
export type ChannelConnectionStatus = z.infer<typeof channelConnectionStatusSchema>;

export const channelInboundStatusSchema = z.enum([
  'RECEIVED',
  'APPLIED',
  'IGNORED',
  'NEEDS_ATTENTION',
  'RESOLVED',
]);
export type ChannelInboundStatus = z.infer<typeof channelInboundStatusSchema>;

/**
 * Why an inbound message needs a person. Each one is a case the system will
 * not guess about: an OTA booking it cannot place exactly as sold.
 */
export const channelAttentionCodeSchema = z.enum([
  /** The raw message could not be read as a booking. */
  'UNREADABLE',
  /** A room type or rate plan in the booking is not mapped. */
  'UNMAPPED_ROOM_TYPE',
  'UNMAPPED_RATE_PLAN',
  /** The booking's currency is not the room type's. */
  'CURRENCY_MISMATCH',
  /** No stock left (even with the overbooking allowance) or no inventory row. */
  'NO_AVAILABILITY',
  /** The booking was refused for another stated reason. */
  'REFUSED',
  /** A modification: dates, rooms or prices changed at the OTA. Apply it at the desk. */
  'MODIFICATION',
  /** A cancellation of a stay that is in house or checked out. */
  'GUEST_IN_HOUSE',
  /** Only some rooms of a multi-room booking could be booked. */
  'PARTIAL',
  /** An earlier revision of the same booking is still waiting for a person. */
  'EARLIER_REVISION',
]);
export type ChannelAttentionCode = z.infer<typeof channelAttentionCodeSchema>;

export const CHANNEL_ATTENTION_LABELS: Record<ChannelAttentionCode, string> = {
  UNREADABLE: 'Could not be read',
  UNMAPPED_ROOM_TYPE: 'Room type not mapped',
  UNMAPPED_RATE_PLAN: 'Rate plan not mapped',
  CURRENCY_MISMATCH: 'Currency differs',
  NO_AVAILABILITY: 'No room left',
  REFUSED: 'Refused',
  MODIFICATION: 'Modified at the OTA',
  GUEST_IN_HOUSE: 'Guest already arrived',
  PARTIAL: 'Only partly booked',
  EARLIER_REVISION: 'Waiting on an earlier revision',
};

/** A provider's identifier: opaque, never blank, bounded. */
const externalIdSchema = z.string().trim().min(1).max(100);

/* -------------------------------------------------------------------------- */
/*  Commands                                                                  */
/* -------------------------------------------------------------------------- */

export const createChannelConnectionSchema = z.object({
  provider: channelProviderSchema,
  /** The provider's id for this hotel (Channex property id). */
  externalPropertyId: externalIdSchema,
});
export type CreateChannelConnectionCommand = z.infer<typeof createChannelConnectionSchema>;

/**
 * The whole mapping of a connection, replacing what was there.
 *
 * Replace-all rather than per-row edits so one save is one audited change and
 * one full push; a mapping is a handful of rows at this scale.
 */
export const channelMappingsSchema = z.object({
  roomTypes: z
    .array(
      z.object({
        roomTypeId: z.uuid(),
        externalRoomTypeId: externalIdSchema,
        ratePlans: z
          .array(z.object({ ratePlanId: z.uuid(), externalRatePlanId: externalIdSchema }))
          .max(50)
          .default([]),
      }),
    )
    .max(200),
});
export type ChannelMappingsCommand = z.infer<typeof channelMappingsSchema>;

export const channelSyncSchema = z.object({
  /** Push every mapped room type over the whole window, not just what changed. */
  full: z.boolean().default(false),
});
export type ChannelSyncCommand = z.infer<typeof channelSyncSchema>;

export const resolveInboundSchema = z.object({
  note: z.string().trim().max(300).nullable().default(null),
});
export type ResolveInboundCommand = z.infer<typeof resolveInboundSchema>;

export const listInboundQuerySchema = z.object({
  status: z.enum(['attention', 'all']).default('attention'),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListInboundQuery = z.infer<typeof listInboundQuerySchema>;

export const listSyncAttemptsQuerySchema = z.object({
  cursor: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListSyncAttemptsQuery = z.infer<typeof listSyncAttemptsQuerySchema>;

/* -------------------------------------------------------------------------- */
/*  Views                                                                     */
/* -------------------------------------------------------------------------- */

export const channelMappingSchema = z.object({
  roomTypeId: z.uuid(),
  externalRoomTypeId: z.string(),
  ratePlans: z.array(z.object({ ratePlanId: z.uuid(), externalRatePlanId: z.string() })),
});
export type ChannelMapping = z.infer<typeof channelMappingSchema>;

export const channelConnectionSchema = z.object({
  id: z.uuid(),
  provider: channelProviderSchema,
  externalPropertyId: z.string(),
  status: channelConnectionStatusSchema,
  /** Whether this server holds credentials for the provider. */
  providerConfigured: z.boolean(),
  lastAriSyncAt: z.string().nullable(),
  lastAriError: z.string().nullable(),
  lastPulledAt: z.string().nullable(),
  lastPullError: z.string().nullable(),
  /** Change rows not yet pushed. Zero when the channels are up to date. */
  pendingAriChanges: z.number().int().nonnegative(),
  inboundNeedingAttention: z.number().int().nonnegative(),
  mappings: z.array(channelMappingSchema),
  createdAt: z.string(),
});
export type ChannelConnection = z.infer<typeof channelConnectionSchema>;

export const channelOverviewSchema = z.object({
  businessDate: businessDateSchema,
  providers: z.array(
    z.object({ provider: channelProviderSchema, label: z.string(), configured: z.boolean() }),
  ),
  connections: z.array(channelConnectionSchema),
  /** What can be mapped: the property's room types and the plans assigned to each. */
  roomTypes: z.array(
    z.object({
      roomTypeId: z.uuid(),
      code: z.string(),
      name: z.string(),
      retired: z.boolean(),
      ratePlans: z.array(
        z.object({ ratePlanId: z.uuid(), code: z.string(), name: z.string(), active: z.boolean() }),
      ),
    }),
  ),
});
export type ChannelOverview = z.infer<typeof channelOverviewSchema>;

export const channelSyncAttemptSchema = z.object({
  id: z.uuid(),
  operation: z.string(),
  method: z.string(),
  path: z.string(),
  ok: z.boolean(),
  responseStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int(),
  requestBody: z.unknown().nullable(),
  responseBody: z.unknown().nullable(),
  createdAt: z.string(),
});
export type ChannelSyncAttempt = z.infer<typeof channelSyncAttemptSchema>;

export const channelSyncAttemptListSchema = z.object({
  items: z.array(channelSyncAttemptSchema),
  nextCursor: z.string().nullable(),
});
export type ChannelSyncAttemptList = z.infer<typeof channelSyncAttemptListSchema>;

export const channelInboundMessageSchema = z.object({
  id: z.uuid(),
  /** Arrival order, as a string (a bigint on the server). */
  sequence: z.string(),
  externalMessageId: z.string(),
  externalBookingId: z.string().nullable(),
  revisionKind: z.string().nullable(),
  status: channelInboundStatusSchema,
  attentionCode: channelAttentionCodeSchema.nullable(),
  outcome: z.string().nullable(),
  attempts: z.number().int(),
  receivedAt: z.string(),
  appliedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  /** What the message says, when it can be read; null when it cannot. */
  summary: z
    .object({
      otaName: z.string().nullable(),
      otaReservationCode: z.string().nullable(),
      guestName: z.string(),
      arrivalDate: z.string(),
      departureDate: z.string(),
      rooms: z.number().int(),
    })
    .nullable(),
  reservations: z.array(
    z.object({
      reservationId: z.uuid(),
      confirmationCode: z.string(),
      roomIndex: z.number().int(),
    }),
  ),
});
export type ChannelInboundMessage = z.infer<typeof channelInboundMessageSchema>;

export const channelInboundListSchema = z.object({
  items: z.array(channelInboundMessageSchema),
  nextCursor: z.string().nullable(),
});
export type ChannelInboundList = z.infer<typeof channelInboundListSchema>;

export const channelSyncResultSchema = z.object({
  /** The change row recorded; the worker pushes it within its debounce. */
  queued: z.boolean(),
  pendingAriChanges: z.number().int().nonnegative(),
});
export type ChannelSyncResult = z.infer<typeof channelSyncResultSchema>;
