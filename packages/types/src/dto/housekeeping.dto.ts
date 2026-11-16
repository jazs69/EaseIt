/**
 * Housekeeping (HK-01 .. HK-04): the board, tasks and inspections.
 *
 * The board is what a housekeeping supervisor looks at in the morning: every
 * room with its status, whether a guest is in it or due in or out today, and
 * the work queued on it. It carries no financial data and no guest names --
 * the housekeeping role is blind to both (HK-05).
 */

import { z } from 'zod';

import { businessDateSchema } from '../domain.js';

export const housekeepingTaskTypeSchema = z.enum(['CLEAN', 'DEEP_CLEAN', 'TURNDOWN', 'INSPECTION']);
export type HousekeepingTaskType = z.infer<typeof housekeepingTaskTypeSchema>;

export const housekeepingTaskStatusSchema = z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']);
export type HousekeepingTaskStatus = z.infer<typeof housekeepingTaskStatusSchema>;

export const inspectionResultSchema = z.enum(['PASSED', 'FAILED']);
export type InspectionResult = z.infer<typeof inspectionResultSchema>;

const personSchema = z.object({ id: z.uuid(), name: z.string() });

export const housekeepingTaskViewSchema = z.object({
  id: z.uuid(),
  roomId: z.uuid(),
  roomNumber: z.string(),
  type: housekeepingTaskTypeSchema,
  status: housekeepingTaskStatusSchema,
  assignedTo: personSchema.nullable(),
  notes: z.string().nullable(),
  businessDate: businessDateSchema,
  createdAt: z.iso.datetime({ offset: true }),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  completedBy: personSchema.nullable(),
  inspectionResult: inspectionResultSchema.nullable(),
});

export type HousekeepingTaskView = z.infer<typeof housekeepingTaskViewSchema>;

export const housekeepingBoardRoomSchema = z.object({
  roomId: z.uuid(),
  number: z.string(),
  floor: z.string().nullable(),
  roomTypeName: z.string(),
  status: z.string(),
  /** A guest is checked in to this room now. */
  occupied: z.boolean(),
  /** A stay assigned to this room arrives on the business date. */
  arrivingToday: z.boolean(),
  /** The in-house stay in this room departs on the business date. */
  departingToday: z.boolean(),
  activeTasks: z.array(housekeepingTaskViewSchema),
});

export type HousekeepingBoardRoom = z.infer<typeof housekeepingBoardRoomSchema>;

export const housekeepingBoardSchema = z.object({
  businessDate: businessDateSchema,
  rooms: z.array(housekeepingBoardRoomSchema),
  /** People at this property who can be given housekeeping work. */
  assignable: z.array(personSchema),
});

export type HousekeepingBoard = z.infer<typeof housekeepingBoardSchema>;

export const listHousekeepingTasksQuerySchema = z.object({
  status: housekeepingTaskStatusSchema.optional(),
  /** Only tasks assigned to the caller. */
  mine: z.enum(['true', 'false']).optional(),
});

export type ListHousekeepingTasksQuery = z.infer<typeof listHousekeepingTasksQuerySchema>;

export const createHousekeepingTaskSchema = z.object({
  roomId: z.uuid(),
  type: housekeepingTaskTypeSchema,
  assignedToId: z.uuid().nullable().default(null),
  notes: z.string().trim().max(500).nullable().default(null),
});

export type CreateHousekeepingTaskCommand = z.infer<typeof createHousekeepingTaskSchema>;

export const assignHousekeepingTaskSchema = z.object({
  assignedToId: z.uuid().nullable(),
});

export type AssignHousekeepingTaskCommand = z.infer<typeof assignHousekeepingTaskSchema>;

export const completeHousekeepingTaskSchema = z.object({
  notes: z.string().trim().max(500).nullable().default(null),
});

export type CompleteHousekeepingTaskCommand = z.infer<typeof completeHousekeepingTaskSchema>;

/** HK-04: record an inspection. FAILED sends the room back to dirty with a re-clean task. */
export const recordInspectionSchema = z.object({
  result: inspectionResultSchema,
  notes: z.string().trim().max(500).nullable().default(null),
});

export type RecordInspectionCommand = z.infer<typeof recordInspectionSchema>;

export const queueCleaningResultSchema = z.object({
  /** Cleaning tasks created for dirty rooms that had none. */
  created: z.number().int().nonnegative(),
});

export type QueueCleaningResult = z.infer<typeof queueCleaningResultSchema>;
