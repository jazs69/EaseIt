/**
 * The channel manager (CM-01 .. CM-05).
 *
 * The API process serves the Channels screen and enqueues nothing on its own
 * besides change rows. The worker registers the same handlers and starts
 * `ChannelSyncScheduler`, which is what pushes and pulls.
 */

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { ClockService } from '../platform/clock.service.js';
import { OutboxModule } from '../platform/outbox/outbox.module.js';
import { RatesModule } from '../rates/rates.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { AriPushService } from './ari-push.service.js';
import { CHANNEL_ADAPTERS, type ChannelAdapter } from './channel-adapter.js';
import { ChannelAdapters, ChannelSyncLog } from './channel-adapters.js';
import {
  ChannelAriPushHandler,
  ChannelBookingsPullHandler,
  ChannelHandlerRegistrar,
  ChannelInboundApplyHandler,
} from './channel.handlers.js';
import { ChannelSyncScheduler } from './channel-sync.scheduler.js';
import { ChannelsController } from './channels.controller.js';
import { ChannelsService } from './channels.service.js';
import { ChannexAdapter } from './channex/channex.adapter.js';
import { InboundService } from './inbound.service.js';

@Module({
  imports: [ReservationsModule, RatesModule, OutboxModule],
  controllers: [ChannelsController],
  providers: [
    {
      // One adapter per provider (CM-05). A second provider is one more entry.
      provide: CHANNEL_ADAPTERS,
      useFactory: (config: ConfigService, clock: ClockService): ChannelAdapter[] => [
        new ChannexAdapter(config, clock),
      ],
      inject: [ConfigService, ClockService],
    },
    ChannelAdapters,
    ChannelSyncLog,
    ChannelsService,
    AriPushService,
    InboundService,
    ChannelAriPushHandler,
    ChannelBookingsPullHandler,
    ChannelInboundApplyHandler,
    ChannelHandlerRegistrar,
    ChannelSyncScheduler,
    TokenService,
    SessionAuthGuard,
  ],
  exports: [ChannelSyncScheduler],
})
export class ChannelsModule {}
