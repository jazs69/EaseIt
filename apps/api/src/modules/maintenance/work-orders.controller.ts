/**
 * Maintenance work orders (MA-01).
 *
 * `SessionAuthGuard` only, like every `:hotelId` route: the grant and
 * permission checks are per-property and live in the service (section 3.2).
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
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  assignWorkOrderSchema,
  closeWorkOrderSchema,
  createWorkOrderSchema,
  listWorkOrdersQuerySchema,
  outOfOrderRangeSchema,
  type AssignWorkOrderCommand,
  type CloseWorkOrderCommand,
  type CreateWorkOrderCommand,
  type ListWorkOrdersQuery,
  type OutOfOrderRange,
  type WorkOrder,
  type WorkOrderList,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { WorkOrdersService } from './work-orders.service.js';

@ApiTags('maintenance')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class WorkOrdersController {
  constructor(private readonly orders: WorkOrdersService) {}

  @Get(':hotelId/work-orders')
  @ApiOperation({ summary: 'Work orders (active by default), with the people who can be assigned' })
  @ApiNotFoundResponse({ description: 'No such property for this caller.' })
  list(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Query(new ZodValidationPipe(listWorkOrdersQuerySchema)) query: ListWorkOrdersQuery,
  ): Promise<WorkOrderList> {
    return this.orders.list(this.userId(request), hotelId, query);
  }

  @Post(':hotelId/work-orders')
  @ApiOperation({
    summary: 'Report a fault on a room (housekeeping:read)',
    description:
      'With outOfOrder, the room is also taken out of order for the range in the same ' +
      'transaction (a MAINTENANCE room block; needs room_blocks:manage). A room holding a ' +
      'stay on those nights is refused with 409.',
  })
  @ApiForbiddenResponse({
    description: 'Missing housekeeping:read, or room_blocks:manage for out of order.',
  })
  @ApiConflictResponse({
    description: 'The room is occupied, already blocked, or has no inventory.',
  })
  create(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(createWorkOrderSchema)) body: CreateWorkOrderCommand,
  ): Promise<WorkOrder> {
    return this.orders.create(this.userId(request), hotelId, body);
  }

  @Post(':hotelId/work-orders/:orderId/out-of-order')
  @HttpCode(200)
  @ApiOperation({
    summary: "Take an active order's room out of order (maintenance:manage + room_blocks:manage)",
  })
  outOfOrder(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(outOfOrderRangeSchema)) body: OutOfOrderRange,
  ): Promise<WorkOrder> {
    return this.orders.takeOutOfOrder(this.userId(request), hotelId, orderId, body);
  }

  @Post(':hotelId/work-orders/:orderId/assign')
  @HttpCode(200)
  @ApiOperation({ summary: 'Assign (or unassign) an active order (maintenance:manage)' })
  assign(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(assignWorkOrderSchema)) body: AssignWorkOrderCommand,
  ): Promise<WorkOrder> {
    return this.orders.assign(this.userId(request), hotelId, orderId, body);
  }

  @Post(':hotelId/work-orders/:orderId/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark an order in progress (maintenance:manage)' })
  start(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('orderId') orderId: string,
  ): Promise<WorkOrder> {
    return this.orders.start(this.userId(request), hotelId, orderId);
  }

  @Post(':hotelId/work-orders/:orderId/resolve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Resolve an order and give the room back from the business date (maintenance:manage)',
  })
  resolve(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(closeWorkOrderSchema)) body: CloseWorkOrderCommand,
  ): Promise<WorkOrder> {
    return this.orders.resolve(this.userId(request), hotelId, orderId, body);
  }

  @Post(':hotelId/work-orders/:orderId/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel an order; the room is given back as on resolve (maintenance:manage)',
  })
  cancel(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(closeWorkOrderSchema)) body: CloseWorkOrderCommand,
  ): Promise<WorkOrder> {
    return this.orders.cancel(this.userId(request), hotelId, orderId, body);
  }

  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
