/**
 * `GET /api/v1/metrics`: Prometheus text exposition (OB-05).
 *
 * Not behind a session: a scraper is not a user. In production it requires
 * `Authorization: Bearer <METRICS_TOKEN>` (the env schema refuses production
 * without one); outside production an unset token leaves it open for local
 * inspection. Compared in constant time. Excluded from the API reference.
 */

import { Controller, Get, Header, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

import { UnauthenticatedError } from '../errors/domain-error.js';
import { MetricsService } from './metrics.service.js';

@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('cache-control', 'no-store')
  scrape(@Req() request: FastifyRequest): Promise<string> {
    const token = this.config.get<string>('METRICS_TOKEN');
    if (token !== undefined) {
      const header = request.headers.authorization ?? '';
      const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
      const expected = Buffer.from(token);
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        throw new UnauthenticatedError();
      }
    }
    return this.metrics.render();
  }
}
