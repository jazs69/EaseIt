/**
 * Invoices (FO-14).
 *
 * `SessionAuthGuard` only; the grant and permission checks are in the
 * service, against the route's own hotelId (section 3.2), as for folios.
 * Issuing needs `folio:settle`, reading and downloading `folio:read`.
 */

import { Controller, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Invoice } from '@repo/types';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { renderInvoiceCsv, renderInvoicePdf } from './invoice-document.js';
import { InvoicesService } from './invoices.service.js';

/** A download name built only from characters every filesystem accepts. */
function fileName(invoice: Invoice, extension: string): string {
  return `${invoice.number.replace(/[^A-Za-z0-9_-]/g, '_')}.${extension}`;
}

@ApiTags('invoices')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post(':hotelId/folios/:folioId/invoice')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Issue the invoice for a closed folio',
    description:
      'Numbered per property and financial year, without gaps, and frozen as issued. ' +
      'Only a closed folio (settled at zero) can be invoiced. Issuing again returns ' +
      'the same invoice.',
  })
  @ApiOkResponse({ description: 'The invoice.' })
  @ApiBadRequestResponse({ description: 'The folio is not closed.' })
  @ApiForbiddenResponse({ description: 'Requires folio:settle.' })
  @ApiNotFoundResponse({ description: 'No such folio at this property.' })
  issue(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('folioId') folioId: string,
  ): Promise<Invoice> {
    return this.invoices.issue(this.userId(request), hotelId, folioId);
  }

  @Get(':hotelId/invoices/:invoiceId')
  @ApiOperation({ summary: 'One invoice, as issued' })
  @ApiOkResponse({ description: 'The invoice.' })
  @ApiForbiddenResponse({ description: 'Requires folio:read.' })
  @ApiNotFoundResponse({ description: 'No such invoice at this property.' })
  get(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('invoiceId') invoiceId: string,
  ): Promise<Invoice> {
    return this.invoices.get(this.userId(request), hotelId, invoiceId);
  }

  @Get(':hotelId/invoices/:invoiceId/pdf')
  @ApiOperation({ summary: 'The invoice as a PDF' })
  @ApiOkResponse({ description: 'application/pdf' })
  async pdf(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('hotelId') hotelId: string,
    @Param('invoiceId') invoiceId: string,
  ): Promise<Buffer> {
    const invoice = await this.invoices.get(this.userId(request), hotelId, invoiceId);
    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', `attachment; filename="${fileName(invoice, 'pdf')}"`);
    reply.header('cache-control', 'private, no-store');
    return renderInvoicePdf(invoice);
  }

  @Get(':hotelId/invoices/:invoiceId/csv')
  @ApiOperation({ summary: 'The invoice as CSV' })
  @ApiOkResponse({ description: 'text/csv' })
  async csv(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('hotelId') hotelId: string,
    @Param('invoiceId') invoiceId: string,
  ): Promise<string> {
    const invoice = await this.invoices.get(this.userId(request), hotelId, invoiceId);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${fileName(invoice, 'csv')}"`);
    reply.header('cache-control', 'private, no-store');
    return renderInvoiceCsv(invoice);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
