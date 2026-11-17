/**
 * The audit log over HTTP (AD-03). Read-only: nothing here writes, and no
 * endpoint exists to edit or delete an audit row.
 */

import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  listAuditLogQuerySchema,
  type AuditLogFacets,
  type AuditLogPage,
  type ListAuditLogQuery,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AuditLogService } from './audit-log.service.js';

@ApiTags('audit-log')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get(':hotelId/audit-log')
  @ApiOperation({
    summary:
      'Audit entries, newest first, filtered by actor, entity, event and property-local date (AD-03)',
  })
  @ApiOkResponse({ description: '`{ items, nextCursor, timeZone }`.' })
  @ApiForbiddenResponse({ description: 'Requires audit_log:read.' })
  @ApiNotFoundResponse({ description: 'No grant at this property.' })
  list(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Query(new ZodValidationPipe(listAuditLogQuerySchema)) query: ListAuditLogQuery,
  ): Promise<AuditLogPage> {
    return this.auditLog.list(this.userId(request), hotelId, query);
  }

  @Get(':hotelId/audit-log/facets')
  @ApiOperation({
    summary: 'The actors, entity types and events that occur in this property’s audit log',
  })
  @ApiForbiddenResponse({ description: 'Requires audit_log:read.' })
  facets(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
  ): Promise<AuditLogFacets> {
    return this.auditLog.facets(this.userId(request), hotelId);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
