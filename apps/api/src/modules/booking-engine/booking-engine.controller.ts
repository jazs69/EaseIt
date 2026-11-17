/**
 * The public booking engine's HTTP surface (BE-01). No session: a guest is
 * not a user. Every route resolves `:slug` server-side (`PublicPropertyGuard`,
 * BE-05) before the handler runs, and is throttled per client address.
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
  UseGuards,
} from '@nestjs/common';
import { ApiNotFoundResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  availabilityQuerySchema,
  bookingAccessQuerySchema,
  publicBookRequestSchema,
  publicQuoteRequestSchema,
  type AvailabilityQuery,
  type AvailabilityResponse,
  type BookingAccessQuery,
  type BookingEngineProperty,
  type PublicBookRequest,
  type PublicBooking,
  type PublicQuote,
  type PublicQuoteRequest,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { BookingEngineService } from './booking-engine.service.js';
import { PublicPropertyGuard, publicProperty } from './public-property.guard.js';

@ApiTags('booking-engine (public)')
@Controller('public/properties/:slug')
@UseGuards(PublicPropertyGuard)
export class BookingEngineController {
  constructor(private readonly engine: BookingEngineService) {}

  @Get()
  @ApiOperation({ summary: 'The hotel, its room categories, and whether it takes online payment' })
  @ApiNotFoundResponse({ description: 'No bookable property with that slug.' })
  profile(@Req() request: FastifyRequest): Promise<BookingEngineProperty> {
    return this.engine.profile(publicProperty(request));
  }

  @Get('availability')
  @ApiOperation({ summary: 'Sellable categories for the stay, priced (advisory, cached 30 s)' })
  availability(
    @Req() request: FastifyRequest,
    @Query(new ZodValidationPipe(availabilityQuerySchema)) query: AvailabilityQuery,
  ): Promise<AvailabilityResponse> {
    return this.engine.search(publicProperty(request), query, request.ip);
  }

  @Post('quotes')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Price a stay and hold the price for 15 minutes (the room is not held)',
  })
  quote(
    @Req() request: FastifyRequest,
    @Body(new ZodValidationPipe(publicQuoteRequestSchema)) body: PublicQuoteRequest,
  ): Promise<PublicQuote> {
    return this.engine.quote(publicProperty(request), body, request.ip);
  }

  @Post('bookings')
  @ApiOperation({
    summary: 'Book a held quote: transactional, oversell-safe, one booking per quote',
  })
  book(
    @Req() request: FastifyRequest,
    @Body(new ZodValidationPipe(publicBookRequestSchema)) body: PublicBookRequest,
  ): Promise<PublicBooking> {
    return this.engine.book(publicProperty(request), body, request.ip);
  }

  @Get('bookings/:code')
  @ApiOperation({ summary: "A guest's own booking (needs its access token)" })
  read(
    @Req() request: FastifyRequest,
    @Param('code') code: string,
    @Query(new ZodValidationPipe(bookingAccessQuerySchema)) query: BookingAccessQuery,
  ): Promise<PublicBooking> {
    return this.engine.read(publicProperty(request), code, query.access);
  }

  @Post('bookings/:code/pay')
  @HttpCode(200)
  @ApiOperation({ summary: 'A Razorpay payment link for the balance (needs the access token)' })
  pay(
    @Req() request: FastifyRequest,
    @Param('code') code: string,
    @Query(new ZodValidationPipe(bookingAccessQuerySchema)) query: BookingAccessQuery,
  ): Promise<PublicBooking> {
    return this.engine.pay(publicProperty(request), code, query.access, request.ip);
  }
}
