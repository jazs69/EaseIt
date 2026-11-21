/**
 * The channel manager's staff API (CM-01, CM-02). `SessionAuthGuard` only,
 * like every `:hotelId` route: grant and permission checks are per property,
 * in the service (section 3.2).
 *
 *   channels:read    overview, call log, inbound messages
 *   channels:manage  connect, map, activate, pause, retry or resolve inbound
 *   channels:sync    ask for a push (and a booking fetch) now
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
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
  channelMappingsSchema,
  channelSyncSchema,
  createChannelConnectionSchema,
  listInboundQuerySchema,
  listSyncAttemptsQuerySchema,
  resolveInboundSchema,
  type ChannelConnection,
  type ChannelInboundList,
  type ChannelInboundMessage,
  type ChannelMappingsCommand,
  type ChannelOverview,
  type ChannelSyncAttemptList,
  type ChannelSyncCommand,
  type ChannelSyncResult,
  type CreateChannelConnectionCommand,
  type ListInboundQuery,
  type ListSyncAttemptsQuery,
  type ResolveInboundCommand,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { ChannelsService } from './channels.service.js';

@ApiTags('channels')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get(':hotelId/channels')
  @ApiOperation({ summary: 'Connections, providers, and what can be mapped (channels:read)' })
  @ApiNotFoundResponse({ description: 'No such property for this caller.' })
  overview(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
  ): Promise<ChannelOverview> {
    return this.channels.overview(this.userId(request), hotelId);
  }

  @Post(':hotelId/channels')
  @ApiOperation({ summary: 'Connect the property to a provider, paused (channels:manage)' })
  @ApiForbiddenResponse({ description: 'Missing channels:manage.' })
  create(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(createChannelConnectionSchema))
    body: CreateChannelConnectionCommand,
  ): Promise<ChannelConnection> {
    return this.channels.create(this.userId(request), hotelId, body);
  }

  @Put(':hotelId/channels/:connectionId/mappings')
  @ApiOperation({
    summary: 'Replace the room-type and rate-plan mapping (channels:manage)',
    description: 'On an active connection the whole window is pushed again.',
  })
  setMappings(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('connectionId') connectionId: string,
    @Body(new ZodValidationPipe(channelMappingsSchema)) body: ChannelMappingsCommand,
  ): Promise<ChannelConnection> {
    return this.channels.setMappings(this.userId(request), hotelId, connectionId, body);
  }

  @Post(':hotelId/channels/:connectionId/activate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Switch a connection on; pushes the whole window (channels:manage)' })
  activate(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('connectionId') connectionId: string,
  ): Promise<ChannelConnection> {
    return this.channels.activate(this.userId(request), hotelId, connectionId);
  }

  @Post(':hotelId/channels/:connectionId/pause')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop pushing and pulling (channels:manage)' })
  pause(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('connectionId') connectionId: string,
  ): Promise<ChannelConnection> {
    return this.channels.pause(this.userId(request), hotelId, connectionId);
  }

  @Post(':hotelId/channels/:connectionId/sync')
  @HttpCode(200)
  @ApiOperation({ summary: 'Push now (full: the whole window) and fetch bookings (channels:sync)' })
  sync(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('connectionId') connectionId: string,
    @Body(new ZodValidationPipe(channelSyncSchema)) body: ChannelSyncCommand,
  ): Promise<ChannelSyncResult> {
    return this.channels.sync(this.userId(request), hotelId, connectionId, body);
  }

  @Get(':hotelId/channels/:connectionId/attempts')
  @ApiOperation({ summary: 'Every provider call, newest first (channels:read)' })
  attempts(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('connectionId') connectionId: string,
    @Query(new ZodValidationPipe(listSyncAttemptsQuerySchema)) query: ListSyncAttemptsQuery,
  ): Promise<ChannelSyncAttemptList> {
    return this.channels.attempts(this.userId(request), hotelId, connectionId, query);
  }

  @Get(':hotelId/channels/:connectionId/inbound')
  @ApiOperation({
    summary: 'Inbound OTA messages; those needing attention by default (channels:read)',
  })
  inbound(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('connectionId') connectionId: string,
    @Query(new ZodValidationPipe(listInboundQuerySchema)) query: ListInboundQuery,
  ): Promise<ChannelInboundList> {
    return this.channels.inbound(this.userId(request), hotelId, connectionId, query);
  }

  @Post(':hotelId/channels/:connectionId/inbound/:messageId/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Apply an inbound message again (channels:manage)' })
  retry(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('connectionId') connectionId: string,
    @Param('messageId') messageId: string,
  ): Promise<ChannelInboundMessage> {
    return this.channels.retryInbound(this.userId(request), hotelId, connectionId, messageId);
  }

  @Post(':hotelId/channels/:connectionId/inbound/:messageId/resolve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Record that an inbound message was dealt with by hand (channels:manage)',
  })
  resolve(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('connectionId') connectionId: string,
    @Param('messageId') messageId: string,
    @Body(new ZodValidationPipe(resolveInboundSchema)) body: ResolveInboundCommand,
  ): Promise<ChannelInboundMessage> {
    return this.channels.resolveInbound(
      this.userId(request),
      hotelId,
      connectionId,
      messageId,
      body,
    );
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
