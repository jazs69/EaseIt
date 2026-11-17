/**
 * AV-09: a short-TTL Redis cache for public availability search.
 *
 * ===========================================================================
 * Keyed by `propertyId` first (CLAUDE.md 2), then the exact search. 30 s TTL,
 * no invalidation: a booking can make a cached answer stale for at most that
 * long, which is harmless because the answer is ADVISORY — a quote re-checks
 * availability uncached, and the booking transaction is the only thing that
 * decides. Nothing on the quote or booking path reads this cache.
 *
 * Redis is optional to the booking engine. The client connects lazily, never
 * queues commands while offline, and gives each command 250 ms; any failure is
 * a miss, logged once per outage, and the search is computed directly. A
 * failing Redis degrades speed, never availability.
 *
 * Under the outbox's key prefix, so a shared Redis keeps EaseIt's keys
 * together and apart from anyone else's.
 * ===========================================================================
 */

import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import { outboxPrefixFrom } from '../platform/outbox/outbox.prefix.js';

export const AVAILABILITY_TTL_SECONDS = 30;

@Injectable()
export class AvailabilityCache implements OnModuleDestroy {
  private readonly logger = new Logger(AvailabilityCache.name);
  private client: Redis | null = null;
  private failing = false;
  private readonly prefix: string;
  private readonly url: string | undefined;

  constructor(config: ConfigService) {
    this.url = config.get<string>('REDIS_URL');
    this.prefix = `${outboxPrefixFrom(config)}:be-avail`;
  }

  private get redis(): Redis | null {
    if (this.url === undefined || this.url.trim() === '') return null;
    if (this.client === null) {
      this.client = new Redis(this.url, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        connectTimeout: 1_000,
        commandTimeout: 250,
      });
      // ioredis emits connection errors as events; without a listener they
      // are unhandled. Reported once per outage, not per request.
      this.client.on('error', (error: Error) => this.trouble(error));
      this.client.on('ready', () => {
        this.failing = false;
      });
    }
    return this.client;
  }

  private trouble(error: unknown): void {
    if (this.failing) return;
    this.failing = true;
    this.logger.warn(
      `Availability cache unavailable, searching uncached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  key(propertyId: string, parts: readonly (string | number)[]): string {
    return `${this.prefix}:${propertyId}:${parts.join(':')}`;
  }

  async get(key: string): Promise<string | null> {
    const redis = this.redis;
    if (redis === null) return null;
    try {
      if (redis.status === 'wait') await redis.connect();
      return await redis.get(key);
    } catch (error) {
      this.trouble(error);
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const redis = this.redis;
    if (redis === null) return;
    try {
      if (redis.status === 'wait') await redis.connect();
      await redis.set(key, value, 'EX', AVAILABILITY_TTL_SECONDS);
    } catch (error) {
      this.trouble(error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client !== null) {
      this.client.disconnect();
      this.client = null;
    }
  }
}
