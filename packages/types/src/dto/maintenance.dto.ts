/**
 * Maintenance work orders (MA-01).
 *
 * A work order is a fault on one room, with a lifecycle: OPEN, IN_PROGRESS,
 * then RESOLVED or CANCELLED. It may take the room out of order for a date
 * range (a room block, reason MAINTENANCE), and closing it gives the room
 * back from the business date. Dates are calendar dates, the range inclusive
 * of its last night, like room blocks.
 */

import { z } from 'zod';

import { businessDateSchema } from '../domain.js';

export const workOrderPrioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
export type WorkOrderPriority = z.infer<typeof workOrderPrioritySchema>;

export const workOrderStatusSchema = z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED']);
export type WorkOrderStatus = z.infer<typeof workOrderStatusSchema>;

export const WORK_ORDER_PRIORITY_LABELS: Record<WorkOrderPriority, string> = {
  LOW: 'Low',
  NORMAL: 'Normal',
  HIGH: 'High',
  URGENT: 'Urgent',
};

export const WORK_ORDER_STATUS_LABELS: Record<WorkOrderStatus, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  RESOLVED: 'Resolved',
  CANCELLED: 'Cancelled',
};

/** Out of order from the first night through the last, inclusive. */
export const outOfOrderRangeSchema = z
  .object({ fromDate: businessDateSchema, throughDate: businessDateSchema })
  .refine((range) => range.fromDate <= range.throughDate, {
    message: 'The last night cannot fall before the first.',
    path: ['throughDate'],
  });

export type OutOfOrderRange = z.infer<typeof outOfOrderRangeSchema>;

export const createWorkOrderSchema = z.object({
  roomId: z.uuid(),
  title: z.string().trim().min(1).max(120),
  description: z
    .string()
    .trim()
    .max(2000)
    .nullable()
    .default(null)
    .transform((v) => (v === '' ? null : v)),
  priority: workOrderPrioritySchema.default('NORMAL'),
  /** Take the room out of order now. Needs `room_blocks:manage` too. */
  outOfOrder: outOfOrderRangeSchema.nullable().default(null),
});

export type CreateWorkOrderCommand = z.infer<typeof createWorkOrderSchema>;

export const assignWorkOrderSchema = z.object({ assignedToId: z.uuid().nullable() });
export type AssignWorkOrderCommand = z.infer<typeof assignWorkOrderSchema>;

export const closeWorkOrderSchema = z.object({
  /** What was done (resolve) or why not (cancel). */
  note: z.string().trim().max(2000).nullable().default(null),
});

export type CloseWorkOrderCommand = z.infer<typeof closeWorkOrderSchema>;

export const listWorkOrdersQuerySchema = z.object({
  /** Omitted: the open ones (OPEN and IN_PROGRESS). `all` lists every status. */
  status: z.enum(['active', 'all', ...workOrderStatusSchema.options]).default('active'),
  roomId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export type ListWorkOrdersQuery = z.infer<typeof listWorkOrdersQuerySchema>;

export const workOrderSchema = z.object({
  id: z.uuid(),
  roomId: z.uuid(),
  roomNumber: z.string(),
  roomTypeName: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  priority: workOrderPrioritySchema,
  status: workOrderStatusSchema,
  reportedBy: z.object({ id: z.uuid(), name: z.string() }),
  assignedTo: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  /** The block holding the room out of order; null when none. */
  outOfOrder: z
    .object({
      blockId: z.uuid(),
      fromDate: businessDateSchema,
      throughDate: businessDateSchema,
      active: z.boolean(),
    })
    .nullable(),
  resolutionNote: z.string().nullable(),
  closedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

export type WorkOrder = z.infer<typeof workOrderSchema>;

export const workOrderListSchema = z.object({
  items: z.array(workOrderSchema),
  /** People who may be assigned (a grant at this property), for the picker. */
  assignees: z.array(z.object({ id: z.uuid(), name: z.string() })),
  /** The property's business date: out-of-order ranges are measured from it. */
  businessDate: businessDateSchema,
});

export type WorkOrderList = z.infer<typeof workOrderListSchema>;
