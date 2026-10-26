/**
 * Probes.
 *
 * ===========================================================================
 * Three endpoints, three different questions. Keeping them apart is the point.
 *
 * - `GET /health` — **liveness**. Does the process answer? No dependency is
 *   touched. A restart is the only sensible remedy for a failure here, so
 *   involving the database would make a brief database blip restart every API
 *   replica, which is how a small outage becomes a large one.
 *
 * - `GET /health/ready` — **readiness**. Should a load balancer send requests?
 *   PostgreSQL only. Redis is deliberately *not* checked: almost every request
 *   this API serves works fine without it, and the one thing that needs it —
 *   draining the outbox — happens in the worker process. Marking the API
 *   unready because Redis is down would take the front desk offline to protect
 *   a background queue.
 *
 * - `GET /health/outbox` — **workload**. How big is the backlog? Always 200,
 *   even with ten thousand pending events and a hundred dead letters, because
 *   a backlog is a number for an operator to read, not a verdict on whether
 *   this process can serve traffic. Alerting thresholds belong in the
 *   monitoring system, which can see history; a probe cannot.
 * ===========================================================================
 */

import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { OutboxBacklog } from '@repo/types';

import { OutboxMetricsService } from '../platform/outbox/outbox-metrics.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outboxMetrics: OutboxMetricsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liveness probe — does the process answer?' })
  @ApiOkResponse({ description: 'The API process is up.' })
  live(): { status: string; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe — can this process serve requests?',
    description:
      'Checks PostgreSQL only. Redis is not a readiness dependency of the API: ' +
      'outbox draining lives in the worker process, so Redis being down must ' +
      'not remove the API from the load balancer.',
  })
  @ApiOkResponse({ description: 'Dependency status per subsystem.' })
  async ready(): Promise<{ status: string; checks: Record<string, boolean> }> {
    const database = await this.prisma.ping();
    return {
      status: database ? 'ok' : 'degraded',
      checks: { database },
    };
  }

  @Get('outbox')
  @ApiOperation({
    summary: 'Outbox backlog — a workload gauge, never a readiness signal.',
    description:
      'Read from PostgreSQL rather than Redis, so the figures stay correct ' +
      'even after a Redis flush. Always returns 200: inspect `dead` and ' +
      '`staleLeases` for conditions that want a human.',
  })
  @ApiOkResponse({ description: 'Outbox counts and since-boot counters.' })
  async outbox(): Promise<OutboxBacklog> {
    return await this.outboxMetrics.backlog();
  }
}
