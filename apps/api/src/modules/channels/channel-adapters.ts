/**
 * The adapters this process knows, by provider, and the log every provider
 * call is written to.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';

import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CHANNEL_ADAPTERS,
  type ChannelAdapter,
  type ChannelProviderCode,
  type ProviderCall,
} from './channel-adapter.js';

@Injectable()
export class ChannelAdapters {
  private readonly byProvider: Map<ChannelProviderCode, ChannelAdapter>;

  constructor(@Inject(CHANNEL_ADAPTERS) adapters: ChannelAdapter[]) {
    this.byProvider = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  get(provider: ChannelProviderCode): ChannelAdapter {
    const adapter = this.byProvider.get(provider);
    // Unreachable while the enum and the module agree.
    if (adapter === undefined) throw new Error(`No adapter registered for ${provider}.`);
    return adapter;
  }

  configured(provider: ChannelProviderCode): boolean {
    return this.byProvider.get(provider)?.configured() ?? false;
  }
}

/** Writes provider calls to `channel_sync_attempt`, outside any business transaction. */
@Injectable()
export class ChannelSyncLog {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    propertyId: string,
    connectionId: string,
    calls: readonly ProviderCall[],
  ): Promise<void> {
    if (calls.length === 0) return;
    await this.prisma.client.channelSyncAttempt.createMany({
      data: calls.map((call) => ({
        propertyId,
        connectionId,
        operation: call.operation,
        method: call.method,
        path: call.path.slice(0, 500),
        requestBody: json(call.requestBody),
        responseStatus: call.responseStatus,
        responseBody: json(call.responseBody),
        ok: call.ok,
        error: call.error === null ? null : call.error.slice(0, 500),
        durationMs: Math.max(0, Math.round(call.durationMs)),
      })),
    });
  }
}

function json(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}
