/**
 * Reusable guest profile endpoints (GP-02).
 *
 * `SessionAuthGuard` only, like every `:hotelId` route: grant and permission
 * checks are per-property and live in the service (section 3.2).
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  createGuestProfileSchema,
  linkGuestStaySchema,
  listGuestProfilesQuerySchema,
  updateGuestProfileSchema,
  type CreateGuestProfileCommand,
  type GuestProfileDetail,
  type GuestProfilePage,
  type LinkGuestStayCommand,
  type ListGuestProfilesQuery,
  type UpdateGuestProfileCommand,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { GuestsService } from './guests.service.js';

@ApiTags('guests')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class GuestsController {
  constructor(private readonly guests: GuestsService) {}

  @Get(':hotelId/guests')
  @ApiOperation({ summary: 'Search guest profiles by name, email or phone (cursor-paged)' })
  @ApiOkResponse({ description: 'A page of profiles.' })
  @ApiForbiddenResponse({ description: 'No reservations:read here.' })
  @ApiNotFoundResponse({ description: 'No such property for this caller.' })
  list(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Query(new ZodValidationPipe(listGuestProfilesQuerySchema)) query: ListGuestProfilesQuery,
  ): Promise<GuestProfilePage> {
    return this.guests.list(this.userId(request), hotelId, query);
  }

  @Post(':hotelId/guests')
  @ApiOperation({ summary: 'Create a guest profile (requires reservations:edit)' })
  create(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(createGuestProfileSchema)) body: CreateGuestProfileCommand,
  ): Promise<GuestProfileDetail> {
    return this.guests.create(this.userId(request), hotelId, body);
  }

  @Get(':hotelId/guests/:guestId')
  @ApiOperation({
    summary: 'A profile with its stays, suggested stays and possible duplicates',
    description:
      'Suggestions share a normalised email or phone. They are offered for ' +
      'linking and never applied automatically.',
  })
  @ApiNotFoundResponse({ description: 'No such profile at this property.' })
  detail(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('guestId') guestId: string,
  ): Promise<GuestProfileDetail> {
    return this.guests.detail(this.userId(request), hotelId, guestId);
  }

  @Patch(':hotelId/guests/:guestId')
  @ApiOperation({ summary: 'Edit a profile (requires reservations:edit)' })
  update(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('guestId') guestId: string,
    @Body(new ZodValidationPipe(updateGuestProfileSchema)) body: UpdateGuestProfileCommand,
  ): Promise<GuestProfileDetail> {
    return this.guests.update(this.userId(request), hotelId, guestId, body);
  }

  @Post(':hotelId/guests/:guestId/stays')
  @ApiOperation({ summary: "Link a booking's guest row to this profile" })
  link(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('guestId') guestId: string,
    @Body(new ZodValidationPipe(linkGuestStaySchema)) body: LinkGuestStayCommand,
  ): Promise<GuestProfileDetail> {
    return this.guests.link(this.userId(request), hotelId, guestId, body);
  }

  @Delete(':hotelId/guests/:guestId/stays/:reservationGuestId')
  @ApiOperation({ summary: 'Unlink a guest row from this profile' })
  unlink(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('guestId') guestId: string,
    @Param('reservationGuestId') reservationGuestId: string,
  ): Promise<GuestProfileDetail> {
    return this.guests.unlink(this.userId(request), hotelId, guestId, reservationGuestId);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
