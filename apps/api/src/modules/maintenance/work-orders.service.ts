/**
 * Maintenance work orders (MA-01).
 *
 * ===========================================================================
 * A fault on a room, and, when it needs one, the room taken out of order.
 *
 * - Anyone who can see the housekeeping board (`housekeeping:read`) can report
 *   a fault and read the list.
 * - Assigning, starting, resolving and cancelling need `maintenance:manage`.
 * - Taking the room out of order also needs `room_blocks:manage`, because it
 *   withholds inventory. It is a room block (reason MAINTENANCE), created
 *   through `RoomBlockService.createWithin` in the SAME transaction as the
 *   order, so it gets every rule a block has: inventory rows locked in
 *   ascending order, real unsold capacity, a room holding a stay refused.
 * - Resolving or cancelling gives the room back from the business date
 *   (`restoreFromWithin`); nights already spent out of order stay blocked, so
 *   occupancy history is not rewritten.
 *
 * Lock order: work order row FOR UPDATE, then the block row, then
 * `inventory_day` ascending (the block code's order). Nothing else locks a
 * work order, so the chain cannot invert. Every change writes an audit row in
 * its own transaction. No grant at the property is not found (section 3.2).
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import {
  Permission,
  permissionsForRoles,
  type AssignWorkOrderCommand,
  type BusinessDate,
  type CloseWorkOrderCommand,
  type CreateWorkOrderCommand,
  type ListWorkOrdersQuery,
  type OutOfOrderRange,
  type Role,
  type WorkOrder,
  type WorkOrderList,
  type WorkOrderStatus,
} from '@repo/types';
import { Prisma } from '@repo/database';

import {
  ForbiddenError,
  InvalidStateTransitionError,
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClockService } from '../platform/clock.service.js';
import {
  RoomBlockService,
  type BlockTx,
  type RoomBlockRow,
} from '../inventory/room-block.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE: readonly WorkOrderStatus[] = ['OPEN', 'IN_PROGRESS'];

const ORDER_SELECT = {
  id: true,
  roomId: true,
  title: true,
  description: true,
  priority: true,
  status: true,
  reportedById: true,
  assignedToId: true,
  roomBlockId: true,
  resolutionNote: true,
  closedAt: true,
  createdAt: true,
  room: { select: { number: true, roomType: { select: { name: true } } } },
  roomBlock: { select: { id: true, fromDate: true, throughDate: true, status: true } },
} as const;

type OrderRow = Prisma.WorkOrderGetPayload<{ select: typeof ORDER_SELECT }>;

interface Caller {
  propertyId: string;
  businessDate: string;
  permissions: readonly Permission[];
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Exclusive `throughDate` (as stored) to the inclusive last night. */
function lastNight(throughExclusive: Date): string {
  return iso(new Date(throughExclusive.getTime() - 86_400_000));
}

@Injectable()
export class WorkOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blocks: RoomBlockService,
    private readonly clock: ClockService,
  ) {}

  async list(userId: string, hotelId: string, query: ListWorkOrdersQuery): Promise<WorkOrderList> {
    const caller = await this.authorise(userId, hotelId, Permission.HOUSEKEEPING_READ);
    const status =
      query.status === 'active'
        ? { in: [...ACTIVE] }
        : query.status === 'all'
          ? undefined
          : query.status;
    const [rows, grants] = await Promise.all([
      this.prisma.client.workOrder.findMany({
        where: {
          propertyId: caller.propertyId,
          ...(status === undefined ? {} : { status }),
          ...(query.roomId === undefined ? {} : { roomId: query.roomId }),
        },
        select: ORDER_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: query.limit,
      }),
      this.prisma.client.userPropertyRole.findMany({
        where: { propertyId: caller.propertyId },
        select: { userId: true },
        distinct: ['userId'],
      }),
    ]);
    const names = await this.names([
      ...rows.flatMap((row) => [row.reportedById, row.assignedToId ?? row.reportedById]),
      ...grants.map((grant) => grant.userId),
    ]);
    return {
      items: rows.map((row) => this.toView(row, names)),
      assignees: grants
        .map((grant) => ({ id: grant.userId, name: names.get(grant.userId) ?? 'Unknown user' }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      businessDate: caller.businessDate as BusinessDate,
    };
  }

  async create(
    userId: string,
    hotelId: string,
    command: CreateWorkOrderCommand,
  ): Promise<WorkOrder> {
    const caller = await this.authorise(userId, hotelId, Permission.HOUSEKEEPING_READ);
    if (command.outOfOrder !== null) this.require(caller, Permission.ROOM_BLOCKS_MANAGE);

    const room = await this.prisma.client.room.findFirst({
      where: { id: command.roomId, propertyId: caller.propertyId, retiredAt: null },
      select: { id: true, roomTypeId: true },
    });
    if (room === null) throw new TenantScopeViolationError('Room');

    const prepared =
      command.outOfOrder === null
        ? null
        : await this.blocks.prepareCreate(
            caller.propertyId,
            this.blockRequest(room, command.outOfOrder, command.title),
          );

    const id = await this.blocks.inBlockTransaction(caller.propertyId, 'work order', async (tx) => {
      let block: RoomBlockRow | null = null;
      if (prepared !== null && command.outOfOrder !== null) {
        block = await this.blocks.createWithin(
          tx,
          caller.propertyId,
          userId,
          this.blockRequest(room, command.outOfOrder, command.title),
          prepared,
        );
      }
      const created = await tx.workOrder.create({
        data: {
          propertyId: caller.propertyId,
          roomId: room.id,
          title: command.title,
          description: command.description,
          priority: command.priority,
          reportedById: userId,
          roomBlockId: block?.id ?? null,
        },
        select: { id: true },
      });
      await this.audit(tx, caller.propertyId, userId, created.id, 'WORK_ORDER_CREATED', null, {
        roomId: room.id,
        priority: command.priority,
        outOfOrder:
          command.outOfOrder === null
            ? null
            : { ...command.outOfOrder, blockId: block?.id ?? null },
      });
      return created.id;
    });
    return this.get(caller.propertyId, id);
  }

  /** Take the room of an active order out of order now. */
  async takeOutOfOrder(
    userId: string,
    hotelId: string,
    orderId: string,
    range: OutOfOrderRange,
  ): Promise<WorkOrder> {
    const caller = await this.authorise(userId, hotelId, Permission.MAINTENANCE_MANAGE);
    this.require(caller, Permission.ROOM_BLOCKS_MANAGE);
    const order = await this.find(caller.propertyId, orderId);
    const room = await this.prisma.client.room.findFirst({
      where: { id: order.roomId, propertyId: caller.propertyId },
      select: { id: true, roomTypeId: true },
    });
    if (room === null) throw new TenantScopeViolationError('Room');
    const request = this.blockRequest(room, range, order.title);
    const prepared = await this.blocks.prepareCreate(caller.propertyId, request);

    await this.blocks.inBlockTransaction(
      caller.propertyId,
      'work order out of order',
      async (tx) => {
        const locked = await this.lock(tx, caller.propertyId, orderId);
        if (!ACTIVE.includes(locked.status))
          throw this.closedError(locked.status, 'take out of order');
        if (locked.roomBlockId !== null && locked.blockActive) {
          throw new ValidationFailedError({
            outOfOrder:
              'This room is already out of order for this work order. Resolve it to give the room back.',
          });
        }
        const block = await this.blocks.createWithin(
          tx,
          caller.propertyId,
          userId,
          request,
          prepared,
        );
        await tx.workOrder.update({ where: { id: orderId }, data: { roomBlockId: block.id } });
        await this.audit(tx, caller.propertyId, userId, orderId, 'WORK_ORDER_OUT_OF_ORDER', null, {
          ...range,
          blockId: block.id,
        });
      },
    );
    return this.get(caller.propertyId, orderId);
  }

  async assign(
    userId: string,
    hotelId: string,
    orderId: string,
    command: AssignWorkOrderCommand,
  ): Promise<WorkOrder> {
    const caller = await this.authorise(userId, hotelId, Permission.MAINTENANCE_MANAGE);
    if (command.assignedToId !== null) {
      const grant = await this.prisma.client.userPropertyRole.findFirst({
        where: { propertyId: caller.propertyId, userId: command.assignedToId },
        select: { userId: true },
      });
      if (grant === null) {
        throw new ValidationFailedError({
          assignedToId: 'That person has no access to this property.',
        });
      }
    }
    await this.prisma.client.$transaction(async (tx) => {
      const locked = await this.lock(tx, caller.propertyId, orderId);
      if (!ACTIVE.includes(locked.status)) throw this.closedError(locked.status, 'assign');
      await tx.workOrder.update({
        where: { id: orderId },
        data: { assignedToId: command.assignedToId },
      });
      await this.audit(
        tx,
        caller.propertyId,
        userId,
        orderId,
        'WORK_ORDER_ASSIGNED',
        { assignedToId: locked.assignedToId },
        { assignedToId: command.assignedToId },
      );
    });
    return this.get(caller.propertyId, orderId);
  }

  async start(userId: string, hotelId: string, orderId: string): Promise<WorkOrder> {
    const caller = await this.authorise(userId, hotelId, Permission.MAINTENANCE_MANAGE);
    await this.prisma.client.$transaction(async (tx) => {
      const locked = await this.lock(tx, caller.propertyId, orderId);
      if (locked.status === 'IN_PROGRESS') return;
      if (locked.status !== 'OPEN') throw this.closedError(locked.status, 'start');
      await tx.workOrder.update({ where: { id: orderId }, data: { status: 'IN_PROGRESS' } });
      await this.audit(
        tx,
        caller.propertyId,
        userId,
        orderId,
        'WORK_ORDER_STARTED',
        { status: 'OPEN' },
        {
          status: 'IN_PROGRESS',
        },
      );
    });
    return this.get(caller.propertyId, orderId);
  }

  resolve(
    userId: string,
    hotelId: string,
    orderId: string,
    command: CloseWorkOrderCommand,
  ): Promise<WorkOrder> {
    return this.close(userId, hotelId, orderId, 'RESOLVED', command);
  }

  cancel(
    userId: string,
    hotelId: string,
    orderId: string,
    command: CloseWorkOrderCommand,
  ): Promise<WorkOrder> {
    return this.close(userId, hotelId, orderId, 'CANCELLED', command);
  }

  /* -------------------------------------------------------------------- */

  /**
   * Closes an active order and gives the room back from the business date.
   * Closing it again the same way is an idempotent success that moves no
   * counter; closing a resolved order as cancelled (or the reverse) is
   * refused.
   */
  private async close(
    userId: string,
    hotelId: string,
    orderId: string,
    to: 'RESOLVED' | 'CANCELLED',
    command: CloseWorkOrderCommand,
  ): Promise<WorkOrder> {
    const caller = await this.authorise(userId, hotelId, Permission.MAINTENANCE_MANAGE);
    await this.blocks.inBlockTransaction(caller.propertyId, 'work order close', async (tx) => {
      const locked = await this.lock(tx, caller.propertyId, orderId);
      if (locked.status === to) return;
      if (!ACTIVE.includes(locked.status)) throw this.closedError(locked.status, to.toLowerCase());

      let nightsReleased = 0;
      if (locked.roomBlockId !== null) {
        const restored = await this.blocks.restoreFromWithin(
          tx,
          caller.propertyId,
          userId,
          locked.roomBlockId,
          caller.businessDate,
        );
        nightsReleased = restored.nightsReleased;
      }
      await tx.workOrder.update({
        where: { id: orderId },
        data: {
          status: to,
          resolutionNote: command.note,
          closedById: userId,
          closedAt: this.clock.now(),
        },
      });
      await this.audit(
        tx,
        caller.propertyId,
        userId,
        orderId,
        to === 'RESOLVED' ? 'WORK_ORDER_RESOLVED' : 'WORK_ORDER_CANCELLED',
        { status: locked.status },
        {
          status: to,
          blockId: locked.roomBlockId,
          nightsReleased,
          restoredFrom: caller.businessDate,
        },
      );
    });
    return this.get(caller.propertyId, orderId);
  }

  /** The order's row FOR UPDATE, scoped by property in the same predicate (3.1.1). */
  private async lock(
    tx: BlockTx,
    propertyId: string,
    orderId: string,
  ): Promise<{
    status: WorkOrderStatus;
    roomBlockId: string | null;
    assignedToId: string | null;
    blockActive: boolean;
  }> {
    if (!UUID.test(orderId)) throw new TenantScopeViolationError('Work order');
    const rows = await tx.$queryRaw<
      { status: WorkOrderStatus; roomBlockId: string | null; assignedToId: string | null }[]
    >`
      SELECT "status"::text AS status, "roomBlockId"::text AS "roomBlockId", "assignedToId"::text AS "assignedToId"
        FROM "work_order"
       WHERE "id" = ${orderId}::uuid AND "propertyId" = ${propertyId}::uuid
         FOR UPDATE`;
    const row = rows[0];
    if (row === undefined) throw new TenantScopeViolationError('Work order');
    let blockActive = false;
    if (row.roomBlockId !== null) {
      const block = await tx.roomBlock.findFirst({
        where: { id: row.roomBlockId, propertyId },
        select: { status: true },
      });
      blockActive = block?.status === 'ACTIVE';
    }
    return { ...row, blockActive };
  }

  private blockRequest(
    room: { id: string; roomTypeId: string },
    range: OutOfOrderRange,
    title: string,
  ) {
    return {
      roomTypeId: room.roomTypeId,
      roomId: room.id,
      fromDate: range.fromDate,
      throughDate: range.throughDate,
      reason: 'MAINTENANCE' as const,
      note: `Work order: ${title}`.slice(0, 200),
    };
  }

  private closedError(status: WorkOrderStatus, action: string): InvalidStateTransitionError {
    return new InvalidStateTransitionError('work order', status, action);
  }

  private async find(propertyId: string, orderId: string): Promise<OrderRow> {
    const row = UUID.test(orderId)
      ? await this.prisma.client.workOrder.findFirst({
          where: { id: orderId, propertyId },
          select: ORDER_SELECT,
        })
      : null;
    if (row === null) throw new TenantScopeViolationError('Work order');
    return row;
  }

  private async get(propertyId: string, orderId: string): Promise<WorkOrder> {
    const row = await this.find(propertyId, orderId);
    const names = await this.names([row.reportedById, row.assignedToId ?? row.reportedById]);
    return this.toView(row, names);
  }

  private toView(row: OrderRow, names: Map<string, string>): WorkOrder {
    return {
      id: row.id,
      roomId: row.roomId,
      roomNumber: row.room.number,
      roomTypeName: row.room.roomType.name,
      title: row.title,
      description: row.description,
      priority: row.priority,
      status: row.status,
      reportedBy: { id: row.reportedById, name: names.get(row.reportedById) ?? 'Unknown user' },
      assignedTo:
        row.assignedToId === null
          ? null
          : { id: row.assignedToId, name: names.get(row.assignedToId) ?? 'Unknown user' },
      outOfOrder:
        row.roomBlock === null
          ? null
          : {
              blockId: row.roomBlock.id,
              fromDate: iso(row.roomBlock.fromDate) as BusinessDate,
              throughDate: lastNight(row.roomBlock.throughDate) as BusinessDate,
              active: row.roomBlock.status === 'ACTIVE',
            },
      resolutionNote: row.resolutionNote,
      closedAt: row.closedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async names(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) return new Map();
    const users = await this.prisma.client.user.findMany({
      where: { id: { in: wanted } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
  }

  private async audit(
    tx: BlockTx,
    propertyId: string,
    userId: string,
    orderId: string,
    event: string,
    before: Prisma.InputJsonValue | null,
    after: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        propertyId,
        actorUserId: userId,
        event,
        entityType: 'work_order',
        entityId: orderId,
        before: before === null ? Prisma.JsonNull : before,
        after,
        reason: null,
      },
    });
  }

  private require(caller: Caller, permission: Permission): void {
    if (!caller.permissions.includes(permission)) throw new ForbiddenError(permission);
  }

  private async authorise(userId: string, hotelId: string, required: Permission): Promise<Caller> {
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: grantedPropertyWhere({ userId, codeOrId: hotelId, operableOnly: false }),
      select: {
        role: { select: { key: true } },
        property: { select: { id: true, businessDate: true } },
      },
    });
    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');
    const roles = grants.map((grant) => grant.role.key).filter((key): key is Role => key !== null);
    const permissions = permissionsForRoles(roles);
    if (!permissions.includes(required)) throw new ForbiddenError(required);
    return {
      propertyId: first.property.id,
      businessDate: iso(first.property.businessDate),
      permissions,
    };
  }
}
