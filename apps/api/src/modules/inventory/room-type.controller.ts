/**
 * Room-type configuration endpoints.
 *
 * A separate controller from `InventoryController` rather than more routes on
 * it: these address a different resource, and the inventory controller owns
 * the calendar's extent. `SessionAuthGuard` only, deliberately not
 * `ActivePropertyGuard` -- these routes are addressed by `:hotelId`, the
 * operator-facing property code, while that guard resolves a uuid. The grant
 * is resolved in the service through `grantedPropertyWhere`, as every other
 * `:hotelId` route in this API does.
 *
 * Permissions:
 *   GET   -> RESERVATIONS_READ  (knowing what the hotel sells is a read)
 *   POST  -> ROOMS_MANAGE
 *   PATCH -> ROOMS_MANAGE
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  createRoomTypeRequestSchema,
  updateRoomTypeRequestSchema,
  type CreateRoomTypeRequest,
  type RoomTypeListResponse,
  type RoomTypeView,
  type UpdateRoomTypeRequest,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RetirementService } from './retirement.service.js';
import { RoomTypeService } from './room-type.service.js';

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class RoomTypeController {
  constructor(
    private readonly roomTypes: RoomTypeService,
    private readonly retirement: RetirementService,
  ) {}

  @Get(':hotelId/room-types')
  @ApiOperation({
    summary: 'The categories this property sells',
    description:
      'Includes a live `roomCount` from the room table. That can legitimately ' +
      'differ from the calendar’s configured `physical`, which is computed when ' +
      'an inventory row is created and never recomputed — a room added today ' +
      'does not change capacity on nights that already exist.',
  })
  @ApiOkResponse({ description: 'Every room type, by sort order then code.' })
  @ApiNotFoundResponse({ description: 'No such property, or no grant at it.' })
  @ApiForbiddenResponse({ description: 'A grant without reservations:read.' })
  list(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
  ): Promise<RoomTypeListResponse> {
    return this.roomTypes.list(this.userId(request), hotelId);
  }

  @Post(':hotelId/room-types')
  @ApiOperation({
    summary: 'Create a room type',
    description:
      'Creates a sellable category. It has no availability calendar until the ' +
      'inventory horizon is extended — generation is operator-triggered and ' +
      'is the only writer of `physical`. Overbooking allowance is not settable ' +
      'here: per-date allowance is the authoritative value and is changed ' +
      'through the inventory allowance endpoint under inventory:override.',
  })
  @ApiCreatedResponse({ description: 'The created room type.' })
  @ApiNotFoundResponse({ description: 'No such property, or no grant at it.' })
  @ApiForbiddenResponse({ description: 'A grant without rooms:manage.' })
  @ApiConflictResponse({ description: 'That code or name is already in use here.' })
  create(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(createRoomTypeRequestSchema))
    body: CreateRoomTypeRequest,
  ): Promise<RoomTypeView> {
    return this.roomTypes.create(this.userId(request), hotelId, body);
  }

  @Patch(':hotelId/room-types/:roomTypeId')
  @ApiOperation({
    summary: 'Edit a room type',
    description:
      '`code` is not editable: it is the operator-facing identity quoted in ' +
      'reports, on the timeline and in channel mappings, so renaming it would ' +
      'orphan those references. Occupancy limits are validated against the ' +
      'merged state, so lowering the guest limit alone cannot leave a higher ' +
      'adult limit behind.',
  })
  @ApiOkResponse({ description: 'The updated room type.' })
  @ApiNotFoundResponse({ description: 'No such property or room type, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rooms:manage.' })
  @ApiConflictResponse({ description: 'That name is already in use here.' })
  update(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('roomTypeId') roomTypeId: string,
    @Body(new ZodValidationPipe(updateRoomTypeRequestSchema))
    body: UpdateRoomTypeRequest,
  ): Promise<RoomTypeView> {
    return this.roomTypes.update(this.userId(request), hotelId, roomTypeId, body);
  }

  @Post(':hotelId/room-types/:roomTypeId/retire')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stop selling a category permanently',
    description:
      'Refused (409) while any room of the type is in service, or the category ' +
      'has a current or future stay or an active block. Idempotent; never undone.',
  })
  @ApiOkResponse({ description: 'The retired room type.' })
  @ApiNotFoundResponse({ description: 'No such property or room type, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rooms:manage.' })
  @ApiConflictResponse({ description: 'The category is still in use, or a concurrent change.' })
  retire(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('roomTypeId') roomTypeId: string,
  ): Promise<RoomTypeView> {
    return this.retirement.retireRoomType(this.userId(request), hotelId, roomTypeId);
  }

  /** Unreachable while `SessionAuthGuard` is attached; asserted so that
   *  detaching it fails closed rather than reading a property of `undefined`. */
  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
