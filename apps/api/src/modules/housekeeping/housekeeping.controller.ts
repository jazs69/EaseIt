/**
 * Housekeeping over HTTP (HK-01 .. HK-04). `SessionAuthGuard` with the grant
 * and permission checks in the service, because the hotel is named in the
 * path (section 3.2). Another property's task or room is 404, never 403.
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  assignHousekeepingTaskSchema,
  completeHousekeepingTaskSchema,
  createHousekeepingTaskSchema,
  listHousekeepingTasksQuerySchema,
  recordInspectionSchema,
  type AssignHousekeepingTaskCommand,
  type CompleteHousekeepingTaskCommand,
  type CreateHousekeepingTaskCommand,
  type HousekeepingBoard,
  type HousekeepingTaskView,
  type ListHousekeepingTasksQuery,
  type QueueCleaningResult,
  type RecordInspectionCommand,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { HousekeepingService } from './housekeeping.service.js';

@ApiTags('housekeeping')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class HousekeepingController {
  constructor(private readonly housekeeping: HousekeepingService) {}

  @Get(':hotelId/housekeeping/board')
  @ApiOperation({ summary: 'Every room: status, occupancy, arrivals/departures today, open tasks (HK-02)' })
  @ApiOkResponse({ description: 'The board.' })
  @ApiForbiddenResponse({ description: 'Requires housekeeping:read.' })
  board(@Req() request: FastifyRequest, @Param('hotelId') hotelId: string): Promise<HousekeepingBoard> {
    return this.housekeeping.board(this.userId(request), hotelId);
  }

  @Get(':hotelId/housekeeping/tasks')
  @ApiOperation({ summary: 'Tasks; open and in progress unless a status is given' })
  tasks(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Query(new ZodValidationPipe(listHousekeepingTasksQuerySchema)) query: ListHousekeepingTasksQuery,
  ): Promise<HousekeepingTaskView[]> {
    return this.housekeeping.listTasks(this.userId(request), hotelId, query);
  }

  @Post(':hotelId/housekeeping/tasks')
  @ApiOperation({ summary: 'Create a task on a room (housekeeping:manage). One active task per room and type.' })
  create(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(createHousekeepingTaskSchema)) body: CreateHousekeepingTaskCommand,
  ): Promise<HousekeepingTaskView> {
    return this.housekeeping.createTask(this.userId(request), hotelId, body);
  }

  @Post(':hotelId/housekeeping/tasks/queue-cleaning')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Queue a cleaning task for every dirty room without one (housekeeping:manage)' })
  queueCleaning(@Req() request: FastifyRequest, @Param('hotelId') hotelId: string): Promise<QueueCleaningResult> {
    return this.housekeeping.queueCleaning(this.userId(request), hotelId);
  }

  @Post(':hotelId/housekeeping/tasks/:taskId/assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign or unassign (housekeeping:manage)' })
  @ApiNotFoundResponse({ description: 'No such task at this property.' })
  assign(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body(new ZodValidationPipe(assignHousekeepingTaskSchema)) body: AssignHousekeepingTaskCommand,
  ): Promise<HousekeepingTaskView> {
    return this.housekeeping.assign(this.userId(request), hotelId, taskId, body);
  }

  @Post(':hotelId/housekeeping/tasks/:taskId/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start one’s own task; an unassigned task is claimed' })
  start(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ): Promise<HousekeepingTaskView> {
    return this.housekeeping.start(this.userId(request), hotelId, taskId);
  }

  @Post(':hotelId/housekeeping/tasks/:taskId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Finish a cleaning or turndown; a finished cleaning makes a dirty room clean' })
  complete(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body(new ZodValidationPipe(completeHousekeepingTaskSchema)) body: CompleteHousekeepingTaskCommand,
  ): Promise<HousekeepingTaskView> {
    return this.housekeeping.complete(this.userId(request), hotelId, taskId, body);
  }

  @Post(':hotelId/housekeeping/tasks/:taskId/inspect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record an inspection (housekeeping:manage, HK-04)',
    description: 'PASSED: a clean vacant room becomes INSPECTED. FAILED: back to VACANT_DIRTY with a re-clean task.',
  })
  inspect(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body(new ZodValidationPipe(recordInspectionSchema)) body: RecordInspectionCommand,
  ): Promise<HousekeepingTaskView> {
    return this.housekeeping.inspect(this.userId(request), hotelId, taskId, body);
  }

  @Post(':hotelId/housekeeping/tasks/:taskId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an open task (housekeeping:manage)' })
  cancel(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ): Promise<HousekeepingTaskView> {
    return this.housekeeping.cancel(this.userId(request), hotelId, taskId);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
