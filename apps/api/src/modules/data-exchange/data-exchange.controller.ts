/**
 * IE-01 import and IE-02 export endpoints.
 *
 *   POST /properties/:hotelId/import                 DRY_RUN or COMMIT (rooms:manage / rates:manage)
 *   GET  /properties/:hotelId/export/:dataset        CSV download (data:export)
 *
 * The export's content type and filename are set only after the service has
 * authorised and built the file, so a refusal still renders as the uniform
 * JSON error (the lesson of the metrics endpoint, OB-05).
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  exportDatasetSchema,
  exportQuerySchema,
  importRequestSchema,
  type ExportDataset,
  type ExportQuery,
  type ImportRequest,
  type ImportResult,
} from '@repo/types';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { ExportService } from './export.service.js';
import { ImportService } from './import.service.js';

@ApiTags('data-exchange')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class DataExchangeController {
  constructor(
    private readonly imports: ImportService,
    private readonly exports: ExportService,
  ) {}

  @Post(':hotelId/import')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Import room types, rooms and rates from CSV: DRY_RUN validates and rolls back; COMMIT writes all or nothing',
  })
  @ApiNotFoundResponse({ description: 'No such property for this caller.' })
  @ApiForbiddenResponse({ description: 'Missing rooms:manage or rates:manage.' })
  import(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(importRequestSchema)) body: ImportRequest,
  ): Promise<ImportResult> {
    return this.imports.run(this.userId(request), hotelId, body);
  }

  @Get(':hotelId/export/:dataset')
  @ApiOperation({ summary: 'Download one dataset as CSV (data:export); every export is audited' })
  @ApiNotFoundResponse({ description: 'No such property for this caller.' })
  @ApiForbiddenResponse({ description: 'Missing data:export.' })
  async export(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('hotelId') hotelId: string,
    @Param('dataset', new ZodValidationPipe(exportDatasetSchema)) dataset: ExportDataset,
    @Query(new ZodValidationPipe(exportQuerySchema)) query: ExportQuery,
  ): Promise<string> {
    const file = await this.exports.export(this.userId(request), hotelId, dataset, query);
    void reply.header('content-type', 'text/csv; charset=utf-8');
    void reply.header(
      'content-disposition',
      `attachment; filename="${file.filename.replace(/[^\w.-]/g, '_')}"`,
    );
    void reply.header('cache-control', 'no-store');
    return file.csv;
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
