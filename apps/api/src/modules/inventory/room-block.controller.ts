/**
 * Room blocks over HTTP. No business logic: validation by schema, everything
 * else in `RoomBlockService`.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
  createRoomBlockRequestSchema,
  roomBlockListQuerySchema,
  type CreateRoomBlockRequest,
  type RoomBlockListQuery,
  type RoomBlockListResponse,
  type RoomBlockView,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RoomBlockService } from './room-block.service.js';

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class RoomBlockController {
  constructor(private readonly blocks: RoomBlockService) {}

  @Get(':hotelId/room-blocks')
  @ApiOperation({ summary: 'List room blocks, newest first' })
  @ApiOkResponse({ description: 'One page of blocks, plus a cursor when more remain.' })
  @ApiNotFoundResponse({ description: 'No such property, or no grant at it.' })
  @ApiForbiddenResponse({ description: 'A grant without reservations:read.' })
  list(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Query(new ZodValidationPipe(roomBlockListQuerySchema)) query: RoomBlockListQuery,
  ): Promise<RoomBlockListResponse> {
    return this.blocks.list(this.userId(request), hotelId, query);
  }

  @Get(':hotelId/room-blocks/:blockId')
  @ApiOperation({ summary: 'One room block' })
  @ApiOkResponse({ description: 'The block.' })
  @ApiNotFoundResponse({ description: 'No such property or block, or no grant.' })
  get(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('blockId') blockId: string,
  ): Promise<RoomBlockView> {
    return this.blocks.get(this.userId(request), hotelId, blockId);
  }

  @Post(':hotelId/room-blocks')
  @ApiOperation({
    summary: 'Withhold rooms from sale for a date range',
    description:
      '`throughDate` is INCLUSIVE: 10th to 15th blocks six nights. Supply ' +
      '`roomId` to block one named room, or `rooms` to withhold a count of the ' +
      'category. Each night must have that many genuinely unsold rooms; a block ' +
      'never consumes the overbooking allowance.',
  })
  @ApiCreatedResponse({ description: 'The created block.' })
  @ApiNotFoundResponse({ description: 'No such property, room type or room, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without room_blocks:manage.' })
  @ApiConflictResponse({
    description:
      'Not enough unsold rooms, the room is already blocked or has a stay, the ' +
      'calendar does not cover these nights, or a concurrent change (try again).',
  })
  create(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(createRoomBlockRequestSchema)) body: CreateRoomBlockRequest,
  ): Promise<RoomBlockView> {
    return this.blocks.create(this.userId(request), hotelId, body);
  }

  @Post(':hotelId/room-blocks/:blockId/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Release a block and return its rooms to sale',
    description: 'Idempotent: releasing an already-released block changes nothing.',
  })
  @ApiOkResponse({ description: 'The released block.' })
  @ApiNotFoundResponse({ description: 'No such property or block, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without room_blocks:manage.' })
  @ApiConflictResponse({ description: 'A concurrent change (try again).' })
  release(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('blockId') blockId: string,
  ): Promise<RoomBlockView> {
    return this.blocks.release(this.userId(request), hotelId, blockId);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
