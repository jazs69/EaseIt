/**
 * Property reports endpoint, JSON or CSV.
 *
 * `SessionAuthGuard` only, matching the other `:hotelId` routes. The grant
 * check and the `financial_reports:read` check both live in the service,
 * because both are per-property: a clerk may read reports at one hotel and not
 * another, and a guard resolving "the session's active property" would answer
 * for the wrong one (CLAUDE.md section 3.2).
 */

import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  reportQuerySchema,
  reportTypeSchema,
  type ReportQuery,
  type ReportResponse,
} from '@repo/types';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import {
  UnauthenticatedError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { toCsv } from './report-csv.js';
import { ReportsService } from './reports.service.js';

const UTF8_FILENAME = "filename*=UTF-8''";

@ApiTags('reports')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get(':hotelId/reports/:reportType')
  @ApiOperation({
    summary: 'Run a property report as JSON or CSV',
    description:
      'Requires financial_reports:read at the property, which a grant alone ' +
      'does not imply - housekeeping is read-only on financials. Reports ' +
      'whose underlying data has no source refuse rather than returning zeros.',
  })
  @ApiOkResponse({ description: 'The report, or a CSV attachment.' })
  @ApiForbiddenResponse({ description: 'No financial reporting permission here.' })
  @ApiNotFoundResponse({
    description: 'No such property for this caller, or the report is not built.',
  })
  async run(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('hotelId') hotelId: string,
    @Param('reportType') reportType: string,
    @Query(new ZodValidationPipe(reportQuerySchema)) query: ReportQuery,
  ): Promise<ReportResponse | string> {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) {
      throw new UnauthenticatedError();
    }

    // Validated here rather than by a param pipe, so an unknown report type is
    // a clean domain error rather than a route that silently fails to match.
    const parsed = reportTypeSchema.safeParse(reportType);
    if (!parsed.success) {
      throw new ValidationFailedError({ reportType: 'Unknown report type.' });
    }

    const report = await this.reports.run(user.userId, hotelId, parsed.data, query);

    if (query.format === 'csv') {
      const filename = `${report.type}-${report.startDate}-to-${report.endDate}.csv`;
      void reply.header('content-type', 'text/csv; charset=utf-8');
      // Both forms of the filename: the plain one is ASCII-only, so a property
      // name or date with anything outside it would be mangled by the
      // browser's download dialog without the UTF-8 variant beside it.
      void reply.header(
        'content-disposition',
        `attachment; filename="${filename}"; ${UTF8_FILENAME}${encodeURIComponent(filename)}`,
      );
      return toCsv(report);
    }

    return report;
  }
}
