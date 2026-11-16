/**
 * Housekeeping: the board, tasks and inspections (HK-01 .. HK-04).
 *
 * ===========================================================================
 * Room *status* has one writer path, the conditional update the status
 * endpoint uses (`status = <what we read>`), and this module follows it: a
 * completed cleaning moves VACANT_DIRTY to VACANT_CLEAN (OCCUPIED_DIRTY to
 * OCCUPIED_CLEAN), a passed inspection moves VACANT_CLEAN to INSPECTED, a
 * failed one sends the room back to VACANT_DIRTY with a re-clean task. Each
 * happens in the same transaction as the task's own change, with the room row
 * locked and the same ROOM_STATUS_CHANGED audit row the endpoint writes. A
 * room whose status moved under us is refused, never overwritten.
 *
 * Authority:
 *   housekeeping:read           the board and task list
 *   housekeeping:update_status  start and finish one's own tasks (an
 *                               unassigned task is claimed by starting it)
 *   housekeeping:manage         create, assign and cancel tasks, record
 *                               inspections, queue cleaning for dirty rooms
 *
 * No folio, payment or guest name is read here (HK-05).
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import {
  Permission,
  permissionsForRoles,
  type AssignHousekeepingTaskCommand,
  type CompleteHousekeepingTaskCommand,
  type CreateHousekeepingTaskCommand,
  type HousekeepingBoard,
  type HousekeepingTaskView,
  type ListHousekeepingTasksQuery,
  type QueueCleaningResult,
  type RecordInspectionCommand,
  type Role,
} from '@repo/types';
import { Prisma } from '@repo/database';

import {
  EntityNotFoundError,
  ForbiddenError,
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { ROW_LOCK_TIMEOUT_MS } from '../../common/errors/sql-state.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClockService } from '../platform/clock.service.js';

type Tx = Prisma.TransactionClient;
const ACTIVE = ['OPEN', 'IN_PROGRESS'] as const;

const TASK_SELECT = {
  id: true,
  roomId: true,
  type: true,
  status: true,
  assignedToId: true,
  notes: true,
  businessDate: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  completedById: true,
  inspectionResult: true,
  room: { select: { number: true } },
} as const;

type TaskRow = Prisma.HousekeepingTaskGetPayload<{ select: typeof TASK_SELECT }>;

interface Caller {
  propertyId: string;
  businessDate: Date;
  userId: string;
  canManage: boolean;
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** What a finished cleaning makes of a room; null when it leaves the status alone. */
function cleanedStatus(current: string): string | null {
  if (current === 'VACANT_DIRTY') return 'VACANT_CLEAN';
  if (current === 'OCCUPIED_DIRTY') return 'OCCUPIED_CLEAN';
  return null;
}

@Injectable()
export class HousekeepingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  /* -------------------------------------------------------------------- */
  /*  HK-02: the board                                                     */
  /* -------------------------------------------------------------------- */

  async board(userId: string, hotelId: string): Promise<HousekeepingBoard> {
    const caller = await this.authorise(userId, hotelId, Permission.HOUSEKEEPING_READ);
    const day = caller.businessDate;

    const [rooms, stays, tasks, people] = await Promise.all([
      this.prisma.client.room.findMany({
        where: { propertyId: caller.propertyId, retiredAt: null },
        select: { id: true, number: true, floor: true, status: true, roomType: { select: { name: true } } },
        orderBy: [{ floor: 'asc' }, { number: 'asc' }],
      }),
      this.prisma.client.reservationRoom.findMany({
        where: {
          propertyId: caller.propertyId,
          roomId: { not: null },
          OR: [
            { status: 'CHECKED_IN' },
            { status: 'CONFIRMED', arrivalDate: day },
          ],
        },
        select: { roomId: true, status: true, arrivalDate: true, departureDate: true },
      }),
      this.prisma.client.housekeepingTask.findMany({
        where: { propertyId: caller.propertyId, status: { in: [...ACTIVE] } },
        select: TASK_SELECT,
        orderBy: { createdAt: 'asc' },
      }),
      this.assignablePeople(caller.propertyId),
    ]);

    const names = await this.names(tasks.flatMap((t) => [t.assignedToId, t.completedById]));
    return {
      businessDate: iso(day) as HousekeepingBoard['businessDate'],
      rooms: rooms.map((room) => {
        const here = stays.filter((stay) => stay.roomId === room.id);
        const inHouse = here.find((stay) => stay.status === 'CHECKED_IN');
        return {
          roomId: room.id,
          number: room.number,
          floor: room.floor,
          roomTypeName: room.roomType.name,
          status: room.status,
          occupied: inHouse !== undefined,
          arrivingToday: here.some((stay) => stay.status === 'CONFIRMED'),
          departingToday: inHouse !== undefined && inHouse.departureDate.getTime() === day.getTime(),
          activeTasks: tasks.filter((t) => t.roomId === room.id).map((t) => this.toView(t, names)),
        };
      }),
      assignable: people,
    };
  }

  async listTasks(userId: string, hotelId: string, query: ListHousekeepingTasksQuery): Promise<HousekeepingTaskView[]> {
    const caller = await this.authorise(userId, hotelId, Permission.HOUSEKEEPING_READ);
    const rows = await this.prisma.client.housekeepingTask.findMany({
      where: {
        propertyId: caller.propertyId,
        ...(query.status === undefined ? { status: { in: [...ACTIVE] } } : { status: query.status }),
        ...(query.mine === 'true' ? { assignedToId: caller.userId } : {}),
      },
      select: TASK_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const names = await this.names(rows.flatMap((t) => [t.assignedToId, t.completedById]));
    return rows.map((row) => this.toView(row, names));
  }

  /* -------------------------------------------------------------------- */
  /*  HK-03: tasks                                                         */
  /* -------------------------------------------------------------------- */

  async createTask(userId: string, hotelId: string, command: CreateHousekeepingTaskCommand): Promise<HousekeepingTaskView> {
    const caller = await this.authorise(userId, hotelId, Permission.HOUSEKEEPING_MANAGE);
    const room = await this.prisma.client.room.findFirst({
      where: { id: command.roomId, propertyId: caller.propertyId },
      select: { id: true, retiredAt: true },
    });
    if (room === null) throw new TenantScopeViolationError('Room');
    if (room.retiredAt !== null) throw new ValidationFailedError({ roomId: 'This room has been retired.' });
    if (command.assignedToId !== null) await this.assertAssignable(caller.propertyId, command.assignedToId);

    try {
      const created = await this.prisma.client.$transaction(async (tx) => {
        const task = await tx.housekeepingTask.create({
          data: {
            propertyId: caller.propertyId,
            roomId: command.roomId,
            type: command.type,
            assignedToId: command.assignedToId,
            notes: command.notes,
            businessDate: caller.businessDate,
            createdById: caller.userId,
          },
          select: TASK_SELECT,
        });
        await this.audit(tx, caller, 'HOUSEKEEPING_TASK_CREATED', task.id, null, {
          roomId: task.roomId,
          type: task.type,
          assignedToId: task.assignedToId,
        });
        return task;
      });
      return this.toView(created, await this.names([created.assignedToId]));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ValidationFailedError({
          type: `This room already has an open ${command.type.toLowerCase().replace('_', ' ')} task.`,
        });
      }
      throw error;
    }
  }

  async assign(userId: string, hotelId: string, taskId: string, command: AssignHousekeepingTaskCommand): Promise<HousekeepingTaskView> {
    const caller = await this.authorise(userId, hotelId, Permission.HOUSEKEEPING_MANAGE);
    if (command.assignedToId !== null) await this.assertAssignable(caller.propertyId, command.assignedToId);
    return this.transition(caller, taskId, async (tx, task) => {
      if (!(ACTIVE as readonly string[]).includes(task.status)) throw this.notActive();
      await tx.housekeepingTask.updateMany({
        where: { id: task.id, propertyId: caller.propertyId },
        data: { assignedToId: command.assignedToId },
      });
      await this.audit(tx, caller, 'HOUSEKEEPING_TASK_ASSIGNED', task.id, { assignedToId: task.assignedToId }, { assignedToId: command.assignedToId });
    });
  }

  /** Start one's own task; an unassigned task is claimed by whoever starts it. */
  async start(userId: string, hotelId: string, taskId: string): Promise<HousekeepingTaskView> {
    const caller = await this.authorise(userId, hotelId, Permission.HOUSEKEEPING_UPDATE_STATUS);
    return this.transition(caller, taskId, async (tx, task) => {
      if (task.status !== 'OPEN') throw new ValidationFailedError({ taskId: 'Only an open task can be started.' });
      this.assertMayWork(caller, task);
      await tx.housekeepingTask.updateMany({
        where: { id: task.id, propertyId: caller.propertyId, status: 'OPEN' },
        data: { status: 'IN_PROGRESS', startedAt: this.clock.now(), assignedToId: task.assignedToId ?? caller.userId },
      });
      await this.audit(tx, caller, 'HOUSEKEEPING_TASK_STARTED', task.id, { status: 'OPEN' }, { status: 'IN_PROGRESS' });
    });
  }

  /**
   * Finish a cleaning or turndown. A finished cleaning makes a dirty room
   * clean, in the same transaction; an inspection is recorded with `inspect`.
   */
  async complete(userId: string, hotelId: string, taskId: string, command: CompleteHousekeepingTaskCommand): Promise<HousekeepingTaskView> {
    const caller = await this.authorise(userId, hotelId, Permission.HOUSEKEEPING_UPDATE_STATUS);
    return this.transition(caller, taskId, async (tx, task) => {
      if (!(ACTIVE as readonly string[]).includes(task.status)) throw this.notActive();
      if (task.type === 'INSPECTION') {
        throw new ValidationFailedError({ taskId: 'An inspection is recorded with a result, not completed.' });
      }
      this.assertMayWork(caller, task);
      const now = this.clock.now();
      if (task.type === 'CLEAN' || task.type === 'DEEP_CLEAN') {
        const room = await this.lockRoom(tx, caller.propertyId, task.roomId);
        const next = cleanedStatus(room.status);
        if (next !== null) await this.setRoomStatus(tx, caller, task.roomId, room.status, next, `Task ${task.type} completed`);
      }
      await tx.housekeepingTask.updateMany({
        where: { id: task.id, propertyId: caller.propertyId, status: { in: [...ACTIVE] } },
        data: {
          status: 'DONE',
          completedAt: now,
          completedById: caller.userId,
          startedAt: task.startedAt ?? now,
          assignedToId: task.assignedToId ?? caller.userId,
          ...(command.notes === null ? {} : { notes: command.notes }),
        },
      });
      await this.audit(tx, caller, 'HOUSEKEEPING_TASK_COMPLETED', task.id, { status: task.status }, { status: 'DONE' });
    });
  }

  async cancel(userId: string, hotelId: string, taskId: string): Promise<HousekeepingTaskView> {
    const caller = await this.authorise(userId, hotelId, Permission.HOUSEKEEPING_MANAGE);
    return this.transition(caller, taskId, async (tx, task) => {
      if (!(ACTIVE as readonly string[]).includes(task.status)) throw this.notActive();
      await tx.housekeepingTask.updateMany({
        where: { id: task.id, propertyId: caller.propertyId, status: { in: [...ACTIVE] } },
        data: { status: 'CANCELLED', cancelledAt: this.clock.now() },
      });
      await this.audit(tx, caller, 'HOUSEKEEPING_TASK_CANCELLED', task.id, { status: task.status }, { status: 'CANCELLED' });
    });
  }

  /** A cleaning task for every dirty room that has none open. */
  async queueCleaning(userId: string, hotelId: string): Promise<QueueCleaningResult> {
    const caller = await this.authorise(userId, hotelId, Permission.HOUSEKEEPING_MANAGE);
    const dirty = await this.prisma.client.room.findMany({
      where: { propertyId: caller.propertyId, retiredAt: null, status: { in: ['VACANT_DIRTY', 'OCCUPIED_DIRTY'] } },
      select: { id: true },
    });
    if (dirty.length === 0) return { created: 0 };
    const result = await this.prisma.client.$transaction(async (tx) => {
      // The partial unique index (one active task per room and type) skips
      // rooms that already have one, even if another request races this.
      const created = await tx.housekeepingTask.createMany({
        data: dirty.map((room) => ({
          propertyId: caller.propertyId,
          roomId: room.id,
          type: 'CLEAN' as const,
          businessDate: caller.businessDate,
          createdById: caller.userId,
        })),
        skipDuplicates: true,
      });
      await this.audit(tx, caller, 'HOUSEKEEPING_CLEANING_QUEUED', caller.propertyId, null, { created: created.count });
      return created.count;
    });
    return { created: result };
  }

  /* -------------------------------------------------------------------- */
  /*  HK-04: inspection                                                    */
  /* -------------------------------------------------------------------- */

  /**
   * PASSED: a clean vacant room becomes INSPECTED. FAILED: the room goes back
   * to VACANT_DIRTY and a re-clean task is queued, so it cannot be presented
   * as clean until it has been cleaned again.
   */
  async inspect(userId: string, hotelId: string, taskId: string, command: RecordInspectionCommand): Promise<HousekeepingTaskView> {
    const caller = await this.authorise(userId, hotelId, Permission.HOUSEKEEPING_MANAGE);
    return this.transition(caller, taskId, async (tx, task) => {
      if (task.type !== 'INSPECTION') throw new ValidationFailedError({ taskId: 'This is not an inspection task.' });
      if (!(ACTIVE as readonly string[]).includes(task.status)) throw this.notActive();
      const room = await this.lockRoom(tx, caller.propertyId, task.roomId);

      if (command.result === 'PASSED') {
        if (room.status !== 'VACANT_CLEAN' && room.status !== 'INSPECTED') {
          throw new ValidationFailedError({
            result: `The room is ${room.status.toLowerCase().replace(/_/g, ' ')}; only a clean, vacant room can pass inspection.`,
          });
        }
        if (room.status === 'VACANT_CLEAN') {
          await this.setRoomStatus(tx, caller, task.roomId, room.status, 'INSPECTED', 'Inspection passed');
        }
      } else {
        if (!['VACANT_CLEAN', 'INSPECTED', 'VACANT_DIRTY'].includes(room.status)) {
          throw new ValidationFailedError({ result: 'Only a vacant room is inspected.' });
        }
        if (room.status !== 'VACANT_DIRTY') {
          await this.setRoomStatus(tx, caller, task.roomId, room.status, 'VACANT_DIRTY', 'Inspection failed');
        }
        await tx.housekeepingTask.createMany({
          data: [
            {
              propertyId: caller.propertyId,
              roomId: task.roomId,
              type: 'CLEAN',
              notes: command.notes === null ? 'Re-clean after a failed inspection' : `Re-clean: ${command.notes}`,
              businessDate: caller.businessDate,
              createdById: caller.userId,
            },
          ],
          skipDuplicates: true,
        });
      }

      const now = this.clock.now();
      await tx.housekeepingTask.updateMany({
        where: { id: task.id, propertyId: caller.propertyId, status: { in: [...ACTIVE] } },
        data: {
          status: 'DONE',
          inspectionResult: command.result,
          completedAt: now,
          completedById: caller.userId,
          startedAt: task.startedAt ?? now,
          ...(command.notes === null ? {} : { notes: command.notes }),
        },
      });
      await this.audit(tx, caller, 'HOUSEKEEPING_INSPECTION_RECORDED', task.id, { roomStatus: room.status }, { result: command.result });
    });
  }

  /* -------------------------------------------------------------------- */
  /*  Shared                                                               */
  /* -------------------------------------------------------------------- */

  /** Lock the task, run the change, return the task as it now is. */
  private async transition(
    caller: Caller,
    taskId: string,
    change: (tx: Tx, task: TaskRow) => Promise<void>,
  ): Promise<HousekeepingTaskView> {
    const updated = await this.prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${String(ROW_LOCK_TIMEOUT_MS)}, true)`;
        await tx.$queryRaw`
          SELECT 1 FROM "housekeeping_task"
           WHERE "id" = ${taskId}::uuid AND "propertyId" = ${caller.propertyId}::uuid
             FOR UPDATE`;
        const task = await tx.housekeepingTask.findFirst({
          where: { id: taskId, propertyId: caller.propertyId },
          select: TASK_SELECT,
        });
        if (task === null) throw new EntityNotFoundError('Housekeeping task');
        await change(tx, task);
        const after = await tx.housekeepingTask.findFirst({
          where: { id: taskId, propertyId: caller.propertyId },
          select: TASK_SELECT,
        });
        if (after === null) throw new EntityNotFoundError('Housekeeping task');
        return after;
      },
      { timeout: 10_000, isolationLevel: 'ReadCommitted' },
    );
    return this.toView(updated, await this.names([updated.assignedToId, updated.completedById]));
  }

  private async lockRoom(tx: Tx, propertyId: string, roomId: string): Promise<{ status: string }> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status"::text AS status FROM "room"
       WHERE "id" = ${roomId}::uuid AND "propertyId" = ${propertyId}::uuid
         FOR UPDATE`;
    const room = rows[0];
    if (room === undefined) throw new TenantScopeViolationError('Room');
    return room;
  }

  /** The status endpoint's write, verbatim in spirit: conditional, then audited. */
  private async setRoomStatus(tx: Tx, caller: Caller, roomId: string, from: string, to: string, note: string): Promise<void> {
    const changed = await tx.room.updateMany({
      where: { id: roomId, propertyId: caller.propertyId, status: from as never },
      data: { status: to as never },
    });
    if (changed.count === 0) {
      throw new ValidationFailedError({ status: 'This room’s status changed while you were working. Reload and try again.' });
    }
    await tx.auditLog.create({
      data: {
        propertyId: caller.propertyId,
        actorUserId: caller.userId,
        event: 'ROOM_STATUS_CHANGED',
        entityType: 'room',
        entityId: roomId,
        before: { status: from },
        after: { status: to, note },
      },
    });
  }

  private assertMayWork(caller: Caller, task: TaskRow): void {
    if (caller.canManage) return;
    if (task.assignedToId !== null && task.assignedToId !== caller.userId) {
      throw new ForbiddenError(Permission.HOUSEKEEPING_MANAGE);
    }
  }

  private notActive(): ValidationFailedError {
    return new ValidationFailedError({ taskId: 'This task is already finished or cancelled.' });
  }

  /** People with a grant here whose roles let them do housekeeping work. */
  private async assignablePeople(propertyId: string): Promise<{ id: string; name: string }[]> {
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: { propertyId, user: { isActive: true } },
      select: {
        user: { select: { id: true, firstName: true, lastName: true } },
        role: { select: { key: true, permissions: { select: { permission: { select: { key: true } } } } } },
      },
    });
    const people = new Map<string, string>();
    for (const grant of grants) {
      const carries =
        grant.role.key !== null
          ? permissionsForRoles([grant.role.key as Role]).includes(Permission.HOUSEKEEPING_UPDATE_STATUS)
          : grant.role.permissions.some((link) => link.permission.key === Permission.HOUSEKEEPING_UPDATE_STATUS);
      if (carries) people.set(grant.user.id, `${grant.user.firstName} ${grant.user.lastName}`.trim());
    }
    return [...people].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  private async assertAssignable(propertyId: string, userId: string): Promise<void> {
    const people = await this.assignablePeople(propertyId);
    if (!people.some((person) => person.id === userId)) {
      throw new ValidationFailedError({ assignedToId: 'That person cannot be given housekeeping work at this property.' });
    }
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

  private toView(row: TaskRow, names: Map<string, string>): HousekeepingTaskView {
    const person = (id: string | null) => (id === null ? null : { id, name: names.get(id) ?? 'Unknown' });
    return {
      id: row.id,
      roomId: row.roomId,
      roomNumber: row.room.number,
      type: row.type,
      status: row.status,
      assignedTo: person(row.assignedToId),
      notes: row.notes,
      businessDate: iso(row.businessDate) as HousekeepingTaskView['businessDate'],
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      completedBy: person(row.completedById),
      inspectionResult: row.inspectionResult,
    };
  }

  private async audit(
    tx: Tx,
    caller: Caller,
    event: string,
    entityId: string,
    before: Prisma.InputJsonValue | null,
    after: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        propertyId: caller.propertyId,
        actorUserId: caller.userId,
        event,
        entityType: 'housekeeping_task',
        entityId,
        before: before ?? Prisma.JsonNull,
        after,
      },
    });
  }

  private async authorise(userId: string, codeOrId: string, required: Permission): Promise<Caller> {
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: grantedPropertyWhere({ userId, codeOrId, operableOnly: false }),
      select: { role: { select: { key: true } }, property: { select: { id: true, businessDate: true } } },
    });
    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');
    const roles = grants.map((grant) => grant.role.key).filter((key): key is Role => key !== null);
    const held = permissionsForRoles(roles);
    if (!held.includes(required)) throw new ForbiddenError(required);
    return {
      propertyId: first.property.id,
      businessDate: first.property.businessDate,
      userId,
      canManage: held.includes(Permission.HOUSEKEEPING_MANAGE),
    };
  }
}
