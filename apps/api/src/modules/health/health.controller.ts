import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PrismaService } from '../../prisma/prisma.service.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness probe — does the process answer?' })
  @ApiOkResponse({ description: 'The API process is up.' })
  live(): { status: string; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — are dependencies reachable?' })
  @ApiOkResponse({ description: 'Dependency status per subsystem.' })
  async ready(): Promise<{ status: string; checks: Record<string, boolean> }> {
    const database = await this.prisma.ping();
    return {
      status: database ? 'ok' : 'degraded',
      checks: { database },
    };
  }
}
