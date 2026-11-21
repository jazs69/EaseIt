/**
 * The outbox handlers of the channel manager (CM-03, CM-04). Thin: each reads
 * its payload and calls the service that owns the work. The worker runs each
 * inside the event's property scope.
 */

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { channelConnectionPayloadSchema, type OutboxEventType } from '@repo/types';

import {
  OutboxHandlerRegistry,
  OutboxPermanentError,
  type OutboxHandler,
  type OutboxHandlerContext,
} from '../platform/outbox/outbox-handler.registry.js';
import { AriPushService } from './ari-push.service.js';
import { InboundService } from './inbound.service.js';

function connectionOf(context: OutboxHandlerContext, type: string): string {
  const parsed = channelConnectionPayloadSchema.safeParse(context.payload);
  if (!parsed.success) throw new OutboxPermanentError(`Malformed ${type} payload.`);
  return parsed.data.connectionId;
}

@Injectable()
export class ChannelAriPushHandler implements OutboxHandler {
  readonly eventType: OutboxEventType = 'CHANNEL_ARI_PUSH';
  constructor(private readonly ari: AriPushService) {}

  async handle(context: OutboxHandlerContext): Promise<void> {
    await this.ari.push(context.propertyId, connectionOf(context, this.eventType));
  }
}

@Injectable()
export class ChannelBookingsPullHandler implements OutboxHandler {
  readonly eventType: OutboxEventType = 'CHANNEL_BOOKINGS_PULL';
  constructor(private readonly inbound: InboundService) {}

  async handle(context: OutboxHandlerContext): Promise<void> {
    await this.inbound.pull(context.propertyId, connectionOf(context, this.eventType));
  }
}

@Injectable()
export class ChannelInboundApplyHandler implements OutboxHandler {
  readonly eventType: OutboxEventType = 'CHANNEL_INBOUND_APPLY';
  private readonly logger = new Logger(ChannelInboundApplyHandler.name);
  constructor(private readonly inbound: InboundService) {}

  async handle(context: OutboxHandlerContext): Promise<void> {
    const connectionId = connectionOf(context, this.eventType);
    const outcome = await this.inbound.apply(context.propertyId, connectionId);
    if (outcome.processed > 0) {
      // Counts only: no guest name, no booking content (section 5).
      this.logger.log(
        `Inbound applied for connection ${connectionId}: ${String(outcome.applied)} applied, ` +
          `${String(outcome.ignored)} ignored, ${String(outcome.needsAttention)} need attention.`,
      );
    }
  }
}

@Injectable()
export class ChannelHandlerRegistrar implements OnModuleInit {
  constructor(
    private readonly registry: OutboxHandlerRegistry,
    private readonly push: ChannelAriPushHandler,
    private readonly pull: ChannelBookingsPullHandler,
    private readonly apply: ChannelInboundApplyHandler,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.push);
    this.registry.register(this.pull);
    this.registry.register(this.apply);
  }
}
