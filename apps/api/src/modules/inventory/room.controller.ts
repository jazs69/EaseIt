/**
 * Physical-room endpoints.
 *
 * `SessionAuthGuard` only, deliberately not `ActivePropertyGuard`: these
 * routes are addressed by `:hotelId`, the operator-facing property code, while
 * that guard resolves a uuid. The grant is resolved in the service through
 * `grantedPropertyWhere`, as every other `:hotelId` route does.
 *
 * Permissions:
 *   GET    -> RESERVATIONS_READ
 *   POST   -> ROOMS_MANAGE
 *   PATCH  -> ROOMS_MANAGE
 *   status -> HOUSEKEEPING_UPDATE_STATUS   (its own route, its own permission)
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
  Query,
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
  changeRoomStatusRequestSchema,
  createRoomRequestSchema,
  rejectedRoomUpdateKeys,
  roomListQuerySchema,
  updateRoomRequestSchema,
  type ChangeRoomStatusRequest,
  type CreateRoomRequest,
  type RoomListQuery,
  type RoomListResponse,
  type RoomView,
  type UpdateRoomRequest,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError, ValidationFailedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RoomService } from './room.service.js';

/**
 * Constructed once, not per request. The update route calls this pipe by hand
 * because it must inspect the raw body first — see the note at its call site.
 */
const UPDATE_ROOM_BODY = new ZodValidationPipe(updateRoomRequestSchema);

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class RoomController {
  constructor(private readonly rooms: RoomService) {}

  @Get(':hotelId/rooms')
  @ApiOperation({
    summary: 'This property’s physical rooms',
    description:
      'Cursor-paginated by room number. Reports configuration and housekeeping ' +
      'status only — it does NOT report whether a room is blocked or available, ' +
      'because room blocks have no read endpoint in this release.',
  })
  @ApiOkResponse({ description: 'One page of rooms, plus a cursor when more remain.' })
  @ApiNotFoundResponse({ description: 'No such property, or no grant at it.' })
  @ApiForbiddenResponse({ description: 'A grant without reservations:read.' })
  list(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Query(new ZodValidationPipe(roomListQuerySchema))
    query: RoomListQuery,
  ): Promise<RoomListResponse> {
    return this.rooms.list(this.userId(request), hotelId, query);
  }

  @Post(':hotelId/rooms')
  @ApiOperation({
    summary: 'Add a physical room',
    description:
      'The room counts towards sellable stock only on inventory dates created ' +
      'AFTER it: `physical` is computed when a night is generated and is never ' +
      'recomputed, so existing nights keep their earlier count. That understates ' +
      'capacity, which can only under-sell, never oversell.',
  })
  @ApiCreatedResponse({ description: 'The created room.' })
  @ApiNotFoundResponse({ description: 'No such property, or no grant at it.' })
  @ApiForbiddenResponse({ description: 'A grant without rooms:manage.' })
  @ApiConflictResponse({ description: 'That room number is already in use here.' })
  create(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(createRoomRequestSchema))
    body: CreateRoomRequest,
  ): Promise<RoomView> {
    return this.rooms.create(this.userId(request), hotelId, body);
  }

  @Patch(':hotelId/rooms/:roomId')
  @ApiOperation({
    summary: 'Edit a room’s configuration',
    description:
      'Number, floor and notes. `status` and `roomTypeId` are REFUSED rather ' +
      'than ignored: status belongs to the room-status endpoint under the ' +
      'housekeeping permission, and changing a room’s category would move ' +
      'capacity between two inventory counters while existing assignments still ' +
      'name the old one, so it is not supported yet.',
  })
  @ApiOkResponse({ description: 'The updated room.' })
  @ApiNotFoundResponse({ description: 'No such property or room, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rooms:manage.' })
  @ApiConflictResponse({ description: 'That room number is already in use here.' })
  update(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('roomId') roomId: string,
    @Body() rawBody: unknown,
  ): Promise<RoomView> {
    // Checked BEFORE the schema runs. Zod strips unknown keys, which would
    // silently discard a `status` the caller believed it had set — so the
    // caller is told where the field actually belongs instead.
    const rejected = rejectedKeys(rawBody);
    if (rejected !== null) throw new ValidationFailedError(rejected);

    /**
     * Validated through the SAME pipe every other body on this controller
     * uses, called directly rather than as a `@Body()` decorator.
     *
     * The decorator cannot be used here: the rejected-key check above needs
     * the RAW body, and a pipe would have stripped `status` and `roomTypeId`
     * before it ran. But calling `schema.parse()` instead meant a plain
     * `ZodError` escaped, and `ZodError` is not a `DomainError` — so every
     * validation failure on this one route came back 500 instead of 400, while
     * its sibling `PATCH /room-types/:roomTypeId` returned 400 correctly.
     *
     * Reusing the pipe rather than re-deriving the issue map keeps one
     * translation from zod issues to `ValidationFailedError`: a second copy
     * would be a second place for the field-path reduction to drift.
     */
    const body: UpdateRoomRequest = UPDATE_ROOM_BODY.transform(rawBody);
    return this.rooms.update(this.userId(request), hotelId, roomId, body);
  }

  @Post(':hotelId/rooms/:roomId/status')
  /**
   * 200, not Nest's default 201: nothing addressable is created. The same
   * reasoning as `inventory/horizon`, `select-context`, `cancel` and
   * `check-out`, all of which declare `HttpStatus.OK`.
   */
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set a room’s housekeeping status',
    description:
      'Five statuses are settable. OUT_OF_ORDER is refused in both directions ' +
      'because it is the only status that changes sellable stock, and ' +
      'OUT_OF_SERVICE is refused as a TARGET because it is counted as stock and ' +
      'stays sellable yet blocks check-in; a room already in that state may ' +
      'still transition out of it. Crossing the occupied/vacant boundary is ' +
      'refused: occupancy is set by check-in, check-out and room move, and is ' +
      'verified here against the live assignment rather than the stored status.',
  })
  @ApiOkResponse({ description: 'The updated room.' })
  @ApiNotFoundResponse({ description: 'No such property or room, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without housekeeping:update_status.' })
  changeStatus(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('roomId') roomId: string,
    @Body(new ZodValidationPipe(changeRoomStatusRequestSchema))
    body: ChangeRoomStatusRequest,
  ): Promise<RoomView> {
    return this.rooms.changeStatus(this.userId(request), hotelId, roomId, body);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}

/** Body keys this endpoint refuses outright, or null when there are none. */
function rejectedKeys(body: unknown): Record<string, string> | null {
  if (typeof body !== 'object' || body === null) return null;

  const issues: Record<string, string> = {};
  for (const [key, reason] of Object.entries(rejectedRoomUpdateKeys)) {
    if (Object.hasOwn(body, key)) issues[key] = reason;
  }

  return Object.keys(issues).length === 0 ? null : issues;
}
