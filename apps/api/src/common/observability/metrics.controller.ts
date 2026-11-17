/**
 * `GET /api/v1/metrics`: Prometheus text exposition (OB-05).
 *
 * Not behind a session: a scraper is not a user. In production it requires
 * `Authorization: Bearer <METRICS_TOKEN>` (the env schema refuses production
 * without one); outside production an unset token leaves it open for local
 * inspection. Compared in constant time. Excluded from the API reference.
 *
 * `@CrossProperty`, like the health endpoint's outbox gauge: the backlog is a
 * portfolio-wide count read through the logged bypass (CLAUDE.md 3.2), and
 * without it the tenant client refuses the unscoped read.
 *
 * The content type is set on success only. Declared with `@Header`, it also
 * applied to the 401's JSON error body, which Fastify then refused to send,
 * turning every refusal into a 500 (found by observability.test.mjs).
 */

import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { UnauthenticatedError } from '../errors/domain-error.js';
import { CrossProperty } from '../tenancy/cross-property.decorator.js';
import { MetricsService } from './metrics.service.js';

@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  @CrossProperty('portfolio-wide metrics scrape (outbox backlog gauge)')
  @Get()
  async scrape(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const token = this.config.get<string>('METRICS_TOKEN');
    if (token !== undefined) {
      const header = request.headers.authorization ?? '';
      const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
      const expected = Buffer.from(token);
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        throw new UnauthenticatedError();
      }
    }
    const body = await this.metrics.render();
    void reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    void reply.header('cache-control', 'no-store');
    return body;
  }
}
